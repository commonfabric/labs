import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CooperativeYield } from "../../src/scheduler/cooperative-yield.ts";

describe("CooperativeYield", () => {
  // Nothing here arms a timer with a delay, so on the package's fake clock
  // `performance.now()` moves only when a test calls `clock.tick()`. The
  // timer that falls due mid-slice is covered on the real clock, in
  // `executor-cooperative-yield.test.ts`.

  describe("instance members", () => {
    describe("maybeYield()", () => {
      it("returns `undefined` until the slice is spent", async () => {
        const yielder = new CooperativeYield(20);
        expect(yielder.maybeYield()).toBeUndefined();
        await clock.tick(19);
        expect(yielder.maybeYield()).toBeUndefined();
        await clock.tick(1);
        const turn = yielder.maybeYield();
        expect(turn).toBeDefined();
        await turn;
        expect(yielder.yieldCount).toBe(1);
      });

      it("calls `onYield` before the turn, and starts a fresh slice when the turn ends", async () => {
        const yielder = new CooperativeYield(20);
        let observed = 0;
        yielder.onYield = () => {
          observed += 1;
        };
        await clock.tick(20);
        const turn = yielder.maybeYield();
        expect(observed).toBe(1);
        expect(yielder.yieldCount).toBe(1);
        await turn;
        expect(yielder.maybeYield()).toBeUndefined();
        expect(observed).toBe(1);
      });

      it("resolves only after a macrotask queued before the yield has run", async () => {
        const yielder = new CooperativeYield(20);
        await clock.tick(20);
        let ran = false;
        setTimeout(() => {
          ran = true;
        }, 0);
        await yielder.maybeYield();
        expect(ran).toBe(true);
      });
    });

    describe("noteMacrotaskBoundary()", () => {
      it("starts a fresh slice", async () => {
        const yielder = new CooperativeYield(20);
        await clock.tick(15);
        yielder.noteMacrotaskBoundary();
        await clock.tick(15);
        expect(yielder.maybeYield()).toBeUndefined();
        await clock.tick(5);
        const turn = yielder.maybeYield();
        expect(turn).toBeDefined();
        await turn;
      });
    });

    describe("yieldNow()", () => {
      it("yields although the slice is fresh", async () => {
        const yielder = new CooperativeYield(20);
        await yielder.yieldNow();
        expect(yielder.yieldCount).toBe(1);
      });

      it("resolves and counts the yield when `onYield` throws", async () => {
        const yielder = new CooperativeYield(20);
        yielder.onYield = () => {
          throw new Error("boom");
        };
        await yielder.yieldNow();
        expect(yielder.yieldCount).toBe(1);
      });
    });
  });
});
