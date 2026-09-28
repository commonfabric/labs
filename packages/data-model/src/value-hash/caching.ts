/**
 * The caches the hash entry points consult before hashing anything: constant
 * hashes for the values that have one, a bounded cache for the other
 * primitives, and an identity cache for deep-frozen objects.
 */

import { LRUCache } from "@commonfabric/utils/cache";

import { isDeepFrozen } from "@/deep-freeze.ts";
import type { FabricHash } from "@/fabric-primitives";
import type { FabricContainerValue, FabricPrimitive } from "@/interface.ts";

import { ValueHasher } from "./ValueHasher.ts";

/**
 * LRU cache for primitive value hashes. Primitives (strings, numbers,
 * bigints, registry-interned symbols) can't be WeakMap keys, so they use a
 * bounded cache. Sizing is based on historical testing (expected ~97% hit
 * rate in practice).
 *
 * A string key is held by the cache itself, and a hashed string can be a
 * whole document: an inline document's `data:` URI runs to tens of thousands
 * of characters. The entry count alone would let 50,000 of those add up to
 * gigabytes, so the same byte budget that `stringRepCache` in `ValueHasher.ts`
 * carries applies here, and the count bounds the short keys that make up the
 * rest.
 */
const primitiveHashCache = new LRUCache<
  string | number | bigint | symbol,
  FabricHash
>({
  capacity: 50_000,
  weigh: (key) => (typeof key === "string" ? key.length * 2 : 16) + 96,
  maxWeight: 8 * 1024 * 1024,
});

/**
 * WeakMap cache for deep-frozen object hashes. Deep-frozen objects are
 * immutable, so their hash is stable and safe to cache by identity.
 * Mutable objects are always recomputed.
 */
const frozenObjectHashCache = new WeakMap<object, FabricHash>();

/**
 * How many hashes `frozenObjectHashCache` has served, counted from when this
 * module loaded. Only a test or a benchmark reads it, through
 * `getFrozenObjectHashCacheHits()`.
 */
let frozenObjectHashCacheHits = 0;

/** Pre-computed hash of `null`. */
export const NULL_HASH = ValueHasher.computeHash(null);

/** Pre-computed hash of `undefined`. */
export const UNDEFINED_HASH = ValueHasher.computeHash(undefined);

/** Pre-computed hash of `true`. */
export const TRUE_HASH = ValueHasher.computeHash(true);

/** Pre-computed hash of `false`. */
export const FALSE_HASH = ValueHasher.computeHash(false);

/** Pre-computed hash of negative zero. */
export const NEGATIVE_ZERO_HASH = ValueHasher.computeHash(-0);

/**
 * Returns the hash of the given object if it is deep-frozen, from the cache
 * when it is there and computing and storing it when it is not, or `undefined`
 * if the object is not deep-frozen.
 */
export function cachedFrozenObjectHashElseUndefined(
  value: FabricContainerValue | FabricPrimitive,
): FabricHash | undefined {
  // Even if we don't know that `value` is deep-frozen, it's okay to look it up
  // in the cache for same (we just won't find it if it's not deep-frozen). And
  // doing this lookup first minimizes the number of checks needed on the fast
  // path.
  const cached = frozenObjectHashCache.get(value);
  if (cached !== undefined) {
    frozenObjectHashCacheHits += 1;
    return cached;
  }

  if (isDeepFrozen(value)) {
    const result = ValueHasher.computeHash(value);
    frozenObjectHashCache.set(value, result);
    return result;
  }

  return undefined;
}

/**
 * Looks up the given primitive in the LRU cache, computing and storing on
 * miss. Caller must filter out values that don't behave under `Map`'s
 * SameValueZero keying (notably `-0`, which collides with `+0`).
 */
export function cachedPrimitiveHash(
  value: string | number | bigint | symbol,
): FabricHash {
  const cached = primitiveHashCache.get(value);
  if (cached !== undefined) return cached;
  const result = ValueHasher.computeHash(value);
  primitiveHashCache.put(value, result);
  return result;
}

/**
 * Counts the hashes served by the frozen-object cache.
 *
 * @internal Not in the `value-hash` barrel; `for-testing-only.ts` offers it to
 * tests.
 */
export function getFrozenObjectHashCacheHits(): number {
  return frozenObjectHashCacheHits;
}
