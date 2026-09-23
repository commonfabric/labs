/**
 * Content hashing of `FabricValue`s. This module produces deterministic digests
 * based on values' logical structure.
 *
 * Traverses the value tree directly and feeds type-tagged data into a single
 * SHA-256 context. See Section 6 of the formal spec and the byte-level spec for
 * the full algorithm.
 */

import {
  createHasher,
  type IncrementalHasher,
  sha256,
} from "@commonfabric/content-hash";
import { encodeULEB128 } from "@commonfabric/leb128";
import { bigintToMinimalTwosComplement } from "@commonfabric/utils/bigint";
import { LRUCache } from "@commonfabric/utils/cache";
import { IndexTrackingStack } from "@commonfabric/utils/index-tracking-stack";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";
import { encodeWtf8 } from "@commonfabric/utils/wtf8";

import { isDeepFrozen } from "./deep-freeze.ts";
import type { FabricValue } from "@/interface.ts";
import { shallowFabricFromConvertibleJsValue } from "./convertible-js.ts";
import { tagOfConvertibleJsValueElseNull, VALUE_TAGS } from "@/types";
import { BaseFabricInstance } from "@/fabric-bases";
import { codecOf, NULL_LIVE_ENVIRONMENT } from "@/codec-common";
import {
  FabricBytes,
  FabricHash,
  FabricKeyPair,
  FabricRegExp,
  type FabricUnavailable,
} from "@/fabric-primitives";

//
// Type tag bytes (Section 2 of the byte-level spec)
//

// Meta (0x0N)
const TAG_END = 0x00;
const TAG_HOLE = 0x01;
const TAG_CYCLE = 0x02;

// Compound (0x1N)
const TAG_ARRAY = 0x10;
const TAG_OBJECT = 0x11;
const TAG_INSTANCE = 0x12;

// Primitive (0x2N)
const TAG_NULL = 0x20;
const TAG_UNDEFINED = 0x21;
const TAG_BOOLEAN = 0x22;
const TAG_NUMBER = 0x23;
const TAG_STRING = 0x24;
const TAG_BYTES = 0x25;
const TAG_BIGINT = 0x26;
const TAG_EPOCH_NSEC = 0x27;
const TAG_EPOCH_DAY = 0x28;
const TAG_HASH = 0x29;
const TAG_SYMBOL = 0x2a;
const TAG_REGEXP = 0x2b;
const TAG_KEY_PAIR = 0x2c;
const TAG_UNAVAILABLE = 0x2d;

// Special for hashing:
const TAG_STRING_HASH = 0xf0;

//
// Pre-allocated tag byte arrays (avoids per-call allocation)
//

const TAG_END_BYTES = new Uint8Array([TAG_END]);
const TAG_HOLE_BYTES = new Uint8Array([TAG_HOLE]);
const TAG_CYCLE_BYTES = new Uint8Array([TAG_CYCLE]);
const TAG_ARRAY_BYTES = new Uint8Array([TAG_ARRAY]);
const TAG_OBJECT_BYTES = new Uint8Array([TAG_OBJECT]);
const TAG_INSTANCE_BYTES = new Uint8Array([TAG_INSTANCE]);
const TAG_NULL_BYTES = new Uint8Array([TAG_NULL]);
const TAG_UNDEFINED_BYTES = new Uint8Array([TAG_UNDEFINED]);
const TAG_BOOLEAN_TRUE_BYTES = new Uint8Array([TAG_BOOLEAN, 0x01]);
const TAG_BOOLEAN_FALSE_BYTES = new Uint8Array([TAG_BOOLEAN, 0x00]);
const TAG_NUMBER_BYTES = new Uint8Array([TAG_NUMBER]);
const TAG_BYTES_BYTES = new Uint8Array([TAG_BYTES]);
const TAG_BIGINT_BYTES = new Uint8Array([TAG_BIGINT]);
const TAG_EPOCH_NSEC_BYTES = new Uint8Array([TAG_EPOCH_NSEC]);
const TAG_EPOCH_DAY_BYTES = new Uint8Array([TAG_EPOCH_DAY]);
const TAG_HASH_BYTES = new Uint8Array([TAG_HASH]);
const TAG_SYMBOL_BYTES = new Uint8Array([TAG_SYMBOL]);
const TAG_REGEXP_BYTES = new Uint8Array([TAG_REGEXP]);
const TAG_KEY_PAIR_BYTES = new Uint8Array([TAG_KEY_PAIR]);
const TAG_UNAVAILABLE_BYTES = new Uint8Array([TAG_UNAVAILABLE]);

