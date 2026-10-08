/**
 * Advances a populated lunch poll across local days.
 * Stored votes survive; the current-day view and option summaries
 * follow the clock, including when a participant votes again.
 */

import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import { findNodeByProp, hasText } from "../test/vnode-helpers.ts";
import CozyPoll, {
  dayKeyOf,
  type LunchProfile,
  type User,
  type Vote,
  voteKeyFor,
} from "./main.tsx";

const MONDAY = new Date(2026, 9, 5, 12).getTime();
const TUESDAY = new Date(2026, 9, 6, 12).getTime();

export default pattern(() => {
  const alex = Writable.of<LunchProfile>({ name: "Alex" });
  const blair = Writable.of<LunchProfile>({ name: "Blair" });
  const votes = Writable.of<Vote[]>([]);
  const users = Writable.of<User[]>([]);
  const clock = Writable.of({ at: MONDAY });
  const poll = CozyPoll({
    options: [
      { id: "soup", title: "Soup", addedByName: "Alex", imageUrl: "" },
      { id: "salad", title: "Salad", addedByName: "Alex", imageUrl: "" },
    ],
    votes,
    users,
    clock,
  });

  const seed = action(() => {
    users.set([
      { name: "Alex", color: "#2f6f4e", profile: alex },
      { name: "Blair", color: "#c2573a", profile: blair },
    ]);
    [alex, blair].forEach((profile) => {
      const voter = profile.resolveAsCell();
      const key = voteKeyFor(voter, "soup");
      if (key === undefined) throw new Error("Fixture voter has no identity");
      const vote = votes.elementById(key);
      vote.set({ voter, optionId: "soup", voteType: "green", castAt: MONDAY });
      votes.addUnique(vote);
    });
  });
  const claimViewer = action(() => {
    poll.overrideViewer.send({ profile: alex, name: "Alex" });
  });
  const nextDay = action(() => clock.set({ at: TUESDAY }));
  const voteAgain = action(() =>
    poll.castVote.send({ optionId: "salad", voteType: "green" })
  );
  const mondayCounts = assert(() =>
    poll.todayDate === dayKeyOf(MONDAY) && poll.todayVoteCount === 2 &&
    poll.voteCount === 2
  );
  const mondaySummary = assert(() =>
    findNodeByProp(poll[UI], "data-vote-swatch-name", "Blair") !== undefined &&
    hasText(poll[UI], "2 love it")
  );
  const tuesdayCounts = assert(() =>
    poll.todayDate === dayKeyOf(TUESDAY) && poll.todayVoteCount === 0 &&
    poll.voteCount === 2
  );
  const tuesdaySummary = assert(() =>
    findNodeByProp(poll[UI], "data-vote-swatch-name", "Blair") === undefined &&
    findNodeByProp(poll[UI], "data-vote-swatch-name", "Alex") === undefined
  );
  const newVoteCounts = assert(() =>
    poll.todayVoteCount === 1 && poll.voteCount === 3 &&
    poll.todaysVotes[0].optionId === "salad"
  );
  const newVoteSummary = assert(() =>
    findNodeByProp(poll[UI], "data-vote-swatch-name", "Blair") === undefined &&
    findNodeByProp(poll[UI], "data-vote-swatch-name", "Alex") !== undefined &&
    hasText(poll[UI], "1 love it")
  );

  return {
    [UI]: poll[UI],
    poll,
    [TESTS]: [
      { action: seed },
      { action: claimViewer },
      { assertion: mondayCounts },
      { assertion: mondaySummary },
      { action: nextDay },
      { assertion: tuesdayCounts },
      { assertion: tuesdaySummary },
      { action: voteAgain },
      { assertion: newVoteCounts },
      { assertion: newVoteSummary },
    ],
  };
});
