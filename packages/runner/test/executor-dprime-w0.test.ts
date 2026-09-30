// W1 (d′) — the (d′) pins (stage-C design §2.8 / §6 W1): demand is the
// memory server's TRACKED-IDS CLOSURE and the demand walk is DELETED.
// Seeded from the W0 refutation experiment; the pins now ASSERT (each
// carries a killing mutation, recorded in the W1 build report). Modeled
// on executor-fan-out.test.ts (a real memory server, a live ExecutorHost,
// N flag-ON clients). Run with SCHEDULER_LIVENESS_EQUIVALENCE=1 (T10′).
//
// - T1′ value-only change under a demanded doc → the demanded computed's
//   instances re-derive, W advances, ZERO walk runs (structural: no
//   `demand-walk:*` action exists — T9′);
// - T2′ (probe) a wave writes a NEW LINK within a piece → the closure
//   follows the piece's `source` wiring, so a piece's own computeds are
//   PRE-EMPTED (recorded); the value lands, zero walk runs;
// - T2′ (cross-piece) a wave writes a link to ANOTHER piece's doc into a
//   field the demander watches narrowly (never the firing stream) → the
//   target is NOT pre-empted → it enters the demander's closure on the
//   tracker's push-time re-traversal (a push-growth demandChanged); the
//   deterministic one-push-late shape W0 §5 left unbuilt;
// - T3′ array growth: a handler appends a link-bearing element to a list
//   the demander watches by schema → the appended target enters the
//   closure (same mechanism, through an array);
// - T4′ a per-user change re-runs only that demander's instances;
// - T5′ one registry key per space doc with N pairs; a user-scoped doc
//   under two principals is two keys;
// - T7′ a computed's ABSENT output doc is demanded before it exists (its
//   writer is a root from the first pass) → it lands;
// - P-demand-set the registry keys = ⋃ trackedIds over the client
//   sessions (service excluded);
// - P-coarse a departed session's rows leave and the writers' roots
//   release; a doc tracked by two sessions stays while one remains;
// - P-arrival a second principal arriving after narrowing gets her
//   instance (the per-key not-current re-arm / root arrival re-arm);
// - T9′ OFF arm: `demandedWriters` empty on a plain client runtime.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import {
  ArrivalLog,
  awaitAdmitted,
  awaitEach,
} from "./support/serving-waits.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("dprime w0 space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("dprime w0 service");
const aliceSigner = await Identity.fromPassphrase("dprime w0 alice");
const bobSigner = await Identity.fromPassphrase("dprime w0 bob");
const carolSigner = await Identity.fromPassphrase("dprime w0 carol");

const FAN_OUT_PATTERN = [
  "import { computed, Default, pattern, PerUser, Writable } from 'commonfabric';",
  "type Draft = Writable<string | Default<''>>;",
  "const text = (cell: Draft): string => (cell.get() as string | undefined) ?? '';",
  "export default pattern<",
  "  { draft?: PerUser<Draft>; n?: number },",
  "  { echo: string; label: string }",
  ">(({ draft, n }) => {",
  "  const draftCell: Draft = draft!;",
  "  return {",
  "    echo: computed(() => 'echo:' + text(draftCell)),",
  "    label: computed(() => 'label:' + String(n ?? 0)),",
  "  };",
  "});",
].join("\n");

/** P-arrival-closure (MAJOR-1 of the W1 review): an OUTER piece that
 * instantiates a NESTED child with a per-user `echo`, and a `publish`
 * handler that writes a LINK to the CHILD'S RESULT doc into a plain
 * holder doc. A principal who watches the HOLDER (never the outer root,
 * never the child's root) reaches the narrowed `echo` output doc only
 * through NON-ROOT closure rows — the root-level arrival re-arm is
 * structurally inert for her (her root is not a piece), so only the
 * per-key currency check (design §2.2 step 3) can materialize her
 * instance. */
const NESTED_PUBLISH_PATTERN = [
  "import { computed, Default, handler, pattern, PerUser, Stream, Writable } from 'commonfabric';",
  "type Draft = Writable<string | Default<''>>;",
  "const text = (cell: Draft): string => (cell.get() as string | undefined) ?? '';",
  "const inner = pattern<{ draft: Draft; n?: number }, { echo: string; label: string }>(",
  "  ({ draft, n }) => ({",
  "    echo: computed(() => 'echo:' + text(draft)),",
  "    label: computed(() => 'label:' + String(n ?? 0)),",
  "  }),",
  ");",
  "const publish = handler<unknown, { slot: Writable<unknown>; target: Writable<unknown> }>(",
  "  (_ev, { slot, target }) => { slot.set(target); },",
  ");",
  "export default pattern<",
  "  { draft?: PerUser<Draft>; n?: number; slot?: Writable<unknown> },",
  "  { slot: unknown; child: { echo: string; label: string }; publish: Stream<unknown> }",
  ">(({ draft, n, slot }) => {",
  "  const child = inner({ draft: draft!, n });",
  "  return { slot, child, publish: publish({ slot: slot!, target: child }) };",
  "});",
].join("\n");

/** OW51 option-3 contract pin: a computed whose `src` argument holds a
 * stored LINK to a doc NOBODY has written — a genuine unresolved input
 * behind a followed hop, so the served run is REFUSAL-DISPOSED with the
 * dead-end doc's read registered. A FOREIGN writer later creates the
 * doc; the registered read must re-fire the disposed run. */
const FOREIGN_ARRIVAL_PATTERN = [
  "import { computed, pattern, Writable } from 'commonfabric';",
  "export default pattern<",
  "  { n?: number; src?: Writable<string> },",
  "  { view: string }",
  ">(({ src }) => ({",
  "  view: computed(() => 'view:' + (src!.get() as string)),",
  "}));",
].join("\n");

/** T2′ (isolated): a HANDLER writes a LINK to a computed it never reads
 * (`slot.set(hiddenCell)` — the link-tool shape); `hidden` is exposed
 * nowhere else, so it is reachable only through the link the wave writes. */
const LINK_ON_EVENT_PATTERN = [
  "import { computed, handler, pattern, Stream, Writable } from 'commonfabric';",
  "const pick = handler<unknown, { slot: Writable<unknown>; hidden: string }>(",
  "  (_ev, { slot, hidden }) => { slot.set(hidden); },",
  ");",
  "export default pattern<",
  "  { n?: number; slot?: Writable<unknown> },",
  "  { slot: unknown; pick: Stream<unknown> }",
  ">(({ n, slot }) => {",
  "  const hidden = computed(() => 'hidden:' + String(n ?? 0));",
  "  return { slot, pick: pick({ slot: slot!, hidden }) };",
  "});",
].join("\n");

/** T2′ (cross-piece): P1 relays an ARG-carried link into `slot` on an
 * event — `slot.set(target.get())`. The link target is a SEPARATE piece's
 * result doc (P2), NOT part of P1's own `source` wiring, so a demander
 * watching P1's `slot` narrowly does not pre-empt P2 through the wiring:
 * P2 enters the demander's closure only when the wave writes the link
 * (§2.3 (i) — the tracker's push-time re-traversal). */
const CROSS_RELAY_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const relay = handler<unknown, { slot: Writable<unknown>; target: Writable<unknown> }>(",
  "  (_ev, { slot, target }) => { slot.set(target); },",
  ");",
  "export default pattern<",
  "  { slot?: Writable<unknown>; target?: Writable<unknown> },",
  "  { slot: unknown; relay: Stream<unknown> }",
  ">(({ slot, target }) => ({ slot, relay: relay({ slot: slot!, target: target! }) }));",
].join("\n");

/** T2′/T3′: the LEAF piece (P2). A space-scoped computed `leaf` the
 * cross-piece link (and the appended array element) points at. */
const LEAF_PATTERN = [
  "import { computed, pattern } from 'commonfabric';",
  "export default pattern<{ n?: number }, { leaf: string }>(",
  "  ({ n }) => ({ leaf: computed(() => 'leaf:' + String(n ?? 0)) }),",
  ");",
].join("\n");

/** T3′ (array growth): a handler PUSHES a link onto a list the demander
 * watches by schema; the appended element carries a link to P2's doc, so
 * the appended target enters the closure on the tracker's re-traversal. */
