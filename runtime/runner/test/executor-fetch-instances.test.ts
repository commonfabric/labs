/** Exercises scoped fetch requests through a service-identity execution host. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  isUnavailable,
  type UnavailableVariant,
} from "@commonfabric/data-model/availability";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Cell } from "../src/cell.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { waitUntil } from "./support/wait-until.ts";

const spaceSigner = await Identity.fromPassphrase("fetch instances space");
const service = await Identity.fromPassphrase("fetch instances service");
const alice = await Identity.fromPassphrase("fetch instances alice");
const bob = await Identity.fromPassphrase("fetch instances bob");
const space = spaceSigner.did() as MemorySpace;
const url = "https://example.test/instance-fetch";

/** One requesting client and its view of the shared piece. */
type ClientView = {
  runtime: Runtime;
  argument: Cell<{ url: string }>;
  result: Cell<{ fetched: string | UnavailableVariant }>;
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
  const teardownIdentities: Array<ScopeKeyIdentity | undefined> = [];
  const servingRuntimes: Runtime[] = [];
  let failNextTeardownEdit = false;
  let teardownEditFailures = 0;
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
        const edit = runtime.edit.bind(runtime);
        runtime.edit = (...args) => {
          if (
            failNextTeardownEdit &&
            requests.some((request) => request.signal?.aborted)
          ) {
            failNextTeardownEdit = false;
            teardownEditFailures++;
            throw new Error("injected teardown edit failure");
          }
          return edit(...args);
        };
        const stamp = runtime.stampServerRun.bind(runtime);
        runtime.stampServerRun = (tx, info) => {
          if (info.actionId.startsWith("fetchText/teardown/")) {
            teardownIdentities.push(info.scopeKeyIdentity);
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
import { fetchText, pattern, PerUser, PerSession, Writable } from "commonfabric";
export default pattern<{ url: ${scoped} }, { fetched: any }>(({ url }) => ({
  fetched: fetchText({ url }),
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
      const result = runtime.getCell<{
        fetched: string | UnavailableVariant;
      }>(
        space,
        "fetch-result",
        pattern.resultSchema,
      );
      await argument.sync();
      await result.sync();
      const seed = runtime.edit();
      argument.withTx(seed).key("url").set(url);
      expect((await seed.commit().settled).error).toBeUndefined();
      if (create) {
        const start = runtime.edit();
        runtime.run(start, pattern, argument, result);
        expect((await start.commit().settled).error).toBeUndefined();
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
      waitForCellValue<string | UnavailableVariant>(
        view.runtime,
        view.result.key("fetched"),
        (state) => state === payload,
      );

    return {
      first: await attach(first, true),
      requests,
      servingErrors,
      teardownIdentities,
      failNextTeardownEdit: () => {
        failNextTeardownEdit = true;
      },
      teardownEditFailures: () => teardownEditFailures,
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
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("executor-fetch-instances", () => {
  for (const scope of ["space", "user", "session"] as const) {
    it(`completes one ${scope}-scoped request under the requesting identity`, async () => {
      const f = await fixture(scope);
      try {
        await f.issued(1);
        f.requests[0].response.resolve(new Response("first payload"));
        expect(await f.value(f.first, "first payload")).toBe("first payload");
        expect(f.servingErrors).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }

  it("retires completed session state and can request again from an earlier session", async () => {
    const f = await fixture("session");
    try {
      await f.issued(1);
      f.requests[0].response.resolve(new Response("first payload"));
      await f.value(f.first, "first payload");
      for (let index = 1; index <= 5; index++) {
        const next = await f.join(alice);
        await f.issued(index + 1);
        f.requests[index].response.resolve(new Response(`payload ${index}`));
        await f.value(next, `payload ${index}`);
      }
      await f.settled();
      const edit = f.first.runtime.edit();
      f.first.argument.withTx(edit).key("url").set(`${url}/returned-session`);
      expect((await edit.commit().settled).error).toBeUndefined();
      await f.issued(7);
      f.requests[6].response.resolve(new Response("returned payload"));
      await f.value(f.first, "returned payload");
      await f.settled();
    } finally {
      await f.close();
    }
    expect(f.teardownIdentities).toEqual([]);
  });

  it("retains a pending request until graph stop aborts its owner", async () => {
    const f = await fixture("user");
    try {
      await f.issued(1);
      await f.host.close();
      expect(f.requests[0].signal?.aborted).toBe(true);
      expect(f.teardownIdentities).toContainEqual(
        f.first.runtime.scopeKeyIdentity,
      );
    } finally {
      await f.close();
    }
  });

  it("aborts every pending instance when one teardown throws", async () => {
    const f = await fixture("user");
    try {
      await f.issued(1);
      await f.join(bob);
      await f.issued(2);
      f.failNextTeardownEdit();
      await f.host.close();
      expect(f.teardownEditFailures()).toBe(1);
      expect(f.requests.map((request) => request.signal?.aborted)).toEqual([
        true,
        true,
      ]);
    } finally {
      await f.close();
    }
  });

  for (const scope of ["user", "session"] as const) {
    it(`completes identical concurrent requests in separate ${scope} instances`, async () => {
      const f = await fixture(scope);
      try {
        await f.issued(1);
        const second = await f.join(scope === "user" ? bob : alice);
        await f.issued(2);
        expect(f.requests[0].signal?.aborted).toBe(false);
        f.requests[0].response.resolve(new Response("first payload"));
        f.requests[1].response.resolve(new Response("second payload"));
        await Promise.all([
          f.value(f.first, "first payload"),
          f.value(second, "second payload"),
        ]);
        expect(f.servingErrors).toEqual([]);
      } finally {
        await f.close();
      }
    });

    it(`settles one ${scope} instance's network error without affecting its neighbor`, async () => {
      const f = await fixture(scope);
      try {
        await f.issued(1);
        const second = await f.join(scope === "user" ? bob : alice);
        await f.issued(2);
        f.requests[0].response.reject(new Error("request failed"));
        const failed = await waitForCellValue<
          string | UnavailableVariant
        >(
          f.first.runtime,
          f.first.result.key("fetched"),
          (state) => isUnavailable(state) && state.reason === "error",
        );
        expect(isUnavailable(failed) && failed.reason === "error").toBe(
          true,
        );
        expect(f.requests[1].signal?.aborted).toBe(false);
        f.requests[1].response.resolve(new Response("second payload"));
        expect(await f.value(second, "second payload")).toBe("second payload");
        expect(f.servingErrors).toEqual([]);
      } finally {
        await f.close();
      }
    });

    it(`supersedes one ${scope} instance without aborting its neighbor`, async () => {
      const f = await fixture(scope);
      try {
        await f.issued(1);
        const second = await f.join(scope === "user" ? bob : alice);
        await f.issued(2);
        const edit = f.first.runtime.edit();
        f.first.argument.withTx(edit).key("url").set(`${url}/replacement`);
        expect((await edit.commit().settled).error).toBeUndefined();
        await f.issued(3);
        expect(f.requests[0].signal?.aborted).toBe(true);
        expect(f.requests[1].signal?.aborted).toBe(false);
        f.requests[0].response.resolve(new Response("superseded payload"));
        f.requests[1].response.resolve(new Response("second payload"));
        f.requests[2].response.resolve(new Response("replacement payload"));
        await Promise.all([
          f.value(f.first, "replacement payload"),
          f.value(second, "second payload"),
        ]);
        expect(f.servingErrors).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }
});
