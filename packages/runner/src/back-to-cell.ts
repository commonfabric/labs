/**
 * Symbols and utilities for converting values back to cells.
 * These symbols are attached to objects during schema validation
 * to enable conversion back to cells when needed.
 */

import { isObjectOrArray } from "@commonfabric/utils/types";
import type { Cell } from "./cell.ts";

/**
 * Symbol to retrieve a cell from a value.
 * When present on an object, calling the function at this symbol
 * returns the cell that the value was derived from.
 *
 * TODO(seefeld): key this on a WeakMap from value to cell instead of a symbol
 * attached to the value. Carrying it as a property is what forces every value
 * that needs a back-pointer to be an object with a reachable surface — see
 * `createOpaquePresence()` in schema.ts, which has to project an empty object
 * where a fresh symbol per value would say exactly as much and expose nothing.
 */
export const toCell = Symbol("toCell");

/**
 * Type representing the internal structure of values that can be
 * converted back to cells.
 */
export type BackToCellInternals = {
  [toCell]: () => Cell<unknown>;
};

/**
 * Type representing a value that has been annotated with back-to-cell symbols.
 */
export type WithBackToCell<T> = T & BackToCellInternals;

/**
 * Marks the value an opaque (`type: "unknown"`) position projects to: a
 * reference that answers presence and identity and carries nothing of what it
 * names.
 *
 * A merge needs to tell one from an ordinary empty object, because a branch
 * that declined to look must never override a branch that looked — see
 * `mergeAnyOfMatches()`.
 */
export const opaqueReference = Symbol("opaqueReference");

/** Whether `value` is the projection of an opaque position. */
export function isOpaqueReference(value: unknown): boolean {
  return isObjectOrArray(value) &&
    (value as Record<symbol, unknown>)[opaqueReference] === true;
}

/**
 * The cell an opaque reference names: the position the reference was read
 * from, which a reader with a schema of its own can read through. Anything
 * that is not the projection of an opaque position yields `undefined`.
 */
export function cellOfOpaqueReference(
  value: unknown,
): Cell<unknown> | undefined {
  return isOpaqueReference(value)
    ? (value as BackToCellInternals)[toCell]()
    : undefined;
}
