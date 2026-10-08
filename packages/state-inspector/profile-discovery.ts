/**
 * Finds the profiles a snapshot of space databases names, offline and
 * read-only, for an operator repairing profiles across a whole store. What it
 * reports is what the snapshot stored; a live reader decides from the live
 * store whether anything it names still is a profile.
 */

import {
  type FabricValue,
  isFabricPlainObject,
} from "@commonfabric/data-model";

import { openSpace } from "./db.ts";
import type { DiscoveredSpace } from "./discover.ts";
import { homeProfileLinks } from "./grouping.ts";
import { candidatesMatching, reconstructDocument } from "./reconstruct.ts";

/** A profile a Home lists, as the Home's list stores the link to it. */
export interface ListedProfile {
  /** The Home space listing it, which is its owner's DID. */
  home: string;

  /** The profile's space. */
  space: string;

  /** The id the list's link names: the slot that links on to the profile. */
  id: string;
}

/** A profile-shaped piece in a space that no Home in the snapshot lists. */
export interface UnlistedProfile {
  /** The space holding it. */
  space: string;

  /** The piece's id. */
  id: string;
}

/** Every profile a snapshot of spaces names, sorted by space then id. */
export interface ProfileDiscovery {
  listed: ListedProfile[];
  unlisted: UnlistedProfile[];
}

/**
 * Whether `value` has the shape of a profile piece's result: its `name`, and
 * the `setName` and `setAvatar` streams a profile exposes. It is a shape test
 * over stored data and no more; what a live reader trusts is the profile's
 * label.
 */
function isProfileResultValue(value: FabricValue): boolean {
  return isFabricPlainObject(value) && "name" in value &&
    "setName" in value && "setAvatar" in value;
}

/**
 * Finds the profiles in a snapshot of spaces, read offline and read-only.
 * `listed` holds each link a Home's `profiles` list stores. `unlisted` holds
 * each profile-shaped piece in a space no listed link names, which a
 * snapshot can hold when the Home listing it is absent from the snapshot or
 * no longer lists it. A file that is not a readable memory database is
 * skipped, whether or not it opens as SQLite.
 */
export function discoverProfiles(
  discovered: readonly DiscoveredSpace[],
  opts: { branch?: string } = {},
): ProfileDiscovery {
  const branch = opts.branch ?? "";
  const scope = "space";
  const listed: ListedProfile[] = [];
  const shaped: UnlistedProfile[] = [];
  for (const d of discovered) {
    let space;
    try {
      space = openSpace(d.path);
    } catch {
      continue;
    }
    const spaceListed: ListedProfile[] = [];
    const spaceShaped: UnlistedProfile[] = [];
    try {
      for (const link of homeProfileLinks(space, { branch, scope }) ?? []) {
        if (link.space && link.id) {
          spaceListed.push({ home: d.did, space: link.space, id: link.id });
        }
      }
      for (
        const id of candidatesMatching(space, {
          branch,
          scope,
          like: ["%setName%", "%setAvatar%"],
        })
      ) {
        let doc;
        try {
          doc = reconstructDocument(space, { id, branch, scope });
        } catch {
          continue;
        }
        if (isProfileResultValue(doc?.value)) {
          spaceShaped.push({ space: d.did, id });
        }
      }
    } catch {
      // A file that opens as SQLite but holds no memory space is skipped
      // whole, so nothing half-read from it is reported.
      continue;
    } finally {
      space.close();
    }
    for (const profile of spaceListed) listed.push(profile);
    for (const profile of spaceShaped) shaped.push(profile);
  }
  const listedSpaces = new Set(listed.map((p) => p.space));
  const order = <T extends { space: string; id: string }>(a: T, b: T) =>
    a.space === b.space
      ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      : (a.space < b.space ? -1 : 1);
  return {
    listed: listed.sort(order),
    unlisted: shaped.filter((p) => !listedSpaces.has(p.space)).sort(order),
  };
}
