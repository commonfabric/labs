import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze, isDeepFrozen } from "@commonfabric/data-model";

import type { PatchOp } from "../../v2.ts";
import { applyPatch, patchOpDescriptors } from "../../v2/patch.ts";

/** A deep-frozen document whose `value` is an object of `size` keys. */
const documentOfSize = (size: number) => {
  const map: Record<string, { name: string }> = {};
  for (let index = 0; index < size; index++) {
    map[`key-${index}`] = { name: `name-${index}` };
  }
  return deepFreeze({ value: map });
};

/** `count` ops, each adding a new key to the document's `value`. */
const addsBeneathValue = (count: number): PatchOp[] =>
  Array.from({ length: count }, (_, index) => ({
    op: "add",
    path: `/value/added-${index}`,
    value: { name: `added-${index}` },
  }));

/**
 * Applies `ops` to `document`, and reports how many times the application
 * copied a container of at least `size` keys.
 *
 * A container is copied for a mutation by a shallow `Object.assign()` from it,
 * so counting the calls whose source is that large counts the copies of the
 * document's `value`. A count that tracks the number of ops is each op copying
 * it again.
 */
const largeCopiesDuring = (
  document: ReturnType<typeof documentOfSize>,
  ops: PatchOp[],
  size: number,
): number => {
  const assign = Object.assign;
  let copies = 0;
  Object.assign = ((target: object, ...sources: object[]) => {
    if (sources.some((source) => Object.keys(source).length >= size)) {
      copies++;
    }
    return assign(target, ...sources);
  }) as typeof Object.assign;
  try {
    applyPatch(document, ops);
  } finally {
    Object.assign = assign;
  }
  return copies;
};

describe("patch", () => {
  describe("applyPatch()", () => {
    it("applies each op to the tree the op before it left", () => {
      const result = applyPatch(deepFreeze({ value: { a: 1, b: 2 } }), [
        { op: "add", path: "/value/x", value: 10 },
        { op: "replace", path: "/value/x", value: 11 },
        { op: "remove", path: "/value/b" },
        { op: "add", path: "/value/y", value: { z: 1 } },
        { op: "replace", path: "/value/y/z", value: 2 },
      ]);

      expect(result).toEqual({ value: { a: 1, x: 11, y: { z: 2 } } });
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("leaves its input unchanged, frozen or mutable", () => {
      for (
        const input of [deepFreeze({ value: { a: 1 } }), { value: { a: 1 } }]
      ) {
        const result = applyPatch(input, [
          { op: "add", path: "/value/x", value: 1 },
          { op: "add", path: "/value/y", value: 2 },
          { op: "remove", path: "/value/a" },
        ]);

        expect(input).toEqual({ value: { a: 1 } });
        expect(result).toEqual({ value: { x: 1, y: 2 } });
      }
    });

    it("returns a deep-frozen tree after moving a container an earlier op thawed", () => {
      const result = applyPatch(deepFreeze({ value: { a: { v: 1 } } }), [
        { op: "replace", path: "/value/a/v", value: 2 },
        { op: "move", from: "/value/a", path: "/value/b" },
        { op: "replace", path: "/value/b/v", value: 3 },
      ]);

      expect(result).toEqual({ value: { b: { v: 3 } } });
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("copies a large object as often for many ops beneath it as for few", () => {
      const size = 1000;
      const short = largeCopiesDuring(
        documentOfSize(size),
        addsBeneathValue(10),
        size,
      );
      const long = largeCopiesDuring(
        documentOfSize(size),
        addsBeneathValue(100),
        size,
      );

      // The floor keeps the probe honest: were the copy no longer made through
      // `Object.assign()`, both counts would read zero and agree.
      expect(short).toBeGreaterThan(0);
      expect(long).toBe(short);
    });
  });

  describe("patchOpDescriptors", () => {
    it("mutates in place the containers an earlier op sharing its set copied", () => {
      const input = deepFreeze({ value: { a: 1 } });
      const owned = new WeakSet<object>();

      const first = patchOpDescriptors.add.apply(
        input,
        { op: "add", path: "/value/x", value: 1 },
        owned,
      );
      const second = patchOpDescriptors.add.apply(
        first,
        { op: "add", path: "/value/y", value: 2 },
        owned,
      );

      expect(second).toBe(first);
      expect(second).toEqual({ value: { a: 1, x: 1, y: 2 } });
      expect(input).toEqual({ value: { a: 1 } });
    });
  });
});
