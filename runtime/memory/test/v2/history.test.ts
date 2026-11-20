import { ChangeSet } from "@codemirror/state";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import {
  type BranchName,
  encodeMemoryBoundary,
  resetServerExecutionConfig,
  resolveScopeKey,
  SERVER_EXECUTION_ATTENTION_DOC_ID,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  setServerExecutionConfig,
  streamEntriesDocId,
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
import { ExecutionLeaseCycle } from "../../v2/execution-lease.ts";
import { listCommits, restoreBranch } from "../../v2/history.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
} from "../../v2/operation-codec.ts";

describe("history", () => {
  const space = "did:key:z6Mk-history-space";
  const sessionId = "session:history";
  const principal = "did:key:z6Mk-history-user";
  const otherPrincipal = "did:key:z6Mk-history-other-user";

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

  /** Writes `of:mine` in `as`'s instance of `scope`, and returns the seq. */
  const setScoped = (
    scope: "user" | "session",
    value: string,
    as: string,
  ): number =>
    applyCommit(engine, {
      sessionId,
      space,
      principal: as,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:mine", scope, value: { value } }],
      },
    }).seq;

  const scopedValue = (scope: "user" | "session", as: string) =>
    read(engine, {
      id: "of:mine",
      scopeKey: resolveScopeKey(scope, { principal: as, sessionId }),
    })?.value;

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

    it("returns the principal of the session that made a commit, and none for a session without one", () => {
      set("of:a", "anonymous");
      applyCommit(engine, {
        sessionId,
        principal,
        space,
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id: "of:a", value: { value: "theirs" } }],
        },
      });

      expect(listCommits(engine).map((commit) => commit.principal))
        .toEqual([principal, undefined]);
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

    describe("over a fork of a fork", () => {
      // The grandchild's history is three stretches: its own commits, the
      // child's up to the grandchild's fork point, and the default branch's
      // up to the child's.

      let onDefault: number[];
      let onChild: number[];
      let onGrandchild: number[];

      beforeEach(() => {
        onDefault = [set("of:a", "default 1"), set("of:a", "default 2")];
        createBranch(engine, "child");
        set("of:a", "default, after the child forked");
        onChild = [
          set("of:a", "child 1", "child"),
          set("of:a", "child 2", "child"),
        ];
        createBranch(engine, "grandchild", { parentBranch: "child" });
        set("of:a", "child, after the grandchild forked", "child");
        onGrandchild = [
          set("of:a", "grandchild 1", "grandchild"),
          set("of:a", "grandchild 2", "grandchild"),
        ];
      });

      const seqs = (options: { before?: number; limit?: number } = {}) =>
        listCommits(engine, { branch: "grandchild", ...options }).map((
          commit,
        ) => commit.seq);

      it("returns its own commits, then each ancestor's up to the fork point below it", () => {
        expect(seqs()).toEqual(
          [...onDefault, ...onChild, ...onGrandchild].toReversed(),
        );
        expect(
          listCommits(engine, { branch: "grandchild" }).map((commit) =>
            commit.branch
          ),
        ).toEqual(["grandchild", "grandchild", "child", "child", "", ""]);
      });

      it("returns the parent's and the default branch's commits below a `before` in the parent's stretch", () => {
        expect(seqs({ before: onChild[1] })).toEqual([
          onChild[0],
          ...onDefault.toReversed(),
        ]);
      });

      it("returns only the default branch's commits below a `before` at the first fork point", () => {
        expect(seqs({ before: onChild[0] })).toEqual(onDefault.toReversed());
      });

      it("returns none of an ancestor's commits when `limit` is the count of its own", () => {
        expect(seqs({ limit: 2 })).toEqual(onGrandchild.toReversed());
      });

      it("returns one of the parent's commits when `limit` runs one past its own", () => {
        expect(seqs({ limit: 3 })).toEqual([
          ...onGrandchild.toReversed(),
          onChild[1],
        ]);
      });

      it("pages through all three stretches, each page starting below the last seq of the one before", () => {
        const pages: number[][] = [];
        let before: number | undefined;
        for (let page = seqs({ limit: 4 }); page.length > 0;) {
          pages.push(page);
          before = page.at(-1);
          page = seqs({ limit: 4, before });
        }

        expect(pages).toEqual([
          [...onGrandchild.toReversed(), ...onChild.toReversed()],
          onDefault.toReversed(),
        ]);
      });
    });

    describe("a commit's `restored`", () => {
      const merge = {
        sourceBranch: "",
        sourceSeq: 1,
        baseBranch: "",
        baseSeq: 1,
      };

      /** Inserts a `system` commit whose stored payload is `original`. */
      const insertSystemCommit = (original: unknown): number => {
        const seq = serverSeq(engine) + 1;
        engine.database.prepare(
          `INSERT INTO "commit"
             (seq, branch, session_id, local_seq, original, resolution, class)
           VALUES (?, '', 'server:odd', ?, ?, ?, 'system')`,
        ).run(
          seq,
          seq,
          encodeMemoryBoundary(original as FabricValue),
          encodeMemoryBoundary({}),
        );
        return seq;
      };

      it("is absent for a client's commit that carries a `merge`", () => {
        set("of:a", "old");
        const seq = applyCommit(engine, {
          sessionId,
          space,
          commit: {
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:a", value: { value: "new" } }],
            merge,
          },
        }).seq;

        const [commit] = listCommits(engine);

        expect(commit).toMatchObject({ seq, class: "authored", writes: 1 });
        expect(commit).not.toHaveProperty("restored");
      });

      it("names the source of a `system` commit that carries a `merge`", () => {
        set("of:a", "old");
        const seq = insertSystemCommit({ merge });

        expect(listCommits(engine)[0]).toMatchObject({
          seq,
          restored: { branch: "", seq: 1 },
        });
      });

      it("is absent for a `system` commit whose `merge` names no branch and seq, or whose payload is `null`", () => {
        set("of:a", "old");
        const odd = [
          { merge: null },
          { merge: "fork" },
          { merge: 7 },
          { merge: { sourceBranch: "fork" } },
          { merge: { sourceBranch: 7, sourceSeq: 1 } },
          { merge: { sourceBranch: "fork", sourceSeq: "1" } },
          null,
        ].map(insertSystemCommit);

        const commits = listCommits(engine, { limit: odd.length });

        expect(commits.map((commit) => commit.seq)).toEqual(odd.toReversed());
        for (const commit of commits) {
          expect(commit).not.toHaveProperty("restored");
          expect(commit.events).toBe(0);
        }
      });
    });

    describe("under server execution", () => {
      const holder = "service:history-holder";
      const sidecar = streamEntriesDocId({ id: "of:poll", path: ["votes"] });

      beforeEach(async () => {
        setServerExecutionConfig(true);
        const lease = new ExecutionLeaseCycle({
          leases: engine.executionLeases,
          space,
          holder,
        });
        if (!await lease.acquire()) throw new Error("lease acquire failed");
      });

      afterEach(() => {
        resetServerExecutionConfig();
      });

      it("returns the count of events a commit appended as `events`", () => {
        const entries = ["event:1", "event:2"].map((eventId) => ({
          eventId,
          stream: { id: "of:poll", path: ["votes"] },
          payload: { vote: "green" },
        }));
        const seq = applyCommit(engine, {
          sessionId,
          principal,
          space,
          commit: {
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: sidecar,
              patches: [{
                op: "append",
                path: "/value/entries",
                values: entries as never[],
              }],
            }],
            eventAppends: entries.map(({ eventId }) => ({
              id: sidecar,
              eventId,
            })),
          },
        }).seq;

        expect(listCommits(engine)[0]).toMatchObject({ seq, events: 2 });
      });

      it("returns a derived commit's `consequenceOf` and `derivedThrough`, and neither for an authored commit", () => {
        const authored = set("of:a", "authored");
        const derived = applyCommit(engine, {
          sessionId: holder,
          space,
          commitClass: "derived",
          holder,
          consequenceOf: ["event:1", "event:2"],
          derivedThrough: authored,
          commit: {
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:derived",
              value: { value: "derived" },
            }],
          },
        }).seq;

        const [first, second] = listCommits(engine);

        expect(first).toMatchObject({
          seq: derived,
          class: "derived",
          consequenceOf: ["event:1", "event:2"],
          derivedThrough: authored,
        });
        expect(second.seq).toBe(authored);
        expect(second).not.toHaveProperty("consequenceOf");
        expect(second).not.toHaveProperty("derivedThrough");
      });
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

  describe("createBranch()", () => {
    it("throws for a fork point below a compaction", () => {
      const then = set("of:a", "old");
      markCompacted();

      expect(() => createBranch(engine, "fork", { forkSeq: then })).toThrow(
        "was compacted",
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

    it("returns `undefined` and writes nothing when a document written since holds the restored value again", () => {
      const then = set("of:a", "old");
      set("of:a", "new");
      const head = set("of:a", "old");

      expect(restore({ sourceSeq: then })).toBeUndefined();
      expect(serverSeq(engine)).toBe(head);
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
      const then = Math.max(
        setScoped("user", "old", principal),
        setScoped("user", "theirs, old", otherPrincipal),
      );
      setScoped("user", "new", principal);
      setScoped("user", "theirs, new", otherPrincipal);

      restore({ sourceSeq: then });

      expect(scopedValue("user", principal)).toBe("old");
      expect(scopedValue("user", otherPrincipal)).toBe("theirs, old");
    });

    it("deletes a user's instance created after the restored point, and leaves another user's that did not change", () => {
      const then = setScoped("user", "kept", principal);
      setScoped("user", "created later", otherPrincipal);

      const commit = restore({ sourceSeq: then });

      expect(scopedValue("user", principal)).toBe("kept");
      expect(
        read(engine, {
          id: "of:mine",
          scopeKey: resolveScopeKey("user", {
            principal: otherPrincipal,
            sessionId,
          }),
        }),
      ).toBeNull();
      expect(commit?.revisions.map((revision) => revision.scopeKey)).toEqual([
        resolveScopeKey("user", { principal: otherPrincipal, sessionId }),
      ]);
    });

    it("leaves a session-scoped instance as it is", () => {
      const then = setScoped("session", "old", principal);
      set("of:a", "old");
      setScoped("session", "new", principal);
      set("of:a", "new");

      restore({ sourceSeq: then });

      expect(valueOf("of:a")).toBeUndefined();
      expect(scopedValue("session", principal)).toBe("new");
    });

    it("leaves the serving loop's event logs, watermark, effect index and attention index as they are", () => {
      const records = [
        streamEntriesDocId({ id: "of:poll", path: ["votes"] }),
        SERVER_EXECUTION_WATERMARK_DOC_ID,
        SERVER_EXECUTION_EFFECTS_DOC_ID,
        SERVER_EXECUTION_ATTENTION_DOC_ID,
      ];
      const record = (id: string, value: string) =>
        applyCommit(engine, {
          sessionId: "server:records",
          space,
          commitClass: "system",
          commit: {
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id, value: { value } }],
          },
        });
      for (const id of records) record(id, "old");
      const then = set("of:a", "old");
      for (const id of records) record(id, "new");
      record("of:fresh-record", "new");
      set("of:a", "new");

      const commit = restore({ sourceSeq: then });

      expect(records.map((id) => valueOf(id))).toEqual(
        records.map(() => "new"),
      );
      expect(commit?.revisions.map((revision) => revision.id).toSorted())
        .toEqual(["of:a", "of:fresh-record"]);
    });

    it("restores a point below an earlier restore, to what the space held there", () => {
      const first = set("of:a", "first");
      const second = set("of:a", "second");
      set("of:a", "third");
      const earlier = restore({ sourceSeq: second });
      expect(valueOf("of:a")).toBe("second");

      const commit = restore({ sourceSeq: first });

      expect(valueOf("of:a")).toBe("first");
      expect(listCommits(engine).slice(0, 2)).toMatchObject([
        { seq: commit?.seq, restored: { branch: "", seq: first } },
        { seq: earlier?.seq, restored: { branch: "", seq: second } },
      ]);
    });

    it("restores the state an earlier restore replaced", () => {
      const first = set("of:a", "first");
      const replaced = set("of:a", "second");
      restore({ sourceSeq: first });

      restore({ sourceSeq: replaced });

      expect(valueOf("of:a")).toBe("second");
    });

    it("restores the default branch to what a fork of a fork holds, inherited documents included", () => {
      set("of:a", "default");
      set("of:b", "default");
      set("of:c", "default");
      createBranch(engine, "child");
      set("of:b", "child", "child");
      createBranch(engine, "grandchild", { parentBranch: "child" });
      set("of:b", "child, later", "child");
      set("of:c", "grandchild", "grandchild");
      set("of:a", "default, later");
      set("of:d", "only on default");

      const commit = restore({ source: "grandchild" });

      expect(valueOf("of:a")).toBe("default");
      expect(valueOf("of:b")).toBe("child");
      expect(valueOf("of:c")).toBe("grandchild");
      expect(read(engine, { id: "of:d" })).toBeNull();
      expect(listCommits(engine)[0]).toMatchObject({
        seq: commit?.seq,
        restored: { branch: "grandchild" },
      });
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

    it("throws for a source branch that does not exist, and writes nothing", () => {
      const head = set("of:a", "value");

      expect(() => restore({ source: "missing" })).toThrow(
        "unknown branch: missing",
      );
      expect(serverSeq(engine)).toBe(head);
    });

    it("throws for a seq outside the source's history", () => {
      const head = set("of:a", "value");

      expect(() => restore({ sourceSeq: head + 1 })).toThrow(
        `seq ${head + 1} is out of range for branch `,
      );
    });
  });
});
