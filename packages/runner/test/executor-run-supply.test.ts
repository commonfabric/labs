// Server-execution v2 stage P2-F: the per-(action × instance) run
// SUPPLY and its two classification consequences, pinned at the unit
// level (the serving-loop E2E drives the same machinery through the
// production demand registry):
//
// - the N-run settle loop, as reshaped by fan-out stage B (RULED
//   2026-08-16 — the resolver returns DEMANDERS and the scheduler
//   derives the instances from its known-scope RATCHET): a scheduler
//   action whose demand roots have demanders runs as a demander — ONE
//   probe run while it has read nothing scoped (a space node runs once
//   regardless of demander count; never as the service identity), and
//   ONCE PER DEMANDING PRINCIPAL once it discovers user scope (the
//   discovery re-arm runs the siblings in the same pass), each run's
//   transaction stamped with its instance's identity through the
//   production choke point (run.ts → stampServerRun → the installed
//   stamper) — instances live in keys/basis/stamps and the node's
//   fan-out record, never as extra graph nodes;
// - the LT6 inheritance rule (events.md §2, RULED 2026-08-03): an
//   event emitted by a stamped run hands its acting identity to the
//   dispatched handler run — a cascade rooted in a demanded
//   (user, session) derivation preserves the actor hop by hop instead
//   of blanking to the userless service fallback;
// - the F1 fold-in (RULED 2026-08-13, option c): a piece-start setup
//   commit that fails on the serving runtime surfaces loudly through
//   `Runtime.pieceStartCommitFailureObserver` instead of being
//   swallowed by the fire-and-forget start path (the piece silently
//   running against stale setup was the filed hazard).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime, type ServerRunInfo } from "../src/runtime.ts";
import { stampWaveRunContext, waveRunContextOf } from "../src/executor/wave.ts";
import { MAX_RETRIES_FOR_REACTIVE } from "../src/scheduler/constants.ts";
import { RetryImmediately } from "../src/scheduler/retry-immediately.ts";
import type {
  IExtendedStorageTransaction,
  TransactionSealDestination,
} from "../src/storage/interface.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("p2f run supply");
const space = signer.did();

const alice = {
  principal: "did:key:p2f-alice",
  sessionId: "alice-s1" as never,
};
const bob = { principal: "did:key:p2f-bob", sessionId: "bob-s1" as never };

