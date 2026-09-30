import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { defer } from "@commonfabric/utils/defer";
import {
  holdWorkerLifetimeLock,
  terminateWorker,
} from "@commonfabric/utils/worker-lifetime";

/** Starts the fixture worker, and returns it with its lifetime lock's name. */
async function startWorker(): Promise<
  { worker: Worker; lifetimeLock: string }
> {
  const worker = new Worker(
    new URL("./fixtures/lifetime-lock-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  const posted = defer<string | undefined>();
  worker.onmessage = (event: MessageEvent<string | undefined>) =>
    posted.resolve(event.data);
  worker.onerror = (event) => posted.reject(new Error(event.message));
  const lifetimeLock = await posted.promise;
  if (lifetimeLock === undefined) {
    worker.terminate();
    throw new Error("The worker took no lifetime lock");
  }
  return { worker, lifetimeLock };
}

/** Runs `body` with `navigator.locks` reading as `locks`. */
async function withLocks(
  locks: Pick<LockManager, "request"> | undefined,
  body: () => Promise<void>,
): Promise<void> {
  Object.defineProperty(navigator, "locks", {
    value: locks,
    configurable: true,
  });
  try {
    await body();
  } finally {
    Reflect.deleteProperty(navigator, "locks");
  }
}

/** The names of every Web Lock this process holds or has requested. */
async function lockNames(): Promise<(string | undefined)[]> {
  const { held = [], pending = [] } = await navigator.locks.query();
  return [...held, ...pending].map(({ name }) => name);
}

describe("worker-lifetime", () => {
  describe("holdWorkerLifetimeLock()", () => {
    it("returns the name of a lock the worker holds while it runs", async () => {
      const { worker, lifetimeLock } = await startWorker();
      try {
        const granted = await navigator.locks.request(
          lifetimeLock,
          { ifAvailable: true },
          (lock) => lock !== null,
        );

        expect(granted).toBe(false);
      } finally {
        await terminateWorker(worker, lifetimeLock);
      }
    });

    it("returns `undefined` when the lock request is refused", async () => {
      const refusing = {
        request: () => Promise.reject(new DOMException("", "SecurityError")),
      };

      await withLocks(refusing, async () => {
        expect(await holdWorkerLifetimeLock()).toBeUndefined();
      });
    });

    it("returns `undefined` where there are no Web Locks", async () => {
      await withLocks(undefined, async () => {
        expect(await holdWorkerLifetimeLock()).toBeUndefined();
      });
    });
  });

  describe("terminateWorker()", () => {
    it("settles once the terminated worker no longer holds its lifetime lock", async () => {
      const { worker, lifetimeLock } = await startWorker();
      expect(await lockNames()).toContain(lifetimeLock);

      await terminateWorker(worker, lifetimeLock);

      expect(await lockNames()).not.toContain(lifetimeLock);
    });
  });
});
