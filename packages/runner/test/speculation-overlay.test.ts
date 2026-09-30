// Server-execution v2 Phase 2: the client speculation overlay
// (speculation.md), end to end against a real memory server, a live
// ExecutorHost (the serving side), and a CLIENT runtime whose flag-ON
// posture is the phase's whole point:
//
// - a client derivation run REDIRECTS its writes into the overlay — the
//   echo renders immediately, the client commits NOTHING for it, and
//   the store's only derivation results are the SpaceServer's
//   derived-class commits (the by-construction removal of the client
//   derivation-commit path);
// - `synced()` never waits on a live overlay entry (the overlay is
//   process-memory only — speculation.md §1);
// - retirement is watermark-driven (speculation.md §4): the pushed
//   derived commit + the replicated watermark doc cover the entry, the
//   overlay empties, and the STORE value renders;
// - client HANDLER runs divert to the overlay too (Phase 3 —
//   events-down; events.md §7: the F10 interim's handler-write commit
//   path is DELETED, and the fire's one authored act is the EVENT
//   append); UI-binding/imperative writes are untouched authorship;
// - a speculative run's post-commit effects follow the egress rule:
//   external-sink kinds are DROPPED (the client never performs egress
//   under the flag — README §3.5), while the reversible `navigateTo`
//   kind still enacts (optimistic navigation, speculation.md §2);
// - the runner's own piece-start instantiation reads the DURABLE view,
//   so its bookkeeping commit never names an overlay layer and the
//   piece keeps the registration its event handlers hang off, and a
//   list coordinator's resume seed reads it for the same reason — with
//   nothing to re-derive behind it, a refused seed strands the
//   coordinator on a container that never arrives.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import { Logger, type LogMessage } from "@commonfabric/utils/logger";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
  SealedCommitVerdict,
} from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { waitForSettled } from "../src/executor/watermark.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { seedResultContainerWhenPullSettles } from "../src/builtins/list-result-container-seed.ts";
import {
  ArrivalLog,
  awaitAdmitted,
  awaitReplica,
} from "./support/serving-waits.ts";
import { flushMicrotasks } from "./speculation-intent-test-utils.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  SpeculationOverlayDestination,
  stampSpeculationRunContext,
} from "../src/speculation/overlay-destination.ts";
import { EffectsChannel } from "../src/speculation/effects-channel.ts";
import {
  ignoreReadForScheduling,
  internalVerifierRead,
  isDurableReadTx,
  isInternalVerifierRead,
  isReadIgnoredForCommit,
  markDurableReadTx,
  markUiInputBlindWriteTx,
  setBlindStructuralTarget,
  unmarkUiInputBlindWriteTx,
} from "../src/storage/reactivity-log.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import { getDirectTransactionReadActivities } from "../src/storage/transaction-inspection.ts";
import { isTerminalRejection } from "../src/storage/rejection.ts";
import type { PostCommitSideEffect } from "../src/cfc/types.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { JSONSchema, Module, Pattern } from "../src/builder/types.ts";
import { type Cell, cellTx, sendEvent } from "../src/cell.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

const spaceSigner = await Identity.fromPassphrase("speculation overlay space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "speculation overlay service",
);
const aliceSigner = await Identity.fromPassphrase("speculation overlay alice");

/**
 * A logger that keeps each report as the key it was filed under and the name
 * of the error it carried, so a test that expects none names the refusal it
 * got instead of only that something was reported.
 */
class RecordingLogger extends Logger {
  readonly reports: Array<{ key: string; error?: string }> = [];

  override warn(key: string, ...messages: LogMessage[]): void {
    const carried = (messages[1] as { error?: { name?: string } } | undefined)
      ?.error;
    this.reports.push({ key, ...(carried ? { error: carried.name } : {}) });
  }
}

