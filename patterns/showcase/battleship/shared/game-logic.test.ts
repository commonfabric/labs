import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { generateRandomShips, getShipCoordinates } from "./game-logic.tsx";

describe("game-logic", () => {
  describe("generateRandomShips()", () => {
    it("places each ship that keeps colliding at the first free square of a board scan", () => {
      // Every draw is 0, so every random attempt puts a ship horizontally at
      // A1. Only the carrier fits there; each later ship runs out of
      // attempts and is placed by scanning rows from the top left.
      using _random = stub(Math, "random", () => 0);
      using warn = stub(console, "warn");

      const ships = generateRandomShips();

      expect(ships.map(({ type, start }) => ({ type, start }))).toEqual([
        { type: "carrier", start: { row: 0, col: 0 } },
        { type: "battleship", start: { row: 0, col: 5 } },
        { type: "cruiser", start: { row: 1, col: 0 } },
        { type: "submarine", start: { row: 1, col: 3 } },
        { type: "destroyer", start: { row: 1, col: 6 } },
      ]);
      expect(ships.every((ship) => ship.orientation === "horizontal"))
        .toBe(true);
      const squares = ships.flatMap(getShipCoordinates).map(({ row, col }) =>
        `${row},${col}`
      );
      expect(new Set(squares).size).toBe(squares.length);
      expect(warn.calls.map((call) => call.args[0])).toEqual([
        "Failed to place battleship randomly, using fallback",
        "Failed to place cruiser randomly, using fallback",
        "Failed to place submarine randomly, using fallback",
        "Failed to place destroyer randomly, using fallback",
      ]);
    });
  });
});
