/**
 * A handler's read-then-write against a commit its replica had not seen yet.
 *
 * A peer's commit lands in the store, and the handler's replica has not heard
 * of it when the handler reads. The handler's write is computed from the old
 * value, so it must not land over the peer's: with server execution off, the
 * read travels with the commit and Memory refuses it as stale. On a serving
 * runtime the handler seals into a wave, which drops the read and checks each
 * written document's head against the store's seq when the wave opened. A
 * seal opens the wave, so the peer's commit sits at or below that seq and the
 * check passes. Both cases here hold the handler to the same outcome.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { PatchOp } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import type { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import {
  stampWaveRunContext,
  type WaveCommitSink,
} from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { ServingWaves } from "./support/serving-waves.ts";

const signer = await Identity.fromPassphrase("serving handler stale read");
const space = signer.did() as MemorySpace;

const counterSchema = {
  type: "number",
  // deno-lint-ignore no-explicit-any
} as any;

const recordSchema = {
  type: "object",
  properties: { a: { type: "number" }, c: { type: "number" } },
  // deno-lint-ignore no-explicit-any
} as any;

/** The peer session's commit counter, one per commit it makes. */
let peerLocalSeq = 0;

/**
 * Commits `value` as `cell`'s whole value straight to `engine` from another
 * session, so no replica hears of it, and returns the commit's seq.
 */
const commitUnseen = (
  engine: Engine.Engine,
  cell: Cell<number>,
  value: number,
): number =>
  Engine.applyCommit(engine, {
    sessionId: "session:peer",
    commit: {
      localSeq: ++peerLocalSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: cell.getAsNormalizedFullLink().id,
        value: { value },
      }],
    },
  }).seq;

/**
 * Commits `patches` to `cell`'s document straight to `engine` from another
 * session, so no replica hears of it, and returns the commit's seq.
 */
const patchUnseen = (
  engine: Engine.Engine,
  cell: Cell<unknown>,
  patches: PatchOp[],
): number =>
  Engine.applyCommit(engine, {
    sessionId: "session:peer",
    commit: {
      localSeq: ++peerLocalSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: cell.getAsNormalizedFullLink().id,
        patches,
      }],
    },
  }).seq;

/** The cell's document as `engine` holds it. */
const stored = (engine: Engine.Engine, cell: Cell<unknown>): unknown =>
  Engine.read(engine, { id: cell.getAsNormalizedFullLink().id });

/**
 * `inner`, with `race` run after its stale-read check has answered and
 * before the wave commits: the window between the accumulator's own check
 * and the sink's store transaction, which a commit admitted there has to be
 * caught in.
 */
const racing = (
  inner: EngineWaveCommitSink,
  race: () => void,
): WaveCommitSink => ({
  currentHeads: (space, docs) => inner.currentHeads(space, docs),
  concurrentWritePaths: (space, doc, sinceSeq) =>
    inner.concurrentWritePaths(space, doc, sinceSeq),
  intrusionSince: (space, doc, sinceSeq, holder) =>
    inner.intrusionSince(space, doc, sinceSeq, holder),
  sessionOverwritePathsSince: (space, doc, sinceSeq, session) =>
    inner.sessionOverwritePathsSince(space, doc, sinceSeq, session),
  staleReads: async (space, reads, holder) => {
    const stale = await inner.staleReads(space, reads, holder);
    race();
    return stale;
  },
  commitWave: (batch) => inner.commitWave(batch),
  commitSpaceAccessChange: (change) => inner.commitSpaceAccessChange(change),
});

