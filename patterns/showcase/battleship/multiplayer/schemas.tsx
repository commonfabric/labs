/**
 * Battleship Multiplayer - Schemas
 *
 * Re-exports shared types and constants from the battleship shared infrastructure,
 * plus multiplayer-specific type definitions for proper typed Cells.
 *
 * This eliminates the JSON serialization hacks (player1Json, shotsJson, etc.)
 * in favor of properly typed Cell values.
 */

import {
  Default,
  type FabricBytes,
  NAME,
  type PerSession,
  type PerSpace,
  type PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

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
  PLAYER_COLORS,
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
  generateRandomShips,
  getInitials,
  getRandomColor,
  getShipCoordinates,
  isShipSunk,
} from "../shared/index.tsx";

// ============ MULTIPLAYER-SPECIFIC TYPES ============

import type { Ship, SquareState } from "../shared/index.tsx";
import { createEmptyGrid } from "../shared/index.tsx";

// ============ PLAYER DATA ============

export interface PlayerData {
  name: string;

  /** Picture bytes, snapshotted from the joiner's shared profile. */
  picture?: FabricBytes;

  /** Avatar text, snapshotted instead when the joiner's profile has no
   * picture. */
  avatar?: string;
  ships: Ship[];
  color: string;
  joinedAt: number;
}

// ============ GAME STATE ============

export interface GameState {
  phase: "waiting" | "playing" | "finished";
  currentTurn: 1 | 2;
  winner: 1 | 2 | null;
  lastMessage: string;
}

// ============ SHOTS STATE ============

/**
 * Shots received by each player, indexed by player number.
 * - Key 1: shots that player 1 has received (fired by player 2)
 * - Key 2: shots that player 2 has received (fired by player 1)
 */
export interface ShotsState {
  1: SquareState[][];
  2: SquareState[][];
}

export type PlayerCell = Writable<PlayerData | null | Default<null>>;
export type ShotsCell = Writable<ShotsState | Default<typeof INITIAL_SHOTS>>;
export type GameStateCell = Writable<
  GameState | Default<typeof INITIAL_GAME_STATE>
>;
export type PlayerNameCell = Writable<string | Default<"">>;
export type PlayerNumberCell = Writable<1 | 2 | null | Default<null>>;

// ============ DEFAULT VALUES ============

export const INITIAL_GAME_STATE: GameState = {
  phase: "waiting",
  currentTurn: 1,
  winner: null,
  lastMessage: "Waiting for players...",
};

export function createInitialShots(): ShotsState {
  return {
    1: createEmptyGrid(),
    2: createEmptyGrid(),
  };
}

export const INITIAL_SHOTS = createInitialShots();

export function normalizePlayerNumber(
  value: 1 | 2 | null | undefined,
): 1 | 2 | null {
  return value === 1 || value === 2 ? value : null;
}

export function trimmedName(value: string | undefined): string {
  return (value ?? "").trim();
}

// ============ PATTERN INPUT/OUTPUT TYPES ============

/**
 * Shared match state is per-space; viewer identity is scoped per user. The
 * join name/picture come from the viewer's shared profile (resolved via
 * `wish({ query: "#profile" })` in the lobby), so there is no join-form text.
 */
export interface LobbyState {
  gameName?: PerSpace<string | Default<"Battleship">>;
  player1?: PerSpace<PlayerCell>;
  player2?: PerSpace<PlayerCell>;
  shots?: PerSpace<ShotsCell>;
  gameState?: PerSpace<GameStateCell>;
  myName?: PerUser<PlayerNameCell>;
  myPlayerNumber?: PerUser<PlayerNumberCell>;
}

/**
 * Room pattern receives shared cells plus per-user player identity.
 */
export interface RoomInput {
  gameName: string;
  player1: PlayerCell;
  player2: PlayerCell;
  shots: ShotsCell;
  gameState: GameStateCell;
  myName: PlayerNameCell;
  myPlayerNumber: PlayerNumberCell;
}

/**
 * Room pattern output exposes player identity and actions for testing.
 */
export interface RoomOutput {
  [NAME]: string;
  [UI]: PerSession<VNode>;
  myName: string;
  myPlayerNumber: 1 | 2 | null;

  /** Fire a shot at the enemy board - exported for testing */
  fireShot: Stream<{ row: number; col: number }>;
}
