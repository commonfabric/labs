import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze, isDeepFrozen } from "@commonfabric/data-model";

import type { PatchOp } from "../../v2.ts";
import { applyPatch, PatchApplyError } from "../../v2/patch.ts";

/**
 * A deep-frozen document whose `value` is an object of `size` keys, each entry
 * holding a name, a count, and a list holding `x`.
 */
const documentOfSize = (size: number) => {
  const map: Record<string, { name: string; count: number; tags: string[] }> =
    {};
  for (let index = 0; index < size; index++) {
    map[`key-${index}`] = { name: `name-${index}`, count: 0, tags: ["x"] };
  }
  return deepFreeze({ value: map });
};

/** `count` ops of one kind, each beneath its own entry of `value`. */
const opsOf = (
  count: number,
  op: (index: number) => PatchOp,
): PatchOp[] => Array.from({ length: count }, (_, index) => op(index));

/**
 * A batch of each op kind beneath the document's `value`, one op per entry.
 * Every one descends through `value`, so each is one that could copy it again,
 * and keying the table by the op union makes a new op kind a compile error
 * here until it has a row.
 */
const opsBeneathValue = {
  replace: (count) =>
    opsOf(count, (index) => ({
      op: "replace",
      path: `/value/key-${index}/name`,
      value: `renamed-${index}`,
    })),
  add: (count) =>
    opsOf(count, (index) => ({
      op: "add",
      path: `/value/added-${index}`,
      value: { name: `added-${index}` },
    })),
  remove: (count) =>
    opsOf(count, (index) => ({ op: "remove", path: `/value/key-${index}` })),
  move: (count) =>
    opsOf(count, (index) => ({
      op: "move",
      from: `/value/key-${index}`,
      path: `/value/moved-${index}`,
    })),
  splice: (count) =>
    opsOf(count, (index) => ({
      op: "splice",
      path: `/value/key-${index}/tags`,
      index: 0,
      remove: 0,
      add: ["y"],
    })),
  append: (count) =>
    opsOf(count, (index) => ({
      op: "append",
      path: `/value/key-${index}/tags`,
      values: ["y"],
    })),
  "add-unique": (count) =>
    opsOf(count, (index) => ({
      op: "add-unique",
      path: `/value/key-${index}/tags`,
      values: ["y"],
    })),
  "remove-by-value": (count) =>
    opsOf(count, (index) => ({
      op: "remove-by-value",
      path: `/value/key-${index}/tags`,
      value: "x",
    })),
  increment: (count) =>
    opsOf(count, (index) => ({
      op: "increment",
      path: `/value/key-${index}/count`,
      by: 1,
    })),
} satisfies Record<PatchOp["op"], (count: number) => PatchOp[]>;

/**
 * For each op kind that places a value, a batch that places an object and then
 * edits inside what it placed: the edit a later op would make through a
 * payload the tree held by reference.
 */
const placingThenEditing = {
  replace: () => [
    { op: "replace", path: "/value/key-0", value: { name: "placed" } },
    { op: "replace", path: "/value/key-0/name", value: "edited" },
  ],
  add: () => [
    { op: "add", path: "/value/added", value: { name: "placed" } },
    { op: "replace", path: "/value/added/name", value: "edited" },
  ],
  splice: () => [
    {
      op: "splice",
      path: "/value/key-0/tags",
      index: 0,
      remove: 0,
      add: [{ name: "placed" }],
    },
    { op: "replace", path: "/value/key-0/tags/0/name", value: "edited" },
  ],
  append: () => [
    { op: "append", path: "/value/key-0/tags", values: [{ name: "placed" }] },
    { op: "replace", path: "/value/key-0/tags/1/name", value: "edited" },
  ],
  "add-unique": () => [
    {
      op: "add-unique",
      path: "/value/key-0/tags",
      values: [{ name: "placed" }],
    },
    { op: "replace", path: "/value/key-0/tags/1/name", value: "edited" },
  ],
} satisfies Partial<Record<PatchOp["op"], () => PatchOp[]>>;

/**
 * Applies `ops` to `document`, whose `value` starts with `size` keys, and
 * reports how many times the application copied a container of at least half
 * that many.
 *
 * A container is copied for a mutation by a shallow `Object.assign()` from it,
 * so counting the calls whose source is that large counts the copies of the
 * document's `value`. Half, because removals shrink `value` as they go, and a
 * copy of it after the first removal must still count. A count that tracks the
 * number of ops is each op copying it again.
 */
const largeCopiesDuring = (
  document: ReturnType<typeof documentOfSize>,
  ops: PatchOp[],
  size: number,
): number => {
  const assign = Object.assign;
  let copies = 0;
  Object.assign = ((target: object, ...sources: object[]) => {
    if (
      sources.some((source) =>
        source != null && Object.keys(source).length >= size / 2
      )
    ) {
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
    it("returns each op applied to the tree the op before it left", () => {
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

    it("leaves its input's content unchanged, frozen or mutable", () => {
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

    it("leaves its input's content unchanged when a later op throws", () => {
      // The ops before the one that throws have mutated copies in place, and
      // those copies must not have been the input's own containers.
      const input = deepFreeze({ value: { a: { v: 1 }, b: 2 } });

      expect(() =>
        applyPatch(input, [
          { op: "replace", path: "/value/a/v", value: 2 },
          { op: "add", path: "/value/c", value: 3 },
          { op: "remove", path: "/value/missing" },
        ])
      ).toThrow(PatchApplyError);
      expect(input).toEqual({ value: { a: { v: 1 }, b: 2 } });
    });

    it("deep-freezes its input in place", () => {
      // Freezing first is what marks every container the ops find mutable as
      // one this call copied, and so safe to mutate in place.
      const input = { value: { a: { b: 1 } }, other: [1] };

      applyPatch(input, [{ op: "replace", path: "/value/a/b", value: 2 }]);

      expect(isDeepFrozen(input)).toBe(true);
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

    for (const [kind, batch] of Object.entries(placingThenEditing)) {
      it(`places a copy of a \`${kind}\` op's payload, which a later op's edit leaves as it was`, () => {
        // An op mutates in place any container it finds mutable, so a payload
        // the tree held by reference would take the later edit, and be frozen
        // with the result.
        const ops = batch();
        const payloads = ops.flatMap((op) =>
          Object.values(op).filter((field) =>
            field !== null && typeof field === "object"
          )
        );
        const before = JSON.parse(JSON.stringify(payloads));

        const result = applyPatch(documentOfSize(10), ops);

        expect(JSON.stringify(result)).toContain('"edited"');
        expect(payloads).toEqual(before);
        for (const payload of payloads) {
          expect(Object.isFrozen(payload)).toBe(false);
        }
      });
    }

    for (const [kind, ops] of Object.entries(opsBeneathValue)) {
      it(`copies a large object as often for many \`${kind}\` ops beneath it as for few`, () => {
        const size = 1000;
        const short = largeCopiesDuring(documentOfSize(size), ops(10), size);
        const long = largeCopiesDuring(documentOfSize(size), ops(100), size);

        // The floor keeps the probe honest: were the copy no longer made
        // through `Object.assign()`, both counts would read zero and agree.
        expect(short).toBeGreaterThan(0);
        expect(long).toBe(short);
      });
    }
  });
});
