/**
 * Conformance cases for the `fvj1:` JSON encoding, and what turns them into a
 * language-neutral fixture. An implementation of the format in another
 * language, or of another wire format that has to agree with this one, tests
 * against the fixture rather than against this package's code.
 *
 * Each case is a value or a text, and the fixture states it as a text, with
 * the mods to decoding it, and records what decoding it does: the value it
 * returns, stated by probes, or the refusal; then the text that value
 * re-encodes to. `test/fixtures/value-probes.md` defines the mods and the
 * probes. Probes state a value without a
 * reader having to build one, or to compare two by an equality that agrees
 * with this package's.
 *
 * Where the formal spec says outright that this package falls short of it, the
 * case says so: the fixture records the spec's outcome, and this package's
 * beside it as a divergence. Generating the fixture fails
 * when a case's declared divergence does not hold, so that a fix here retires
 * the mark rather than leaving it to mislead.
 *
 * This is reached through `for-testing-only.ts` and has no place in any
 * barrel.
 */

import type { FabricValue } from "@/interface.ts";
import { ProblematicStateError, ProblematicValue } from "@/codec-common";
import { JsonCodecEngine } from "@/codec-json";
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
  type FabricPrimitiveClassesByName,
  FabricRegExp,
  FabricUnavailable,
} from "@/fabric-primitives";
import { jsonFromFabricValue, newDefaultJsonCodecEngine } from "./codecs.ts";
import {
  assertDistinctCaseNames,
  type ClassCaseNotes,
  classCasesOf,
  type ExampleMakers,
  fabricValueOfTextWithMods,
  type FixtureJson,
  type FixtureRequirements,
  fixtureTextOf,
  plainJsonTextOf,
  probedPathsOf,
  probesOf,
  requirementsOf,
  sparseArrayOf,
  STUB_CODEC_EXCLUSION,
  type TextWithMods,
  textWithModsOf,
  type ValuePath,
  type ValueProbe,
} from "./conformance-fixtures.ts";

//
// Types
//

/**
 * Why a decode or an encode is refused. A decode is refused when the text
 * lacks the `fvj1:` prefix, when what follows the prefix is not JSON, or when
 * the JSON is not a form the format allows; the spec settles all three alike,
 * so the kind says why and not how. An encode is refused when the format has
 * no text for the value.
 */
export type Fvj1Refusal = "not-fvj1" | "not-json" | "malformed" | "unencodable";

/**
 * What decoding one text or encoding one value does: a decode returns the
 * value these probes state, an encode writes this text, and either can be
 * refused.
 */
export type Fvj1Outcome =
  | { readonly probes: readonly ValueProbe[] }
  | { readonly text: string }
  | { readonly refused: Fvj1Refusal };

/**
 * One conformance case: a value, made fresh by `make`, or a text. The fixture
 * states a value as its canonical text and mods, so either way a case is
 * decoded, and what it decodes to is re-encoded.
 *
 * `section` names the part of the formal spec the case exercises.
 * `requires` names the flavors of regular expression whose construction the
 * case's outcome depends on; the fixture entry adds the guarantees of size the
 * case needs past the floors.
 * `divergence` is a note on what the format requires, for a case where this
 * package does not do it. The format's outcome is never typed here. For a
 * value, it is the value's own probes, and the text {@link plainJsonTextOf}
 * computes, so a divergence can only be declared for a value that function
 * writes. For a text, it is that the text is refused, the format refusing
 * every text this package over-accepts, unless `specDecodes` says the format
 * decodes the text as this package does. Then the format's outcome is the
 * text {@link plainJsonTextOf} computes for what it decodes to, and the
 * divergence is in re-encoding that.
 */
export type Fvj1ConformanceCase =
  & {
    readonly name: string;
    readonly section: string;
    readonly requires?: Pick<FixtureRequirements, "flavors">;
    readonly divergence?: string;
  }
  & (
    | { readonly make: () => FabricValue }
    | { readonly text: string; readonly specDecodes?: true }
  );

//
// The cases
//

/**
 * Returns every conformance case: the fixed ones below, and one for each
 * example the given makers make, so that a class added to either table of
 * classes is a case without anything here changing.
 */
export function fvj1ConformanceCases(
  primitiveMakers: ExampleMakers<FabricPrimitiveClassesByName>,
  instanceMakers: ExampleMakers<FabricInstanceClassesByName>,
): readonly Fvj1ConformanceCase[] {
  return Object.freeze([
    ...FIXED_CASES,
    ...classCasesOf(primitiveMakers, PRIMITIVE_CLASS_NOTES),
    ...classCasesOf(instanceMakers, INSTANCE_CLASS_NOTES),
  ]);
}

const SECTION_PREFIX = "3-json-encoding.md section 1.1";
const SECTION_NUMBERS = "3-json-encoding.md section 3, `SpecialNumber@1`";
const SECTION_STRINGS = "1-fabric-values.md section 6.7";
const SECTION_NUMBER_TEXT = "3-json-encoding.md section 11.2";
const SECTION_STRING_TEXT = "3-json-encoding.md section 11.3";
const SECTION_DECODED_TEXT = "3-json-encoding.md section 11.4";
const SECTION_KEY_ORDER = "3-json-encoding.md section 10";
const SECTION_HOLES = "3-json-encoding.md section 3, sparse array encoding";
const SECTION_UNDEFINED = "3-json-encoding.md section 5";
const SECTION_ESCAPES = "3-json-encoding.md section 6";
const SECTION_ESCAPE_DISPATCH =
  "3-json-encoding.md section 6, encoder dispatch";
