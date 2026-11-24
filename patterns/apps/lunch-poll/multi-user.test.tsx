/// <cts-enable />

/**
 * Multi-user pattern test for the lunch poll.
 *
 * One runtime cannot simulate a second user, so this runs ONE shared poll
 * across two worker-isolated runtimes and covers what a single identity
 * cannot: a second user joining, host gating rejecting a genuinely different
 * non-host, votes from two users tallied cross-runtime, and open host
 * takeover observed from the deposed host's runtime.
 *
 * Identity is each viewer's profile cell, claimed through the pattern's
 * `overrideViewer` test seam: the handler runs in the SENDING session's
 * runtime, so each participant's claim lands in its own per-user override
 * slot on the same shared piece. That mirrors production, where every viewer
 * resolves their own `#profile` against one shared roster. (Do NOT hand the
 * `viewer` input a cell built in `setup` instead: a scoped cell materializes
 * under whichever user instantiates the piece, so both participants end up
 * reading the first worker's slot.)
 *
 * Cross-runtime reads use INLINE literal accesses (users[0].name) — `.map()`,
 * loop-variable indexing, and helper calls over another runtime's arrays do
 * not resolve before a local write (see scrabble/multi-user.test.tsx).
 */
import {
  action,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import LunchPoll, { type CozyPollOutput, type LunchProfile } from "./main.tsx";

interface Setup {
  poll: CozyPollOutput;
}

/** One shared poll, as a real deployment has. */
export const setup = pattern(() => ({
  poll: LunchPoll({}),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const poll = setup.poll;
  const aliceProfile = Writable.of<LunchProfile>({ name: "Alice" });

  // Claim this runtime's identity; the seam writes Alice's own per-user slot.
  const action_become_alice = action(() => {
    poll.overrideViewer.send({ profile: aliceProfile, name: "Alice" });
  });
  const action_join = action(() => {
    poll.joinAs.send({});
  });
  const action_add_sushi = action(() => {
    poll.addOption.send({ title: "Sushi" });
  });
  const action_vote_green = action(() => {
    // Read the id inline. Binding the element first and reading `.id` off the
    // binding does not always resolve across runtimes before the send, which
    // reaches the stream as an undefined argument.
    const optionId = poll.options?.[0]?.id;
    if (optionId) poll.castVote.send({ optionId, voteType: "green" });
  });

  // First joiner becomes the host.
  const assert_joined_as_host = assert(() =>
    poll.myName === "Alice" &&
    poll.hostName === "Alice" &&
    poll.isJoined === true &&
    poll.isAdmin === true &&
    (poll.users ?? []).length === 1 &&
    poll.users?.[0]?.name === "Alice"
  );
  const assert_option_added = assert(() =>
    (poll.options ?? []).length === 1 &&
    poll.options?.[0]?.title === "Sushi"
  );
  const assert_own_vote = assert(() =>
    (poll.votes ?? []).length === 1 &&
    poll.votes?.[0]?.voteType === "green"
  );
  // Bob joined and voted; his two gated addOption attempts left no trace.
  const assert_sees_bob = assert(() =>
    (poll.users ?? []).length === 2 &&
    poll.users?.[1]?.name === "Bob" &&
    (poll.votes ?? []).length === 2 &&
    (poll.options ?? []).length === 1 &&
    poll.myName === "Alice"
  );
  // Host takeover observed from the deposed host's runtime.
  const assert_deposed = assert(() =>
    poll.hostName === "Bob" && poll.isAdmin === false
  );

  return {
    [TESTS]: [
      { action: action_become_alice },
      { action: action_join },
      { assertion: assert_joined_as_host },
      { action: action_add_sushi },
      { assertion: assert_option_added },
      { action: action_vote_green },
      { assertion: assert_own_vote },
      { label: "alice-set-up" },
      { await: "bob-voted" },
      { assertion: assert_sees_bob },
      { await: "bob-claimed-host" },
      { assertion: assert_deposed },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const poll = setup.poll;
  const bobProfile = Writable.of<LunchProfile>({ name: "Bob" });

  const action_become_bob = action(() => {
    poll.overrideViewer.send({ profile: bobProfile, name: "Bob" });
  });

  const action_try_add_before_join = action(() => {
    poll.addOption.send({ title: "Pizza" });
  });
  const action_join = action(() => {
    poll.joinAs.send({});
  });
  const action_try_add_as_non_host = action(() => {
    poll.addOption.send({ title: "Pizza" });
  });
  const action_vote_green = action(() => {
    // Read the id inline. Binding the element first and reading `.id` off the
    // binding does not always resolve across runtimes before the send, which
    // reaches the stream as an undefined argument.
    const optionId = poll.options?.[0]?.id;
    if (optionId) poll.castVote.send({ optionId, voteType: "green" });
  });
  const action_claim_host = action(() => {
    poll.claimHost.send({});
  });

  // Alice's setup propagated from her runtime.
  const assert_sees_alice_setup = assert(() =>
    (poll.users ?? []).length === 1 &&
    poll.users?.[0]?.name === "Alice" &&
    poll.hostName === "Alice" &&
    (poll.options ?? []).length === 1 &&
    poll.options?.[0]?.title === "Sushi" &&
    (poll.votes ?? []).length === 1
  );
  // Identity isolation: Alice's join must not make Bob a participant.
  const assert_not_joined_yet = assert(() =>
    poll.myName === "Bob" && poll.isJoined === false
  );
  const assert_joined_not_host = assert(() =>
    poll.isJoined === true &&
    poll.isAdmin === false &&
    (poll.users ?? []).length === 2 &&
    poll.users?.[1]?.name === "Bob"
  );
  // Both gated attempts (pre-join AND joined-but-not-host) left no trace: a
  // real second user is rejected by the host gate.
  const assert_gating_held = assert(() => (poll.options ?? []).length === 1);
  const assert_both_votes = assert(() => (poll.votes ?? []).length === 2);
  const assert_is_host_now = assert(() =>
    poll.hostName === "Bob" && poll.isAdmin === true
  );

  return {
    [TESTS]: [
      { await: "alice-set-up" },
      // Claim this runtime's identity before any identity-dependent step;
      // the per-user seam keeps the write from touching Alice's slot.
      { action: action_become_bob },
      { assertion: assert_sees_alice_setup },
      { assertion: assert_not_joined_yet },
      { action: action_try_add_before_join },
      { action: action_join },
      { assertion: assert_joined_not_host },
      { action: action_try_add_as_non_host },
      { assertion: assert_gating_held },
      { action: action_vote_green },
      { assertion: assert_both_votes },
      { label: "bob-voted" },
      { action: action_claim_host },
      { assertion: assert_is_host_now },
      { label: "bob-claimed-host" },
    ],
    // A vote is a read-modify-write over the shared list, so two viewers
    // writing at once conflict and the loser retries — the scheduler logs
    // "commit failed transiently; backing off". That retry IS the designed
    // behavior here (identity is a cell, which cannot key a mergeable
    // per-vote write), and every assertion above holds after it, so the
    // warning is expected rather than a defect.
    allowConsoleWarnings: true,
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
