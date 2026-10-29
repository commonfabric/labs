// Regression: a reactive EFFECT whose optimistic commit fails with a cross-replica
// ConflictError recovers and re-runs against fresh state — WITHOUT consuming the
// reactive retry budget — exactly as a computation is.
//
// ConflictError is kept out of the reactive retry budget (a conflict is a wait for
// catch-up, not a failure). Recovery is guaranteed by the catch-up re-queue in
// watchReactiveActionCommit: re-arm the subscription, wait for the conflict's
// `readyToRetry`, then re-run. The cross-replica ConflictError's read-repair sync
// re-triggering the effect via reader-dirty is a redundant fast path. The
// off-budget conflict-skip is intentionally NOT gated to computations — effects
// take the same path. A same-replica race is a StorageTransactionInconsistent,
// which keeps its bounded retry; only the cross-replica ConflictError reaches this
// path.
//
// Coverage gap this fills: compute-conflict-recovery.test.ts asserts the reader-dirty
// PREDICATE for computations; commit-conflict-reconcile.test.ts exercises read-repair
// on a MANUAL tx. Neither drives a scheduler-managed EFFECT commit through a real
// conflict and back to recovery.
//
// Harness: two Runtimes share ONE server, each with its own replicas (recipe from
// commit-conflict-reconcile.test.ts). The writer (A) advances the shared doc; the
// replica under test (B) is left provably stale, so B's effect deterministically
// reads the stale value and its commit conflicts.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type {
  IStorageNotification,
  StorageNotification,
} from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("effect-conflict-recovery");
const space = signer.did();

class SuppressibleStorageManager extends EmulatedStorageManager {
  /**
   * Whether to forward storage notifications to subscribers with their
   * `changes` emptied, so they raise no reader-dirty — a deterministic stand-in
   * for a dataless catch-up (a conflict whose catch-up carries no diff). Off by
   * default: a transparent passthrough that leaves the other tests unaffected.
   */
  suppressReaderDirty = false;

  override subscribe(subscription: IStorageNotification): void {
    super.subscribe({
      next: (n: StorageNotification) =>
        this.suppressReaderDirty && "changes" in n
          ? subscription.next(
            { ...n, changes: [] } as unknown as StorageNotification,
          )
          : subscription.next(n),
    });
  }
}

