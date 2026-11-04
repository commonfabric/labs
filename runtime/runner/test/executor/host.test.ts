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
  type ServingMemoryServerOptions,
  startServingMemoryServer,
} from "../../src/executor/serving-memory-server.deno.ts";
import { servingRuntimeFactory } from "../../src/executor/serving-runtime.ts";
import type { Cell } from "../../src/cell.ts";
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

/** What {@link withPattern} hands the test it runs. */
type PatternFixture = {
  serving: ServingMemoryServer;
  host: ExecutorHost;
  runtime: Runtime;
  space: MemorySpace;
  result: Cell<Record<string, unknown>>;
};

/**
 * Runs `body` with `source` started in the owner's space by a client that
 * watches its result, on a serving loop given `options`.
 */
async function withPattern(
  source: string,
  options: Pick<ServingMemoryServerOptions, "policy" | "fetch">,
  body: (fixture: PatternFixture) => Promise<void>,
): Promise<void> {
  await using serving = await startServingMemoryServer({
    apiUrl: new URL(import.meta.url),
    ...options,
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
      files: [{ name: "/main.tsx", contents: source }],
    }, { space });
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "result",
      pattern.resultSchema,
    );
    const start = runtime.edit();
    runtime.run(start, pattern, {}, result);
    expect((await start.commit().settled).error).toBeUndefined();
    cancel = result.sink(() => {});
    await body({
      serving,
      host: serving.host.host!,
      runtime,
      space,
      result,
    });
  } finally {
    cancel?.();
    await serving.host.close();
    await runtime.dispose();
  }
}

/**
 * {@link withPattern} for the chain, read to its first value, on a loop that
 * gives every wave one millisecond to settle. A deadline that short cuts the
 * waves, which leaves each handler's event queued for a later wave rather than
 * served in the wave that carries its sender.
 */
function withChain(
  body: (
    fixture: PatternFixture & {
      /** Fires `value` at the chain's first handler, and flushes it out. */
      start(value: string): Promise<void>;
    },
  ) => Promise<void>,
): Promise<void> {
  return withPattern(
    CHAIN_SOURCE,
    { policy: { flushDeadlineMs: 1 } },
    async (fixture) => {
      const { runtime, result } = fixture;
      await waitForCellValue<Record<string, unknown>>(
        runtime,
        result,
        (value) => value?.landed === "",
      );
      await body({
        ...fixture,
        start: async (value) => {
          result.key("start").send({ value });
          await runtime.idle();
          await runtime.storageManager.synced();
        },
      });
    },
  );
}

/** Takes enough turns of the event loop for a wait that was going to end to. */
async function manyTurns(): Promise<void> {
  for (let turn = 0; turn < 2000; turn++) await Deno.stat(".");
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
      await withChain(async ({ host, runtime, result, start }) => {
        await start("first");
        await host.whenQuiescent();
        await runtime.storageManager.pullOpenSpacesToHead();
        await runtime.idle();
        expect(result.key("landed").get()).toBe("first");
      });
    });

    it("stays unresolved while a served fetch is out, and resolves after its answer", async () => {
      const called = defer<void>();
      const answer = defer<void>();
      await withPattern(FETCH_SOURCE, {
        fetch: async () => {
          called.resolve();
          await answer.promise;
          return new Response('{"v":7}', {
            headers: { "content-type": "application/json" },
          });
        },
      }, async ({ host, runtime, result }) => {
        await called.promise;
        let resolved = false;
        const waiting = host.whenQuiescent().then(() => {
          resolved = true;
        });
        await manyTurns();
        expect(resolved).toBe(false);
        answer.resolve();
        await waiting;
        await runtime.storageManager.pullOpenSpacesToHead();
        await runtime.idle();
        expect(result.key("v").get()).toBe(7);
      });
    });

    it("resolves after the demand pass a client's new watch owes", async () => {
      // The fetch starts when the loop takes up the piece, which the watch asks
      // for, and nothing else has happened to wake the loop by then.
      let calls = 0;
      await withPattern(FETCH_SOURCE, {
        fetch: () => {
          calls++;
          return Promise.resolve(
            new Response('{"v":7}', {
              headers: { "content-type": "application/json" },
            }),
          );
        },
      }, async ({ host }) => {
        await host.whenQuiescent();
        expect(calls).toBe(1);
      });
    });

    it("resolves after the activation an admitted commit started", async () => {
      // Nothing has opened a tenure on this space but the commit just above,
      // so the tenure's registration is the first thing that can go wrong.
      const settled: string[] = [];
      await using serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
        onActivationSettled: (_space, outcome) => settled.push(outcome),
      });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(serving.server, {
          as: owner,
        }),
        experimental: { serverExecution: true },
      });
      try {
        const tx = runtime.edit();
        runtime.getCell<number>(owner.did() as MemorySpace, "a-cell", {
          type: "number",
        }).withTx(tx).set(1);
        expect((await tx.commit().settled).error).toBeUndefined();
        await serving.host.host!.whenQuiescent();
        expect(settled).toStrictEqual(["active"]);
      } finally {
        await serving.host.close();
        await runtime.dispose();
      }
    });

    it("resolves after a parked space with a live session is served again", async () => {
      await withChain(async ({ host, space }) => {
        await host.whenQuiescent();
        void host.spaceServer(space)!.park("host-test");
        await host.whenQuiescent();
        expect(host.spaceServer(space)?.active).toBe(true);
      });
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
