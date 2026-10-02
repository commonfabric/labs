/**
 * Conformance cases for the `fvj1:` JSON encoding, and what turns them into a
 * language-neutral fixture. An implementation of the format in another
 * language, or of another wire format that has to agree with this one, tests
 * against the fixture rather than against this package's code.
 *
 * Each case is a value or a text, and the fixture records what this package's
 * default JSON codec does with it: the exact text a value encodes to, and the
 * value a text decodes to, or the refusal. Values are written in the
 * descriptor notation that `test/fixtures/fvj1-conformance.md` defines, which
 * says everything about a value that the format carries and nothing about how
 * the format carries it.
 *
 * Where the formal spec says outright that this package falls short of it, the
 * case says so: the fixture records the spec's outcome, and this package's
 * beside it as a divergence. Where the spec does not settle a case, the case
 * records this package's outcome as unspecified. Generating the fixture fails
 * when a case's declared divergence does not hold, so that a fix here retires
 * the mark rather than leaving it to mislead.
 *
 * This is reached through `for-testing-only.ts` and has no place in any
 * barrel.
 */

import { utf8Compare } from "@commonfabric/utils/utf8";

import type { FabricValue } from "@/interface.ts";
import {
  ProblematicStateError,
  ProblematicValue,
  UnknownValue,
} from "@/codec-common";
import { JsonCodecEngine } from "@/codec-json";
import {
  FabricError,
  type FabricInstanceClassesByName,
  FabricLink,
  FabricMap,
  FabricSet,
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
  UNAVAILABLE_ERROR_KINDS,
  UNAVAILABLE_REASONS,
} from "@/fabric-primitives";
import { isFabricArray, isFabricPlainObject } from "@/types";
import { fabricFromJsonValue, jsonFromFabricValue } from "./codecs.ts";

//
// Types
//

/**
 * A value in the descriptor notation `test/fixtures/fvj1-conformance.md`
 * defines. It is JSON, so that any language can read it.
 */
export type Fvj1Descriptor =
  | null
  | boolean
  | number
  | string
  | readonly Fvj1Descriptor[]
  | { readonly [key: string]: Fvj1Descriptor };

/**
 * Why a decode is refused: the text lacks the `fvj1:` prefix, what follows
 * the prefix is not JSON, or the JSON is not a form the format allows. The
 * spec settles all three alike, so the kind says why and not how.
 */
export type Fvj1DecodeRefusal = "not-fvj1" | "not-json" | "malformed";

/** What encoding one value does: writes this text, or is refused. */
export type Fvj1EncodeOutcome =
  | { readonly text: string }
  | { readonly refused: "unencodable" };

/** What decoding one text does: returns this value, or is refused. */
export type Fvj1DecodeOutcome =
  | { readonly value: Fvj1Descriptor }
  | { readonly refused: Fvj1DecodeRefusal };

/**
 * One conformance case: a value to encode, made fresh by `make`, or a text to
 * decode. A value whose text decodes back to it makes a round trip, and a
 * text that decodes makes an encode case of the value it decodes to, so most
 * cases check both directions.
 *
 * `section` names the part of the formal spec the case exercises.
 * `divergence` is a note on what the format requires, for a case where this
 * package does not do it. The format's outcome is never typed here. For a
 * value, it is the text {@link plainJsonTextOf} computes, so a divergence can
 * only be declared for a value that function writes. For a text, it is that
 * the text is refused, the format refusing every text this package
 * over-accepts. `unspecified` is a note on what the format leaves open, for a
 * case whose outcome is recorded without being claimed as required.
 */
export type Fvj1ConformanceCase =
  & {
    readonly name: string;
    readonly section: string;
    readonly unspecified?: string;
    readonly divergence?: string;
  }
  & (
    | { readonly make: () => FabricValue }
    | { readonly text: string }
  );

/** Makers of examples of each class in one of the class tables. */
type ExampleMakers<ClassesByName> = {
  readonly [Name in keyof ClassesByName]: readonly (() => FabricValue)[];
};

/**
 * What a class's examples need beyond their makers: the spec section, or a
 * note saying why the class's examples are not cases.
 */
