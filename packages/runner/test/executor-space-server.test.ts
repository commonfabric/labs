// Server-execution v2 stage G: the SpaceServer's production recovery
// seams, pinned at the SpaceServer level (the stage-G review's M-B and
// m-3). The serving-loop E2E drives the happy path through the
// ExecutorHost; these tests pin the seams a deterministic suite left
// uncovered:
//
// - the §6-step-5 ACTIVATION RE-SEND: durable append rows written by a
//   wave that crashed/parked before delivery are delivered by the next
//   activation (delete the re-send call and the first test goes red);
// - the post-wave OWED drain: rows a transport-failed delivery leaves
//   behind ride the NEXT wave's drain even when that wave carries no
//   fresh appends (#outboxDrainOwed — armed by the failed activation
//   re-send too);
// - the park-race straggler drop (m-3): effects handed over for a wave
//   this server closed or abandoned are OWNED AND DROPPED — no
//   re-created #pendingEffectsByWave entry (the leak pin), no inline
//   flush firing network work for a contribution that never committed.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/utils/logger";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  insertExecutionOutboxRows,
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";
import {
  acquireExecutionLease,
  executionLeaseHolder,
  liveExecutionLeaseHolder,
  releaseExecutionLease,
} from "@commonfabric/memory/v2/execution-lease";
import {
  decodeMemoryBoundary,
  resolveScopeKey,
  type SessionViewInterest,
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { COMPONENT_READ_CONTRACT_VERSION } from "../src/component-read-contract.ts";
import type { Action } from "../src/scheduler/types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import type { PostCommitSideEffect } from "../src/cfc/types.ts";
import {
  SpaceServer,
  STRUCTURE_LOAD_STUCK_AFTER,
} from "../src/executor/space-server.ts";
import { stampWaveRunContext, waveRunContextOf } from "../src/executor/wave.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
} from "../src/executor/stats.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { ArrivalLog, awaitEach } from "./support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("space-server test space");
const space = spaceSigner.did() as MemorySpace;
const targetSigner = await Identity.fromPassphrase("space-server test target");
const targetSpace = targetSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "space-server test service",
);

const pendingRowStream = { id: "of:space-server-stream", path: [] as string[] };
const pendingRowSidecar = streamEntriesDocId(pendingRowStream);
const pendingRow = (eventId: string) => ({
  targetSpace,
  targetStream: pendingRowSidecar,
  targetStreamLink: pendingRowStream,
  eventId,
  payload: { via: "recovery seam" },
  actingPrincipal: "user:alice",
  actingSession: "sess-1",
  capabilityRef: "cap-r",
});

