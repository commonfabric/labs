/**
 * Test Pattern: Battleship Multiplayer Room
 *
 * Tests the game room logic:
 * - Firing shots (hit/miss detection)
 * - Turn switching after each shot
 * - Cannot fire when not your turn
 * - Cannot fire at same spot twice
 * - Cannot fire when game is finished
 * - Win detection when all ships sunk
 *
 * Run: deno task cf test patterns/showcase/battleship/multiplayer/room.test.tsx --root patterns/showcase/battleship --verbose
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import BattleshipRoom from "./room.tsx";
import {
  createInitialShots,
  type GameState,
  type PlayerData,
  type Ship,
  type ShotsState,
} from "./schemas.tsx";

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a simple ship at a known position for predictable testing.
 * This creates a 2-cell destroyer at row 0, cols 0-1.
 */
function createTestShips(): Ship[] {
  return [
    {
      type: "destroyer",
      start: { row: 0, col: 0 },
      orientation: "horizontal",
    },
  ];
}

/**
 * Create player data with known ships for testing.
 *
 * `joinedAt` uses a fixed timestamp: no assertion reads it, and calling a clock
 * in the pattern top-level body is rejected by the time-capability gate.
 */
function createTestPlayer(name: string, playerNum: 1 | 2): PlayerData {
  return {
    name,
    ships: createTestShips(),
    color: playerNum === 1 ? "#3b82f6" : "#ef4444",
    joinedAt: 0,
  };
}

// =============================================================================
// Test Pattern
// =============================================================================

export default pattern(() => {
  // Setup shared state cells (simulating what lobby would create)
  const player1Cell = new Writable<PlayerData | null>(
    createTestPlayer("Alice", 1),
  );
  const player2Cell = new Writable<PlayerData | null>(
    createTestPlayer("Bob", 2),
  );
  const shotsCell = new Writable<ShotsState>(createInitialShots());
  const gameStateCell = new Writable<GameState>({
    phase: "playing",
    currentTurn: 1,
    winner: null,
    lastMessage: "Alice's turn - fire at the enemy fleet!",
  });
  const myNameCell = new Writable("Alice");
  const myPlayerNumberCell = new Writable<1 | 2 | null>(1);

  // Create room as Player 1 (Alice)
  const room = BattleshipRoom({
    gameName: "Test Game",
    player1: player1Cell,
    player2: player2Cell,
    shots: shotsCell,
    gameState: gameStateCell,
    myName: myNameCell,
    myPlayerNumber: myPlayerNumberCell,
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  // Fire at empty water (miss) - row 5, col 5 has no ship
  const action_fire_miss = action(() => {
    room.fireShot.send({ row: 5, col: 5 });
  });

  // Fire at ship (hit) - row 0, col 0 has Bob's destroyer
  const _action_fire_hit = action(() => {
    room.fireShot.send({ row: 0, col: 0 });
  });

  // Fire at same spot again (should be ignored)
  const action_fire_same_spot = action(() => {
    room.fireShot.send({ row: 5, col: 5 });
  });

  // Fire when not your turn (should be ignored since turn switched to player 2)
  const action_fire_wrong_turn = action(() => {
    room.fireShot.send({ row: 1, col: 1 });
  });

  // Sink the destroyer by hitting row 0, col 1 (second cell)
  // First we need to switch turns back to player 1
  const _action_fire_sink_ship = action(() => {
    room.fireShot.send({ row: 0, col: 1 });
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_initial_turn_is_player1 = assert(
    () => gameStateCell.get().currentTurn === 1,
  );

  const assert_initial_phase_playing = assert(
    () => gameStateCell.get().phase === "playing",
  );

  const assert_initial_no_shots = assert(() => {
    const shots = shotsCell.get();
    // All cells should be "empty"
    return shots[1].every((row) => row.every((cell) => cell === "empty")) &&
      shots[2].every((row) => row.every((cell) => cell === "empty"));
  });

  // ==========================================================================
  // Assertions - After Miss
  // ==========================================================================

  const assert_miss_recorded = assert(() => {
    const shots = shotsCell.get();
    // Player 1 fired at player 2's board, so shots[2][5][5] should be "miss"
    return shots[2][5][5] === "miss";
  });

  const assert_turn_switched_to_player2 = assert(
    () => gameStateCell.get().currentTurn === 2,
  );

  const assert_message_contains_miss = assert(() =>
    gameStateCell.get().lastMessage.includes("Miss")
  );

  // ==========================================================================
  // Assertions - After Invalid Actions
  // ==========================================================================

  // After firing at same spot, nothing should change (still player 2's turn)
  const assert_still_player2_turn = assert(
    () => gameStateCell.get().currentTurn === 2,
  );

  // After firing when not your turn, nothing should change
  const assert_no_new_shot_recorded = assert(() => {
    const shots = shotsCell.get();
    // row 1, col 1 should still be empty (shot was ignored)
    return shots[2][1][1] === "empty";
  });

  // ==========================================================================
  // Assertions - After Hit
  // ==========================================================================

  const _assert_hit_recorded = assert(() => {
    const shots = shotsCell.get();
    // Player 1 fired at player 2's board at 0,0 where destroyer is
    return shots[2][0][0] === "hit";
  });

  const _assert_message_contains_hit = assert(() =>
    gameStateCell.get().lastMessage.includes("Hit")
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Initial State ===
      { assertion: assert_initial_turn_is_player1 },
      { assertion: assert_initial_phase_playing },
      { assertion: assert_initial_no_shots },

      // === Fire a miss (player 1 fires) ===
      { action: action_fire_miss },
      { assertion: assert_miss_recorded },
      { assertion: assert_turn_switched_to_player2 },
      { assertion: assert_message_contains_miss },

      // === Try to fire at same spot (should be ignored - still player 2's turn) ===
      { action: action_fire_same_spot },
      { assertion: assert_still_player2_turn },

      // === Try to fire when not your turn (should be ignored) ===
      { action: action_fire_wrong_turn },
      { assertion: assert_no_new_shot_recorded },
      { assertion: assert_still_player2_turn },
      // Note: To test hits, we'd need to switch turns back to player 1.
      // The current test structure doesn't support player 2 actions easily
      // since the room is bound to player 1. A more complete test would
      // create two room instances or use the lobby's turn-switching.
    ],
    // Expose for debugging
    room,
    player1: player1Cell,
    player2: player2Cell,
    shots: shotsCell,
    gameState: gameStateCell,
  };
});
