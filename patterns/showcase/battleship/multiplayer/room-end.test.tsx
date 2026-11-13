/**
 * Test Pattern: Battleship Multiplayer Room, a finished match
 *
 * Alice has sunk Bob's only ship. Bob is shown his defeat over a board that
 * shows every shot he took; a slot emptied under its viewer leaves their own
 * board empty and their card named for the slot; and a viewer with no slot is
 * shown no boards. `room.test.tsx` shows Alice her victory.
 *
 * Run: deno task cf test --root patterns patterns/showcase/battleship/multiplayer/room-end.test.tsx
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
import { shows, squareAt, viewOf } from "../shared/board-view.ts";
import BattleshipRoom from "./room.tsx";
import {
  createTestPlayer,
  playerCards,
  shotsWith,
  status,
} from "./room-view.ts";
import type { GameState, PlayerData, ShotsState } from "./schemas.tsx";

export default pattern(() => {
  const player2Cell = new Writable<PlayerData | null>(
    createTestPlayer("Bob", 2),
  );
  const myNameCell = new Writable("Bob");
  const myPlayerNumberCell = new Writable<1 | 2 | null>(2);
  const room = BattleshipRoom({
    gameName: "Test Game",
    player1: new Writable<PlayerData | null>(createTestPlayer("Alice", 1)),
    player2: player2Cell,
    // Bob hit A1 and missed J10; Alice missed F6 and sank his destroyer.
    shots: new Writable<ShotsState>({
      1: shotsWith([[0, 0, "hit"], [9, 9, "miss"]]),
      2: shotsWith([[5, 5, "miss"], [0, 0, "hit"], [0, 1, "hit"]]),
    }),
    gameState: new Writable<GameState>({
      phase: "finished",
      currentTurn: 1,
      winner: 1,
      lastMessage: "B1: Hit! You sunk the Destroyer! Alice wins!",
    }),
    myName: myNameCell,
    myPlayerNumber: myPlayerNumberCell,
  });

  // The viewer gives up their seat.
  const action_leave_seat = action(() => {
    myNameCell.set("");
    myPlayerNumberCell.set(null);
  });
  const action_bob_leaves = action(() => {
    player2Cell.set(null);
  });

  const assert_defeat_view = assert(() => {
    const view = viewOf(room[UI]);
    return room[NAME] === "Battleship: Bob" &&
      status(view) === "Defeat. Your fleet was destroyed." &&
      // Alice's miss and the hits that sank him, on Bob's own board.
      shows(squareAt(view.own, 5, 5), "O", "#374151") &&
      shows(squareAt(view.own, 0, 1), "X", "#dc2626") &&
      playerCards(view) ===
        JSON.stringify(["AAliceActive", "BBob (you)Waiting"]);
  });

  const assert_no_slot_view = assert(() => {
    const view = viewOf(room[UI]);
    return room[NAME] === "Battleship: Joining" &&
      view.own.length === 0 && view.enemy.length === 0;
  });

  // Bob's own board has nothing to draw, and his card is named for the slot.
  const assert_empty_slot_view = assert(() => {
    const view = viewOf(room[UI]);
    return view.own.length === 0 && view.enemy.length === 100 &&
      playerCards(view) ===
        JSON.stringify(["AAliceActive", "P2Player 2 (you)Waiting"]);
  });

  return {
    [TESTS]: [
      { assertion: assert_defeat_view },
      { action: action_bob_leaves },
      { assertion: assert_empty_slot_view },
      { action: action_leave_seat },
      { assertion: assert_no_slot_view },
    ],
    room,
  };
});
