import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { DID } from "@commonfabric/identity";

import { UnavailableSpaceRetry } from "../src/lib/unavailable-space-retry.ts";

const REFUSED = "did:key:z6Mk-shell-refused" as DID;
const OTHER_REFUSED = "did:key:z6Mk-shell-other-refused" as DID;
const ADMITTED = "did:key:z6Mk-shell-admitted" as DID;

/** A notice of a refused space, as a `RuntimeClient` emits it. */
type Notice = { space: DID; deleted?: true };

/**
 * A stand-in for a `RuntimeClient`, which records each retry of a space and
 * counts each retry of the unreachable ones, and lets a test deliver a
 * refusal notice to whatever is listening for one.
 */
function fakeRuntime(
  retryResult: () => Promise<void> = () => Promise.resolve(),
  unreachableResult: () => Promise<void> = () => Promise.resolve(),
) {
  const listeners = new Set<(notice: Notice) => void>();
  const retried: DID[] = [];
  const unreachableRetries = { count: 0 };
  return {
    retried,
    unreachableRetries,
    listeners,
    refuse(space: DID, options: { deleted?: true } = {}): void {
      for (const listener of listeners) listener({ space, ...options });
    },
    on(_event: "spaceaccesslost", listener: (notice: Notice) => void) {
      listeners.add(listener);
    },
    off(_event: "spaceaccesslost", listener: (notice: Notice) => void) {
      listeners.delete(listener);
    },
    retrySpaceAccess(space: DID): Promise<void> {
      retried.push(space);
      return retryResult();
    },
    retryUnreachableSpaces(): Promise<void> {
      unreachableRetries.count++;
      return unreachableResult();
    },
  };
}

describe("UnavailableSpaceRetry", () => {
  describe("instance members", () => {
    describe("retry()", () => {
      it("retries a space the runtime reported refused", () => {
        const runtime = fakeRuntime();
        const retry = new UnavailableSpaceRetry(runtime);
        runtime.refuse(REFUSED);
        retry.retry(REFUSED);
        expect(runtime.retried).toEqual([REFUSED]);
      });

      it("retries nothing for a space the runtime reported deleted, whether or not it reported it refused first", () => {
        const runtime = fakeRuntime();
        const retry = new UnavailableSpaceRetry(runtime);
        runtime.refuse(REFUSED, { deleted: true });
        runtime.refuse(OTHER_REFUSED);
        runtime.refuse(OTHER_REFUSED, { deleted: true });
        runtime.refuse(OTHER_REFUSED);
        retry.retry(REFUSED);
        retry.retry(OTHER_REFUSED);
        expect(runtime.retried).toEqual([]);
      });

      it("retries nothing for a space the runtime never reported refused", () => {
        const runtime = fakeRuntime();
        const retry = new UnavailableSpaceRetry(runtime);
        runtime.refuse(REFUSED);
        retry.retry(ADMITTED);
        retry.retry(undefined);
        expect(runtime.retried).toEqual([]);
      });

      it("retries the spaces the runtime could not reach, whatever the space", () => {
        const runtime = fakeRuntime();
        const retry = new UnavailableSpaceRetry(runtime);
        runtime.refuse(REFUSED);
        retry.retry(REFUSED);
        retry.retry(ADMITTED);
        retry.retry(undefined);
        expect(runtime.unreachableRetries.count).toBe(3);
      });
    });

    describe("retryAll()", () => {
      it("retries each space the runtime reported refused, once each", () => {
        const runtime = fakeRuntime();
        const retry = new UnavailableSpaceRetry(runtime);
        runtime.refuse(REFUSED);
        runtime.refuse(OTHER_REFUSED);
        runtime.refuse(REFUSED);
        retry.retryAll();
        expect(runtime.retried).toEqual([REFUSED, OTHER_REFUSED]);
      });

      it("retries the spaces the runtime could not reach, refused spaces or none", () => {
        const runtime = fakeRuntime();
        const retry = new UnavailableSpaceRetry(runtime);
        retry.retryAll();
        runtime.refuse(REFUSED);
        retry.retryAll();
        expect(runtime.unreachableRetries.count).toBe(2);
      });

      it("retries no space the runtime reported deleted", () => {
        const runtime = fakeRuntime();
        const retry = new UnavailableSpaceRetry(runtime);
        runtime.refuse(REFUSED);
        runtime.refuse(OTHER_REFUSED);
        runtime.refuse(OTHER_REFUSED, { deleted: true });
        retry.retryAll();
        expect(runtime.retried).toEqual([REFUSED]);
      });

      it("logs a failed retry as a warning", async () => {
        const failure = Promise.withResolvers<void>();
        const runtime = fakeRuntime(() => failure.promise);
        const retry = new UnavailableSpaceRetry(runtime);
        const warnings: unknown[][] = [];
        const originalWarn = console.warn;
        const warned = Promise.withResolvers<void>();
        console.warn = (...args: unknown[]) => {
          warnings.push(args);
          warned.resolve();
        };
        try {
          runtime.refuse(REFUSED);
          expect(() => retry.retryAll()).not.toThrow();
          const cause = new Error("worker gone");
          failure.reject(cause);
          await warned.promise;
          expect(warnings).toEqual([[
            `[UnavailableSpaceRetry] Retrying ${REFUSED} failed:`,
            cause,
          ]]);
        } finally {
          console.warn = originalWarn;
        }
      });
    });

    describe("retryUnreachable()", () => {
      it("retries the spaces the runtime could not reach, and no refused space", () => {
        const runtime = fakeRuntime();
        const retry = new UnavailableSpaceRetry(runtime);
        runtime.refuse(REFUSED);
        retry.retryUnreachable();
        expect(runtime.unreachableRetries.count).toBe(1);
        expect(runtime.retried).toEqual([]);
      });

      it("logs a failed retry as a warning", async () => {
        const failure = Promise.withResolvers<void>();
        const runtime = fakeRuntime(undefined, () => failure.promise);
        const retry = new UnavailableSpaceRetry(runtime);
        const warnings: unknown[][] = [];
        const originalWarn = console.warn;
        const warned = Promise.withResolvers<void>();
        console.warn = (...args: unknown[]) => {
          warnings.push(args);
          warned.resolve();
        };
        try {
          expect(() => retry.retryUnreachable()).not.toThrow();
          const cause = new Error("worker gone");
          failure.reject(cause);
          await warned.promise;
          expect(warnings).toEqual([[
            "[UnavailableSpaceRetry] Retrying unreachable spaces failed:",
            cause,
          ]]);
        } finally {
          console.warn = originalWarn;
        }
      });
    });

    describe("dispose()", () => {
      it("stops listening, so a later refusal is not retried", () => {
        const runtime = fakeRuntime();
        const retry = new UnavailableSpaceRetry(runtime);
        expect(runtime.listeners.size).toBe(1);
        retry.dispose();
        expect(runtime.listeners.size).toBe(0);
        runtime.refuse(REFUSED);
        retry.retryAll();
        expect(runtime.retried).toEqual([]);
      });
    });
  });
});
