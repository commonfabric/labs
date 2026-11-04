/// <cts-enable />

/**
 * Multi-user pattern test for scrabble.
 *
 * Unlike scrabble.test.tsx (one runtime, one identity), this runs ONE shared
 * game across two worker-isolated runtimes — exercising what a single runtime
 * cannot: each user draws into their OWN PerUser rack from the shared bag,
 * the shared player roster propagates across runtimes, and the "name already
 * taken" guard rejects a join from a genuinely different user.
 *
 * Joins go through the programmatic `joinWithName` stream (the headless seam
 * kept by the profile migration); the profile-wish UI path needs a browser.
 *
 * Cross-runtime read caveats baked into this test (reads of state another
 * runtime wrote, before this runtime's first own write):
 * - roster reads are INLINE literal accesses (players[0].name) in the
 *   assertion computed — `.map()`, loop-variable indexing, and module-level
 *   helper calls over the shared array do not resolve cross-runtime.
 * - a participant cannot read their own UNWRITTEN PerUser array (bob's rack
 *   before joining), so pre-join isolation is asserted via `myName` and via
 *   Alice's rack surviving Bob's join.
 *
 * Join order is deterministic (markers): Alice first, then Bob.
 */
import { action, assert, multiUserTest, pattern, TESTS } from "commonfabric";
import Scrabble, { type GameOutput } from "./scrabble.tsx";

interface Setup {
  game: GameOutput;
}

export const setup = pattern(() => ({
  game: Scrabble({ gameName: "Multi-user Scrabble" }),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const game = setup.game;

  const action_join = action(() => {
    game.joinWithName.send("Alice");
  });

  const assert_joined = assert(() =>
    game.myName === "Alice" &&
    (game.rack ?? []).length === 7 &&
    (game.players ?? []).length === 1 &&
    game.players?.[0]?.name === "Alice"
  );
  // Bob joining must not clobber Alice's PerUser identity or rack, and the
  // shared roster must resolve BOTH players in Alice's runtime.
  const assert_sees_both = assert(() =>
    (game.players ?? []).length === 2 &&
    game.players?.[0]?.name === "Alice" &&
    game.players?.[1]?.name === "Bob" &&
    game.myName === "Alice" &&
    (game.rack ?? []).length === 7
  );
  // Two players drew 7 tiles each from the one shared bag.
  const assert_bag_consumed = assert(() => game.bagIndex === 14);

  return {
    [TESTS]: [
      { action: action_join },
      { assertion: assert_joined },
      { label: "alice-joined" },
      { await: "bob-joined" },
      { assertion: assert_sees_both },
      { assertion: assert_bag_consumed },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const game = setup.game;

  const action_join_as_alice = action(() => {
    game.joinWithName.send("Alice");
  });
  const action_join = action(() => {
    game.joinWithName.send("Bob");
  });

  // Shared roster propagated from Alice's runtime.
  const assert_sees_alice = assert(() =>
    (game.players ?? []).length === 1 &&
    game.players?.[0]?.name === "Alice"
  );
  // PerUser isolation: Alice's join must not leak into Bob's identity.
  const assert_not_joined_yet = assert(() => game.myName === "");
  // A DIFFERENT user trying to take Alice's name is rejected with a message
  // (PerSession) and stays unjoined.
  const assert_name_taken = assert(() =>
    game.message === "Name Alice is already taken." &&
    game.myName === ""
  );
  const assert_joined = assert(() =>
    game.myName === "Bob" &&
    (game.rack ?? []).length === 7 &&
    (game.players ?? []).length === 2 &&
    game.players?.[0]?.name === "Alice" &&
    game.players?.[1]?.name === "Bob"
  );

  return {
    [TESTS]: [
      { await: "alice-joined" },
      { assertion: assert_sees_alice },
      { assertion: assert_not_joined_yet },
      { action: action_join_as_alice },
      { assertion: assert_name_taken },
      { action: action_join },
      { assertion: assert_joined },
      { label: "bob-joined" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
