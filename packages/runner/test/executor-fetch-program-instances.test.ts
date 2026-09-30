/** Exercises scoped program resolution through a service-identity execution host. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { ProgramResult } from "../src/builtins/fetch-program.ts";
import type { Cell } from "../src/cell.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { waitUntil } from "./support/wait-until.ts";

const spaceSigner = await Identity.fromPassphrase(
  "fetch program instances space",
);
const service = await Identity.fromPassphrase(
  "fetch program instances service",
);
const alice = await Identity.fromPassphrase("fetch program instances alice");
const bob = await Identity.fromPassphrase("fetch program instances bob");
const space = spaceSigner.did() as MemorySpace;
const url = "https://example.test/instance-program.ts";

/** Public state of the fetch node. */
type FetchView = {
  pending?: boolean;
  result?: ProgramResult;
  error?: unknown;
};

/** One requesting client and its view of the shared piece. */
type ClientView = {
  runtime: Runtime;
  argument: Cell<{ url: string }>;
  result: Cell<{ fetched: FetchView }>;
};

/** Creates a host with controlled HTTP responses and separate requesting clients. */
async function fixture(scope: "space" | "user" | "session") {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const servingErrors: unknown[] = [];
  const requests: Array<{
    url: string;
    signal?: AbortSignal | null;
    response: ReturnType<typeof Promise.withResolvers<Response>>;
  }> = [];
  const clients: Array<{
    runtime: Runtime;
    manager: EmulatedStorageManager;
    cancel?: () => void;
  }> = [];
  const servingRuntimes: Runtime[] = [];
  const teardownIdentities: Array<ScopeKeyIdentity | undefined> = [];
  let rejectNextTeardownStamp = false;
  const originalFetch = globalThis.fetch;
  let closeHost: (() => Promise<void>) | undefined;

  /** Releases partially created fixtures as well as completed test setups. */
  async function close() {
    try {
      for (const request of requests) {
        request.response.resolve(new Response("cleanup"));
      }
      for (const client of clients) client.cancel?.();
      await closeHost?.();
      for (const client of clients) {
        try {
          await client.runtime.dispose({ closeStorage: false });
        } finally {
          await client.manager.close();
        }
      }
      await server.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  try {
    globalThis.fetch = (input, init) => {
      const requestedUrl = input instanceof Request ? input.url : String(input);
      if (!requestedUrl.startsWith(url)) return originalFetch(input, init);
      const response = Promise.withResolvers<Response>();
      const signal = init?.signal;
      requests.push({ url: requestedUrl, signal, response });
      const abort = () => response.reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      return response.promise.finally(() =>
        signal?.removeEventListener("abort", abort)
      );
    };
    const host = new ExecutorHost({
      server,
      serviceIdentity: service.did(),
      // The execution host owns an asynchronous factory contract.
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: service,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntimes.push(runtime);
        const stamp = runtime.stampServerRun.bind(runtime);
        runtime.stampServerRun = (tx, info) => {
          if (info.actionId.startsWith("fetchProgram/teardown/")) {
            teardownIdentities.push(info.scopeKeyIdentity);
            if (rejectNextTeardownStamp) {
              rejectNextTeardownStamp = false;
              throw new Error("injected teardown stamp failure");
            }
          }
          stamp(tx, info);
        };
        runtime.scheduler.onError((error) => servingErrors.push(error));
        return {
          runtime,
          dispose: async () => {
            try {
              await runtime.dispose();
            } catch (error) {
              await manager.close();
              throw error;
            }
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });
    closeHost = () => host.close();

    /** Opens an independently authenticated client session. */
    const openClient = (signer: typeof alice) => {
      const manager = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: true },
      });
      const client = {
        runtime,
        manager,
        cancel: undefined as (() => void) | undefined,
      };
      clients.push(client);
      return client;
    };

    const first = openClient(alice);
    const scoped = scope === "space"
      ? "Writable<string>"
      : `${scope === "user" ? "PerUser" : "PerSession"}<Writable<string>>`;
    const pattern = await first.runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
import { fetchProgram, pattern, PerUser, PerSession, Writable } from "commonfabric";
export default pattern<{ url: ${scoped} }, { fetched: any }>(({ url }) => ({
  fetched: fetchProgram({ url }),
}));
`,
      }],
    }, { space });

    /** Publishes one client's input and starts observing its output instance. */
    const attach = async (
      client: typeof first,
      create: boolean,
    ): Promise<ClientView> => {
      const { runtime } = client;
      const argument = runtime.getCell<{ url: string }>(
        space,
        "fetch-input",
        pattern.argumentSchema,
      );
      const result = runtime.getCell<{ fetched: FetchView }>(
        space,
        "fetch-result",
        pattern.resultSchema,
      );
      await argument.sync();
      await result.sync();
      const seed = runtime.edit();
      argument.withTx(seed).key("url").set(url);
      expect((await seed.commit()).error).toBeUndefined();
      if (create) {
        const start = runtime.edit();
        runtime.run(start, pattern, argument, result);
        expect((await start.commit()).error).toBeUndefined();
      }
      client.cancel = result.sink(() => {});
      return {
        runtime,
        argument,
        result,
      };
    };

    /** Observes a settled payload through the client's subscribed fetch field. */
    const value = (view: ClientView, payload: string) =>
      waitForCellValue<FetchView>(
        view.runtime,
        view.result.key("fetched"),
        (state) =>
          state?.pending === false &&
          state.result?.files.some((file) =>
              file.contents.includes(payload)
            ) === true,
      );

    return {
      first: await attach(first, true),
      requests,
      servingErrors,
      server,
      teardownIdentities,
      rejectNextTeardown: () => rejectNextTeardownStamp = true,
      host,
      value,
      settled: () =>
        Promise.all(servingRuntimes.map((runtime) => runtime.settled())),
      join: (signer: typeof alice) => attach(openClient(signer), false),
      /** Waits for dispatch or retirement, exposing a skipped request as missing I/O. */
      async issued(count: number) {
        await waitUntil(
          () =>
            requests.length >= count || host.stats().outbox.completed >= count,
          () =>
            JSON.stringify({
              requests: requests.map((request) => request.url),
              stats: host.stats(),
              servingErrors,
            }),
        );
        expect(requests).toHaveLength(count);
      },
      async retired(count: number) {
        await waitUntil(
          () => host.stats().outbox.completed >= count,
          () => JSON.stringify({ stats: host.stats(), servingErrors }),
        );
      },
      async entries() {
        const engine = await server.engineForSpace(space);
        const writes = Engine.selectCommitsSince(engine, { fromSeq: 0 })
          .flatMap((commit) => commit.writes);
        const addresses = new Map(
          writes.map((
            write,
          ) => [JSON.stringify([write.id, write.scopeKey]), write]),
        );
        return [...addresses.values()].flatMap((address) => {
          const value = Engine.read(engine, address)?.value;
          if (!isObjectOrArray(value)) return [];
          return Object.values(value).flatMap((entry) => {
            if (
              !isObjectOrArray(entry) ||
              !("inputHash" in entry) || !("state" in entry) ||
              !isObjectOrArray(entry.state) ||
              !("type" in entry.state)
            ) return [];
            return [{ scopeKey: address.scopeKey, state: entry.state.type }];
          });
        });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** A TypeScript program with a distinguishable response body. */
function programResponse(payload: string): Response {
  return new Response(`export const payload = ${JSON.stringify(payload)};`, {
    headers: { "Content-Type": "text/typescript" },
  });
}

describe("executor-fetch-program-instances", () => {
  for (const scope of ["space", "user", "session"] as const) {
    it(`completes a ${scope}-scoped program resolution`, async () => {
      const f = await fixture(scope);
      try {
        await f.issued(1);
        f.requests[0].response.resolve(programResponse("served"));
        await f.retired(1);
        expect(await f.entries()).toEqual([{
          scopeKey: resolveScopeKey(scope, f.first.runtime.scopeKeyIdentity),
          state: "success",
        }]);
        expect((await f.value(f.first, "served")).error).toBeUndefined();
        expect(f.servingErrors).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }

  for (const scope of ["user", "session"] as const) {
    it(`completes identical URLs independently for two ${scope} instances`, async () => {
      const f = await fixture(scope);
      try {
        await f.issued(1);
        const second = await f.join(scope === "user" ? bob : alice);
        await f.issued(2);
        f.requests[1].response.resolve(programResponse("second"));
        await f.retired(1);
        expect(await f.entries()).toEqual(expect.arrayContaining([
          {
            scopeKey: resolveScopeKey(scope, f.first.runtime.scopeKeyIdentity),
            state: "fetching",
          },
          {
            scopeKey: resolveScopeKey(scope, second.runtime.scopeKeyIdentity),
            state: "success",
          },
        ]));
        expect((await f.value(second, "second")).error).toBeUndefined();
        f.requests[0].response.resolve(programResponse("first"));
        await f.retired(2);
        expect((await f.value(f.first, "first")).error).toBeUndefined();
        expect((await f.value(second, "second")).error).toBeUndefined();
        expect(f.requests).toHaveLength(2);
        expect(f.servingErrors).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }
  for (const scope of ["user", "session"] as const) {
    it(`keeps another ${scope} instance pending when a program request fails`, async () => {
      const f = await fixture(scope);
      try {
        await f.issued(1);
        const second = await f.join(scope === "user" ? bob : alice);
        await f.issued(2);
        f.requests[0].response.reject(new Error("program fetch failed"));
        await f.retired(1);
        expect(await f.entries()).toEqual(expect.arrayContaining([
          {
            scopeKey: resolveScopeKey(scope, f.first.runtime.scopeKeyIdentity),
            state: "error",
          },
          {
            scopeKey: resolveScopeKey(scope, second.runtime.scopeKeyIdentity),
            state: "fetching",
          },
        ]));
        const failed = await waitForCellValue<FetchView>(
          f.first.runtime,
          f.first.result.key("fetched"),
          (state) => state?.pending === false && state.error !== undefined,
        );
        expect(failed.result).toBeUndefined();
        f.requests[1].response.resolve(programResponse("neighbor"));
        await f.retired(2);
        expect((await f.value(second, "neighbor")).error).toBeUndefined();
        expect(f.requests).toHaveLength(2);
      } finally {
        await f.close();
      }
    });

    it(`returns to a held ${scope} program request while a different URL resolves`, async () => {
      const f = await fixture(scope);
      const setUrl = async (value: string) => {
        const tx = f.first.runtime.edit();
        f.first.argument.withTx(tx).key("url").set(value);
        expect((await tx.commit()).error).toBeUndefined();
      };
      try {
        await f.issued(1);
        await setUrl(`${url}?second`);
        await f.issued(2);
        await setUrl(url);
        f.requests[0].response.resolve(programResponse("original"));
        await f.retired(1);
        expect((await f.value(f.first, "original")).error).toBeUndefined();
        f.requests[1].response.resolve(programResponse("other"));
        await f.retired(2);
        expect((await f.value(f.first, "original")).error).toBeUndefined();
        expect(f.requests).toHaveLength(2);
        expect((await f.entries()).map((entry) => entry.state)).toEqual([
          "success",
          "success",
        ]);
      } finally {
        await f.close();
      }
    });
  }
  for (const scope of ["user", "session"] as const) {
    it(`stops all ${scope} resolutions even when one cleanup stamp throws`, async () => {
      const f = await fixture(scope);
      try {
        await f.issued(1);
        const second = await f.join(scope === "user" ? bob : alice);
        await f.issued(2);
        f.rejectNextTeardown();
        await f.host.close();
        expect(f.teardownIdentities).toEqual(expect.arrayContaining([
          f.first.runtime.scopeKeyIdentity,
          second.runtime.scopeKeyIdentity,
        ]));
        for (const request of f.requests) {
          request.response.resolve(programResponse("late"));
        }
        await f.settled();
        expect(
          (await f.entries()).some((entry) =>
            entry.state === "success" || entry.state === "error"
          ),
        ).toBe(false);
      } finally {
        await f.close();
      }
    });
  }
});
