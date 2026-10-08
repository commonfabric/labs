/**
 * Conformance cases for the content hash, and what turns them into a
 * language-neutral fixture. An implementation of `hashOf()` in another
 * language tests against the fixture rather than against this package's code.
 *
 * Each case is a value, and the fixture records what this package's hasher
 * does with it: the bytes it feeds SHA-256, the digest, and the digest's string
 * form, or the refusal. Values are written in the descriptor notation that
 * `test/fixtures/value-descriptors.md` defines.
 *
 * Where the byte-level spec gives a value's bytes outright, the case quotes
 * them, and the fixture records the spec's outcome. A case whose quote this
 * package does not feed says so as a divergence, and this package's outcome
 * goes beside the spec's. Generating the fixture fails when a quote and this
 * package disagree with no divergence declared, and when a declared divergence
 * does not hold.
 *
 * The hash agrees with `valueEqual()`: two values' hashes are equal exactly
 * when the values are `valueEqual()`, which `test/hash-conformance.test.ts`
 * holds every two cases to. Where two cases' values hash the same and their
 * descriptors differ, as for a link and an unknown value preserving a link's
 * tag and state, the cases have to say so, one naming the other as its equal,
 * and generating the fixture fails otherwise.
 *
 * This is reached through `for-testing-only.ts` and has no place in any
 * barrel.
 */

import {
  createHasher,
  type IncrementalHasher,
  sha256,
} from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";

import type { FabricValue } from "@/interface.ts";
import { UnknownValue } from "@/codec-common";
import { deepFreeze } from "@/deep-freeze.ts";
import {
  FabricError,
  type FabricInstanceClassesByName,
  FabricLink,
} from "@/fabric-instances";
import {
  FabricBytes,
  FabricDurationDay,
  FabricDurationNsec,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  type FabricPrimitiveClassesByName,
  FabricRegExp,
  FabricUnavailable,
} from "@/fabric-primitives";
import { hashOf } from "@/value-hash";
import {
  assertDistinctCaseNames,
  bytesOfHex,
  type ClassCaseNotes,
  classCasesOf,
  descriptorOf,
  type ExampleMakers,
  fixtureTextOf,
  hexOf,
  sparseArrayOf,
  STUB_CODEC_EXCLUSION,
  type ValueDescriptor,
} from "./conformance-fixtures.ts";
import { ValueHasher } from "./value-hash/ValueHasher.ts";

//
// Types
//

/**
 * What hashing one value does: feeds SHA-256 these bytes, giving this digest,
 * whose string form is this, or is refused. The stream and the digest are in
 * lowercase hexadecimal.
 */
export type HashOutcome = HashedOutcome | { readonly refused: "unhashable" };

/** What hashing one value does when it is not refused. */
export type HashedOutcome = {
  readonly stream: string;
  readonly digest: string;
  readonly string: string;
};

/**
 * One conformance case: a value to hash, made fresh by `make`.
 *
 * `section` names the part of the spec the case exercises. `spec` is the byte
 * stream the spec gives the value, in hexadecimal as the spec writes it,
 * spaces and all, for a value it gives one for. `equals` names another case,
 * earlier among the cases, whose value this one's is `valueEqual()` to.
 * `divergence` is a note on what the spec requires, for a case where this
 * package does not do it, and can only be declared for a case with a `spec`:
 * that is the only place the spec's outcome is known apart from this
 * package's.
 */
export type HashConformanceCase = {
  readonly name: string;
  readonly section: string;
  readonly make: () => FabricValue;
  readonly spec?: string;
  readonly equals?: string;
  readonly divergence?: string;
};

//
// The cases
//

/**
 * Returns every conformance case: the fixed ones below, and one for each
 * example the given makers make, so that a class added to either table of
 * classes is a case without anything here changing.
 */
export function hashConformanceCases(
  primitiveMakers: ExampleMakers<FabricPrimitiveClassesByName>,
  instanceMakers: ExampleMakers<FabricInstanceClassesByName>,
): readonly HashConformanceCase[] {
  return Object.freeze([
    ...FIXED_CASES,
    ...classCasesOf(primitiveMakers, PRIMITIVE_CLASS_NOTES),
    ...classCasesOf(instanceMakers, INSTANCE_CLASS_NOTES),
  ]);
}

