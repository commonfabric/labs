import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  type ConfirmedRead,
  type Operation,
  type PatchOp,
  ProtocolError,
  toDocumentPath,
} from "../../v2.ts";
import {
  applyCommit,
  close,
  type Engine,
  open,
  read,
} from "../../v2/engine.ts";

describe("applyCommit()", () => {
  // A splice names its index and its count of removals in whole numbers at or
  // above zero. A marked splice (`pinned`) also stands as its mark says: under
  // a recursive read of its array or of a path above it, with its document in
  // no other operation of the commit, and alone on its array in its patch
  // operation. An unmarked splice meets only the rules every patch meets.
  // Each case commits against the same seeded document.

  const space = "did:key:z6MksplicedAdmissionTestSpace";
  const id = "of:spliced";
  const seeded = {
    tags: ["a", "b", "c", "d"],
    counts: [10, 20, 30],
    rows: [{ items: ["p"] }, { items: ["q"] }],
    extra: {},
  };
  let engine: Engine;
  let path: string;
  let localSeq = 0;
  let seededSeq = 0;

  /** A recursive read of the document at `readPath`, at its seeded head. */
  const readAt = (readPath: string[], shallow = false): ConfirmedRead => ({
    id,
    path: toDocumentPath(readPath),
    seq: seededSeq,
    ...(shallow ? { nonRecursive: true } : {}),
  });

  const commitOperations = (
    operations: Operation[],
    confirmed: ConfirmedRead[] = [],
  ): number =>
    applyCommit(engine, {
      sessionId: "session-under-test",
      principal: "did:key:alice",
      space,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed, pending: [] },
        operations,
      },
    }).seq;

  const commit = (patches: PatchOp[], confirmed: ConfirmedRead[] = []) =>
    commitOperations([{ op: "patch", id, patches }], confirmed);

  const stored = () => read(engine, { id })?.value;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
    seededSeq = applyCommit(engine, {
      sessionId: "seeder-session",
      principal: "did:key:seeder",
      space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value: seeded } }],
      },
    }).seq;
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  const marked = (
    array: string,
    index: number,
    remove: number,
    add: unknown[],
  ): PatchOp => ({
    op: "splice",
    path: array,
    index,
    remove,
    add: add as PatchOp extends { add: infer A } ? A : never,
    pinned: true,
  });

  describe("refuses a splice", () => {
    it("at a fractional index", () => {
      expect(() =>
        commit([{
          op: "splice",
          path: "/value/tags",
          index: 0.5,
          remove: 1,
          add: ["x"],
        }])
      ).toThrow(ProtocolError);
      expect(stored()).toEqual(seeded);
    });

    it("removing a fractional count", () => {
      expect(() =>
        commit([{
          op: "splice",
          path: "/value/tags",
          index: 1,
          remove: 1.5,
          add: [],
        }])
      ).toThrow(ProtocolError);
      expect(stored()).toEqual(seeded);
    });
  });

  describe("accepts an unmarked splice", () => {
    it("of several of one array", () => {
      commit([
        { op: "splice", path: "/value/tags", index: 0, remove: 0, add: ["c"] },
        { op: "splice", path: "/value/tags", index: 3, remove: 1, add: [] },
      ]);
      expect(stored()).toEqual({ ...seeded, tags: ["c", "a", "b", "d"] });
    });

    it("beside an increment of the element its truncation drops", () => {
      commit([
        { op: "increment", path: "/value/counts/2", by: 1 },
        { op: "splice", path: "/value/counts", index: 2, remove: 1, add: [] },
      ]);
      expect(stored()).toEqual({ ...seeded, counts: [10, 20] });
    });

    it("beside an append to its array, without a read", () => {
      commit([
        { op: "splice", path: "/value/tags", index: 0, remove: 0, add: ["x"] },
        { op: "append", path: "/value/tags", values: ["y"] },
      ]);
      expect(stored()).toEqual({
        ...seeded,
        tags: ["x", "a", "b", "c", "d", "y"],
      });
    });
  });

  describe("refuses a marked splice", () => {
    const refused: Array<
      {
        beside: string;
        operations: () => Operation[];
        reads?: () => ConfirmedRead[];
      }
    > = [
      {
        beside: "with no read",
        operations: () => [{
          op: "patch",
          id,
          patches: [marked("/value/tags", 0, 0, ["x"])],
        }],
        reads: () => [],
      },
      {
        beside: "under a shallow read of the array alone",
        operations: () => [{
          op: "patch",
          id,
          patches: [marked("/value/tags", 0, 0, ["x"])],
        }],
        reads: () => [readAt(["value", "tags"], true)],
      },
      {
        beside: "under a read of another array alone",
        operations: () => [{
          op: "patch",
          id,
          patches: [marked("/value/tags", 0, 0, ["x"])],
        }],
        reads: () => [readAt(["value", "counts"])],
      },
      {
        beside: "beside another operation on the document",
        operations: () => [
          { op: "patch", id, patches: [marked("/value/tags", 0, 0, ["x"])] },
          { op: "patch", id, patches: [marked("/value/tags", 0, 1, [])] },
        ],
      },
      {
        beside: "beside an unmarked splice of its array",
        operations: () => [{
          op: "patch",
          id,
          patches: [
            marked("/value/tags", 0, 0, ["x"]),
            { op: "splice", path: "/value/tags", index: 5, remove: 0, add: [] },
          ],
        }],
      },
      {
        beside: "beside an append to its array",
        operations: () => [{
          op: "patch",
          id,
          patches: [
            marked("/value/tags", 0, 0, ["x"]),
            { op: "append", path: "/value/tags", values: ["y"] },
          ],
        }],
      },
      {
        beside: "beside an increment at or past its index",
        operations: () => [{
          op: "patch",
          id,
          patches: [
            marked("/value/counts", 0, 0, [9]),
            { op: "increment", path: "/value/counts/1", by: 1 },
          ],
        }],
      },
      {
        beside: "beside a removal of an element below its index",
        operations: () => [{
          op: "patch",
          id,
          patches: [
            marked("/value/tags", 2, 0, ["x"]),
            { op: "remove", path: "/value/tags/0" },
          ],
        }],
      },
      {
        beside: "beside a replace of a value above its array",
        operations: () => [{
          op: "patch",
          id,
          patches: [
            marked("/value/tags", 0, 0, ["x"]),
            { op: "replace", path: "/value", value: { ...seeded, tags: [] } },
          ],
        }],
      },
      {
        beside: "beside an add to an array above it, before its element",
        operations: () => [{
          op: "patch",
          id,
          patches: [
            { op: "add", path: "/value/rows/0", value: { items: ["t"] } },
            marked("/value/rows/2/items", 0, 0, ["x"]),
            { op: "remove", path: "/value/rows/0" },
          ],
        }],
      },
      {
        beside: "beside a splice of an array above it, at its element",
        operations: () => [{
          op: "patch",
          id,
          patches: [
            marked("/value/rows/1/items", 0, 0, ["x"]),
            marked("/value/rows", 1, 0, [{ items: [] }]),
          ],
        }],
      },
      {
        beside:
          "beside an unmarked splice of an array above it, at its element",
        operations: () => [{
          op: "patch",
          id,
          patches: [
            {
              op: "splice",
              path: "/value/rows",
              index: 0,
              remove: 0,
              add: [{ items: [] }],
            },
            marked("/value/rows/1/items", 0, 0, ["x"]),
          ],
        }],
      },
    ];

    for (const { beside, operations, reads } of refused) {
      it(beside, () => {
        expect(() =>
          commitOperations(
            operations(),
            reads === undefined ? [readAt(["value"])] : reads(),
          )
        ).toThrow(/marks a splice/);
        expect(stored()).toEqual(seeded);
      });
    }
  });

  describe("accepts a marked splice", () => {
    it("under a recursive read of its array", () => {
      commit([marked("/value/tags", 0, 0, ["x"])], [
        readAt(["value", "tags"]),
      ]);
      expect(stored()).toEqual({
        ...seeded,
        tags: ["x", "a", "b", "c", "d"],
      });
    });

    it("under a read of a path above it, beside a replace below its index", () => {
      commit([
        { op: "replace", path: "/value/tags/0", value: "z" },
        marked("/value/tags", 2, 0, ["x"]),
      ], [readAt(["value"])]);
      expect(stored()).toEqual({
        ...seeded,
        tags: ["z", "b", "x", "c", "d"],
      });
    });

    it("of a row below a marked splice of the rows", () => {
      commit([
        marked("/value/rows/0/items", 0, 0, ["o"]),
        marked("/value/rows", 1, 0, [{ items: [] }]),
      ], [readAt(["value"])]);
      expect(stored()).toEqual({
        ...seeded,
        rows: [{ items: ["o", "p"] }, { items: [] }, { items: ["q"] }],
      });
    });

    it("beside an unmarked splice of an array above it, past its element", () => {
      commit([
        marked("/value/rows/1/items", 0, 0, ["x"]),
        {
          op: "splice",
          path: "/value/rows",
          index: 2,
          remove: 0,
          add: [{ items: [] }],
        },
      ], [readAt(["value"])]);
      expect(stored()).toEqual({
        ...seeded,
        rows: [{ items: ["p"] }, { items: ["x", "q"] }, { items: [] }],
      });
    });

    it("beside an add at a key of a record above it", () => {
      commit([
        marked("/value/tags", 0, 0, ["x"]),
        { op: "add", path: "/value/extra/1", value: true },
        { op: "add", path: "/value/note", value: "n" },
      ], [readAt(["value"])]);
      expect(stored()).toEqual({
        ...seeded,
        tags: ["x", "a", "b", "c", "d"],
        extra: { 1: true },
        note: "n",
      });
    });
  });
});
