import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  type CommitPrecondition,
  commitPreconditionValueHash,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { defer } from "@commonfabric/utils/defer";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { createCell, sendEvent } from "../src/cell.ts";
import { startServingMemoryServer } from "../src/executor/serving-memory-server.deno.ts";
import type {
  WaveCommitRejection,
  WaveCommitSink,
  WaveSpaceCommit,
} from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { ArrivalLog } from "./support/serving-waits.ts";

const signer = await Identity.fromPassphrase("pin document");
const space = signer.did() as MemorySpace;

type Observed = { state: string; revision: string };

const saved: Observed = { state: "saved", revision: "R1" };
const archived: Observed = { state: "archived", revision: "R2" };

// `confirm` reports what it observed and writes nothing to the document it
// observed, which is the shape a pin exists for. `count` touches neither of
// those documents.
const PATTERN = `
import { handler, pattern, Stream, Writable } from "commonfabric";
type Observed = { state: string; revision: string };
type Outcome = { state?: string; revision?: string };
const confirm = handler<
  unknown,
  { observed: Writable<Observed>; outcome: Writable<Outcome> }
>((_event, { observed, outcome }) => {
  observed.pinDocument();
  const seen = observed.get();
  outcome.set({ state: seen.state, revision: seen.revision });
});
const count = handler<unknown, { tally: Writable<number> }>(
  (_event, { tally }) => {
    tally.set((tally.get() ?? 0) + 1);
  },
);
export default pattern<
  {
    observed: Writable<Observed>;
    outcome: Writable<Outcome>;
    tally: Writable<number>;
  },
  { confirm: Stream<unknown>; count: Stream<unknown> }
>(({ observed, outcome, tally }) => ({
  confirm: confirm({ observed, outcome }),
  count: count({ tally }),
}));
`;

/** The pins `tx` carries for its commit to `space`. */
const pinsOf = (tx: IExtendedStorageTransaction): CommitPrecondition[] =>
  (tx.getCommitPreconditions?.(space) ?? []).filter((precondition) =>
    precondition.kind === "entity-value-hash"
  );

