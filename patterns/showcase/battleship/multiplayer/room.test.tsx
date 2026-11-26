/**
 * Test Pattern: Battleship Multiplayer Room
 *
 * One room plays a whole match. The test owns the per-user identity cells, so
 * it switches the viewer between Alice (player 1) and Bob (player 2) to take
 * each player's turn:
 * - firing records hits and misses
 * - turns alternate, and a shot out of turn, or at a square already shot on
 *   the shooter's own turn, is ignored
 * - a shot at a fleet that holds no ships records nothing
 * - sinking a ship names it, and sinking the last one wins the match, which
 *   the winner is shown over boards that offer no more shots
 * - a room whose match has not started says it is waiting for an opponent
 *
 * Each read of a room's view with its boards costs seconds, so the rest of
 * what the boards show is `room-board.test.tsx`'s and `room-end.test.tsx`'s.
 *
 * Run: deno task cf test --root patterns patterns/showcase/battleship/multiplayer/room.test.tsx
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
import { styleOf } from "../../../tools/test-support/vnode-helpers.ts";
import { shows, squareAt, viewOf } from "../shared/board-view.ts";
import BattleshipRoom from "./room.tsx";
import {
  createTestPlayer,
  playerCards,
  status,
  turnIndicator,
} from "./room-view.ts";
import {
  createInitialShots,
  type GameState,
  type PlayerData,
  type ShotsState,
} from "./schemas.tsx";

const ALICE = { name: "Alice", playerNum: 1 } as const;
const BOB = { name: "Bob", playerNum: 2 } as const;
const NOBODY = { name: "", playerNum: null };

// =============================================================================
// Test Pattern
// =============================================================================

export default pattern(() => {
  // Shared state cells, as the lobby would create them.
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
  // This viewer's identity, which the test switches between the players.
  const myNameCell = new Writable("Alice");
  const myPlayerNumberCell = new Writable<1 | 2 | null>(1);

  const room = BattleshipRoom({
    gameName: "Test Game",
    player1: player1Cell,
    player2: player2Cell,
    shots: shotsCell,
    gameState: gameStateCell,
    myName: myNameCell,
    myPlayerNumber: myPlayerNumberCell,
  });

  // A room whose match nobody has written yet: it reads as its default,
  // waiting for players, and there are no shots to draw.
  const unstarted = BattleshipRoom({
    gameName: "Test Game",
    player1: new Writable<PlayerData | null>(createTestPlayer("Carol", 1)),
    player2: new Writable<PlayerData | null>(null),
    shots: new Writable<ShotsState>(),
    gameState: new Writable<GameState>(),
    myName: new Writable("Carol"),
    myPlayerNumber: new Writable<1 | 2 | null>(1),
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  // Takes a seat as the viewer the event names.
  const action_view_as = action<{ name: string; playerNum: 1 | 2 | null }>(
    ({ name, playerNum }) => {
      myNameCell.set(name);
      myPlayerNumberCell.set(playerNum);
    },
  );

  // Fires at the square the event names.
  const action_fire = action<{ row: number; col: number }>((shot) => {
    room.fireShot.send(shot);
  });

  const action_remove_bobs_fleet = action(() => {
    player2Cell.set(createTestPlayer("Bob", 2, []));
  });
  const action_restore_bobs_fleet = action(() => {
    player2Cell.set(createTestPlayer("Bob", 2));
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_initial_identity = assert(() =>
    room.myName === "Alice" && room.myPlayerNumber === 1 &&
    room[NAME] === "Battleship: Alice"
  );
  const assert_initial_no_shots = assert(() => {
    const shots = shotsCell.get();
    return shots[1].every((row) => row.every((cell) => cell === "empty")) &&
      shots[2].every((row) => row.every((cell) => cell === "empty"));
  });
  const assert_empty_fleet_shot_ignored = assert(() =>
    shotsCell.get()[2][0][0] === "empty" &&
    gameStateCell.get().currentTurn === 1
  );
  const assert_miss_recorded = assert(() =>
    shotsCell.get()[2][5][5] === "miss" &&
    gameStateCell.get().currentTurn === 2 &&
    gameStateCell.get().lastMessage === "F6: Miss. Bob's turn."
  );
  const assert_still_player2_turn = assert(() =>
    gameStateCell.get().currentTurn === 2 &&
    shotsCell.get()[2][1][1] === "empty"
  );
  const assert_bob_hit = assert(() =>
    shotsCell.get()[1][0][0] === "hit" &&
    gameStateCell.get().lastMessage === "A1: Hit! Alice's turn."
  );
  const assert_alice_hit = assert(() =>
    shotsCell.get()[2][0][0] === "hit" &&
    gameStateCell.get().lastMessage === "A1: Hit! Bob's turn."
  );
  const assert_bob_missed = assert(() =>
    shotsCell.get()[1][9][9] === "miss" &&
    shotsCell.get()[2][0][0] === "hit" &&
    gameStateCell.get().currentTurn === 1 &&
    gameStateCell.get().lastMessage === "J10: Miss. Alice's turn."
  );
  const assert_alice_won = assert(() =>
    gameStateCell.get().phase === "finished" &&
    gameStateCell.get().winner === 1 &&
    gameStateCell.get().lastMessage ===
      "B1: Hit! You sunk the Destroyer! Alice wins!"
  );
  const assert_shot_after_finish_ignored = assert(() =>
    shotsCell.get()[2][4][4] === "empty" &&
    gameStateCell.get().winner === 1
  );

  const assert_victory_view = assert(() => {
    const view = viewOf(room[UI]);
    return status(view) === "Victory! You sunk all enemy ships!" &&
      turnIndicator(view) === "none" &&
      // Bob's hit, on Alice's own board, and hers on the enemy board.
      shows(squareAt(view.own, 0, 0), "X", "#dc2626") &&
      shows(squareAt(view.enemy, 0, 1), "X", "#dc2626") &&
      // An open square of a finished match no longer offers a shot.
      styleOf(squareAt(view.enemy, 4, 4), "cursor") === "default";
  });

  const assert_no_slot = assert(() =>
    room[NAME] === "Battleship: Joining" && room.myPlayerNumber === null
  );

  const assert_unstarted_view = assert(() => {
    const view = viewOf(unstarted[UI]);
    // Nobody's turn yet, so neither card shows its player active.
    return status(view) === "Waiting for an opponent to join..." &&
      turnIndicator(view) === "none" &&
      playerCards(view) ===
        JSON.stringify(["CCarol (you)Waiting", "P2Player 2Waiting"]) &&
      view.text.includes("Waiting for players...") &&
      view.own.length === 0 && view.enemy.length === 0;
  });

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      { assertion: assert_initial_identity },
      { assertion: assert_initial_no_shots },

      { action: action_remove_bobs_fleet },
      { action: action_fire, event: { row: 0, col: 0 } },
      { assertion: assert_empty_fleet_shot_ignored },
      { action: action_restore_bobs_fleet },

      // Alice misses at F6.
      { action: action_fire, event: { row: 5, col: 5 } },
      { assertion: assert_miss_recorded },
      // A shot out of turn is ignored.
      { action: action_fire, event: { row: 1, col: 1 } },
      { assertion: assert_still_player2_turn },

      // Bob hits A1 of Alice's destroyer.
      { action: action_view_as, event: BOB },
      { action: action_fire, event: { row: 0, col: 0 } },
      { assertion: assert_bob_hit },

      // Alice hits A1 of Bob's.
      { action: action_view_as, event: ALICE },
      { action: action_fire, event: { row: 0, col: 0 } },
      { assertion: assert_alice_hit },

      { action: action_view_as, event: BOB },
      { action: action_fire, event: { row: 9, col: 9 } },
      { assertion: assert_bob_missed },

      // On her own turn, Alice's second shot at A1, which she has hit
      // already, is ignored: it records nothing and passes no turn.
      { action: action_view_as, event: ALICE },
      { action: action_fire, event: { row: 0, col: 0 } },
      { assertion: assert_bob_missed },

      // Alice hits B1, which sinks Bob's only ship.
      { action: action_fire, event: { row: 0, col: 1 } },
      { assertion: assert_alice_won },
      { assertion: assert_victory_view },
      { action: action_fire, event: { row: 4, col: 4 } },
      { assertion: assert_shot_after_finish_ignored },

      { action: action_view_as, event: NOBODY },
      { assertion: assert_no_slot },

      { assertion: assert_unstarted_view },
    ],
    room,
    unstarted,
  };
});
