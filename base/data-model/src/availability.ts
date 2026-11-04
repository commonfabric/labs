/**
 * Availability predicates and error construction over the canonical
 * `FabricUnavailable` primitive. The predicates inspect only the reached root;
 * successful payloads remain opaque.
 */

import type {
  HasError,
  HasSchemaMismatch,
  IsObsolete,
  IsPending,
  IsSyncing,
  UnavailableErrorKind,
  UnavailableVariant,
} from "@/api.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { tagOfFabricValueElseNull } from "@/types/tag-of.ts";
import { VALUE_TAGS } from "@/types/tags.ts";
import {
  FabricUnavailable,
  UNAVAILABLE_OBSOLETE as canonicalObsolete,
  UNAVAILABLE_PENDING as canonicalPending,
  UNAVAILABLE_SYNCING as canonicalSyncing,
} from "@/fabric-primitives/FabricUnavailable.ts";

export type { UnavailableObservationKind } from "@/api.ts";
export type {
  HasError,
  HasSchemaMismatch,
  IsObsolete,
  IsPending,
  IsSyncing,
  UnavailableVariant,
};
export { FabricError, FabricUnavailable };
export const UNAVAILABLE_PENDING = canonicalPending as
  & FabricUnavailable
  & IsPending;
export const UNAVAILABLE_SYNCING = canonicalSyncing as
  & FabricUnavailable
  & IsSyncing;
export const UNAVAILABLE_OBSOLETE = canonicalObsolete as
  & FabricUnavailable
  & IsObsolete;

/** Returns whether the reached root is a canonical unavailable primitive. */
export function isUnavailable(value: unknown): value is UnavailableVariant {
  return tagOfFabricValueElseNull<unknown>(value, undefined) ===
    VALUE_TAGS.FabricUnavailable;
}

/** Returns whether the reached root is pending. */
export function isPending(value: unknown): value is IsPending {
  return isUnavailable(value) && value.isPending();
}

/** Returns whether the reached root is awaiting synchronization. */
export function isSyncing(value: unknown): value is IsSyncing {
  return isUnavailable(value) && value.isSyncing();
}

/** Returns whether the reached root is a retired output. */
export function isObsolete(value: unknown): value is IsObsolete {
  return isUnavailable(value) && value.reason === "obsolete";
}

/** Marks a retired output with optional diagnostic migration guidance. */
export function unavailableObsolete(
  message?: string,
): FabricUnavailable & IsObsolete {
  return message === undefined ? UNAVAILABLE_OBSOLETE : new FabricUnavailable(
    "obsolete",
    null,
    null,
    message,
  ) as FabricUnavailable & IsObsolete;
}

/** Returns whether the reached root is a terminal error of any kind. */
export function hasError(value: unknown): value is HasError {
  return isUnavailable(value) && value.isError();
}

/** Returns whether the reached root is a schema-mismatch error. */
export function hasSchemaMismatch(value: unknown): value is HasSchemaMismatch {
  return hasError(value) && value.errorKind === "schemaMismatch";
}

/** Converts a failure into a canonical error marker of the given kind. */
export function unavailableError(
  error: Error | FabricError | string,
  kind: UnavailableErrorKind = "general",
): FabricUnavailable & HasError {
  return new FabricUnavailable(
    "error",
    kind,
    typeof error === "string" ? error : error.message,
  ) as FabricUnavailable & HasError;
}

const SCHEMA_MISMATCH = new FabricUnavailable(
  "error",
  "schemaMismatch",
) as FabricUnavailable & HasSchemaMismatch;

/** Returns the canonical terminal marker for a schema-invalid result. */
export function unavailableMismatch(
  message?: string,
): FabricUnavailable & HasSchemaMismatch {
  return message === undefined ? SCHEMA_MISMATCH : new FabricUnavailable(
    "error",
    "schemaMismatch",
    message,
  ) as FabricUnavailable & HasSchemaMismatch;
}
