/**
 * Test: Cozy Lunch Poll's host controls
 *
 * The host logs where the group ate, from an option's "✓ we went here" or
 * by its id, backdated through the date field; the log keeps only the most
 * recent visits; and the host deletes a visit, clears the log, and resets
 * the votes, the last two asking first. main.test.tsx drives the same streams
 * headlessly; this presses the controls and reads back what they leave.
 */

import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findNodeByProp,
  hasText,
  propValue,
  setBound,
} from "../../tools/test-support/vnode-helpers.ts";
import CozyPoll, {
  type HistoryEntry,
  type LunchProfile,
  type Vote,
} from "./main.tsx";

// The host's options generate art; the endpoint is mocked so nothing reaches
// a live generator.
export const fetchMocks = [
  {
    urlIncludes: "/api/ai/img",
    contentType: "image/png",
    base64Body:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  },
];

/** Noon on a fixed local day, which the poll reads as now. */
const NOW = new Date(2026, 0, 1, 12).getTime();
const DAY = 86_400_000;

/** How many visits the log keeps. */
const KEPT = 200;

/** The date the host backdates a visit to, as the date field holds it. */
const BACKDATE = "2025-12-25";

/** The visits already logged: as many as are kept, the oldest first. */
const LOGGED: HistoryEntry[] = Array.from({ length: KEPT }, (_, index) => ({
  id: `h_old_${index}`,
  title: `Old ${index}`,
  loggedByName: "",
  wentAt: NOW - (KEPT + 30 - index) * DAY,
  votes: [],
}));

export default pattern(() => {
  const alex = Writable.of<LunchProfile>({ name: "Alex" });
  const visits = Writable.of<HistoryEntry[]>([]);
  const votes = Writable.of<Vote[]>([]);
  const poll = CozyPoll({ clock: { at: NOW }, visits, votes });

  // === Actions ===

  // A full log, and a vote Alex cast yesterday on an option long gone.
  const action_seed = action(() => {
    visits.set(LOGGED);
    votes.set([{
      voter: alex,
      optionId: "o_gone",
      voteType: "red",
      castAt: NOW - DAY,
    }]);
  });
  const action_host = action(() => {
    poll.overrideViewer.send({ profile: alex, name: "Alex" });
    poll.joinAs.send({});
  });
  // Added while a vote is stored, whose option id an option may not take.
  const action_add_options = action(() => {
    poll.addOption.send({ title: "Chipotle" });
    poll.addOption.send({ title: "Thai Kitchen" });
  });
  const action_love_chipotle = action(() => {
    const chipotle = poll.options.find((o) => o.title === "Chipotle");
    if (chipotle) {
      poll.castVote.send({ optionId: chipotle.id, voteType: "green" });
    }
  });
  const action_log_chipotle_by_id = action(() => {
    const chipotle = poll.options.find((o) => o.title === "Chipotle");
    if (chipotle) poll.logVisit.send({ optionId: chipotle.id });
  });
  const action_log_missing_option = action(() =>
    poll.logVisit.send({ optionId: "o_missing" })
  );
  // Typing a date into the field, as its `$value` binding does.
  const action_type_backdate = action(() =>
    setBound(
      findNodeByProp(poll[UI], "type", "date"),
      "$value",
      BACKDATE,
      "the date field",
    )
  );

  // === Assertions ===

  const assert_hosting = assert(() =>
    poll.isAdmin === true &&
    poll.options.length === 2 &&
    poll.historyCount === KEPT &&
    poll.votes.length === 2 &&
    poll.todayVoteCount === 1
  );

  // The log keeps its size, dropping the oldest visit for the newest, whose
  // snapshot holds today's vote and not yesterday's.
  const assert_logged_by_id = assert(() => {
    const newest = poll.recentVisits[0];
    return poll.historyCount === KEPT &&
      poll.mostRecentTitle === "Chipotle" &&
      newest?.wentAt === NOW &&
      newest?.votes.length === 1 &&
      newest?.votes[0]?.optionTitle === "Chipotle" &&
      newest?.votes[0]?.color === "green" &&
      poll.placeStats[0]?.title === "Chipotle" &&
      poll.placeStats[0]?.greens === 1;
  });

  const assert_missing_option_not_logged = assert(() =>
    poll.historyCount === KEPT && poll.mostRecentTitle === "Chipotle"
  );

  // The visit lands on the date typed, and the field empties for the next.
  const assert_backdated = assert(() => {
    const thai = poll.recentVisits.find((v) => v.title === "Thai Kitchen");
    return thai?.wentAt === new Date(2025, 11, 25).getTime() &&
      poll.historyCount === KEPT &&
      poll.mostRecentTitle === "Chipotle" &&
      propValue(findNodeByProp(poll[UI], "type", "date"), "$value") === "" &&
      hasText(
        findNodeByProp(poll[UI], "data-recent-visit-title", "Thai Kitchen"),
        "Thai Kitchen",
      );
  });

  const assert_chipotle_deleted = assert(() =>
    poll.historyCount === KEPT - 1 &&
    poll.recentVisits.every((v) => v.title !== "Chipotle") &&
    findNodeByProp(poll[UI], "data-recent-visit-title", "Chipotle") ===
      undefined
  );

  const assert_clear_asks_first = assert(() =>
    hasText(poll[UI], "Clear all") && poll.historyCount === KEPT - 1
  );

  const assert_clear_cancelled = assert(() =>
    !hasText(poll[UI], "Clear all") && poll.historyCount === KEPT - 1
  );

  const assert_cleared = assert(() =>
    poll.historyCount === 0 && !hasText(poll[UI], "Recently eaten")
  );

  const assert_reset_asks_first = assert(() =>
    hasText(poll[UI], "Yes, reset") && poll.todayVoteCount === 1
  );

  const assert_reset_cancelled = assert(() =>
    !hasText(poll[UI], "Yes, reset") && poll.todayVoteCount === 1
  );

  const assert_reset = assert(() =>
    poll.votes.length === 0 && !hasText(poll[UI], "Yes, reset")
  );

  return {
    [TESTS]: [
      { action: action_seed },
      { action: action_host },
      { action: action_add_options },
      { action: action_love_chipotle },
      { assertion: assert_hosting },

      { action: action_log_chipotle_by_id },
      { assertion: assert_logged_by_id },
      { action: action_log_missing_option },
      { assertion: assert_missing_option_not_logged },
      { action: action_type_backdate },
      { press: poll[UI], control: "✓ we went here", within: "Thai Kitchen" },
      { assertion: assert_backdated },

      { press: poll[UI], control: "✕", within: "Chipotle" },
      { assertion: assert_chipotle_deleted },
      { press: poll[UI], control: "clear all" },
      { assertion: assert_clear_asks_first },
      { press: poll[UI], control: "Cancel" },
      { assertion: assert_clear_cancelled },
      { press: poll[UI], control: "clear all" },
      { press: poll[UI], control: "Clear all" },
      { assertion: assert_cleared },

      { press: poll[UI], control: "Reset votes" },
      { assertion: assert_reset_asks_first },
      { press: poll[UI], control: "Cancel" },
      { assertion: assert_reset_cancelled },
      { press: poll[UI], control: "Reset votes" },
      { press: poll[UI], control: "Yes, reset" },
      { assertion: assert_reset },
    ],
    poll,
  };
});
