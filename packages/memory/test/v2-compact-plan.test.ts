/**
 * The compaction planner against stores the engine built, checked against
 * counts taken by hand from the same tables.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";

import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import { planCompaction } from "../v2/compact.ts";

const A = "computed:a";
const B = "computed:b";
const C = "of:c";
const ACL = "of:did:key:z6MkTestSpace";

const commit = (localSeq: number, operations: unknown[]) =>
  ({ localSeq, reads: { confirmed: [], pending: [] }, operations }) as never;

/**
 * `computed:a`: a set and fifteen patches (two snapshots at interval 10 and
 * retention 2 — the engine writes one every ten patches since the base or
 * the newest snapshot). `computed:b`: one set. `of:c`: a set and two
 * patches. The ACL document: one set, never selected.
 */
const build = (engine: Engine): void => {
  let local = 1;
  const apply = (operations: unknown[]) =>
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(local++, operations),
    });
  apply([{
    op: "set",
    id: ACL,
    value: { value: { owners: ["did:key:z6MkTestSpace"] } },
  }]);
  apply([{ op: "set", id: A, value: { value: { n: 0 } } }]);
  for (let index = 1; index <= 15; index++) {
    apply([{
      op: "patch",
      id: A,
      patches: [{ op: "replace", path: "/value/n", value: index }],
    }]);
  }
  apply([{ op: "set", id: B, value: { value: { n: 0 } } }]);
  apply([{ op: "set", id: C, value: { value: { n: 0 } } }]);
  apply([{
    op: "patch",
    id: C,
    patches: [{ op: "replace", path: "/value/n", value: 1 }],
  }]);
  apply([{
    op: "patch",
    id: C,
    patches: [{ op: "replace", path: "/value/n", value: 2 }],
  }]);
};