describe("Phase 2 speculation overlay", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let _servingRuntime: Runtime | undefined;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
          },
        });
        _servingRuntime = runtime;
        await onServingRuntime?.(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      onActivationSettled: (activatedSpace, outcome) =>
        activations.record({ space: activatedSpace, outcome }),
    });

  /** Resolves once `activatedSpace` has an ACTIVE tenure — activation
   * finishes on no admission or session edge of its own. */
  const activated = (activatedSpace: MemorySpace): Promise<unknown> =>
    activations.matching((entry) =>
      entry.space === activatedSpace && entry.outcome === "active"
    );

  let activations: ArrivalLog<{ space: string; outcome: string }>;
  let onServingRuntime: ((runtime: Runtime) => Promise<void>) | undefined;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    _servingRuntime = undefined;
    onServingRuntime = undefined;
    activations = new ArrivalLog();
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  // Kept for symmetry with the other suites; the remaining tests build
  // their clients explicitly (each pins its own flag posture).
  // deno-lint-ignore no-unused-vars
  const openClient = () => {
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    // EXPLICITLY flag-ON (review thread r3739139533): relying on the
    // host having pinned the ambient flag made the test order-dependent
    // — under an unset ambient env this runtime would run the OFF path
    // and assert authored-class commits for the wrong reason. No
    // servingPosture: a flag-ON CLIENT, speculation overlay by default.
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
  };

  const COUNTER_PATTERN = [
    "import { computed, pattern } from 'commonfabric';",
    "export default pattern<{ n: number }, { total: number }>(",
    "  ({ n }) => ({ total: computed(() => n * 7) }),",
    ");",
  ].join("\n");

  // A draft cell whose field carries an authored confidentiality
  // clause: writing through it marks the tx CFC-relevant
  // (`recordRelevantSchemaWritePolicyInput`) and the authored write
  // persists REAL stored CFC metadata — schemaHash included — onto the
  // doc, so every later write into the doc runs CFC prepare and its
  // internal-verifier read of the write-target doc fires (the
  // name-draft triage's death site). The clause only labels; it gates
  // nothing about the write.
  const DRAFT_SCHEMA = {
    type: "object",
    properties: {
      name: {
        type: "string",
        ifc: {
          confidentiality: [{
            type: "https://commonfabric.org/cfc/atom/Resource",
            class: "did",
            subject: aliceSigner.did(),
          }],
        },
      },
    },
  } as const satisfies JSONSchema;

  it("a client derivation run diverts to the overlay: instant echo with NO client commit, then watermark-driven retirement to the store value once the server serves (speculation.md §1, §4; the by-construction gate)", async () => {
    // PHASE A — the echo, deterministically BEFORE any serving exists:
    // the client runs the graph locally under the flag; the result
    // renders from the overlay and the store receives no derivation
    // commit at all (there is no code path for one).
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
    }, { space });
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "spec-arg",
      undefined,
    );
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "spec-result",
      compiled.resultSchema,
    );
    await clientArg.sync();
    await clientResult.sync();
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, clientArg, clientResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    // A live reader IS the demand (pull-based laziness): without one
    // the computed never runs anywhere.
    const cancelDemand = clientResult.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    const clientSessions = new Set<string>();
    for (
      const record of Engine.selectCommitsSince(engine, { fromSeq: 0 })
    ) {
      clientSessions.add(record.sessionId);
    }
    const commitsBefore = Engine.selectCommitsSince(engine, {
      fromSeq: 0,
    }).length;

    // The authored input: an imperative (unstamped) write — ordinary
    // authorship, committed as today.
    const editTx = clientRuntime.edit();
    clientArg.withTx(editTx).set({ n: 6 });
    expect((await editTx.commit()).error).toBeUndefined();
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // The ECHO: the client's speculative run rendered 42 with no server
    // executor in existence.
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );
    const overlay = clientRuntime.speculationOverlay;
    expect(overlay).toBeDefined();
    expect(overlay!.entryCount(space)).toBeGreaterThanOrEqual(1);

    // (synced() above already proved the overlay never wedges the
    // client durability barrier — it resolved with a live entry
    // outstanding; speculation.md §1.)

    // The by-construction half, pre-serving: the ONLY new commit since
    // the snapshot is the authored argument write. The derivation
    // committed NOTHING.
    const preServing = Engine.selectCommitsSince(engine, { fromSeq: 0 });
    expect(preServing.length).toBe(commitsBefore + 1);
    expect(preServing.every((record) => record.class !== "derived")).toBe(
      true,
    );

    // PHASE B — the authoritative path arrives: stand up the executor;
    // a fresh authored poke activates the space, the SpaceServer
    // derives, ONE derived commit lands + pushes, and the replicated
    // watermark doc covers the entries — retirement.
    onServingRuntime = async (runtime) => {
      const served = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
      }, { space });
      const argument = runtime.getCell<{ n: number }>(
        space,
        "spec-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        "spec-result",
        served.resultSchema,
      );
      await argument.sync();
      await result.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, served, argument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await runtime.idle();
    };
    host = newHost();
    const pokeTx = clientRuntime.edit();
    clientArg.withTx(pokeTx).set({ n: 8 });
    expect((await pokeTx.commit()).error).toBeUndefined();
    const pokeSeq = Engine.serverSeq(engine);
    await activated(space);
    await waitForSettled(clientRuntime, space, pokeSeq);

    // Retirement (speculation.md §4): the covering watermark retires
    // every entry; the STORE value renders through the same path.
    await overlay!.waitForSpaceQuiescence(space);
    expect(overlay!.entryCount(space)).toBe(0);
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 56,
      { stuckLabel: "the authoritative total to render as 56" },
    );

    // The single-deriver envelope (testing.md §4): every derived-class
    // commit is the lease holder's own — none from any client session.
    const all = Engine.selectCommitsSince(engine, { fromSeq: 0 });
    const derived = all.filter((record) => record.class === "derived");
    expect(derived.length).toBeGreaterThanOrEqual(1);
    for (const record of derived) {
      // testing.md §4's single-deriver envelope, BOTH halves: the
      // holder IS the lease-holding SpaceServer's service identity
      // (the DR1 holder is minted from the service DID), and no
      // client session produced it.
      expect(String(record.holder).startsWith(serviceSigner.did())).toBe(
        true,
      );
      expect(clientSessions.has(record.sessionId)).toBe(false);
    }
    cancelDemand();
  });

  it("a client handler fire commits ONLY the event: the append lands stamped, the handler write diverts to the echo (events.md §1, §7 — F10 deleted)", async () => {
    // Deliberately NO serving host: the client half must hold on its
    // own — the append lands, the handler write does not, the echo
    // renders and STAYS (no wave exists to cover it). The full loop
    // (server processes the event, consequences land, the echo
    // retires) is the serving-side suite's pin. The flag is explicit
    // (no host pinned the ambient).
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const HANDLER_PATTERN = [
      "import { handler, pattern, Stream, Writable } from 'commonfabric';",
      "const bump = handler<unknown, { value: Writable<number> }>(",
      "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
      ");",
      "export default pattern<",
      "  { value: Writable<number> },",
      "  { value: number; bump: Stream<unknown> }",
      ">(({ value }) => ({ value, bump: bump({ value }) }));",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: HANDLER_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ value: number }>(
      space,
      "handler-arg",
      undefined,
    );
    const result = clientRuntime.getCell<
      { value: number; bump: unknown }
    >(
      space,
      "handler-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      argument.withTx(seed).set({ value: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // Fire the handler client-side. Under events-down the client's ONE
    // computational commit is the EVENT APPEND (events.md §1, §7): the
    // stream's sidecar doc gains a stamped entry, and the handler's own
    // write never reaches the store — it renders as the overlay echo.
    const before = Engine.serverSeq(engine);
    const overlay = clientRuntime.speculationOverlay;
    expect(overlay).toBeDefined();
    result.key("bump").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await awaitAdmitted(server, () => {
      const records = Engine.selectCommitsSince(engine, {
        fromSeq: before,
      });
      return records.some((record) => record.class === "authored");
    });
    // The store's ONLY new state is the event: the sidecar entry is
    // stamped from the authenticated envelope (firedAt = the firing
    // session — protocol.md §2's authored event-append row), and the
    // handler's consequence doc is UNTOUCHED durably (events.md §7:
    // no client handler-write commit path exists).
    const sidecarDocs = Engine.selectPendingStreamEventDocs(engine);
    expect(sidecarDocs.length).toBe(1);
    expect(sidecarDocs[0].entries.length).toBe(1);
    const entry = sidecarDocs[0].entries[0];
    expect(typeof entry.seq).toBe("number");
    expect(entry.firedAt?.user).toBe(aliceSigner.did());
    expect(typeof entry.firedAt?.session).toBe("string");
    expect(typeof entry.firedAt?.clientSeq).toBe("number");
    const afterFire = Engine.selectCommitsSince(engine, { fromSeq: before });
    expect(afterFire.length).toBe(1);
    expect(afterFire[0].class).toBe("authored");
    // The ECHO: the handler ran locally and its write renders through
    // the overlay — a live entry tagged with the fired event's id.
    await waitForCellValue(
      clientRuntime,
      argument.key("value"),
      (value: number | undefined) => (value ?? 0) >= 1,
      { stuckLabel: "the argument's value to take the handler's write" },
    );
    expect(overlay!.entryCount(space)).toBeGreaterThanOrEqual(1);
    // The durable half of the doc the handler wrote did NOT change:
    // reading the STORE view (the engine) shows the seed value only —
    // by the cell's REAL hash-derived id, and asserting the doc EXISTS
    // (a wrong-id read would pass vacuously through `?? 0`).
    const argDoc = Engine.read(engine, {
      id: argument.getAsNormalizedFullLink().id,
    });
    expect(argDoc).not.toBeNull();
    expect((argDoc?.value as { value?: number } | undefined)?.value).toBe(0);
    cancelDemand();
  });

  it("the send settle callback NEVER reports the speculative echo as durable success: a refused append surfaces an error status; an undischarged append holds the callback (verdict blocker, 2026-08-12)", async () => {
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const HANDLER_PATTERN = [
      "import { handler, pattern, Stream, Writable } from 'commonfabric';",
      "const bump = handler<unknown, { value: Writable<number> }>(",
      "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
      ");",
      "export default pattern<",
      "  { value: Writable<number> },",
      "  { value: number; bump: Stream<unknown> }",
      ">(({ value }) => ({ value, bump: bump({ value }) }));",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: HANDLER_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ value: number }>(
      space,
      "ack-arg",
      undefined,
    );
    const result = clientRuntime.getCell<{ value: number; bump: unknown }>(
      space,
      "ack-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      argument.withTx(seed).set({ value: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    const replica = clientRuntime.storageManager.open(space).replica as {
      enqueueEventAppend?: (append: unknown) => Promise<unknown>;
    };
    const realEnqueue = replica.enqueueEventAppend!.bind(replica);
    try {
      // Arm 1 — REFUSED at admission: the callback's tx reads ERROR.
      replica.enqueueEventAppend = () =>
        Promise.resolve({ delivered: false, refused: "admission said no" });
      const refusedAcks = new ArrivalLog<void>();
      let refusedStatus:
        | { status: string; error?: { message?: string } }
        | undefined;
      sendEvent(result.key("bump"), {}, (ackTx) => {
        refusedStatus = ackTx.status();
        refusedAcks.record();
      });
      await clientRuntime.idle();
      await refusedAcks.reached(1);
      expect(refusedStatus!.status).toBe("error");
      expect(refusedStatus!.error?.message).toContain("admission said no");

      // Arm 2 — UNDISCHARGED (offline): the callback must HOLD — no
      // false durable success from the local echo. (The echo itself
      // ran: handler dispatch is local either way.)
      replica.enqueueEventAppend = () => new Promise(() => {});
      let heldFired = false;
      sendEvent(result.key("bump"), {}, () => {
        heldFired = true;
      });
      // The ack fires from the append's own commit, which the held
      // enqueue never issues; a stray one would be this runtime's work,
      // and the drain runs it.
      await clientRuntime.idle();
      expect(heldFired).toBe(false);
    } finally {
      replica.enqueueEventAppend = realEnqueue;
      cancelDemand();
    }
  });

  it("a speculative run's egress effects are dropped; navigateTo still enacts (the egress rule, README §1/§3.5; speculation.md §2)", async () => {
    // Destination-level pin: no server needed — the allowlist decision
    // is the unit under test.
    const runtime = {
      storageManager: { open: () => ({ replica: {} }) },
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);
    const flushed: string[] = [];
    const flushArrivals = new ArrivalLog<string>();
    const effectOf = (kind: string): PostCommitSideEffect => ({
      id: `${kind}:1`,
      kind,
      flush: () => {
        flushed.push(kind);
        flushArrivals.record(kind);
      },
    });
    const derivationTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(derivationTx, {
      actionId: "spec-test",
      kind: "derivation",
    });
    const owned = destination.deferSealedEffects(derivationTx, [
      effectOf("navigateTo"),
      effectOf("fetch"),
      effectOf("sqlite-query"),
    ]);
    expect(owned).toBe(true);
    await flushArrivals.reached(1);
    expect(flushed).toEqual(["navigateTo"]);

    // An event-handler echo follows the SAME egress rule since Phase 3
    // (events.md §7: the echo owns its effects — egress kinds dropped,
    // navigateTo enacts); a bookkeeping tx keeps today's inline flush.
    const handlerTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(handlerTx, {
      actionId: "spec-test-handler",
      kind: "event-handler",
    });
    expect(destination.deferSealedEffects(handlerTx, [effectOf("fetch")]))
      .toBe(true);
    const bookkeepingTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(bookkeepingTx, {
      actionId: "spec-test-bookkeeping",
      kind: "bookkeeping",
    });
    expect(
      destination.deferSealedEffects(bookkeepingTx, [effectOf("fetch")]),
    ).toBe(false);
  });

  // The two convergence tests below drive the destination directly: the
  // allowlist decision and the nonce arbitration are the units under
  // test, and neither needs a server.

  const destinationWithChannel = (): {
    destination: SpeculationOverlayDestination;
    channel: EffectsChannel;
  } => {
    const runtime = {
      storageManager: { open: () => ({ replica: {} }) },
    } as unknown as Runtime;
    const channel = new EffectsChannel(runtime);
    (runtime as { effectsChannel?: EffectsChannel }).effectsChannel = channel;
    return {
      destination: new SpeculationOverlayDestination(runtime),
      channel,
    };
  };

  const navigateEffect = (
    nonce: string,
    flush: () => void,
  ): PostCommitSideEffect => ({
    id: `navigateTo:${nonce}`,
    kind: "navigateTo",
    nonce,
    flush,
  });

  it("converges an optimistic `navigateTo` on an enactment the effects channel already made (protocol.md §5; T2.Q7)", async () => {
    // Convergence runs both ways. The overlay records an optimistic
    // enactment's nonce on the channel so a later authoritative
    // delivery converges on it; this is the other direction — the
    // authoritative intent reaching the channel first, which happens
    // whenever the served round trip beats the client's own
    // speculative run of the same handler. Enacting here navigates a
    // second time for one journey, and to the client's speculative
    // target rather than the served one, because the overlay dropped
    // the writes that target's piece would have needed.
    const { destination, channel } = destinationWithChannel();
    const enacted = "nav:already-enacted";
    // What the channel's authoritative arm does with an arriving
    // intent: take the nonce and navigate.
    expect(await channel.enactOnce(enacted, () => Promise.resolve())).toBe(
      true,
    );

    // Both effects seal in one transaction, so the second one's flush
    // is an ordered barrier: the loop decides the first before it
    // reaches the second. A fresh nonce is a different journey, and
    // still enacts.
    const fresh = "nav:not-yet-enacted";
    const flushed: string[] = [];
    const reachedFresh = Promise.withResolvers<void>();
    const derivationTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(derivationTx, {
      actionId: "spec-converge-on-authoritative",
      kind: "derivation",
    });
    expect(
      destination.deferSealedEffects(derivationTx, [
        navigateEffect(enacted, () => {
          flushed.push(enacted);
        }),
        navigateEffect(fresh, () => {
          flushed.push(fresh);
          reachedFresh.resolve();
        }),
      ]),
    ).toBe(true);
    await reachedFresh.promise;
    expect(flushed).toEqual([fresh]);
  });

  it("enacts an optimistic `navigateTo` whose in-flight enactment failed, and stands down for one that succeeds (protocol.md §5)", async () => {
    // A record taken before its enactment settles is a prediction, not
    // a fact: a failed enactment retracts its record and leaves the
    // durable entry unacked for a later delivery. Standing down on a
    // prediction that did not come true loses the navigation, since a
    // quiet space commits nothing else to deliver that entry on.
    const { destination, channel } = destinationWithChannel();
    const failing = "nav:in-flight-fails";
    const succeeding = "nav:in-flight-succeeds";
    const failure = Promise.withResolvers<void>();
    const success = Promise.withResolvers<void>();
    const authoritative = Promise.all([
      channel.enactOnce(failing, () => failure.promise),
      channel.enactOnce(succeeding, () => success.promise),
    ]);

    const flushed: string[] = [];
    const reachedBarrier = Promise.withResolvers<void>();
    const derivationTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(derivationTx, {
      actionId: "spec-converge-in-flight",
      kind: "derivation",
    });
    expect(
      destination.deferSealedEffects(derivationTx, [
        navigateEffect(failing, () => {
          flushed.push(failing);
        }),
        navigateEffect(succeeding, () => {
          flushed.push(succeeding);
        }),
        navigateEffect("nav:barrier", () => {
          reachedBarrier.resolve();
        }),
      ]),
    ).toBe(true);
    // Both enactments are still in flight, so the overlay is waiting on
    // the first rather than assuming its outcome.
    expect(flushed).toEqual([]);

    failure.reject(new Error("enactment failed (test-injected)"));
    success.resolve();
    expect(await authoritative).toEqual([false, true]);
    await reachedBarrier.promise;
    expect(flushed).toEqual([failing]);
  });

  it("records the nonce before the enactment runs, so work that enacts synchronously cannot be enacted twice (protocol.md §5)", async () => {
    // The record has to be installed before the callback can observe
    // it. A navigation callback that enacts synchronously, or that
    // re-enters a delivery before returning its promise, meets the
    // record rather than a gap; a callback that throws synchronously
    // resolves as a failed enactment rather than escaping as a throw.
    const { destination, channel } = destinationWithChannel();
    const nonce = "nav:synchronous";
    const seen: boolean[] = [];
    const enacted = await channel.enactOnce(nonce, () => {
      // What a re-entrant delivery would find mid-enactment.
      seen.push(channel.hasEnacted(nonce));
      return Promise.resolve();
    });
    expect(enacted).toBe(true);
    expect(seen).toEqual([true]);

    const flushed: string[] = [];
    const reachedBarrier = Promise.withResolvers<void>();
    const derivationTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(derivationTx, {
      actionId: "spec-record-before-work",
      kind: "derivation",
    });
    expect(
      destination.deferSealedEffects(derivationTx, [
        navigateEffect(nonce, () => {
          flushed.push(nonce);
        }),
        navigateEffect("nav:barrier", () => {
          reachedBarrier.resolve();
        }),
      ]),
    ).toBe(true);
    await reachedBarrier.promise;
    expect(flushed).toEqual([]);

    // A synchronous throw is the enactment failing, not an escaping
    // exception, so the record retracts and a caller may enact again.
    const throwing = "nav:throws-synchronously";
    expect(
      await channel.enactOnce(throwing, () => {
        throw new Error("enactment failed (test-injected)");
      }),
    ).toBe(false);
    expect(channel.hasEnacted(throwing)).toBe(false);
  });

  it("the llm-dialog tool loop's egress is dropped under speculation (review 2026-08-11 m5): the claimed updateArgument mitigation, asserted", async () => {
    // llm-dialog's turn starts as a `llmDialog-start` sink-request
    // post-commit effect (llm-dialog.ts's
    // enqueueSinkRequestPostCommitEffect). Under speculation that
    // egress must DROP — the tool loop (and with it every tool
    // mutation, updateArgument included) runs only in the server's
    // authoritative run. This was the claimed m5 mitigation; nothing
    // asserted it before this pin.
    const runtime = {
      storageManager: { open: () => ({ replica: {} }) },
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);
    const flushed: string[] = [];
    const dialogStart: PostCommitSideEffect = {
      id: "llmDialog:req-1",
      kind: "llmDialog-start",
      flush: () => {
        flushed.push("llmDialog-start");
      },
    };
    const handlerTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(handlerTx, {
      actionId: "spec-llm-dialog",
      kind: "event-handler",
      eventId: "evt-llm-turn",
    });
    // Owned by the overlay (a speculative run), and NEVER flushed.
    expect(destination.deferSealedEffects(handlerTx, [dialogStart])).toBe(
      true,
    );
    await flushMicrotasks();
    expect(flushed).toEqual([]);
  });

  it("the overlay REFUSES an event-handler seal lacking an eventId (review 2026-08-11 m5): silent loss surfaces as a loud commit error", async () => {
    // An event-handler seal carrying no eventId (llm-dialog's
    // updateArgument is one) has NO intent to retire against. Diverted
    // on a flag-ON client into an overlay entry, it would report ok
    // while nothing landed and no server run reproduced it, so the
    // overlay refuses the seal loudly instead.
    const runtime = {
      storageManager: { open: () => ({ replica: {} }) },
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);

    const noEventTx = { tx: {} } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(noEventTx, {
      actionId: "llm-dialog/update-argument",
      kind: "event-handler",
    });
    const refused = await destination.seal(noEventTx);
    expect(refused.error).toBeDefined();
    expect(refused.error?.message).toContain("no eventId");
    expect(refused.error?.message).toContain("silently lost");

    // The SAME seal WITH an eventId passes the refusal and proceeds to
    // the next gate (this bare fake tx has no seal support, so it hits
    // the fail-closed sealing arm — a DIFFERENT error).
    const withEventTx = { tx: {} } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(withEventTx, {
      actionId: "spec-handler-with-event",
      kind: "event-handler",
      eventId: "evt-has-id",
    });
    const sealed = await destination.seal(withEventTx);
    expect(sealed.error).toBeDefined();
    expect(sealed.error?.message).toContain("does not support sealing");

    // A transaction that CAN seal but cannot take the whole-document mark
    // is refused on the same footing: its ops would be patches, which
    // compose with the layer beneath them (speculation.md §1). Named
    // separately from the sealing arm so the refusal says which.
    const patchOnlyTx = {
      tx: { sealInto: () => Promise.resolve({ ok: {} }) },
    } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(patchOnlyTx, {
      actionId: "spec-derivation-patch-only",
      kind: "derivation",
    });
    const patchOnly = await destination.seal(patchOnlyTx);
    expect(patchOnly.error).toBeDefined();
    expect(patchOnly.error?.message).toContain(
      "does not support whole-document writes",
    );
  });

  it("an authored tx that read a speculative echo is refused LOUDLY at the client, terminal, with no wire export (speculation.md §6; leg-C RULED 2026-08-13)", async () => {
    // A commit exporting the echo's overlay-only localSeq as a wire
    // pending-read dependency would be rejected by the server — which
    // cannot distinguish never-coming from not-yet-arrived — with
    // `pending dependency not resolved: <seq>`, and the scheduler's
    // convergence loop would spin its whole retry window against the
    // same live echo.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
    }, { space });
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "basis-arg",
      undefined,
    );
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "basis-result",
      compiled.resultSchema,
    );
    await clientArg.sync();
    await clientResult.sync();
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, clientArg, clientResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = clientResult.sink(() => {});
    await clientRuntime.idle();
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 6 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );
    const overlay = clientRuntime.speculationOverlay!;
    expect(overlay.entryCount(space)).toBeGreaterThanOrEqual(1);
    const commitsBefore =
      Engine.selectCommitsSince(engine, { fromSeq: 0 }).length;

    // The authored act: an unstamped tx reads the echo and writes a
    // copy elsewhere.
    const copyCell = clientRuntime.getCell<{ copied: number }>(
      space,
      "basis-copy",
      undefined,
    );
    await copyCell.sync();
    const authoredTx = clientRuntime.edit();
    const observed = clientResult.withTx(authoredTx).key("total").get();
    expect(observed).toBe(42);
    copyCell.withTx(authoredTx).set({ copied: observed as number });
    const outcome = await authoredTx.commit();

    // LOUD and terminal-classified — the client's own refusal, not a
    // server round trip.
    expect(outcome.error).toBeDefined();
    expect(outcome.error!.name).toBe("SpeculativeBasisError");
    expect(outcome.error!.message).toContain("speculative overlay layer");
    expect(isTerminalRejection(outcome.error)).toBe(true);
    // Nothing reached the wire: the engine saw no commit attempt land,
    // and the echo is untouched (the refusal is not a withdrawal).
    expect(Engine.selectCommitsSince(engine, { fromSeq: 0 }).length).toBe(
      commitsBefore,
    );
    expect(overlay.entryCount(space)).toBeGreaterThanOrEqual(1);
    // The refused write never rendered (refusal precedes the
    // optimistic apply) — no flicker, no revert.
    expect(copyCell.get()?.copied).toBeUndefined();
    cancelDemand();
  });

  it("a blind UI-input write into a doc carrying a speculative layer EXPORTS — user input is never terminally refused for a process-local echo (verification-coverage.md OW47; the cellset-lww own-write shape)", async () => {
    // The OW47 client own-write durability seam (rootcause §2b; the
    // cellset-lww end-to-end step; cfc-group-chat-demo's local shape —
    // Bob's messageDraft): a USER's blind `$value` binding write
    // (handleCellSet) into a doc on which one of the client's OWN
    // speculation echoes still stands was refused TERMINALLY
    // (`speculative-basis-refused`) and silently dropped. The blind
    // write consumes NO overlay value — its only conflict-set read is
    // the structural nonRecursive read at the cell's PARENT — but
    // buildReads named every pending layer of that doc, speculative
    // ones included, so the export refusal fired on a read that carries
    // no value dependency. An echo's standing window is at least a full
    // served round trip (the arrival gate holds it until every doc it
    // wrote is confirmed), and unbounded for a never-served instance,
    // so "user typed while an echo stood" is a routine state, not a
    // race. The fix: the structural read bases on the doc's
    // NON-speculative stack (speculative layers are excluded from its
    // named layers — they are process-local render state, not a data
    // dependency, and they never reach the wire as commits the server
    // could sequence against). The §6 export-refusal ruling is
    // untouched for value-consuming reads — the test above pins it.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
    }, { space });
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "own-write-arg",
      undefined,
    );
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "own-write-result",
      compiled.resultSchema,
    );
    await clientArg.sync();
    await clientResult.sync();
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, clientArg, clientResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = clientResult.sink(() => {});
    await clientRuntime.idle();
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 6 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );
    const overlay = clientRuntime.speculationOverlay!;
    const echoEntries = overlay.entryCount(space);
    expect(echoEntries).toBeGreaterThanOrEqual(1);
    const commitsBefore =
      Engine.selectCommitsSince(engine, { fromSeq: 0 }).length;

    // The USER act, exactly handleCellSet's shape (runtime-processor.ts;
    // the multi-runtime worker mirrors it): mark the tx blind, thread
    // the cell's PARENT as the structural precondition, set, commit.
    // The target doc is the one the echo wrote.
    const totalCell = clientResult.key("total");
    const blindTx = clientRuntime.edit();
    markUiInputBlindWriteTx(blindTx);
    const link = totalCell.withTx(blindTx).resolveAsCell()
      .getAsNormalizedFullLink();
    setBlindStructuralTarget(blindTx, {
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path.slice(0, -1),
    });
    totalCell.withTx(blindTx).set(777);
    unmarkUiInputBlindWriteTx(blindTx);
    clientRuntime.prepareTxForCommit(blindTx);
    const outcome = await blindTx.commit();

    // The write exports — no SpeculativeBasisError, no silent drop.
    expect(outcome.error).toBeUndefined();
    await clientRuntime.storageManager.synced();

    // Exactly ONE new engine commit: the write landed once — nothing is
    // re-issued, so nothing can double-apply (the which-direction hazard
    // both ways: no loss, no duplicate).
    const after = Engine.selectCommitsSince(engine, { fromSeq: 0 });
    expect(after.length).toBe(commitsBefore + 1);

    // The DURABLE truth holds the typed value: read through a fresh
    // reader with no overlay (the writing client's own render keeps
    // reading its echo until retirement — that is the overlay's job,
    // not a durability property).
    const readerManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerManager,
    });
    try {
      const readerResult = readerRuntime.getCell<{ total: number }>(
        space,
        "own-write-result",
        compiled.resultSchema,
      );
      await readerResult.sync();
      await waitForCellValue(
        readerRuntime,
        readerResult.key("total"),
        (total: number | undefined) => total === 777,
        { stuckLabel: "the reader's total to reach 777" },
      );
    } finally {
      await readerRuntime.dispose();
      await readerManager.close();
    }

    // The echo itself is untouched: the exclusion is in the exported
    // BASIS, never a withdrawal — retirement stays the overlay's
    // arrival-gated business (speculation.md §4).
    expect(overlay.entryCount(space)).toBe(echoEntries);
    cancelDemand();
  });

  it("a CFC-RELEVANT blind UI-input write into a doc carrying a speculative layer EXPORTS — the internal-verifier read bases on the non-speculative stack (verification-coverage.md OW47 second producer; the name-draft shape; RULED 2026-08-21)", async () => {
    // The OW47 family's SECOND layer-naming producer (the name-draft
    // own-write loss triage, docs/history/plans/server-execution-v2/
    // optimize/name-draft-loss-triage.md): when the blind write's
    // target is CFC-relevant, CFC prepare's internal-verifier read of
    // the write-target doc (`storedMetadataFor`, path [], recursive,
    // issued AFTER `unmarkUiInputBlindWriteTx` by design) entered the
    // commit set with no exclusion, so under a standing own-echo the
    // basis named the echo layer and the §6 export refusal killed the
    // USER's typed input terminally — while the structural read (the
    // test above) was already excluded. The ruled fix (arm (b),
    // 2026-08-21): the blind-write tx's verifier reads base on the
    // doc's NON-speculative stack — the value they verify AND the
    // basis they contribute — so the verifier verifies exactly the
    // durable policy state the server will enforce against. The
    // refusal is UNTOUCHED for value-consuming and for non-blind
    // transactions (the tests beside this one pin both directions).
    //
    // Shape: a plain draft cell whose field carries an authored
    // confidentiality clause — the authored pre-write persists REAL
    // stored CFC metadata (schemaHash included) onto the doc, so the
    // later UI fill is CFC-relevant end to end. The standing echo is
    // sealed onto the replica exactly as the overlay destination seals
    // one (`sealNative`, speculative, verdict pending) — the layer
    // state §6 and `buildReads` consult is identical to a pattern
    // echo's.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const draft = clientRuntime.getCell<{ name: string }>(
      space,
      "verifier-draft",
      DRAFT_SCHEMA,
    );
    await draft.sync();
    {
      const tx = clientRuntime.edit();
      draft.withTx(tx).set({ name: "durable-name" });
      clientRuntime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();
    const draftLink = draft.getAsNormalizedFullLink();

    // Setup guard: the authored labeled write persisted stored CFC
    // metadata onto the draft doc — without it the fill below would
    // not be CFC-relevant and the pin would be vacuous.
    {
      const guardTx = clientRuntime.edit();
      expect(readStoredCfcMetadata(guardTx, draftLink)).toBeDefined();
      await guardTx.commit();
    }

    // The standing seed echo: a SPECULATIVE overlay layer over the
    // draft doc, verdict pending — the arrival-gated window the triage
    // measured at a full served round trip.
    const replica = clientManager.open(space).replica;
    const durableDoc = replica.getDocument(draftLink.id, draftLink.scope);
    expect(durableDoc).toBeDefined();
    replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: draftLink.id,
          type: "application/json",
          value: {
            ...(durableDoc as Record<string, unknown>),
            value: { name: "seed-echo" },
          },
        }],
      },
      undefined,
      new Promise(() => {}),
      { speculative: true },
    );
    expect(draft.key("name").get()).toBe("seed-echo");
    const commitsBefore =
      Engine.selectCommitsSince(engine, { fromSeq: 0 }).length;

    // The USER act, exactly handleCellSet's shape (runtime-processor.ts):
    // mark the tx blind, thread the cell's PARENT as the structural
    // precondition, set, unmark, prepare, commit.
    const nameCell = draft.key("name");
    const blindTx = clientRuntime.edit();
    markUiInputBlindWriteTx(blindTx);
    const link = nameCell.withTx(blindTx).resolveAsCell()
      .getAsNormalizedFullLink();
    setBlindStructuralTarget(blindTx, {
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path.slice(0, -1),
    });
    nameCell.withTx(blindTx).set("typed-name");
    unmarkUiInputBlindWriteTx(blindTx);
    // Vacuity guard: the pin only pins the death site if CFC prepare
    // actually runs on this tx.
    expect(blindTx.getCfcState().relevant).toBe(true);
    clientRuntime.prepareTxForCommit(blindTx);
    // The verifier read's commit-time SHAPE (the triage's arm (c), the
    // path half of the ruled arm (b)): the stored-metadata read of the
    // write-target doc is scoped to the /cfc it consumes — a path-[]
    // recursive read made the whole document a value dependency, so a
    // concurrent value write between the reader's lagging confirmed
    // basis and the server head (the echo's arrival window IS that lag)
    // conflicted the fill server-side as a stale confirmed read. The
    // commit-set verifier reads of the target doc must sit at ["cfc"],
    // never at the doc root.
    const verifierReads = [
      ...(getDirectTransactionReadActivities(blindTx) ?? []),
    ].filter((read) =>
      read.id === link.id &&
      isInternalVerifierRead(read.meta) &&
      !isReadIgnoredForCommit(read.meta)
    );
    expect(verifierReads.length).toBeGreaterThanOrEqual(1);
    for (const read of verifierReads) {
      expect(read.path).toEqual(["cfc"]);
    }
    const outcome = await blindTx.commit();

    // The write exports — no SpeculativeBasisError, no silent drop.
    expect(outcome.error).toBeUndefined();
    await clientRuntime.storageManager.synced();

    // Exactly ONE new engine commit: nothing is re-issued, so nothing
    // can double-apply (the which-direction hazard both ways).
    const after = Engine.selectCommitsSince(engine, { fromSeq: 0 });
    expect(after.length).toBe(commitsBefore + 1);

    // The DURABLE truth holds the typed value, read through a fresh
    // overlay-free reader.
    const readerManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerManager,
    });
    try {
      const readerDraft = readerRuntime.getCell<{ name: string }>(
        space,
        "verifier-draft",
        DRAFT_SCHEMA,
      );
      await readerDraft.sync();
      await waitForCellValue(
        readerRuntime,
        readerDraft.key("name"),
        (name: string | undefined) => name === "typed-name",
        { stuckLabel: "the reader to see the typed draft name" },
      );
    } finally {
      await readerRuntime.dispose();
      await readerManager.close();
    }

    // The echo is untouched — basis exclusion, never a withdrawal: the
    // speculative layer still stands on the doc (its verdict is
    // pending).
    expect(
      replica.speculationRetirementView!(draftLink.id, draftLink.scope)
        .pendingLocalSeqs.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("a blind write whose stored schema doc is staged ONLY by the standing echo still EXPORTS — content-addressed reads are layer-indifferent, exempt from durable serving (the profile-embed run-3 live signature)", async () => {
    // The refinement the first live gate forced: the durable-basis rule
    // must NOT extend to CONTENT-ADDRESSED reads. During an echo's
    // arrival window the client's durable view can lack a `cid:` schema
    // doc the echo's own staging carries (the covering SERVED commit
    // already persisted the same doc server-side — that lag IS why the
    // echo still stands), and serving the verifier "durably absent"
    // there turned the user's fill into CFC prepare's silent
    // `stored schemaHash … missing or unreadable` abort — the same
    // observable loss §6's refusal produced, one layer deeper. A cid:
    // doc's content is identical on EVERY layer (the replica refuses
    // content that does not hash to its id), so the ordinary
    // (overlay-inclusive) view IS the durable content: the verifier
    // may consume it while its layers stay excluded from the blind
    // tx's basis — consistent by construction.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const draft = clientRuntime.getCell<{ name: string }>(
      space,
      "cid-staged-draft",
      DRAFT_SCHEMA,
    );
    await draft.sync();
    {
      const tx = clientRuntime.edit();
      draft.withTx(tx).set({ name: "durable-name" });
      clientRuntime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();
    const draftLink = draft.getAsNormalizedFullLink();

    // Re-point the draft doc's DURABLE stored metadata at a schema whose
    // cid: doc is NOT durably present anywhere — the ungated path-[]
    // full-document write (the seeding shape hydration uses; a direct
    // ["cfc"] write is refused as label forgery).
    const stagedSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    } as const;
    const stagedHash = internSchemaAsTaggedHashString(stagedSchema);
    // The covering install, FIRST: a commit either carries its closure or
    // stands on the space already holding it (the memory boundary
    // refuses metadata naming a document it cannot see). The store-proven
    // live shape had the server holding the doc while the client's views
    // lagged — this writer session is that covering install.
    {
      const writerManager = EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      const writerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerManager,
      });
      try {
        const tx = writerRuntime.edit();
        tx.writeOrThrow({
          space,
          id: `cid:${stagedHash}` as never,
          type: "application/json",
          path: [],
        }, { value: stagedSchema });
        expect((await tx.commit()).error).toBeUndefined();
        await writerRuntime.storageManager.synced();
      } finally {
        await writerRuntime.dispose();
        await writerManager.close();
      }
    }
    {
      const seedTx = clientRuntime.edit();
      const docAddress = {
        space,
        id: draftLink.id,
        scope: draftLink.scope,
        type: "application/json" as const,
        path: [],
      };
      const current = seedTx.readOrThrow(docAddress);
      const base = current && typeof current === "object" ? current : {};
      seedStoredEnvelope(seedTx, docAddress, {
        ...base,
        cfc: {
          version: 1,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: {}, origin: "declared" }],
          },
          schemaHash: stagedHash,
        },
      });
      expect((await seedTx.commit()).error).toBeUndefined();
      await clientRuntime.storageManager.synced();
    }

    // The standing echo: ONE speculative layer carrying the seed value
    // AND the staged schema doc — exactly the shape a speculative
    // handler run seals (its `#stageSchemaDocsForValue` staging rides
    // the same layer). `cid:${stagedHash}` exists ONLY here.
    const replica = clientManager.open(space).replica;
    const durableDoc = replica.getDocument(draftLink.id, draftLink.scope);
    expect(durableDoc).toBeDefined();
    replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: draftLink.id,
          type: "application/json",
          value: {
            ...(durableDoc as Record<string, unknown>),
            value: { name: "seed-echo" },
          },
        }, {
          op: "set",
          id: `cid:${stagedHash}` as never,
          type: "application/json",
          value: { value: stagedSchema },
        }],
      },
      undefined,
      new Promise(() => {}),
      { speculative: true },
    );
    expect(draft.key("name").get()).toBe("seed-echo");
    const commitsBefore =
      Engine.selectCommitsSince(engine, { fromSeq: 0 }).length;

    const nameCell = draft.key("name");
    const blindTx = clientRuntime.edit();
    markUiInputBlindWriteTx(blindTx);
    const link = nameCell.withTx(blindTx).resolveAsCell()
      .getAsNormalizedFullLink();
    setBlindStructuralTarget(blindTx, {
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path.slice(0, -1),
    });
    nameCell.withTx(blindTx).set("typed-name");
    unmarkUiInputBlindWriteTx(blindTx);
    expect(blindTx.getCfcState().relevant).toBe(true);
    clientRuntime.prepareTxForCommit(blindTx);
    const outcome = await blindTx.commit();

    // The fill survives: no silent `stored schemaHash … missing or
    // unreadable` abort, no §6 refusal — one exported commit, the
    // typed value durable.
    expect(outcome.error).toBeUndefined();
    await clientRuntime.storageManager.synced();
    const after = Engine.selectCommitsSince(engine, { fromSeq: 0 });
    expect(after.length).toBe(commitsBefore + 1);

    const readerManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerManager,
    });
    try {
      const readerDraft = readerRuntime.getCell<{ name: string }>(
        space,
        "cid-staged-draft",
        DRAFT_SCHEMA,
      );
      await readerDraft.sync();
      await waitForCellValue(
        readerRuntime,
        readerDraft.key("name"),
        (name: string | undefined) => name === "typed-name",
        { stuckLabel: "the reader to see the typed draft name" },
      );
    } finally {
      await readerRuntime.dispose();
      await readerManager.close();
    }
  });

  it("a blind write whose DURABLE stored schemaHash resolves in NO replica view still EXPORTS via the realm schema registry — whoever stamped the metadata held the content (the profile-embed run-2 live signature)", async () => {
    // The second resolution gap the live gate surfaced: a frame
    // delivers a doc's `/cfc` metadata WITHOUT its schemaHash refs, so
    // the client's durable view can reference a schema document no
    // replica view holds — durable OR overlay (store-proven: the
    // server held `cid:<hash>` as a head while the client's prepare
    // died on it). Content addressing makes resolution
    // location-indifferent: the realm registry holds only content
    // verified against its hash, and `ensureSchemaDocument` registers
    // at the STAMPING site (production's echo stamps the same hash it
    // references, in this same session), so `loadSchemaDocument` falls
    // back to the registry instead of killing the user's fill on a
    // resolution gap — the triage's flagged "missing or unreadable"
    // silent-worker class. This pin registers directly, standing in
    // for the stamper's session.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const draft = clientRuntime.getCell<{ name: string }>(
      space,
      "registry-draft",
      DRAFT_SCHEMA,
    );
    await draft.sync();
    {
      const tx = clientRuntime.edit();
      draft.withTx(tx).set({ name: "durable-name" });
      clientRuntime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();
    const draftLink = draft.getAsNormalizedFullLink();

    // The stored metadata references a schema document held by NO view:
    // registered in the realm registry only (the stamper's session).
    const registryOnlySchema = {
      type: "object",
      properties: { name: { type: "string" }, registryPin: { type: "number" } },
    } as const;
    const registryOnlyHash = internSchemaAsTaggedHashString(
      registryOnlySchema,
    );
    registerSchemaDocument(registryOnlyHash, registryOnlySchema);
    // The covering install, FIRST: a commit either carries its closure or
    // stands on the space already holding it (the memory boundary
    // refuses metadata naming a document it cannot see). The store-proven
    // live shape had the server holding the doc while the client's views
    // lagged — this writer session is that covering install.
    {
      const writerManager = EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      const writerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerManager,
      });
      try {
        const tx = writerRuntime.edit();
        tx.writeOrThrow({
          space,
          id: `cid:${registryOnlyHash}` as never,
          type: "application/json",
          path: [],
        }, { value: registryOnlySchema });
        expect((await tx.commit()).error).toBeUndefined();
        await writerRuntime.storageManager.synced();
      } finally {
        await writerRuntime.dispose();
        await writerManager.close();
      }
    }
    {
      const seedTx = clientRuntime.edit();
      const docAddress = {
        space,
        id: draftLink.id,
        scope: draftLink.scope,
        type: "application/json" as const,
        path: [],
      };
      const current = seedTx.readOrThrow(docAddress);
      const base = current && typeof current === "object" ? current : {};
      seedStoredEnvelope(seedTx, docAddress, {
        ...base,
        cfc: {
          version: 1,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: {}, origin: "declared" }],
          },
          schemaHash: registryOnlyHash,
        },
      });
      expect((await seedTx.commit()).error).toBeUndefined();
      await clientRuntime.storageManager.synced();
    }

    // The standing echo: value-only, exactly the traced seed shape.
    const replica = clientManager.open(space).replica;
    const durableDoc = replica.getDocument(draftLink.id, draftLink.scope);
    expect(durableDoc).toBeDefined();
    replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: draftLink.id,
          type: "application/json",
          value: {
            ...(durableDoc as Record<string, unknown>),
            value: { name: "seed-echo" },
          },
        }],
      },
      undefined,
      new Promise(() => {}),
      { speculative: true },
    );
    expect(draft.key("name").get()).toBe("seed-echo");
    const commitsBefore =
      Engine.selectCommitsSince(engine, { fromSeq: 0 }).length;

    const nameCell = draft.key("name");
    const blindTx = clientRuntime.edit();
    markUiInputBlindWriteTx(blindTx);
    const link = nameCell.withTx(blindTx).resolveAsCell()
      .getAsNormalizedFullLink();
    setBlindStructuralTarget(blindTx, {
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path.slice(0, -1),
    });
    nameCell.withTx(blindTx).set("typed-name");
    unmarkUiInputBlindWriteTx(blindTx);
    expect(blindTx.getCfcState().relevant).toBe(true);
    clientRuntime.prepareTxForCommit(blindTx);
    const outcome = await blindTx.commit();

    // The fill survives: the registry supplied the verified content, no
    // silent abort, no §6 refusal — one exported commit, durable value.
    expect(outcome.error).toBeUndefined();
    await clientRuntime.storageManager.synced();
    const after = Engine.selectCommitsSince(engine, { fromSeq: 0 });
    expect(after.length).toBe(commitsBefore + 1);

    const readerManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerManager,
    });
    try {
      const readerDraft = readerRuntime.getCell<{ name: string }>(
        space,
        "registry-draft",
        DRAFT_SCHEMA,
      );
      await readerDraft.sync();
      await waitForCellValue(
        readerRuntime,
        readerDraft.key("name"),
        (name: string | undefined) => name === "typed-name",
        { stuckLabel: "the reader to see the typed draft name" },
      );
    } finally {
      await readerRuntime.dispose();
      await readerManager.close();
    }
  });

  it("a blind fill resolving its stored schema from the registry while the ENGINE already holds the cid: doc still EXPORTS — content-addressed reads carry no confirmed-seq precondition (the review's probe-1)", async () => {
    // The seq half of content-addressed layer-indifference: a registry-
    // (or overlay-) resolved schema read leaves the replica's confirmed
    // basis for the cid: doc at 0, while the doc's FIRST INSTALL is a
    // real revision row and the engine's staleness scan has no
    // content-addressed carve-out. Were the commit to export
    // `confirmed {seq: 0}` for it, then in the delivery-gap window with
    // the doc already server-installed by ANOTHER session the fill would
    // die `ConflictError: stale confirmed read: cid:… at seq 0
    // conflicted with seq N`, silently (the discarded commit promise);
    // the resolution-gap pins cannot see that, because they leave the
    // engine EMPTY at the hash, and a seq-0 confirmed read of an absent
    // doc is satisfiable. So `buildReads` leaves cid: reads out of the
    // commit conflict set entirely: content under a content-addressed id
    // can never change — the engine's own rule — so there is no
    // staleness for the scan to find; server-side closure validation
    // owns presence.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const draft = clientRuntime.getCell<{ name: string }>(
      space,
      "engine-installed-draft",
      DRAFT_SCHEMA,
    );
    await draft.sync();
    {
      const tx = clientRuntime.edit();
      draft.withTx(tx).set({ name: "durable-name" });
      clientRuntime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();
    const draftLink = draft.getAsNormalizedFullLink();

    const installedSchema = {
      type: "object",
      properties: { name: { type: "string" }, probeOne: { type: "number" } },
    } as const;
    const installedHash = internSchemaAsTaggedHashString(installedSchema);
    registerSchemaDocument(installedHash, installedSchema);
    // A SECOND session installs the schema document in the ENGINE,
    // FIRST — the doc's first revision row, in place before any commit
    // references it (a commit either carries its closure or stands on
    // the space already holding it). With the install preceding the
    // reference, this harness's frames attach the installed doc, so the
    // client replica may hold it and a seq-0 registry-resolution premise
    // is not constructible through commits — this pin is an end-to-end
    // net over the fill.
    {
      const writerManager = EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      const writerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerManager,
      });
      try {
        const tx = writerRuntime.edit();
        tx.writeOrThrow({
          space,
          id: `cid:${installedHash}` as never,
          type: "application/json",
          path: [],
        }, { value: installedSchema });
        expect((await tx.commit()).error).toBeUndefined();
        await writerRuntime.storageManager.synced();
      } finally {
        await writerRuntime.dispose();
        await writerManager.close();
      }
    }
    {
      const seedTx = clientRuntime.edit();
      const docAddress = {
        space,
        id: draftLink.id,
        scope: draftLink.scope,
        type: "application/json" as const,
        path: [],
      };
      const current = seedTx.readOrThrow(docAddress);
      const base = current && typeof current === "object" ? current : {};
      seedStoredEnvelope(seedTx, docAddress, {
        ...base,
        cfc: {
          version: 1,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: {}, origin: "declared" }],
          },
          schemaHash: installedHash,
        },
      });
      expect((await seedTx.commit()).error).toBeUndefined();
      await clientRuntime.storageManager.synced();
    }

    // The standing echo, then the fill.
    const replica = clientManager.open(space).replica;
    const durableDoc = replica.getDocument(draftLink.id, draftLink.scope);
    expect(durableDoc).toBeDefined();
    replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: draftLink.id,
          type: "application/json",
          value: {
            ...(durableDoc as Record<string, unknown>),
            value: { name: "seed-echo" },
          },
        }],
      },
      undefined,
      new Promise(() => {}),
      { speculative: true },
    );
    expect(draft.key("name").get()).toBe("seed-echo");
    const commitsBefore =
      Engine.selectCommitsSince(engine, { fromSeq: 0 }).length;

    const nameCell = draft.key("name");
    const blindTx = clientRuntime.edit();
    markUiInputBlindWriteTx(blindTx);
    const link = nameCell.withTx(blindTx).resolveAsCell()
      .getAsNormalizedFullLink();
    setBlindStructuralTarget(blindTx, {
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path.slice(0, -1),
    });
    nameCell.withTx(blindTx).set("typed-name");
    unmarkUiInputBlindWriteTx(blindTx);
    expect(blindTx.getCfcState().relevant).toBe(true);
    clientRuntime.prepareTxForCommit(blindTx);
    const outcome = await blindTx.commit();

    // No stale-confirmed-read conflict on the cid: doc: the write
    // exports and lands.
    expect(outcome.error).toBeUndefined();
    await clientRuntime.storageManager.synced();
    const after = Engine.selectCommitsSince(engine, { fromSeq: 0 });
    expect(after.length).toBe(commitsBefore + 1);

    const readerManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerManager,
    });
    try {
      const readerDraft = readerRuntime.getCell<{ name: string }>(
        space,
        "engine-installed-draft",
        DRAFT_SCHEMA,
      );
      await readerDraft.sync();
      await waitForCellValue(
        readerRuntime,
        readerDraft.key("name"),
        (name: string | undefined) => name === "typed-name",
        { stuckLabel: "the reader to see the typed draft name" },
      );
    } finally {
      await readerRuntime.dispose();
      await readerManager.close();
    }
  });

  it("resolves a frame's schema reference end to end through kick, pull, and install", async () => {
    // The dedupe's contract half: `#kickedCfcSchemaPulls` clears its
    // entry on an empty completion, not on a pull ERROR alone. A pull
    // that SUCCEEDS without delivering — the document not yet installed
    // server-side, a legal state — would otherwise retain its entry
    // forever, later frames would skip the re-kick, and the delivery-gap
    // window would become PERMANENT for the session. The re-arm is what
    // makes the hook's "retried on a later frame" contract true: the
    // next arriving frame whose metadata references the hash kicks
    // again — by then the stamper's install has landed and the pull
    // delivers.
    //
    // HONESTY NOTE on what this pin can discriminate: in the emulated
    // loopback, a frame that arrives AFTER the install can carry the
    // referenced document itself, so the heal below succeeds with or
    // without the re-arm — this pin is an end-to-end NET over the
    // reference-arrives → document-resolves flow (frames, hook,
    // ordering barrier), not a dedupe discriminator. The dedupe's
    // discriminating bench is the live ON gate's kick-before-install
    // ordering, where watch frames do NOT attach the refs.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });

    const draft = clientRuntime.getCell<{ name: string }>(
      space,
      "rearm-draft",
      DRAFT_SCHEMA,
    );
    await draft.sync();
    {
      const tx = clientRuntime.edit();
      draft.withTx(tx).set({ name: "durable-name" });
      clientRuntime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();
    const draftLink = draft.getAsNormalizedFullLink();
    const cancelWatch = draft.sink(() => {});

    const lateSchema = {
      type: "object",
      properties: { name: { type: "string" }, rearm: { type: "boolean" } },
    } as const;
    const lateHash = internSchemaAsTaggedHashString(lateSchema);
    const replica = clientManager.open(space).replica;

    // FRAME 1 (a second session): /cfc references the hash, and the
    // cid: doc rides the SAME commit (a commit carries its closure, so
    // a reference-before-install ordering is not constructible through
    // commits). With the install landing alongside, this pin is an
    // end-to-end net over reference-arrives → document-resolves; the
    // empty-pull re-arm's remaining constructible arms are covered
    // below, and its discriminating bench stays the live ON gate.
    {
      const writerManager = EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      const writerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerManager,
      });
      try {
        const writerDraft = writerRuntime.getCell<{ name: string }>(
          space,
          "rearm-draft",
          DRAFT_SCHEMA,
        );
        await writerDraft.sync();
        const seedTx = writerRuntime.edit();
        const docAddress = {
          space,
          id: draftLink.id,
          scope: draftLink.scope,
          type: "application/json" as const,
          path: [],
        };
        seedTx.writeOrThrow({
          space,
          id: `cid:${lateHash}` as never,
          type: "application/json",
          path: [],
        }, { value: lateSchema });
        const current = seedTx.readOrThrow(docAddress);
        const base = current && typeof current === "object" ? current : {};
        seedStoredEnvelope(seedTx, docAddress, {
          ...base,
          cfc: {
            version: 1,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: {}, origin: "declared" }],
            },
            schemaHash: lateHash,
          },
        });
        expect((await seedTx.commit()).error).toBeUndefined();
        await writerRuntime.storageManager.synced();
      } finally {
        await writerRuntime.dispose();
        await writerManager.close();
      }
    }
    // The metadata integrated over the watch; the kick's empty pull has
    // settled (the pull joins the synced() barrier).
    await awaitReplica(
      clientManager,
      () =>
        (replica.getDocument(draftLink.id, draftLink.scope) as {
          cfc?: { schemaHash?: string };
        } | undefined)?.cfc?.schemaHash === lateHash,
    );
    // The kick's pull joins the replica's inbound settle: after this,
    // frame 1's pull has fully completed. (The doc may already be at
    // hand — frame delivery attaches installed refs in this harness —
    // so no absence is asserted; the heal below is the net.)
    await (replica as unknown as { inputSynced(): Promise<void> })
      .inputSynced();

    // FRAME 2: the draft doc updates again, so a fresh frame carries
    // the same reference (the cid: re-write is an idempotent blind
    // install). Whatever frame 1 left unresolved, this frame's kick
    // delivers.
    {
      const writerManager = EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      const writerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerManager,
      });
      try {
        const writerDraft = writerRuntime.getCell<{ name: string }>(
          space,
          "rearm-draft",
          DRAFT_SCHEMA,
        );
        await writerDraft.sync();
        const tx = writerRuntime.edit();
        tx.writeOrThrow({
          space,
          id: `cid:${lateHash}` as never,
          type: "application/json",
          path: [],
        }, { value: lateSchema });
        const docAddress = {
          space,
          id: draftLink.id,
          scope: draftLink.scope,
          type: "application/json" as const,
          path: [],
        };
        const current = tx.readOrThrow(docAddress);
        const base = current && typeof current === "object" ? current : {};
        tx.writeOrThrow(docAddress, {
          ...base,
          value: { name: "second-frame" },
        });
        expect((await tx.commit()).error).toBeUndefined();
        await writerRuntime.storageManager.synced();
      } finally {
        await writerRuntime.dispose();
        await writerManager.close();
      }
    }

    // The heal: the reference resolves on this replica via the re-kick.
    await awaitReplica(
      clientManager,
      () => replica.getDocument(`cid:${lateHash}` as never) !== undefined,
    );

    // The hook's remaining CONSTRUCTIBLE skip arms, coverage-verified
    // (instrumented line hits, not asserts — the loopback masks most
    // behavioral observables here):
    //
    //  - the PAIR frame: ONE writer commit stamping TWO watched docs'
    //    metadata with the SAME hash. A dedupe-hit construction would
    //    need the hash UNINSTALLED — a commit shape the closure contract
    //    rules out (the reference must ride with its document or find
    //    it already stored) — and a delivered hash is
    //    resolvable-guarded, never dedupe-hit. The dedupe-hit skip's
    //    line joins the doc-shape guard below as enumerated coverage
    //    debt;
    //  - the string-shape guard: metadata WITHOUT a schemaHash, on
    //    its own frame.
    const writeDocFrame = async (
      writes: {
        id: string;
        scope: unknown;
        value: unknown;
      }[],
    ) => {
      const writerManager = EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      const writerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerManager,
      });
      try {
        // Touch the docs so the writer session can address them.
        const writerDraft = writerRuntime.getCell<{ name: string }>(
          space,
          "rearm-draft",
          DRAFT_SCHEMA,
        );
        await writerDraft.sync();
        const tx = writerRuntime.edit();
        for (const write of writes) {
          seedStoredEnvelope(tx, {
            space,
            id: write.id as never,
            scope: write.scope as never,
            type: "application/json",
            path: [],
          }, write.value as never);
        }
        expect((await tx.commit()).error).toBeUndefined();
        await writerRuntime.storageManager.synced();
      } finally {
        await writerRuntime.dispose();
        await writerManager.close();
      }
    };
    const readerSees = (name: string) => () =>
      (replica.getDocument(draftLink.id, draftLink.scope) as {
        value?: { name?: string };
      } | undefined)?.value?.name === name;
    const currentDoc = () =>
      replica.getDocument(draftLink.id, draftLink.scope) as Record<
        string,
        unknown
      >;

    // A SECOND watched doc for the same-batch dedupe-hit construction.
    const draftB = clientRuntime.getCell<{ name: string }>(
      space,
      "rearm-draft-b",
      DRAFT_SCHEMA,
    );
    await draftB.sync();
    {
      const tx = clientRuntime.edit();
      draftB.withTx(tx).set({ name: "b-durable" });
      clientRuntime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();
    const draftBLink = draftB.getAsNormalizedFullLink();
    const cancelWatchB = draftB.sink(() => {});

    const pairSchema = {
      type: "object",
      properties: { name: { type: "string" }, pairPin: { type: "boolean" } },
    } as const;
    const pairHash = internSchemaAsTaggedHashString(pairSchema);
    const pairCfc = {
      version: 1,
      labelMap: {
        version: 1,
        entries: [{ path: [], label: {}, origin: "declared" }],
      },
      schemaHash: pairHash,
    };
    const docBValue = replica.getDocument(
      draftBLink.id,
      draftBLink.scope,
    ) as Record<string, unknown>;
    await writeDocFrame([
      {
        id: `cid:${pairHash}`,
        scope: "space",
        value: { value: pairSchema },
      },
      {
        id: draftLink.id,
        scope: draftLink.scope,
        value: { ...currentDoc(), value: { name: "pair-frame" }, cfc: pairCfc },
      },
      {
        id: draftBLink.id,
        scope: draftBLink.scope,
        value: { ...docBValue, cfc: pairCfc },
      },
    ]);
    await awaitReplica(clientManager, readerSees("pair-frame"));

    // The schemaHash-less metadata frame (the string-shape guard).
    await writeDocFrame([{
      id: draftLink.id,
      scope: draftLink.scope,
      value: {
        ...currentDoc(),
        value: { name: "fourth-frame" },
        cfc: {
          version: 1,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: {}, origin: "declared" }],
          },
        },
      },
    }]);
    await awaitReplica(clientManager, readerSees("fourth-frame"));

    // The doc-shape guard (a non-object root) is NOT constructible:
    // the write path refuses any non-object full-document root
    // ("memory v2 transactions require explicit full-document roots"),
    // so no commit — and no frame — can carry one. The guard is
    // defensive; its line is enumerated coverage debt.
    await (replica as unknown as { inputSynced(): Promise<void> })
      .inputSynced();
    cancelWatchB();
    cancelWatch();
  });

  it("a PRESENT-but-EMPTY durable document reads as present through the blind-tx verifier view — the root serves {} and /cfc serves no-metadata, never a deleted doc", async () => {
    // The empty-collapse deviation: `toTransactionDocumentValue` maps a
    // present-but-empty document to `undefined`, so the durable
    // verifier view served an existing (empty-envelope) doc as DELETED
    // — its root read `undefined` where the transaction's ordinary
    // semantics give `{}`. The durable root now serves the replica
    // state directly: root `{}`, and the `["cfc"]` descent resolves
    // ok(undefined) directly (an object root with the key absent) —
    // "no metadata", the correct verdict for an envelope that exists
    // and carries none.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });

    const emptyId = "of:empty-envelope-doc" as never;
    {
      const tx = clientRuntime.edit();
      tx.writeOrThrow({
        space,
        id: emptyId,
        type: "application/json",
        path: [],
      }, { value: { seeded: true } });
      expect((await tx.commit()).error).toBeUndefined();
      await clientRuntime.storageManager.synced();
    }
    const replica = clientManager.open(space).replica;
    // Present-but-empty is not constructible through the write path —
    // the wire normalizes an empty document away — but the FOLD paths
    // produce it: a durable in-flight PATCH removing the last key
    // renders the non-speculative view as {}. Seal exactly that (a
    // NON-speculative seal, verdict pending — a durable pending layer).
    let resolveVerdict!: (
      verdict: { withdrawn: { message: string } },
    ) => void;
    const sealed = replica.sealNative!(
      {
        operations: [{
          op: "patch",
          id: emptyId,
          type: "application/json",
          patches: [{ op: "remove", path: "/value" }] as never,
          value: {},
        }],
      },
      undefined,
      new Promise((resolve) => {
        resolveVerdict = resolve;
      }),
      {},
    );
    // Construction guard: the doc's view is PRESENT and EMPTY.
    expect(replica.getDocument(emptyId)).toEqual({});

    const verifierMeta = {
      meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
    };
    try {
      const blindTx = clientRuntime.edit();
      markUiInputBlindWriteTx(blindTx);
      setBlindStructuralTarget(blindTx, {
        id: emptyId as unknown as string,
        space,
        scope: undefined,
        path: [],
      });
      unmarkUiInputBlindWriteTx(blindTx);
      expect(
        blindTx.readOrThrow({
          space,
          id: emptyId,
          type: "application/json",
          path: [],
        }, verifierMeta),
      ).toEqual({});
      expect(
        blindTx.readOrThrow({
          space,
          id: emptyId,
          type: "application/json",
          path: ["cfc"],
        }, verifierMeta),
      ).toBeUndefined();
      await blindTx.commit();
    } finally {
      // Withdraw the sealed layer so its settlement completes before
      // teardown even when an assert throws (a pending durable seal
      // strands the event loop).
      resolveVerdict({ withdrawn: { message: "pin teardown" } });
      await sealed.settled.catch(() => {});
    }
  });

  it("the SAME CFC-relevant write WITHOUT the blind mark is still refused over a standing echo — the verifier-read basis change is confined to the blind-write tx shape (speculation.md §6 stands)", async () => {
    // The scoping reverse pin: identical doc, identical relevance,
    // identical standing echo — only the blind UI-input marking
    // differs. A non-blind set is read-modify-write: its own value
    // read of the target doc is a REAL dependency on the echo, and
    // the ruled §6 refusal must keep firing terminally (the
    // verifier-read exclusion never reaches a transaction outside the
    // `unmarkUiInputBlindWriteTx` family).
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const draft = clientRuntime.getCell<{ name: string }>(
      space,
      "nonblind-draft",
      DRAFT_SCHEMA,
    );
    await draft.sync();
    {
      const tx = clientRuntime.edit();
      draft.withTx(tx).set({ name: "durable-name" });
      clientRuntime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();
    const draftLink = draft.getAsNormalizedFullLink();

    const replica = clientManager.open(space).replica;
    const durableDoc = replica.getDocument(draftLink.id, draftLink.scope);
    expect(durableDoc).toBeDefined();
    replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: draftLink.id,
          type: "application/json",
          value: {
            ...(durableDoc as Record<string, unknown>),
            value: { name: "seed-echo" },
          },
        }],
      },
      undefined,
      new Promise(() => {}),
      { speculative: true },
    );
    expect(draft.key("name").get()).toBe("seed-echo");
    const commitsBefore =
      Engine.selectCommitsSince(engine, { fromSeq: 0 }).length;

    const casTx = clientRuntime.edit();
    draft.key("name").withTx(casTx).set("cas-name");
    // Vacuity guard: the scoping claim needs CFC prepare on this tx too.
    expect(casTx.getCfcState().relevant).toBe(true);
    clientRuntime.prepareTxForCommit(casTx);
    const outcome = await casTx.commit();

    expect(outcome.error).toBeDefined();
    expect(outcome.error!.name).toBe("SpeculativeBasisError");
    expect(outcome.error!.message).toContain("speculative overlay layer");
    expect(isTerminalRejection(outcome.error)).toBe(true);
    // Nothing reached the wire.
    expect(Engine.selectCommitsSince(engine, { fromSeq: 0 }).length).toBe(
      commitsBefore,
    );
  });

  it("a durable-read direct transaction authors from confirmed state while a speculative echo stands", async () => {
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);
    const database = clientRuntime.getCell<{ id: string; rev: number }>(
      space,
      "direct-durable-database",
      undefined,
    );
    await database.sync();
    {
      const tx = clientRuntime.edit();
      database.withTx(tx).set({ id: "db-1", rev: 1 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();

    const replica = clientManager.open(space).replica;
    const link = database.getAsNormalizedFullLink();
    const durableDoc = replica.getDocument(link.id, link.scope);
    const verdict = Promise.withResolvers<
      {
        committed: { seq: number };
      } | {
        withdrawn: { message: string };
      }
    >();
    const sealed = replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: link.id,
          type: "application/json",
          value: {
            ...(durableDoc as Record<string, unknown>),
            value: { id: "db-1", rev: 9 },
          },
        }],
      },
      undefined,
      verdict.promise,
      { speculative: true },
    );
    expect(database.get()).toEqual({ id: "db-1", rev: 9 });
    const commitsBefore = Engine.selectCommitsSince(engine, { fromSeq: 0 })
      .length;

    const tx = clientRuntime.edit();
    markDurableReadTx(tx);
    const wrapped = new TransactionWrapper(tx);
    expect(isDurableReadTx(wrapped)).toBe(true);
    expect(database.withTx(wrapped).get()).toEqual({ id: "db-1", rev: 1 });
    database.key("rev").withTx(wrapped).set(2);
    clientRuntime.prepareTxForCommit(tx);
    const outcome = await tx.commit();

    expect(outcome.error).toBeUndefined();
    expect(Engine.selectCommitsSince(engine, { fromSeq: 0 }).length).toBe(
      commitsBefore + 1,
    );
    verdict.resolve({ withdrawn: { message: "test complete" } });
    await sealed.settled;
  });

  it("a piece-start instantiation reads through the durable view while a speculative echo stands: its bookkeeping commit lands and the piece stays registered (speculation.md §6)", async () => {
    // The runner's own piece-instantiation transaction is an authored
    // write bound for the wire, so its read basis must never name a
    // speculative layer. The refusal is terminal by ruling, and the arm
    // that catches it retires the whole piece registration — which takes
    // the event handlers the graph installed with it, so the next send
    // to one of those streams finds no handler and drops. That is the
    // shape observed on the ON lane: a dropped module-add send three
    // milliseconds after a `SpeculativeBasisError` on
    // `piece-instantiate/...`.
    //
    // The piece is a hand-built witness whose one raw node reads a shared
    // document through the instantiation's own transaction and writes a
    // changing value, so every instantiation carries a real bookkeeping
    // commit instead of being optimized away to a no-op — the device
    // executor-wave.test.ts uses for this same machinery.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const shared = clientRuntime.getCell<{ n: number }>(
      space,
      "piece-start-shared-input",
      undefined,
    );
    await shared.sync();
    {
      const seed = clientRuntime.edit();
      shared.withTx(seed).set({ n: 1 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();

    let instantiations = 0;
    const readPerInstantiation: unknown[] = [];
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
            const parentCell = args[4] as Cell<Record<string, unknown>>;
            instantiations += 1;
            readPerInstantiation.push(
              shared.withTx(cellTx(parentCell)).key("n").get(),
            );
            parentCell.key("witness").set(instantiations);
            return { action: () => {} };
          },
        } as Module,
        inputs: {},
        outputs: {},
      }],
    };

    const witness = clientRuntime.getCell<Record<string, unknown>>(
      space,
      "piece-start-witness",
      undefined,
    );
    {
      const tx = clientRuntime.edit();
      const running = clientRuntime.runner.run(
        tx,
        pattern,
        {},
        witness.withTx(tx),
      );
      expect((await tx.commit()).error).toBeUndefined();
      await running.pull();
    }
    await clientRuntime.storageManager.synced();
    expect(instantiations).toBe(1);
    const registrationsWhileRunning = clientRuntime.runner.cancels.size;
    clientRuntime.runner.stop(witness);
    expect(clientRuntime.runner.cancels.size).toBe(
      registrationsWhileRunning - 1,
    );

    // The window: an echo stands on the shared document, so an
    // instantiation that reads it through the ordinary view names a
    // process-local layer in its commit basis.
    const replica = clientManager.open(space).replica;
    const sharedLink = shared.getAsNormalizedFullLink();
    const durableDoc = replica.getDocument(sharedLink.id, sharedLink.scope);
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    const sealed = replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: sharedLink.id,
          type: "application/json",
          value: {
            ...(durableDoc as Record<string, unknown>),
            value: { n: 99 },
          },
        }],
      },
      undefined,
      verdict.promise,
      { speculative: true },
    );
    expect(shared.get()).toEqual({ n: 99 });

    const failures: Array<{ actionId: string; name?: string }> = [];
    clientRuntime.pieceStartCommitFailureObserver = ({ actionId, error }) => {
      failures.push({ actionId, name: (error as { name?: string })?.name });
    };
    try {
      expect(await clientRuntime.start(witness)).toBe(true);
      await clientRuntime.idle();
      await clientRuntime.runner.idlePieceInstantiationSettlements();

      // Its setup write landed: nothing refused it.
      expect(failures).toEqual([]);
      // The instantiation ran against the durable value, not the echo's,
      // which is the value side of the basis it names.
      expect(instantiations).toBe(2);
      expect(readPerInstantiation[1]).toBe(1);
      // And the store holds what it wrote.
      await clientRuntime.storageManager.synced();
      expect(
        (Engine.read(engine, { id: witness.getAsNormalizedFullLink().id })
          ?.value as { witness?: number } | undefined)?.witness,
      ).toBe(2);
      // So the piece is still registered, and the handlers its graph
      // installed are still reachable by an event.
      expect(clientRuntime.runner.cancels.size).toBe(registrationsWhileRunning);
    } finally {
      verdict.resolve({ withdrawn: { message: "test complete" } });
      await sealed.settled.catch(() => {});
    }
  });

  it("a piece-start instantiation still consumes a DURABLE in-flight layer: the mark excludes speculation, not everything pending (speculation.md §6)", async () => {
    // The reverse pin of the case above, and the one that catches the
    // wrong implementation of it. The durable-read mark must skip the
    // process-local speculation layers and nothing else: a durable
    // sealed layer is a real write on its way to the store, its localSeq
    // is nameable in a commit basis, and an instantiation that stopped
    // consuming it would build the graph from a value the store is
    // already past. Written as "skip every pending layer" the case above
    // still passes and this one reads 1.
    //
    // The two seals differ in exactly one token — the `speculative`
    // option — so the values the two tests expect are what separates the
    // two layer classes.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });

    const shared = clientRuntime.getCell<{ n: number }>(
      space,
      "piece-start-durable-input",
      undefined,
    );
    await shared.sync();
    {
      const seed = clientRuntime.edit();
      shared.withTx(seed).set({ n: 1 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();

    let instantiations = 0;
    const readPerInstantiation: unknown[] = [];
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
            const parentCell = args[4] as Cell<Record<string, unknown>>;
            instantiations += 1;
            readPerInstantiation.push(
              shared.withTx(cellTx(parentCell)).key("n").get(),
            );
            parentCell.key("witness").set(instantiations);
            return { action: () => {} };
          },
        } as Module,
        inputs: {},
        outputs: {},
      }],
    };

    const witness = clientRuntime.getCell<Record<string, unknown>>(
      space,
      "piece-start-durable-witness",
      undefined,
    );
    {
      const tx = clientRuntime.edit();
      const running = clientRuntime.runner.run(
        tx,
        pattern,
        {},
        witness.withTx(tx),
      );
      expect((await tx.commit()).error).toBeUndefined();
      await running.pull();
    }
    await clientRuntime.storageManager.synced();
    expect(instantiations).toBe(1);
    expect(readPerInstantiation[0]).toBe(1);
    clientRuntime.runner.stop(witness);

    // A DURABLE sealed layer: the same shape as the speculative one
    // above without the `speculative` option, so it is a write bound for
    // the store whose verdict has not landed yet.
    const replica = clientManager.open(space).replica;
    const sharedLink = shared.getAsNormalizedFullLink();
    const durableDoc = replica.getDocument(sharedLink.id, sharedLink.scope);
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    const sealed = replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: sharedLink.id,
          type: "application/json",
          value: {
            ...(durableDoc as Record<string, unknown>),
            value: { n: 42 },
          },
        }],
      },
      undefined,
      verdict.promise,
    );
    expect(shared.get()).toEqual({ n: 42 });

    const refusals: unknown[] = [];
    clientRuntime.pieceStartCommitFailureObserver = ({ error }) => {
      refusals.push(error);
    };
    try {
      expect(await clientRuntime.start(witness)).toBe(true);
      await clientRuntime.idle();

      // The layer is durable, so the instantiation consumed it.
      expect(instantiations).toBe(2);
      expect(readPerInstantiation[1]).toBe(42);
      // And naming it is legitimate: whatever this commit's fate, it is
      // never the terminal refusal a speculative basis earns. Its fate
      // rides the seal's undischarged verdict, which is why the outcome
      // itself is not asserted here.
      await clientRuntime.runner.idlePieceInstantiationSettlements();
      expect(
        refusals.filter((error) =>
          isTerminalRejection(error as { name?: string })
        ),
      ).toEqual([]);
    } finally {
      verdict.resolve({ withdrawn: { message: "test complete" } });
      await sealed.settled.catch(() => {});
    }
  });

  it("a list coordinator's resume seed reads the durable view while a speculative echo stands on its container: the seed lands, and the coordinator's wait ends (speculation.md §6)", async () => {
    // A list coordinator that resumes onto a result container with no
    // value defers its reconcile and pulls the container, so that the
    // value's arrival re-triggers it. A container that was never
    // persisted has no value to arrive, and the seed is what ends that
    // wait: it writes the empty array a fresh coordinator would have
    // written, and that write is the arrival.
    //
    // The recovery the terminal refusal names — re-deriving once the
    // authoritative value lands — is therefore unavailable to the seed,
    // whose own write is that value. A refused seed leaves the
    // coordinator waiting for a re-trigger nothing sends: it starts no
    // element run, and the list it renders stays empty for the life of
    // the piece.
    //
    // The window is the ordinary one. An echo stands on the container's
    // document while the list it holds has never been persisted, so a
    // seed reading through the overlay names a process-local layer in
    // its commit basis and is refused terminally.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const container = clientRuntime.getCell<unknown[]>(
      space,
      "resume-seed-speculative-container",
      undefined,
    );
    await container.sync();
    const containerId = container.getAsNormalizedFullLink().id;

    const replica = clientManager.open(space).replica;
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    const sealed = replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: containerId,
          type: "application/json",
          value: { cfc: { version: 1, labelMap: { entries: [] } } },
        }],
      },
      undefined,
      verdict.promise,
      { speculative: true },
    );
    // The layer carries no value for the container, so the overlay view
    // agrees with the durable one that the list is still absent: what
    // separates the two is the basis a commit reading either would name.
    expect(container.get()).toBeUndefined();

    const logger = new RecordingLogger("resume seed durable view");
    try {
      await seedResultContainerWhenPullSettles(
        clientRuntime,
        container,
        () => true,
        () => {},
        Promise.resolve(),
        logger,
        "map/resume-seed/of:resume-seed-speculative-container",
      );

      // The seed reached the store, so the container now holds the
      // value whose arrival re-triggers the deferred reconcile.
      await clientRuntime.storageManager.synced();
      expect(logger.reports).toEqual([]);
      expect(Engine.read(engine, { id: containerId })?.value).toEqual([]);
    } finally {
      verdict.resolve({ withdrawn: { message: "test complete" } });
      await sealed.settled.catch(() => {});
    }
  });

  it("a list coordinator's resume seed still reads a DURABLE in-flight layer: a container another writer has already filled is left alone (speculation.md §6)", async () => {
    // The reverse pin of the case above, and the one that catches the
    // wrong implementation of it. The seed's precondition is that the
    // container holds nothing, and a durable in-flight layer is a real
    // value on its way to the store. Written as "read past every pending
    // layer", the case above still passes and this one replaces a filled
    // container with an empty list, which discards every element run
    // that coordinator had.
    //
    // The two seals differ in exactly one token, the `speculative`
    // option, so what the container ends up holding is what separates
    // the two layer classes.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });

    const engine = await server.engineForSpace(space);
    const container = clientRuntime.getCell<unknown[]>(
      space,
      "resume-seed-durable-container",
      undefined,
    );
    await container.sync();
    const containerId = container.getAsNormalizedFullLink().id;

    const replica = clientManager.open(space).replica;
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    const sealed = replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: containerId,
          type: "application/json",
          value: { value: ["already here"] },
        }],
      },
      undefined,
      verdict.promise,
    );
    expect(container.get()).toEqual(["already here"]);
    const commitsBefore = Engine.selectCommitsSince(engine, { fromSeq: 0 })
      .length;

    const logger = new RecordingLogger("resume seed durable layer");
    try {
      await seedResultContainerWhenPullSettles(
        clientRuntime,
        container,
        () => true,
        () => {},
        Promise.resolve(),
        logger,
        "map/resume-seed/of:resume-seed-durable-container",
      );
      // The seed stood down: it wrote nothing, so the store received no
      // commit from it, and the container still holds the layer's value.
      // The value alone would not say so, because the layer stands above
      // whatever the seed wrote.
      expect(Engine.selectCommitsSince(engine, { fromSeq: 0 }).length).toBe(
        commitsBefore,
      );
      expect(container.get()).toEqual(["already here"]);
      expect(logger.reports).toEqual([]);
    } finally {
      verdict.resolve({ withdrawn: { message: "test complete" } });
      await sealed.settled.catch(() => {});
    }
  });

  it("under a standing overlay layer whose writes include /cfc, a blind-write tx's verifier-shaped read sees the DURABLE doc while an ordinary read sees the overlay — verify-durable and name-durable travel together (RULED 2026-08-21)", async () => {
    // The consistency pin for the ruled arm (b): the value the
    // verifier consumes must match the basis named for it. The echo
    // CLASS writes `/cfc` (observed on save echoes in the triage), so
    // overlay and durable policy state genuinely diverge; the ruling
    // makes DURABLE the verifier's input for the blind-write tx —
    // never verify-overlay + name-durable. Pinned at the transaction
    // read seam, where the split is directly observable: a synthetic
    // speculative layer rewrites the doc's value AND plants `/cfc`;
    // the verifier-shaped read (internalVerifierRead meta, issued
    // after the blind window closes, in a tx carrying the blind
    // structural target) returns the durable doc, an ordinary read of
    // the same doc in the same tx returns the overlay view, and the
    // same verifier-shaped read in a tx WITHOUT the blind shape keeps
    // today's overlay basis.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });

    const doc = clientRuntime.getCell<{ total: number }>(
      space,
      "verifier-consistency-doc",
      undefined,
    );
    await doc.sync();
    {
      const tx = clientRuntime.edit();
      doc.withTx(tx).set({ total: 1 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();
    const docId = doc.getAsNormalizedFullLink().id;

    // A standing SPECULATIVE layer that rewrites the value and plants
    // /cfc — sealed onto the real replica exactly as the overlay
    // destination seals an echo (speculative: true, verdict pending).
    const replica = clientManager.open(space).replica;
    const overlayCfc = {
      version: 1,
      labelMap: {
        version: 1,
        entries: [{ path: ["total"], label: {}, origin: "declared" }],
      },
    };
    replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: docId,
          type: "application/json",
          value: { value: { total: 42 }, cfc: overlayCfc },
        }],
      },
      undefined,
      new Promise(() => {}),
      { speculative: true },
    );
    // The overlay view shows the layer.
    expect(doc.key("total").get()).toBe(42);

    const verifierMeta = {
      meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
    };
    const address = (path: string[]) => ({
      space,
      id: docId,
      type: "application/json" as const,
      path,
    });

    // A tx WITHOUT the blind shape: the verifier-shaped read keeps
    // today's overlay basis (the change is confined to the blind
    // family).
    {
      const plainTx = clientRuntime.edit();
      expect(plainTx.readOrThrow(address(["value", "total"]), verifierMeta))
        .toBe(42);
      expect(plainTx.readOrThrow(address(["cfc"]), verifierMeta))
        .toEqual(overlayCfc);
      await plainTx.commit();
    }

    // The blind-write tx shape (mark → structural target → unmark):
    // verifier-shaped reads see the DURABLE doc; ordinary reads in the
    // SAME tx see the overlay.
    {
      const blindTx = clientRuntime.edit();
      markUiInputBlindWriteTx(blindTx);
      const link = doc.withTx(blindTx).resolveAsCell()
        .getAsNormalizedFullLink();
      setBlindStructuralTarget(blindTx, {
        id: link.id,
        space: link.space,
        scope: link.scope,
        path: [],
      });
      unmarkUiInputBlindWriteTx(blindTx);
      expect(blindTx.readOrThrow(address(["value", "total"]), verifierMeta))
        .toBe(1);
      expect(blindTx.readOrThrow(address(["cfc"]), verifierMeta))
        .toBeUndefined();
      expect(blindTx.readOrThrow(address(["value", "total"]))).toBe(42);
      expect(blindTx.readOrThrow(address(["cfc"]))).toEqual(overlayCfc);
      await blindTx.commit();
    }
  });

  it("a handler that read a speculative echo runs ONCE — no convergence-retry loop against a dependency that is never coming (leg-C 1b; events-down diverts the write)", async () => {
    // A convergence-retry loop here is structurally absent, by TWO
    // layered mechanisms: leg-C's terminal refusal classifies any
    // authored export naming a speculative layer `terminal` (1a pins
    // it), and Phase 3's events-down DIVERTS the client handler write
    // into the overlay echo altogether (F10 deleted; events.md §7) —
    // the handler authors no wire commit, so there is no doomed
    // dependency to retry against. Either way: the handler runs ONCE.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    // Handler-run counting rides the console channel: the pattern
    // sandbox's globalThis is isolated from the test's, but its
    // console routes through the runtime's consoleHandler.
    let handlerRuns = 0;
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
      consoleHandler: (message) => {
        if (String(message.args?.[0]).includes("leg-c-handler-run")) {
          handlerRuns += 1;
          return [];
        }
        return message.args ?? [];
      },
    });

    const HANDLER_COPY_PATTERN = [
      "import { computed, handler, pattern, Stream, Writable } from 'commonfabric';",
      "const copy = handler<unknown, { total: number; copied: Writable<number> }>(",
      "  (_ev, { total, copied }) => {",
      "    console.log('leg-c-handler-run');",
      "    copied.set(total);",
      "  },",
      ");",
      "export default pattern<",
      "  { n: number; copied: Writable<number> },",
      "  { total: number; copy: Stream<unknown>; copied: number }",
      ">(({ n, copied }) => {",
      "  const total = computed(() => n * 7);",
      "  return { total, copy: copy({ total, copied }), copied };",
      "});",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: HANDLER_COPY_PATTERN }],
    }, { space });
    const clientArg = clientRuntime.getCell<{ n: number; copied: number }>(
      space,
      "loop-arg",
      undefined,
    );
    const clientResult = clientRuntime.getCell<
      { total: number; copy: unknown; copied: number }
    >(
      space,
      "loop-result",
      compiled.resultSchema,
    );
    await clientArg.sync();
    await clientResult.sync();
    {
      const seed = clientRuntime.edit();
      clientArg.withTx(seed).set({ n: 6, copied: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, clientArg, clientResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = clientResult.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );

    const engine = await server.engineForSpace(space);
    const commitsBefore =
      Engine.selectCommitsSince(engine, { fromSeq: 0 }).length;
    handlerRuns = 0;
    clientResult.key("copy").send({});
    await clientRuntime.idle();
    // The handler runs exactly once. A re-run is this runtime's own
    // scheduler work — the pre-fix defect was a backoff loop, which
    // keeps the scheduler busy — so the drain and the store round trip
    // below are ordered after one.
    await clientRuntime.storageManager.synced();
    await clientRuntime.idle();
    expect(handlerRuns).toBe(1);
    // Events-down (F10 deleted): the handler's write DIVERTED to the
    // overlay echo — it renders locally against the speculative total,
    // but the handler authored no wire commit carrying the doomed
    // speculative dependency. The STORE's argument doc keeps the
    // seeded value; the only new wire commit is the event append.
    expect(clientArg.key("copied").get()).toBe(42);
    const argDoc = Engine.read(engine, {
      id: clientArg.getAsNormalizedFullLink().id,
    });
    expect(argDoc).not.toBeNull();
    expect((argDoc?.value as { copied?: number } | undefined)?.copied).toBe(0);
    const newCommits = Engine.selectCommitsSince(engine, { fromSeq: 0 })
      .slice(commitsBefore);
    expect(newCommits.length).toBe(1);
    expect(newCommits[0].class).toBe("authored");
    cancelDemand();
  });

  it("keeps entries until the replica can prove safe retirement", async () => {
    const space = (await Identity.fromPassphrase("retirement capabilities"))
      .did() as MemorySpace;
    for (const missing of ["view", "acknowledgments"]) {
      let capable = false;
      let watermark: ((value: unknown) => void) | undefined;
      const replica = {
        sealNative: (
          native: { operations: unknown[] },
          _source: unknown,
          verdict: Promise<unknown>,
        ) => ({
          localSeq: 10,
          commit: {
            localSeq: 10,
            reads: {
              confirmed: [{ id: "of:input", seq: 1 }],
              pending: [],
            },
            operations: native.operations,
          },
          settled: verdict.then(() => undefined, () => undefined),
        }),
        get speculationRetirementView() {
          return !capable && missing === "view" ? undefined : () => ({
            confirmedSeq: 10,
            pendingLocalSeqs: [],
          });
        },
        get ackedSeqOf() {
          return !capable && missing === "acknowledgments"
            ? undefined
            : () => undefined;
        },
      };
      // The replica and watermark sink are the destination's public inputs;
      // scripting them makes capability arrival independent of scheduling.
      const runtime = {
        storageManager: { open: () => ({ replica }) },
        getCellFromLink: () => ({
          sink: (callback: (value: unknown) => void) => {
            watermark = callback;
            return () => {};
          },
        }),
      } as unknown as Runtime;
      const destination = new SpeculationOverlayDestination(runtime);
      try {
        const tx = {
          tx: {
            markWholeDocumentWrites: () => {},
            sealInto: (collector: {
              sealSpaceCommit: (
                space: MemorySpace,
                native: unknown,
                source: unknown,
              ) => Promise<unknown>;
            }) =>
              collector.sealSpaceCommit(space, {
                operations: [{
                  op: "set",
                  id: "of:output",
                  scope: "space",
                  value: { value: 7 },
                }],
                preconditions: [],
              }, undefined).then(() => ({ ok: {} })),
          },
        } as unknown as IExtendedStorageTransaction;
        stampSpeculationRunContext(tx, {
          actionId: "capability-arrival",
          kind: "derivation",
        });
        expect((await destination.seal(tx)).ok).toBeDefined();
        expect(destination.entryCount(space)).toBe(1);
        expect(watermark).toBeDefined();

        watermark!({ seq: 2 });
        expect(destination.entryCount(space)).toBe(1);

        capable = true;
        const retired = destination.waitForSpaceQuiescence(space);
        watermark!({ seq: 3 });
        await retired;
        expect(destination.entryCount(space)).toBe(0);
      } finally {
        destination.close();
      }
    }
  });

  it("an entry whose origin's accept verdict lands AFTER the covering watermark still retires — the ack wake re-sweeps; no further watermark event needed (leg-C 1c)", async () => {
    // Destination-level pin with a scripted replica: deterministic
    // control over the verdict-vs-watermark race. The sweep at W runs
    // while the origin is unacked (blocked) and the verdict lands after;
    // without a re-sweep the entry would stay pending forever on the
    // then-quiet space.
    const doc = "of:verdict-race" as never;
    let ackedSeq: number | undefined = undefined;
    const pendingLocalSeqs = [10, 30];
    let watermarkCallback: ((value: unknown) => void) | undefined;
    const replica = {
      sealNative: (
        _native: unknown,
        _source: unknown,
        verdict: Promise<unknown>,
        options?: { speculative?: boolean },
      ) => {
        expect(options?.speculative).toBe(true);
        return {
          localSeq: 30,
          commit: {
            localSeq: 30,
            reads: {
              confirmed: [],
              // The origin layer BELOW the entry: localSeq 10, still
              // unacked at seal time.
              pending: [{ id: doc, localSeq: [10], basisSeq: 0 }],
            },
            operations: [],
          },
          settled: verdict.then(() => undefined, () => undefined),
        };
      },
      speculationRetirementView: () => ({
        confirmedSeq: 0,
        pendingLocalSeqs,
      }),
      ackedSeqOf: (localSeq: number) => localSeq === 10 ? ackedSeq : undefined,
      speculationAckObserver: undefined as (() => void) | undefined,
    };
    const runtime = {
      storageManager: { open: () => ({ replica }) },
      getCellFromLink: () => ({
        sink: (callback: (value: unknown) => void) => {
          watermarkCallback = callback;
          return () => {};
        },
      }),
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);

    // Seal the speculative entry through the destination.
    const sealTx = {
      tx: {
        // These doubles hand-build the ops they seal, so the mark has nothing
        // to shape; it is present because the seal refuses a transaction that
        // cannot take it.
        markWholeDocumentWrites: () => {},
        sealInto: (collector: {
          sealSpaceCommit: (
            space: MemorySpace,
            native: unknown,
            source: unknown,
          ) => Promise<unknown>;
        }) => {
          return collector.sealSpaceCommit(space, {
            operations: [],
            preconditions: [],
          }, undefined).then(() => ({ ok: {} }));
        },
      },
    } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(sealTx, {
      actionId: "verdict-race",
      kind: "derivation",
    });
    expect((await destination.seal(sealTx)).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(1);
    // The seal installed both hooks.
    expect(watermarkCallback).toBeDefined();
    expect(replica.speculationAckObserver).toBeDefined();

    // The covering watermark arrives FIRST (W=50 covers everything the
    // entry consumed) — but the origin's verdict is still in flight, so
    // the sweep skips the entry as blocked.
    watermarkCallback!({ seq: 50 });
    await flushMicrotasks();
    expect(destination.entryCount(space)).toBe(1);

    // The verdict lands: origin 10 acked at store seq 5; its layer
    // promotes off the pending stack. NO further watermark event.
    ackedSeq = 5;
    pendingLocalSeqs.splice(0, pendingLocalSeqs.length, 30);
    const quiescence = destination.waitForSpaceQuiescence(space);
    replica.speculationAckObserver?.();
    await quiescence;
    expect(destination.entryCount(space)).toBe(0);
    destination.close();
  });

  it("a close() racing the seal neither resurrects entries nor enacts navigateTo; a REJECTED sealInto withdraws collected entries (threads r3739139501, r3739139536)", async () => {
    // Destination-level, scripted: hold sealInto mid-flight, close()
    // the overlay, then let the seal complete. The continuation must not
    // register the entry after close() has swept (a resurrected entry
    // nothing would ever withdraw), and deferSealedEffects must not
    // flush the allowlisted navigateTo of the never-accepted commit.
    const verdicts: unknown[] = [];
    const replica = {
      sealNative: (
        _native: unknown,
        _source: unknown,
        verdict: Promise<unknown>,
      ) => {
        verdict.then((value) => verdicts.push(value), () => {});
        return {
          localSeq: 7,
          commit: {
            localSeq: 7,
            reads: { confirmed: [], pending: [] },
            operations: [],
          },
          settled: verdict.then(() => undefined, () => undefined),
        };
      },
      speculationRetirementView: () => ({
        confirmedSeq: 0,
        pendingLocalSeqs: [7],
      }),
      ackedSeqOf: () => undefined,
      speculationAckObserver: undefined as (() => void) | undefined,
    };
    const runtime = {
      storageManager: { open: () => ({ replica }) },
      getCellFromLink: () => ({ sink: () => () => {} }),
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);

    const gate = Promise.withResolvers<void>();
    const sealTx = {
      tx: {
        markWholeDocumentWrites: () => {},
        sealInto: async (collector: {
          sealSpaceCommit: (
            space: MemorySpace,
            native: unknown,
            source: unknown,
          ) => Promise<unknown>;
        }) => {
          await collector.sealSpaceCommit(space, {
            operations: [],
            preconditions: [],
          }, undefined);
          await gate.promise;
          return { ok: {} };
        },
      },
    } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(sealTx, {
      actionId: "close-race",
      kind: "derivation",
    });
    const sealResult = destination.seal(sealTx);
    // close() lands while sealInto is parked on the gate.
    destination.close();
    gate.resolve();
    expect((await sealResult).ok).toBeDefined();
    // NOT resurrected — and the entry's verdict was resolved (a
    // rollback withdrawal), not left dangling.
    expect(destination.entryCount(space)).toBe(0);
    expect(verdicts.length).toBe(1);
    expect(
      (verdicts[0] as { withdrawn?: unknown }).withdrawn,
    ).toBeDefined();

    // The effect half: a navigateTo of a derivation on the CLOSED
    // overlay is owned AND dropped.
    let flushed = 0;
    const effectTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(effectTx, {
      actionId: "close-race-effect",
      kind: "derivation",
    });
    const owned = destination.deferSealedEffects(effectTx, [{
      id: "navigateTo:1",
      kind: "navigateTo",
      flush: () => {
        flushed += 1;
      },
    }]);
    expect(owned).toBe(true);
    await flushMicrotasks();
    expect(flushed).toBe(0);

    // The rejection half (r3739139536), on a fresh destination: a
    // sealInto that REJECTS after collecting a space withdraws the
    // collected entry and surfaces a CommitError.
    const rejecting = new SpeculationOverlayDestination(runtime);
    const verdictsBefore = verdicts.length;
    const rejectTx = {
      tx: {
        markWholeDocumentWrites: () => {},
        sealInto: async (collector: {
          sealSpaceCommit: (
            space: MemorySpace,
            native: unknown,
            source: unknown,
          ) => Promise<unknown>;
        }) => {
          await collector.sealSpaceCommit(space, {
            operations: [],
            preconditions: [],
          }, undefined);
          throw new Error("transport fell over mid-seal");
        },
      },
    } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(rejectTx, {
      actionId: "seal-reject",
      kind: "derivation",
    });
    const rejected = await rejecting.seal(rejectTx);
    expect(rejected.error).toBeDefined();
    expect(rejected.error!.message).toContain("transport fell over");
    expect(rejecting.entryCount(space)).toBe(0);
    expect(verdicts.length).toBe(verdictsBefore + 1);
    expect(
      (verdicts[verdictsBefore] as { withdrawn?: unknown }).withdrawn,
    ).toBeDefined();
    rejecting.close();
  });

  it("an effectful builtin reached by client speculation never fires egress: pending renders, zero client fetch calls (README §3.5's never-execute rule)", async () => {
    // Client-only bring-up posture (no serving host): the flag is set
    // explicitly, and the client's fetch stub must never be called.
    const calls: string[] = [];
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      fetch: (input) => {
        calls.push(String(input));
        return Promise.resolve(
          new Response(JSON.stringify({ leaked: true }), {
            headers: { "content-type": "application/json" },
          }),
        );
      },
      experimental: { serverExecution: true },
    });
    const FETCH_PATTERN = [
      "import { fetchJsonUnchecked, pattern } from 'commonfabric';",
      "export default pattern<{ url: string }, { fetch: any }>(",
      "  ({ url }) => ({ fetch: fetchJsonUnchecked({ url }) }),",
      ");",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: FETCH_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ url: string }>(
      space,
      "client-fetch-arg",
      undefined,
    );
    const result = clientRuntime.getCell<{ fetch: { pending?: boolean } }>(
      space,
      "client-fetch-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const tx = clientRuntime.edit();
    argument.withTx(tx).set({ url: "https://phase-2.test/never" });
    expect((await tx.commit()).error).toBeUndefined();
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    // A floating egress would be this runtime's own tracked work.
    await clientRuntime.idle();
    expect(calls).toEqual([]);
    // And the branch RENDERS PENDING (speculation.md §2: on a memo
    // miss the node reads as pending — the ordinary loading state —
    // until the server's result arrives).
    const rendered = result.key("fetch").get() as
      | { pending?: boolean; result?: unknown }
      | undefined;
    expect(rendered?.result).toBeUndefined();
    cancelDemand();
  });

  it("an overlay entry over an ARRAY renders the value its derivation computed, whatever the confirmed value beneath it becomes (the pivot flake: a positional splice re-applied over the authoritative array)", async () => {
    // An entry's ops sit ABOVE the confirmed value and are materialized
    // over it on every read, so an op that is POSITIONAL — a splice
    // carrying an index and an element — describes a value only while the
    // layer beneath is the one the run diffed against. The authoritative
    // derivation arrives on that layer before the entry retires, and the
    // same splice then inserts a second copy of an element the arrived
    // array already carries.
    //
    // The symptom this pins: a board's derived pivot read one row per
    // topic plus one, and one row short, in the same suite — a doubled
    // element and a dropped one are the two directions of one re-applied
    // splice.
    const LIST_PATTERN = [
      "import { Default, lift, pattern, Writable } from 'commonfabric';",
      "const doubleAll = lift(",
      "  ({ items }: { items: number[] }) => items.map((n) => n * 2),",
      ");",
      "export default pattern<",
      "  { items?: Writable<number[] | Default<[]>> },",
      "  { doubled: number[] }",
      ">(({ items }) => ({ doubled: doubleAll({ items: items! }) }));",
    ].join("\n");

    const openRuntime = (flagOn: boolean) => {
      const manager = EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: flagOn },
      });
      return { manager, runtime };
    };

    /** Installs the pattern over the shared cells and hands back the
     * result cell plus a live reader, which IS the demand that makes the
     * lift run at all. */
    const install = async (runtime: Runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: LIST_PATTERN }],
      }, { space });
      const argument = runtime.getCell<{ items: number[] }>(
        space,
        "splice-arg",
        undefined,
      );
      const result = runtime.getCell<{ doubled: number[] }>(
        space,
        "splice-result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
      return { argument, result, release: result.sink(() => {}) };
    };

    // The confirmed two-element array, committed by an ordinary flag-OFF
    // client — the deriving committer this test needs, without an
    // executor host to advance a watermark later on.
    const seeder = openRuntime(false);
    let derivedLink;
    try {
      const seeded = await install(seeder.runtime);
      const tx = seeder.runtime.edit();
      seeded.argument.withTx(tx).set({ items: [1, 2] });
      expect((await tx.commit()).error).toBeUndefined();
      await seeder.runtime.idle();
      await waitForCellValue(
        seeder.runtime,
        seeded.result.key("doubled"),
        (doubled: number[] | undefined) => (doubled ?? []).length === 2,
        { stuckLabel: "the seeded two-element array to render" },
      );
      await seeder.runtime.storageManager.synced();
      // The derived document itself, so the arrival below lands on the
      // very layer an entry's ops are materialized over.
      derivedLink = seeded.result.key("doubled").resolveAsCell()
        .getAsNormalizedFullLink();
      seeded.release();
    } finally {
      await seeder.runtime.dispose();
      await seeder.manager.close();
    }

    // The flag-ON client, opened over the settled state. Its first run
    // computes the array already stored, so the no-op elision seals no
    // entry — which is what leaves the NEXT run diffing against the
    // CONFIRMED value rather than against an echo of its own.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const client = await install(clientRuntime);
    await clientRuntime.idle();
    await waitForCellValue(
      clientRuntime,
      client.result.key("doubled"),
      (doubled: number[] | undefined) => (doubled ?? []).length === 2,
      {
        stuckLabel:
          "the stored two-element array to render at the flag-ON client",
      },
    );
    // The same derived document both sides derive into, so the arrival
    // below lands under the entry this client seals rather than beside it.
    expect(
      client.result.key("doubled").resolveAsCell().getAsNormalizedFullLink()
        .id,
    ).toBe(derivedLink.id);
    // Its run computed what is already stored, so nothing sealed.
    expect(clientRuntime.speculationOverlay?.entryCount(space) ?? 0).toBe(0);

    // The speculative run: three elements diffed against the confirmed
    // two, which is the splice. Nothing advances the watermark here, so
    // the entry stands — that is the window the flake lives in, held
    // open rather than raced.
    {
      const tx = clientRuntime.edit();
      client.argument.withTx(tx).set({ items: [1, 2, 3] });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.idle();
    await waitForCellValue(
      clientRuntime,
      client.result.key("doubled"),
      (doubled: number[] | undefined) => (doubled ?? []).length === 3,
      { stuckLabel: "the speculative three-element echo to render" },
    );
    expect(clientRuntime.speculationOverlay!.entryCount(space))
      .toBeGreaterThanOrEqual(1);
    // Released before the arrival below, so the entry under test is the
    // one this run sealed and no re-derivation seals another over it.
    client.release();

    // The authoritative value arrives under the standing entry. Written
    // from a second session because that is what moves the CONFIRMED
    // value: a write through this client would land as one more layer
    // above it. Deliberately NOT the array the speculation computed, so
    // the assertion separates three outcomes — the entry rendering its
    // own value, the splice composing with what arrived, and the entry
    // having quietly retired.
    const writer = openRuntime(false);
    try {
      const arrived = writer.runtime.getCellFromLink<number[]>(derivedLink);
      await arrived.sync();
      const tx = writer.runtime.edit();
      arrived.withTx(tx).set([7, 8, 9]);
      expect((await tx.commit()).error).toBeUndefined();
      await writer.runtime.storageManager.synced();
    } finally {
      await writer.runtime.dispose();
      await writer.manager.close();
    }
    const replica = clientRuntime.storageManager.open(space).replica;
    await awaitReplica(
      clientManager,
      () =>
        JSON.stringify(
          (replica.getNonSpeculativeDocument!(
            derivedLink.id,
            derivedLink.scope,
          ) as { value?: unknown } | undefined)?.value,
        ) === JSON.stringify([7, 8, 9]),
    );

    // The entry still stands, so what renders is the entry's own value —
    // the three elements its derivation computed — and neither the
    // arrived array nor those three composed with it.
    expect(clientRuntime.speculationOverlay!.entryCount(space))
      .toBeGreaterThanOrEqual(1);
    expect(client.result.key("doubled").get()).toEqual([2, 4, 6]);
  });
});