describe("effect commit-conflict recovery (no retry budget)", () => {
  // scheduler-v2 cutover: the debounced variant of #4210's effect-conflict
  // coverage was dropped here. It pinned the v1 `conditionallyScheduledEffects`
  // path, which scheduler-v2 deletes (see
  // docs/history/specs/scheduler-v2/current-system-inventory.md, "Conditional
  // effects — Delete"). Under v2's pull-based settle a `debounce` effect defers
  // its first run, so B's read-repair brings the source to the post-bump value
  // before the effect runs: the first read is fresh (not the stale value the
  // test asserted) and no conflict is produced at all — strictly better, but it
  // no longer exercises the conflict-recovery path these tests target. The
  // conflict guarantee (off-budget re-queue after catch-up, #4343) is covered
  // by the plain-effect test and the dataless-catch-up strand test below.

  let server: MemoryV2Server.Server;
  let storageA: SuppressibleStorageManager;
  let storageB: SuppressibleStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;
  let conflicts: Error[];

  // Recovery is a multi-round conversation — conflict, repair frame,
  // re-run, commit — and each round's delivery is released by an explicit
  // fan-out flush. Iteration-bounded rather than time-bounded: each round
  // either makes real progress or the predicate is unreachable.
  const converge = async (
    predicate: () => boolean,
    rounds = 25,
  ): Promise<boolean> => {
    for (let i = 0; i < rounds && !predicate(); i++) {
      await server.flushSessions();
      await clock.settle();
      await rtB.idle();
    }
    return predicate();
  };

  beforeEach(() => {
    conflicts = [];
    // Manual fan-out: the controlled staleness these tests are built on is
    // a gated state, not a timing accident — frames spread only through
    // converge()'s explicit flushes.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    // The inherited static builds `new this(...)`, so these ARE
    // SuppressibleStorageManager instances; its declared return type is just
    // the base class.
    storageA = SuppressibleStorageManager.connectTo(
      server,
      { as: signer },
    ) as SuppressibleStorageManager;
    storageB = SuppressibleStorageManager.connectTo(
      server,
      { as: signer },
    ) as SuppressibleStorageManager;
    storageB.subscribe({
      next: (notification: StorageNotification) => {
        if (
          notification.type === "revert" &&
          notification.reason.name === "ConflictError"
        ) {
          conflicts.push(notification.reason);
        }
        return undefined;
      },
    });
    rtA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    rtB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
  });

  afterEach(async () => {
    await rtB.dispose();
    await rtA.dispose();
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  const exerciseEffectConflict = async (
    tag: string,
    extraOptions: { debounce?: number },
  ): Promise<void> => {
    const srcKey = `${tag}-src`;
    const resKey = `${tag}-res`;

    // A seeds source=1 and result=0, publishes to the shared server.
    const srcA = rtA.getCell<number>(space, srcKey, undefined);
    const resA = rtA.getCell<number>(space, resKey, undefined);
    {
      const tx = rtA.edit();
      srcA.withTx(tx).set(1);
      resA.withTx(tx).set(0);
      rtA.prepareTxForCommit(tx);
      // Verdict-marked, no synced(): the barrier would hold on A's parked
      // accept and force the shared fan-out through — to B too, destroying
      // the controlled staleness. The awaited verdict is durably accepted,
      // which is all B's explicit sync/pull needs.
      const res = await tx.commit({ holdSyncedUntilCovered: false }).verdict;
      expect(res.error, `seed: ${JSON.stringify(res.error)}`).toBeUndefined();
    }

    // B converges to source=1, result=0.
    const srcB = rtB.getCell<number>(space, srcKey, undefined);
    const resB = rtB.getCell<number>(space, resKey, undefined);
    await srcB.sync();
    await resB.sync();
    await srcB.pull();
    await resB.pull();
    expect(srcB.get(), "B converged to source=1").toBe(1);

    // A advances source to 2. B is deliberately NOT synced — it stays stale at 1.
    {
      const tx = rtA.edit();
      srcA.withTx(tx).set(2);
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit({ holdSyncedUntilCovered: false }).verdict;
      expect(res.error, `bump: ${JSON.stringify(res.error)}`).toBeUndefined();
    }
    expect(srcB.get(), "B is provably stale (still 1) before the effect runs")
      .toBe(1);

    // Subscribe an effect on B that reads source and writes source*10 into result.
    // Its first run reads the stale 1; its commit conflicts (server at 2); the
    // conflict is skipped from the retry budget, and the catch-up re-queue (with
    // read-repair / reader-dirty as a fast path) re-runs it against 2.
    const seen: number[] = [];
    let runs = 0;
    const effect: Action = (actionTx) => {
      runs++;
      const value = srcB.withTx(actionTx).get();
      seen.push(value);
      resB.withTx(actionTx).send(value * 10);
    };
    rtB.scheduler.subscribe(effect, {
      reads: [toMemorySpaceAddress(srcB.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(resB.getAsNormalizedFullLink())],
    }, { isEffect: true, ...extraOptions });

    await rtB.idle();
    expect(seen[0], "effect first ran against the stale value").toBe(1);

    const recovered = await converge(() => seen.includes(2));
    await rtB.idle();

    expect(
      conflicts.length,
      "the effect's optimistic commit hit a real ConflictError",
    ).toBeGreaterThanOrEqual(1);
    expect(
      recovered,
      "effect re-ran against the post-conflict value after catch-up",
    ).toBe(true);
    expect(resB.get(), "effect's recovered write reflects fresh state").toBe(
      20,
    );
    expect(runs, "effect re-ran (was not stranded by the skipped retry)")
      .toBeGreaterThanOrEqual(2);
  };

  it("recovers a plain effect off the retry budget (not stranded)", async () => {
    await exerciseEffectConflict("plain", {});
  });

  it("recovers only via the re-queue when the catch-up is dataless", async () => {
    // Deterministic regression for the #4210/#4343 strand: a reactive action
    // whose commit conflicts must re-evaluate even when the conflict's catch-up
    // delivers NO reader-dirty (the "already-delivered write" case). The real
    // strand is a timing window that doesn't reproduce deterministically — on a
    // normal conflict the read-repair force-notifies, so reader-dirty fires and
    // the action self-recovers even without a re-queue. `suppressReaderDirty`
    // stands in for the dataless catch-up: the real ConflictError still flows
    // via the commit promise and the repaired value still lands in confirmed
    // storage, so recovery is left ONLY to the re-queue. Passes with #4343's
    // re-queue; strands (fails) with a no-requeue handler (the #4210 /
    // #4349-ordinary behavior).

    const srcKey = "strand-src";
    const resKey = "strand-res";

    // A seeds source=1, result=0.
    const srcA = rtA.getCell<number>(space, srcKey, undefined);
    const resA = rtA.getCell<number>(space, resKey, undefined);
    {
      const tx = rtA.edit();
      srcA.withTx(tx).set(1);
      resA.withTx(tx).set(0);
      rtA.prepareTxForCommit(tx);
      // Verdict-marked, no synced(): the barrier would hold on A's parked
      // accept and force the shared fan-out through — to B too, destroying
      // the controlled staleness. The awaited verdict is durably accepted,
      // which is all B's explicit sync/pull needs.
      const res = await tx.commit({ holdSyncedUntilCovered: false }).verdict;
      expect(res.error, `seed: ${JSON.stringify(res.error)}`).toBeUndefined();
    }

    // B converges to source=1.
    const srcB = rtB.getCell<number>(space, srcKey, undefined);
    const resB = rtB.getCell<number>(space, resKey, undefined);
    await srcB.sync();
    await resB.sync();
    await srcB.pull();
    await resB.pull();
    expect(srcB.get(), "B converged to source=1").toBe(1);

    // From here the scheduler must see no reader-dirty for the bump: the
    // catch-up is dataless, so recovery can come ONLY from the re-queue.
    storageB.suppressReaderDirty = true;

    // scheduler-v2 adaptation: under the demand-driven scheduler the effect's
    // first run races the bump's integration into B's replica (main ran it
    // synchronously at subscribe, deterministically before the sync tick). Pin
    // the stale basis explicitly instead: the effect reads source, then parks
    // on a gate the test resolves only after A's bump is durable at the
    // server. The running transaction's read basis is captured at the read, so
    // its commit conflicts deterministically regardless of integration timing.
    let releaseFirstRun!: () => void;
    const firstRunGate = new Promise<void>((r) => (releaseFirstRun = r));
    let firstReadDone!: () => void;
    const firstRead = new Promise<void>((r) => (firstReadDone = r));
    let gateOpen = false;

    const seen: number[] = [];
    let runs = 0;
    const effect: Action = async (actionTx) => {
      runs++;
      const value = srcB.withTx(actionTx).get();
      seen.push(value);
      if (!gateOpen) {
        firstReadDone();
        await firstRunGate;
      }
      resB.withTx(actionTx).send(value * 10);
    };
    rtB.scheduler.subscribe(effect, {
      reads: [toMemorySpaceAddress(srcB.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(resB.getAsNormalizedFullLink())],
    }, { isEffect: true });

    // The first run is now in flight, parked after reading the stale value.
    await firstRead;
    expect(seen[0], "first run read the stale value").toBe(1);

    // A advances source to 2 while B's first run holds its stale basis.
    {
      const tx = rtA.edit();
      srcA.withTx(tx).set(2);
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit({ holdSyncedUntilCovered: false }).verdict;
      expect(res.error, `bump: ${JSON.stringify(res.error)}`).toBeUndefined();
    }

    // Release the parked run; its commit now carries the stale source basis.
    gateOpen = true;
    releaseFirstRun();
    await rtB.idle();

    // On a no-requeue handler the action is stranded here (no reader-dirty, no
    // re-queue); with #4343's re-queue it re-runs against the caught-up state.
    const recovered = await converge(() => runs >= 2 && resB.get() === 20);
    await rtB.idle();

    expect(
      conflicts.length,
      "the commit hit a real ConflictError",
    ).toBeGreaterThanOrEqual(1);
    expect(
      recovered,
      "action re-ran via the re-queue despite the dataless catch-up",
    ).toBe(true);
    expect(runs, "action re-ran (not stranded)").toBeGreaterThanOrEqual(2);
    expect(resB.get(), "recovered, committed value reflects fresh state").toBe(
      20,
    );
  });
});