const LIST_GROW_PATTERN = [
  "import { Default, handler, pattern, Stream, Writable } from 'commonfabric';",
  "type List = Writable<unknown[] | Default<[]>>;",
  "const push = handler<unknown, { list: List; target: Writable<unknown> }>(",
  "  (_ev, { list, target }) => {",
  "    const cur = (list.get() as unknown[] | undefined) ?? [];",
  "    list.set([...cur, target]);",
  "  },",
  ");",
  "export default pattern<",
  "  { list?: List; target?: Writable<unknown> },",
  "  { list: unknown[]; push: Stream<unknown> }",
  ">(({ list, target }) => ({ list: list!, push: push({ list: list!, target: target! }) }));",
].join("\n");

const rowsUnder = (
  engine: Engine.Engine,
  scopeKey: string,
): Map<string, unknown> => {
  const rows = engine.database.prepare(
    `SELECT id FROM head WHERE scope_key = :scope_key AND op != 'delete'`,
  ).all({ scope_key: scopeKey }) as Array<{ id: string }>;
  const out = new Map<string, unknown>();
  for (const { id } of rows) {
    out.set(id, Engine.read(engine, { id, scopeKey } as never)?.value);
  }
  return out;
};

const instanceHolds = (
  engine: Engine.Engine,
  scopeKey: string,
  needle: string,
): boolean =>
  [...rowsUnder(engine, scopeKey).values()].some((value) =>
    JSON.stringify(value ?? null).includes(needle)
  );

