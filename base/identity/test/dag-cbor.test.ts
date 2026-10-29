// Flat `Deno.test` cases: this package's tests also run in a browser through
// `deno-web-test`, which does not support `@std/testing/bdd`.

import { expect } from "@std/expect";

import {
  DagCborError,
  decodeDagCbor,
  encodeDagCbor,
  isDagCborMap,
} from "../src/dag-cbor.ts";

const bytes = (...values: number[]) => new Uint8Array(values);

Deno.test("encodeDagCbor() encodes an integer in its shortest form at each width", () => {
  expect(encodeDagCbor(0)).toEqual(bytes(0x00));
  expect(encodeDagCbor(23)).toEqual(bytes(0x17));
  expect(encodeDagCbor(24)).toEqual(bytes(0x18, 0x18));
  expect(encodeDagCbor(255)).toEqual(bytes(0x18, 0xff));
  expect(encodeDagCbor(256)).toEqual(bytes(0x19, 0x01, 0x00));
  expect(encodeDagCbor(65536)).toEqual(bytes(0x1a, 0, 1, 0, 0));
  expect(encodeDagCbor(0x1_0000_0000)).toEqual(
    bytes(0x1b, 0, 0, 0, 1, 0, 0, 0, 0),
  );
});

Deno.test("encodeDagCbor() encodes `null`, text, bytes, and an empty array", () => {
  expect(encodeDagCbor(null)).toEqual(bytes(0xf6));
  expect(encodeDagCbor("ab")).toEqual(bytes(0x62, 0x61, 0x62));
  expect(encodeDagCbor(bytes(1, 2))).toEqual(bytes(0x42, 1, 2));
  expect(encodeDagCbor([])).toEqual(bytes(0x80));
});

Deno.test("encodeDagCbor() orders map keys by length and then bytewise", () => {
  const encoded = encodeDagCbor({ nonce: 1, b: 2, a: 3 });
  expect(encoded).toEqual(
    bytes(
      0xa3,
      0x61,
      0x61,
      0x03,
      0x61,
      0x62,
      0x02,
      0x65,
      0x6e,
      0x6f,
      0x6e,
      0x63,
      0x65,
      0x01,
    ),
  );
});

Deno.test("encodeDagCbor() throws for a negative or fractional number", () => {
  expect(() => encodeDagCbor(-1)).toThrow(DagCborError);
  expect(() => encodeDagCbor(1.5)).toThrow(DagCborError);
});

Deno.test("encodeDagCbor() throws for a value nested too deep", () => {
  let value: unknown[] = [];
  for (let i = 0; i < 10; i++) value = [value];
  expect(() => encodeDagCbor(value as never)).toThrow(DagCborError);
});

Deno.test("decodeDagCbor() returns the value whose encoding it is given", () => {
  const value = {
    h: bytes(0x34, 0x01),
    tag: { exp: null, n: 300, pol: [], s: "did:key:z" },
  };
  expect(decodeDagCbor(encodeDagCbor(value))).toEqual(value);
});

Deno.test("decodeDagCbor() throws for an integer not in its shortest form", () => {
  expect(() => decodeDagCbor(bytes(0x18, 0x05))).toThrow(DagCborError);
  expect(() => decodeDagCbor(bytes(0x19, 0x00, 0xff))).toThrow(DagCborError);
});

Deno.test("decodeDagCbor() throws for an indefinite-length item", () => {
  expect(() => decodeDagCbor(bytes(0x9f, 0xff))).toThrow(DagCborError);
});

Deno.test("decodeDagCbor() throws for a tag, a float, a negative integer, or another simple value", () => {
  expect(() => decodeDagCbor(bytes(0xd8, 0x2a, 0x00))).toThrow(DagCborError);
  expect(() => decodeDagCbor(bytes(0xf9, 0x3c, 0x00))).toThrow(DagCborError);
  expect(() => decodeDagCbor(bytes(0x20))).toThrow(DagCborError);
  expect(() => decodeDagCbor(bytes(0xf4))).toThrow(DagCborError);
});

Deno.test("decodeDagCbor() throws for map keys out of canonical order or repeated", () => {
  // {"b": 1, "a": 2}: "b" sorts after "a".
  expect(() => decodeDagCbor(bytes(0xa2, 0x61, 0x62, 1, 0x61, 0x61, 2)))
    .toThrow(DagCborError);
  expect(() => decodeDagCbor(bytes(0xa2, 0x61, 0x61, 1, 0x61, 0x61, 2)))
    .toThrow(DagCborError);
});

Deno.test("decodeDagCbor() throws for a map key that is not text", () => {
  expect(() => decodeDagCbor(bytes(0xa1, 0x01, 0x01))).toThrow(DagCborError);
});

Deno.test("decodeDagCbor() throws for text that is not UTF-8", () => {
  expect(() => decodeDagCbor(bytes(0x61, 0xff))).toThrow(DagCborError);
});

Deno.test("decodeDagCbor() throws for truncated input and for trailing bytes", () => {
  expect(() => decodeDagCbor(bytes(0x42, 0x01))).toThrow(DagCborError);
  expect(() => decodeDagCbor(bytes(0x00, 0x00))).toThrow(DagCborError);
});

Deno.test("encodeDagCbor() encodes a plain object with Object.prototype or null as its prototype, and throws for any other object", () => {
  const plain = encodeDagCbor({ a: 1 });
  const bare = Object.create(null) as { [key: string]: number };
  bare.a = 1;
  expect(encodeDagCbor(bare)).toEqual(plain);
  class Donut {
    a = 1;
  }
  expect(() => encodeDagCbor(new Donut() as never)).toThrow(DagCborError);
  expect(() => encodeDagCbor(new Date(0) as never)).toThrow(DagCborError);
  expect(() => encodeDagCbor(new Map() as never)).toThrow(DagCborError);
});

Deno.test("decodeDagCbor() returns `__proto__` as an own key rather than setting the prototype", () => {
  // {"__proto__": {"x": 1}}
  const decoded = decodeDagCbor(
    encodeDagCbor({ ["__proto__"]: { x: 1 } }),
  );
  expect(isDagCborMap(decoded)).toBe(true);
  expect(Object.keys(decoded as object)).toEqual(["__proto__"]);
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  expect((decoded as { x?: unknown }).x).toBeUndefined();
});

Deno.test("decodeDagCbor() keeps a leading U+FEFF in text", () => {
  expect(decodeDagCbor(encodeDagCbor("\ufeffa"))).toBe("\ufeffa");
});

Deno.test("isDagCborMap() returns `true` for a map and `false` for every other kind of value", () => {
  expect(isDagCborMap({})).toBe(true);
  expect(isDagCborMap(null)).toBe(false);
  expect(isDagCborMap([])).toBe(false);
  expect(isDagCborMap(bytes())).toBe(false);
  expect(isDagCborMap("")).toBe(false);
  expect(isDagCborMap(0)).toBe(false);
});
