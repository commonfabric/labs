import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("cross-space settled");

/** How many rejections of tracked work the storage manager has logged. */
const loggedRejections = (): number =>
  (getLoggerCountsBreakdown() as Record<
    string,
    Record<string, { error?: number }>
  >)["storage.v2"]?.["tracked-work-rejected"]?.error ?? 0;

/**
 * How many times `then()` has been called on a `CountedPromise`, counted from
 * when this module loaded.
 */
let thenCalls = 0;

/**
 * A promise that counts the reactions anything attaches to it, which is what a
 * waiter on tracked work would cost if it chained onto that work.
 */
class CountedPromise<T> extends Promise<T> {
  override then<A = T, B = never>(
    onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    thenCalls++;
    return super.then(onFulfilled, onRejected);
  }
}

describe("memory-v2-cross-space-settled", () => {
  let storage: EmulatedStorageManager;

  beforeEach(() => {
    storage = EmulatedStorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await storage.close();
  });

  describe("crossSpaceSettled()", () => {
    it("resolves once tracked work settles, including work tracked while it waits", async () => {
      const rejectionsBefore = loggedRejections();
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      storage.trackUntilSettled(first.promise);
      let settled = false;
      const waiting = storage.crossSpaceSettled().then(() => {
        settled = true;
      });

      // The second piece of work joins before the first is done, so the
      // first finishing leaves the set nonempty.
      storage.trackUntilSettled(second.promise);
      first.resolve();
      await first.promise;
      expect(storage.pendingCrossSpacePromiseCount()).toBe(1);
      expect(settled).toBe(false);

      second.reject(new Error("a failed load still settles"));
      await waiting;
      expect(settled).toBe(true);
      expect(storage.pendingCrossSpacePromiseCount()).toBe(0);
      expect(loggedRejections()).toBe(rejectionsBefore + 1);
    });

    it("resolves when nothing is tracked", async () => {
      expect(storage.pendingCrossSpacePromiseCount()).toBe(0);
      await storage.crossSpaceSettled();
    });

    it("attaches no reaction to tracked work for each waiter", async () => {
      // The same work waited for by one caller and by fifty must gain the
      // same number of reactions: waiting is paid per waiter and per piece of
      // work, not for every pair of them.

      const reactionsWith = async (waiterCount: number): Promise<number> => {
        const works = Array.from(
          { length: 20 },
          () => CountedPromise.withResolvers<void>(),
        );
        thenCalls = 0;
        for (const work of works) storage.trackUntilSettled(work.promise);
        const waiters = Array.from(
          { length: waiterCount },
          () => storage.crossSpaceSettled(),
        );
        for (const work of works) work.resolve();
        await Promise.all(waiters);
        return thenCalls;
      };

      const alone = await reactionsWith(1);
      const crowded = await reactionsWith(50);
      expect(alone).toBeGreaterThan(0);
      expect(crowded).toBe(alone);
    });
  });
});
