/**
 * Top-level `export`ed hashing functions.
 */

import type { FabricValue } from "@/interface.ts";
import type { FabricHash } from "@/fabric-primitives";

import {
  cachedFrozenObjectHashElseUndefined,
  cachedPrimitiveHash,
  FALSE_HASH,
  NEGATIVE_ZERO_HASH,
  NULL_HASH,
  TRUE_HASH,
  UNDEFINED_HASH,
} from "./caching.ts";
import { ValueHasher } from "./ValueHasher.ts";

/**
 * Common helper for the exported hash functions, which _might_ return a plain
 * `string` when passed `stringOkay = true`.
 */
function hashOfInternal(value: unknown, stringOkay: false): FabricHash;
function hashOfInternal(
  value: unknown,
  stringOkay: true,
): FabricHash | string;
function hashOfInternal(
  value: unknown,
  stringOkay: boolean,
): FabricHash | string {
  switch (typeof value) {
    case "boolean":
      return value ? TRUE_HASH : FALSE_HASH;

    case "string":
    case "bigint":
      return cachedPrimitiveHash(value);

    case "number":
      // `Map` keys via SameValueZero, which conflates `-0` with `+0`. Use the
      // pre-computed hash for `-0` so it doesn't collide with (or pollute)
      // the `+0` cache entry.
      return Object.is(value, -0)
        ? NEGATIVE_ZERO_HASH
        : cachedPrimitiveHash(value);

    case "undefined":
      return UNDEFINED_HASH;

    case "symbol": {
      // Only registry-interned symbols are hashable; unique symbols have
      // no portable representation. The throw inside `feedValue()` covers the
      // unique case structurally; check here so that the cache key is sound.
      if (Symbol.keyFor(value) === undefined) {
        throw new Error("Cannot hash unique (uninterned) symbol");
      }
      return cachedPrimitiveHash(value);
    }

    case "object": {
      if (value === null) {
        return NULL_HASH;
      }

      const frozenHash = cachedFrozenObjectHashElseUndefined(value);
      if (frozenHash !== undefined) {
        return frozenHash;
      }

      return stringOkay
        ? ValueHasher.computeHashAsString(value)
        : ValueHasher.computeHash(value);
    }

    default: {
      throw new Error(`Cannot hash value of type \`${typeof value}\``);
    }
  }
}

/**
 * Computes the SHA-256 hash of a `FabricValue`. Returns a `FabricHash` with
 * algorithm tag `fid1` ("Fabric ID, Version 1").
 *
 * Caches results for primitives (LRU) and deep-frozen objects (`WeakMap`).
 */
export function hashOf(value: FabricValue): FabricHash {
  return hashOfInternal(value, false);
}

/**
 * Like `hashOf()`, except always returns a plain string of the hash, encoded as
 * base64url, _without_ a `<type>:` prefix.
 */
export function hashStringOf(value: FabricValue): string {
  const result = hashOfInternal(value, true);
  return (typeof result === "string") ? result : result.hashString;
}

/**
 * Like `hashOf()`, except always returns a plain string of the hash, encoded as
 * base64url, with the `<type>:` prefix.
 */
export function taggedHashStringOf(value: FabricValue): string {
  return hashOfInternal(value, false).toString();
}
