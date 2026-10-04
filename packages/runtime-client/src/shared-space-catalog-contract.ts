/** The portable collection of shared spaces in a person's Home. */

import type { JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";
import { isWellFormedDID } from "@commonfabric/identity/did";
import { normalizeSpaceHost } from "@commonfabric/runner/space-host";
import { isPlainObject } from "@commonfabric/utils/types";

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
    state: sharedSpaceMembershipSchema,
    revision: { type: "string" },
    lastAction: membershipActionSchema,
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
    version: { const: 1 },
    entries: {
      type: "object",
      additionalProperties: sharedSpaceEntrySchema,
    },
    offers: {
      type: "object",
      additionalProperties: sharedSpaceOfferReceiptSchema,
    },
  },
  required: ["version", "entries", "offers"],
} as const satisfies JSONSchema;

/** The durable catalog value. Unknown kinds remain readable and retained. */
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
  kind: "loom" | "fabrichat-room";

  /** Legacy membership used only when inserting an absent entry. Defaults to saved. */
  initialState?: SharedSpaceMembership;

  /** Optional display hint, retained from the first registration. */
  title?: string;

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

/** A committed registration or a refusal that changes nothing. */
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

/** A committed membership choice, confirmation, or refusal. */
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
    reason: "missing" | "revision" | "action" | "catalog-changed";
  };

/** Returns the stable cause of a person's dedicated catalog document. */
export function sharedSpaceCatalogCause(principal: string): {
  sharedSpaceCatalog: string;
} {
  if (!isWellFormedDID(principal)) {
    throw new TypeError("Catalog Home requires a well-formed principal DID.");
  }
  return { sharedSpaceCatalog: principal };
}

/** Returns a canonical HTTP or HTTPS origin, refusing credentials and paths. */
export function sharedSpaceCatalogHost(host: string): string {
  return normalizeSpaceHost(host).origin;
}

/** Returns a receipt key that includes both the sender and the offer identity. */
export function sharedSpaceOfferKey(from: string, id: string): string {
  if (!isWellFormedDID(from) || !boundedString(id, 320)) {
    throw new TypeError("Catalog offer requires a sender DID and stable ID.");
  }
  return JSON.stringify([from, id]);
}

/**
 * Validates a decoded catalog without replacing malformed data with an empty
 * collection. Extra fields and unknown kinds survive compatible readers.
 */
export function isSharedSpaceCatalog(
  value: unknown,
): value is SharedSpaceCatalog {
  if (
    !isPlainObject(value) || value.version !== 1 ||
    !isPlainObject(value.entries) || !isPlainObject(value.offers)
  ) return false;
  for (const [space, entry] of Object.entries(value.entries)) {
    if (
      !isPlainObject(entry) || !validTarget(entry) || entry.space !== space ||
      !membership(entry.state) || !boundedString(entry.revision, 320) ||
      (entry.title !== undefined && !boundedString(entry.title, 200, true))
    ) return false;
    if (entry.lastAction !== undefined) {
      const action = entry.lastAction;
      if (
        !isPlainObject(action) || !boundedString(action.id, 320) ||
        !boundedString(action.expectedRevision, 320) ||
        action.state !== entry.state
      ) return false;
    }
  }
  for (const [key, receipt] of Object.entries(value.offers)) {
    if (
      !isPlainObject(receipt) || !validTarget(receipt) ||
      !isWellFormedDID(receipt.from) || !boundedString(receipt.id, 320) ||
      key !== sharedSpaceOfferKey(receipt.from, receipt.id)
    ) return false;
    const entry = value.entries[receipt.space as string];
    if (
      !isPlainObject(entry) || entry.host !== receipt.host ||
      entry.kind !== receipt.kind
    ) return false;
  }
  return true;
}

/** Validates and normalizes a registration before it reaches storage. */
export function normalizeSharedSpaceRegistration(
  registration: SharedSpaceRegistration,
): SharedSpaceRegistration {
  if (
    !isPlainObject(registration) || !isWellFormedDID(registration.space) ||
    !["loom", "fabrichat-room"].includes(registration.kind) ||
    (registration.initialState !== undefined &&
      !membership(registration.initialState)) ||
    (registration.title !== undefined &&
      !boundedString(registration.title, 200, true))
  ) throw new TypeError("Invalid shared-space registration.");
  if (registration.offer !== undefined) {
    if (!isPlainObject(registration.offer)) {
      throw new TypeError("Invalid shared-space offer identity.");
    }
    sharedSpaceOfferKey(registration.offer.from, registration.offer.id);
  }
  return {
    space: registration.space,
    host: sharedSpaceCatalogHost(registration.host),
    kind: registration.kind,
    ...(registration.initialState === undefined
      ? {}
      : { initialState: registration.initialState }),
    ...(registration.title === undefined ? {} : { title: registration.title }),
    ...(registration.offer === undefined ? {} : {
      offer: {
        from: registration.offer.from,
        id: registration.offer.id,
      },
    }),
  };
}

/** Validates an explicit membership action before it reaches storage. */
export function validateSharedSpaceMembershipChange(
  change: SharedSpaceMembershipChange,
): void {
  if (
    !isPlainObject(change) || !isWellFormedDID(change.space) ||
    !boundedString(change.id, 320) ||
    !boundedString(change.expectedRevision, 320) || !membership(change.state)
  ) throw new TypeError("Invalid shared-space membership action.");
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

/** Helper for catalog validation, which recognizes collection choices. */
function membership(value: unknown): value is SharedSpaceMembership {
  return value === "saved" || value === "archived";
}

/** Helper for catalog validation, which checks a stored normalized target. */
function validTarget(value: Record<string, unknown>): boolean {
  if (
    !isWellFormedDID(value.space) || !boundedString(value.kind, 32) ||
    typeof value.host !== "string"
  ) return false;
  try {
    return sharedSpaceCatalogHost(value.host) === value.host;
  } catch {
    return false;
  }
}
