/**
 * Writing and removing a value at a path, each copying only the spine that
 * changed.
 *
 * Off-spine subtrees keep their identity, which is the property the whole
 * shape exists for. The rest is deciding what a path means when the structure
 * does not already match it: a missing intermediate is created in the shape
 * the next segment implies, while a present leaf that is not a container is
 * refused rather than overwritten with structure.
 *
 * Removal turns on what counts as absent, and the answers are stricter than a
 * property read would give. A sparse hole, an out-of-range index, and an
 * index-like name that is not canonical all count as absent -- and absent
 * means nothing shifts.
 *
 * Neither one descends into a `FabricInstance`, which holds its state privately
 * and so has nothing a path key addresses. They part on what that means:
 * writing refuses it, while removal reads it as absent and leaves the root
 * alone.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricError } from "@/fabric-instances/index.ts";
import { FabricHash } from "@/fabric-primitives/index.ts";
import {
  CloneForMutationError,
  cloneWithoutValueAtPath,
  cloneWithValueAtPath,
  deepFreeze,
  isDeepFrozen,
} from "@/index.ts";

// deno-lint-ignore no-explicit-any
const obj = (v: unknown) => v as any;

describe("value-clone", () => {
  describe("cloneWithValueAtPath()", () => {
    it("copies only the mutated spine; off-spine subtrees are shared", () => {
      const root = deepFreeze({
        value: { left: { nested: { stable: true } }, right: { count: 1 } },
      });

      const result = obj(
        cloneWithValueAtPath(root, ["value", "right", "count"], 2),
      );

      expect(result).not.toBe(root);
      expect(result.value).not.toBe(obj(root).value);
      expect(result.value.left).toBe(obj(root).value.left); // off-spine: shared
      expect(result.value.right).not.toBe(obj(root).value.right); // on-spine: copied
      expect(result.value.right.count).toBe(2);
      expect(obj(root).value.right.count).toBe(1); // input untouched
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("creates missing intermediate containers, shaped by the next segment", () => {
      const objResult = obj(
        cloneWithValueAtPath(deepFreeze({}), ["a", "b"], 1),
      );
      expect(objResult.a.b).toBe(1);
      expect(Array.isArray(objResult.a)).toBe(false);
      expect(isDeepFrozen(objResult)).toBe(true);

      // An array-index-shaped next segment creates an array.
      const arrResult = obj(
        cloneWithValueAtPath(deepFreeze({}), ["items", "0"], "x"),
      );
      expect(Array.isArray(arrResult.items)).toBe(true);
      expect(arrResult.items[0]).toBe("x");
    });

    it("replaces the whole value for an empty path (deep-frozen)", () => {
      const result = obj(cloneWithValueAtPath(deepFreeze({ old: true }), [], {
        replacement: 1,
      }));
      expect(result).toEqual({ replacement: 1 });
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("throws rather than overwrite a present non-container leaf with spine structure", () => {
      // Descending a write path *through* a present non-container leaf would
      // have to replace that leaf with a fresh container, discarding whatever
      // it held. Refusing is what keeps the write from destroying it silently.
      expect(() =>
        cloneWithValueAtPath(deepFreeze({ a: "string" }), ["a", "b"], 1)
      )
        .toThrow(CloneForMutationError);
      expect(() =>
        cloneWithValueAtPath(deepFreeze({ a: { b: 5 } }), ["a", "b", "c"], 1)
      ).toThrow(CloneForMutationError);
    });

    it("preserves a FabricInstance sibling of the mutated spine by identity", () => {
      const hash = FabricHash.fromString("sha256:abcd");
      const root = deepFreeze({ value: { keep: hash, target: { count: 1 } } });

      const result = obj(
        cloneWithValueAtPath(root, ["value", "target", "count"], 2),
      );

      // `value` is shallow-cloned, being on the spine. Its `keep` sibling
      // rides along by identity rather than being reconstructed or demoted.
      expect(result.value.keep).toBe(hash);
      expect(result.value.keep).toBeInstanceOf(FabricHash);
      expect(result.value.keep.tag).toBe("sha256");
    });

    it("throws when the parent of the path is a `FabricInstance`", () => {
      const root = deepFreeze({
        err: FabricError.fromNativeError(new Error("boom")),
      });

      expect(() => cloneWithValueAtPath(root, ["err", "extra"], 42))
        .toThrow(CloneForMutationError);
    });

    it("reports a `FabricInstance` parent as a failed descent", () => {
      // Not `non-mutable-*`: an instance IS mutable and IS a container. What
      // it is not is addressable by a key, which is what the descent kinds
      // report. (An own property assigned through one would be invisible to
      // every reading of it as a `FabricValue` -- the codec's included.)
      const root = deepFreeze({
        err: FabricError.fromNativeError(new Error("boom")),
      });

      try {
        cloneWithValueAtPath(root, ["err", "extra"], 42);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(CloneForMutationError);
        const err = e as CloneForMutationError;
        expect(err.kind).toBe("non-container-descent");
        expect(err.pathIndex).toBe(0);
        expect(err.valueKind).toBe("FabricInstance (FabricError)");
      }
    });
  });

  describe("cloneWithoutValueAtPath()", () => {
    it("removes an object key, copying only the mutated spine", () => {
      const root = deepFreeze({
        value: { left: { nested: true }, right: { keep: 1, remove: 2 } },
      });

      const result = obj(
        cloneWithoutValueAtPath(root, ["value", "right", "remove"]),
      );

      expect(result.value.left).toBe(obj(root).value.left); // off-spine: shared
      expect(result.value.right).toEqual({ keep: 1 });
      expect(obj(root).value.right.remove).toBe(2); // input untouched
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("splices out an array element", () => {
      const root = deepFreeze({ items: [10, 20, 30] });

      const result = obj(cloneWithoutValueAtPath(root, ["items", "1"]));

      expect(result.items).toEqual([10, 30]);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("treats a sparse array hole (and out-of-range index) as absent", () => {
      const items = [10, 20, 30];
      delete items[1]; // sparse hole at index 1
      const root = deepFreeze({ items });

      // A hole is "nothing to remove" -- must not splice and shift the array.
      expect(cloneWithoutValueAtPath(root, ["items", "1"])).toBe(root);
      expect(cloneWithoutValueAtPath(root, ["items", "5"])).toBe(root);
    });

    it("treats non-canonical array-index names as absent (no shift)", () => {
      const root = deepFreeze({ items: [10, 20, 30] });

      // `00`/`01` coerce to in-range numbers but are not canonical index
      // names; `length` is an own array property but not an element. None
      // address an array element, so removal is a no-op (no splice/shift).
      expect(cloneWithoutValueAtPath(root, ["items", "00"])).toBe(root);
      expect(cloneWithoutValueAtPath(root, ["items", "01"])).toBe(root);
      expect(cloneWithoutValueAtPath(root, ["items", "length"])).toBe(root);
    });

    it("is identity for an already-frozen root when the path is absent", () => {
      const root = deepFreeze({ value: { left: { stable: true } } });

      expect(cloneWithoutValueAtPath(root, ["value", "right"])).toBe(root);
      expect(cloneWithoutValueAtPath(root, ["value", "left", "missing"])).toBe(
        root,
      );
    });

    it("returns a frozen clone (not an in-place freeze) for an absent path on a mutable root", () => {
      const root = { value: { left: { stable: true } } }; // not frozen

      const result = obj(cloneWithoutValueAtPath(root, ["value", "right"]));

      expect(isDeepFrozen(result)).toBe(true); // result is deep-frozen
      expect(Object.isFrozen(root)).toBe(false); // input not frozen in place
      expect(result).not.toBe(root); // a clone, not the input
      expect(result).toEqual(root); // same content
    });

    it("returns the root unchanged for a path under a `FabricPrimitive`", () => {
      const hash = FabricHash.fromString("sha256:abcd");
      const root = deepFreeze({ value: { wrapper: hash } });

      // There is nothing path-addressable under an opaque wrapper, so removal
      // is a no-op rather than an attempt to clone or mutate the wrapper.
      expect(cloneWithoutValueAtPath(root, ["value", "wrapper", "x"])).toBe(
        root,
      );
    });

    it("returns the root unchanged for a path under a `FabricInstance`", () => {
      // The same answer for the other non-addressable arm, which the primitive
      // case above does not reach: a `FabricPrimitive` is refused by the
      // descent itself, while an instance is a container the descent admits.
      // Removal parts from `cloneWithValueAtPath()` here -- absent is absent,
      // so there is nothing to refuse.
      const err = FabricError.fromNativeError(new Error("boom"));
      const root = deepFreeze({ value: { wrapper: err } });

      expect(cloneWithoutValueAtPath(root, ["value", "wrapper", "x"])).toBe(
        root,
      );
    });

    it("removes the whole value for an `undefined` root or an empty path", () => {
      expect(cloneWithoutValueAtPath(undefined, ["a"])).toBeUndefined();
      expect(cloneWithoutValueAtPath(deepFreeze({ a: 1 }), [])).toBeUndefined();
    });
  });
});