const SECTION_RESERVED_KEYS = "3-json-encoding.md section 4";
const SECTION_SYMBOL = "3-json-encoding.md section 3, `Symbol@1`";
const SECTION_BIGINT = "3-json-encoding.md section 3, `BigInt@1`";
const SECTION_BASE64 = "3-json-encoding.md section 3, base64url convention";
const SECTION_UNKNOWN = "3-json-encoding.md section 8";
const SECTION_TAG_SYNTAX = "3-json-encoding.md section 2";
const SECTION_RESERVATION = "3-json-encoding.md section 9";
const SECTION_TYPES = "3-json-encoding.md section 3";
const SECTION_TEMPORAL = "3-json-encoding.md section 3, temporal quantities";
const SECTION_ERROR = "3-json-encoding.md section 3, `Error@1`";
const SECTION_LINK = "3-json-encoding.md section 3, `Link@1`";
const SECTION_REGEXP = "3-json-encoding.md section 3, `RegExp@1`";
const SECTION_UNAVAILABLE = "3-json-encoding.md section 3, `Unavailable@1`";

/**
 * The integers at and just past the edges of a signed 64-bit integer, and a
 * pair far past them. The format bounds none of them, and an implementation
 * that holds these counts in an `int64` meets its edges here.
 */
const WIDE_INTEGERS: readonly (readonly [string, bigint])[] = [
  ["2^63 - 1", 2n ** 63n - 1n],
  ["-2^63", -(2n ** 63n)],
  ["2^63", 2n ** 63n],
  ["-2^63 - 1", -(2n ** 63n) - 1n],
  ["2^100", 2n ** 100n],
  ["-2^100", -(2n ** 100n)],
];

/** Note shared by the cases with a key this implementation reserves. */
const RESERVED_KEY_NOTE = "Section 4 lets a record carry any key, and its " +
  "note says this implementation does not yet meet that: it refuses " +
  "`__proto__` and `constructor` on both sides of the wire. An " +
  "implementation on a host that does not route assignment through a " +
  "prototype reserves no names.";

/** Note shared by the cases with a `RegExp@1` state lacking a field. */
const REGEXP_FIELDS_NOTE = "Section 3 requires all three fields of a " +
  "`RegExp@1` state, and gives `flavor` no default.";