const SECTION_NULL = "2-hash-byte-format.md section 4.1";
const SECTION_BOOLEAN = "2-hash-byte-format.md section 4.2";
const SECTION_NUMBER = "2-hash-byte-format.md section 4.3";
const SECTION_STRING = "2-hash-byte-format.md section 4.4";
const SECTION_BIGINT = "2-hash-byte-format.md section 4.5";
const SECTION_SYMBOL = "2-hash-byte-format.md section 4.6";
const SECTION_UNDEFINED = "2-hash-byte-format.md section 4.7";
const SECTION_BYTES = "2-hash-byte-format.md section 4.8";
const SECTION_EPOCH_NSEC = "2-hash-byte-format.md section 4.9";
const SECTION_EPOCH_DAY = "2-hash-byte-format.md section 4.10";
const SECTION_HASH = "2-hash-byte-format.md section 4.11";
const SECTION_ARRAY = "2-hash-byte-format.md section 4.12";
const SECTION_OBJECT = "2-hash-byte-format.md section 4.13";
const SECTION_INSTANCE = "2-hash-byte-format.md section 4.14";
const SECTION_HOLES = "2-hash-byte-format.md section 4.15";
const SECTION_REGEXP = "2-hash-byte-format.md section 4.16";
const SECTION_KEY_PAIR = "2-hash-byte-format.md section 4.17";
const SECTION_UNAVAILABLE = "2-hash-byte-format.md section 4.18";
const SECTION_CYCLES = "2-hash-byte-format.md section 4.19";
const SECTION_DURATION_NSEC = "2-hash-byte-format.md section 4.20";
const SECTION_DURATION_DAY = "2-hash-byte-format.md section 4.21";
const SECTION_KEY_ORDER = "2-hash-byte-format.md section 5";
const SECTION_REJECTED = "2-hash-byte-format.md section 8";
const SECTION_EQUALITY = "1-fabric-values.md section 6.7";

