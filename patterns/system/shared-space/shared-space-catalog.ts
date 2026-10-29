/**
 * Home's shared-space collection. Registration retains the first accepted
 * route; explicit membership choices compare the revision the user observed,
 * and so does a removal. A retitle refreshes an entry's display title and
 * nothing else. Registration also records which of the person's profiles
 * acts in the space, once, beside the catalog. Handler results describe the
 * action, while the catalog and those records carry membership.
 */

import {
  type Cell,
  eventKey,
  handler,
  isWellFormedDID,
  profileOwnerOf,
  resultOwnerOf,
  spaceOf,
  toSchema,
  type Writable,
  type WriteAuthorizedBy,
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

  /**
   * Why the profile the offer's registration named was not recorded as the
   * one acting in the space, when it was not: Home records another profile
   * for the space, or holds a record it cannot read (`profile`), or the
   * profile is not one Home lists (`unknown-profile`).
   */
  profileConflict?: SharedSpaceProfileConflict;
}

/** Why a registration did not record the profile it named. */
export type SharedSpaceProfileConflict = "profile" | "unknown-profile";

/** A collection keyed by space DID and receipts keyed by sender and offer ID. */
export interface SharedSpaceCatalog {
  entries: Record<string, SharedSpaceEntry>;
  offers: Record<string, SharedSpaceOfferReceipt>;
}

/**
 * Which of the person's profiles acts in one social space: the profile's own
 * space, which identifies it. It belongs to the space's membership, filed
 * under the space as the space's entry is, and so outlasts any root the space
 * has.
 */
export interface SharedSpaceProfileRecord {
  space: string;
  profile: string;
}

/**
 * Home's records of the profile acting in each social space, keyed by the
 * space's DID. The validating reader selects every stored field, for the
 * reason {@link SharedSpaceCatalogStorage} gives.
 */
export type SharedSpaceProfileStorage = Record<string, any>;

/** A target whose root, access, and kind the registering application vetted. */
export interface SharedSpaceRegistration {
  space: string;
  host: string;
  kind: string;
  title?: string;
  since?: number;
  initialState?: SharedSpaceMembership;
  offer?: { from: string; id: string };

  /**
   * The space DID of the person's profile that acts in the space, recorded
   * when Home records none for the space. A recorded profile is never
   * replaced.
   */
  profile?: string;
}

/**
 * Registration's outcome, independent of subsequent membership changes. A
 * conflict over the route or the offer wrote nothing. A conflict over the
 * profile registered the space all the same, and `registration` says whether
 * that admitted a new entry or found one.
 */
export type SharedSpaceRegistrationResult =
  | { status: "registered" | "existing"; space: string }
  | { status: "conflict"; reason: "host" | "kind" | "offer" }
  | {
    status: "conflict";
    reason: SharedSpaceProfileConflict;
    space: string;
    registration: "registered" | "existing";
  };

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

/** Names one entry whose display title its space's root now gives. */
export interface SharedSpaceRetitle {
  space: string;
  title: string;
}

/** A retitle's outcome. */
export type SharedSpaceRetitleResult =
  | { status: "retitled" | "unchanged"; space: string }
  | { status: "conflict"; reason: "missing" };

/**
 * The validating reader deliberately selects every stored field. A narrower
 * schema can omit a malformed optional value before the validator sees it.
 */
export type SharedSpaceCatalogStorage = Record<string, any>;

/** The catalog's writable binding, held by Home and its handlers. */
export interface SharedSpaceCatalogState {
  catalog: Writable<SharedSpaceCatalogStorage>;
}

/**
 * What a binding of {@link registerSharedSpace} holds: the catalog, and, to
 * record the profile a registration names, Home's records of the profile
 * acting in each space and Home's `profiles` list.
 */
export interface SharedSpaceRegistrationState extends SharedSpaceCatalogState {
  sharedSpaceProfiles?: Writable<SharedSpaceProfileStorage>;
  profiles?: Cell<Cell<unknown>[]>;
  retiredProfiles?: Cell<Cell<unknown>[]>;
}

/**
 * What Home's lists say of a profile a registration names: one of the
 * person's own profiles (`live`), one of them they retired (`retired`), or
 * neither (`unknown`).
 */
export type SharedSpaceProfileStanding = "live" | "retired" | "unknown";

