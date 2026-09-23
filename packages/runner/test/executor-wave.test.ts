// Server-execution v2 stage D: seal-into-wave, end to end against a real
// Runtime, storage stack, and engine (serving-loop.md §3c–§3d). The
// executable spec model (packages/spec-model/server-execution) is the
// semantic oracle for this machinery; the tests here pin the same ruled
// semantics at the implementation layer:
//
// - one abstraction, two destinations: without a destination the commit
//   path is today's, byte for byte (nothing here runs off the flag; the
//   whole existing suite is the OFF-arm witness), and installing one off
//   the flag is refused;
// - unstamped seals are REFUSED at the destination (serving-loop.md §3d,
//   RULED 2026-08-05): every server-side commit path stamps its run
//   context before sealing — no anonymous fallback;
// - the layered view: a later action tx reads an earlier tx's sealed
//   writes through the ordinary read path, and nothing reaches the store
//   until the wave commits — then everything lands as ONE commit;
// - C8a: a superseded pure-derivation write DROPS at the per-doc CAS
//   (counted supersededWrites), the concurrent authored value survives,
//   and a dependent derivation that read the withdrawn write drops with
//   it (never committed blind);
// - C8b/C9: a raced non-re-derivable consequence REQUEUES — never lost
//   (the re-run in a later wave commits it, consequenceOf carries the
//   eventId exactly once across both waves), never doubled — while a
//   commuting consequence REBASES and commits;
// - sealing order: the wave commit preserves seal order, never reorders;
// - identity annotations attach at seal time and ride the wave commit
//   (protocol.md §1), and basis rows land per (action, instance) in the
//   same store transaction (serving-loop.md §3b);
// - DR1/§2: a lease lost mid-wave aborts the wave commit — work sealed
//   under a lapsed tenure never commits;
// - protocol.md §2b: multi-space seals commit foreign-first, and a
//   foreign failure withholds the home commit;
// - protocol.md §2b, the F1b fix: a foreign space whose engine cannot be
//   resolved withdraws exactly the contributions that sealed into it —
//   the handler requeues, the derivation drops, everything else commits,
//   and no batch is ever built for the failed space.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  EXECUTION_LEASE_TTL_MS,
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { selectSchedulerBasisRows } from "@commonfabric/memory/v2/scheduler-basis";
import {
  decodeMemoryBoundary,
  resolvePrincipalSessionKey,
  resolveScopeKey,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type SessionEffectsDocValue,
  streamEntriesDocId,
} from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import {
  type Options as StorageOptions,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import type { Signer } from "@commonfabric/memory/interface";
import { Runtime } from "../src/runtime.ts";
import type { Module, Pattern } from "../src/builder/types.ts";
import type {
  ITransactionSealSink,
  MemorySpace,
  Result,
  SealedCommitVerdict,
  SealedNativeCommit,
  TransactionSealDestination,
} from "../src/storage/interface.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  type WaveCommitRejection,
  type WaveCommitSink,
  waveRunContextOf,
  waveSettlementOf,
} from "../src/executor/wave.ts";
import {
  createChildCellTransaction,
  createDuplicateWorkTransaction,
  createNonReactiveTransaction,
} from "../src/storage/extended-storage-transaction.ts";
import {
  EngineWaveCommitSink,
  waveCommitFailureResult,
} from "../src/executor/engine-wave-sink.ts";
import {
  effectCompletionKeyOf,
  markEffectCompletion,
} from "../src/executor/effect-completion.ts";
import { txToReactivityLog } from "../src/scheduler/reactivity.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("executor wave test");
const space = signer.did() as MemorySpace;

