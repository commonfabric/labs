// Server-execution v2 — the client speculation ARRIVAL GATE
// (speculation.md §4, RULED 2026-08-16; landed with fan-out stage A as
// its own commit): an input-origin overlay entry retires on ARRIVAL of
// the authoritative value for every doc instance it wrote — a CONFIRMED
// value at seq ≥ the entry's floor — not on watermark coverage of its
// basis alone. Coverage without arrival is the OW32 retire-to-nothing
// loop: the echo dropped to nothing, the writer (subscribed to its own
// output through the scope-narrowing write path) re-derived,
// re-speculated, retired, forever, on any instance the server never
// served (a per-user node the demand walk did not reach; a served node's
// first wave not yet landed at boot).
//
// - the OW32 shape (the triage's probe): a flag-ON client with NO serving
//   host, a `computed` over a PerUser input (its output scope-narrows
//   into `computed:X/user:<self>`), a watermark that covers the basis
//   with NO store value for the instance → the echo STAYS (bounded runs,
//   entry live, the client value renders, no non-settling episode);
//   mutation (gate removed) → the loop returns;
// - arrival: the store's value for the instance lands at seq ≥ floor,
//   the covering watermark re-sweeps → the entry retires and the store
//   value renders;
// - rider "own retirement is not a trigger": the flip a retiring echo
//   produces carries the echo's own transaction as its source, and the
//   scheduler does not re-dirty that transaction's action for it — a
//   writer subscribed to its own output does not re-derive on a
//   divergent authoritative value, re-speculate, and loop through the
//   gate (mutation: the `integrate` arm of the own-source skip removed →
//   the writer re-dirties);
// - rider "supersede-by-newer" (destination-level, scripted): a newer
//   entry of the same writer whose whole-doc ops cover an older entry's
//   docs retires the older one at seal; a PATCH does not; another writer
//   does not.
//
// Stage C tuning T2 (speculation.md §4's owed ARRIVAL RE-SWEEP + the
// LATE-ECHO rule; stage-c-attribution-report §4):
// - the E2 shape: a served derived value that arrives DECOUPLED from a
//   watermark advance (an exhausted wave carries none; W already covers
//   the entry's floor) retires the echo and renders — without waiting for
//   an unrelated commit to lift W (mutation: the arrival observer removed
//   → the entry stands until the next watermark event);
// - the arrival wake is FILTERED to docs some entry wrote and never
//   relaxes the gate (scripted: an arrival for an unrelated doc sweeps
//   nothing; an arrival while W < floor retires nothing);
// - a LATE echo — an event-handler echo sealed after its intent's
//   TERMINAL consequence already arrived — is dropped at seal, never
//   registered (its writes render nothing); a fresh intent's echo still
//   registers (mutation: the check removed → the late echo registers and
//   its divergent write renders).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  type CommitClass,
  resolveScopeKey,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  type SessionSync,
} from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  SpeculationOverlayDestination,
  stampSpeculationRunContext,
} from "../src/speculation/overlay-destination.ts";
import { readWatermarkSeq as readWatermark } from "../src/executor/watermark.ts";

import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

const spaceSigner = await Identity.fromPassphrase("arrival gate space");
const space = spaceSigner.did() as MemorySpace;
const aliceSigner = await Identity.fromPassphrase("arrival gate alice");

/** A per-user derivation: `echo` reads a PerUser draft, so its output
 * narrows into the reader's user instance — exactly the shape whose
 * echo the OW32 loop retired to nothing. */
const PER_USER_PATTERN = [
  "import { computed, Default, pattern, PerUser, Writable } from 'commonfabric';",
  "type Draft = Writable<string | Default<''>>;",
  "export default pattern<",
  "  { draft?: PerUser<Draft> },",
  "  { echo: string }",
  ">(({ draft }) => {",
  "  const draftCell: Draft = draft!;",
  "  return {",
  "    echo: computed(() => 'echo:' + ((draftCell.get() as string | undefined) ?? '')),",
  "  };",
  "});",
].join("\n");

/**
 * The overlay destination under a scripted pair of writers, for the
 * supersede-by-newer cases below.
 *
 * The replica double seals natively and reports a retirement view that
 * retires nothing, so an entry leaves the destination only when the supersede
 * rule drops it. `seal` hands the destination whatever operations a case
 * names, under whichever writer it names.
 */
const supersedeHarness = () => {
  let nextLocalSeq = 10;
  const replica = {
    sealNative: (
      native: { operations: Array<Record<string, unknown>> },
      _source: unknown,
      verdict: Promise<unknown>,
    ) => {
      const localSeq = nextLocalSeq++;
      return {
        localSeq,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: native.operations,
        },
        settled: verdict.then(() => undefined, () => undefined),
      };
    },
    speculationRetirementView: () => ({
      confirmedSeq: 0,
      pendingLocalSeqs: [] as number[],
    }),
    ackedSeqOf: () => undefined,
    speculationAckObserver: undefined as (() => void) | undefined,
  };
  const runtime = {
    storageManager: { open: () => ({ replica }) },
    getCellFromLink: () => ({ sink: () => () => {} }),
  } as unknown as Runtime;
  const destination = new SpeculationOverlayDestination(runtime);
  const seal = (
    writer: object,
    operations: Array<Record<string, unknown>>,
  ) => {
    const tx = {
      tx: {
        sourceAction: writer,
        // These doubles hand-build the ops they seal, so the mark has
        // nothing to shape; it is present because the seal refuses a
        // transaction that cannot take it.
        markWholeDocumentWrites: () => {},
        sealInto: (collector: {
          sealSpaceCommit: (
            space: MemorySpace,
            native: unknown,
            source: unknown,
          ) => Promise<unknown>;
        }) =>
          collector.sealSpaceCommit(
            space,
            { operations, preconditions: [] },
            { sourceAction: writer },
          ).then(() => ({ ok: {} })),
      },
    } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(tx, {
      actionId: "supersede",
      kind: "derivation",
    });
    return destination.seal(tx).settled;
  };
  const setOf = (id: string) => ({
    op: "set",
    id,
    scope: "user",
    value: { value: 1 },
  });
  return {
    destination,
    seal,
    setOf,
    writerA: { name: "writer-a" },
    writerB: { name: "writer-b" },
  };
};

