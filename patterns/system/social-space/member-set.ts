/**
 * A social space's members, joined from the two places they are recorded: the
 * space's access list, which says who belongs, and its roster, which holds the
 * profiles people joined with. A roster entry is a claim anyone in the space
 * can add, so only the access list decides membership.
 */

import {
  equalsKey,
  joinSpaceMembers,
  profileOwnerOf,
  type SpaceMemberList,
  type SpaceMemberOf,
} from "commonfabric";
import type { ParticipantProfile } from "../loom/participants.tsx";

/** One member of a social space, with the roster's profiles of their own. */
export type SpaceMember = SpaceMemberOf<ParticipantProfile>;

/**
 * Returns the members of a social space whose access list is `list` and whose
 * roster is `roster`: one for each principal `list` names, sorted by DID,
 * each with the profiles on `roster` that are that principal's own. `list`'s
 * `"*"` entry names no one, so it adds no member, and a profile that is no
 * one's, or whose owner `list` does not name, is left out. `undefined` while
 * `list` is, so a reader can tell "not known yet" from "nobody".
 *
 * It is `joinSpaceMembers()`, the join a host applies too, with whose own a
 * profile is from `profileOwnerOf()`, the ownership rule every other reader
 * of whose a profile is applies, so a profile counts toward a member exactly
 * when it counts as theirs anywhere else. Call it where `profileOwnerOf()`
 * can be called, in a reactive computation or a handler; a profile still
 * loading counts toward no one until it arrives. A profile `roster` lists
 * more than once, as a roster joined from several does, is one profile,
 * compared with `equalsKey()`, and is counted once.
 */
export const memberSet = (
  roster: readonly ParticipantProfile[],
  list: SpaceMemberList | undefined,
): SpaceMember[] | undefined =>
  joinSpaceMembers(roster, list, profileOwnerOf, equalsKey);
