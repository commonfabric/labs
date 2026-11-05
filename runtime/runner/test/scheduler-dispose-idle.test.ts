/**
 * `idle()` on a disposed scheduler, and the teardown that depends on it.
 *
 * `execute()` returns immediately once the scheduler is disposed, and it is the
 * only thing that drains `idlePromises`. So every park on that list — whether
 * it happened before dispose or is requested after — is a park forever unless
 * dispose accounts for it. `Runtime.dispose()` awaits `scheduler.idle()` twice,
 * which is how that became a hang rather than a leak for any caller that had
 * already quiesced the scheduler by hand.
 *
 * Deliberately no wall-clock bound on the awaits below: the failure being
 * pinned IS "this never resolves", so a hung test is the faithful report of it,
 * and a bound whose early fire fails a healthy run is the thing
 * docs/development/waiting-in-tests.md tells you not to add.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";

const signer = await Identity.fromPassphrase("scheduler dispose idle");

const newRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => new Runtime({ apiUrl: new URL(import.meta.url), storageManager });

// The fake clock the preload installs per test; absent on a real-clock run.
// Read through globalThis so this file also type-checks as a standalone program
// (the ambient declaration in clock.d.ts is in scope only when the package
// directory is checked as one).
function fakeClock(): { settle(): Promise<void> } | undefined {
  return (globalThis as { clock?: { settle(): Promise<void> } }).clock;
}

/**
 * Leaves the scheduler with work it will never get to run: an effect
 * subscription queues execution, so `scheduled` is set and `idle()` takes a
 * parking branch rather than the "nothing to do" one.
 */
const subscribeIdleBlockingEffect = (runtime: Runtime): void => {
  const action: Action = () => {};
  runtime.scheduler.subscribe(
    action,
    { reads: [], shallowReads: [], writes: [] },
    { isEffect: true, debounce: 50 },
  );
};

describe("scheduler.dispose() and idle()", () => {
  it("resolves an idle() requested after dispose", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      subscribeIdleBlockingEffect(runtime);
      runtime.scheduler.dispose();

      // Verified by mutation: without the disposed branch in waitForQuiescence
      // this never settles, and it is the FIRST case to go red — dispose
      // draining the parked list cannot reach an idle() that has not been
      // requested yet.
      await runtime.scheduler.idle();
    } finally {
      // The full teardown, which the case below is what makes possible.
      await runtime.dispose();
    }
  });

  it("resolves an idle() already parked when dispose arrives", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      subscribeIdleBlockingEffect(runtime);
      const parked = runtime.scheduler.idle();
      runtime.scheduler.dispose();

      // The waiter above was pushed BEFORE dispose, so the branch that covers
      // the previous case cannot reach it — only dispose draining the list can.
      // Verified by mutation: dropping that drain reds this case with the
      // previous one still passing, which is what keeps the two mechanisms
      // separately pinned rather than one masking the other.
      await parked;
    } finally {
      // The full teardown, which the case below is what makes possible.
      await runtime.dispose();
    }
  });

  it("holds a parked waiter until an in-flight run finishes", async () => {
    // `dispose()` does NOT cancel a run already under way — `execute()` checks
    // `disposed` only on entry. A waiter parked while execution was merely
    // SCHEDULED therefore outlives the moment the run starts, and releasing it
    // at dispose would report quiescence with an action, and its commit, still
    // going — the one reading a caller who is about to close shared storage
    // cannot recover from. Waiting on `runningPromise` is not optional here.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const action: Action = () => {
        signalStarted();
        return gate;
      };
      runtime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );

      const order: string[] = [];
      // Parked while `scheduled` is set and no run has begun, which is the
      // branch that makes this reachable: the run starts afterwards.
      const parked = runtime.scheduler.idle().then(() => order.push("idle"));
      await started;
      // settle() rather than a yield of my own: an ordering guarantee to a
      // fixpoint, which is what an assertion that something has NOT happened
      // needs — it cannot lose the race under load.
      await fakeClock()?.settle();
      // Guards against passing vacuously: if this waiter had already resolved,
      // the claim below would hold for the wrong reason.
      expect(order).toEqual([]);

      runtime.scheduler.dispose();

      await fakeClock()?.settle();
      expect(order).toEqual([]);

      release();
      await parked;
      expect(order).toEqual(["idle"]);
    } finally {
      // Released here too: an assertion above throwing must not strand the
      // in-flight action, or teardown blocks on it and buries the real error.
      release();
      await runtime.dispose();
    }
  });

  it("lets Runtime.dispose() compose with an already-disposed scheduler", async () => {
    // The end-to-end shape, and the reason the two cases above are worth
    // pinning: a test that quiesced the scheduler by hand could not then run
    // the real teardown, so it closed storage directly and skipped
    // `sourceReconciler.dispose()`, `settlePointerCommits()` and `popFrame()`.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    subscribeIdleBlockingEffect(runtime);
    runtime.scheduler.dispose();

    await runtime.dispose();
  });
});
