import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import {
  type CommitPrecondition,
  type ConfirmedRead,
  type Operation,
  type PendingRead,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { ServedAclChange } from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { Runtime } from "../../src/runtime.ts";
import type { SpaceAccessChange } from "../../src/builder/types.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  ISpaceReplica,
  ITransactionSealSink,
  MemorySpace,
  NativeStorageCommit,
  Result,
  SealedCommitVerdict,
  SealedNativeCommit,
  StorageTransactionRejected,
  Unit,
} from "../../src/storage/interface.ts";
import {
  stageSpaceAccessChanges,
  stampWaveRunContext,
  WaveAccumulator,
  type WaveCommitRejection,
  type WaveCommitSink,
  type WaveLease,
  type WaveRunContext,
  waveSettlementOf,
  type WaveSpaceCommit,
} from "../../src/executor/wave.ts";
import { EngineWaveCommitSink } from "../../src/executor/engine-wave-sink.ts";
import { ExtendedStorageTransaction } from "../../src/storage/extended-storage-transaction.ts";
import { ManagedStorageTransaction } from "../../src/traverse.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("executor wave arms test");
const space = signer.did() as MemorySpace;
const foreignSpace = (await Identity.fromPassphrase("wave arms foreign"))
  .did() as MemorySpace;

/** The count of `messageKey` logged at `level` by the wave's logger. */
const logged = (messageKey: string, level: "warn" | "error"): number =>
  getLoggerCountsBreakdown()["wave-accumulator"]?.[messageKey]?.[level] ?? 0;

/** The path of a read of a whole document. */
const ROOT = toDocumentPath([]);

/** What one transaction seals into one space, as the replica hands it back. */
interface SealSpec {
  /** The space sealed into; the home space when absent. */
  space?: MemorySpace;
  operations: Operation[];
  confirmed?: ConfirmedRead[];
  pending?: PendingRead[];
  preconditions?: CommitPrecondition[];
}

const sealSpecs = new WeakMap<NativeStorageCommit, SealSpec>();

/** A transaction that seals the commits it was built with, in order. */
class SealingTransaction extends ManagedStorageTransaction {
  readonly #seals: readonly SealSpec[];

  constructor(seals: readonly SealSpec[]) {
    super({ load: () => null });
    this.#seals = seals;
  }

  async sealInto(
    sink: ITransactionSealSink,
  ): Promise<Result<Unit, CommitError>> {
    for (const seal of this.#seals) {
      const native: NativeStorageCommit = { operations: [] };
      sealSpecs.set(native, seal);
      const result = await sink.sealSpaceCommit(
        seal.space ?? space,
        native,
        this,
      );
      if (result.error) return result;
    }
    return { ok: {} };
  }
}

/**
 * A replica of `target` that holds nothing, with `extras` for the optional
 * members it implements.
 */
const replicaHoldingNothing = (
  target: MemorySpace,
  extras: Pick<ISpaceReplica, "sealNative"> = {},
): ISpaceReplica => ({
  did: () => target,
  get: () => undefined,
  getDocument: () => undefined,
  hasPendingWrite: () => false,
  confirmedDocumentSeq: () => 0,
  ...extras,
});

/**
 * A replica lookup whose replicas hold nothing, and seal what a
 * `SealingTransaction` hands them, settling each seal with its verdict.
 */
const emptyReplicas = (): (target: MemorySpace) => ISpaceReplica => {
  const localSeqs = new Map<MemorySpace, number>();
  return (target) =>
    replicaHoldingNothing(target, {
      sealNative: (
        native: NativeStorageCommit,
        _source: unknown,
        verdict: Promise<SealedCommitVerdict>,
      ): SealedNativeCommit => {
        const seal = sealSpecs.get(native) ?? { operations: [] };
        const localSeq = (localSeqs.get(target) ?? 0) + 1;
        localSeqs.set(target, localSeq);
        return {
          localSeq,
          commit: {
            localSeq,
            operations: seal.operations,
            reads: {
              confirmed: seal.confirmed ?? [],
              pending: seal.pending ?? [],
            },
            ...(seal.preconditions === undefined
              ? {}
              : { preconditions: seal.preconditions }),
          },
          settled: verdict.then((
            settled,
          ): Result<Unit, StorageTransactionRejected> =>
            "committed" in settled ? { ok: {} } : {
              error: {
                name: "StoreError",
                message: settled.withdrawn.message,
                cause: new Error(settled.withdrawn.message),
              },
            }
          ),
        };
      },
    });
};

