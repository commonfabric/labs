/**
 * A social space's members, joined from the two places they are recorded: the
 * space's access list, which says who belongs, and its roster, which holds the
 * profiles people joined with. A roster entry is a claim anyone in the space
 * can add, so only the access list decides membership. The join is the one
 * every reader of a space's members applies, in pattern code
 * (`joinSpaceMembers` in the pattern API) and on a host (`spaceMembersAt()`).
 */

import type {
  DID,
  JoinSpaceMembersFunction,
  SpaceMemberList,
  SpaceMemberOf,
} from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";

import { spaceMemberListAt } from "./builder/space-access.ts";
import type { Cell } from "./cell.ts";
import { linkEqualityKey } from "./link-equality.ts";
import { profileOwnerAt } from "./profile-owner.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/**
 * Returns the members of a social space whose access list is `list` and whose
 * roster is `roster`, as `JoinSpaceMembersFunction` in the pattern API states:
 * one for each principal `list` names, sorted by DID, each with the profiles
 * on `roster` whose owner, as `ownerOf` returns it, is that principal, each
 * once by `keyOf`, in the order `roster` first lists them. `undefined` while
 * `list` is.
 */
export const joinSpaceMembers: JoinSpaceMembersFunction = <P>(
  roster: readonly P[],
  list: SpaceMemberList | undefined,
  ownerOf: (profile: P) => DID | undefined,
  keyOf: (profile: P) => string | undefined,
): SpaceMemberOf<P>[] | undefined => {
  if (list === undefined) return undefined;
  const members = new Map<DID, SpaceMemberOf<P>>(
    (Object.entries(list.principals) as [DID, SpaceMemberOf<P>["level"]][])
      .map(([principal, level]) => [
        principal,
        { principal, level, profiles: [] },
      ]),
  );
  const seenKeys = new Set<string>();
  const seenUnkeyed = new Set<P>();
  for (const profile of roster) {
    const owner = ownerOf(profile);
    const member = owner === undefined ? undefined : members.get(owner);
    if (member === undefined) continue;
    // A profile with no key is the same as nothing but itself.
    const key = keyOf(profile);
    const seen = key === undefined
      ? seenUnkeyed.has(profile)
      : seenKeys.has(key);
    if (seen) continue;
    if (key === undefined) seenUnkeyed.add(profile);
    else seenKeys.add(key);
    member.profiles.push(profile);
  }
  // The keys are distinct, so no two members compare equal.
  return [...members.values()].sort((a, b) =>
    a.principal < b.principal ? -1 : 1
  );
};

/**
 * Returns the members of `space`, read through `tx`, whose roster is
 * `roster`: {@link joinSpaceMembers} over the list `spaceMemberListAt()`
 * reads. Each profile's owner is the one `profileOwnerAt()` reads, and two
 * profiles count as one when their links, resolved in `tx`, are the same. It
 * is the join pattern code makes with `profileOwnerOf` and `equalsKey`, for a
 * host. `undefined` while `spaceMemberListAt()` returns it.
 *
 * The caller loads each profile on `roster` and the documents its name links
 * through before the call, for example with `loadProfileOwnerDocuments()`. A
 * profile that is not loaded counts toward no one.
 *
 * @throws What `profileOwnerAt()` throws.
 */
export function spaceMembersAt(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  roster: readonly Cell<unknown>[],
): SpaceMemberOf<Cell<unknown>>[] | undefined {
  return joinSpaceMembers(
    roster,
    spaceMemberListAt(runtime, tx, space),
    (profile) => profileOwnerAt(runtime, tx, profile),
    (profile) => linkEqualityKey(profile, undefined, true, tx, runtime),
  );
}
