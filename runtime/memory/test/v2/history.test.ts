import { ChangeSet } from "@codemirror/state";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  type BranchName,
  encodeMemoryBoundary,
  resolveScopeKey,
  toValuePath,
} from "../../v2.ts";
import {
  applyCommit,
  close,
  COMPACTION_SESSION_PREFIX,
  createBranch,
  deleteBranch,
  type Engine,
  open,
  queryOperationField,
  read,
  serverSeq,
} from "../../v2/engine.ts";
import { listCommits, restoreBranch } from "../../v2/history.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
} from "../../v2/operation-codec.ts";

describe("history", () => {
  const space = "did:key:z6Mk-history-space";
  const sessionId = "session:history";
  const principal = "did:key:z6Mk-history-user";

  let engine: Engine;
  let path: string;
  let localSeq: number;

  const set = (id: string, value: string, branch?: BranchName): number =>
    applyCommit(engine, {
      sessionId,
      space,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value } }],
        ...(branch === undefined ? {} : { branch }),
      },
    }).seq;

  const remove = (id: string): number =>
    applyCommit(engine, {
      sessionId,
      space,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id }],
      },
    }).seq;

  const valueOf = (id: string, branch?: BranchName) =>
    read(engine, { id, ...(branch === undefined ? {} : { branch }) })?.value;

  const restore = (
    options: { target?: BranchName; source?: BranchName; sourceSeq?: number },
  ) =>
    restoreBranch(engine, {
      space,
      sessionId: "server:restore",
      localSeq: ++localSeq,
      ...options,
    });

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  /**
   * Inserts the commit `cf space compact` leaves at the head of a store it
   * has compacted, and returns its seq.
   */
  const markCompacted = (): number => {
    const seq = serverSeq(engine) + 1;
    engine.database.prepare(
      `INSERT INTO "commit"
         (seq, branch, session_id, local_seq, original, resolution, class)
       VALUES (?, '', ?, 1, ?, ?, 'system')`,
    ).run(
      seq,
      `${COMPACTION_SESSION_PREFIX}test`,
      encodeMemoryBoundary({}),
      encodeMemoryBoundary({}),
    );
    return seq;
  };

  describe("listCommits()", () => {
    it("returns a branch's commits newest first", () => {
      const first = set("of:a", "one");
      const second = set("of:b", "two");

      const commits = listCommits(engine);

      expect(commits.map((commit) => commit.seq)).toEqual([second, first]);
      expect(commits[0]).toMatchObject({
        branch: "",
        class: "authored",
        events: 0,
        writes: 1,
      });
      expect(Number.isNaN(Date.parse(commits[0].createdAt))).toBe(false);
    });

    it("returns a fork's own commits, then its parent's up to the fork point", () => {
      const before = set("of:a", "before");
      createBranch(engine, "fork");
      const onParent = set("of:a", "parent");
      const onFork = set("of:a", "fork", "fork");

      expect(listCommits(engine, { branch: "fork" }).map((c) => c.seq))
        .toEqual([onFork, before]);
      expect(listCommits(engine).map((c) => c.seq))
        .toEqual([onParent, before]);
    });

    it("returns only commits below `before`, and at most `limit` of them", () => {
      const seqs = [1, 2, 3, 4].map((n) => set("of:a", `value ${n}`));

      expect(
        listCommits(engine, { before: seqs[3], limit: 2 }).map((c) => c.seq),
      ).toEqual([seqs[2], seqs[1]]);
    });

    it("leaves out the commits below a compaction", () => {
      set("of:a", "before");
      const floor = markCompacted();
      const after = set("of:a", "after");

      expect(listCommits(engine).map((commit) => commit.seq))
        .toEqual([after, floor]);
    });

    it("throws for a branch that does not exist", () => {
      expect(() => listCommits(engine, { branch: "missing" })).toThrow(
        "unknown branch: missing",
      );
    });
  });

  describe("restoreBranch()", () => {
    it("sets changed documents back, deletes later ones and revives deleted ones", () => {
      set("of:kept", "same");
      set("of:changed", "old");
      const then = set("of:deleted", "was here");
      set("of:changed", "new");
      set("of:added", "later");
      remove("of:deleted");

      const commit = restore({ sourceSeq: then });

      expect(valueOf("of:kept")).toBe("same");
      expect(valueOf("of:changed")).toBe("old");
      expect(valueOf("of:deleted")).toBe("was here");
      expect(read(engine, { id: "of:added" })).toBeNull();
      expect(commit?.revisions.map((revision) => revision.id).toSorted())
        .toEqual(["of:added", "of:changed", "of:deleted"]);
    });

    it("records a system commit naming the point it restored", () => {
      const then = set("of:a", "old");
      set("of:a", "new");

      const commit = restore({ sourceSeq: then });

      expect(listCommits(engine)[0]).toMatchObject({
        seq: commit?.seq,
        class: "system",
        restored: { branch: "", seq: then },
      });
    });

    it("keeps the state a restore replaced readable at its seq", () => {
      const then = set("of:a", "old");
      const replaced = set("of:a", "new");

      restore({ sourceSeq: then });

      expect(read(engine, { id: "of:a", seq: replaced })?.value).toBe("new");
    });

    it("returns `undefined` and writes nothing when nothing differs", () => {
      const head = set("of:a", "value");

      expect(restore({ sourceSeq: head })).toBeUndefined();
      expect(listCommits(engine).map((c) => c.seq)).toEqual([head]);
    });

    it("throws for a fork point below a compaction", () => {
      const then = set("of:a", "old");
      markCompacted();

      expect(() => createBranch(engine, "fork", { forkSeq: then })).toThrow(
        "was compacted",
      );
    });

    it("restores the default branch to a fork's head", () => {
      set("of:a", "before");
      set("of:b", "before");
      createBranch(engine, "fork");
      set("of:a", "on fork", "fork");
      set("of:c", "only on fork", "fork");
      set("of:b", "on parent");
      set("of:d", "only on parent");

      restore({ source: "fork" });

      expect(valueOf("of:a")).toBe("on fork");
      expect(valueOf("of:b")).toBe("before");
      expect(valueOf("of:c")).toBe("only on fork");
      expect(read(engine, { id: "of:d" })).toBeNull();
    });

    it("restores from a deleted fork", () => {
      set("of:a", "before");
      createBranch(engine, "fork");
      set("of:a", "on fork", "fork");
      deleteBranch(engine, "fork");

      restore({ source: "fork" });

      expect(valueOf("of:a")).toBe("on fork");
    });

    it("restores each user's instance of a user-scoped document", () => {
      const write = (value: string) =>
        applyCommit(engine, {
          sessionId,
          space,
          principal,
          commit: {
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:mine",
              scope: "user",
              value: { value },
            }],
          },
        }).seq;
      const then = write("old");
      write("new");

      restore({ sourceSeq: then });

      const scopeKey = resolveScopeKey("user", { principal, sessionId });
      expect(read(engine, { id: "of:mine", scopeKey })?.value).toBe("old");
    });

    it("ends a collaborative field of a document it sets back", () => {
      const field = { id: "of:text", path: toValuePath(["body"]) };
      applyCommit(engine, {
        sessionId,
        space,
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: field.id,
            value: { value: { body: "a" } },
          }],
        },
      });
      const then = set("of:other", "marker");
      applyCommit(engine, {
        sessionId,
        space,
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            ...field,
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "edit:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{
                clientId: "editor",
                changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
              }],
            },
          }],
        },
      });
      expect(queryOperationField(engine, field)).toMatchObject({
        active: true,
        materialized: "ab",
      });

      restore({ sourceSeq: then });

      expect(queryOperationField(engine, field)).toMatchObject({
        active: false,
        materialized: "a",
      });
    });

    it("leaves the space's access list as it is", () => {
      const then = set("of:a", "old");
      set(`of:${space}`, "access list");

      restore({ sourceSeq: then });

      expect(valueOf(`of:${space}`)).toBe("access list");
    });

    it("throws for a seq below a compaction, and writes nothing", () => {
      const then = set("of:a", "old");
      set("of:a", "new");
      markCompacted();

      expect(() => restore({ sourceSeq: then })).toThrow("was compacted");
      expect(valueOf("of:a")).toBe("new");
    });

    it("throws for a seq outside the source's history", () => {
      const head = set("of:a", "value");

      expect(() => restore({ sourceSeq: head + 1 })).toThrow(
        `seq ${head + 1} is out of range for branch `,
      );
    });
  });
});
