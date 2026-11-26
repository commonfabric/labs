import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import { type Operation, type PatchOp, toDocumentPath } from "../../v2.ts";
import {
  applyCommit,
  close,
  createBranch,
  type Engine,
  open,
  selectDocHead,
  selectSessionOverwritePathsSince,
} from "../../v2/engine.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

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

  // A commit that marks a splice carries the read the mark stands on: a
  // recursive read of the document's value at its current head.
  const commit = (
    operations: Operation[],
    by: { principal: string; sessionId: string } = {
      principal,
      sessionId: session,
    },
  ): number => {
    const marks = operations.some((operation) =>
      operation.op === "patch" &&
      operation.patches.some((patch) =>
        patch.op === "splice" && patch.pinned === true
      )
    );
    const seq = selectDocHead(engine, { id, scopeKey: "space" });
    return applyCommit(engine, {
      sessionId: by.sessionId,
      principal: by.principal,
      space,
      commit: {
        localSeq: ++localSeq,
        reads: {
          confirmed: marks
            ? [{ id, path: toDocumentPath(["value"]), seq }]
            : [],
          pending: [],
        },
        operations,
      },
    }).seq;
  };

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
        pinned: true,
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
        pinned: true,
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
        pinned: true,
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
        pinned: true,
        path: "/value/tags",
        index: 4,
        remove: 0,
        add: ["e"],
      }));
      expect(overwritten(filled)).toEqual([]);
    });

    it("leaves out the indices whose values its splice left equal", () => {
      // Prepending to `[a, a, a, c]` leaves `a` at indices 1 and 2, as the
      // per-index form of the change does.
      commit(
        patch({
          op: "replace",
          path: "/value/tags",
          value: ["a", "a", "a", "c"],
        }),
        { principal: "did:key:seeder", sessionId: "seeder-session" },
      );
      const repeated = commit(
        patch({ op: "replace", path: "/value/count", value: 1 }),
        { principal: "did:key:seeder", sessionId: "seeder-session" },
      );
      commit(patch({
        op: "splice",
        pinned: true,
        path: "/value/tags",
        index: 0,
        remove: 0,
        add: ["x"],
      }));
      expect(overwritten(repeated)).toEqual([
        { array: ["value", "tags"], fromIndex: 0, toIndex: 1 },
        { array: ["value", "tags"], fromIndex: 3, toIndex: 4 },
      ]);
    });

    it("returns nothing for a removal at the end that removes nothing", () => {
      // The store removes what the array holds past the index, here nothing,
      // so the splice only appends.
      commit(patch({
        op: "splice",
        pinned: true,
        path: "/value/tags",
        index: 4,
        remove: 1,
        add: ["t"],
      }));
      expect(overwritten(filled)).toEqual([]);
    });

    it("returns nothing for a truncation beside an increment of the element it drops", () => {
      // The per-index form of a change that increments the last element and
      // then truncates the array sends both.
      commit(
        patch({ op: "replace", path: "/value/tags", value: [10, 20, 30] }),
        { principal: "did:key:seeder", sessionId: "seeder-session" },
      );
      const counted = commit(
        patch({ op: "replace", path: "/value/count", value: 1 }),
        { principal: "did:key:seeder", sessionId: "seeder-session" },
      );
      commit(patch(
        { op: "increment", path: "/value/tags/2", by: 1 },
        { op: "splice", path: "/value/tags", index: 2, remove: 1, add: [] },
      ));
      expect(overwritten(counted)).toEqual([]);
    });

    it("returns nothing for an unmarked splice that lands mid-array after a peer's append", () => {
      // The per-index form appends at the writer's old length; a peer's
      // append landed first, so the splice inserts before the peer's elements
      // and moves them. An unmarked splice overwrites nothing, so a delayed
      // handler's write to one of those elements stands.
      commit(patch({ op: "append", path: "/value/tags", values: ["p", "q"] }), {
        principal: "did:key:peer",
        sessionId: "peer-session",
      });
      commit(patch({
        op: "splice",
        path: "/value/tags",
        index: 4,
        remove: 0,
        add: ["mine"],
      }));
      expect(overwritten(filled)).toEqual([]);
    });

    it("leaves an index below its first splice to the replace that reaches it", () => {
      commit(patch(
        { op: "replace", path: "/value/tags/0", value: "z" },
        {
          op: "splice",
          pinned: true,
          path: "/value/tags",
          index: 2,
          remove: 0,
          add: ["x"],
        },
      ));
      expect(overwritten(filled)).toEqual([
        ["value", "tags", "0"],
        { array: ["value", "tags"], fromIndex: 2, toIndex: 4 },
      ]);
    });

    it("leaves out the elements a move's splices leave where they were", () => {
      // `c` moves to the head: an insertion, then the removal of its old
      // place, which leaves `d` at index 3.
      commit(patch(
        {
          op: "splice",
          pinned: true,
          path: "/value/tags",
          index: 0,
          remove: 0,
          add: ["c"],
        },
        {
          op: "splice",
          pinned: true,
          path: "/value/tags",
          index: 3,
          remove: 1,
          add: [],
        },
      ));
      expect(overwritten(filled)).toEqual([
        { array: ["value", "tags"], fromIndex: 0, toIndex: 3 },
      ]);
    });

    it("reads a fork's first write of the document against the document the fork inherited, as the per-index form does", () => {
      // The same head insertion on two forks of the filled list, marked on
      // one and index by index on the other.
      const onFork = (branch: string, patches: PatchOp[]) => {
        createBranch(engine, branch);
        applyCommit(engine, {
          sessionId: session,
          principal,
          space,
          commit: {
            localSeq: ++localSeq,
            branch,
            reads: {
              confirmed: [{ id, path: toDocumentPath(["value"]), seq: filled }],
              pending: [],
            },
            operations: [{ op: "patch", id, patches }],
          },
        });
        return selectSessionOverwritePathsSince(engine, {
          branch,
          id,
          scopeKey: "space",
          sinceSeq: filled,
          principal,
          sessionId: session,
        });
      };
      expect(onFork("marked", [{
        op: "splice",
        pinned: true,
        path: "/value/tags",
        index: 0,
        remove: 0,
        add: ["x"],
      }])).toEqual([{ array: ["value", "tags"], fromIndex: 0, toIndex: 4 }]);
      expect(onFork("positional", [
        { op: "replace", path: "/value/tags/0", value: "x" },
        { op: "replace", path: "/value/tags/1", value: "a" },
        { op: "replace", path: "/value/tags/2", value: "b" },
        { op: "replace", path: "/value/tags/3", value: "c" },
        { op: "splice", path: "/value/tags", index: 4, remove: 0, add: ["d"] },
      ])).toEqual([0, 1, 2, 3].map((index) => ["value", "tags", `${index}`]));
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
