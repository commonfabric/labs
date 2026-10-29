/**
 * Battleship Pass-and-Play - Schemas
 *
 * Re-exports shared types and constants from the battleship shared infrastructure,
 * plus pass-and-play specific type definitions and helpers.
 */

// ============ RE-EXPORT SHARED TYPES ============
export type {
  Coordinate,
  Ship,
  ShipType,
  SquareState,
} from "../shared/index.tsx";

// ============ RE-EXPORT SHARED CONSTANTS ============
export {
  BOARD_SIZE,
  COLS,
  GRID_INDICES,
  ROWS,
  SHIP_NAMES,
  SHIP_SIZES,
} from "../shared/index.tsx";

// ============ RE-EXPORT SHARED GAME LOGIC ============
export {
  areAllShipsSunk,
  buildShipPositions,
  createEmptyGrid,
  findShipAt,
  getShipCoordinates,
  isShipSunk,
} from "../shared/index.tsx";

// ============ PASS-AND-PLAY SPECIFIC TYPES ============

import type { Ship, SquareState } from "../shared/index.tsx";
import { createEmptyGrid } from "../shared/index.tsx";

export interface PlayerBoard {
  ships: Ship[];
  shots: SquareState[][]; // 10x10 grid - shots RECEIVED from opponent
}

export interface GameState {
  phase: "playing" | "finished";
  currentTurn: 1 | 2;
  player1: PlayerBoard;
  player2: PlayerBoard;
  winner: 1 | 2 | null;
  lastMessage: string;
  viewingAs: 1 | 2 | null; // null = full transition screen (ready to reveal)
  awaitingPass: boolean; // true = show result + pass button, board locked
}

// ============ PASS-AND-PLAY SPECIFIC HELPERS ============

// Default ship placements for testing
export function createDefaultShips1(): Ship[] {
  return [
    { type: "carrier", start: { row: 0, col: 0 }, orientation: "horizontal" },
    {
      type: "battleship",
      start: { row: 2, col: 1 },
      orientation: "horizontal",
    },
    { type: "cruiser", start: { row: 4, col: 3 }, orientation: "vertical" },
    { type: "submarine", start: { row: 5, col: 7 }, orientation: "horizontal" },
    { type: "destroyer", start: { row: 8, col: 5 }, orientation: "vertical" },
  ];
}

export function createDefaultShips2(): Ship[] {
  return [
    { type: "carrier", start: { row: 1, col: 2 }, orientation: "vertical" },
    {
      type: "battleship",
      start: { row: 0, col: 6 },
      orientation: "horizontal",
    },
    { type: "cruiser", start: { row: 6, col: 0 }, orientation: "horizontal" },
    { type: "submarine", start: { row: 7, col: 4 }, orientation: "vertical" },
    { type: "destroyer", start: { row: 9, col: 8 }, orientation: "horizontal" },
  ];
}

export function createInitialState(): GameState {
  return {
    phase: "playing",
    currentTurn: 1,
    player1: {
      ships: createDefaultShips1(),
      shots: createEmptyGrid(),
    },
    player2: {
      ships: createDefaultShips2(),
      shots: createEmptyGrid(),
    },
    winner: null,
    lastMessage: "Player 1's turn",
    viewingAs: null, // Start with transition screen
    awaitingPass: false,
  };
}