/** The cases that do not range over the class tables. */
const FIXED_CASES: readonly Fvj1ConformanceCase[] = [
  // JSON's own values, and how their text is written.
  { name: "null", section: SECTION_PREFIX, make: () => null },
  { name: "true", section: SECTION_PREFIX, make: () => true },
  { name: "false", section: SECTION_PREFIX, make: () => false },
  { name: "zero", section: SECTION_NUMBER_TEXT, make: () => 0 },
  { name: "integer", section: SECTION_NUMBER_TEXT, make: () => 42 },
  { name: "negative fraction", section: SECTION_NUMBER_TEXT, make: () => -1.5 },
  { name: "inexact fraction", section: SECTION_NUMBER_TEXT, make: () => 0.1 },
  { name: "large exponent", section: SECTION_NUMBER_TEXT, make: () => 1e21 },
  { name: "small exponent", section: SECTION_NUMBER_TEXT, make: () => 1e-7 },
  {
    name: "smallest subnormal",
    section: SECTION_NUMBER_TEXT,
    make: () => Number.MIN_VALUE,
  },
  {
    name: "largest double",
    section: SECTION_NUMBER_TEXT,
    make: () => Number.MAX_VALUE,
  },
  {
    name: "integer past 2^53",
    section: SECTION_NUMBER_TEXT,
    make: () => 2 ** 53 + 2,
  },
  {
    name: "number spelled with fraction and exponent",
    section: SECTION_DECODED_TEXT,
    text: "fvj1:1.0E2",
  },
  {
    name: "whitespace around and inside the JSON",
    section: SECTION_DECODED_TEXT,
    text: "fvj1: [ 1 , 2 ] ",
  },
  {
    name: "number literal negative zero",
    section: SECTION_PREFIX,
    text: "fvj1:-0",
    divergence: "Negative zero is written only as `SpecialNumber@1`, and the " +
      "JSON number `-0` is refused. This implementation decodes it to " +
      "negative zero.",
  },
  {
    name: "number literal past the largest double",
    section: SECTION_PREFIX,
    text: "fvj1:1e400",
    divergence: "A JSON number whose value a double cannot represent is " +
      "refused, rather than read as infinity or as the largest double. This " +
      "implementation decodes it to infinity.",
  },

  // Numbers JSON cannot write.
  { name: "negative zero", section: SECTION_NUMBERS, make: () => -0 },
  { name: "NaN", section: SECTION_NUMBERS, make: () => NaN },
  { name: "positive infinity", section: SECTION_NUMBERS, make: () => Infinity },
  {
    name: "negative infinity",
    section: SECTION_NUMBERS,
    make: () => -Infinity,
  },

  // Strings.
  { name: "empty string", section: SECTION_STRING_TEXT, make: () => "" },
  {
    name: "string of characters JSON escapes",
    section: SECTION_STRING_TEXT,
    make: () => '"\\/\b\f\n\r\t\u0000\u001f\u007f\u2028',
  },
  {
    name: "string beyond ASCII",
    section: SECTION_STRING_TEXT,
    make: () => "\u00e9\u{1F600}\uffff",
  },
  {
    name: "string in NFC",
    section: SECTION_STRINGS,
    make: () => "\u00e9",
  },
  {
    name: "string in NFD",
    section: SECTION_STRINGS,
    make: () => "e\u0301",
  },
  {
    name: "lone high surrogate",
    section: SECTION_STRING_TEXT,
    make: () => "\ud800",
  },
  {
    name: "lone low surrogate between characters",
    section: SECTION_STRING_TEXT,
    make: () => "a\udc00b",
  },
  {
    name: "surrogates in reverse order",
    section: SECTION_STRING_TEXT,
    make: () => "\udc00\ud800",
  },
  {
    name: "lone surrogate escaped in uppercase",
    section: SECTION_DECODED_TEXT,
    text: 'fvj1:"\\uD800"',
  },

  // Records and key order.
  { name: "empty record", section: SECTION_KEY_ORDER, make: () => ({}) },
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
        ["\u00e9", 5],
        ["e\u0301", 6],
        ["\uffff", 7],
        ["\u{1F600}", 8],
        ["\udc00", 9],
        ["\ud800", 10],
      ]),
  },
  {
    name: "record keys out of order",
    section: SECTION_KEY_ORDER,
    text: 'fvj1:{"b":1,"a":2}',
  },
  {
    name: "record keys that read as integers",
    section: SECTION_KEY_ORDER,
    make: () => ({ "2": "two", "10": "ten", a: "a" }),
    divergence: "Section 10 requires keys in UTF-8 byte order, under which " +
      "`10` comes before `2`. This implementation writes keys that read as " +
      "array indices first and in numeric order, building its output " +
      "through a JavaScript object, whose enumeration puts them there.",
  },
  {
    name: "record naming a key twice",
    section: SECTION_PREFIX,
    text: 'fvj1:{"a":1,"a":2}',
    divergence: "A record naming one key twice is refused. This " +
      "implementation keeps the last.",
  },
  {
    name: "record with key __proto__",
    section: SECTION_RESERVED_KEYS,
    make: () => JSON.parse('{"__proto__":1}'),
    divergence: RESERVED_KEY_NOTE,
  },
  {
    name: "record with key constructor",
    section: SECTION_RESERVED_KEYS,
    make: () => ({ constructor: 1 }),
    divergence: RESERVED_KEY_NOTE,
  },

  // Arrays, holes, and `undefined`.
  { name: "empty array", section: SECTION_HOLES, make: () => [] },
  {
    name: "array with a hole and an undefined",
    section: SECTION_HOLES,
    make: () => sparseArrayOf(4, [[0, 1], [2, undefined], [3, 3]]),
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
    name: "array with a long run of holes",
    section: SECTION_HOLES,
    make: () => sparseArrayOf(1_000_001, [[1_000_000, "x"]]),
  },
  {
    name: "array with adjacent hole runs",
    section: SECTION_HOLES,
    text: 'fvj1:[{"/hole":1},{"/hole":2},1]',
  },
  { name: "undefined", section: SECTION_UNDEFINED, make: () => undefined },
  {
    name: "undefined in a record",
    section: SECTION_UNDEFINED,
    make: () => ({ u: undefined }),
  },
  {
    name: "undefined with an empty-record state",
    section: SECTION_UNDEFINED,
    text: 'fvj1:{"/Undefined@1":{}}',
  },

  // Records with `/`-prefixed keys.
  {
    name: "slash key over a literal",
    section: SECTION_ESCAPE_DISPATCH,
    make: () => ({ "/a": 1 }),
  },
  {
    name: "slash key alone",
    section: SECTION_ESCAPE_DISPATCH,
    make: () => ({ "/": 1 }),
  },
  {
    name: "slash key over a value that needs encoding",
    section: SECTION_ESCAPE_DISPATCH,
    make: () => ({ "/a": 10n, b: [undefined] }),
  },
  {
    name: "slash keys nested over literals",
    section: SECTION_ESCAPE_DISPATCH,
    make: () => ({ "/a": { "/b": 1 } }),
  },
  {
    name: "slash keys nested over a value that needs encoding",
    section: SECTION_ESCAPE_DISPATCH,
    make: () => ({ "/a": { "/b": 1n } }),
  },
  {
    name: "object escape over literals",
    section: SECTION_ESCAPE_DISPATCH,
    text: 'fvj1:{"/object":{"/x":1}}',
  },
  {
    name: "quote escape over a tagged form",
    section: SECTION_ESCAPES,
    text: 'fvj1:{"/quote":{"/Link@1":{"id":"x"}}}',
  },
  {
    name: "quote escape over an array holding a hole marker",
    section: SECTION_ESCAPES,
    text: 'fvj1:{"/quote":[1,{"/hole":1}]}',
  },

  // Symbols and bigints.
  {
    name: "registered symbol",
    section: SECTION_SYMBOL,
    make: () => Symbol.for("key"),
  },
  {
    name: "registered symbol with the empty key",
    section: SECTION_SYMBOL,
    make: () => Symbol.for(""),
  },
  {
    name: "unregistered symbol",
    section: SECTION_SYMBOL,
    make: () => Symbol("local"),
  },
  {
    name: "unregistered symbol with no description",
    section: SECTION_SYMBOL,
    make: () => Symbol(),
  },
  {
    name: "unregistered symbol with the empty description",
    section: SECTION_SYMBOL,
    make: () => Symbol(""),
  },
  { name: "bigint zero", section: SECTION_BIGINT, make: () => 0n },
  { name: "bigint one", section: SECTION_BIGINT, make: () => 1n },
  { name: "bigint minus one", section: SECTION_BIGINT, make: () => -1n },
  { name: "bigint 128", section: SECTION_BIGINT, make: () => 128n },
  { name: "bigint minus 128", section: SECTION_BIGINT, make: () => -128n },
  { name: "bigint minus 129", section: SECTION_BIGINT, make: () => -129n },
  { name: "bigint 2^64", section: SECTION_BIGINT, make: () => 2n ** 64n },
  {
    name: "bigint state with padding",
    section: SECTION_BASE64,
    text: 'fvj1:{"/BigInt@1":"AIA="}',
  },
  {
    name: "bigint state not minimal",
    section: SECTION_BIGINT,
    text: 'fvj1:{"/BigInt@1":"AAA"}',
  },
  // `0xff 0xff`, `0x00 0x7f` and `0xff 0x80`: sign-extended.
  ...["__8", "AH8", "_4A"].map((state): Fvj1ConformanceCase => ({
    name: `bigint state sign-extended, ${JSON.stringify(state)}`,
    section: SECTION_BIGINT,
    text: `fvj1:{"/BigInt@1":${JSON.stringify(state)}}`,
  })),
  // Each temporal decodes its state as `BigInt@1` does, through its own path.
  ...[
    ["EpochNsec", "AAA"],
    ["EpochDay", "__8"],
    ["DurationNsec", "AH8"],
    ["DurationDay", "_4A"],
  ].map(([tag, state]): Fvj1ConformanceCase => ({
    name: `${tag} state not minimal`,
    section: "3-json-encoding.md section 3, temporal quantities",
    text: `fvj1:{"/${tag}@1":${JSON.stringify(state)}}`,
  })),
  {
    name: "bigint state of no bytes",
    section: SECTION_BIGINT,
    text: 'fvj1:{"/BigInt@1":""}',
  },
  {
    name: "bytes state with padding",
    section: SECTION_BASE64,
    text: 'fvj1:{"/Bytes@1":"AQ=="}',
  },
  {
    name: "bytes state in the standard base64 alphabet",
    section: SECTION_BASE64,
    text: 'fvj1:{"/Bytes@1":"+/8"}',
  },
  {
    name: "bytes state of a lone base64 character",
    section: SECTION_BASE64,
    text: 'fvj1:{"/Bytes@1":"A"}',
  },
  {
    name: "bytes state holding whitespace",
    section: SECTION_BASE64,
    text: 'fvj1:{"/Bytes@1":"AQ I"}',
  },
  {
    name: "bytes state with nonzero trailing bits",
    section: SECTION_BASE64,
    text: 'fvj1:{"/Bytes@1":"AR"}',
  },
  {
    name: "bytes state with one padding character",
    section: SECTION_BASE64,
    text: 'fvj1:{"/Bytes@1":"AQI="}',
  },
  // Padding other than RFC 4648's: too little, too much, after whole groups,
  // and with no characters before it.
  ...["AA=", "AAA==", "AAAA=", "=="].map((state): Fvj1ConformanceCase => ({
    name: `bytes state with padding ${JSON.stringify(state)}`,
    section: SECTION_BASE64,
    text: `fvj1:{"/Bytes@1":${JSON.stringify(state)}}`,
  })),

  // Nesting, and values beyond the class examples.
  {
    name: "nested containers and instances",
    section: SECTION_TYPES,
    make: () => ({
      list: [1, [2, { deep: [undefined, 3n, Symbol.for("s")] }]],
      bytes: new FabricBytes(new Uint8Array([255])),
      link: new FabricLink({ id: "of:x", path: ["a", "1"], space: "did:x" }),
    }),
  },
  {
    name: "error with every field",
    section: "3-json-encoding.md section 3, `Error@1`",
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
    name: "link with a payload of arbitrary fields",
    section: "3-json-encoding.md section 3, `Link@1`",
    make: () => new FabricLink({ kind: "example", targets: [1, 2] }),
  },
  {
    name: "unavailable with an error kind and no message",
    section: "3-json-encoding.md section 3, `Unavailable@1`",
    make: () => new FabricUnavailable("error", "network"),
  },
  {
    name: "regular expression of another flavor",
    section: "3-json-encoding.md section 3, `RegExp@1`",
    make: () => new FabricRegExp("other", "(?<", ""),
  },
  {
    name: "problematic value whose tag is not a tag",
    section: "3-json-encoding.md section 3, `Problematic@1`",
    text: 'fvj1:{"/Problematic@1":{"error":"e","state":{"/Undefined@1":null},' +
      '"tag":"not a tag"}}',
  },

  // Unknown tags.
  {
    name: "unknown tag over a state that needs decoding",
    section: SECTION_UNKNOWN,
    text: 'fvj1:{"/Future@2":{"x":{"/Bytes@1":"AQ"}}}',
  },
  {
    name: "unknown tag over null",
    section: SECTION_UNKNOWN,
    text: 'fvj1:[{"/Abc123@1234":null}]',
  },

  // Decodes the spec refuses.
  { name: "text without the prefix", section: SECTION_PREFIX, text: "42" },
  {
    name: "prefix in the wrong case",
    section: SECTION_PREFIX,
    text: "FVJ1:42",
  },
  { name: "prefix alone", section: SECTION_PREFIX, text: "fvj1:" },
  { name: "prefix over broken JSON", section: SECTION_PREFIX, text: "fvj1:{" },
  ...[
    "bytes@1",
    "By-tes@1",
    "Bytes@0",
    "Bytes@01",
    "Bytes@1.0",
    " Bytes@1",
    "Bytes@1\n",
  ].map((tag): Fvj1ConformanceCase => ({
    name: `malformed tag ${JSON.stringify(tag)}`,
    section: SECTION_TAG_SYNTAX,
    text: `fvj1:${JSON.stringify({ [`/${tag}`]: 1 })}`,
  })),
  {
    name: "bare slash key",
    section: SECTION_RESERVATION,
    text: 'fvj1:{"/":1}',
  },
  {
    name: "tag beside a plain key",
    section: SECTION_RESERVATION,
    text: 'fvj1:{"/Bytes@1":"AQ","a":1}',
  },
  {
    name: "two tags in one record",
    section: SECTION_RESERVATION,
    text: 'fvj1:{"/Future@2":null,"/Other@1":1}',
  },
  {
    name: "hole marker outside an array",
    section: SECTION_HOLES,
    text: 'fvj1:{"/hole":1}',
  },
  {
    name: "hole run of zero",
    section: SECTION_HOLES,
    text: 'fvj1:[{"/hole":0}]',
  },
  {
    name: "hole run of a fraction",
    section: SECTION_HOLES,
    text: 'fvj1:[{"/hole":1.5}]',
  },
  {
    name: "hole run of a string",
    section: SECTION_HOLES,
    text: 'fvj1:[{"/hole":"1"}]',
  },
  {
    name: "object escape over an array",
    section: SECTION_ESCAPES,
    text: 'fvj1:{"/object":[1]}',
  },
  {
    name: "undefined with a numeric state",
    section: SECTION_UNDEFINED,
    text: 'fvj1:{"/Undefined@1":1}',
  },
  {
    name: "special number outside the four literals",
    section: SECTION_NUMBERS,
    text: 'fvj1:{"/SpecialNumber@1":"Infinity"}',
  },
  {
    name: "symbol with a numeric state",
    section: SECTION_SYMBOL,
    text: 'fvj1:{"/Symbol@1":1}',
  },
  {
    name: "bytes with a null state",
    section: SECTION_TYPES,
    text: 'fvj1:{"/Bytes@1":null}',
  },
  {
    name: "hash with a numeric hash",
    section: "3-json-encoding.md section 3, `Hash@1`",
    text: 'fvj1:{"/Hash@1":{"hash":7,"tag":"fid1"}}',
  },
  {
    name: "key pair with a key outside base64url",
    section: "3-json-encoding.md section 3, `KeyPair@1`",
    text: 'fvj1:{"/KeyPair@1":{"algorithm":"A","privateKey":"AA",' +
      '"publicKey":"+"}}',
  },
  {
    name: "regular expression that does not construct",
    section: "3-json-encoding.md section 3, `RegExp@1`",
    text: 'fvj1:{"/RegExp@1":{"flags":"","flavor":"es2025","source":"("}}',
    requires: { flavors: ["es2025"] },
  },
  {
    name: "unavailable pairing an error kind with a transient reason",
    section: "3-json-encoding.md section 3, `Unavailable@1`",
    text: 'fvj1:{"/Unavailable@1":{"errorKind":"general","reason":"pending"}}',
  },
  {
    name: "problematic value with no state",
    section: "3-json-encoding.md section 3, `Problematic@1`",
    text: 'fvj1:{"/Problematic@1":{"error":"e","tag":"x"}}',
  },

  // Escapes, and what the reservation of `/` keys refuses.
  {
    name: "slash key that is a tag, over a literal",
    section: SECTION_ESCAPE_DISPATCH,
    make: () => ({ "/Bytes@1": "AQ" }),
  },
  {
    name: "quote escape nested in an object escape",
    section: SECTION_ESCAPES,
    text: 'fvj1:{"/object":{"/a":{"/quote":{"/b":1}}}}',
  },
  {
    name: "object escape nested in a quote escape",
    section: SECTION_ESCAPES,
    text: 'fvj1:{"/quote":{"/object":{"/x":1}}}',
  },
  {
    name: "object escape over the empty record",
    section: SECTION_ESCAPES,
    text: 'fvj1:{"/object":{}}',
  },
  {
    name: "quote escape over the empty record",
    section: SECTION_ESCAPES,
    text: 'fvj1:{"/quote":{}}',
  },
  {
    name: "quote escape over an undefined",
    section: SECTION_ESCAPES,
    text: 'fvj1:{"/quote":{"/Undefined@1":null}}',
  },
  {
    name: "quote escape over a key that is not a tag",
    section: SECTION_ESCAPES,
    text: 'fvj1:{"/quote":{"/bytes@1":1}}',
  },
  {
    name: "object escape over a key that is an escape",
    section: SECTION_ESCAPES,
    text: 'fvj1:{"/object":{"/quote":1}}',
  },
  {
    name: "object escape over slash and plain keys",
    section: SECTION_ESCAPES,
    text: 'fvj1:{"/object":{"/x":1,"y":2}}',
  },
  {
    name: "object escape beside a plain key",
    section: SECTION_RESERVATION,
    text: 'fvj1:{"/object":{"a":1},"b":2}',
  },
  {
    name: "quote escape beside a plain key",
    section: SECTION_RESERVATION,
    text: 'fvj1:{"/quote":1,"a":1}',
  },
  {
    name: "link payload with a bare slash key",
    section: SECTION_RESERVATION,
    text: 'fvj1:{"/Link@1":{"/x":1}}',
  },

  // Keys this implementation reserves, below the top of a value.
  {
    name: "record with key __proto__ nested in a record",
    section: SECTION_RESERVED_KEYS,
    make: () => ({ a: JSON.parse('{"__proto__":1}') }),
    divergence: RESERVED_KEY_NOTE,
  },
  {
    name: "record with key constructor nested in a record",
    section: SECTION_RESERVED_KEYS,
    make: () => ({ a: { constructor: 1 } }),
    divergence: RESERVED_KEY_NOTE,
  },
  {
    name: "quote escape over a record with key __proto__",
    section: SECTION_RESERVED_KEYS,
    text: 'fvj1:{"/quote":{"__proto__":1}}',
    specDecodes: true,
    divergence: RESERVED_KEY_NOTE + " Here it decodes the text, the " +
      "`/quote` escape taking the record as it is, but refuses to encode the " +
      "record it decodes to.",
  },

  // Integers at and past the edges of a signed 64-bit integer.
  ...WIDE_INTEGERS.map(([label, count]): Fvj1ConformanceCase => ({
    name: `bigint ${label}`,
    section: SECTION_BIGINT,
    make: () => count,
  })),
  ...WIDE_INTEGERS.map(([label, count]): Fvj1ConformanceCase => ({
    name: `EpochNsec of ${label}`,
    section: SECTION_TEMPORAL,
    make: () => new FabricEpochNsec(count),
  })),
  ...([
    ["EpochDay", (count: bigint) => new FabricEpochDay(count)],
    ["DurationNsec", (count: bigint) => new FabricDurationNsec(count)],
    ["DurationDay", (count: bigint) => new FabricDurationDay(count)],
  ] as const).flatMap(([tag, made]) =>
    WIDE_INTEGERS.filter(([label]) => label === "2^63" || label === "-2^63")
      .map(([label, count]): Fvj1ConformanceCase => ({
        name: `${tag} of ${label}`,
        section: SECTION_TEMPORAL,
        make: () => made(count),
      }))
  ),

  // Errors and links.
  {
    name: "error with extras of every primitive kind",
    section: SECTION_ERROR,
    make: () =>
      new FabricError({
        type: "Error",
        name: null,
        message: "m",
        stack: undefined,
        cause: undefined,
        extras: {
          bigint: 2n,
          boolean: true,
          null: null,
          number: -1.5,
          string: "s",
          symbol: Symbol.for("key"),
          undefined: undefined,
        },
      }),
  },
  {
    name: "link with a payload key that is an escape",
    section: SECTION_LINK,
    make: () => new FabricLink({ "/quote": { "/Link@1": { id: "x" } } }),
  },
  {
    name: "link with a payload key that is a tag, over a bigint",
    section: SECTION_LINK,
    make: () => new FabricLink({ "/Bytes@1": 1n }),
  },
  {
    name: "link with a numeric payload",
    section: SECTION_LINK,
    text: 'fvj1:{"/Link@1":5}',
  },
  {
    name: "link with an array payload",
    section: SECTION_LINK,
    text: 'fvj1:{"/Link@1":[]}',
  },
  {
    name: "link with the empty record as payload",
    section: SECTION_LINK,
    text: 'fvj1:{"/Link@1":{}}',
  },

  // More decodes the spec refuses.
  {
    name: "hole run of a negative number",
    section: SECTION_HOLES,
    text: 'fvj1:[{"/hole":-1}]',
  },
  {
    name: "error with a string state",
    section: SECTION_ERROR,
    text: 'fvj1:{"/Error@1":"boom"}',
  },
  {
    name: "error with a numeric type",
    section: SECTION_ERROR,
    text: 'fvj1:{"/Error@1":{"message":"m","name":null,"type":7}}',
  },
  {
    name: "error with a numeric name",
    section: SECTION_ERROR,
    text: 'fvj1:{"/Error@1":{"message":"m","name":1,"type":"Error"}}',
  },
  {
    name: "error with a numeric stack",
    section: SECTION_ERROR,
    text: 'fvj1:{"/Error@1":{"message":"m","name":null,"stack":5,' +
      '"type":"Error"}}',
  },
  {
    name: "error with a type that is not a string",
    section: SECTION_ERROR,
    text: 'fvj1:{"/Error@1":{"message":"m","name":null,' +
      '"type":{"/Undefined@1":null}}}',
  },
  {
    name: "error with no name",
    section: SECTION_ERROR,
    text: 'fvj1:{"/Error@1":{"message":"m","type":"TypeError"}}',
  },
  {
    name: "error with no message",
    section: SECTION_ERROR,
    text: 'fvj1:{"/Error@1":{"name":null,"type":"Error"}}',
    divergence: "Section 3 requires `message` of an `Error@1` state. This " +
      "implementation reads an absent message as empty.",
  },
  {
    name: "error with no type",
    section: SECTION_ERROR,
    text: 'fvj1:{"/Error@1":{"message":"m","name":null}}',
    divergence: "Section 3 requires `type` of an `Error@1` state. This " +
      "implementation reads an absent type as the `name`, or as `Error` " +
      "where the name is `null` or absent too.",
  },
  {
    name: "error with the empty state",
    section: SECTION_ERROR,
    text: 'fvj1:{"/Error@1":{}}',
    divergence: "Section 3 requires `type` and `message` of an `Error@1` " +
      "state. This implementation reads the empty state as an `Error` with " +
      "an empty message.",
  },
  {
    name: "unavailable with a string state",
    section: SECTION_UNAVAILABLE,
    text: 'fvj1:{"/Unavailable@1":"pending"}',
  },
  {
    name: "unavailable with an unknown reason",
    section: SECTION_UNAVAILABLE,
    text: 'fvj1:{"/Unavailable@1":{"reason":"gone"}}',
  },
  {
    name: "unavailable error with no kind",
    section: SECTION_UNAVAILABLE,
    text: 'fvj1:{"/Unavailable@1":{"reason":"error"}}',
  },
  {
    name: "unavailable error with an unknown kind",
    section: SECTION_UNAVAILABLE,
    text: 'fvj1:{"/Unavailable@1":{"errorKind":"nope","reason":"error"}}',
  },
  {
    name: "unavailable error with a numeric message",
    section: SECTION_UNAVAILABLE,
    text: 'fvj1:{"/Unavailable@1":{"errorKind":"network","errorMessage":5,' +
      '"reason":"error"}}',
  },
  {
    name: "unavailable error with a null message",
    section: SECTION_UNAVAILABLE,
    text: 'fvj1:{"/Unavailable@1":{"errorKind":"network",' +
      '"errorMessage":null,"reason":"error"}}',
  },
  {
    name: "unavailable pairing a message with a transient reason",
    section: SECTION_UNAVAILABLE,
    text: 'fvj1:{"/Unavailable@1":{"errorMessage":"m","reason":"pending"}}',
  },
  {
    name: "regular expression with a string state",
    section: SECTION_REGEXP,
    text: 'fvj1:{"/RegExp@1":"a"}',
  },
  {
    name: "regular expression with a numeric source",
    section: SECTION_REGEXP,
    text: 'fvj1:{"/RegExp@1":{"flags":"","flavor":"es2025","source":1}}',
  },
  {
    name: "regular expression with a numeric flavor",
    section: SECTION_REGEXP,
    text: 'fvj1:{"/RegExp@1":{"flags":"","flavor":1,"source":"a"}}',
  },
  {
    name: "regular expression with a flag es2025 lacks",
    section: SECTION_REGEXP,
    text: 'fvj1:{"/RegExp@1":{"flags":"z","flavor":"es2025","source":"a"}}',
    requires: { flavors: ["es2025"] },
  },
  {
    name: "regular expression with no flags",
    section: SECTION_REGEXP,
    text: 'fvj1:{"/RegExp@1":{"flavor":"es2025","source":"a"}}',
    divergence: REGEXP_FIELDS_NOTE + " This implementation reads absent " +
      "flags as empty.",
  },
  {
    name: "regular expression with no flavor",
    section: SECTION_REGEXP,
    text: 'fvj1:{"/RegExp@1":{"flags":"","source":"a"}}',
    divergence: REGEXP_FIELDS_NOTE + " This implementation reads an absent " +
      "flavor as `es2025`, a default the format does not have.",
  },
  {
    name: "regular expression with no source",
    section: SECTION_REGEXP,
    text: 'fvj1:{"/RegExp@1":{"flags":"","flavor":"es2025"}}',
    divergence: REGEXP_FIELDS_NOTE + " This implementation reads an absent " +
      "source as empty.",
  },
  {
    name: "regular expression with the empty state",
    section: SECTION_REGEXP,
    text: 'fvj1:{"/RegExp@1":{}}',
    divergence: REGEXP_FIELDS_NOTE + " This implementation reads the empty " +
      "state as an empty `es2025` pattern with no flags.",
  },
  {
    name: "tag with no version",
    section: SECTION_TAG_SYNTAX,
    text: 'fvj1:{"/EpochNsec":"AA"}',
  },
  {
    name: "special number with a numeric state",
    section: SECTION_NUMBERS,
    text: 'fvj1:{"/SpecialNumber@1":0}',
  },
];

