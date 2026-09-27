import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type FabricValue, valueEqual, valueEqualByWalk } from "@";
import { codecOf, NULL_LIVE_ENVIRONMENT, UnknownValue } from "@/codec-common";
import { FabricError } from "@/fabric-instances";
import { FabricBytes } from "@/fabric-primitives";

/** Wraps `target` so that every property read of it is counted. */
function counted<T extends object>(
  target: T,
): { value: T; reads: () => number } {
  let reads = 0;
  const value = new Proxy(target, {
    get(inner, key, receiver) {
      reads++;
      return Reflect.get(inner, key, receiver);
    },
    ownKeys(inner) {
      reads++;
      return Reflect.ownKeys(inner);
    },
  });
  return { value, reads: () => reads };
}

/** Builds a chain of records `depth` deep, ending at `leaf`. */
function chain(depth: number, leaf: FabricValue): FabricValue {
  let value = leaf;
  for (let level = 0; level < depth; level++) value = { next: value };
  return value;
}

describe("valueEqualByWalk()", () => {
  describe("shared subtrees", () => {
    it("returns `true` for a subtree both operands share without reading it", () => {
      const shared = counted({ name: "same" });

      expect(valueEqualByWalk(
        { entry: shared.value, other: 1 },
        { entry: shared.value, other: 1 },
      )).toBe(true);
      expect(shared.reads()).toBe(0);
    });

    it("reads none of a revision's unedited entries", () => {
      const entries = Array.from(
        { length: 50 },
        (_, index) => counted({ name: `entry-${index}` }),
      );
      const base: Record<string, FabricValue> = {};
      entries.forEach((entry, index) => base[`key-${index}`] = entry.value);
      const revision = { ...base, "key-0": { name: "edited" } };

      expect(valueEqualByWalk(base, revision)).toBe(false);
      expect(entries.slice(1).map((entry) => entry.reads())).toEqual(
        entries.slice(1).map(() => 0),
      );
    });

    it("does not throw on an unhashable value inside a subtree both operands share", () => {
      const shared = { run: () => 1 } as unknown as FabricValue;

      expect(() => valueEqual({ shared, v: 1 }, { shared, v: 2 })).toThrow();
      expect(valueEqualByWalk({ shared, v: 1 }, { shared, v: 2 })).toBe(false);
    });
  });

  describe("agreement with `valueEqual()`", () => {
    it("distinguishes an array hole from a stored `undefined`", () => {
      // deno-lint-ignore no-sparse-arrays
      const holed = [1, , 3];

      expect(valueEqualByWalk(holed, [1, undefined, 3])).toBe(false);
      // deno-lint-ignore no-sparse-arrays
      expect(valueEqualByWalk(holed, [1, , 3])).toBe(true);
    });

    it("distinguishes an absent key from a key holding `undefined`", () => {
      expect(valueEqualByWalk({ a: 1 }, { a: 1, b: undefined })).toBe(false);
      expect(valueEqualByWalk({ b: undefined, a: 1 }, { a: 1, b: undefined }))
        .toBe(true);
    });

    it("holds `-0` distinct from `+0` and `NaN` equal to itself inside a container", () => {
      expect(valueEqualByWalk({ n: -0 }, { n: 0 })).toBe(false);
      expect(valueEqualByWalk([NaN], [NaN])).toBe(true);
    });

    it("compares special objects by content, across classes sharing a codec tag", () => {
      const error = new FabricError({
        type: "Error",
        message: "boom",
        stack: undefined,
        cause: undefined,
      });
      const codec = codecOf(error);
      const preserved = new UnknownValue(
        codec.tagForValue(error),
        codec.encode(error, NULL_LIVE_ENVIRONMENT),
      );

      expect(valueEqualByWalk({ e: error }, { e: preserved })).toBe(true);
      expect(valueEqualByWalk(
        { b: new FabricBytes(new Uint8Array([1])) },
        { b: new FabricBytes(new Uint8Array([2])) },
      )).toBe(false);
    });

    it("returns `false` for a record against an array", () => {
      expect(valueEqualByWalk({ v: {} }, { v: [] })).toBe(false);
    });

    it("throws on a null-prototype object it reaches, as `valueEqual()` does", () => {
      const bare = Object.assign(Object.create(null), { a: 1 });

      expect(() => valueEqual({ v: bare }, { v: { a: 1 } })).toThrow();
      expect(() => valueEqualByWalk({ v: bare }, { v: { a: 1 } })).toThrow();
    });

    it("compares cyclic graphs as `valueEqual()` does", () => {
      const left: Record<string, FabricValue> = { label: "same" };
      const right: Record<string, FabricValue> = { label: "same" };
      left.self = left;
      right.self = right;
      const once: Record<string, FabricValue> = {};
      once.x = once;
      const twice: Record<string, FabricValue> = {};
      twice.x = { x: twice };

      expect(valueEqualByWalk(left, right)).toBe(true);
      expect(valueEqualByWalk(once, twice)).toBe(valueEqual(once, twice));
      right.label = "different";
      expect(valueEqualByWalk(left, right)).toBe(false);
    });

    it("compares values nested past the walk's depth as `valueEqual()` does", () => {
      expect(valueEqualByWalk(chain(400, "leaf"), chain(400, "leaf")))
        .toBe(true);
      expect(valueEqualByWalk(chain(400, "leaf"), chain(400, "other")))
        .toBe(false);
    });
  });
});
