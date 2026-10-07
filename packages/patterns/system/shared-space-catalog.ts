/**
 * Home's shared-space collection. Registration retains the first accepted
 * route; explicit membership choices compare the revision the user observed,
 * and so does a removal. Handler results describe the action, while the catalog
 * carries membership.
 */

import {
  eventKey,
  handler,
  isWellFormedDID,
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
    reason:
      | "missing"
      | "revision"
      | "action"
      | "unsupported-state"
      | "unsupported-revision";
  };

/** Names one entry to remove, at the revision its remover observed. */
export interface SharedSpaceRemoval {
  space: string;
  expectedRevision: string;
}

/** A removal's outcome, carried by its normal handler receipt. */
export type SharedSpaceRemovalResult =
  | { status: "removed"; space: string }
  | { status: "conflict"; reason: "missing" | "revision" | "offer" };

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

/** Normalizes a bare HTTP or HTTPS origin for an admitted route. */
function normalizeHost(host: string): string {
  const source = host.trim();
  // Check the spelling before URL parsing can erase dot paths, empty query or
  // fragment markers, credentials, backslashes, or embedded whitespace.
  if (!/^https?:\/\/[^/?#\\@\s]+\/?$/i.test(source)) {
    throw new TypeError(
      "Space host must contain only an HTTP or HTTPS origin.",
    );
  }
  try {
    return new URL(source).origin;
  } catch {
    throw new TypeError("Invalid space host URL.");
  }
}

/** Names this event's transition at an exact generation. */
function revisionAt(generation: bigint): string {
  return `${generation}:${eventKey()}`;
}

/** Advances a known generation only when the next token fits the contract. */
function nextRevision(revision: string): string | undefined {
  const match = /^([1-9][0-9]*):.+$/.exec(revision);
  if (!match) return undefined;
  const next = revisionAt(BigInt(match[1]) + 1n);
  return next.length <= 320 ? next : undefined;
}

/** Whether a stored target carries a canonical origin and well-formed DID. */
function validTarget(value: Record<string, unknown>): boolean {
  if (
    !isWellFormedDID(value.space) || !boundedString(value.kind, 32) ||
    typeof value.host !== "string"
  ) return false;
  try {
    return normalizeHost(value.host) === value.host;
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
  return { ...value, host: normalizeHost(value.host) };
}

/** Whether action evidence is understood by this writer. */
function membershipAction(
  value: unknown,
): value is Omit<SharedSpaceMembershipChange, "space"> {
  return plainObject(value) && boundedString(value.id, 320) &&
    boundedString(value.expectedRevision, 320) && membership(value.state);
}

/**
 * Registers an admitted space in `catalog` without changing any existing
 * membership, staging its writes in the transaction of the handler that calls
 * it, so a handler can register a space in the same commit as its own writes.
 * Insert-if-absent: an entry already present for the space keeps its title,
 * membership and revision, and an archived one stays archived. A registration
 * naming an offer records a receipt keyed by the offer's sender and ID, beside
 * the entry, unless one is already there. Returns `conflict` without writing
 * anything when the space is already registered with another host or kind, or
 * the offer's receipt names another target. Call it only from a handler,
 * since a new entry's revision names the handler's event.
 *
 * @throws When `input` is not a valid registration, or `catalog` holds
 *   something other than a valid catalog.
 */
export function registerSharedSpaceIn(
  catalog: Writable<SharedSpaceCatalogStorage>,
  input: SharedSpaceRegistration,
): SharedSpaceRegistrationResult {
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
      revision: revisionAt(1n),
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
}

// Retain every event field for validation, including linked payloads whose
// stored schema would otherwise omit a malformed optional field.
const eventSchema = toSchema<Record<string, any>>();

/**
 * Registers an admitted space without changing any existing membership, as
 * {@link registerSharedSpaceIn} does.
 */
export const registerSharedSpace = handler<
  SharedSpaceRegistration,
  SharedSpaceCatalogState,
  SharedSpaceRegistrationResult
>(
  eventSchema,
  toSchema<SharedSpaceCatalogState>(),
  (input, { catalog }) => registerSharedSpaceIn(catalog, input),
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
    const revision = nextRevision(current.revision);
    if (revision === undefined) {
      return { status: "conflict", reason: "unsupported-revision" };
    }
    catalog.key("entries", change.space, "state").set(change.state);
    catalog.key("entries", change.space, "revision").set(revision);
    catalog.key("entries", change.space, "lastAction").set({
      id: change.id,
      expectedRevision: change.expectedRevision,
      state: change.state,
    });
    return { status: "applied", space: change.space, id: change.id };
  },
);

/**
 * Removes one entry from the catalog, for one purpose only: an application
 * that registered spaces on the person's behalf undoing that import. It is not
 * how a person puts a shared space away (archive is, and nothing a person
 * invokes calls this), and it is not a general way to delete, clean up,
 * repair, or compact entries.
 *
 * It removes the entry only while the entry is still at `expectedRevision`,
 * the revision its caller observed, so a membership choice made since is never
 * lost, and only when no offer receipt names the space: removing such an entry
 * alone leaves an invalid receipt, and removing the receipt as well forgets the
 * offer that it refuses to replay. Removal grants and revokes no access.
 *
 * The rest of a safe undo is the caller's, since only the caller knows it:
 * - remove only entries it can show it registered itself;
 * - keep the complete entry it observed, as its backup, before calling;
 * - stop registering those spaces first, because a later registration admits a
 *   removed space again as a new entry, and a re-admitted invocation of the
 *   original registration recreates it at its original revision.
 *
 * CFS's `share.catalog-undo` is the caller written to these rules.
 */
export const removeSharedSpace = handler<
  SharedSpaceRemoval,
  SharedSpaceCatalogState,
  SharedSpaceRemovalResult
>(
  eventSchema,
  toSchema<SharedSpaceCatalogState>(),
  (removal, { catalog }) => {
    if (
      !plainObject(removal) || !isWellFormedDID(removal.space) ||
      !boundedString(removal.expectedRevision, 320)
    ) {
      throw new TypeError("Invalid shared-space removal.");
    }
    const stored = readSharedSpaceCatalog(catalog);
    const current = stored.entries[removal.space];
    if (!current) return { status: "conflict", reason: "missing" };
    if (current.revision !== removal.expectedRevision) {
      return { status: "conflict", reason: "revision" };
    }
    if (
      Object.values(stored.offers).some((receipt) =>
        receipt.space === removal.space
      )
    ) return { status: "conflict", reason: "offer" };
    // Writing the entries without this one deletes its slot and leaves the
    // others unwritten. `undefined` written at the slot itself would be stored
    // as its value, which the validating reader refuses.
    catalog.key("entries").set(
      Object.fromEntries(
        Object.entries(stored.entries).filter(([space]) =>
          space !== removal.space
        ),
      ),
    );
    return { status: "removed", space: removal.space };
  },
);