/** What the primitive classes' examples need beyond their makers. */
const PRIMITIVE_CLASS_NOTES: {
  readonly [Name in keyof FabricPrimitiveClassesByName]: ClassCaseNotes;
} = {
  FabricBytes: { section: "3-json-encoding.md section 3, `Bytes@1`" },
  FabricDurationDay: {
    section: "3-json-encoding.md section 3, temporal quantities",
  },
  FabricDurationNsec: {
    section: "3-json-encoding.md section 3, temporal quantities",
  },
  FabricEpochDay: {
    section: "3-json-encoding.md section 3, temporal quantities",
  },
  FabricEpochNsec: {
    section: "3-json-encoding.md section 3, temporal quantities",
  },
  FabricHash: { section: "3-json-encoding.md section 3, `Hash@1`" },
  FabricKeyPair: { section: "3-json-encoding.md section 3, `KeyPair@1`" },
  FabricRegExp: { section: "3-json-encoding.md section 3, `RegExp@1`" },
  FabricUnavailable: {
    section: "3-json-encoding.md section 3, `Unavailable@1`",
  },
};

/** What the instance classes' examples need beyond their makers. */
const INSTANCE_CLASS_NOTES: {
  readonly [Name in keyof FabricInstanceClassesByName]: ClassCaseNotes;
} = {
  FabricError: { section: "3-json-encoding.md section 3, `Error@1`" },
  FabricLink: { section: "3-json-encoding.md section 3, `Link@1`" },
  FabricMap: { excluded: STUB_CODEC_EXCLUSION },
  FabricSet: { excluded: STUB_CODEC_EXCLUSION },
  ProblematicValue: {
    section: "3-json-encoding.md section 3, `Problematic@1`",
  },
  UnknownValue: { section: SECTION_UNKNOWN },
};

