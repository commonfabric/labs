/**
 * The package's ready-made encode and decode entry points, exercised on the
 * class set they come configured with.
 *
 * Much of this is that a value survives the trip, but the cases earning their
 * space are the ones where the format's own syntax collides with ordinary
 * data. An object keyed `/` has to escape and come back identical, and the
 * markers other layers write into values -- a stream, an error, an alias --
 * have to pass through untouched rather than being interpreted here.
 *
 * The plain-object entry point additionally refuses anything that decoded to
 * something else, so a caller that asked for a record is not handed an array
 * or an instance instead.
 *
 * The depth this package's README guarantees is held here too, through every
 * path a value takes: encoding, decoding, hashing and comparing.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { hashStringOf, isValidFabricValue, valueEqual } from "@";
import type { FabricValue } from "@";
import { BaseLiveEnvironment } from "@/codec-common";
import { JsonCodecEngine } from "@/codec-json";
import {
  createDefaultJsonRegistry,
  fabricFromJsonValue,
  jsonFromFabricValue,
  plainObjectFromJson,
  realmFromFabricValue,
} from "@/codecs.ts";
import { FabricError } from "@/fabric-instances";
import { FabricKeyPair } from "@/fabric-primitives";
import { SIZE_GUARANTEES_FOR_TESTING_ONLY } from "@/for-testing-only.ts";

/** Mock runtime for decode calls. */
class MockRuntime extends BaseLiveEnvironment {
  override getCell(): never {
    throw new Error("getCell not implemented in test runtime");
  }
}

const mockRuntime = new MockRuntime();

/** Encodes and then decodes a value, per the current dispatch configuration. */
function roundTrip(value: FabricValue): FabricValue {
  return fabricFromJsonValue(jsonFromFabricValue(value), mockRuntime);
}

/**
 * Asserts that encoding a value produces the expected JSON encoded form,
 * compared as parsed structure, after stripping the modern encoding prefix.
 */
function expectEncodedFormat(value: FabricValue, expected: unknown): void {
  const json = jsonFromFabricValue(value);
  expect(JsonCodecEngine.seemsLikeEncoded(json)).toBe(true);
  expect(
    JSON.parse(JsonCodecEngine.unwrapEncodedValueForTesting(json)),
  ).toEqual(expected);
}

/**
 * Returns `count` arrays, each but the innermost holding the next as its one
 * element, and the innermost holding `innermost`.
 */
function nestedArraysOf(
  count: number,
  innermost: readonly FabricValue[],
): FabricValue {
  let value: FabricValue = innermost;
  for (let made = 1; made < count; made++) {
    value = [value];
  }
  return value;
}

/**
 * Returns `count` errors, each but the innermost the cause of the next one out,
 * and the innermost having `message` and no cause.
 */
function nestedErrorsOf(count: number, message: string): FabricValue {
  let value = new FabricError({
    type: "Error",
    name: "Error",
    message,
    stack: undefined,
    cause: undefined,
  });
  for (let made = 1; made < count; made++) {
    value = new FabricError({
      type: "Error",
      name: "Error",
      message: "m",
      stack: undefined,
      cause: value,
    });
  }
  return value;
}

/**
 * Asserts that `value` encodes to a text that decodes to a value equal to it,
 * which hashes as it does and encodes to the same text, and that `other`, which
 * differs from it only at its innermost level, neither compares nor hashes
 * equal to it.
 */
function expectEveryPathHolds(value: FabricValue, other: FabricValue): void {
  const text = jsonFromFabricValue(value);
  const decoded = fabricFromJsonValue(text, mockRuntime);

  expect(valueEqual(decoded, value)).toBe(true);
  expect(hashStringOf(decoded)).toBe(hashStringOf(value));
  expect(jsonFromFabricValue(decoded)).toBe(text);
  expect(valueEqual(other, value)).toBe(false);
  expect(hashStringOf(other)).not.toBe(hashStringOf(value));
}

