/**
 * Test: Cozy Poll's host controls, driven through its view
 *
 * The host's destructive controls each ask before acting: Reset votes, and
 * an option's remove. This presses each, cancels it once, confirms it once,
 * and reads back what the view and the poll show after each step.
 */

import { action, assert, pattern, TESTS, UI } from "commonfabric";
import CozyPoll from "./main.tsx";
import { shows } from "./view-text.ts";

export default pattern(() => {
  const poll = CozyPoll({});

  // === Actions ===

  // Alex hosts two options, and loves Ramen.
  const action_set_up = action(() => {
    poll.joinAs.send({ name: "Alex" });
    poll.addOption.send({ title: "Pho" });
    poll.addOption.send({ title: "Ramen" });
  });
  const action_love_ramen = action(() => {
    const ramen = poll.options.find((option) => option.title === "Ramen");
    if (ramen) poll.castVote.send({ optionId: ramen.id, voteType: "green" });
  });
  const action_remove_unknown_option = action(() =>
    poll.removeOption.send({ optionId: "o_missing" })
  );

  // === Assertions ===

  const assert_set_up = assert(() =>
    poll.isAdmin === true &&
    poll.options.length === 2 &&
    poll.votes.length === 1 &&
    shows(poll[UI], "Reset votes")
  );

  const assert_reset_asks_first = assert(() =>
    shows(poll[UI], "Yes, reset") &&
    !shows(poll[UI], "Reset votes") &&
    poll.votes.length === 1
  );

  const assert_reset_cancelled = assert(() =>
    !shows(poll[UI], "Yes, reset") &&
    shows(poll[UI], "Reset votes") &&
    poll.votes.length === 1
  );

  const assert_reset_done = assert(() =>
    poll.votes.length === 0 && shows(poll[UI], "Reset votes")
  );

  const assert_remove_asks_first = assert(() =>
    shows(poll[UI], 'Remove "Pho" and discard its votes?') &&
    poll.options.length === 2
  );

  const assert_remove_cancelled = assert(() =>
    !shows(poll[UI], 'Remove "Pho" and discard its votes?') &&
    poll.options.length === 2
  );

  const assert_pho_removed = assert(() =>
    poll.options.length === 1 &&
    poll.options[0]?.title === "Ramen" &&
    !shows(poll[UI], 'Remove "Pho" and discard its votes?')
  );

  const assert_unknown_removal_ignored = assert(() =>
    poll.options.length === 1
  );

  // A red vote on the only option still makes it the top choice, flagged.
  const assert_vetoed_top_choice = assert(() =>
    shows(poll[UI], "Top choice") &&
    shows(poll[UI], "1 can't accept") &&
    shows(poll[UI], "1 joined · 1 options · 1 votes")
  );

  return {
    [TESTS]: [
      { action: action_set_up },
      { action: action_love_ramen },
      { assertion: assert_set_up },

      { press: poll[UI], control: "Reset votes" },
      { assertion: assert_reset_asks_first },
      { press: poll[UI], control: "Cancel" },
      { assertion: assert_reset_cancelled },
      { press: poll[UI], control: "Reset votes" },
      { press: poll[UI], control: "Yes, reset" },
      { assertion: assert_reset_done },

      { press: poll[UI], control: "· remove", within: "Pho" },
      { assertion: assert_remove_asks_first },
      { press: poll[UI], control: "Cancel" },
      { assertion: assert_remove_cancelled },
      { press: poll[UI], control: "· remove", within: "Pho" },
      { press: poll[UI], control: "Yes, remove" },
      { assertion: assert_pho_removed },
      { action: action_remove_unknown_option },
      { assertion: assert_unknown_removal_ignored },

      { press: poll[UI], control: "🔴", within: "Ramen" },
      { assertion: assert_vetoed_top_choice },
    ],
    poll,
  };
});
