/**
 * Test Pattern: Battleship Pass-and-Play
 *
 * Tests the core game mechanics of the pass-and-play Battleship game:
 * - Initial state and transition flow
 * - Player ready transitions
 * - Firing shots (hits and misses)
 * - Turn switching
 * - Pass device flow
 * - Ship sinking detection
 * - Win condition
 * - Game reset
 *
 * Ship Positions (from createDefaultShips1 and createDefaultShips2):
 *
 * Player 1's ships (Player 2 targets these):
 * - Carrier (5): row 0, cols 0-4 (horizontal)
 * - Battleship (4): row 2, cols 1-4 (horizontal)
 * - Cruiser (3): rows 4-6, col 3 (vertical)
 * - Submarine (3): row 5, cols 7-9 (horizontal)
 * - Destroyer (2): rows 8-9, col 5 (vertical)
 *
 * Player 2's ships (Player 1 targets these):
 * - Carrier (5): rows 1-5, col 2 (vertical)
 * - Battleship (4): row 0, cols 6-9 (horizontal)
 * - Cruiser (3): row 3, cols 0-2 (horizontal)
 * - Submarine (3): rows 7-9, col 4 (vertical)
 * - Destroyer (2): row 9, cols 8-9 (horizontal)
 *
 * Run: deno task cf test patterns/showcase/battleship/pass-and-play/main.test.tsx --verbose
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import Battleship, { type SquareState } from "./main.tsx";

export default pattern(() => {
  // Instantiate the battleship pattern
  const game = Battleship({});

  // ==========================================================================
  // Actions using the exported handlers via closure (action() approach)
  // ==========================================================================

  // Player ready action - transitions from transition screen to game view
  const action_player_ready = action(() => {
    game.playerReady.send();
  });

  // Pass device action
  const action_pass_device = action(() => {
    game.passDevice.send();
  });

  // Reset game action
  const action_reset_game = action(() => {
    game.resetGame.send();
  });

  // Fire at a miss location (row 9, col 0 - empty for Player 2's board)
  const action_fire_miss = action(() => {
    game.fireShot.send({ row: 9, col: 0 });
  });

  // Player 2 fires at Player 1's carrier (row 0, col 0)
  const action_p2_fire_hit_carrier = action(() => {
    game.fireShot.send({ row: 0, col: 0 });
  });

  // ==========================================================================
  // Assertions - access game state properties directly through OpaqueCell proxy
  // ==========================================================================

  // Initial state assertions
  const assert_initial_phase_playing = assert(
    () => game.game.get().phase === "playing",
  );
  const assert_initial_turn_player1 = assert(
    () => game.game.get().currentTurn === 1,
  );
  const assert_initial_viewingAs_null = assert(
    () => game.game.get().viewingAs === null,
  );
  const assert_initial_winner_null = assert(
    () => game.game.get().winner === null,
  );
  const assert_initial_not_awaiting_pass = assert(
    () => game.game.get().awaitingPass === false,
  );

  // After playerReady - Player 1 is now viewing
  const assert_viewingAs_player1 = assert(
    () => game.game.get().viewingAs === 1,
  );
  const assert_still_turn_player1 = assert(
    () => game.game.get().currentTurn === 1,
  );

  // After firing a miss
  const assert_shot_recorded_miss = assert(() => {
    return game.game.get().player2.shots[9][0] === "miss";
  });
  const assert_turn_switched_to_player2 = assert(
    () => game.game.get().currentTurn === 2,
  );
  const assert_awaiting_pass_after_shot = assert(
    () => game.game.get().awaitingPass === true,
  );

  // After passDevice
  const assert_viewingAs_null_after_pass = assert(
    () => game.game.get().viewingAs === null,
  );
  const assert_not_awaiting_pass_after_pass = assert(
    () => game.game.get().awaitingPass === false,
  );

  // After player 2 ready
  const assert_viewingAs_player2 = assert(
    () => game.game.get().viewingAs === 2,
  );

  // After player 2 fires a hit
  const assert_shot_recorded_hit = assert(() => {
    // Player 2 fires at Player 1's carrier at row 0, col 0
    return game.game.get().player1.shots[0][0] === "hit";
  });
  const assert_turn_back_to_player1 = assert(
    () => game.game.get().currentTurn === 1,
  );

  // After reset
  const assert_reset_phase_playing = assert(
    () => game.game.get().phase === "playing",
  );
  const assert_reset_turn_player1 = assert(
    () => game.game.get().currentTurn === 1,
  );
  const assert_reset_viewingAs_null = assert(
    () => game.game.get().viewingAs === null,
  );
  const assert_reset_shots_cleared = assert(() => {
    // All shots should be empty after reset
    const p1Clear = game.game.get().player1.shots.every((row: SquareState[]) =>
      row.every((cell: SquareState) => cell === "empty")
    );
    const p2Clear = game.game.get().player2.shots.every((row: SquareState[]) =>
      row.every((cell: SquareState) => cell === "empty")
    );
    return p1Clear && p2Clear;
  });

  // ==========================================================================
  // Test Sequence - array of { assertion } or { action } objects
  // ==========================================================================
  return {
    [TESTS]: [
      // === Test 1: Initial state ===
      { assertion: assert_initial_phase_playing },
      { assertion: assert_initial_turn_player1 },
      { assertion: assert_initial_viewingAs_null },
      { assertion: assert_initial_winner_null },
      { assertion: assert_initial_not_awaiting_pass },
      // === Test 2: Player 1 ready ===
      { action: action_player_ready },
      { assertion: assert_viewingAs_player1 },
      { assertion: assert_still_turn_player1 },
      // === Test 3: Player 1 fires a miss ===
      { action: action_fire_miss },
      { assertion: assert_shot_recorded_miss },
      { assertion: assert_turn_switched_to_player2 },
      { assertion: assert_awaiting_pass_after_shot },
      // === Test 4: Pass device ===
      { action: action_pass_device },
      { assertion: assert_viewingAs_null_after_pass },
      { assertion: assert_not_awaiting_pass_after_pass },
      // === Test 5: Player 2 ready ===
      { action: action_player_ready },
      { assertion: assert_viewingAs_player2 },
      // === Test 6: Player 2 fires a hit ===
      { action: action_p2_fire_hit_carrier },
      { assertion: assert_shot_recorded_hit },
      { assertion: assert_turn_back_to_player1 },
      // === Test 7: Pass and reset ===
      { action: action_pass_device },
      { action: action_reset_game },
      { assertion: assert_reset_phase_playing },
      { assertion: assert_reset_turn_player1 },
      { assertion: assert_reset_viewingAs_null },
      { assertion: assert_reset_shots_cleared },
    ],
    game,
  };
});
