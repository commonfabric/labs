/**
 * Battleship Shared Types
 *
 * Core type definitions used by both pass-and-play and multiplayer
 * battleship patterns.
 */

// ============ CORE GAME TYPES ============

export type Coordinate = { row: number; col: number };

export type ShipType =
  | "carrier"
  | "battleship"
  | "cruiser"
  | "submarine"
  | "destroyer";

export interface Ship {
  type: ShipType;
  start: Coordinate;
  orientation: "horizontal" | "vertical";
}

export type SquareState = "empty" | "miss" | "hit";
