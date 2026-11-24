# Battleship Design

## Data Model

### Core Types

```typescript
type Coordinate = { row: number; col: number }; // 0-9 for both

type ShipType =
  | "carrier"
  | "battleship"
  | "cruiser"
  | "submarine"
  | "destroyer";

interface Ship {
  type: ShipType;
  start: Coordinate;
  orientation: "horizontal" | "vertical";
  hits: boolean[]; // Length matches ship size, tracks which segments are hit
}

type SquareState = "empty" | "miss" | "hit";

interface PlayerBoard {
  ships: Ship[];
  incomingShots: SquareState[][]; // 10x10 grid of shots received from opponent
}

interface GameState {
  phase: "setup-p1" | "setup-p2" | "playing" | "finished";
  currentTurn: 1 | 2;
  player1: PlayerBoard;
  player2: PlayerBoard;
  winner: 1 | 2 | null;
}
```

### Ship Sizes

```typescript
const SHIP_SIZES: Record<ShipType, number> = {
  carrier: 5,
  battleship: 4,
  cruiser: 3,
  submarine: 3,
  destroyer: 2,
};
```

## UI Structure

### Phase 1: Debug Mode (Single-Player)

```
+------------------------------------------+
|            BATTLESHIP (Debug)            |
+------------------------------------------+
| Player 1's Turn                          |
+------------------------------------------+
|   PLAYER 1 BOARD    |   PLAYER 2 BOARD   |
|   (ships visible)   |   (ships visible)  |
|   [10x10 grid]      |   [10x10 grid]     |
|                     |                    |
| Click to fire here  | Click to fire here |
+------------------------------------------+
| Status: "Hit! You sunk the Destroyer!"   |
+------------------------------------------+
```

- Both boards show all ships
- Current player clicks on opponent's board to fire
- All hits/misses visible on both boards

### Phase 2: Two-Player Mode (Future)

Each player sees:

- **Left panel:** Their own board with ships + incoming shots
- **Right panel:** Enemy board with only their outgoing shots (hits/misses)

## Component Breakdown

### Main Pattern: `battleship.tsx`

- Manages game state
- Renders current phase UI
- Handles turn switching

### Sub-components (may be inline initially):

1. **Grid** - 10x10 clickable grid
2. **Square** - Single square showing state (water/ship/hit/miss)
3. **ShipPlacer** - Setup phase UI for placing ships
4. **StatusBar** - Current turn, messages, win state

## Handlers

### `fireShot`

```typescript
// Input: target coordinate, current game state
// Effect: Update opponent's board, check for hit/sink/win
// Switch turn
```

### `placeShip` (setup phase)

```typescript
// Input: ship type, start coordinate, orientation
// Validation: No overlap, within bounds
// Effect: Add ship to player's board
```

### `resetGame`

```typescript
// Reset all state to initial
```

## Computed Values

- `isGameOver`: Check if all ships of a player are sunk
- `getWinner`: Return winner if game over
- `shipsRemaining(player)`: Count of unsunk ships
- `getShipAt(board, coord)`: Find ship occupying a coordinate

## Implementation Order

1. **Static grid rendering** - Just display a 10x10 grid
2. **Ship placement logic** - Hard-code ships for testing
3. **Click-to-fire** - Basic shot mechanics
4. **Hit/miss/sink detection** - Game logic
5. **Turn switching** - Alternate players
6. **Win detection** - End game when all ships sunk
7. **Setup phase** - Let players place ships
8. **Two-player views** - Hide opponent info