describe("stage D seal-into-wave", () => {
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let engine: Engine.Engine;

  const newWave = (options: {
    lease?: ConstructorParameters<typeof WaveAccumulator>[0]["lease"];
    foreignWriteGrant?: ConstructorParameters<
      typeof WaveAccumulator
    >[0]["foreignWriteGrant"];
  } = {}): WaveAccumulator =>
    new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      // OFF-arm cardinality 1: the instance keys derive from the
      // runtime's own authenticated session (plan Phase 1 stage E). The
      // accumulator constructs keys via the ONE shared constructor — a
      // test cannot hand it a different format (key-vocabulary.md §4).
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "wave-test-session",
      },
      replicaFor: (s) => storageManager.open(s).replica,
      // The Phase-5 posture, explicitly: these tests exercise the §2b
      // multi-space machinery (foreign-first sequencing, cross-space
      // withdrawal closure) — dark until Phase 5, kept correct here.
      // The serving loop's real accumulators run the DEFAULT ("refuse",
      // RULED 2026-08-14 (c)) — pinned by its own tests below and in
      // executor-serving-loop.test.ts.
      foreignWrites: "accept",
      // Allow-all authority probe unless a test binds the grant arm:
      // these tests exercise the wave MECHANICS (sequencing, carriage
      // completeness, withdrawal closure) against synthetic spaces.
      // The gate's real predicate is pinned by its own arms below and
      // by executor-cross-space.test.ts against the memory server's
      // foreignWriteAuthorityFor.
      foreignWriteGrant: options.foreignWriteGrant ?? (() => true),
      ...(options.lease !== undefined ? { lease: options.lease } : {}),
    });

  const newSink = (): EngineWaveCommitSink =>
    new EngineWaveCommitSink({
      engineFor: () => engine,
      // The derived-envelope admission (protocol.md §2, RULED 2026-08-05)
      // requires the producing session to BE the lease holder's own
      // service session, so the sink commits under the holder identity —
      // exactly the stage-F SpaceServer posture.
      sessionId: executionLeaseHolder(`service:${space}`),
    });

  const stoppedWitnessPiece = async (
    id: string,
    options: { throwOnInstantiation?: number; on?: Runtime } = {},
  ) => {
    const host = options.on ?? runtime;
    let instantiations = 0;
    let lastRunInstantiation = 0;
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {
        type: "object",
        properties: { witness: { type: "number" } },
      },
      result: {},
      nodes: [{
        module: {
          type: "raw",
          implementation: (...args: unknown[]) => {
            const parentCell = args[4] as {
              key: (name: string) => { set: (value: number) => void };
            };
            instantiations += 1;
            if (instantiations === options.throwOnInstantiation) {
              throw new Error(`witness instantiation ${instantiations} failed`);
            }
            // `parentCell` is bound to `Runner.#startCore()`'s actual
            // transaction. A changing value makes every instantiation
            // contribute a real bookkeeping write instead of being optimized
            // to a no-op.
            parentCell.key("witness").set(instantiations);
            const thisInstantiation = instantiations;
            const action = () => {
              lastRunInstantiation = thisInstantiation;
            };
            return {
              action,
            };
          },
        } as Module,
        inputs: {},
        outputs: {},
      }],
    };
    const tx = host.edit();
    const cell = host.getCell<Record<string, unknown>>(
      space,
      id,
      undefined,
      tx,
    );
    const running = host.runner.run(tx, pattern, {}, cell);
    expect((await tx.commit()).error).toBeUndefined();
    await running.pull();
    host.runner.stop(cell);
    return {
      cell,
      instantiations: () => instantiations,
      lastRunInstantiation: () => lastRunInstantiation,
    };
  };

  const routePieceInstantiationWaves = (
    firstWave: WaveAccumulator,
    recoveryWave: WaveAccumulator,
  ) => {
    let destinationWave = firstWave;
    const firstSeal = Promise.withResolvers<void>();
    const recoverySeal = Promise.withResolvers<void>();
    let recoverySeals = 0;
    let sealChain = Promise.resolve();
    runtime.installSealDestination({
      seal: (tx) => {
        const target = destinationWave;
        const sealed = sealChain.then(async () => {
          const result = await target.seal(tx);
          if (
            result.error === undefined &&
            waveSettlementOf(tx) !== undefined &&
            waveRunContextOf(tx)?.actionId.startsWith("piece-instantiate/")
          ) {
            if (target === firstWave) firstSeal.resolve();
            else {
              recoverySeals += 1;
              recoverySeal.resolve();
            }
          }
          return result;
        });
        sealChain = sealed.then(() => undefined, () => undefined);
        return sealed;
      },
    }, {
      runStamper: (tx, info) =>
        stampWaveRunContext(tx, {
          actionId: info.actionId,
          kind: info.kind,
        }),
    });
    return {
      firstSeal: firstSeal.promise,
      recoverySeal: recoverySeal.promise,
      recoverySeals: () => recoverySeals,
      idleSeals: () => sealChain,
      useRecoveryWave: () => {
        destinationWave = recoveryWave;
      },
    };
  };

  const wholeDocumentConflictSink = (
    inner: WaveCommitSink,
  ): WaveCommitSink => {
    const conflictHead = Engine.serverSeq(engine) + 1;
    return {
      currentHeads: (_targetSpace, docs) =>
        Promise.resolve(
          new Map(docs.map((doc) => [
            `${doc.id} ${doc.scopeKey}`,
            conflictHead,
          ])),
        ),
      concurrentWritePaths: () => Promise.resolve([[]]),
      commitWave: (batch) => inner.commitWave(batch),
    };
  };

  /** Seed a foreign engine's GENESIS ACL as its first commit (OW31 B4:
   * the sink refuses a foreign data batch into a seq-0/no-ACL engine —
   * INV-13 mirrored on the engine-direct plane — so tests exercising
   * later foreign commits first land the genesis the wave commit step
   * forces in production). */
  const seedGenesisAcl = (
    foreignEngine: Engine.Engine,
    foreignSpace: MemorySpace,
    owner = "did:key:alice",
  ): void => {
    Engine.applyCommit(foreignEngine, {
      sessionId: "test-genesis-session",
      space: foreignSpace,
      principal: foreignSpace,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${foreignSpace}`,
          value: { value: { [owner]: "OWNER", "*": "WRITE" } },
        }],
      },
    });
  };

  const liveLease = (): ExecutionLeaseCycle => {
    const cycle = new ExecutionLeaseCycle({
      engine,
      space,
      holder: executionLeaseHolder(`service:${space}`),
    });
    if (!cycle.acquire()) throw new Error("test lease acquire failed");
    return cycle;
  };

  beforeEach(async () => {
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    engine = await server.engineForSpace(space);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  it("refuses a seal destination off the flag", async () => {
    const offManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const offRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: offManager,
      experimental: { serverExecution: false },
    });
    try {
      expect(() => offRuntime.installSealDestination(newWave())).toThrow(
        "EXPERIMENTAL_SERVER_EXECUTION",
      );
    } finally {
      await offRuntime.dispose();
      await offManager.close();
    }
  });

  it("refuses an unstamped seal: every server-side commit path stamps its run context (RULED 2026-08-05)", async () => {
    const wave = newWave();
    runtime.installSealDestination(wave);
    const doc = runtime.getCell<{ value: number }>(
      space,
      "wave-unstamped",
      undefined,
    );
    const seqBefore = Engine.serverSeq(engine);

    // No stampWaveRunContext call: the seal destination must refuse
    // loudly — never fall back to an anonymous derivation. (Red-first:
    // pre-ruling, this commit was ACCEPTED as an anonymous
    // contribution — error undefined, contributionCount 1.)
    const tx = runtime.edit();
    doc.withTx(tx).set({ value: 1 });
    await expect(tx.commit()).rejects.toThrow(
      "unstamped transaction sealed into a wave",
    );

    // Nothing entered the wave and nothing reached the store.
    expect(wave.contributionCount).toBe(0);
    expect(Engine.serverSeq(engine)).toBe(seqBefore);
    runtime.clearSealDestination();
  });

  it("attributes a proven-no-commit row-label refusal to the failed operation's one served event", async () => {
    const wave = newWave();
    runtime.installSealDestination(wave);
    const first = runtime.getCell<{ value: number }>(
      space,
      "row-label-owner-first",
      undefined,
    );
    const second = runtime.getCell<{ value: number }>(
      space,
      "row-label-owner-second",
      undefined,
    );
    for (
      const [cell, eventId, index, seq] of [
        [first, "row-label-event-first", 2, 12],
        [second, "row-label-event-second", 5, 15],
      ] as const
    ) {
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: `row-label-owner:${eventId}`,
        kind: "event-handler",
        eventId,
        streamEntry: {
          sidecarId: "of:stream-events:row-label-owner",
          index,
          seq,
        },
      });
      cell.withTx(tx).set({ value: seq });
      expect((await tx.commit()).error).toBeUndefined();
    }
    runtime.clearSealDestination();

    const inner = newSink();
    const sink: WaveCommitSink = {
      currentHeads: (target, docs) => inner.currentHeads(target, docs),
      concurrentWritePaths: (target, doc, sinceSeq) =>
        inner.concurrentWritePaths(target, doc, sinceSeq),
      commitWave: (batch) => {
        const failedOperation = batch.operations.findIndex((operation) =>
          operation.op !== "sqlite" &&
          operation.id === second.getAsNormalizedFullLink().id
        );
        expect(failedOperation).toBeGreaterThanOrEqual(0);
        return Promise.resolve({
          error: {
            name: "RowLabelCommitError",
            message: "sqlite commit refused: synthetic owner pin",
            failedOperation,
          },
        });
      },
    };
    const outcome = await wave.commitWave(sink);
    await wave.settled();

    expect(outcome.requeuedEventIds).toEqual([
      "row-label-event-first",
      "row-label-event-second",
    ]);
    expect(outcome.provenNoCommitDeliveryFailures).toEqual([{
      eventId: "row-label-event-second",
      streamEntry: {
        sidecarId: "of:stream-events:row-label-owner",
        index: 5,
        seq: 15,
      },
      failureClass: "protocol",
      recoveryEpoch: "row-label-verdict",
      permanentEvidence: true,
    }]);
  });

  it("preserves a row-label refusal's failed operation at the engine sink boundary", () => {
    const error = new Engine.RowLabelCommitError(
      "sqlite commit refused: synthetic operation pin",
    );
    error.operationIndex = 4;
    expect(waveCommitFailureResult(error)).toEqual({
      error: {
        name: "RowLabelCommitError",
        message: "sqlite commit refused: synthetic operation pin",
        failedOperation: 4,
      },
    });
    expect(waveCommitFailureResult("plain refusal")).toEqual({
      error: {
        name: "WaveCommitRejected",
        message: "plain refusal",
      },
    });
  });

  it("seals into the wave instead of committing; later txs read the layered view; the wave commits once", async () => {
    const lease = liveLease();
    const leasedWave = newWave({ lease });
    runtime.installSealDestination(leasedWave);

    const a = runtime.getCell<{ value: number }>(space, "wave-a", undefined);
    const b = runtime.getCell<{ value: number }>(space, "wave-b", undefined);
    const seqBefore = Engine.serverSeq(engine);

    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-a", kind: "derivation" });
    a.withTx(tx1).set({ value: 1 });
    expect((await tx1.commit()).error).toBeUndefined();

    // Nothing reached the store: the sealed write lives in the overlay.
    expect(Engine.serverSeq(engine)).toBe(seqBefore);

    // The layered view: a later action tx reads the sealed write through
    // the ordinary read path, and its own write joins the wave.
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-b", kind: "derivation" });
    const seen = a.withTx(tx2).get();
    expect(seen).toEqual({ value: 1 });
    b.withTx(tx2).set({ value: seen!.value + 1 });
    expect((await tx2.commit()).error).toBeUndefined();
    expect(leasedWave.contributionCount).toBe(2);

    runtime.clearSealDestination();
    const outcome = await leasedWave.commitWave(newSink());
    await leasedWave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.supersededWrites).toBe(0);
    expect(outcome.dispositions).toEqual([
      { kind: "committed" },
      { kind: "committed" },
    ]);
    // ONE derived commit carries both actions' writes, in seal order.
    expect(Engine.serverSeq(engine)).toBe(outcome.seq);
    const aLink = a.getAsNormalizedFullLink();
    const bLink = b.getAsNormalizedFullLink();
    const revisions = engine.database.prepare(
      `SELECT id FROM revision WHERE seq = :seq ORDER BY op_index`,
    ).all({ seq: outcome.seq }) as { id: string }[];
    expect(revisions.map((r) => r.id)).toEqual([aLink.id, bLink.id]);
    const commitMeta = engine.database.prepare(
      `SELECT class, holder FROM "commit" WHERE seq = :seq`,
    ).get({ seq: outcome.seq }) as { class: string; holder: string };
    expect(commitMeta.class).toBe("derived");
    expect(commitMeta.holder).toBe(lease.holder);
  });

  it("drops superseded pure writes (C8a) and the derivations that read them; the authored value survives", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const x = runtime.getCell<{ value: number }>(space, "wave-x", undefined);
    const z = runtime.getCell<{ value: number }>(space, "wave-z", undefined);

    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-x", kind: "derivation" });
    x.withTx(tx1).set({ value: 10 });
    expect((await tx1.commit()).error).toBeUndefined();
    const tx1Settlement = waveSettlementOf(tx1);
    expect(tx1Settlement).toBeDefined();

    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-z", kind: "derivation" });
    const seen = x.withTx(tx2).get();
    z.withTx(tx2).set({ value: seen!.value + 1 });
    expect((await tx2.commit()).error).toBeUndefined();

    // A concurrent authored commit lands mid-wave and moves x's head past
    // the wave's basis: the next wave's input, and this wave's conflict.
    const xLink = x.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: xLink.id,
          value: { value: { value: 99 } },
        }],
      },
    });

    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    const tx1Settled = await tx1Settlement!;

    // The superseded pure write dropped (counted), and the derivation
    // that READ the withdrawn write dropped with it — nothing derived
    // from withdrawn state commits.
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.supersededWrites).toBe(1);
    expect(outcome.dependencyDroppedWrites).toBe(1);
    expect(outcome.dispositions[0]).toEqual({ kind: "dropped" });
    expect(outcome.dispositions[1]).toEqual({ kind: "dropped" });
    expect(
      (tx1Settled.error as { waveWithdrawalCause?: unknown } | undefined)
        ?.waveWithdrawalCause,
    ).toBe("contribution-dropped");
    // No wave commit happened at all (nothing survived), and the
    // authored value stands — dropping is what makes that sound.
    expect(outcome.seq).toBeUndefined();
    const zLink = z.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: zLink.id, scopeKey: "space" }),
    ).toBe(0);
    const stored = Engine.readState(engine, { id: xLink.id });
    expect(stored?.document).toEqual({ value: { value: 99 } });
  });

  it("drops a derived write over an intrusion the sealing replica had not taken, though the wave's basis covers it — never a blind clobber", async () => {
    // A wave's basis is the serverSeq it OPENED at, while the view its runs
    // read is the replica's. A commit admitted before the wave opened and
    // never taken by the replica is counted in the basis and absent from
    // the view, so the doc's head sits at or below the basis while the
    // derivation that wrote it never saw the value there.

    const w = runtime.getCell<{ value: number }>(
      space,
      "wave-stale-read",
      undefined,
    );
    // The replica takes the doc while it is ABSENT: confirmed read seq 0.
    await w.sync();
    const wLink = w.getAsNormalizedFullLink();
    // The authored commit lands BEFORE the wave opens — the replica never
    // takes it, a direct engine apply reaching no session — so the doc's
    // head sits at or below the basis the wave is about to open at.
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: wLink.id,
          value: { value: { value: 99 } },
        }],
      },
    });
    const lease = liveLease();
    const wave = newWave({ lease });
    expect(
      Engine.selectDocHead(engine, { id: wLink.id, scopeKey: "space" }),
    ).toBeLessThanOrEqual(wave.basisSeq);
    runtime.installSealDestination(wave);

    const tx = runtime.edit();
    stampWaveRunContext(tx, { actionId: "derive-w", kind: "derivation" });
    expect(w.withTx(tx).get()).toBeUndefined();
    w.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();
    const settlement = waveSettlementOf(tx);
    expect(settlement).toBeDefined();

    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.supersededWrites).toBe(1);
    expect(outcome.dispositions[0]).toEqual({ kind: "dropped" });
    expect(
      ((await settlement!).error as
        | { waveWithdrawalCause?: unknown }
        | undefined)?.waveWithdrawalCause,
    ).toBe("contribution-dropped");
    // The authored value stands: nothing of the wave reached the store.
    expect(outcome.seq).toBeUndefined();
    expect(Engine.readState(engine, { id: wLink.id })?.document).toEqual({
      value: { value: 99 },
    });
  });

  it("commits a derived write over a move the sealing replica had not taken when the move was this tenure's OWN derived commit — not every older view is an intrusion", async () => {
    // The control for the drop above. A serving tenure advances its own
    // output documents under runs still in flight, so a view older than
    // the head is the ordinary case; only a writer the tenure's own
    // derived commits do not account for makes it a conflict. Moving the
    // check off that question stalls every re-derivation after a tenure
    // restarts.

    const lease = liveLease();
    const w = runtime.getCell<{ value: number }>(
      space,
      "wave-own-move",
      undefined,
    );
    await w.sync();
    const wLink = w.getAsNormalizedFullLink();
    // This tenure's own derived commit, applied straight to the engine so
    // the replica does not take it.
    Engine.applyCommit(engine, {
      sessionId: lease.holder,
      space,
      commitClass: "derived",
      holder: lease.holder,
      commit: {
        // Out of the way of the sink's own counter, which shares this
        // session id and dedupes by (session, localSeq).
        localSeq: 900,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: wLink.id,
          value: { value: { value: 41 } },
        }],
      },
    });
    const wave = newWave({ lease });
    expect(
      Engine.selectDocHead(engine, { id: wLink.id, scopeKey: "space" }),
    ).toBeLessThanOrEqual(wave.basisSeq);
    runtime.installSealDestination(wave);

    const tx = runtime.edit();
    stampWaveRunContext(tx, { actionId: "derive-own", kind: "derivation" });
    w.withTx(tx).set({ value: 42 });
    expect((await tx.commit()).error).toBeUndefined();

    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.supersededWrites).toBe(0);
    expect(outcome.dispositions[0]).toEqual({ kind: "committed" });
    expect(Engine.readState(engine, { id: wLink.id })?.document).toEqual({
      value: { value: 42 },
    });
  });

  it("exempts a contribution that read a doc at or after the loop's own direct commit from the conflict on it; one sealed before drops, and one that read the doc stale is refused at its own commit", async () => {
    // The direct commit writes x and y. A contribution sealed before it
    // wrote x. Two transactions opened afterwards write y: one read y with
    // the commit applied, the other read y before the replica took it,
    // and the replica's claim check at its commit refuses it ahead of the
    // wave — a stale read never seals.
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    const x = runtime.getCell<{ value: number }>(
      space,
      "wave-own-x",
      undefined,
    );
    const y = runtime.getCell<{ value: number }>(
      space,
      "wave-own-y",
      undefined,
    );
    const xLink = x.getAsNormalizedFullLink();
    const yLink = y.getAsNormalizedFullLink();

    const before = runtime.edit();
    stampWaveRunContext(before, {
      actionId: "derive-x-early",
      kind: "derivation",
    });
    x.withTx(before).set({ value: 1 });
    expect((await before.commit()).error).toBeUndefined();

    const stale = runtime.edit();
    stampWaveRunContext(stale, {
      actionId: "derive-y-stale",
      kind: "derivation",
    });
    const staleSeen = y.withTx(stale).get()?.value ?? 0;

    Engine.applyCommit(engine, {
      sessionId: "direct-session",
      principal: signer.did(),
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: xLink.id, value: { value: { value: 50 } } },
          { op: "set", id: yLink.id, value: { value: { value: 50 } } },
        ],
      },
    });
    const ownSeq = Engine.serverSeq(engine);
    await y.sync();
    expect(y.get()).toEqual({ value: 50 });
    wave.noteOwnCommit(ownSeq, [
      { id: xLink.id, scopeKey: "space" },
      { id: yLink.id, scopeKey: "space" },
    ]);

    const fresh = runtime.edit();
    stampWaveRunContext(fresh, {
      actionId: "derive-y-fresh",
      kind: "derivation",
    });
    const freshSeen = y.withTx(fresh).get()?.value ?? 0;
    y.withTx(fresh).set({ value: freshSeen + 1 });
    expect((await fresh.commit()).error).toBeUndefined();

    y.withTx(stale).set({ value: staleSeen + 1 });
    const staleOutcome = await stale.commit({ resolveAt: "verdict" });
    expect(staleOutcome.error?.name).toBe("StorageTransactionInconsistent");

    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.dispositions).toEqual([
      { kind: "dropped" },
      { kind: "committed" },
    ]);
    expect(outcome.supersededWrites).toBe(1);
    expect(Engine.readState(engine, { id: xLink.id })?.document).toEqual({
      value: { value: 50 },
    });
    expect(Engine.readState(engine, { id: yLink.id })?.document).toEqual({
      value: { value: 51 },
    });
  });

  it("commits a completion's memo-state writes authoritatively: a doomed sealed overlay masking the hash doc cannot elide them, so a supersede-drop never tears hash from result (completion-visibility F2)", async () => {
    // The torn-hash interleave this pins closed (the completion-visibility
    // wedge, Link 1 + Link 2):
    //
    //   1. an input-transition run's memo-state wipe rewrites the memo
    //      doc's `inputHash` and SEALS into an open wave — the replica's
    //      visible state now shows the new hash through the sealed
    //      overlay while the engine still holds the stale one;
    //   2. the effect's COMPLETION writeback commits engine-plane at
    //      `basisSeq = NOW` (racing the open wave), writing the result
    //      AND re-asserting the same `inputHash`. Diffed against the
    //      overlay, the hash write looks like a no-op — without
    //      authoritative completion writes it is ELIDED from the commit;
    //   3. the completion moved the memo doc's head past the wave's
    //      basis, so the wave commit supersede-DROPS the wipe (C8a) and
    //      the overlay rolls back.
    //
    // Durable outcome pre-fix: `result present + inputHash stale` — the
    // next run's memo guard reads "inputs changed" and destroys the
    // just-served value. The pin: after the drop, the ENGINE's hash
    // matches the served result.
    const lease = liveLease();
    const wave = newWave({ lease });
    const sink = newSink();
    const holder = executionLeaseHolder(`service:${space}`);

    const internalDoc = runtime.getCell<{ inputHash?: string }>(
      space,
      "torn-internal",
      undefined,
    );
    const resultDoc = runtime.getCell<{ value?: string }>(
      space,
      "torn-result",
      undefined,
    );

    // Prime the STALE hash as engine + confirmed state (an ordinary
    // pushed commit — no destination installed yet).
    const primeTx = runtime.edit();
    internalDoc.withTx(primeTx).set({ inputHash: "stale" });
    expect((await primeTx.commit()).error).toBeUndefined();

    // The routing destination: unmarked seals ride the wave; a MARKED
    // effect-completion writeback commits as its own engine-plane commit
    // at `basisSeq = NOW` with an inline verdict — the SpaceServer
    // completion committer's core (space-server.ts §4), minus the
    // outbox/annotation carriage this pin does not need.
    const destination: TransactionSealDestination = {
      seal: async (tx) => {
        if (effectCompletionKeyOf(tx) === undefined) return wave.seal(tx);
        const inner = tx.tx;
        const sealedSpaces: Array<{
          sealed: SealedNativeCommit;
          resolveVerdict: (verdict: SealedCommitVerdict) => void;
        }> = [];
        const collector: ITransactionSealSink = {
          sealSpaceCommit: (sealSpace, native, source) => {
            const replica = storageManager.open(sealSpace).replica;
            const { promise, resolve } = Promise.withResolvers<
              SealedCommitVerdict
            >();
            sealedSpaces.push({
              sealed: replica.sealNative!(native, source, promise),
              resolveVerdict: resolve,
            });
            return Promise.resolve({ ok: {} });
          },
        };
        const result = await inner.sealInto!(collector);
        if (result.error) {
          for (const sealed of sealedSpaces) {
            sealed.resolveVerdict({
              withdrawn: { message: "completion seal failed" },
            });
          }
          return result;
        }
        const sealed = sealedSpaces[0];
        const outcome = await sink.commitWave({
          space,
          home: true,
          basisSeq: Engine.serverSeq(engine),
          rebasedHeads: [],
          operations: [...sealed.sealed.commit.operations],
          preconditions: [...sealed.sealed.commit.preconditions ?? []],
          annotations: [],
          consequenceOf: [],
          basisInstances: [],
          holder,
        });
        if (outcome.error) {
          sealed.resolveVerdict({
            withdrawn: { message: outcome.error.message },
          });
          return {
            error: {
              name: "StorageTransactionAborted",
              message: outcome.error.message,
              reason: new Error("completion-commit-rejected"),
            },
          };
        }
        sealed.resolveVerdict({ committed: { seq: outcome.ok.seq } });
        // Sequence the promotion (settleSealedCommit runs inside
        // settlement) before reporting the writeback committed.
        await sealed.sealed.settled;
        return { ok: {} };
      },
    };
    runtime.installSealDestination(destination);

    // 1. The doomed derivation: the memo-state wipe, sealed into the
    // open wave. The overlay now masks the memo doc with "new".
    const t1 = runtime.edit();
    stampWaveRunContext(t1, { actionId: "memo-wipe", kind: "derivation" });
    internalDoc.withTx(t1).key("inputHash").set("new");
    expect((await t1.commit()).error).toBeUndefined();

    // 2. The completion writeback, racing the open wave: the result AND
    // the hash it serves. Against the overlay the hash write is a
    // visible no-op — authoritative completion writes must carry it
    // anyway.
    const completion = await runtime.editWithRetry((tx) => {
      markEffectCompletion(tx, "fetchTest:torn-hash");
      internalDoc.withTx(tx).key("inputHash").set("new");
      resultDoc.withTx(tx).set({ value: "served" });
    });
    expect(completion.error).toBeUndefined();

    // 3. The wave commits: the completion moved the memo doc's head past
    // the wave's basis — the wipe is superseded and DROPS (C8a). The
    // drop must actually happen or this pin is vacuous.
    runtime.clearSealDestination();
    const outcome = await wave.commitWave(sink);
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.supersededWrites).toBe(1);
    expect(outcome.dispositions[0]).toEqual({ kind: "dropped" });

    // THE PIN: engine-side hash and result are CONSISTENT — the elision
    // did not tear them (pre-fix: hash "stale", result "served").
    const iLink = internalDoc.getAsNormalizedFullLink();
    expect(Engine.readState(engine, { id: iLink.id })?.document).toEqual({
      value: { inputHash: "new" },
    });
    const rLink = resultDoc.getAsNormalizedFullLink();
    expect(Engine.readState(engine, { id: rLink.id })?.document).toEqual({
      value: { value: "served" },
    });

    // And the replica's visible state agrees with the engine after the
    // drop rolled the overlay back — no stale-hash flip for later reads.
    expect(internalDoc.get()).toEqual({ inputHash: "new" });
    lease.release();
  });

  it("requeues a raced consequence (C8b) — never lost, never doubled across waves — and annotates + records its basis when it lands", async () => {
    const lease = liveLease();

    const y = runtime.getCell<{ value: number }>(space, "wave-y", undefined);
    const seed = runtime.getCell<{ value: number }>(
      space,
      "wave-seed",
      undefined,
    );

    // Seed a doc the handler reads, so basis rows have a confirmed read.
    const seedTx = runtime.edit();
    seed.withTx(seedTx).set({ value: 7 });
    expect((await seedTx.commit()).error).toBeUndefined();
    const seedSeq = Engine.serverSeq(engine);

    const wave1 = newWave({ lease });
    runtime.installSealDestination(wave1);

    const handlerRun = async (accumulator: WaveAccumulator) => {
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "handle-vote",
        kind: "event-handler",
        eventId: "e1",
        acting: { user: "did:key:alice", session: "sess-1" },
      });
      const base = seed.withTx(tx).get();
      y.withTx(tx).set({ value: base!.value + 1 });
      expect((await tx.commit()).error).toBeUndefined();
      return accumulator;
    };
    await handlerRun(wave1);

    // A rival authored write races the consequence on the same doc: a
    // whole-doc set never commutes, so the rebase conflicts semantically.
    const yLink = y.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: yLink.id,
          value: { value: { value: 1000 } },
        }],
      },
    });

    runtime.clearSealDestination();
    const outcome1 = await wave1.commitWave(newSink());
    await wave1.settled();

    // REQUEUED, not lost, not committed, not consequenced: §3d's T3 row.
    expect(outcome1.requeuedEventIds).toEqual(["e1"]);
    expect(outcome1.committedEventIds).toEqual([]);
    expect(outcome1.dispositions[0]).toEqual({ kind: "requeued" });
    expect(outcome1.seq).toBeUndefined();

    // The later wave retries the event against fresh state: exactly once.
    const wave2 = newWave({ lease });
    runtime.installSealDestination(wave2);
    await handlerRun(wave2);
    runtime.clearSealDestination();
    const sink = newSink();
    const outcome2 = await wave2.commitWave(sink);
    await wave2.settled();

    expect(outcome2.aborted).toBeUndefined();
    expect(outcome2.committedEventIds).toEqual(["e1"]);
    expect(outcome2.requeuedEventIds).toEqual([]);

    // consequenceOf carries e1 exactly once across both waves, the
    // acting identity annotations rode the write (protocol.md §1), and
    // the handler's basis rows landed per (action, instance) in the same
    // store transaction (serving-loop.md §3b).
    const rows = engine.database.prepare(
      `SELECT seq, consequence_of, annotations FROM "commit"
       WHERE consequence_of IS NOT NULL`,
    ).all() as { seq: number; consequence_of: string; annotations: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].seq).toBe(outcome2.seq);
    expect(decodeMemoryBoundary(rows[0].consequence_of)).toEqual(["e1"]);
    const annotations = decodeMemoryBoundary(rows[0].annotations) as Array<
      Record<string, unknown>
    >;
    expect(annotations).toEqual([
      { op: 0, actingUser: "did:key:alice", actingSession: "sess-1" },
    ]);
    const basis = selectSchedulerBasisRows(engine, {
      branch: "",
      action: "handle-vote",
      actionScopeKey: "space",
    });
    const seedLink = seed.getAsNormalizedFullLink();
    const seedRow = basis.find((row) => row.entity === seedLink.id);
    expect(seedRow).toEqual({
      entitySpace: space,
      entity: seedLink.id,
      entityScopeKey: "space",
      seq: seedSeq,
    });
  });

  it("folds ALL of an event's contributions into its requeue — the served intent tx rolls back with its handler (Phase 4; events.md §4)", async () => {
    // Phase 4 makes an event contribute SEVERAL transactions to one
    // wave: the handler run plus the served navigateTo's intent tx
    // (builtins.md §4's split contract). Requeue must be atomic PER
    // EVENT: a requeued handler beside a SURVIVING intent would mark
    // the event consequenced (survivedEventIds) while its consequences
    // were withdrawn — lost forever behind the idempotency skip.
    // (Red-first: without the per-event fold in resolveConflicts, the
    // intent survives — dispositions [requeued, committed] — and the
    // second wave's re-run double-issues nothing only by luck.)
    const lease = liveLease();
    const y = runtime.getCell<{ value: number }>(
      space,
      "wave-nav-y",
      undefined,
    );
    const actorKey = resolvePrincipalSessionKey("did:key:alice", "sess-1");

    const runEvent = async () => {
      // The handler run: reads + bumps y.
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "handle-go",
        kind: "event-handler",
        eventId: "e-nav",
        acting: { user: "did:key:alice", session: "sess-1" },
      });
      const base = y.withTx(tx).get()?.value ?? 0;
      y.withTx(tx).set({ value: base + 1 });
      expect((await tx.commit()).error).toBeUndefined();
      // The served intent tx: SAME event, separate contribution,
      // addressed to the acting session's instance.
      const intentTx = runtime.edit();
      stampWaveRunContext(intentTx, {
        actionId: "server-execution/navigate-intent:nav-e",
        kind: "event-handler",
        eventId: "e-nav",
        acting: { user: "did:key:alice", session: "sess-1" },
        scopeKeyIdentity: {
          principal: "did:key:alice",
          sessionId: "sess-1" as never,
        },
      });
      // RAW tx write (the builtin's own shape): a Cell.set would
      // cellify the entry into a linked child doc.
      intentTx.writeValueOrThrow(
        {
          space,
          id: SERVER_EXECUTION_EFFECTS_DOC_ID,
          scope: "session",
          path: [],
        } as never,
        {
          entries: [{
            nonce: "nav:fold-test",
            kind: "navigate",
            args: { target: { id: "of:nav-target", path: [] } },
            issuedIn: null,
          }],
        } as never,
      );
      expect((await intentTx.commit()).error).toBeUndefined();
    };

    const wave1 = newWave({ lease });
    runtime.installSealDestination(wave1);
    await runEvent();

    // A rival authored write races ONLY the handler's consequence doc:
    // a whole-doc set never commutes, so the handler requeues — and the
    // intent (which nothing raced) must FOLD with it.
    const yLink = y.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 51,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: yLink.id,
          value: { value: { value: 1000 } },
        }],
      },
    });

    runtime.clearSealDestination();
    const outcome1 = await wave1.commitWave(newSink());
    await wave1.settled();

    // BOTH contributions requeued; the event reported ONCE; nothing
    // marked consequenced; no intent landed.
    expect(outcome1.requeuedEventIds).toEqual(["e-nav"]);
    expect(outcome1.committedEventIds).toEqual([]);
    expect(outcome1.dispositions).toEqual([
      { kind: "requeued" },
      { kind: "requeued" },
    ]);
    const storedAfter1 = Engine.readState(engine, {
      id: SERVER_EXECUTION_EFFECTS_DOC_ID,
      scopeKey: actorKey,
    })?.document?.value as SessionEffectsDocValue | undefined;
    expect(storedAfter1?.entries ?? []).toEqual([]);

    // The later wave retries the WHOLE event: consequence + intent land
    // exactly once, converging against the rival's value.
    const wave2 = newWave({ lease });
    runtime.installSealDestination(wave2);
    await runEvent();
    runtime.clearSealDestination();
    const outcome2 = await wave2.commitWave(newSink());
    await wave2.settled();

    expect(outcome2.aborted).toBeUndefined();
    expect(outcome2.committedEventIds).toEqual(["e-nav"]);
    expect(outcome2.requeuedEventIds).toEqual([]);
    // The re-run's consequence landed exactly once (the fixture's
    // replica never saw the rival's engine-direct write, so the re-run
    // read base 0 — the point is single delivery, not arithmetic).
    const yDoc = Engine.read(engine, { id: yLink.id })?.value as
      | { value?: number }
      | undefined;
    expect(yDoc?.value).toBe(1);
    const storedAfter2 = Engine.readState(engine, {
      id: SERVER_EXECUTION_EFFECTS_DOC_ID,
      scopeKey: actorKey,
    })?.document?.value as SessionEffectsDocValue | undefined;
    expect(storedAfter2?.entries?.length).toBe(1);
    expect(storedAfter2?.entries?.[0].nonce).toBe("nav:fold-test");
    expect(typeof storedAfter2?.entries?.[0].issuedIn).toBe("number");
  });

  it("rebases a commuting consequence instead of requeueing (field-level merge)", async () => {
    const lease = liveLease();

    // Seed a structured doc, then patch disjoint fields concurrently.
    const doc = runtime.getCell<{ a: number; b: number }>(
      space,
      "wave-rebase",
      undefined,
    );
    const seedTx = runtime.edit();
    doc.withTx(seedTx).set({ a: 1, b: 1 });
    expect((await seedTx.commit()).error).toBeUndefined();

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "handle-a",
      kind: "event-handler",
      eventId: "e-rebase",
      acting: { user: "did:key:alice" },
    });
    doc.withTx(tx).key("a").set(2);
    expect((await tx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    // The rival touches ONLY /value/b — disjoint from the handler's
    // /value/a patch, so the consequence commutes and rebases.
    const link = doc.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: link.id,
          patches: [{ op: "replace", path: "/value/b", value: 50 }],
        }],
      },
    });

    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.requeuedEventIds).toEqual([]);
    expect(outcome.committedEventIds).toEqual(["e-rebase"]);
    // Both writes survive: the rival's b and the rebased consequence's a.
    const stored = Engine.readState(engine, { id: link.id });
    expect(stored?.document).toEqual({ value: { a: 2, b: 50 } });
  });

  it("rebases an event's consequence mark against a CONCURRENT tail append to the same stream sidecar (§3d's stream-sidecar refinement)", async () => {
    // The sidecar's two writers meet at `/value/entries`: the loop marks
    // the entry it just processed, and a delivery appends a new one. The
    // general prefix-overlap rule reads that as a conflict — an
    // index-addressed mark sits under the appended-to array — and would
    // requeue every event whose stream took a concurrent fire. A tail
    // append creates only NEW indices, so the two commute.

    const streamLink = { id: "of:sidecar-rebase-stream", path: ["stream"] };
    const sidecarId = streamEntriesDocId(streamLink);
    const deliver = (eventId: string, localSeq: number) =>
      server.commitDelegatedAppend({
        targetSpace: space,
        targetStream: sidecarId,
        targetStreamLink: streamLink,
        eventId,
        payload: { via: "sidecar rebase" },
        actingPrincipal: "did:key:alice",
        actingSession: "sidecar-rebase-session",
        capabilityRef: "cap-sidecar-rebase",
        sessionId: `service:${space}`,
        localSeq,
      });

    // The event under processing: one durable entry at index 0.
    expect((await deliver("e-marked", 900_001)).deduped).toBe(false);
    // Loaded before the mark, as the drain leaves it: a write against an
    // unloaded doc commits as a whole-doc set, and only a patch can
    // commute with anything.
    await runtime.getCellFromLink({
      space,
      id: sidecarId as never,
      scope: "space",
      path: [],
    }).sync();

    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "sidecar-handler",
      kind: "event-handler",
      eventId: "e-marked",
      acting: { user: "did:key:alice" },
    });
    // The consequence mark, written exactly as the dispatch writes it:
    // the handler's own tx carries `entries/<index>/consequenced`.
    runtime.getCellFromLink<boolean>({
      space,
      id: sidecarId as never,
      scope: "space",
      path: ["entries", "0", "consequenced"],
    }).withTx(tx).set(true);
    expect((await tx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    // The concurrent writer: a second event delivered onto the same
    // stream after the wave's basis — a tail append at `/value/entries`,
    // the only shape the sidecar admits from anyone but the loop.
    expect((await deliver("e-appended", 900_002)).deduped).toBe(false);

    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.requeuedEventIds).toEqual([]);
    expect(outcome.committedEventIds).toEqual(["e-marked"]);
    // Both survive: the appended entry AND the mark on the entry that
    // was already there.
    const stored = Engine.readState(engine, { id: sidecarId })?.document
      ?.value as {
        entries?: Array<{ eventId?: string; consequenced?: boolean }>;
      } | undefined;
    expect(stored?.entries?.map((entry) => entry.eventId)).toEqual([
      "e-marked",
      "e-appended",
    ]);
    expect(stored?.entries?.[0].consequenced).toBe(true);
    expect(stored?.entries?.[1].consequenced).toBeUndefined();
  });

  it("aborts the wave commit when the lease tenure lapsed (work sealed under a lapsed tenure never commits)", async () => {
    let now = 1_000_000;
    const cycle = new ExecutionLeaseCycle({
      engine,
      space,
      holder: executionLeaseHolder(`service:${space}`),
      now: () => now,
    });
    expect(cycle.acquire()).toBe(true);

    const wave = newWave({ lease: cycle });
    runtime.installSealDestination(wave);
    const cell = runtime.getCell<{ value: number }>(
      space,
      "wave-tenure",
      undefined,
    );
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "handle-late",
      kind: "event-handler",
      eventId: "e-late",
    });
    cell.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    // The lease expires (a pause outlived the TTL) and the same process
    // reacquires: a NEW tenure. The renewal failure is the
    // stop-committing signal; the in-flight wave aborts (§2's MUST).
    now += EXECUTION_LEASE_TTL_MS + 1;
    expect(cycle.renew()).toBe(false);
    expect(cycle.acquire()).toBe(true);

    const seqBefore = Engine.serverSeq(engine);
    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBe("lease-lost");
    expect(outcome.requeuedEventIds).toEqual(["e-late"]);
    expect(Engine.serverSeq(engine)).toBe(seqBefore);
  });

  it("commits multi-space seals foreign-first and withholds the home commit on a foreign failure (protocol.md §2b)", async () => {
    const foreignSigner = await Identity.fromPassphrase("wave foreign space");
    const foreign = foreignSigner.did() as MemorySpace;
    const foreignEngine = await server.engineForSpace(foreign);
    seedGenesisAcl(foreignEngine, foreign);
    const lease = liveLease();

    const engines = new Map<MemorySpace, Engine.Engine>([
      [space, engine],
      [foreign, foreignEngine],
    ]);

    const runProvisioningWave = async (value: number): Promise<
      {
        wave: WaveAccumulator;
        order: Array<{ space: MemorySpace; home: boolean }>;
      }
    > => {
      const wave = newWave({ lease });
      runtime.installSealDestination(wave);
      const homeCell = runtime.getCell<{ value: number }>(
        space,
        "wave-home-link",
        undefined,
      );
      const foreignCell = runtime.getCell<{ value: number }>(
        foreign,
        "wave-provisioned",
        undefined,
      );
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "provision",
        kind: "event-handler",
        eventId: "e-prov",
        acting: { user: "did:key:alice", session: "sess-1" },
        // The §2b provisioning shape (Phase 5's accept-with-carriage
        // gate): every foreign commit carries acting + grant.
        capabilityRef: "cap:test-grant",
      });
      tx.enableMultiSpaceWrites?.([foreign, space]);
      foreignCell.withTx(tx).set({ value });
      homeCell.withTx(tx).set({ value: value + 1 });
      expect((await tx.commit()).error).toBeUndefined();
      runtime.clearSealDestination();
      const order: Array<{ space: MemorySpace; home: boolean }> = [];
      return { wave, order };
    };

    // First: the foreign-first ordering on success.
    {
      const { wave, order } = await runProvisioningWave(1);
      const inner = new EngineWaveCommitSink({
        engineFor: (s) => engines.get(s)!,
        sessionId: executionLeaseHolder(`service:${space}`),
      });
      const recordingSink: WaveCommitSink = {
        currentHeads: (s, docs) => inner.currentHeads(s, docs),
        concurrentWritePaths: (s, doc, since) =>
          inner.concurrentWritePaths(s, doc, since),
        commitWave: (batch) => {
          order.push({ space: batch.space, home: batch.home });
          return inner.commitWave(batch);
        },
      };
      const outcome = await wave.commitWave(recordingSink);
      await wave.settled();
      expect(outcome.aborted).toBeUndefined();
      expect(order).toEqual([
        { space: foreign, home: false },
        { space, home: true },
      ]);
      // The foreign commit is authored-class; the home commit derived.
      const foreignClass = foreignEngine.database.prepare(
        `SELECT class FROM "commit" ORDER BY seq DESC LIMIT 1`,
      ).get() as { class: string };
      expect(foreignClass.class).toBe("authored");
    }

    // Then: a foreign failure withholds the home commit and requeues.
    {
      const { wave } = await runProvisioningWave(10);
      const inner = new EngineWaveCommitSink({
        engineFor: (s) => engines.get(s)!,
        sessionId: executionLeaseHolder(`service:${space}`),
      });
      const failingSink: WaveCommitSink = {
        currentHeads: (s, docs) => inner.currentHeads(s, docs),
        concurrentWritePaths: (s, doc, since) =>
          inner.concurrentWritePaths(s, doc, since),
        commitWave: (
          batch,
        ): Promise<Result<{ seq: number }, WaveCommitRejection>> => {
          if (!batch.home) {
            return Promise.resolve({
              error: {
                name: "WaveCommitRejected",
                message: "injected foreign failure",
              },
            });
          }
          return inner.commitWave(batch);
        },
      };
      const homeSeqBefore = Engine.serverSeq(engine);
      const outcome = await wave.commitWave(failingSink);
      await wave.settled();
      expect(outcome.aborted).toBe("foreign-commit-failed");
      expect(outcome.requeuedEventIds).toEqual(["e-prov"]);
      // The home commit never landed: the event stays unconsequenced and
      // replays (§2b).
      expect(Engine.serverSeq(engine)).toBe(homeSeqBefore);
    }
  });

  it("an unresolvable foreign space withdraws exactly its own crossings: the handler requeues, the derivation drops, a home-only contribution commits, and no batch reaches the failed space (protocol.md §2b; the F1b fix)", async () => {
    // What a wave is carrying when a foreign space fails decides which
    // arms of the withdrawal run: the requeue arm needs a handler that
    // crossed into that space, the drop arm needs a derivation that
    // crossed, and the skip arm needs a contribution that stayed home.
    // A test driving the serving loop gets whichever of the three
    // happen to seal into one wave, so this one builds the wave itself
    // and puts all three in it.
    const foreignSigner = await Identity.fromPassphrase(
      "wave foreign unresolvable",
    );
    const foreign = foreignSigner.did() as MemorySpace;
    const foreignEngine = await server.engineForSpace(foreign);
    seedGenesisAcl(foreignEngine, foreign);
    const lease = liveLease();

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    // The crossing handler: a §2b provisioning run with a home write of
    // its own, so its withdrawal is visible in both spaces.
    const handlerForeign = runtime.getCell<{ value: number }>(
      foreign,
      "f1b-handler-foreign",
      undefined,
    );
    const handlerHome = runtime.getCell<{ value: number }>(
      space,
      "f1b-handler-home",
      undefined,
    );
    const handlerTx = runtime.edit();
    stampWaveRunContext(handlerTx, {
      actionId: "provision/handler",
      kind: "event-handler",
      eventId: "e-crossing",
      acting: { user: "did:key:alice", session: "sess-1" },
      capabilityRef: "cap:test-grant",
    });
    handlerTx.enableMultiSpaceWrites?.([foreign, space]);
    handlerForeign.withTx(handlerTx).set({ value: 1 });
    handlerHome.withTx(handlerTx).set({ value: 2 });
    expect((await handlerTx.commit()).error).toBeUndefined();

    // The crossing derivation: same target space, and no event behind
    // it, so it takes the drop arm rather than the requeue arm.
    const derivationForeign = runtime.getCell<{ value: number }>(
      foreign,
      "f1b-derivation-foreign",
      undefined,
    );
    const derivationHome = runtime.getCell<{ value: number }>(
      space,
      "f1b-derivation-home",
      undefined,
    );
    const derivationTx = runtime.edit();
    stampWaveRunContext(derivationTx, {
      actionId: "derive/crossing",
      kind: "derivation",
      acting: { user: "did:key:alice", session: "sess-1" },
      scopeKeyIdentity: { principal: "did:key:alice", sessionId: "sess-1" },
      capabilityRef: "cap:test-grant",
    });
    derivationTx.enableMultiSpaceWrites?.([foreign, space]);
    derivationForeign.withTx(derivationTx).set({ value: 3 });
    derivationHome.withTx(derivationTx).set({ value: 4 });
    expect((await derivationTx.commit()).error).toBeUndefined();

    // The bystander: everything else the wave is carrying. It never
    // touched the failed space and reads nothing the withdrawals take
    // away, so it commits.
    const bystander = runtime.getCell<{ value: number }>(
      space,
      "f1b-bystander",
      undefined,
    );
    const bystanderTx = runtime.edit();
    stampWaveRunContext(bystanderTx, {
      actionId: "derive/bystander",
      kind: "derivation",
    });
    bystander.withTx(bystanderTx).set({ value: 5 });
    expect((await bystanderTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    wave.failForeignSpace(foreign, "engine open failed (test)");

    // The sink stands in for the serving loop's own, which reaches the
    // failed space through an engine lookup that has nothing to return:
    // a batch built for it can only be refused, and the refusal aborts
    // the wave. The recorded spaces say whether one was built at all.
    const foreignSeqBefore = Engine.serverSeq(foreignEngine);
    const inner = newSink();
    const committedSpaces: MemorySpace[] = [];
    const recordingSink: WaveCommitSink = {
      currentHeads: (s, docs) => inner.currentHeads(s, docs),
      concurrentWritePaths: (s, doc, since) =>
        inner.concurrentWritePaths(s, doc, since),
      commitWave: (
        batch,
      ): Promise<Result<{ seq: number }, WaveCommitRejection>> => {
        committedSpaces.push(batch.space);
        if (batch.space !== space) {
          return Promise.resolve({
            error: {
              name: "WaveCommitRejected",
              message: `no resolved co-hosted engine for ${batch.space}`,
            },
          });
        }
        return inner.commitWave(batch);
      },
    };
    const outcome = await wave.commitWave(recordingSink);
    await wave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.dispositions).toEqual([
      { kind: "requeued" },
      { kind: "dropped" },
      { kind: "committed" },
    ]);
    // The handler's event stays pending and replays; the derivation is
    // recomputed on demand, and its one withdrawn home write is counted.
    expect(outcome.requeuedEventIds).toEqual(["e-crossing"]);
    expect(outcome.dependencyDroppedWrites).toBe(1);

    // Nothing reached the failed space, and at home only the bystander's
    // write landed.
    expect(committedSpaces).toEqual([space]);
    expect(Engine.serverSeq(foreignEngine)).toBe(foreignSeqBefore);
    expect(
      Engine.selectDocHead(engine, {
        id: handlerHome.getAsNormalizedFullLink().id,
        scopeKey: "space",
      }),
    ).toBe(0);
    expect(
      Engine.selectDocHead(engine, {
        id: derivationHome.getAsNormalizedFullLink().id,
        scopeKey: "space",
      }),
    ).toBe(0);
    expect(
      Engine.selectDocHead(engine, {
        id: bystander.getAsNormalizedFullLink().id,
        scopeKey: "space",
      }),
    ).toBeGreaterThan(0);
  });

  it("refuses a foreign-space write at ACCUMULATION on the default posture: the action fails loudly and counted, the wave survives (serving-loop.md §3d, RULED 2026-08-14 (c))", async () => {
    // The lunch-wall trigger, at its ruled seat: a serving runtime's
    // wish materialization resolves against the RUNTIME's home space —
    // the SERVICE identity's — and its writes ride the wave into a
    // foreign space. Pre-ruling those writes sealed fine and the WHOLE
    // WAVE died later at the commit step's #foreignEngineFor guard
    // (loop-failed → park: the space outage). Ruled (c): the refusal
    // moves to ACCUMULATION — action-scoped (only the writing action
    // fails), loud, counted; the wave commits everything else. The
    // commit-step guard stays as backstop.
    const foreignSigner = await Identity.fromPassphrase(
      "wave foreign refusal",
    );
    const foreign = foreignSigner.did() as MemorySpace;
    const lease = liveLease();
    const refusals: { space: MemorySpace; actionId?: string }[] = [];
    const wave = new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "wave-refusal-session",
      },
      replicaFor: (s) => storageManager.open(s).replica,
      lease,
      onForeignWriteRefusal: (info) => refusals.push(info),
    });
    runtime.installSealDestination(wave);

    // The trigger shape: a single-space tx whose writes target the
    // foreign space outright (the profile-bootstrap shape).
    const foreignCell = runtime.getCell<{ value: number }>(
      foreign,
      "refusal-foreign-doc",
      undefined,
    );
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "wish/profile-materialize",
      kind: "derivation",
    });
    foreignCell.withTx(tx).set({ value: 1 });
    const committed = await tx.commit();
    expect(committed.error).toBeDefined();
    expect(committed.error!.message).toContain("foreign-space write");
    expect(refusals).toEqual([
      { space: foreign, actionId: "wish/profile-materialize" },
    ]);

    // The wave SURVIVES: a clean home-space contribution seals and the
    // wave commits it (pre-ruling the foreign batch reached the commit
    // step and killed the whole wave).
    const homeCell = runtime.getCell<{ value: number }>(
      space,
      "refusal-home-doc",
      undefined,
    );
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive/home", kind: "derivation" });
    homeCell.withTx(tx2).set({ value: 2 });
    expect((await tx2.commit()).error).toBeUndefined();
    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.seq).toBeDefined();
    // The home write landed; nothing of the refused action did.
    const homeRow = engine.database.prepare(
      `SELECT COUNT(*) AS n FROM revision WHERE id = :id`,
    ).get({ id: homeCell.getAsNormalizedFullLink().id }) as { n: number };
    expect(homeRow.n).toBeGreaterThanOrEqual(1);
    const foreignRow = engine.database.prepare(
      `SELECT COUNT(*) AS n FROM revision WHERE id = :id`,
    ).get({ id: foreignCell.getAsNormalizedFullLink().id }) as { n: number };
    expect(foreignRow.n).toBe(0);
  });

  it("a multi-space tx under the default posture refuses WHOLE: its already-sealed home writes withdraw, the wave survives (RULED 2026-08-14 (c))", async () => {
    // Failure isolation is per ACTION (§3d): when the tx's foreign half
    // refuses at accumulation, its home half — sealed earlier in the
    // same tx's commit order — must withdraw with it, and the wave
    // keeps serving everyone else.
    const foreignSigner = await Identity.fromPassphrase(
      "wave foreign refusal multi",
    );
    const foreign = foreignSigner.did() as MemorySpace;
    const lease = liveLease();
    const wave = new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "wave-refusal-multi-session",
      },
      replicaFor: (s) => storageManager.open(s).replica,
      lease,
    });
    runtime.installSealDestination(wave);

    const homeCell = runtime.getCell<{ value: number }>(
      space,
      "refusal-multi-home",
      undefined,
    );
    const foreignCell = runtime.getCell<{ value: number }>(
      foreign,
      "refusal-multi-foreign",
      undefined,
    );
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "provision/multi",
      kind: "event-handler",
      eventId: "e-refused",
      acting: { user: "did:key:alice", session: "sess-1" },
    });
    // HOME FIRST, deliberately: the home half seals into the overlay
    // before the foreign half refuses — pinning the withdrawal.
    tx.enableMultiSpaceWrites?.([space, foreign]);
    homeCell.withTx(tx).set({ value: 1 });
    foreignCell.withTx(tx).set({ value: 2 });
    const committed = await tx.commit();
    expect(committed.error).toBeDefined();
    expect(committed.error!.message).toContain("foreign-space write");

    // The wave still commits a clean later contribution, and the
    // refused action's HOME write never lands (withdrawn at seal).
    const cleanCell = runtime.getCell<{ value: number }>(
      space,
      "refusal-multi-clean",
      undefined,
    );
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive/clean", kind: "derivation" });
    cleanCell.withTx(tx2).set({ value: 3 });
    expect((await tx2.commit()).error).toBeUndefined();
    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.seq).toBeDefined();
    const withdrawnHome = engine.database.prepare(
      `SELECT COUNT(*) AS n FROM revision WHERE id = :id`,
    ).get({ id: homeCell.getAsNormalizedFullLink().id }) as { n: number };
    expect(withdrawnHome.n).toBe(0);
    const clean = engine.database.prepare(
      `SELECT COUNT(*) AS n FROM revision WHERE id = :id`,
    ).get({ id: cleanCell.getAsNormalizedFullLink().id }) as { n: number };
    expect(clean.n).toBeGreaterThanOrEqual(1);
  });

  it("folds a reader of a FOREIGN sealed write into the writer's withdrawal (cross-space withdrawn-read closure)", async () => {
    const foreignSigner = await Identity.fromPassphrase("wave foreign closure");
    const foreign = foreignSigner.did() as MemorySpace;
    const foreignEngine = await server.engineForSpace(foreign);
    const lease = liveLease();
    const engines = new Map<MemorySpace, Engine.Engine>([
      [space, engine],
      [foreign, foreignEngine],
    ]);

    const homeDoc = runtime.getCell<{ value: number }>(
      space,
      "wave-xspace-home",
      undefined,
    );
    const foreignSeed = runtime.getCell<{ value: number }>(
      foreign,
      "wave-xspace-foreign-seed",
      undefined,
    );
    const foreignOut = runtime.getCell<{ value: number }>(
      foreign,
      "wave-xspace-foreign-out",
      undefined,
    );
    const homeOut = runtime.getCell<{ value: number }>(
      space,
      "wave-xspace-home-out",
      undefined,
    );

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    // The writer: a provisioning handler seals a FOREIGN write plus a
    // home write a rival will race (whole-doc set → semantic conflict →
    // requeue in the first resolve pass).
    const writerTx = runtime.edit();
    stampWaveRunContext(writerTx, {
      actionId: "provision-writer",
      kind: "event-handler",
      eventId: "e-foreign-writer",
      acting: { user: "did:key:alice", session: "sess-1" },
      // The §2b provisioning carriage (Phase 5's accept gate).
      capabilityRef: "cap:test-grant",
    });
    writerTx.enableMultiSpaceWrites?.([foreign, space]);
    foreignSeed.withTx(writerTx).set({ value: 3 });
    homeDoc.withTx(writerTx).set({ value: 1 });
    expect((await writerTx.commit()).error).toBeUndefined();

    // The reader: reads the writer's FOREIGN sealed write through the
    // foreign replica's layered view and derives writes in both spaces.
    const readerTx = runtime.edit();
    stampWaveRunContext(readerTx, {
      actionId: "derive-from-foreign",
      kind: "derivation",
      // A demanded run acting as its demander (the Phase-5 wish shape:
      // per-demanding-identity resolution riding §2b's crossing) — the
      // acting + grant carriage is what admits its foreign write at
      // the accept gate.
      acting: { user: "did:key:alice", session: "sess-1" },
      scopeKeyIdentity: { principal: "did:key:alice", sessionId: "sess-1" },
      capabilityRef: "cap:test-grant",
    });
    readerTx.enableMultiSpaceWrites?.([foreign, space]);
    const seen = foreignSeed.withTx(readerTx).get();
    expect(seen).toEqual({ value: 3 });
    foreignOut.withTx(readerTx).set({ value: seen!.value + 1 });
    homeOut.withTx(readerTx).set({ value: seen!.value + 10 });
    expect((await readerTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const homeLink = homeDoc.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: homeLink.id,
          value: { value: { value: 1000 } },
        }],
      },
    });

    const sink = new EngineWaveCommitSink({
      engineFor: (s) => engines.get(s)!,
      sessionId: "wave-test-service",
    });
    const outcome = await wave.commitWave(sink);
    await wave.settled();

    // The writer requeued, so its foreign write never lands — and the
    // reader derived from it, so NOTHING the reader wrote may commit,
    // in EITHER space (§3d: no blind derived writes). The foreign read
    // rides the reader's foreign sealed commit, which is what the
    // per-space closure resolves it against.
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.requeuedEventIds).toEqual(["e-foreign-writer"]);
    expect(outcome.dispositions).toEqual([
      { kind: "requeued" },
      { kind: "dropped" },
    ]);
    expect(outcome.dependencyDroppedWrites).toBe(1);
    const foreignOutLink = foreignOut.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(foreignEngine, {
        id: foreignOutLink.id,
        scopeKey: "space",
      }),
    ).toBe(0);
    const homeOutLink = homeOut.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: homeOutLink.id, scopeKey: "space" }),
    ).toBe(0);
  });

  it("disposes each contribution's writes to a conflicted doc independently: one handler's rebase never absolves a derivation's superseded write", async () => {
    const lease = liveLease();

    const doc = runtime.getCell<{ a: number; b: number }>(
      space,
      "wave-mixed",
      undefined,
    );
    const input = runtime.getCell<{ value: number }>(
      space,
      "wave-mixed-input",
      undefined,
    );
    const seedTx = runtime.edit();
    doc.withTx(seedTx).set({ a: 1, b: 1 });
    input.withTx(seedTx).set({ value: 5 });
    expect((await seedTx.commit()).error).toBeUndefined();
    const inputSeq = Engine.serverSeq(engine);

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    // A handler patches /value/a — disjoint from the rival, so it
    // legitimately rebases.
    const handlerTx = runtime.edit();
    stampWaveRunContext(handlerTx, {
      actionId: "handle-a",
      kind: "event-handler",
      eventId: "e-mixed",
      acting: { user: "did:key:alice" },
    });
    doc.withTx(handlerTx).key("a").set(2);
    expect((await handlerTx.commit()).error).toBeUndefined();

    // A pure derivation READS an input and whole-doc-sets the SAME doc:
    // its write must be judged on its own — superseded, dropped — not
    // ride the handler's rebase.
    const derivationTx = runtime.edit();
    stampWaveRunContext(derivationTx, {
      actionId: "derive-mixed",
      kind: "derivation",
    });
    const seen = input.withTx(derivationTx).get();
    doc.withTx(derivationTx).set({ a: seen!.value, b: seen!.value });
    expect((await derivationTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const link = doc.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: link.id,
          patches: [{ op: "replace", path: "/value/b", value: 50 }],
        }],
      },
    });

    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.committedEventIds).toEqual(["e-mixed"]);
    expect(outcome.supersededWrites).toBe(1);
    expect(outcome.dispositions[1]).toEqual({ kind: "dropped" });
    // The authored b survives and the rebased a lands; the stale
    // derivation clobbered nothing.
    const stored = Engine.readState(engine, { id: link.id });
    expect(stored?.document).toEqual({ value: { a: 2, b: 50 } });
    // The Q1 corollary (§3d, RULED 2026-08-05): the dropped-write
    // SURVIVOR still lands its basis rows — its reads are true, and no
    // recompute-owed mark exists.
    const derivationBasis = selectSchedulerBasisRows(engine, {
      branch: "",
      action: "derive-mixed",
      actionScopeKey: "space",
    });
    const inputLink = input.getAsNormalizedFullLink();
    expect(derivationBasis.find((row) => row.entity === inputLink.id))
      .toEqual({
        entitySpace: space,
        entity: inputLink.id,
        entityScopeKey: "space",
        seq: inputSeq,
      });
  });

  it("requeues a second handler whose patch overlaps the concurrent write, while the first handler's disjoint patch rebases", async () => {
    const lease = liveLease();

    const doc = runtime.getCell<{ a: number; b: number }>(
      space,
      "wave-two-handlers",
      undefined,
    );
    const seedTx = runtime.edit();
    doc.withTx(seedTx).set({ a: 1, b: 1 });
    expect((await seedTx.commit()).error).toBeUndefined();

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const firstTx = runtime.edit();
    stampWaveRunContext(firstTx, {
      actionId: "handle-a",
      kind: "event-handler",
      eventId: "e-first",
      acting: { user: "did:key:alice" },
    });
    doc.withTx(firstTx).key("a").set(2);
    expect((await firstTx.commit()).error).toBeUndefined();

    // The second handler patches /value/b — the SAME field the rival
    // writes — so its rebase conflicts semantically and it requeues.
    const secondTx = runtime.edit();
    stampWaveRunContext(secondTx, {
      actionId: "handle-b",
      kind: "event-handler",
      eventId: "e-second",
      acting: { user: "did:key:bob" },
    });
    doc.withTx(secondTx).key("b").set(7);
    expect((await secondTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const link = doc.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: link.id,
          patches: [{ op: "replace", path: "/value/b", value: 50 }],
        }],
      },
    });

    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.committedEventIds).toEqual(["e-first"]);
    expect(outcome.requeuedEventIds).toEqual(["e-second"]);
    // The rival's b stands; the raced consequence did not commit blind.
    const stored = Engine.readState(engine, { id: link.id });
    expect(stored?.document).toEqual({ value: { a: 2, b: 50 } });
  });

  /** C8d scenario: a requeued parent event with a same-wave cascade
   * child. The parent's whole-doc set races a rival (semantic conflict →
   * requeue); the child writes its own doc and reads NOTHING of the
   * parent's, so only the cascade closure ties their fates. */
  const runCascadeRequeueScenario = async () => {
    const lease = liveLease();
    const parentDoc = runtime.getCell<{ value: number }>(
      space,
      "wave-cascade-parent",
      undefined,
    );
    const childDoc = runtime.getCell<{ value: number }>(
      space,
      "wave-cascade-child",
      undefined,
    );

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const parentTx = runtime.edit();
    stampWaveRunContext(parentTx, {
      actionId: "handle-cascade-parent",
      kind: "event-handler",
      eventId: "e-parent",
      acting: { user: "did:key:alice" },
    });
    parentDoc.withTx(parentTx).set({ value: 1 });
    expect((await parentTx.commit()).error).toBeUndefined();

    const childTx = runtime.edit();
    stampWaveRunContext(childTx, {
      actionId: "handle-cascade-child",
      kind: "event-handler",
      eventId: "e-child",
      parentEventId: "e-parent",
      acting: { user: "did:key:alice" },
    });
    childDoc.withTx(childTx).set({ value: 2 });
    expect((await childTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const parentLink = parentDoc.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: parentLink.id,
          value: { value: { value: 1000 } },
        }],
      },
    });

    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    return { outcome, childDoc };
  };

  it("folds a same-wave cascade child into its requeued parent's rollback (C8d closure)", async () => {
    const { outcome, childDoc } = await runCascadeRequeueScenario();

    // The child raced nothing itself — only the cascade closure rolls it
    // back with its parent. Its write must not land: the parent's re-run
    // re-mints the cascade, and a committed child would double it.
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.dispositions).toEqual([
      { kind: "requeued" },
      { kind: "requeued" },
    ]);
    expect(outcome.committedEventIds).toEqual([]);
    expect(outcome.seq).toBeUndefined();
    const childLink = childDoc.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: childLink.id, scopeKey: "space" }),
    ).toBe(0);
  });

  it("reports SURVIVING requeues only: a cascade child of a requeued parent has no durable entry to retry", async () => {
    const { outcome } = await runCascadeRequeueScenario();

    // The child rolled back WITH its parent (previous test), but the
    // serving loop must be told to retry only the PARENT: the cascade
    // child never got a durable stream entry — the parent's re-run
    // re-mints it with a fresh id — so reporting it would make the loop
    // retry an event that does not exist.
    expect(outcome.requeuedEventIds).toEqual(["e-parent"]);
  });

  it("the emit-path tail read is append mechanics, not a dependency (review 2026-08-11 M3, RULED let-stand 2026-08-13): a derivation emitter neither logs nor bases on the target sidecar", async () => {
    // LT6's case: a demanded DERIVATION that emits. Pre-fix, cell.ts's
    // LT1 emission read the sidecar tail UNMARKED, so the emitting
    // run's dependency log and basis rows contained the target stream
    // doc — a neighbor's append to the same stream RE-RAN the emitter
    // (which re-emitted under a fresh eventId). The adjudication: a
    // sender does not re-send because someone else sent — the read is
    // append mechanics, classified with the machinery-read boundary
    // (`ignoreReadForScheduling` + `mergeableOpRead`, the Cell.push
    // precedent).
    const lease = liveLease();
    const servingManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const servingRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: servingManager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    try {
      const streamCell = servingRuntime.getCell<unknown>(
        space,
        "m3-emitter-stream",
        { asCell: ["stream"] },
      );
      const seed = servingRuntime.getCell<{ value: number }>(
        space,
        "m3-emitter-seed",
        undefined,
      );
      {
        const tx = servingRuntime.edit();
        seed.withTx(tx).set({ value: 7 });
        expect((await tx.commit()).error).toBeUndefined();
      }
      const seedSeq = Engine.serverSeq(engine);

      const wave = new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        scopeKeyIdentity: {
          principal: signer.did(),
          sessionId: "m3-session",
        },
        replicaFor: (s) => servingManager.open(s).replica,
        lease,
      });
      servingRuntime.installSealDestination(wave);

      // The demanded-derivation emitter: reads the seed (its one
      // genuine dependency), then emits on the stream — the LT1
      // same-space carriage writes the sidecar entry into this tx.
      const emitTx = servingRuntime.edit();
      stampWaveRunContext(emitTx, {
        actionId: "m3-emitter",
        kind: "derivation",
      });
      const base = seed.withTx(emitTx).get();
      expect(base?.value).toBe(7);
      streamCell.withTx(emitTx).send({ ping: 1 } as never);

      const streamLink = streamCell.getAsNormalizedFullLink();
      const sidecarId = streamEntriesDocId({
        id: streamLink.id,
        path: [...streamLink.path],
      });
      const seedId = seed.getAsNormalizedFullLink().id;

      // The DEPENDENCY-LOG half (the no-re-run mechanism: the
      // scheduler subscribes the action to exactly these reads): the
      // sidecar must NOT be among them; the seed must be.
      const log = txToReactivityLog(emitTx);
      expect(log.reads.some((read) => read.id === seedId)).toBe(true);
      expect(
        log.reads.concat(log.shallowReads).some((read) =>
          read.id === sidecarId
        ),
      ).toBe(false);
      // The WRITE stays logged — the emitter genuinely wrote the entry.
      expect(log.writes.some((write) => write.id === sidecarId)).toBe(true);

      expect((await emitTx.commit()).error).toBeUndefined();
      servingRuntime.clearSealDestination();
      const outcome = await wave.commitWave(newSink());
      await wave.settled();
      expect(outcome.aborted).toBeUndefined();
      expect(outcome.seq).toBeDefined();

      // The BASIS-ROW half (§3b): the emitter's rows carry the seed —
      // and never the sidecar (pre-fix the tail read put it there, so
      // a restart-time basis check re-coupled emitter to stream too).
      const rows = selectSchedulerBasisRows(engine, {
        branch: "",
        action: "m3-emitter",
        actionScopeKey: "space",
      });
      expect(rows.some((row) => row.entity === seedId)).toBe(true);
      expect(rows.some((row) => row.entity === sidecarId)).toBe(false);
      const seedRow = rows.find((row) => row.entity === seedId);
      expect(seedRow?.seq).toBe(seedSeq);

      // Sanity: the emission itself LANDED (the exclusion removed the
      // dependency, not the append) — stamped seq, inherited actor.
      const sidecar = Engine.readState(engine, { id: sidecarId })?.document
        ?.value as
          | {
            entries?: Array<
              { seq?: number; firedAt?: { session?: string } }
            >;
          }
          | undefined;
      expect(sidecar?.entries?.length).toBe(1);
      expect(typeof sidecar?.entries?.[0].seq).toBe("number");
      expect(sidecar?.entries?.[0].firedAt?.session).toBe("server");
    } finally {
      lease.release();
      await servingRuntime.dispose();
      await servingManager.close();
    }
  });

  it("a symbol-bearing FabricValue payload survives wave assembly and stamping — the spine clones never re-encode payloads (verdict blocker, 2026-08-12)", async () => {
    // Registry-interned symbols are valid FabricValues
    // (data-model/interface.ts). Pre-fix, BOTH the batch build
    // (wave.ts) and the engine's stamping helper (engine.ts) ran
    // `structuredClone` over the whole sidecar op: a valid symbol
    // payload threw `DataCloneError` mid-assembly and the
    // event-and-consequence commit aborted.
    const lease = liveLease();
    const servingManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const servingRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: servingManager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    try {
      const streamCell = servingRuntime.getCell<unknown>(
        space,
        "symbol-payload-stream",
        { asCell: ["stream"] },
      );
      const wave = new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        scopeKeyIdentity: {
          principal: signer.did(),
          sessionId: "symbol-session",
        },
        replicaFor: (s) => servingManager.open(s).replica,
        lease,
      });
      servingRuntime.installSealDestination(wave);
      const emitTx = servingRuntime.edit();
      stampWaveRunContext(emitTx, {
        actionId: "symbol-emitter",
        kind: "derivation",
      });
      streamCell.withTx(emitTx).send(
        { tag: Symbol.for("cf:test-tag") } as never,
      );
      expect((await emitTx.commit()).error).toBeUndefined();
      servingRuntime.clearSealDestination();
      const outcome = await wave.commitWave(newSink());
      await wave.settled();
      // Pre-fix: DataCloneError aborted the wave right here.
      expect(outcome.aborted).toBeUndefined();
      expect(outcome.seq).toBeDefined();
      const streamLink = streamCell.getAsNormalizedFullLink();
      const sidecarId = streamEntriesDocId({
        id: streamLink.id,
        path: [...streamLink.path],
      });
      const sidecar = Engine.readState(engine, { id: sidecarId })?.document
        ?.value as
          | { entries?: Array<{ seq?: number }> }
          | undefined;
      expect(sidecar?.entries?.length).toBe(1);
      expect(typeof sidecar?.entries?.[0].seq).toBe("number");
    } finally {
      lease.release();
      await servingRuntime.dispose();
      await servingManager.close();
    }
  });

  it("drops a derivation that read a requeued handler's sealed write (nothing derived from withdrawn state commits)", async () => {
    const lease = liveLease();
    const consequence = runtime.getCell<{ value: number }>(
      space,
      "wave-requeued-consequence",
      undefined,
    );
    const derived = runtime.getCell<{ value: number }>(
      space,
      "wave-derived-from-requeued",
      undefined,
    );

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const handlerTx = runtime.edit();
    stampWaveRunContext(handlerTx, {
      actionId: "handle-withdrawn",
      kind: "event-handler",
      eventId: "e-withdrawn",
      acting: { user: "did:key:alice" },
    });
    consequence.withTx(handlerTx).set({ value: 5 });
    expect((await handlerTx.commit()).error).toBeUndefined();

    // The derivation READS the handler's sealed write through the
    // layered view, then writes its own doc.
    const deriveTx = runtime.edit();
    stampWaveRunContext(deriveTx, {
      actionId: "derive-from-withdrawn",
      kind: "derivation",
    });
    const seen = consequence.withTx(deriveTx).get();
    expect(seen).toEqual({ value: 5 });
    derived.withTx(deriveTx).set({ value: seen!.value + 1 });
    expect((await deriveTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    // A rival whole-doc set races the consequence: semantic conflict, so
    // the handler REQUEUES (not a per-doc drop — the closure must fold
    // the reader in off the requeue arm specifically).
    const link = consequence.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: link.id,
          value: { value: { value: 1000 } },
        }],
      },
    });

    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    // The derivation derived from state that will re-run later:
    // committing it would be §3d's forbidden blind derived write.
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.requeuedEventIds).toEqual(["e-withdrawn"]);
    expect(outcome.dispositions).toEqual([
      { kind: "requeued" },
      { kind: "dropped" },
    ]);
    expect(outcome.dependencyDroppedWrites).toBe(1);
    const derivedLink = derived.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: derivedLink.id, scopeKey: "space" }),
    ).toBe(0);
  });

  it("re-resolves when the sink's in-transaction re-verification names a doc that moved after the head query", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const x = runtime.getCell<{ value: number }>(space, "wave-race", undefined);
    const keep = runtime.getCell<{ value: number }>(
      space,
      "wave-race-keep",
      undefined,
    );
    const tx = runtime.edit();
    stampWaveRunContext(tx, { actionId: "derive-race", kind: "derivation" });
    x.withTx(tx).set({ value: 1 });
    keep.withTx(tx).set({ value: 2 });
    expect((await tx.commit()).error).toBeUndefined();
    const settlement = waveSettlementOf(tx);
    expect(settlement).toBeDefined();
    runtime.clearSealDestination();

    // The rival lands BETWEEN the accumulator's head query and the store
    // transaction: injected on the sink's first home commit attempt, so
    // only the engine's in-transaction re-verification can catch it.
    const xLink = x.getAsNormalizedFullLink();
    const inner = newSink();
    let homeAttempts = 0;
    const racingSink: WaveCommitSink = {
      currentHeads: (s, docs) => inner.currentHeads(s, docs),
      concurrentWritePaths: (s, doc, since) =>
        inner.concurrentWritePaths(s, doc, since),
      commitWave: (batch) => {
        homeAttempts += 1;
        if (homeAttempts === 1) {
          Engine.applyCommit(engine, {
            sessionId: "rival-session",
            principal: "user:rival",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: xLink.id,
                value: { value: { value: 99 } },
              }],
            },
          });
        }
        return inner.commitWave(batch);
      },
    };

    const outcome = await wave.commitWave(racingSink);
    await wave.settled();
    const settled = await settlement!;

    // Attempt 1 was rejected with the doc NAMED; the loop folded it in,
    // dropped the superseded write, and attempt 2 committed the rest.
    expect(homeAttempts).toBe(2);
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.supersededWrites).toBe(1);
    expect(outcome.dispositions[0]).toEqual({
      kind: "partially-dropped",
      droppedOps: 1,
    });
    expect(settled.error).toBeDefined();
    expect(
      (settled.error as { waveWithdrawalCause?: unknown })
        .waveWithdrawalCause,
    ).toBeUndefined();
    const stored = Engine.readState(engine, { id: xLink.id });
    expect(stored?.document).toEqual({ value: { value: 99 } });
    const keepLink = keep.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: keepLink.id, scopeKey: "space" }),
    ).toBe(outcome.seq);
  });

  it("resolves a sink-reported precondition failure per owning contribution, never whole-wave", async () => {
    const lease = liveLease();
    const guarded = runtime.getCell<{ value: number }>(
      space,
      "wave-guarded-out",
      undefined,
    );
    const independent = runtime.getCell<{ value: number }>(
      space,
      "wave-independent-out",
      undefined,
    );

    // The doc the handler's create-only gate targets, created by a rival
    // DIRECTLY against the engine: the replica never sees it, so only
    // the engine's in-transaction validation can catch the violation —
    // exactly the race the wave-side resolution loop exists for.
    const takenId = "of:wave-precondition-taken";
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: takenId,
          value: { value: { value: 1 } },
        }],
      },
    });

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const handlerTx = runtime.edit();
    stampWaveRunContext(handlerTx, {
      actionId: "handle-guarded",
      kind: "event-handler",
      eventId: "e-guarded",
      acting: { user: "did:key:alice" },
    });
    guarded.withTx(handlerTx).set({ value: 1 });
    // Non-null assert rather than `?.`: a silently skipped gate would
    // make this test vacuous — absence must throw.
    handlerTx.addCommitPrecondition!(space, {
      kind: "entity-absent",
      id: takenId,
    });
    expect((await handlerTx.commit()).error).toBeUndefined();

    const deriveTx = runtime.edit();
    stampWaveRunContext(deriveTx, {
      actionId: "derive-independent",
      kind: "derivation",
    });
    independent.withTx(deriveTx).set({ value: 2 });
    expect((await deriveTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    // Per-owning-contribution resolution: the handler REQUEUES on its
    // violated gate, the unrelated derivation COMMITS. A whole-wave
    // abort here would be §3d's forbidden whole-wave CAS failure shape.
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.dispositions).toEqual([
      { kind: "requeued" },
      { kind: "committed" },
    ]);
    expect(outcome.requeuedEventIds).toEqual(["e-guarded"]);
    expect(outcome.committedEventIds).toEqual([]);
    const guardedLink = guarded.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: guardedLink.id, scopeKey: "space" }),
    ).toBe(0);
    const independentLink = independent.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, {
        id: independentLink.id,
        scopeKey: "space",
      }),
    ).toBe(outcome.seq);
  });

  it("validates a preconditions-only wave instead of short-circuiting (a violated gate must not resolve committed)", async () => {
    const lease = liveLease();
    const takenId = "of:wave-preconditions-only-taken";
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: takenId,
          value: { value: { value: 1 } },
        }],
      },
    });

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    const guardTx = runtime.edit();
    stampWaveRunContext(guardTx, {
      actionId: "derive-guard",
      kind: "derivation",
    });
    guardTx.addCommitPrecondition!(space, {
      kind: "entity-absent",
      id: takenId,
    });
    expect((await guardTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();
    expect(wave.contributionCount).toBe(1);

    const seqBefore = Engine.serverSeq(engine);
    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    // A home batch with 0 ops and 0 consequenceOf but a NON-EMPTY gate
    // must reach the sink: short-circuiting it resolves the contribution
    // committed (seq 0) with the gate never validated.
    expect(outcome.dispositions).toEqual([{ kind: "dropped" }]);
    expect(outcome.seq).toBeUndefined();
    expect(Engine.serverSeq(engine)).toBe(seqBefore);
  });

  it("attaches the explicit scope_key on a scoped write at seal time, and the engine keys the row by it", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const scoped = runtime.getCell<{ value: number }>(
      space,
      "wave-scoped",
      undefined,
      undefined,
      "user",
    );
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "handle-scoped",
      kind: "event-handler",
      eventId: "e-scoped",
      acting: { user: "did:key:alice", session: "sess-1" },
    });
    scoped.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();

    const expectedKey = Engine.resolveScopeKey("user", {
      principal: signer.did(),
      sessionId: "wave-test-session",
    });
    const row = engine.database.prepare(
      `SELECT annotations FROM "commit" WHERE seq = :seq`,
    ).get({ seq: outcome.seq }) as { annotations: string };
    const annotations = decodeMemoryBoundary(row.annotations) as Array<
      Record<string, unknown>
    >;
    const scopedAnnotation = annotations.find((a) => a.scopeKey !== undefined);
    expect(scopedAnnotation?.scopeKey).toBe(expectedKey);
    expect(scopedAnnotation?.actingUser).toBe("did:key:alice");
    const link = scoped.getAsNormalizedFullLink();
    const revision = engine.database.prepare(
      `SELECT scope_key FROM revision WHERE id = :id`,
    ).get({ id: link.id }) as { scope_key: string };
    expect(revision.scope_key).toBe(expectedKey);
  });

  it("replaces a same-instance action's basis rows with the LAST run's set within one wave", async () => {
    const lease = liveLease();

    const seedA = runtime.getCell<{ value: number }>(
      space,
      "wave-seed-a",
      undefined,
    );
    const seedB = runtime.getCell<{ value: number }>(
      space,
      "wave-seed-b",
      undefined,
    );
    const outA = runtime.getCell<{ value: number }>(
      space,
      "wave-out-a",
      undefined,
    );
    const outB = runtime.getCell<{ value: number }>(
      space,
      "wave-out-b",
      undefined,
    );
    for (const [cell, value] of [[seedA, 1], [seedB, 2]] as const) {
      const tx = runtime.edit();
      cell.withTx(tx).set({ value });
      expect((await tx.commit()).error).toBeUndefined();
    }

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    // The same action instance runs twice in one wave (re-dirtied by a
    // later input); §3b's overwrite unit: the LAST run's rows replace
    // the first run's as a set — never a union.
    const run1 = runtime.edit();
    stampWaveRunContext(run1, { actionId: "recompute", kind: "derivation" });
    outA.withTx(run1).set({ value: seedA.withTx(run1).get()!.value + 1 });
    expect((await run1.commit()).error).toBeUndefined();
    const run2 = runtime.edit();
    stampWaveRunContext(run2, { actionId: "recompute", kind: "derivation" });
    outB.withTx(run2).set({ value: seedB.withTx(run2).get()!.value + 1 });
    expect((await run2.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();

    const basis = selectSchedulerBasisRows(engine, {
      branch: "",
      action: "recompute",
      actionScopeKey: "space",
    });
    const entities = basis.map((row) => row.entity);
    const seedALink = seedA.getAsNormalizedFullLink();
    const seedBLink = seedB.getAsNormalizedFullLink();
    expect(entities).toContain(seedBLink.id);
    expect(entities).not.toContain(seedALink.id);
  });

  it("isolates a failed seal to its own action (an aborted tx discards only its own writes)", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const kept = runtime.getCell<{ value: number }>(
      space,
      "wave-kept",
      undefined,
    );
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-kept", kind: "derivation" });
    kept.withTx(tx1).set({ value: 1 });
    expect((await tx1.commit()).error).toBeUndefined();

    // The second action aborts before commit: it never reaches the wave.
    const dropped = runtime.getCell<{ value: number }>(
      space,
      "wave-aborted",
      undefined,
    );
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-drop", kind: "derivation" });
    dropped.withTx(tx2).set({ value: 2 });
    tx2.abort("test");

    expect(wave.contributionCount).toBe(1);
    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.dispositions).toEqual([{ kind: "committed" }]);
    const keptLink = kept.getAsNormalizedFullLink();
    const droppedLink = dropped.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: keptLink.id, scopeKey: "space" }),
    ).toBe(outcome.seq);
    expect(
      Engine.selectDocHead(engine, { id: droppedLink.id, scopeKey: "space" }),
    ).toBe(0);
  });

  it("stage F: delegated foreign scoped writes key from the CARRIED acting identity; missing or partial carriage is refused (protocol.md §2's delegated row)", async () => {
    const foreignSigner = await Identity.fromPassphrase(
      "wave delegated foreign space",
    );
    const foreign = foreignSigner.did() as MemorySpace;
    const foreignEngine = await server.engineForSpace(foreign);
    seedGenesisAcl(foreignEngine, foreign);
    const lease = liveLease();
    const engines = new Map<MemorySpace, Engine.Engine>([
      [space, engine],
      [foreign, foreignEngine],
    ]);

    const provision = async (
      context: Parameters<typeof stampWaveRunContext>[1],
      value: number,
    ): Promise<WaveAccumulator> => {
      const wave = newWave({ lease });
      runtime.installSealDestination(wave);
      const foreignScoped = runtime.getCell<{ value: number }>(
        foreign,
        "wave-delegated-scoped",
        undefined,
        undefined,
        "user",
      );
      const home = runtime.getCell<{ value: number }>(
        space,
        "wave-delegated-home",
        undefined,
      );
      const tx = runtime.edit();
      stampWaveRunContext(tx, context);
      tx.enableMultiSpaceWrites?.([foreign, space]);
      foreignScoped.withTx(tx).set({ value });
      home.withTx(tx).set({ value: value + 1 });
      expect((await tx.commit()).error).toBeUndefined();
      runtime.clearSealDestination();
      return wave;
    };

    // WITH full delegated carriage: admitted; the foreign scoped row is
    // keyed by the ACTING principal's instance — never the sink's own.
    const acting = { user: "did:key:alice", session: "sess-1" };
    const okWave = await provision({
      actionId: "provision-scoped",
      kind: "event-handler",
      eventId: "e-delegated",
      acting,
      scopeKeyIdentity: { principal: acting.user, sessionId: acting.session },
      capabilityRef: "cap:test-grant",
    }, 7);
    const sink = new EngineWaveCommitSink({
      engineFor: (s) => engines.get(s)!,
      sessionId: executionLeaseHolder(`service:${space}`),
    });
    const outcome = await okWave.commitWave(sink);
    await okWave.settled();
    expect(outcome.aborted).toBeUndefined();

    const foreignRows = foreignEngine.database.prepare(
      `SELECT scope_key FROM revision WHERE id = :id`,
    ).all({
      id: runtime.getCell<{ value: number }>(
        foreign,
        "wave-delegated-scoped",
        undefined,
        undefined,
        "user",
      ).getAsNormalizedFullLink().id,
    }) as { scope_key: string }[];
    expect(foreignRows.map((r) => r.scope_key)).toEqual([
      "user:did%3Akey%3Aalice",
    ]);
    const meta = foreignEngine.database.prepare(
      `SELECT class, acting_principal, acting_session, capability_ref
       FROM "commit" ORDER BY seq DESC LIMIT 1`,
    ).get() as Record<string, string>;
    expect(meta.class).toBe("authored");
    expect(meta.acting_principal).toBe("did:key:alice");
    expect(meta.acting_session).toBe("sess-1");
    expect(meta.capability_ref).toBe("cap:test-grant");

    // WITHOUT the capabilityRef (partial carriage): refused at
    // ACCUMULATION (Phase 5's accept-with-carriage gate — a foreign
    // write is admitted only under the full §2b delegated carriage), so
    // the tx fails action-scoped and NOTHING reaches the sink, let
    // alone keys from its principal. The sink's own delegated
    // validation stays as backstop (its direct test below).
    const partialWave = newWave({ lease });
    runtime.installSealDestination(partialWave);
    const foreignScoped = runtime.getCell<{ value: number }>(
      foreign,
      "wave-delegated-scoped",
      undefined,
      undefined,
      "user",
    );
    const home = runtime.getCell<{ value: number }>(
      space,
      "wave-delegated-home",
      undefined,
    );
    const partialTx = runtime.edit();
    stampWaveRunContext(partialTx, {
      actionId: "provision-scoped-2",
      kind: "event-handler",
      eventId: "e-partial",
      acting,
      scopeKeyIdentity: { principal: acting.user, sessionId: acting.session },
      // no capabilityRef
    });
    partialTx.enableMultiSpaceWrites?.([foreign, space]);
    foreignScoped.withTx(partialTx).set({ value: 21 });
    home.withTx(partialTx).set({ value: 22 });
    const partialCommit = await partialTx.commit();
    expect(partialCommit.error?.message ?? "").toContain(
      "foreign-space write refused at wave accumulation",
    );
    runtime.clearSealDestination();
    const outcome2 = await partialWave.commitWave(sink);
    await partialWave.settled();
    // Nothing sealed: the refused tx withdrew whole, the wave is vacuous.
    expect(outcome2.aborted).toBeUndefined();
    expect(outcome2.committedEventIds).toEqual([]);
  });

  it("Phase 5 backstop: the sink still refuses a foreign batch's scoped op without delegated carriage (protocol.md §2's delegated row)", async () => {
    const foreignSigner = await Identity.fromPassphrase(
      "wave sink backstop foreign space",
    );
    const foreign = foreignSigner.did() as MemorySpace;
    const foreignEngine = await server.engineForSpace(foreign);
    // Genesis first (OW31 B4): this pin is about the CARRIAGE refusal,
    // which sits behind the sink's INV-13 mirror.
    seedGenesisAcl(foreignEngine, foreign);
    const sink = new EngineWaveCommitSink({
      engineFor: () => foreignEngine,
      sessionId: executionLeaseHolder(`service:${space}`),
    });
    const refused = await sink.commitWave({
      space: foreign,
      home: false,
      basisSeq: 0,
      rebasedHeads: [],
      operations: [{
        op: "set",
        id: "of:backstop",
        scope: "user",
        value: { value: { v: 1 } },
      } as never],
      preconditions: [],
      annotations: [],
      consequenceOf: [],
      basisInstances: [],
      holder: undefined,
      // no delegated carriage
    });
    expect(refused.error?.message ?? "").toContain(
      "scoped write in a foreign wave batch refused",
    );
  });

  it("OW31 B4: a foreign data commit never lands before the genesis ACL — the sink mirrors INV-13 on the engine-direct plane", async () => {
    const foreignSigner = await Identity.fromPassphrase(
      "wave sink inv13 foreign space",
    );
    const foreign = foreignSigner.did() as MemorySpace;
    const foreignEngine = await server.engineForSpace(foreign);
    const sink = new EngineWaveCommitSink({
      engineFor: () => foreignEngine,
      sessionId: executionLeaseHolder(`service:${space}`),
    });
    const acting = "did:key:z6Mk-inv13-alice";
    const batchFor = (id: string) => ({
      space: foreign,
      home: false as const,
      basisSeq: 0,
      rebasedHeads: [],
      operations: [{
        op: "set",
        id,
        value: { value: { v: 1 } },
      } as never],
      preconditions: [],
      annotations: [],
      consequenceOf: [],
      basisInstances: [],
      holder: undefined,
      delegated: {
        actingPrincipal: acting,
        capabilityRef: "event-consequence:e-inv13",
      },
    });

    // Fresh engine (seq 0, no ACL): the data batch REFUSES — the
    // genesis ACL must be the space's first commit (INV-13's
    // precedence, protocol.md §2's genesis clause; session-plane
    // #validateAclCommit's mirror on the engine-direct plane).
    const refused = await sink.commitWave(batchFor("of:inv13-data"));
    expect(refused.error?.message ?? "").toContain("genesis");
    expect(Engine.serverSeq(foreignEngine)).toBe(0);

    // With the genesis ACL landed (seq 1, the space's first commit —
    // as the wave commit step forces for creation-granted targets),
    // the same batch applies at seq 2.
    Engine.applyCommit(foreignEngine, {
      sessionId: "inv13-genesis-session",
      space: foreign,
      principal: foreign,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${foreign}`,
          value: { value: { [acting]: "OWNER", "*": "WRITE" } },
        }],
      },
    });
    expect(Engine.serverSeq(foreignEngine)).toBe(1);
    const applied = await sink.commitWave(batchFor("of:inv13-data"));
    expect(applied.error).toBeUndefined();
    expect(applied.ok?.seq).toBe(2);
  });

  it("OW31 B3+B4: a creation-granted provisioning wave forces the genesis ACL (owner = the acting user, actor = the space) before its data batch; replay converges on the acl arm; a mis-threaded owner shows in the ACL content (the wildcard write grant is the F2 residual)", async () => {
    // The serving-side storage manager: bootstrap-capable factory over
    // the SAME shared server, holding the provisioned space's identity
    // with the ACTING user as genesis owner (slice-1 threading).
    class BootstrapLoopbackFactory implements SessionFactory {
      readonly supportsAclBootstrap = true;
      readonly principals: string[] = [];
      readonly #server: MemoryV2Server.Server;

      constructor(server: MemoryV2Server.Server) {
        this.#server = server;
      }
      async create(
        targetSpace: MemorySpace,
        sessionSigner?: Signer,
        requested: MemoryV2Client.MountOptions = {},
      ) {
        this.principals.push(sessionSigner?.did() ?? "<anonymous>");
        const client = await MemoryV2Client.connect({
          transport: MemoryV2Client.loopback(this.#server),
        });
        const session = await client.mount(
          targetSpace,
          requested,
          (_space, _session, context) => ({
            invocation: {
              aud: context.audience,
              challenge: context.challenge.value,
            },
            authorization: { principal: sessionSigner?.did() },
          }),
        );
        return { client, session };
      }
    }
    class BootstrapStorageManager extends StorageManager {
      static overServer(
        options: Omit<StorageOptions, "memoryHost">,
        factory: SessionFactory,
      ): BootstrapStorageManager {
        return new BootstrapStorageManager(
          { ...options, memoryHost: new URL("memory://") },
          factory,
        );
      }
    }
    const serviceSigner = await Identity.fromPassphrase(
      "ow31 provisioning service",
    );
    const alice = "did:key:z6Mk-ow31-acting-alice";
    const pIdentity = await Identity.fromPassphrase("ow31 provisioned space");
    const provisioned = pIdentity.did() as MemorySpace;
    const factory = new BootstrapLoopbackFactory(server);
    const servingManager = BootstrapStorageManager.overServer(
      { as: serviceSigner },
      factory,
    );
    servingManager.registerSpaceIdentity(pIdentity, { owner: alice });

    const lease = liveLease();
    const provisionWave = (): WaveAccumulator =>
      new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        scopeKeyIdentity: {
          principal: signer.did(),
          sessionId: "ow31-wave-session",
        },
        replicaFor: (s) => storageManager.open(s).replica,
        lease,
        foreignWrites: "accept",
        // The REAL structural grant supply with the FULL verdict — the
        // shape the serving loop now wires (the via arm is retained).
        foreignWriteGrant: (s, acting) =>
          server.foreignWriteAuthorityFor(s, acting.user),
      });
    const sealProvision = async (wave: WaveAccumulator, value: number) => {
      runtime.installSealDestination(wave);
      const cell = runtime.getCell<{ value: number }>(
        provisioned,
        "ow31-provisioned-doc",
        undefined,
      );
      const home = runtime.getCell<{ value: number }>(
        space,
        "ow31-home-link",
        undefined,
      );
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "ow31-provision",
        kind: "event-handler",
        eventId: "e-ow31",
        acting: { user: alice, session: "sess-ow31" },
        capabilityRef: "event-consequence:e-ow31",
      });
      tx.enableMultiSpaceWrites?.([provisioned, space]);
      cell.withTx(tx).set({ value });
      home.withTx(tx).set({ value: value + 1 });
      expect((await tx.commit()).error).toBeUndefined();
      runtime.clearSealDestination();
    };

    try {
      // Wave 1: the crossing is granted via the CREATION arm and the
      // wave retains it.
      const wave1 = provisionWave();
      await sealProvision(wave1, 7);
      expect(wave1.creationGrantedForeignSpaces()).toEqual([provisioned]);

      // The commit step's forcing (space-server.ts): genesis BEFORE the
      // sink's data batch.
      await servingManager.ensureSpaceInitialized(provisioned);
      const pEngine = await server.engineForSpace(provisioned);
      const engines = new Map<MemorySpace, Engine.Engine>([
        [space, engine],
        [provisioned, pEngine],
      ]);
      const sink = new EngineWaveCommitSink({
        engineFor: (s) => engines.get(s)!,
        sessionId: executionLeaseHolder(`service:${space}`),
      });
      const outcome1 = await wave1.commitWave(sink);
      await wave1.settled();
      expect(outcome1.aborted).toBeUndefined();

      // The pins: commit #1 IS the ACL; owner = the acting user; the
      // genesis actor is the SPACE identity; the service appears
      // NOWHERE; the data batch landed at seq >= 2.
      expect(
        Engine.selectDocHead(pEngine, {
          id: `of:${provisioned}`,
          scopeKey: "space",
        }),
      ).toBe(1);
      const acl = await server.readDocument(provisioned, `of:${provisioned}`);
      expect(acl?.value).toEqual({ [alice]: "OWNER", "*": "WRITE" });
      expect(
        Object.keys(acl?.value as Record<string, unknown>),
      ).not.toContain(serviceSigner.did());
      expect(factory.principals).toContain(pIdentity.did());
      const dataHead = Engine.selectDocHead(pEngine, {
        id: runtime.getCell<{ value: number }>(
          provisioned,
          "ow31-provisioned-doc",
          undefined,
        ).getAsNormalizedFullLink().id,
        scopeKey: "space",
      });
      expect(dataHead).toBeGreaterThanOrEqual(2);

      // REPLAY (a kill between the foreign and home commits re-runs the
      // handler): the store now exists, so the grant resolves via the
      // ACL arm through the acting user's OWNER — no second genesis is
      // forced, the data re-applies convergently, and the ACL stays the
      // ONE user-owned document at seq 1.
      const wave2 = provisionWave();
      await sealProvision(wave2, 7);
      expect(wave2.creationGrantedForeignSpaces()).toEqual([]);
      const outcome2 = await wave2.commitWave(sink);
      await wave2.settled();
      expect(outcome2.aborted).toBeUndefined();
      expect(
        Engine.selectDocHead(pEngine, {
          id: `of:${provisioned}`,
          scopeKey: "space",
        }),
      ).toBe(1);
      expect(
        (await server.readDocument(provisioned, `of:${provisioned}`))?.value,
      ).toEqual({ [alice]: "OWNER", "*": "WRITE" });

      // The MUTATION pin (B4 iii): drop/mis-thread the genesis owner —
      // a space whose genesis named someone else refuses the acting
      // user's replay on the acl arm, loudly.
      const wrongIdentity = await Identity.fromPassphrase(
        "ow31 wrong-owner space",
      );
      const wrongSpace = wrongIdentity.did() as MemorySpace;
      servingManager.registerSpaceIdentity(wrongIdentity, {
        owner: "did:key:z6Mk-ow31-bob",
      });
      await servingManager.ensureSpaceInitialized(wrongSpace);
      const wrongVerdict = await server.foreignWriteAuthorityFor(
        wrongSpace,
        alice,
      );
      // "*": "WRITE" still grants alice via the wildcard (flagged
      // residual F2 — the wildcard is a separate policy question), so
      // the acl arm GRANTS here; the owner mutation shows up in the
      // ACL content, not the wildcard-covered write grant.
      expect(wrongVerdict).toEqual({ granted: true, via: "acl" });
      expect(
        (await server.readDocument(wrongSpace, `of:${wrongSpace}`))?.value,
      ).toEqual({ "did:key:z6Mk-ow31-bob": "OWNER", "*": "WRITE" });
    } finally {
      await servingManager.close();
    }
  });

  it("Phase 5 accept gate is an AUTHORIZATION boundary: an UNGRANTED crossing refuses action-scoped even with full carriage; the actor's own home space admits (protocol.md §2b; the F1 fix)", async () => {
    // The F1 finding: carriage (acting + capabilityRef) is minted for
    // every acting run, so a carriage-only gate authorized nothing —
    // any served pattern acting for any user could write ANY co-hosted
    // space. The gate now consults a REAL authorization predicate; here
    // it is wired to the memory server's structural grant supply
    // (foreignWriteAuthorityFor), exactly as the serving loop wires it.
    const actorSigner = await Identity.fromPassphrase("wave grant actor");
    const actor = actorSigner.did();
    const victimSigner = await Identity.fromPassphrase(
      "wave grant victim space",
    );
    const victim = victimSigner.did() as MemorySpace;
    // The victim space EXISTS (engine open) and carries no ACL: the
    // serving plane fails closed for it (fail-closed interim,
    // protocol.md §2 — the client path's populated-legacy compat is a
    // rollout accommodation, not a grant).
    await server.engineForSpace(victim);

    let refusals = 0;
    const wave = new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "wave-grant-session",
      },
      replicaFor: (s) => storageManager.open(s).replica,
      foreignWrites: "accept",
      foreignWriteGrant: async (s, acting) =>
        (await server.foreignWriteAuthorityFor(s, acting.user)).granted,
      onForeignWriteRefusal: () => {
        refusals += 1;
      },
    });
    runtime.installSealDestination(wave);
    try {
      // UNGRANTED: full §2b carriage, existing foreign space, no
      // authority — the review's concrete attack (a run acting for
      // alice writing a space alice holds nothing on). Pre-fix this
      // ADMITTED; it must refuse action-scoped, loud and counted.
      const ungrantedTarget = runtime.getCell<{ value: number }>(
        victim,
        "wave-grant-victim-doc",
        undefined,
      );
      const homeBeside = runtime.getCell<{ value: number }>(
        space,
        "wave-grant-home-doc",
        undefined,
      );
      const ungrantedTx = runtime.edit();
      stampWaveRunContext(ungrantedTx, {
        actionId: "provision-ungranted",
        kind: "event-handler",
        eventId: "e-ungranted",
        acting: { user: actor, session: "sess-1" },
        capabilityRef: "cap:test-grant",
      });
      ungrantedTx.enableMultiSpaceWrites?.([victim, space]);
      ungrantedTarget.withTx(ungrantedTx).set({ value: 1 });
      homeBeside.withTx(ungrantedTx).set({ value: 2 });
      const ungrantedCommit = await ungrantedTx.commit();
      expect(ungrantedCommit.error?.message ?? "").toContain(
        "holds no structural write grant",
      );
      expect(refusals).toBe(1);

      // GRANTED (owner-by-identity): the SAME carriage shape targeting
      // the acting identity's OWN home space (space DID == actor DID)
      // is admitted at the gate — the demanded wish bootstrap's
      // sanctioned §2b crossing.
      const ownTarget = runtime.getCell<{ value: number }>(
        actor as MemorySpace,
        "wave-grant-own-home-doc",
        undefined,
      );
      const homeBeside2 = runtime.getCell<{ value: number }>(
        space,
        "wave-grant-home-doc-2",
        undefined,
      );
      const grantedTx = runtime.edit();
      stampWaveRunContext(grantedTx, {
        actionId: "provision-own-home",
        kind: "event-handler",
        eventId: "e-own-home",
        acting: { user: actor, session: "sess-1" },
        capabilityRef: "cap:test-grant",
      });
      grantedTx.enableMultiSpaceWrites?.([actor as MemorySpace, space]);
      ownTarget.withTx(grantedTx).set({ value: 3 });
      homeBeside2.withTx(grantedTx).set({ value: 4 });
      const grantedCommit = await grantedTx.commit();
      expect(grantedCommit.error).toBeUndefined();
      expect(refusals).toBe(1);
      expect(wave.foreignSpaces).toEqual([actor as MemorySpace]);
    } finally {
      runtime.clearSealDestination();
      wave.abandon("test-only");
      await wave.settled();
    }
  });

  it("Phase 5 accept gate cannot be configured VACUOUS: accept without an authority probe refuses at construction (the F1 fix)", () => {
    expect(() =>
      new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        scopeKeyIdentity: {
          principal: signer.did(),
          sessionId: "wave-vacuous-session",
        },
        replicaFor: (s) => storageManager.open(s).replica,
        foreignWrites: "accept",
      })
    ).toThrow("foreignWriteGrant");
  });

  it("stage F: a read in a space the run wrote nothing to folds the reader into a withdrawal (the discharged stage-D bound)", async () => {
    const foreignSigner = await Identity.fromPassphrase(
      "wave read-only space",
    );
    const foreign = foreignSigner.did() as MemorySpace;
    const foreignEngine = await server.engineForSpace(foreign);
    const lease = liveLease();
    const engines = new Map<MemorySpace, Engine.Engine>([
      [space, engine],
      [foreign, foreignEngine],
    ]);
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const foreignDoc = runtime.getCell<{ value: number }>(
      foreign,
      "wave-foreign-input",
      undefined,
    );
    const homeIn = runtime.getCell<{ value: number }>(
      space,
      "wave-ro-home-in",
      undefined,
    );
    const homeOut = runtime.getCell<{ value: number }>(
      space,
      "wave-ro-home-out",
      undefined,
    );

    // Contribution 0: an event handler WRITES the foreign doc (multi-space
    // seal) and a home doc.
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, {
      actionId: "write-foreign",
      kind: "event-handler",
      eventId: "e-fw",
      acting: { user: "did:key:alice", session: "sess-1" },
      capabilityRef: "cap:test-grant",
    });
    tx1.enableMultiSpaceWrites?.([foreign, space]);
    foreignDoc.withTx(tx1).set({ value: 5 });
    homeIn.withTx(tx1).set({ value: 5 });
    expect((await tx1.commit()).error).toBeUndefined();

    // Contribution 1: a derivation READS the foreign doc (read-only in
    // that space — the tx seals only the home space) and writes home.
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, {
      actionId: "derive-from-foreign",
      kind: "derivation",
    });
    const seen = foreignDoc.withTx(tx2).get();
    homeOut.withTx(tx2).set({ value: (seen?.value ?? 0) + 1 });
    expect((await tx2.commit()).error).toBeUndefined();

    // A rival authored commit moves homeIn's head past the basis, which
    // REQUEUES contribution 0 (whole-doc set never commutes) — its
    // foreign write withdraws with it. Contribution 1 read that
    // withdrawn foreign write in a space it wrote nothing to: without
    // the sealSpaceReads handoff it would commit blind; with it, it
    // folds into the withdrawal.
    const homeInLink = homeIn.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: homeInLink.id,
          value: { value: { value: 99 } },
        }],
      },
    });

    runtime.clearSealDestination();
    const sink = new EngineWaveCommitSink({
      engineFor: (s) => engines.get(s)!,
      sessionId: executionLeaseHolder(`service:${space}`),
    });
    const outcome = await wave.commitWave(sink);
    await wave.settled();

    expect(outcome.requeuedEventIds).toEqual(["e-fw"]);
    expect(outcome.dispositions[0]).toEqual({ kind: "requeued" });
    // The reader of the withdrawn foreign write dropped with it — nothing
    // derived from withdrawn state commits (serving-loop.md §3d).
    expect(outcome.dispositions[1]).toEqual({ kind: "dropped" });
    const outLink = homeOut.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: outLink.id, scopeKey: "space" }),
    ).toBe(0);
  });

  it("stage F: a bookkeeping contribution rebases commuting patches and carries derivedThrough; a semantic conflict drops it whole (Q4's sanctioned internal stamp kind)", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const watermark = runtime.getCell<{ seq: number }>(
      space,
      "wave-watermark-doc",
      undefined,
    );
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "serving-loop/watermark",
      kind: "bookkeeping",
    });
    watermark.withTx(tx).set({ seq: 41 });
    expect((await tx.commit()).error).toBeUndefined();

    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink(), { derivedThrough: 41 });
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.dispositions).toEqual([{ kind: "committed" }]);
    const meta = engine.database.prepare(
      `SELECT class, derived_through FROM "commit" WHERE seq = :seq`,
    ).get({ seq: outcome.seq }) as { class: string; derived_through: number };
    expect(meta.class).toBe("derived");
    expect(meta.derived_through).toBe(41);

    // A raced bookkeeping write whose op does not commute DROPS whole —
    // no event exists to requeue; the loop re-derives its bookkeeping.
    const wave2 = newWave({ lease });
    runtime.installSealDestination(wave2);
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, {
      actionId: "serving-loop/watermark",
      kind: "bookkeeping",
    });
    watermark.withTx(tx2).set({ seq: 42 });
    expect((await tx2.commit()).error).toBeUndefined();
    const wmLink = watermark.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: wmLink.id,
          value: { value: { seq: 999 } },
        }],
      },
    });
    runtime.clearSealDestination();
    const outcome2 = await wave2.commitWave(newSink(), { derivedThrough: 42 });
    await wave2.settled();
    expect(outcome2.dispositions[0]).toEqual({ kind: "dropped" });
    expect(outcome2.requeuedEventIds).toEqual([]);
    // The forged/raced authored value stands (accepted threat model).
    const stored = Engine.readState(engine, { id: wmLink.id });
    expect(stored?.document).toEqual({ value: { seq: 999 } });
  });

  it("stage F+2: one wave batch holds TWO instances of ONE doc — the sink/engine fold at cardinality 2 (M1's write half)", async () => {
    const lease = liveLease();
    const aliceKey = resolveScopeKey("user", {
      principal: "did:key:fan-alice",
      sessionId: "alice-s1",
    });
    const bobKey = resolveScopeKey("user", {
      principal: "did:key:fan-bob",
      sessionId: "bob-s1",
    });
    const outcome = await newSink().commitWave({
      space,
      home: true,
      basisSeq: Engine.serverSeq(engine),
      rebasedHeads: [],
      operations: [
        {
          op: "set",
          id: "of:fanout-two-instances" as never,
          scope: "user",
          value: { value: { total: 1 } },
        },
        {
          op: "set",
          id: "of:fanout-two-instances" as never,
          scope: "user",
          value: { value: { total: 2 } },
        },
      ] as never,
      preconditions: [],
      annotations: [
        { op: 0, scopeKey: aliceKey },
        { op: 1, scopeKey: bobKey },
      ],
      consequenceOf: [],
      basisInstances: [],
      holder: lease.holder,
    });
    expect(outcome.error).toBeUndefined();
    const rows = engine.database.prepare(
      `SELECT scope_key FROM revision WHERE id = :id ORDER BY scope_key`,
    ).all({ id: "of:fanout-two-instances" }) as { scope_key: string }[];
    expect(rows.map((r) => r.scope_key)).toEqual(
      [aliceKey, bobKey].sort(),
    );
    lease.release();
  });

  it("stage F+2: two stamped runs with two demanded identities fold into one wave — per-run keys on writes and basis rows (M1 at cardinality 2)", async () => {
    const lease = liveLease();

    // A shared space-scoped doc BOTH runs read, so each run's basis
    // rows have real content to pin per (action, instance).
    const seed = runtime.getCell<{ value: number }>(
      space,
      "wave-m1-fanout-seed",
      undefined,
    );
    const seedTx = runtime.edit();
    seed.withTx(seedTx).set({ value: 5 });
    expect((await seedTx.commit()).error).toBeUndefined();

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    // Each demanded instance derives its OWN slot doc (the per-instance
    // result cells the byScope machinery keys — key-vocabulary §1 site
    // 3): the runs share NO local doc, which is what the landed depth
    // supports — the replica's per-instance READ keying (one doc, two
    // instances read locally) is the owed scheduler/replica follow-up,
    // and the same-doc ENGINE fold is pinned by the sink-level test
    // above.
    const identities = [
      { principal: "did:key:fan-alice", sessionId: "alice-s1" },
      { principal: "did:key:fan-bob", sessionId: "bob-s1" },
    ] as const;
    const cells = identities.map((_, index) =>
      runtime.getCell<{ value: number }>(
        space,
        `wave-m1-fanout-${index}`,
        undefined,
        undefined,
        "user",
      )
    );
    for (const [index, identity] of identities.entries()) {
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "derive-fanout",
        kind: "derivation",
        scopeKeyIdentity: identity,
        actionScopeKey: resolveScopeKey("user", identity),
      });
      const base = seed.withTx(tx).get();
      cells[index].withTx(tx).set({ value: (base?.value ?? 0) + index + 1 });
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `run ${index} seal failed: ${committed.error.message}`,
        );
      }
    }

    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.supersededWrites).toBe(0);

    // Each run's write keyed by ITS demanded instance — never the
    // wave-level identity's.
    for (const [index, identity] of identities.entries()) {
      const link = cells[index].getAsNormalizedFullLink();
      const rows = engine.database.prepare(
        `SELECT scope_key FROM revision WHERE id = :id`,
      ).all({ id: link.id }) as { scope_key: string }[];
      expect(rows.map((r) => r.scope_key)).toEqual([
        resolveScopeKey("user", identity),
      ]);
    }
    // ONE wave commit carried both runs; basis rows keyed per
    // (action, instance) — §3b's overwrite unit at cardinality 2. Each
    // instance's rows carry the run's REAL read of the shared seed.
    const seedId = seed.getAsNormalizedFullLink().id;
    for (const identity of identities) {
      const basis = selectSchedulerBasisRows(engine, {
        branch: "",
        action: "derive-fanout",
        actionScopeKey: resolveScopeKey("user", identity),
      });
      expect(basis.length).toBeGreaterThanOrEqual(1);
      expect(basis.some((row) => row.entity === seedId)).toBe(true);
    }
  });

  it("stage F: M1 — a run's per-run scopeKeyIdentity keys its scoped writes and basis rows (the demand-supplied instance)", async () => {
    const lease = liveLease();

    // Seed a doc the run READS, so its basis rows have content to pin.
    const seed = runtime.getCell<{ value: number }>(
      space,
      "wave-m1-seed",
      undefined,
    );
    const seedTx = runtime.edit();
    seed.withTx(seedTx).set({ value: 2 });
    expect((await seedTx.commit()).error).toBeUndefined();
    const seedSeq = Engine.serverSeq(engine);

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const scoped = runtime.getCell<{ value: number }>(
      space,
      "wave-m1-scoped",
      undefined,
      undefined,
      "user",
    );
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "derive-for-bob",
      kind: "derivation",
      // The demand supplied bob's instance identity (scopes.md §5): the
      // run reads and writes AS that instance, not as the wave-level
      // (service/session) identity.
      scopeKeyIdentity: { principal: "did:key:bob", sessionId: "bob-s1" },
      actionScopeKey: "user:did%3Akey%3Abob",
    });
    const base = seed.withTx(tx).get();
    scoped.withTx(tx).set({ value: (base?.value ?? 0) + 1 });
    expect((await tx.commit()).error).toBeUndefined();

    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();

    const link = scoped.getAsNormalizedFullLink();
    const rows = engine.database.prepare(
      `SELECT scope_key FROM revision WHERE id = :id`,
    ).all({ id: link.id }) as { scope_key: string }[];
    expect(rows.map((r) => r.scope_key)).toEqual(["user:did%3Akey%3Abob"]);
    // The basis rows land UNDER BOB'S instance key (never the wave-level
    // identity's), and carry the run's actual read.
    const basis = selectSchedulerBasisRows(engine, {
      branch: "",
      action: "derive-for-bob",
      actionScopeKey: "user:did%3Akey%3Abob",
    });
    const seedLink = seed.getAsNormalizedFullLink();
    const seedRow = basis.find((row) => row.entity === seedLink.id);
    expect(seedRow).toEqual({
      entitySpace: space,
      entity: seedLink.id,
      entityScopeKey: "space",
      seq: seedSeq,
    });
    // And NOT under the wave-level identity.
    const misKeyed = selectSchedulerBasisRows(engine, {
      branch: "",
      action: "derive-for-bob",
      actionScopeKey: "space",
    });
    expect(misKeyed).toEqual([]);
  });

  it("stage A: S4 clearance in BOTH directions — an action whose TRUE key changes across waves has its stranded rows cleared (user→space clears the stamped user key; space→user clears the broader `space` key), and a real row set in the same wave under a stranded key is never overwritten by a clearance (mutations: no clearance / no guard → red)", async () => {
    // The independent review's finding 3: the shipped S4 pins asserted
    // only that rows are not WRITTEN under a stranded key; none had a
    // previously-stranded row to CLEAR. Here the same action (one
    // actionId, one demand stamp `user:bob`) discovers a different scope
    // in successive waves, and each wave must clear the rows the previous
    // one left under the key that is now stranded.
    const lease = liveLease();
    // One sink for the whole test: the engine's replay guard keys on the
    // sink's (session, localSeq), so per-wave sinks would collide.
    const sink = newSink();
    const bobIdentity = { principal: "did:key:s4-bob", sessionId: "bob-s1" };
    const bobKey = resolveScopeKey("user", bobIdentity);
    const spaceDoc = runtime.getCell<{ value: number }>(
      space,
      "wave-s4-clear-space-input",
      undefined,
    );
    const userDoc = runtime.getCell<{ value: number }>(
      space,
      "wave-s4-clear-user-input",
      undefined,
      undefined,
      "user",
    );
    const output = runtime.getCell<{ value: number }>(
      space,
      "wave-s4-clear-output",
      undefined,
    );
    {
      const seedTx = runtime.edit();
      spaceDoc.withTx(seedTx).set({ value: 1 });
      expect((await seedTx.commit()).error).toBeUndefined();
    }
    const runOnce = async (
      actionId: string,
      reads: "space" | "user",
      valueOut: number,
    ) => {
      const wave = newWave({ lease });
      runtime.installSealDestination(wave);
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId,
        kind: "derivation",
        scopeKeyIdentity: bobIdentity,
        // Bob's demand stamps his USER instance in every wave.
        actionScopeKey: bobKey,
      });
      if (reads === "space") {
        spaceDoc.withTx(tx).get();
      } else {
        userDoc.withTx(tx).get(); // discovers `user` (Bob's instance)
      }
      // The write stays space-scoped so only the READS decide the
      // discovered scope (the tx ratchet is read-driven).
      output.withTx(tx).set({ value: valueOut });
      expect((await tx.commit()).error).toBeUndefined();
      runtime.clearSealDestination();
      const outcome = await wave.commitWave(sink);
      await wave.settled();
      expect(outcome.aborted).toBeUndefined();
    };
    const rowsUnder = (actionId: string, key: string) =>
      selectSchedulerBasisRows(engine, {
        branch: "",
        action: actionId,
        actionScopeKey: key,
      });

    // Direction 1 (user → space): wave 1 discovers Bob's user instance →
    // rows under `user:bob`; wave 2 reads only space → true key `space`,
    // and the stamped `user:bob` is now stranded → its rows are CLEARED.
    await runOnce("s4-clear-broaden", "user", 1);
    expect(rowsUnder("s4-clear-broaden", bobKey).length).toBeGreaterThan(0);
    await runOnce("s4-clear-broaden", "space", 2);
    expect(rowsUnder("s4-clear-broaden", "space").length).toBeGreaterThan(0);
    expect(rowsUnder("s4-clear-broaden", bobKey)).toEqual([]);

    // Direction 2 (space → user): wave 1 reads only space → rows under
    // `space`; wave 2 discovers Bob's user instance → true key `user:bob`,
    // and the broader `space` key on his chain is stranded → CLEARED.
    await runOnce("s4-clear-narrow", "space", 1);
    expect(rowsUnder("s4-clear-narrow", "space").length).toBeGreaterThan(0);
    await runOnce("s4-clear-narrow", "user", 2);
    expect(rowsUnder("s4-clear-narrow", bobKey).length).toBeGreaterThan(0);
    expect(rowsUnder("s4-clear-narrow", "space")).toEqual([]);

    // The guard: two contributions of ONE action in ONE wave — a
    // space-discovering run (real rows under `space`) sealed FIRST, then
    // Bob's user-discovering run whose stranded set names `space`. The
    // clearance must not overwrite the real row set already recorded in
    // this wave under that key.
    {
      const wave = newWave({ lease });
      runtime.installSealDestination(wave);
      const spaceRun = runtime.edit();
      stampWaveRunContext(spaceRun, {
        actionId: "s4-clear-guard",
        kind: "derivation",
        // The wave-level identity, no per-run stamp: true key `space`.
      });
      spaceDoc.withTx(spaceRun).get();
      output.withTx(spaceRun).set({ value: 10 });
      expect((await spaceRun.commit()).error).toBeUndefined();
      const bobRun = runtime.edit();
      stampWaveRunContext(bobRun, {
        actionId: "s4-clear-guard",
        kind: "derivation",
        scopeKeyIdentity: bobIdentity,
        actionScopeKey: bobKey,
      });
      userDoc.withTx(bobRun).get();
      const bobOut = runtime.getCell<{ value: number }>(
        space,
        "wave-s4-clear-guard-bob-output",
        undefined,
      );
      bobOut.withTx(bobRun).set({ value: 11 });
      expect((await bobRun.commit()).error).toBeUndefined();
      runtime.clearSealDestination();
      const outcome = await wave.commitWave(sink);
      await wave.settled();
      expect(outcome.aborted).toBeUndefined();
      expect(rowsUnder("s4-clear-guard", "space").length).toBeGreaterThan(0);
      expect(rowsUnder("s4-clear-guard", bobKey).length).toBeGreaterThan(0);
    }
  });

  it("stage F: M1 — the run context survives sample()/sink() transaction wrappers (r3739139477: the stamp is on the ORIGINAL tx; a wrapped scoped read must not fall back to the service identity)", async () => {
    const tx = runtime.edit();
    const context = {
      actionId: "wrapped-read",
      kind: "derivation" as const,
      scopeKeyIdentity: {
        principal: "did:key:wrap-alice",
        sessionId: "alice-s1",
      },
      actionScopeKey: resolveScopeKey("user", {
        principal: "did:key:wrap-alice",
        sessionId: "alice-s1",
      }),
    };
    stampWaveRunContext(tx, context);
    // The three wrapper shapes Cell.sample()/Cell.sink() and the
    // duplicate-work comparator mint. Pre-fix, waveRunContextOf keyed
    // strictly on object identity and returned undefined for all of
    // them — schema.ts's traversal context then resolved scoped reads
    // against runtime.scopeKeyIdentity (the SERVICE session on a
    // serving runtime): wrong scope instance, tracker keys recorded
    // under the service session.
    expect(waveRunContextOf(createNonReactiveTransaction(tx)))
      .toBe(context);
    expect(waveRunContextOf(createDuplicateWorkTransaction(tx)))
      .toBe(context);
    expect(waveRunContextOf(createChildCellTransaction(tx, runtime.edit())))
      .toBe(context);
    // Nested wrapping (sample() inside a sink() callback) unwraps too.
    expect(
      waveRunContextOf(
        createNonReactiveTransaction(createDuplicateWorkTransaction(tx)),
      ),
    ).toBe(context);
    // An UNSTAMPED tx stays undefined through a wrapper — the walk
    // must not invent a context.
    expect(waveRunContextOf(createNonReactiveTransaction(runtime.edit())))
      .toBeUndefined();
    await tx.abort();
  });

  it("stage F: a bookkeeping PATCH racing a DISJOINT authored patch REBASES and commits (the live rebase arm)", async () => {
    const lease = liveLease();

    // Materialize the doc first so later writes are patches.
    const doc = runtime.getCell<{ seq: number; other?: number }>(
      space,
      "wave-bookkeeping-rebase",
      undefined,
    );
    const seedTx = runtime.edit();
    doc.withTx(seedTx).set({ seq: 1, other: 0 });
    expect((await seedTx.commit()).error).toBeUndefined();

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "serving-loop/watermark",
      kind: "bookkeeping",
    });
    doc.withTx(tx).key("seq").set(9);
    expect((await tx.commit()).error).toBeUndefined();

    // A concurrent authored PATCH to a DISJOINT field: commutes, so the
    // bookkeeping advance rebases instead of dropping.
    const link = doc.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: link.id,
          patches: [{ op: "replace", path: "/value/other", value: 7 }],
        }],
      },
    });

    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.dispositions[0]).toEqual({ kind: "committed" });
    // Both survive: the concurrent field AND the rebased advance.
    const stored = Engine.readState(engine, { id: link.id });
    expect(stored?.document).toEqual({ value: { seq: 9, other: 7 } });
  });

  it("reinstantiates a piece once after an immediate stale-read refusal", async () => {
    const witness = await stoppedWitnessPiece(
      "wave-piece-instantiate-stale-read",
    );
    let pieceInstantiationSeals = 0;
    let readinessCalls = 0;
    const failures: unknown[] = [];
    runtime.pieceStartCommitFailureObserver = ({ error }) => {
      failures.push(error);
    };
    // The refusal names a REAL document, in the shape `toRejectedError`
    // hands the runner: the engine's message plus the conflict descriptor
    // parsed out of it. Readiness has two halves — the wire's `readyToRetry`
    // gate and the named document's pull — and a refusal carrying no
    // `conflict` silently exercises only the first.
    const conflicted = witness.cell.getAsNormalizedFullLink().id;
    const pulled: string[] = [];
    const provider = runtime.storageManager.open(space);
    const providerSync = provider.sync.bind(provider);
    (provider as { sync: typeof provider.sync }).sync = ((
      ...args: Parameters<typeof provider.sync>
    ) => {
      pulled.push(String(args[0]));
      return providerSync(...args);
    }) as typeof provider.sync;
    const staleRead = {
      name: "ConflictError" as const,
      message: `stale confirmed read: ${conflicted} at seq 0 ` +
        "conflicted with seq 1",
      conflict: { space, the: "application/json", of: conflicted },
      readyToRetry: () => {
        readinessCalls += 1;
        return Promise.resolve();
      },
    };
    runtime.installSealDestination({
      seal: (tx) => {
        if (
          !waveRunContextOf(tx)?.actionId.startsWith("piece-instantiate/")
        ) {
          return tx.tx.commit();
        }
        pieceInstantiationSeals += 1;
        if (pieceInstantiationSeals === 1) {
          return Promise.resolve({ error: staleRead as never });
        }
        return tx.tx.commit();
      },
    }, {
      runStamper: (tx, info) =>
        stampWaveRunContext(tx, {
          actionId: info.actionId,
          kind: info.kind,
        }),
    });

    expect(await runtime.start(witness.cell)).toBe(true);
    await runtime.idle();
    await runtime.runner.idlePieceInstantiationSettlements();

    expect(pieceInstantiationSeals).toBe(2);
    expect(readinessCalls).toBe(1);
    expect(
      pulled,
      "readiness must also pull the conflicted document, so the retry's " +
        "write carries its true version instead of re-asserting seq 0",
    ).toContain(conflicted);
    expect(
      failures,
      "a refusal the retry repaired is not a structure-load failure",
    ).toEqual([]);
    expect(witness.instantiations()).toBe(3);
    expect(witness.lastRunInstantiation()).toBe(3);
  });

  it("keeps a stale-read instantiation refusal terminal off the flag", async () => {
    const offManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const offRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: offManager,
      experimental: { serverExecution: false },
    });
    try {
      const witness = await stoppedWitnessPiece(
        "off-piece-instantiate-stale-read",
        { on: offRuntime },
      );

      // The instantiate transaction names ITSELF through `stampServerRun`,
      // which an OFF runtime still calls even though it records nothing.
      // That is the handle this test needs: an OFF runtime rejects the seal
      // destination the flag-ON tests refuse through, and a start mints
      // several transactions, so refusing merely the first would not say
      // which one was refused.
      const instantiateTxs = new WeakSet<object>();
      const originalStamp = offRuntime.stampServerRun.bind(offRuntime);
      (offRuntime as { stampServerRun: typeof offRuntime.stampServerRun })
        .stampServerRun = ((
          tx: Parameters<typeof offRuntime.stampServerRun>[0],
          info: Parameters<typeof offRuntime.stampServerRun>[1],
        ) => {
          if (info.actionId.startsWith("piece-instantiate/")) {
            instantiateTxs.add(tx);
          }
          return originalStamp(tx, info);
        }) as typeof offRuntime.stampServerRun;

      const conflicted = witness.cell.getAsNormalizedFullLink().id;
      const staleRead = {
        name: "ConflictError" as const,
        message: `stale confirmed read: ${conflicted} at seq 0 ` +
          "conflicted with seq 1",
        conflict: { space, the: "application/json", of: conflicted },
        readyToRetry: () => Promise.resolve(),
      };
      let refusals = 0;
      const originalEdit = offRuntime.edit.bind(offRuntime);
      (offRuntime as { edit: typeof offRuntime.edit }).edit = ((
        ...args: Parameters<typeof offRuntime.edit>
      ) => {
        const tx = originalEdit(...args);
        const commit = tx.commit.bind(tx);
        (tx as { commit: typeof tx.commit }).commit = (() => {
          if (!instantiateTxs.has(tx)) return commit();
          refusals += 1;
          tx.abort(staleRead.message);
          return Promise.resolve({ error: staleRead as never });
        }) as typeof tx.commit;
        return tx;
      }) as typeof offRuntime.edit;

      let readinessCalls = 0;
      const originalReadiness = offRuntime.awaitCommitRetryReadiness.bind(
        offRuntime,
      );
      offRuntime.awaitCommitRetryReadiness = ((
        ...args: Parameters<typeof offRuntime.awaitCommitRetryReadiness>
      ) => {
        readinessCalls += 1;
        return originalReadiness(...args);
      }) as typeof offRuntime.awaitCommitRetryReadiness;

      const started = await offRuntime.start(witness.cell);
      await offRuntime.idle();
      await offRuntime.runner.idlePieceInstantiationSettlements();

      // The refusal reached the instantiate commit itself, and off the flag
      // it stays terminal: no catch-up is awaited and no second attempt is
      // made. The repaired view a retry would read is the serving side's to
      // supply, and an OFF runtime has none, so the start reports the piece
      // as not running rather than recovering it. The same refusal under
      // the flag leaves `start` true and instantiates a third time.
      expect(refusals).toBe(1);
      expect(started).toBe(false);
      expect(readinessCalls).toBe(0);
      expect(witness.instantiations()).toBe(2);
    } finally {
      await offRuntime.dispose();
      await offManager.close();
    }
  });

  it("tears down after a second stale-read refusal instead of spinning", async () => {
    const witness = await stoppedWitnessPiece(
      "wave-piece-instantiate-stale-read-twice",
    );
    let pieceInstantiationSeals = 0;
    let readinessCalls = 0;
    const failures: unknown[] = [];
    runtime.pieceStartCommitFailureObserver = ({ error }) => {
      failures.push(error);
    };
    const conflicted = witness.cell.getAsNormalizedFullLink().id;
    const staleRead = {
      name: "ConflictError" as const,
      message: `stale confirmed read: ${conflicted} at seq 0 ` +
        "conflicted with seq 1",
      conflict: { space, the: "application/json", of: conflicted },
      readyToRetry: () => {
        readinessCalls += 1;
        return Promise.resolve();
      },
    };
    runtime.installSealDestination({
      seal: (tx) => {
        if (
          !waveRunContextOf(tx)?.actionId.startsWith("piece-instantiate/")
        ) {
          return tx.tx.commit();
        }
        pieceInstantiationSeals += 1;
        if (pieceInstantiationSeals <= 2) {
          return Promise.resolve({ error: staleRead as never });
        }
        return tx.tx.commit();
      },
    }, {
      runStamper: (tx, info) =>
        stampWaveRunContext(tx, {
          actionId: info.actionId,
          kind: info.kind,
        }),
    });

    expect(await runtime.start(witness.cell)).toBe(true);
    await runtime.idle();
    await runtime.runner.idlePieceInstantiationSettlements();

    // Exactly one retry. A basis the serving side does not repair is a
    // permanent refusal, so the second one retires the registration rather
    // than spinning on it.
    expect(pieceInstantiationSeals).toBe(2);
    expect(readinessCalls).toBe(1);
    expect(failures).toContain(staleRead);
    expect(witness.instantiations()).toBe(3);

    // Retired, not wedged: a later owner starts the piece afresh.
    runtime.clearSealDestination();
    expect(await runtime.start(witness.cell)).toBe(true);
    await runtime.idle();
    await runtime.runner.idlePieceInstantiationSettlements();
    expect(witness.instantiations()).toBe(4);
  });

  it("declines a stale-read refusal the stopped piece no longer owns", async () => {
    const witness = await stoppedWitnessPiece(
      "wave-piece-instantiate-stale-read-stopped",
    );
    let pieceInstantiationSeals = 0;
    let readinessCalls = 0;
    const refusalRequested = Promise.withResolvers<void>();
    const heldRefusal = Promise.withResolvers<{ error: unknown }>();
    const staleRead = {
      name: "ConflictError" as const,
      message: "stale confirmed read: of:piece-start at seq 0 " +
        "conflicted with seq 1",
      readyToRetry: () => {
        readinessCalls += 1;
        return Promise.resolve();
      },
    };
    runtime.installSealDestination({
      seal: (tx) => {
        if (
          !waveRunContextOf(tx)?.actionId.startsWith("piece-instantiate/")
        ) {
          return tx.tx.commit();
        }
        pieceInstantiationSeals += 1;
        if (pieceInstantiationSeals === 1) {
          refusalRequested.resolve();
          return heldRefusal.promise as never;
        }
        return tx.tx.commit();
      },
    }, {
      runStamper: (tx, info) =>
        stampWaveRunContext(tx, {
          actionId: info.actionId,
          kind: info.kind,
        }),
    });

    expect(await runtime.start(witness.cell)).toBe(true);
    await refusalRequested.promise;

    // The stop lands while the instantiate commit is still in flight, so the
    // refusal arrives against a registration this attempt no longer owns.
    // Recovery declines: the stop keeps the key, and no readiness gate is
    // entered on behalf of retired nodes.
    runtime.runner.stop(witness.cell);
    heldRefusal.resolve({ error: staleRead as never });
    await runtime.runner.idlePieceInstantiationSettlements();

    expect(pieceInstantiationSeals).toBe(1);
    expect(readinessCalls).toBe(0);
    expect(witness.instantiations()).toBe(2);
  });

  it("tears down after an immediate non-stale instantiation refusal", async () => {
    const witness = await stoppedWitnessPiece(
      "wave-piece-instantiate-terminal-refusal",
    );
    const refusal = {
      name: "TransactionError" as const,
      message: "piece instantiate destination refused",
    };
    const failures: unknown[] = [];
    let refusals = 0;
    runtime.pieceStartCommitFailureObserver = ({ error }) => {
      failures.push(error);
    };
    runtime.installSealDestination({
      seal: (tx) => {
        if (
          waveRunContextOf(tx)?.actionId.startsWith("piece-instantiate/") &&
          refusals === 0
        ) {
          refusals += 1;
          return Promise.resolve({ error: refusal as never });
        }
        return tx.tx.commit();
      },
    }, {
      runStamper: (tx, info) =>
        stampWaveRunContext(tx, {
          actionId: info.actionId,
          kind: info.kind,
        }),
    });

    expect(await runtime.start(witness.cell)).toBe(true);
    await runtime.runner.idlePieceInstantiationSettlements();
    expect(refusals).toBe(1);
    expect(failures).toContain(refusal);
    expect(witness.instantiations()).toBe(2);

    // A terminal refusal retires the exact outer registration, so a later
    // owner can start the piece afresh instead of finding a dead entry.
    runtime.clearSealDestination();
    expect(await runtime.start(witness.cell)).toBe(true);
    await runtime.idle();
    await runtime.runner.idlePieceInstantiationSettlements();
    expect(witness.instantiations()).toBe(3);
  });

  it("reinstantiates a piece once after its bookkeeping contribution is withdrawn, preserving the live registration and action", async () => {
    const witness = await stoppedWitnessPiece(
      "wave-piece-instantiate-recovery",
    );
    const { cell } = witness;
    const lease = liveLease();
    const firstWave = newWave({ lease });
    const recoveryWave = newWave({ lease });
    const route = routePieceInstantiationWaves(firstWave, recoveryWave);
    const failures: Array<{ actionId: string; error: unknown }> = [];
    runtime.pieceStartCommitFailureObserver = (failure) => {
      failures.push(failure);
    };

    expect(await runtime.start(cell)).toBe(true);
    await route.firstSeal;
    await runtime.idle();
    await route.idleSeals();
    route.useRecoveryWave();

    // Every document the first wave wrote appears to have advanced, and a
    // whole-document rival write overlaps it. Bookkeeping cannot commute with
    // that shape, so the accumulator deterministically drops the complete
    // piece-instantiate contribution instead of relying on event-loop timing.
    const inner = newSink();
    const conflictSink = wholeDocumentConflictSink(inner);
    const firstOutcome = await firstWave.commitWave(conflictSink);
    await firstWave.settled();
    expect(
      firstOutcome.dispositions.some((disposition) =>
        disposition.kind === "dropped"
      ),
    ).toBe(true);

    // Settlement, not seal acceptance, triggers one fresh instantiation into
    // the next wave. Let its newly registered actions quiesce before closing
    // that wave, matching the serving loop's seal barrier.
    await route.recoverySeal;
    await runtime.idle();
    runtime.clearSealDestination();
    const recoveryOutcome = await recoveryWave.commitWave(inner);
    await recoveryWave.settled();
    await runtime.runner.idlePieceInstantiationSettlements();
    expect(recoveryOutcome.aborted).toBeUndefined();
    expect(route.recoverySeals()).toBe(1);
    expect(
      failures.filter((failure) =>
        failure.actionId.startsWith("piece-instantiate/")
      ),
      "a withdrawal the retry repaired is not a structure-load failure",
    ).toEqual([]);

    // The retry kept the original outer registration alive, and the action
    // belonging to its third raw-module instantiation ran.
    expect(witness.instantiations()).toBe(3);
    expect(witness.lastRunInstantiation()).toBe(3);
    lease.release();
  });

  it("tears down after a second dropped piece-instantiation contribution instead of retrying again", async () => {
    const witness = await stoppedWitnessPiece(
      "wave-piece-instantiate-second-drop",
    );
    const lease = liveLease();
    const firstWave = newWave({ lease });
    const recoveryWave = newWave({ lease });
    const route = routePieceInstantiationWaves(firstWave, recoveryWave);
    const conflictSink = wholeDocumentConflictSink(newSink());

    expect(await runtime.start(witness.cell)).toBe(true);
    await route.firstSeal;
    await runtime.idle();
    await route.idleSeals();
    route.useRecoveryWave();
    await firstWave.commitWave(conflictSink);
    await firstWave.settled();
    await route.recoverySeal;
    await runtime.idle();
    await recoveryWave.commitWave(conflictSink);
    await recoveryWave.settled();
    await runtime.runner.idlePieceInstantiationSettlements();

    // Initial materialization + losing start + its one retry. A loop would
    // instantiate a fourth graph after the recovery wave withdrew it.
    expect(witness.instantiations()).toBe(3);

    runtime.clearSealDestination();
    expect(await runtime.start(witness.cell)).toBe(true);
    await runtime.idle();
    await runtime.runner.idlePieceInstantiationSettlements();
    expect(witness.instantiations()).toBe(4);
    lease.release();
  });

  it("surfaces a synchronous reinstantiation failure and tears down the registration", async () => {
    const witness = await stoppedWitnessPiece(
      "wave-piece-instantiate-retry-throws",
      { throwOnInstantiation: 3 },
    );
    const lease = liveLease();
    const firstWave = newWave({ lease });
    const recoveryWave = newWave({ lease });
    const route = routePieceInstantiationWaves(firstWave, recoveryWave);
    const failures: unknown[] = [];
    runtime.pieceStartCommitFailureObserver = ({ error }) => {
      failures.push(error);
    };

    expect(await runtime.start(witness.cell)).toBe(true);
    await route.firstSeal;
    await runtime.idle();
    await route.idleSeals();
    route.useRecoveryWave();
    await firstWave.commitWave(wholeDocumentConflictSink(newSink()));
    await firstWave.settled();
    await runtime.runner.idlePieceInstantiationSettlements();

    expect(witness.instantiations()).toBe(3);
    expect(
      failures.some((error) =>
        error instanceof Error && error.message ===
          "witness instantiation 3 failed"
      ),
    ).toBe(true);
    expect(route.recoverySeals()).toBe(0);

    // The failed retry retired the exact outer registration, so an ordinary
    // later start can instantiate it afresh instead of finding a dead entry.
    runtime.clearSealDestination();
    recoveryWave.abandon("test cleanup");
    expect(await runtime.start(witness.cell)).toBe(true);
    await runtime.idle();
    await runtime.runner.idlePieceInstantiationSettlements();
    expect(witness.instantiations()).toBe(4);
    lease.release();
  });

  it("surfaces a rejected piece-instantiation commit and tears down the registration", async () => {
    const witness = await stoppedWitnessPiece(
      "wave-piece-instantiate-commit-rejects",
    );
    const rejection = new Error("piece instantiate destination rejected");
    const failures: unknown[] = [];
    let rejections = 0;
    runtime.pieceStartCommitFailureObserver = ({ error }) => {
      failures.push(error);
    };
    runtime.installSealDestination({
      seal: (tx) => {
        if (
          waveRunContextOf(tx)?.actionId.startsWith("piece-instantiate/")
        ) {
          rejections += 1;
          return Promise.reject(rejection);
        }
        return tx.tx.commit();
      },
    }, {
      runStamper: (tx, info) =>
        stampWaveRunContext(tx, {
          actionId: info.actionId,
          kind: info.kind,
        }),
    });

    expect(await runtime.start(witness.cell)).toBe(true);
    await runtime.runner.idlePieceInstantiationSettlements();
    expect(rejections).toBe(1);
    expect(failures).toContain(rejection);

    // Promise rejection takes the same exact-registration teardown path as a
    // refused Result, so the next owner can start the piece normally.
    runtime.clearSealDestination();
    expect(await runtime.start(witness.cell)).toBe(true);
    await runtime.idle();
    await runtime.runner.idlePieceInstantiationSettlements();
    expect(witness.instantiations()).toBe(3);
  });

  it("aborts held retry readiness when the piece stops and does not revive it", async () => {
    const { cell } = await stoppedWitnessPiece(
      "wave-piece-instantiate-stop",
    );
    const lease = liveLease();
    const firstWave = newWave({ lease });
    const recoveryWave = newWave({ lease });
    const route = routePieceInstantiationWaves(firstWave, recoveryWave);
    const readinessEntered = Promise.withResolvers<void>();
    const heldReadiness = Promise.withResolvers<void>();
    // Park the recovery inside the readiness gate. The withdrawal error the
    // wave mints carries no `readyToRetry`, so one is threaded onto it here
    // and the real gate still races it against the teardown signal — which
    // is the behavior under test.
    const originalReadiness = runtime.awaitCommitRetryReadiness.bind(runtime);
    runtime.awaitCommitRetryReadiness = ((
      error: unknown,
      signal?: AbortSignal,
    ) => {
      (error as { readyToRetry?: () => Promise<void> }).readyToRetry = () => {
        readinessEntered.resolve();
        return heldReadiness.promise;
      };
      return originalReadiness(error, signal);
    }) as typeof runtime.awaitCommitRetryReadiness;

    expect(await runtime.start(cell)).toBe(true);
    await route.firstSeal;
    await runtime.idle();
    await route.idleSeals();
    route.useRecoveryWave();
    await firstWave.commitWave(wholeDocumentConflictSink(newSink()));
    await firstWave.settled();
    await readinessEntered.promise;

    // The settlement is parked inside readyToRetry(), not merely waiting for
    // its post-readiness exact-registration guard. Stopping must abort that
    // wait so fire-and-forget settlement can quiesce without releasing it.
    runtime.runner.stop(cell);
    await runtime.runner.idlePieceInstantiationSettlements();

    expect(route.recoverySeals()).toBe(0);
    runtime.clearSealDestination();
    recoveryWave.abandon("test cleanup");
    heldReadiness.resolve();
    lease.release();
  });

  it("does not retry an abandoned piece-instantiation wave in place", async () => {
    const witness = await stoppedWitnessPiece(
      "wave-piece-instantiate-abandon",
    );
    const lease = liveLease();
    const firstWave = newWave({ lease });
    const recoveryWave = newWave({ lease });
    const route = routePieceInstantiationWaves(firstWave, recoveryWave);
    const failures: unknown[] = [];
    runtime.pieceStartCommitFailureObserver = ({ error }) => {
      failures.push(error);
    };

    expect(await runtime.start(witness.cell)).toBe(true);
    await route.firstSeal;
    await runtime.idle();
    await route.idleSeals();
    route.useRecoveryWave();
    firstWave.abandon("whole-wave lifecycle recovery owns this case");
    await firstWave.settled();
    await runtime.runner.idlePieceInstantiationSettlements();

    expect(route.recoverySeals()).toBe(0);
    expect(witness.instantiations()).toBe(2);
    // Explicit wave abandonment is clean enclosing-lifecycle teardown: it
    // remains visible as a warning, but does not tick the failure observer.
    expect(failures).toEqual([]);

    // The non-retryable withdrawal removed the dead registration, so an
    // ordinary later start can rebuild it through its owning lifecycle.
    runtime.clearSealDestination();
    expect(await runtime.start(witness.cell)).toBe(true);
    await runtime.idle();
    await runtime.runner.idlePieceInstantiationSettlements();
    expect(witness.instantiations()).toBe(3);
    recoveryWave.abandon("test cleanup");
    lease.release();
  });
});

