import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { holdLifetimeLock } from "@/backends/web-worker/lifetime-lock.ts";

/** Runs `body` with `navigator.locks` reading as `locks`. */
async function withLocks(
  locks: LockManager | undefined,
  body: () => Promise<void>,
): Promise<void> {
  Object.defineProperty(navigator, "locks", {
    value: locks,
    configurable: true,
  });
  try {
    await body();
  } finally {
    delete (navigator as { locks?: LockManager }).locks;
  }
}

describe("lifetime-lock", () => {
  describe("holdLifetimeLock()", () => {
    it("resolves with the name of a lock it goes on holding", async () => {
      const name = await holdLifetimeLock();

      expect(name).toBeDefined();
      const { held } = await navigator.locks.query();
      expect(held?.map((lock) => lock.name)).toContain(name);
      const taken = await navigator.locks.request(
        name!,
        { ifAvailable: true },
        (lock) => lock !== null,
      );
      expect(taken).toBe(false);
    });

    it("resolves with `undefined` when the lock request is refused", async () => {
      const refusing = {
        request: () => Promise.reject(new DOMException("", "SecurityError")),
      } as unknown as LockManager;

      await withLocks(refusing, async () => {
        expect(await holdLifetimeLock()).toBeUndefined();
      });
    });

    it("resolves with `undefined` where there are no Web Locks", async () => {
      await withLocks(undefined, async () => {
        expect(await holdLifetimeLock()).toBeUndefined();
      });
    });
  });
});