//
// The fixture
//

/** What the fixture says about itself. */
const FIXTURE_ABOUT = "Generated by `deno task regenerate-fvj1-conformance` " +
  "in packages/data-model, from the cases in src/fvj1-conformance.ts. " +
  "fvj1-conformance.md beside this file defines its format.";

/**
 * Returns the text of the fixture for `cases`, running each through this
 * package's default JSON codec. Each case is one line, and every character
 * past ASCII is escaped, so that the file is unchanged by any tool that
 * normalizes text.
 *
 * @throws If two cases share a name; if the codec fails other than by
 *   refusing; if a case's text decodes, or what it decodes to re-encodes,
 *   other than as the spec has it and no divergence says so; if a value
 *   encodes other than as what its text decodes to does; if a lenient decode
 *   of a text the spec refuses yields other than one `ProblematicValue`; or if
 *   a divergence a case declares does not hold.
 */
export function fvj1ConformanceFixtureText(
  cases: readonly Fvj1ConformanceCase[],
): string {
  assertDistinctCaseNames(cases);
  return fixtureTextOf(FIXTURE_ABOUT, cases.map(fixtureEntryOf));
}

/**
 * Returns what encoding `value` with this package's default JSON codec does.
 * A refusal is a throw of a plain `Error` or a `ProblematicStateError`, which
 * are what the codec refuses with.
 *
 * @throws What the codec throws, when it is anything else: a `TypeError`,
 *   say, is a fault in the codec rather than an answer from it.
 */
