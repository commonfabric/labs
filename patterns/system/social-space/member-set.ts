/**
 * A social space's members, joined from the two places they are recorded: the
 * space's access list, which says who belongs, and its roster, which holds the
 * profiles people joined with. A roster entry is a claim anyone in the space
 * can add, so only the access list decides membership.
 */

import {
  profileOwnerOf,
  type SpaceGrantLevel,
  type SpaceMemberList,
} from "commonfabric";
import type { ParticipantProfile } from "../loom/participants.tsx";

/** One member of a social space. */
export interface SpaceMember {
  /** The principal's DID, as the space's access list names it. */
  principal: string;

  /** The level the access list's entry for `principal` grants. */
  level: SpaceGrantLevel;

  /**
   * The roster's profiles that are `principal`'s own, in roster order, and
   * empty for a member with none there. A reader that shows one face for the
   * member shows the first.
   */
  profiles: ParticipantProfile[];
}

/**
 * Returns the members of a social space whose access list is `list` and whose
 * roster is `roster`: one for each principal `list` names, sorted by DID,
 * each with the profiles on `roster` that are that principal's own. `list`'s
 * `"*"` entry names no one, so it adds no member, and a profile that is no
 * one's, or whose owner `list` does not name, is left out. `undefined` while
 * `list` is, so a reader can tell "not known yet" from "nobody".
 *
 * Whose own a profile is comes from `profileOwnerOf()`, the ownership rule
 * every other reader of whose a profile is applies, so a profile counts
 * toward a member exactly when it counts as theirs anywhere else. Call it
 * where `profileOwnerOf()` can be called, in a reactive computation or a
 * handler; a profile still loading counts toward no one until it arrives.
 */
export const memberSet = (
  roster: readonly ParticipantProfile[],
  list: SpaceMemberList | undefined,
): SpaceMember[] | undefined => {
  if (list === undefined) return undefined;
  const members = new Map<string, SpaceMember>(
    Object.entries(list.principals).map(([principal, level]) => [
      principal,
      { principal, level, profiles: [] },
    ]),
  );
  for (const profile of roster) {
    const owner = profileOwnerOf(profile);
    if (owner !== undefined) members.get(owner)?.profiles.push(profile);
  }
  // The keys are distinct, so no two members compare equal.
  return [...members.values()].sort((a, b) =>
    a.principal < b.principal ? -1 : 1
  );
};
