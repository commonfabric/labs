import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { WakeShaper } from "../../src/scheduler/wake-shaping.ts";

describe("WakeShaper", () => {
  describe("instance members", () => {
    describe("hold()", () => {
      it("delivers nothing once the shaper is disposed", () => {
        const shaper = new WakeShaper(100, 1);
        let delivered = 0;
        shaper.dispose();

        shaper.hold({ groupKey: "group", deliver: () => delivered++ });

        expect(delivered).toBe(0);
        expect(shaper.hasPending()).toBe(false);
      });
    });

    describe("whenDrained()", () => {
      it("resolves at once while nothing is held", async () => {
        // No timer of the shaper's is armed, so only an answer given at once
        // resolves within the microtasks awaited here.

        const shaper = new WakeShaper(100, 1);
        let drained = false;

        shaper.whenDrained().then(() => drained = true);
        await Promise.resolve();
        await Promise.resolve();

        expect(drained).toBe(true);
      });
    });

    describe("dispose()", () => {
      it("releases a drain waiter without delivering the queued wake", async () => {
        const shaper = new WakeShaper(100, 1);
        const delivered: string[] = [];
        shaper.hold({ groupKey: "group", deliver: () => delivered.push("a") });
        shaper.hold({ groupKey: "group", deliver: () => delivered.push("b") });
        expect(shaper.hasPending()).toBe(true);
        const drained = shaper.whenDrained();

        shaper.dispose();
        await drained;

        expect(delivered).toEqual(["a"]);
        expect(shaper.hasPending()).toBe(false);
      });

      it("arms no tick when the wake a hold delivers disposes the shaper", async () => {
        const shaper = new WakeShaper(100, 2);
        const delivered: string[] = [];
        shaper.hold({
          groupKey: "group",
          deliver: () => {
            delivered.push("a");
            shaper.dispose();
          },
        });

        await clock.tick(100);

        expect(delivered).toEqual(["a"]);
        expect(shaper.hasPending()).toBe(false);
      });

      it("delivers nothing more and ends the group's ticks when a wake the tick delivers disposes the shaper", async () => {
        // The first wake takes the only token, so the other two are held for
        // the tick, which delivers them as one batch.

        const shaper = new WakeShaper(100, 1);
        const delivered: string[] = [];
        shaper.hold({ groupKey: "group", deliver: () => delivered.push("a") });
        shaper.hold({
          groupKey: "group",
          deliver: () => {
            delivered.push("b");
            shaper.dispose();
          },
        });
        shaper.hold({ groupKey: "group", deliver: () => delivered.push("c") });

        await clock.tick(100);
        expect(delivered).toEqual(["a", "b"]);
        await clock.tick(100);

        expect(delivered).toEqual(["a", "b"]);
        expect(shaper.hasPending()).toBe(false);
      });
    });
  });
});