describe("serving-handler-stale-read", () => {
  describe("with server execution off", () => {
    let server: MemoryV2Server.Server;
    let storage: EmulatedStorageManager;
    let runtime: Runtime;

    beforeEach(() => {
      server = newSharedServer();
      storage = EmulatedStorageManager.connectTo(server, { as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
    });
    afterEach(async () => {
      await runtime?.dispose();
      await storage?.close();
      await server?.close();
    });

    it("refuses a handler's write computed from a value the store has replaced", async () => {
      const seed = runtime.edit();
      const counter = runtime.getCell<number>(
        space,
        "counter",
        counterSchema,
        seed,
      );
      counter.set(0);
      expect((await seed.commit().settled).error).toBeUndefined();
      await storage.synced();
      const engine = await server.engineForSpace(space);

      commitUnseen(engine, counter, 5);
      const tx = runtime.edit();
      const handled = counter.withTx(tx);
      expect(handled.get(), "the replica has not seen the peer").toBe(0);
      handled.set(handled.get() + 1);
      const { error } = await tx.commit().settled;

      expect(error?.name).toBe("ConflictError");
      expect(stored(engine, counter)).toEqual({ value: 5 });
    });
  });

  describe("with server execution on", () => {
    let waves: ServingWaves;

    beforeEach(async () => {
      waves = await ServingWaves.open(signer);
    });
    afterEach(async () => {
      await waves.dispose();
    });

    it("keeps a commit that lands after the wave opened from being overwritten", async () => {
      const { runtime, engine } = waves;
      const counter = runtime.getCell<number>(space, "counter", counterSchema);
      const seed = runtime.edit();
      counter.withTx(seed).set(0);
      expect((await seed.commit().settled).error).toBeUndefined();
      await waves.storageManager.synced();
      waves.serve();

      waves.openWave();
      commitUnseen(engine, counter, 5);
      const tx = runtime.edit();
      stampWaveRunContext(tx, { actionId: "increment", kind: "event-handler" });
      const handled = counter.withTx(tx);
      handled.set(handled.get() + 1);
      await tx.commit().settled;
      await waves.commitWave();

      expect(stored(engine, counter)).toEqual({ value: 5 });
    });

    it("keeps a commit the handler's replica never saw from being overwritten", async () => {
      const { runtime, engine } = waves;
      const counter = runtime.getCell<number>(space, "counter", counterSchema);
      const seed = runtime.edit();
      counter.withTx(seed).set(0);
      expect((await seed.commit().settled).error).toBeUndefined();
      await waves.storageManager.synced();
      waves.serve();

      const peerSeq = commitUnseen(engine, counter, 5);
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "increment",
        kind: "event-handler",
        eventId: "increment-1",
      });
      const handled = counter.withTx(tx);
      expect(handled.get(), "the replica has not seen the peer").toBe(0);
      handled.set(handled.get() + 1);
      await tx.commit().settled;
      const outcome = await waves.commitWave();

      expect(stored(engine, counter)).toEqual({ value: 5 });
      expect(outcome.requeuedEventIds).toEqual(["increment-1"]);
      expect(outcome.staleReadRequeues).toBe(1);
      expect(outcome.requeueCatchUp).toMatchObject([{
        eventId: "increment-1",
        docs: [{ id: counter.getAsNormalizedFullLink().id, seq: peerSeq }],
      }]);
    });

    it("requeues a handler whose stale read was of a doc other than the one it wrote", async () => {
      const { runtime, engine } = waves;
      const counter = runtime.getCell<number>(space, "counter", counterSchema);
      const mirror = runtime.getCell<number>(space, "mirror", counterSchema);
      const seed = runtime.edit();
      counter.withTx(seed).set(0);
      mirror.withTx(seed).set(0);
      expect((await seed.commit().settled).error).toBeUndefined();
      await waves.storageManager.synced();
      waves.serve();

      const peerSeq = commitUnseen(engine, counter, 5);
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "mirror",
        kind: "event-handler",
        eventId: "mirror-1",
      });
      mirror.withTx(tx).set(counter.withTx(tx).get() + 1);
      await tx.commit().settled;
      const outcome = await waves.commitWave();

      expect(stored(engine, mirror)).toEqual({ value: 0 });
      expect(outcome.requeuedEventIds).toEqual(["mirror-1"]);
      expect(outcome.requeueCatchUp).toMatchObject([{
        eventId: "mirror-1",
        docs: [{ id: counter.getAsNormalizedFullLink().id, seq: peerSeq }],
      }]);
    });

    it("requeues a handler whose read a commit staled between the wave's check and its commit", async () => {
      const { runtime, engine } = waves;
      const counter = runtime.getCell<number>(space, "counter", counterSchema);
      const mirror = runtime.getCell<number>(space, "mirror", counterSchema);
      const seed = runtime.edit();
      counter.withTx(seed).set(0);
      mirror.withTx(seed).set(0);
      expect((await seed.commit().settled).error).toBeUndefined();
      await waves.storageManager.synced();
      waves.serve();

      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "mirror",
        kind: "event-handler",
        eventId: "mirror-2",
      });
      mirror.withTx(tx).set(counter.withTx(tx).get() + 1);
      await tx.commit().settled;
      let peerSeq = 0;
      const outcome = await waves.commitWave(
        racing(waves.sink(), () => {
          peerSeq = commitUnseen(engine, counter, 5);
        }),
      );

      expect(peerSeq).not.toBe(0);
      expect(stored(engine, mirror)).toEqual({ value: 0 });
      expect(outcome.requeuedEventIds).toEqual(["mirror-2"]);
      expect(outcome.staleReadRequeues).toBe(1);
      expect(outcome.requeueCatchUp).toMatchObject([{
        eventId: "mirror-2",
        docs: [{ id: counter.getAsNormalizedFullLink().id, seq: peerSeq }],
      }]);
    });

    it("requeues a handler whose reads of two docs a commit staled between the wave's check and its commit, and waits for both", async () => {
      const { runtime, engine } = waves;
      const counter = runtime.getCell<number>(space, "counter", counterSchema);
      const other = runtime.getCell<number>(space, "other", counterSchema);
      const mirror = runtime.getCell<number>(space, "mirror", counterSchema);
      const seed = runtime.edit();
      counter.withTx(seed).set(0);
      other.withTx(seed).set(0);
      mirror.withTx(seed).set(0);
      expect((await seed.commit().settled).error).toBeUndefined();
      await waves.storageManager.synced();
      waves.serve();

      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "mirror",
        kind: "event-handler",
        eventId: "mirror-3",
      });
      mirror.withTx(tx).set(
        counter.withTx(tx).get() + other.withTx(tx).get() + 1,
      );
      await tx.commit().settled;
      let counterSeq = 0;
      let otherSeq = 0;
      const outcome = await waves.commitWave(
        racing(waves.sink(), () => {
          counterSeq = commitUnseen(engine, counter, 5);
          otherSeq = commitUnseen(engine, other, 7);
        }),
      );

      expect(stored(engine, mirror)).toEqual({ value: 0 });
      expect(outcome.requeuedEventIds).toEqual(["mirror-3"]);
      const waitsFor = outcome.requeueCatchUp
        .filter((gate) => gate.eventId === "mirror-3")
        .flatMap((gate) => gate.docs.map((doc) => [doc.id, doc.seq]))
        .sort();
      expect(waitsFor).toEqual([
        [counter.getAsNormalizedFullLink().id, counterSeq],
        [other.getAsNormalizedFullLink().id, otherSeq],
      ].sort());
    });

    it("requeues the later entries of a requeued event's stream that share its commit seq", async () => {
      const { runtime, engine } = waves;
      const counter = runtime.getCell<number>(space, "counter", counterSchema);
      const first = runtime.getCell<number>(space, "first", counterSchema);
      const seed = runtime.edit();
      counter.withTx(seed).set(0);
      first.withTx(seed).set(0);
      expect((await seed.commit().settled).error).toBeUndefined();
      await waves.storageManager.synced();
      waves.serve();

      commitUnseen(engine, counter, 5);
      const stream = "of:stream-events:batched";
      const head = runtime.edit();
      stampWaveRunContext(head, {
        actionId: "head",
        kind: "event-handler",
        eventId: "e1",
        streamEntry: { sidecarId: stream, index: 0, seq: 1 },
      });
      const handled = counter.withTx(head);
      handled.set(handled.get() + 1);
      await head.commit().settled;
      const later = runtime.edit();
      stampWaveRunContext(later, {
        actionId: "later",
        kind: "event-handler",
        eventId: "e2",
        streamEntry: { sidecarId: stream, index: 1, seq: 1 },
      });
      first.withTx(later).set(1);
      await later.commit().settled;
      const outcome = await waves.commitWave();

      expect(outcome.requeuedEventIds).toEqual(["e1", "e2"]);
      expect(outcome.staleReadRequeues).toBe(2);
      expect(stored(engine, first)).toEqual({ value: 0 });
    });

    it("requeues the later entries of a requeued event's stream with it, and no other stream's", async () => {
      const { runtime, engine } = waves;
      const counter = runtime.getCell<number>(space, "counter", counterSchema);
      const first = runtime.getCell<number>(space, "first", counterSchema);
      const second = runtime.getCell<number>(space, "second", counterSchema);
      const seed = runtime.edit();
      counter.withTx(seed).set(0);
      first.withTx(seed).set(0);
      second.withTx(seed).set(0);
      expect((await seed.commit().settled).error).toBeUndefined();
      await waves.storageManager.synced();
      waves.serve();

      commitUnseen(engine, counter, 5);
      const stream = "of:stream-events:ordered";
      const head = runtime.edit();
      stampWaveRunContext(head, {
        actionId: "head",
        kind: "event-handler",
        eventId: "e1",
        streamEntry: { sidecarId: stream, index: 0, seq: 1 },
      });
      const handled = counter.withTx(head);
      handled.set(handled.get() + 1);
      await head.commit().settled;
      const later = runtime.edit();
      stampWaveRunContext(later, {
        actionId: "later",
        kind: "event-handler",
        eventId: "e2",
        streamEntry: { sidecarId: stream, index: 1, seq: 2 },
      });
      first.withTx(later).set(1);
      await later.commit().settled;
      const elsewhere = runtime.edit();
      stampWaveRunContext(elsewhere, {
        actionId: "elsewhere",
        kind: "event-handler",
        eventId: "e3",
        streamEntry: { sidecarId: "of:stream-events:other", index: 0, seq: 3 },
      });
      second.withTx(elsewhere).set(1);
      await elsewhere.commit().settled;
      const outcome = await waves.commitWave();

      expect(outcome.requeuedEventIds).toEqual(["e1", "e2"]);
      expect(outcome.staleReadRequeues).toBe(2);
      expect(stored(engine, first)).toEqual({ value: 0 });
      expect(stored(engine, second)).toEqual({ value: 1 });
    });

    it("rebases a handler whose reads are current over a concurrent patch to another field", async () => {
      const { runtime, engine } = waves;
      const record = runtime.getCell<{ a: number; c: number }>(
        space,
        "record",
        recordSchema,
      );
      const seed = runtime.edit();
      record.withTx(seed).set({ a: 0, c: 0 });
      expect((await seed.commit().settled).error).toBeUndefined();
      await waves.storageManager.synced();
      waves.serve();

      waves.openWave();
      patchUnseen(engine, record, [{
        op: "replace",
        path: "/value/c",
        value: 7,
      }]);
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "set-a",
        kind: "event-handler",
        eventId: "set-a-1",
      });
      record.withTx(tx).key("a").set(1);
      await tx.commit().settled;
      const outcome = await waves.commitWave();

      expect(outcome.requeuedEventIds).toEqual([]);
      expect(stored(engine, record)).toEqual({ value: { a: 1, c: 7 } });
    });
  });
});
