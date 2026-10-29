/**
 * The compaction run (`compactStore`, docs/plans/compact-space.md stage 4)
 * against stores the engine built, judged through the engine reopened on
 * its output: every head reads back identical, the boundary rows are the
 * only rows the run touches, and the four protocol cases of the plan's §3
 * stay refused against the tool's own output rather than a hand transform.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { relative, toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";

import {
  applyCommit,
  close,
  COMPACTION_SESSION_PREFIX,
  ConflictError,
  createBranch,
  type Engine,
  open,
  read,
  selectCommitsSince,
} from "../v2/engine.ts";
import { readGenesisRoot, readSpaceKind } from "../v2/genesis-root.ts";
import { encodeMemoryBoundary, ProtocolError } from "../v2.ts";
import { isACL } from "../acl.ts";
import {
  type CompactionProgress,
  CompactionRefused,
  type CompactionRun,
  compactStore,
  decodeHollowedPayload,
  formatCompactionReport,
  formatCompactionRun,
  HOLLOWED_MARKER_PREFIX,
  isHollowedPayload,
  planCompaction,
  refusals,
} from "../v2/compact.ts";

const SPACE = "did:key:z6MkTestSpace";
const ACL = `of:${SPACE}`;
const A = "computed:a";
const B = "computed:b";
const C = "of:c";
const DOC = "of:doc";
const OTHER = "of:other";

const commit = (localSeq: number, extra: Record<string, unknown>) =>
  ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [],
    ...extra,
  }) as never;
const ops = (localSeq: number, operations: unknown[]) =>
  commit(localSeq, { operations });
const setOp = (id: string, value: unknown) => ({
  op: "set",
  id,
  value: { value },
});
const patchOp = (id: string, patches: unknown[]) => ({
  op: "patch",
  id,
  patches,
});

type Row = {
  id: string;
  scope_key: string;
  seq: number;
  op_index: number;
  op: string;
  data: string | null;
  commit_seq: number;
};

const rowsOf = (db: Database, id?: string): Row[] =>
  db.prepare(
    `SELECT id, scope_key, seq, op_index, op, data, commit_seq FROM revision
     WHERE branch = '' ${id === undefined ? "" : "AND id = ?"}
     ORDER BY id, scope_key, seq, op_index`,
  ).all<Row>(...(id === undefined ? [] : [id]));

type Head = {
  id: string;
  scope_key: string;
  seq: number;
  op_index: number;
  op: string;
};
const headsOf = (db: Database, includeAcl = false): Head[] =>
  db.prepare(
    `SELECT id, scope_key, seq, op_index, op FROM head
     WHERE branch = '' ${includeAcl ? "" : "AND id NOT LIKE 'of:did:%'"}
     ORDER BY id, scope_key`,
  ).all<Head>();

const compactionCommits = (db: Database) =>
  db.prepare(
    `SELECT seq, session_id, class FROM "commit" WHERE session_id LIKE ? ORDER BY seq`,
  ).all<{ seq: number; session_id: string; class: string }>(
    `${COMPACTION_SESSION_PREFIX}%`,
  );

const value = (engine: Engine, id: string): unknown =>
  read(engine, { id: id as never });

describe("compactStore", () => {
  let dir: string;
  let store: string;
  let backup: string;
  let out: string;
  let engine: Engine | undefined;
  const opened: Engine[] = [];

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "compact-write-" });
    store = `${dir}/space.sqlite`;
    backup = `${dir}/space.pre-compaction.sqlite`;
    out = `${dir}/space.compacted.sqlite`;
  });
  afterEach(async () => {
    for (const e of opened) close(e);
    opened.length = 0;
    await Deno.remove(dir, { recursive: true });
  });

  /** Builds the store with `fn`, closes it, and keeps a backup copy. */
  const build = async (
    fn: (engine: Engine) => void,
    options: { snapshotInterval?: number } = {},
  ): Promise<void> => {
    engine = await open({
      url: toFileUrl(store),
      snapshotInterval: options.snapshotInterval ?? 10,
      snapshotRetention: 2,
    });
    fn(engine);
    close(engine);
    engine = undefined;
    // The engine leaves a -wal beside the file until its last connection
    // closes; after `close` the file is whole.
    await Deno.copyFile(store, backup);
  };

  const reopen = async (path: string): Promise<Engine> => {
    const e = await open({ url: toFileUrl(path) });
    opened.push(e);
    return e;
  };

  const genesis = (e: Engine) =>
    applyCommit(e, {
      sessionId: `session:${SPACE}:genesis`,
      principal: SPACE,
      commit: commit(1, {
        operations: [setOp(ACL, { [SPACE]: "OWNER" })],
        genesisRoot: { cause: "seed" },
        spaceKind: "topics",
      }),
    } as never);

  /** The planner test's store: `computed:a` with a set and fifteen patches,
   * `computed:b` one set, `of:c` a set and two patches, after the ACL
   * genesis. */
  const standard = (e: Engine): void => {
    genesis(e);
    let local = 1;
    const apply = (operations: unknown[]) =>
      applyCommit(e, { sessionId: "s:a", commit: ops(local++, operations) });
    apply([setOp(A, { n: 0 })]);
    for (let index = 1; index <= 15; index++) {
      apply([patchOp(A, [{ op: "replace", path: "/value/n", value: index }])]);
    }
    apply([setOp(B, { n: 0 })]);
    apply([setOp(C, { n: 0 })]);
    apply([patchOp(C, [{ op: "replace", path: "/value/n", value: 1 }])]);
    apply([patchOp(C, [{ op: "replace", path: "/value/n", value: 2 }])]);
  };

  it("materializes the head, re-attributes it, deletes the history behind it, and every head reads back identical", async () => {
    await build(standard);
    const before = new Database(backup, { readonly: true });
    const headsBefore = headsOf(before);
    const aclBefore = rowsOf(before, ACL);
    expect(
      before.prepare(`SELECT count(*) AS n FROM snapshot WHERE id = ?`)
        .get<{ n: number }>(A)!.n,
    ).toBeGreaterThan(0);
    before.close();

    const run = await compactStore({
      store,
      out,
      selection: { prefixes: ["computed:"] },
      runId: "2026-10-11T00:00:00.000Z",
    });
    expect(run.instancesCompacted).toBe(1);
    expect(run.materialized).toBe(1);
    expect(run.rowsDeleted).toBe(15);
    expect(run.snapshotsDeleted).toBeGreaterThan(0);
    expect(run.acl).toEqual({ status: "marked", id: ACL });
    expect(run.report.compactionCommit).toEqual({
      seq: run.commitSeq,
      sessionId: run.sessionId,
      localSeq: 1,
    });
    expect(run.sessionId).toBe(
      `${COMPACTION_SESSION_PREFIX}2026-10-11T00:00:00.000Z`,
    );
    expect(run.outBytes).toBeGreaterThan(0);
    expect(formatCompactionRun(run)).toContain("1 compacted, 1 boundaries");

    const result = await reopen(out);
    const original = await reopen(backup);
    const db = result.database;

    // I1: every head but the ACL document's keeps its address; the
    // materialized head's op is now `set`.
    const headsAfter = headsOf(db);
    expect(headsAfter.map(({ op: _op, ...rest }) => rest)).toEqual(
      headsBefore.map(({ op: _op, ...rest }) => rest),
    );
    const changedOps = headsAfter.filter((h, i) => h.op !== headsBefore[i].op);
    expect(changedOps.map((h) => [h.id, h.op])).toEqual([[A, "set"]]);

    // The compaction commit, and exactly the rows that point at it.
    const commits = compactionCommits(db);
    expect(commits).toEqual([{
      seq: run.commitSeq,
      session_id: run.sessionId,
      class: "system",
    }]);
    expect(
      db.prepare(`SELECT head_seq FROM branch WHERE name = ''`).get<
        { head_seq: number }
      >()!.head_seq,
    ).toBe(run.commitSeq);
    const attributed = rowsOf(db).filter((r) => r.commit_seq === run.commitSeq);
    expect(attributed.map((r) => [r.id, r.seq, r.op_index, r.op])).toEqual([
      [A, headsBefore.find((h) => h.id === A)!.seq, 0, "set"],
      [ACL, run.commitSeq, 0, "set"],
    ]);
    expect(rowsOf(db, A)).toHaveLength(1);
    expect(
      db.prepare(`SELECT count(*) AS n FROM snapshot WHERE id = ?`).get<
        { n: number }
      >(A)!.n,
    ).toBe(0);

    // I7: an unselected instance keeps every row, attribution included.
    const beforeDb = original.database;
    expect(rowsOf(db, C)).toEqual(rowsOf(beforeDb, C));
    expect(rowsOf(db, B)).toEqual(rowsOf(beforeDb, B));

    // Every document reads back identical through the engine.
    for (const id of [A, B, C]) {
      expect(value(result, id)).toEqual(value(original, id));
    }

    // The ACL document: a whole-document set at the compaction commit, its
    // value an unchanged ACL, the marker beside it naming the run.
    const aclHead = headsOf(db, true).find((h) => h.id === ACL)!;
    expect(aclHead).toMatchObject({
      seq: run.commitSeq,
      op_index: 0,
      op: "set",
    });
    const acl = value(result, ACL) as Record<string, unknown>;
    expect(acl.value).toEqual(
      (value(original, ACL) as { value: unknown }).value,
    );
    expect(isACL(acl.value)).toBe(true);
    expect(acl.compaction).toMatchObject({
      lastCommitSeq: run.lastCommitSeq,
      runs: [{
        commitSeq: run.commitSeq,
        documents: "computed:",
        truncated: 1,
        runId: run.runId,
      }],
    });
    // Its history is the membership audit: the earlier rows are all there.
    expect(rowsOf(db, ACL).slice(0, aclBefore.length)).toEqual(aclBefore);
    // The run's own record is the commit's payload.
    const payload = db.prepare(`SELECT original FROM "commit" WHERE seq = ?`)
      .get<{ original: string }>(run.commitSeq)!.original;
    expect(payload).toContain('"runId"');
    expect(payload).toContain(`"sessionId":"${run.sessionId}"`);
    expect(isHollowedPayload(payload)).toBe(false);
  });

  it("keeps the rows above a bounded cut byte-identical, and materializes a boundary between two operations of one commit, with and without a snapshot at that seq", async () => {
    for (const snapshotInterval of [100, 1]) {
      const scenario = `${dir}/cut-${snapshotInterval}`;
      await Deno.mkdir(scenario);
      store = `${scenario}/space.sqlite`;
      backup = `${scenario}/backup.sqlite`;
      out = `${scenario}/out.sqlite`;
      let twoOps = 0;
      await build((e) => {
        genesis(e);
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(1, [setOp(DOC, { items: [] })]),
        });
        twoOps = applyCommit(e, {
          sessionId: "s:a",
          commit: ops(2, [
            patchOp(DOC, [{ op: "add", path: "/value/items/-", value: "a" }]),
            patchOp(DOC, [{ op: "add", path: "/value/items/-", value: "b" }]),
          ]),
        }).seq;
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(3, [
            patchOp(DOC, [{ op: "add", path: "/value/items/-", value: "c" }]),
          ]),
        });
      }, { snapshotInterval });
      const before = new Database(backup, { readonly: true });
      const snapshotsAt = before.prepare(
        `SELECT count(*) AS n FROM snapshot WHERE id = ? AND seq = ?`,
      ).get<{ n: number }>(DOC, twoOps)!.n;
      expect(snapshotsAt).toBe(snapshotInterval === 1 ? 1 : 0);
      const rowsBefore = rowsOf(before, DOC);
      before.close();

      const run = await compactStore({
        store,
        out,
        selection: { prefixes: ["of:"] },
        cut: { beforeSeq: twoOps },
      });
      expect(run.instancesCompacted).toBe(1);
      expect(run.rowsDeleted).toBe(1);

      const result = await reopen(out);
      const rowsAfter = rowsOf(result.database, DOC);
      // The boundary is the commit's first operation, now a set holding the
      // state after exactly that operation; its own (seq, op_index) stays.
      expect(rowsAfter[0]).toMatchObject({
        seq: twoOps,
        op_index: 0,
        op: "set",
        commit_seq: run.commitSeq,
      });
      expect(
        (read(result, { id: DOC as never, seq: twoOps } as never) as {
          value: { items: unknown[] };
        }).value.items,
      ).toEqual(["a", "b"]);
      // Rows above the boundary are the input's, op and attribution included.
      expect(rowsAfter.slice(1)).toEqual(
        rowsBefore.filter((r) =>
          r.seq > twoOps || (r.seq === twoOps && r.op_index > 0)
        ),
      );
      // The head is still a patch over the new base, and reads the same.
      const head = headsOf(result.database).find((h) => h.id === DOC)!;
      expect(head.op).toBe("patch");
      expect(
        (value(result, DOC) as { value: { items: unknown[] } }).value.items,
      ).toEqual(["a", "b", "c"]);
      close(opened.pop()!);
    }
  });

  describe("the four protocol cases, against the tool's output", () => {
    const seed = (e: Engine) =>
      applyCommit(e, {
        sessionId: "s:seed",
        commit: ops(1, [setOp(DOC, { x: 2, y: 3 })]),
      });
    const replace = (e: Engine, trailing: boolean) => {
      applyCommit(e, {
        sessionId: "s:b",
        commit: ops(1, [setOp(DOC, { x: 1 })]),
      });
      if (trailing) {
        applyCommit(e, {
          sessionId: "s:b",
          commit: ops(2, [
            patchOp(DOC, [{ op: "replace", path: "/value/x", value: 1 }]),
          ]),
        });
      }
    };
    const staleConfirmedPatch = (e: Engine) =>
      applyCommit(e, {
        sessionId: "s:a",
        commit: commit(1, {
          reads: { confirmed: [{ id: DOC, path: [], seq: 2 }], pending: [] },
          operations: [
            patchOp(DOC, [{ op: "add", path: "/value/x", value: 1 }]),
          ],
        }),
      });

    for (
      const [name, trailing, cut] of [
        ["a patch-headed instance", true, undefined],
        ["an instance whose boundary was already a set", false, undefined],
        ["a bounded cut that keeps rows above the boundary", true, 4],
      ] as const
    ) {
      it(`keeps refusing a confirmed read whose basis was compacted away, ${name}`, async () => {
        await build((e) => {
          genesis(e);
          seed(e);
          replace(e, trailing);
          if (cut !== undefined) {
            applyCommit(e, {
              sessionId: "s:b",
              commit: ops(3, [
                patchOp(DOC, [{ op: "replace", path: "/value/x", value: 1 }]),
              ]),
            });
          }
        });
        const original = await reopen(backup);
        expect(() => staleConfirmedPatch(original)).toThrow(ConflictError);

        await compactStore({
          store,
          out,
          selection: { prefixes: ["of:"] },
          cut: cut === undefined ? undefined : { beforeSeq: cut },
        });
        const result = await reopen(out);
        expect(() => staleConfirmedPatch(result)).toThrow(ConflictError);
        expect((value(result, DOC) as { value: unknown }).value).toEqual({
          x: 1,
        });
      });
    }

    it("keeps refusing a pending read whose basis was compacted away", async () => {
      await build((e) => {
        genesis(e);
        seed(e);
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(1, [
            patchOp(DOC, [{ op: "add", path: "/value/x", value: 2 }]),
          ]),
        });
        replace(e, true);
      });
      const stalePending = (e: Engine) =>
        applyCommit(e, {
          sessionId: "s:a",
          commit: commit(2, {
            reads: {
              confirmed: [],
              pending: [{ id: DOC, path: [], basisSeq: 2, localSeq: [1] }],
            },
            operations: [
              patchOp(DOC, [{ op: "add", path: "/value/x", value: 1 }]),
            ],
          }),
        });
      const original = await reopen(backup);
      expect(() => stalePending(original)).toThrow(ConflictError);
      await compactStore({ store, out, selection: { prefixes: ["of:"] } });
      const result = await reopen(out);
      expect(() => stalePending(result)).toThrow(ConflictError);
    });

    it("keeps refusing a pending read crossing compacted foreign writes", async () => {
      await build((e) => {
        genesis(e);
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(1, [setOp(DOC, { p: 0, q: 0 })]),
        });
        applyCommit(e, {
          sessionId: "s:b",
          commit: ops(1, [
            patchOp(DOC, [{ op: "replace", path: "/value/p", value: 1 }]),
          ]),
        });
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(2, [
            patchOp(DOC, [{ op: "replace", path: "/value/q", value: 1 }]),
          ]),
        });
      });
      // Session a reads p over its own layers 1 and 2 from basis 0 — which
      // never saw b's write — and derives a document from what it read.
      const derive = (e: Engine) =>
        applyCommit(e, {
          sessionId: "s:a",
          commit: commit(3, {
            reads: {
              confirmed: [],
              pending: [{
                id: DOC,
                path: ["value", "p"],
                basisSeq: 0,
                localSeq: [1, 2],
              }],
            },
            operations: [setOp(OTHER, { sawP: 0 })],
          }),
        });
      const original = await reopen(backup);
      expect(() => derive(original)).toThrow(ConflictError);
      await compactStore({ store, out, selection: { prefixes: ["of:"] } });
      const result = await reopen(out);
      expect(() => derive(result)).toThrow(ConflictError);
      expect(value(result, OTHER)).toBeNull();
    });

    it("never applies an old resubmission as a fresh mutation once its payload is hollowed", async () => {
      await build((e) => {
        genesis(e);
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(1, [setOp(DOC, { n: 1 })]),
        });
        applyCommit(e, {
          sessionId: "s:b",
          commit: ops(1, [
            patchOp(DOC, [{ op: "replace", path: "/value/n", value: 2 }]),
          ]),
        });
      });
      const resubmit = (e: Engine) =>
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(1, [setOp(DOC, { n: 1 })]),
        });
      const original = await reopen(backup);
      expect(resubmit(original)).toMatchObject({ seq: 2, replayed: true });

      // A zero window: every commit but the genesis is outside it.
      const phases: CompactionProgress["phase"][] = [];
      const run = await compactStore({
        store,
        out,
        selection: { prefixes: ["of:"] },
        keepPayloadsMs: 0,
        onProgress: (progress) => phases.push(progress.phase),
      });
      expect(run.hollowed).toBe(2);
      expect(phases).toEqual(["planned", "instance", "hollowing", "vacuum"]);
      const result = await reopen(out);
      const payloads = result.database.prepare(
        `SELECT seq, original FROM "commit" ORDER BY seq`,
      ).all<{ seq: number; original: string }>();
      expect(payloads.map((row) => [row.seq, isHollowedPayload(row.original)]))
        .toEqual([[1, false], [2, true], [3, true], [run.commitSeq, false]]);
      const marker = decodeHollowedPayload(payloads[1].original)!;
      expect(marker).toMatchObject({
        commitSeq: run.commitSeq,
        runId: run.runId,
      });
      expect(marker.hash).toHaveLength(43);
      expect(HOLLOWED_MARKER_PREFIX.startsWith("fvj1:")).toBe(true);

      expect(() => resubmit(result)).toThrow(ProtocolError);
      expect(() => resubmit(result)).toThrow("replay mismatch");
      expect((value(result, DOC) as { value: unknown }).value).toEqual({
        n: 2,
      });
    });

    it("answers a resubmission inside the payload window from its stored result, with every operation elided", async () => {
      await build((e) => {
        genesis(e);
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(1, [setOp(DOC, { n: 1 })]),
        });
        applyCommit(e, {
          sessionId: "s:b",
          commit: ops(1, [
            patchOp(DOC, [{ op: "replace", path: "/value/n", value: 2 }]),
          ]),
        });
      });
      const run = await compactStore({
        store,
        out,
        selection: { prefixes: ["of:"] },
      });
      expect(run.hollowed).toBe(0);
      const result = await reopen(out);
      const replayed = applyCommit(result, {
        sessionId: "s:b",
        commit: ops(1, [
          patchOp(DOC, [{ op: "replace", path: "/value/n", value: 2 }]),
        ]),
      });
      expect(replayed).toMatchObject({
        seq: 3,
        replayed: true,
        elidedOpIndexes: [0],
      });
    });
  });

  it("keeps the genesis receipt, the op_*-referenced payloads, and the feed's view of the compaction commit", async () => {
    await build((e) => {
      standard(e);
      // A row referencing commit 3's payload the way an operation table does.
      e.database.exec(
        `INSERT INTO op_checkpoint (branch, id, scope_key, path, epoch, version, materialized, commit_seq)
         VALUES ('', 'computed:a', 'space', '[]', 1, 1, '{}', 3)`,
      );
    });
    const original = await reopen(backup);
    const run = await compactStore({
      store,
      out,
      selection: { prefixes: ["computed:"] },
      keepPayloadsMs: 0,
    });
    const result = await reopen(out);
    const payloads = result.database.prepare(
      `SELECT seq, original FROM "commit" ORDER BY seq`,
    ).all<{ seq: number; original: string }>();
    const intact = payloads.filter((row) => !isHollowedPayload(row.original))
      .map((row) => row.seq);
    expect(intact).toEqual([1, 3, run.commitSeq]);
    expect(run.hollowed).toBe(payloads.length - 3);
    expect(payloads[0].original).toBe(
      original.database.prepare(`SELECT original FROM "commit" WHERE seq = 1`)
        .get<{ original: string }>()!.original,
    );
    expect(readGenesisRoot(result)).toEqual(readGenesisRoot(original));
    expect(readGenesisRoot(result)).toEqual({ cause: "seed" });
    expect(readSpaceKind(result)).toBe("topics");

    // I4's stated cost: a feed read spanning the compaction commit lists
    // every compacted instance, and the ACL document, as its writes.
    const feed = selectCommitsSince(result, { fromSeq: run.commitSeq - 1 });
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      seq: run.commitSeq,
      class: "system",
      sessionId: run.sessionId,
    });
    expect(feed[0].writes.map((w) => w.id).sort()).toEqual([A, ACL].sort());
  });

  it("takes the store and the result as paths relative to the working directory", async () => {
    await build(standard);
    const run = await compactStore({
      store: relative(Deno.cwd(), store),
      selection: { prefixes: ["computed:"] },
    });
    expect(run.out).toBe(`${store}.compacted.sqlite`);
    expect((await Deno.stat(run.out)).size).toBeGreaterThan(0);
  });

  it("writes no ACL revision when the store has no ACL document", async () => {
    await build((e) => {
      let local = 1;
      applyCommit(e, {
        sessionId: "s:a",
        commit: ops(local++, [setOp(A, { n: 0 })]),
      });
      applyCommit(e, {
        sessionId: "s:a",
        commit: ops(local++, [
          patchOp(A, [{ op: "replace", path: "/value/n", value: 1 }]),
        ]),
      });
    });
    const run = await compactStore({
      store,
      out,
      selection: { prefixes: ["computed:"] },
    });
    expect(run.acl).toEqual({ status: "absent" });
    const result = await reopen(out);
    expect(
      result.database.prepare(
        `SELECT count(*) AS n FROM revision WHERE id LIKE 'of:did:%'`,
      )
        .get<{ n: number }>()!.n,
    ).toBe(0);
    expect(
      rowsOf(result.database).filter((r) => r.commit_seq === run.commitSeq),
    )
      .toHaveLength(1);
    expect(formatCompactionRun(run)).toContain("no ACL document");
  });

  it("leaves a tombstoned ACL document as it is", async () => {
    await build((e) => {
      standard(e);
      applyCommit(e, {
        sessionId: `session:${SPACE}:genesis`,
        principal: SPACE,
        commit: ops(2, [{ op: "delete", id: ACL }]),
      } as never);
    });
    const run = await compactStore({
      store,
      out,
      selection: { prefixes: ["computed:"] },
    });
    expect(run.acl).toEqual({ status: "deleted", id: ACL });
    const result = await reopen(out);
    expect(value(result, ACL)).toBeNull();
    expect(headsOf(result.database, true).find((h) => h.id === ACL))
      .toMatchObject({
        op: "delete",
      });
    expect(
      rowsOf(result.database).filter((r) => r.commit_seq === run.commitSeq),
    ).toHaveLength(1);
    expect(formatCompactionRun(run)).toContain("tombstone");
  });

  it("resumes an interrupted run to the same result, with two compaction commits", async () => {
    const build3 = (e: Engine) => {
      genesis(e);
      let local = 1;
      for (const id of [A, B, "computed:c"]) {
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(local++, [setOp(id, { n: 0 })]),
        });
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(local++, [
            patchOp(id, [{ op: "replace", path: "/value/n", value: 1 }]),
          ]),
        });
      }
      // The client commits are an hour old, as a store's are by the time a
      // run reaches it, so the interrupted run's compaction commit is created
      // after the cutoff of a zero window.
      e.database.exec(
        `UPDATE "commit" SET created_at = datetime(created_at, '-1 hour')`,
      );
    };
    await build(build3);
    const twin = `${dir}/twin.sqlite`;
    await Deno.copyFile(backup, twin);
    const twinOut = `${dir}/twin.compacted.sqlite`;
    const whole = await compactStore({
      store: twin,
      out: twinOut,
      selection: { prefixes: ["computed:"] },
      keepPayloadsMs: 0,
      runId: "whole",
    });
    expect(whole.instancesCompacted).toBe(3);

    const stop = new Error("stop after the first instance");
    await expect(compactStore({
      store,
      out,
      selection: { prefixes: ["computed:"] },
      keepPayloadsMs: 0,
      runId: "first",
      onProgress: (progress) => {
        if (progress.phase === "instance" && progress.completed === 1) {
          throw stop;
        }
      },
    })).rejects.toBe(stop);
    expect(await Deno.stat(out).catch(() => undefined)).toBeUndefined();
    // The interrupted store is one every reader can use: the first instance
    // is compacted, the others are as they were.
    const partial = await reopen(store);
    expect(compactionCommits(partial.database)).toHaveLength(1);
    expect(rowsOf(partial.database, A)).toHaveLength(1);
    expect(rowsOf(partial.database, B)).toHaveLength(2);
    close(opened.pop()!);

    const second = await compactStore({
      store,
      out,
      selection: { prefixes: ["computed:"] },
      keepPayloadsMs: 0,
      runId: "second",
    });
    expect(second.instancesCompacted).toBe(2);
    expect(second.report.payloads.alreadyHollowed).toBe(0);
    expect(second.report.payloads.insideWindow).toBe(0);
    expect(second.report.payloads.exemptCompaction).toBe(1);
    expect(formatCompactionReport(second.report)).toContain(
      "earlier runs' commits keep 1",
    );

    const resumed = await reopen(out);
    const uninterrupted = await reopen(twinOut);
    expect(compactionCommits(resumed.database).map((c) => c.session_id))
      .toEqual([
        `${COMPACTION_SESSION_PREFIX}first`,
        `${COMPACTION_SESSION_PREFIX}second`,
      ]);
    expect(headsOf(resumed.database)).toEqual(headsOf(uninterrupted.database));
    for (const id of [A, B, "computed:c", ACL]) {
      const left = value(resumed, id) as Record<string, unknown>;
      const right = value(uninterrupted, id) as Record<string, unknown>;
      if (id === ACL) {
        expect(left.value).toEqual(right.value);
        expect((left.compaction as { runs: unknown[] }).runs).toHaveLength(1);
      } else {
        expect(left).toEqual(right);
      }
    }
    // The same rows, each attributed to a compaction commit where the
    // uninterrupted run's are, and hollowed where its are.
    const shape = (db: Database) =>
      rowsOf(db).filter((r) => r.id !== ACL).map((r) => ({
        ...r,
        commit_seq: compactionCommits(db).some((c) => c.seq === r.commit_seq)
          ? "compaction"
          : r.commit_seq,
      }));
    expect(shape(resumed.database)).toEqual(shape(uninterrupted.database));
    const hollowedSeqs = (db: Database) =>
      db.prepare(`SELECT seq, original FROM "commit"`).all<
        { seq: number; original: string }
      >().filter((row) => isHollowedPayload(row.original)).map((row) =>
        row.seq
      );
    expect(hollowedSeqs(resumed.database)).toEqual(
      hollowedSeqs(uninterrupted.database),
    );
    expect(whole.hollowed).toBe(second.hollowed + 0);
  });

  describe("refusals", () => {
    it("refuses a store with a second branch, a result that exists, a log beside the store, and a missing store", async () => {
      await build((e) => {
        standard(e);
        createBranch(e, "fork" as never);
      });
      await expect(
        compactStore({ store, out, selection: { prefixes: ["computed:"] } }),
      )
        .rejects.toThrow(CompactionRefused);
      await expect(
        compactStore({ store, out, selection: { prefixes: ["computed:"] } }),
      )
        .rejects.toThrow("second branch");

      await Deno.writeTextFile(out, "");
      await expect(
        compactStore({
          store: backup,
          out,
          selection: { prefixes: ["computed:"] },
        }),
      )
        .rejects.toThrow("never overwritten");
      await Deno.remove(out);
      // A symlink whose target does not exist is still something at the
      // path, and the result would be written through it.
      await Deno.symlink(`${dir}/nowhere.sqlite`, out);
      await expect(
        compactStore({
          store: backup,
          out,
          selection: { prefixes: ["computed:"] },
        }),
      ).rejects.toThrow("never overwritten");
      await Deno.remove(out);

      await Deno.writeTextFile(`${backup}-wal`, "not empty");
      await expect(
        compactStore({
          store: backup,
          out,
          selection: { prefixes: ["computed:"] },
        }),
      )
        .rejects.toThrow("-wal is not empty");
      await Deno.remove(`${backup}-wal`);

      await expect(
        compactStore({
          store: `${dir}/missing.sqlite`,
          out,
          selection: { prefixes: ["computed:"] },
        }),
      )
        .rejects.toThrow("no store");
      // Nothing was written by any refusal.
      expect(await Deno.stat(out).catch(() => undefined)).toBeUndefined();
    });

    it("refuses a store holding two ACL documents", async () => {
      await build((e) => {
        standard(e);
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(99, [setOp("of:did:key:z6MkOtherSpace", { x: "OWNER" })]),
        });
      });
      await expect(
        compactStore({ store, out, selection: { prefixes: ["computed:"] } }),
      ).rejects.toThrow("2 ACL documents");
    });

    it("names every reason a planned run must not write", async () => {
      await build(standard);
      const db = new Database(backup, { readonly: true });
      const report = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
      });
      db.close();
      expect(refusals(report)).toEqual([]);
      const broken = {
        ...report,
        preconditions: {
          ...report.preconditions,
          missingTables: ["branch"],
          singleBranch: false,
          branches: ["fork"],
          genesisPresent: false,
          foreignKeyViolations: 2,
        },
      };
      const reasons = refusals(broken);
      expect(reasons).toHaveLength(4);
      expect(reasons[0]).toContain("lacks branch");
      expect(reasons[1]).toContain("second branch (fork)");
      expect(reasons[2]).toContain("no commit 1");
      expect(reasons[3]).toContain("2 violation(s)");
    });

    it("refuses a store the engine would migrate on opening, leaving it untouched", async () => {
      // A current store with one column the engine added since and one
      // index it declares: `open` would add both back. The refusal must come
      // from the read-only preflight, before anything can.
      await build(standard);
      const db = new Database(store);
      db.exec(`ALTER TABLE "commit" DROP COLUMN holder`);
      db.exec(`DROP INDEX idx_head_live_entity_ids`);
      db.close();
      const before = await Deno.readFile(store);
      const refusal = compactStore({
        store,
        out,
        selection: { prefixes: ["computed:"] },
      });
      await expect(refusal).rejects.toThrow(CompactionRefused);
      await refusal.catch((error: Error) => {
        expect(error.message).toContain("commit has no holder column");
        expect(error.message).toContain("lacks index idx_head_live_entity_ids");
        expect(error.message).toContain("predates a migration");
      });
      expect(await Deno.readFile(store)).toEqual(before);
      expect(await Deno.stat(out).catch(() => undefined)).toBeUndefined();

      // A legacy scheduler table the engine drops: refused the same way.
      const legacy = new Database(backup);
      legacy.exec(`CREATE TABLE scheduler_observation (x INTEGER)`);
      legacy.close();
      await expect(
        compactStore({
          store: backup,
          out,
          selection: { prefixes: ["computed:"] },
        }),
      ).rejects.toThrow("legacy table(s) scheduler_observation");
    });

    it("stops when the store changed between the plan and the write", async () => {
      // The plan is published after the read-only connection closes and
      // before the engine opens; a writer slipping in there is what the
      // guards below are for. Each case tampers from the `planned` hook.
      const tamper = (sql: string) =>
        compactStore({
          store,
          out,
          selection: { prefixes: ["computed:"] },
          onProgress: (progress) => {
            if (progress.phase !== "planned") return;
            const db = new Database(store);
            db.exec(sql);
            db.close();
          },
        });
      // Each case starts from its own store: `build` opens the path it is
      // given, and a store a refused run left behind is not the fixture.
      const fresh = async (fn: (e: Engine) => void) => {
        for (const path of [store, backup, out]) {
          await Deno.remove(path).catch(() => {});
        }
        await build(fn);
      };
      // A commit appended: the next seq is no longer the plan's.
      await fresh(standard);
      await expect(tamper(
        `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
         SELECT seq + 1, 'late', 1, original, resolution FROM "commit" WHERE seq = (SELECT MAX(seq) FROM "commit")`,
      )).rejects.toThrow("the store changed since it was planned");
      // The planned patch boundary gone: the engine's reconstruction is the
      // first to notice. The same boundary rewritten as a set: the run's own
      // guard is.
      await fresh(standard);
      await expect(tamper(
        `DELETE FROM revision WHERE id = '${A}' AND seq = (SELECT seq FROM head WHERE id = '${A}')`,
      )).rejects.toThrow("no revision of");
      await fresh(standard);
      await expect(tamper(
        `UPDATE revision SET op = 'set', data = '${
          encodeMemoryBoundary({ value: { n: 15 } } as never)
        }' WHERE id = '${A}' AND seq = (SELECT seq FROM head WHERE id = '${A}')`,
      )).rejects.toThrow("the planned patch boundary");
      // A planned set boundary rewritten as a patch.
      await fresh((e) => {
        standard(e);
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(60, [setOp(A, { n: 99 })]),
        });
      });
      await expect(tamper(
        `UPDATE revision SET op = 'patch', data = '[]' WHERE id = '${A}' AND seq = (SELECT seq FROM head WHERE id = '${A}')`,
      )).rejects.toThrow("the planned set boundary");
    });

    it("names a column declared differently from the engine's", async () => {
      await build(standard);
      // `branch.status` redeclared with another default: the same name and
      // type, so only the declaration comparison can tell.
      const db = new Database(store);
      db.exec(`
        CREATE TABLE branch_redeclared (
          name TEXT NOT NULL PRIMARY KEY, parent_branch TEXT, fork_seq INTEGER,
          created_seq INTEGER NOT NULL DEFAULT 0, head_seq INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'live', created_at TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at TEXT, FOREIGN KEY (parent_branch) REFERENCES branch_redeclared(name));
        INSERT INTO branch_redeclared SELECT * FROM branch;
        DROP TABLE branch;
        ALTER TABLE branch_redeclared RENAME TO branch;`);
      db.close();
      await expect(
        compactStore({ store, out, selection: { prefixes: ["computed:"] } }),
      ).rejects.toThrow(
        "branch.status is declared TEXT NOT NULL DEFAULT 'live' where the engine declares TEXT NOT NULL DEFAULT 'active'",
      );
    });

    it("refuses an ACL document whose value is not an ACL", async () => {
      await build((e) => {
        standard(e);
        applyCommit(e, {
          sessionId: "s:a",
          commit: ops(50, [setOp(ACL, { "not a did": "OWNER" })]),
        });
      });
      await expect(
        compactStore({ store, out, selection: { prefixes: ["computed:"] } }),
      ).rejects.toThrow("not an ACL");
    });

    it("refuses a store from before the per-scope migration without opening it for writing", async () => {
      const legacy = new Database(store, { create: true });
      legacy.exec(`
CREATE TABLE "commit" (seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL, original JSON NOT NULL,
  resolution JSON NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE revision (branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, seq, op_index));
CREATE TABLE head (branch TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, PRIMARY KEY (branch, id));
INSERT INTO "commit" (seq, session_id, local_seq, original, resolution) VALUES (1, 's', 1, '{}', '{}');
INSERT INTO revision (id, seq, op_index, op, data, commit_seq) VALUES ('computed:x', 1, 0, 'set', '{"value":1}', 1);
INSERT INTO head (branch, id, seq, op_index) VALUES ('', 'computed:x', 1, 0);`);
      legacy.close();
      const before = await Deno.stat(store);
      await expect(
        compactStore({ store, out, selection: { prefixes: ["computed:"] } }),
      )
        .rejects.toThrow("predates a migration");
      expect((await Deno.stat(store)).mtime?.getTime()).toBe(
        before.mtime?.getTime(),
      );
    });
  });
});

/** Type-level use of the run shape, so a field renamed here fails the check. */
const _shape = (run: CompactionRun): number => run.commitSeq + run.hollowed;