export function fvj1EncodeOutcomeOf(value: FabricValue): Fvj1Outcome {
  try {
    return { text: jsonFromFabricValue(value) };
  } catch (e) {
    return refusalOrRethrow(
      e,
      (e instanceof Error && e.constructor === Error) ||
        e instanceof ProblematicStateError,
      { refused: "unencodable" },
    );
  }
}

/**
 * Returns what decoding `stated` with this package's JSON codec does: the
 * probes of what `fabricValueOfTextWithMods()` returns for it, or the refusal.
 * The codec is strict, so that a malformation is refused rather than returned
 * as a `ProblematicValue`, and a refusal is a throw of a
 * `ProblematicStateError`, which is what a strict codec refuses with.
 *
 * @throws What decoding throws, when it is anything else: a fault in the
 *   codec, or mods that break their rules.
 */
export function fvj1DecodeOutcomeOf(stated: TextWithMods): Fvj1Outcome {
  let decoded: FabricValue;
  try {
    decoded = fabricValueOfTextWithMods(stated);
  } catch (e) {
    return refusalOrRethrow(e, e instanceof ProblematicStateError, {
      refused: decodeRefusalOf(stated.text),
    });
  }
  return { probes: probesOf(decoded, stated.patches) };
}

/**
 * Returns the path of each `ProblematicValue` that decoding `text` with this
 * package's default JSON codec, made lenient, returns in place of refusing.
 * Section 9 of `3-json-encoding.md` has a lenient decoder return one for a
 * text a strict one refuses, and does not say where; these are where this
 * package puts them. A `ProblematicValue` within another's state is part of
 * what the other preserves, and has no path here.
 *
 * @throws What the codec throws.
 */
