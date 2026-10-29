/**
 * Regression test for the "Lunch stats" (`placeStats`) aggregate.
 *
 * Two properties that previously broke:
 *  1. Per-place scoping. Each `logVisit` snapshots EVERY option's votes against
 *     that one visit, so the tallies must count only the votes cast FOR the
 *     visited place (`vh.option_title = v.title`). Before the fix the join was
 *     on `visit_id` alone and summed the whole board.
 *  2. Yellow tally. The query only summed green/red; yellow votes were dropped.
 *
 * Scenario (single identity, host): vote 🟡 on Thai and 🔴 on Chipotle, then log
 * a visit to Thai. Thai's snapshot therefore contains a yellow-for-Thai and a
 * red-for-Chipotle. Correct stats for Thai: 1 visit, 0 green, 1 yellow, 0 red.
 *   - old per-place bug would show reds = 1 (counting the Chipotle veto)
 *   - pre-yellow query had no `yellows` field at all (=> undefined !== 1)
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import CozyPoll, { type LunchProfile } from "./main.tsx";

export default pattern(() => {
  // Identity is a profile cell, so the test claims one instead of a name.
  const alex = Writable.of<LunchProfile>({ name: "Alex" });
  const poll = CozyPoll({});

  const become_alex = action(() => {
    poll.overrideViewer.send({ profile: alex, name: "Alex" });
  });
  const join = action(() => {
    poll.joinAs.send({});
  });
  // Thai is options[0], Chipotle is options[1] (insertion order).
  const add_thai = action(() => {
    poll.addOption.send({ title: "Thai" });
  });
  const add_chipotle = action(() => {
    poll.addOption.send({ title: "Chipotle" });
  });
  const vote_yellow_thai = action(() => {
    const thai = poll.options[0];
    if (thai) poll.castVote.send({ optionId: thai.id, voteType: "yellow" });
  });
  const vote_red_chipotle = action(() => {
    const chipotle = poll.options[1];
    if (chipotle) {
      poll.castVote.send({ optionId: chipotle.id, voteType: "red" });
    }
  });
  const log_thai = action(() => {
    poll.logVisit.send({ title: "Thai" });
  });

  // Only Thai was visited, so placeStats has exactly its row.
  const assert_thai_stats_scoped_and_yellow = assert(() => {
    const s = (poll.placeStats ?? [])[0];
    return !!s &&
      s.title === "Thai" &&
      s.visits === 1 &&
      s.greens === 0 &&
      s.yellows === 1 &&
      s.reds === 0;
  });

  return {
    [TESTS]: [
      { action: become_alex },
      { action: join },
      { action: add_thai },
      { action: add_chipotle },
      { action: vote_yellow_thai },
      { action: vote_red_chipotle },
      { action: log_thai },
      { assertion: assert_thai_stats_scoped_and_yellow },
    ],
  };
});