//
// Core: recursive value feeding
//

/**
 * Maximum encoded length of a string which is represented in just-encoded form.
 * Longer strings are represented in a hash feed as the hash of the string (in
 * Merkle-ish fashion).
 */
const MAX_DIRECT_STRING_LENGTH = 64;

/** Maximum value (inclusive) of the small-length-number cache. */
const MAX_CACHED_SMALL_LENGTH = 500;

/** Reusable 8-byte buffer for float64 encoding. */
const f64Buf = new ArrayBuffer(8);

/** Float64 "view" of `f64Buf`. */
const f64View = new DataView(f64Buf);

/** Byte-array "view" of `f64Buf`. */
const f64Bytes = new Uint8Array(f64Buf);

/**
 * Canonical quiet-NaN payload (big-endian `7F F8 00 00 00 00 00 00`). All NaN
 * bit patterns hash to this single representation.
 */
const CANONICAL_NAN_BYTES = new Uint8Array([
  0x7f,
  0xf8,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
]);

/**
 * LRU cache for string representations. The entry count suits the short,
 * repeated strings this mostly sees — property names, ids, tags. The byte
 * budget covers the rest: values reach this hasher as whole documents and
 * inlined data URIs that run to tens of kilobytes each, and 50,000 of those
 * held by their key alone would be gigabytes.
 */
const stringRepCache = new LRUCache<string, Uint8Array>({
  capacity: 50_000,
  weigh: (key, value) => key.length * 2 + value.length + 64,
  maxWeight: 8 * 1024 * 1024,
});

/** Prepopulated cache of encoded small-length numbers. */
const smallLengthCache: Uint8Array[] = Array.from(
  { length: MAX_CACHED_SMALL_LENGTH + 1 },
  (_, i) => encodeULEB128(i),
);

/**
 * Gets the bytes needed to represent the given string, either by computing it
 * or retrieving a previously-computed result from the cache.
 */
function getStringRep(value: string) {
  const cached = stringRepCache.get(value);
  if (cached !== undefined) return cached;

  const wtf8Buf = encodeWtf8(value);
  const wtf8Length = wtf8Buf.length;

  let result;

  if (wtf8Length <= MAX_DIRECT_STRING_LENGTH) {
    // Contents are: tag + wtf8Length + wtf8.
    const totalLength = 2 + wtf8Length;
    result = new Uint8Array(totalLength);
    result[0] = TAG_STRING;
    result[1] = wtf8Length; // Always fits in a byte!
    result.set(wtf8Buf, 2); // After the tag and length.
  } else {
    const hashBuf = sha256(wtf8Buf);

    // Contents are: tag + hash.
    const totalLength = 1 + hashBuf.length;
    result = new Uint8Array(totalLength);
    result[0] = TAG_STRING_HASH;
    result.set(hashBuf, 1); // After the tag.
  }

  stringRepCache.put(value, result);
  return result;
}

/**
 * Returns the eight bytes that represent the given number in a hash, which are
 * its big-endian IEEE 754 form. Every `NaN` gets `CANONICAL_NAN_BYTES`, and
 * those are not read from the value, so whichever bits an engine holds for a
 * `NaN` have no effect on a hash.
 *
 * The result is good until the next call. For every value other than `NaN`, it
 * is the one buffer this function writes into each time.
 *
 * @internal Exported so that `for-testing-only.ts` can offer it to tests.
 */
export function float64BytesOf(value: number): Uint8Array {
  if (Number.isNaN(value)) {
    return CANONICAL_NAN_BYTES;
  }

  f64View.setFloat64(0, value, false); // big-endian
  return f64Bytes;
}

/**
 * Computes the hash of one value. An instance holds the hasher the value's
 * bytes go into and the path of containers enclosing the position being fed,
 * so it serves exactly one hash: it is made, fed a value, and asked for a
 * digest.
 */
