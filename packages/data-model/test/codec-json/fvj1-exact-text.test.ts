/**
 * The exact `fvj1:` text the default JSON codec writes for one value of each
 * kind the format carries, and the value that text decodes back to.
 *
 * Every expected text here is written from the specification
 * (`docs/specs/space-model-formal-spec/3-json-encoding.md`, and
 * `1-fabric-values.md` where it says more), never copied from the codec's
 * output. These cases are what entitle the codec to stand as the reference
 * against which the package's conformance fixtures are checked, so a text
 * taken from the codec would let it vouch for itself.
 *
 * The specification fixes the text and not only its structure: Section 11 of
 * `3-json-encoding.md` gives each number and each string one way to be
 * written, and the body no whitespace between its tokens, and Section 10 gives
 * a record one order of keys.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type FabricValue, valueEqual } from "@";
import { ProblematicValue, UnknownValue } from "@/codec-common";
import { fabricFromJsonValue, jsonFromFabricValue } from "@/codecs.ts";
import {
  FabricError,
  FabricLink,
  FabricMap,
  FabricSet,
} from "@/fabric-instances";
import type { FabricInstanceClassesByName } from "@/fabric-instances/impl.ts";
import {
  FabricBytes,
  FabricDurationDay,
  FabricDurationNsec,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  FabricRegExp,
  FabricUnavailable,
} from "@/fabric-primitives";
import type { FabricPrimitiveClassesByName } from "@/fabric-primitives/impl.ts";

/** One value, and the exact text it encodes to and decodes from. */
type TextCase = {
  /** What the value is, as the cases' descriptions name it. */
  readonly what: string;

  /** Makes the value afresh. */
  readonly make: () => FabricValue;

  /** The exact text. */
  readonly text: string;
};

/**
 * A class whose codec refuses every value, its implementation being a stub
 * (`1-fabric-values.md` Sections 1.4.3 and 1.4.4). It has no text to pin until
 * that changes, and the case refusing it is the one that says so.
 */
type StubbedClass = {
  /** Makes a value of the class. */
  readonly stubbed: () => FabricValue;
};

/**
 * Asserts that `actual` is the value `expected` is: equal by `valueEqual()`,
 * and an instance of the same class where `expected` is an object. The second
 * is not implied by the first, which holds between an instance and an
 * `UnknownValue` carrying its tag and state.
 */
function expectSameValue(actual: FabricValue, expected: FabricValue): void {
  expect(valueEqual(actual, expected)).toBe(true);
  if (typeof expected === "object" && expected !== null) {
    expect(Object.getPrototypeOf(actual)).toBe(
      Object.getPrototypeOf(expected),
    );
  }
}

/** Defines the encode and decode cases for each of `cases`. */
function describeTextCases(cases: readonly TextCase[]): void {
  for (const { what, make, text } of cases) {
    it(`encodes ${what} to its text`, () => {
      expect(jsonFromFabricValue(make())).toBe(text);
    });

    it(`decodes the text of ${what} back to it`, () => {
      expectSameValue(fabricFromJsonValue(text), make());
    });
  }
}

/** Makes a `FabricError` from `fields`, with no `stack` or `cause`. */
function errorOf(
  fields: {
    type: string;
    name?: string;
    message: string;
    extras?: Record<string, FabricValue>;
  },
): FabricError {
  return new FabricError({ stack: undefined, cause: undefined, ...fields });
}

/**
 * The cases for each `bigint` a temporal class carries, as `make` from the
 * value. Section 3 of `3-json-encoding.md` has each temporal encode its
 * `bigint` as `BigInt@1` does, as base64url over its minimal two's-complement
 * big-endian bytes, so these are that table's rows and their neighbors: `0x7f`
 * the largest one-byte value, and `0xff 0x7f` the first negative needing two
 * bytes. The last three are 2^63 - 1, 2^63 and -2^63, as eight bytes, nine,
 * and eight.
 */