describe("codecs", () => {
  describe("createDefaultJsonRegistry()", () => {
    it("returns a frozen registry", () => {
      expect(Object.isFrozen(createDefaultJsonRegistry())).toBe(true);
    });

    it("registers this package's fabric classes on top of the base", () => {
      const registry = createDefaultJsonRegistry();
      const value = FabricError.fromNativeError(new Error("boom"));

      // The base alone reports `undefined` here; see
      // `createBaseJsonRegistry.test.ts`.
      expect(registry.codecFromValue(value)).toBeDefined();
    });
  });

  it("round-trips `undefined`", () => {
    expect(roundTrip(undefined)).toBe(undefined);
  });

  it("round-trips `bigint`", () => {
    expect(roundTrip(42n)).toBe(42n);
  });

  describe("jsonFromFabricValue()", () => {
    it("encodes `undefined` to tagged JSON", () => {
      expectEncodedFormat(undefined, { "/Undefined@1": null });
    });

    it("encodes `bigint` to tagged JSON", () => {
      expectEncodedFormat(42n, { "/BigInt@1": "Kg" });
    });
  });

  describe("fabricFromJsonValue()", () => {
    it("decodes tagged `undefined`", () => {
      const json = 'fvj1:{"\/Undefined@1":null}';
      expect(fabricFromJsonValue(json, mockRuntime)).toBe(undefined);
    });

    it("decodes tagged `bigint`", () => {
      const json = 'fvj1:{"\/BigInt@1":"Kg"}';
      expect(fabricFromJsonValue(json, mockRuntime)).toBe(42n);
    });
  });

  it("round-trips plain objects", () => {
    const value = { a: 1, b: "two" };
    expect(roundTrip(value)).toEqual({ a: 1, b: "two" });
  });

  it("round-trips arrays", () => {
    const value = [1, "two", null];
    expect(roundTrip(value)).toEqual([1, "two", null]);
  });

  it("round-trips `null`", () => {
    expect(roundTrip(null)).toBe(null);
  });

  it("stringifies JSON-safe primitives normally (under the encoding prefix)", () => {
    expect(jsonFromFabricValue(42)).toBe("fvj1:42");
    expect(jsonFromFabricValue("hello")).toBe('fvj1:"hello"');
    expect(jsonFromFabricValue(true)).toBe("fvj1:true");
    expect(jsonFromFabricValue(null)).toBe("fvj1:null");
  });

  describe("a state the format cannot write down", () => {
    // `2.11 Input Contracts` names three reasons `encode()` throws for a
    // value that is otherwise valid. This is the third: the class is claimed
    // by a codec in the registry, and that codec refuses this instance's
    // state. Asserted through the engine rather than the codec, because the
    // contract the spec states is the engine's.

    it(
      "throws through the engine, where the format has no form for it",
      async () => {
        const pair = new FabricKeyPair(
          await crypto.subtle.generateKey("Ed25519", false, [
            "sign",
            "verify",
          ]) as CryptoKeyPair,
        );

        // Valid, and claimed: neither of the other two reasons applies.
        expect(isValidFabricValue(pair)).toBe(true);
        expect(createDefaultJsonRegistry().codecFromValue(pair)).toBeDefined();

        expect(() => jsonFromFabricValue(pair)).toThrow(
          /no JSON representation/,
        );
      },
    );

    it("encodes for a format that does have a form for it", async () => {
      const pair = new FabricKeyPair(
        await crypto.subtle.generateKey("Ed25519", false, [
          "sign",
          "verify",
        ]) as CryptoKeyPair,
      );

      // The refusal is the JSON format's, not the value's: the same instance
      // crosses a realm boundary as itself.
      expect(() => realmFromFabricValue(pair)).not.toThrow();
    });
  });

  describe("edge case", () => {
    it("round-trips object with slash-prefixed key", () => {
      const value = { "/foo": "bar" };
      expect(roundTrip(value)).toEqual({ "/foo": "bar" });
    });

    it("freezes decoded objects", () => {
      const value = { a: 1, b: "two" };
      expect(Object.isFrozen(roundTrip(value))).toBe(true);
    });

    it("freezes decoded arrays", () => {
      const value = [1, 2, 3];
      expect(Object.isFrozen(roundTrip(value))).toBe(true);
    });

    it("round-trips nested object with special types", () => {
      const value = {
        name: "test",
        count: 42n,
        missing: undefined,
      };
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.name).toBe("test");
      expect(decoded.count).toBe(42n);
      expect(decoded.missing).toBe(undefined);
    });
  });

  describe("slash-prefixed keys and legacy markers", () => {
    it('`{ "/": value }` round-trips via `/object` escaping', () => {
      // Arbitrary object-valued `/` key (not a link). Write path wraps in
      // /object, read path unwraps it.
      const slashObject = {
        "/": { kind: "widget", tags: ["a", "b"], size: 3 },
      };
      expect(roundTrip(slashObject)).toEqual(slashObject);
    });

    it('nested `{ "/": value }` within object round-trips', () => {
      const value = {
        name: "test",
        slashKeyed: { "/": { inner: { flag: true }, count: 0 } },
      };
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.name).toBe("test");
      expect(decoded.slashKeyed).toEqual(
        { "/": { inner: { flag: true }, count: 0 } },
      );
    });

    it('`{ "/": "string" }` round-trips via `/object` escaping', () => {
      // An arbitrary string-valued `/` key — not an entity ref; exercises the
      // escaping for the `/` key per se.
      const slashKeyed = { "/": "an arbitrary string" };
      expect(roundTrip(slashKeyed)).toEqual(slashKeyed);
    });

    it("passes the `$stream` marker through unchanged", () => {
      const value = { $stream: true };
      expect(roundTrip(value)).toEqual({ $stream: true });
    });

    it("passes the `@Error` marker through unchanged", () => {
      const value = {
        "@Error": { name: "TypeError", message: "oops", stack: "" },
      };
      expect(roundTrip(value)).toEqual({
        "@Error": { name: "TypeError", message: "oops", stack: "" },
      });
    });

    it('`$alias` marker with nested `{ "/": value }` round-trips', () => {
      const value = {
        $alias: {
          path: ["value", "name"],
          cell: { "/": "an arbitrary string" },
        },
      };
      expect(roundTrip(value)).toEqual({
        $alias: {
          path: ["value", "name"],
          cell: { "/": "an arbitrary string" },
        },
      });
    });

    it("round-trips a mixed value with fabric types and slash-keys", () => {
      const value = {
        count: 42n,
        slashKeyed: { "/": { values: [1, 2, 3], note: "hello" } },
        items: [1, { "/": "another arbitrary string" }, undefined],
      };
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.count).toBe(42n);
      expect(decoded.slashKeyed).toEqual(
        { "/": { values: [1, 2, 3], note: "hello" } },
      );
      expect((decoded.items as unknown[])[0]).toBe(1);
      expect((decoded.items as unknown[])[1]).toEqual({
        "/": "another arbitrary string",
      });
      expect((decoded.items as unknown[])[2]).toBe(undefined);
    });

    it('`{ "/": value }` inside array round-trips', () => {
      const value = [
        { "/": { count: 1 } },
        { "/": { labels: ["x"], ready: true } },
      ];
      expect(roundTrip(value)).toEqual(value);
    });
  });

  describe("`fabricFromJsonValue()` without a runtime argument", () => {
    it("decodes a plain object", () => {
      expect(fabricFromJsonValue('fvj1:{"a":1}')).toEqual({ a: 1 });
    });

    it("decodes a primitive", () => {
      expect(fabricFromJsonValue("fvj1:42")).toBe(42);
    });

    it("decodes tagged values that don't need cell decoding", () => {
      expect(fabricFromJsonValue('fvj1:{"\/Undefined@1":null}')).toBe(
        undefined,
      );
      expect(fabricFromJsonValue('fvj1:{"\/BigInt@1":"Kg"}')).toBe(42n);
    });

    it("treats an explicit `undefined` runtime as equivalent to omission", () => {
      expect(fabricFromJsonValue('fvj1:{"a":1}', undefined)).toEqual({ a: 1 });
    });
  });

  describe("plainObjectFromJson", () => {
    it("returns the decoded plain object", () => {
      const json = jsonFromFabricValue({ a: 1, b: 42n });
      const result = plainObjectFromJson<{ a: number; b: bigint }>(json);
      expect(result.a).toBe(1);
      expect(result.b).toBe(42n);
    });

    it("throws on a class instance (`FabricError`)", () => {
      const err = FabricError.fromNativeError(new Error("test"));
      const json = jsonFromFabricValue(err);
      expect(() => plainObjectFromJson(json)).toThrow(/instance/);
    });

    it("throws on an array", () => {
      const json = jsonFromFabricValue(["whoops"]);
      expect(() => plainObjectFromJson(json)).toThrow(/array/);
    });

    for (const prim of [null, 123, "florp", true]) {
      it(`throws on primitive \`${prim}\``, () => {
        const json = jsonFromFabricValue(prim);
        expect(() => plainObjectFromJson(json)).toThrow(/primitive/);
      });
    }
  });

  describe("values as deep as this package guarantees", () => {
    // The README states the guarantee of depth, which every path a value
    // takes here holds to: encoding, decoding, hashing and comparing. An
    // error and its state count as two levels.

    const depth = SIZE_GUARANTEES_FOR_TESTING_ONLY.depth;

    it("encodes, decodes, hashes and compares nested arrays that deep", () => {
      expectEveryPathHolds(
        nestedArraysOf(depth, []),
        nestedArraysOf(depth, [0]),
      );
    });

    it("encodes, decodes, hashes and compares a chain of error causes that deep", () => {
      expectEveryPathHolds(
        nestedErrorsOf(depth / 2, "m"),
        nestedErrorsOf(depth / 2, "n"),
      );
    });
  });
});