describe("stage P2-F per-(action × instance) run supply", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  /** Every ServerRunInfo the production stamping choke points hand the
   * installed stamper, in order. */
  let stamped: ServerRunInfo[];

  /** A PASS-THROUGH destination: seals commit natively (byte-identical
   * to no destination) while the installed stamper records and stamps
   * every run context — the unit-level stand-in for the SpaceServer's
   * stamper seam. */
  const passThroughDestination = (): TransactionSealDestination => ({
    seal: (tx: IExtendedStorageTransaction) => tx.tx.commit(),
  });

  const recordingStamper = (
    tx: IExtendedStorageTransaction,
    info: ServerRunInfo,
  ): void => {
    stamped.push(info);
    stampWaveRunContext(tx, {
      actionId: info.actionId,
      kind: info.kind,
      ...(info.eventId !== undefined ? { eventId: info.eventId } : {}),
      ...(info.scopeKeyIdentity !== undefined
        ? { scopeKeyIdentity: info.scopeKeyIdentity }
        : {}),
      ...(info.actionScopeKey !== undefined
        ? { actionScopeKey: info.actionScopeKey }
        : {}),
    });
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    stamped = [];
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    runtime.clearSealDestination();
    await runtime.dispose();
    await storageManager.close();
  });

  it("runs a demanded action as its demanders: ONE probe run for a node reading nothing scoped, then — once a run discovers user scope — one run per demanding principal in the SAME pass (the known-scope ratchet + the discovery re-arm; fan-out stage B)", async () => {
    const rootId = "of:p2f-fanout-root";
    const bobKey = resolveScopeKey("user", bob);
    // The registry returns DEMANDERS (stage B's seam): who watches the
    // root, at any address. The scheduler decides the instances.
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
      runDemanderResolver: (pieceRootIds) =>
        pieceRootIds.includes(rootId) ? [alice, bob] : [],
    });

    const observedContexts: Array<
      { actionScopeKey?: string; principal?: string } | undefined
    > = [];
    let readsUserScope = false;
    const userDoc = runtime.getCellFromLink<{ v?: number }>({
      space,
      id: "of:p2f-fanout-user-doc" as never,
      scope: "user",
      path: [],
    });
    const action = Object.assign(
      (tx: IExtendedStorageTransaction) => {
        const context = waveRunContextOf(tx);
        observedContexts.push(
          context === undefined ? undefined : {
            actionScopeKey: context.actionScopeKey,
            principal: context.scopeKeyIdentity?.principal,
          },
        );
        // Learned by RUNNING (D11: no static analysis): the read is what
        // narrows the node.
        if (readsUserScope) userDoc.withTx(tx).get();
      },
      {
        schedulerObservationIdentity: {
          pieceId: `space:${rootId}`,
          pieceRootId: rootId,
        },
      },
    );

    // Space node: ONE run — the probe, min(D) = alice, key `space` —
    // regardless of the two demanders (design §B2/§G B-c; a demanded
    // piece never runs as the service, mutation: the fallback restored
    // for demanded work → the stamp carries no identity).
    await runtime.scheduler.run(action);
    await runtime.idle();
    let derivationStamps = stamped.filter((info) => info.kind === "derivation");
    expect(derivationStamps.length).toBe(1);
    expect(derivationStamps[0].scopeKeyIdentity?.principal).toBe(
      alice.principal,
    );
    expect(derivationStamps[0].actionScopeKey).toBe("space");
    expect(observedContexts).toEqual([
      { actionScopeKey: "space", principal: alice.principal },
    ]);

    // The node starts reading user scope: the probe run (alice)
    // discovers `user`, the ratchet narrows, and Bob's instance runs in
    // the SAME pass — TWO runs, in demander order, each stamped through
    // the PRODUCTION choke point with its instance's identity.
    stamped.length = 0;
    observedContexts.length = 0;
    readsUserScope = true;
    await runtime.scheduler.run(action);
    await runtime.idle();
    derivationStamps = stamped.filter((info) => info.kind === "derivation");
    expect(derivationStamps.length).toBe(2);
    expect(derivationStamps[0].scopeKeyIdentity?.principal).toBe(
      alice.principal,
    );
    expect(derivationStamps[0].actionScopeKey).toBe("space");
    expect(derivationStamps[1].scopeKeyIdentity?.principal).toBe(
      bob.principal,
    );
    expect(derivationStamps[1].actionScopeKey).toBe(bobKey);
    expect(observedContexts).toEqual([
      { actionScopeKey: "space", principal: alice.principal },
      { actionScopeKey: bobKey, principal: bob.principal },
    ]);
  });

  it("keeps the single wave-identity run for an action with no demanders", async () => {
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
      runDemanderResolver: () => [],
    });
    let invocations = 0;
    const action = Object.assign(
      (_tx: IExtendedStorageTransaction) => {
        invocations += 1;
      },
      {
        schedulerObservationIdentity: {
          pieceId: "space:of:p2f-solo-root",
          pieceRootId: "of:p2f-solo-root",
        },
      },
    );
    await runtime.scheduler.run(action);
    await runtime.idle();
    expect(invocations).toBe(1);
    const derivationStamps = stamped.filter((info) =>
      info.kind === "derivation"
    );
    expect(derivationStamps.length).toBe(1);
    expect(derivationStamps[0].scopeKeyIdentity).toBeUndefined();
  });

  it("re-arms a node that ran with no demander reachable once a demander arrives for its root", async () => {
    const rootId = "of:p2f-late-demander-root";
    let demanders: Array<typeof alice> = [];
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
      runDemanderResolver: (pieceRootIds) =>
        pieceRootIds.includes(rootId) ? demanders : [],
    });
    let invocations = 0;
    const action = Object.assign(
      (_tx: IExtendedStorageTransaction) => {
        invocations += 1;
      },
      {
        schedulerObservationIdentity: {
          pieceId: `space:${rootId}`,
          pieceRootId: rootId,
        },
      },
    );
    // Registered as an effect, so the scheduler runs it on subscription
    // rather than waiting for a reader to demand it.
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await runtime.idle();
    expect(invocations).toBe(1);
    const fallbackStamps = stamped.filter((info) => info.kind === "derivation");
    expect(fallbackStamps.length).toBe(1);
    expect(fallbackStamps[0].scopeKeyIdentity).toBeUndefined();

    // Alice's demand reaches the root only now: the node has no known
    // scope for her, so it runs again, and that run is her probe.
    demanders = [alice];
    stamped.length = 0;
    expect(runtime.scheduler.invalidateActionsForDemandRoots([rootId])).toBe(
      1,
    );
    await runtime.idle();
    expect(invocations).toBe(2);
    const derivationStamps = stamped.filter((info) =>
      info.kind === "derivation"
    );
    expect(derivationStamps.length).toBe(1);
    expect(derivationStamps[0].scopeKeyIdentity?.principal).toBe(
      alice.principal,
    );
  });

  it("resolves a NESTED piece's instances through the OUTER root a client demands (Phase 7 demand-root chain): the child's actions run per demanded instance instead of falling to the service identity", async () => {
    // The lunch-gate wall's last mechanism: a sub-pattern instantiated by
    // function call gets its OWN result doc as `pieceRootId`, but a client
    // demands the OUTER piece root — so pre-Phase-7 the child's scoped
    // derivations ran with NO demanded identity, keyed under the serving
    // session's (the SERVICE identity's) instances, unread by anyone. The
    // chain (`demandRootIds`) resolves the child through its parent.
    // The child reads a PER-USER input (stage B: only a node that
    // discovers user scope fans out per principal — a space-only child
    // would run once, as the probe).
    const parentSource = [
      "import { computed, pattern, PerUser, Writable } from 'commonfabric';",
      "type Mine = Writable<number | undefined>;",
      "const child = pattern<{ n: number; mine: Mine }, { doubled: number }>(",
      "  ({ n, mine }) => ({ doubled: computed(() => n * 2 + ((mine.get() as number | undefined) ?? 0)) }),",
      ");",
      "export default pattern<{ n: number; mine?: PerUser<Mine> }, { out: number }>(({ n, mine }) => {",
      "  const c = child({ n, mine: mine! });",
      "  return { out: c.doubled };",
      "});",
      "",
    ].join("\n");
    const tx = runtime.edit();
    const parentPattern = await runtime.patternManager.compilePattern(
      programOf(parentSource),
      { space, tx },
    );
    const parentCell = runtime.getCell<{ out?: number }>(
      space,
      "p2f-nested-parent",
      undefined,
      tx,
    );
    const parentRootId = parentCell.getAsNormalizedFullLink().id;
    // The registry knows ONLY the outer root (what a browser watches):
    // any resolution through the child's own root alone finds nothing.
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
      runDemanderResolver: (pieceRootIds) =>
        pieceRootIds.includes(parentRootId) ? [alice, bob] : [],
    });
    const running = runtime.runner.run(
      tx,
      parentPattern,
      { n: 21 },
      parentCell,
    );
    expect((await tx.commit()).error).toBeUndefined();
    await running.pull();
    await runtime.idle();

    // The child's `computed` ran ONCE PER demanding principal of the
    // OUTER root, each run stamped with that instance's identity — never
    // the wave-level (service) fallback.
    const childRuns = stamped.filter((info) =>
      info.kind === "derivation" && info.actionId.includes("__cfLift") ||
      (info.kind === "derivation" && info.actionId.includes("computed"))
    );
    const identities = childRuns.map((info) =>
      info.scopeKeyIdentity?.principal
    );
    expect(identities).toContain(alice.principal);
    expect(identities).toContain(bob.principal);
    expect(
      childRuns.every((info) => info.scopeKeyIdentity !== undefined),
    ).toBe(true);
    runtime.runner.stop(parentCell);
  });

  /** The child derivation runs the stamper saw (`computed` lifts to a
   * `__cfLift_*` derivation), with each run's demanded principal —
   * undefined = the wave-level (service) fallback. */
  const childDerivationPrincipals = (): (string | undefined)[] =>
    stamped
      .filter((info) =>
        info.kind === "derivation" &&
        (info.actionId.includes("__cfLift") ||
          info.actionId.includes("computed"))
      )
      .map((info) => info.scopeKeyIdentity?.principal);

  // Same class as the nested-pattern-node case above, through a different
  // instantiation site: `builtins/map.ts`, `filter.ts` and `flatmap.ts`
  // start each element's sub-piece with `runtime.runner.run` directly.
  // Before this landed those calls carried no `parentPieceRootId`, so a
  // list item's sub-piece ran its scoped derivations with NO demanded
  // identity — the service fallback — while the parent's own `raw:map`
  // action ran per instance (the P7 independent review's probe: alice=0
  // bob=0 fallback=2). Any per-user state inside a list item's sub-piece
  // was mis-keyed under the service identity — at cardinality 1 too.
  // Stage B: the element sub-piece reads a PER-USER input, so its
  // derivation discovers user scope and fans out per demanding
  // principal (a space-only sub-piece would run once, as the probe).
  const LIST_BUILTIN_CHILD_SOURCES: Record<
    "map" | "filter" | "flatMap",
    string
  > = {
    map: [
      "export default pattern<{ items: number[]; mine?: PerUser<Mine> }, { out: { doubled: number }[] }>(({ items, mine }) => {",
      "  const out = items.map((n) => child({ n, mine: mine! }));",
      "  return { out };",
      "});",
    ].join("\n"),
    filter: [
      // The predicate reads the sub-piece's derived field directly (an
      // expression around it would be lifted into a computed of the
      // element piece and never instantiate the child).
      "export default pattern<{ items: number[]; mine?: PerUser<Mine> }, { out: number[] }>(({ items, mine }) => {",
      "  const out = items.filter((n) => { const c = child({ n, mine: mine! }); return c.keep; });",
      "  return { out };",
      "});",
    ].join("\n"),
    flatMap: [
      "export default pattern<{ items: number[]; mine?: PerUser<Mine> }, { out: { doubled: number }[] }>(({ items, mine }) => {",
      "  const out = items.flatMap((n) => [child({ n, mine: mine! })]);",
      "  return { out };",
      "});",
    ].join("\n"),
  };
  for (
    const builtin of Object.keys(LIST_BUILTIN_CHILD_SOURCES) as Array<
      keyof typeof LIST_BUILTIN_CHILD_SOURCES
    >
  ) {
    it(`carries the chain through the LIST builtins' child instantiation: a sub-piece a \`${builtin}\` callback starts resolves its instances through the OUTER demanded root (P7 review finding 4)`, async () => {
      const parentSource = [
        "import { computed, pattern, PerUser, Writable } from 'commonfabric';",
        "type Mine = Writable<number | undefined>;",
        "const child = pattern<{ n: number; mine: Mine }, { doubled: number; keep: boolean }>(",
        "  ({ n, mine }) => ({ doubled: computed(() => n * 2 + ((mine.get() as number | undefined) ?? 0)), keep: computed(() => n + ((mine.get() as number | undefined) ?? 0) > 1) }),",
        ");",
        LIST_BUILTIN_CHILD_SOURCES[builtin],
        "",
      ].join("\n");
      const tx = runtime.edit();
      const parentPattern = await runtime.patternManager.compilePattern(
        programOf(parentSource),
        { space, tx },
      );
      const parentCell = runtime.getCell<{ out?: unknown }>(
        space,
        `p7-${builtin}-chain-parent`,
        undefined,
        tx,
      );
      const parentRootId = parentCell.getAsNormalizedFullLink().id;
      // The registry knows ONLY the outer root (what a browser watches).
      runtime.installSealDestination(passThroughDestination(), {
        runStamper: recordingStamper,
        runDemanderResolver: (pieceRootIds) =>
          pieceRootIds.includes(parentRootId) ? [alice, bob] : [],
      });
      const running = runtime.runner.run(
        tx,
        parentPattern,
        { items: [1, 2] },
        parentCell,
      );
      expect((await tx.commit()).error).toBeUndefined();
      await running.pull();
      await runtime.idle();

      const principals = childDerivationPrincipals();
      expect(principals.length).toBeGreaterThan(0);
      // Every element sub-piece's derivation ran per demanded instance of
      // the OUTER root — alice and bob both present, no service fallback.
      expect(principals).toContain(alice.principal);
      expect(principals).toContain(bob.principal);
      expect(principals.every((p) => p !== undefined)).toBe(true);
      runtime.runner.stop(parentCell);
    });
  }

  it("composes across two levels: a GRANDCHILD nested pattern node resolves through the outermost demanded root (the chain is transitive)", async () => {
    // Pinned from the P7 independent review's second probe (it composed
    // at head): a child of a child carries the whole ancestor chain, so
    // demand on the outermost root reaches the grandchild's derivations.
    const src = [
      "import { computed, pattern, PerUser, Writable } from 'commonfabric';",
      "type Mine = Writable<number | undefined>;",
      "const grandchild = pattern<{ n: number; mine: Mine }, { tripled: number }>(",
      "  ({ n, mine }) => ({ tripled: computed(() => n * 3 + ((mine.get() as number | undefined) ?? 0)) }),",
      ");",
      "const child = pattern<{ n: number; mine: Mine }, { g: { tripled: number } }>(",
      "  ({ n, mine }) => ({ g: grandchild({ n, mine }) }),",
      ");",
      "export default pattern<{ n: number; mine?: PerUser<Mine> }, { out: number }>(({ n, mine }) => {",
      "  const c = child({ n, mine: mine! });",
      "  return { out: c.g.tripled };",
      "});",
      "",
    ].join("\n");
    const tx = runtime.edit();
    const parentPattern = await runtime.patternManager.compilePattern(
      programOf(src),
      { space, tx },
    );
    const parentCell = runtime.getCell<{ out?: number }>(
      space,
      "p7-grandchild-parent",
      undefined,
      tx,
    );
    const parentRootId = parentCell.getAsNormalizedFullLink().id;
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
      runDemanderResolver: (pieceRootIds) =>
        pieceRootIds.includes(parentRootId) ? [alice, bob] : [],
    });
    const running = runtime.runner.run(tx, parentPattern, { n: 5 }, parentCell);
    expect((await tx.commit()).error).toBeUndefined();
    await running.pull();
    await runtime.idle();
    const principals = childDerivationPrincipals();
    expect(principals.length).toBeGreaterThan(0);
    expect(principals).toContain(alice.principal);
    expect(principals).toContain(bob.principal);
    expect(principals.every((p) => p !== undefined)).toBe(true);
    runtime.runner.stop(parentCell);
  });

  it("hands the emitting run's identity to the dispatched handler run (LT6: events run as the session they originated from)", async () => {
    const aliceKey = resolveScopeKey("user", alice);
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
    });

    // A handler on a stream doc, registered directly (events.md §1's
    // `addSchedulerEventHandler` hook).
    const streamCell = runtime.getCell<{ v?: number }>(
      space,
      "p2f-lt6-stream",
      undefined,
    );
    await streamCell.sync();
    const streamLink = streamCell.getAsNormalizedFullLink();
    const handled = Promise.withResolvers<void>();
    const cancel = runtime.scheduler.addEventHandler(
      (_tx, _event) => {
        handled.resolve();
      },
      streamLink,
    );

    try {
      // The EMITTING run: a demanded user-session derivation — its tx
      // stamped through the production choke point with the demand's
      // identity (the run supply's output), committed like a finished
      // run (the production `Cell.send` path forwards the run's own
      // `this.tx` the same way; the stamp side-table survives commit).
      const originTx = runtime.edit();
      runtime.stampServerRun(originTx, {
        actionId: "test/p2f-emitting-derivation",
        kind: "derivation",
        scopeKeyIdentity: alice,
        actionScopeKey: aliceKey,
      });
      const originProbe = runtime.getCell<{ emitted?: boolean }>(
        space,
        "p2f-lt6-origin-probe",
        undefined,
      );
      await originProbe.sync();
      originProbe.withTx(originTx).set({ emitted: true });
      runtime.scheduler.queueEvent(
        streamLink,
        { v: 1 },
        true,
        undefined,
        true,
        { originTx },
      );
      expect((await originTx.commit()).error).toBeUndefined();
      await runtime.idle();
      await handled.promise;

      // The dispatched handler run's stamp INHERITS the emitting run's
      // acting identity (LT6) — pre-P2-F it carried none and the
      // handler classified userless.
      const handlerStamps = stamped.filter((info) =>
        info.kind === "event-handler"
      );
      expect(handlerStamps.length).toBeGreaterThanOrEqual(1);
      expect(handlerStamps[0].scopeKeyIdentity?.principal).toBe(
        alice.principal,
      );
      expect(String(handlerStamps[0].scopeKeyIdentity?.sessionId)).toBe(
        "alice-s1",
      );
      expect(handlerStamps[0].actionScopeKey).toBe(aliceKey);
    } finally {
      cancel();
    }
  });

  //
  // Fan-out stage B, review F1: a bounded RetryImmediately
  //
  // Fan-out stage B, independent review F1: `RetryImmediately` inside a
  // fanned-out instance run must be BOUNDED — the OFF arm's shape (one queued
  // retry per attempt, a macrotask apart, MAX_RETRIES_FOR_REACTIVE attempts,
  // then the accepted zombie). Before the fix the loop re-ran the same instance
  // in the SAME pass (its key never became clean, so the set kept offering it):
  // 501 invocations of a 500-throw action inside ONE `run()`, and a
  // never-resolving name spun the process's microtask queue forever — no timer
  // fired, `idle()` never resolved.
  //

  it("F1: a demanded action that keeps throwing RetryImmediately is bounded per pass — the loop DEFERS the instance instead of re-running it, the retry rides the queue (a timer fires between attempts), and the budget is MAX_RETRIES_FOR_REACTIVE", async () => {
    const rootId = "of:p2f-retry-root";
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
      runDemanderResolver: (pieceRootIds) =>
        pieceRootIds.includes(rootId) ? [alice, bob] : [],
    });
    let invocations = 0;
    // The reviewer's probe shape: throw 500 times, then succeed. Under
    // the bounded shape the budget (10) is exhausted long before the
    // 500th throw, so the action never "succeeds" — it becomes the
    // accepted zombie. Under the hot loop it succeeded on invocation
    // 501 inside one pass.
    const action = Object.assign(
      (_tx: IExtendedStorageTransaction) => {
        invocations += 1;
        if (invocations <= 500) throw new RetryImmediately("nope");
      },
      {
        schedulerObservationIdentity: {
          pieceId: `space:${rootId}`,
          pieceRootId: rootId,
        },
      },
    );
    // A macrotask armed BEFORE the run: under the hot loop it could not
    // fire until the loop had spun through all 501 invocations.
    let invocationsWhenTimerFired = -1;
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        invocationsWhenTimerFired = invocations;
        resolve();
      }, 0)
    );
    await runtime.scheduler.run(action);
    // The pass ran the deferred probe ONCE and returned control.
    expect(invocations).toBe(1);
    await timer;
    expect(invocationsWhenTimerFired).toBeLessThanOrEqual(1);
    await runtime.idle();
    // Bounded: at most the retry budget, never the 500-throw tail.
    expect(invocations).toBeLessThanOrEqual(MAX_RETRIES_FOR_REACTIVE);
  });

  it("F1: one principal's unresolvable name never starves a sibling instance — Alice's instance defers, Bob's runs in the SAME pass; Alice's retries ride the queue and exhaust at MAX_RETRIES_FOR_REACTIVE while Bob's clean instance is not re-run (B7 keep)", async () => {
    const rootId = "of:p2f-retry-sibling-root";
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
      runDemanderResolver: (pieceRootIds) =>
        pieceRootIds.includes(rootId) ? [alice, bob] : [],
    });
    const userDoc = runtime.getCellFromLink<{ v?: number }>({
      space,
      id: "of:p2f-retry-sibling-user-doc" as never,
      scope: "user",
      path: [],
    });
    const runs = { alice: 0, bob: 0, other: 0 };
    let aliceThrows = false;
    const action = Object.assign(
      (tx: IExtendedStorageTransaction) => {
        // Narrows by READING user scope (D11: learned by running).
        userDoc.withTx(tx).get();
        const principal = waveRunContextOf(tx)?.scopeKeyIdentity?.principal;
        if (principal === alice.principal) {
          runs.alice += 1;
          if (aliceThrows) throw new RetryImmediately("alice's name");
        } else if (principal === bob.principal) {
          runs.bob += 1;
        } else {
          runs.other += 1;
        }
      },
      {
        schedulerObservationIdentity: {
          pieceId: `space:${rootId}`,
          pieceRootId: rootId,
        },
      },
    );
    // Registered (not a raw one-shot): the queued retries can find the
    // node and run it, and the node keeps its fan-out record across
    // passes.
    const cancel = runtime.scheduler.register(action, undefined, {
      isEffect: true,
    });
    try {
      await runtime.idle();
      // Pass 1: the probe (alice) discovers user scope; bob's instance
      // runs in the same pass (the discovery re-arm).
      expect(runs).toEqual({ alice: 1, bob: 1, other: 0 });

      // Now alice's instance cannot resolve its name. An untargeted
      // invalidation dirties both instances.
      aliceThrows = true;
      let aliceRunsWhenTimerFired = -1;
      const timer = new Promise<void>((resolve) =>
        setTimeout(() => {
          aliceRunsWhenTimerFired = runs.alice;
          resolve();
        }, 0)
      );
      runtime.scheduler.invalidateAction(action);
      await runtime.idle();
      await timer;
      // Bob ran once more — in the FIRST pass, not after alice's budget
      // was gone — and never again (his key stayed clean while alice's
      // queued retries re-ran only her dirty key).
      expect(runs.bob).toBe(2);
      // Alice: bounded by the retry budget, one attempt per queued pass
      // (a macrotask apart — the timer saw at most her first attempt or
      // two), then the accepted zombie. The budget counter is per ACTION
      // (`state.retries`), so bob's one successful commit in the first
      // pass resets it once — one extra attempt, never an unbounded
      // number: in the queued passes only alice's dirty key runs.
      // (Pre-fix this spun the pass forever: 4 GB OOM.)
      expect(runs.alice - 1).toBeGreaterThanOrEqual(MAX_RETRIES_FOR_REACTIVE);
      expect(runs.alice - 1).toBeLessThanOrEqual(MAX_RETRIES_FOR_REACTIVE + 1);
      expect(aliceRunsWhenTimerFired).toBeLessThanOrEqual(3);
      expect(runs.other).toBe(0);
    } finally {
      cancel();
    }
  });

  it("F1: a RetryImmediately that resolves after a few attempts converges — the deferred instance's queued retries run it to success, its sibling untouched", async () => {
    const rootId = "of:p2f-retry-converge-root";
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
      runDemanderResolver: (pieceRootIds) =>
        pieceRootIds.includes(rootId) ? [alice, bob] : [],
    });
    const userDoc = runtime.getCellFromLink<{ v?: number }>({
      space,
      id: "of:p2f-retry-converge-user-doc" as never,
      scope: "user",
      path: [],
    });
    const runs = { alice: 0, bob: 0 };
    let aliceThrowsLeft = 0;
    let aliceSucceeded = 0;
    const action = Object.assign(
      (tx: IExtendedStorageTransaction) => {
        userDoc.withTx(tx).get();
        const principal = waveRunContextOf(tx)?.scopeKeyIdentity?.principal;
        if (principal === alice.principal) {
          runs.alice += 1;
          if (aliceThrowsLeft > 0) {
            aliceThrowsLeft -= 1;
            throw new RetryImmediately("alice's name, not yet");
          }
          aliceSucceeded += 1;
        } else if (principal === bob.principal) {
          runs.bob += 1;
        }
      },
      {
        schedulerObservationIdentity: {
          pieceId: `space:${rootId}`,
          pieceRootId: rootId,
        },
      },
    );
    const cancel = runtime.scheduler.register(action, undefined, {
      isEffect: true,
    });
    try {
      await runtime.idle();
      expect(runs).toEqual({ alice: 1, bob: 1 });
      aliceThrowsLeft = 3;
      runtime.scheduler.invalidateAction(action);
      await runtime.idle();
      // Three deferred attempts, then the fourth succeeds; bob ran once.
      expect(runs).toEqual({ alice: 1 + 4, bob: 2 });
      expect(aliceSucceeded).toBe(2);
    } finally {
      cancel();
    }
  });
});

