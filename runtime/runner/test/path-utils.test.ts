import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  arrayEqual,
  getValueAtPath,
  hasValueAtPath,
  setValueAtPath,
} from "../src/path-utils.ts";

describe("Path operations", () => {
  describe("setValueAtPath", () => {
    it("should set a value at the specified path", () => {
      const obj = {};
      setValueAtPath(obj, ["a", "b", "c"], 42);
      expect(obj).toEqual({ a: { b: { c: 42 } } });
    });

    it("should create arrays when encountering numeric keys", () => {
      const obj = {};
      setValueAtPath(obj, ["a", 0, "b"], "test");
      expect(obj).toEqual({ a: [{ b: "test" }] });
    });

    it("replaces a `null` spine slot with a container", () => {
      // `typeof null` is `"object"`, so a walk that decides the spine by
      // `typeof` alone descends `null` and then writes onto it.

      const obj = { x: null };
      setValueAtPath(obj, ["x", "y"], 2);
      expect(obj).toEqual({ x: { y: 2 } });
    });

    it("should overwrite existing values", () => {
      const obj = { x: { y: 1 } };
      setValueAtPath(obj, ["x", "y"], 2);
      expect(obj).toEqual({ x: { y: 2 } });
    });

    it("should skip writes when the value is unchanged", () => {
      const obj = { x: { y: 1 } };
      const changed = setValueAtPath(obj, ["x", "y"], 1);
      expect(changed).toBe(false);
      expect(obj).toEqual({ x: { y: 1 } });
    });

    it("is Fabric-aware: an equal FabricBytes is a no-op", () => {
      // Two distinct same-content `FabricBytes`: no real change, so the no-op
      // gate must elide the write and return `false`.
      const obj = { x: new FabricBytes(new Uint8Array([1, 2, 3])) };
      const changed = setValueAtPath(
        obj,
        ["x"],
        new FabricBytes(new Uint8Array([1, 2, 3])),
      );
      expect(changed).toBe(false);
    });

    it("is Fabric-aware: a differing `FabricBytes` is a real change", () => {
      // Two distinct `FabricBytes` differing only in their (private `#fields`)
      // byte content: a real change, not a no-op, so the write must happen and
      // `true` be returned.
      const original = new FabricBytes(new Uint8Array([1, 2, 3]));
      const replacement = new FabricBytes(new Uint8Array([4, 5, 6]));
      const obj = { x: original };
      const changed = setValueAtPath(obj, ["x"], replacement);
      expect(changed).toBe(true);
      expect(obj.x).toBe(replacement);
    });
  });

  describe("getValueAtPath", () => {
    const obj = { a: { b: { c: 42 } }, x: [{ y: "test" }] };

    it("should retrieve a value at the specified path", () => {
      expect(getValueAtPath(obj, ["a", "b", "c"])).toBe(42);
    });

    it("should work with array indices", () => {
      expect(getValueAtPath(obj, ["x", 0, "y"])).toBe("test");
    });

    it("should return undefined for non-existent paths", () => {
      expect(getValueAtPath(obj, ["a", "b", "d"])).toBeUndefined();
    });
  });

  describe("hasValueAtPath", () => {
    const obj = { a: { b: { c: 42 } }, x: [{ y: "test" }] };

    it("should return true for existing paths", () => {
      expect(hasValueAtPath(obj, ["a", "b", "c"])).toBe(true);
    });

    it("should work with array indices", () => {
      expect(hasValueAtPath(obj, ["x", 0, "y"])).toBe(true);
    });

    it("should return false for non-existent paths", () => {
      expect(hasValueAtPath(obj, ["a", "b", "d"])).toBe(false);
    });

    it("should return false for partially existing paths", () => {
      expect(hasValueAtPath(obj, ["a", "b", "c", "d"])).toBe(false);
    });
  });

  describe("hasValueAtPath for undefined values", () => {
    const store = {
      defaultValue: undefined,
    };

    it("should return true for a present key whose value is undefined", () => {
      expect(hasValueAtPath(store, ["defaultValue"])).toBe(true);
    });

    it("should return false for an absent key", () => {
      expect(hasValueAtPath(store, ["missing"])).toBe(false);
    });
  });

  describe("setValueAtPath with undefined", () => {
    it("should store undefined as a value, keeping the key present", () => {
      const obj: Record<string, unknown> = { a: 1, b: 2 };
      setValueAtPath(obj, ["a"], undefined);
      expect("a" in obj).toBe(true);
      expect(obj.a).toBeUndefined();
      expect(Object.keys(obj)).toEqual(["a", "b"]);
    });

    it("should not truncate arrays when setting undefined", () => {
      const obj: { list: unknown[] } = { list: [1, 2, 3] };
      setValueAtPath(obj, ["list", 2], undefined);
      expect(obj.list.length).toBe(3);
      expect(2 in obj.list).toBe(true);
      expect(obj.list[2]).toBeUndefined();
    });
  });

  describe("arrayEqual", () => {
    it("should compare missing arrays by reference equality", () => {
      expect(arrayEqual(undefined, undefined)).toBe(true);
      expect(arrayEqual(undefined, [])).toBe(false);
    });

    it("should return false for arrays with different lengths", () => {
      expect(arrayEqual(["a"], ["a", "b"])).toBe(false);
    });
  });
});