class ValueHasher {
  /** Hasher which receives the value's bytes. */
  readonly #hasher: IncrementalHasher = createHasher();

  /**
   * The containers enclosing the position being fed, outermost first. A
   * container found here is a cycle, and is fed as a reference to its position.
   */
  readonly #path = new IndexTrackingStack<object>();

  //
  // Instance members
  //

  /** Returns the digest of everything fed so far, as a `FabricHash`. */
  digest(): FabricHash {
    return new FabricHash(this.#hasher.digest(), "fid1", true);
  }

  /**
   * Returns the digest of everything fed so far, as a string encoded as
   * `base64url`.
   */
  digestString(): string {
    return this.#hasher.digest("base64url");
  }

  /**
   * Feeds a single `FabricValue` into the hasher, using the type-tagged byte
   * format from the byte-level spec.
   */
  feedValue(value: unknown): void {
    const hasher = this.#hasher;

    switch (typeof value) {
      case "boolean":
        hasher.update(value ? TAG_BOOLEAN_TRUE_BYTES : TAG_BOOLEAN_FALSE_BYTES);
        break;

      case "number":
        hasher.update(TAG_NUMBER_BYTES);
        hasher.update(float64BytesOf(value));
        break;

      case "string": {
        hasher.update(getStringRep(value));
        break;
      }

      case "bigint": {
        hasher.update(TAG_BIGINT_BYTES);
        const bytes = bigintToMinimalTwosComplement(value);
        this.#feedLength(bytes.length);
        hasher.update(bytes);
        break;
      }

      case "symbol": {
        const key = Symbol.keyFor(value);
        if (key === undefined) {
          throw new Error("Cannot hash unique (uninterned) symbol");
        }
        hasher.update(TAG_SYMBOL_BYTES);
        hasher.update(getStringRep(key));
        break;
      }

      case "undefined":
        hasher.update(TAG_UNDEFINED_BYTES);
        break;

      case "object":
        if (value === null) {
          hasher.update(TAG_NULL_BYTES);
        } else {
          this.#feedObjectValue(value);
        }
        break;

      default:
        throw new Error(
          `\`hashOf()\`: unsupported type \`${typeof value}\``,
        );
    }
  }

  /**
   * Feed an array value with sparse hole handling, terminated by `TAG_END`, or
   * a cycle reference if the array is on the path.
   */
  #feedArray(value: unknown[]): void {
    if (this.#feedCycleIfOnPath(value)) {
      return;
    }

    const hasher = this.#hasher;
    const path = this.#path;

    path.push(value);
    hasher.update(TAG_ARRAY_BYTES);
    let i = 0;
    while (i < value.length) {
      if (!(i in value)) {
        // Start of a hole run -- coalesce consecutive holes.
        let runLen = 0;
        while (i < value.length && !(i in value)) {
          runLen++;
          i++;
        }
        hasher.update(TAG_HOLE_BYTES);
        this.#feedLength(runLen);
      } else {
        this.feedValue(value[i]);
        i++;
      }
    }
    hasher.update(TAG_END_BYTES);
    path.pop();
  }

  /**
   * Feeds a cycle reference into the hasher if the given container is on the
   * path. Returns whether it did.
   */
  #feedCycleIfOnPath(value: object): boolean {
    const path = this.#path;
    const at = path.lastIndexOf(value);

    if (at < 0) {
      return false;
    }

