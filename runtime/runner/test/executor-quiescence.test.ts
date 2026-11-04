import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { streamEntriesDocId } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";
import type { Cell } from "../src/cell.ts";
import type { ExecutorHost } from "../src/executor/host.ts";
import {
  type ServingMemoryServer,
  type ServingMemoryServerOptions,
  startServingMemoryServer,
} from "../src/executor/serving-memory-server.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const owner = await Identity.fromPassphrase("executor quiescence owner");

/**
 * A chain of handlers, each sending the next one an event on its own account,
 * of which only the last writes. The first holds up its wave past the flush
 * deadline, which leaves the next link queued for a later wave rather than
 * served in the wave that carries its sender.
 */
const CHAIN_SOURCE = `
import { handler, pattern, type Stream, Writable } from "commonfabric";
type Note = { value: string; spent?: number };
const land = handler<Note, { landed: Writable<string> }>(
  (event, { landed }) => landed.set(event.value),
);
const relay = handler<Note, { next: Stream<Note> }>(
  (event, { next }) => next.send(event),
);
const relayAfterTheDeadline = handler<Note, { next: Stream<Note> }>(
  (event, { next }) => {
    // Counted rather than timed: a pattern's clock does not move during a run.
    let spent = 0;
    for (let i = 0; i < 300_000_000; i++) spent = (spent + i) | 0;
    next.send({ value: event.value, spent });
  },
);
export default pattern(() => {
  const landed = new Writable<string>("").for("landed");
  const third = relay({ next: land({ landed }) });
  const second = relay({ next: third });
  return { landed, start: relayAfterTheDeadline({ next: second }) };
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
 * Runs `body` with `source` started in the owner's space by a client, which
 * starts no watch of its result, on a serving loop given `options`.
 */
async function withPattern(
  source: string,
  options: Pick<ServingMemoryServerOptions, "fetch" | "onWaveCycle">,
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
    await body({
      serving,
      host: serving.host.host!,
      runtime,
      space,
      result,
    });
  } finally {
    await serving.host.close();
    await runtime.dispose();
  }
}

/** {@link withPattern} for the chain, read to its first value. */
function withChain(
  body: (
    fixture: PatternFixture & {
      /** Fires `value` at the chain's first handler, and flushes it out. */
      start(value: string): Promise<void>;
    },
  ) => Promise<void>,
): Promise<void> {
  const cancels: Array<() => void> = [];
  return withPattern(
    CHAIN_SOURCE,
    {},
    async (fixture) => {
      const { runtime, result } = fixture;
      cancels.push(result.sink(() => {}));
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
      for (const cancel of cancels) cancel();
    },
  );
}

/**
 * `host.whenQuiescent()` under the stuck-condition net, which fails a test whose
 * loop never comes to rest rather than leaving it to run out its lane.
 */
const quiescence = (host: ExecutorHost): Promise<number> =>
  withStuckNet(host.whenQuiescent(), "the serving loop's quiescence");

/**
 * Takes turns of the event loop for longer than the loop takes to run out of
 * things to do, its demand grace included. A wait that ends early has ended by
 * the time this returns.
 */
async function longAfterTheLoopRests(): Promise<void> {
  for (let turn = 0; turn < 30_000; turn++) await Deno.stat(".");
}

describe("executor-quiescence", () => {
  // Each case asks what `ExecutorHost.whenQuiescent()` has waited for by the
  // time it resolves.

  it("resolves after every link of a cascade of handlers' own events has committed", async () => {
    // Read from the store: the firing client's own view can show its
    // speculative run of the cascade whether or not the loop has finished it.
    await withChain(async ({ serving, host, space, result, start }) => {
      await start("first");
      await quiescence(host);
      const engine = await serving.server.engineForSpace(space);
      const { id } = result.key("landed").resolveAsCell()
        .getAsNormalizedFullLink();
      expect(Engine.selectPendingStreamEventDocs(engine)).toStrictEqual([]);
      expect(JSON.stringify(Engine.read(engine, { id })?.value)).toContain(
        "first",
      );
    });
  });

  it("resolves after a served fetch has answered and its answer is written", async () => {
    let answered = false;
    await withPattern(FETCH_SOURCE, {
      fetch: async () => {
        await longAfterTheLoopRests();
        answered = true;
        return new Response('{"v":7}', {
          headers: { "content-type": "application/json" },
        });
      },
    }, async ({ host, runtime, result }) => {
      const cancel = result.sink(() => {});
      try {
        await runtime.storageManager.synced();
        await quiescence(host);
        expect(answered).toBe(true);
        await runtime.storageManager.pullOpenSpacesToHead();
        await runtime.idle();
        expect(result.key("v").get()).toBe(7);
      } finally {
        cancel();
      }
    });
  });

  it("resolves after a lifecycle verb in the loop's cycle has finished", async () => {
    let finished = false;
    await withPattern(CHAIN_SOURCE, {}, async ({ host, space }) => {
      await quiescence(host);
      const verb = host.runLifecycleVerb(space, {
        name: "held",
        run: async () => {
          await longAfterTheLoopRests();
          finished = true;
          return {};
        },
      });
      await quiescence(host);
      expect(finished).toBe(true);
      await verb;
    });
  });

  it("resolves after the demand pass a client's new watch owes", async () => {
    // A watch asks for a pass through a grace timer, and the loop is otherwise
    // quiet until that fires.
    let cycles = 0;
    await withPattern(CHAIN_SOURCE, {
      onWaveCycle: () => cycles++,
    }, async ({ host, runtime, space }) => {
      await quiescence(host);
      const cyclesBefore = cycles;
      const wakesBefore = host.stats().demand.watchWakes;
      const cancel = runtime.getCell<string>(space, "watched", {
        type: "string",
      }).sink(() => {});
      try {
        await runtime.storageManager.synced();
        expect(host.stats().demand.watchWakes).toBeGreaterThan(wakesBefore);
        await quiescence(host);
        expect(cycles).toBeGreaterThan(cyclesBefore);
      } finally {
        cancel();
      }
    });
  });

  it("finds a frame already applied once `framesApplied()` resolves", async () => {
    // The wait reads what a frame set off in one synchronous stretch, so what
    // the frame carries has to be in the replica by the time this returns.
    await withPattern(CHAIN_SOURCE, {}, async ({ serving, runtime, space }) => {
      const reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(serving.server, {
          as: owner,
        }),
        experimental: { serverExecution: true },
      });
      try {
        const schema = { type: "string" } as const;
        const written = runtime.getCell<string>(space, "written", schema);
        const read = reader.getCell<string>(space, "written", schema);
        const cancel = read.sink(() => {});
        await reader.storageManager.synced();
        const tx = runtime.edit();
        written.withTx(tx).set("arrived");
        expect((await tx.commit().settled).error).toBeUndefined();
        await serving.server.idle();
        await reader.storageManager.inputSynced?.();
        await reader.storageManager.framesApplied?.();
        expect(read.getRaw()).toBe("arrived");
        cancel();
      } finally {
        await reader.dispose();
      }
    });
  });

  it("resolves after an event only a backstop will drain again has its consequence", async () => {
    // The stream belongs to no piece, so each drain defers it and leaves it for
    // the rescan timer, until the deferrals run out and it is dropped. Between
    // those drains the loop is suspended with nothing to do but wait for that
    // timer.
    await withPattern(CHAIN_SOURCE, {}, async ({ serving, host, space }) => {
      const stream = { id: "of:no-such-piece", path: ["stream"] };
      const sidecar = streamEntriesDocId(stream);
      await serving.server.commitDelegatedAppend({
        targetSpace: space,
        targetStream: sidecar,
        targetStreamLink: stream,
        eventId: "evt-unrunnable",
        payload: {},
        actingPrincipal: owner.did(),
        actingSession: "quiescence-session",
        capabilityRef: "cap-quiescence",
        sessionId: `service:${space}`,
        localSeq: 990_100,
      });
      await quiescence(host);
      const engine = await serving.server.engineForSpace(space);
      expect(Engine.selectPendingStreamEventDocs(engine)).toStrictEqual([]);
      expect(host.stats().events.deferredRescansFired).toBeGreaterThan(0);
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
      await quiescence(serving.host.host!);
      expect(settled).toStrictEqual(["active"]);
    } finally {
      await serving.host.close();
      await runtime.dispose();
    }
  });

  it("resolves after a parked space with a live session is served again", async () => {
    await withChain(async ({ host, space }) => {
      await quiescence(host);
      void host.spaceServer(space)!.park("host-test");
      await quiescence(host);
      expect(host.spaceServer(space)?.active).toBe(true);
    });
  });

  it("resolves with the same value until a loop does anything further", async () => {
    await withChain(async ({ host, start }) => {
      const before = await quiescence(host);
      expect(await quiescence(host)).toBe(before);
      await start("first");
      expect(await quiescence(host)).not.toBe(before);
    });
  });

  it("resolves once the host has closed", async () => {
    await withChain(async ({ host }) => {
      await host.close();
      await expect(host.whenQuiescent()).resolves.toBeGreaterThanOrEqual(0);
    });
  });
});
