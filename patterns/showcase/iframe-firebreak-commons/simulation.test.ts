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

/** Returns the first tile of the board before any action that satisfies `test`. */
function initialTile(test: (tile: TileState) => boolean): TileState {
  const tile = reduceSimulation(input, []).tiles.find(test);
  if (!tile) throw new Error("The board has no such tile.");
  return tile;
}

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

    it("describes a thrown value that is not an error", () => {
      const reported: RendererFailureAlarm[] = [];

      reportRendererFailure("WebGL lost", (alarm) => reported.push(alarm));

      expect(reported[0].description).toBe("WebGL lost");
      expect(reported[0].stacktrace).toContain("WebGL lost");
    });

    it("reports the message as the trace of an error without a stack", () => {
      const reported: RendererFailureAlarm[] = [];
      const failure = new Error("WebGL unavailable");
      failure.stack = undefined;

      reportRendererFailure(failure, (alarm) => reported.push(alarm));

      expect(reported[0].stacktrace).toBe("WebGL unavailable");
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

    it("spreads only to neighbors that are dry, unburned, and unprotected", () => {
      const tile = (id: string, x: number, y: number): TileState => ({
        id,
        x,
        y,
        terrain: "forest",
        fire: 0,
        firebreak: false,
        wetUntilTurn: 0,
        residents: 0,
        evacuatedResidents: 0,
        lostResidents: 0,
        burned: false,
      });
      const source: TileState = { ...tile("source", 1, 1), fire: 2 };
      const lake: TileState = { ...tile("lake", 0, 1), terrain: "water" };
      const firebreak: TileState = {
        ...tile("firebreak", 1, 0),
        firebreak: true,
      };
      const wet: TileState = { ...tile("wet", 1, 2), wetUntilTurn: 1 };
      const open = tile("open", 2, 1);

      advanceFire(input, 1, [source, lake, firebreak, wet, open]);

      expect(source.fire).toBe(3);
      expect(source.burned).toBe(true);
      expect(open.fire).toBe(1);
      expect(lake.fire).toBe(0);
      expect(firebreak.fire).toBe(0);
      expect(wet.fire).toBe(0);
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

    it("uses the smallest board and turn limit for a size that is not finite", () => {
      expect(normalizedBoardDimensions({ columns: NaN, rows: Infinity }))
        .toEqual({ columns: 5, rows: 4 });
      expect(normalizedMaximumTurns(NaN)).toBe(1);
    });

    it("mixes every terrain into the board, varying down each column", () => {
      const { tiles } = reduceSimulation(DEFAULT_INPUT, []);

      expect(new Set(tiles.map((tile) => tile.terrain))).toEqual(
        new Set(["water", "grass", "forest", "settlement"]),
      );
      for (let x = 0; x < DEFAULT_INPUT.columns; x++) {
        const column = tiles.filter((tile) => tile.x === x);
        expect(new Set(column.map((tile) => tile.terrain)).size)
          .toBeGreaterThan(1);
      }
    });

    it("rejects a deployment to a tile that is not on the board", () => {
      const result = reduceSimulation(input, [{
        id: "off-board",
        actorId: "crew-alice",
        turn: 1,
        type: "water",
        tileId: "tile-99-99",
      }]);

      expect(result.rejectedActionIds).toEqual(["off-board"]);
    });

    it("rejects water on a tile that is not burning", () => {
      const dry = initialTile((tile) =>
        tile.fire === 0 && tile.terrain !== "water"
      );
      const lake = initialTile((tile) => tile.terrain === "water");

      const result = reduceSimulation(input, [
        {
          id: "dry",
          actorId: "crew-alice",
          turn: 1,
          type: "water",
          tileId: dry.id,
        },
        {
          id: "lake",
          actorId: "crew-bob",
          turn: 1,
          type: "water",
          tileId: lake.id,
        },
      ]);

      expect(result.acceptedActionIds).toEqual([]);
      expect(result.rejectedActionIds).toEqual(["dry", "lake"]);
      expect(result.tiles.find((tile) => tile.id === dry.id)?.wetUntilTurn)
        .toBe(0);
    });

    it("evacuates a settlement's residents once, and only a settlement", () => {
      const settlement = initialTile((tile) => tile.terrain === "settlement");
      const forest = initialTile((tile) => tile.terrain === "forest");
      const evacuate = (
        id: string,
        actorId: string,
        tileId: string,
      ): SimulationAction => ({
        id,
        actorId,
        turn: 1,
        type: "evacuate",
        tileId,
      });

      const result = reduceSimulation(input, [
        evacuate("a-first", "crew-alice", settlement.id),
        evacuate("b-again", "crew-bob", settlement.id),
        evacuate("c-forest", "crew-carol", forest.id),
      ]);

      expect(result.acceptedActionIds).toEqual(["a-first"]);
      expect(result.rejectedActionIds).toEqual(["b-again", "c-forest"]);
      expect(result.evacuatedResidentCount).toBe(settlement.residents);
    });

    it("stops the drill at the advance that leaves nothing burning", () => {
      const fires = reduceSimulation(input, []).tiles.filter((tile) =>
        tile.fire > 0
      );
      const actions: SimulationAction[] = [
        ...fires.map((tile, index): SimulationAction => ({
          id: `water-${index}`,
          actorId: `crew-${index}`,
          turn: 1,
          type: "water",
          tileId: tile.id,
        })),
        { id: "advance-1", actorId: "crew-0", turn: 1, type: "advance-turn" },
        { id: "advance-2", actorId: "crew-0", turn: 2, type: "advance-turn" },
      ];

      const result = reduceSimulation(input, actions);

      expect(result.turn).toBe(2);
      expect(result.status).toBe("contained");
      expect(result.acceptedActionIds).toContain("advance-1");
      expect(result.rejectedActionIds).toEqual(["advance-2"]);
    });

    it("describes watering only while its protection is current", () => {
      const tile = reduceSimulation(input, []).tiles[0];
      tile.wetUntilTurn = 2;

      expect(describeTile(tile, 2)).toContain("recently watered");
      expect(describeTile(tile, 3)).not.toContain("recently watered");
    });

    it("describes a fire's intensity and a firebreak's protection", () => {
      const tile = initialTile((candidate) => candidate.fire > 0);

      expect(describeTile(tile, 1)).toContain("fire intensity 2");
      expect(describeTile(tile, 1)).not.toContain("firebreak protected");

      tile.fire = 0;
      tile.firebreak = true;

      expect(describeTile(tile, 1)).toContain("firebreak protected");
      expect(describeTile(tile, 1)).not.toContain("fire intensity");
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