    this.#hasher.update(TAG_CYCLE_BYTES);
    this.#feedLength(path.depth - at);
    return true;
  }

  /**
   * Feeds a length value into the hasher, using the standard in-hash encoding
   * for same.
   */
  #feedLength(value: number): void {
    const valueBuf = (value <= MAX_CACHED_SMALL_LENGTH)
      ? smallLengthCache[value]!
      : encodeULEB128(value);

    this.#hasher.update(valueBuf);
  }

  /**
   * Feed an object-typed value (`FabricPrimitive`, `FabricInstance`, `Array`,
   * or plain object) into the hasher. Dispatches via
   * `tagOfConvertibleJsValueElseNull()` / `VALUE_TAGS` for recognized types.
   * The `null` case is handled by the caller (`feedValue()`).
   */
  #feedObjectValue(value: object): void {
    const hasher = this.#hasher;
    const tag = tagOfConvertibleJsValueElseNull(value);

    switch (tag) {
      case VALUE_TAGS.FabricEpochNsec: {
        hasher.update(TAG_EPOCH_NSEC_BYTES);
        const bytes = bigintToMinimalTwosComplement(
          (value as { value: bigint }).value,
        );
        this.#feedLength(bytes.length);
        hasher.update(bytes);
        return;
      }

      case VALUE_TAGS.FabricEpochDay: {
        hasher.update(TAG_EPOCH_DAY_BYTES);
        const bytes = bigintToMinimalTwosComplement(
          (value as { value: bigint }).value,
        );
        this.#feedLength(bytes.length);
        hasher.update(bytes);
        return;
      }

      case VALUE_TAGS.FabricHash: {
        const cid = value as FabricHash;
        hasher.update(TAG_HASH_BYTES);
        hasher.update(getStringRep(cid.tag));
        // TODO(@danfuzz): Look into avoiding making a copy of bytes here.
        // This could be a performance issue.
        const cidBytes = cid.bytes;
        this.#feedLength(cidBytes.length);
        hasher.update(cidBytes);
        return;
      }

      case VALUE_TAGS.Array:
        this.#feedArray(value as unknown[]);
        return;

      case VALUE_TAGS.Object:
        this.#feedPlainObject(value as Record<string, unknown>);
        return;

      case VALUE_TAGS.FabricBytes: {
        hasher.update(TAG_BYTES_BYTES);
        const fab = value as FabricBytes;
        this.#feedLength(fab.length);
        hasher.update(fab.slice());
        return;
      }

      case VALUE_TAGS.FabricInstance: {
        if (this.#feedCycleIfOnPath(value)) {
          return;
        }
        const fabInst = value as BaseFabricInstance;
        hasher.update(TAG_INSTANCE_BYTES);
        const codec = codecOf(fabInst);
        hasher.update(getStringRep(codec.tagForValue(fabInst)));
        const state = codec.encode(fabInst, NULL_LIVE_ENVIRONMENT);
        this.#path.push(fabInst);
        this.feedValue(state);
        this.#path.pop();
        return;
      }

      case VALUE_TAGS.FabricKeyPair: {
        const fab = value as FabricKeyPair;
        if (!fab.hasMaterial) {
          // A pair holding handles has no content to hash: its material is
          // unreachable, and the algorithm alone is shared by every key that
          // uses it.
          throw new Error(
            "`hashOf()`: cannot hash a key pair that holds handles.",
          );
        }
        hasher.update(TAG_KEY_PAIR_BYTES);
        this.feedValue(fab.algorithm);
        this.feedValue(fab.publicKeyBytes);
        this.feedValue(fab.privateKeyBytes);
        return;
      }

      case VALUE_TAGS.FabricRegExp: {
        const fab = value as FabricRegExp;
        hasher.update(TAG_REGEXP_BYTES);
        this.feedValue(fab.source);
        this.feedValue(fab.flags);
        this.feedValue(fab.flavor);
        return;
      }

      case VALUE_TAGS.FabricUnavailable: {
        const fab = value as FabricUnavailable;
        hasher.update(TAG_UNAVAILABLE_BYTES);
        this.feedValue(fab.reason);
        this.feedValue(fab.errorKind);
        this.feedValue(fab.rawErrorMessage);
        return;
      }

      case VALUE_TAGS.JsDate:
      case VALUE_TAGS.JsRegExp:
      case VALUE_TAGS.JsUint8Array: {
        // Native instances that have a well-defined `FabricValue` conversion.
        // Convert on-the-fly and hash the converted value.
        const converted = shallowFabricFromConvertibleJsValue(value, false);
        this.feedValue(converted);
        return;
      }

      default: {
        // Nothing else is handled. As of this writing, specifically missing are
        // `Map`, `Set`, and `Error`.
        throw new Error(
          `\`hashOf()\`: unsupported object type ${
            backtickQuote(value?.constructor?.name ?? typeof value)
          }`,
        );
      }
    }
  }

  /**
   * Feed a plain object value, keys sorted by the byte order of their WTF-8
   * encoding, terminated by `TAG_END`, or a cycle reference if the object is on
   * the path.
   */
  #feedPlainObject(value: Record<string, unknown>): void {
    if (this.#feedCycleIfOnPath(value)) {
      return;
    }

    const hasher = this.#hasher;
    const path = this.#path;

    path.push(value);

    // Note: Even though we could conceivably define the key sort order to be
    // something easier to calculate in JS, (a) ultimately we want this
    // implementation to be but one of several that aren't all written in JS,
    // (b) those other languages don't necessarily have the same encoding bias
    // as JS, and (c) we want to make the specification for hashing
    // straightforward anyway (and are willing to pay a performance cost
    // because of it).
    const keys = utf8SortedKeysOf(value);

    hasher.update(TAG_OBJECT_BYTES);
    for (const key of keys) {
      // Keys are encoded in the same format as strings, and values are hashed
      // recursively.
      hasher.update(getStringRep(key));
      this.feedValue(value[key]);
    }
    hasher.update(TAG_END_BYTES);
    path.pop();
  }

  //
  // Static members
  //

  /**
   * Computes the hash of a value without consulting or populating any cache.
   */
  static computeHash(value: unknown): FabricHash {
    const valueHasher = new ValueHasher();
    valueHasher.feedValue(value);
    return valueHasher.digest();
  }

  /**
   * Like `computeHash()`, except it returns a simple string hash value,
   * encoded as `base64url`, rather than a hash object.
   */
  static computeHashAsString(value: unknown): string {
    const valueHasher = new ValueHasher();
    valueHasher.feedValue(value);
    return valueHasher.digestString();
  }
}

