/**
 * Test: the reduced lunch poll renders a nullable value read in a computed
 * block, and its handlers keep to their guards.
 *
 * The repro's view reads `minimalNullable`, a `string | null`, inside a
 * `computed()` block, which once blanked everything below the header. The
 * test checks that block shows "null" with no options and the first option's
 * title once one is added. It then drives the poll the way its view does:
 * joining, adding options as the host, voting through each row's buttons,
 * removing a voted option along with its votes, and resetting. A second poll
 * starts with an option and votes, so each refusal shows as a count that did
 * not change: a second join, a guest adding or removing options or resetting
 * votes, and a vote cast or cleared by someone who has not joined.
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  clickInRow,
  findNode,
  hasText,
  innermostNode,
  isButton,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import CozyPoll from "./main.tsx";

/** The row of the option titled `title`: the innermost node showing its rank
 * alongside the title and its "added by" line. */
const row = (root: unknown, title: string) =>
  innermostNode(
    root,
    (node) =>
      hasText(node, "#") && hasText(node, title) && hasText(node, "added by"),
  );

/** The style of the button labeled `label` in the row of `title`. */
const buttonStyle = (root: unknown, title: string, label: string) =>
  propValue(findNode(row(root, title), isButton(label)), "style");

export default pattern(() => {
  const host = CozyPoll({});
  // The vote with no voter name is one only the unjoined guard keeps a viewer
  // who has not joined from clearing.
  const guest = CozyPoll({
    users: [{ name: "Ada", color: "#2f8a64", joinedAt: 0 }],
    adminName: "Ada",
    options: [{ id: "o1", title: "Sushi", addedByName: "Ada" }],
    votes: [
      { voterName: "Ada", optionId: "o1", voteType: "green" },
      { voterName: "", optionId: "o1", voteType: "yellow" },
    ],
  });

  const action_join_without_name = action(() => clickButton(host[UI], "Join"));
  const action_join_host = action(() => host.joinAs.send({ name: " Ada " }));
  const action_join_host_again = action(() => host.joinAs.send({ name: "Bo" }));
  // Each action whose outcome depends on the order of its events sends one
  // event, or several whose order does not matter, so the step that follows
  // reads the state the events before it left.
  const action_add_sushi = action(() => {
    host.addOption.send({ title: "  " });
    host.addOption.send({ title: "Sushi" });
  });
  const action_add_tacos = action(() =>
    host.addOption.send({ title: "Tacos" })
  );
  const action_love_sushi = action(() => clickInRow(host[UI], "Sushi", "🟢"));
  const action_unlove_sushi = action(() => clickInRow(host[UI], "Sushi", "🟢"));
  const action_maybe_sushi = action(() => clickInRow(host[UI], "Sushi", "🟡"));
  const action_veto_sushi_love_tacos = action(() => {
    clickInRow(host[UI], "Sushi", "🔴");
    clickInRow(host[UI], "Tacos", "🟢");
  });
  const action_clear_sushi = action(() =>
    clickInRow(host[UI], "Sushi", "Clear")
  );
  const action_veto_sushi_again = action(() =>
    clickInRow(host[UI], "Sushi", "🔴")
  );
  const action_remove_sushi = action(() => {
    host.removeOption.send({ optionId: "missing" });
    clickInRow(host[UI], "Sushi", "✕");
  });
  const action_reset_votes = action(() => clickButton(host[UI], "Reset votes"));

  // The guest poll already names Ada as host and lists her, so joining as her
  // is refused and joining as Bo makes Bo a guest. Everything Bo then tries
  // that only the host may do is refused, and so is a vote cast or cleared
  // before Bo joined.
  const action_guest_votes_before_joining = action(() => {
    guest.castVote.send({ optionId: "o1", voteType: "green" });
    guest.clearMyVote.send({ optionId: "o1" });
  });
  const action_guest_joins = action(() => {
    guest.joinAs.send({ name: "Ada" });
    guest.joinAs.send({ name: "Bo" });
  });
  const action_guest_tries_host_controls = action(() => {
    guest.addOption.send({ title: "Pizza" });
    guest.removeOption.send({ optionId: "o1" });
    guest.resetVotes.send({});
  });

  const assert_starts_empty = assert(() =>
    host[NAME] === "Cozy lunch poll" &&
    host.question === "Where should we eat?" &&
    hasText(host[UI], "Where should we eat?") &&
    host.userCount === 0 &&
    !host.isJoined &&
    hasText(host[UI], "minimal nullable: null")
  );

  const assert_still_unjoined = assert(() =>
    host.userCount === 0 && host.myName === ""
  );

  const assert_host_joined = assert(() =>
    host.userCount === 1 &&
    host.users[0]?.name === "Ada" &&
    host.users[0]?.color === "#2f8a64" &&
    host.myName === "Ada" &&
    host.adminName === "Ada" &&
    host.isJoined &&
    host.isAdmin
  );

  // The computed block that read the nullable value now reads the first
  // option's title, and the blank title was refused.
  const assert_options_added = assert(() =>
    host.optionCount === 2 &&
    host.options[0]?.title === "Sushi" &&
    host.options[0]?.addedByName === "Ada" &&
    hasText(host[UI], "minimal nullable: Sushi") &&
    hasText(row(host[UI], "Tacos"), "added by Ada")
  );

  const assert_sushi_loved = assert(() =>
    host.voteCount === 1 &&
    host.votes[0]?.voteType === "green" &&
    String(buttonStyle(host[UI], "Sushi", "🟢")).includes("#22c55e") &&
    String(buttonStyle(host[UI], "Sushi", "🟡")).includes("opacity: 0.4") &&
    buttonStyle(host[UI], "Tacos", "🟢") === ""
  );

  // Pressing the same vote again takes it back.
  const assert_sushi_unloved = assert(() =>
    host.voteCount === 0 &&
    buttonStyle(host[UI], "Sushi", "🟢") === "" &&
    findNode(row(host[UI], "Sushi"), isButton("Clear")) === undefined
  );

  // A second vote on the same option replaces the first, so Sushi ends on a
  // veto, and the tally ranks Tacos first.
  const assert_sushi_vetoed = assert(() =>
    host.voteCount === 2 &&
    host.votes.some((v) =>
      v.optionId === host.options[0]?.id &&
      v.voteType === "red"
    ) &&
    String(buttonStyle(host[UI], "Sushi", "🔴")).includes("#ef4444") &&
    hasText(row(host[UI], "Tacos"), "#1") &&
    hasText(row(host[UI], "Sushi"), "#2")
  );

  const assert_sushi_cleared = assert(() =>
    host.voteCount === 1 &&
    host.votes[0]?.voteType === "green" &&
    buttonStyle(host[UI], "Sushi", "🔴") === ""
  );

  const assert_sushi_vetoed_again = assert(() =>
    host.voteCount === 2 &&
    String(buttonStyle(host[UI], "Sushi", "🔴")).includes("#ef4444")
  );

  // Removing Sushi takes its veto with it and leaves the vote for Tacos.
  const assert_sushi_removed = assert(() =>
    host.optionCount === 1 &&
    host.options[0]?.title === "Tacos" &&
    host.voteCount === 1 &&
    host.votes[0]?.optionId === host.options[0]?.id &&
    row(host[UI], "Sushi") === undefined &&
    hasText(host[UI], "minimal nullable: Tacos")
  );

  const assert_votes_reset = assert(() =>
    host.voteCount === 0 && host.optionCount === 1
  );

  const assert_guest_vote_refused = assert(() =>
    guest.voteCount === 2 && !guest.isJoined
  );

  const assert_guest_joined = assert(() =>
    guest.userCount === 2 &&
    guest.users[1]?.color === "#c2573a" &&
    guest.myName === "Bo" &&
    guest.adminName === "Ada" &&
    guest.isJoined &&
    !guest.isAdmin
  );

  const assert_guest_host_controls_refused = assert(() =>
    guest.optionCount === 1 &&
    guest.voteCount === 2 &&
    hasText(guest[UI], "minimal nullable: Sushi") &&
    findNode(row(guest[UI], "Sushi"), isButton("✕")) === undefined
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { action: action_join_without_name },
      { assertion: assert_still_unjoined },
      { action: action_join_host },
      { assertion: assert_host_joined },
      { action: action_join_host_again },
      { assertion: assert_host_joined },
      { action: action_add_sushi },
      { action: action_add_tacos },
      { assertion: assert_options_added },
      { action: action_love_sushi },
      { assertion: assert_sushi_loved },
      { action: action_unlove_sushi },
      { assertion: assert_sushi_unloved },
      { action: action_maybe_sushi },
      { action: action_veto_sushi_love_tacos },
      { assertion: assert_sushi_vetoed },
      { action: action_clear_sushi },
      { assertion: assert_sushi_cleared },
      { action: action_veto_sushi_again },
      { assertion: assert_sushi_vetoed_again },
      { action: action_remove_sushi },
      { assertion: assert_sushi_removed },
      { action: action_reset_votes },
      { assertion: assert_votes_reset },

      { action: action_guest_votes_before_joining },
      { assertion: assert_guest_vote_refused },
      { action: action_guest_joins },
      { assertion: assert_guest_joined },
      { action: action_guest_tries_host_controls },
      { assertion: assert_guest_host_controls_refused },
    ],
    host,
    guest,
  };
});