/** The cases that do not range over the class tables. */
const FIXED_CASES: readonly HashConformanceCase[] = [
  // Fixed-size primitives.
  { name: "null", section: SECTION_NULL, spec: "20", make: () => null },
  { name: "true", section: SECTION_BOOLEAN, spec: "22 01", make: () => true },
  {
    name: "false",
    section: SECTION_BOOLEAN,
    spec: "22 00",
    make: () => false,
  },
  {
    name: "undefined",
    section: SECTION_UNDEFINED,
    spec: "21",
    make: () => undefined,
  },

  // Numbers.
  {
    name: "integer",
    section: SECTION_NUMBER,
    spec: "23 40 45 00 00 00 00 00 00",
    make: () => 42,
  },
  {
    name: "one",
    section: SECTION_NUMBER,
    spec: "23 3F F0 00 00 00 00 00 00",
    make: () => 1,
  },
  {
    name: "zero",
    section: SECTION_NUMBER,
    spec: "23 00 00 00 00 00 00 00 00",
    make: () => 0,
  },
  {
    name: "negative zero",
    section: SECTION_NUMBER,
    spec: "23 80 00 00 00 00 00 00 00",
    make: () => -0,
  },
  {
    name: "NaN",
    section: SECTION_NUMBER,
    spec: "23 7F F8 00 00 00 00 00 00",
    make: () => NaN,
  },
  {
    name: "NaN of other bits",
    section: SECTION_NUMBER,
    equals: "NaN",
    // A negative quiet `NaN` with a payload. Whether an engine keeps those
    // bits is its own affair; either way, every `NaN` hashes as the one.
    make: () => {
      const view = new DataView(new ArrayBuffer(8));
      view.setUint32(0, 0xfff80000);
      view.setUint32(4, 1);
      return view.getFloat64(0);
    },
  },
  {
    name: "positive infinity",
    section: SECTION_NUMBER,
    spec: "23 7F F0 00 00 00 00 00 00",
    make: () => Infinity,
  },
  {
    name: "negative infinity",
    section: SECTION_NUMBER,
    spec: "23 FF F0 00 00 00 00 00 00",
    make: () => -Infinity,
  },
  { name: "negative fraction", section: SECTION_NUMBER, make: () => -1.5 },
  { name: "inexact fraction", section: SECTION_NUMBER, make: () => 0.1 },
  {
    name: "smallest subnormal",
    section: SECTION_NUMBER,
    make: () => Number.MIN_VALUE,
  },
  {
    name: "largest double",
    section: SECTION_NUMBER,
    make: () => Number.MAX_VALUE,
  },
  {
    name: "largest safe integer",
    section: SECTION_NUMBER,
    make: () => Number.MAX_SAFE_INTEGER,
  },
  {
    name: "integer past 2^53",
    section: SECTION_NUMBER,
    make: () => 2 ** 53 + 2,
  },
  { name: "large exponent", section: SECTION_NUMBER, make: () => 1e21 },

  // Strings, and where the direct form gives way to the hashed one.
  {
    name: "string",
    section: SECTION_STRING,
    spec: "24 05 68 65 6C 6C 6F",
    make: () => "hello",
  },
  {
    name: "empty string",
    section: SECTION_STRING,
    spec: "24 00",
    make: () => "",
  },
  {
    name: "string of characters JSON escapes",
    section: SECTION_STRING,
    make: () => '"\\/\b\f\n\r\t\u0000\u001f\u007f ',
  },
  {
    name: "string beyond ASCII",
    section: SECTION_STRING,
    make: () => "é\u{1F600}￿",
  },
  { name: "string in NFC", section: SECTION_STRING, make: () => "é" },
  { name: "string in NFD", section: SECTION_STRING, make: () => "é" },
  {
    name: "lone high surrogate",
    section: SECTION_STRING,
    spec: "24 03 ED A0 80",
    make: () => "\ud800",
  },
  {
    name: "lone low surrogate between characters",
    section: SECTION_STRING,
    make: () => "a\udc00b",
  },
  {
    name: "surrogates in reverse order",
    section: SECTION_STRING,
    make: () => "\udc00\ud800",
  },
  {
    name: "replacement character",
    section: SECTION_STRING,
    make: () => "�",
  },
  {
    name: "string of 64 UTF-8 bytes in ASCII",
    section: SECTION_STRING,
    make: () => "a".repeat(64),
  },
  {
    name: "string of 65 UTF-8 bytes in ASCII",
    section: SECTION_STRING,
    make: () => "a".repeat(65),
  },
  {
    name: "string of 64 UTF-8 bytes in 32 code units",
    section: SECTION_STRING,
    make: () => "é".repeat(32),
  },
  {
    name: "string of 66 UTF-8 bytes in 33 code units",
    section: SECTION_STRING,
    make: () => "é".repeat(33),
  },
  {
    name: "string of 65 UTF-8 bytes in 64 code units",
    section: SECTION_STRING,
    make: () => "a".repeat(63) + "é",
  },
  {
    name: "string of 64 UTF-8 bytes in supplementary characters",
    section: SECTION_STRING,
    make: () => "\u{1F600}".repeat(16),
  },
  {
    name: "string of 66 WTF-8 bytes in lone surrogates",
    section: SECTION_STRING,
    make: () => "\ud800".repeat(22),
  },

  // Bigints.
  {
    name: "bigint zero",
    section: SECTION_BIGINT,
    spec: "26 01 00",
    make: () => 0n,
  },
  {
    name: "bigint 127",
    section: SECTION_BIGINT,
    spec: "26 01 7F",
    make: () => 127n,
  },
  {
    name: "bigint 128",
    section: SECTION_BIGINT,
    spec: "26 02 00 80",
    make: () => 128n,
  },
  {
    name: "bigint minus one",
    section: SECTION_BIGINT,
    spec: "26 01 FF",
    make: () => -1n,
  },
  {
    name: "bigint minus 128",
    section: SECTION_BIGINT,
    spec: "26 01 80",
    make: () => -128n,
  },
  {
    name: "bigint minus 129",
    section: SECTION_BIGINT,
    spec: "26 02 FF 7F",
    make: () => -129n,
  },
  { name: "bigint 42", section: SECTION_BIGINT, make: () => 42n },
  { name: "bigint 2^64", section: SECTION_BIGINT, make: () => 2n ** 64n },
  {
    name: "bigint minus 2^64",
    section: SECTION_BIGINT,
    make: () => -(2n ** 64n),
  },
  {
    name: "bigint of twelve distinct bytes",
    section: SECTION_BIGINT,
    make: () => 0x112233445566778899abcdefn,
  },
  {
    name: "bigint of 129 bytes",
    section: SECTION_BIGINT,
    make: () => 2n ** 1024n,
  },
  {
    name: "bigint of 129 bytes, negative",
    section: SECTION_BIGINT,
    make: () => -(2n ** 1024n) - 1n,
  },

  // Symbols, and the ones refused.
  {
    name: "registered symbol",
    section: SECTION_SYMBOL,
    make: () => Symbol.for("key"),
  },
  {
    name: "string of a registered symbol's key",
    section: SECTION_SYMBOL,
    make: () => "key",
  },
  {
    name: "registered symbol with the empty key",
    section: SECTION_SYMBOL,
    make: () => Symbol.for(""),
  },
  {
    name: "registered symbol with a key of 65 UTF-8 bytes",
    section: SECTION_SYMBOL,
    make: () => Symbol.for("k".repeat(65)),
  },
  {
    name: "unregistered symbol",
    section: SECTION_REJECTED,
    make: () => Symbol("local"),
  },
  {
    name: "unregistered symbol with no description",
    section: SECTION_REJECTED,
    make: () => Symbol(),
  },
  {
    name: "unregistered symbol with the empty description",
    section: SECTION_REJECTED,
    make: () => Symbol(""),
  },
  {
    name: "unregistered symbol in a record",
    section: SECTION_REJECTED,
    make: () => ({ s: Symbol("local") }),
  },
  {
    name: "unregistered symbol in an array",
    section: SECTION_REJECTED,
    make: () => [1, Symbol("local")],
  },

  // Bytes.
  {
    name: "empty bytes",
    section: SECTION_BYTES,
    spec: "25 00",
    make: () => new FabricBytes(new Uint8Array()),
  },
  {
    name: "bytes 128 long",
    section: SECTION_BYTES,
    make: () => new FabricBytes(Uint8Array.from({ length: 128 }, (_, i) => i)),
  },
  {
    name: "bytes 300 long",
    section: SECTION_BYTES,
    make: () =>
      new FabricBytes(Uint8Array.from({ length: 300 }, (_, i) => i % 256)),
  },
  {
    name: "bytes deadbeef",
    section: SECTION_BYTES,
    make: () => new FabricBytes(new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
  },
  {
    name: "bytes deadbeef, viewed through part of a larger buffer",
    section: SECTION_BYTES,
    equals: "bytes deadbeef",
    make: () =>
      new FabricBytes(
        new Uint8Array([0, 0xde, 0xad, 0xbe, 0xef, 0]).subarray(1, 5),
      ),
  },

  // Temporal quantities.
  {
    name: "epoch nanoseconds zero",
    section: SECTION_EPOCH_NSEC,
    spec: "27 01 00",
    make: () => new FabricEpochNsec(0n),
  },
  {
    name: "epoch nanoseconds of an instant in 2023",
    section: SECTION_EPOCH_NSEC,
    make: () => new FabricEpochNsec(1_700_000_000_123_456_789n),
  },
  {
    name: "epoch nanoseconds 2^63",
    section: SECTION_EPOCH_NSEC,
    make: () => new FabricEpochNsec(2n ** 63n),
  },
  {
    name: "epoch nanoseconds minus 2^63",
    section: SECTION_EPOCH_NSEC,
    make: () => new FabricEpochNsec(-(2n ** 63n)),
  },
  {
    name: "epoch nanoseconds 42",
    section: SECTION_EPOCH_NSEC,
    make: () => new FabricEpochNsec(42n),
  },
  {
    name: "epoch days 42",
    section: SECTION_EPOCH_DAY,
    spec: "28 01 2A",
    make: () => new FabricEpochDay(42n),
  },
  {
    name: "duration nanoseconds 42",
    section: SECTION_DURATION_NSEC,
    spec: "2E 01 2A",
    make: () => new FabricDurationNsec(42n),
  },
  {
    name: "duration days 42",
    section: SECTION_DURATION_DAY,
    make: () => new FabricDurationDay(42n),
  },
  {
    name: "duration days 7",
    section: SECTION_DURATION_DAY,
    spec: "2F 01 07",
    make: () => new FabricDurationDay(7n),
  },

  // Hashes.
  {
    name: "hash of four bytes",
    section: SECTION_HASH,
    spec: "29  24 04 66 69 64 31  04  DE AD BE EF",
    make: () =>
      new FabricHash(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), "fid1"),
  },
  {
    name: "hash of no bytes",
    section: SECTION_HASH,
    make: () => new FabricHash(new Uint8Array(), "fid1"),
  },
  {
    name: "hash under an algorithm tag of 65 UTF-8 bytes",
    section: SECTION_HASH,
    make: () => new FabricHash(new Uint8Array([1]), "t".repeat(65)),
  },

  // Regular expressions.
  {
    name: "regular expression",
    section: SECTION_REGEXP,
    spec: "2B  24 03 61 62 63  24 02 67 69  24 06 65 73 32 30 32 35",
    make: () => new FabricRegExp(/abc/gi),
  },
  {
    name: "regular expression from its parts",
    section: SECTION_REGEXP,
    equals: "regular expression",
    make: () => new FabricRegExp("es2025", "abc", "gi"),
  },
  {
    name: "regular expression of another flavor",
    section: SECTION_REGEXP,
    make: () => new FabricRegExp("other", "abc", "gi"),
  },
  {
    name: "regular expression of a source of 65 UTF-8 bytes",
    section: SECTION_REGEXP,
    make: () => new FabricRegExp("es2025", "x".repeat(65), ""),
  },

  // Key pairs.
  {
    name: "key pair",
    section: SECTION_KEY_PAIR,
    spec: "2C  24 07 45 64 32 35 35 31 39  25 02 DE AD  25 03 BE EF 01",
    make: () =>
      new FabricKeyPair(
        "Ed25519",
        new Uint8Array([0xde, 0xad]),
        new Uint8Array([0xbe, 0xef, 0x01]),
      ),
  },
  {
    name: "key pair with its keys the other way round",
    section: SECTION_KEY_PAIR,
    make: () =>
      new FabricKeyPair(
        "Ed25519",
        new Uint8Array([0xbe, 0xef, 0x01]),
        new Uint8Array([0xde, 0xad]),
      ),
  },

  // Unavailable data.
  {
    name: "unavailable with an error kind and a message",
    section: SECTION_UNAVAILABLE,
    spec: "2D  24 05 65 72 72 6F 72  24 07 6E 65 74 77 6F 72 6B  " +
      "24 04 62 6F 6F 6D",
    make: () => new FabricUnavailable("error", "network", "boom"),
  },
  {
    name: "unavailable and pending",
    section: SECTION_UNAVAILABLE,
    spec: "2D  24 07 70 65 6E 64 69 6E 67  20  20",
    make: () => new FabricUnavailable("pending"),
  },
  {
    name: "unavailable with an error kind and no message",
    section: SECTION_UNAVAILABLE,
    make: () => new FabricUnavailable("error", "network"),
  },
  {
    name: "unavailable with an error kind and its default message",
    section: SECTION_UNAVAILABLE,
    equals: "unavailable with an error kind and no message",
    make: () =>
      new FabricUnavailable(
        "error",
        "network",
        new FabricUnavailable("error", "network").errorMessage,
      ),
  },

  // Arrays and holes.
  {
    name: "empty array",
    section: SECTION_ARRAY,
    spec: "10 00",
    make: () => [],
  },
  {
    name: "nested arrays",
    section: SECTION_ARRAY,
    make: () => [1, [2, [3, []]]],
  },
  {
    name: "array with a hole",
    section: SECTION_HOLES,
    spec: "10  23 3F F0 00 00 00 00 00 00  01 01  " +
      "23 40 08 00 00 00 00 00 00  00",
    make: () => sparseArrayOf(3, [[0, 1], [2, 3]]),
  },
  {
    name: "array with an undefined",
    section: SECTION_HOLES,
    spec: "10  23 3F F0 00 00 00 00 00 00  21  " +
      "23 40 08 00 00 00 00 00 00  00",
    make: () => [1, undefined, 3],
  },
  {
    name: "array with a null",
    section: SECTION_HOLES,
    spec: "10  23 3F F0 00 00 00 00 00 00  20  " +
      "23 40 08 00 00 00 00 00 00  00",
    make: () => [1, null, 3],
  },
  {
    name: "array of holes only",
    section: SECTION_HOLES,
    make: () => new Array(3),
  },
  {
    name: "array ending in a hole",
    section: SECTION_HOLES,
    make: () => sparseArrayOf(2, [[0, 1]]),
  },
  {
    name: "array with a run of 128 holes",
    section: SECTION_HOLES,
    make: () => sparseArrayOf(130, [[0, 1], [129, 2]]),
  },
  {
    name: "array with a long run of holes",
    section: SECTION_HOLES,
    make: () => sparseArrayOf(1_000_001, [[1_000_000, "x"]]),
  },
  {
    name: "array holding a record shaped like a hole run",
    section: SECTION_HOLES,
    make: () => [{ "/hole": 1 }, 1],
  },

  // Records, and the order of their keys.
  {
    name: "empty record",
    section: SECTION_OBJECT,
    spec: "11 00",
    make: () => ({}),
  },
  {
    name: "record",
    section: SECTION_OBJECT,
    spec: "11  24 01 61  23 3F F0 00 00 00 00 00 00  " +
      "24 01 62  23 40 00 00 00 00 00 00 00  00",
    make: () => ({ a: 1, b: 2 }),
  },
  {
    name: "record with its keys made in another order",
    section: SECTION_EQUALITY,
    equals: "record",
    make: () => ({ b: 2, a: 1 }),
  },
  {
    name: "record holding an undefined",
    section: SECTION_OBJECT,
    make: () => ({ u: undefined }),
  },
  {
    name: "record keys in UTF-8 order",
    section: SECTION_KEY_ORDER,
    // Built from entries, a linter reading the two lone surrogates as one
    // key in an object literal.
    make: () =>
      Object.fromEntries([
        ["b", 1],
        ["a", 2],
        ["B", 3],
        ["", 4],
        ["é", 5],
        ["é", 6],
        ["￿", 7],
        ["\u{1F600}", 8],
        ["\udc00", 9],
        ["\ud800", 10],
      ]),
  },
  {
    name: "record keys of a supplementary and a private-use character",
    section: SECTION_KEY_ORDER,
    make: () => ({ "\u{10000}": 1, "": 2 }),
  },
  {
    name: "record keys that read as integers",
    section: SECTION_KEY_ORDER,
    make: () => ({ "2": "two", "10": "ten", a: "a" }),
  },
  {
    name: "record with a key of 65 UTF-8 bytes",
    section: SECTION_OBJECT,
    make: () => ({ ["k".repeat(65)]: 1, k: 2 }),
  },
  {
    name: "record with a slash key",
    section: SECTION_OBJECT,
    make: () => ({ "/a": 1 }),
  },
  {
    name: "record with a slash key alone",
    section: SECTION_OBJECT,
    make: () => ({ "/": 1 }),
  },
  {
    name: "record shaped like a tagged link",
    section: SECTION_OBJECT,
    make: () => ({ "/Link@1": { id: "of:fid1:ccc" } }),
  },
  {
    name: "record shaped like a quoted record",
    section: SECTION_OBJECT,
    make: () => ({ "/quote": { "/x": 1 } }),
  },
  {
    name: "record with key __proto__",
    section: SECTION_OBJECT,
    make: () => JSON.parse('{"__proto__":1}'),
  },
  {
    name: "record with key constructor",
    section: SECTION_OBJECT,
    make: () => ({ constructor: 1 }),
  },
  {
    name: "record of the fields of a link",
    section: SECTION_OBJECT,
    make: () => ({ id: "of:fid1:ccc" }),
  },

  // Instances.
  {
    name: "link",
    section: SECTION_INSTANCE,
    make: () => new FabricLink({ id: "of:fid1:ccc" }),
  },
  {
    name: "unknown value preserving a link",
    section: SECTION_EQUALITY,
    equals: "link",
    make: () => new UnknownValue("Link@1", { id: "of:fid1:ccc" }),
  },
  {
    name: "link with a path and a space",
    section: SECTION_INSTANCE,
    make: () =>
      new FabricLink({ id: "of:fid1:ccc", path: ["a", "1"], space: "did:x" }),
  },
  {
    name: "link with a payload of arbitrary fields",
    section: SECTION_INSTANCE,
    make: () => new FabricLink({ kind: "example", targets: [1, 2n] }),
  },
  {
    name: "error",
    section: SECTION_INSTANCE,
    make: () =>
      new FabricError({
        type: "Error",
        name: "Error",
        message: "m",
        stack: undefined,
        cause: undefined,
      }),
  },
  {
    name: "unknown value preserving an error",
    section: SECTION_EQUALITY,
    equals: "error",
    make: () =>
      new UnknownValue("Error@1", { type: "Error", name: null, message: "m" }),
  },
  {
    name: "error with every field",
    section: SECTION_INSTANCE,
    make: () =>
      new FabricError({
        type: "TypeError",
        name: "CustomError",
        message: "boom",
        stack: "at somewhere",
        cause: 5n,
        extras: { code: 7 },
      }),
  },
  {
    name: "unknown value under the tag of a primitive",
    section: SECTION_INSTANCE,
    make: () => new UnknownValue("Bytes@1", "AQ"),
  },
  {
    name: "unknown value under a tag of 65 UTF-8 bytes",
    section: SECTION_INSTANCE,
    make: () => new UnknownValue(`${"T".repeat(63)}@1`, null),
  },

  // Cycles, and sharing.
  {
    name: "record holding itself",
    section: SECTION_CYCLES,
    spec: "11  24 04 73 65 6C 66  02 01  00",
    make: () => {
      const record: { self?: FabricValue } = {};
      record.self = record;
      return record;
    },
  },
  {
    name: "array holding itself",
    section: SECTION_CYCLES,
    make: () => {
      const array: FabricValue[] = [1];
      array.push(array);
      return array;
    },
  },
  {
    name: "record whose cycle closes two levels up",
    section: SECTION_CYCLES,
    make: () => {
      const record: { x?: FabricValue } = {};
      record.x = { x: record };
      return record;
    },
  },
  {
    name: "record holding a record that holds itself",
    section: SECTION_CYCLES,
    make: () => {
      const inner: { x?: FabricValue } = {};
      inner.x = inner;
      return { x: inner };
    },
  },
  {
    name: "array holding one record that holds itself, twice",
    section: SECTION_CYCLES,
    make: () => {
      const inner: { self?: FabricValue } = {};
      inner.self = inner;
      return [inner, inner];
    },
  },
  {
    name: "record holding two equal records",
    section: SECTION_CYCLES,
    make: () => ({ a: { n: 1 }, b: { n: 1 } }),
  },
  {
    name: "record holding one record twice",
    section: SECTION_EQUALITY,
    equals: "record holding two equal records",
    make: () => {
      const shared = { n: 1 };
      return { a: shared, b: shared };
    },
  },
  {
    name: "deep-frozen record whose hash is cached",
    section: SECTION_EQUALITY,
    equals: "record",
    make: () => {
      const record = deepFreeze({ a: 1, b: 2 });
      hashOf(record);
      return record;
    },
  },
];

