import {
  action,
  assert,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findNodeByProp } from "../test/vnode-helpers.ts";
import CozyPoll, {
  type LunchProfile,
  type Option,
  type User,
  type Vote,
  voteKeyFor,
} from "./main.tsx";

const OPTIONS: Option[] = Array.from({ length: 14 }, (_, index) => ({
  id: `option-${index}`,
  title: `Lunch ${index}`,
  addedByName: "Fixture",
  imageUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
}));

const NAMES = ["Alex", "Blair", "Casey", "Drew", "Eli", "Fran", "Gale", "Hal"];

/**
 * The instant the poll reads as now, and every seeded vote's stamp: noon on a
 * fixed local day, so what the poll counts as today's votes does not depend on
 * where the run falls against a day boundary.
 */
const NOW = new Date(2026, 0, 1, 12).getTime();

export default pattern(() => {
  const people = NAMES.map((name) => ({
    name,
    profile: Writable.of<LunchProfile>({ name }),
  }));
  const users = Writable.of<User[]>([]);
  const votes = Writable.of<Vote[]>([]);
  const poll = CozyPoll({
    options: OPTIONS,
    users,
    votes,
    clock: { at: NOW },
  });

  const seed = action(() => {
    users.set(people.map(({ name, profile }) => ({
      name,
      profile,
      color: "#2f6f4e",
    })));
    Array.from({ length: 74 }, (_, index) => index).forEach((index) => {
      const optionId = `option-${index % 14}`;
      const voter = people[Math.floor(index / 14)].profile.resolveAsCell();
      const key = voteKeyFor(voter, optionId);
      if (key === undefined) throw new Error("Fixture voter has no identity");
      const vote = votes.elementById(key);
      vote.set({ optionId, voter, voteType: "green", castAt: NOW });
      votes.addUnique(vote);
    });
  });
  const claimViewer = action(() => {
    poll.overrideViewer.send({
      profile: people[0].profile,
      name: people[0].name,
    });
  });
  const changeVote = action(() => {
    poll.castVote.send({ optionId: "option-0", voteType: "yellow" });
  });

  const populated = assert(() =>
    poll.optionCount === 14 && poll.userCount === 8 &&
    poll.voteCount === 74 && poll.todayVoteCount === 74 && poll.isJoined
  );
  const allCardsVisible = assert(() =>
    OPTIONS.every((option) =>
      findNodeByProp(poll[UI], "data-option-title", option.title) !== undefined
    )
  );
  const totalsPreserved = assert(() =>
    poll.voteCount === 74 && poll.todayVoteCount === 74 &&
    poll.votes.filter((vote) => vote.voteType === "yellow").length === 1
  );
  const voteChanged = assert(() =>
    poll.votes.some((vote) =>
      vote.optionId === "option-0" && vote.voteType === "yellow" &&
      equals(vote.voter, people[0].profile)
    )
  );
  const changedCardVisible = assert(() =>
    findNodeByProp(poll[UI], "aria-label", "Clear my yellow vote") !== undefined
  );

  return {
    [UI]: poll[UI],
    [TESTS]: [
      { action: seed },
      { action: claimViewer },
      { assertion: populated },
      { assertion: allCardsVisible },
      { action: changeVote },
      { assertion: totalsPreserved },
      { assertion: voteChanged },
      { assertion: changedCardVisible },
      { settle: true },
    ],
  };
});
