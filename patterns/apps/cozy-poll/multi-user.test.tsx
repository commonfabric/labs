/// <cts-enable />

/**
 * Multi-user pattern test for cozy poll.
 *
 * main.test.tsx documents the single-identity caveat (CT-1598): one runtime
 * cannot simulate a second user. This runs ONE shared poll across two
 * worker-isolated runtimes and covers that gap: second-user join isolation,
 * the host gate rejecting a real non-host user, cross-runtime vote
 * visibility, and open host takeover. The deeper voting flows stay in
 * main.test.tsx; lunch-poll/multi-user.test.tsx covers the richer variant.
 *
 * Joins go through the `joinAs` event-name override (the headless seam kept
 * by the profile migration); the profile-wish UI path needs a browser.
 * Cross-runtime reads use INLINE literal accesses — see
 * scrabble/multi-user.test.tsx.
 */
import { action, assert, multiUserTest, pattern, TESTS } from "commonfabric";
import CozyPoll, { type CozyPollOutput } from "./main.tsx";

interface Setup {
  poll: CozyPollOutput;
}

export const setup = pattern(() => ({
  poll: CozyPoll({}),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const poll = setup.poll;

  const action_join = action(() => {
    poll.joinAs.send({ name: "Alice" });
  });
  const action_add_ramen = action(() => {
    poll.addOption.send({ title: "Ramen" });
  });

  const assert_joined_as_host = assert(() =>
    poll.myName === "Alice" &&
    poll.adminName === "Alice" &&
    poll.isAdmin === true &&
    (poll.users ?? []).length === 1 &&
    poll.users?.[0]?.name === "Alice"
  );
  const assert_option_added = assert(() =>
    (poll.options ?? []).length === 1 &&
    poll.options?.[0]?.title === "Ramen"
  );
  // Bob joined and voted; his gated addOption attempt left no trace.
  const assert_sees_bobs_vote = assert(() =>
    (poll.users ?? []).length === 2 &&
    poll.users?.[1]?.name === "Bob" &&
    (poll.votes ?? []).length === 1 &&
    poll.votes?.[0]?.voterName === "Bob" &&
    poll.votes?.[0]?.voteType === "red" &&
    (poll.options ?? []).length === 1 &&
    poll.myName === "Alice"
  );
  // Host takeover observed from the deposed host's runtime.
  const assert_deposed = assert(() =>
    poll.adminName === "Bob" && poll.isAdmin === false
  );

  return {
    [TESTS]: [
      { action: action_join },
      { assertion: assert_joined_as_host },
      { action: action_add_ramen },
      { assertion: assert_option_added },
      { label: "alice-set-up" },
      { await: "bob-voted" },
      { assertion: assert_sees_bobs_vote },
      { await: "bob-claimed-host" },
      { assertion: assert_deposed },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const poll = setup.poll;

  const action_join = action(() => {
    poll.joinAs.send({ name: "Bob" });
  });
  const action_try_add_as_non_host = action(() => {
    poll.addOption.send({ title: "Should not appear" });
  });
  const action_vote_red = action(() => {
    const first = poll.options?.[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "red" });
  });
  const action_claim_host = action(() => {
    poll.claimHost.send({});
  });

  const assert_sees_alice_setup = assert(() =>
    (poll.users ?? []).length === 1 &&
    poll.users?.[0]?.name === "Alice" &&
    poll.adminName === "Alice" &&
    (poll.options ?? []).length === 1 &&
    poll.options?.[0]?.title === "Ramen"
  );
  // PerUser isolation: Alice's join must not leak into Bob's identity.
  const assert_not_joined_yet = assert(() =>
    poll.myName === "" && poll.isJoined === false
  );
  const assert_joined_not_host = assert(() =>
    poll.myName === "Bob" &&
    poll.isAdmin === false &&
    (poll.users ?? []).length === 2 &&
    poll.users?.[1]?.name === "Bob"
  );
  // The host gate rejected a real second user (the CT-1598 gap).
  const assert_gating_held = assert(() => (poll.options ?? []).length === 1);
  const assert_own_vote = assert(() =>
    (poll.votes ?? []).length === 1 &&
    poll.votes?.[0]?.voterName === "Bob" &&
    poll.votes?.[0]?.voteType === "red"
  );
  const assert_is_host_now = assert(() =>
    poll.adminName === "Bob" && poll.isAdmin === true
  );

  return {
    [TESTS]: [
      { await: "alice-set-up" },
      { assertion: assert_sees_alice_setup },
      { assertion: assert_not_joined_yet },
      { action: action_join },
      { assertion: assert_joined_not_host },
      { action: action_try_add_as_non_host },
      { assertion: assert_gating_held },
      { action: action_vote_red },
      { assertion: assert_own_vote },
      { label: "bob-voted" },
      { action: action_claim_host },
      { assertion: assert_is_host_now },
      { label: "bob-claimed-host" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