function temporalCases(
  tag: string,
  make: (value: bigint) => FabricValue,
): TextCase[] {
  const states: [bigint, string][] = [
    [0n, "AA"],
    [1n, "AQ"],
    [-1n, "_w"],
    [127n, "fw"],
    [128n, "AIA"],
    [-128n, "gA"],
    [-129n, "_38"],
    [2n ** 63n - 1n, "f_________8"],
    [2n ** 63n, "AIAAAAAAAAAA"],
    [-(2n ** 63n), "gAAAAAAAAAA"],
  ];

  return states.map(([value, state]) => ({
    what: `\`${value}n\``,
    make: () => make(value),
    text: `fvj1:{"/${tag}":"${state}"}`,
  }));
}

/**
 * The cases for the four tags the format itself decides, which no class
 * claims (`3-json-encoding.md` Section 3).
 */
const FORMAT_TAG_CASES: Readonly<
  Record<
    "BigInt@1" | "SpecialNumber@1" | "Symbol@1" | "Undefined@1",
    TextCase[]
  >
> = {
  // The rows of the table under `BigInt@1` in Section 3, and two more.
  "BigInt@1": [
    { what: "`0n`", make: () => 0n, text: 'fvj1:{"/BigInt@1":"AA"}' },
    { what: "`1n`", make: () => 1n, text: 'fvj1:{"/BigInt@1":"AQ"}' },
    { what: "`-1n`", make: () => -1n, text: 'fvj1:{"/BigInt@1":"_w"}' },
    { what: "`128n`", make: () => 128n, text: 'fvj1:{"/BigInt@1":"AIA"}' },
    { what: "`-128n`", make: () => -128n, text: 'fvj1:{"/BigInt@1":"gA"}' },
    { what: "`-129n`", make: () => -129n, text: 'fvj1:{"/BigInt@1":"_38"}' },
    {
      what: "`2n ** 64n`",
      make: () => 2n ** 64n,
      text: 'fvj1:{"/BigInt@1":"AQAAAAAAAAAA"}',
    },
  ],
  "SpecialNumber@1": [
    {
      what: "`-0`",
      make: () => -0,
      text: 'fvj1:{"/SpecialNumber@1":"-0"}',
    },
    {
      what: "`NaN`",
      make: () => NaN,
      text: 'fvj1:{"/SpecialNumber@1":"NaN"}',
    },
    {
      what: "`Infinity`",
      make: () => Infinity,
      text: 'fvj1:{"/SpecialNumber@1":"+Infinity"}',
    },
    {
      what: "`-Infinity`",
      make: () => -Infinity,
      text: 'fvj1:{"/SpecialNumber@1":"-Infinity"}',
    },
  ],
  "Symbol@1": [
    {
      what: "an interned symbol",
      make: () => Symbol.for("cruller"),
      text: 'fvj1:{"/Symbol@1":"cruller"}',
    },
  ],
  "Undefined@1": [
    {
      what: "`undefined`",
      make: () => undefined,
      text: 'fvj1:{"/Undefined@1":null}',
    },
  ],
};

/**
 * The cases for each concrete class, keyed by its name. Its type is what holds
 * the table to every class the package defines: a class with no entry here
 * stops the build.
 *
 * A record that reaches the wire, a class's state included, is written with its
 * keys in UTF-8 byte order (`3-json-encoding.md` Section 10), whatever order
 * the state's fields are named in by the specification.
 */
const CLASS_CASES: Readonly<
  Record<
    keyof FabricPrimitiveClassesByName | keyof FabricInstanceClassesByName,
    readonly TextCase[] | StubbedClass
  >
