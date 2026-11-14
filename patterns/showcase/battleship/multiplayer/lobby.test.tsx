/**
 * Test Pattern: Battleship Multiplayer Lobby
 *
 * Tests the lobby data model and actions:
 * - Initial state (defaults)
 * - Player 1 joining
 * - Player 2 joining
 * - Game state transition to "playing" when both players join
 * - Reset functionality
 * - What the lobby shows as players join, and joining with a profile
 *
 * Run: deno task cf test patterns/showcase/battleship/multiplayer/lobby.test.tsx --verbose
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  findElementByText,
  hasText,
  propValue,
} from "../../../tools/test-support/vnode-helpers.ts";
import type { ProfileFaceFields } from "../../../system/profile-face/profile-face.ts";
import BattleshipLobby, { BattleshipLobbyCore } from "./lobby.tsx";
import {
  createInitialShots,
  type GameState,
  INITIAL_GAME_STATE,
  type PlayerData,
  type ShotsState,
} from "./schemas.tsx";

export default pattern(() => {
  // Create Writable cells with initial values for the lobby state
  const player1Cell = new Writable<PlayerData | null>(null);
  const player2Cell = new Writable<PlayerData | null>(null);
  const shotsCell = new Writable<ShotsState>(createInitialShots());
  const gameStateCell = new Writable<GameState>(INITIAL_GAME_STATE);

  // Instantiate the lobby pattern with properly initialized cells
  const lobby = BattleshipLobby({
    gameName: "Battleship",
    player1: player1Cell,
    player2: player2Cell,
    shots: shotsCell,
    gameState: gameStateCell,
  });

  // A lobby given a stand-in for the viewer's profile, which a pattern test
  // cannot resolve with `#profile`.
  const profile = new Writable<{ name?: string } & ProfileFaceFields>({
    name: "Dana",
  });
  const core = BattleshipLobbyCore({
    gameName: "Harbor",
    player1: new Writable<PlayerData | null>(null),
    player2: new Writable<PlayerData | null>(null),
    shots: new Writable<ShotsState>(createInitialShots()),
    gameState: new Writable<GameState>(INITIAL_GAME_STATE),
    profile,
    profileName: "Dana",
  });

  // ==========================================================================
  // Actions using exported Stream handlers
  // ==========================================================================

  // Player 1 joins with name "Alice"
  const action_join_player1 = action(() => {
    lobby.joinPlayer1.send({ name: "Alice" });
  });

  // Player 2 joins with name "Bob"
  const action_join_player2 = action(() => {
    lobby.joinPlayer2.send({ name: "Bob" });
  });

  // Reset the lobby
  const action_reset = action(() => {
    lobby.reset.send();
  });

  // Try to join with empty name (should be ignored)
  const action_join_empty_name = action(() => {
    lobby.joinPlayer1.send({ name: "" });
  });

  const action_join_with_name_alice = action(() => {
    lobby.joinWithName.send("Alice");
  });

  // Simulate another player resetting shared match state. This leaves the
  // current viewer's scoped player assignment stale.
  const action_clear_shared_match_state = action(() => {
    player1Cell.set(null);
    player2Cell.set(null);
    shotsCell.set(createInitialShots());
    gameStateCell.set(INITIAL_GAME_STATE);
  });

  const action_rejoin_after_stale_slot = action(() => {
    lobby.joinWithName.send("Carol");
  });

  const action_join_with_profile = action(() => {
    clickButton(core[UI], "Join as Dana");
  });
  // Joining again, already seated, changes nothing.
  const action_join_again = action(() => {
    core.joinWithName.send("Dana");
  });

  // ==========================================================================
  // View Assertions
  // ==========================================================================

  // Without a profile, the join button asks for one and stays disabled.
  const assert_initial_view = assert(() => {
    const ui = lobby[UI];
    return lobby[NAME] === "Battleship - Battleship" &&
      hasText(ui, "Join to deploy the first fleet.") &&
      hasText(ui, "Player 1: Open") && hasText(ui, "Player 2: Open") &&
      propValue(findElement(ui, "cf-avatar"), "name") === "?" &&
      propValue(
          findElementByText(ui, "cf-button", "Create a profile to join"),
          "disabled",
        ) === true;
  });
  const assert_one_player_view = assert(() => {
    const ui = lobby[UI];
    return hasText(ui, "Waiting for a second captain.") &&
      hasText(ui, "Player 1: Alice") && hasText(ui, "Player 2: Open") &&
      propValue(findElement(ui, "cf-avatar"), "name") === "Alice";
  });
  const assert_full_view = assert(() => {
    const ui = lobby[UI];
    return hasText(ui, "Both fleets are deployed.") &&
      hasText(ui, "Player 2: Bob") &&
      hasText(ui, "This game already has two players.") &&
      !hasText(ui, "Create a profile to join") &&
      lobby.shots[1].every((row) => row.every((cell) => cell === "empty"));
  });

  const assert_profile_join_offered = assert(() =>
    core[NAME] === "Harbor - Battleship" &&
    propValue(
        findElementByText(core[UI], "cf-button", "Join as Dana"),
        "disabled",
      ) ===
      false
  );
  // The stand-in is nobody's own profile, so the seat takes no face from it.
  const assert_joined_with_profile = assert(() =>
    core.player1?.name === "Dana" && core.player1?.avatar === undefined &&
    core.myName === "Dana" && core.myPlayerNumber === 1
  );
  // A seated viewer is shown the room instead of the lobby.
  const assert_room_shown = assert(() =>
    hasText(core[UI], "Playing as") && !hasText(core[UI], "Join as Dana")
  );
  const assert_join_again_ignored = assert(() =>
    core.player2 === null && core.myPlayerNumber === 1
  );

  // ==========================================================================
  // Initial State Assertions
  // ==========================================================================

  // Game name defaults to "Battleship"
  const assert_initial_game_name = assert(
    () => lobby.gameName === "Battleship",
  );

  // Both players are initially null
  const assert_initial_player1_null = assert(() => lobby.player1 === null);
  const assert_initial_player2_null = assert(() => lobby.player2 === null);

  // Game state phase is "waiting"
  const assert_initial_phase_waiting = assert(
    () => lobby.gameState.phase === "waiting",
  );

  // Game state currentTurn is 1 initially
  const assert_initial_current_turn = assert(
    () => lobby.gameState.currentTurn === 1,
  );

  // Game state winner is null initially
  const assert_initial_winner_null = assert(
    () => lobby.gameState.winner === null,
  );

  // ==========================================================================
  // After Player 1 Joins Assertions
  // ==========================================================================

  // Player 1 has joined with correct name
  const assert_player1_name = assert(() => lobby.player1?.name === "Alice");

  // Player 1 has ships assigned
  const assert_player1_has_ships = assert(
    () =>
      lobby.player1 !== null &&
      Array.isArray(lobby.player1.ships) &&
      lobby.player1.ships.length === 5,
  );

  // Player 1 has a color
  const assert_player1_has_color = assert(
    () =>
      lobby.player1 !== null &&
      typeof lobby.player1.color === "string" &&
      lobby.player1.color.length > 0,
  );

  // Player 2 is still null
  const assert_player2_still_null = assert(() => lobby.player2 === null);

  // Game state is still waiting (only 1 player joined)
  const assert_still_waiting_one_player = assert(
    () => lobby.gameState.phase === "waiting",
  );

  // ==========================================================================
  // After Player 2 Joins Assertions
  // ==========================================================================

  // Player 2 has joined with correct name
  const assert_player2_name = assert(() => lobby.player2?.name === "Bob");

  // Player 2 has ships assigned
  const assert_player2_has_ships = assert(
    () =>
      lobby.player2 !== null &&
      Array.isArray(lobby.player2.ships) &&
      lobby.player2.ships.length === 5,
  );

  // Game state phase changes to "playing"
  const assert_phase_playing = assert(
    () => lobby.gameState.phase === "playing",
  );

  // Game state currentTurn is set to 1 when game starts
  const assert_current_turn_player1 = assert(
    () => lobby.gameState.currentTurn === 1,
  );

  // ==========================================================================
  // After Reset Assertions
  // ==========================================================================

  // Both players are back to null
  const assert_reset_player1_null = assert(() => lobby.player1 === null);
  const assert_reset_player2_null = assert(() => lobby.player2 === null);

  // Game state returns to "waiting"
  const assert_reset_phase_waiting = assert(
    () => lobby.gameState.phase === "waiting",
  );

  // Winner is null after reset
  const assert_reset_winner_null = assert(
    () => lobby.gameState.winner === null,
  );

  // ==========================================================================
  // Edge Case: Stale per-user slot should not block rejoin
  // ==========================================================================
  const assert_stale_slot_rejoined = assert(() =>
    lobby.player1?.name === "Carol" &&
    lobby.myName === "Carol" &&
    lobby.myPlayerNumber === 1
  );

  const assert_stale_slot_prepared = assert(() =>
    lobby.player1 === null &&
    lobby.myName === "Alice" &&
    lobby.myPlayerNumber === 1
  );

  // ==========================================================================
  // Edge Case: Empty name should be ignored
  // ==========================================================================
  const assert_empty_name_ignored = assert(() => lobby.player1 === null);

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Initial State Tests ===
      { assertion: assert_initial_game_name },
      { assertion: assert_initial_player1_null },
      { assertion: assert_initial_player2_null },
      { assertion: assert_initial_phase_waiting },
      { assertion: assert_initial_current_turn },
      { assertion: assert_initial_winner_null },
      { assertion: assert_initial_view },

      // === Edge case: Empty name ignored ===
      { action: action_join_empty_name },
      { assertion: assert_empty_name_ignored },

      // === Player 1 Joins ===
      { action: action_join_player1 },
      { assertion: assert_player1_name },
      { assertion: assert_player1_has_ships },
      { assertion: assert_player1_has_color },
      { assertion: assert_player2_still_null },
      { assertion: assert_still_waiting_one_player },
      { assertion: assert_one_player_view },

      // === Player 2 Joins ===
      { action: action_join_player2 },
      { assertion: assert_player2_name },
      { assertion: assert_player2_has_ships },
      { assertion: assert_phase_playing },
      { assertion: assert_current_turn_player1 },
      { assertion: assert_full_view },

      // === Reset ===
      { action: action_reset },
      { assertion: assert_reset_player1_null },
      { assertion: assert_reset_player2_null },
      { assertion: assert_reset_phase_waiting },
      { assertion: assert_reset_winner_null },

      // === Rejoin after stale per-user assignment ===
      { action: action_join_with_name_alice },
      { action: action_clear_shared_match_state },
      { assertion: assert_stale_slot_prepared },
      { action: action_rejoin_after_stale_slot },
      { assertion: assert_stale_slot_rejoined },

      // === Joining with a profile ===
      { assertion: assert_profile_join_offered },
      { action: action_join_with_profile },
      { assertion: assert_joined_with_profile },
      { assertion: assert_room_shown },
      { action: action_join_again },
      { assertion: assert_join_again_ignored },
    ],
    lobby,
    core,
  };
});
