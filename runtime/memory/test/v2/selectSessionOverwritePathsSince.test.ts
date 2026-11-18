import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { Operation, PatchOp } from "../../v2.ts";
import {
  applyCommit,
  close,
  type Engine,
  open,
  selectSessionOverwritePathsSince,
} from "../../v2/engine.ts";

describe("selectSessionOverwritePathsSince()", () => {
  // Every case asks about one session — `session` opened by `principal` — on
  // one document, which a different session seeds first.

  const space = "did:key:z6MkselectSessionOverwritePathsSinceTestSpace";
  const id = "of:overwrite-target";
  const principal = "did:key:alice";
  const session = "session-under-test";
  let engine: Engine;
  let path: string;
  let localSeq = 0;

  const commit = (
    operations: Operation[],
    by: { principal: string; sessionId: string } = {
      principal,
      sessionId: session,
    },
  ): number =>
    applyCommit(engine, {
      sessionId: by.sessionId,
      principal: by.principal,
      space,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations,
      },
    }).seq;

  const patch = (...patches: PatchOp[]): Operation[] => [
    { op: "patch", id, patches },
  ];

  const overwritten = (sinceSeq: number, sessionId = session) =>
    selectSessionOverwritePathsSince(engine, {
      id,
      scopeKey: "space",
      sinceSeq,
      principal,
      sessionId,
    });

  let seeded = 0;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
    seeded = commit(
      [{
        op: "set",
        id,
        value: { value: { name: "", bio: "", tags: [], count: 0 } },
      }],
      { principal: "did:key:seeder", sessionId: "seeder-session" },
    );
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  it("returns an empty list when the session wrote nothing after the seq", () => {
    commit(patch({ op: "replace", path: "/value/name", value: "early" }));
    const after = commit(
      patch({ op: "replace", path: "/value/bio", value: "" }),
    );
    expect(overwritten(after)).toEqual([]);
  });

  it("returns the root path for the session's `set` after the seq", () => {
    commit([{
      op: "set",
      id,
      value: { value: { name: "Grace", bio: "", tags: [], count: 0 } },
    }]);
    expect(overwritten(seeded)).toEqual([[]]);
  });

  it("returns the root path for the session's `delete` after the seq", () => {
    commit([{ op: "delete", id }]);
    expect(overwritten(seeded)).toEqual([[]]);
  });

  it("returns the paths of `replace`, `add` and `remove` patches in commit order", () => {
    commit(patch({ op: "replace", path: "/value/name", value: "Grace" }));
    commit(
      patch(
        { op: "add", path: "/value/title", value: "Admiral" },
        { op: "remove", path: "/value/bio" },
      ),
    );
    expect(overwritten(seeded)).toEqual([
      ["value", "name"],
      ["value", "title"],
      ["value", "bio"],
    ]);
  });

  it("returns both paths of a `move`", () => {
    commit(patch({ op: "move", from: "/value/bio", path: "/value/name" }));
    expect(overwritten(seeded)).toEqual([["value", "bio"], ["value", "name"]]);
  });

  it("returns an empty list for patches that merge into existing content", () => {
    commit(
      patch(
        { op: "append", path: "/value/tags", values: ["a"] },
        { op: "increment", path: "/value/count", by: 1 },
      ),
    );
    expect(overwritten(seeded)).toEqual([]);
  });

  describe("for a `splice`", () => {
    // The seeder fills the list, so the session's splices land inside it.
    let filled = 0;
    beforeEach(() => {
      filled = commit(
        patch({
          op: "replace",
          path: "/value/tags",
          value: ["a", "b", "c", "d"],
        }),
        { principal: "did:key:seeder", sessionId: "seeder-session" },
      );
    });

    it("returns the elements it moved where it inserts", () => {
      commit(patch({
        op: "splice",
        path: "/value/tags",
        index: 1,
        remove: 0,
        add: ["x"],
      }));
      expect(overwritten(filled)).toEqual([
        { array: ["value", "tags"], fromIndex: 1, toIndex: 4 },
      ]);
    });

    it("returns the elements it replaced or moved where it removes more than it adds", () => {
      commit(patch({
        op: "splice",
        path: "/value/tags",
        index: 0,
        remove: 2,
        add: ["x"],
      }));
      expect(overwritten(filled)).toEqual([
        { array: ["value", "tags"], fromIndex: 0, toIndex: 3 },
      ]);
    });

    it("returns the indices it replaced where it keeps the length", () => {
      commit(patch({
        op: "splice",
        path: "/value/tags",
        index: 1,
        remove: 2,
        add: ["x", "y"],
      }));
      expect(overwritten(filled)).toEqual([
        { array: ["value", "tags"], fromIndex: 1, toIndex: 3 },
      ]);
    });

    it("returns nothing for a splice that appends past the end", () => {
      commit(patch({
        op: "splice",
        path: "/value/tags",
        index: 4,
        remove: 0,
        add: ["e"],
      }));
      expect(overwritten(filled)).toEqual([]);
    });

    it("leaves out the elements a move's splices leave where they were", () => {
      // `c` moves to the head: an insertion, then the removal of its old
      // place, which leaves `d` at index 3.
      commit(patch(
        { op: "splice", path: "/value/tags", index: 0, remove: 0, add: ["c"] },
        { op: "splice", path: "/value/tags", index: 3, remove: 1, add: [] },
      ));
      expect(overwritten(filled)).toEqual([
        { array: ["value", "tags"], fromIndex: 0, toIndex: 3 },
      ]);
    });
  });

  it("returns an empty list for another session's writes after the seq", () => {
    commit(patch({ op: "replace", path: "/value/name", value: "Grace" }), {
      principal,
      sessionId: "another-session",
    });
    commit(patch({ op: "replace", path: "/value/bio", value: "Admiral" }), {
      principal: "did:key:bob",
      sessionId: session,
    });
    expect(overwritten(seeded)).toEqual([]);
  });

  it("returns only the paths the asked-for session wrote, among other sessions' writes", () => {
    commit(patch({ op: "replace", path: "/value/name", value: "Grace" }), {
      principal,
      sessionId: "another-session",
    });
    commit(patch({ op: "replace", path: "/value/bio", value: "Admiral" }));
    expect(overwritten(seeded)).toEqual([["value", "bio"]]);
    expect(overwritten(seeded, "another-session")).toEqual([[
      "value",
      "name",
    ]]);
  });
});
