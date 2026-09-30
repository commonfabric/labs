// Server-execution v2 stage G: the outbox — both halves — and the
// stage-D sqlite bound's discharge (serving-loop.md §4–§6; FP1 RULED
// 2026-08-03). The executable spec model
// (packages/spec-model/server-execution) stays the oracle; these tests
// pin the same ruled semantics at the implementation layer:
//
// - effects hand to the outbox POST-commit, never at seal
//   (serving-loop.md §3): a destination that defers takes the sealed
//   tx's post-commit effects, and the inline flush is skipped; a
//   destination without the hook keeps today's inline flush;
// - the EFFECT half is process-local with in-flight dedupe per key
//   (§4/§5): a second admit of a live id attaches, counters count
//   (§7's memo/outbox blocks), and the run-context carriage captured
//   at seal is retrievable until the work settles;
// - the DURABLE half (FP1): outbound append rows land INSIDE the
//   wave's own engine transaction, only for SURVIVING contributions;
//   delivery admits at the target under the delegated row — `firedAt`
//   from the CARRIED actor, the envelope the service session (LT5) —
//   then deletes the row (admit-before-delete, so a crash between the
//   two re-sends and the target's eventId horizon dedupes: the model's
//   C2/FP1 closure — no schedule loses an append); an LT4
//   deterministic rejection deletes without retrying;
// - sqlite ops in HOME wave batches attach their cell-db through the
//   memory server's wave hook and apply atomically with the wave's
//   cell ops; a sink without the hook, a batch without per-op scope
//   keys, and a FOREIGN batch with sqlite ops are all refused loudly.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  insertExecutionOutboxRows,
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";
import { cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { streamEntriesDocId } from "@commonfabric/memory/v2";
import { table } from "@commonfabric/memory/sqlite/schema";
import { runQuery } from "@commonfabric/memory/sqlite/exec";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  restoreRuntimeEventDispatch,
  serializeRuntimeEvent,
} from "../src/cfc/event-reference-context.ts";
import { normalizeClause } from "../src/cfc/clause.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { getCfcReferenceProvenance } from "../src/cfc/reference-provenance.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
  TransactionSealDestination,
} from "../src/storage/interface.ts";
import type { PostCommitSideEffect } from "../src/cfc/types.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  type WaveSpaceCommit,
} from "../src/executor/wave.ts";
import { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import { SpaceOutbox } from "../src/executor/outbox.ts";
import { sqliteQueryMemoDecision } from "../src/builtins/sqlite-builtins.ts";
import { emptyServingLoopStats } from "../src/executor/stats.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("executor outbox test");
const space = signer.did() as MemorySpace;
const targetSigner = await Identity.fromPassphrase("executor outbox target");
const targetSpace = targetSigner.did() as MemorySpace;

describe("stage G outbox + sqlite discharge", () => {
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let engine: Engine.Engine;

  /** One process-lifetime counter per test, shared by every sink and
   * outbox (the replay-keying discipline — engine-wave-sink.ts). */
  let localSeqRef: { value: number };

  const holder = executionLeaseHolder(`service:${space}`);

  const newWave = (options: {
    lease?: ConstructorParameters<typeof WaveAccumulator>[0]["lease"];
  } = {}): WaveAccumulator =>
    new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "outbox-test-session",
      },
      replicaFor: (s) => storageManager.open(s).replica,
      // The Phase-5 posture, explicitly: the FP1 fold tests exercise
      // foreign-only-seal survivors (§2b machinery, dark until Phase
      // 5). The serving loop's real accumulators run the DEFAULT
      // ("refuse", RULED 2026-08-14 (c)) — pinned in
      // executor-serving-loop.test.ts and executor-wave.test.ts.
      foreignWrites: "accept",
      // Allow-all authority probe: these tests exercise the FP1 fold
      // mechanics; the gate's grant predicate is pinned in
      // executor-wave.test.ts and executor-cross-space.test.ts.
      foreignWriteGrant: () => true,
      ...(options.lease !== undefined ? { lease: options.lease } : {}),
    });

  const newSink = (
    options: {
      sqliteAttachmentsFor?: ConstructorParameters<
        typeof EngineWaveCommitSink
      >[0]["sqliteAttachmentsFor"];
    } = {},
  ): EngineWaveCommitSink =>
    new EngineWaveCommitSink({
      engineFor: () => engine,
      sessionId: holder,
      localSeqRef,
      ...(options.sqliteAttachmentsFor !== undefined
        ? { sqliteAttachmentsFor: options.sqliteAttachmentsFor }
        : {}),
    });

  const liveLease = (): ExecutionLeaseCycle => {
    const cycle = new ExecutionLeaseCycle({ engine, space, holder });
    if (!cycle.acquire()) throw new Error("test lease acquire failed");
    return cycle;
  };

  const newOutbox = (
    stats = emptyServingLoopStats(),
  ): {
    outbox: SpaceOutbox;
    stats: ReturnType<typeof emptyServingLoopStats>;
  } => ({
    outbox: new SpaceOutbox({
      stats,
      server,
      engine,
      space,
      sessionId: holder,
      localSeqRef,
    }),
    stats,
  });

  beforeEach(async () => {
    localSeqRef = { value: 0 };
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    engine = await server.engineForSpace(space);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  //
  // The effect handoff at the seal destination
  //

  it("defers a sealed tx's post-commit effects to the destination; without the hook the inline flush stays (serving-loop.md §3)", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    const deferred: PostCommitSideEffect[][] = [];
    // A destination that OWNS effects: wave sealing plus the stage-G
    // defer hook (the SpaceServer's shape, minus the loop).
    const deferringDestination: TransactionSealDestination = {
      seal: (tx: IExtendedStorageTransaction) => wave.seal(tx),
      deferSealedEffects: (
        _tx: IExtendedStorageTransaction,
        effects: readonly PostCommitSideEffect[],
      ) => {
        deferred.push([...effects]);
        return true;
      },
    };
    runtime.installSealDestination(deferringDestination);

    const doc = runtime.getCell<{ value: number }>(
      space,
      "outbox-defer",
      undefined,
    );
    let flushed = 0;
    const tx = runtime.edit();
    stampWaveRunContext(tx, { actionId: "derive-defer", kind: "derivation" });
    doc.withTx(tx).set({ value: 1 });
    tx.enqueuePostCommitEffect({
      id: "fetchTest:hash-1",
      kind: "fetchTest-start",
      flush: () => {
        flushed += 1;
      },
    });
    expect((await tx.commit()).error).toBeUndefined();

    // NOT flushed at seal: the destination took the effects (post-commit
    // handoff is the wave cycle's duty, not the seal's).
    expect(flushed).toBe(0);
    expect(deferred.length).toBe(1);
    expect(deferred[0].map((effect) => effect.id)).toEqual([
      "fetchTest:hash-1",
    ]);
    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.seq).toBeDefined();

    // Contrast: a destination WITHOUT the hook keeps today's inline
    // flush at seal — bare accumulators (stage-D tests) unchanged.
    const wave2 = newWave({ lease });
    runtime.installSealDestination(wave2);
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-inline", kind: "derivation" });
    doc.withTx(tx2).set({ value: 2 });
    tx2.enqueuePostCommitEffect({
      id: "fetchTest:hash-2",
      kind: "fetchTest-start",
      flush: () => {
        flushed += 1;
      },
    });
    expect((await tx2.commit()).error).toBeUndefined();
    expect(flushed).toBe(1);
    runtime.clearSealDestination();
    wave2.abandon("test over");
    lease.release();
  });

  //
  // The process-local effect half
  //

  it("admits sealed effects post-commit with in-flight dedupe per key; counters and carriage are live (serving-loop.md §4–§5, §7)", async () => {
    const { outbox, stats } = newOutbox();
    let ran = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effect = (id: string): PostCommitSideEffect => ({
      id,
      kind: "fetchTest-start",
      flush: () => {
        ran += 1;
        // The builtin shape: the flush starts work synchronously and
        // returns; the WORK is what completion tracks.
        outbox.observeAsyncWork(gate);
      },
    });
    const tx = {} as IExtendedStorageTransaction;
    const context = {
      actionId: "fetch-node",
      kind: "derivation" as const,
      acting: { user: "user:alice", session: "sess-1" },
    };
    outbox.admitSealedEffects([{
      tx,
      effects: [effect("fetchTest:key-A")],
      context,
    }]);
    // §4's in-flight dedupe: a second miss on the same key attaches —
    // the callback runs once.
    outbox.admitSealedEffects([{
      tx,
      effects: [effect("fetchTest:key-A")],
      context: undefined,
    }]);
    expect(ran).toBe(1);
    expect(stats.outbox.queued).toBe(1);
    expect(stats.memo.misses).toBe(1);
    expect(stats.memo.inflight).toBe(1);
    // The §4 identity carriage, captured at the original run's seal, is
    // live while the effect is — the completion committer's annotation
    // source.
    expect(outbox.carriageFor("fetchTest:key-A")?.acting?.user).toBe(
      "user:alice",
    );

    release!();
    await outbox.settle();
    expect(stats.outbox.completed).toBe(1);
    expect(stats.outbox.failed).toBe(0);
    expect(stats.memo.inflight).toBe(0);
    // Carriage retires with the work (a late straggler falls back to
    // the wave identity, which is the same identity in Phase 1).
    expect(outbox.carriageFor("fetchTest:key-A")).toBeUndefined();
  });

  it("holds an effect's in-flight entry until every completion is READABLE: a stale re-admit across the absorption window dedupes; retirement follows the barrier (serving-loop.md §4, the B-1 read-consistency gate)", async () => {
    // The captured double-fire this pins closed: a completion commits
    // engine-side and the effect's work settles, but the serving
    // replica has not APPLIED the completion yet (a parked accept
    // awaiting its catch-up marker). Retiring the key inside that
    // window let a later wave's stale-snapshot re-run re-admit it, and
    // the re-admitted claim — reading unabsorbed state — passed the
    // hash guard and egressed a second time. The retirement barrier
    // (deferRetirement ← the completion committer's whenApplied
    // promise) makes the re-admit DEDUPE until absorption.
    const { outbox, stats } = newOutbox();
    let ran = 0;
    const effect = (): PostCommitSideEffect => ({
      id: "fetchTest:key-b1",
      kind: "fetchTest-start",
      flush: () => {
        ran += 1;
      },
    });
    const tx = {} as IExtendedStorageTransaction;
    outbox.admitSealedEffects([{
      tx,
      effects: [effect()],
      context: undefined,
    }]);
    expect(ran).toBe(1);
    // The completion committer registers its read barrier while the key
    // is in flight (in production, from inside the effect's own tracked
    // work — always before the work settles).
    const barrier = Promise.withResolvers<void>();
    outbox.deferRetirement("fetchTest:key-b1", barrier.promise);

    // The work settles (the flush was synchronous) — but the entry MUST
    // remain in flight: absorption is held back.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stats.outbox.completed).toBe(1);
    expect(outbox.inflightCount).toBe(1);

    // The stale re-admit across the absorption window: DEDUPES — no
    // second flush, no second queue/miss count.
    outbox.admitSealedEffects([{
      tx,
      effects: [effect()],
      context: undefined,
    }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toBe(1);
    expect(stats.outbox.queued).toBe(1);
    expect(stats.memo.misses).toBe(1);

    // Absorption: the barrier resolves, the entry retires.
    barrier.resolve();
    await outbox.settle();
    expect(outbox.inflightCount).toBe(0);

    // A barrier registered for a key NOT in flight is a no-op (a
    // straggler completion of a retired key holds nothing)...
    const straggler = Promise.withResolvers<void>();
    outbox.deferRetirement("fetchTest:key-b1", straggler.promise);
    // ...so a post-absorption admit that still misses re-fires
    // legitimately and retires without waiting on it.
    outbox.admitSealedEffects([{
      tx,
      effects: [effect()],
      context: undefined,
    }]);
    expect(ran).toBe(2);
    await outbox.settle();
    expect(outbox.inflightCount).toBe(0);
    straggler.resolve();
  });

  it("counts infrastructure failures as outbox.failed (a flush throw); effect-level failures are error-shaped RESULTS, not failures (§4)", async () => {
    const { outbox, stats } = newOutbox();
    outbox.admitSealedEffects([{
      tx: {} as IExtendedStorageTransaction,
      effects: [{
        id: "fetchTest:throws",
        kind: "fetchTest-start",
        flush: () => {
          throw new Error("flush infrastructure broke");
        },
      }],
      context: undefined,
    }]);
    await outbox.settle();
    expect(stats.outbox.failed).toBe(1);
    expect(stats.outbox.completed).toBe(0);
  });

  //
  // The durable half (FP1): rows in the wave's own transaction
  //

  it("lands outbound append rows INSIDE the wave's engine transaction, for surviving contributions only (FP1; the model's committed-only fold)", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const x = runtime.getCell<{ value: number }>(space, "append-x", undefined);
    const z = runtime.getCell<{ value: number }>(space, "append-z", undefined);

    // Contribution 1: writes x and stages an append. Its x write will be
    // SUPERSEDED per-doc — and per §3d (RULED 2026-08-05) the drop
    // re-arms nothing, so nothing would ever re-run this producer to
    // re-emit: like its basis rows ("its reads are true"), its append
    // MUST still ride the wave.
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-x", kind: "derivation" });
    x.withTx(tx1).set({ value: 10 });
    wave.enqueueOutboundAppend(tx1, {
      targetSpace,
      targetStream: "of:target-stream",
      eventId: "evt-1",
      payload: { note: "from contribution 1" },
      actingPrincipal: "user:alice",
      actingSession: "sess-1",
      capabilityRef: "cap-1",
    });
    expect((await tx1.commit()).error).toBeUndefined();

    // Contribution 2: READS contribution 1's withdrawn x write — it is
    // withdrawn WHOLE (nothing derived from withdrawn state commits),
    // and its own reads re-run it when fresh state lands. Its append
    // must NOT become a durable row: the re-run re-emits it (the
    // model's committed-only cascadesCross fold).
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-z", kind: "derivation" });
    const seen = x.withTx(tx2).get();
    z.withTx(tx2).set({ value: seen!.value + 1 });
    wave.enqueueOutboundAppend(tx2, {
      targetSpace,
      targetStream: "of:target-stream",
      eventId: "evt-lost",
      payload: {},
      actingPrincipal: "user:bob",
      capabilityRef: "cap-2",
    });
    expect((await tx2.commit()).error).toBeUndefined();

    // A concurrent authored commit moves x's head past the wave basis.
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
    expect(wave.hasOutboundAppends).toBe(true);
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    // Contribution 1: per-doc superseded (its only doc — disposition
    // "dropped" via the all-dropped path) yet still a structural
    // survivor: basis rows and appends ride. Contribution 2:
    // dependency-dropped whole — excluded.
    expect(outcome.supersededWrites).toBe(1);
    expect(outcome.dependencyDroppedWrites).toBe(1);
    // The batch had no surviving ops but DID carry appends: the
    // appends-only wave commit is not short-circuited (FP1 — the rows
    // land inside a real wave transaction).
    expect(outcome.seq).toBeDefined();

    const rows = selectPendingExecutionOutboxRows(engine, { branch: "" });
    expect(rows.length).toBe(1);
    expect(rows[0].eventId).toBe("evt-1");
    expect(rows[0].targetSpace).toBe(targetSpace);
    expect(rows[0].actingPrincipal).toBe("user:alice");
    expect(rows[0].actingSession).toBe("sess-1");
    expect(rows[0].capabilityRef).toBe("cap-1");
    expect(rows[0].createdSeq).toBe(outcome.seq);
    lease.release();
  });

  //
  // Delivery (FP1 closure): admit at the target, then delete
  //

  it("retains nested reference history through a durable cross-space outbox row", async () => {
    const secret = normalizeClause({
      anyOf: ["outbox-selection", cfcAtom.space(space)],
    });
    const write = runtime.edit();
    write.setCfcFlowLabelsMode("persist");
    const target = runtime.getCell(
      space,
      "reference-outbox-target",
      undefined,
      write,
    );
    target.set("public target");
    const selector = runtime.getCell(space, "reference-outbox-selector", {
      type: "string",
      ifc: { confidentiality: [secret] },
    }, write);
    selector.set("private selection");
    expect((await write.commit()).error).toBeUndefined();
    const send = runtime.edit();
    send.setCfcFlowLabelsMode("persist");
    selector.withTx(send).get();
    const box = runtime.getImmutableCell(
      space,
      { item: target.withTx(send).asSchema({ scope: "space" }) },
      undefined,
      send,
    );
    const dispatchTarget = runtime.getCell(
      targetSpace,
      "reference-outbox-stream",
      undefined,
      send,
    ).getAsNormalizedFullLink();
    const event = serializeRuntimeEvent(
      { box },
      send,
      targetSpace,
      dispatchTarget,
    );
    send.abort();
    const stream = { id: dispatchTarget.id, path: dispatchTarget.path };
    const sidecar = streamEntriesDocId(stream);
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [{
        targetSpace,
        targetStream: sidecar,
        targetStreamLink: stream,
        eventId: "evt-reference-outbox",
        payload: event.payload,
        runtimeReferenceContext: event.runtimeReferenceContext,
        actingPrincipal: "user:alice",
        actingSession: "sess-reference",
        capabilityRef: "cap-reference",
      }],
    });
    expect(
      selectPendingExecutionOutboxRows(engine, { branch: "" })[0]
        .runtimeReferenceContext,
    )
      .toBe(event.runtimeReferenceContext);
    const { outbox, stats } = newOutbox();
    await outbox.deliverPendingAppends();
    expect(stats.outbox.failed).toBe(0);
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }))
      .toHaveLength(0);
    const destination = await server.engineForSpace(targetSpace);
    const entries = (Engine.read(destination, { id: sidecar })?.value as {
      entries: {
        payload: FabricValue;
        runtimeReferenceContext?: string;
        firedAt: unknown;
      }[];
    }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].runtimeReferenceContext).toBe(
      event.runtimeReferenceContext,
    );
    expect(entries[0].firedAt).toEqual({
      user: "user:alice",
      session: "sess-reference",
    });
    const read = runtime.edit();
    read.setCfcFlowLabelsMode("persist");
    const restored = restoreRuntimeEventDispatch(
      entries[0].payload,
      entries[0].runtimeReferenceContext,
      { ...dispatchTarget },
    );
    expect(getCfcReferenceProvenance(restored.target)?.confidentiality)
      .toContainEqual(secret);
    expect(
      runtime.getImmutableCell(space, restored.payload, undefined, read).key(
        "box",
        "item",
      ).get(),
    )
      .toBe("public target");
    expect(deriveFlowJoin(read).confidentiality).toContainEqual(secret);
    read.abort();
  });

  it("delivers pending rows: delegated admission at the target stamps firedAt from the CARRIED actor (LT5 envelope), then deletes the row; a re-sent duplicate dedupes at the eventId horizon", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    const x = runtime.getCell<{ value: number }>(space, "deliver-x", undefined);
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-x", kind: "derivation" });
    x.withTx(tx1).set({ value: 1 });
    const deliverStream = { id: "of:deliver-stream", path: [] as string[] };
    const deliverSidecar = streamEntriesDocId(deliverStream);
    wave.enqueueOutboundAppend(tx1, {
      targetSpace,
      targetStream: deliverSidecar,
      targetStreamLink: deliverStream,
      eventId: "evt-d1",
      payload: { n: 7 },
      actingPrincipal: "user:alice",
      actingSession: "sess-1",
      capabilityRef: "cap-d",
    });
    expect((await tx1.commit()).error).toBeUndefined();
    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.seq).toBeDefined();

    const { outbox, stats } = newOutbox();
    await outbox.deliverPendingAppends();

    // Delivered: the target stream doc holds the entry, firedAt from
    // the CARRIED actor — never the delivering envelope (protocol.md
    // §2's delegated stamping; the silent-empty-instance trap stays
    // closed) — and the delivery commit's envelope session is the
    // service holder (LT5), class authored.
    const targetEngine = await server.engineForSpace(targetSpace);
    const doc = Engine.read(targetEngine, { id: deliverSidecar });
    const entries =
      (doc?.value as { entries?: Array<Record<string, unknown>> })?.entries ??
        [];
    expect(entries.length).toBe(1);
    expect(entries[0].eventId).toBe("evt-d1");
    expect(entries[0].payload).toEqual({ n: 7 });
    expect(entries[0].firedAt).toEqual({
      user: "user:alice",
      session: "sess-1",
    });
    const commitRow = targetEngine.database.prepare(
      `SELECT class, session_id, acting_principal, capability_ref
       FROM "commit" ORDER BY seq DESC LIMIT 1`,
    ).get() as {
      class: string;
      session_id: string;
      acting_principal: string;
      capability_ref: string;
    };
    expect(commitRow.class).toBe("authored");
    expect(commitRow.session_id).toContain(`service:${space}`);
    expect(commitRow.acting_principal).toBe("user:alice");
    expect(commitRow.capability_ref).toBe("cap-d");

    // Delivery-ack: the row is gone (a queue that empties).
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);

    // The crash window between admit and delete: simulate by
    // re-inserting the SAME row (as a re-send would find it) and
    // delivering again — the duplicate dedupes at the target's eventId
    // horizon (no second entry) and the row still retires.
    const lease2 = liveLease();
    const wave2 = newWave({ lease: lease2 });
    runtime.installSealDestination(wave2);
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-x2", kind: "derivation" });
    x.withTx(tx2).set({ value: 2 });
    wave2.enqueueOutboundAppend(tx2, {
      targetSpace,
      targetStream: deliverSidecar,
      targetStreamLink: deliverStream,
      eventId: "evt-d1",
      payload: { n: 7 },
      actingPrincipal: "user:alice",
      actingSession: "sess-1",
      capabilityRef: "cap-d",
    });
    expect((await tx2.commit()).error).toBeUndefined();
    runtime.clearSealDestination();
    expect((await wave2.commitWave(newSink())).seq).toBeDefined();
    await wave2.settled();
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(1);
    // A fresh outbox instance (the recovering process — §6 step 5's
    // re-send): the durable row survived, the effect half did not need
    // to.
    const { outbox: recovered, stats: recoveredStats } = newOutbox();
    await recovered.deliverPendingAppends();
    const after = Engine.read(targetEngine, { id: deliverSidecar });
    const afterEntries =
      (after?.value as { entries?: Array<unknown> })?.entries ?? [];
    expect(afterEntries.length).toBe(1);
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    // Both deliveries clean: the first outbox's AND — the assertion
    // that actually guards the re-send this leg is about (round-2
    // thread 11; the old check read the FIRST outbox's counter, which
    // the re-send never touches) — the RECOVERED outbox's.
    expect(stats.outbox.failed).toBe(0);
    expect(recoveredStats.outbox.failed).toBe(0);
    lease.release();
    lease2.release();
  });

  //
  // The fold's completeness, and the gate at the source
  //
  // What the durable half must still carry — a foreign-only survivor's
  // appends, and a tx that sealed nothing but staged some — and the refusal
  // that happens at enqueue rather than at delivery.
  //

  it("folds a FOREIGN-only-seal survivor's appends into the home batch's outbox rows (FP1 fold completeness; the stage-G review's M-A)", async () => {
    // A contribution whose only sealed space is FOREIGN (the Phase-5
    // provisioning shape): its cross-space appends are consequences of
    // a SURVIVING contribution and must land as durable rows in the
    // HOME wave transaction — the pre-fix fold sat under the home-seal
    // guard and lost them silently.
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const foreignCell = runtime.getCell<{ value: number }>(
      targetSpace,
      "foreign-only-x",
      undefined,
    );
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, {
      actionId: "handle-foreign-only",
      kind: "event-handler",
      eventId: "evt-foreign-only",
      // The §2b provisioning carriage (Phase 5's accept gate): a
      // foreign write is admitted only under acting + grant.
      acting: { user: "user:alice", session: "sess-1" },
      capabilityRef: "cap-fo",
    });
    foreignCell.withTx(tx1).set({ value: 5 });
    wave.enqueueOutboundAppend(tx1, {
      targetSpace,
      targetStream: "of:foreign-only-stream",
      eventId: "evt-fo-1",
      payload: { via: "foreign-only survivor" },
      actingPrincipal: "user:alice",
      actingSession: "sess-1",
      capabilityRef: "cap-fo",
    });
    expect((await tx1.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const targetEngine = await server.engineForSpace(targetSpace);
    // OW31 B4: a foreign data batch never lands in a fresh store ahead
    // of its genesis ACL (the sink's INV-13 mirror) — land the genesis
    // the production flow's commit-step forcing provides.
    Engine.applyCommit(targetEngine, {
      sessionId: "test-genesis-session",
      space: targetSpace,
      principal: targetSpace,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${targetSpace}`,
          value: { value: { "user:alice": "OWNER", "*": "WRITE" } },
        }],
      },
    });
    const sink = new EngineWaveCommitSink({
      engineFor: (s) => (s === space ? engine : targetEngine),
      sessionId: holder,
      localSeqRef,
    });
    const outcome = await wave.commitWave(sink);
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    // The home commit exists — carried appends force it even with zero
    // home ops — and the rows live in the HOME engine (the source-side
    // durable queue), with the event covered by consequenceOf.
    expect(outcome.seq).toBeDefined();
    expect(outcome.committedEventIds).toEqual(["evt-foreign-only"]);
    const rows = selectPendingExecutionOutboxRows(engine, { branch: "" });
    expect(rows.length).toBe(1);
    expect(rows[0].eventId).toBe("evt-fo-1");
    expect(rows[0].createdSeq).toBe(outcome.seq);
    // The foreign write itself landed at the target.
    expect(
      Engine.read(targetEngine, {
        id: foreignCell.getAsNormalizedFullLink().id,
      }),
    ).toEqual({ value: { value: 5 } });
    lease.release();
  });

  it("mints a zero-write contribution for a tx that sealed NOTHING but staged appends — the Phase-3 pure-forwarding handler; its appends land (M-A)", async () => {
    // The model explicitly permits committed contributions with
    // `writes: []` carrying cross-space appends (its cascadesCross and
    // consequenceOf folds run for every committed contribution). The
    // pre-fix seal() dropped the tx at the empty-assembly fast path and
    // orphaned its staged appends silently.
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, {
      actionId: "handle-pure-forward",
      kind: "event-handler",
      eventId: "evt-forwarding",
    });
    // No writes at all: the handler's only consequence is the emit.
    wave.enqueueOutboundAppend(tx1, {
      targetSpace,
      targetStream: "of:zero-seal-stream",
      eventId: "evt-zs-1",
      payload: { via: "zero-seal emitter" },
      actingPrincipal: "user:bob",
      actingSession: "sess-2",
      capabilityRef: "cap-zs",
    });
    expect((await tx1.commit()).error).toBeUndefined();
    expect(wave.contributionCount).toBe(1);
    expect(wave.hasOutboundAppends).toBe(true);
    runtime.clearSealDestination();

    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.seq).toBeDefined();
    expect(outcome.dispositions).toEqual([{ kind: "committed" }]);
    expect(outcome.committedEventIds).toEqual(["evt-forwarding"]);
    const rows = selectPendingExecutionOutboxRows(engine, { branch: "" });
    expect(rows.length).toBe(1);
    expect(rows[0].eventId).toBe("evt-zs-1");
    expect(rows[0].targetStream).toBe("of:zero-seal-stream");
    expect(rows[0].actingPrincipal).toBe("user:bob");
    expect(rows[0].createdSeq).toBe(outcome.seq);
    lease.release();
  });

  it("refuses a userless (or grantless) append at the SOURCE — fail-closed ahead of the delegated floor that would destroy it at delivery", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    const x = runtime.getCell<{ value: number }>(space, "guard-x", undefined);
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-x", kind: "derivation" });
    x.withTx(tx1).set({ value: 1 });
    // The OW15 floor carve-out at the SOURCE (SHAPE RULED 2026-08-05;
    // implemented with Phase 3): a userless emission stages IFF it is
    // DECLARED sessionless-space-scope; the floor negatives hold both
    // ways, the declaration alongside an actor is a contradiction, and
    // the grant stays mandatory throughout.
    expect(() =>
      wave.enqueueOutboundAppend(tx1, {
        targetSpace,
        targetStream: "of:stream-events:guard",
        eventId: "evt-guard",
        payload: {},
        capabilityRef: "cap-x",
      })
    ).toThrow("sessionless-space-scope");
    expect(() =>
      wave.enqueueOutboundAppend(tx1, {
        targetSpace,
        targetStream: "of:stream-events:guard",
        eventId: "evt-guard-2",
        payload: {},
        actingPrincipal: "user:alice",
        capabilityRef: "",
      })
    ).toThrow("capability grant");
    expect(() =>
      wave.enqueueOutboundAppend(tx1, {
        targetSpace,
        targetStream: "of:stream-events:guard",
        eventId: "evt-guard-3",
        payload: {},
        actingPrincipal: "user:alice",
        sessionlessSpaceScope: true,
        capabilityRef: "cap-x",
      })
    ).toThrow("contradiction");
    // The POSITIVE: a DECLARED userless emission stages.
    wave.enqueueOutboundAppend(tx1, {
      targetSpace,
      targetStream: "of:stream-events:guard",
      eventId: "evt-guard-declared",
      payload: {},
      sessionlessSpaceScope: true,
      capabilityRef: "cap-x",
    });
    expect((await tx1.commit()).error).toBeUndefined();
    runtime.clearSealDestination();
    wave.abandon("test over");
    lease.release();
  });

  //
  // Refusals and failures at delivery
  //
  // What the drain does at the floor: a declared userless row delivers, an
  // undeclared one retires, a deterministic rejection retires — one of them
  // after writing its failure notice back onto the source event — and a
  // transport failure keeps the row for the next drain.
  //

  it("does not retry an LT4 deterministic admission rejection: the row is deleted and counted failed", async () => {
    // The accumulator refuses userless entries at the source (above),
    // so a floor-tripping row can only exist as a directly-inserted
    // one — a Phase-3-era or corrupted row. Delivery must retire it
    // (LT4: deterministic rejections are not retried), never loop on
    // it.
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [{
        targetSpace,
        targetStream: "of:lt4-stream",
        eventId: "evt-lt4",
        payload: {},
        capabilityRef: "cap-x",
      }],
    });

    const { outbox, stats } = newOutbox();
    await outbox.deliverPendingAppends();
    // LT4: not retried — the row is retired, the failure counted; the
    // source-side failure notice is Phase 3's events.md §5 machinery.
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    expect(stats.outbox.failed).toBe(1);
    const targetEngine = await server.engineForSpace(targetSpace);
    expect(Engine.read(targetEngine, { id: "of:lt4-stream" })).toBeNull();
  });

  it("refuses a LINK-LESS legacy row deterministically — the delivery never fabricates a stream link for it (events.md §1's one derivation; T18)", async () => {
    // A stage-G-era row: a real sidecar id but NO targetStreamLink. A
    // fabricated path-less link would hash to a DIFFERENT sidecar, so
    // the target's drain would route the event to a stream nothing
    // fired at. Refused (LT4 arm), retired, nothing written.
    const legacyStream = { id: "of:legacy-stream", path: [] as string[] };
    const legacySidecar = streamEntriesDocId(legacyStream);
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [{
        targetSpace,
        targetStream: legacySidecar,
        eventId: "evt-legacy",
        payload: {},
        actingPrincipal: "user:alice",
        actingSession: "sess-1",
        capabilityRef: "cap-legacy",
      }],
    });
    const { outbox, stats } = newOutbox();
    await outbox.deliverPendingAppends();
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    expect(stats.outbox.failed).toBe(1);
    const targetEngine = await server.engineForSpace(targetSpace);
    expect(Engine.read(targetEngine, { id: legacySidecar })).toBeNull();
  });

  it("OW15: a DECLARED userless row delivers — the target stamps firedAt = { session: 'server' } with NO user; undeclared userless stays refused (the floor negatives)", async () => {
    const ow15Stream = { id: "of:ow15-stream", path: ["events"] };
    const ow15Sidecar = streamEntriesDocId(ow15Stream);
    const ow15UndeclaredStream = {
      id: "of:ow15-undeclared",
      path: [] as string[],
    };
    const ow15UndeclaredSidecar = streamEntriesDocId(ow15UndeclaredStream);
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [{
        targetSpace,
        targetStream: ow15Sidecar,
        targetStreamLink: ow15Stream,
        eventId: "evt-ow15",
        payload: { n: 1 },
        sessionlessSpaceScope: true,
        capabilityRef: "cap-ow15",
      }, {
        // The floor negative at delivery: userless WITHOUT the
        // declaration is refused deterministically (LT4 retires it).
        // The link is VALID so the refusal pinned here stays the
        // FLOOR's, not the link binding's.
        targetSpace,
        targetStream: ow15UndeclaredSidecar,
        targetStreamLink: ow15UndeclaredStream,
        eventId: "evt-ow15-undeclared",
        payload: { n: 2 },
        capabilityRef: "cap-ow15",
      }],
    });
    const { outbox, stats } = newOutbox();
    await outbox.deliverPendingAppends();
    const targetEngine = await server.engineForSpace(targetSpace);
    const doc = Engine.read(targetEngine, { id: ow15Sidecar });
    const entries =
      (doc?.value as { entries?: Array<Record<string, unknown>> })?.entries ??
        [];
    expect(entries.length).toBe(1);
    expect(entries[0].firedAt).toEqual({ session: "server" });
    expect(typeof entries[0].seq).toBe("number");
    const commitRow = targetEngine.database.prepare(
      `SELECT acting_principal, acting_session FROM "commit"
       ORDER BY seq DESC LIMIT 1`,
    ).get() as {
      acting_principal: string | null;
      acting_session: string | null;
    };
    expect(commitRow.acting_principal).toBeNull();
    expect(commitRow.acting_session).toBeNull();
    // The undeclared row was refused (LT4) and retired.
    expect(
      Engine.read(targetEngine, { id: ow15UndeclaredSidecar }),
    ).toBeNull();
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    expect(stats.outbox.failed).toBe(1);
  });

  it("OW14: a deterministic refusal writes the failure notice onto the SOURCE event's entry BEFORE the row retires; a re-refusal dedupes the notice", async () => {
    // The source event's entry, as the source SpaceServer would hold it
    // (a consequenced client fire whose handler emitted the append).
    // Derived commits — the setup AND the outbox's notice write — need
    // the live lease (protocol.md §2's one equality check).
    const lease = liveLease();
    const sourceStream = { id: "of:ow14-stream", path: ["s"] };
    const sourceSidecar = streamEntriesDocId(sourceStream);
    const ow14TargetStream = { id: "of:ow14-target", path: [] as string[] };
    const ow14TargetSidecar = streamEntriesDocId(ow14TargetStream);
    const holder2 = holder;
    Engine.applyCommit(engine, {
      sessionId: holder2,
      space,
      commitClass: "derived",
      holder: holder2,
      commit: {
        localSeq: 990_001,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: sourceSidecar as never,
          value: {
            value: {
              entries: [{
                eventId: "evt-source",
                stream: sourceStream,
                firedAt: { user: "user:alice", session: "sess-1" },
                consequenced: true,
              }],
            },
          } as never,
        }],
        eventAppends: [{ id: sourceSidecar, eventId: "evt-source" }],
      },
    });
    // The refused append: userless and UNDECLARED — the target refuses
    // deterministically — carrying the source-event reference.
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 2,
      rows: [{
        targetSpace,
        targetStream: ow14TargetSidecar,
        targetStreamLink: ow14TargetStream,
        eventId: "evt-refused",
        payload: {},
        capabilityRef: "cap-ow14",
        sourceEvent: { sidecarId: sourceSidecar, eventId: "evt-source" },
      }],
    });
    const { outbox, stats } = newOutbox();
    await outbox.deliverPendingAppends();
    // The notice landed on the source entry, and the row retired.
    const read = () =>
      ((Engine.read(engine, { id: sourceSidecar })?.value ?? {}) as {
        entries?: Array<{
          deliveryFailures?: Array<
            { eventId: string; targetSpace: string; reason: string }
          >;
        }>;
      }).entries?.[0].deliveryFailures ?? [];
    expect(read().length).toBe(1);
    expect(read()[0].eventId).toBe("evt-refused");
    expect(read()[0].targetSpace).toBe(targetSpace);
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    expect(stats.outbox.failed).toBe(1);

    // The crash window (write-then-delete): the SAME row re-sent —
    // re-refused, RE-NOTICED deduped (never a second notice), retired.
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 3,
      rows: [{
        targetSpace,
        targetStream: ow14TargetSidecar,
        targetStreamLink: ow14TargetStream,
        eventId: "evt-refused",
        payload: {},
        capabilityRef: "cap-ow14",
        sourceEvent: { sidecarId: sourceSidecar, eventId: "evt-source" },
      }],
    });
    const { outbox: again } = newOutbox();
    await again.deliverPendingAppends();
    expect(read().length).toBe(1);
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    lease.release();
  });

  it("stops the drain at a transport failure: the failed row AND its successors stay, preserving per-stream FIFO; the re-drain delivers in order (round-2 thread 7)", async () => {
    // Three rows to ONE target stream, inserted directly (the crashed-
    // before-delivery shape the drain recovers).
    const fifoStream = { id: "of:fifo-stream-link", path: [] as string[] };
    const fifoSidecar = streamEntriesDocId(fifoStream);
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [1, 2, 3].map((n) => ({
        targetSpace,
        targetStream: fifoSidecar,
        targetStreamLink: fifoStream,
        eventId: `evt-fifo-${n}`,
        payload: { n },
        actingPrincipal: "user:alice",
        actingSession: "sess-1",
        capabilityRef: "cap-fifo",
      })),
    });

    // A transport that fails the FIRST delivery attempt only.
    let failuresLeft = 1;
    const flakyOnce = new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === "commitDelegatedAppend" && failuresLeft > 0) {
          return () => {
            failuresLeft -= 1;
            return Promise.reject(new Error("transport down"));
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const flakyOutbox = new SpaceOutbox({
      stats: emptyServingLoopStats(),
      server: flakyOnce as typeof server,
      engine,
      sessionId: holder,
      localSeqRef,
    });

    // The failed first row STOPS the drain: nothing delivered, ALL
    // three rows kept (pre-fix, rows 2 and 3 delivered past the
    // retained row 1 — the per-stream FIFO break the re-send then
    // completes: 2, 3, 1).
    const first = await flakyOutbox.deliverPendingAppends();
    expect(first.remaining).toBe(3);
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(3);
    const targetEngine = await server.engineForSpace(targetSpace);
    const empty = Engine.read(targetEngine, { id: fifoSidecar });
    expect(
      ((empty?.value as { entries?: Array<unknown> })?.entries ?? []).length,
    ).toBe(0);

    // The healthy re-drain delivers everything IN INSERTION ORDER.
    const second = await flakyOutbox.deliverPendingAppends();
    expect(second.remaining).toBe(0);
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    const after = Engine.read(targetEngine, { id: fifoSidecar });
    const entries =
      (after?.value as { entries?: Array<{ eventId?: string }> })?.entries ??
        [];
    expect(entries.map((entry) => entry.eventId)).toEqual([
      "evt-fifo-1",
      "evt-fifo-2",
      "evt-fifo-3",
    ]);
  });

  it("keeps the row on a transport-class delivery failure (admit-before-delete): the next drain delivers exactly one entry", async () => {
    const transportStream = { id: "of:transport-stream", path: [] as string[] };
    const transportSidecar = streamEntriesDocId(transportStream);
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [{
        targetSpace,
        targetStream: transportSidecar,
        targetStreamLink: transportStream,
        eventId: "evt-tr1",
        payload: { n: 3 },
        actingPrincipal: "user:alice",
        actingSession: "sess-1",
        capabilityRef: "cap-t",
      }],
    });

    // A transport-failing server: commitDelegatedAppend rejects with a
    // NON-deterministic (non-ProtocolError) failure — the row MUST
    // survive (delete-before-admit would pass the happy-path tests but
    // lose the append here).
    const failing = new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === "commitDelegatedAppend") {
          return () => Promise.reject(new Error("transport down"));
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const stats = emptyServingLoopStats();
    const flaky = new SpaceOutbox({
      stats,
      server: failing as typeof server,
      engine,
      sessionId: holder,
      localSeqRef,
    });
    const { remaining } = await flaky.deliverPendingAppends();
    expect(remaining).toBe(1);
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(1);
    // Transport failures are not LT4 failures: nothing counted failed.
    expect(stats.outbox.failed).toBe(0);

    // The next drain (a real server) delivers exactly ONE entry and
    // retires the row.
    const { outbox } = newOutbox();
    await outbox.deliverPendingAppends();
    const targetEngine = await server.engineForSpace(targetSpace);
    const doc = Engine.read(targetEngine, { id: transportSidecar });
    const entries = (doc?.value as { entries?: Array<unknown> })?.entries ?? [];
    expect(entries.length).toBe(1);
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
  });

  //
  // The sqliteQuery memo decision (B1's fix, serving-loop.md §4/§6)
  //

  it("sqliteQuery memo decision: a settled result is a hit, local work dedupes, and an orphaned claim re-issues", () => {
    // No stored key: issue (the ordinary miss).
    expect(sqliteQueryMemoDecision({
      stored: undefined,
      hash: "h1",
      inFlightHere: false,
      speculativeRun: false,
    })).toBe("issue");
    // Settled (result or error landed): the §4 hit — both arms.
    expect(sqliteQueryMemoDecision({
      stored: { pending: false, requestHash: "h1" },
      hash: "h1",
      inFlightHere: false,
      speculativeRun: false,
    })).toBe("hit");
    // A pending claim with the RPC in flight HERE: dedupe (§4's one
    // outstanding effect per key).
    expect(sqliteQueryMemoDecision({
      stored: { pending: true, requestHash: "h1" },
      hash: "h1",
      inFlightHere: true,
      speculativeRun: false,
    })).toBe("dedupe");
    // A pending claim with no local owner may belong to a stopped or concurrent
    // runtime. A non-speculative read safely reissues under the hash guard.
    expect(sqliteQueryMemoDecision({
      stored: { pending: true, requestHash: "h1" },
      hash: "h1",
      inFlightHere: false,
      speculativeRun: false,
    })).toBe("issue");
    // Speculative derivations cannot enact SQLite effects, so their pending
    // view is not evidence that a recoverable effect was abandoned.
    expect(sqliteQueryMemoDecision({
      stored: { pending: true, requestHash: "h1" },
      hash: "h1",
      inFlightHere: false,
      speculativeRun: true,
    })).toBe("dedupe");
    // A different stored key always re-issues (input-driven retry).
    expect(sqliteQueryMemoDecision({
      stored: { pending: false, requestHash: "old" },
      hash: "h1",
      inFlightHere: false,
      speculativeRun: true,
    })).toBe("issue");
  });

  //
  // Discharging a sqlite op through the attachment hook
  //
  // What the decision above leads to: a folded op applied atomically through
  // the hook, and a loud refusal everywhere else — no hook, no resolved scope
  // key, or a foreign batch.
  //

  // Unique per test run: the cell-db FILE for a memory-URL engine lives
  // at a deterministic TMPDIR path keyed by (space, id) — a stable id
  // would accrete rows across suite runs.
  const SQLITE_DB_ID = `of:wave-cell-db-${crypto.randomUUID()}`;
  const SQLITE_TABLES = {
    messages: table({ id: "integer primary key", body: "text" }),
  };

  const sqliteBatch = (options: {
    home?: boolean;
    scopeKeys?: ReadonlyArray<{ op: number; scopeKey: "space" }>;
    holder?: string;
  } = {}): WaveSpaceCommit => ({
    space,
    home: options.home ?? true,
    basisSeq: Engine.serverSeq(engine),
    rebasedHeads: [],
    operations: [
      {
        op: "set",
        id: "of:wave-sqlite-cell",
        value: { value: { ok: true } },
      },
      {
        op: "sqlite",
        db: { id: SQLITE_DB_ID, tables: SQLITE_TABLES },
        sql: "INSERT INTO messages (body) VALUES (?)",
        params: ["from the wave"],
      },
    ],
    preconditions: [],
    annotations: [],
    consequenceOf: [],
    basisInstances: [],
    holder: options.holder ?? holder,
    ...(options.scopeKeys === undefined
      ? { sqliteScopeKeys: [{ op: 1, scopeKey: "space" }] }
      : { sqliteScopeKeys: options.scopeKeys }),
  });

  it("applies a folded sqlite op in a HOME wave batch atomically via the server's attachment hook (the stage-D bound discharged)", async () => {
    const lease = liveLease();
    const sink = newSink({
      sqliteAttachmentsFor: (s, operations, scopeKeyByOpIndex) =>
        server.attachWaveCommitSqliteDbs(
          engine,
          s,
          operations,
          scopeKeyByOpIndex,
        ),
    });
    const result = await sink.commitWave(sqliteBatch());
    expect(result.error).toBeUndefined();

    // Both halves landed atomically: the cell write in the store, the
    // row in the (space-scoped) cell-db file.
    expect(
      Engine.read(engine, { id: "of:wave-sqlite-cell" }),
    ).toEqual({ value: { ok: true } });
    const attached = server.attachWaveCommitSqliteDbs(
      engine,
      space,
      [{
        op: "sqlite",
        db: { id: SQLITE_DB_ID, tables: SQLITE_TABLES },
        sql: "SELECT 1",
      }],
      new Map([[0, "space"]]),
    );
    try {
      expect(runQuery(engine.database, "SELECT body FROM messages")).toEqual([
        { body: "from the wave" },
      ]);
    } finally {
      attached.detach();
    }
    lease.release();
  });

  it("refuses a sqlite-carrying batch loudly on a sink without the attachment hook, on a batch without per-op scope keys, and on a FOREIGN batch", async () => {
    const lease = liveLease();
    // No hook: refused, never silently applied.
    const bare = await newSink().commitWave(sqliteBatch());
    expect(bare.error?.message).toContain("no attachment hook");

    // Hook present but no resolved scope key for the op: the server
    // helper refuses (the accumulator resolves every sqlite op's scope
    // against its run's identity — a missing entry is a plumbing bug).
    const hooked = newSink({
      sqliteAttachmentsFor: (s, operations, scopeKeyByOpIndex) =>
        server.attachWaveCommitSqliteDbs(
          engine,
          s,
          operations,
          scopeKeyByOpIndex,
        ),
    });
    const keyless = await hooked.commitWave(
      sqliteBatch({ scopeKeys: [] }),
    );
    expect(keyless.error?.message).toContain("no resolved scope key");

    // Foreign batch: Phase 5's cross-space design owns it.
    const foreign = await hooked.commitWave(
      sqliteBatch({ home: false }),
    );
    expect(foreign.error?.message).toContain("FOREIGN wave batch");
    lease.release();
  });
});