type ClassCaseNotes =
  | { readonly section: string }
  | { readonly excluded: string };

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
const SECTION_KEY_ORDER = "3-json-encoding.md section 10";
const SECTION_HOLES = "3-json-encoding.md section 3, sparse array encoding";
const SECTION_UNDEFINED = "3-json-encoding.md section 5";
const SECTION_ESCAPES = "3-json-encoding.md section 6";
const SECTION_RESERVED_KEYS = "3-json-encoding.md section 4";
const SECTION_SYMBOL = "3-json-encoding.md section 3, `Symbol@1`";
const SECTION_BIGINT = "3-json-encoding.md section 3, `BigInt@1`";
const SECTION_BASE64 = "3-json-encoding.md section 3, base64url convention";
const SECTION_UNKNOWN = "3-json-encoding.md section 8";
const SECTION_TAG_SYNTAX = "3-json-encoding.md section 2";
const SECTION_RESERVATION = "3-json-encoding.md section 9";
const SECTION_TYPES = "3-json-encoding.md section 3";

/** Why the classes whose codecs are stubs have no cases. */
const STUB_CODEC_EXCLUSION = "Its codec is a stub, pending general " +
  "`FabricInstance` support (1-fabric-values.md sections 1.4.3 and 1.4.4).";

/** Note shared by the cases with a key this implementation reserves. */
const RESERVED_KEY_NOTE = "Section 4 lets a record carry any key, and its " +
  "note says this implementation does not yet meet that: it refuses " +
  "`__proto__` and `constructor` on both sides of the wire. An " +
  "implementation on a host that does not route assignment through a " +
  "prototype reserves no names.";

/** The cases that do not range over the class tables. */
const FIXED_CASES: readonly Fvj1ConformanceCase[] = [
  // JSON's own values.
  { name: "null", section: SECTION_PREFIX, make: () => null },
  { name: "true", section: SECTION_PREFIX, make: () => true },
  { name: "false", section: SECTION_PREFIX, make: () => false },
  { name: "zero", section: SECTION_PREFIX, make: () => 0 },
  { name: "integer", section: SECTION_PREFIX, make: () => 42 },
  { name: "negative fraction", section: SECTION_PREFIX, make: () => -1.5 },
  { name: "inexact fraction", section: SECTION_PREFIX, make: () => 0.1 },
  { name: "large exponent", section: SECTION_PREFIX, make: () => 1e21 },
  { name: "small exponent", section: SECTION_PREFIX, make: () => 1e-7 },
  {
    name: "smallest subnormal",
    section: SECTION_PREFIX,
    make: () => Number.MIN_VALUE,
  },
  {
    name: "largest double",
    section: SECTION_PREFIX,
    make: () => Number.MAX_VALUE,
  },
  {
    name: "integer past 2^53",
    section: SECTION_PREFIX,
    make: () => 2 ** 53 + 2,
  },
  {
    name: "number spelled with fraction and exponent",
    section: SECTION_PREFIX,
    text: "fvj1:1.0E2",
  },
  {
    name: "whitespace around and inside the JSON",
    section: SECTION_PREFIX,
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
  { name: "empty string", section: SECTION_STRINGS, make: () => "" },
  {
    name: "string of characters JSON escapes",
    section: SECTION_STRINGS,
    make: () => '"\\/\b\f\n\r\t\u0000\u001f\u007f\u2028',
  },
  {
    name: "string beyond ASCII",
    section: SECTION_STRINGS,
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
    section: SECTION_STRINGS,
    make: () => "\ud800",
  },
  {
    name: "lone low surrogate between characters",
    section: SECTION_STRINGS,
    make: () => "a\udc00b",
  },
  {
    name: "surrogates in reverse order",
    section: SECTION_STRINGS,
    make: () => "\udc00\ud800",
  },
  {
    name: "lone surrogate escaped in uppercase",
    section: SECTION_STRINGS,
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
    section: SECTION_KEY_ORDER,
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
    section: SECTION_ESCAPES,
    make: () => ({ "/a": 1 }),
  },
  {
    name: "slash key alone",
    section: SECTION_ESCAPES,
    make: () => ({ "/": 1 }),
  },
  {
    name: "slash key over a value that needs encoding",
    section: SECTION_ESCAPES,
    make: () => ({ "/a": 10n, b: [undefined] }),
  },
  {
    name: "slash keys nested over literals",
    section: SECTION_ESCAPES,
    make: () => ({ "/a": { "/b": 1 } }),
  },
  {
    name: "slash keys nested over a value that needs encoding",
    section: SECTION_ESCAPES,
    make: () => ({ "/a": { "/b": 1n } }),
  },
  {
    name: "object escape over literals",
    section: SECTION_ESCAPES,
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
    divergence: "A state with a redundant leading `0x00` or `0xff` byte is " +
      "refused. This implementation reads it as the value it stands for.",
  },
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
    divergence: "A base64url state holding whitespace is refused. This " +
      "implementation skips the whitespace.",
  },
  {
    name: "bytes state with nonzero trailing bits",
    section: SECTION_BASE64,
    text: 'fvj1:{"/Bytes@1":"AR"}',
    unspecified: "Section 3 does not say whether a decoder refuses nonzero " +
      "bits after the last whole byte. This implementation ignores them, " +
      "reading `AR` as the byte `AQ` writes.",
  },

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
];