describe("pinDocument()", () => {
  describe("in a handler's transaction", () => {
    let storageManager: EmulatedStorageManager;
    let runtime: Runtime;
    let observedId: string;
    let tx: IExtendedStorageTransaction;

    beforeEach(async () => {
      storageManager = EmulatedStorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const seed = runtime.edit();
      const observed = runtime.getCell<Observed>(
        space,
        "pin-rules-observed",
        undefined,
        seed,
      );
      observed.set(saved);
      runtime.getCell<{ observed: unknown }>(
        space,
        "pin-rules-holder",
        undefined,
        seed,
      ).set({ observed });
      expect((await seed.commit()).error).toBeUndefined();
      await storageManager.synced();
      observedId = observed.getAsNormalizedFullLink().id;
      tx = runtime.edit();
    });

    afterEach(async () => {
      tx.abort();
      await runtime.dispose();
      await storageManager.close();
    });

    /** Runs `body` in a handler frame over `tx`. */
    const inHandler = (body: () => void): void => {
      const frame = pushFrame({
        runtime,
        tx,
        space,
        generatedIdCounter: 0,
        inHandler: true,
      });
      try {
        body();
      } finally {
        popFrame(frame);
      }
    };

    /** The `pin-rules-observed` cell, bound to `tx`. */
    const observedCell = () =>
      runtime.getCell<Observed>(space, "pin-rules-observed", undefined, tx);

    it("pins the whole document's value, from a cell pointing inside it", () => {
      inHandler(() => observedCell().key("state").pinDocument());

      expect(pinsOf(tx)).toEqual([{
        kind: "entity-value-hash",
        id: observedId,
        scope: "space",
        valueHash: commitPreconditionValueHash(saved),
      }]);
    });

    it("pins the document a link leads to, not the one holding the link", () => {
      inHandler(() =>
        runtime.getCell<{ observed: Observed }>(
          space,
          "pin-rules-holder",
          undefined,
          tx,
        ).key("observed").pinDocument()
      );

      expect(
        pinsOf(tx).map((pin) => pin.kind === "entity-value-hash" && pin.id),
      )
        .toEqual([observedId]);
    });

    it("pins `null` for a document that holds no value", () => {
      inHandler(() =>
        runtime.getCell<Observed>(space, "pin-rules-absent", undefined, tx)
          .pinDocument()
      );

      expect(pinsOf(tx)).toEqual([expect.objectContaining({
        valueHash: null,
      })]);
    });

    it("keeps the first pin's baseline through a later write and a second call", () => {
      inHandler(() => {
        observedCell().pinDocument();
        observedCell().set(archived);
        observedCell().pinDocument();
      });

      expect(pinsOf(tx)).toEqual([expect.objectContaining({
        valueHash: commitPreconditionValueHash(saved),
      })]);
    });

    it("throws for a document the transaction has already written", () => {
      inHandler(() => {
        observedCell().set(archived);
        expect(() => observedCell().pinDocument()).toThrow(
          "must precede every write",
        );
      });
      expect(pinsOf(tx)).toEqual([]);
    });

    it("throws for a document that is not space-scoped", () => {
      inHandler(() => {
        const scoped = createCell<Observed>(runtime, {
          ...observedCell().getAsNormalizedFullLink(),
          scope: "user",
        }, tx);
        expect(() => scoped.pinDocument()).toThrow("space-scoped");
      });
      expect(pinsOf(tx)).toEqual([]);
    });

    it("throws outside a handler", () => {
      expect(() => observedCell().pinDocument()).toThrow("only in a handler");
      expect(pinsOf(tx)).toEqual([]);
    });
  });

  describe("against a concurrent commit", () => {
    /** One client runtime, connected as `signer`. */
    type Client = { runtime: Runtime; storage: EmulatedStorageManager };

    let clients: Client[];
    let stops: Array<() => void>;

    beforeEach(() => {
      clients = [];
      stops = [];
    });

    afterEach(async () => {
      for (const stop of stops) stop();
      for (const { runtime, storage } of clients.reverse()) {
        await runtime.dispose();
        await storage.close();
      }
    });

    /** A client runtime over `server`, which `afterEach` disposes. */
    const connect = (
      server: MemoryV2Server.Server,
      serverExecution: boolean,
    ): Runtime => {
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: { serverExecution },
      });
      clients.push({ runtime, storage });
      return runtime;
    };

    /** A sink that reads through `sink`, and commits through `commitWave`. */
    const withCommitWave = (
      sink: WaveCommitSink,
      commitWave: WaveCommitSink["commitWave"],
    ): WaveCommitSink => ({
      currentHeads: (space, docs) => sink.currentHeads(space, docs),
      concurrentWritePaths: (space, doc, sinceSeq) =>
        sink.concurrentWritePaths(space, doc, sinceSeq),
      intrusionSince: sink.intrusionSince?.bind(sink),
      commitWave,
    });

    /**
     * Stands the pattern up on `runtime`, over an `observed` document holding
     * `saved`, and returns its streams.
     */
    const standUp = async (runtime: Runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: PATTERN }],
      }, { space });
      const observed = runtime.getCell<Observed>(space, "pin-observed");
      const outcome = runtime.getCell<Partial<Observed>>(space, "pin-outcome");
      const tally = runtime.getCell<number>(space, "pin-tally");
      const result = runtime.getCell<Record<string, unknown>>(
        space,
        "pin-result",
        compiled.resultSchema,
      );
      for (const cell of [observed, outcome, tally, result]) await cell.sync();
      const tx = runtime.edit();
      observed.withTx(tx).set(saved);
      outcome.withTx(tx).set({});
      tally.withTx(tx).set(0);
      runtime.run(tx, compiled, { observed, outcome, tally }, result);
      expect((await tx.commit({ resolveAt: "verdict" })).error)
        .toBeUndefined();
      result.sink(() => {});
      await runtime.idle();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.storageManager.synced();
      return {
        confirm: result.key("confirm"),
        count: result.key("count"),
      };
    };

    /** Commits `value` to the `observed` document from `runtime`. */
    const commitObserved = async (runtime: Runtime, value: Observed) => {
      const observed = runtime.getCell<Observed>(space, "pin-observed");
      await observed.sync();
      const tx = runtime.edit();
      observed.withTx(tx).set(value);
      expect((await tx.commit({ resolveAt: "verdict" })).error)
        .toBeUndefined();
    };

    /**
     * Each value `server` stores for the document `cause` names, in the order
     * the commits writing it were admitted, which `afterEach` stops recording.
     */
    const admitted = async (
      server: MemoryV2Server.Server,
      runtime: Runtime,
      cause: string,
    ): Promise<unknown[]> => {
      const engine = await server.engineForSpace(space);
      const id = runtime.getCell(space, cause).getAsNormalizedFullLink().id;
      const values: unknown[] = [];
      stops.push(server.watchAdmittedCommits((notice) => {
        if (
          notice.space === space &&
          notice.writes.some((write) => write.id === id)
        ) {
          values.push(Engine.read(engine, { id })?.value);
        }
      }));
      return values;
    };

    it("re-runs a handler whose observation went stale, with server execution off", async () => {
      // The handler's first commit is held, after its run observed `saved`,
      // while a peer commits.

      const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
      try {
        const runtime = connect(server, false);
        const streams = await standUp(runtime);
        const outcomes = await admitted(server, runtime, "pin-outcome");

        const held = new ArrivalLog<void>();
        const release = defer<void>();
        let armed = true;
        const edit = runtime.edit.bind(runtime);
        runtime.edit = (options) => {
          const tx = edit(options);
          const commit = tx.commit.bind(tx);
          tx.commit = async (commitOptions) => {
            if (armed && tx.dispatchedEventId !== undefined) {
              armed = false;
              held.record();
              await release.promise;
            }
            return await commit(commitOptions);
          };
          return tx;
        };
        try {
          const acks = new ArrivalLog<string>();
          sendEvent(
            streams.confirm,
            {},
            (tx) => acks.record(tx.status().status),
          );
          await held.reached(1);
          await commitObserved(connect(server, false), archived);
          release.resolve();
          await acks.reached(1);

          expect(acks.entries).toEqual(["done"]);
          expect(outcomes).toEqual([archived]);
        } finally {
          release.resolve();
          runtime.edit = edit;
        }
      } finally {
        await server.close();
      }
    });

    it("re-runs a handler whose observation went stale, with server execution on", async () => {
      // The wave carrying `confirm`'s consequence is held at the commit step
      // while a peer commits, so the run being committed observed `saved`.

      const held = new ArrivalLog<void>();
      const release = defer<void>();
      let armed = true;
      await using serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
        decorateWaveCommitSink: (sink) =>
          withCommitWave(sink, async (batch) => {
            if (armed && batch.consequenceOf.length > 0) {
              armed = false;
              held.record();
              await release.promise;
            }
            return await sink.commitWave(batch);
          }),
      });
      try {
        const runtime = connect(serving.server, true);
        const streams = await standUp(runtime);
        const outcomes = await admitted(serving.server, runtime, "pin-outcome");

        const acks = new ArrivalLog<string>();
        sendEvent(streams.confirm, {}, (tx) => acks.record(tx.status().status));
        await held.reached(1);
        await commitObserved(connect(serving.server, true), archived);
        release.resolve();
        await acks.reached(1);

        expect(acks.entries).toEqual(["done"]);
        expect(outcomes).toEqual([archived]);
      } finally {
        release.resolve();
      }
    });

    it("requeues only the run whose pin failed, and commits the rest of its wave", async () => {
      // The first wave, carrying a `count`, is held while a `confirm` and a
      // second `count` are appended, so that the two land in the next wave
      // together. That wave is held in turn while a peer commits.

      const commits: Array<{
        batch: WaveSpaceCommit;
        error?: WaveCommitRejection;
      }> = [];
      const held = new ArrivalLog<WaveSpaceCommit>();
      const releases = [defer<void>(), defer<void>()];
      await using serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
        decorateWaveCommitSink: (sink) =>
          withCommitWave(sink, async (batch) => {
            // The first consequence-carrying batch, and then the first batch
            // carrying the pin: a refused batch is offered again, and the
            // offer of the first one again must not take the second hold.
            const hold = held.entries.length === 0
              ? batch.consequenceOf.length > 0 ? releases[0] : undefined
              : held.entries.length === 1 &&
                  batch.preconditions.some((precondition) =>
                    precondition.kind === "entity-value-hash"
                  )
              ? releases[1]
              : undefined;
            if (hold !== undefined) {
              held.record(batch);
              await hold.promise;
            }
            const result = await sink.commitWave(batch);
            commits.push({ batch, error: result.error });
            return result;
          }),
      });
      try {
        const runtime = connect(serving.server, true);
        const streams = await standUp(runtime);
        const outcomes = await admitted(serving.server, runtime, "pin-outcome");
        const tallies = await admitted(serving.server, runtime, "pin-tally");

        const acks = new ArrivalLog<string>();
        const appends = new ArrivalLog<boolean>();
        const send = (stream: typeof streams.count, name: string) =>
          sendEvent(
            stream,
            {},
            (tx) => acks.record(`${name} ${tx.status().status}`),
            {
              onAppended: (delivery) => appends.record(delivery.delivered),
            },
          );
        send(streams.count, "first count");
        await held.reached(1);
        send(streams.confirm, "confirm");
        send(streams.count, "second count");
        await appends.reached(3);
        releases[0].resolve();
        await held.reached(2);
        await commitObserved(connect(serving.server, true), archived);
        releases[1].resolve();
        await acks.reached(3);

        const together = held.entries[1];
        expect(together.consequenceOf).toHaveLength(2);
        const pinIndex = together.preconditions.findIndex((precondition) =>
          precondition.kind === "entity-value-hash"
        );
        const refused = commits.findIndex((commit) =>
          commit.batch === together
        );
        expect(commits[refused].error?.failedPreconditions).toEqual([pinIndex]);
        expect(commits[refused + 1].error).toBeUndefined();
        expect(commits[refused + 1].batch.consequenceOf).toHaveLength(1);
        expect(together.consequenceOf).toContain(
          commits[refused + 1].batch.consequenceOf[0],
        );
        expect(acks.entries).toEqual([
          "first count done",
          "second count done",
          "confirm done",
        ]);
        expect(tallies).toEqual([1, 2]);
        expect(outcomes).toEqual([archived]);
      } finally {
        for (const release of releases) release.resolve();
      }
    });
  });
});
