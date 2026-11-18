/**
 * Test: Cozy Poll, driven through its view
 *
 * main.test.tsx drives the poll's streams; this drives the join card, the
 * option draft, and the vote chips, and reads back what the view shows for
 * the state they leave: the header counts, the top choice, the ranked
 * summary, and each option's row. host-controls.test.tsx drives the host's
 * two-step reset and remove.
 */

import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  findElementByText,
  findNodeByProp,
  hasExactText,
  hasText,
  propValue,
  setBound,
} from "../../tools/test-support/vnode-helpers.ts";
import CozyPoll from "./main.tsx";
import {
  chipLabel,
  chipStyle,
  optionRow,
  shows,
  voterChip,
} from "./view-text.ts";

export default pattern(() => {
  const poll = CozyPoll({});

  // === Actions ===

  // No name in the event, and no profile to take one from.
  const action_join_nameless = action(() => poll.joinAs.send({}));
  const action_join_as_alex = action(() => poll.joinAs.send({ name: "Alex" }));

  // Typing into the host's option field, as its `$value` binding does.
  const action_type_pho = action(() =>
    setBound(
      findElement(poll[UI], "cf-input"),
      "$value",
      "  Pho  ",
      "the option field",
    )
  );
  const action_add_ramen = action(() =>
    poll.addOption.send({ title: "Ramen" })
  );
  const action_clear_my_pho_vote = action(() => {
    const pho = poll.options.find((option) => option.title === "Pho");
    if (pho) poll.clearMyVote.send({ optionId: pho.id });
  });

  // === Assertions ===

  const assert_named = assert(() => poll[NAME] === "Cozy poll");

  // Before anyone joins: the join card, which offers to create a profile
  // since the test has none, and no host chip.
  const assert_join_card = assert(() =>
    shows(poll[UI], "Join the poll") &&
    shows(poll[UI], "First to join becomes the host.") &&
    propValue(
        findElementByText(poll[UI], "cf-button", "Create a profile to join"),
        "disabled",
      ) === true &&
    shows(poll[UI], "0 joined · 0 options · 0 votes") &&
    !shows(poll[UI], "HOST")
  );

  const assert_nameless_join_ignored = assert(() =>
    poll.isJoined === false && poll.users.length === 0
  );

  // Alex hosts: the join card gives way to the host chip, his own chip, and
  // the host controls.
  const assert_host_view = assert(() =>
    !shows(poll[UI], "Join the poll") &&
    shows(poll[UI], "HOST") &&
    findNodeByProp(poll[UI], "title", "Alex") !== undefined &&
    shows(poll[UI], "Host controls") &&
    shows(poll[UI], "1 joined · 0 options · 0 votes")
  );

  const assert_empty_draft_adds_nothing = assert(() =>
    poll.optionCount === 0 && shows(poll[UI], "No options yet")
  );

  // The draft is trimmed into an option, and the field is emptied.
  const assert_pho_added_from_draft = assert(() =>
    poll.options.length === 1 &&
    poll.options[0]?.title === "Pho" &&
    propValue(findElement(poll[UI], "cf-input"), "$value") === "" &&
    !shows(poll[UI], "No options yet")
  );

  const assert_two_rows = assert(() =>
    shows(poll[UI], "1 joined · 2 options · 0 votes") &&
    hasText(optionRow(poll[UI], "Pho"), "added by Alex") &&
    hasText(optionRow(poll[UI], "Ramen"), "added by Alex") &&
    !shows(poll[UI], "Top choice")
  );

  // A yellow vote crowns Pho, marks its chip, dims the others in the row, and
  // lists Alex's initial against Pho in the summary of all options.
  const assert_pho_okay = assert(() =>
    poll.votes.length === 1 &&
    poll.votes[0]?.voteType === "yellow" &&
    shows(poll[UI], "Top choice") &&
    shows(poll[UI], "1 okay with it") &&
    chipLabel(optionRow(poll[UI], "Pho"), "🟡") === "Clear my yellow vote" &&
    chipStyle(optionRow(poll[UI], "Pho"), "🟢") === "opacity: 0.4;" &&
    chipLabel(optionRow(poll[UI], "Ramen"), "🟡") === "Okay with it" &&
    chipStyle(optionRow(poll[UI], "Ramen"), "🟢") === "" &&
    hasExactText(voterChip(poll[UI], "Alex"), "A")
  );

  const assert_pho_cleared_by_chip = assert(() =>
    poll.votes.length === 0 && !shows(poll[UI], "Top choice")
  );

  // Green on Ramen, red on Pho: Ramen ranks first, Pho second.
  const assert_ranked = assert(() =>
    poll.votes.length === 2 &&
    shows(poll[UI], "1 love it") &&
    hasText(optionRow(poll[UI], "Ramen"), "#1") &&
    hasText(optionRow(poll[UI], "Pho"), "#2") &&
    chipLabel(optionRow(poll[UI], "Ramen"), "🟢") === "Clear my green vote" &&
    chipLabel(optionRow(poll[UI], "Pho"), "🔴") === "Clear my red vote" &&
    shows(poll[UI], "1 joined · 2 options · 2 votes")
  );

  const assert_pho_vote_cleared = assert(() =>
    poll.votes.length === 1 &&
    poll.votes[0]?.voteType === "green" &&
    chipLabel(optionRow(poll[UI], "Pho"), "🔴") === "Veto"
  );

  return {
    [TESTS]: [
      { assertion: assert_named },
      { assertion: assert_join_card },
      { action: action_join_nameless },
      { assertion: assert_nameless_join_ignored },
      { action: action_join_as_alex },
      { assertion: assert_host_view },

      { press: poll[UI], control: "Add" },
      { assertion: assert_empty_draft_adds_nothing },
      { action: action_type_pho },
      { press: poll[UI], control: "Add" },
      { assertion: assert_pho_added_from_draft },
      { action: action_add_ramen },
      { assertion: assert_two_rows },

      { press: poll[UI], control: "🟡", within: "Pho" },
      { assertion: assert_pho_okay },
      { press: poll[UI], control: "🟡", within: "Pho" },
      { assertion: assert_pho_cleared_by_chip },
      { press: poll[UI], control: "🟢", within: "Ramen" },
      { press: poll[UI], control: "🔴", within: "Pho" },
      { assertion: assert_ranked },
      { action: action_clear_my_pho_vote },
      { assertion: assert_pho_vote_cleared },
    ],
    poll,
  };
});
