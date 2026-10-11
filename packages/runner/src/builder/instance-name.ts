/**
 * Names for sub-pattern instances. The transformer wraps a pattern factory
 * call bound to a `const` in `nameInstance(Child(...), "child")`, and the
 * pattern builder takes that name as the instance's partial cause when nothing
 * else names it. Its identity then rests on the name rather than on where the
 * instance sits in the pattern's result.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

import { exportCell, isCell } from "../cell.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import type { JSONObject, OpaqueCell } from "./types.ts";

/** The name each instance root was given, keyed by its root cell. */
const instanceNames = new WeakMap<OpaqueCell<unknown>, string>();

/**
 * Gives the sub-pattern instance `value` the instance name `name`, and returns
 * `value`. A value that is not a cell is returned as it is, unnamed.
 */
export function nameInstance<T>(value: T, name: string): T {
  if (typeof name !== "string") {
    throw new TypeError("nameInstance: an instance name is a string");
  }
  const cell = isCellResultForDereferencing(value)
    ? getCellOrThrow(value)
    : value;
  if (isCell(cell)) instanceNames.set(exportCell(cell).cell, name);
  return value;
}

/** The instance name given to the root cell `root`, if any. */
export function instanceNameOf(root: OpaqueCell<unknown>): string | undefined {
  return instanceNames.get(root);
}

/**
 * The partial cause of the instance named `name`. It sits under the reserved
 * `$generated` key, so no cause a pattern gives with `.for()` can equal it,
 * and its string value keeps it apart from the builder's numbered causes.
 */
export function instancePartialCause(name: string): JSONObject {
  return { $generated: "instance", name };
}

/**
 * The instance name `partialCause` carries, when it is the partial cause of a
 * named instance, and `undefined` otherwise.
 */
export function instanceNameOfPartialCause(
  partialCause: unknown,
): string | undefined {
  if (
    isObjectNotArray(partialCause) &&
    partialCause.$generated === "instance" &&
    typeof partialCause.name === "string" &&
    Object.keys(partialCause).length === 2
  ) {
    return partialCause.name;
  }
  return undefined;
}
