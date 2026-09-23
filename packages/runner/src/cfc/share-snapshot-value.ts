/** Reference-free JSON snapshots for the trusted host sharing surface. */

import type { JSONValue } from "@commonfabric/api";
import { cloneIfNecessary } from "@commonfabric/data-model";

import { isCell } from "../cell.ts";
import { isPrimitiveCellLink } from "../link-utils.ts";

/** Refuses references, non-JSON primitives, and cyclic data before copying. */
function validateSnapshot(value: unknown, seen = new Set<unknown>()): void {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" || isCell(value) || isPrimitiveCellLink(value)
  ) {
    throw new Error(
      "Snapshot sharing requires JSON values without cell references",
    );
  }
  if (seen.has(value)) {
    throw new Error("Snapshot sharing refuses cyclic values");
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) && prototype !== null &&
    prototype !== Object.prototype
  ) {
    throw new Error("Snapshot sharing requires plain JSON objects");
  }
  seen.add(value);
  try {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__") {
        throw new Error("Snapshot sharing refuses prototype keys");
      }
      validateSnapshot(entry, seen);
    }
  } finally {
    seen.delete(value);
  }
}

/** Captures a deeply immutable, reference-free JSON value for host review. */
export function snapshotJsonValue(value: unknown): JSONValue {
  validateSnapshot(value);
  return cloneIfNecessary(value as JSONValue) as JSONValue;
}
