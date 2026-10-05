/** Portable catalog data and transitions; callers validate input and confirm commits. */

import type { JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";
import { isWellFormedDID } from "@commonfabric/identity/did";

/** Collection membership, independent of the space's access list. */
export const sharedSpaceMembershipSchema = {
  enum: ["saved", "archived"],
} as const satisfies JSONSchema;

/** An explicit collection choice. */
export type SharedSpaceMembership = Schema<typeof sharedSpaceMembershipSchema>;

/** Evidence of the last explicit collection choice. */
const membershipActionSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    expectedRevision: { type: "string" },
    state: sharedSpaceMembershipSchema,
  },
  required: ["id", "expectedRevision", "state"],
} as const satisfies JSONSchema;

/** One space's retained collection membership and accepted routing fact. */
export const sharedSpaceEntrySchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    host: { type: "string" },
    kind: { type: "string" },
    title: { type: "string" },
    from: { type: "string" },
    since: { type: "number" },
    state: { type: "string" },
    revision: { type: "string" },
    lastAction: true,
  },
  required: ["space", "host", "kind", "state", "revision"],
} as const satisfies JSONSchema;

/** A catalog record. Its revision changes on each explicit membership action. */
export type SharedSpaceEntry = Schema<typeof sharedSpaceEntrySchema>;

/** A validated offer identity and the target it registered. */
const sharedSpaceOfferReceiptSchema = {
  type: "object",
  properties: {
    from: { type: "string" },
    id: { type: "string" },
    space: { type: "string" },
    host: { type: "string" },
    kind: { type: "string" },
  },
  required: ["from", "id", "space", "host", "kind"],
} as const satisfies JSONSchema;

/** The dedicated Home document, keyed by space DID and by sender/offer ID. */
export const sharedSpaceCatalogSchema = {
  type: "object",
  properties: {
    entries: {
      type: "object",
      additionalProperties: sharedSpaceEntrySchema,
    },
    offers: {
      type: "object",
      additionalProperties: sharedSpaceOfferReceiptSchema,
    },
  },
  required: ["entries", "offers"],
} as const satisfies JSONSchema;

/** The durable catalog value. Unknown kinds, states, and action evidence remain readable and retained. */
export type SharedSpaceCatalog = Schema<typeof sharedSpaceCatalogSchema>;

/** A validated catalog snapshot or a successfully observed absent document. */
export type SharedSpaceCatalogRead =
  | {
    /** A catalog has been loaded and validated. */
    status: "ready";

    /** The collection observed by this read. */
    catalog: SharedSpaceCatalog;
  }
  | {
    /** Storage confirmed that this Home has no catalog document. */
    status: "absent";
  };

/** The principal and independently configured host of the canonical Home. */
export type SharedSpaceCatalogHome = {
  /** Principal whose Home holds the catalog. */
  principal: string;

  /** HTTP or HTTPS origin serving that Home. */
  host: string;
};

/** A target whose kind, root, and access the registering application validated. */
export type SharedSpaceRegistration = {
  /** Identity of the shared space. */
  space: string;

  /** Memory host serving the shared space. */
  host: string;

  /** Collection consumer that can interpret the space. */
  kind: string;

  /** Legacy membership used only when inserting an absent entry. Defaults to saved. */
  initialState?: SharedSpaceMembership;

  /** Optional display hint, retained from the first registration. */
  title?: string;

  /** Recipient admission time in epoch milliseconds, optionally preserved during migration. */
  since?: number;

  /** Optional validated offer identity, recorded atomically with registration. */
  offer?: {
    /** Claimed sender, validated by the receiving application. */
    from: string;

    /** Stable sender-chosen identity of this offer. */
    id: string;
  };
};

/** An explicit action against the membership revision the user observed. */
export type SharedSpaceMembershipChange = {
  /** Identity of the catalog entry. */
  space: string;

  /** Durable operation identity, reused when confirming a lost reply. */
  id: string;

  /** Membership revision the action was based on. */
  expectedRevision: string;

  /** The user's requested collection choice. */
  state: SharedSpaceMembership;
};

/** A registration outcome; the caller separately confirms its transaction. */
export type SharedSpaceRegistrationResult =
  | {
    /** Whether this request inserted the entry. */
    status: "registered" | "existing";

    /** Membership selected in the committed transaction. */
    entry: SharedSpaceEntry;
  }
  | {
    /** Conflicting target evidence. */
    status: "conflict";

    /** The part of the registration that conflicts. */
    reason: "host" | "kind" | "offer" | "catalog-changed";
  };