/** What the primitive classes' examples need beyond their makers. */
const PRIMITIVE_CLASS_NOTES: {
  readonly [Name in keyof FabricPrimitiveClassesByName]: ClassCaseNotes;
} = {
  FabricBytes: { section: SECTION_BYTES },
  FabricDurationDay: { section: SECTION_DURATION_DAY },
  FabricDurationNsec: { section: SECTION_DURATION_NSEC },
  FabricEpochDay: { section: SECTION_EPOCH_DAY },
  FabricEpochNsec: { section: SECTION_EPOCH_NSEC },
  FabricHash: { section: SECTION_HASH },
  FabricKeyPair: { section: SECTION_KEY_PAIR },
  FabricRegExp: { section: SECTION_REGEXP },
  FabricUnavailable: { section: SECTION_UNAVAILABLE },
};

/** What the instance classes' examples need beyond their makers. */
const INSTANCE_CLASS_NOTES: {
  readonly [Name in keyof FabricInstanceClassesByName]: ClassCaseNotes;
} = {
  FabricError: { section: SECTION_INSTANCE },
  FabricLink: { section: SECTION_INSTANCE },
  FabricMap: { excluded: STUB_CODEC_EXCLUSION },
  FabricSet: { excluded: STUB_CODEC_EXCLUSION },
  ProblematicValue: { section: SECTION_INSTANCE },
  UnknownValue: { section: SECTION_INSTANCE },
};

