/**
 * Battleship Shared Constants
 *
 * All constants used by both pass-and-play and multiplayer
 * battleship patterns.
 */

import type { ShipType } from "./types.tsx";

export const BOARD_SIZE = 10;

export const SHIP_SIZES: Record<ShipType, number> = {
  carrier: 5,
  battleship: 4,
  cruiser: 3,
  submarine: 3,
  destroyer: 2,
};

export const SHIP_NAMES: Record<ShipType, string> = {
  carrier: "Carrier",
  battleship: "Battleship",
  cruiser: "Cruiser",
  submarine: "Submarine",
  destroyer: "Destroyer",
};

export const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
export const ROWS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
export const GRID_INDICES = ROWS.flatMap((r) =>
  ROWS.map((c) => ({ row: r, col: c }))
);

export const PLAYER_COLORS = ["#3b82f6", "#ef4444"]; // Blue, Red