/**
 * Returns an array of length `length` holding `entries`, each an index and the
 * value there, and a hole at every other index.
 */
function sparseArrayOf(
  length: number,
  entries: readonly (readonly [number, FabricValue])[],
): FabricValue[] {
  const result: FabricValue[] = new Array(length);
  for (const [index, value] of entries) {
    result[index] = value;
  }
  return result;
}

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

/**
 * Returns one case for each maker in `makers`, named for its class and its
 * place among that class's makers.
 */
function classCasesOf<Name extends string>(
  makers: { readonly [N in Name]: readonly (() => FabricValue)[] },
  notes: { readonly [N in Name]: ClassCaseNotes },
): Fvj1ConformanceCase[] {
  const cases: Fvj1ConformanceCase[] = [];
  for (const name in notes) {
    const classNotes = notes[name];
    if ("excluded" in classNotes) continue;
    makers[name].forEach((make, index) => {
      cases.push({
        name: `${name}, example ${index + 1}`,
        section: classNotes.section,
        make,
      });
    });
  }
  return cases;
}

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
 *   refusing; if a value case's text does not decode back to its value, or
 *   differs from what {@link plainJsonTextOf} writes for it, and no divergence
 *   says so; or if a divergence a case declares does not hold.
 */
export function fvj1ConformanceFixtureText(
  cases: readonly Fvj1ConformanceCase[],
): string {
  const names = new Set<string>();
  const lines = cases.map((conformanceCase) => {
    if (names.has(conformanceCase.name)) {
      throw new Error(`Two cases are named ${conformanceCase.name}.`);
    }
    names.add(conformanceCase.name);
    return asciiJsonOf(fixtureEntryOf(conformanceCase));
  });

  return `{\n  "about": ${asciiJsonOf(FIXTURE_ABOUT)},\n  "cases": [\n    ` +
    `${lines.join(",\n    ")}\n  ]\n}\n`;
}

/**
 * Returns what encoding `value` with this package's default JSON codec does.
 * A refusal is a throw of a plain `Error` or a `ProblematicStateError`, which
 * are what the codec refuses with.
 *
 * @throws What the codec throws, when it is anything else: a `TypeError`,
 *   say, is a fault in the codec rather than an answer from it.
 */
