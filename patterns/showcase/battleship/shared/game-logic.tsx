/**
 * Battleship Shared Game Logic
 *
 * Pure game logic functions used by both pass-and-play and multiplayer
 * battleship patterns.
 */

import type { Coordinate, Ship, ShipType, SquareState } from "./types.tsx";
import { BOARD_SIZE, PLAYER_COLORS, SHIP_SIZES } from "./constants.tsx";

// ============ GRID HELPERS ============

export function createEmptyGrid(): SquareState[][] {
  return Array.from(
    { length: BOARD_SIZE },
    () => Array.from({ length: BOARD_SIZE }, () => "empty" as SquareState),
  );
}

// ============ SHIP COORDINATE HELPERS ============

export function getShipCoordinates(ship: Ship): Coordinate[] {
  const size = SHIP_SIZES[ship.type];
  const coords: Coordinate[] = [];
  for (let i = 0; i < size; i++) {
    if (ship.orientation === "horizontal") {
      coords.push({ row: ship.start.row, col: ship.start.col + i });
    } else {
      coords.push({ row: ship.start.row + i, col: ship.start.col });
    }
  }
  return coords;
}

export function findShipAt(ships: Ship[], coord: Coordinate): Ship | null {
  for (const ship of ships) {
    const shipCoords = getShipCoordinates(ship);
    if (shipCoords.some((c) => c.row === coord.row && c.col === coord.col)) {
      return ship;
    }
  }
  return null;
}

export function buildShipPositions(ships: Ship[]): Record<string, ShipType> {
  const positions: Record<string, ShipType> = {};
  for (const ship of ships) {
    const coords = getShipCoordinates(ship);
    for (const c of coords) {
      positions[`${c.row},${c.col}`] = ship.type;
    }
  }
  return positions;
}

// ============ GAME STATE HELPERS ============

export function isShipSunk(ship: Ship, shots: SquareState[][]): boolean {
  const coords = getShipCoordinates(ship);
  return coords.every((c) => shots[c.row]?.[c.col] === "hit");
}

export function areAllShipsSunk(
  ships: Ship[],
  shots: SquareState[][],
): boolean {
  return ships.every((ship) => isShipSunk(ship, shots));
}

// ============ SHIP PLACEMENT ============

function canPlaceShip(ship: Ship, occupiedPositions: Set<string>): boolean {
  const coords = getShipCoordinates(ship);
  for (const c of coords) {
    if (c.row < 0 || c.row >= BOARD_SIZE || c.col < 0 || c.col >= BOARD_SIZE) {
      return false;
    }
    if (occupiedPositions.has(`${c.row},${c.col}`)) {
      return false;
    }
  }
  return true;
}

export function generateRandomShips(): Ship[] {
  const ships: Ship[] = [];
  const occupiedPositions = new Set<string>();
  const shipTypes: ShipType[] = [
    "carrier",
    "battleship",
    "cruiser",
    "submarine",
    "destroyer",
  ];

  for (const type of shipTypes) {
    let placed = false;
    let attempts = 0;
    const maxAttempts = 100;

    while (!placed && attempts < maxAttempts) {
      attempts++;
      const orientation: "horizontal" | "vertical" = Math.random() < 0.5
        ? "horizontal"
        : "vertical";
      const size = SHIP_SIZES[type];

      const maxRow = orientation === "vertical"
        ? BOARD_SIZE - size
        : BOARD_SIZE - 1;
      const maxCol = orientation === "horizontal"
        ? BOARD_SIZE - size
        : BOARD_SIZE - 1;

      const row = Math.floor(Math.random() * (maxRow + 1));
      const col = Math.floor(Math.random() * (maxCol + 1));

      const ship: Ship = { type, start: { row, col }, orientation };

      if (canPlaceShip(ship, occupiedPositions)) {
        ships.push(ship);
        const coords = getShipCoordinates(ship);
        for (const c of coords) {
          occupiedPositions.add(`${c.row},${c.col}`);
        }
        placed = true;
      }
    }

    if (!placed) {
      // Fallback: use deterministic placement by scanning the board
      console.warn(`Failed to place ${type} randomly, using fallback`);
      const size = SHIP_SIZES[type];

      // Try horizontal placement first, then vertical
      for (const orientation of ["horizontal", "vertical"] as const) {
        if (placed) break;
        const maxRow = orientation === "vertical"
          ? BOARD_SIZE - size
          : BOARD_SIZE - 1;
        const maxCol = orientation === "horizontal"
          ? BOARD_SIZE - size
          : BOARD_SIZE - 1;

        for (let row = 0; row <= maxRow && !placed; row++) {
          for (let col = 0; col <= maxCol && !placed; col++) {
            const ship: Ship = { type, start: { row, col }, orientation };
            if (canPlaceShip(ship, occupiedPositions)) {
              ships.push(ship);
              const coords = getShipCoordinates(ship);
              for (const c of coords) {
                occupiedPositions.add(`${c.row},${c.col}`);
              }
              placed = true;
            }
          }
        }
      }

      if (!placed) {
        console.error(
          `Could not place ${type} even with fallback - board may be too crowded`,
        );
      }
    }
  }

  return ships;
}

// ============ UI HELPERS ============

export function getRandomColor(index: number): string {
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

export function getInitials(name: string): string {
  if (!name || typeof name !== "string") return "?";
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
