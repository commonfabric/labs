import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";

import { SpaceAccessRetries } from "@/backends/space-access-retries.ts";

const SPACE = "did:key:z6Mk-retries-space" as MemorySpace;
const OTHER = "did:key:z6Mk-retries-other" as MemorySpace;

/**
 * A `SpaceAccessRetries` over a retry that settles only when the test says,
 * with each call it made and a way to settle the newest.
 */
function gatedRetries() {
  const calls: MemorySpace[] = [];
  const gates: PromiseWithResolvers<void>[] = [];
  const retries = new SpaceAccessRetries((space) => {
    calls.push(space);
    const gate = Promise.withResolvers<void>();
    gates.push(gate);
    return gate.promise;
  });
  return { retries, calls, gates };
}

describe("SpaceAccessRetries", () => {
  describe("instance members", () => {
    describe("retry()", () => {
      it("shares a retry in flight with a second call for the same space, and starts another for another space", async () => {
        const { retries, calls, gates } = gatedRetries();
        const first = retries.retry(SPACE);
        const second = retries.retry(SPACE);
        const other = retries.retry(OTHER);
        expect(second).toBe(first);
        expect(calls).toEqual([SPACE, OTHER]);
        for (const gate of gates) gate.resolve();
        await Promise.all([first, other]);
      });

      it("starts a new retry once the one in flight settles", async () => {
        const { retries, calls, gates } = gatedRetries();
        const first = retries.retry(SPACE);
        gates[0].resolve();
        await first;
        const again = retries.retry(SPACE);
        expect(calls).toEqual([SPACE, SPACE]);
        gates[1].resolve();
        await again;
      });

      it("rejects as the retry it called does", async () => {
        const { retries, gates } = gatedRetries();
        const retry = retries.retry(SPACE);
        const cause = new Error("server gone");
        gates[0].reject(cause);
        await expect(retry).rejects.toBe(cause);
      });
    });

    describe("dispose()", () => {
      it("starts no retry afterwards, and tells no observer of a retry that settles afterwards", async () => {
        const { retries, calls, gates } = gatedRetries();
        const heard: MemorySpace[] = [];
        retries.subscribe((space) => heard.push(space));
        const inFlight = retries.retry(SPACE);
        expect(heard).toEqual([SPACE]);
        retries.dispose();
        const afterDispose = retries.retry(OTHER);
        expect(calls).toEqual([SPACE]);
        for (const gate of gates) gate.resolve();
        await Promise.all([inFlight, afterDispose]);
        expect(heard).toEqual([SPACE]);
      });
    });

    describe("state()", () => {
      it("reports a retry in flight while one is, and one more settled once it settles", async () => {
        const { retries, gates } = gatedRetries();
        expect(retries.state(SPACE)).toEqual({ retrying: false, settled: 0 });
        const retry = retries.retry(SPACE);
        expect(retries.state(SPACE)).toEqual({ retrying: true, settled: 0 });
        expect(retries.state(OTHER)).toEqual({ retrying: false, settled: 0 });
        gates[0].resolve();
        await retry;
        expect(retries.state(SPACE)).toEqual({ retrying: false, settled: 1 });
      });

      it("counts a rejected retry as settled", async () => {
        const { retries, gates } = gatedRetries();
        const retry = retries.retry(SPACE);
        gates[0].reject(new Error("server gone"));
        await retry.catch(() => {});
        expect(retries.state(SPACE)).toEqual({ retrying: false, settled: 1 });
      });
    });

    describe("subscribe()", () => {
      it("tells an observer when a retry starts and when it settles, until cancelled", async () => {
        const { retries, gates } = gatedRetries();
        const heard: [MemorySpace, boolean][] = [];
        const cancel = retries.subscribe((space) =>
          heard.push([space, retries.state(space).retrying])
        );
        const retry = retries.retry(SPACE);
        retries.retry(SPACE);
        expect(heard).toEqual([[SPACE, true]]);
        gates[0].resolve();
        await retry;
        expect(heard).toEqual([[SPACE, true], [SPACE, false]]);
        cancel();
        const later = retries.retry(SPACE);
        gates[1].resolve();
        await later;
        expect(heard).toHaveLength(2);
      });
    });
  });
});