describe("stage F fix round: foreign-batch settle sequences and shallow reads", () => {
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let engine: Engine.Engine;

  beforeEach(async () => {
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    engine = await server.engineForSpace(space);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  it("waveSettlementOf: a sealed tx's settlement resolves ok on the wave commit and error on withdrawal (the durable-acceptance primitive the pattern swap gates on — thread r3731191444)", async () => {
    const holder = executionLeaseHolder(`service:${space}`);
    const cycle = new ExecutionLeaseCycle({ engine, space, holder });
    if (!cycle.acquire()) throw new Error("test lease acquire failed");

    // Committed arm.
    const wave1 = new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "settlement-session",
      },
      replicaFor: (s) => storageManager.open(s).replica,
      lease: cycle,
    });
    runtime.installSealDestination(wave1);
    const doc1 = runtime.getCell<{ n: number }>(
      space,
      "settlement-committed",
      undefined,
    );
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, {
      actionId: "settlement-probe/committed",
      kind: "bookkeeping",
    });
    doc1.withTx(tx1).set({ n: 1 });
    expect((await tx1.commit()).error).toBeUndefined();
    const settlement1 = waveSettlementOf(tx1);
    expect(settlement1).toBeDefined();
    runtime.clearSealDestination();
    const sink = new EngineWaveCommitSink({
      engineFor: () => engine,
      sessionId: holder,
    });
    const outcome1 = await wave1.commitWave(sink);
    await wave1.settled();
    expect(outcome1.dispositions).toEqual([{ kind: "committed" }]);
    expect((await settlement1!).error).toBeUndefined();

    // Withdrawn arm: an abandoned wave withdraws the sealed setup — the
    // settlement resolves with an error, and a swap gated on it keeps
    // the OLD graph.
    const wave2 = new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "settlement-session-2",
      },
      replicaFor: (s) => storageManager.open(s).replica,
      lease: cycle,
    });
    runtime.installSealDestination(wave2);
    const doc2 = runtime.getCell<{ n: number }>(
      space,
      "settlement-withdrawn",
      undefined,
    );
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, {
      actionId: "settlement-probe/withdrawn",
      kind: "bookkeeping",
    });
    doc2.withTx(tx2).set({ n: 2 });
    expect((await tx2.commit()).error).toBeUndefined();
    const settlement2 = waveSettlementOf(tx2);
    expect(settlement2).toBeDefined();
    runtime.clearSealDestination();
    wave2.abandon("test-induced abort");
    await wave2.settled();
    const settled2 = await settlement2!;
    expect(settled2.error).toBeDefined();
    expect(
      (settled2.error as { waveWithdrawalCause?: unknown })
        .waveWithdrawalCause,
    ).toBe("wave-abandoned");

    // A tx that never sealed into a wave has no settlement (the OFF
    // arm's discriminator).
    const tx3 = runtime.edit();
    const doc3 = runtime.getCell<{ n: number }>(
      space,
      "settlement-off-arm",
      undefined,
    );
    doc3.withTx(tx3).set({ n: 3 });
    expect((await tx3.commit()).error).toBeUndefined();
    expect(waveSettlementOf(tx3)).toBeUndefined();
  });

  it("resolves each foreign contribution with ITS OWN batch's accepted seq — two delegated identities provisioning one space never share a promotion seq (thread r3731191406)", async () => {
    const foreignSigner = await Identity.fromPassphrase(
      "wave foreign-seq space",
    );
    const foreign = foreignSigner.did() as MemorySpace;

    // Capture the verdict promise each seal hands the replica: the
    // promotion seq each sealed space contribution RESOLVES with is
    // exactly what feeds replica heads and later conflict decisions.
    const sealedVerdicts: Array<{
      space: MemorySpace;
      verdict: Promise<{ committed?: { seq: number } }>;
    }> = [];
    const wave = new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "wave-foreign-seq-session",
      },
      // §2b Phase-5 machinery under test (see newWave's posture note,
      // including the allow-all authority probe).
      foreignWrites: "accept",
      foreignWriteGrant: () => true,
      replicaFor: (s) => {
        const real = storageManager.open(s).replica;
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "sealNative") {
              const sealNative = Reflect.get(target, prop, receiver) as (
                ...args: unknown[]
              ) => unknown;
              if (typeof sealNative !== "function") return sealNative;
              return (...args: unknown[]) => {
                sealedVerdicts.push({
                  space: s,
                  verdict: args[2] as Promise<{ committed?: { seq: number } }>,
                });
                return sealNative.apply(target, args);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    runtime.installSealDestination(wave);

    const foreignDocA = runtime.getCell<{ value: number }>(
      foreign,
      "foreign-seq-a",
      undefined,
    );
    const foreignDocB = runtime.getCell<{ value: number }>(
      foreign,
      "foreign-seq-b",
      undefined,
    );
    const homeA = runtime.getCell<{ value: number }>(
      space,
      "foreign-seq-home-a",
      undefined,
    );
    const homeB = runtime.getCell<{ value: number }>(
      space,
      "foreign-seq-home-b",
      undefined,
    );

    // Two event-handler contributions provisioning the SAME foreign
    // space under DIFFERENT delegated identities: protocol.md §2b groups
    // them into two batches (one per acting identity), each accepted
    // with its own store seq.
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, {
      actionId: "provision-as-alice",
      kind: "event-handler",
      eventId: "e-alice",
      acting: { user: "did:key:alice", session: "sess-a" },
      capabilityRef: "cap:grant-alice",
    });
    tx1.enableMultiSpaceWrites?.([foreign, space]);
    foreignDocA.withTx(tx1).set({ value: 1 });
    homeA.withTx(tx1).set({ value: 1 });
    expect((await tx1.commit()).error).toBeUndefined();

    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, {
      actionId: "provision-as-bob",
      kind: "event-handler",
      eventId: "e-bob",
      acting: { user: "did:key:bob", session: "sess-b" },
      capabilityRef: "cap:grant-bob",
    });
    tx2.enableMultiSpaceWrites?.([foreign, space]);
    foreignDocB.withTx(tx2).set({ value: 2 });
    homeB.withTx(tx2).set({ value: 2 });
    expect((await tx2.commit()).error).toBeUndefined();

    runtime.clearSealDestination();

    // A stub sink accepting every batch with a DISTINCT seq, recording
    // which batch got which.
    let nextSeq = 100;
    const batchSeqs: Array<{
      space: MemorySpace;
      home: boolean;
      delegated?: { actingPrincipal: string };
      seq: number;
    }> = [];
    const sink: WaveCommitSink = {
      currentHeads: (_space, docs) =>
        Promise.resolve(
          new Map(docs.map((doc) => [
            `${doc.id} ${doc.scopeKey}`,
            0,
          ])),
        ),
      concurrentWritePaths: () => Promise.resolve([]),
      commitWave: (batch) => {
        nextSeq += 1;
        batchSeqs.push({
          space: batch.space,
          home: batch.home,
          ...(batch.delegated === undefined ? {} : {
            delegated: { actingPrincipal: batch.delegated.actingPrincipal },
          }),
          seq: nextSeq,
        });
        return Promise.resolve({ ok: { seq: nextSeq } });
      },
    };

    const outcome = await wave.commitWave(sink);
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.dispositions).toEqual([
      { kind: "committed" },
      { kind: "committed" },
    ]);

    // Two foreign batches (one per delegated identity) + one home batch,
    // each accepted at its own seq.
    const foreignBatches = batchSeqs.filter((batch) => !batch.home);
    expect(foreignBatches.length).toBe(2);
    const seqByActor = new Map(
      foreignBatches.map(
        (batch) => [batch.delegated?.actingPrincipal, batch.seq] as const,
      ),
    );

    // THE PIN: each contribution's foreign space resolves with the seq
    // of the batch ITS ops rode — alice's with alice's batch seq, bob's
    // with bob's — never the last-committed batch's seq for both.
    const foreignVerdicts = sealedVerdicts.filter(
      (entry) => entry.space === foreign,
    );
    expect(foreignVerdicts.length).toBe(2);
    const verdictA = await foreignVerdicts[0].verdict;
    const verdictB = await foreignVerdicts[1].verdict;
    expect(verdictA.committed?.seq).toBe(seqByActor.get("did:key:alice"));
    expect(verdictB.committed?.seq).toBe(seqByActor.get("did:key:bob"));
  });

  it("a NON-RECURSIVE read in a read-only space still folds the reader into the withdrawal (shallowReads ride the seal handoff — thread r3731191403)", async () => {
    const foreignSigner = await Identity.fromPassphrase(
      "wave shallow-read space",
    );
    const foreign = foreignSigner.did() as MemorySpace;
    const foreignEngine = await server.engineForSpace(foreign);
    const holder = executionLeaseHolder(`service:${space}`);
    const cycle = new ExecutionLeaseCycle({ engine, space, holder });
    if (!cycle.acquire()) throw new Error("test lease acquire failed");
    const engines = new Map<MemorySpace, Engine.Engine>([
      [space, engine],
      [foreign, foreignEngine],
    ]);
    const wave = new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "wave-shallow-session",
      },
      // §2b Phase-5 machinery under test (see newWave's posture note,
      // including the allow-all authority probe).
      foreignWrites: "accept",
      foreignWriteGrant: () => true,
      replicaFor: (s) => storageManager.open(s).replica,
      lease: cycle,
    });
    runtime.installSealDestination(wave);

    const foreignDoc = runtime.getCell<{ value: number }>(
      foreign,
      "wave-shallow-foreign-input",
      undefined,
    );
    const homeIn = runtime.getCell<{ value: number }>(
      space,
      "wave-shallow-home-in",
      undefined,
    );
    const homeOut = runtime.getCell<{ value: number }>(
      space,
      "wave-shallow-home-out",
      undefined,
    );

    // Contribution 0: an event handler WRITES the foreign doc and a home
    // doc (as in the recursive-read variant above).
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, {
      actionId: "shallow-write-foreign",
      kind: "event-handler",
      eventId: "e-shallow-fw",
      acting: { user: "did:key:alice", session: "sess-1" },
      capabilityRef: "cap:test-grant",
    });
    tx1.enableMultiSpaceWrites?.([foreign, space]);
    foreignDoc.withTx(tx1).set({ value: 5 });
    homeIn.withTx(tx1).set({ value: 5 });
    expect((await tx1.commit()).error).toBeUndefined();

    // Contribution 1: a derivation SHALLOW-reads the foreign doc — a
    // nonRecursive shape probe, exactly what the query proxies record
    // for container-shape reads — and writes home. The read set of a
    // read-only space must include these: a derived write based on a
    // withdrawn shallow read is as blind as one based on a deep read.
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, {
      actionId: "derive-from-shallow-foreign",
      kind: "derivation",
    });
    tx2.readValueOrThrow(foreignDoc.getAsNormalizedFullLink(), {
      nonRecursive: true,
    });
    homeOut.withTx(tx2).set({ value: 1 });
    expect((await tx2.commit()).error).toBeUndefined();

    // A rival authored commit moves homeIn's head past the basis, which
    // REQUEUES contribution 0 — its foreign write withdraws with it.
    const homeInLink = homeIn.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: homeInLink.id,
          value: { value: { value: 99 } },
        }],
      },
    });

    runtime.clearSealDestination();
    const sink = new EngineWaveCommitSink({
      engineFor: (s) => engines.get(s)!,
      sessionId: holder,
    });
    const outcome = await wave.commitWave(sink);
    await wave.settled();

    expect(outcome.requeuedEventIds).toEqual(["e-shallow-fw"]);
    expect(outcome.dispositions[0]).toEqual({ kind: "requeued" });
    // The SHALLOW reader of the withdrawn foreign write drops with it —
    // omitting shallowReads from the handoff would commit it blind.
    expect(outcome.dispositions[1]).toEqual({ kind: "dropped" });
    const outLink = homeOut.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: outLink.id, scopeKey: "space" }),
    ).toBe(0);
  });
});
