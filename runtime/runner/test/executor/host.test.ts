import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { ServerExecutionObserver } from "@commonfabric/memory/v2/server";
import { defer } from "@commonfabric/async/defer";
import { ExecutorHost } from "../../src/executor/host.ts";
import { inServingContext } from "../../src/executor/serving-context.ts";
import {
  type ServingMemoryServer,
  startServingMemoryServer,
} from "../../src/executor/serving-memory-server.deno.ts";
import { servingRuntimeFactory } from "../../src/executor/serving-runtime.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";

const service = await Identity.fromPassphrase("executor host service");
const owner = await Identity.fromPassphrase("executor host owner");

/**
 * A chain of handlers, each sending the next one an event on its own account,
 * of which only the last writes.
 */
const CHAIN_SOURCE = `
import { handler, pattern, type Stream, Writable } from "commonfabric";
type Note = { value: string };
const land = handler<Note, { landed: Writable<string> }>(
  (event, { landed }) => landed.set(event.value),
);
const relay = handler<Note, { next: Stream<Note> }>(
  (event, { next }) => next.send(event),
);
export default pattern(() => {
  const landed = new Writable<string>("").for("landed");
  const third = relay({ next: land({ landed }) });
  const second = relay({ next: third });
  return { landed, start: relay({ next: second }) };
});
`;

/** A fetch the loop makes, whose answer it writes. */
const FETCH_SOURCE = `
import { fetchJson, pattern } from "commonfabric";
export default pattern(() => {
  const fetched = fetchJson<{ v: number }>({ url: "https://example.test/v" });
  return { v: fetched.result.v };
});
`;

type Chain = { landed: string };

/** What {@link withChain} hands the test it runs. */
type ChainFixture = {
  serving: ServingMemoryServer;
  host: ExecutorHost;
  runtime: Runtime;
  /** Fires `value` at the chain's first handler, and flushes the event out. */
  start(value: string): Promise<void>;
  /** The value the chain's last handler wrote, as the client reads it now. */
  landed(): string;
};

/**
 * Runs `body` with a client and the chain started, on a serving loop that gives
 * every wave one millisecond to settle. A deadline that short cuts the waves,
 * which leaves each handler's event queued for a later wave rather than served
 * in the wave that carries its sender.
 */
async function withChain(
  body: (fixture: ChainFixture) => Promise<void>,
): Promise<void> {
  await using serving = await startServingMemoryServer({
    apiUrl: new URL(import.meta.url),
    policy: { flushDeadlineMs: 1 },
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: EmulatedStorageManager.connectTo(serving.server, {
      as: owner,
    }),
    experimental: { serverExecution: true },
  });
  const space = owner.did() as MemorySpace;
  let cancel: (() => void) | undefined;
  try {
    const pattern = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: CHAIN_SOURCE }],
    }, { space });
    const result = runtime.getCell<Chain>(space, "chain", pattern.resultSchema);
    const start = runtime.edit();
    runtime.run(start, pattern, {}, result);
    expect((await start.commit().settled).error).toBeUndefined();
    cancel = result.sink(() => {});
    await waitForCellValue<Chain>(
      runtime,
      result,
      (value) => value?.landed === "",
    );
    await body({
      serving,
      host: serving.host.host!,
      runtime,
      start: async (value) => {
        result.key("start").send({ value });
        await runtime.idle();
        await runtime.storageManager.synced();
      },
      landed: () => result.key("landed").get(),
    });
  } finally {
    cancel?.();
    await serving.host.close();
    await runtime.dispose();
  }
}

describe("ExecutorHost", () => {
  describe("constructor()", () => {
    it("activates the space an admitted commit names in the serving context, though called from outside it", async () => {
      // A warm notice activates its space with no session open on it, so the
      // admission hook is the only thing that starts the activation.
      const server = newLoopbackServer();
      let observer: ServerExecutionObserver | undefined;
      const setObserver = server.setServerExecutionObserver.bind(server);
      server.setServerExecutionObserver = (next) => {
        observer = next;
        setObserver(next);
      };
      const factory = servingRuntimeFactory({
        server,
        identity: service,
        apiUrl: new URL(import.meta.url),
      });
      const builds: boolean[] = [];
      const settled = defer<string>();
      const host = new ExecutorHost({
        server,
        serviceIdentity: service.did(),
        ensureSpaceRoots: false,
        createRuntime: (space, context) => {
          builds.push(inServingContext());
          return factory(space, context);
        },
        onActivationSettled: (_space, outcome) => settled.resolve(outcome),
      });
      try {
        observer!.commitAdmitted!({
          space: owner.did(),
          seq: 1,
          class: "authored",
          sessionId: "executor-host-test",
          writes: [],
          warm: true,
        });
        expect(await settled.promise).toBe("active");
      } finally {
        await host.close();
        await server.close();
      }
      expect(builds).toStrictEqual([true]);
    });
  });

  describe("whenQuiescent()", () => {
    it("resolves after every link of a cascade of handlers' own events has committed", async () => {
      await withChain(async ({ host, runtime, start, landed }) => {
        await start("first");
        await host.whenQuiescent();
        await runtime.storageManager.pullOpenSpacesToHead();
        await runtime.idle();
        expect(landed()).toBe("first");
      });
    });

    it("waits for a served fetch and for what its answer writes", async () => {
      // The fetch answers well after the loop has run out of anything else to
      // do, so the value is there only if the wait covered the fetch.
      let answered = false;
      await using serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
        fetch: async () => {
          for (let turn = 0; turn < 200; turn++) await Deno.stat(".");
          answered = true;
          return new Response('{"v":7}', {
            headers: { "content-type": "application/json" },
          });
        },
      });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(serving.server, {
          as: owner,
        }),
        experimental: { serverExecution: true },
      });
      const space = owner.did() as MemorySpace;
      let cancel: (() => void) | undefined;
      try {
        const pattern = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: FETCH_SOURCE }],
        }, { space });
        const result = runtime.getCell<{ v?: number }>(
          space,
          "fetch",
          pattern.resultSchema,
        );
        const start = runtime.edit();
        runtime.run(start, pattern, {}, result);
        expect((await start.commit().settled).error).toBeUndefined();
        cancel = result.sink(() => {});
        await runtime.idle();
        await runtime.storageManager.synced();
        await serving.host.host!.whenQuiescent();
        expect(answered).toBe(true);
        await runtime.storageManager.pullOpenSpacesToHead();
        await runtime.idle();
        expect(result.get()?.v).toBe(7);
      } finally {
        cancel?.();
        await serving.host.close();
        await runtime.dispose();
      }
    });

    it("answers the same value until a loop does anything further", async () => {
      await withChain(async ({ host, start }) => {
        const before = await host.whenQuiescent();
        expect(await host.whenQuiescent()).toBe(before);
        await start("first");
        expect(await host.whenQuiescent()).not.toBe(before);
      });
    });

    it("resolves once the host has closed", async () => {
      await withChain(async ({ host }) => {
        await host.close();
        await expect(host.whenQuiescent()).resolves.toBeGreaterThanOrEqual(0);
      });
    });
  });
});
