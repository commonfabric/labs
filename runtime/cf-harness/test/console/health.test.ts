import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ConsoleHealth, type ConsoleHealthRow } from "../../console/health.ts";

const fact = {
  id: "index.reachable",
  group: "index",
  label: "Pattern Index Reachability",
  value: "not checked",
  source: "index /health",
  detail: "GET health at https://index.test",
};

describe("ConsoleHealth", () => {
  describe("instance members", () => {
    describe("snapshot()", () => {
      it("returns unknown immediately while sharing a pending probe, then retains its observation until stale", async () => {
        let now = Date.parse("2026-09-17T00:00:00.000Z");
        let calls = 0;
        const ready = Promise.withResolvers<readonly ConsoleHealthRow[]>();
        const row: ConsoleHealthRow = {
          ...fact,
          value: "responding",
          state: "ok",
          checkedAt: new Date(now).toISOString(),
        };
        const health = new ConsoleHealth([], [{
          id: fact.id,
          initial: [fact],
          read: () => {
            calls++;
            return ready.promise;
          },
          unavailable: () => [],
        }], () => now);
        const initial = health.snapshot();
        expect(initial).toEqual({
          version: 1,
          generatedAt: new Date(now).toISOString(),
          rows: [{ ...fact, state: "unknown", checkedAt: null }],
        });
        const pending = health.refresh();
        const concurrent = health.refresh();
        ready.resolve([row]);
        await Promise.all([pending, concurrent]);
        expect(calls).toBe(1);
        expect(health.snapshot().rows).toEqual([row]);
        now += 29_999;
        await health.refresh();
        expect(calls).toBe(1);
        now += 1;
        await health.refresh();
        expect(calls).toBe(2);
      });

      it("records an unavailable probe as unknown with the failure observation's timestamp", async () => {
        const now = Date.parse("2026-09-17T03:00:00.000Z");
        const failure = new Error("offline");
        let observed: unknown;
        const health = new ConsoleHealth([], [{
          id: fact.id,
          initial: [fact],
          read: () => Promise.reject(failure),
          unavailable: (checkedAt, error) => {
            observed = error;
            return [{
              ...fact,
              state: "unknown",
              checkedAt,
              value: "not verified",
              reason: "The request could not complete.",
              remedy: "Check the network.",
            }];
          },
        }], () => now);
        await health.refresh();
        expect(observed).toBe(failure);
        expect(health.snapshot().rows).toEqual([{
          ...fact,
          state: "unknown",
          checkedAt: new Date(now).toISOString(),
          value: "not verified",
          reason: "The request could not complete.",
          remedy: "Check the network.",
        }]);
      });
    });
  });
});
