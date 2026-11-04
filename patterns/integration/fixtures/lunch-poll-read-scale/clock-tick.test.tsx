import { action, assert, pattern, TESTS, UI } from "commonfabric";
import Poll from "./main.tsx";

/** Collects interval diagnostics; the second render declares the limit. */
export const readBudgets = {};

/**
 * The instant the poll's clock starts at: noon on the local day, twelve hours
 * from either boundary, so the five-minute step below stays inside one day
 * wherever this runs. The poll reads the day off the local calendar, so an
 * instant fixed in UTC would sit on the boundary itself under `TZ=UTC`.
 */
const START = new Date(2026, 0, 1, 12).getTime();

/** What a `#now/300` tick advances the clock by. */
const TICK = 300_000;

/**
 * The poll's current-day vote filter costs nothing when the clock ticks inside
 * one day. The clock advances by one tick between two renders of a seeded poll
 * and the second render's reads are held to a figure that a rescan of the 74
 * votes, which costs upwards of 200 accesses, cannot fit inside.
 */
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
          poll.voteCount === 74 && poll.todayVoteCount === 74 && poll.isJoined
        ),
      },
      { render: poll[UI] },
      { action: action(() => poll.setClock.send({ at: START + TICK })) },
      { render: poll[UI], readBudget: { total: 100, perRun: 50 } },
      { assertion: assert(() => poll.todayVoteCount === 74) },
      // The epoch is an instant like any other, so a clock reading zero is a
      // day rather than a clock that has not resolved. Which local day it is
      // depends on the zone, so the assertion is that the poll names one.
      { action: action(() => poll.setClock.send({ at: 0 })) },
      { assertion: assert(() => poll.todayDate !== "") },
    ],
  };
});