> = {
  FabricBytes: [
    {
      what: "empty bytes",
      make: () => new FabricBytes(new Uint8Array([])),
      text: 'fvj1:{"/Bytes@1":""}',
    },
    {
      // Both characters only the URL-safe alphabet has, and no padding.
      what: "bytes `fb ff 01`",
      make: () => new FabricBytes(new Uint8Array([0xfb, 0xff, 0x01])),
      text: 'fvj1:{"/Bytes@1":"-_8B"}',
    },
  ],
  FabricDurationDay: temporalCases(
    "DurationDay@1",
    (value) => new FabricDurationDay(value),
  ),
  FabricDurationNsec: temporalCases(
    "DurationNsec@1",
    (value) => new FabricDurationNsec(value),
  ),
  FabricEpochDay: temporalCases(
    "EpochDay@1",
    (value) => new FabricEpochDay(value),
  ),
  FabricEpochNsec: temporalCases(
    "EpochNsec@1",
    (value) => new FabricEpochNsec(value),
  ),
  FabricHash: [
    {
      what: "a hash",
      make: () => new FabricHash(new Uint8Array([0xfb, 0xff]), "fid1"),
      text: 'fvj1:{"/Hash@1":{"hash":"-_8","tag":"fid1"}}',
    },
  ],
  FabricKeyPair: [
    {
      what: "a key pair holding key material",
      make: () =>
        new FabricKeyPair(
          "Ed25519",
          new Uint8Array([1, 2, 3]),
          new Uint8Array([4, 5]),
        ),
      text:
        'fvj1:{"/KeyPair@1":{"algorithm":"Ed25519","privateKey":"BAU","publicKey":"AQID"}}',
    },
  ],
  FabricRegExp: [
    {
      what: "an `es2025` regular expression",
      make: () => new FabricRegExp(/ab+c/gi),
      text:
        'fvj1:{"/RegExp@1":{"flags":"gi","flavor":"es2025","source":"ab+c"}}',
    },
    {
      what: "a regular expression of another flavor",
      make: () => new FabricRegExp("pcre2", "a++", "x"),
      text: 'fvj1:{"/RegExp@1":{"flags":"x","flavor":"pcre2","source":"a++"}}',
    },
  ],
  FabricUnavailable: [
    {
      what: "a transient reason",
      make: () => new FabricUnavailable("pending"),
      text: 'fvj1:{"/Unavailable@1":{"reason":"pending"}}',
    },
    {
      what: "an error with no message",
      make: () => new FabricUnavailable("error", "network"),
      text: 'fvj1:{"/Unavailable@1":{"errorKind":"network","reason":"error"}}',
    },
    {
      what: "an error with a message",
      make: () => new FabricUnavailable("error", "network", "offline"),
      text:
        'fvj1:{"/Unavailable@1":{"errorKind":"network","errorMessage":"offline","reason":"error"}}',
    },
  ],
  FabricError: [
    {
      what: "an error with neither `stack` nor `cause`",
      make: () => errorOf({ type: "TypeError", message: "boom" }),
      text:
        'fvj1:{"/Error@1":{"message":"boom","name":null,"type":"TypeError"}}',
    },
  ],
  FabricLink: [
    {
      // The payload is the state, with no policy on its fields.
      what: "a link",
      make: () =>
        new FabricLink({
          space: "did:key:z6Mk",
          path: ["donuts", "0"],
          id: "of:cruller",
        }),
      text:
        'fvj1:{"/Link@1":{"id":"of:cruller","path":["donuts","0"],"space":"did:key:z6Mk"}}',
    },
  ],
  FabricMap: {
    stubbed: () => new FabricMap(new Map([["a", 1]])),
  },
  FabricSet: {
    stubbed: () => new FabricSet(new Set([1])),
  },
  ProblematicValue: [
    {
      what: "a preserved failure",
      make: () => new ProblematicValue("Bytes@1", 7, "not a string"),
      text:
        'fvj1:{"/Problematic@1":{"error":"not a string","state":7,"tag":"Bytes@1"}}',
    },
    {
      // Every value is a valid state, `undefined` among them.
      what: "a preserved failure whose state is `undefined`",
      make: () => new ProblematicValue("Bytes@1", undefined, "absent"),
      text:
        'fvj1:{"/Problematic@1":{"error":"absent","state":{"/Undefined@1":null},"tag":"Bytes@1"}}',
    },
  ],
  UnknownValue: [
    {
      // Re-emitted under its preserved tag, with its preserved state
      // (Section 8).
      what: "an unknown value",
      make: () => new UnknownValue("Future@2", { b: [1], a: "x" }),
      text: 'fvj1:{"/Future@2":{"a":"x","b":[1]}}',
    },
  ],
};

