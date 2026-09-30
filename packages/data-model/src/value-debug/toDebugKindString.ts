import { isPlainObject } from "@commonfabric/utils/types";

import { FabricInstance, FabricPrimitive } from "@/interface.ts";

/**
 * Produces a short human-readable kind-string for a value, suitable for
 * error messages and other diagnostic contexts where the caller wants to
 * say something like _"can't operate on a `${toDebugKindString(value)}`"_.
 *
 * Distinguishes:
 *
 * - `null` / `undefined` -- rendered literally.
 * - Plain objects and arrays -- `"object"` / `"array"`.
 * - `FabricInstance` and `FabricPrimitive` -- rendered with their concrete
 *   subclass constructor name (e.g. `"FabricInstance (FabricError)"`).
 * - Other class instances -- rendered with their constructor name.
 * - JS primitives -- rendered as their `typeof` (`"number"`, `"string"`,
 *   `"bigint"`, `"boolean"`, `"symbol"`, `"function"`).
 */
export function toDebugKindString(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  if (value instanceof FabricInstance) {
    return `FabricInstance (${value.constructor.name})`;
  }
  if (value instanceof FabricPrimitive) {
    return `FabricPrimitive (${value.constructor.name})`;
  }
  if (isPlainObject(value)) return "object";
  return value.constructor?.name ?? "object";
}
