/** Exercises Battleship placement, shot tracking, and player display helpers. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  areAllShipsSunk,
  buildShipPositions,
  createEmptyGrid,
  findShipAt,
  generateRandomShips,
  getInitials,
  getRandomColor,
  getShipCoordinates,
  isShipSunk,
} from "../../battleship/shared/game-logic.tsx";
import type { Ship } from "../../battleship/shared/types.tsx";

// Every placement draws orientation, row, and column. The second candidate
// repeats the carrier's start; the remaining candidates occupy separate rows.
const placements = [
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0.1,
  0,
  0,
  0.2,
  0,
  0,
  0.3,
  0,
  0,
  0.4,
  0,
];

describe("game-logic", () => {
  it("tracks occupied squares and requires every ship square to be hit", () => {
    const ships: Ship[] = [{
      type: "destroyer",
      start: { row: 1, col: 2 },
      orientation: "horizontal",
    }, {
      type: "submarine",
      start: { row: 3, col: 4 },
      orientation: "vertical",
    }];
    const shots = createEmptyGrid();
    expect(shots).toHaveLength(10);
    expect(shots.every((row) => row.length === 10)).toBe(true);
    expect(shots.flat().every((square) => square === "empty")).toBe(true);
    expect(buildShipPositions(ships)).toEqual({
      "1,2": "destroyer",
      "1,3": "destroyer",
      "3,4": "submarine",
      "4,4": "submarine",
      "5,4": "submarine",
    });
    expect(findShipAt(ships, { row: 1, col: 3 })).toBe(ships[0]);
    expect(findShipAt(ships, { row: 5, col: 4 })).toBe(ships[1]);
    expect(findShipAt(ships, { row: 0, col: 0 })).toBeNull();
    expect(isShipSunk(ships[0], shots)).toBe(false);
    shots[1][2] = "hit";
    expect(shots[0][2]).toBe("empty");
    expect(isShipSunk(ships[0], shots)).toBe(false);
    shots[1][3] = "hit";
    expect(isShipSunk(ships[0], shots)).toBe(true);
    expect(areAllShipsSunk(ships, shots)).toBe(false);
    for (const { row, col } of getShipCoordinates(ships[1])) {
      shots[row][col] = "hit";
    }
    expect(areAllShipsSunk(ships, shots)).toBe(true);
  });

  it("cycles player colors and abbreviates trimmed names", () => {
    expect(getRandomColor(0)).toBe("#3b82f6");
    expect(getRandomColor(1)).toBe("#ef4444");
    expect(getRandomColor(2)).toBe(getRandomColor(0));
    expect(getInitials("  ada   lovelace byron ")).toBe("AL");
    expect(getInitials("Grace")).toBe("G");
    expect(getInitials("")).toBe("?");
    expect(getInitials("   ")).toBe("?");
  });

  it("rejects an overlapping random placement before placing the next ship", () => {
    let draw = 0;
    using random = stub(Math, "random", () => {
      const value = placements[draw++];
      if (value === undefined) throw new Error("Unexpected placement draw");
      return value;
    });
    const ships = generateRandomShips();
    expect(
      ships.map(({ type, start, orientation }) => ({
        type,
        start,
        orientation,
      })),
    )
      .toEqual([
        {
          type: "carrier",
          start: { row: 0, col: 0 },
          orientation: "horizontal",
        },
        {
          type: "battleship",
          start: { row: 1, col: 0 },
          orientation: "horizontal",
        },
        {
          type: "cruiser",
          start: { row: 2, col: 0 },
          orientation: "horizontal",
        },
        {
          type: "submarine",
          start: { row: 3, col: 0 },
          orientation: "horizontal",
        },
        {
          type: "destroyer",
          start: { row: 4, col: 0 },
          orientation: "horizontal",
        },
      ]);
    const coordinates = ships.flatMap(getShipCoordinates).map(({ row, col }) =>
      `${row},${col}`
    );
    expect(new Set(coordinates).size).toBe(coordinates.length);
    expect(random.calls).toHaveLength(placements.length);
  });
});
