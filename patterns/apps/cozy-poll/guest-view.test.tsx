/**
 * Test: Cozy Poll, as a guest of somebody else's poll
 *
 * The poll starts hosted by Bob, whom this test's one identity is not, so it
 * reads the view a guest sees — Bob named as host in the join card, the
 * header, and the empty state — and takes the host role through the
 * click-to-reveal control. multi-user.test.tsx covers the same takeover
 * across two runtimes through the streams.
 */

import { action, assert, pattern, TESTS, UI } from "commonfabric";
import { findNodeByProp } from "../../tools/test-support/vnode-helpers.ts";
import CozyPoll from "./main.tsx";
import { shows } from "./view-text.ts";

export default pattern(() => {
  const poll = CozyPoll({
    adminName: "Bob",
    users: [{ name: "Bob", color: "#2f8a64", joinedAt: 0 }],
  });

  // === Actions ===

  // Each needs a joined viewer, so each is ignored before joining.
  const action_vote_before_join = action(() =>
    poll.castVote.send({ optionId: "o_any", voteType: "green" })
  );
  const action_clear_before_join = action(() =>
    poll.clearMyVote.send({ optionId: "o_any" })
  );
  const action_claim_before_join = action(() => poll.claimHost.send({}));

  const action_join_as_bob = action(() => poll.joinAs.send({ name: "Bob" }));
  const action_join_as_alex = action(() => poll.joinAs.send({ name: "Alex" }));

  // === Assertions ===

  const assert_ignored_before_join = assert(() =>
    poll.votes.length === 0 &&
    poll.adminName === "Bob" &&
    poll.isJoined === false
  );

  const assert_guest_join_card = assert(() =>
    shows(poll[UI], "Join the poll") &&
    shows(poll[UI], "Hosted by Bob.") &&
    shows(poll[UI], "Bob can add the first option.")
  );

  // Bob's name is taken, so nobody joins under it again.
  const assert_taken_name_refused = assert(() =>
    poll.isJoined === false && poll.users.length === 1
  );

  // Alex joins as a guest: his own chip and no host chip, Bob named in the
  // header, and no host controls.
  const assert_guest_view = assert(() =>
    poll.myName === "Alex" &&
    poll.isAdmin === false &&
    poll.users.length === 2 &&
    poll.users[1]?.color === "#c2573a" &&
    shows(poll[UI], "2 joined · 0 options · 0 votes · hosted by Bob") &&
    findNodeByProp(poll[UI], "title", "Alex") !== undefined &&
    !shows(poll[UI], "HOST") &&
    !shows(poll[UI], "Host controls") &&
    shows(poll[UI], "Bob can add the first option.") &&
    !shows(poll[UI], "Become host")
  );

  const assert_takeover_offered = assert(() =>
    shows(poll[UI], "Become host") && poll.adminName === "Bob"
  );

  const assert_takeover_withdrawn = assert(() =>
    !shows(poll[UI], "Become host") &&
    shows(poll[UI], "Hosted by Bob.") &&
    poll.adminName === "Bob"
  );

  const assert_alex_hosts = assert(() =>
    poll.adminName === "Alex" &&
    poll.isAdmin === true &&
    shows(poll[UI], "HOST") &&
    shows(poll[UI], "Host controls") &&
    !shows(poll[UI], "Become host") &&
    !shows(poll[UI], "Hosted by Alex.")
  );

  return {
    [TESTS]: [
      { action: action_vote_before_join },
      { action: action_clear_before_join },
      { action: action_claim_before_join },
      { assertion: assert_ignored_before_join },
      { assertion: assert_guest_join_card },

      { action: action_join_as_bob },
      { assertion: assert_taken_name_refused },
      { action: action_join_as_alex },
      { assertion: assert_guest_view },

      { press: poll[UI], control: "Hosted by Bob." },
      { assertion: assert_takeover_offered },
      { press: poll[UI], control: "Cancel" },
      { assertion: assert_takeover_withdrawn },
      { press: poll[UI], control: "Hosted by Bob." },
      { press: poll[UI], control: "Become host" },
      { assertion: assert_alex_hosts },
    ],
    poll,
  };
});
