import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type FabrichatBenchmarkRooms,
  seedFabrichatBenchmarkRooms,
} from "../integration/fabrichat-room-bench-support.ts";

describe("fabrichat-room-bench-support", () => {
  describe("seedFabrichatBenchmarkRooms()", () => {
    // Each seed is held open until the test releases it, so a case can see
    // which seeds are running at once and whether the call has returned.
    const heldSeeds = () => {
      type Label = keyof FabrichatBenchmarkRooms<string>;
      const gates = {
        read: Promise.withResolvers<void>(),
        send: Promise.withResolvers<void>(),
        react: Promise.withResolvers<void>(),
      };
      const running = new Set<Label>();
      let maximumRunning = 0;
      const seed = async (label: Label) => {
        running.add(label);
        maximumRunning = Math.max(maximumRunning, running.size);
        try {
          await gates[label].promise;
          return `${label} room`;
        } finally {
          running.delete(label);
        }
      };
      return { gates, running, seed, maximumRunning: () => maximumRunning };
    };

    it("runs all three seeds at once", async () => {
      const held = heldSeeds();

      const rooms = seedFabrichatBenchmarkRooms(held.seed);

      expect([...held.running].sort()).toEqual(["react", "read", "send"]);
      held.gates.read.resolve();
      held.gates.send.resolve();
      held.gates.react.resolve();
      await rooms;
      expect(held.maximumRunning()).toBe(3);
    });

    it("returns each room only once every seed has finished", async () => {
      const held = heldSeeds();
      let returned = false;

      const rooms = seedFabrichatBenchmarkRooms(held.seed);
      void rooms.then(() => returned = true);
      held.gates.react.resolve();
      held.gates.read.resolve();
      await held.gates.read.promise;
      await Promise.resolve();
      expect(returned).toBe(false);
      expect([...held.running]).toEqual(["send"]);

      held.gates.send.resolve();
      expect(await rooms).toEqual({
        read: "read room",
        send: "send room",
        react: "react room",
      });
      expect(returned).toBe(true);
    });

    it("rejects with the error of a seed that fails", async () => {
      const failure = new Error("Member 2's reaction did not happen");

      const rooms = seedFabrichatBenchmarkRooms((label) =>
        label === "send"
          ? Promise.reject(failure)
          : Promise.resolve(`${label} room`)
      );

      await expect(rooms).rejects.toBe(failure);
    });
  });
});
