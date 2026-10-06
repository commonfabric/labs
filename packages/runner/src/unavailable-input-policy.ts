import type {
  UnavailableInputPolicy,
  UnavailableObservationKind,
} from "@commonfabric/api";

const KNOWN_REASONS = new Set<UnavailableObservationKind>([
  "pending",
  "error",
  "syncing",
  "schemaMismatch",
]);

/**
 * Validates policy metadata before it can authorize a computation boundary.
 *
 * Availability policy is serialized with authored modules, so TypeScript's
 * static shape is not a trust boundary. Invalid or ambiguous metadata fails
 * closed instead of being ignored or partially applied.
 */
export function assertValidUnavailableInputPolicy(
  value: unknown,
): asserts value is UnavailableInputPolicy {
  if (!Array.isArray(value)) {
    invalid("policy must be an array");
  }

  const exactPaths = new Set<string>();
  for (let entryIndex = 0; entryIndex < value.length; entryIndex++) {
    const entry = value[entryIndex];
    if (!isPlainRecord(entry)) {
      invalid(`entry ${entryIndex} must be an object`);
    }

    const keys = Object.keys(entry);
    if (
      keys.length !== 2 || !keys.includes("path") ||
      !keys.includes("reasons")
    ) {
      invalid(`entry ${entryIndex} must contain only path and reasons`);
    }

    if (
      !Array.isArray(entry.path) ||
      !entry.path.every((part: unknown) => typeof part === "string")
    ) {
      invalid(`entry ${entryIndex} path must be an array of strings`);
    }

    const pathKey = JSON.stringify(entry.path);
    if (exactPaths.has(pathKey)) {
      invalid(`entry ${entryIndex} has a duplicate exact path`);
    }
    exactPaths.add(pathKey);

    if (!Array.isArray(entry.reasons) || entry.reasons.length === 0) {
      invalid(`entry ${entryIndex} reasons must be a non-empty array`);
    }

    const reasons = new Set<UnavailableObservationKind>();
    for (
      let reasonIndex = 0;
      reasonIndex < entry.reasons.length;
      reasonIndex++
    ) {
      const reason = entry.reasons[reasonIndex];
      if (
        typeof reason !== "string" ||
        !KNOWN_REASONS.has(reason as UnavailableObservationKind)
      ) {
        invalid(
          `entry ${entryIndex} reason ${reasonIndex} is not a known reason`,
        );
      }
      if (reasons.has(reason as UnavailableObservationKind)) {
        invalid(`entry ${entryIndex} has a duplicate reason '${reason}'`);
      }
      reasons.add(reason as UnavailableObservationKind);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(detail: string): never {
  throw new TypeError(`Invalid unavailable input policy: ${detail}`);
}
