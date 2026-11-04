/**
 * Home's social-space interface: independent command and observation roles
 * over its owned catalog. Product consumers select the role they use; command
 * bindings carry no collection data. See `docs/features/shared-space-catalog.md`.
 */

import type { Stream } from "commonfabric";
import {
  isSharedSpaceCatalog,
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

/** Home's grouped social-space surface; consumers project individual roles. */
export interface SharedSpaceInterface {
  view: SharedSpaceCollectionView;
  receipts: SharedSpaceReceiptView;
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