//
// The fixture
//

/** What the fixture says about itself. */
const FIXTURE_ABOUT = "Generated by `deno task regenerate-hash-conformance` " +
  "in packages/data-model, from the cases in src/hash-conformance.ts. " +
  "hash-conformance.md beside this file defines its format.";

/**
 * Returns the text of the fixture for `cases`, hashing each case's value with
 * this package's hasher.
 *
 * @throws If two cases share a name; if the hasher fails other than by
 *   refusing; if a case's hash differs from its `spec` and no divergence says
 *   so, or a divergence a case declares does not hold; if a case's `equals`
 *   names no earlier case; or if two cases' hashes are equal where their
 *   descriptors differ and neither names the other as its equal, or unequal
 *   where one does.
 */
export function hashConformanceFixtureText(
  cases: readonly HashConformanceCase[],
): string {
  assertDistinctCaseNames(cases);
  const made = cases.map((conformanceCase): MadeCase => {
    const value = conformanceCase.make();
    return {
      conformanceCase,
      described: descriptorOf(value),
      hashed: hashOutcomeOf(value),
    };
  });
  assertEqualsNamesEachEqualHash(made);
  return fixtureTextOf(FIXTURE_ABOUT, made.map(fixtureEntryOf));
}

/** One case, with the descriptor of the value it made and what hashing it did. */
type MadeCase = {
  readonly conformanceCase: HashConformanceCase;
  readonly described: ValueDescriptor;
  readonly hashed: HashOutcome;
};

