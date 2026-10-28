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
          poll.seed.send({ voteCount: 74, voterCount: 8, optionCount: 14 })
        ),
      },
      { action: action(() => poll.claim.send({ type: "click" })) },
      {
        assertion: assert(() =>
          poll.voteCount === 74 && poll.userCount === 8 &&
          poll.optionCount === 14 && poll.isJoined &&
          poll.todayDate === dayKeyOf(START)
        ),
      },
      { render: poll[UI], readBudget: { total: 6000, perRun: 300 } },
      {
        action: action(() =>
          poll.castVote.send({ optionId: "option-0", voteType: "yellow" })
        ),
      },
      { render: poll[UI], readBudget: { total: 1100, perRun: 300 } },
      {
        assertion: assert(() =>
          poll.voteCount === 74 &&
          poll.todayVoteCount === 74 &&
          poll.votes.filter((vote) => vote.voteType === "yellow").length === 1
        ),
      },
    ],
  };
});