/**
 * Where a registration naming a profile records it: Home's records of the
 * profile acting in each space, and what says whether the named profile, by
 * its space, is one of the person's live profiles (`standing`), which a new
 * record requires. A registration naming no profile reads neither.
 */
export interface SharedSpaceProfileRecorder {
  records: Writable<SharedSpaceProfileStorage>;
  standing: (profile: string) => SharedSpaceProfileStanding;
}

/** Returns the offer identity shared by all collection consumers. */
export function sharedSpaceOfferKey(from: string, id: string): string {
  if (!isWellFormedDID(from) || !boundedString(id, 320)) {
    throw new TypeError("Catalog offer requires a sender DID and stable ID.");
  }
  return JSON.stringify([from, id]);
}

/**
 * Reads an initialized catalog, refusing unavailable or malformed values. It
 * writes nothing, which its parameter declares by being a `Cell` where the
 * catalog's writers take a `Writable`: a computation that hands a cell to a
 * `Writable` parameter is scheduled as a writer of that cell.
 *
 * @throws When `catalog` holds something other than a valid catalog.
 */
export function readSharedSpaceCatalog(
  catalog: Cell<SharedSpaceCatalogStorage>,
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

/**
 * Whether `value` is a readable record of the profile acting in `space`:
 * one filed under that space, naming a profile by a well-formed DID. Extra
 * fields are retained.
 */
export function isSharedSpaceProfileRecord(
  value: unknown,
  space: string,
): value is SharedSpaceProfileRecord {
  return plainObject(value) && value.space === space &&
    isWellFormedDID(value.profile);
}

/**
 * Whether `value` has the shape Home's records of the profile acting in each
 * space take: a record keyed by space, whose values may each be readable or
 * not ({@link isSharedSpaceProfileRecord}).
 */
export function isSharedSpaceProfileStorage(
  value: unknown,
): value is Record<string, unknown> {
  return plainObject(value);
}

/**
 * Reads Home's records of the profile acting in each space, refusing an
 * unavailable or malformed value. A single unreadable record leaves the rest
 * readable, so it is returned as it is stored.
 *
 * @throws When `records` holds something other than a record of records.
 */
function readSharedSpaceProfiles(
  records: Cell<SharedSpaceProfileStorage>,
): Record<string, unknown> {
  const value = records.get();
  if (!isSharedSpaceProfileStorage(value)) {
    throw new Error(
      "The records of the profile acting in each social space are " +
        "unavailable or malformed.",
    );
  }
  return value;
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
    (value.since !== undefined && !admissionTime(value.since)) ||
    (value.profile !== undefined && !isWellFormedDID(value.profile))
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
 * the entry, unless one is already there. A registration naming a profile
 * records it in `recorder.records` as the profile acting in the space, unless
 * a record is already there, which is never replaced, whether or not the
 * space already has an entry. Returns `conflict` without writing anything
 * when the space is already registered with another host or kind, or the
 * offer's receipt names another target. When the space's profile record names
 * another profile or is one this writer cannot read (`profile`), or there is
 * no record and `recorder.standing` does not say the named profile is one of
 * the person's live profiles (`unknown-profile`), it registers the space and
 * the offer's receipt as it would for a registration naming no profile,
 * records no profile, writes the reason into the offer's receipt as its
 * `profileConflict`, and returns `conflict` with that reason. A registration
 * naming a profile replaces the `profileConflict` of a receipt already there
 * with its own outcome, so that an offer sent again once its profile is one
 * of the person's live profiles clears it. A registration naming the profile
 * a record already names records nothing new, whatever that profile's
 * standing now. Call it only
 * from a handler, since a new entry's revision names the handler's event.
 *
 * @throws When `input` is not a valid registration, when it names a profile
 *   and there is no `recorder`, when `catalog` holds something other than a
 *   valid catalog, or when `recorder.records` holds something other than a
 *   record keyed by space.
 */
export function registerSharedSpaceIn(
  catalog: Writable<SharedSpaceCatalogStorage>,
  input: SharedSpaceRegistration,
  recorder?: SharedSpaceProfileRecorder,
): SharedSpaceRegistrationResult {
  const registration = normalizeRegistration(input);
  const { space, host, kind, title, offer, profile } = registration;
  if (profile !== undefined && recorder === undefined) {
    throw new TypeError(
      "This registration names a profile, which nothing here can record.",
    );
  }
  const stored = readSharedSpaceCatalog(catalog);
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
  const receipt = key === undefined ? undefined : stored.offers[key];
  if (
    receipt &&
    (receipt.space !== space || receipt.host !== host ||
      receipt.kind !== kind)
  ) return { status: "conflict", reason: "offer" };
  let recordProfile: (() => void) | undefined;
  let profileConflict: SharedSpaceProfileConflict | undefined;
  if (profile !== undefined && recorder !== undefined) {
    const held = readSharedSpaceProfiles(recorder.records)[space];
    if (held !== undefined) {
      if (
        !(isSharedSpaceProfileRecord(held, space) && held.profile === profile)
      ) profileConflict = "profile";
    } else if (recorder.standing(profile) !== "live") {
      profileConflict = "unknown-profile";
    } else {
      recordProfile = () => recorder.records.key(space).set({ space, profile });
    }
  }
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
  if (
    key && offer &&
    (!receipt ||
      (profile !== undefined && receipt.profileConflict !== profileConflict))
  ) {
    catalog.key("offers", key).set({
      from: offer.from,
      id: offer.id,
      space,
      host,
      kind,
      ...(profileConflict === undefined ? {} : { profileConflict }),
    });
  }
  recordProfile?.();
  return profileConflict === undefined
    ? { status: current ? "existing" : "registered", space }
    : {
      status: "conflict",
      reason: profileConflict,
      space,
      registration: current ? "existing" : "registered",
    };
}

/**
 * What Home's lists say of the profile whose space is `profile`, for a
 * registration recording it: `live` when `profiles` lists it, it is
 * `owner`'s own (`profileOwnerOf()`, the rule the runner's
 * `profileOwnership()` applies to `#profile`), and `retiredProfiles` does not
 * list it; `retired` when it is
 * one of the person's own profiles that `retiredProfiles` lists; and
 * `unknown` otherwise. An element of either list that is no link names no
 * profile.
 *
 * @throws When a label cannot be read, which leaves the registration to fail
 *   rather than to take the profile for someone else's.
 */
function profileStanding(
  profile: string,
  owner: string | undefined,
  profiles: Cell<Cell<unknown>[]>,
  retiredProfiles: Cell<Cell<unknown>[]> | undefined,
): SharedSpaceProfileStanding {
  const listed = (list: Cell<Cell<unknown>[]> | undefined) =>
    (list?.get() ?? []).filter((link) => spaceOf(link) === profile);
  const own = owner !== undefined &&
    listed(profiles).some((link) => profileOwnerOf(link) === owner);
  return !own
    ? "unknown"
    : listed(retiredProfiles).length > 0
    ? "retired"
    : "live";
}

// Retain every event field for validation, including linked payloads whose
// stored schema would otherwise omit a malformed optional field.
const eventSchema = toSchema<Record<string, any>>();

/**
 * Registers an admitted space without changing any existing membership, as
 * {@link registerSharedSpaceIn} does, recording the profile it names in
 * `sharedSpaceProfiles`, which must be one of the person's live profiles by
 * `profiles` and `retiredProfiles`. A registration naming a profile throws
 * for a binding missing any of them, or one where the records, the lists and
 * the catalog are not each the field of their name of one pattern's result
 * (`resultOwnerOf()`), as Home's are, the catalog being the result's
 * `sharedSpaceCatalogStorage`.
 */
export const registerSharedSpace = handler<
  SharedSpaceRegistration,
  SharedSpaceRegistrationState,
  SharedSpaceRegistrationResult
>(
  eventSchema,
  toSchema<SharedSpaceRegistrationState>(),
  (
    input,
    { catalog, sharedSpaceProfiles, profiles, retiredProfiles },
  ) =>
    registerSharedSpaceIn(
      catalog,
      input,
      sharedSpaceProfiles === undefined || profiles === undefined
        ? undefined
        : {
          records: sharedSpaceProfiles,
          // The records live in Home's space, whose DID is its owner's, so
          // the owner they are checked against is Home's whatever binds them.
          standing: (profile) => {
            // The standing is decided by the lists this binding names, so
            // each must be the field of its name of the result that owns the
            // records, and so must the catalog the records are written
            // beside, which is its `sharedSpaceCatalogStorage`.
            const owners = new Set([
              resultOwnerOf(catalog, "sharedSpaceCatalogStorage"),
              resultOwnerOf(sharedSpaceProfiles, "sharedSpaceProfiles"),
              resultOwnerOf(profiles, "profiles"),
              resultOwnerOf(retiredProfiles, "retiredProfiles"),
            ]);
            if (owners.size !== 1 || owners.has(undefined)) {
              throw new TypeError(
                "This registration names a profile, and the lists this " +
                  "handler was bound to are not one Home's own.",
              );
            }
            return profileStanding(
              profile,
              spaceOf(sharedSpaceProfiles),
              profiles,
              retiredProfiles,
            );
          },
        },
    ),
);

/**
 * Applies the user's membership choice in `catalog` only to the revision they
 * observed, staging its writes in the transaction of the handler that calls
 * it, so a handler can apply a choice in the same commit as its own writes.
 * Returns `conflict` without writing anything when the space has no entry, the
 * entry's state or action evidence is one this writer doesn't understand, the
 * observed revision is not the current one, or the next revision would not
 * fit. Repeating the last applied choice returns `confirmed`. Call it only
 * from a handler, since a new revision names the handler's event.
 *
 * @throws When `change` is not a valid membership action, or `catalog` holds
 *   something other than a valid catalog.
 */
export function changeSharedSpaceMembershipIn(
  catalog: Writable<SharedSpaceCatalogStorage>,
  change: SharedSpaceMembershipChange,
): SharedSpaceMembershipResult {
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
}

/**
 * Applies the user's choice only to the revision they observed, as
 * {@link changeSharedSpaceMembershipIn} does.
 */
export const changeSharedSpaceMembership = handler<
  SharedSpaceMembershipChange,
  SharedSpaceCatalogState,
  SharedSpaceMembershipResult
>(
  eventSchema,
  toSchema<SharedSpaceCatalogState>(),
  (change, { catalog }) => changeSharedSpaceMembershipIn(catalog, change),
);

/**
 * Sets the display title of the entry for `retitle.space` in `catalog` to the
 * title its space's root now gives, staging its write in the transaction of
 * the handler that calls it. Writes nothing when the entry already has that
 * title, and returns `conflict` without writing when the space has no entry.
 * The entry's membership, revision and last action stay as they are: a title
 * is a display hint, not a membership choice, so a choice made from a list
 * shown before the retitle still names the current revision.
 *
 * @throws When `retitle` is not a valid retitle, or `catalog` holds something
 *   other than a valid catalog.
 */
export function retitleSharedSpaceIn(
  catalog: Writable<SharedSpaceCatalogStorage>,
  retitle: SharedSpaceRetitle,
): SharedSpaceRetitleResult {
  if (
    !plainObject(retitle) || !isWellFormedDID(retitle.space) ||
    !boundedString(retitle.title, 200, true)
  ) {
    throw new TypeError("Invalid shared-space retitle.");
  }
  const current = readSharedSpaceCatalog(catalog).entries[retitle.space];
  if (!current) return { status: "conflict", reason: "missing" };
  if (current.title === retitle.title) {
    return { status: "unchanged", space: retitle.space };
  }
  catalog.key("entries", retitle.space, "title").set(retitle.title);
  return { status: "retitled", space: retitle.space };
}

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
 * offer that it refuses to replay. The record of the profile acting in the
 * space stays where it is, so a later registration of the space naming that
 * profile records nothing new, and one naming another is a `conflict`.
 * Removal grants and revokes no access.
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

/**
 * Home's records of the profile acting in each social space, with their
 * write policy: `registerSharedSpace`, which adds a record where there is
 * none, writes them and no other handler does, the whole and each record
 * alike. It never replaces or removes a record, so a binding of it that
 * names another catalog or another profile list, whoever's code makes it,
 * can add a record for a space that has none and nothing else. It asks for
 * no gesture, so any pattern that reaches Home's streams can record a profile
 * for a space that has none by registering the space; what the policies rule
 * out is a write by anything else.
 */
export type TrustedSharedSpaceProfiles = WriteAuthorizedBy<
  Record<
    string,
    WriteAuthorizedBy<SharedSpaceProfileRecord, typeof registerSharedSpace>
  >,
  typeof registerSharedSpace
>;