/**
 * The message section 8 requires a hasher to refuse an unregistered symbol
 * with, which is the refusal a value describable in the notation can reach.
 */
const UNREGISTERED_SYMBOL_REFUSAL = "Cannot hash unique (uninterned) symbol";

/**
 * Returns what hashing `value` with this package's hasher does: the bytes it
 * feeds SHA-256, and the digest it makes of them. A refusal is a throw of a
 * plain `Error` with the message section 8 requires for an unregistered
 * symbol.
 *
 * @throws What the hasher throws, when it is anything else, a failure to hash
 *   being no outcome a fixture records.
 */
export function hashOutcomeOf(value: FabricValue): HashOutcome {
  const recorder = new RecordingHasher();
  const hasher = new ValueHasher(recorder);
  try {
    hasher.feedValue(value);
  } catch (e) {
    if (
      !(e instanceof Error && e.constructor === Error &&
        e.message === UNREGISTERED_SYMBOL_REFUSAL)
    ) {
      throw e;
    }
    return { refused: "unhashable" };
  }

  const digest = hasher.digest();
  return {
    stream: hexOf(recorder.stream),
    digest: hexOf(digest.bytes),
    string: digest.toString(),
  };
}

/**
 * A SHA-256 hasher that keeps a copy of every byte it is fed, so that what a
 * digest was made of can be read back.
 */
