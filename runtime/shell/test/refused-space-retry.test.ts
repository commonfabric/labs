import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { DID } from "@commonfabric/identity";

import { RefusedSpaceRetry } from "../src/lib/refused-space-retry.ts";

const REFUSED = "did:key:z6Mk-shell-refused" as DID;
const OTHER_REFUSED = "did:key:z6Mk-shell-other-refused" as DID;
const ADMITTED = "did:key:z6Mk-shell-admitted" as DID;

/**
 * A stand-in for a `RuntimeClient`, which records each retry and lets a test
 * deliver a refusal notice to whatever is listening for one.
 */
function fakeRuntime(
  retryResult: () => Promise<void> = () => Promise.resolve(),
) {
  const listeners = new Set<(notice: { space: DID }) => void>();
  const retried: DID[] = [];
  return {
    retried,
    listeners,
    refuse(space: DID): void {
      for (const listener of listeners) listener({ space });
    },
    on(_event: "spaceaccesslost", listener: (notice: { space: DID }) => void) {
      listeners.add(listener);
    },
    off(_event: "spaceaccesslost", listener: (notice: { space: DID }) => void) {
      listeners.delete(listener);
    },
    retrySpaceAccess(space: DID): Promise<void> {
      retried.push(space);
      return retryResult();
    },
  };
}

describe("RefusedSpaceRetry", () => {
  describe("instance members", () => {
    describe("retry()", () => {
      it("retries a space the runtime reported refused", () => {
        const runtime = fakeRuntime();
        const retry = new RefusedSpaceRetry(runtime);
        runtime.refuse(REFUSED);
        retry.retry(REFUSED);
        expect(runtime.retried).toEqual([REFUSED]);
      });

      it("retries nothing for a space the runtime never reported refused", () => {
        const runtime = fakeRuntime();
        const retry = new RefusedSpaceRetry(runtime);
        runtime.refuse(REFUSED);
        retry.retry(ADMITTED);
        retry.retry(undefined);
        expect(runtime.retried).toEqual([]);
      });
    });

    describe("retryAll()", () => {
      it("retries each space the runtime reported refused, once each", () => {
        const runtime = fakeRuntime();
        const retry = new RefusedSpaceRetry(runtime);
        runtime.refuse(REFUSED);
        runtime.refuse(OTHER_REFUSED);
        runtime.refuse(REFUSED);
        retry.retryAll();
        expect(runtime.retried).toEqual([REFUSED, OTHER_REFUSED]);
      });

      it("logs a failed retry as a warning", async () => {
        const failure = Promise.withResolvers<void>();
        const runtime = fakeRuntime(() => failure.promise);
        const retry = new RefusedSpaceRetry(runtime);
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
            `[RefusedSpaceRetry] Retrying ${REFUSED} failed:`,
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
        const retry = new RefusedSpaceRetry(runtime);
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
