/**
 * Test: Cozy Poll
 *
 * Exercises the scope idioms (per-space directory, per-user identity,
 * derived admin) and the core voting flows.
 *
 * Single-identity caveat (CT-1598): this file runs in one runtime with one
 * identity, so admin gating is exercised by attempting admin actions *before*
 * any join (myName empty → handler bails). The real second-user cases —
 * gating against a non-host user, host takeover, cross-runtime visibility —
 * are covered by multi-user.test.tsx.
 */

import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findNode,
  hasExactText,
} from "../../tools/test-support/vnode-helpers.ts";
import CozyPoll from "./main.tsx";

export default pattern(() => {
  const poll = CozyPoll({});

  // === Actions ===

  const action_try_add_before_join = action(() => {
    poll.addOption.send({ title: "Should not appear" });
  });

  const action_try_remove_before_join = action(() => {
    poll.removeOption.send({ optionId: "any" });
  });

  const action_try_reset_before_join = action(() => {
    poll.resetVotes.send({});
  });

  const action_join_as_alex = action(() => {
    poll.joinAs.send({ name: "Alex" });
  });

  const action_try_rejoin_as_alex_two = action(() => {
    poll.joinAs.send({ name: "Alex Two" });
  });

  const action_add_chipotle = action(() => {
    poll.addOption.send({ title: "Chipotle" });
  });

  const action_add_thai = action(() => {
    poll.addOption.send({ title: "Thai Kitchen" });
  });

  const action_vote_green_first = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "green" });
  });

  const action_vote_yellow_first = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "yellow" });
  });

  const action_vote_red_first = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "red" });
  });

  const action_vote_green_first_again = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "green" });
  });

  const action_reset_votes = action(() => {
    poll.resetVotes.send({});
  });

  const action_remove_first_option = action(() => {
    const first = poll.options[0];
    if (first) poll.removeOption.send({ optionId: first.id });
  });

  // Single-identity caveat (CT-1598): host *takeover* needs a second user and
  // is covered by multi-user.test.tsx. This just confirms claimHost is wired
  // and is a harmless no-op when the caller already holds the role.
  const action_claim_host = action(() => {
    poll.claimHost.send({});
  });

  // === Assertions ===

  // After joining, no leftovers from the pre-join admin attempts: only
  // Alex is in users, no admin name was claimed by anyone else, and the
  // "Should not appear" option is absent (implied by chipotle assertions
  // later — options.length === 1 after only Chipotle is added).
  const assert_joined_as_alex = assert(() =>
    poll.users.length === 1 &&
    poll.users[0]?.name === "Alex" &&
    poll.myName === "Alex" &&
    poll.adminName === "Alex" &&
    poll.isJoined === true &&
    poll.isAdmin === true
  );

  const assert_immutable_after_join = assert(() =>
    poll.users.length === 1 &&
    poll.myName === "Alex"
  );

  const assert_chipotle_added = assert(() =>
    poll.options.length === 1 &&
    poll.options[0]?.title === "Chipotle" &&
    poll.options[0]?.addedByName === "Alex"
  );

  const assert_two_options = assert(() => poll.options.length === 2);

  const assert_green_vote_recorded = assert(() => {
    const v = poll.votes[0];
    return poll.votes.length === 1 &&
      v?.voteType === "green" &&
      v?.voterName === "Alex";
  });

  const assert_changed_to_yellow = assert(() => {
    const v = poll.votes[0];
    return poll.votes.length === 1 &&
      v?.voteType === "yellow";
  });

  const assert_changed_to_red = assert(() => {
    const v = poll.votes[0];
    return poll.votes.length === 1 &&
      v?.voteType === "red";
  });

  const assert_revote_green_cleared = assert(() => poll.votes.length === 0);

  const assert_votes_reset = assert(() => poll.votes.length === 0);

  const assert_option_removed_with_its_votes = assert(() =>
    poll.options.length === 1 &&
    poll.options[0]?.title === "Thai Kitchen" &&
    poll.votes.length === 0
  );

  const assert_still_alex_host = assert(() =>
    poll.adminName === "Alex" && poll.isAdmin === true
  );

  // The empty state is the whole board before anyone adds an option, and its
  // job is to say who can do something about that. It reads differently to a
  // viewer with no host to wait for than to the host themselves, so both are
  // checked; the remaining branch names somebody else and needs the second
  // identity multi-user.test.tsx has.
  const assert_empty_state_awaits_a_host = assert(() =>
    poll.optionCount === 0 &&
    findNode(poll[UI], (node) => hasExactText(node, "No options yet")) !==
      undefined &&
    findNode(
        poll[UI],
        (node) => hasExactText(node, "Waiting for a host to join."),
      ) !== undefined
  );

  const assert_empty_state_prompts_the_host = assert(() =>
    poll.optionCount === 0 &&
    findNode(poll[UI], (node) => hasExactText(node, "No options yet")) !==
      undefined &&
    findNode(
        poll[UI],
        (node) => hasExactText(node, "Add the first one above."),
      ) !== undefined
  );

  return {
    [TESTS]: [
      // Admin-gated handlers are no-ops before anyone joins (myName empty).
      // The handler bails on `if (!me || me !== admin) return`. No
      // separate assertion here — downstream assertions (e.g. only
      // Chipotle ends up in options, only Alex in users) implicitly
      // verify these attempts left no state. See ADMIN-FUTURE.md for
      // the kernel-level upgrade path.
      { action: action_try_add_before_join },
      { action: action_try_remove_before_join },
      { action: action_try_reset_before_join },
      // Nobody has joined, so the board has no host to name.
      { assertion: assert_empty_state_awaits_a_host },

      // First join → claims admin
      { action: action_join_as_alex },
      { assertion: assert_joined_as_alex },

      // Second join attempt → no-op (name immutable after join)
      { action: action_try_rejoin_as_alex_two },
      { assertion: assert_immutable_after_join },

      // claimHost is a harmless no-op when the caller is already host.
      { action: action_claim_host },
      { assertion: assert_still_alex_host },

      // Alex hosts now, so the same empty board asks him for the first option.
      { assertion: assert_empty_state_prompts_the_host },

      // Admin adds options
      { action: action_add_chipotle },
      { assertion: assert_chipotle_added },
      { action: action_add_thai },
      { assertion: assert_two_options },

      // Vote green → yellow → red (covers all three colors)
      { action: action_vote_green_first },
      { assertion: assert_green_vote_recorded },
      { action: action_vote_yellow_first },
      { assertion: assert_changed_to_yellow },
      { action: action_vote_red_first },
      { assertion: assert_changed_to_red },

      // Voting green again (was red) → switches to green
      { action: action_vote_green_first_again },
      { assertion: assert_green_vote_recorded },

      // Voting same color again → toggles off
      { action: action_vote_green_first_again },
      { assertion: assert_revote_green_cleared },

      // Admin reset clears votes
      { action: action_vote_green_first },
      { action: action_reset_votes },
      { assertion: assert_votes_reset },

      // Remove option with votes → option AND its votes are discarded
      { action: action_vote_green_first },
      { action: action_remove_first_option },
      { assertion: assert_option_removed_with_its_votes },
    ],
    poll,
  };
});
