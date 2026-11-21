/**
 * Fixtures and view readers the room's pattern tests share. Each test file
 * reads the room's view only a few times: every read rebuilds both boards,
 * which costs seconds.
 */

import {
  styleOf,
  textContent,
} from "../../../tools/test-support/vnode-helpers.ts";
import type { BoardView } from "../shared/board-view.ts";
import type { PlayerData, Ship, SquareState } from "./schemas.tsx";
import { createEmptyGrid } from "./schemas.tsx";

/** A single destroyer on row 0, columns 0 and 1 (A1 and B1). */
export function createTestShips(): Ship[] {
  return [
    { type: "destroyer", start: { row: 0, col: 0 }, orientation: "horizontal" },
  ];
}

/**
 * Player data with known ships. `joinedAt` is fixed: no assertion reads it,
 * and calling a clock in the pattern body is rejected by the time-capability
 * gate.
 */
export function createTestPlayer(
  name: string,
  playerNum: 1 | 2,
  ships = createTestShips(),
): PlayerData {
  return {
    name,
    ships,
    color: playerNum === 1 ? "#3b82f6" : "#ef4444",
    joinedAt: 0,
  };
}

/** A board's shots received, with `marks` written over open water. */
export const shotsWith = (
  marks: readonly [row: number, col: number, state: SquareState][],
): SquareState[][] => {
  const grid = createEmptyGrid();
  for (const [row, col, state] of marks) grid[row][col] = state;
  return grid;
};

/** The text of the first node outside the boards whose `style` sets `key`
 * to `value`. */
const textWhere = (view: BoardView, key: string, value: string): string =>
  textContent(view.nodes.find((node) => styleOf(node, key) === value)).trim();

/** The status bar's message: the 18px line under the header. */
export const status = (view: BoardView): string =>
  textWhere(view, "fontSize", "18px");

/** The initials in the header's badge for the viewer. */
export const headerInitials = (view: BoardView): string =>
  textWhere(view, "width", "24px");

/** The display of the "YOUR TURN" indicator, which stays in the tree. */
export const turnIndicator = (view: BoardView): unknown =>
  styleOf(
    view.nodes.find((node) => styleOf(node, "marginBottom") === "12px"),
    "display",
  );

/** The text of each player card, in order (initials, name, and status), as
 * JSON. */
export const playerCards = (view: BoardView): string =>
  JSON.stringify(
    view.nodes.filter((node) => styleOf(node, "padding") === "8px 16px")
      .map((node) => textContent(node).trim()),
  );