describe("speculation arrival gate (speculation.md §4, RULED 2026-08-16)", () => {
  let server: MemoryV2Server.Server;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    managers = [];
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  const openClient = (signer: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    managers.push(manager);
    runtimes.push(runtime);
    return runtime;
  };

  /** Write the watermark doc from a second session (no serving host in
   * these tests): the client's watermark sink sees `{seq}` and sweeps. */
  const pushWatermark = async (writer: Runtime, seq: number) => {
    const wm = writer.getCellFromLink<{ seq: number }>({
      space,
      id: SERVER_EXECUTION_WATERMARK_DOC_ID as never,
      scope: "space",
      path: [],
    });
    const tx = writer.edit();
    wm.withTx(tx).set({ seq });
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();
  };

  /** Total runs of the piece's lifts (the per-user `echo` derivation is
   * the only lift): the loop's signature is this count climbing. */
  const echoRunCount = (runtime: Runtime): number =>
    runtime.scheduler.getGraphSnapshot().nodes
      .filter((node) => node.id.includes("cfLift"))
      .reduce((total, node) => total + (node.stats?.runCount ?? 0), 0);

  it("the OW32 shape: a covering watermark with NO store value for the written instance leaves the echo in place — bounded runs, live entry, the client value renders (mutation: gate removed → the retire-to-nothing loop returns); then arrival retires it and the store value renders; own-retirement is not a trigger even when the values diverge", async () => {
    const alice = openClient(aliceSigner);
    const engine = await server.engineForSpace(space);
    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PER_USER_PATTERN }],
    }, { space });
    const arg = alice.getCell<Record<string, unknown>>(
      space,
      "ag-arg",
      undefined,
    );
    const result = alice.getCell<{ echo: string }>(
      space,
      "ag-result",
      compiled.resultSchema,
    );
    await arg.sync();
    await result.sync();
    {
      const tx = alice.edit();
      arg.withTx(tx).set({});
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, compiled, arg, result);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    // Demand: a live reader.
    const cancelDemand = result.sink(() => {});
    // The per-user input, through the argument schema (narrows into
    // alice's instance).
    const typedArg = alice.getCell<{ draft: string }>(
      space,
      "ag-arg",
      compiled.argumentSchema,
    );
    {
      const tx = alice.edit();
      typedArg.key("draft").withTx(tx).set("A");
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    // The ECHO: the client's speculative run rendered it, with NO server.
    await waitForCellValue<string>(
      alice,
      result.key("echo"),
      (echo) => echo === "echo:A",
      { stuckLabel: "the speculative echo of A to render" },
    );
    const overlay = alice.speculationOverlay!;
    expect(overlay.entryCount(space)).toBeGreaterThanOrEqual(1);
    const runsAfterEcho = echoRunCount(alice);

    // A watermark that COVERS the basis (the input's seq and everything
    // before it) — with NO store value for computed:X/user:<alice>.
    const writer = openClient(spaceSigner);
    const coverSeq = Engine.serverSeq(engine);
    await pushWatermark(writer, coverSeq);
    await alice.idle();
    await alice.storageManager.synced();
    // A would-be loop shows itself in the pass this drains, not over a
    // window: retire-to-nothing re-runs the lift, which re-speculates,
    // which the same sweep retires again — scheduler work, so the pass
    // runs it to the non-settling guard's cap. Dozens of runs against
    // the bound of two below, and `isNonSettling` goes true with them.
    await alice.idle();

    // THE GATE: the echo stays — the entry is live, the client value
    // renders, and the lift ran a bounded number of times (no
    // retire-to-nothing loop, no non-settling episode).
    expect(overlay.entryCount(space)).toBeGreaterThanOrEqual(1);
    expect(result.key("echo").get()).toBe("echo:A");
    expect(echoRunCount(alice) - runsAfterEcho).toBeLessThanOrEqual(2);
    expect(alice.scheduler.isNonSettling()).toBe(false);
    // And the store still holds nothing for the instance (nobody served
    // it) — the exact OW32 substrate.
    const aliceKey = resolveScopeKey("user", { principal: aliceSigner.did() });
    const echoDocs = (engine.database.prepare(
      `SELECT id FROM head WHERE scope_key = :scope_key AND op != 'delete'
       AND id LIKE 'computed:%'`,
    ).all({ scope_key: aliceKey }) as Array<{ id: string }>).map((r) => r.id);
    expect(echoDocs.length).toBe(0);

    // ARRIVAL: the store's value for the instance lands — as a second
    // session of the same principal (the authoritative writer would be
    // the serving loop; its value need not equal the echo), then a
    // covering watermark re-sweeps. Find the echo doc's id from the
    // client's own view of the result.
    const echoLink = result.key("echo").getAsNormalizedFullLink();
    const echoTarget = alice.getCellFromLink<unknown>({
      ...echoLink,
      schema: undefined,
    }).getRaw({ lastNode: "writeRedirect" }) as
      | { "/": { "link@1": { id?: string } } }
      | undefined;
    const echoDocId = echoTarget?.["/"]?.["link@1"]?.id ??
      (() => {
        // The result slot may hold the computed link directly.
        const raw = alice.getCellFromLink<unknown>({
          ...result.getAsNormalizedFullLink(),
          schema: undefined,
        }).getRaw() as { echo?: { "/": { "link@1": { id?: string } } } };
        return raw?.echo?.["/"]?.["link@1"]?.id;
      })();
    expect(echoDocId).toBeDefined();
    const aliceAgain = openClient(aliceSigner);
    const authoritative = aliceAgain.getCellFromLink<unknown>({
      space,
      id: echoDocId as never,
      scope: "user",
      path: [],
    });
    const authoritativeSlot = aliceAgain.getCellFromLink<unknown>({
      space,
      id: echoDocId as never,
      scope: "space",
      path: [],
    });
    await authoritative.sync();
    await authoritativeSlot.sync();
    {
      // A DIVERGENT authoritative value: the store says something the
      // echo did not — BOTH docs the speculation wrote (the served
      // narrowing writes exactly these two: the value at the user
      // instance and the redirect at the space slot). The redirect's
      // REPRESENTATION differs from the client's too (an explicit `id`,
      // the shape a served narrowing writes — the triage's §6
      // observation), so the retirement flips the space slot the writer
      // reads: without the own-retirement rider, that flip re-runs the
      // writer, which re-speculates its own shape, which the gate retires
      // at once (the instance HAS arrived), which flips again — forever.
      const tx = aliceAgain.edit();
      authoritative.withTx(tx).set("echo:server" as never);
      authoritativeSlot.withTx(tx).set(
        {
          "/": {
            "link@1": {
              id: echoDocId,
              overwrite: "redirect",
              path: [],
              scope: "user",
            },
          },
        } as never,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await aliceAgain.storageManager.synced();
    const runsBeforeArrival = echoRunCount(alice);
    await pushWatermark(writer, Engine.serverSeq(engine));
    // Retirement is what reveals the authoritative value, so the render
    // is the retirement's own edge; the entry count reads it back.
    await waitForCellValue<string>(
      alice,
      result.key("echo"),
      (echo) => echo === "echo:server",
      { stuckLabel: "the server's echo to replace the speculative one" },
    );
    expect(overlay.entryCount(space)).toBe(0);
    // A re-speculate/re-retire loop would be scheduler work off the same
    // flip, and this pass runs it to the non-settling cap.
    await alice.idle();
    // The flip to the (divergent) authoritative value did not start a
    // re-speculate/re-retire loop: no re-derivation, no live entry, the
    // store value stands. Stated honestly: in THIS fixture the writer's
    // registered reads do not include its own user-instance output (only
    // the space slot's redirect, whose semantic value the arrival did
    // not change), so the divergence loop the own-retirement rider closes
    // is not reachable here — the rider's mechanism is pinned by the
    // next test with its own mutation; this assertion is the end-to-end
    // shape.
    expect(overlay.entryCount(space)).toBe(0);
    expect(echoRunCount(alice) - runsBeforeArrival).toBeLessThanOrEqual(1);
    expect(result.key("echo").get()).toBe("echo:server");
    expect(alice.scheduler.isNonSettling()).toBe(false);
    cancelDemand();
  });

  it("own retirement is not a trigger (mechanism): the flip a superseded speculation produces carries the echo's own transaction as its source, and the scheduler does not re-dirty that transaction's action for it (mutation: no source → the writer re-dirties)", async () => {
    // A flag-ON, non-serving runtime (client posture) on an emulated
    // store: no wave destination — the speculation overlay is the
    // default seal destination, but this pin drives the replica seam
    // directly with a scripted verdict.
    const manager = StorageManager.emulate({ as: aliceSigner });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    try {
      const doc = runtime.getCell<{ value: string }>(
        space,
        "own-retirement-doc",
        undefined,
        undefined,
        "user",
      );
      // A LIVE reader of the doc — an effect, so it re-runs on every
      // change to what it read — standing in for the writer subscribed to
      // its own output.
      let runs = 0;
      const writer = (tx: IExtendedStorageTransaction) => {
        runs += 1;
        doc.withTx(tx).get();
      };
      runtime.scheduler.subscribe(writer, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      await runtime.idle();
      expect(runs).toBe(1);

      const replica = manager.open(space).replica;
      const docId = doc.getAsNormalizedFullLink().id;
      const sealSpeculative = (value: string, sourceAction: object) => {
        const sourceTx = runtime.edit();
        sourceTx.tx.sourceAction = sourceAction;
        const { promise, resolve } = Promise.withResolvers<
          { withdrawn: { message: string; superseded: true } }
        >();
        const sealed = replica.sealNative!(
          {
            operations: [{
              op: "set",
              id: docId,
              type: "application/json",
              scope: "user",
              value: { value: { value } } as never,
            }],
            preconditions: [],
          } as never,
          sourceTx.tx,
          promise,
          { speculative: true },
        );
        return {
          retire: async () => {
            resolve({
              withdrawn: { message: "superseded (test)", superseded: true },
            });
            await sealed.settled;
          },
          abort: () => sourceTx.abort(),
        };
      };

      // The writer's OWN echo retires: the flip carries the echo's source,
      // the writer is not re-dirtied.
      const own = sealSpeculative("own-echo", writer);
      await runtime.idle();
      const runsAfterOwnSeal = runs;
      await own.retire();
      await runtime.idle();
      expect(runs).toBe(runsAfterOwnSeal);
      own.abort();

      // A DIFFERENT action's echo retiring on the same doc DOES re-dirty
      // the writer (it is a reader of that doc, not the source).
      const other = () => {};
      const foreign = sealSpeculative("other-echo", other);
      await runtime.idle();
      const runsAfterForeignSeal = runs;
      await foreign.retire();
      await runtime.idle();
      expect(runs).toBeGreaterThan(runsAfterForeignSeal);
      foreign.abort();
    } finally {
      await runtime.dispose();
      await manager.close();
    }
  });

  it("supersede-by-newer (destination-level): a newer whole-doc entry of the same writer retires the older entry over the same instances at seal; a patch does not; another writer does not", async () => {
    const { destination, seal, setOf, writerA, writerB } = supersedeHarness();
    const doc = "of:supersede";
    const set = setOf(doc);
    const patch = {
      op: "patch",
      id: doc,
      scope: "user",
      patches: [{ op: "replace", path: "/value", value: 2 }],
    };
    // Entry 1 (A, set) then entry 2 (A, set over the same instance): 1
    // is superseded at 2's seal.
    expect((await seal(writerA, [set])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(1);
    expect((await seal(writerA, [set])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(1);
    // Entry 3 (A, PATCH): the older whole-doc entry is KEPT (the patch is
    // path-relative to the layer beneath it).
    expect((await seal(writerA, [patch])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(2);
    // Entry 4 (B, set): another writer never supersedes A's entries.
    expect((await seal(writerB, [set])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(3);
    // Entry 5 (A, set) supersedes A's set-entry (2) — but NOT the patch
    // entry (3): a patch's docs are covered by a whole-doc set... entry 3
    // wrote `doc` too, by patch; the newer set covers its DOC, so it is
    // superseded (dropping a patch layer under a whole-doc set is
    // invisible); B's entry stays.
    expect((await seal(writerA, [set])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(2);
    destination.close();
  });

  it("supersede-by-newer keeps an older entry the newer one covers only in part", async () => {
    // The rule drops an older entry only when the newer entry's whole-doc
    // ops cover EVERY doc the older one wrote. An older entry over two
    // instances, met by a newer entry over one of them, keeps its own: the
    // uncovered instance still reads through the older layer, and dropping
    // it would take that speculation with it.
    const { destination, seal, setOf, writerA } = supersedeHarness();
    const first = setOf("of:supersede-part-1");
    const second = setOf("of:supersede-part-2");

    // Entry 1 (A) over both instances.
    expect((await seal(writerA, [first, second])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(1);

    // Entry 2 (A) over the first instance alone: entry 1 wrote the second
    // as well, so it is KEPT.
    expect((await seal(writerA, [first])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(2);

    // Entry 3 (A) over both instances covers every doc each older entry
    // wrote, so both go.
    expect((await seal(writerA, [first, second])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(1);
    destination.close();
  });

  it("stage C T2, the E2 shape: a served value arriving DECOUPLED from a watermark advance (W already covers the floor; the arrival's own seq is above W) retires the echo and renders at once — no unrelated commit needed (mutation: arrival observer removed → the entry stands)", async () => {
    // Same substrate as the OW32 pin above: alice's per-user echo, a
    // watermark covering its basis, the instance not yet served.
    const alice = openClient(aliceSigner);
    const engine = await server.engineForSpace(space);
    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PER_USER_PATTERN }],
    }, { space });
    const arg = alice.getCell<Record<string, unknown>>(
      space,
      "ag-arrival-arg",
      undefined,
    );
    const result = alice.getCell<{ echo: string }>(
      space,
      "ag-arrival-result",
      compiled.resultSchema,
    );
    await arg.sync();
    await result.sync();
    {
      const tx = alice.edit();
      arg.withTx(tx).set({});
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, compiled, arg, result);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    const cancelDemand = result.sink(() => {});
    const typedArg = alice.getCell<{ draft: string }>(
      space,
      "ag-arrival-arg",
      compiled.argumentSchema,
    );
    {
      const tx = alice.edit();
      typedArg.key("draft").withTx(tx).set("A");
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    await waitForCellValue<string>(
      alice,
      result.key("echo"),
      (echo) => echo === "echo:A",
      { stuckLabel: "the speculative echo of A to render" },
    );
    const overlay = alice.speculationOverlay!;
    expect(overlay.entryCount(space)).toBeGreaterThanOrEqual(1);

    // W covers the basis; the instance is unserved → the entry stands.
    // A retirement would ride the watermark push this flushes, and the
    // sweep it schedules is work the drain below runs.
    const writer = openClient(spaceSigner);
    await pushWatermark(writer, Engine.serverSeq(engine));
    await alice.storageManager.synced();
    await alice.idle();
    expect(overlay.entryCount(space)).toBeGreaterThanOrEqual(1);
    expect(result.key("echo").get()).toBe("echo:A");
    const arrivalSweepsBefore = overlay.arrivalSweepCount;

    // The ARRIVAL, decoupled: the authoritative value for BOTH written
    // docs lands at a seq ABOVE the covering W — an exhausted wave's
    // derived commit carries no watermark movement — and NO further
    // watermark write follows. Pre-fix nothing re-swept: the entry stood
    // (hiding the served value) until the next unrelated commit lifted W
    // (the attribution's E2: 48 s, released by another user's draft).
    const echoLink = result.key("echo").getAsNormalizedFullLink();
    const echoTarget = alice.getCellFromLink<unknown>({
      ...echoLink,
      schema: undefined,
    }).getRaw({ lastNode: "writeRedirect" }) as
      | { "/": { "link@1": { id?: string } } }
      | undefined;
    const echoDocId = echoTarget?.["/"]?.["link@1"]?.id ??
      (() => {
        const raw = alice.getCellFromLink<unknown>({
          ...result.getAsNormalizedFullLink(),
          schema: undefined,
        }).getRaw() as { echo?: { "/": { "link@1": { id?: string } } } };
        return raw?.echo?.["/"]?.["link@1"]?.id;
      })();
    expect(echoDocId).toBeDefined();
    const aliceAgain = openClient(aliceSigner);
    const authoritative = aliceAgain.getCellFromLink<unknown>({
      space,
      id: echoDocId as never,
      scope: "user",
      path: [],
    });
    const authoritativeSlot = aliceAgain.getCellFromLink<unknown>({
      space,
      id: echoDocId as never,
      scope: "space",
      path: [],
    });
    await authoritative.sync();
    await authoritativeSlot.sync();
    const watermarkAtArrival = readWatermark(engine);
    {
      const tx = aliceAgain.edit();
      authoritative.withTx(tx).set("echo:server" as never);
      authoritativeSlot.withTx(tx).set(
        {
          "/": {
            "link@1": {
              id: echoDocId,
              overwrite: "redirect",
              path: [],
              scope: "user",
            },
          },
        } as never,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await aliceAgain.storageManager.synced();
    // The arrival's seq is above W and W does not move.
    expect(Engine.serverSeq(engine)).toBeGreaterThan(watermarkAtArrival);
    // THE PIN: retired and rendered off the arrival alone.
    await waitForCellValue<string>(
      alice,
      result.key("echo"),
      (echo) => echo === "echo:server",
      { stuckLabel: "the server's echo to replace the speculative one" },
    );
    expect(overlay.entryCount(space)).toBe(0);
    expect(overlay.arrivalSweepCount).toBeGreaterThan(arrivalSweepsBefore);
    expect(readWatermark(engine)).toBe(watermarkAtArrival);
    await alice.idle();
    expect(alice.scheduler.isNonSettling()).toBe(false);
    cancelDemand();
  });

  it("stage C T2, the arrival wake is a TRIGGER, not a relaxation (scripted): an arrival for a doc no entry wrote sweeps nothing; an arrival while W < floor retires nothing; an arrival with W ≥ floor retires the entry", async () => {
    const doc = "of:arrival-scripted" as never;
    const other = "of:arrival-unrelated" as never;
    let nextLocalSeq = 10;
    let confirmedSeq = 0;
    const replica = {
      sealNative: (
        native: { operations: Array<Record<string, unknown>> },
        _source: unknown,
        verdict: Promise<unknown>,
      ) => {
        const localSeq = nextLocalSeq++;
        return {
          localSeq,
          commit: {
            localSeq,
            // A confirmed read at seq 40: the entry's floor.
            reads: {
              confirmed: [{ id: "of:input", seq: 40 }],
              pending: [],
            },
            operations: native.operations,
          },
          settled: verdict.then(() => undefined, () => undefined),
        };
      },
      speculationRetirementView: () => ({
        confirmedSeq,
        pendingLocalSeqs: [] as number[],
      }),
      ackedSeqOf: () => undefined,
      speculationAckObserver: undefined as (() => void) | undefined,
      speculationArrivalObserver: undefined as
        | ((arrived: readonly { id: string; scope?: string }[]) => void)
        | undefined,
    };
    const watermarkSinks: Array<(value: unknown) => void> = [];
    const runtime = {
      storageManager: { open: () => ({ replica }) },
      getCellFromLink: (link: { id: string }) => ({
        sink: (cb: (value: unknown) => void) => {
          if (link.id === SERVER_EXECUTION_WATERMARK_DOC_ID) {
            watermarkSinks.push(cb);
          }
          return () => {};
        },
      }),
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);
    const tx = {
      tx: {
        sourceAction: { name: "writer" },
        markWholeDocumentWrites: () => {},
        sealInto: (collector: {
          sealSpaceCommit: (
            space: MemorySpace,
            native: unknown,
            source: unknown,
          ) => Promise<unknown>;
        }) =>
          collector.sealSpaceCommit(
            space,
            {
              operations: [{
                op: "set",
                id: doc,
                scope: "user",
                value: { value: 1 },
              }],
              preconditions: [],
            },
            { sourceAction: { name: "writer" } },
          ).then(() => ({ ok: {} })),
      },
    } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(tx, { actionId: "arrival", kind: "derivation" });
    expect((await destination.seal(tx).settled).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(1);
    // The overlay installed its arrival wake beside the watermark sink.
    expect(replica.speculationArrivalObserver).toBeDefined();
    const arrive = (id: string) =>
      replica.speculationArrivalObserver!([{ id, scope: "user" }]);
    // W < floor (30 < 40): an arrival of the written doc retires NOTHING
    // — the coverage rule stands; the wake is not a relaxation.
    for (const sink of watermarkSinks) sink({ seq: 30 });
    confirmedSeq = 45;
    arrive(doc);
    expect(destination.entryCount(space)).toBe(1);
    expect(destination.arrivalSweepCount).toBe(1);
    // W ≥ floor, but the arrival names a doc no entry wrote: no sweep.
    for (const sink of watermarkSinks) sink({ seq: 40 });
    // (the watermark sink itself swept — and retired nothing? It would
    // retire now: W 40 ≥ floor 40 and confirmedSeq 45 ≥ 40. Re-seal a
    // fresh entry to test the filter on a live one.)
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destination.entryCount(space)).toBe(0);
    confirmedSeq = 0;
    expect((await destination.seal(tx).settled).ok).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destination.entryCount(space)).toBe(1);
    const sweepsBefore = destination.arrivalSweepCount;
    arrive(other);
    expect(destination.arrivalSweepCount).toBe(sweepsBefore);
    expect(destination.entryCount(space)).toBe(1);
    // The arrival of the WRITTEN doc with W ≥ floor: retired.
    confirmedSeq = 46;
    arrive(doc);
    expect(destination.arrivalSweepCount).toBe(sweepsBefore + 1);
    expect(destination.entryCount(space)).toBe(0);
    destination.close();
    expect(replica.speculationArrivalObserver).toBeUndefined();
  });

  it("stage C T2, the LATE-ECHO rule (scripted): an event-handler echo sealed AFTER its intent reached a terminal consequence is dropped at seal — never registered, its writes render nothing; a fresh intent's echo still registers (mutation: check removed → the late echo registers)", async () => {
    let nextLocalSeq = 10;
    const sealed: Array<Record<string, unknown>[]> = [];
    const replica = {
      sealNative: (
        native: { operations: Array<Record<string, unknown>> },
        _source: unknown,
        verdict: Promise<unknown>,
      ) => {
        sealed.push(native.operations);
        const localSeq = nextLocalSeq++;
        return {
          localSeq,
          commit: {
            localSeq,
            reads: { confirmed: [], pending: [] },
            operations: native.operations,
          },
          settled: verdict.then(() => undefined, () => undefined),
        };
      },
      speculationRetirementView: () => ({
        confirmedSeq: 0,
        pendingLocalSeqs: [] as number[],
      }),
      ackedSeqOf: () => undefined,
      speculationAckObserver: undefined as (() => void) | undefined,
      speculationArrivalObserver: undefined,
    };
    // The intent watch is a storage-notification listener (stage C
    // design (e)): the stub manager carries the seam it uses — a relay
    // that accepts subscriptions, a raw replica read (nothing stored),
    // and the schema-less watch.
    const subscribers = new Set<unknown>();
    const runtime = {
      storageManager: {
        open: () => ({
          replica: Object.assign(replica, { getDocument: () => undefined }),
          sync: () => Promise.resolve({ ok: {} }),
        }),
        subscribe: (subscription: unknown) => subscribers.add(subscription),
        unsubscribe: (subscription: unknown) =>
          subscribers.delete(subscription),
      },
      getCellFromLink: () => ({ sink: () => () => {} }),
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);
    const sidecarId = "of:late-echo-sidecar";
    const echoOf = (eventId: string) => {
      const tx = {
        tx: {
          sourceAction: { name: "handler" },
          markWholeDocumentWrites: () => {},
          sealInto: (collector: {
            sealSpaceCommit: (
              space: MemorySpace,
              native: unknown,
              source: unknown,
            ) => Promise<unknown>;
          }) =>
            collector.sealSpaceCommit(
              space,
              {
                operations: [{
                  op: "set",
                  id: "of:toggle",
                  scope: "space",
                  value: { everyoneIsAdmin: true },
                }],
                preconditions: [],
              },
              { sourceAction: { name: "handler" } },
            ).then(() => ({ ok: {} })),
        },
      } as unknown as IExtendedStorageTransaction;
      stampSpeculationRunContext(tx, {
        actionId: "handler",
        kind: "event-handler",
        eventId,
      });
      return tx;
    };
    // Intent 1: fired, then its TERMINAL consequence arrives (a refused
    // delivery — the same `#settleIntentConsequence` seam the consequenced
    // mark, the dropped notice and the served error all reach) BEFORE the
    // client's local dispatch seals its echo.
    destination.trackIntent(space, sidecarId, "evt-late");
    destination.resolveIntent(space, sidecarId, "evt-late", {
      kind: "refused",
      reason: "test: terminal before the echo",
    });
    expect((await destination.seal(echoOf("evt-late")).settled).ok)
      .toBeDefined();
    // Dropped: nothing sealed into the replica, no entry, counted.
    expect(sealed.length).toBe(0);
    expect(destination.entryCount(space)).toBe(0);
    expect(destination.lateEchoDropCount).toBe(1);
    // Intent 2: fired and still pending — its echo registers as before.
    destination.trackIntent(space, sidecarId, "evt-fresh");
    expect((await destination.seal(echoOf("evt-fresh")).settled).ok)
      .toBeDefined();
    expect(sealed.length).toBe(1);
    expect(destination.entryCount(space)).toBe(1);
    expect(destination.lateEchoDropCount).toBe(1);
    // An untracked eventId (a client cascade's minted id) with no
    // terminal parent is never jobless: it registers too.
    expect((await destination.seal(echoOf("evt-cascade-minted")).settled).ok)
      .toBeDefined();
    expect(sealed.length).toBe(2);
    expect(destination.entryCount(space)).toBe(2);
    // The late echo's CASCADE (self-review finding 2): a child echo whose
    // `parentEventId` is the terminal intent is dropped too, and so is
    // ITS child (the dropped run's minted id joins the jobless set) —
    // while a child of a live intent still registers.
    const cascadeOf = (eventId: string, parentEventId: string) => {
      const tx = echoOf(eventId);
      stampSpeculationRunContext(tx, {
        actionId: "handler",
        kind: "event-handler",
        eventId,
        parentEventId,
      });
      return tx;
    };
    expect(
      (await destination.seal(cascadeOf("evt-late-child", "evt-late")).settled)
        .ok,
    ).toBeDefined();
    expect(
      (await destination.seal(
        cascadeOf("evt-late-grandchild", "evt-late-child"),
      ).settled).ok,
    ).toBeDefined();
    expect(sealed.length).toBe(2);
    expect(destination.entryCount(space)).toBe(2);
    expect(destination.lateEchoDropCount).toBe(3);
    expect(
      (await destination.seal(cascadeOf("evt-fresh-child", "evt-fresh"))
        .settled)
        .ok,
    ).toBeDefined();
    expect(sealed.length).toBe(3);
    expect(destination.entryCount(space)).toBe(3);
    // A dropped late echo's enactable effects are OWNED and not enacted
    // (the closed arm's shape): deferSealedEffects returns true without
    // flushing.
    let flushed = 0;
    const dropped = echoOf("evt-late");
    expect((await destination.seal(dropped).settled).ok).toBeDefined();
    expect(
      destination.deferSealedEffects(dropped, [{
        id: "nav:late",
        kind: "navigateTo",
        flush: () => {
          flushed += 1;
        },
      }]),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushed).toBe(0);
    destination.close();
  });

  // The ARRIVAL-WITNESS predicate (speculation.md §4, RULED 2026-08-22 —
  // candidate (B) of the OW33 fork memo): a confirmed cover witnesses
  // arrival only STRICTLY ABOVE the entry's floor (any commit class), or
  // AT the floor when the covering commit is DERIVED-class. An
  // authored-class cover at the floor is the entry's own basis commit —
  // the setup write that created the computed docs' structure (the
  // client's own for a new instance, a prior session's for a resumed
  // one) — and never witnesses the derivation's arrival: the OW33 hole
  // retired first-run speculations on it 40–260 ms before the served
  // value landed. The scripted pins below replay the #6195 review's two
  // decoded store shapes exactly (run 5's new-instance arm: setup at 11,
  // watermark-only advance covering it, values at 13; run 1's resumed
  // arm: a PRE-EXISTING values-free watermark at 7 with the victim's
  // values riding the new settle's first values commit), plus the
  // both-sides contracts the predicate must preserve: the elision
  // posture (cover below the floor stands), the legitimate at-floor
  // derived retirement, above-floor retirement regardless of class, and
  // the fail-closed unknown-class posture at the floor.

  /** A scripted overlay over a fake replica with PER-DOC cover state
   * ({confirmedSeq, coverClass}), the predicate pins' harness — the same
   * seams as the trigger-not-relaxation pin above, extended with the
   * covering commit's class. */
  const scriptedWitnessOverlay = (options: { floorSeq: number }) => {
    let nextLocalSeq = 10;
    const covers = new Map<
      string,
      { confirmedSeq: number; coverClass?: CommitClass }
    >();
    const replica = {
      sealNative: (
        native: { operations: Array<Record<string, unknown>> },
        _source: unknown,
        verdict: Promise<unknown>,
      ) => {
        const localSeq = nextLocalSeq++;
        return {
          localSeq,
          commit: {
            localSeq,
            // The entry's read basis: one confirmed read at the floor
            // seq (the setup commit the speculation's reads sit on).
            reads: {
              confirmed: [{ id: "of:witness-input", seq: options.floorSeq }],
              pending: [],
            },
            operations: native.operations,
          },
          settled: verdict.then(() => undefined, () => undefined),
        };
      },
      speculationRetirementView: (id: string) => ({
        confirmedSeq: covers.get(id)?.confirmedSeq ?? 0,
        coverClass: covers.get(id)?.coverClass,
        pendingLocalSeqs: [] as number[],
      }),
      ackedSeqOf: () => undefined,
      speculationAckObserver: undefined as (() => void) | undefined,
      speculationArrivalObserver: undefined as
        | ((arrived: readonly { id: string; scope?: string }[]) => void)
        | undefined,
    };
    const watermarkSinks: Array<(value: unknown) => void> = [];
    const runtime = {
      storageManager: { open: () => ({ replica }) },
      getCellFromLink: (link: { id: string }) => ({
        sink: (cb: (value: unknown) => void) => {
          if (link.id === SERVER_EXECUTION_WATERMARK_DOC_ID) {
            watermarkSinks.push(cb);
          }
          return () => {};
        },
      }),
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);
    const sealVictim = async (victimId: string) => {
      const tx = {
        tx: {
          sourceAction: { name: "witness-writer" },
          markWholeDocumentWrites: () => {},
          sealInto: (collector: {
            sealSpaceCommit: (
              space: MemorySpace,
              native: unknown,
              source: unknown,
            ) => Promise<unknown>;
          }) =>
            collector.sealSpaceCommit(
              space,
              {
                operations: [{
                  op: "set",
                  id: victimId,
                  scope: "user",
                  value: { value: 1 },
                }],
                preconditions: [],
              },
              { sourceAction: { name: "witness-writer" } },
            ).then(() => ({ ok: {} })),
        },
      } as unknown as IExtendedStorageTransaction;
      stampSpeculationRunContext(tx, {
        actionId: "witness",
        kind: "derivation",
      });
      expect((await destination.seal(tx).settled).ok).toBeDefined();
      // The at-seal sweep is a queued microtask; let it run.
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return {
      destination,
      replica,
      sealVictim,
      setCover: (
        id: string,
        cover: { confirmedSeq: number; coverClass?: CommitClass },
      ) => covers.set(id, cover),
      pushWatermark: (seq: number) => {
        for (const sink of watermarkSinks) sink({ seq });
      },
      arrive: (id: string) =>
        replica.speculationArrivalObserver?.([{ id, scope: "user" }]),
    };
  };

  it("arrival-witness (B), the NEW-INSTANCE arm (run 5's store shape): an AUTHORED cover at exactly the floor — the client's own setup at 11 — does NOT witness arrival when the values-free advance covers the floor; the derived values commit at 13 does", async () => {
    const victim = "of:witness-new-victim";
    const scripted = scriptedWitnessOverlay({ floorSeq: 11 });
    // The setup commit at 11 wrote the victim's STRUCTURE: an
    // authored-class confirmed cover at exactly the entry's floor.
    scripted.setCover(victim, { confirmedSeq: 11, coverClass: "authored" });
    await scripted.sealVictim(victim);
    expect(scripted.destination.entryCount(space)).toBe(1);
    // The values-free advance covers the floor (W ≥ 11) while the
    // victim's served value is still a wave away. Pre-predicate this
    // retired the entry on the authored setup cover — the OW33 hole
    // (the read then saw undefined for 40–260 ms).
    scripted.pushWatermark(11);
    expect(scripted.destination.entryCount(space)).toBe(1);
    // The served derivation lands: a derived-class cover above the
    // floor. The arrival wake re-sweeps and the entry retires.
    scripted.setCover(victim, { confirmedSeq: 13, coverClass: "derived" });
    scripted.arrive(victim);
    expect(scripted.destination.entryCount(space)).toBe(0);
    scripted.destination.close();
  });

  it("arrival-witness (B), the RESUMED-INSTANCE arm (run 1's store shape): a PRIOR session's authored setup cover at the floor plus a PRE-EXISTING values-free watermark does not retire the entry AT SEAL; the new settle's first values commit does", async () => {
    const victim = "of:witness-resumed-victim";
    const scripted = scriptedWitnessOverlay({ floorSeq: 7 });
    // The prior session's setup: an authored confirmed cover at the
    // floor, already in the replica BEFORE this session speculates —
    // and the covering watermark already stands (the prior wave's
    // values-free `watermark→7` commit).
    scripted.setCover(victim, { confirmedSeq: 7, coverClass: "authored" });
    await scripted.sealVictim(victim);
    scripted.pushWatermark(7);
    // Pre-predicate the entry retired AT SEAL against the pre-existing
    // cover (run 1's observed shape: entries retired within the seal's
    // microtask sweep while the victim's values rode the new settle's
    // FIRST values commit, arriving after the read).
    expect(scripted.destination.entryCount(space)).toBe(1);
    // The new settle's first values commit: derived, above the floor.
    scripted.setCover(victim, { confirmedSeq: 8, coverClass: "derived" });
    scripted.arrive(victim);
    expect(scripted.destination.entryCount(space)).toBe(0);
    scripted.destination.close();
  });

  it("arrival-witness (B) preserves the ELISION posture: an unchanged authoritative value writes nothing, so the doc's cover stays BELOW the floor and the value-identical echo stands (both sides of the predicate change)", async () => {
    const victim = "of:witness-elided-victim";
    const scripted = scriptedWitnessOverlay({ floorSeq: 40 });
    // The doc's cover is the OLD derived value at 30; the re-run read a
    // newer input (floor 40) and produced the same output — the server
    // elides the rewrite, so no cover at/above 40 ever appears.
    scripted.setCover(victim, { confirmedSeq: 30, coverClass: "derived" });
    await scripted.sealVictim(victim);
    scripted.pushWatermark(40);
    expect(scripted.destination.entryCount(space)).toBe(1);
    scripted.pushWatermark(50);
    expect(scripted.destination.entryCount(space)).toBe(1);
    scripted.destination.close();
  });

  it("arrival-witness (B) preserves the LEGITIMATE at-floor retirement: a derived-class cover AT the floor — a re-derivation whose run read the already-arrived value at that seq — retires (the case seq-keyed (C) would refuse, stranding chained entries)", async () => {
    const victim = "of:witness-rederived-victim";
    const scripted = scriptedWitnessOverlay({ floorSeq: 40 });
    scripted.setCover(victim, { confirmedSeq: 40, coverClass: "derived" });
    await scripted.sealVictim(victim);
    scripted.pushWatermark(40);
    expect(scripted.destination.entryCount(space)).toBe(0);
    scripted.destination.close();
  });

  it("arrival-witness (B) above the floor: ANY confirmed cover strictly above the floor witnesses arrival — class is consulted only at equality (a foreign authored write above the floor retires; the store has spoken past everything this run consumed)", async () => {
    const victim = "of:witness-above-victim";
    const scripted = scriptedWitnessOverlay({ floorSeq: 40 });
    scripted.setCover(victim, { confirmedSeq: 41, coverClass: "authored" });
    await scripted.sealVictim(victim);
    scripted.pushWatermark(40);
    expect(scripted.destination.entryCount(space)).toBe(0);
    scripted.destination.close();
  });

  it("arrival-witness (B) fails CLOSED on an unknown class at the floor: a cover whose class the replica does not know (an OFF-arm or pre-predicate frame) does not witness at equality — the standing echo stands, never the undefined read; strictly above the floor it retires as always", async () => {
    const victim = "of:witness-unknown-victim";
    const scripted = scriptedWitnessOverlay({ floorSeq: 40 });
    scripted.setCover(victim, { confirmedSeq: 40 });
    await scripted.sealVictim(victim);
    scripted.pushWatermark(40);
    expect(scripted.destination.entryCount(space)).toBe(1);
    scripted.setCover(victim, { confirmedSeq: 41 });
    scripted.arrive(victim);
    expect(scripted.destination.entryCount(space)).toBe(0);
    scripted.destination.close();
  });

  //
  // The class THREADING (the predicate's plumbing)
  //
  // The replica records the covering commit's class on its confirmed record
  // — from the frame's `coverClass` on integrate,
  // preserved across a same-seq re-upsert without one, dropped when the seq
  // moves without one, and `authored` for an own commit's promotion — and
  // `speculationRetirementView` surfaces it to the sweep.
  //

  it("class threading: applySessionSync records the frame's coverClass on the confirmed record, preserves it across a same-seq re-upsert without one, and drops it when the seq moves without one; the retirement view surfaces it", async () => {
    const manager = StorageManager.emulate({ as: aliceSigner });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    try {
      const replica = runtime.storageManager.open(space)
        .replica as SpaceReplica;
      const upsert = (
        seq: number,
        coverClass?: CommitClass,
      ) => ({
        branch: "",
        id: "of:threading-doc",
        scope: "space" as const,
        seq,
        doc: { value: { n: seq } },
        ...(coverClass === undefined ? {} : { coverClass }),
      });
      const view = () =>
        replica.speculationRetirementView("of:threading-doc", "space");
      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 0,
        toSeq: 5,
        upserts: [upsert(5, "derived")],
        removes: [],
      }, "integrate");
      expect(view()).toMatchObject({ confirmedSeq: 5, coverClass: "derived" });
      // A same-seq re-upsert WITHOUT a class (a watch-refresh replay, an
      // OFF-arm or pre-predicate frame echo) preserves the known class —
      // the cover is the same commit.
      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 5,
        toSeq: 5,
        upserts: [upsert(5)],
        removes: [],
      }, "integrate");
      expect(view()).toMatchObject({ confirmedSeq: 5, coverClass: "derived" });
      // A FORWARD move without a class is a different commit: the stale
      // class must not survive onto it.
      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 5,
        toSeq: 6,
        upserts: [upsert(6)],
        removes: [],
      }, "integrate");
      const moved = view();
      expect(moved.confirmedSeq).toBe(6);
      expect(moved.coverClass).toBeUndefined();
    } finally {
      await runtime.dispose();
      await manager.close();
    }
  });

  it("class threading: the arrival wake fires when a same-seq frame supplies the class LATE (undefined -> defined) — an entry failed closed at its floor under an unknown class is re-swept when the class arrives, not stranded until an unrelated commit", async () => {
    const manager = StorageManager.emulate({ as: aliceSigner });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    try {
      const replica = runtime.storageManager.open(space)
        .replica as SpaceReplica;
      const upsert = (seq: number, coverClass?: CommitClass) => ({
        branch: "",
        id: "of:wake-doc",
        scope: "space" as const,
        seq,
        doc: { value: { n: seq } },
        ...(coverClass === undefined ? {} : { coverClass }),
      });
      const sync = (up: SessionSync["upserts"][number]) =>
        replica.accessForTestingOnly.applySessionSync({
          type: "sync",
          fromSeq: 0,
          toSeq: 5,
          upserts: [up],
          removes: [],
        }, "integrate");
      // The doc integrates classless BEFORE the observer exists (the
      // mixed window: a pre-predicate frame, or one from before this
      // client learned the class).
      sync(upsert(5));
      const wakes: Array<readonly { id: string; scope?: string }[]> = [];
      replica.speculationArrivalObserver = (docs) => wakes.push(docs);
      // A same-seq echo still without a class: nothing changed, no wake.
      sync(upsert(5));
      expect(wakes.length).toBe(0);
      // The class arrives LATE at the SAME seq: the predicate's inputs
      // changed, so the arrival wake fires (undefined -> defined).
      sync(upsert(5, "derived"));
      expect(wakes.length).toBe(1);
      expect(wakes[0]).toEqual([{ id: "of:wake-doc", scope: "space" }]);
      // Already known: a repeat carries nothing new, no second wake.
      sync(upsert(5, "derived"));
      expect(wakes.length).toBe(1);
    } finally {
      await runtime.dispose();
      await manager.close();
    }
  });

  it("class threading: an own commit's promotion records `authored` (the transact admission class), end to end through a real server round trip", async () => {
    const alice = openClient(aliceSigner);
    const doc = alice.getCell<{ value: number }>(
      space,
      "threading-own-doc",
      undefined,
    );
    await doc.sync();
    {
      const tx = alice.edit();
      doc.withTx(tx).set({ value: 7 });
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await alice.storageManager.synced();
    const view = (alice.storageManager.open(space).replica as unknown as {
      speculationRetirementView(
        id: string,
        scope?: string,
      ): { confirmedSeq: number; coverClass?: CommitClass };
    }).speculationRetirementView(
      doc.getAsNormalizedFullLink().id,
      "space",
    );
    expect(view.confirmedSeq).toBeGreaterThan(0);
    expect(view.coverClass).toBe("authored");
  });

  //
  // Content-addressed writes (#6304)
  //
  // Both of these turn on a `cid:` document's identity rather than on a cover
  // class: the scripted case witnesses arrival by identity, and the
  // real-replica case decides what a retiring stored-cid speculation renders.
  //

  it("a content-addressed write witnesses arrival by identity (#6304, scripted): a stored `cid:` doc's frozen cover below the floor does not hold the entry — coverage retires it and its array patch stops replaying; a cid doc with NO confirmed cover still holds it (mutation: identity witness removed → the entry stands forever and fabricates a fourth row)", async () => {
    // The #6304 shape: a speculative derivation re-sets an already-stored
    // schema document (`cid:` — content-addressed, so the re-set is a
    // no-op by identity) and patches a shared array doc in the same run.
    // A cid doc's confirmed cover can never advance (every rewrite is
    // identical, so the equality cutoff elides it), so an arrival gate
    // that holds it to `confirmedSeq >= floor` strands the entry forever
    // — and the standing array patch replays over every newer confirmed
    // base, growing the served array past the durable store.
    const cidDoc = "cid:schema-reset" as never;
    const arrayDoc = "of:pivot-rows" as never;
    let nextLocalSeq = 10;
    // Per-doc confirmed covers: the array doc's derivation has arrived
    // ABOVE the floor (46 < 50); the cid doc's cover is frozen at its
    // original registration seq, far below it.
    const views = new Map<
      string,
      { confirmedSeq: number; coverClass?: string }
    >([
      [cidDoc, { confirmedSeq: 22, coverClass: "derived" }],
      [arrayDoc, { confirmedSeq: 50, coverClass: "derived" }],
    ]);
    const replica = {
      sealNative: (
        native: { operations: Array<Record<string, unknown>> },
        _source: unknown,
        verdict: Promise<unknown>,
      ) => {
        const localSeq = nextLocalSeq++;
        return {
          localSeq,
          commit: {
            localSeq,
            // The entry's floor: a confirmed read at seq 46.
            reads: {
              confirmed: [{ id: "of:input", seq: 46 }],
              pending: [],
            },
            operations: native.operations,
          },
          settled: verdict.then(() => undefined, () => undefined),
        };
      },
      speculationRetirementView: (id: string) => ({
        confirmedSeq: views.get(id)?.confirmedSeq ?? 0,
        coverClass: views.get(id)?.coverClass,
        pendingLocalSeqs: [] as number[],
      }),
      ackedSeqOf: () => undefined,
      speculationAckObserver: undefined as (() => void) | undefined,
      speculationArrivalObserver: undefined as (() => void) | undefined,
    };
    const watermarkSinks: Array<(value: unknown) => void> = [];
    const runtime = {
      storageManager: { open: () => ({ replica }) },
      getCellFromLink: (link: { id: string }) => ({
        sink: (cb: (value: unknown) => void) => {
          if (link.id === SERVER_EXECUTION_WATERMARK_DOC_ID) {
            watermarkSinks.push(cb);
          }
          return () => {};
        },
      }),
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);
    const sealBoth = () => {
      const tx = {
        tx: {
          sourceAction: { name: "pivot" },
          markWholeDocumentWrites: () => {},
          sealInto: (collector: {
            sealSpaceCommit: (
              space: MemorySpace,
              native: unknown,
              source: unknown,
            ) => Promise<unknown>;
          }) =>
            collector.sealSpaceCommit(
              space,
              {
                operations: [
                  {
                    op: "patch",
                    id: arrayDoc,
                    scope: "space",
                    patches: [{
                      op: "splice",
                      path: "/value",
                      index: 2,
                      remove: 0,
                      add: [{ row: 3 }],
                    }],
                  },
                  {
                    op: "set",
                    id: cidDoc,
                    scope: "space",
                    value: { schema: true },
                  },
                ],
                preconditions: [],
              },
              { sourceAction: { name: "pivot" } },
            ).then(() => ({ ok: {} })),
        },
      } as unknown as IExtendedStorageTransaction;
      stampSpeculationRunContext(tx, {
        actionId: "pivot",
        kind: "derivation",
      });
      return destination.seal(tx).settled;
    };
    expect((await sealBoth()).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(1);
    // Coverage arrives (W 46 ≥ floor 46). The array doc's cover (50,
    // derived) witnesses above the floor; the cid doc witnesses by
    // identity despite its frozen cover — the entry retires, so its
    // splice stops replaying over the served array. Registration
    // completes before seal() resolves and the watermark callback
    // sweeps synchronously, so no settling wait exists to await.
    for (const sink of watermarkSinks) sink({ seq: 46 });
    expect(destination.entryCount(space)).toBe(0);
    // The identity witness is NOT a relaxation for an UNSTORED schema
    // document: a cid doc with no confirmed cover still holds the entry
    // — dropping its layer would flip local schema resolution to
    // nothing.
    views.set(cidDoc, { confirmedSeq: 0 });
    expect((await sealBoth()).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(1);
    for (const sink of watermarkSinks) sink({ seq: 46 });
    expect(destination.entryCount(space)).toBe(1);
    destination.close();
  });

  it("renders the STORED value when a stored-cid speculation retires (#6304, real replica): an identical re-set and a divergent layer both retire once covered — the store wins over the divergent bytes — while an unstored cid write keeps its entry and its layer standing", async () => {
    // The layered half the scripted pin cannot model: real pending
    // layers over a real confirmed mirror, with values in play. The
    // speculative seals happen BEFORE this replica pulls the cid docs'
    // covers — the shape the schema-doc staging path produces (and the
    // only one a client can produce for an identical value: the
    // transaction layer elides a write it can compare and find
    // unchanged).
    const installer = openClient(spaceSigner);
    // The two installed documents are named by their content, so their
    // stored values differ in a field the assertions never read; the
    // unstored one is never committed, so its id is free.
    const identicalStored = { v: "stored" };
    const divergentStored = { v: "stored", doc: "divergent" };
    const identicalId = `cid:${taggedHashStringOf(identicalStored)}` as never;
    const divergentId = `cid:${taggedHashStringOf(divergentStored)}` as never;
    const unstoredId = "cid:6304-unstored" as never;
    const cellFor = (runtime: Runtime, id: never) =>
      runtime.getCellFromLink<{ v: string; doc?: string }>({
        space,
        id,
        scope: "space",
        path: [],
      });
    {
      const installedIdentical = cellFor(installer, identicalId);
      const installedDivergent = cellFor(installer, divergentId);
      await installedIdentical.sync();
      await installedDivergent.sync();
      const tx = installer.edit();
      installedIdentical.withTx(tx).set(identicalStored);
      installedDivergent.withTx(tx).set(divergentStored);
      expect((await tx.commit().settled).error).toBeUndefined();
      await installer.storageManager.synced();
    }

    // Alice's floor input commits AFTER the cid installs, so her
    // speculation's confirmed read basis sits ABOVE their covers — the
    // configuration whose floor comparison the identity witness exists
    // to bypass.
    const alice = openClient(aliceSigner);
    const input = alice.getCell<{ n: number }>(space, "ag-6304-input");
    await input.sync();
    {
      const tx = alice.edit();
      input.withTx(tx).set({ n: 1 });
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await alice.storageManager.synced();
    const view = (
      alice.storageManager.open(space).replica as unknown as {
        speculationRetirementView(
          id: string,
          scope?: string,
        ): { confirmedSeq: number };
      }
    ).speculationRetirementView.bind(alice.storageManager.open(space).replica);
    const floorSeq =
      view(input.getAsNormalizedFullLink().id, "space").confirmedSeq;
    expect(floorSeq).toBeGreaterThan(0);

    const destination = new SpeculationOverlayDestination(alice);
    const sealCidWrite = async (id: never, value: { v: string }) => {
      const tx = alice.edit();
      // The confirmed read whose seq is the entry's floor.
      expect(input.withTx(tx).get()?.n).toBe(1);
      cellFor(alice, id).withTx(tx).set(value);
      stampSpeculationRunContext(tx, {
        actionId: `6304-${id}`,
        kind: "derivation",
      });
      expect((await destination.seal(tx).settled).ok).toBeDefined();
    };
    await sealCidWrite(identicalId, { v: "stored" });
    await sealCidWrite(divergentId, { v: "divergent" });
    await sealCidWrite(unstoredId, { v: "speculative" });
    expect(destination.entryCount(space)).toBe(3);
    // Pre-retirement the layers render, the divergent bytes included.
    expect(cellFor(alice, identicalId).get()?.v).toBe("stored");
    expect(cellFor(alice, divergentId).get()?.v).toBe("divergent");
    expect(cellFor(alice, unstoredId).get()?.v).toBe("speculative");

    // Coverage, then the stored covers: the watermark passes the floor,
    // and syncing the two installed docs lands their confirmed values
    // (at seqs BELOW the floor) under the standing layers.
    const engine = await server.engineForSpace(space);
    await pushWatermark(installer, Engine.serverSeq(engine));
    await cellFor(alice, identicalId).sync();
    await cellFor(alice, divergentId).sync();
    // The stored-cid entries retire (the identity witness; without it
    // their covers sit below the floor forever and this wait times
    // out); the unstored entry is the one that must remain.
    await waitForCellValue<{ v: string }>(
      alice,
      cellFor(alice, divergentId),
      (value) => value?.v === "stored",
      { stuckLabel: "the divergent cell to render its stored value" },
    );
    expect(destination.entryCount(space)).toBe(1);
    expect(cellFor(alice, identicalId).get()?.v).toBe("stored");
    // THE PIN: the store wins — retirement replaced the divergent
    // speculative bytes with the immutable stored value.
    expect(cellFor(alice, divergentId).get()?.v).toBe("stored");
    // The unstored write's entry stands and its layer still renders:
    // nothing has served that document, so dropping it would flip the
    // read to nothing.
    expect(cellFor(alice, unstoredId).get()?.v).toBe("speculative");
    destination.close();
  });
});