const withStore = async (
  fn: (db: Database, engine: Engine) => void,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({
    url: toFileUrl(path),
    snapshotInterval: 10,
    snapshotRetention: 2,
  });
  try {
    build(engine);
    fn(engine.database, engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

/** Rows and bytes of `id` strictly before `(seq, opIndex)`, by hand. */
const behind = (db: Database, id: string, seq: number, opIndex: number) =>
  db.prepare(
    `SELECT count(*) AS n, COALESCE(sum(length(data)), 0) AS bytes FROM revision
     WHERE id = ? AND (seq < ? OR (seq = ? AND op_index < ?))`,
  ).get<{ n: number; bytes: number }>(id, seq, seq, opIndex)!;

const head = (db: Database, id: string) =>
  db.prepare(`SELECT seq, op_index, op FROM head WHERE id = ?`)
    .get<{ seq: number; op_index: number; op: string }>(id)!;

describe("planCompaction", () => {
  it("cuts every selected instance at its head by default", async () => {
    await withStore((db) => {
      const report = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
      });

      expect(report.instances).toEqual({
        matched: 2,
        truncated: 1,
        materialized: 1,
        headOpChanges: 1,
      });
      const a = head(db, A);
      expect(a.op).toBe("patch");
      const hand = behind(db, A, a.seq, a.op_index);
      expect(hand.n).toBe(15);
      expect(report.revisions).toEqual({
        rowsDeleted: hand.n,
        bytesDeleted: hand.bytes,
      });
      const snapshots = db.prepare(
        `SELECT count(*) AS n, COALESCE(sum(length(value)), 0) AS bytes FROM snapshot WHERE id = ?`,
      ).get<{ n: number; bytes: number }>(A)!;
      expect(snapshots.n).toBeGreaterThan(0);
      expect(report.snapshots).toEqual({
        rowsDeleted: snapshots.n,
        bytesDeleted: snapshots.bytes,
      });
      expect(report.largest.map((plan) => plan.id)).toEqual([A]);
      expect(report.largest[0].boundary).toEqual({
        seq: a.seq,
        opIndex: a.op_index,
        op: "patch",
      });
      expect(report.preconditions).toMatchObject({
        singleBranch: true,
        genesisPresent: true,
        opTableRows: 0,
      });
      expect(report.compactionCommit.seq).toBe(
        db.prepare(`SELECT MAX(seq) + 1 AS seq FROM "commit"`).get<
          { seq: number }
        >()!.seq,
      );
      expect(report.compactionCommit.sessionId.startsWith("compaction:")).toBe(
        true,
      );
    });
  });

  it("never selects the ACL document, whatever the prefix", async () => {
    await withStore((db) => {
      const report = planCompaction(db, { selection: { prefixes: ["of:"] } });
      expect(report.instances.matched).toBe(1);
      expect(report.largest.map((plan) => plan.id)).toEqual([C]);
    });
  });

  it("keeps the newest n rows under --keep-last, materializing the oldest kept patch", async () => {
    await withStore((db) => {
      const report = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
        cut: { keepLast: 3 },
      });
      const a = head(db, A);
      const third = db.prepare(
        `SELECT seq, op_index FROM revision WHERE id = ? ORDER BY seq DESC, op_index DESC LIMIT 1 OFFSET 2`,
      ).get<{ seq: number; op_index: number }>(A)!;
      const hand = behind(db, A, third.seq, third.op_index);
      expect(hand.n).toBe(13);
      expect(report.revisions.rowsDeleted).toBe(13);
      expect(report.instances).toEqual({
        matched: 2,
        truncated: 1,
        materialized: 1,
        headOpChanges: 0,
      });
      expect(report.largest[0].boundary).toEqual({
        seq: third.seq,
        opIndex: third.op_index,
        op: "patch",
      });
      expect(report.largest[0].headSeq).toBe(a.seq);
    });
  });

  it("keeps rows at or above --before-seq, and keeps a head below it", async () => {
    await withStore((db) => {
      const fifth = db.prepare(
        `SELECT seq FROM revision WHERE id = ? ORDER BY seq ASC LIMIT 1 OFFSET 5`,
      ).get<{ seq: number }>(A)!.seq;
      const report = planCompaction(db, {
        selection: { prefixes: ["computed:", "of:"] },
        cut: { beforeSeq: fifth },
      });
      // computed:a loses its set and four patches; of:c, entirely above the
      // cut, loses nothing; computed:b has one row.
      expect(report.instances).toEqual({
        matched: 3,
        truncated: 1,
        materialized: 1,
        headOpChanges: 0,
      });
      expect(report.revisions.rowsDeleted).toBe(5);
      expect(report.largest[0].boundary.seq).toBe(fifth);
      // A cut above every row of of:c keeps its head, which is never deleted.
      const far = planCompaction(db, {
        selection: { prefixes: ["of:"] },
        cut: { beforeSeq: 10_000 },
      });
      const c = head(db, C);
      expect(far.largest[0].boundary).toEqual({
        seq: c.seq,
        opIndex: c.op_index,
        op: "patch",
      });
      expect(far.revisions.rowsDeleted).toBe(2);
    });
  });

  it("accounts for payloads outside the window, exempting the genesis receipt", async () => {
    await withStore((db) => {
      const commits =
        db.prepare(`SELECT count(*) AS n FROM "commit"`).get<{ n: number }>()!
          .n;
      const everything = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
        keepPayloadsMs: 0,
      });
      // Every commit was created in the same second, so a window of zero puts
      // all of them outside it; commit 1 is the genesis and stays.
      expect(everything.payloads.commits).toBe(commits);
      expect(everything.payloads.insideWindow).toBe(0);
      expect(everything.payloads.exemptGenesis).toBe(1);
      const owning = db.prepare(
        `SELECT count(DISTINCT r.commit_seq) AS n FROM revision r JOIN head h
         ON h.id = r.id AND h.scope_key = r.scope_key AND h.seq = r.seq AND h.op_index = r.op_index
         WHERE r.commit_seq <> 1`,
      ).get<{ n: number }>()!.n;
      expect(everything.payloads.hollowed.owningHead.commits).toBe(owning);
      expect(everything.payloads.hollowed.headless.commits).toBe(
        commits - 1 - owning,
      );
      expect(
        everything.payloads.hollowed.owningHead.bytes +
          everything.payloads.hollowed.headless.bytes,
      )
        .toBe(
          db.prepare(
            `SELECT sum(length(original)) AS b FROM "commit" WHERE seq <> 1`,
          ).get<{ b: number }>()!.b,
        );

      const nothing = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
        keepPayloadsMs: 60_000,
      });
      expect(nothing.payloads.insideWindow).toBe(commits);
      expect(
        nothing.payloads.hollowed.owningHead.commits +
          nothing.payloads.hollowed.headless.commits,
      ).toBe(0);
    });
  });
});