/** A membership outcome; the caller separately confirms its transaction. */
export type SharedSpaceMembershipResult =
  | {
    /** Whether this request wrote the action or confirmed its retained evidence. */
    status: "applied" | "confirmed";

    /** Membership selected in the committed transaction. */
    entry: SharedSpaceEntry;
  }
  | {
    /** The action cannot be applied or confirmed against current evidence. */
    status: "conflict";

    /** Missing entry, stale revision, or reused operation identity. */
    reason:
      | "missing"
      | "revision"
      | "action"
      | "unsupported-state"
      | "catalog-changed";
  };

/** Returns a receipt key that includes both the sender and the offer identity. */
export function sharedSpaceOfferKey(from: string, id: string): string {
  if (!isWellFormedDID(from) || !boundedString(id, 320)) {
    throw new TypeError("Catalog offer requires a sender DID and stable ID.");
  }
  return JSON.stringify([from, id]);
}

/** Helper for catalog validation, which checks a bounded text field. */
function boundedString(
  value: unknown,
  max: number,
  empty = false,
): value is string {
  return typeof value === "string" && (empty || value.length > 0) &&
    value.length <= max;
}

/** Whether this implementation can apply an explicit membership choice. */
export function isSharedSpaceMembership(
  value: unknown,
): value is SharedSpaceMembership {
  return value === "saved" || value === "archived";
}

/** Whether retained action evidence has the shape this writer understands. */
export function isSharedSpaceMembershipAction(
  value: unknown,
): value is Schema<typeof membershipActionSchema> {
  return value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    "id" in value && "expectedRevision" in value && "state" in value &&
    boundedString(value.id, 320) &&
    boundedString(value.expectedRevision, 320) &&
    isSharedSpaceMembership(value.state);
}

/** A bounded path changed by a catalog transition. */
export type CatalogWritePath =
  | readonly [string, string]
  | readonly [string, string, string];

/** Applies insert-only registration to a transaction-local catalog copy. */
export function registerCatalogEntry(
  catalog: SharedSpaceCatalog,
  registration: SharedSpaceRegistration,
  revision: string,
  since: number,
  write: (path: CatalogWritePath, value: unknown) => void,
): SharedSpaceRegistrationResult {
  const { space, host, kind, title, offer } = registration;
  const current = catalog.entries[space];
  if (current && current.host !== host) {
    return { status: "conflict", reason: "host" };
  }
  if (current && current.kind !== kind) {
    return { status: "conflict", reason: "kind" };
  }
  const key = offer && sharedSpaceOfferKey(offer.from, offer.id);
  const receipt = key && catalog.offers[key];
  if (
    receipt && (receipt.space !== space || receipt.host !== host ||
      receipt.kind !== kind)
  ) return { status: "conflict", reason: "offer" };
  const entry: SharedSpaceEntry = current ?? {
    space,
    host,
    kind,
    ...(title === undefined ? {} : { title }),
    ...(offer === undefined ? {} : { from: offer.from }),
    since,
    state: registration.initialState ?? "saved",
    revision,
  };
  if (!current) write(["entries", space], entry);
  catalog.entries[space] = entry;
  if (key && offer) {
    catalog.offers[key] = { ...offer, space, host, kind };
    if (!receipt) write(["offers", key], catalog.offers[key]);
  }
  return { status: current ? "existing" : "registered", entry };
}

/** Applies a revision-checked choice to a transaction-local catalog copy. */
export function changeCatalogMembership(
  catalog: SharedSpaceCatalog,
  change: SharedSpaceMembershipChange,
  revision: string,
  write: (path: CatalogWritePath, value: unknown) => void,
): SharedSpaceMembershipResult {
  const current = catalog.entries[change.space];
  if (!current) return { status: "conflict", reason: "missing" };
  if (!isSharedSpaceMembership(current.state)) {
    return { status: "conflict", reason: "unsupported-state" };
  }
  const last = current.lastAction;
  if (
    last !== undefined &&
    (!isSharedSpaceMembershipAction(last) || last.state !== current.state)
  ) {
    return { status: "conflict", reason: "action" };
  }
  if (last?.id === change.id) {
    return last.expectedRevision === change.expectedRevision &&
        last.state === change.state
      ? { status: "confirmed", entry: current }
      : { status: "conflict", reason: "action" };
  }
  if (current.revision !== change.expectedRevision) {
    return { status: "conflict", reason: "revision" };
  }
  const entry: SharedSpaceEntry = {
    ...current,
    state: change.state,
    revision,
    lastAction: {
      id: change.id,
      expectedRevision: change.expectedRevision,
      state: change.state,
    },
  };
  write(["entries", change.space, "state"], entry.state);
  write(["entries", change.space, "revision"], entry.revision);
  write(["entries", change.space, "lastAction"], entry.lastAction);
  catalog.entries[change.space] = entry;
  return { status: "applied", entry };
}
