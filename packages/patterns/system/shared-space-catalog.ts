/**
 * Home's shared-space collection. Registration retains the first accepted
 * route; explicit membership choices compare the revision the user observed.
 * Handler results describe the action, while the catalog carries membership.
 */

import {
  eventKey,
  handler,
  isWellFormedDID,
  normalizeSpaceHost,
  toSchema,
  type Writable,
} from "commonfabric";

/** Collection membership, independent of access to the space. */
export type SharedSpaceMembership = "saved" | "archived";

/** Evidence of the most recent explicit membership choice. */
export interface SharedSpaceMembershipChange {
  space: string;
  id: string;
  expectedRevision: string;
  state: SharedSpaceMembership;
}

/** The retained routing fact and membership of a shared space. */
export interface SharedSpaceEntry {
  space: string;
  host: string;
  kind: string;
  state: string;
  revision: string;
  title?: string;
  from?: string;
  since?: number;
  lastAction?: unknown;
}

/** The immutable target associated with one validated offer. */
export interface SharedSpaceOfferReceipt {
  from: string;
  id: string;
  space: string;
  host: string;
  kind: string;
}

/** A collection keyed by space DID and receipts keyed by sender and offer ID. */
export interface SharedSpaceCatalog {
  entries: Record<string, SharedSpaceEntry>;
  offers: Record<string, SharedSpaceOfferReceipt>;
}

/** A target whose root, access, and kind the registering application vetted. */
export interface SharedSpaceRegistration {
  space: string;
  host: string;
  kind: string;
  title?: string;
  since?: number;
  initialState?: SharedSpaceMembership;
  offer?: { from: string; id: string };
}

/** Registration's outcome, independent of subsequent membership changes. */
export type SharedSpaceRegistrationResult =
  | { status: "registered" | "existing"; space: string }
  | { status: "conflict"; reason: "host" | "kind" | "offer" };

/** A membership action's outcome, carried by its normal handler receipt. */
export type SharedSpaceMembershipResult =
  | { status: "applied" | "confirmed"; space: string; id: string }
  | {
    status: "conflict";
    reason: "missing" | "revision" | "action" | "unsupported-state";
  };

/**
 * The validating reader deliberately selects every stored field. A narrower
 * schema can omit a malformed optional value before the validator sees it.
 */
export type SharedSpaceCatalogStorage = Record<string, any>;

/** The catalog's writable binding, held by Home and its handlers. */
export interface SharedSpaceCatalogState {
  catalog: Writable<SharedSpaceCatalogStorage>;
}

/** Returns the offer identity shared by all collection consumers. */
export function sharedSpaceOfferKey(from: string, id: string): string {
  if (!isWellFormedDID(from) || !boundedString(id, 320)) {
    throw new TypeError("Catalog offer requires a sender DID and stable ID.");
  }
  return JSON.stringify([from, id]);
}

/** Reads an initialized catalog, refusing unavailable or malformed values. */
export function readSharedSpaceCatalog(
  catalog: Writable<SharedSpaceCatalogStorage>,
): SharedSpaceCatalog {
  const value = catalog.get();
  if (!isSharedSpaceCatalog(value)) {
    throw new Error("The shared-space catalog is unavailable or malformed.");
  }
  return value;
}

/** Validates known fields while retaining extra fields and future states. */
export function isSharedSpaceCatalog(
  value: unknown,
): value is SharedSpaceCatalog {
  if (
    !plainObject(value) || !plainObject(value.entries) ||
    !plainObject(value.offers)
  ) return false;
  if (
    !Object.entries(value.entries).every(([space, entry]) =>
      plainObject(entry) && validTarget(entry) && entry.space === space &&
      boundedString(entry.state, 32) && boundedString(entry.revision, 320) &&
      (entry.title === undefined || boundedString(entry.title, 200, true)) &&
      (entry.from === undefined || isWellFormedDID(entry.from)) &&
      (entry.since === undefined || admissionTime(entry.since))
    )
  ) return false;
  const entries = value.entries;
  return Object.entries(value.offers).every(([key, receipt]) => {
    if (
      !plainObject(receipt) || !validTarget(receipt) ||
      !isWellFormedDID(receipt.from) || !boundedString(receipt.id, 320) ||
      key !== sharedSpaceOfferKey(receipt.from, receipt.id)
    ) return false;
    const entry = entries[receipt.space as string];
    return plainObject(entry) && entry.host === receipt.host &&
      entry.kind === receipt.kind;
  });
}

/** Whether a value has the record shape a catalog accepts. */
function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

/** Whether a text value fits its wire contract. */
function boundedString(
  value: unknown,
  max: number,
  empty = false,
): value is string {
  return typeof value === "string" && (empty || value.length > 0) &&
    value.length <= max;
}

