/**
 * Immutable counterparts to `Map` and `Set`, and the key equality they carry
 * over.
 *
 * The cases that matter are the ones where key identity is not obvious:
 * signed zeros and the non-finite values, where a collection's notion of "the
 * same key" is not `===` and has to be preserved rather than quietly improved
 * upon.
 *
 * The set additionally carries the algebra -- union, intersection, difference
 * -- which an immutable receiver can only express by producing a new set.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FrozenMap, FrozenSet } from "@/frozen-builtins.ts";

type MutableMapExtensions<K, V> = {
  getOrInsert(key: K, defaultValue: V): V;
  getOrInsertComputed(key: K, callback: (key: K) => V): V;
};

describe("frozen-builtins", () => {
  describe("FrozenMap", () => {
    it("is instanceof `Map`", () => {
      const fm = new FrozenMap([["a", 1]]);
      expect(fm).toBeInstanceOf(Map);
    });

    it("reports as frozen via `Object.isFrozen()`", () => {
      const fm = new FrozenMap([["a", 1]]);
      expect(Object.isFrozen(fm)).toBe(true);
    });

    it("reads back what it was constructed with", () => {
      const fm = new FrozenMap<string, number>([["a", 1], ["b", 2]]);
      expect(fm.size).toBe(2);
      expect(fm.get("a")).toBe(1);
      expect(fm.get("b")).toBe(2);
      expect(fm.has("a")).toBe(true);
      expect(fm.has("b")).toBe(true);
      expect(fm.has("c")).toBe(false);
      expect([...fm.keys()]).toEqual(["a", "b"]);
      expect([...fm.values()]).toEqual([1, 2]);
      expect([...fm.entries()]).toEqual([["a", 1], ["b", 2]]);
    });

    it("throws on `set()`", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(() => fm.set("b", 2)).toThrow("Cannot mutate a `FrozenMap`");
    });

    it("throws on `delete()`", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(() => fm.delete("a")).toThrow("Cannot mutate a `FrozenMap`");
    });

    it("throws on `clear()`", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(() => fm.clear()).toThrow("Cannot mutate a `FrozenMap`");
    });

    it("throws from the intrinsic `Map` mutators", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(() => Map.prototype.set.call(fm, "b", 2)).toThrow();
      expect(fm.has("b")).toBe(false);
    });

    it("throws for a receiver that has no backing store", () => {
      const foreign = Object.create(FrozenMap.prototype) as FrozenMap<
        string,
        number
      >;

      expect(() => foreign.get("a")).toThrow(
        "Incompatible `FrozenMap` receiver",
      );
      expect(() => foreign.has("a")).toThrow(
        "Incompatible `FrozenMap` receiver",
      );
      expect(() => foreign.size).toThrow("Incompatible `FrozenMap` receiver");
      expect(() => foreign.keys()).toThrow("Incompatible `FrozenMap` receiver");
      expect(() => foreign.values()).toThrow(
        "Incompatible `FrozenMap` receiver",
      );
      expect(() => foreign.entries()).toThrow(
        "Incompatible `FrozenMap` receiver",
      );
    });

    it("reports `Map` as its `Symbol.toStringTag`", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(fm[Symbol.toStringTag]).toBe("Map");
      expect(Object.prototype.toString.call(fm)).toBe("[object Map]");
    });

    it("throws on `getOrInsert()`", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]) as
        & FrozenMap<
          string,
          number
        >
        & MutableMapExtensions<string, number>;
      expect(() => fm.getOrInsert("b", 2)).toThrow(
        "Cannot mutate a `FrozenMap`",
      );
      expect(fm.has("b")).toBe(false);
    });

    it("throws on `getOrInsertComputed()` without invoking the callback", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]) as
        & FrozenMap<
          string,
          number
        >
        & MutableMapExtensions<string, number>;
      let invoked = false;
      expect(() =>
        fm.getOrInsertComputed("b", () => {
          invoked = true;
          return 2;
        })
      ).toThrow("Cannot mutate a `FrozenMap`");
      expect(invoked).toBe(false);
      expect(fm.has("b")).toBe(false);
    });

    it("visits every entry in order under `forEach()`", () => {
      const fm = new FrozenMap([["x", 10], ["y", 20]]);
      const entries: [string, number][] = [];
      fm.forEach((v, k) => entries.push([k, v]));
      expect(entries).toEqual([["x", 10], ["y", 20]]);
    });

    it("has a size of `0` when constructed with no argument", () => {
      const fm = new FrozenMap();
      expect(fm.size).toBe(0);
    });

    it("has a size of `0` when constructed with `null`", () => {
      const fm = new FrozenMap(null);
      expect(fm.size).toBe(0);
    });

    it("throws on a builder write after `finish()`", () => {
      const builder = FrozenMap.createBuilder<string, number>();
      builder.set("a", 1);

      const fm = builder.finish();

      expect(() => builder.set("b", 2)).toThrow(
        "Cannot mutate a finalized `FrozenMap` builder",
      );
      expect([...fm.entries()]).toEqual([["a", 1]]);
    });

    describe("non-finite and signed-zero keys", () => {
      // Keys go through `Map.prototype.set`, which carries the same signed-zero
      // normalization as `Set.prototype.add`. This is a separate construction
      // site from `FrozenSet`'s, so the equivalent `FrozenSet` cases below do
      // not reach it -- see the rationale on that block for why the behavior is
      // deliberate rather than a defect.

      it("normalizes a `-0` key to `+0`, as `Map` does", () => {
        const fm = new FrozenMap<number, string>([[-0, "a"]]);

        expect(fm.size).toBe(1);
        expect([...fm.keys()][0]).toBe(0);
      });

      it("treats `-0` and `+0` as the same key", () => {
        const fm = new FrozenMap<number, string>([[-0, "a"], [0, "b"]]);

        expect(fm.size).toBe(1);
        expect(fm.get(0)).toBe("b");
        expect(fm.get(-0)).toBe("b");
      });

      it("treats all `NaN`s as one key", () => {
        const fm = new FrozenMap<number, string>([[NaN, "a"], [NaN, "b"]]);

        expect(fm.size).toBe(1);
        expect(fm.get(NaN)).toBe("b");
      });

      it("keeps the two infinities as distinct keys", () => {
        const fm = new FrozenMap<number, string>([
          [Infinity, "pos"],
          [-Infinity, "neg"],
        ]);

        expect(fm.size).toBe(2);
        expect(fm.get(Infinity)).toBe("pos");
        expect(fm.get(-Infinity)).toBe("neg");
      });
    });
  });

  describe("FrozenSet", () => {
    it("is instanceof `Set`", () => {
      const fs = new FrozenSet([1, 2, 3]);
      expect(fs).toBeInstanceOf(Set);
    });

    it("reports as frozen via `Object.isFrozen()`", () => {
      const fs = new FrozenSet([1, 2, 3]);
      expect(Object.isFrozen(fs)).toBe(true);
    });

    it("reads back what it was constructed with", () => {
      const fs = new FrozenSet<number>([1, 2, 3]);
      expect(fs.size).toBe(3);
      expect(fs.has(1)).toBe(true);
      expect(fs.has(4)).toBe(false);
      expect([...fs.values()]).toEqual([1, 2, 3]);
    });

    it("throws on `add()`", () => {
      const fs = new FrozenSet<number>([1]);
      expect(() => fs.add(2)).toThrow("Cannot mutate a `FrozenSet`");
    });

    it("throws on `delete()`", () => {
      const fs = new FrozenSet<number>([1]);
      expect(() => fs.delete(1)).toThrow("Cannot mutate a `FrozenSet`");
    });

    it("throws on `clear()`", () => {
      const fs = new FrozenSet<number>([1]);
      expect(() => fs.clear()).toThrow("Cannot mutate a `FrozenSet`");
    });

    it("throws from the intrinsic `Set` mutators", () => {
      const fs = new FrozenSet<number>([1]);
      expect(() => Set.prototype.add.call(fs, 2)).toThrow();
      expect(fs.has(2)).toBe(false);
    });

    it("throws for a receiver that has no backing store", () => {
      const foreign = Object.create(FrozenSet.prototype) as FrozenSet<number>;

      expect(() => foreign.has(1)).toThrow("Incompatible `FrozenSet` receiver");
      expect(() => foreign.size).toThrow("Incompatible `FrozenSet` receiver");
      expect(() => foreign.keys()).toThrow("Incompatible `FrozenSet` receiver");
      expect(() => foreign.values()).toThrow(
        "Incompatible `FrozenSet` receiver",
      );
      expect(() => foreign.entries()).toThrow(
        "Incompatible `FrozenSet` receiver",
      );
    });

    it("reports `Set` as its `Symbol.toStringTag`", () => {
      const fs = new FrozenSet<number>([1]);
      expect(fs[Symbol.toStringTag]).toBe("Set");
      expect(Object.prototype.toString.call(fs)).toBe("[object Set]");
    });

    it("yields value-value pairs from `entries()`, as `Set` does", () => {
      const fs = new FrozenSet<number>([1, 2]);
      expect([...fs.entries()]).toEqual([[1, 1], [2, 2]]);
    });

    it("yields values from `keys()`, as `Set` does", () => {
      const fs = new FrozenSet<number>([1, 2]);
      expect([...fs.keys()]).toEqual([1, 2]);
    });

    it("visits every element in order under `forEach()`", () => {
      const fs = new FrozenSet([10, 20, 30]);
      const values: number[] = [];
      fs.forEach((v) => values.push(v));
      expect(values).toEqual([10, 20, 30]);
    });

    it("has a size of `0` when constructed with no argument", () => {
      const fs = new FrozenSet();
      expect(fs.size).toBe(0);
    });

    it("has a size of `0` when constructed with `null`", () => {
      const fs = new FrozenSet(null);
      expect(fs.size).toBe(0);
    });

    it("throws on a builder write after `finish()`", () => {
      const builder = FrozenSet.createBuilder<number>();
      builder.add(1);

      const fs = builder.finish();

      expect(() => builder.add(2)).toThrow(
        "Cannot mutate a finalized `FrozenSet` builder",
      );
      expect([...fs.values()]).toEqual([1]);
    });

    describe("set algebra", () => {
      it("computes `union()`", () => {
        const fs = new FrozenSet<number>([1, 2]);
        expect([...fs.union(new Set([2, 3]))]).toEqual([1, 2, 3]);
      });

      it("computes `intersection()`", () => {
        const fs = new FrozenSet<number>([1, 2, 3]);
        expect([...fs.intersection(new Set([2, 3, 4]))]).toEqual([2, 3]);
      });

      it("computes `difference()`", () => {
        const fs = new FrozenSet<number>([1, 2, 3]);
        expect([...fs.difference(new Set([2, 4]))]).toEqual([1, 3]);
      });

      it("computes `symmetricDifference()`", () => {
        const fs = new FrozenSet<number>([1, 2, 3]);
        expect([...fs.symmetricDifference(new Set([3, 4]))]).toEqual([1, 2, 4]);
      });

      it("computes `isSubsetOf()`", () => {
        const fs = new FrozenSet<number>([1, 2]);
        expect(fs.isSubsetOf(new Set([1, 2, 3]))).toBe(true);
        expect(fs.isSubsetOf(new Set([1, 3]))).toBe(false);
      });

      it("computes `isSupersetOf()`", () => {
        const fs = new FrozenSet<number>([1, 2, 3]);
        expect(fs.isSupersetOf(new Set([1, 3]))).toBe(true);
        expect(fs.isSupersetOf(new Set([1, 4]))).toBe(false);
      });

      it("computes `isDisjointFrom()`", () => {
        const fs = new FrozenSet<number>([1, 2]);
        expect(fs.isDisjointFrom(new Set([3, 4]))).toBe(true);
        expect(fs.isDisjointFrom(new Set([2, 3]))).toBe(false);
      });

      it("returns a mutable `Set` from the value-producing methods", () => {
        const result = new FrozenSet<number>([1]).union(new Set([2]));

        expect(result).toBeInstanceOf(Set);
        expect(result).not.toBeInstanceOf(FrozenSet);
        result.add(3);
        expect([...result]).toEqual([1, 2, 3]);
      });

      it("computes set algebra with an empty operand on either side", () => {
        const empty = new FrozenSet<number>();

        expect([...empty.union(new Set([1]))]).toEqual([1]);
        expect([...empty.intersection(new Set([1]))]).toEqual([]);
        expect([...empty.difference(new Set([1]))]).toEqual([]);
        expect([...new FrozenSet([1]).intersection(new Set<number>())])
          .toEqual([]);
        expect(empty.isSubsetOf(new Set([1]))).toBe(true);
        expect(empty.isDisjointFrom(new Set([1]))).toBe(true);
      });

      it("takes `intersection()` order from the smaller operand", () => {
        // `Set.prototype.intersection` iterates whichever operand is smaller,
        // so the result's iteration order follows that operand rather than
        // always following the receiver.

        const fs = new FrozenSet<number>([1, 2, 3, 4, 5]);
        expect([...fs.intersection(new Set([5, 1]))]).toEqual([5, 1]);
      });

      it("takes `intersection()` order from itself when no larger", () => {
        const fs = new FrozenSet<number>([5, 1]);
        expect([...fs.intersection(new Set([1, 2, 3, 4, 5]))]).toEqual([5, 1]);
      });

      it("takes `intersection()` order from itself on equal sizes", () => {
        // Equal sizes are the boundary between the two branches, and the
        // intrinsic iterates the receiver there. The operands below share their
        // elements but not their order, so the result distinguishes which side
        // was iterated -- which an equal-size case with coinciding orders
        // cannot.

        const fs = new FrozenSet<number>([1, 2]);
        expect([...fs.intersection(new Set([2, 1]))]).toEqual([1, 2]);
      });
    });

    describe("non-finite and signed-zero values", () => {
      // These wrappers follow `Set`'s `SameValueZero` comparison, under which
      // `-0` and `+0` are the same element. `FabricValue` equality follows
      // `Object.is()` instead and holds the two distinct, so the behavior
      // pinned here can look like a bug against that rule. It isn't, for two
      // reasons that are worth stating rather than rediscovering:
      //
      // `FrozenSet<T>` is declared `implements Set<T>`. It does not merely
      // resemble a `Set`, it claims substitutability -- so keying it by
      // `Object.is()` would produce a `Set` that is not a `Set`, breaking the
      // interface in its own `implements` clause. And `FrozenMap`/`FrozenSet`
      // are not `FabricValue`s at all, so the `Object.is()` rule does not
      // reach them in the first place.
      //
      // The plausible future mistake at this site is therefore not a naive
      // `===`; it is someone "fixing" these wrappers toward `Object.is()` for
      // consistency. These tests are what stops that.
      //
      // `toBe()` compares with `Object.is()`, which tells `-0` from `+0`.
      // `toEqual()` does not, and would make these assertions vacuous.

      it("normalizes `-0` to `+0` on insertion, as `Set` does", () => {
        const fs = new FrozenSet<number>([-0]);

        expect(fs.size).toBe(1);
        expect([...fs.values()][0]).toBe(0);
      });

      it("treats `-0` and `+0` as the same element", () => {
        const fs = new FrozenSet<number>([-0, 0]);

        expect(fs.size).toBe(1);
        expect(fs.has(0)).toBe(true);
        expect(fs.has(-0)).toBe(true);
      });

      it("unifies `-0` and `+0` across set algebra", () => {
        const fs = new FrozenSet<number>([-0]);

        const intersected = [...fs.intersection(new Set([0]))];
        expect(intersected.length).toBe(1);
        expect(Object.is(intersected[0], 0)).toBe(true);
        expect([...fs.difference(new Set([0]))]).toEqual([]);
        expect(fs.isSubsetOf(new Set([0]))).toBe(true);
        expect(fs.isDisjointFrom(new Set([0]))).toBe(false);
      });

      it("treats all `NaN`s as one element", () => {
        const fs = new FrozenSet<number>([NaN, NaN]);

        expect(fs.size).toBe(1);
        expect(fs.has(NaN)).toBe(true);
      });

      it("keeps the two infinities distinct", () => {
        const fs = new FrozenSet<number>([Infinity, -Infinity]);

        expect(fs.size).toBe(2);
        expect([...fs.values()][0]).toBe(Infinity);
        expect([...fs.values()][1]).toBe(-Infinity);
        expect(fs.isDisjointFrom(new Set([Infinity]))).toBe(false);
      });
    });
  });
});
