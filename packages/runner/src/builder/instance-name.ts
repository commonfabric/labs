/**
 * Names for sub-pattern instances. In a runtime that names instances
 * (`namesInstances()`), the transformer wraps a pattern factory call bound to
 * a `const` in `nameInstance(Child(...), "child")`, and the pattern builder
 * takes that name as the instance's partial cause when nothing else names it.
 * Its identity then rests on the name rather than on where the instance sits
 * in the pattern's result.
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
 * `value`. A value that is not a cell is returned as it is, unnamed, and the
 * builder never names a stream root, so a name given to one has no effect.
 */
export function nameInstance<T>(value: T, name: string): T {
  if (typeof name !== "string") {
    throw new TypeError("nameInstance: an instance name is a string");
  }
  const cell = isCellResultForDereferencing(value)
    ? getCellOrThrow(value)
    : value;
  if (isCell(cell)) {
    instanceNames.set(exportCell(cell).cell, name);
  }
  return value;
}

/**
 * Whether a runtime whose experimental options are `experimental` compiles a
 * pattern factory call bound to a `const` as a named instance. It is the one
 * read of the `instanceNames` flag: the compile and the key its compiled code
 * is cached under both take it from here, so that the two cannot disagree.
 */
export function namesInstances(
  experimental: { readonly instanceNames?: boolean | undefined },
): boolean {
  return experimental.instanceNames === true;
}

/** The instance name given to the root cell `root`, if any. */
export function instanceNameOf(root: OpaqueCell<unknown>): string | undefined {
  return instanceNames.get(root);
}

/**
 * The partial cause of the instance named `name`, `{ $instance: name }`.
 * `$instance` is a reserved key, so no cause a pattern gives with `.for()` can
 * equal it, and it stands apart from `$generated`, the key of the causes the
 * builder mints for anonymous roots.
 */
export function instancePartialCause(name: string): JSONObject {
  return { $instance: name };
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
    typeof partialCause.$instance === "string" &&
    Object.keys(partialCause).length === 1
  ) {
    return partialCause.$instance;
  }
  return undefined;
}
