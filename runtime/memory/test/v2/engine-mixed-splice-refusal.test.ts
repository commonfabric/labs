import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { type Operation, type PatchOp, ProtocolError } from "../../v2.ts";
import {
  applyCommit,
  close,
  type Engine,
  open,
  read,
} from "../../v2/engine.ts";

describe("applyCommit()", () => {
  // A commit's splices stand alone on their array: nothing else in the same
  // patch operation touches the array at or past the lowest index they splice
  // it at, adds, removes or moves one of its elements, or touches the array
  // itself or a value above it. That is what lets the indices a session's
  // splices overwrote be read back from the documents before and after its
  // commit. Each case commits one patch operation against the same seeded
  // document.

  const space = "did:key:z6MkmixedSpliceRefusalTestSpace";
  const id = "of:spliced";
  const seeded = {
    name: "",
    tags: ["a", "b", "c", "d"],
    rows: [{ items: ["p"] }, { items: ["q"] }],
  };
  let engine: Engine;
  let path: string;
  let localSeq = 0;

  const commit = (...patches: PatchOp[]): number =>
    applyCommit(engine, {
      sessionId: "session-under-test",
      principal: "did:key:alice",
      space,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "patch", id, patches }] as Operation[],
      },
    }).seq;

  const stored = () => read(engine, { id })?.value;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
    applyCommit(engine, {
      sessionId: "seeder-session",
      principal: "did:key:seeder",
      space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value: seeded } }],
      },
    });
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  const prepend: PatchOp = {
    op: "splice",
    path: "/value/tags",
    index: 0,
    remove: 0,
    add: ["x"],
  };
  const insertAtTwo: PatchOp = {
    op: "splice",
    path: "/value/tags",
    index: 2,
    remove: 0,
    add: ["x"],
  };

  describe("refuses a splice beside", () => {
    const refused: Array<{ beside: string; patches: PatchOp[] }> = [
      {
        beside: "an append to the array",
        patches: [prepend, {
          op: "append",
          path: "/value/tags",
          values: ["y"],
        }],
      },
      {
        beside: "an add-unique to the array",
        patches: [prepend, {
          op: "add-unique",
          path: "/value/tags",
          values: ["x"],
        }],
      },
      {
        beside: "a remove-by-value from the array",
        patches: [insertAtTwo, {
          op: "remove-by-value",
          path: "/value/tags",
          value: "a",
        }],
      },
      {
        beside: "a replace of the array itself",
        patches: [prepend, {
          op: "replace",
          path: "/value/tags",
          value: ["z"],
        }],
      },
      {
        beside: "a replace at an index at or past its own",
        patches: [insertAtTwo, {
          op: "replace",
          path: "/value/tags/3",
          value: "z",
        }],
      },
      {
        beside: "an increment at an index at or past its own",
        patches: [
          { op: "replace", path: "/value/tags", value: [1, 1, 3] },
          { op: "splice", path: "/value/tags", index: 0, remove: 0, add: [9] },
          { op: "increment", path: "/value/tags/1", by: 1 },
        ],
      },
      {
        beside: "a removal of an element below its index",
        patches: [insertAtTwo, { op: "remove", path: "/value/tags/0" }],
      },
      {
        beside: "an add at the end of the array",
        patches: [prepend, { op: "add", path: "/value/tags/-", value: "w" }],
      },
      {
        beside: "a move out of the array",
        patches: [insertAtTwo, {
          op: "move",
          from: "/value/tags/0",
          path: "/value/moved",
        }],
      },
      {
        beside: "a move into the array",
        patches: [insertAtTwo, {
          op: "move",
          from: "/value/name",
          path: "/value/tags/1",
        }],
      },
      {
        beside: "a replace of a value above the array",
        patches: [prepend, {
          op: "replace",
          path: "/value",
          value: { ...seeded, tags: [] },
        }],
      },
      {
        beside: "an edit of a row a splice of the rows has moved",
        patches: [
          {
            op: "splice",
            path: "/value/rows",
            index: 0,
            remove: 0,
            add: [{ items: ["t"] }],
          },
          { op: "replace", path: "/value/rows/1/items/0", value: "9" },
          { op: "splice", path: "/value/rows", index: 0, remove: 1, add: [] },
        ],
      },
      {
        beside: "a splice of a row at or past the rows' first splice",
        patches: [
          {
            op: "splice",
            path: "/value/rows",
            index: 1,
            remove: 0,
            add: [{ items: [] }],
          },
          {
            op: "splice",
            path: "/value/rows/1/items",
            index: 0,
            remove: 0,
            add: ["r"],
          },
        ],
      },
    ];

    for (const { beside, patches } of refused) {
      it(beside, () => {
        expect(() => commit(...patches)).toThrow(ProtocolError);
        expect(stored()).toEqual(seeded);
      });
    }
  });

  describe("accepts", () => {
    it("several splices of one array", () => {
      commit(
        { op: "splice", path: "/value/tags", index: 0, remove: 0, add: ["c"] },
        { op: "splice", path: "/value/tags", index: 3, remove: 1, add: [] },
      );
      expect(stored()).toEqual({ ...seeded, tags: ["c", "a", "b", "d"] });
    });

    it("a replace at an index below the first splice's", () => {
      commit({ op: "replace", path: "/value/tags/0", value: "z" }, insertAtTwo);
      expect(stored()).toEqual({
        ...seeded,
        tags: ["z", "b", "x", "c", "d"],
      });
    });

    it("a splice of a row below the rows' first splice", () => {
      commit(
        {
          op: "splice",
          path: "/value/rows/0/items",
          index: 0,
          remove: 0,
          add: ["o"],
        },
        {
          op: "splice",
          path: "/value/rows",
          index: 1,
          remove: 0,
          add: [{ items: [] }],
        },
      );
      expect(stored()).toEqual({
        ...seeded,
        rows: [{ items: ["o", "p"] }, { items: [] }, { items: ["q"] }],
      });
    });

    it("the per-index form of a change: replaces, then a splice at the tail", () => {
      commit(
        { op: "replace", path: "/value/tags/0", value: "x" },
        { op: "replace", path: "/value/tags/1", value: "a" },
        { op: "replace", path: "/value/tags/2", value: "b" },
        { op: "replace", path: "/value/tags/3", value: "c" },
        { op: "splice", path: "/value/tags", index: 4, remove: 0, add: ["d"] },
      );
      expect(stored()).toEqual({
        ...seeded,
        tags: ["x", "a", "b", "c", "d"],
      });
    });
  });
});