//
// Caches
//

/** Pre-computed hash of `null`. */
const NULL_HASH = ValueHasher.computeHash(null);

/** Pre-computed hash of `undefined`. */
const UNDEFINED_HASH = ValueHasher.computeHash(undefined);

/** Pre-computed hash of `true`. */
const TRUE_HASH = ValueHasher.computeHash(true);

/** Pre-computed hash of `false`. */
const FALSE_HASH = ValueHasher.computeHash(false);

/** Pre-computed hash of negative zero. */
const NEGATIVE_ZERO_HASH = ValueHasher.computeHash(-0);

/**
 * LRU cache for primitive value hashes. Primitives (strings, numbers,
 * bigints, registry-interned symbols) can't be WeakMap keys, so they use a
 * bounded cache. Sizing is based on historical testing (expected ~97% hit
 * rate in practice).
 *
 * A string key is held by the cache itself, and a hashed string can be a
 * whole document: an inline document's `data:` URI runs to tens of thousands
 * of characters. The entry count alone would let 50,000 of those add up to
 * gigabytes, so the same byte budget `stringRepCache` carries applies here,
 * and the count bounds the short keys that make up the rest.
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

let frozenObjectHashCacheHits = 0;

/** Counts `hashOf` and `hashStringOf` calls served by the frozen-object cache. */
export function getFrozenObjectHashCacheHits(): number {
  return frozenObjectHashCacheHits;
}

/**
 * Looks up the given primitive in the LRU cache, computing and storing on
 * miss. Caller must filter out values that don't behave under `Map`'s
 * SameValueZero keying (notably `-0`, which collides with `+0`).
 */
function cachedPrimitiveHash(
  value: string | number | bigint | symbol,
): FabricHash {
  const cached = primitiveHashCache.get(value);
  if (cached !== undefined) return cached;
  const result = ValueHasher.computeHash(value);
  primitiveHashCache.put(value, result);
  return result;
}

//
// Public API
//

/**
 * Common helper for the two exported hash functions, which _might_ return a
 * plain `string` when passed `stringOkay = true`.
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

      const obj = value as object;

      // Even if we don't know that `obj` is deep-frozen, it's okay to look it
      // up in the cache for same (we just won't find it if it's not
      // deep-frozen). And doing this lookup first minimizes the number of
      // checks needed on the fast path.
      const cached = frozenObjectHashCache.get(obj);
      if (cached !== undefined) {
        frozenObjectHashCacheHits += 1;
        return cached;
      }

      if (isDeepFrozen(value)) {
        const result = ValueHasher.computeHash(value);
        frozenObjectHashCache.set(obj, result);
        return result;
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
export function hashStringOf(value: unknown): string {
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