describe("W1 (d′): demand = the tracked-ids closure, the walk deleted", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let servingRuntime: Runtime | undefined;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
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
        runtime.scheduler.setActionRunTraceEnabled(true);
        servingRuntime = runtime;
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      onWaveCycle: cycles.record,
      onActivationSettled: (activatedSpace, outcome) =>
        activations.record({ space: activatedSpace, outcome }),
    });

  beforeEach(() => {
    sessions = new MemoryV2Server.SessionRegistry({ ttlMs: 500 });
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      sessions,
    });
    managers = [];
    runtimes = [];
    servingRuntime = undefined;
    cycles = new ArrivalLog();
    activations = new ArrivalLog();
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  /** Every wave cycle the host's tenure completes — the edge the demand
   * pass's own bookkeeping moves behind. */
  let cycles: ArrivalLog<unknown>;
  let activations: ArrivalLog<{ space: string; outcome: string }>;
  /** The registry is the test's own: a departing client's session
   * detaches and lingers for the resume window, and a lingering
   * session's watches are still DEMAND, so departures remove the
   * session outright rather than waiting the window out. */
  let sessions: MemoryV2Server.SessionRegistry;

  /** Resolves once the space has an ACTIVE tenure. */
  const activated = (): Promise<unknown> =>
    activations.matching((entry) =>
      entry.space === space && entry.outcome === "active"
    );

  /** Wake the loop with a demand note and wait for the cycle it runs.
   * Ordered after the demand pass, and it writes nothing — which is
   * what a file measuring demand rows, waves and wakes needs from a
   * barrier. */
  const settleACycle = async (): Promise<void> => {
    // The tenure has to exist before its demand can be poked. Activation
    // is driven from the admission feed, so a caller that has only
    // committed does not yet have one.
    await activated();
    const spaceServer = host!.spaceServer(space)!;
    // Poke only once the loop is waiting for input. A cycle already in
    // flight ends after the note and would satisfy the wait below without
    // the note's own pass having run.
    await awaitEach(cycles, () => spaceServer.suspendedOnInput);
    const before = cycles.entries.length;
    spaceServer.noteDemandChanged();
    await cycles.reached(before + 1);
  };

  const openClient = (signer: Identity): {
    runtime: Runtime;
    manager: EmulatedStorageManager;
  } => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    managers.push(manager);
    runtimes.push(runtime);
    return { runtime, manager };
  };

  const demandRows = () =>
    server.demandedInstancesForSpace(space, {
      excludePrincipal: serviceSigner.did(),
    });
  const walkRuns = () =>
    servingRuntime!.scheduler.getActionRunTrace().filter((entry) =>
      entry.actionId.startsWith("demand-walk:")
    ).length;

  const standUp = async (options: {
    names: { arg: string; result: string };
    pattern?: string;
    clients: Identity[];

    /** Extra ARGUMENT fields seeded beside `{ n: 1 }` (a pin that needs
     * a holder cell or a cross-piece link in the outer piece's arg). */
    argExtras?: (alice: Runtime) => Promise<Record<string, unknown>>;
  }) => {
    host = newHost();
    const aliceClient = openClient(aliceSigner);
    const alice = aliceClient.runtime;
    const engine = await server.engineForSpace(space);
    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: options.pattern ?? FAN_OUT_PATTERN,
      }],
    }, { space });
    const aliceArg = alice.getCell<Record<string, unknown>>(
      space,
      options.names.arg,
      undefined,
    );
    const aliceResult = alice.getCell<Record<string, unknown>>(
      space,
      options.names.result,
      compiled.resultSchema,
    );
    await aliceArg.sync();
    await aliceResult.sync();
    {
      const extras = options.argExtras === undefined
        ? {}
        : await options.argExtras(alice);
      const seed = alice.edit();
      aliceArg.withTx(seed).set({ n: 1, ...extras });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, compiled, aliceArg, aliceResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    const argId = aliceArg.getAsNormalizedFullLink().id;
    const resultId = aliceResult.getAsNormalizedFullLink().id;

    const clients = new Map<
      string,
      { runtime: Runtime; manager: EmulatedStorageManager }
    >([
      [aliceSigner.did(), aliceClient],
    ]);
    const cancels: Array<() => void> = [];
    const watchRoot = async (signer: Identity) => {
      const client = clients.get(signer.did()) ?? openClient(signer);
      clients.set(signer.did(), client);
      const result = client.runtime.getCell<Record<string, unknown>>(
        space,
        options.names.result,
        compiled.resultSchema,
      );
      await result.sync();
      cancels.push(result.sink(() => {}));
      return client;
    };
    for (const signer of options.clients) await watchRoot(signer);
    await activated();
    await awaitEach(cycles, () => {
      const demanded = host!.spaceServer(space)?.demandedIdentitiesOf(
        resultId,
      ) ?? [];
      return options.clients.every((signer) =>
        demanded.some((i) => i.principal === signer.did())
      );
    });
    const typedArg = (runtime: Runtime) =>
      runtime.getCell<{ draft: string; flag: boolean; n: number }>(
        space,
        options.names.arg,
        compiled.argumentSchema,
      );
    const writeDraft = async (runtime: Runtime, value: string) => {
      const arg = typedArg(runtime);
      await arg.sync();
      const tx = runtime.edit();
      arg.key("draft").withTx(tx).set(value);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      await runtime.storageManager.synced();
    };
    const userKey = (signer: Identity) =>
      resolveScopeKey("user", { principal: signer.did() });
    return {
      engine,
      compiled,
      argId,
      resultId,
      clients,
      watchRoot,
      writeDraft,
      typedArg,
      userKey,
      cancel: () => cancels.forEach((cancel) => cancel()),
    };
  };

  it("T1′/T4′/T5′/T7′/T9′/P-demand-set: value-only change re-derives the demanded per-user computed for THAT user only, W advances, zero walk runs; the registry is the closure; a computed demanded before it exists lands", async () => {
    host = newHost();
    // T9′ (OFF half): a plain client runtime has an EMPTY demanded-writer set.
    const probeClient = openClient(bobSigner);
    expect(probeClient.runtime.scheduler.demandedWriterCount).toBe(0);
    await probeClient.runtime.dispose();
    await probeClient.manager.close();
    sessions.remove(space, probeClient.manager.id);
    runtimes.splice(runtimes.indexOf(probeClient.runtime), 1);
    managers.splice(managers.indexOf(probeClient.manager), 1);
    host.close();
    const setup = await standUp({
      names: { arg: "dp-a-arg", result: "dp-a-result" },
      clients: [aliceSigner, bobSigner],
    });
    const { engine, clients } = setup;
    const alice = clients.get(aliceSigner.did())!.runtime;
    const bob = clients.get(bobSigner.did())!.runtime;
    const aliceKey = setup.userKey(aliceSigner);
    const bobKey = setup.userKey(bobSigner);

    // T7′: the `label` and `echo` computeds' output docs are demanded
    // (in the closure) — the writer is a root — and land server-side.
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, "space", '"label:1"'),
    );
    const rowsAfterLanding = demandRows();
    const computedRows = rowsAfterLanding.filter((r) =>
      r.id.startsWith("computed:")
    );
    console.log(
      `[T7′] demand rows=${rowsAfterLanding.length} computed rows=${computedRows.length} (root:true ${
        computedRows.filter((r) => r.root).length
      } / root:false ${computedRows.filter((r) => !r.root).length}); ` +
        `demandedWriters=${servingRuntime!.scheduler.demandedWriterCount}; ` +
        `demandedEntities=${servingRuntime!.scheduler.demandedEntityCount}`,
    );
    expect(servingRuntime!.scheduler.demandedWriterCount).toBeGreaterThan(0);

    // T1′ + T4′: Alice's per-user draft → only Alice's echo instance
    // re-derives; W advances; ZERO walk runs.
    await setup.writeDraft(alice, "A");
    await setup.writeDraft(bob, "B");
    await awaitAdmitted(
      server,
      () =>
        instanceHolds(engine, aliceKey, '"echo:A"') &&
        instanceHolds(engine, bobKey, '"echo:B"'),
    );
    const traceBefore = servingRuntime!.scheduler.getActionRunTrace().length;
    const wBefore = host!.spaceServer(space)!.watermark;
    await setup.writeDraft(alice, "A2");
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, aliceKey, '"echo:A2"'),
    );
    await awaitEach(
      cycles,
      () => host!.spaceServer(space)!.watermark > wBefore,
    );
    const since = servingRuntime!.scheduler.getActionRunTrace().slice(
      traceBefore,
    );
    // T4′: no run under Bob's instance for Alice's change.
    expect(
      since.filter((e) => e.instanceKey === bobKey).map((e) => e.actionId),
    ).toEqual([]);
    expect(instanceHolds(engine, bobKey, '"echo:A2"')).toBe(false);
    // T9′ (structural): zero walk runs, ever.
    expect(walkRuns()).toBe(0);

    // T5′ + P-demand-set: registry keys = the closure's instance keys.
    const rows = demandRows();
    const keys = new Set(rows.map((r) => `${r.scopeKey}\0${r.id}`));
    const resultRows = rows.filter((r) => r.id === setup.resultId);
    // The space-scoped result root: ONE key, N pairs (one per session).
    expect(new Set(resultRows.map((r) => r.scopeKey))).toEqual(
      new Set(["space"]),
    );
    expect(resultRows.length).toBeGreaterThanOrEqual(2);
    // A user-scoped doc under two principals: two keys.
    const userKeyed = rows.filter((r) => r.scopeKey.startsWith("user:"));
    const principals = new Set(userKeyed.map((r) => r.scopeKey));
    console.log(
      `[T5′] keys=${keys.size} rows=${rows.length} result-root pairs=${resultRows.length} user-instance keys=${principals.size}`,
    );
    expect(principals.has(aliceKey)).toBe(true);
    expect(principals.has(bobKey)).toBe(true);
    const sizes = server.demandSetSizesForSpace(space, {
      excludePrincipal: serviceSigner.did(),
    });
    expect(sizes.unionKeys).toBe(keys.size);
    const stats = host!.stats();
    // MINOR-2: within a single tenure (no park) the space-lived
    // enter/leave accumulators fold the FULL delta since the last fold, so
    // they equal the scheduler's own running counters exactly — no
    // transition is lost (a pass-START snapshot would drop any counted
    // between passes; the demand notes below drive passes without input).
    expect(stats.demand.demandRootEnters).toBe(
      servingRuntime!.scheduler.demandRootCounters.enters,
    );
    expect(stats.demand.demandRootLeaves).toBe(
      servingRuntime!.scheduler.demandRootCounters.leaves,
    );
    console.log(
      `[T1′] demand=${
        JSON.stringify({ ...stats.demand, sizeSeries: undefined })
      }`,
    );
    console.log(
      `[T1′] settle series (ms/class/waves/growthWakes): ${
        JSON.stringify(
          stats.settle.series.map((s) => [
            Math.round(s.ms),
            s.class,
            s.waves,
            s.growthWakes,
          ]),
        )
      }`,
    );
    setup.cancel();
  });

  it("T2′ probe: a wave writes a NEW LINK (a served handler sets slot := hidden, a computed it never reads) with a NON-creator, schema-narrowed ({slot:string}, additionalProperties:false) demander → RECORDS whether the target was already demanded (the closure follows the piece's `source`/process wiring, so a piece's own computeds are pre-empted), how it entered (tracker closure vs client pull), the cycle count and the settle split; asserts the landing and zero walk runs", async () => {
    // Alice CREATES the piece and DEPARTS (her session's tracked set —
    // which pulled every doc her local run read — leaves after the TTL);
    // Bob then watches ONLY the result root WITH THE RESULT SCHEMA, so
    // his closure is exactly what the schema reaches: the result doc,
    // `view`'s ifElse output doc — and, only after the flip writes the
    // link, `guarded`'s doc.
    host = newHost();
    const aliceClient = openClient(aliceSigner);
    const alice = aliceClient.runtime;
    const engine = await server.engineForSpace(space);
    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: LINK_ON_EVENT_PATTERN }],
    }, { space });
    const aliceArg = alice.getCell<Record<string, unknown>>(
      space,
      "dp-b-arg",
      undefined,
    );
    const aliceResult = alice.getCell<Record<string, unknown>>(
      space,
      "dp-b-result",
      compiled.resultSchema,
    );
    await aliceArg.sync();
    await aliceResult.sync();
    {
      const seed = alice.edit();
      aliceArg.withTx(seed).set({ n: 7 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, compiled, aliceArg, aliceResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    const resultId = aliceResult.getAsNormalizedFullLink().id;
    // Alice departs.
    await alice.dispose();
    await aliceClient.manager.close();
    sessions.remove(space, aliceClient.manager.id);
    runtimes.splice(runtimes.indexOf(alice), 1);
    managers.splice(managers.indexOf(aliceClient.manager), 1);
    await settleACycle();
    // Bob: the ONLY demander, schema-narrowed root watch.
    const bobClient = openClient(bobSigner);
    const bob = bobClient.runtime;
    // Bob's DEMAND: a NARROW schema — only `slot` (a string) — so the
    // closure is the result doc plus, once the link exists, the string
    // behind `slot`. (`unknown` / Stream fields reach the whole wiring —
    // handler bindings, ifElse inputs — which is why the earlier shapes
    // found the target already demanded; recorded in the report.)
    const bobResult = bob.getCell<Record<string, unknown>>(
      space,
      "dp-b-result",
      {
        type: "object",
        properties: { slot: { type: "string" } },
        additionalProperties: false,
      } as never,
    );
    await bobResult.sync();
    const cancel = bobResult.sink(() => {});
    // The event is fired through a FULL-schema cell (the stream lives
    // under `pick`); the client's own speculative run may pull docs —
    // the row's `root` flag below says whether the target entered
    // through the tracker (closure) or a client pull (root).
    const bobFull = bob.getCell<Record<string, unknown>>(
      space,
      "dp-b-result",
      compiled.resultSchema,
    );
    await activated();
    await awaitEach(
      cycles,
      () =>
        (host!.spaceServer(space)?.demandedIdentitiesOf(resultId) ?? [])
          .some((i) => i.principal === bobSigner.did()),
    );
    // Quiesce and let Alice's departed rows leave the set.
    await awaitEach(cycles, () => {
      host!.spaceServer(space)!.noteDemandChanged();
      return demandRows().every((r) =>
        r.identity?.principal === bobSigner.did()
      );
    });
    await servingRuntime!.idle();
    await settleACycle();
    const before = demandRows();
    const guardedRowsBefore = before.filter((r) =>
      r.id.startsWith("computed:")
    );
    const writersBefore = servingRuntime!.scheduler.demandedWriterCount;
    const wakesBefore = host!.stats().demand.pushGrowthWakes;
    const wavesBefore = host!.stats().waves;
    const derivedBefore = host!.stats().derivedCommits;
    const seriesBefore = host!.stats().settle.series.length;
    const guardedPresentBefore = instanceHolds(engine, "space", '"hidden:7"');
    console.log(
      `[T2′ pre rows] ${
        JSON.stringify(
          before.map((
            r,
          ) => [r.id.slice(0, 40), r.scopeKey, r.root ? "root" : "closure"]),
        )
      }`,
    );
    console.log(
      `[T2′ pre] rows=${before.length} computed rows=${guardedRowsBefore.length} (${
        guardedRowsBefore.map((r) => (r.root ? "root" : "closure")).join(",")
      }) demandedWriters=${writersBefore} guarded present=${guardedPresentBefore}`,
    );
    // Bob fires the `pick` event (an authored input; the served handler
    // writes the NEW LINK slot → hidden, reading nothing of hidden).
    const t0 = performance.now();
    bobFull.key("pick").send({});
    await bob.idle();
    await bob.storageManager.synced();
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, "space", '"hidden:7"'),
    );
    const landedMs = performance.now() - t0;
    await settleACycle();
    const stats = host!.stats();
    const after = demandRows();
    const newRows = after.filter((r) =>
      !before.some((b) => b.id === r.id && b.scopeKey === r.scopeKey)
    );
    console.log(
      `[T2′] guarded landed in ${Math.round(landedMs)} ms after bob's flip; ` +
        `waves +${stats.waves - wavesBefore}, derivedCommits +${
          stats.derivedCommits - derivedBefore
        }, pushGrowthWakes +${stats.demand.pushGrowthWakes - wakesBefore}, ` +
        `demandedWriters ${writersBefore} → ${
          servingRuntime!.scheduler.demandedWriterCount
        }, ` +
        `new rows=${newRows.length} [${
          newRows.map((r) =>
            `${r.id.slice(0, 18)}…:${r.root ? "root" : "closure"}`
          ).join(", ")
        }]; settle entries since: ${
          JSON.stringify(
            stats.settle.series.slice(seriesBefore).map((s) => ({
              ms: Math.round(s.ms),
              cls: s.class,
              waves: s.waves,
              gw: s.growthWakes,
              msGrowth: (s as { msGrowth?: number }).msGrowth === undefined
                ? undefined
                : Math.round((s as { msGrowth?: number }).msGrowth!),
              growthWaves: (s as { growthWaves?: number }).growthWaves,
              graceMs: (s as { graceMs?: number }).graceMs === undefined
                ? undefined
                : Math.round((s as { graceMs?: number }).graceMs!),
            })),
          )
        }`,
    );
    console.log(
      `[T2′ verdict] target demanded BEFORE the link: ${
        guardedPresentBefore ? "YES (pre-empted)" : "no"
      }; ` +
        `entered via: ${
          newRows.some((r) => r.id.startsWith("computed:") && !r.root)
            ? "TRACKER re-traversal (closure row)"
            : newRows.some((r) => r.id.startsWith("computed:") && r.root)
            ? "CLIENT pull (root row)"
            : "already present"
        }`,
    );
    expect(walkRuns()).toBe(0);
    cancel();
  });

  it("P-coarse: a departed session's rows leave and its writers' roots release; a doc tracked by two sessions stays while one remains", async () => {
    const setup = await standUp({
      names: { arg: "dp-c-arg", result: "dp-c-result" },
      clients: [aliceSigner, bobSigner],
    });
    const { engine, clients } = setup;
    const alice = clients.get(aliceSigner.did())!.runtime;
    const bob = clients.get(bobSigner.did())!;
    const aliceKey = setup.userKey(aliceSigner);
    const bobKey = setup.userKey(bobSigner);
    await setup.writeDraft(alice, "A");
    await setup.writeDraft(bob.runtime, "B");
    await awaitAdmitted(
      server,
      () =>
        instanceHolds(engine, aliceKey, '"echo:A"') &&
        instanceHolds(engine, bobKey, '"echo:B"'),
    );
    await servingRuntime!.idle();
    await settleACycle();
    const writersBefore = servingRuntime!.scheduler.demandedWriterCount;
    const keysBefore = server.demandSetSizesForSpace(space, {
      excludePrincipal: serviceSigner.did(),
    }).unionKeys;
    const bobRowsBefore = demandRows().filter((r) => r.scopeKey === bobKey);
    expect(bobRowsBefore.length).toBeGreaterThan(0);
    // Bob departs: his runtime and connection close; the session prunes
    // after the (short) TTL; the next demand pass sees his rows gone.
    await bob.runtime.dispose();
    await bob.manager.close();
    sessions.remove(space, bob.manager.id);
    runtimes.splice(runtimes.indexOf(bob.runtime), 1);
    managers.splice(managers.indexOf(bob.manager), 1);
    await settleACycle();
    // Drive a pass (a demand note; a real input would do the same).
    await awaitEach(cycles, () => {
      host!.spaceServer(space)!.noteDemandChanged();
      return demandRows().filter((r) => r.scopeKey === bobKey).length === 0;
    });
    await settleACycle();
    const writersAfter = servingRuntime!.scheduler.demandedWriterCount;
    const keysAfter = server.demandSetSizesForSpace(space, {
      excludePrincipal: serviceSigner.did(),
    }).unionKeys;
    const stats = host!.stats();
    console.log(
      `[P-coarse] keys ${keysBefore} → ${keysAfter}; demandedWriters ${writersBefore} → ${writersAfter}; enters=${stats.demand.demandRootEnters} leaves=${stats.demand.demandRootLeaves}; registry keys=${stats.demand.demandedInstances}`,
    );
    // The space doc (the result root) tracked by Alice STAYS; the
    // registry shrank (Bob's user-instance keys left); roots released
    // only for writers whose every demanded key left (leaves counted).
    expect(keysAfter).toBeLessThan(keysBefore);
    expect(
      demandRows().some((r) =>
        r.id === setup.resultId && r.scopeKey === "space"
      ),
    ).toBe(true);
    expect(stats.demand.demandedInstances).toBe(keysAfter);
    expect(stats.demand.demandRootLeaves).toBeGreaterThanOrEqual(0);
    // Alice's demand still serves: her next draft re-derives.
    await setup.writeDraft(alice, "A2");
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, aliceKey, '"echo:A2"'),
    );
    setup.cancel();
  });

  it("P-release (root leave / 1→0): a writer demanded ONLY through a departing session releases its root status when that session leaves (a 1→0 transition — demandedWriters drops, demandRootLeaves increments) and goes DORMANT (a later write to its input does not re-derive server-side), while a writer a REMAINING session still demands stays a root and keeps re-deriving", async () => {
    // MAJOR-2 of the W1 review: P-coarse never exercised a root release
    // (its departing keys named WRITERLESS entities — a per-user instance
    // row of a space-declared doc maps to a `user/…` entity while the
    // writer is indexed under `space/…`), so `demandRootLeaves` stayed 0
    // and a no-op `leaveDemandedEntity` (M-B) was green. This pin drives a
    // genuine 1→0: two SEPARATE pieces, each with its OWN space-scoped
    // `label` writer, one demanded only through Bob's session.
    //
    // The releasing writer must be demanded by NO other session — and a
    // creator's session tracks every doc its local run pulled, so the
    // SOLO piece is created BY BOB (not Alice): only Bob's session ever
    // names its `label` doc. When Bob leaves, that space key departs (no
    // remaining pair) → `leaveDemandedEntity` 1→0 → the writer releases.
    // Killing mutation (review M-B): `leaveDemandedEntity` a no-op → the
    // solo writer never releases (`demandRootLeaves` 0; a later write
    // re-derives — dormancy fails).
    host = newHost();
    const aliceClient = openClient(aliceSigner);
    const alice = aliceClient.runtime;
    const bobClient = openClient(bobSigner);
    const bob = bobClient.runtime;
    const engine = await server.engineForSpace(space);
    const make = async (rt: Runtime, argName: string, resultName: string) => {
      const compiled = await rt.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: FAN_OUT_PATTERN }],
      }, { space });
      const arg = rt.getCell<Record<string, unknown>>(
        space,
        argName,
        undefined,
      );
      const result = rt.getCell<Record<string, unknown>>(
        space,
        resultName,
        compiled.resultSchema,
      );
      await arg.sync();
      await result.sync();
      {
        const seed = rt.edit();
        arg.withTx(seed).set({ n: 1 });
        expect((await seed.commit()).error).toBeUndefined();
      }
      {
        const tx = rt.edit();
        rt.run(tx, compiled, arg, result);
        expect((await tx.commit()).error).toBeUndefined();
      }
      await rt.idle();
      await rt.storageManager.synced();
      return { compiled, resultId: result.getAsNormalizedFullLink().id };
    };
    // Alice creates+watches SHARED; Bob creates SOLO. Both watch SHARED;
    // only Bob watches SOLO. (A space `label` computed per piece — the
    // writer that becomes a demand root; `label:1` is its landed value.)
    const shared = await make(alice, "dp-r-sh-arg", "dp-r-sh-res");
    const solo = await make(bob, "dp-r-so-arg", "dp-r-so-res");
    const cancels: Array<() => void> = [];
    const watch = async (
      rt: Runtime,
      resultName: string,
      compiled: { resultSchema: unknown },
    ) => {
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        resultName,
        compiled.resultSchema as never,
      );
      await cell.sync();
      cancels.push(cell.sink(() => {}));
    };
    await watch(alice, "dp-r-sh-res", shared.compiled);
    await watch(bob, "dp-r-sh-res", shared.compiled);
    await watch(bob, "dp-r-so-res", solo.compiled);
    await activated();
    await awaitEach(
      cycles,
      () =>
        instanceHolds(engine, "space", '"label:1"') &&
        (host!.spaceServer(space)?.demandedIdentitiesOf(solo.resultId) ?? [])
          .some((i) => i.principal === bobSigner.did()),
    );
    await servingRuntime!.idle();
    await settleACycle();
    const writersBefore = servingRuntime!.scheduler.demandedWriterCount;
    const leavesBefore = host!.stats().demand.demandRootLeaves;
    expect(writersBefore).toBeGreaterThanOrEqual(4);
    // Bob departs (his runtime + connection close; the session prunes
    // after the TTL). His solo piece's `label` doc then has no remaining
    // demander; the shared piece's `label` doc still has Alice's.
    await bob.dispose();
    await bobClient.manager.close();
    sessions.remove(space, bobClient.manager.id);
    runtimes.splice(runtimes.indexOf(bob), 1);
    managers.splice(managers.indexOf(bobClient.manager), 1);
    await settleACycle();
    await awaitEach(cycles, () => {
      host!.spaceServer(space)!.noteDemandChanged();
      return demandRows().filter((r) =>
        r.identity?.principal === bobSigner.did()
      ).length === 0;
    });
    await settleACycle();
    const writersAfter = servingRuntime!.scheduler.demandedWriterCount;
    const leavesAfter = host!.stats().demand.demandRootLeaves;
    console.log(
      `[P-release] demandedWriters ${writersBefore} → ${writersAfter}; ` +
        `demandRootLeaves ${leavesBefore} → ${leavesAfter}`,
    );
    // A genuine 1→0: the solo piece's writers left the root set, and the
    // leave was COUNTED (M-B — a no-op leave — leaves this flat, RED).
    expect(writersAfter).toBeLessThan(writersBefore);
    expect(leavesAfter).toBeGreaterThan(leavesBefore);
    // DORMANCY: a write to the SOLO piece's input (its space `n`) does
    // NOT re-derive server-side — its `label` writer is no longer a
    // demand root, so the dirtied node stays unmaterialized. (M-B keeps
    // the writer a root → `label:2` lands → this assertion RED.)
    const soloArg = alice.getCell<{ n: number }>(
      space,
      "dp-r-so-arg",
      { type: "object", properties: { n: { type: "number" } } } as never,
    );
    await soloArg.sync();
    {
      const tx = alice.edit();
      soloArg.key("n").withTx(tx).set(2);
      expect((await tx.commit()).error).toBeUndefined();
      await alice.idle();
      await alice.storageManager.synced();
    }
    // SHARED still serves: Alice writes its `n`, its `label` re-derives
    // (the remaining-demander writer stays a root — the "release only
    // when the LAST demander leaves" half).
    const sharedArg = alice.getCell<{ n: number }>(
      space,
      "dp-r-sh-arg",
      { type: "object", properties: { n: { type: "number" } } } as never,
    );
    await sharedArg.sync();
    {
      const tx = alice.edit();
      sharedArg.key("n").withTx(tx).set(2);
      expect((await tx.commit()).error).toBeUndefined();
      await alice.idle();
      await alice.storageManager.synced();
    }
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, "space", '"label:2"'),
    );
    // The dormant solo piece did NOT re-derive: exactly ONE `label:2`
    // landed (the shared piece's), never the solo piece's.
    const labelTwos = [...rowsUnder(engine, "space").values()].filter((v) =>
      JSON.stringify(v ?? null).includes('"label:2"')
    );
    console.log(`[P-release] label:2 instances=${labelTwos.length}`);
    expect(labelTwos.length).toBe(1);
    expect(walkRuns()).toBe(0);
    cancels.forEach((cancel) => cancel());
  });

  it("P-arrival: a second principal arriving after the node narrowed gets her instance on demand (per-key not-current re-arm / root arrival re-arm), the first principal's instance untouched", async () => {
    const setup = await standUp({
      names: { arg: "dp-d-arg", result: "dp-d-result" },
      clients: [aliceSigner],
    });
    const { engine, clients } = setup;
    const alice = clients.get(aliceSigner.did())!.runtime;
    const aliceKey = setup.userKey(aliceSigner);
    const bobKey = setup.userKey(bobSigner);
    await setup.writeDraft(alice, "A");
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, aliceKey, '"echo:A"'),
    );
    await servingRuntime!.idle();
    await settleACycle();
    const traceBefore = servingRuntime!.scheduler.getActionRunTrace().length;
    const rearmsBefore = host!.stats().demand.notCurrentRearms;
    const arrivalsBefore = host!.stats().demandArrivals;
    const bob = await setup.watchRoot(bobSigner);
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, bobKey, '"echo:"'),
    );
    const since = servingRuntime!.scheduler.getActionRunTrace().slice(
      traceBefore,
    );
    expect(
      since.filter((e) => e.instanceKey === aliceKey).map((e) => e.actionId),
    ).toEqual([]);
    const stats = host!.stats();
    console.log(
      `[P-arrival] notCurrentRearms +${
        stats.demand.notCurrentRearms - rearmsBefore
      }, demandArrivals +${stats.demandArrivals - arrivalsBefore}`,
    );
    // Bob arrived on the ROOT key, so BOTH re-arms fire for him: the
    // root-level arrival re-arm (`demandArrivals`) and the per-key
    // currency check on his new pair of the `echo` output doc's key
    // (`notCurrentRearms`). Assert both moved — the per-key check's
    // counter was unasserted before the W1 review (MAJOR-1), which left
    // `rearmNotCurrentForDemander` returning 0 green here. The pin that
    // makes the per-key check LOAD-BEARING (the landing itself) is
    // P-arrival-closure below.
    expect(stats.demandArrivals - arrivalsBefore).toBeGreaterThanOrEqual(1);
    expect(stats.demand.notCurrentRearms - rearmsBefore)
      .toBeGreaterThanOrEqual(1);
    await setup.writeDraft(bob.runtime, "B");
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, bobKey, '"echo:B"'),
    );
    expect(instanceHolds(engine, aliceKey, '"echo:B"')).toBe(false);
    setup.cancel();
  });

  it("P-arrival-closure: a second principal whose closure reaches a narrowed writer's OUTPUT doc only through NON-ROOT rows (her root is a plain holder doc linking to a nested child's result) gets her instance through the per-key currency check alone — no demanded root gains her pair, so the root-level arrival re-arm is inert; the first principal's instance untouched", async () => {
    // The design §2.2 case the root-level re-arm cannot see: "a doc
    // entering Alice's closure whose writer is already a root for Bob's
    // sake and clean node-level, but has no instance for Alice". Here
    // ALICE is the first principal (a NON-creator session watching the
    // outer root; the nested child's `echo` narrows to `user:alice` and
    // goes clean) and BOB is the late arrival: he watches ONLY the holder
    // doc — a plain `of:` doc, not a piece — whose value the `publish`
    // handler set to a link to the CHILD'S result doc. His closure
    // therefore reaches the child's result and `echo`'s output doc as
    // NON-root rows; no key in `#demandedRoots` gains his pair, so
    // `invalidateActionsForDemandRoots` (the root arrival re-arm) has
    // nothing to re-arm for him — `demandArrivals` stays flat — and only
    // `rearmNotCurrentForDemander` on his new pair of the `echo` key can
    // materialize `user:bob`'s instance.
    //
    // The CREATOR departs first (T2′-probe shape): a creator's session
    // holds every doc its local run pulled as a watch ROOT, which would
    // put the child's result into `#demandedRoots` and let the root
    // re-arm serve Bob through it — the exact vacuity the W1 review found
    // in P-arrival (MAJOR-1). Killing mutation (review M-C):
    // `rearmNotCurrentForDemander` returning 0 → Bob's instance never
    // lands (timeout).
    host = newHost();
    const creatorClient = openClient(aliceSigner);
    const creator = creatorClient.runtime;
    const engine = await server.engineForSpace(space);
    const compiled = await creator.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: NESTED_PUBLISH_PATTERN }],
    }, { space });
    const holder = creator.getCell<unknown>(space, "dp-e-holder", undefined);
    const cArg = creator.getCell<Record<string, unknown>>(
      space,
      "dp-e-arg",
      undefined,
    );
    const cResult = creator.getCell<Record<string, unknown>>(
      space,
      "dp-e-result",
      compiled.resultSchema,
    );
    await holder.sync();
    await cArg.sync();
    await cResult.sync();
    {
      const seed = creator.edit();
      cArg.withTx(seed).set({ n: 1, slot: holder });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = creator.edit();
      creator.run(tx, compiled, cArg, cResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await creator.idle();
    await creator.storageManager.synced();
    const resultId = cResult.getAsNormalizedFullLink().id;
    const holderId = holder.getAsNormalizedFullLink().id;
    // The creator departs (her session's every-doc-a-root tracked set
    // leaves after the TTL) and a pass RETIRES her keys — so none of the
    // piece's docs stays a demanded ROOT from her tenure (the registry's
    // root set is sticky for a key that never departs).
    await creator.dispose();
    await creatorClient.manager.close();
    sessions.remove(space, creatorClient.manager.id);
    runtimes.splice(runtimes.indexOf(creator), 1);
    managers.splice(managers.indexOf(creatorClient.manager), 1);
    await settleACycle();
    await activated();
    await awaitEach(cycles, () => {
      host!.spaceServer(space)!.noteDemandChanged();
      return demandRows().length === 0;
    });
    await settleACycle();
    // Alice, a FRESH session: watches the outer root but by a NARROW
    // schema that reaches `child.echo` (so the child's `echo` narrows to
    // her and goes clean) and does NOT name `slot` — she does not root
    // the holder doc, so the holder is NEW to `#demandedRoots` when Bob
    // arrives on it (making Bob's arrival non-root — `arrivals` empty).
    const aliceClient = openClient(aliceSigner);
    const alice = aliceClient.runtime;
    const aliceResult = alice.getCell<Record<string, unknown>>(
      space,
      "dp-e-result",
      {
        type: "object",
        properties: {
          child: {
            type: "object",
            properties: { echo: { type: "string" } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      } as never,
    );
    await aliceResult.sync();
    const aliceCancel = aliceResult.sink(() => {});
    // A full-schema cell to FIRE the publish event (the stream lives
    // under `publish`; firing pulls no holder demand into Alice's watch).
    const aliceFull = alice.getCell<Record<string, unknown>>(
      space,
      "dp-e-result",
      compiled.resultSchema,
    );
    await aliceFull.sync();
    await activated();
    await awaitEach(
      cycles,
      () =>
        (host!.spaceServer(space)?.demandedIdentitiesOf(resultId) ?? [])
          .some((i) => i.principal === aliceSigner.did()),
    );
    const aliceKey = resolveScopeKey("user", { principal: aliceSigner.did() });
    const bobKey = resolveScopeKey("user", { principal: bobSigner.did() });
    // The draft is written through a schema that names ONLY the per-user
    // `draft` slot (so the writer's session roots nothing but the outer
    // result — the full argument schema's `slot: Writable` would root the
    // holder doc too, and a root-row holder would make Bob's arrival a
    // root-level "arrival" of an inert root).
    const argSchema = compiled.argumentSchema as {
      properties?: Record<string, unknown>;
    };
    const draftOnlySchema = {
      type: "object",
      properties: { draft: argSchema.properties!.draft },
    } as never;
    const typedArg = (runtime: Runtime) =>
      runtime.getCell<{ draft: string }>(space, "dp-e-arg", draftOnlySchema);
    const writeDraft = async (runtime: Runtime, value: string) => {
      const arg = typedArg(runtime);
      await arg.sync();
      const tx = runtime.edit();
      arg.key("draft").withTx(tx).set(value);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      await runtime.storageManager.synced();
    };
    await writeDraft(alice, "A");
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, aliceKey, '"echo:A"'),
    );
    // Alice fires publish: the served handler writes holder := link to
    // the CHILD'S result doc.
    aliceFull.key("publish").send({});
    await alice.idle();
    await alice.storageManager.synced();
    await awaitAdmitted(
      server,
      () =>
        JSON.stringify(rowsUnder(engine, "space").get(holderId) ?? null)
          .includes("link"),
    );
    // Quiesce.
    await servingRuntime!.idle();
    await settleACycle();
    const traceBefore = servingRuntime!.scheduler.getActionRunTrace().length;
    const rearmsBefore = host!.stats().demand.notCurrentRearms;
    const arrivalsBefore = host!.stats().demandArrivals;
    const writersBefore = servingRuntime!.scheduler.demandedWriterCount;
    expect(instanceHolds(engine, bobKey, '"echo:"')).toBe(false);
    // Bob arrives: watches the HOLDER doc only, by a schema that follows
    // the link into `{ echo }`.
    const bobClient = openClient(bobSigner);
    const bob = bobClient.runtime;
    const bobHolder = bob.getCell<Record<string, unknown>>(
      space,
      "dp-e-holder",
      {
        type: "object",
        properties: { echo: { type: "string" } },
        additionalProperties: false,
      } as never,
    );
    await bobHolder.sync();
    const bobCancel = bobHolder.sink(() => {});
    const bobRowsNow = () =>
      demandRows().filter((r) => r.identity?.principal === bobSigner.did());
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, bobKey, '"echo:"'),
    );
    const stats = host!.stats();
    const bobRows = bobRowsNow();
    const bobEchoRows = bobRows.filter((r) => r.id.startsWith("computed:"));
    console.log(
      `[P-arrival-closure] notCurrentRearms +${
        stats.demand.notCurrentRearms - rearmsBefore
      }, demandArrivals +${stats.demandArrivals - arrivalsBefore}, ` +
        `demandedWriters ${writersBefore} → ${
          servingRuntime!.scheduler.demandedWriterCount
        }; bob rows=${bobRows.length} [${
          bobRows.map((r) =>
            `${r.id.slice(0, 14)}…@${r.scopeKey.slice(0, 10)}:${
              r.root ? "root" : "closure"
            }`
          ).join(", ")
        }]`,
    );
    // Bob's only mutable space-scoped root row is the holder doc; schema
    // documents are immutable roots and cannot re-arm a piece. Every piece doc
    // he reaches (the child's result, `echo`'s output doc) is a CLOSURE
    // row. This is the isolation the pin exists for: the root-level
    // arrival re-arm (`invalidateActionsForDemandRoots`) re-arms a
    // narrowed node only when the node's `demandRootIds` (its piece's
    // roots) intersect an ARRIVED key's id — and Bob roots ONLY the
    // holder doc, which is no piece's root, so the echo node is not
    // reachable from Bob's arrival by root at all. Only the per-key
    // currency check on Bob's new pair of the `echo` output key can
    // materialize `user:bob`'s instance. (The `demandArrivals` counter
    // does tick — the holder is a demanded root that gained Bob's pair —
    // but its re-arm reaches no echo node; the LANDING is the assertion
    // that matters, and M-C makes it red.)
    expect(
      bobRows.filter((r) =>
        r.root && r.scopeKey === "space" && !r.id.startsWith("cid:")
      ).map((r) => r.id),
    ).toEqual([holderId]);
    expect(bobEchoRows.length).toBeGreaterThan(0);
    expect(bobEchoRows.every((r) => !r.root)).toBe(true);
    // The per-key check fired for Bob's pair (M-C — return 0 — makes the
    // landing time out).
    expect(stats.demand.notCurrentRearms - rearmsBefore)
      .toBeGreaterThanOrEqual(1);
    // Alice's instance untouched (no run under her key since).
    const since = servingRuntime!.scheduler.getActionRunTrace().slice(
      traceBefore,
    );
    expect(
      since.filter((e) => e.instanceKey === aliceKey).map((e) => e.actionId),
    ).toEqual([]);
    // Bob's demand now serves him: his draft re-derives his instance only.
    await writeDraft(bob, "B");
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, bobKey, '"echo:B"'),
    );
    expect(instanceHolds(engine, aliceKey, '"echo:B"')).toBe(false);
    expect(walkRuns()).toBe(0);
    bobCancel();
    aliceCancel();
  });

  it("OW51 refusal re-trigger (the RULED option-3 contract): a refusal-disposed served run re-fires when the awaited doc arrives from a FOREIGN writer — a disposed instance is CLEAN and every root-level re-arm keeps clean instances, so only the refusal's registered dead-end read can re-fire it; it does, and the value lands", async () => {
    // The disposition under pin (speculation.md §2, RULED 2026-08-21):
    // a refusal-disposed run re-triggers "when any of the reads so far
    // change (just like a regular call)" — the arriving dead-end doc
    // included. The root-level machinery is structurally unable to
    // deliver this: a disposed run finishes CLEAN (`fanOutRunFinished`
    // — the ruled interim output `undefined` IS its current value), and
    // both root-level re-arms (`invalidateActionsForDemandRoots`, the
    // arrival currency check) mark the node invalid with
    // `fanOutInstances: "keep"`, which re-runs only NOT-clean
    // instances. The ONLY path from the write to the re-run is the
    // refusal's own registered read: the disposed run's committed log
    // (dead-end read included) joins the node's union subscription, and
    // the write's cause-bearing dirty un-cleans exactly the covered
    // instances. The writer is FOREIGN — a third session that watches
    // nothing and merely writes the doc; the target is no piece's
    // demand root, so no arrival re-arm ever names it.
    //
    // Load-bearing seams (mutation-verified, recorded in the OW51
    // build report §8.4): M-CLEAN — remove `dirtyFanOutKey`'s
    // `clean.delete`, so a cause-bearing dirty can no longer un-clean
    // a disposed instance — and this landing times out. M-UNION (the
    // #6179 review's sharper kill) — drop zero-write logs from
    // `fanOutUnionLog`, and only THIS pin goes red: the union
    // subscription never learns the disposed run's dead-end read and
    // the foreign arrival re-fires nothing. (The refusal-disposed
    // run's tx COMMITS through the ordinary path — §8.1 — which is
    // exactly why its log reaches the union subscription at all.)
    const setup = await standUp({
      names: { arg: "dp-f-arg", result: "dp-f-result" },
      pattern: FOREIGN_ARRIVAL_PATTERN,
      clients: [aliceSigner],
      // deno-lint-ignore require-await
      argExtras: async (alice) => {
        const target = alice.getCell<string>(
          space,
          "dp-f-target",
          { type: "string" } as never,
        );
        return { src: target };
      },
    });
    const { engine } = setup;
    // Quiesce: the served run read `src` through the stored sigil, the
    // walk followed the hop and dead-ended at the unwritten target doc,
    // and the run was REFUSAL-disposed — output undefined, no landing.
    await servingRuntime!.idle();
    await settleACycle();
    expect(instanceHolds(engine, "space", '"view:')).toBe(false);
    // The demand registry covers the piece (alice watches the result
    // root); the target doc never becomes a demanded ROOT of the piece.
    expect(
      demandRows().some((r) => r.id === setup.resultId && r.root),
    ).toBe(true);
    const traceBefore = servingRuntime!.scheduler.getActionRunTrace().length;
    // The FOREIGN writer: a third session that watches nothing writes
    // the awaited doc.
    const carolClient = openClient(carolSigner);
    const carolTarget = carolClient.runtime.getCell<string>(
      space,
      "dp-f-target",
      { type: "string" } as never,
    );
    await carolTarget.sync();
    {
      const tx = carolClient.runtime.edit();
      carolTarget.withTx(tx).set("hello");
      expect((await tx.commit()).error).toBeUndefined();
    }
    await carolClient.runtime.idle();
    await carolClient.runtime.storageManager.synced();
    // The arrival re-fires the DISPOSED run through its registered
    // read, and the derived value lands.
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, "space", '"view:hello"'),
    );
    expect(
      servingRuntime!.scheduler.getActionRunTrace().length,
    ).toBeGreaterThan(traceBefore);
    expect(walkRuns()).toBe(0);
    setup.cancel();
  });

  // T2′ (cross-piece) and T3′ (array growth): the ONE-PUSH-LATE structural
  // growth path a unit pin can make DETERMINISTIC (W0 §5 left it unbuilt).
  // The demander (Bob) watches ONLY a NARROW field and NEVER the firing
  // stream, so P1's handler wiring (which reaches the cross-piece link
  // target) never pre-empts Bob's closure — the within-piece source
  // wiring the probe above hit pre-empts only a session that watches the
  // handler. A SEPARATE actor (Alice) fires. Before the wave writes the
  // link, P2's doc is NOT in Bob's rows; the wave writes it; the tracker's
  // push-time re-traversal reaches P2 → Bob's closure GROWS (a
  // push-growth demandChanged) → the settle series classes the input
  // `structural-growth` and the cycle count is the growth waves.
  // The cross-piece / array-growth GROWTH pin (MAJOR-3 of the W1 review):
  // the value asserted must be one the SERVER derives FRESH through the
  // wave's own link, not a value a client already committed and not one
  // any session demanded before the link. So: Alice CREATES P1
  // (relay/list) and P2 (leaf) and DEPARTS; a NON-runner then bumps P2's
  // input so the store's `leaf` is STALE and P2's writer dirty; Bob
  // watches ONLY P1's narrow field (never the stream, never P2's root); a
  // SEPARATE firing actor (Carol) fires the relay/push. Before the link
  // nobody demands leaf → the stale value stays. The wave writes the link
  // → Bob's closure grows to P2's leaf (a closure row) → the server
  // derives the FRESH leaf and it lands — the landing is the assertion,
  // and `demandedWriters` grows because P2's writer became a demand root.
  //
  // NOTE on M-E (demand pass ignoring non-root rows): P2's `leaf` here is
  // SPACE-scoped, so once Carol's served handler run READS the
  // cross-piece target link, P2's single instance is made live through
  // that run's own read edge (design §2.3(ii)) and lands regardless of
  // the demand pass — so M-E does not bite THIS pin. The M-E kill
  // (closure-row consumption is load-bearing for a landing) is a PER-USER
  // property and is pinned by P-arrival-closure (a demander's own
  // instance, reached only through her non-root closure row, is starved
  // under M-E). The reviewer sanctioned recording this split rather than
  // forcing a per-user narrowing the fan-out machinery will not produce
  // in a departed-creator growth (MAJOR-3 fix note).
  const standUpCrossGrowth = async (options: {
    p1Pattern: string;
    p1Names: { arg: string; result: string; field: string };
    bobFieldSchema: Record<string, unknown>;
  }) => {
    host = newHost();
    const aliceClient = openClient(aliceSigner);
    const alice = aliceClient.runtime;
    const engine = await server.engineForSpace(space);
    const leaf = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: LEAF_PATTERN }],
    }, { space });
    const p1 = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: options.p1Pattern }],
    }, { space });
    const bArg = alice.getCell<Record<string, unknown>>(
      space,
      "dp-x-b-arg",
      undefined,
    );
    const bResult = alice.getCell<Record<string, unknown>>(
      space,
      "dp-x-b-result",
      leaf.resultSchema,
    );
    await bArg.sync();
    await bResult.sync();
    {
      const seed = alice.edit();
      bArg.withTx(seed).set({ n: 5 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, leaf, bArg, bResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const holder = alice.getCell<unknown>(space, "dp-x-holder", undefined);
    const aArg = alice.getCell<Record<string, unknown>>(
      space,
      options.p1Names.arg,
      undefined,
    );
    const aResult = alice.getCell<Record<string, unknown>>(
      space,
      options.p1Names.result,
      p1.resultSchema,
    );
    await holder.sync();
    await aArg.sync();
    await aResult.sync();
    {
      const seed = alice.edit();
      aArg.withTx(seed).set({ slot: holder, list: holder, target: bResult });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, p1, aArg, aResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    const bResultId = bResult.getAsNormalizedFullLink().id;
    const aResultId = aResult.getAsNormalizedFullLink().id;
    // Alice DEPARTS: her creator session tracked every doc her local runs
    // pulled (P1's whole wiring AND P2's leaf), which would keep leaf
    // demanded and pre-empt the growth. After the TTL nobody demands leaf.
    await alice.dispose();
    await aliceClient.manager.close();
    sessions.remove(space, aliceClient.manager.id);
    runtimes.splice(runtimes.indexOf(alice), 1);
    managers.splice(managers.indexOf(aliceClient.manager), 1);
    await settleACycle();
    // Carol: the FIRING actor. She watches P1's result to append the
    // event; she does not watch P2's leaf beyond P1's own wiring.
    const carolClient = openClient(carolSigner);
    const carol = carolClient.runtime;
    const carolFire = carol.getCell<Record<string, unknown>>(
      space,
      options.p1Names.result,
      p1.resultSchema,
    );
    await carolFire.sync();
    // Bob: watches P1's result but ONLY the one field, by a schema that
    // follows the link into `{ leaf }`. Never the stream, never P2's root.
    const bobClient = openClient(bobSigner);
    const bob = bobClient.runtime;
    const bobResult = bob.getCell<Record<string, unknown>>(
      space,
      options.p1Names.result,
      {
        type: "object",
        properties: { [options.p1Names.field]: options.bobFieldSchema },
        additionalProperties: false,
      } as never,
    );
    await bobResult.sync();
    const bobCancel = bobResult.sink(() => {});
    await activated();
    await awaitEach(
      cycles,
      () =>
        (host!.spaceServer(space)?.demandedIdentitiesOf(aResultId) ?? [])
          .some((i) => i.principal === bobSigner.did()),
    );
    // Bump P2's `n` from Carol (a NON-runner of P2): the store's leaf:5 is
    // now stale, P2's writer dirty; nobody demands leaf, so the server
    // does not derive leaf:6 — it stays leaf:5 until Bob's link.
    const carolBArg = carol.getCell<{ n: number }>(
      space,
      "dp-x-b-arg",
      { type: "object", properties: { n: { type: "number" } } } as never,
    );
    await carolBArg.sync();
    {
      const tx = carol.edit();
      carolBArg.key("n").withTx(tx).set(6);
      expect((await tx.commit()).error).toBeUndefined();
      await carol.idle();
      await carol.storageManager.synced();
    }
    // Quiesce; let Alice's departed rows leave. The fresh value is ABSENT
    // and leaf is not yet in Bob's closure (the growth precondition).
    await awaitEach(cycles, () => {
      host!.spaceServer(space)!.noteDemandChanged();
      return !demandRows().some((r) =>
        r.identity?.principal === aliceSigner.did()
      );
    });
    await servingRuntime!.idle();
    await settleACycle();
    const bobTracksLeaf = () =>
      demandRows().some((r) =>
        r.id === bResultId && r.identity?.principal === bobSigner.did()
      );
    return {
      engine,
      carol,
      carolFire,
      bResultId,
      bobTracksLeaf,
      cleanup: () => {
        bobCancel();
      },
    };
  };

  it("T2′ (cross-piece) GROWTH: a wave writes a link to ANOTHER piece's stale result doc into a field the demander watches narrowly → the target enters the demander's closure as a NON-ROOT row and the server derives the FRESH value, which LANDS (the landing is the assertion, not a value a client pre-committed); pushGrowthWakes +1, demandedWriters grows, zero walk runs", async () => {
    const x = await standUpCrossGrowth({
      p1Pattern: CROSS_RELAY_PATTERN,
      p1Names: { arg: "dp-x-a-arg", result: "dp-x-a-result", field: "slot" },
      bobFieldSchema: {
        type: "object",
        properties: { leaf: { type: "string" } },
        additionalProperties: false,
      },
    });
    // Growth preconditions: leaf is not yet in Bob's closure, the FRESH
    // value has not landed (nobody demands leaf), the stale value stands.
    const preEmpted = x.bobTracksLeaf();
    expect(preEmpted).toBe(false);
    expect(instanceHolds(x.engine, "space", '"leaf:6"')).toBe(false);
    expect(instanceHolds(x.engine, "space", '"leaf:5"')).toBe(true);
    const wakesBefore = host!.stats().demand.pushGrowthWakes;
    const writersBefore = servingRuntime!.scheduler.demandedWriterCount;
    const seriesBefore = host!.stats().settle.series.length;
    // Carol (who does NOT demand leaf) fires the relay: slot := link(P2).
    x.carolFire.key("relay").send({});
    await x.carol.idle();
    await x.carol.storageManager.synced();
    // The FRESH value lands — the assertion (leaf:6 was never
    // client-computed; it exists only if the server derived it after the
    // link reached P2's writer).
    await awaitAdmitted(
      server,
      () => instanceHolds(x.engine, "space", '"leaf:6"'),
    );
    // Bob's replica pulls the leaf and his watch set grows; the server
    // sees that as a demand change, and the loop runs a pass for it.
    await awaitEach(cycles, () => x.bobTracksLeaf());
    const stats = host!.stats();
    const growth = stats.settle.series.slice(seriesBefore).filter((s) =>
      s.class === "structural-growth"
    );
    console.log(
      `[T2′ cross-growth] fresh leaf landed; pre-empted=${preEmpted}; ` +
        `pushGrowthWakes +${stats.demand.pushGrowthWakes - wakesBefore}; ` +
        `demandedWriters ${writersBefore} → ${
          servingRuntime!.scheduler.demandedWriterCount
        }; ` +
        `structural-growth entries=${
          JSON.stringify(
            growth.map((s) => ({ ms: Math.round(s.ms), waves: s.waves })),
          )
        }`,
    );
    // The deterministic facts: the fresh value is served; P2 is in Bob's
    // closure AFTER the link; the growth notify fired; the standing
    // demand-root set grew (P2's writer entered); the walk is gone.
    expect(instanceHolds(x.engine, "space", '"leaf:6"')).toBe(true);
    expect(x.bobTracksLeaf()).toBe(true);
    expect(host!.stats().demand.pushGrowthWakes).toBeGreaterThan(wakesBefore);
    expect(servingRuntime!.scheduler.demandedWriterCount)
      .toBeGreaterThan(writersBefore);
    expect(walkRuns()).toBe(0);
    x.cleanup();
  });

  it("T3′ (array growth) GROWTH: a handler appends a link-bearing element to a list the demander watches by schema → the appended target enters the closure as a NON-ROOT row and the server derives the FRESH value, which LANDS; pushGrowthWakes +1, demandedWriters grows, zero walk runs", async () => {
    const x = await standUpCrossGrowth({
      p1Pattern: LIST_GROW_PATTERN,
      p1Names: { arg: "dp-y-a-arg", result: "dp-y-a-result", field: "list" },
      bobFieldSchema: {
        type: "array",
        items: {
          type: "object",
          properties: { leaf: { type: "string" } },
          additionalProperties: false,
        },
      },
    });
    const preEmpted = x.bobTracksLeaf();
    expect(preEmpted).toBe(false);
    expect(instanceHolds(x.engine, "space", '"leaf:6"')).toBe(false);
    expect(instanceHolds(x.engine, "space", '"leaf:5"')).toBe(true);
    const wakesBefore = host!.stats().demand.pushGrowthWakes;
    const writersBefore = servingRuntime!.scheduler.demandedWriterCount;
    const seriesBefore = host!.stats().settle.series.length;
    // Carol pushes a link to P2 onto the list.
    x.carolFire.key("push").send({});
    await x.carol.idle();
    await x.carol.storageManager.synced();
    await awaitAdmitted(
      server,
      () => instanceHolds(x.engine, "space", '"leaf:6"'),
    );
    // Bob's replica pulls the leaf and his watch set grows; the server
    // sees that as a demand change, and the loop runs a pass for it.
    await awaitEach(cycles, () => x.bobTracksLeaf());
    const stats = host!.stats();
    const growth = stats.settle.series.slice(seriesBefore).filter((s) =>
      s.class === "structural-growth"
    );
    console.log(
      `[T3′ array-growth] fresh leaf landed; pre-empted=${preEmpted}; ` +
        `pushGrowthWakes +${stats.demand.pushGrowthWakes - wakesBefore}; ` +
        `demandedWriters ${writersBefore} → ${
          servingRuntime!.scheduler.demandedWriterCount
        }; ` +
        `structural-growth entries=${
          JSON.stringify(growth.map((s) => ({ ms: Math.round(s.ms) })))
        }`,
    );
    expect(instanceHolds(x.engine, "space", '"leaf:6"')).toBe(true);
    expect(x.bobTracksLeaf()).toBe(true);
    expect(host!.stats().demand.pushGrowthWakes).toBeGreaterThan(wakesBefore);
    expect(servingRuntime!.scheduler.demandedWriterCount)
      .toBeGreaterThan(writersBefore);
    expect(walkRuns()).toBe(0);
    x.cleanup();
  });
});
