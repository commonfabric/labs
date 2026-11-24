/** Keyed vote entities shared by the isolated reactive-row reproductions. */

import {
  type Default,
  handler,
  type PerSpace,
  type Writable,
} from "commonfabric";

/** Content of one separately stored vote. */
export interface Vote {
  /** Option receiving the vote. */
  optionId: string;

  /** Rendered vote color. */
  color: string;

  /** Linked profile resolved while rendering a swatch. */
  voter: { name: string };
}

/** Shared inputs; the fixtures expose derived rows rather than raw vote data. */
export interface Input {
  /** Stable rows whose nested filters demand matching votes. */
  options?: PerSpace<Default<{ id: string }[], [{ id: "one" }, { id: "two" }]>>;

  /** Membership links to separately stored vote entities. */
  votes?: PerSpace<Default<Vote[], []>>;

  /** Separately stored profiles referenced by votes. */
  profiles?: PerSpace<Default<{ name: string }[], []>>;
}

/** Creates or updates one vote without reading the shared list. */
export const cast = handler<
  { key: string; optionId: string; color: string },
  { votes: Writable<Vote[]>; profiles: Writable<{ name: string }[]> }
>(({ key, optionId, color }, { votes, profiles }) => {
  const voter = profiles.elementById(key);
  if (!voter.get()) {
    voter.set({ name: key });
    profiles.addUnique(voter);
  }
  const vote = votes.elementById(key);
  vote.set({ optionId, color, voter });
  votes.addUnique(vote);
});

/** Changes a linked profile without editing the vote that references it. */
export const rename = handler<
  { key: string; name: string },
  { profiles: Writable<{ name: string }[]> }
>(({ key, name }, { profiles }) => {
  profiles.elementById(key).key("name").set(name);
});

/** Removes a vote's membership link while preserving its keyed entity. */
export const retract = handler<
  { key: string },
  { votes: Writable<Vote[]> }
>(({ key }, { votes }) => {
  votes.removeByValue(votes.elementById(key));
});
