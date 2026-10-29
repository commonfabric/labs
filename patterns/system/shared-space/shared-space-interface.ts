/**
 * Home's social-space interface: independent command and observation roles
 * over its owned catalog. Product consumers select the role they use; command
 * bindings carry no collection data. See `docs/features/shared-space-catalog.md`.
 */

import type { Stream } from "commonfabric";
import {
  isSharedSpaceCatalog,
  isSharedSpaceProfileRecord,
  isSharedSpaceProfileStorage,
  type SharedSpaceEntry,
  type SharedSpaceMembershipChange,
  type SharedSpaceMembershipResult,
  type SharedSpaceOfferReceipt,
  type SharedSpaceRegistration,
  type SharedSpaceRegistrationResult,
  type SharedSpaceRemoval,
  type SharedSpaceRemovalResult,
} from "./shared-space-catalog.ts";

/** Commands for admitting a vetted space and choosing its membership. */
export interface SharedSpaceCommands {
  register: Stream<SharedSpaceRegistration, SharedSpaceRegistrationResult>;
  changeMembership: Stream<
    SharedSpaceMembershipChange,
    SharedSpaceMembershipResult
  >;
}

/** An application's undo of its own import, under the removal contract. */
export interface SharedSpaceImportCommands {
  remove: Stream<SharedSpaceRemoval, SharedSpaceRemovalResult>;
}

/** Membership partitions for one kind, including unfamiliar stored states. */
export interface SharedSpaceKindView {
  saved: SharedSpaceEntry[];
  archived: SharedSpaceEntry[];
  other: SharedSpaceEntry[];
}

/** A catalog that has not produced a usable value. */
export interface SharedSpaceUnavailable {
  status: "unavailable";
  reason: "loading" | "malformed";
}

/**
 * A reactive collection observation. Entries retain their opaque revision and
 * extension fields; lists display admission hints, then space DID.
 * Availability describes this observation, not durable command completion.
 */
export type SharedSpaceCollectionView = SharedSpaceUnavailable | {
  status: "ready";
  entries: Record<string, SharedSpaceEntry>;
  saved: SharedSpaceEntry[];
  archived: SharedSpaceEntry[];
  other: SharedSpaceEntry[];
  byKind: Record<string, SharedSpaceKindView>;
};

/** Validated admission receipts, observed independently of collection lists. */
export type SharedSpaceReceiptView = SharedSpaceUnavailable | {
  status: "ready";
  offers: Record<string, SharedSpaceOfferReceipt>;
};

/**
 * Which of the person's profiles acts in one social space, as Home records
 * it. `unrecorded`: Home records none, as for a space a registration naming
 * no profile admitted. `unreadable`: Home holds a record this reader cannot
 * read. `live`: the record names `profile`, one of the person's profiles.
 * `retired`: the record names `profile`, one of the person's profiles that
 * they have retired. `foreign`: the record names `profile`, which is not one
 * of the person's own profiles now: Home does not list it, or it is not the
 * person's own by the rule every reader of a person's profiles applies
 * (`profileOwnerOf()`). None of these means the person's default profile.
 */
export type SharedSpaceProfile =
  | { status: "unrecorded" | "unreadable" }
  | { status: "live" | "retired" | "foreign"; profile: string };

/**
 * The profile acting in each space the catalog holds an entry for, keyed by
 * the space's DID, observed as the collection is. A space the catalog holds
 * no entry for has no key. `live` lists the spaces of the profiles Home
 * lists that are the person's own and not retired, those a registration can
 * record, so that a reader holding an offer whose profile was not one of them
 * learns when it becomes one.
 */
export type SharedSpaceProfileView = SharedSpaceUnavailable | {
  status: "ready";
  spaces: Record<string, SharedSpaceProfile>;
  live: string[];
};

/** Home's grouped social-space surface; consumers project individual roles. */
export interface SharedSpaceInterface {
  view: SharedSpaceCollectionView;
  receipts: SharedSpaceReceiptView;
  profiles: SharedSpaceProfileView;
  commands: SharedSpaceCommands;
  imports: SharedSpaceImportCommands;
}