// F1 (RULED 2026-08-13, option c): the piece-start setup commit's
// failure must SURFACE — loudly, counted — never be swallowed by the
// fire-and-forget start path.

const V1_NO_HANDLER = [
  "import { Writable, pattern } from 'commonfabric';",
  "interface Args { [key: string]: any }",
  "export default pattern<Args, { count: Writable<number> }>(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count };",
  "});",
  "",
].join("\n");

const V3_WITH_HANDLER = [
  "import { Writable, handler, pattern } from 'commonfabric';",
  "interface Args { limit?: number; [key: string]: any }",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "export default pattern<Args, { count: Writable<number> }>(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

describe("stage P2-F piece-start commit failure surfacing (F1)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: {
        serverExecution: true,
      },
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  // The bricked-piece fixture (nested-piece-setup-repair.test.ts's
  // shape): set up for V1, then re-point patternIdentity at the
  // handler-bearing V3 whose stream marker the V1 doc never
  // materialized — the exact durable state whose demanded start mints
  // a setup-REPAIR write on the serving runtime (`ensurePieceRunning`
  // → start → `Runner.#startCore()` → applySetupState).
  const brickedPiece = async () => {
    const tx = runtime.edit();
    const pm = runtime.patternManager;
    const v1 = await pm.compilePattern(programOf(V1_NO_HANDLER), {
      space,
      tx,
    });
    const v3 = await pm.compilePattern(programOf(V3_WITH_HANDLER), {
      space,
      tx,
    });
    const v3Ref = pm.getArtifactEntryRef(v3)!;
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "p2f-f1-brick",
      undefined,
      tx,
    );
    const running = runtime.runner.run(tx, v1, { limit: 3 }, cell);
    await tx.commit();
    await running.pull();
    runtime.runner.stop(cell);
    const tx2 = runtime.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v3Ref.identity,
      symbol: v3Ref.symbol,
    }, rawMetaWriteAuthorization);
    await tx2.commit();
    return cell;
  };

  it("restages a cold-start repair after a stale-read refusal", async () => {
    const cell = await brickedPiece();
    const manifest = cell.getMetaRaw("internal");
    const projection = cell.getRaw();
    const setupMarker = cell.getMetaRaw("patternSetupIdentity");
    const conflicted = cell.getAsNormalizedFullLink().id;
    let repairSeals = 0;
    const failures: unknown[] = [];
    runtime.pieceStartCommitFailureObserver = ({ error }) =>
      failures.push(error);
    runtime.installSealDestination({
      seal: (tx) => {
        if (waveRunContextOf(tx)?.actionId.startsWith("piece-start-repair/")) {
          repairSeals += 1;
          if (repairSeals === 1) {
            return Promise.resolve({
              error: {
                name: "ConflictError",
                message:
                  `stale confirmed read: ${conflicted} at seq 0 conflicted with seq 1`,
                conflict: { space, the: "application/json", of: conflicted },
                readyToRetry: () => Promise.resolve(),
              } as never,
            });
          }
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
    try {
      expect(await runtime.start(cell)).toBe(true);
      await runtime.idle();
      await runtime.runner.idlePieceInstantiationSettlements();
      expect(repairSeals).toBe(2);
      expect(failures).toEqual([]);
      expect(cell.getMetaRaw("internal")).not.toEqual(manifest);
      expect(cell.getRaw()).not.toEqual(projection);
      expect(cell.getMetaRaw("patternSetupIdentity")).toEqual(setupMarker);
    } finally {
      runtime.clearSealDestination();
    }
  });

  it("surfaces a refused piece-start setup-repair commit through the observer instead of swallowing it", async () => {
    const cell = await brickedPiece();

    // A destination that REFUSES exactly the piece-start repair's
    // sealed commit and passes everything else through natively — the
    // deterministic stand-in for a wave-side refusal (a conflict drop,
    // a lease-lost withdrawal, the §3d refusal of an unstamped tx).
    const refused: string[] = [];
    runtime.installSealDestination({
      seal: (tx: IExtendedStorageTransaction) => {
        const context = waveRunContextOf(tx);
        if (context?.actionId.startsWith("piece-start-repair/")) {
          refused.push(context.actionId);
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted" as const,
              message: "test refusal of the piece-start repair seal",
              reason: new Error("p2f-f1-test-refusal"),
            },
          });
        }
        return tx.tx.commit();
      },
    }, {
      runStamper: (tx, info) => {
        stampWaveRunContext(tx, {
          actionId: info.actionId,
          kind: info.kind,
        });
      },
    });

    const surfaced: Array<{ actionId: string; error: unknown }> = [];
    runtime.pieceStartCommitFailureObserver = (failure) => {
      surfaced.push(failure);
    };

    // The demanded start: instantiation throws missing-stream-marker,
    // the repair stages setup + retries in one tx, and THAT commit is
    // refused at the seal. Pre-F1 the refusal Result was swallowed
    // (teardown only, no surfacing) — the piece silently ran against
    // stale setup with nothing counted anywhere.
    await runtime.start(cell);
    await runtime.idle();

    // The refusal genuinely happened…
    expect(refused.length).toBeGreaterThanOrEqual(1);
    // …and SURFACED: the observer received the failure, action-id
    // attributed (the loud log rides the same call).
    expect(surfaced.length).toBeGreaterThanOrEqual(1);
    expect(surfaced[0].actionId.startsWith("piece-start-repair/")).toBe(true);
    runtime.clearSealDestination();
  });

  it("surfaces a refused fire-and-forget piece-INSTANTIATE commit through the observer (the start path's own arm, not only the repair's)", async () => {
    // A HEALTHY piece — no repair involved: run V1, stop, restart. The
    // restart's `Runner.#startCore()` mints the self-minted fire-and-forget
    // instantiation tx (`piece-instantiate/<root>`) — the arm the F1
    // hazard was actually filed about (start() resolves before the
    // commit settles, so a swallowed refusal leaves the piece silently
    // running against writes that never landed).
    const tx = runtime.edit();
    const pm = runtime.patternManager;
    const v1 = await pm.compilePattern(programOf(V1_NO_HANDLER), {
      space,
      tx,
    });
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "p2f-f2-restart",
      undefined,
      tx,
    );
    const running = runtime.runner.run(tx, v1, { limit: 3 }, cell);
    await tx.commit();
    await running.pull();
    runtime.runner.stop(cell);

    // A destination that REFUSES exactly the instantiate seal and
    // passes everything else through natively — the same deterministic
    // wave-side refusal stand-in as the repair test above.
    const refused: string[] = [];
    runtime.installSealDestination({
      seal: (sealTx: IExtendedStorageTransaction) => {
        const context = waveRunContextOf(sealTx);
        if (context?.actionId.startsWith("piece-instantiate/")) {
          refused.push(context.actionId);
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted" as const,
              message: "test refusal of the piece-instantiate seal",
              reason: new Error("p2f-f2-test-refusal"),
            },
          });
        }
        return sealTx.tx.commit();
      },
    }, {
      runStamper: (stampTx, info) => {
        stampWaveRunContext(stampTx, {
          actionId: info.actionId,
          kind: info.kind,
        });
      },
    });

    const surfaced: Array<{ actionId: string; error: unknown }> = [];
    runtime.pieceStartCommitFailureObserver = (failure) => {
      surfaced.push(failure);
    };

    // Fire-and-forget by design: start resolves true while the refused
    // commit settles behind it.
    const started = await runtime.start(cell);
    expect(started).toBe(true);
    await runtime.idle();

    // The refusal genuinely happened…
    expect(refused.length).toBeGreaterThanOrEqual(1);
    // …and SURFACED through the observer (neutralization red: silence
    // the instantiate arm's commit().then/.catch reporting in
    // instantiatePattern and this never fires).
    const deadline = Date.now() + 5_000;
    while (surfaced.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(surfaced.length).toBeGreaterThanOrEqual(1);
    expect(surfaced[0].actionId.startsWith("piece-instantiate/")).toBe(true);
    runtime.clearSealDestination();
  });

  it("stamps the piece-start repair seal with the sanctioned bookkeeping kind (the §3d piece-start site, RULED 2026-08-13)", async () => {
    const cell = await brickedPiece();
    const stamps: ServerRunInfo[] = [];
    runtime.installSealDestination({
      seal: (tx: IExtendedStorageTransaction) => tx.tx.commit(),
    }, {
      runStamper: (tx, info) => {
        stamps.push(info);
        stampWaveRunContext(tx, { actionId: info.actionId, kind: info.kind });
      },
    });
    const started = await runtime.start(cell);
    expect(started).toBe(true);
    await runtime.idle();
    const repairStamps = stamps.filter((info) =>
      info.actionId.startsWith("piece-start-repair/")
    );
    expect(repairStamps.length).toBeGreaterThanOrEqual(1);
    expect(repairStamps[0].kind).toBe("bookkeeping");
    runtime.clearSealDestination();
  });
});
