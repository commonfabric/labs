/**
 * Test Pattern: Battleship Multiplayer Room, the opening boards
 *
 * Alice opens a match on her turn: her status, header, and player cards say
 * so, her board shows her fleet, and the enemy board offers every square. A
 * click on an enemy square fires there, and the miss is drawn where she shot.
 *
 * Run: deno task cf test --root patterns patterns/showcase/battleship/multiplayer/room-board.test.tsx
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  fireClick,
  styleOf,
} from "../../../tools/test-support/vnode-helpers.ts";
import { shows, squareAt, viewOf } from "../shared/board-view.ts";
import BattleshipRoom from "./room.tsx";
import {
  createTestPlayer,
  headerInitials,
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

export default pattern(() => {
  const shotsCell = new Writable<ShotsState>(createInitialShots());
  const gameStateCell = new Writable<GameState>({
    phase: "playing",
    currentTurn: 1,
    winner: null,
    lastMessage: "Alice's turn - fire at the enemy fleet!",
  });
  const room = BattleshipRoom({
    gameName: "Test Game",
    player1: new Writable<PlayerData | null>(createTestPlayer("Alice", 1)),
    player2: new Writable<PlayerData | null>(createTestPlayer("Bob", 2)),
    shots: shotsCell,
    gameState: gameStateCell,
    myName: new Writable("Alice"),
    myPlayerNumber: new Writable<1 | 2 | null>(1),
  });

  // Alice fires at F6 by clicking that square of the enemy board.
  const action_click_f6 = action(() => {
    fireClick(squareAt(viewOf(room[UI]).enemy, 5, 5), "enemy square F6");
  });

  const assert_opening_view = assert(() => {
    const view = viewOf(room[UI]);
    return status(view) === "Your turn - fire at the enemy fleet!" &&
      turnIndicator(view) === "block" &&
      view.text.includes("Alice's turn - fire at the enemy fleet!") &&
      headerInitials(view) === "A" &&
      playerCards(view) ===
        JSON.stringify(["AAlice (you)Active", "BBobWaiting"]) &&
      // Her destroyer is drawn on her board, open water beside it.
      shows(squareAt(view.own, 0, 0), "", "#22c55e") &&
      shows(squareAt(view.own, 5, 5), "", "#1e3a5f") &&
      styleOf(squareAt(view.enemy, 5, 5), "cursor") === "pointer" &&
      view.own.length === 100 && view.enemy.length === 100;
  });

  const assert_miss_recorded = assert(() =>
    shotsCell.get()[2][5][5] === "miss" &&
    gameStateCell.get().lastMessage === "F6: Miss. Bob's turn."
  );

  const assert_miss_view = assert(() => {
    const view = viewOf(room[UI]);
    const square = squareAt(view.enemy, 5, 5);
    return shows(square, "O", "#374151") &&
      styleOf(square, "cursor") === "default" &&
      status(view) === "Waiting for opponent..." &&
      turnIndicator(view) === "none" &&
      playerCards(view) ===
        JSON.stringify(["AAlice (you)Waiting", "BBobActive"]);
  });

  return {
    [TESTS]: [
      { assertion: assert_opening_view },
      { action: action_click_f6 },
      { assertion: assert_miss_recorded },
      { assertion: assert_miss_view },
    ],
    room,
  };
});
