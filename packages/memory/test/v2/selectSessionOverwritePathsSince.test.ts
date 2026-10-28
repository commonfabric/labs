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
        { op: "splice", path: "/value/tags", index: 0, remove: 0, add: ["b"] },
      ),
    );
    expect(overwritten(seeded)).toEqual([]);
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