export function fvj1ProblematicPathsOf(text: string): ValuePath[] {
  const paths = probedPathsOf(
    newDefaultJsonCodecEngine({ lenient: true }).decode(text),
    (node) => node instanceof ProblematicValue,
  );
  return paths.filter((path) =>
    !paths.some((outer) =>
      outer.length < path.length &&
      outer.every((step, index) =>
        JSON.stringify(step) === JSON.stringify(path[index])
      )
    )
  );
}

/**
 * Returns `refusal` when `isRefusal` says `thrown` is what the codec refuses
 * with, and throws `thrown` otherwise, it then being a fault in the codec.
 */
function refusalOrRethrow<Refusal>(
  thrown: unknown,
  isRefusal: boolean,
  refusal: Refusal,
): Refusal {
  if (!isRefusal) {
    throw thrown;
  }
  return refusal;
}

/** Returns the fixture entry for one case. */
function fixtureEntryOf(
  conformanceCase: Fvj1ConformanceCase,
): Record<string, FixtureJson> {
  const { name, section, divergence } = conformanceCase;
  const implementation: Record<string, FixtureJson> = {};

  // Records this package's outcome where it differs from the spec's, which
  // only a divergence permits.
  const compare = (
    step: "decode" | "encode",
    ours: Fvj1Outcome,
    spec: Fvj1Outcome,
  ) => {
    if (isSameOutcome(ours, spec)) {
      return;
    } else if (divergence === undefined) {
      throw new Error(
        `${name}: the ${step} is ${JSON.stringify(ours)}, not ` +
          `${JSON.stringify(spec)}, and no divergence says so.`,
      );
    }
    implementation[step] = ours;
  };

  let stated: TextWithMods;
  let specDecoded: Fvj1Outcome;
  let specReencoded: Fvj1Outcome | undefined;
  let canonical: string | undefined;
  let reencode: () => Fvj1Outcome;

  if ("make" in conformanceCase) {
    const value = conformanceCase.make();
    if (divergence !== undefined && plainJsonTextOf(value) === undefined) {
      throw new Error(
        `${name}: declares a divergence for a value whose spec text this ` +
          "module does not compute.",
      );
    }
    stated = textWithModsOf(value);
    specDecoded = { probes: probesOf(value, stated.patches) };

    // What no text carries, a cycle or a symbol of no registry key, has no
    // encoding either.
    specReencoded = (stated.patches === undefined)
      ? { text: stated.text }
      : { refused: "unencodable" };

    const encoded = fvj1EncodeOutcomeOf(value);
    reencode = () => {
      const reencoded = fvj1EncodeOutcomeOf(fabricValueOfTextWithMods(stated));
      if (!isSameOutcome(reencoded, encoded)) {
        throw new Error(
          `${name}: encodes to ${JSON.stringify(encoded)}, but what its ` +
            `text decodes to encodes to ${JSON.stringify(reencoded)}.`,
        );
      }
      return reencoded;
    };
  } else {
    const { text, specDecodes } = conformanceCase;
    stated = { text };
    specDecoded = (divergence === undefined || specDecodes)
      ? fvj1DecodeOutcomeOf(stated)
      : { refused: decodeRefusalOf(text) };
    reencode = () => fvj1EncodeOutcomeOf(fabricValueOfTextWithMods(stated));
    if (specDecodes && !("probes" in specDecoded)) {
      throw new Error(
        `${name}: says the spec decodes a text this package refuses, whose ` +
          "decoding this module therefore does not compute.",
      );
    } else if ("probes" in specDecoded) {
      const value = fabricValueOfTextWithMods(stated);
      if (divergence !== undefined && plainJsonTextOf(value) === undefined) {
        throw new Error(
          `${name}: declares a divergence for a value whose spec text this ` +
            "module does not compute.",
        );
      }
      const restated = textWithModsOf(value);
      if (restated.unclaimed !== undefined || restated.patches !== undefined) {
        throw new Error(`${name}: decodes to a value no text alone writes.`);
      }
      specReencoded = { text: restated.text };
      if (restated.text !== text) {
        canonical = restated.text;
      }
    }
  }

  const decoded = fvj1DecodeOutcomeOf(stated);
  compare("decode", decoded, specDecoded);
  if (specReencoded !== undefined) {
    if (isSameOutcome(decoded, specDecoded)) {
      compare("encode", reencode(), specReencoded);
    } else if ("make" in conformanceCase) {
      // This package's decoder refuses the text, or returns a value other
      // than the one the case makes, so what is re-encoded is that value.
      compare(
        "encode",
        fvj1EncodeOutcomeOf(conformanceCase.make()),
        specReencoded,
      );
    }
  }

  const requires = requirementsOf(stated, conformanceCase.requires?.flavors);
  const entry: Record<string, FixtureJson> = {
    name,
    section,
    ...(requires === undefined ? {} : { requires }),
    ...stated,
    ...specDecoded,
  };
  if (canonical !== undefined) {
    entry.canonical = canonical;
  }
  if (specReencoded !== undefined && "refused" in specReencoded) {
    entry.reencode = specReencoded;
  }
  if ("refused" in specDecoded && implementation.decode === undefined) {
    const paths = fvj1ProblematicPathsOf(stated.text);
    if (paths.length !== 1) {
      throw new Error(
        `${name}: a lenient decode yields ${paths.length} problematic ` +
          "values, not one.",
      );
    }
    entry.problematicAt = paths[0]!;
  }

  if (divergence !== undefined) {
    if (Object.keys(implementation).length === 0) {
      throw new Error(
        `${name}: declares a divergence, but this implementation does what ` +
          "the spec says.",
      );
    }
    entry.divergence = { note: divergence, ...implementation };
  }

  return entry;
}

/**
 * Returns why `text` is refused, read off the text: whether it has the
 * prefix, and whether what follows the prefix parses as JSON.
 */
function decodeRefusalOf(text: string): Fvj1Refusal {
  if (!JsonCodecEngine.seemsLikeEncoded(text)) {
    return "not-fvj1";
  }
  try {
    JSON.parse(JsonCodecEngine.unwrapEncodedValueForTesting(text, true));
  } catch {
    return "not-json";
  }
  return "malformed";
}

/** Indicates whether two outcomes are the same, outcomes being JSON. */
function isSameOutcome(a: Fvj1Outcome, b: Fvj1Outcome): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
