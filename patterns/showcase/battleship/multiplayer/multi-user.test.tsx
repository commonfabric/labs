/// <cts-enable />

/**
 * Multi-user pattern test for the battleship multiplayer lobby.
 *
 * Unlike lobby.test.tsx (one runtime driving both slots from a single
 * identity), this runs ONE shared lobby instance across two worker-isolated
 * runtimes — so the PerUser slot assignment (`myName` / `myPlayerNumber`)
 * and cross-runtime propagation of the shared match state are actually
 * exercised: two real users land in two different slots.
 *
 * Joins go through the programmatic `joinWithName` stream (the headless seam
 * kept by the profile migration); the profile-wish UI path needs a browser.
 */
import { action, assert, multiUserTest, pattern, TESTS } from "commonfabric";
import BattleshipLobby, { type LobbyOutput } from "./lobby.tsx";

interface Setup {
  lobby: LobbyOutput;
}

export const setup = pattern(() => ({
  lobby: BattleshipLobby({}),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const lobby = setup.lobby;

  const action_join = action(() => {
    lobby.joinWithName.send("Alice");
  });

  const assert_joined_slot_1 = assert(() =>
    lobby.myName === "Alice" &&
    lobby.myPlayerNumber === 1 &&
    lobby.player1?.name === "Alice"
  );
  const assert_game_started = assert(() =>
    lobby.player2?.name === "Bob" &&
    lobby.gameState.phase === "playing" &&
    lobby.gameState.currentTurn === 1
  );
  // Bob joining must not clobber Alice's PerUser slot assignment.
  const assert_slot_unchanged = assert(() =>
    lobby.myName === "Alice" && lobby.myPlayerNumber === 1
  );

  return {
    [TESTS]: [
      { action: action_join },
      { assertion: assert_joined_slot_1 },
      { label: "alice-joined" },
      { await: "bob-joined" },
      { assertion: assert_game_started },
      { assertion: assert_slot_unchanged },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const lobby = setup.lobby;

  const action_join = action(() => {
    lobby.joinWithName.send("Bob");
  });

  // Shared slot propagated from Alice's runtime.
  const assert_sees_alice = assert(() => lobby.player1?.name === "Alice");
  // PerUser isolation: Alice's join must not leak into Bob's identity cells
  // (unwritten PerUser cells may read as undefined in a fresh runtime).
  const assert_not_joined_yet = assert(() =>
    (lobby.myName ?? "") === "" && (lobby.myPlayerNumber ?? null) === null
  );
  const assert_joined_slot_2 = assert(() =>
    lobby.myName === "Bob" &&
    lobby.myPlayerNumber === 2 &&
    lobby.player2?.name === "Bob"
  );
  const assert_game_started = assert(() =>
    lobby.gameState.phase === "playing" && lobby.gameState.currentTurn === 1
  );

  return {
    [TESTS]: [
      { await: "alice-joined" },
      { assertion: assert_sees_alice },
      { assertion: assert_not_joined_yet },
      { action: action_join },
      { assertion: assert_joined_slot_2 },
      { assertion: assert_game_started },
      { label: "bob-joined" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
