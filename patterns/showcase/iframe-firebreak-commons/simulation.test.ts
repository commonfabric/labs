import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  DEFAULT_INPUT,
  type IframeInputData,
  type SimulationAction,
} from "./contract.ts";
import {
  actionDisposition,
  advanceFire,
  describeTile,
  initializeRenderer,
  normalizedBoardDimensions,
  normalizedMaximumTurns,
  reduceSimulation,
  type RendererFailureAlarm,
  reportRendererFailure,
  type TileState,
} from "./simulation.ts";

const input: IframeInputData = {
  ...DEFAULT_INPUT,
  seed: 712_367,
  columns: 8,
  rows: 6,
  initialFireCount: 2,
  maximumTurns: 8,
};

describe("simulation", () => {
  describe("initializeRenderer()", () => {
    it("surfaces and preserves a renderer bootstrap failure", () => {
      const failure = new Error("WebGL unavailable");
      const seen: unknown[] = [];

      expect(() =>
        initializeRenderer(() => {
          throw failure;
        }, (cause) => seen.push(cause))
      ).toThrow(failure);
      expect(seen).toEqual([failure]);
    });
  });

  describe("reportRendererFailure()", () => {
    it("raises a complete pre-bridge guest alarm", () => {
      const reported: RendererFailureAlarm[] = [];
      const failure = new Error("WebGL unavailable");

      reportRendererFailure(failure, (alarm) => reported.push(alarm));

      expect(reported).toEqual([{
        description: "WebGL unavailable",
        source: "iframe-firebreak-commons",
        lineno: 0,
        colno: 0,
        stacktrace: failure.stack,
      }]);
    });
  });

  describe("reduceSimulation()", () => {
    it("returns the same seeded board for the same semantic action log", () => {
      const initial = reduceSimulation(input, []);
      const burning = initial.tiles.find((tile) => tile.fire > 0)!;
      const buildable = initial.tiles.find((tile) =>
        tile.fire === 0 &&
        (tile.terrain === "forest" || tile.terrain === "grass")
      )!;
      const actions: SimulationAction[] = [
        {
          id: "action-water",
          actorId: "crew-alice",
          turn: 1,
          type: "water",
          tileId: burning.id,
        },
        {
          id: "action-break",
          actorId: "crew-bob",
          turn: 1,
          type: "firebreak",
          tileId: buildable.id,
        },
        {
          id: "action-advance",
          actorId: "crew-alice",
          turn: 1,
          type: "advance-turn",
        },
      ];

      expect(reduceSimulation(input, actions)).toEqual(
        reduceSimulation(input, [...actions].reverse()),
      );
    });

    it("deduplicates stable action IDs independently of append order", () => {
      const tile = reduceSimulation(input, []).tiles.find((candidate) =>
        candidate.fire > 0
      )!;
      const water: SimulationAction = {
        id: "stable-action",
        actorId: "crew-alice",
        turn: 1,
        type: "water",
        tileId: tile.id,
      };

      const single = reduceSimulation(input, [water]);
      const duplicate = reduceSimulation(input, [water, { ...water }]);

      expect(duplicate).toEqual(single);
      expect(duplicate.acceptedActionIds).toEqual(["stable-action"]);
    });

    it("applies one crew deployment per actor and accepts concurrent crews", () => {
      const initial = reduceSimulation(input, []);
      const fires = initial.tiles.filter((tile) => tile.fire > 0);
      const actions: SimulationAction[] = [
        {
          id: "alice-first",
          actorId: "crew-alice",
          turn: 1,
          type: "water",
          tileId: fires[0].id,
        },
        {
          id: "alice-second",
          actorId: "crew-alice",
          turn: 1,
          type: "water",
          tileId: fires[1].id,
        },
        {
          id: "bob-water",
          actorId: "crew-bob",
          turn: 1,
          type: "water",
          tileId: fires[1].id,
        },
      ];

      const result = reduceSimulation(input, actions);

      expect(result.acceptedActionIds).toEqual([
        "alice-first",
        "bob-water",
      ]);
      expect(result.rejectedActionIds).toEqual(["alice-second"]);
      expect(result.activeFireCount).toBe(0);
      expect(result.status).toBe("contained");
    });

    it("allows a valid deployment after the same actor submits an invalid one", () => {
      const initial = reduceSimulation(input, []);
      const burning = initial.tiles.find((tile) => tile.fire > 0)!;
      const buildable = initial.tiles.find((tile) =>
        tile.fire === 0 &&
        (tile.terrain === "forest" || tile.terrain === "grass")
      )!;

      const result = reduceSimulation(input, [
        {
          id: "alice-invalid",
          actorId: "crew-alice",
          turn: 1,
          type: "firebreak",
          tileId: burning.id,
        },
        {
          id: "alice-valid",
          actorId: "crew-alice",
          turn: 1,
          type: "firebreak",
          tileId: buildable.id,
        },
      ]);

      expect(result.rejectedActionIds).toContain("alice-invalid");
      expect(result.acceptedActionIds).toContain("alice-valid");
      expect(result.tiles.find((tile) => tile.id === buildable.id)?.firebreak)
        .toBe(true);
    });

    it("does not spread from a wet tile extinguished during the advance", () => {
      const source: TileState = {
        id: "source",
        x: 0,
        y: 0,
        terrain: "forest",
        fire: 1,
        firebreak: false,
        wetUntilTurn: 1,
        residents: 0,
        evacuatedResidents: 0,
        lostResidents: 0,
        burned: false,
      };
      const target: TileState = {
        ...source,
        id: "target",
        x: 1,
        fire: 0,
        wetUntilTurn: 0,
      };

      advanceFire({ ...input, seed: 0 }, 1, [source, target]);

      expect(source.fire).toBe(0);
      expect(target.fire).toBe(0);
    });

    it("normalizes custom dimensions for the simulation and renderer", () => {
      expect(normalizedBoardDimensions({ columns: 100, rows: 2 })).toEqual({
        columns: 12,
        rows: 4,
      });
      expect(reduceSimulation({ ...input, columns: 100, rows: 2 }, []).tiles)
        .toHaveLength(48);
      expect(normalizedMaximumTurns(100)).toBe(50);
      expect(normalizedMaximumTurns(-4)).toBe(1);
    });

    it("describes watering only while its protection is current", () => {
      const tile = reduceSimulation(input, []).tiles[0];
      tile.wetUntilTurn = 2;

      expect(describeTile(tile, 2)).toContain("recently watered");
      expect(describeTile(tile, 3)).not.toContain("recently watered");
    });

    it("describes evacuated, lost, and remaining residents separately", () => {
      const tile = reduceSimulation(input, []).tiles.find((candidate) =>
        candidate.terrain === "settlement"
      )!;
      tile.evacuatedResidents = 2;
      tile.lostResidents = tile.residents - 2;

      expect(describeTile(tile, 1)).toContain("2 residents evacuated");
      expect(describeTile(tile, 1)).toContain(
        `${tile.lostResidents} residents lost`,
      );
      expect(describeTile(tile, 1)).toContain(
        "no residents awaiting evacuation",
      );
    });

    it("distinguishes rejected intents from accepted board actions", () => {
      const result = reduceSimulation(input, []);
      result.acceptedActionIds.push("accepted");
      result.rejectedActionIds.push("rejected");

      expect(actionDisposition(result, "accepted")).toBe("accepted");
      expect(actionDisposition(result, "rejected")).toBe("rejected");
      expect(actionDisposition(result, "unseen")).toBe("pending");
    });

    it("advances a turn once when several crews append advance intents", () => {
      const actions: SimulationAction[] = [
        {
          id: "advance-b",
          actorId: "crew-bob",
          turn: 1,
          type: "advance-turn",
        },
        {
          id: "advance-a",
          actorId: "crew-alice",
          turn: 1,
          type: "advance-turn",
        },
      ];

      const result = reduceSimulation(input, actions);

      expect(result.turn).toBe(2);
      expect(result.acceptedActionIds).toEqual(["advance-a"]);
      expect(result.rejectedActionIds).toEqual(["advance-b"]);
    });

    it("keeps future-turn actions inert until every earlier turn advances", () => {
      const initial = reduceSimulation(input, []);
      const burning = initial.tiles.find((tile) => tile.fire > 0)!;
      const futureWater: SimulationAction = {
        id: "future-water",
        actorId: "crew-alice",
        turn: 2,
        type: "water",
        tileId: burning.id,
      };

      const waiting = reduceSimulation(input, [futureWater]);
      const active = reduceSimulation(input, [
        futureWater,
        {
          id: "advance-turn-one",
          actorId: "crew-bob",
          turn: 1,
          type: "advance-turn",
        },
      ]);

      expect(waiting.acceptedActionIds).not.toContain("future-water");
      expect(active.acceptedActionIds).toContain("future-water");
    });

    it("changes the generated landscape when the input seed changes", () => {
      const first = reduceSimulation(input, []).tiles.map((tile) =>
        tile.terrain
      );
      const second = reduceSimulation({ ...input, seed: input.seed + 1 }, [])
        .tiles.map((tile) => tile.terrain);

      expect(second).not.toEqual(first);
    });
  });
});