export function fvj1EncodeOutcomeOf(value: FabricValue): Fvj1EncodeOutcome {
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
 * Returns what decoding `text` with this package's default JSON codec does,
 * the codec being strict, so that a malformation is refused rather than
 * returned as a `ProblematicValue`. A refusal is a throw of a
 * `ProblematicStateError`, which is what a strict codec refuses with.
 *
 * @throws What the codec throws, when it is anything else.
 */
export function fvj1DecodeOutcomeOf(text: string): Fvj1DecodeOutcome {
  let decoded: FabricValue;
  try {
    decoded = fabricFromJsonValue(text);
  } catch (e) {
    return refusalOrRethrow(e, e instanceof ProblematicStateError, {
      refused: decodeRefusalOf(text),
    });
  }
  return { value: fvj1DescriptorOf(decoded) };
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
): Record<string, Fvj1Descriptor> {
  const { name, section, unspecified, divergence } = conformanceCase;
  const entry: Record<string, Fvj1Descriptor> = { name, section };
  const implementation: Record<string, Fvj1Descriptor> = {};

  if ("make" in conformanceCase) {
    const value = conformanceCase.make();
    const described = fvj1DescriptorOf(value);
    const encoded = fvj1EncodeOutcomeOf(value);
    const plainText = plainJsonTextOf(value);
    if (divergence !== undefined && plainText === undefined) {
      throw new Error(
        `${name}: declares a divergence for a value whose spec text this ` +
          "module does not compute.",
      );
    }
    const specEncoded = (plainText === undefined)
      ? encoded
      : { text: plainText };
    entry.encode = { value: described, ...specEncoded };
    if (!isSameOutcome(encoded, specEncoded)) {
      if (divergence === undefined) {
        throw new Error(
          `${name}: encodes to ${JSON.stringify(encoded)}, not to ` +
            `\`${plainText}\`.`,
        );
      }
      implementation.encode = encoded;
    }

    if ("text" in specEncoded) {
      const decoded = fvj1DecodeOutcomeOf(specEncoded.text);
      entry.decode = { text: specEncoded.text, value: described };
      if (!isSameOutcome(decoded, { value: described })) {
        if (divergence === undefined) {
          throw new Error(
            `${name}: \`${specEncoded.text}\` does not decode to the value ` +
              "it was encoded from.",
          );
        }
        implementation.decode = decoded;
      }
    }
  } else {
    const { text } = conformanceCase;
    const decoded = fvj1DecodeOutcomeOf(text);
    const specDecoded: Fvj1DecodeOutcome = (divergence === undefined)
      ? decoded
      : { refused: decodeRefusalOf(text) };
    entry.decode = { text, ...specDecoded };
    if (!isSameOutcome(decoded, specDecoded)) {
      implementation.decode = decoded;
    }

    if ("value" in specDecoded) {
      // Built from the descriptor, so that the value encoded is the one the
      // fixture states rather than the one this decode happened to return.
      entry.encode = {
        value: specDecoded.value,
        ...fvj1EncodeOutcomeOf(fabricValueOfFvj1Descriptor(specDecoded.value)),
      };
    }
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
  if (unspecified !== undefined) {
    entry.unspecified = unspecified;
  }

  return entry;
}

/**
 * Returns the `fvj1:` text the spec gives `value`, when `value` is plain JSON
 * that needs no encoding: `null`, a boolean, a finite number other than
 * negative zero, a string, or an array or record of these, holding no hole and
 * no key starting with `/`. Returns `undefined` for anything else.
 *
 * This writes the text without the codec, sorting the value's own keys with
 * `utf8Compare()`, the canonical comparator section 10 names, so that the
 * codec's key order is held to a computation from the case rather than to
 * the codec's output or to text typed by hand.
 */
function plainJsonTextOf(value: FabricValue): string | undefined {
  const body = plainJsonBodyOf(value);
  return (body === undefined)
    ? undefined
    : JsonCodecEngine.wrapEncodedValueForTesting(body, true);
}

/** Helper for {@link plainJsonTextOf}, which writes the JSON alone. */
function plainJsonBodyOf(value: FabricValue): string | undefined {
  if (
    value === null || typeof value === "boolean" || typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value) &&
      !Object.is(value, -0))
  ) {
    return JSON.stringify(value);
  }

  const parts: string[] = [];
  if (isFabricArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const part = (index in value) ? plainJsonBodyOf(value[index]) : undefined;
      if (part === undefined) return undefined;
      parts.push(part);
    }
    return `[${parts.join(",")}]`;
  } else if (isFabricPlainObject(value)) {
    for (const key of Object.keys(value).sort(utf8Compare)) {
      const part = plainJsonBodyOf(value[key]);
      if (part === undefined || key.startsWith("/")) return undefined;
      parts.push(`${JSON.stringify(key)}:${part}`);
    }
    return `{${parts.join(",")}}`;
  }
  return undefined;
}

/**
 * Returns why `text` is refused, read off the text: whether it has the
 * prefix, and whether what follows the prefix parses as JSON.
 */