class RecordingHasher implements IncrementalHasher {
  readonly #hasher = createHasher();
  readonly #chunks: Uint8Array[] = [];

  /** Every byte fed so far, in the order fed. */
  get stream(): Uint8Array {
    const stream = new Uint8Array(
      this.#chunks.reduce((total, chunk) => total + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of this.#chunks) {
      stream.set(chunk, offset);
      offset += chunk.length;
    }
    return stream;
  }

  /** @inheritDoc */
  update(data: Uint8Array): void {
    // Copied, a chunk being the caller's to reuse once this returns.
    this.#chunks.push(data.slice());
    this.#hasher.update(data);
  }

  /** @inheritDoc */
  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
  digest(encoding?: "base64url"): Uint8Array | string {
    return (encoding === undefined)
      ? this.#hasher.digest()
      : this.#hasher.digest(encoding);
  }
}

/**
 * Returns the outcome the spec gives a value whose bytes are `stream`: the
 * stream, its SHA-256 digest, and the digest's string form.
 */
function outcomeOfStream(stream: Uint8Array): HashedOutcome {
  const digest = sha256(stream);
  return {
    stream: hexOf(stream),
    digest: hexOf(digest),
    string: `fid1:${toUnpaddedBase64url(digest)}`,
  };
}

/** Returns the fixture entry for one case. */
function fixtureEntryOf(
  { conformanceCase, described, hashed }: MadeCase,
): Record<string, ValueDescriptor> {
  const { name, section, spec, equals, divergence } = conformanceCase;
  if (divergence !== undefined && spec === undefined) {
    throw new Error(
      `${name}: declares a divergence for a value the spec gives no bytes ` +
        "for.",
    );
  }
  const specHashed = (spec === undefined)
    ? hashed
    : outcomeOfStream(bytesOfHex(spec.replaceAll(" ", "").toLowerCase()));

  const entry: Record<string, ValueDescriptor> = {
    name,
    section,
    value: described,
    hash: specHashed,
  };
  if (equals !== undefined) {
    entry.equals = equals;
  }

  if (!isSameOutcome(hashed, specHashed)) {
    if (divergence === undefined) {
      throw new Error(
        `${name}: hashes to ${JSON.stringify(hashed)}, not to the bytes ` +
          `\`${spec}\`.`,
      );
    }
    entry.divergence = { note: divergence, hash: hashed };
  } else if (divergence !== undefined) {
    throw new Error(
      `${name}: declares a divergence, but this implementation does what ` +
        "the spec says.",
    );
  }

  return entry;
}