/**
 * A sink that records each batch it is handed and answers it with the next
 * of `verdicts`, accepting it once they run out. `overrides` replace the
 * rest of its answers, which otherwise report nothing having moved.
 */
const recordingSink = (
  overrides: Partial<WaveCommitSink> = {},
  verdicts: Result<{ seq: number }, WaveCommitRejection>[] = [],
): { sink: WaveCommitSink; batches: WaveSpaceCommit[] } => {
  const batches: WaveSpaceCommit[] = [];
  let seq = 20;
  const sink: WaveCommitSink = {
    currentHeads: () => Promise.resolve(new Map()),
    concurrentWritePaths: () => Promise.resolve([]),
    commitWave: (batch) => {
      batches.push(batch);
      seq += 1;
      return Promise.resolve(verdicts.shift() ?? { ok: { seq } });
    },
    ...overrides,
  };
  return { sink, batches };
};

/** A write of the whole document `id`. */
const setOf = (id: string): Operation => ({
  op: "set",
  id,
  value: { value: { written: id } },
});

describe("WaveAccumulator", () => {
  describe("with a runtime's transactions", () => {
    let server: MemoryV2Server.Server;
    let storageManager: EmulatedStorageManager;
    let runtime: Runtime;
    let engine: Engine.Engine;
    let lease: WaveLease & { end(): void };

    const newWave = (
      options: Partial<ConstructorParameters<typeof WaveAccumulator>[0]> = {},
    ): WaveAccumulator =>
      new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        scopeKeyIdentity: {
          principal: signer.did(),
          sessionId: "wave-arms-session",
        },
        replicaFor: (s) => storageManager.open(s).replica,
        foreignWrites: "accept",
        foreignWriteGrant: () => true,
        lease,
        ...options,
      });

    const newSink = (): EngineWaveCommitSink =>
      new EngineWaveCommitSink({
        engineFor: () => engine,
        sessionId: executionLeaseHolder(`service:${space}`),
      });

    /** The space's execution lease, whose tenure ends when a test says so. */
    const endableLease = async (): Promise<WaveLease & { end(): void }> => {
      const cycle = new ExecutionLeaseCycle({
        leases: engine.executionLeases,
        space,
        holder: executionLeaseHolder(`service:${space}`),
      });
      if (!await cycle.acquire()) throw new Error("test lease acquire failed");
      let current = true;
      return {
        holder: cycle.holder,
        tenure: cycle.tenure,
        isCurrentTenure: (tenure) => current && cycle.isCurrentTenure(tenure),
        end: () => {
          current = false;
        },
      };
    };

    /** A transaction stamped as `kind` that sets `id` to `{ n }`. */
    const writing = (
      id: string,
      n: number,
      context: Parameters<typeof stampWaveRunContext>[1] = {
        actionId: `write/${id}`,
        kind: "derivation",
      },
      target: MemorySpace = space,
    ): IExtendedStorageTransaction => {
      const tx = runtime.edit();
      stampWaveRunContext(tx, context);
      runtime.getCell<{ n: number }>(target, id, undefined).withTx(tx).set({
        n,
      });
      return tx;
    };

    const stored = (id: string, from = engine) =>
      Engine.read(from, {
        id: runtime.getCell(space, id, undefined).getAsNormalizedFullLink().id,
      });

    beforeEach(async () => {
      server = newSharedServer();
      storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      engine = await server.engineForSpace(space);
      lease = await endableLease();
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
      await server.close();
    });

    describe("seal()", () => {
      it("refuses a transaction once the wave has committed, and takes it before", async () => {
        const wave = newWave();
        expect((await wave.seal(writing("before-close", 1))).error)
          .toBeUndefined();
        await wave.commitWave(newSink());
        await wave.settled();

        const result = await wave.seal(writing("after-close", 2));

        expect(result.error?.name).toBe("StorageTransactionAborted");
        expect((result.error as { reason?: Error }).reason?.message).toBe(
          "wave-closed",
        );
        expect(wave.contributionCount).toBe(1);
        expect(stored("before-close")).not.toBeNull();
        expect(stored("after-close")).toBeNull();
      });

      it("refuses a transaction that cannot seal", async () => {
        const wave = newWave();
        const tx = new ExtendedStorageTransaction(
          new ManagedStorageTransaction({ load: () => null }),
        );
        stampWaveRunContext(tx, { actionId: "unsealable", kind: "derivation" });

        const result = await wave.seal(tx);

        expect(result.error?.name).toBe("StorageTransactionAborted");
        expect((result.error as { reason?: Error }).reason?.message).toBe(
          "seal-unsupported",
        );
        expect(wave.contributionCount).toBe(0);
      });

      it("refuses a second seal while the first is still assembling", async () => {
        const wave = newWave();
        const firstTx = writing("first-seal", 1);
        const secondTx = writing("second-seal", 2);
        const first = wave.seal(firstTx);

        await expect(wave.seal(secondTx)).rejects.toThrow(
          "concurrent seal() calls on one wave",
        );
        expect((await first).error).toBeUndefined();
        expect(wave.contributionCount).toBe(1);
        await wave.commitWave(newSink());
        await wave.settled();
        expect(stored("first-seal")).not.toBeNull();
        expect(stored("second-seal")).toBeNull();
      });
    });

    describe("the seal sink outside a seal", () => {
      it("refuses a space commit and ignores a read set", async () => {
        const wave = newWave();
        const source = new ManagedStorageTransaction({ load: () => null });

        wave.sealSpaceReads(space, [{ space, id: "of:read-outside" }]);
        const result = await wave.sealSpaceCommit(
          space,
          { operations: [] },
          source,
        );

        expect(result.error?.name).toBe("StorageTransactionAborted");
        expect((result.error as { reason?: Error }).reason?.message).toBe(
          "seal-out-of-order",
        );
        expect(wave.contributionCount).toBe(0);
      });
    });

    describe("noteSealFailure()", () => {
      const context = {
        actionId: "handler/late",
        kind: "event-handler" as const,
        eventId: "late-event",
      };

      it("requeues the event while the wave is open", async () => {
        const wave = newWave();
        expect((await wave.seal(writing("noted-open", 1, context))).error)
          .toBeUndefined();
        wave.noteSealFailure(context);

        const outcome = await wave.commitWave(newSink());

        expect(outcome.requeuedEventIds).toEqual(["late-event"]);
        expect(stored("noted-open")).toBeNull();
      });

      it("logs an error and changes nothing once the wave has committed", async () => {
        const wave = newWave();
        expect((await wave.seal(writing("noted-closed", 1, context))).error)
          .toBeUndefined();
        const outcome = await wave.commitWave(newSink());
        const before = logged("seal-failure-after-close", "error");

        wave.noteSealFailure(context);

        expect(logged("seal-failure-after-close", "error")).toBe(before + 1);
        expect(outcome.requeuedEventIds).toEqual([]);
        expect(stored("noted-closed")).not.toBeNull();
      });
    });

    describe("failForeignSpace()", () => {
      it("refuses the wave's own space", () => {
        expect(() => newWave().failForeignSpace(space, "unresolvable")).toThrow(
          "failForeignSpace on the wave's OWN home space",
        );
      });

      it("does nothing once the wave has been abandoned", () => {
        const wave = newWave();
        wave.abandon("test");
        expect(() => wave.failForeignSpace(space, "unresolvable")).not
          .toThrow();
      });
    });

    describe("enqueueOutboundAppend()", () => {
      const append = {
        targetSpace: foreignSpace,
        targetStream: "of:target-stream",
        eventId: "evt-append",
        payload: {},
        actingPrincipal: "user:alice",
        actingSession: "sess-1",
        capabilityRef: "cap-1",
      };

      it("refuses an append once the wave has been abandoned", () => {
        const wave = newWave();
        const tx = writing("append-abandoned", 1);
        wave.abandon("test");
        expect(() => wave.enqueueOutboundAppend(tx, append)).toThrow(
          "nothing may stage appends into it",
        );
      });

      it("refuses an append for a transaction that has sealed", async () => {
        const wave = newWave();
        const tx = writing("append-sealed", 1);
        expect((await wave.seal(tx)).error).toBeUndefined();
        expect(() => wave.enqueueOutboundAppend(tx, append)).toThrow(
          "transaction already sealed",
        );
        expect(wave.hasOutboundAppends).toBe(false);
        wave.abandon("test end");
      });

      it("refuses a userless append that names an acting session, and stages one that does not", () => {
        const wave = newWave();
        const tx = writing("append-userless", 1);
        const userless = {
          ...append,
          actingPrincipal: undefined,
          actingSession: undefined,
          sessionlessSpaceScope: true,
        };
        expect(() =>
          wave.enqueueOutboundAppend(tx, {
            ...userless,
            actingSession: "sess-1",
          })
        ).toThrow("alongside an acting session is a contradiction");
        expect(wave.hasOutboundAppends).toBe(false);

        wave.enqueueOutboundAppend(tx, userless);

        expect(wave.hasUnsealedAppends).toBe(true);
      });
    });

    describe("commitWave()", () => {
      it("refuses a second commit", async () => {
        const wave = newWave();
        await wave.commitWave(newSink());
        await expect(wave.commitWave(newSink())).rejects.toThrow(
          "wave already committed or abandoned",
        );
      });
    });
  });

  describe("with hand-built seals", () => {
    // These seal transactions that hand the wave exactly the commits a case
    // names, into replicas that hold nothing else, and commit through a sink
    // that answers as the case says, so each case assembles the wave it
    // wants and states what the sink was handed.

    const basisSeq = 10;
    const alice = "did:key:z6Mk-wave-arms-alice";
    const sidecar = "of:stream-events:wave-arms";

    const handBuiltWave = (
      options: Partial<ConstructorParameters<typeof WaveAccumulator>[0]> = {},
    ): WaveAccumulator =>
      new WaveAccumulator({
        space,
        basisSeq,
        scopeKeyIdentity: { principal: signer.did(), sessionId: "hand-built" },
        replicaFor: emptyReplicas(),
        foreignWrites: "accept",
        foreignWriteGrant: () => true,
        ...options,
      });

    /** Seals one transaction stamped with `context` that seals `seals`. */
    const sealRun = async (
      wave: WaveAccumulator,
      context: WaveRunContext,
      seals: SealSpec[],
      staged?: ReadonlyMap<MemorySpace, readonly SpaceAccessChange[]>,
    ) => {
      const tx = new ExtendedStorageTransaction(new SealingTransaction(seals));
      stampWaveRunContext(tx, context);
      if (staged !== undefined) stageSpaceAccessChanges(tx, staged);
      return { tx, result: await wave.seal(tx) };
    };

    /** A handler run delivering `eventId`'s durable entry for alice. */
    const delivering = (eventId: string): WaveRunContext => ({
      actionId: `handler/${eventId}`,
      kind: "event-handler",
      eventId,
      streamEntry: { sidecarId: sidecar, index: 0, seq: 4 },
      acting: { user: alice, session: "alice-session" },
      capabilityRef: `event-consequence:${eventId}`,
    });

    /** A lease whose tenure ends when `end()` is called. */
    const endableLease = (): WaveLease & { end(): void } => {
      let current = true;
      return {
        holder: "service:wave-arms",
        tenure: 1,
        isCurrentTenure: () => current,
        end: () => {
          current = false;
        },
      };
    };

    const grantToCarol = new Map<MemorySpace, SpaceAccessChange[]>([[space, [{
      principal: "did:key:z6Mk-wave-arms-carol",
      level: "READ" as const,
      actor: alice,
    }]]]);

    describe("seal()", () => {
      it("refuses a transaction sealing into a space whose replica cannot seal", async () => {
        const replicas = emptyReplicas();
        const wave = handBuiltWave({
          replicaFor: (target) =>
            target === space ? replicas(target) : replicaHoldingNothing(target),
        });

        const home = await sealRun(wave, delivering("home-only"), [{
          operations: [setOf("of:h")],
        }]);
        const crossing = await sealRun(wave, delivering("crossing"), [{
          space: foreignSpace,
          operations: [setOf("of:f")],
        }]);

        expect(home.result.error).toBeUndefined();
        expect(crossing.result.error).toMatchObject({
          name: "StorageTransactionAborted",
          message: `space replica for ${foreignSpace} does not support sealing`,
        });
        expect(wave.contributionCount).toBe(1);
        wave.abandon("test end");
      });
    });

    describe("emitted stream entries", () => {
      it("declares the entries a patch replacing a stream's entry list appends, and marks a copy delivered in the same wave consequenced", async () => {
        const wave = handBuiltWave();
        const entries = [{ eventId: "child" }, { eventId: "stamped", seq: 3 }];
        await sealRun(wave, delivering("parent"), [{
          operations: [{
            op: "patch",
            id: sidecar,
            patches: [{
              op: "replace",
              path: "/value/entries",
              value: entries,
            }],
          }],
        }]);
        await sealRun(wave, {
          actionId: "handler/child",
          kind: "event-handler",
          eventId: "child",
          lt1: true,
        }, [{ operations: [setOf("of:child-output")] }]);
        const { sink, batches } = recordingSink();

        const outcome = await wave.commitWave(sink);

        expect(outcome.orphanDeliveriesRefused).toBe(0);
        expect(outcome.dispositions).toEqual([
          { kind: "committed" },
          { kind: "committed" },
        ]);
        expect(batches[0].eventAppends).toEqual([
          { id: sidecar, eventId: "child" },
        ]);
        expect(batches[0].operations[0]).toEqual({
          op: "patch",
          id: sidecar,
          patches: [{
            op: "replace",
            path: "/value/entries",
            value: [
              { eventId: "child", consequenced: true },
              { eventId: "stamped", seq: 3 },
            ],
          }],
        });
        expect(entries).toEqual([
          { eventId: "child" },
          { eventId: "stamped", seq: 3 },
        ]);
      });
    });

    describe("the per-document conflict check", () => {
      it("keeps a write on a document the loop's own commit moved only for a run that read every document of that commit at or after it", async () => {
        const wave = handBuiltWave();
        wave.noteOwnCommit(12, [
          { id: "of:x", scopeKey: "space" },
          { id: "of:y", scopeKey: "space" },
        ]);
        await sealRun(wave, delivering("saw-commit"), [{
          operations: [setOf("of:x")],
          confirmed: [
            { id: "of:x", path: ROOT, seq: 12 },
            { id: "of:z", path: ROOT, seq: 5 },
          ],
          pending: [{ id: "of:w", path: ROOT, localSeq: 7 }],
        }]);
        await sealRun(wave, delivering("read-before-commit"), [{
          operations: [setOf("of:y")],
          confirmed: [
            { id: "of:y", path: ROOT, seq: 12 },
            { id: "of:x", path: ROOT, seq: 8 },
          ],
        }]);
        const { sink, batches } = recordingSink({
          currentHeads: () =>
            Promise.resolve(new Map([["of:x space", 12], ["of:y space", 12]])),
        });

        const outcome = await wave.commitWave(sink);

        expect(outcome.dispositions).toEqual([
          { kind: "committed" },
          { kind: "requeued" },
        ]);
        expect(outcome.requeuedEventIds).toEqual(["read-before-commit"]);
        expect(batches[0].rebasedHeads).toEqual([
          { doc: "of:x space", head: 12 },
        ]);
        expect(batches[0].operations).toEqual([setOf("of:x")]);
      });

      it("drops the patches the firing session overwrote, and rebases the rest past a concurrent commit to the paths they wrote", async () => {
        const wave = handBuiltWave();
        const sqlite: Operation = {
          op: "sqlite",
          db: { id: "of:wave-arms-db" },
          sql: "SELECT 1",
        };
        const kept: Operation = {
          op: "patch",
          id: "of:d",
          patches: [{ op: "replace", path: "/value/b", value: 2 }],
        };
        await sealRun(wave, delivering("overwritten"), [{
          operations: [
            sqlite,
            {
              op: "patch",
              id: "of:d",
              patches: [{ op: "replace", path: "/value/a", value: 1 }],
            },
            kept,
          ],
        }]);
        const overwriteQueries: unknown[] = [];
        const { sink, batches } = recordingSink({
          currentHeads: () => Promise.resolve(new Map([["of:d space", 11]])),
          concurrentWritePaths: () => Promise.resolve([["value", "a"]]),
          sessionOverwritePathsSince: (_space, doc, sinceSeq, session) => {
            overwriteQueries.push({ doc: doc.id, sinceSeq, session });
            return Promise.resolve([["value", "a"]]);
          },
        });

        const outcome = await wave.commitWave(sink);

        expect(overwriteQueries).toEqual([{
          doc: "of:d",
          sinceSeq: 4,
          session: { principal: alice, sessionId: "alice-session" },
        }]);
        expect(outcome.dispositions).toEqual([
          { kind: "partially-dropped", droppedOps: 1 },
        ]);
        expect(batches[0].operations).toEqual([sqlite, kept]);
        expect(batches[0].rebasedHeads).toEqual([
          { doc: "of:d space", head: 11 },
        ]);
      });

      it("drops a whole-document write only where the firing session overwrote the whole document", async () => {
        const wave = handBuiltWave();
        await sealRun(wave, delivering("whole-writes"), [{
          operations: [setOf("of:e1"), setOf("of:e2")],
        }]);
        const overwritten = new Map([
          ["of:e1", [[]]],
          ["of:e2", [["value", "a"]]],
        ]);
        const { sink, batches } = recordingSink({
          sessionOverwritePathsSince: (_space, doc) =>
            Promise.resolve(overwritten.get(doc.id) ?? []),
        });

        const outcome = await wave.commitWave(sink);

        expect(outcome.dispositions).toEqual([
          { kind: "partially-dropped", droppedOps: 1 },
        ]);
        expect(batches[0].operations).toEqual([setOf("of:e2")]);
      });

      it("drops a derivation's write on a document the commit names conflicted, recording the head as unknown when the sink reports none", async () => {
        const wave = handBuiltWave();
        const { tx } = await sealRun(wave, {
          actionId: "derive/p",
          kind: "derivation",
        }, [{ operations: [setOf("of:p")] }]);
        const { sink, batches } = recordingSink({}, [{
          error: {
            name: "WaveCommitRejected",
            message: "of:p moved",
            conflictedDocs: ["of:p space"],
          },
        }]);

        const outcome = await wave.commitWave(sink);

        expect(batches.length).toBe(1);
        expect(outcome.seq).toBeUndefined();
        expect(outcome.supersededWrites).toBe(1);
        expect(outcome.dispositions).toEqual([{ kind: "dropped" }]);
        const settlement = await waveSettlementOf(tx);
        expect(settlement?.error?.supersededOutputs).toEqual([{
          space,
          id: "of:p",
          scopeKeyIdentity: {
            principal: signer.did(),
            sessionId: "hand-built",
          },
          seq: 0,
        }]);
      });

      it("decides a rebase again against the new head when the commit names the rebased document conflicted", async () => {
        const wave = handBuiltWave();
        await sealRun(wave, delivering("rebased"), [{
          operations: [{
            op: "patch",
            id: "of:r",
            patches: [{ op: "replace", path: "/value/a", value: 1 }],
          }],
        }]);
        let head = 10;
        const { sink, batches } = recordingSink({
          currentHeads: () => {
            head += 1;
            return Promise.resolve(new Map([["of:r space", head]]));
          },
          concurrentWritePaths: () => Promise.resolve([["value", "b"]]),
        }, [{
          error: {
            name: "WaveCommitRejected",
            message: "of:r moved again",
            conflictedDocs: ["of:r space"],
          },
        }]);

        const outcome = await wave.commitWave(sink);

        expect(batches.map((batch) => batch.rebasedHeads)).toEqual([
          [{ doc: "of:r space", head: 11 }],
          [{ doc: "of:r space", head: 12 }],
        ]);
        expect(outcome.dispositions).toEqual([{ kind: "committed" }]);
        expect(outcome.seq).toBe(22);
      });

      it("requeues only the run a stale read the commit names belongs to", async () => {
        const wave = handBuiltWave();
        await sealRun(wave, delivering("stale"), [{
          operations: [setOf("of:sa")],
          confirmed: [{ id: "of:q", path: ROOT, seq: 9 }],
        }]);
        await sealRun(wave, {
          ...delivering("fresh"),
          streamEntry: { sidecarId: `${sidecar}-2`, index: 0, seq: 5 },
        }, [{ operations: [setOf("of:sb")] }]);
        const { sink, batches } = recordingSink({}, [{
          error: {
            name: "WaveCommitRejected",
            message: "stale reads",
            staleReads: [
              { contribution: 0, read: 0, seq: 15 },
              { contribution: 0, read: 3, seq: 16 },
              { contribution: 1, read: 0, seq: 17 },
            ],
          },
        }]);

        const outcome = await wave.commitWave(sink);

        expect(outcome.dispositions).toEqual([
          { kind: "requeued" },
          { kind: "committed" },
        ]);
        expect(outcome.staleReadRequeues).toBe(1);
        expect(outcome.requeueCatchUp).toEqual([{
          eventId: "stale",
          docs: [{ id: "of:q", seq: 15 }],
        }]);
        expect(batches[1].operations).toEqual([setOf("of:sb")]);
      });
    });

    describe("a tenure that ends during the commit step", () => {
      const endingSink = (lease: { end(): void }) =>
        recordingSink({
          currentHeads: () => {
            lease.end();
            return Promise.resolve(new Map());
          },
        });

      it("aborts before the home commit", async () => {
        const lease = endableLease();
        const wave = handBuiltWave({ lease });
        await sealRun(wave, delivering("home"), [{
          operations: [setOf("of:h")],
        }]);
        const { sink, batches } = endingSink(lease);

        const outcome = await wave.commitWave(sink);

        expect(outcome.aborted).toBe("lease-lost");
        expect(outcome.dispositions).toEqual([{ kind: "requeued" }]);
        expect(batches).toEqual([]);
      });

      it("aborts before a foreign provisioning commit", async () => {
        const lease = endableLease();
        const wave = handBuiltWave({ lease });
        await sealRun(wave, delivering("foreign"), [
          { space: foreignSpace, operations: [setOf("of:f")] },
          { operations: [setOf("of:h")] },
        ]);
        const { sink, batches } = endingSink(lease);

        const outcome = await wave.commitWave(sink);

        expect(outcome.aborted).toBe("lease-lost");
        expect(outcome.foreignCommits).toEqual([]);
        expect(batches).toEqual([]);
      });

      it("aborts before an access-list change", async () => {
        const lease = endableLease();
        const committed: unknown[] = [];
        const wave = handBuiltWave({
          lease,
          spaceAccessAuthority: () => Promise.resolve({ admitted: true }),
        });
        await sealRun(wave, delivering("access"), [{
          operations: [setOf("of:h")],
        }], grantToCarol);
        const { sink, batches } = endingSink(lease);
        sink.commitSpaceAccessChange = (change) => {
          committed.push(change);
          return Promise.resolve({ ok: {} });
        };

        const outcome = await wave.commitWave(sink);

        expect(outcome.aborted).toBe("lease-lost");
        expect(committed).toEqual([]);
        expect(batches).toEqual([]);
      });

      it("reads a refusal of the home commit as the lost lease", async () => {
        const lease = endableLease();
        const wave = handBuiltWave({ lease });
        await sealRun(wave, delivering("refused"), [{
          operations: [setOf("of:h")],
        }]);
        const { sink, batches } = recordingSink();
        sink.commitWave = (batch) => {
          batches.push(batch);
          lease.end();
          return Promise.resolve({
            error: { name: "WaveCommitRejected", message: "not the holder" },
          });
        };

        const outcome = await wave.commitWave(sink);

        expect(outcome.aborted).toBe("lease-lost");
        expect(batches.length).toBe(1);
      });
    });

    describe("access-list changes", () => {
      it("refuses at the seal a change the wave has no authority to decide", async () => {
        const wave = handBuiltWave();
        const before = logged("access-list-change-refused", "warn");

        const { result } = await sealRun(wave, delivering("no-authority"), [{
          operations: [setOf("of:h")],
        }], grantToCarol);

        expect(result.error?.message).toBe(
          "This wave admits no change to an access list.",
        );
        expect(logged("access-list-change-refused", "warn")).toBe(before + 1);
        expect(wave.contributionCount).toBe(0);
      });

      it("refuses at the seal a change from a run that delivers no durable entry, or made as another actor, without asking the authority", async () => {
        const decided: ServedAclChange[] = [];
        const wave = handBuiltWave({
          spaceAccessAuthority: (change) => {
            decided.push(change);
            return Promise.resolve({ admitted: true });
          },
        });
        const { streamEntry: _, ...undelivered } = delivering("undelivered");
        const asCarol = new Map<MemorySpace, SpaceAccessChange[]>([[space, [{
          ...grantToCarol.get(space)![0],
          actor: "did:key:z6Mk-wave-arms-carol",
        }]]]);

        const refusals = [
          await sealRun(wave, undelivered, [{
            operations: [setOf("of:u")],
          }], grantToCarol),
          await sealRun(wave, delivering("as-carol"), [{
            operations: [setOf("of:c")],
          }], asCarol),
        ];
        const admitted = await sealRun(wave, delivering("as-alice"), [{
          operations: [setOf("of:a")],
        }], grantToCarol);

        for (const { result } of refusals) {
          expect(result.error?.message).toBe(
            "Only a handler run delivering a durable stream entry may " +
              "change an access list, and only as the actor it acts for.",
          );
        }
        expect(admitted.result.error).toBeUndefined();
        expect(decided.map((change) => change.capabilityRef)).toEqual([
          "event-consequence:as-alice",
        ]);
        expect(wave.contributionCount).toBe(1);
      });

      it("commits the change the seal admitted, and throws for a sink that cannot commit one", async () => {
        const decided: ServedAclChange[] = [];
        const newWave = () =>
          handBuiltWave({
            spaceAccessAuthority: (change) => {
              decided.push(change);
              return Promise.resolve({ admitted: true });
            },
          });
        const admitting = newWave();
        await sealRun(admitting, delivering("admitted"), [{
          operations: [setOf("of:h")],
        }], grantToCarol);
        const committed: ServedAclChange[] = [];
        const { sink } = recordingSink({
          commitSpaceAccessChange: (change) => {
            committed.push(change);
            return Promise.resolve({ ok: {} });
          },
        });
        const refusing = newWave();
        await sealRun(refusing, delivering("no-hook"), [{
          operations: [setOf("of:h")],
        }], grantToCarol);

        expect((await admitting.commitWave(sink)).dispositions).toEqual([
          { kind: "committed" },
        ]);
        await expect(refusing.commitWave(recordingSink().sink)).rejects
          .toThrow("has no `commitSpaceAccessChange()` to commit it with");
        expect(committed).toEqual([decided[0]]);
        expect(committed[0]).toMatchObject({
          space,
          actingPrincipal: alice,
          capabilityRef: "event-consequence:admitted",
        });
      });
    });

    describe("foreign writes", () => {
      it("refuses every crossing of a wave whose authority probe throws, probing once", async () => {
        let probes = 0;
        const wave = handBuiltWave({
          foreignWriteGrant: () => {
            probes += 1;
            throw new Error("probe failed");
          },
        });
        const before = logged("foreign-write-grant-probe-failed", "warn");

        const first = await sealRun(wave, delivering("cross-1"), [{
          space: foreignSpace,
          operations: [setOf("of:f1")],
        }]);
        const second = await sealRun(wave, delivering("cross-2"), [{
          space: foreignSpace,
          operations: [setOf("of:f2")],
        }]);

        for (const { result } of [first, second]) {
          expect(result.error).toMatchObject({
            name: "StorageTransactionAborted",
            reason: expect.objectContaining({
              message: "foreign-write-refused",
            }),
          });
        }
        expect(probes).toBe(1);
        expect(logged("foreign-write-grant-probe-failed", "warn")).toBe(
          before + 1,
        );
        expect(wave.contributionCount).toBe(0);
      });

      it("carries a foreign seal's preconditions in that space's batch", async () => {
        const wave = handBuiltWave();
        const precondition: CommitPrecondition = {
          kind: "entity-absent",
          id: "of:f",
        };
        await sealRun(wave, delivering("provision"), [
          {
            space: foreignSpace,
            operations: [setOf("of:f")],
            preconditions: [precondition],
          },
          { operations: [setOf("of:h")] },
        ]);
        const { sink, batches } = recordingSink();

        await wave.commitWave(sink);

        expect(batches.map((batch) => [batch.space, batch.preconditions]))
          .toEqual([[foreignSpace, [precondition]], [space, []]]);
      });
    });

    describe("basis rows", () => {
      it("keys a run that discovered an instance its identity cannot name by its stamped key, and clears the space key it narrowed from", async () => {
        const wave = handBuiltWave();
        const tx = new ExtendedStorageTransaction(
          new SealingTransaction([{
            operations: [setOf("of:b")],
            confirmed: [{ id: "of:read", path: ROOT, seq: 3 }],
          }]),
        );
        stampWaveRunContext(tx, {
          actionId: "derive/sessionless",
          kind: "derivation",
          actionScopeKey: "user:sessionless",
          scopeKeyIdentity: {},
        });
        tx.noteReadScope("session");
        expect((await wave.seal(tx)).error).toBeUndefined();
        const { sink, batches } = recordingSink();

        await wave.commitWave(sink);

        expect(batches[0].basisInstances).toEqual([
          {
            action: "derive/sessionless",
            actionScopeKey: "user:sessionless",
            rows: [{
              action: "derive/sessionless",
              actionScopeKey: "user:sessionless",
              entitySpace: space,
              entity: "of:read",
              entityScopeKey: "space",
              seq: 3,
            }],
          },
          {
            action: "derive/sessionless",
            actionScopeKey: "space",
            rows: [],
          },
        ]);
      });
    });
  });
});