/** Orders admission hints with a deterministic identity tie-breaker. */
function compareEntries(a: SharedSpaceEntry, b: SharedSpaceEntry): number {
  // Validated DID Core identifiers are ASCII, whose text and UTF-8 orders agree.
  return (b.since ?? 0) - (a.since ?? 0) ||
    (a.space < b.space ? -1 : a.space > b.space ? 1 : 0);
}

/** Partitions entries without treating an unfamiliar state as saved. */
function partition(entries: SharedSpaceEntry[]): SharedSpaceKindView {
  return {
    saved: entries.filter((entry) => entry.state === "saved"),
    archived: entries.filter((entry) => entry.state === "archived"),
    other: entries.filter((entry) =>
      entry.state !== "saved" && entry.state !== "archived"
    ),
  };
}

/** Groups an ordered collection in one pass, retaining the order per kind. */
function byKind(
  entries: SharedSpaceEntry[],
): Record<string, SharedSpaceKindView> {
  const groups = new Map<string, SharedSpaceKindView>();
  for (const entry of entries) {
    const group = groups.get(entry.kind) ??
      { saved: [], archived: [], other: [] };
    groups.set(entry.kind, group);
    const list = entry.state === "saved"
      ? group.saved
      : entry.state === "archived"
      ? group.archived
      : group.other;
    list.push(entry);
  }
  const result: Record<string, SharedSpaceKindView> = Object.create(null);
  for (const [kind, group] of groups) result[kind] = group;
  return result;
}

/**
 * Validates a complete stored catalog before constructing its collection view.
 * An unfinished or malformed observation remains explicitly unavailable.
 */
export function sharedSpaceCollectionViewOf(
  value: unknown,
): SharedSpaceCollectionView {
  if (!isSharedSpaceCatalog(value)) {
    return {
      status: "unavailable",
      reason: value === undefined ? "loading" : "malformed",
    };
  }
  const entries = Object.values(value.entries).sort(compareEntries);
  return {
    status: "ready",
    entries: value.entries,
    ...partition(entries),
    byKind: byKind(entries),
  };
}

/** Validates a complete stored catalog before exposing its offer receipts. */
export function sharedSpaceReceiptViewOf(
  value: unknown,
): SharedSpaceReceiptView {
  return isSharedSpaceCatalog(value)
    ? { status: "ready", offers: value.offers }
    : {
      status: "unavailable",
      reason: value === undefined ? "loading" : "malformed",
    };
}

/**
 * Says which profile acts in each space `collection` lists, from `records`,
 * Home's records of the profile acting in each space, `retired`, the spaces
 * of the profiles Home lists as retired, and `own`, the spaces of the
 * profiles Home lists that are the person's own by the label on their name.
 * The observation is unavailable for the reason `collection` is, while
 * `records`, `retired` or `own` is unfinished, `undefined`, and as malformed
 * when `records` is malformed or a listed profile's space cannot be read.
 */
export function sharedSpaceProfileViewOf(
  collection: SharedSpaceCollectionView | undefined,
  records: unknown,
  retired: readonly (string | undefined)[] | undefined,
  own: readonly (string | undefined)[] | undefined,
): SharedSpaceProfileView {
  if (collection?.status === "unavailable") return collection;
  if (
    collection === undefined || records === undefined ||
    retired === undefined || own === undefined
  ) return { status: "unavailable", reason: "loading" };
  if (
    !isSharedSpaceProfileStorage(records) || retired.includes(undefined) ||
    own.includes(undefined)
  ) return { status: "unavailable", reason: "malformed" };
  const spaces: Record<string, SharedSpaceProfile> = Object.create(null);
  for (const space of Object.keys(collection.entries)) {
    const record = Object.hasOwn(records, space) ? records[space] : undefined;
    spaces[space] = record === undefined
      ? { status: "unrecorded" }
      : !isSharedSpaceProfileRecord(record, space)
      ? { status: "unreadable" }
      : {
        status: !own.includes(record.profile)
          ? "foreign"
          : retired.includes(record.profile)
          ? "retired"
          : "live",
        profile: record.profile,
      };
  }
  return {
    status: "ready",
    spaces,
    live: own.filter((space): space is string =>
      space !== undefined && !retired.includes(space)
    ),
  };
}