/**
 * Throws unless every two of the cases in `made`, where their descriptors
 * differ, have equal hashes exactly when one names the other under `equals`,
 * and have equal hashes wherever one does. A refused value has no hash, and
 * so is equal to nothing here.
 */
function assertEqualsNamesEachEqualHash(made: readonly MadeCase[]): void {
  const digests = made.map(({ hashed }) =>
    ("digest" in hashed) ? hashed.digest : undefined
  );
  const descriptors = made.map(({ described }) => JSON.stringify(described));

  // The case each case names under `equals`, followed back to one naming
  // none, so that two cases declared equal share a root.
  const indexOfName = new Map<string, number>();
  const roots: number[] = [];
  made.forEach(({ conformanceCase: { name, equals } }, index) => {
    if (equals === undefined) {
      roots.push(index);
    } else {
      const named = indexOfName.get(equals);
      if (named === undefined) {
        throw new Error(`${name}: \`equals\` names no earlier case.`);
      }
      roots.push(roots[named]!);
    }
    indexOfName.set(name, index);
  });

  for (let j = 0; j < made.length; j++) {
    for (let i = 0; i < j; i++) {
      const a = made[i]!.conformanceCase.name;
      const b = made[j]!.conformanceCase.name;
      const declared = roots[i] === roots[j];
      if (digests[i] === undefined || digests[j] === undefined) {
        if (declared) {
          throw new Error(`${b}: names ${a} as its equal, but one is refused.`);
        }
        continue;
      }

      const hashEqual = digests[i] === digests[j];
      if (
        (declared !== hashEqual) &&
        (declared || descriptors[i] !== descriptors[j])
      ) {
        throw new Error(
          `${a} and ${b}: their hashes are ` +
            `${hashEqual ? "equal" : "unequal"}, but ` +
            `${declared ? "one names" : "neither names"} the other under ` +
            "`equals`.",
        );
      }
    }
  }
}

/** Indicates whether two outcomes are the same, outcomes being JSON. */
function isSameOutcome(a: HashOutcome, b: HashOutcome): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
