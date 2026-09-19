/**
 * Preparing a value for a structured mutation by thawing only the spine along
 * a path.
 *
 * The payoff is in what goes untouched. Subtrees off the spine keep their
 * identity and with it their place in the deep-frozen cache, so re-freezing
 * the result afterward short-circuits on them rather than walking them again
 * -- which is why a case here inspects the cache and not only the values.
 *
 * The remainder is what a path can mean against a structure that does not
 * already match it: whether a missing intermediate is created and in what
 * shape, where a `FabricInstance` is allowed to sit, and which of those
 * situations is an error carrying enough detail for a caller to act on.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricError } from "@/fabric-instances/index.ts";
import { FabricEpochNsec } from "@/fabric-primitives/index.ts";
import {
  cloneForMutation,
  CloneForMutationError,
  deepFreeze,
  isDeepFrozen,
} from "@/index.ts";

describe("cloneForMutation()", () => {
  describe("empty path", () => {
    it("returns the root as mutable, plus identical `pathValue`", () => {
      const root = Object.freeze({ a: 1, b: 2 });
      const { value, pathValue } = cloneForMutation(root, []);

      expect(value).not.toBe(root);
      expect(Object.isFrozen(value)).toBe(false);
      expect(pathValue).toBe(value);
      expect(value).toEqual({ a: 1, b: 2 });
    });

    it("returns input identity when already mutable + `force=false`", () => {
      const root = { a: 1 };
      const { value, pathValue } = cloneForMutation(root, [], {
        force: false,
      });
      expect(value).toBe(root);
      expect(pathValue).toBe(root);
    });

    it("does not touch the input on default options (`force` defaults to `true`)", () => {
      // Default `force` is true, matching `cloneIfNecessary`'s default
      // when `frozen: false`. Even with mutable input, the result is a
      // fresh copy.
      const root = { a: 1 };
      const { value, pathValue } = cloneForMutation(root, []);
      expect(value).not.toBe(root);
      expect(pathValue).toBe(value);
      expect(value).toEqual({ a: 1 });
      expect(Object.isFrozen(value)).toBe(false);
    });

    it("always shallow-clones the root when `force=true`", () => {
      const root = { a: 1 };
      const { value, pathValue } = cloneForMutation(root, [], {
        force: true,
      });
      expect(value).not.toBe(root);
      expect(pathValue).toBe(value);
      expect(value).toEqual({ a: 1 });
      expect(Object.isFrozen(value)).toBe(false);
    });

    it("returns a thawed copy of an empty-path `FabricInstance`", () => {
      const err = FabricError.fromNativeError(new Error("test"));
      Object.freeze(err);
      const { value, pathValue } = cloneForMutation(
        err,
        [],
      );
      expect(value).not.toBe(err);
      expect(value).toBeInstanceOf(FabricError);
      expect(Object.isFrozen(value)).toBe(false);
      expect(pathValue).toBe(value);
      // `[SHALLOW_UNFROZEN_CLONE]` preserves the FabricValue-shaped state.
      const cloned = value;
      expect(cloned.type).toBe(err.type);
      expect(cloned.name).toBe(err.name);
      expect(cloned.message).toBe(err.message);
    });
  });

  describe("single-step path", () => {
    it("clones only the spine and exposes the leaf container", () => {
      const inner = Object.freeze({ x: 1 });
      const sibling = Object.freeze({ y: 2 });
      const root = Object.freeze({
        a: inner,
        b: sibling,
      });

      const { value, pathValue } = cloneForMutation(root, ["a"]);

      expect(value).not.toBe(root);
      expect(pathValue).toBe(
        (value as unknown as Record<string, unknown>).a,
      );
      expect(pathValue).not.toBe(inner); // had to thaw it
      expect(Object.isFrozen(value)).toBe(false);
      expect(Object.isFrozen(pathValue)).toBe(false);

      // Critical: the sibling subtree is preserved by identity.
      expect((value as unknown as Record<string, unknown>).b).toBe(sibling);
    });

    it("descends into a single-element array", () => {
      const noteA = Object.freeze({ title: "first" });
      const noteB = Object.freeze({ title: "second" });
      const root = Object.freeze({
        notes: Object.freeze([noteA, noteB]),
      });

      const { value, pathValue } = cloneForMutation(root, ["notes"]);

      expect(Array.isArray(pathValue)).toBe(true);
      expect((pathValue as unknown as unknown[]).length).toBe(2);

      // The note objects inside the freshly-thawed array are still the
      // original frozen instances -- shallow-thaw shares references.
      expect((pathValue as unknown as unknown[])[0]).toBe(noteA);
      expect((pathValue as unknown as unknown[])[1]).toBe(noteB);

      // The spliced-in array lives inside the new root.
      expect((value as unknown as Record<string, unknown>).notes).toBe(
        pathValue,
      );
    });

    it("returns input root identity when already mutable + `force=false`", () => {
      const inner = { x: 1 };
      const root = { a: inner };

      const { value, pathValue } = cloneForMutation(root, ["a"], {
        force: false,
      });

      // Already-mutable root reused by identity.
      expect(value).toBe(root);
      // Inner was already mutable too -- reused.
      expect(pathValue).toBe(inner);
    });

    it("does not touch a mutable input on default options", () => {
      // Default `force` is true: input is left alone even when mutable.
      const inner = { x: 1 };
      const root = { a: inner };

      const { value, pathValue } = cloneForMutation(root, ["a"]);

      expect(value).not.toBe(root);
      expect(pathValue).not.toBe(inner);
      // Sibling identity still preserved (would be `b` if present).
    });

    it("always copies the root and leaf when `force=true`", () => {
      const inner = { x: 1 };
      const root = { a: inner };

      const { value, pathValue } = cloneForMutation(root, ["a"], {
        force: true,
      });

      expect(value).not.toBe(root);
      expect(pathValue).not.toBe(inner);
      // ...but the leaf's children stay shared.
      expect(pathValue).toEqual({ x: 1 });
    });
  });

  describe("deep paths", () => {
    it("clones every spine container, preserves off-spine identity", () => {
      // Tree shape:
      //   root
      //     ├ a (frozen, on spine)
      //     │   ├ b (frozen, on spine)
      //     │   │   └ c (frozen, on spine -- the target)
      //     │   └ b2 (frozen, OFF spine)
      //     └ a2 (frozen, OFF spine)
      const c = Object.freeze({ leaf: true });
      const b2 = Object.freeze({ off: "spine-b" });
      const b = Object.freeze({ c, b2 });
      const a2 = Object.freeze({ off: "spine-a" });
      const a = Object.freeze({ b, a2 });
      const root = Object.freeze({ a, a2 });

      const { value, pathValue } = cloneForMutation(root, ["a", "b", "c"]);

      // Every spine container is freshly cloned (or at minimum,
      // distinct from the input's frozen original).
      expect(value).not.toBe(root);
      const newA = (value as unknown as Record<string, unknown>)
        .a as Record<
          string,
          unknown
        >;
      expect(newA).not.toBe(a);
      const newB = newA.b as Record<string, unknown>;
      expect(newB).not.toBe(b);
      const newC = newB.c;
      expect(newC).toBe(pathValue);
      expect(newC).not.toBe(c);

      // Off-spine subtrees retained by identity:
      //   - root.a2 (sibling of `a`)
      //   - a.b is now newA.b (= newB); but a.a2 (= a2) -- wait, a2 is on
      //     root, not on a. The off-spine peer at depth `a` is `root.a2`.
      //   - The off-spine peer at depth `b` is `a.a2`... no, `a` only has
      //     children `b` and `a2`. So `a2` is off-spine relative to the
      //     descent into `b`.
      expect((value as unknown as Record<string, unknown>).a2).toBe(a2);
      expect(newA.a2).toBe(a2);
      expect(newB.b2).toBe(b2);

      // Spine is mutable, off-spine retains frozenness:
      expect(Object.isFrozen(value)).toBe(false);
      expect(Object.isFrozen(newA)).toBe(false);
      expect(Object.isFrozen(newB)).toBe(false);
      expect(Object.isFrozen(newC)).toBe(false);
      expect(Object.isFrozen(a2)).toBe(true);
      expect(Object.isFrozen(b2)).toBe(true);
    });

    it("descends through arrays as well as objects", () => {
      const target = Object.freeze({ leaf: true });
      const otherNote = Object.freeze({ leaf: false });
      const notes = Object.freeze([otherNote, target]);
      const root = Object.freeze({ notes });

      const { value, pathValue } = cloneForMutation(
        root,
        ["notes", "1"],
      );

      const newNotes = (value as unknown as Record<string, unknown>).notes;
      expect(Array.isArray(newNotes)).toBe(true);
      expect(newNotes).not.toBe(notes);
      // Other (off-spine) element preserved by identity.
      expect((newNotes as unknown[])[0]).toBe(otherNote);
      // Target is the freshly-thawed pathValue.
      expect((newNotes as unknown[])[1]).toBe(pathValue);
      expect(pathValue).not.toBe(target);
    });
  });

  describe("deep-frozen cache preservation", () => {
    it("preserves off-spine deep-frozen subtrees in the cache", () => {
      // A deeply-nested off-spine subtree:
      const sibling = deepFreeze({ deep: { nested: [1, 2, 3] } });
      // (Sanity: deepFreeze has cached it.)
      expect(isDeepFrozen(sibling)).toBe(true);

      const target = Object.freeze({ leaf: true });
      const root = deepFreeze({ a: target, b: sibling });

      const { value } = cloneForMutation(root, ["a"]);

      // The sibling subtree is preserved by identity AND retains its
      // place in the deep-frozen cache (so future `isDeepFrozen` checks
      // and `cloneIfNecessary` short-circuits stay O(1)).
      expect((value as unknown as Record<string, unknown>).b).toBe(sibling);
      expect(isDeepFrozen(sibling)).toBe(true);
    });
  });

  describe("`FabricInstance` at leaf", () => {
    it("clones via `shallowClone(false)`, not as a plain object", () => {
      const err = FabricError.fromNativeError(new Error("boom"));
      Object.freeze(err);
      const root = Object.freeze({ payload: err });

      const { value, pathValue } = cloneForMutation(root, ["payload"]);

      expect(pathValue).toBeInstanceOf(FabricError);
      expect(pathValue).not.toBe(err);
      expect(Object.isFrozen(pathValue)).toBe(false);
      // The FabricValue-shaped state is preserved (shallowClone).
      const cloned = pathValue as unknown as FabricError;
      expect(cloned.type).toBe(err.type);
      expect(cloned.message).toBe(err.message);
      // And spliced into the new spine.
      expect((value as unknown as Record<string, unknown>).payload).toBe(
        pathValue,
      );
    });
  });

  describe("mutation through pathValue", () => {
    it("leaves the input untouched when the clone's array is pushed to", () => {
      const notes = Object.freeze([{ id: 1 }, { id: 2 }]);
      const root = Object.freeze({ notes });

      const { value, pathValue } = cloneForMutation(root, ["notes"]);

      (pathValue as unknown as Array<Record<string, unknown>>).push({
        id: 3,
      });

      expect((value as unknown as Record<string, unknown>).notes).toBe(
        pathValue,
      );
      expect((pathValue as unknown as unknown[]).length).toBe(3);
      // Input is untouched.
      expect(notes.length).toBe(2);
    });

    it("leaves the input untouched when a property is deleted from the clone", () => {
      const root = Object.freeze({
        keep: 1,
        drop: 2,
      });

      const { value, pathValue } = cloneForMutation(root, []);

      delete (pathValue as unknown as Record<string, unknown>).drop;

      expect(value).toEqual({ keep: 1 });
      expect((root as unknown as Record<string, unknown>).drop).toBe(2);
    });

    it("does not touch the input on `force=true` even with mutable input", () => {
      const inner = { x: 1, y: 2 };
      const root = { inner };

      const { value, pathValue } = cloneForMutation(
        root,
        ["inner"],
        { force: true },
      );

      (pathValue as unknown as Record<string, unknown>).x = 999;

      expect((value as unknown as Record<string, unknown>).inner).toBe(
        pathValue,
      );
      // Input untouched.
      expect(inner.x).toBe(1);
      expect(root.inner).toBe(inner);
    });
  });

  describe("createMissing", () => {
    it("creates a missing intermediate object", () => {
      const root = Object.freeze({ a: { existing: 1 } });
      const { value, pathValue } = cloneForMutation(
        root,
        ["a", "new"],
        { createMissing: true, nextKeyAfterPath: "key" },
      );
      const newA = (value as unknown as Record<string, unknown>)
        .a as Record<
          string,
          unknown
        >;
      // The original `a.existing` is preserved by identity (off-spine).
      expect(newA.existing).toBe(1);
      // `a.new` is freshly created and is what `pathValue` points at.
      expect(newA.new).toBe(pathValue);
      // `nextKeyAfterPath: "key"` selects an object.
      expect(pathValue).toEqual({});
      expect(Array.isArray(pathValue)).toBe(false);
    });

    it("creates a missing intermediate array (numeric next key)", () => {
      const root = Object.freeze({ a: {} });
      const { value, pathValue } = cloneForMutation(
        root,
        ["a", "items"],
        { createMissing: true, nextKeyAfterPath: "0" },
      );
      const newA = (value as unknown as Record<string, unknown>)
        .a as Record<
          string,
          unknown
        >;
      expect(newA.items).toBe(pathValue);
      expect(Array.isArray(pathValue)).toBe(true);
      expect(pathValue).toEqual([]);
    });

    it("treats `-` as the JSON-Pointer array append marker", () => {
      const root = Object.freeze({});
      const { value: _v, pathValue } = cloneForMutation(
        root,
        ["items"],
        { createMissing: true, nextKeyAfterPath: "-" },
      );
      expect(Array.isArray(pathValue)).toBe(true);
    });

    it("defaults to an object when `nextKeyAfterPath` is omitted", () => {
      const root = Object.freeze({});
      const { pathValue } = cloneForMutation(
        root,
        ["new"],
        { createMissing: true },
      );
      expect(Array.isArray(pathValue)).toBe(false);
      expect(pathValue).toEqual({});
    });

    it("chains multiple missing intermediates with correct shapes", () => {
      // path: ["a", "0", "items", "0", "name"]
      //   a -> object (next segment is "0" -- wait, this is the
      //   array-index test below; for THIS test let's mix object
      //   and array).
      //
      // Try: root.notes[0].title where notes doesn't exist.
      // - path[0]="notes" -> needs container at root.notes. Next is
      //   "0" -> array.
      // - path[1]="0" -> needs container at root.notes[0]. Next is
      //   "title" -> object.
      // - path[2]="title" -> the leaf, nextKeyAfterPath="" -> object
      //   if missing.
      const root = Object.freeze({});
      const { value, pathValue } = cloneForMutation(
        root,
        ["notes", "0", "title"],
        { createMissing: true },
      );
      const newRoot = value as unknown as Record<string, unknown>;
      expect(Array.isArray(newRoot.notes)).toBe(true);
      const notes = newRoot.notes as unknown[];
      expect(notes.length).toBe(1);
      expect(typeof notes[0]).toBe("object");
      expect(Array.isArray(notes[0])).toBe(false);
      // The leaf was created with default `nextKeyAfterPath: ""` -> object.
      expect(pathValue).toBe(
        (notes[0] as Record<string, unknown>).title,
      );
      expect(pathValue).toEqual({});
    });

    it("preserves existing intermediates while creating missing ones", () => {
      const existingNotes = Object.freeze([{ kept: 1 }]);
      const root = Object.freeze({
        notes: existingNotes,
      });
      const { value, pathValue } = cloneForMutation(
        root,
        ["notes", "0", "newKey"],
        { createMissing: true, nextKeyAfterPath: "leaf" },
      );
      const newRoot = value as unknown as Record<string, unknown>;
      const newNotes = newRoot.notes as unknown[];
      // The existing element was thawed (spine touches it) but the
      // sibling identity of `existingNotes[0].kept` is preserved.
      const note0 = newNotes[0] as Record<string, unknown>;
      expect(note0.kept).toBe(1);
      // The newly-created leaf-parent slot.
      expect(note0.newKey).toBe(pathValue);
      expect(pathValue).toEqual({});
    });

    it("does not interfere with normal (non-missing) descent", () => {
      // If everything exists, `createMissing: true` should behave the
      // same as the default.
      const root = Object.freeze({
        a: Object.freeze({ b: Object.freeze({ c: 42 }) }),
      });
      const { pathValue } = cloneForMutation(
        root,
        ["a", "b"],
        { createMissing: true },
      );
      expect(pathValue).toEqual({ c: 42 });
    });

    it("interacts correctly with `force=false` (identity on existing path)", () => {
      // If `createMissing: true` but every step exists AND `force:
      // false` AND input is already mutable, identity is preserved.
      const inner = { existing: 1 };
      const root = { a: inner };
      const { value, pathValue } = cloneForMutation(
        root,
        ["a"],
        { createMissing: true, force: false },
      );
      expect(value).toBe(root);
      expect(pathValue).toBe(inner);
    });

    it("respects `force=true` on the spine-thaw even when creating", () => {
      // When force=true (default), already-mutable spine containers
      // are still copied. `createMissing` doesn't change that.
      const root = { existing: 1 };
      const { value, pathValue } = cloneForMutation(
        root,
        ["new"],
        { createMissing: true },
      );
      expect(value).not.toBe(root); // root was force-copied
      expect((value as unknown as Record<string, unknown>).existing).toBe(
        1,
      );
      expect((value as unknown as Record<string, unknown>).new).toBe(
        pathValue,
      );
    });
  });

  describe("CloneForMutationError", () => {
    it("uses kind `missing-segment` for a missing intermediate", () => {
      const root = Object.freeze({ a: { b: 1 } });
      try {
        cloneForMutation(root, ["a", "nonesuch", "more"]);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(CloneForMutationError);
        const err = e as CloneForMutationError;
        expect(err.kind).toBe("missing-segment");
        expect(err.pathIndex).toBe(1);
        expect(err.valueKind).toBe("undefined");
      }
    });

    it("uses kind `non-container-descent` for primitive in path", () => {
      const root = Object.freeze({ x: 42 });
      try {
        cloneForMutation(root, ["x", "anything"]);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(CloneForMutationError);
        const err = e as CloneForMutationError;
        expect(err.kind).toBe("non-container-descent");
        expect(err.pathIndex).toBe(0);
        expect(err.valueKind).toBe("number");
      }
    });

    it("uses kind `non-mutable-leaf` for a primitive leaf", () => {
      const root = Object.freeze({ x: 42 });
      try {
        cloneForMutation(root, ["x"]);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(CloneForMutationError);
        const err = e as CloneForMutationError;
        expect(err.kind).toBe("non-mutable-leaf");
        expect(err.pathIndex).toBe(0);
        expect(err.valueKind).toBe("number");
      }
    });

    it("uses kind `non-mutable-root` for empty path with bad root", () => {
      try {
        cloneForMutation(42, []);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(CloneForMutationError);
        const err = e as CloneForMutationError;
        expect(err.kind).toBe("non-mutable-root");
        expect(err.pathIndex).toBe(-1);
        expect(err.valueKind).toBe("number");
      }
    });

    it("uses kind `non-container-root` for non-empty path with bad root", () => {
      try {
        cloneForMutation(42, ["x"]);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(CloneForMutationError);
        const err = e as CloneForMutationError;
        expect(err.kind).toBe("non-container-root");
        expect(err.pathIndex).toBe(-1);
        expect(err.valueKind).toBe("number");
      }
    });

    it("sets `error.name` to `CloneForMutationError`", () => {
      try {
        cloneForMutation(42, []);
        throw new Error("expected throw");
      } catch (e) {
        expect((e as Error).name).toBe("CloneForMutationError");
      }
    });
  });

  describe("errors", () => {
    it("throws on a missing path segment", () => {
      const root = Object.freeze({ a: { b: 1 } });
      expect(() => cloneForMutation(root, ["a", "nonesuch"]))
        .toThrow("missing path segment");
    });

    it("throws on a missing array index", () => {
      const root = Object.freeze({
        notes: Object.freeze([1, 2, 3]),
      });
      expect(() => cloneForMutation(root, ["notes", "10"]))
        .toThrow("missing path segment");
    });

    it("throws when descending through a primitive", () => {
      const root = Object.freeze({ x: 42 });
      expect(() => cloneForMutation(root, ["x", "anything"]))
        .toThrow("cannot descend into");
    });

    it("throws when descending through a `FabricInstance`", () => {
      const err = FabricError.fromNativeError(new Error("inside"));
      const root = Object.freeze({ err });
      // `path = ["err", "something"]` tries to descend INTO the
      // FabricInstance, which isn't supported.
      expect(() => cloneForMutation(root, ["err", "message"])).toThrow(
        "cannot descend into",
      );
    });

    it("throws when descending through a `FabricPrimitive`", () => {
      const epoch = new FabricEpochNsec(123n);
      const root = Object.freeze({
        epoch: epoch,
      });
      expect(() => cloneForMutation(root, ["epoch", "anything"]))
        .toThrow("cannot descend into");
    });

    it("throws when the leaf is a primitive (not mutable)", () => {
      const root = Object.freeze({ x: 42 });
      expect(() => cloneForMutation(root, ["x"]))
        .toThrow("cannot mutate");
    });

    it("throws when the leaf is a `FabricPrimitive` (not mutable)", () => {
      const epoch = new FabricEpochNsec(123n);
      const root = Object.freeze({
        epoch: epoch,
      });
      expect(() => cloneForMutation(root, ["epoch"]))
        .toThrow("cannot mutate");
    });

    it("throws on empty-path against a non-mutable root", () => {
      expect(() => cloneForMutation(42, []))
        .toThrow("cannot mutate");
    });

    it("throws on non-empty path against a non-container root", () => {
      expect(() => cloneForMutation(42, ["x"]))
        .toThrow("cannot descend into");
    });

    it("throws on non-empty path against a `FabricInstance` root", () => {
      // A FabricInstance is OK at the leaf but not as the root of a
      // non-empty path (we don't descend into FabricInstance internals).
      const err = FabricError.fromNativeError(new Error("test"));
      expect(() => cloneForMutation(err, ["x"]))
        .toThrow("cannot descend into");
    });
  });
});