function decodeRefusalOf(text: string): Fvj1DecodeRefusal {
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

/** Indicates whether two outcomes are the same, descriptors being JSON. */
function isSameOutcome(
  a: Fvj1EncodeOutcome | Fvj1DecodeOutcome,
  b: Fvj1EncodeOutcome | Fvj1DecodeOutcome,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Returns the JSON text of `value`, with every non-ASCII code unit escaped. */
function asciiJsonOf(value: Fvj1Descriptor): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

//
// Descriptors
//

/**
 * Returns the descriptor of `value`, in the notation
 * `test/fixtures/fvj1-conformance.md` defines.
 *
 * @throws If `value` is a key pair holding `CryptoKey` handles rather than
 *   key material, which no descriptor can write down.
 */
export function fvj1DescriptorOf(value: FabricValue): Fvj1Descriptor {
  switch (typeof value) {
    case "undefined": {
      return { undefined: null };
    }
    case "boolean": {
      return value;
    }
    case "string": {
      return stringDescriptorOf(value);
    }
    case "bigint": {
      return { bigint: value.toString() };
    }
    case "symbol": {
      const key = Symbol.keyFor(value);
      return (key === undefined)
        ? {
          unregisteredSymbol: (value.description === undefined)
            ? null
            : stringDescriptorOf(value.description),
        }
        : { symbol: stringDescriptorOf(key) };
    }
    case "number": {
      if (Number.isFinite(value) && !Object.is(value, -0)) {
        return value;
      }
      const special = SPECIAL_NUMBER_NAMES.find(([, number]) =>
        Object.is(number, value)
      );
      return { number: (special === undefined) ? "NaN" : special[0] };
    }
  }

  if (value === null) {
    return null;
  } else if (isFabricArray(value)) {
    return { array: arrayEntriesOf(value) };
  } else if (isFabricPlainObject(value)) {
    return { record: recordEntriesOf(value) };
  }

  for (const notation of Object.values(CLASS_NOTATIONS)) {
    const described = notation.describe(value);
    if (described !== undefined) {
      return described;
    }
  }
  throw new Error("No descriptor for a value of an unknown class.");
}

/**
 * Returns the value `descriptor` describes. The inverse of
 * {@link fvj1DescriptorOf}: the descriptor of the result is `descriptor`.
 *
 * @throws If `descriptor` is not one the notation defines.
 */
export function fabricValueOfFvj1Descriptor(
  descriptor: Fvj1Descriptor,
): FabricValue {
  if (
    descriptor === null || typeof descriptor === "boolean" ||
    typeof descriptor === "number" || typeof descriptor === "string"
  ) {
    return descriptor;
  }

  const [kind, payload] = soleEntryOf(descriptor);
  switch (kind) {
    case "undefined": {
      return undefined;
    }
    case "number": {
      const found = SPECIAL_NUMBER_NAMES.find(([name]) => name === payload);
      if (found === undefined) {
        throw new Error(`Not a special number: ${JSON.stringify(payload)}`);
      }
      return found[1];
    }
    case "utf16": {
      return stringOf(descriptor);
    }
    case "bigint": {
      return BigInt(stringOf(payload));
    }
    case "symbol": {
      return Symbol.for(stringOf(payload));
    }
    case "unregisteredSymbol": {
      return (payload === null) ? Symbol() : Symbol(stringOf(payload));
    }
    case "array": {
      return arrayOf(payload);
    }
    case "record": {
      return Object.fromEntries(
        listOf(payload).map((pair) => {
          const [key, value] = pairOf(pair);
          return [stringOf(key), fabricValueOfFvj1Descriptor(value)];
        }),
      );
    }
  }

  for (const notation of Object.values(CLASS_NOTATIONS)) {
    if (notation.key === kind) {
      return notation.make(payload);
    }
  }
  throw new Error(`Not a descriptor kind: ${kind}`);
}

/** The special numbers, under the names their descriptors use. */
const SPECIAL_NUMBER_NAMES: readonly (readonly [string, number])[] = [
  ["-0", -0],
  ["NaN", NaN],
  ["+Infinity", Infinity],
  ["-Infinity", -Infinity],
];

/**
 * How one class's instances are described, and made back from a descriptor.
 * `cls` is there for its type, which ties the entry to the class it is keyed
 * under in {@link CLASS_NOTATIONS}.
 */
interface ClassNotation<Class> {
  readonly cls: Class;
  readonly key: string;
  /** The descriptor of `value`, or `undefined` if it is not of this class. */
  readonly describe: (value: FabricValue) => Fvj1Descriptor | undefined;
  readonly make: (payload: Fvj1Descriptor) => FabricValue;
}

/**
 * Returns the notation for instances of `cls`, under the descriptor key `key`.
 * `describe` returns the payload a descriptor holds under that key, and `make`
 * returns the instance a payload describes.
 */
function notate<Class extends abstract new (...args: never) => object>(
  cls: Class,
  key: string,
  describe: (value: InstanceType<Class>) => Fvj1Descriptor,
  make: (payload: Fvj1Descriptor) => InstanceType<Class>,
): ClassNotation<Class> {
  return {
    cls,
    key,
    describe: (value) =>
      isInstanceOf(cls, value) ? { [key]: describe(value) } : undefined,
    make,
  };
}

/** Indicates whether `value` is an instance of `cls`. */
function isInstanceOf<Class extends abstract new (...args: never) => object>(
  cls: Class,
  value: unknown,
): value is InstanceType<Class> {
  return value instanceof cls;
}

/**
 * The notation for every concrete class, keyed the way the two class tables
 * key the classes. Its type is what holds it complete.
 */
const CLASS_NOTATIONS:
  & {
    readonly [Name in keyof FabricPrimitiveClassesByName]: ClassNotation<
      FabricPrimitiveClassesByName[Name]
    >;
  }
  & {
    readonly [Name in keyof FabricInstanceClassesByName]: ClassNotation<
      FabricInstanceClassesByName[Name]
    >;
  } = {
    FabricBytes: notate(
      FabricBytes,
      "Bytes",
      (value) => hexOf(value.slice()),
      (payload) => new FabricBytes(bytesOf(payload)),
    ),
    FabricDurationDay: notate(
      FabricDurationDay,
      "DurationDay",
      (value) => value.value.toString(),
      (payload) => new FabricDurationDay(BigInt(stringOf(payload))),
    ),
    FabricDurationNsec: notate(
      FabricDurationNsec,
      "DurationNsec",
      (value) => value.value.toString(),
      (payload) => new FabricDurationNsec(BigInt(stringOf(payload))),
    ),
    FabricEpochDay: notate(
      FabricEpochDay,
      "EpochDay",
      (value) => value.value.toString(),
      (payload) => new FabricEpochDay(BigInt(stringOf(payload))),
    ),
    FabricEpochNsec: notate(
      FabricEpochNsec,
      "EpochNsec",
      (value) => value.value.toString(),
      (payload) => new FabricEpochNsec(BigInt(stringOf(payload))),
    ),
    FabricHash: notate(
      FabricHash,
      "Hash",
      (value) => ({
        tag: stringDescriptorOf(value.tag),
        hash: hexOf(value.bytes),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        return new FabricHash(
          bytesOf(fieldOf(fields, "hash")),
          stringOf(fieldOf(fields, "tag")),
        );
      },
    ),
    FabricKeyPair: notate(
      FabricKeyPair,
      "KeyPair",
      (value) => {
        if (!value.hasMaterial) {
          throw new Error(
            "No descriptor for a key pair holding `CryptoKey` handles.",
          );
        }
        return {
          algorithm: stringDescriptorOf(value.algorithm),
          publicKey: hexOf(value.publicKeyBytes.slice()),
          privateKey: hexOf(value.privateKeyBytes.slice()),
        };
      },
      (payload) => {
        const fields = fieldsOf(payload);
        return new FabricKeyPair(
          stringOf(fieldOf(fields, "algorithm")),
          bytesOf(fieldOf(fields, "publicKey")),
          bytesOf(fieldOf(fields, "privateKey")),
        );
      },
    ),
    FabricRegExp: notate(
      FabricRegExp,
      "RegExp",
      (value) => ({
        flavor: stringDescriptorOf(value.flavor),
        source: stringDescriptorOf(value.source),
        flags: stringDescriptorOf(value.flags),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        return new FabricRegExp(
          stringOf(fieldOf(fields, "flavor")),
          stringOf(fieldOf(fields, "source")),
          stringOf(fieldOf(fields, "flags")),
        );
      },
    ),
    FabricUnavailable: notate(
      FabricUnavailable,
      "Unavailable",
      (value) => ({
        reason: value.reason,
        ...(value.errorKind === null ? {} : { errorKind: value.errorKind }),
        ...(value.rawErrorMessage === null
          ? {}
          : { errorMessage: stringDescriptorOf(value.rawErrorMessage) }),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        const reasonName = stringOf(fieldOf(fields, "reason"));
        const reason = Object.values(UNAVAILABLE_REASONS).find((r) =>
          r === reasonName
        );
        if (reason === undefined) {
          throw new Error(`Not an unavailable reason: ${reasonName}`);
        }
        const kindName = fields.errorKind;
        const errorKind = (kindName === undefined)
          ? null
          : Object.values(UNAVAILABLE_ERROR_KINDS).find((k) =>
            k === stringOf(kindName)
          );
        if (errorKind === undefined) {
          throw new Error(`Not an error kind: ${JSON.stringify(kindName)}`);
        }
        const message = fields.errorMessage;
        return new FabricUnavailable(
          reason,
          errorKind,
          (message === undefined) ? null : stringOf(message),
        );
      },
    ),
    FabricError: notate(
      FabricError,
      "Error",
      (value) => ({
        type: stringDescriptorOf(value.type),
        name: stringDescriptorOf(value.name),
        message: stringDescriptorOf(value.message),
        ...(value.stack === undefined
          ? {}
          : { stack: stringDescriptorOf(value.stack) }),
        ...(value.cause === undefined
          ? {}
          : { cause: fvj1DescriptorOf(value.cause) }),
        extras: [...value.extraEntries()]
          .sort(([a], [b]) => utf8Compare(a, b))
          .map(([key, extra]) => [
            stringDescriptorOf(key),
            fvj1DescriptorOf(extra),
          ]),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        const { stack, cause } = fields;
        return new FabricError({
          type: stringOf(fieldOf(fields, "type")),
          name: stringOf(fieldOf(fields, "name")),
          message: stringOf(fieldOf(fields, "message")),
          stack: (stack === undefined) ? undefined : stringOf(stack),
          cause: (cause === undefined)
            ? undefined
            : fabricValueOfFvj1Descriptor(cause),
          extras: listOf(fieldOf(fields, "extras")).map((pair) => {
            const [key, extra] = pairOf(pair);
            return [stringOf(key), fabricValueOfFvj1Descriptor(extra)] as const;
          }),
        });
      },
    ),
    FabricLink: notate(
      FabricLink,
      "Link",
      (value) => fvj1DescriptorOf(value.payload),
      (payload) => {
        const linkPayload = fabricValueOfFvj1Descriptor(payload);
        if (!isFabricPlainObject(linkPayload)) {
          throw new Error("A link's payload must be a record.");
        }
        return new FabricLink(linkPayload);
      },
    ),
    FabricMap: notate(
      FabricMap,
      "Map",
      (value) =>
        [...value.map].map(([key, entry]) => [
          fvj1DescriptorOf(key),
          fvj1DescriptorOf(entry),
        ]),
      (payload) =>
        new FabricMap(
          new Map(
            listOf(payload).map((pair) => {
              const [key, entry] = pairOf(pair);
              return [
                fabricValueOfFvj1Descriptor(key),
                fabricValueOfFvj1Descriptor(entry),
              ];
            }),
          ),
        ),
    ),
    FabricSet: notate(
      FabricSet,
      "Set",
      (value) => [...value.set].map(fvj1DescriptorOf),
      (payload) =>
        new FabricSet(
          new Set(listOf(payload).map(fabricValueOfFvj1Descriptor)),
        ),
    ),
    ProblematicValue: notate(
      ProblematicValue,
      "Problematic",
      (value) => ({
        tag: stringDescriptorOf(value.wireTypeTag),
        state: fvj1DescriptorOf(value.state),
        error: stringDescriptorOf(value.error),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        return new ProblematicValue(
          stringOf(fieldOf(fields, "tag")),
          fabricValueOfFvj1Descriptor(fieldOf(fields, "state")),
          stringOf(fieldOf(fields, "error")),
        );
      },
    ),
    UnknownValue: notate(
      UnknownValue,
      "Unknown",
      (value) => ({
        tag: value.wireTypeTag,
        state: fvj1DescriptorOf(value.state),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        return new UnknownValue(
          stringOf(fieldOf(fields, "tag")),
          fabricValueOfFvj1Descriptor(fieldOf(fields, "state")),
        );
      },
    ),
  };

/**
 * Returns the descriptor of a string: the string itself when it is well
 * formed, and its UTF-16 code units when it holds a lone surrogate, which not
 * every JSON reader keeps.
 */
function stringDescriptorOf(value: string): Fvj1Descriptor {
  return value.isWellFormed()
    ? value
    : { utf16: Array.from(value, (_, i) => value.charCodeAt(i)) };
}

/** Returns the entries of an array's descriptor, holes as maximal runs. */
function arrayEntriesOf(value: readonly FabricValue[]): Fvj1Descriptor[] {
  const entries: Fvj1Descriptor[] = [];
  let index = 0;
  while (index < value.length) {
    if (index in value) {
      entries.push(fvj1DescriptorOf(value[index]));
      index++;
    } else {
      let count = 0;
      for (; index < value.length && !(index in value); index++) {
        count++;
      }
      entries.push({ hole: count });
    }
  }
  return entries;
}

/** Returns the entries of a record's descriptor, in UTF-8 order of key. */
function recordEntriesOf(
  value: { readonly [key: string]: FabricValue },
): Fvj1Descriptor[] {
  return Object.keys(value).sort(utf8Compare).map((key) => [
    stringDescriptorOf(key),
    fvj1DescriptorOf(value[key]),
  ]);
}

/** Returns the array an array descriptor's payload describes. */
function arrayOf(payload: Fvj1Descriptor): FabricValue[] {
  const result: FabricValue[] = [];
  let index = 0;
  for (const entry of listOf(payload)) {
    const hole = holeCountOf(entry);
    if (hole === undefined) {
      result[index] = fabricValueOfFvj1Descriptor(entry);
      index++;
    } else {
      index += hole;
    }
  }
  result.length = index;
  return result;
}

/**
 * Returns the count of a `hole` entry, or `undefined` for any other entry.
 *
 * @throws If a `hole` entry's count is not an integer of at least one, the
 *   least run the wire format writes.
 */
function holeCountOf(entry: Fvj1Descriptor): number | undefined {
  if (entry === null || typeof entry !== "object" || isList(entry)) {
    return undefined;
  }
  const [kind, count] = soleEntryOf(entry);
  if (kind !== "hole") {
    return undefined;
  } else if (
    !(typeof count === "number" && Number.isSafeInteger(count) && count >= 1)
  ) {
    throw new Error(`Not a hole count: ${JSON.stringify(count)}`);
  }
  return count;
}

/** Returns the string a string descriptor describes. */
function stringOf(descriptor: Fvj1Descriptor): string {
  if (typeof descriptor === "string") {
    return descriptor;
  }
  const [kind, units] = soleEntryOf(fieldsOf(descriptor));
  if (kind !== "utf16") {
    throw new Error(`Not a string descriptor: ${JSON.stringify(descriptor)}`);
  }
  return listOf(units).map((unit) => {
    if (typeof unit !== "number") {
      throw new Error(`Not a code unit: ${JSON.stringify(unit)}`);
    }
    return String.fromCharCode(unit);
  }).join("");
}

/** Returns the bytes a lowercase hexadecimal string describes. */
function bytesOf(descriptor: Fvj1Descriptor): Uint8Array {
  const hex = stringOf(descriptor);
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new Error(`Not lowercase hexadecimal bytes: ${hex}`);
  }
  return Uint8Array.from(
    { length: hex.length / 2 },
    (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}

/** Returns `bytes` as lowercase hexadecimal. */
function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Returns `descriptor` as a list, throwing if it is not one. */
function listOf(descriptor: Fvj1Descriptor): readonly Fvj1Descriptor[] {
  if (!isList(descriptor)) {
    throw new Error(`Not a list: ${JSON.stringify(descriptor)}`);
  }
  return descriptor;
}

/**
 * Indicates whether `descriptor` is a list. `Array.isArray()` narrows to a
 * mutable array, which leaves a read-only one in the other branch.
 */
function isList(
  descriptor: Fvj1Descriptor,
): descriptor is readonly Fvj1Descriptor[] {
  return Array.isArray(descriptor);
}

/** Returns `descriptor` as a two-element list, throwing if it is not one. */
function pairOf(
  descriptor: Fvj1Descriptor,
): readonly [Fvj1Descriptor, Fvj1Descriptor] {
  const [first, second, ...rest] = listOf(descriptor);
  if (first === undefined || second === undefined || rest.length > 0) {
    throw new Error(`Not a pair: ${JSON.stringify(descriptor)}`);
  }
  return [first, second];
}

/** Returns `descriptor` as a JSON object, throwing if it is not one. */
function fieldsOf(
  descriptor: Fvj1Descriptor,
): { readonly [key: string]: Fvj1Descriptor } {
  if (
    descriptor === null || typeof descriptor !== "object" || isList(descriptor)
  ) {
    throw new Error(`Not an object: ${JSON.stringify(descriptor)}`);
  }
  return descriptor;
}

/** Returns the field `key` of `fields`, throwing if it is absent. */
function fieldOf(
  fields: { readonly [key: string]: Fvj1Descriptor },
  key: string,
): Fvj1Descriptor {
  const field = fields[key];
  if (field === undefined) {
    throw new Error(`No field \`${key}\` in ${JSON.stringify(fields)}`);
  }
  return field;
}

/** Returns the one key and value of `descriptor`, throwing unless one. */
function soleEntryOf(
  descriptor: Fvj1Descriptor,
): readonly [string, Fvj1Descriptor] {
  const entries = Object.entries(fieldsOf(descriptor));
  const [entry] = entries;
  if (entry === undefined || entries.length > 1) {
    throw new Error(`Not a single-key object: ${JSON.stringify(descriptor)}`);
  }
  return entry;
}
