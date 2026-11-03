/**
 * `PathKeyMap` keyed by path rather than by a single value, so the cases that
 * matter are the ones where paths relate to each other: a nested path under a
 * set one, overwriting at the same path, and invalidating a chain.
 *
 * The distinction between a present-but-`undefined` value and an absent key is
 * pinned deliberately. A map that collapses the two cannot be used to cache
 * anything whose legitimate value is `undefined`, which is most of what a
 * reactive read returns.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { PathKeyMap } from "../src/path-key-map.ts";

describe("PathKeyMap", () => {
  describe("empty state", () => {
    it("is empty on a fresh map", () => {
      const m = new PathKeyMap<number>();
      expect(m.isEmpty()).toBe(true);
      expect(m.get([])).toBeUndefined();
      expect(m.get(["a"])).toBeUndefined();
      expect(m.has([])).toBe(false);
      expect(m.has(["a", "b"])).toBe(false);
      expect([...m.keys()]).toEqual([]);
      expect([...m.entries()]).toEqual([]);
    });
  });

  describe("set()/get()/has()", () => {
    it("stores and retrieves a value at the root path", () => {
      const m = new PathKeyMap<string>();
      m.set([], "root-value");
      expect(m.has([])).toBe(true);
      expect(m.get([])).toBe("root-value");
      expect(m.has(["a"])).toBe(false);
      expect(m.isEmpty()).toBe(false);
    });

    it("stores and retrieves values at nested paths", () => {
      const m = new PathKeyMap<number>();
      m.set(["a", "b"], 1);
      m.set(["a", "c"], 2);
      m.set(["a", "b", "deep"], 3);
      expect(m.get(["a", "b"])).toBe(1);
      expect(m.get(["a", "c"])).toBe(2);
      expect(m.get(["a", "b", "deep"])).toBe(3);
      // Interior node without its own value is absent even though it has
      // descendants with values.
      expect(m.has(["a"])).toBe(false);
      expect(m.get(["a"])).toBeUndefined();
    });

    it("overwrites a prior value at the same path", () => {
      const m = new PathKeyMap<string>();
      m.set(["x"], "first");
      m.set(["x"], "second");
      expect(m.get(["x"])).toBe("second");
    });

    it("distinguishes a present-but-`undefined` value from an absent key", () => {
      const m = new PathKeyMap<number | undefined>();
      m.set(["a"], undefined);
      expect(m.has(["a"])).toBe(true);
      expect(m.get(["a"])).toBeUndefined();
      expect(m.has(["b"])).toBe(false);
    });
  });

  describe("delete()", () => {
    it("removes a present value and returns `true`", () => {
      const m = new PathKeyMap<number>();
      m.set(["a", "b"], 1);
      m.set(["a", "b", "c"], 2);
      expect(m.delete(["a", "b"])).toBe(true);
      expect(m.has(["a", "b"])).toBe(false);
      // Descendant under the deleted node is unaffected.
      expect(m.get(["a", "b", "c"])).toBe(2);
    });

    it("returns `false` on a re-delete or an absent path", () => {
      const m = new PathKeyMap<number>();
      m.set(["a"], 1);
      expect(m.delete(["a"])).toBe(true);
      expect(m.delete(["a"])).toBe(false);
      expect(m.delete(["nope"])).toBe(false);
    });
  });

  describe("clear()", () => {
    it("empties everything", () => {
      const m = new PathKeyMap<number>();
      m.set([], 0);
      m.set(["a"], 1);
      m.set(["a", "b"], 2);
      m.clear();
      expect(m.isEmpty()).toBe(true);
      expect(m.get([])).toBeUndefined();
      expect(m.get(["a"])).toBeUndefined();
      expect(m.get(["a", "b"])).toBeUndefined();
    });
  });

  describe("invalidateChain()", () => {
    it("on the root path behaves like `clear()`", () => {
      const m = new PathKeyMap<number>();
      m.set([], 0);
      m.set(["a"], 1);
      m.set(["a", "b", "c"], 2);
      m.invalidateChain([]);
      expect(m.isEmpty()).toBe(true);
    });

    it("drops ancestors and the leaf subtree; preserves cousins", () => {
      // Layout:
      //   /a/b      <- ancestor of write
      //   /a/b/c    <- the write target
      //   /a/b/c/d  <- descendant of write
      //   /a/b/x    <- sibling under same parent /a/b
      //   /a/y      <- sibling under different parent
      //   /z        <- root-level sibling
      //   /         <- root value
      const m = new PathKeyMap<string>();
      m.set([], "ROOT");
      m.set(["a"], "/a");
      m.set(["a", "b"], "/a/b");
      m.set(["a", "b", "c"], "/a/b/c");
      m.set(["a", "b", "c", "d"], "/a/b/c/d");
      m.set(["a", "b", "x"], "/a/b/x");
      m.set(["a", "y"], "/a/y");
      m.set(["z"], "/z");

      m.invalidateChain(["a", "b", "c"]);

      // Ancestors of the write are dropped:
      expect(m.has([])).toBe(false);
      expect(m.has(["a"])).toBe(false);
      expect(m.has(["a", "b"])).toBe(false);
      // The write target itself is dropped:
      expect(m.has(["a", "b", "c"])).toBe(false);
      // The subtree below the write is dropped:
      expect(m.has(["a", "b", "c", "d"])).toBe(false);
      // The sibling under the same parent is preserved (it shares
      // structurally, so its cached value remains valid):
      expect(m.get(["a", "b", "x"])).toBe("/a/b/x");
      // Cousins off divergent ancestors are preserved:
      expect(m.get(["a", "y"])).toBe("/a/y");
      expect(m.get(["z"])).toBe("/z");
    });

    it("clears ancestors even when no value is stored at the write path", () => {
      const m = new PathKeyMap<string>();
      m.set(["a"], "/a");
      m.set(["a", "b"], "/a/b");
      // Nothing stored at /a/b/c, but /a and /a/b are ancestors of the write
      // and must be dropped.
      m.invalidateChain(["a", "b", "c"]);
      expect(m.has(["a"])).toBe(false);
      expect(m.has(["a", "b"])).toBe(false);
    });

    it("short-circuits when the chain has no child to descend into", () => {
      // /a is a leaf in the trie. invalidateChain at /a/b/c stops walking
      // once it would have to descend into a missing child; /a's value
      // still gets cleared because we clear-on-walk.
      const m = new PathKeyMap<string>();
      m.set(["a"], "/a");
      m.set(["zzz"], "/zzz");
      m.invalidateChain(["a", "b", "c"]);
      expect(m.has(["a"])).toBe(false);
      // Unrelated sibling preserved.
      expect(m.get(["zzz"])).toBe("/zzz");
    });

    it("drops the root and the subtree for a one-segment path", () => {
      const m = new PathKeyMap<string>();
      m.set([], "ROOT");
      m.set(["a"], "/a");
      m.set(["a", "b"], "/a/b");
      m.set(["b"], "/b");
      m.invalidateChain(["a"]);
      expect(m.has([])).toBe(false);
      expect(m.has(["a"])).toBe(false);
      expect(m.has(["a", "b"])).toBe(false);
      expect(m.get(["b"])).toBe("/b");
    });
  });

  describe("keys()/entries()", () => {
    it("iterates every present path", () => {
      const m = new PathKeyMap<number>();
      m.set(["a"], 1);
      m.set(["a", "b"], 2);
      m.set(["a", "c"], 3);
      m.set(["d"], 4);

      const keys = [...m.keys()].map((p) => p.join("/")).sort();
      expect(keys).toEqual(["a", "a/b", "a/c", "d"]);

      const entriesByKey = new Map<string, number>();
      for (const [path, value] of m.entries()) {
        entriesByKey.set(path.join("/"), value);
      }
      expect(entriesByKey.get("a")).toBe(1);
      expect(entriesByKey.get("a/b")).toBe(2);
      expect(entriesByKey.get("a/c")).toBe(3);
      expect(entriesByKey.get("d")).toBe(4);
    });
  });

  describe("realistic shapes", () => {
    it(
      "stress: many sibling writes, one invalidation, only the chain drops",
      () => {
        // Mirrors the realistic Cell.set() shape: lots of cached reads at
        // sibling paths, then a write that should only invalidate one of
        // them.
        const m = new PathKeyMap<number>();
        for (let i = 0; i < 100; i++) {
          m.set(["root", "subtree", `s${i}`], i);
        }
        m.invalidateChain(["root", "subtree", "s42"]);
        expect(m.has(["root", "subtree", "s42"])).toBe(false);
        for (let i = 0; i < 100; i++) {
          if (i === 42) continue;
          expect(m.get(["root", "subtree", `s${i}`])).toBe(i);
        }
      },
    );

    it("preserves reference identity of stored values", () => {
      // Important for the v2-transaction usecase: cached frozen reads are
      // compared by reference identity downstream.
      const m = new PathKeyMap<Record<string, unknown>>();
      const obj = Object.freeze({ x: 1 });
      m.set(["a", "b"], obj);
      expect(m.get(["a", "b"])).toBe(obj);
    });
  });
});
