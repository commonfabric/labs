/**
 * `stripUndefinedProps()` removes `undefined`-valued properties, and the cases
 * that say what it is are the things it leaves alone: a `null` property, an
 * empty nested object, and an array holding `undefined` elements.
 *
 * That last one is the boundary a caller is most likely to assume wrongly.
 * Dropping an element from an array would renumber the rest, so array contents
 * pass through untouched however much they look like the properties being
 * stripped.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stripUndefinedProps } from "@commonfabric/utils/strip-undefined-props";

describe("stripUndefinedProps()", () => {
  it("returns an empty object given an empty object", () => {
    expect(stripUndefinedProps({})).toEqual({});
  });

  it("returns a shallow copy when no properties are `undefined`", () => {
    const input = { a: 1, b: "two", c: true, d: null };
    const out = stripUndefinedProps(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it("drops `undefined`-valued top-level properties", () => {
    expect(stripUndefinedProps({ a: 1, b: undefined, c: 3 })).toEqual({
      a: 1,
      c: 3,
    });
  });

  it("drops `undefined`-valued properties at nested depths", () => {
    expect(stripUndefinedProps({
      a: 1,
      b: { c: undefined, d: 4, e: { f: undefined, g: 7 } },
    })).toEqual({
      a: 1,
      b: { d: 4, e: { g: 7 } },
    });
  });

  it("preserves `null` properties", () => {
    expect(stripUndefinedProps({ a: null, b: undefined })).toEqual({ a: null });
  });

  it("preserves empty nested objects", () => {
    expect(stripUndefinedProps({ a: {}, b: { c: undefined } })).toEqual({
      a: {},
      b: {},
    });
  });

  it("leaves array values intact, including any `undefined` elements", () => {
    const input = { xs: [1, undefined, 3], ys: undefined };
    const out = stripUndefinedProps(input);
    expect(out).toEqual({ xs: [1, undefined, 3] });
    expect(out.xs).toBe(input.xs);
  });

  it("does not walk into class instances", () => {
    class Tag {
      constructor(public name: string, public maybe: string | undefined) {}
    }
    const tag = new Tag("t", undefined);
    const out = stripUndefinedProps({ tag, dropped: undefined });
    expect(out).toEqual({ tag });
    expect(out.tag).toBe(tag);
  });

  it("does not mutate the input object", () => {
    const input = { a: 1, b: undefined, c: { d: undefined, e: 5 } };
    stripUndefinedProps(input);
    expect(input).toEqual({ a: 1, b: undefined, c: { d: undefined, e: 5 } });
  });

  it("copies a `__proto__` own property as an own data property, not as a prototype", () => {
    // `JSON.parse()` produces an object with an *own* `__proto__` property
    // (it does not invoke the `__proto__` setter), so callers feeding
    // parsed JSON in could reach this code with that shape. A naive
    // assignment-based copy would invoke the setter on the output and
    // pollute its prototype chain.
    const input = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}');
    const out = stripUndefinedProps(input);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")).toEqual({
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(out.x).toBe(1);
  });
});
