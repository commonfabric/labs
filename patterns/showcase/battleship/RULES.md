# Battleship Game Rules

## Board

- 10x10 grid
- Columns: A-J
- Rows: 1-10

## Ships

| Ship       | Size |
| ---------- | ---- |
| Carrier    | 5    |
| Battleship | 4    |
| Cruiser    | 3    |
| Submarine  | 3    |
| Destroyer  | 2    |

**Total:** 5 ships, 17 squares

## Setup Phase

- Each player places all 5 ships on their grid
- Ships can be placed horizontally or vertically (no diagonal)
- Ships cannot overlap
- Ships cannot extend beyond the board edges

## Gameplay

1. Players alternate turns
2. On your turn, call a shot by selecting a cell on the opponent's grid (e.g.,
   "B-7")
3. Opponent announces result:
   - **Hit** - Shot landed on a ship
   - **Miss** - Shot landed in empty water
4. When all squares of a ship are hit: **"You sunk my [ship name]!"**
5. First player to sink all 5 of opponent's ships wins

## Implementation Phases

### Phase 1: Single-Player Debug Mode

- Both players' boards fully visible (ships + all shots)
- Single player takes turns for both sides
- Useful for testing game mechanics

### Phase 2: Two-Player Mode

- Each player sees:
  - **Own board:** All their ships + where opponent has fired (hits and misses)
  - **Enemy board:** Only their own shots (hits and misses), ship positions
    hidden until hit
- Designed for two browser windows (regular + incognito)