/** Whether a timestamp is a nonnegative, exact epoch millisecond. */
function admissionTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Whether a stored target carries a canonical origin and well-formed DID. */
function validTarget(value: Record<string, unknown>): boolean {
  if (
    !isWellFormedDID(value.space) || !boundedString(value.kind, 32) ||
    typeof value.host !== "string"
  ) return false;
  try {
    return normalizeSpaceHost(value.host).origin === value.host;
  } catch {
    return false;
  }
}

/** Whether this writer understands a membership choice. */
function membership(value: unknown): value is SharedSpaceMembership {
  return value === "saved" || value === "archived";
}

/** Validates all values before normalizing the admitted route. */
function normalizeRegistration(
  value: SharedSpaceRegistration,
): SharedSpaceRegistration {
  if (
    !plainObject(value) || !isWellFormedDID(value.space) ||
    typeof value.host !== "string" || !boundedString(value.kind, 32) ||
    (value.initialState !== undefined && !membership(value.initialState)) ||
    (value.title !== undefined && !boundedString(value.title, 200, true)) ||
    (value.since !== undefined && !admissionTime(value.since))
  ) throw new TypeError("Invalid shared-space registration.");
  if (value.offer !== undefined) {
    if (!plainObject(value.offer)) {
      throw new TypeError("Invalid shared-space offer identity.");
    }
    sharedSpaceOfferKey(value.offer.from, value.offer.id);
  }
  return { ...value, host: normalizeSpaceHost(value.host).origin };
}

/** Whether action evidence is understood by this writer. */
function membershipAction(
  value: unknown,
): value is Omit<SharedSpaceMembershipChange, "space"> {
  return plainObject(value) && boundedString(value.id, 320) &&
    boundedString(value.expectedRevision, 320) && membership(value.state);
}

// Retain every event field for validation, including linked payloads whose
// stored schema would otherwise omit a malformed optional field.
const eventSchema = toSchema<Record<string, any>>();

/** Registers an admitted space without changing any existing membership. */
export const registerSharedSpace = handler<
  SharedSpaceRegistration,
  SharedSpaceCatalogState,
  SharedSpaceRegistrationResult
>(
  eventSchema,
  toSchema<SharedSpaceCatalogState>(),
  (input, { catalog }) => {
    const registration = normalizeRegistration(input);
    const stored = readSharedSpaceCatalog(catalog);
    const { space, host, kind, title, offer } = registration;
    const current = stored.entries[space];
    if (current && current.host !== host) {
      return {
        status: "conflict",
        reason: "host",
      };
    }
    if (current && current.kind !== kind) {
      return {
        status: "conflict",
        reason: "kind",
      };
    }
    const key = offer && sharedSpaceOfferKey(offer.from, offer.id);
    const receipt = key && stored.offers[key];
    if (
      receipt &&
      (receipt.space !== space || receipt.host !== host ||
        receipt.kind !== kind)
    ) return { status: "conflict", reason: "offer" };
    if (!current) {
      catalog.key("entries", space).set({
        space,
        host,
        kind,
        ...(title === undefined ? {} : { title }),
        ...(offer === undefined ? {} : { from: offer.from }),
        since: registration.since ?? Date.now(),
        state: registration.initialState ?? "saved",
        revision: eventKey(),
      });
    }
    if (key && offer && !receipt) {
      catalog.key("offers", key).set({
        from: offer.from,
        id: offer.id,
        space,
        host,
        kind,
      });
    }
    return { status: current ? "existing" : "registered", space };
  },
);

/** Applies the user's choice only to the revision they observed. */
export const changeSharedSpaceMembership = handler<
  SharedSpaceMembershipChange,
  SharedSpaceCatalogState,
  SharedSpaceMembershipResult
>(
  eventSchema,
  toSchema<SharedSpaceCatalogState>(),
  (change, { catalog }) => {
    if (
      !plainObject(change) || !isWellFormedDID(change.space) ||
      !membershipAction(change)
    ) {
      throw new TypeError("Invalid shared-space membership action.");
    }
    const current = readSharedSpaceCatalog(catalog).entries[change.space];
    if (!current) return { status: "conflict", reason: "missing" };
    if (!membership(current.state)) {
      return {
        status: "conflict",
        reason: "unsupported-state",
      };
    }
    const last = current.lastAction;
    if (
      last !== undefined &&
      (!membershipAction(last) || last.state !== current.state)
    ) {
      return { status: "conflict", reason: "action" };
    }
    if (last?.id === change.id) {
      return last.expectedRevision === change.expectedRevision &&
          last.state === change.state
        ? { status: "confirmed", space: change.space, id: change.id }
        : { status: "conflict", reason: "action" };
    }
    if (current.revision !== change.expectedRevision) {
      return {
        status: "conflict",
        reason: "revision",
      };
    }
    catalog.key("entries", change.space, "state").set(change.state);
    catalog.key("entries", change.space, "revision").set(eventKey());
    catalog.key("entries", change.space, "lastAction").set({
      id: change.id,
      expectedRevision: change.expectedRevision,
      state: change.state,
    });
    return { status: "applied", space: change.space, id: change.id };
  },
);