describe("stage G SpaceServer recovery seams", () => {
  let server: MemoryV2Server.Server;
  let engine: Engine.Engine;
  let servingRuntime: Runtime | undefined;
  let spaceServer: SpaceServer | undefined;

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    engine = await server.engineForSpace(space);
    servingRuntime = undefined;
    spaceServer = undefined;
    cycles = new ArrivalLog();
    parks = new ArrivalLog();
    retirements = new ArrivalLog();
  });

  afterEach(async () => {
    await spaceServer?.park("test-teardown");
    await server.close();
  });

  let lastStats = emptyServingLoopStats();

  /** Every wave cycle the tenure under test completes, committed or
   * not — the edge the loop's own counters move behind. */
  let cycles: ArrivalLog<void>;
  /** Every park, with its reason. */
  let parks: ArrivalLog<string>;
  /** Each in-flight effect as the outbox retires it — the activation
   * re-send retires its row without a wave, so no cycle reports it. */
  let retirements: ArrivalLog<void>;

  const newSpaceServer = (
    options: {
      serverFacade?: MemoryV2Server.Server;
      stats?: ServingLoopStats;
      policy?: ConstructorParameters<typeof SpaceServer>[0]["policy"];
      onParked?: (reason: string) => void;
    } = {},
  ): SpaceServer => {
    const stats = options.stats ?? emptyServingLoopStats();
    lastStats = stats;
    const created = new SpaceServer({
      space,
      server: options.serverFacade ?? server,
      engine,
      serviceIdentity: serviceSigner.did(),
      createRuntime: () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntime = runtime;
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      localSeqRef: { value: 0 },
      stats,
      onWaveCycle: cycles.record,
      onEffectRetired: retirements.record,
      onParked: parks.record,
      policy: options.policy ?? { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
      ...(options.onParked !== undefined ? { onParked: options.onParked } : {}),
    });
    spaceServer = created;
    return created;
  };

  /** Seal one stamped probe write through the serving loop and wait for
   * its wave to commit — the deterministic "drive one wave" helper. */
  const driveOneWave = async (probeName: string): Promise<void> => {
    const runtime = servingRuntime!;
    const probe = runtime.getCell<{ n: number }>(space, probeName, undefined);
    await probe.sync();
    const seqBefore = Engine.serverSeq(engine);
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: `test/${probeName}`,
      kind: "derivation",
    });
    probe.withTx(tx).set({ n: 1 });
    // Resolves at SEAL; the loop's cycle commits the wave.
    expect((await tx.commit()).error).toBeUndefined();
    await awaitEach(cycles, () => Engine.serverSeq(engine) > seqBefore);
  };

  it("refuses to activate on a runtime without servingPosture: the Phase-2 speculation default would divert factory-time loads (serving-loop.md §3)", async () => {
    const stats = emptyServingLoopStats();
    const rejecting = new SpaceServer({
      space,
      server,
      engine,
      serviceIdentity: serviceSigner.did(),
      createRuntime: () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        // Deliberately NOT servingPosture: under the flag this runtime's
        // default seal destination is the client speculation overlay,
        // and its factory-time structure loads would divert instead of
        // committing through the loopback plane — the loud refusal is
        // the guard.
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: true },
        });
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      localSeqRef: { value: 0 },
      stats,
      policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    });
    await expect(rejecting.activate()).rejects.toThrow(
      /servingPosture/,
    );
    // The refused activation released the lease (no stranded row).
    expect(
      liveExecutionLeaseHolder(engine, space),
    ).toBeUndefined();
  });

  it("returns `false` from `activate()` while another process holds the space's execution lease, and reports `lease-unavailable` without building a runtime (serving-loop.md §3)", async () => {
    // The rival's row is the whole staging: a lease acquired under a
    // holder this server can never match, live for far longer than the
    // activation below takes.
    const rival = executionLeaseHolder("did:key:space-server-rival");
    expect(
      acquireExecutionLease(engine, {
        space,
        holder: rival,
        ttlMs: 600_000,
      }),
    ).toBe(true);

    const parks: string[] = [];
    const refused = newSpaceServer({
      onParked: (reason) => parks.push(reason),
    });

    expect(await refused.activate()).toBe(false);
    expect(refused.active).toBe(false);
    expect(parks).toEqual(["lease-unavailable"]);
    // The refusal precedes the runtime factory — a second deriver must
    // not build a serving runtime it has no right to commit from — and
    // it leaves the rival's row exactly as it found it.
    expect(servingRuntime).toBeUndefined();
    expect(liveExecutionLeaseHolder(engine, space)).toBe(rival);
    expect(lastStats.lease.held).toBe(0);
  });

  it("re-sends pending durable append rows on ACTIVATION (serving-loop.md §6 step 5): park-stranded rows deliver, then retire", async () => {
    // The crash/park window: a wave committed its append rows, the
    // process died before delivery. The rows are durable engine state —
    // model them directly.
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [pendingRow("evt-activation-resend")],
    });
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(1);

    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);

    // Delivered by the activation re-send itself — no wave ran (no input,
    // no demand), so the re-send's own retirement is the edge here and a
    // cycle never comes. Delete the re-send call in activate() and this
    // never returns with the row still pending.
    await awaitEach(
      retirements,
      () =>
        selectPendingExecutionOutboxRows(engine, { branch: "" }).length === 0,
    );
    const targetEngine = await server.engineForSpace(targetSpace);
    const doc = Engine.read(targetEngine, {
      id: pendingRowSidecar,
    });
    const entries = (doc?.value as { entries?: Array<Record<string, unknown>> })
      ?.entries ?? [];
    expect(entries.length).toBe(1);
    expect(entries[0].eventId).toBe("evt-activation-resend");
  });

  it("keeps rows across a transport-failed activation re-send and delivers them on the NEXT wave's drain, without fresh appends (#outboxDrainOwed)", async () => {
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [pendingRow("evt-owed-drain")],
    });

    // A server whose delegated-append transport fails exactly once:
    // the activation re-send fails (rows survive), the next drain
    // succeeds.
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

    const created = newSpaceServer({
      serverFacade: flakyOnce as typeof server,
    });
    expect(await created.activate()).toBe(true);
    // The transport failure kept the row (admit-before-delete).
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(1);

    // Drive one wave that stages NO appends: the owed drain — armed by
    // the failed activation re-send — must deliver the surviving row.
    await driveOneWave("owed-drain-probe");
    await awaitEach(
      cycles,
      () =>
        selectPendingExecutionOutboxRows(engine, { branch: "" }).length === 0,
    );
    const targetEngine = await server.engineForSpace(targetSpace);
    const doc = Engine.read(targetEngine, {
      id: pendingRowSidecar,
    });
    const entries = (doc?.value as { entries?: Array<unknown> })?.entries ?? [];
    expect(entries.length).toBe(1);
  });

  it("aborts the handler tx when the consequence mark cannot be written (review 2026-08-11 C2): unmarked consequences never commit — events.md §4's double-consequence hatch stays closed", async () => {
    // The mark IS the exactly-once record: a handler tx whose
    // consequence-mark write failed but whose CONSEQUENCES still
    // committed would re-run on the next drain — double consequences.
    // The reviewer's probe (replace #stampRun's tx.abort with a
    // continue) left every suite green; this pin goes red under it.
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);
    const runtime = servingRuntime!;

    // Fault injection at the mark-write seam: the sidecar's cell
    // construction throws — a stand-in for any storage-layer mark
    // failure (a compacted-away index, a schema refusal, a read fault).
    const sidecarId = "of:stream-events:c2-mark-stream";
    const original = runtime.getCellFromLink.bind(runtime);
    (runtime as unknown as { getCellFromLink: unknown }).getCellFromLink = (
      link: { id?: string },
      ...rest: unknown[]
    ) => {
      if (link?.id === sidecarId) {
        throw new Error("injected mark-write failure (C2)");
      }
      return (original as (...args: unknown[]) => unknown)(link, ...rest);
    };
    try {
      const consequence = runtime.getCell<{ n: number }>(
        space,
        "c2-consequence",
        undefined,
      );
      await consequence.sync();
      const tx = runtime.edit();
      // The would-be handler consequence rides the tx (order within
      // one tx is immaterial — the stamp writes the mark before the
      // handler runs in production).
      consequence.withTx(tx).set({ n: 1 });
      // The REAL #stampRun (installed at activation as the runtime's
      // runStamper) attempts the mark write, which fails: the tx must
      // ABORT — the dispatch's error arm owns the error consequence.
      runtime.stampServerRun(tx, {
        actionId: "test/c2-handler",
        kind: "event-handler",
        eventId: "evt-c2",
        streamEntry: { sidecarId, index: 0, seq: 1 },
      });
      const committed = await tx.commit();
      expect(committed.error).toBeDefined();

      // Flush a wave: the unmarked consequence must NEVER land (under
      // the probe the sealed tx commits with this wave — red).
      await driveOneWave("c2-flush-probe");
      const doc = Engine.read(engine, {
        id: consequence.getAsNormalizedFullLink().id,
      });
      expect(doc?.value).toBeUndefined();
    } finally {
      (runtime as unknown as { getCellFromLink: unknown }).getCellFromLink =
        original;
    }
  });

  it("drops a straggler's effects for a closed or abandoned wave — owned, no re-created entry, no inline flush (m-3)", async () => {
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);

    // A stamped tx seals into a wave; the loop commits it (the wave
    // closes).
    const runtime = servingRuntime!;
    const probe = runtime.getCell<{ n: number }>(
      space,
      "m3-straggler-probe",
      undefined,
    );
    await probe.sync();
    const seqBefore = Engine.serverSeq(engine);
    const probeTx = runtime.edit();
    stampWaveRunContext(probeTx, {
      actionId: "test/m3-straggler",
      kind: "derivation",
    });
    probe.withTx(probeTx).set({ n: 1 });
    expect((await probeTx.commit()).error).toBeUndefined();
    await awaitEach(cycles, () => Engine.serverSeq(engine) > seqBefore);

    // The straggler: a late deferSealedEffects for the CLOSED wave's tx
    // (in production, a continuation racing park/rotation). It must be
    // OWNED (true — the caller must not inline-flush network work for a
    // contribution whose wave is gone) and DROPPED (no map entry — the
    // pre-fix re-created one nothing would ever consume).
    let flushed = 0;
    const effect: PostCommitSideEffect = {
      id: "fetchTest:m3-straggler",
      kind: "fetchTest-start",
      flush: () => {
        flushed += 1;
      },
    };
    expect(created.deferSealedEffects(probeTx, [effect])).toBe(true);
    expect(created.deferredEffectWaveCount).toBe(0);
    expect(flushed).toBe(0);

    // Same drop once the space is PARKED (the !active arm): still
    // owned, still nothing stored or flushed.
    await created.park("m3-straggler-park");
    expect(created.deferSealedEffects(probeTx, [effect])).toBe(true);
    expect(created.deferredEffectWaveCount).toBe(0);
    expect(flushed).toBe(0);
  });

  it("clamps the W advance to the shadow floor — the min/max composition and serving-loop.md §7's counter, full suppression and the remove sentinel included — and the shadow-flip wake lifts the clamp promptly (Phase 2 settle input barrier)", async () => {
    const stats = emptyServingLoopStats();
    const created = newSpaceServer({ stats });
    expect(await created.activate()).toBe(true);

    // The serving replica, with the floor STUBBED: the replica-level
    // shadow machinery (recording, exemptions, the verdict-race
    // repair) is pinned in memory-v2-stacked-commit.test.ts; this test
    // pins the SpaceServer's half of the contract — what the loop DOES
    // with a floor.
    const replica = servingRuntime!.storageManager.open(space)
      .replica as unknown as {
        unappliedForeignSeqFloor?: () => number | undefined;
        shadowFlipObserver?: () => void;
      };
    // Activation installed the wake hook (the flip's dirtiness has no
    // admitted-commit record behind it, so nothing else ends the
    // loop's input wait before the idle timeout).
    expect(replica.shadowFlipObserver).toBeDefined();

    // Real commits via the memory server's direct-write path; the
    // notices are the host feed, supplied by hand in this direct-drive
    // harness (the ExecutorHost's admission observer in production).
    const write = async (doc: string): Promise<number> => {
      const applied = await server.writeDocument(space, doc, { n: 1 });
      return applied.seq;
    };
    const notice = (seq: number) =>
      created.enqueueCommit({
        space,
        seq,
        class: "system",
        sessionId: "session:clamp-probe",
        writes: [{ id: "of:clamp-probe", scopeKey: "space" }],
      });

    // Baseline: no floor, the advance reaches the batch head.
    const s1 = await write("of:clamp-a");
    notice(s1);
    await awaitEach(cycles, () => created.watermark === s1);
    expect(stats.watermarkClamped).toBe(0);

    // PARTIAL clamp: two inputs, the floor shadows the second — W
    // advances to floor-1, never the batch head. This pins the
    // composition: `inputVisibleHead = min(batchHead, floor-1)`,
    // `advanceTo = max(W, inputVisibleHead)` — invert either and the
    // assertions below go red (min→max advances past the floor;
    // max→min refuses the advance).
    let floor: number | undefined;
    replica.unappliedForeignSeqFloor = () => floor;
    const s2 = await write("of:clamp-b");
    const s3 = await write("of:clamp-c");
    floor = s3;
    // Enqueued back-to-back synchronously: one input batch, one cycle.
    notice(s2);
    notice(s3);
    await awaitEach(cycles, () => created.watermark === s2);
    expect(created.watermark).toBe(s3 - 1);
    expect(stats.watermarkClamped).toBe(1);

    // FULL suppression: the shadowed seq is the LOWEST input above W
    // (floor == W+1), so the advance is suppressed entirely
    // (advanceTo == W). §7's binding sentence — "waves whose W advance
    // was actually clamped below the input batch head" — counts
    // exactly this; the pre-fix guard required advanceTo > W and
    // missed it.
    const s4 = await write("of:clamp-d");
    notice(s4);
    await awaitEach(cycles, () => stats.watermarkClamped >= 2);
    expect(created.watermark).toBe(s2);
    expect(stats.watermarkClamped).toBe(2);

    // The REMOVE-sentinel floor (1): a shadowed remove carries no wire
    // seq, so its floor holds W entirely — counted the same way.
    floor = 1;
    const s5 = await write("of:clamp-e");
    notice(s5);
    await awaitEach(cycles, () => stats.watermarkClamped >= 3);
    expect(created.watermark).toBe(s2);

    // The PROMPT lift: the flip resolves the input wait directly — no
    // admitted commit remains on the feed (s3..s5 drained cycles ago;
    // only their VISIBILITY changed), so without the wake the catch-up
    // wave would sit out idleParkMs (600 s here) and this wait would
    // never return. Fired the way the replica's confirmPending does at
    // promotion, and fired once: the loop arms its input wait
    // synchronously after the cycle edge the wait above resolved on, so
    // it is already waiting when this lands.
    floor = undefined;
    replica.shadowFlipObserver?.();
    await awaitEach(cycles, () => created.watermark === s5);
    expect(stats.watermarkClamped).toBe(3);
  });

  it("holds the watermark when its bookkeeping transaction fails, then advances on fresh input", async () => {
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);

    const runtime = servingRuntime!;
    const edit = runtime.edit.bind(runtime);
    const watermarkFailureCount = () =>
      getLogger("space-server").countsByKey["watermark-seal-failed"]?.warn ??
        0;
    const failuresBefore = watermarkFailureCount();
    const retryCommitGate = Promise.withResolvers<void>();
    /** Each watermark-bookkeeping commit as it is attempted. The second
     * attempt blocks on the gate below, inside the wave cycle that made
     * it, so the cycle it belongs to does not end until the test
     * releases it and there is no cycle edge to wait on for it. */
    const watermarkCommits = new ArrivalLog<void>();
    runtime.edit = (options) => {
      const tx = edit(options);
      const commit = tx.commit.bind(tx);
      tx.commit = () => {
        if (
          waveRunContextOf(tx)?.actionId !== "server-execution/watermark"
        ) {
          return commit();
        }
        watermarkCommits.record();
        const attempt = watermarkCommits.entries.length;
        if (attempt === 1) {
          const reason = new Error("injected watermark commit failure");
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted" as const,
              message: reason.message,
              reason,
            },
          });
        }
        if (attempt === 2) {
          return retryCommitGate.promise.then(() => commit());
        }
        return commit();
      };
      return tx;
    };

    const first = await server.writeDocument(
      space,
      "of:watermark-failure-first",
      { n: 1 },
    );
    created.enqueueCommit({
      space,
      seq: first.seq,
      class: "authored",
      sessionId: "session:watermark-failure",
      writes: [{ id: "of:watermark-failure-first", scopeKey: "space" }],
    });
    await awaitEach(
      cycles,
      () => watermarkFailureCount() > failuresBefore,
    );
    expect(watermarkCommits.entries.length).toBe(1);

    const second = await server.writeDocument(
      space,
      "of:watermark-failure-second",
      { n: 2 },
    );
    try {
      created.enqueueCommit({
        space,
        seq: second.seq,
        class: "authored",
        sessionId: "session:watermark-failure",
        writes: [{ id: "of:watermark-failure-second", scopeKey: "space" }],
      });
      await watermarkCommits.reached(2);
      expect(created.watermark).toBeLessThan(first.seq);
    } finally {
      retryCommitGate.resolve();
    }
    await awaitEach(cycles, () => created.watermark >= second.seq);
  });

  it("abandons accepted runner callbacks when parking before their wave closes", async () => {
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);
    const defer = created.deferSealedEffects.bind(created);
    let parked: Promise<void> | undefined;
    let acceptedBatches = 0;
    let flushed = false;
    let abandoned: unknown;
    const handoff = stub(created, "deferSealedEffects", (tx, effects) => {
      const owned = defer(tx, effects);
      acceptedBatches = created.deferredEffectWaveCount;
      // Park on the actual ownership handoff, before the serving loop can close
      // this wave. No elapsed-time ordering decides which path the test covers.
      parked = created.park("pending-runner-callback");
      return owned;
    });
    try {
      const tx = servingRuntime!.edit();
      stampWaveRunContext(tx, {
        actionId: "test/parked-runner-callback",
        kind: "derivation",
      });
      tx.enqueuePostCommitEffect({
        id: "runner-acceptance:parked",
        kind: "runner-acceptance",
        flush: () => {
          flushed = true;
        },
        abandon: (reason) => {
          abandoned = reason;
        },
      });
      expect((await tx.commit()).error).toBeUndefined();
      expect(acceptedBatches).toBe(1);
      expect(parked).toBeDefined();
      await parked;
      expect(abandoned).toBe("pending-runner-callback");
      expect(flushed).toBe(false);
      expect(created.deferredEffectWaveCount).toBe(0);
    } finally {
      handoff.restore();
    }
  });

  it("fires an EFFECT-ONLY batch on a quiet space: an all-no-op tx's deferred effects close a vacuous wave instead of starving until park (round-2 thread 1)", async () => {
    // The §6-step-3 recovery shape: an activation re-run of an
    // effectful node whose claim is already durable seals an ALL-NO-OP
    // transaction (its claim writes elide) that carries only the
    // effect. It mints NO contribution, so the pre-fix loop — which
    // closed waves only for contributions or watermark movement —
    // never closed the wave holding the batch: on a quiet space the
    // effect starved, and the eventual idle park dropped it.
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);

    const runtime = servingRuntime!;
    let flushed = 0;
    const flushArrivals = new ArrivalLog<void>();
    const seqBefore = Engine.serverSeq(engine);
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "test/effect-only-reissue",
      kind: "derivation",
    });
    // NO writes: the tx seals empty (contributes nothing) and carries
    // one deferred effect.
    tx.enqueuePostCommitEffect({
      id: "fetchTest:effect-only",
      kind: "fetchTest-start",
      flush: () => {
        flushed += 1;
        flushArrivals.record();
      },
    });
    expect((await tx.commit()).error).toBeUndefined();

    // The effect must FIRE with no further input: the loop counts the
    // deferred batch as work, closes the (vacuous, zero-contribution)
    // wave, and admits the batch to the outbox.
    await flushArrivals.reached(1);
    // Vacuous close: nothing was committed for it.
    expect(Engine.serverSeq(engine)).toBe(seqBefore);
    expect(created.deferredEffectWaveCount).toBe(0);
  });

  it("discards a REJECTED wave's effects: a terminal engine-side rejection withdraws the claims, so the batch must not egress (round-2 thread 3)", async () => {
    const created = newSpaceServer({
      // Renewals must not repair the lease mid-test: the rejection is
      // staged by deleting the engine-side lease row while the
      // in-process tenure stays valid.
      policy: {
        flushDeadlineMs: 2_000,
        idleParkMs: 600_000,
        renewIntervalMs: 600_000,
      },
    });
    expect(await created.activate()).toBe(true);
    const runtime = servingRuntime!;

    // Pull the engine-side lease row out from under the ACTIVE server:
    // the in-process tenure check still passes (no renew ran), so the
    // wave proceeds to its commit — where the engine's derived-class
    // admission (holder must hold the LIVE execution_lease) refuses it
    // with a conflict-less rejection: the accumulator's terminal
    // `aborted: "rejected"` arm, exactly the failed-wave shape the
    // admission gate must discard effects for.
    engine.database.prepare(
      `DELETE FROM execution_lease WHERE space = :space`,
    ).run({ space });

    let flushed = 0;
    const probe = runtime.getCell<{ n: number }>(
      space,
      "rejected-wave-probe",
      undefined,
    );
    await probe.sync();
    const seqBefore = Engine.serverSeq(engine);
    const wavesBefore = lastStats.waves;
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "test/rejected-wave",
      kind: "derivation",
    });
    probe.withTx(tx).set({ n: 1 });
    tx.enqueuePostCommitEffect({
      id: "fetchTest:rejected-wave",
      kind: "fetchTest-start",
      flush: () => {
        flushed += 1;
      },
    });
    expect((await tx.commit()).error).toBeUndefined();

    // The wave closes (counted) but commits nothing and — the pin —
    // its effects are DISCARDED, not admitted: the sealed claim writes
    // were withdrawn with the rejection, so firing would egress work
    // whose claim never became durable (pre-fix, every non-lease-lost
    // abort admitted the batch).
    // The cycle that closed the wave is the edge; its end is ordered
    // after any flush the wave would wrongly have admitted.
    await awaitEach(cycles, () => lastStats.waves > wavesBefore);
    expect(flushed).toBe(0);
    expect(Engine.serverSeq(engine)).toBe(seqBefore);
  });

  it("reports a survived renewal blip to the memory server: the renew arm's same-process reacquire calls noteLeaseReacquired with the space and the service identity — once per blip, never on a plain renewal, never when the reacquire fails and the space parks (fan-out stage A's finding 1, the re-arm's trigger)", async () => {
    // A Proxy facade over the real server that records the notice; every
    // other call passes through (the sx2 facade pattern above).
    const notices: Array<{ space: string; principal: string }> = [];
    const noticeArrivals = new ArrivalLog<void>();
    const spy = new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === "noteLeaseReacquired") {
          return (notice: { space: string; principal: string }) => {
            notices.push(notice);
            noticeArrivals.record();
            return target.noteLeaseReacquired(notice);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof server;
    const stats = emptyServingLoopStats();
    const created = newSpaceServer({
      serverFacade: spy,
      stats,
      policy: {
        flushDeadlineMs: 2_000,
        idleParkMs: 600_000,
        renewIntervalMs: 25,
      },
    });
    expect(await created.activate()).toBe(true);
    // Activation itself reports nothing. Whether a PLAIN renewal reports
    // is carried by the count assertions after the blip below: the renew
    // ticks every 25 ms for the rest of this test, so a renewal that
    // reported would push the count past the one the blip produces.
    expect(notices).toEqual([]);
    expect(stats.lease.lost).toBe(0);

    // The blip: the row vanishes with NO rival, so the next tick's
    // renewal FAILS and the same-process reacquire SUCCEEDS.
    releaseExecutionLease(engine, { space, holder: created.holder });
    // The notice is the reacquire's own edge; the failed tick and the
    // restored row are what produced it.
    await noticeArrivals.reached(1);
    expect(stats.lease.lost).toBeGreaterThanOrEqual(1);
    expect(liveExecutionLeaseHolder(engine, space)).toBe(created.holder);
    expect(notices).toEqual([{ space, principal: serviceSigner.did() }]);
    expect(created.active).toBe(true);

    // A blip the reacquire LOSES (a rival took the row) parks the space
    // and reports nothing: there is no live lease to re-arm under.
    releaseExecutionLease(engine, { space, holder: created.holder });
    expect(
      acquireExecutionLease(engine, {
        space,
        holder: executionLeaseHolder("did:key:rival-process"),
        ttlMs: 600_000,
      }),
    ).toBe(true);
    await parks.reached(1);
    expect(created.active).not.toBe(true);
    // One notice per blip, over every plain renewal since.
    expect(notices.length).toBe(1);
  });

  it("resolves a second park only once the first has parked the space", async () => {
    // A park the renew arm fires without awaiting is still running its
    // dispose when the host closes; the host's own park must wait for it,
    // or the engine closes under a tenure that still releases its lease
    // through it.
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);
    const first = created.park("first");
    let parked = false;
    created.whenParked.then(() => {
      parked = true;
    });
    await created.park("second");
    expect(parked).toBe(true);
    await first;
  });

  //
  // Stage P2-F: late-notice accounting (the sx2 unskip flake)
  //

  it("counts an authored notice that arrives AFTER a higher-seq echo (the two-producer notice race): late records still count and re-arm, and coverage stays in-order", async () => {
    const stats = emptyServingLoopStats();
    const created = newSpaceServer({ stats });
    expect(await created.activate()).toBe(true);

    // Two REAL commits, enqueued out of order — the loop's own
    // post-commit notice (seq S+1) landing before the transact
    // path's async admission notice (seq S), exactly the in-process
    // race the unskipped sx2 gate exposed (authoredSeen undercounted
    // while W stayed honest).
    const first = await server.writeDocument(space, "of:p2f-late-a", {
      n: 1,
    });
    const second = await server.writeDocument(space, "of:p2f-late-b", {
      n: 2,
    });
    const authoredBefore = stats.authoredSeen;
    created.enqueueCommit({
      space,
      seq: second.seq,
      class: "authored",
      sessionId: "session:p2f-late",
      writes: [{ id: "of:p2f-late-b", scopeKey: "space" }],
    });
    await awaitEach(cycles, () => created.watermark >= second.seq);
    // The LATE notice: seq below the drained head. Pre-fix it was
    // silently skipped (never counted); post-fix it counts exactly
    // once — a replayed duplicate stays skipped.
    created.enqueueCommit({
      space,
      seq: first.seq,
      class: "authored",
      sessionId: "session:p2f-late",
      writes: [{ id: "of:p2f-late-a", scopeKey: "space" }],
    });
    await awaitEach(
      cycles,
      () => stats.authoredSeen === authoredBefore + 2,
    );
    created.enqueueCommit({
      space,
      seq: first.seq,
      class: "authored",
      sessionId: "session:p2f-late",
      writes: [{ id: "of:p2f-late-a", scopeKey: "space" }],
    });
    await cycles.reached(cycles.entries.length + 1);
    expect(stats.authoredSeen).toBe(authoredBefore + 2);
    // Coverage math stayed in-order: W never regressed.
    expect(created.watermark).toBeGreaterThanOrEqual(second.seq);
  });

  //
  // The demand-seam apparatus
  //
  // The helpers the regions below share: what they hand-feed, and the shape
  // demand takes under (d′).
  //

  // W0 (d′) SCRATCH: these seams hand-feed DEMAND with no client session.
  // Under (d′) demand is the tracked-ids CLOSURE (`demandedInstancesForSpace`
  // rows: instance-keyed, `root` marked) — a client watching a piece's
  // result with its schema tracks the result doc AND the `computed:` docs
  // it links to (the writers of those are the demand roots; the root doc
  // itself has no scheduler writer). A seam that feeds ROOT rows only
  // would demand nothing runnable, so this shim adds a SUPERSET closure:
  // every `computed:` doc in the space (space instance, `root: false`,
  // no identity — the demanders still come from the identity-bearing root
  // rows through `#pieceRootByDemandKey`, as before). The mechanism these
  // pins bind (terminal state, re-arm, argument-doc supply, LT6) is
  // unchanged by the demand source.
  const demandRowsFor = (
    roots: Array<{
      id: string;
      scope?: string;
      identity?: { principal?: string; sessionId?: string };
    }>,
  ) => {
    const rows: Array<{
      id: string;
      scope: "space" | "user" | "session";
      scopeKey: string;
      identity?: { principal?: string; sessionId?: string };
      root: boolean;
    }> = [];
    for (const root of roots) {
      const scope = (root.scope ?? "space") as "space" | "user" | "session";
      let scopeKey = "space";
      if (scope !== "space") {
        try {
          scopeKey = resolveScopeKey(scope, {
            principal: root.identity?.principal,
            sessionId: root.identity?.sessionId as never,
          });
        } catch {
          continue;
        }
      }
      rows.push({
        id: root.id,
        scope,
        scopeKey,
        ...(root.identity === undefined ? {} : { identity: root.identity }),
        root: true,
      });
    }
    const computedIds = engine.database.prepare(
      `SELECT DISTINCT id FROM head WHERE id LIKE 'computed:%' AND op != 'delete'`,
    ).all() as Array<{ id: string }>;
    for (const { id } of computedIds) {
      rows.push({ id, scope: "space", scopeKey: "space", root: false });
    }
    return rows;
  };

  /**
   * A facade whose watch registry names exactly the given demanded roots — the
   * unit-level stand-in for client sessions' watches (the production feed is
   * pinned in the serving-loop E2E).
   */
  const demandFacade = (
    roots: Array<{
      id: string;
      scope?: string;
      identity?: { principal?: string; sessionId?: string };
    }>,
  ): typeof server =>
    new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === "demandedInstancesForSpace") {
          return () => demandRowsFor(roots);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof server;

  //
  // The terminal decision for a demanded root
  //
  // Reaching it and stopping the per-cycle churn, counting a root that stays
  // parked short of it, and re-arming out of it on a later commit.
  //

  it("terminalizes a confirmed no-meta demanded root and STOPS the per-cycle churn (OW19's terminal half)", async () => {
    // A doc that EXISTS durably with a plain value and NO pattern meta
    // — the never-a-piece `of:` class (registry/home/argument docs)
    // that id classes cannot exclude.
    await server.writeDocument(space, "of:p2f-terminal-root", { plain: 1 });

    const stats = emptyServingLoopStats();
    const created = newSpaceServer({
      stats,
      serverFacade: demandFacade([{ id: "of:p2f-terminal-root" }]),
    });
    expect(await created.activate()).toBe(true);

    // The root terminalizes: attempted, confirmed synced-no-meta,
    // parked — counted once.
    await awaitEach(cycles, () => stats.structureLoadTerminal === 1);

    // THE CHURN STOPS (the starvation fork's fix): further cycles —
    // driven by unrelated commits — re-attempt NOTHING for the parked
    // root. Pre-P2-F every input-driven cycle re-ran the ensure
    // (structureLoadDeferred grew per cycle, unbounded).
    const deferredAtTerminal = stats.structureLoadDeferred;
    const terminalAtTerminal = stats.structureLoadTerminal;
    for (let i = 0; i < 4; i++) {
      const applied = await server.writeDocument(
        space,
        `of:p2f-unrelated-${i}`,
        { n: i },
      );
      created.enqueueCommit({
        space,
        seq: applied.seq,
        class: "system",
        sessionId: "session:p2f-unrelated",
        writes: [{ id: `of:p2f-unrelated-${i}`, scopeKey: "space" }],
      });
      await awaitEach(cycles, () => created.watermark >= applied.seq);
    }
    expect(stats.structureLoadDeferred).toBe(deferredAtTerminal);
    expect(stats.structureLoadTerminal).toBe(terminalAtTerminal);
    expect(stats.structureLoadRearmed).toBe(0);
    expect(stats.structureLoadFailures).toBe(0);
  });

  it("a demanded root stuck in per-cycle deferral is counted after the threshold — the forever-park is visible from stats (OW46)", async () => {
    // The home-profile Ada shape (rootcause §1; verification-coverage.md
    // OW46): a doc whose pattern pointer names an identity that can
    // never load — the program docs are missing — defers its structure
    // load EVERY input-driven cycle, forever. Each attempt lands in the
    // aggregate structureLoadDeferred, where a dead space is
    // indistinguishable from routine one-cycle creation races, and the
    // only log line is debug-level. This pin: after
    // STRUCTURE_LOAD_STUCK_AFTER consecutive deferrals of ONE root the
    // loop counts a structureLoadStuck crossing (once per root, not per
    // cycle) and WARNS with the space and root named.
    const rootId = "of:ow46-stuck-root";
    // Direct engine write so the doc carries `patternIdentity` META
    // beside its value (writeDocument wraps value-only).
    Engine.applyCommit(engine, {
      sessionId: "session:ow46-writer",
      space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: rootId,
          value: {
            value: { plain: 1 },
            patternIdentity: {
              identity: "ow46-no-such-pattern",
              symbol: "default",
            },
          },
        }],
      },
      commitClass: "system",
    });

    const stats = emptyServingLoopStats();
    const created = newSpaceServer({
      stats,
      serverFacade: demandFacade([{ id: rootId }]),
    });
    expect(await created.activate()).toBe(true);

    // Drive input cycles; each one re-attempts the pending root and
    // defers (pattern-unloadable). The crossing must appear at exactly
    // the threshold — not before (stuck stays 0 while the streak is
    // short: a routine creation-race deferral never trips it), and only
    // ONCE for the one stuck root no matter how far past the threshold
    // the cycles run — driven past the first DOUBLING (2× the
    // threshold) so the doubling re-warn path runs while the crossing
    // counter provably does not re-count. The warn is observed through
    // the console the logger writes to.
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes("structure-load-stuck")) warns.push(line);
      originalWarn.apply(console, args);
    };
    try {
      for (
        let i = 0;
        stats.structureLoadDeferred < 2 * STRUCTURE_LOAD_STUCK_AFTER + 2 &&
        i < 60;
        i++
      ) {
        if (stats.structureLoadDeferred < STRUCTURE_LOAD_STUCK_AFTER) {
          expect(stats.structureLoadStuck).toBe(0);
          expect(warns.length).toBe(0);
        }
        const applied = await server.writeDocument(
          space,
          `of:ow46-noise-${i}`,
          { n: i },
        );
        created.enqueueCommit({
          space,
          seq: applied.seq,
          class: "system",
          sessionId: "session:ow46-noise",
          writes: [{ id: `of:ow46-noise-${i}`, scopeKey: "space" }],
        });
        await awaitEach(cycles, () => created.watermark >= applied.seq);
      }
    } finally {
      console.warn = originalWarn;
    }
    expect(stats.structureLoadDeferred).toBeGreaterThanOrEqual(
      2 * STRUCTURE_LOAD_STUCK_AFTER,
    );
    expect(stats.structureLoadStuck).toBe(1);
    // The warn fired at the crossing (8) and again at the doubling
    // (16) — visible persistence without per-cycle spam — and each
    // line names the root.
    expect(warns.length).toBe(2);
    for (const line of warns) {
      expect(line).toContain("of:ow46-stuck-root");
    }
    expect(stats.structureLoadFailures).toBe(0);
    expect(stats.structureLoadTerminal).toBe(0);
  });

  it("re-arms a terminal root on a commit touching it and LOADS a piece created after the terminal decision (OW19's not-yet half)", async () => {
    const stats = emptyServingLoopStats();
    const rootName = "p2f-created-later";
    const created = newSpaceServer({ stats });
    expect(await created.activate()).toBe(true);
    const runtime = servingRuntime!;

    // The demanded root's id BEFORE anything exists at it — the
    // creation race's first half: demand precedes the piece.
    const rootCell = runtime.getCell<{ total?: number }>(
      space,
      rootName,
      undefined,
    );
    const rootId = rootCell.getAsNormalizedFullLink().id;

    // Point the demand facade at it (swapped in via the server's
    // observer seam: the SpaceServer reads demandedInstancesForSpace on
    // every demand pass, so overriding the method on the shared server
    // object works mid-flight).
    const originalWatched = server.demandedInstancesForSpace.bind(server);
    (server as { demandedInstancesForSpace: unknown })
      .demandedInstancesForSpace = () => demandRowsFor([{ id: rootId }]);
    try {
      // Fire a demand pass; the absent root confirms no-meta and
      // terminalizes (not-yet and never are indistinguishable HERE —
      // the re-arm below is what distinguishes them). Poll-fired: the
      // wake resolves the loop's input wait, which is re-armed between
      // cycles (the clamp test's idiom).
      await awaitEach(cycles, () => {
        created.noteDemandChanged();
        return stats.structureLoadTerminal === 1;
      });

      // NOW create the piece at that root through a CLIENT runtime —
      // the scheduler tell's creation shape (an outside-scheduler
      // authored act; protocol.md §1): its commit is a fresh authored
      // admission whose notice the admission hook would deliver — this
      // direct-drive harness hand-feeds the same notice with the
      // commit's REAL seq.
      const creatorManager = EmulatedStorageManager.connectTo(server, {
        as: spaceSigner,
      });
      const creator = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: creatorManager,
      });
      try {
        const compiled = await creator.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: [
              "import { computed, pattern } from 'commonfabric';",
              "export default pattern<{ n: number }, { total: number }>(",
              "  ({ n }) => ({ total: computed(() => n + 7) }),",
              ");",
            ].join("\n"),
          }],
        }, { space });
        const argument = creator.getCell<{ n: number }>(
          space,
          "p2f-created-later-arg",
          undefined,
        );
        const creatorRoot = creator.getCell<{ total?: number }>(
          space,
          rootName,
          undefined,
        );
        await argument.sync();
        await creatorRoot.sync();
        const argTx = creator.edit();
        argument.withTx(argTx).set({ n: 1 });
        creator.run(argTx, compiled, argument, creatorRoot);
        expect((await argTx.commit()).error).toBeUndefined();
        await creator.idle();
        await creator.storageManager.synced();
      } finally {
        await creator.dispose();
        await creatorManager.close();
      }
      const creationSeq = Engine.serverSeq(engine);
      created.enqueueCommit({
        space,
        seq: creationSeq,
        class: "authored",
        sessionId: "session:p2f-creator",
        writes: [{ id: rootId, scopeKey: "space" }],
      });

      await awaitEach(cycles, () => stats.structureLoadRearmed === 1);
      // The settle-gated retry LOADS the piece: no re-terminalization,
      // and the piece's derivation serves — the derived total lands in
      // the engine under a derived-class commit.
      await awaitEach(cycles, () => {
        const row = engine.database.prepare(
          `SELECT c.class AS class FROM revision r
             JOIN "commit" c ON c.seq = r.commit_seq
             WHERE r.id LIKE 'computed:%' ORDER BY r.seq DESC LIMIT 1`,
        ).get() as { class: string } | undefined;
        return row?.class === "derived";
      });
      expect(stats.structureLoadTerminal).toBe(1);
      expect(stats.structureLoadFailures).toBe(0);
    } finally {
      (server as { demandedInstancesForSpace: unknown })
        .demandedInstancesForSpace = originalWatched;
    }
  });

  //
  // Stage P2-F: the argument-doc demand → owning-piece run supply
  //

  it("supplies a scoped ARGUMENT-doc demand's identity to the owning piece's derivation runs: the ensure-resolved root differs from the demanded id, and the derived commit still carries the demanding actor (the #pieceRootByDemandKey arm)", async () => {
    // An ordinary nested-doc watch: the client's scoped subscription
    // names the piece's ARGUMENT doc, not its result root. The demand
    // key therefore never matches the piece root by suffix — the run
    // supply finds the demand's identity ONLY through the structure
    // load's resolved-root mapping. If that mapping silently breaks,
    // the demanded derivation falls back to the wave identity and its
    // writes classify USERLESS — the exact misclassification stage
    // P2-F exists to end, which is why this pin binds the OBSERVABLE
    // (the derived commit's acting annotations), not the map.
    //
    // The piece, created BEFORE serving starts, via a client runtime.
    // The demanded doc is the piece's argument META doc (the runner's
    // own argument cell, which carries the `result` backlink the
    // ensure traversal follows to the owning root).
    const creatorManager = EmulatedStorageManager.connectTo(server, {
      as: spaceSigner,
    });
    const creator = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: creatorManager,
    });
    let pieceRootId: string;
    let argMetaDocId: string;
    let inputDocId: string;
    try {
      // The derivation reads a PER-USER slot besides `n` (fan-out stage
      // B, RULED 2026-08-16 — design §F: attribution derives from the
      // scope a run DISCOVERS; a space-only `n + 7` runs once as the
      // probe and acts as nobody). The creator narrows the slot through
      // the argument schema, so every later read of it follows the
      // redirect into the reader's own instance.
      const compiled = await creator.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, Default, pattern, PerUser, Writable } from 'commonfabric';",
            "type Mine = Writable<number | Default<0>>;",
            "export default pattern<{ n: number; mine?: PerUser<Mine> }, { total: number }>(",
            "  ({ n, mine }) => { const mineCell: Mine = mine!; return { total: computed(() => n + 7 + ((mineCell.get() as number | undefined) ?? 0)) }; },",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const input = creator.getCell<{ n: number }>(
        space,
        "p2f-argdemand-input",
        undefined,
      );
      const root = creator.getCell<{ total?: number }>(
        space,
        "p2f-argdemand-root",
        undefined,
      );
      await input.sync();
      await root.sync();
      const tx = creator.edit();
      input.withTx(tx).set({ n: 1 });
      creator.run(tx, compiled, input, root);
      expect((await tx.commit()).error).toBeUndefined();
      const typedInput = creator.getCell<{ mine: number }>(
        space,
        "p2f-argdemand-input",
        compiled.argumentSchema,
      );
      const mineTx = creator.edit();
      typedInput.key("mine").withTx(mineTx).set(1);
      expect((await mineTx.commit()).error).toBeUndefined();
      await creator.idle();
      await creator.storageManager.synced();
      pieceRootId = root.getAsNormalizedFullLink().id;
      inputDocId = input.getAsNormalizedFullLink().id;
      argMetaDocId = getMetaLink(root, "argument")!.id;
    } finally {
      await creator.dispose();
      await creatorManager.close();
    }
    // The mapping premise: the demanded id is NOT the owning root.
    expect(argMetaDocId).not.toBe(pieceRootId);

    // The demander's scoped watch on the argument doc (identity-
    // bearing) coexists with a plain space demand on the piece root
    // (the value subscription that pulls the derivation; it carries no
    // identity and mints no run of its own — scopes.md §5: the run set
    // is exactly the identity-bearing demand entries, and a coexisting
    // space demand rides those runs).
    const demander = {
      principal: "did:key:p2f-argdemander",
      sessionId: "argdemander-s1",
    };
    const stats = emptyServingLoopStats();
    const created = newSpaceServer({
      stats,
      serverFacade: demandFacade([
        { id: pieceRootId },
        { id: argMetaDocId, scope: "user", identity: demander },
      ]),
    });
    expect(await created.activate()).toBe(true);

    // The authored input: a client writes the piece's argument value;
    // the notice drives the cycle whose wave re-derives `total` — as
    // the DEMANDING instance.
    const pokerManager = EmulatedStorageManager.connectTo(server, {
      as: spaceSigner,
    });
    const poker = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: pokerManager,
    });
    try {
      const input = poker.getCell<{ n: number }>(
        space,
        "p2f-argdemand-input",
        undefined,
      );
      await input.sync();
      const pokeTx = poker.edit();
      // A key write: a whole-doc set would clobber the `mine` slot's
      // redirect the creator narrowed.
      input.key("n").withTx(pokeTx).set(2);
      expect((await pokeTx.commit()).error).toBeUndefined();
      await poker.storageManager.synced();
    } finally {
      await poker.dispose();
      await pokerManager.close();
    }
    created.enqueueCommit({
      space,
      seq: Engine.serverSeq(engine),
      class: "authored",
      sessionId: "session:p2f-argdemand-poker",
      writes: [{ id: inputDocId, scopeKey: "space" }],
    });

    // THE PIN (neutralization red: with the `#pieceRootByDemandKey`
    // match removed from `#runInstancesFor` — or the setter that feeds
    // it dropped — no instance resolves for the owning root, the run
    // falls back to the wave identity, and no acting annotation ever
    // lands): the derived commit's write annotations carry the
    // demanding (user, session).
    const actingRows = () => {
      const rows = engine.database.prepare(
        `SELECT annotations FROM "commit" WHERE class = 'derived' AND
         annotations IS NOT NULL`,
      ).all() as Array<{ annotations: string }>;
      return rows.flatMap((row) =>
        decodeMemoryBoundary(row.annotations) as unknown as Array<{
          actingUser?: string;
          actingSession?: string;
        }>
      ).filter((annotation) => annotation.actingUser !== undefined);
    };
    await awaitEach(
      cycles,
      () => actingRows().some((a) => a.actingUser === demander.principal),
    );
    // A USER-scoped instance value carries the user only (design §F,
    // RULED 2026-08-16): no session on a user-instance run's writes.
    expect(
      actingRows()
        .filter((a) => a.actingUser === demander.principal)
        .every((a) => a.actingSession === undefined),
    ).toBe(true);

    // The same run's basis rows key under the run's TRUE instance (S4,
    // server-execution v2 stage A): its DISCOVERED scope resolved against
    // the demander's identity — this derivation reads the demander's
    // per-user slot, so its rows key under the demander's user instance.
    const expectedInstanceKey = resolveScopeKey("user", demander as never);
    const basisKeys = new Set(
      (engine.database.prepare(
        `SELECT DISTINCT action_scope_key FROM scheduler_basis`,
      ).all() as Array<{ action_scope_key: string }>).map((row) =>
        row.action_scope_key
      ),
    );
    expect(basisKeys.has(expectedInstanceKey)).toBe(true);

    // The argument-doc demand RESOLVED (started through the owning
    // root) — it neither terminalized nor failed.
    expect(stats.structureLoadTerminal).toBe(0);
    expect(stats.structureLoadFailures).toBe(0);
  });

  //
  // LT6 at the events-down layer
  //
  // The same demanded-run attribution, seen where the event is emitted rather
  // than where the run is supplied.
  //

  it("LT6 at the events-down layer: an event emitted by a DEMANDED (user, session) derivation run carries the demanding actor on its durable entry — and with the supply neutral (no demanded instance) the same emission classifies userless", async () => {
    // The cross-stack blocker this pin closes (round-2, STEP 3): under
    // Phase 3 a serving-arm emission stamps the entry's `firedAt` from
    // the RUN's acting identity (cell.ts, events.md §2) — but before
    // stage P2-F no derivation run ever HAD one, so a demanded user's
    // derivation emitted userless events (`firedAt.session = "server"`,
    // no user), and delivery destroyed the actor. With the
    // per-(action × instance) run supply below us, the whole
    // production chain is drivable: demand registry → run.ts's
    // per-instance fan-out → #stampRun's acting derivation → the
    // serving-arm same-space emission → the durable entry → the drain's
    // dispatch → the handler's attribution. The pin binds the DURABLE
    // OBSERVABLES (the sidecar entry's `firedAt`, the handler
    // consequence's acting annotations), with the supply-neutral arm
    // first: the SAME emission machinery, run without a demanded
    // instance, emits the userless shape — restore the supply and the
    // actor is carried. (events.md §2; scopes.md §5; LT6 RULED
    // 2026-08-03: "events run as the session they originated from".)
    const demander = {
      principal: "did:key:lt6-demander",
      sessionId: "lt6-s1",
    };
    const demandedRoot = "of:lt6-demanded-root";
    await server.writeDocument(space, demandedRoot, { plain: 1 });

    // Stream + probe docs, created by a CLIENT runtime (client commits
    // land natively; the serving runtime's own writes must ride stamped
    // waves).
    const creatorManager = EmulatedStorageManager.connectTo(server, {
      as: spaceSigner,
    });
    const creator = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: creatorManager,
    });
    try {
      for (
        const name of [
          "lt6-stream-userless",
          "lt6-stream-demanded",
          "lt6-stream-early",
        ]
      ) {
        // A stream document holds no value, and nothing on it says what it
        // is: the handle that reaches it declares the stream.
        const stream = creator.getCell<unknown>(space, name, {
          asCell: ["stream"],
        });
        await stream.sync();
      }
      for (
        const name of [
          "lt6-probe-userless",
          "lt6-probe-demanded",
          "lt6-probe-early",
        ]
      ) {
        const probe = creator.getCell<{ handled?: number }>(
          space,
          name,
          undefined,
        );
        await probe.sync();
        const tx = creator.edit();
        probe.withTx(tx).set({});
        expect((await tx.commit()).error).toBeUndefined();
      }
      await creator.storageManager.synced();
    } finally {
      await creator.dispose();
      await creatorManager.close();
    }

    const stats = emptyServingLoopStats();
    const created = newSpaceServer({
      stats,
      serverFacade: demandFacade([
        { id: demandedRoot, scope: "user", identity: demander },
      ]),
    });
    expect(await created.activate()).toBe(true);
    const serving = servingRuntime!;
    // The demand registry has absorbed the identity-bearing demand —
    // the run supply's input.
    await awaitEach(
      cycles,
      () => created.demandedIdentitiesOf(demandedRoot).length === 1,
    );

    const cancels: Array<() => void> = [];
    try {
      const runArm = async (arm: {
        stream: string;
        probe: string;
        pieceRootId: string;
        actionId: string;

        /** The EARLY-EMIT shape (fan-out stage B): send FIRST, read user
         * scope AFTER. */
        emitBeforeRead?: boolean;
      }): Promise<{
        entry: NonNullable<StreamEventsDocValue["entries"]>[number];
      }> => {
        // The serving side's handle declares the stream: a send decides
        // stream-or-write off the handle, and the document holds no value.
        const streamCell = serving.getCell<unknown>(space, arm.stream, {
          asCell: ["stream"],
        });
        const probeCell = serving.getCell<{ handled?: number }>(
          space,
          arm.probe,
          undefined,
        );
        await streamCell.sync();
        await probeCell.sync();
        const streamLink = streamCell.getAsNormalizedFullLink();
        cancels.push(serving.scheduler.addEventHandler(
          (tx: IExtendedStorageTransaction, _event: unknown) => {
            probeCell.withTx(tx).set({ handled: 1 });
          },
          streamLink,
        ));
        // The emitting derivation, through the PRODUCTION choke points:
        // scheduler.run → run.ts's demanded-instance fan-out →
        // stampServerRun → the SpaceServer's #stampRun → the
        // serving-arm send. It reads USER-scoped state BEFORE emitting
        // (fan-out stage B, RULED 2026-08-16 — design §F: a run's actor
        // derives from the scope it discovers; a derivation that reads
        // nothing scoped is a space-scope run and its emission carries
        // no actor whoever demanded it — events.md §2's "a space-scope
        // run's carries neither").
        const userProbe = serving.getCellFromLink<{ v?: number }>({
          space,
          id: `of:lt6-user-probe-${arm.pieceRootId}` as never,
          scope: "user",
          path: [],
        });
        const action = Object.assign(
          (tx: IExtendedStorageTransaction) => {
            if (arm.emitBeforeRead) {
              streamCell.withTx(tx).send({ ping: 1 } as never);
              userProbe.withTx(tx).get();
              return;
            }
            userProbe.withTx(tx).get();
            streamCell.withTx(tx).send({ ping: 1 } as never);
          },
          {
            schedulerObservationIdentity: {
              pieceId: `space:${arm.pieceRootId}`,
              pieceRootId: arm.pieceRootId,
            },
          },
        );
        await serving.scheduler.run(action as never);
        const sidecarId = streamEntriesDocId({
          id: streamLink.id,
          path: [...streamLink.path],
        } as never);
        const entriesOf = () =>
          ((Engine.read(engine, { id: sidecarId })?.value ??
            {}) as StreamEventsDocValue).entries ?? [];
        await awaitEach(
          cycles,
          () =>
            entriesOf().length === 1 &&
            entriesOf()[0].consequenced === true,
        );
        return { entry: entriesOf()[0] };
      };

      // ARM 1 — the supply NEUTRAL (no demand entry for this root): the
      // run keeps the wave identity and the emission classifies
      // USERLESS — the pre-P2-F misclassification, still the truthful
      // shape for a chain with no actor (OW15's omitted-key posture:
      // no `user` KEY at all, session "server").
      const userless = await runArm({
        stream: "lt6-stream-userless",
        probe: "lt6-probe-userless",
        pieceRootId: "of:lt6-undemanded-root",
        actionId: "test/lt6-userless-emitter",
      });
      expect(userless.entry.firedAt).toBeDefined();
      expect("user" in userless.entry.firedAt!).toBe(false);
      expect(userless.entry.firedAt!.session).toBe("server");

      // ARM 2 — the supply LIVE: the demanded root's action runs AS the
      // demanding principal's USER instance (it read user scope), and
      // its emission carries that actor on the durable entry — the user,
      // with `session = "server"` (events.md §2: a user-instance run's
      // event carries the user with session "server"; the pair rides
      // only a session-instance run's — design §F). Pre-stage-B the
      // demand's full pair was stamped eagerly.
      const demanded = await runArm({
        stream: "lt6-stream-demanded",
        probe: "lt6-probe-demanded",
        pieceRootId: demandedRoot,
        actionId: "test/lt6-demanded-emitter",
      });
      expect(demanded.entry.firedAt?.user).toBe(demander.principal);
      expect(demanded.entry.firedAt?.session).toBe("server");

      // The classification CARRIES to the handler run (LD1: handlers
      // keep the event's actor): its consequence commit's write
      // annotations name the demanding user (no session — the event's
      // chain is user-instance-rooted).
      const actingAnnotations = () =>
        (engine.database.prepare(
          `SELECT annotations FROM "commit"
           WHERE class = 'derived' AND annotations IS NOT NULL`,
        ).all() as Array<{ annotations: string }>).flatMap((row) =>
          decodeMemoryBoundary(row.annotations) as unknown as Array<{
            actingUser?: string;
            actingSession?: string;
          }>
        ).filter((annotation) => annotation.actingUser !== undefined);
      await awaitEach(
        cycles,
        () =>
          actingAnnotations().some((a) =>
            a.actingUser === demander.principal &&
            a.actingSession === undefined
          ),
      );
      // And the userless arm never manufactured an actor anywhere.
      expect(
        actingAnnotations().every((a) => a.actingUser === demander.principal),
      ).toBe(true);

      // ARM 3 — the EARLY-EMIT GUARD (fan-out stage B, RULED 2026-08-16
      // fail-closed; design §F risk 4): the demanded run SENDS before it
      // reads user scope. Its first run's emission is attributed at the
      // ratchet SO FAR — `space`, no actor — and the run then discovers
      // `user`; the seal REFUSES that contribution (an under-attributed
      // event never commits), the node's known-scope ratchet has moved
      // to `user`, and the retry emits at the learned scope: the durable
      // entry carries the demanding USER. Mutation (the guard removed):
      // the first, userless emission commits — the entry has no `user`.
      const refusalsBefore = stats.earlyEmitRefusals;
      const early = await runArm({
        stream: "lt6-stream-early",
        probe: "lt6-probe-early",
        pieceRootId: demandedRoot,
        actionId: "test/lt6-early-emitter",
        emitBeforeRead: true,
      });
      expect(early.entry.firedAt?.user).toBe(demander.principal);
      expect(early.entry.firedAt?.session).toBe("server");
      expect(stats.earlyEmitRefusals).toBeGreaterThan(refusalsBefore);
      // Exactly one durable entry: the refused emission never landed.
      const earlySidecarId = streamEntriesDocId({
        id: serving.getCell<unknown>(space, "lt6-stream-early", undefined)
          .getAsNormalizedFullLink().id,
        path: [],
      } as never);
      const earlyEntries =
        ((Engine.read(engine, { id: earlySidecarId })?.value ??
          {}) as StreamEventsDocValue).entries ?? [];
      expect(earlyEntries.length).toBe(1);
    } finally {
      for (const cancel of cancels) cancel();
    }
  });
  it("publishes settled view producers from an exhausted wave before new input arrives", async () => {
    const current = newSpaceServer();
    await current.activate();
    const held = Promise.withResolvers<void>();
    let hold = false;
    const runtime = servingRuntime!;
    const root = runtime.getCell(space, "partial view", undefined);
    const input = runtime.getCell<number>(space, "partial input", {
      type: "number",
    });
    const fast = runtime.getCell<number>(space, "partial fast", {
      type: "number",
    });
    const slow = runtime.getCell<number>(space, "partial slow", {
      type: "number",
    });
    const cancels: (() => void)[] = [];
    const action = (id: string, run: Action): Action =>
      Object.assign(run, {
        viewNodeId: id,
        viewPiece: root.getAsNormalizedFullLink(),
        module: { type: "javascript", implementation: () => {} },
      });
    await current.runLifecycleVerb({
      name: "prepare partial view",
      run: async () => {
        const tx = runtime.edit();
        stampWaveRunContext(tx, {
          actionId: "partial-view/setup",
          kind: "bookkeeping",
        });
        input.withTx(tx).set(1);
        root.withTx(tx).set({
          $UI: {
            type: "vnode",
            name: "div",
            props: {},
            children: [fast, slow, {
              type: "vnode",
              name: "cf-input",
              props: { $value: input },
              children: [],
            }],
          },
        });
        expect((await tx.commit()).error).toBeUndefined();
        cancels.push(runtime.scheduler.register(
          action("fast", (tx) => {
            fast.withTx(tx).set(input.withTx(tx).get() * 2);
          }),
          { isEffect: true },
        ));
        cancels.push(runtime.scheduler.register(
          action("slow", (tx) => {
            const value = input.withTx(tx).get();
            const write = () => {
              slow.withTx(tx).set(value * 3);
            };
            return hold ? held.promise.then(write) : write();
          }),
          { isEffect: true },
        ));
      },
    });
    const interest: SessionViewInterest = {
      handle: {
        sessionId: "partial-viewer",
        sessionEpoch: "partial-session",
        viewEpoch: "partial-view",
        viewId: "screen",
        revision: 0,
      },
      principal: serviceSigner.did(),
      attached: true,
      view: {
        id: "screen",
        revision: 0,
        mode: "speculate",
        componentContractVersion: COMPONENT_READ_CONTRACT_VERSION,
        query: {
          roots: [{
            id: root.getAsNormalizedFullLink().id,
            selector: { path: [] },
          }],
        },
      },
    };
    const interests = stub(server, "viewInterestsForSpace", () => [interest]);
    const publications = stub(
      server,
      "setViewSelection",
      () => Promise.resolve(true),
    );
    try {
      const exhaustedBefore = lastStats.wavesBudgetExhausted;
      hold = true;
      await current.runLifecycleVerb({
        name: "change partial view input",
        run: async () => {
          const tx = runtime.edit();
          stampWaveRunContext(tx, {
            actionId: "partial-view/edit",
            kind: "bookkeeping",
          });
          input.withTx(tx).set(2);
          expect((await tx.commit()).error).toBeUndefined();
        },
      });
      expect(lastStats.wavesBudgetExhausted).toBeGreaterThan(exhaustedBefore);
      expect(publications.calls.length).toBeGreaterThan(0);
      const selection = publications.calls.at(-1)!.args[2];
      expect(
        selection.producers?.find((producer) => producer.id === "fast")?.basis,
      ).toBeDefined();
      expect(selection.producers?.find((producer) => producer.id === "slow"))
        .toBeDefined();
      expect(
        selection.producers?.find((producer) => producer.id === "slow")?.basis,
      ).toBeUndefined();
      expect(fast.get()).toBe(4);
      expect(slow.get()).toBe(3);
    } finally {
      hold = false;
      held.resolve();
      await runtime.idle();
      await current.runLifecycleVerb({
        name: "drain partial view",
        run: () => Promise.resolve(),
      });
      interests.restore();
      publications.restore();
      for (const cancel of cancels) cancel();
    }
  });
});
