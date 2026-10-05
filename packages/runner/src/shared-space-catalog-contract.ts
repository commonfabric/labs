/** The portable collection of shared spaces in a person's Home. */

import { isWellFormedDID } from "@commonfabric/identity/did";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  isSharedSpaceMembership,
  type SharedSpaceCatalog,
  type SharedSpaceMembershipChange,
  sharedSpaceOfferKey,
  type SharedSpaceRegistration,
} from "./shared-space-catalog-data.ts";
import { normalizeSpaceHost } from "./space-host.ts";

export * from "./shared-space-catalog-data.ts";

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

/**
 * Validates a decoded catalog without replacing malformed data with an empty
 * collection. Extra fields and unknown kinds survive compatible readers.
 */
export function isSharedSpaceCatalog(
  value: unknown,
): value is SharedSpaceCatalog {
  if (
    !isPlainObject(value) ||
    !isPlainObject(value.entries) || !isPlainObject(value.offers)
  ) return false;
  for (const [space, entry] of Object.entries(value.entries)) {
    if (
      !isPlainObject(entry) || !validTarget(entry) || entry.space !== space ||
      !boundedString(entry.state, 32) || !boundedString(entry.revision, 320) ||
      (entry.title !== undefined && !boundedString(entry.title, 200, true)) ||
      (entry.from !== undefined && !isWellFormedDID(entry.from)) ||
      (entry.since !== undefined && !admissionTime(entry.since))
    ) return false;
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
    !boundedString(registration.kind, 32) ||
    (registration.initialState !== undefined &&
      !isSharedSpaceMembership(registration.initialState)) ||
    (registration.title !== undefined &&
      !boundedString(registration.title, 200, true)) ||
    (registration.since !== undefined && !admissionTime(registration.since))
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
    ...(registration.since === undefined ? {} : { since: registration.since }),
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
    !boundedString(change.expectedRevision, 320) ||
    !isSharedSpaceMembership(change.state)
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

/** Whether an admission timestamp is a nonnegative, exact epoch millisecond. */
function admissionTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
