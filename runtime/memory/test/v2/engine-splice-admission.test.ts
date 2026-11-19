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
  // A splice names its index and its count of removals in whole numbers at or
  // above zero; any other op may sit beside it. Each case commits one patch
  // operation against the same seeded document.

  const space = "did:key:z6MksplicedAdmissionTestSpace";
  const id = "of:spliced";
  const seeded = {
    tags: ["a", "b", "c", "d"],
    counts: [10, 20, 30],
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

  describe("refuses a splice", () => {
    it("at a fractional index", () => {
      expect(() =>
        commit({
          op: "splice",
          path: "/value/tags",
          index: 0.5,
          remove: 1,
          add: ["x"],
        })
      ).toThrow(ProtocolError);
      expect(stored()).toEqual(seeded);
    });

    it("removing a fractional count", () => {
      expect(() =>
        commit({
          op: "splice",
          path: "/value/tags",
          index: 1,
          remove: 1.5,
          add: [],
        })
      ).toThrow(ProtocolError);
      expect(stored()).toEqual(seeded);
    });
  });

  describe("accepts", () => {
    it("several splices of one array", () => {
      commit(
        { op: "splice", path: "/value/tags", index: 0, remove: 0, add: ["c"] },
        { op: "splice", path: "/value/tags", index: 3, remove: 1, add: [] },
      );
      expect(stored()).toEqual({ ...seeded, tags: ["c", "a", "b", "d"] });
    });

    it("an increment of an element beside the truncation that drops it", () => {
      commit(
        { op: "increment", path: "/value/counts/2", by: 1 },
        { op: "splice", path: "/value/counts", index: 2, remove: 1, add: [] },
      );
      expect(stored()).toEqual({ ...seeded, counts: [10, 20] });
    });

    it("a splice of a row beside a splice of the rows", () => {
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
  });
});
