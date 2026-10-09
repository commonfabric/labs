import { action, assert, pattern, TESTS, UI } from "commonfabric";
import { dayKeyOf } from "../../../lunch-poll/main.tsx";
import Poll from "./main.tsx";

/** Collects interval diagnostics; render steps declare the enforced limits. */
export const readBudgets = {};

/**
 * The instant the poll's clock is pinned at: noon on the local day. The poll
 * counts only the votes cast on its clock's day, so on the wall clock a run
 * spanning local midnight drops every seeded vote from that count between the
 * two renders, and the second render measures a rebuild of the whole vote view
 * rather than one vote's change.
 */
const START = new Date(2026, 0, 1, 12).getTime();

export default pattern(() => {
  const poll = Poll({});
  return {
    [TESTS]: [
      { action: action(() => poll.setClock.send({ at: START })) },
      {
        action: action(() =>
          poll.seed.send({ voteCount: 296, voterCount: 24, optionCount: 14 })
        ),
      },
      { action: action(() => poll.claim.send({ type: "click" })) },
      {
        assertion: assert(() =>
          poll.voteCount === 296 && poll.userCount === 24 &&
          poll.optionCount === 14 && poll.isJoined &&
          poll.todayDate === dayKeyOf(START)
        ),
      },
      { render: poll[UI], readBudget: { total: 76000, perRun: 31000 } },
      {
        action: action(() =>
          poll.castVote.send({ optionId: "option-0", voteType: "yellow" })
        ),
      },
      { render: poll[UI], readBudget: { total: 67000, perRun: 31000 } },
      {
        assertion: assert(() =>
          poll.voteCount === 296 &&
          poll.todayVoteCount === 296 &&
          poll.votes.filter((vote) => vote.voteType === "yellow").length === 1
        ),
      },
    ],
  };
});