describe("fvj1-exact-text", () => {
  describe("tags the format decides", () => {
    for (const [tag, cases] of Object.entries(FORMAT_TAG_CASES)) {
      describe(tag, () => {
        describeTextCases(cases);
      });
    }
  });

  describe("classes", () => {
    for (const [name, cases] of Object.entries(CLASS_CASES)) {
      describe(name, () => {
        if ("stubbed" in cases) {
          it("refuses to encode a value, its codec being a stub", () => {
            expect(() => jsonFromFabricValue(cases.stubbed())).toThrow(
              "not yet implemented",
            );
          });
        } else {
          describeTextCases(cases);
        }
      });
    }
  });

  describe("`Error@1` state", () => {
    // The state is `{ type, name, message, stack?, cause?, ... }`, the trailing
    // properties being the error's own (`3-json-encoding.md` Section 3). `name`
    // is `null` where it matches `type`, and written out otherwise
    // (`1-fabric-values.md` Section 1.4.2).

    describeTextCases([
      {
        what: "an error whose name differs from its type",
        make: () => errorOf({ type: "Error", name: "Glaze", message: "m" }),
        text: 'fvj1:{"/Error@1":{"message":"m","name":"Glaze","type":"Error"}}',
      },
      {
        what: "an error with a `stack`",
        make: () =>
          new FabricError({
            type: "Error",
            message: "m",
            stack: "at fry",
            cause: undefined,
          }),
        text:
          'fvj1:{"/Error@1":{"message":"m","name":null,"stack":"at fry","type":"Error"}}',
      },
      {
        what: "an error with a `cause`",
        make: () =>
          new FabricError({
            type: "Error",
            message: "m",
            stack: undefined,
            cause: errorOf({ type: "RangeError", message: "why" }),
          }),
        text:
          'fvj1:{"/Error@1":{"cause":{"/Error@1":{"message":"why","name":null,"type":"RangeError"}},"message":"m","name":null,"type":"Error"}}',
      },
      {
        // The extras sit in the state beside `message`, in key order among the
        // fixed fields, and are encoded like any other value.
        what: "an error with extras",
        make: () =>
          errorOf({
            type: "Error",
            message: "m",
            extras: { zeta: true, code: 42n, aa: "x" },
          }),
        text:
          'fvj1:{"/Error@1":{"aa":"x","code":{"/BigInt@1":"Kg"},"message":"m","name":null,"type":"Error","zeta":true}}',
      },
    ]);

    it("decodes a `null` `name` to the type", () => {
      const decoded = fabricFromJsonValue(
        'fvj1:{"/Error@1":{"message":"m","name":null,"type":"TypeError"}}',
      );
      expect((decoded as FabricError).name).toBe("TypeError");
    });

    it("decodes a written-out `name` to itself", () => {
      const decoded = fabricFromJsonValue(
        'fvj1:{"/Error@1":{"message":"m","name":"Glaze","type":"TypeError"}}',
      );
      expect((decoded as FabricError).name).toBe("Glaze");
    });

    it("decodes an absent `stack` and `cause` to `undefined`", () => {
      const decoded = fabricFromJsonValue(
        'fvj1:{"/Error@1":{"message":"m","name":null,"type":"Error"}}',
      ) as FabricError;
      expect(decoded.stack).toBe(undefined);
      expect(decoded.cause).toBe(undefined);
      expect([...decoded.extraKeys()]).toEqual([]);
    });
  });

  describe("JSON numbers", () => {
    // `Number::toString` writes a number's digits plainly while its decimal
    // exponent `n` satisfies -6 < n <= 21, and in exponential form otherwise,
    // the exponent always signed. Each threshold has a case either side.

    describeTextCases([
      // The example in Section 1.1 of `3-json-encoding.md`.
      { what: "`42`", make: () => 42, text: "fvj1:42" },
      { what: "`0`", make: () => 0, text: "fvj1:0" },
      { what: "`-1.5`", make: () => -1.5, text: "fvj1:-1.5" },
      {
        what: "`1e20`",
        make: () => 1e20,
        text: "fvj1:100000000000000000000",
      },
      { what: "`1e21`", make: () => 1e21, text: "fvj1:1e+21" },
      { what: "`1e-6`", make: () => 1e-6, text: "fvj1:0.000001" },
      { what: "`1e-7`", make: () => 1e-7, text: "fvj1:1e-7" },
      {
        what: "the smallest subnormal",
        make: () => 5e-324,
        text: "fvj1:5e-324",
      },
      {
        what: "the largest double",
        make: () => Number.MAX_VALUE,
        text: "fvj1:1.7976931348623157e+308",
      },
      {
        // 2^53 + 2, past the safe integers, with its digits written plainly.
        what: "`9007199254740994`",
        make: () => 9007199254740994,
        text: "fvj1:9007199254740994",
      },
    ]);
  });

  describe("JSON strings", () => {
    // `QuoteJSONString` writes `"`, `\`, and the control characters U+0008,
    // U+0009, U+000A, U+000C and U+000D as two-character escapes. It writes
    // every other code unit below U+0020, and every lone surrogate, as `\u`
    // and four lowercase hex digits, and everything else as itself.

    describeTextCases([
      {
        what: "the two characters JSON requires escaped",
        make: () => '"\\',
        text: 'fvj1:"\\"\\\\"',
      },
      {
        what: "the control characters with a short escape",
        make: () => "\b\t\n\f\r",
        text: 'fvj1:"\\b\\t\\n\\f\\r"',
      },
      {
        what: "U+0000",
        make: () => "\u0000",
        text: 'fvj1:"\\u0000"',
      },
      {
        what: "U+001F",
        make: () => "\u001f",
        text: 'fvj1:"\\u001f"',
      },
      {
        what: "a solidus",
        make: () => "/",
        text: 'fvj1:"/"',
      },
      {
        what: "U+007F",
        make: () => "\u007f",
        text: 'fvj1:"\u007f"',
      },
      {
        what: "U+2028 and U+2029",
        make: () => "\u2028\u2029",
        text: 'fvj1:"\u2028\u2029"',
      },
      {
        what: "a surrogate pair",
        make: () => "🍩",
        text: 'fvj1:"🍩"',
      },
    ]);

    describe("lone surrogates", () => {
      describeTextCases([
        {
          what: "a lone high surrogate",
          make: () => "\ud800",
          text: 'fvj1:"\\ud800"',
        },
        {
          what: "a lone low surrogate between other characters",
          make: () => "a\udfffb",
          text: 'fvj1:"a\\udfffb"',
        },
        {
          what: "a reversed surrogate pair",
          make: () => "\udf69\ud83c",
          text: 'fvj1:"\\udf69\\ud83c"',
        },
        {
          what: "a record keyed by a lone surrogate",
          make: () => ({ "\ud800": 1 }),
          text: 'fvj1:{"\\ud800":1}',
        },
      ]);
    });
  });

  describe("a record holding `undefined` and a record lacking the key", () => {
    // The two are distinct values (`1-fabric-values.md` Section 6.4), so they
    // have distinct texts.

    it("encodes a record holding `undefined` with the key present", () => {
      expect(jsonFromFabricValue({ u: undefined })).toBe(
        'fvj1:{"u":{"/Undefined@1":null}}',
      );
    });

    it("encodes a record lacking the key as an empty record", () => {
      expect(jsonFromFabricValue({})).toBe("fvj1:{}");
    });

    it("decodes the key present to a record holding `undefined`", () => {
      const decoded = fabricFromJsonValue('fvj1:{"u":{"/Undefined@1":null}}');
      expect(Object.keys(decoded as object)).toEqual(["u"]);
      expect((decoded as Record<string, FabricValue>).u).toBe(undefined);
    });

    it("decodes an empty record to a record with no keys", () => {
      const decoded = fabricFromJsonValue("fvj1:{}");
      expect(Object.keys(decoded as object)).toEqual([]);
    });
  });
});
