/**
 * The compaction planner against stores the engine built, checked against
 * counts taken by hand from the same tables.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";

import {
  applyCommit,
  close,
  COMPACTION_SESSION_PREFIX,
  type Engine,
  open,
} from "../v2/engine.ts";
import {
  type CompactionReport,
  formatCompactionReport,
  normalizePrefixes,
  planCompaction,
} from "../v2/compact.ts";

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
  // Non-ASCII content throughout, so a count of characters and a count of
  // stored bytes cannot agree by accident.
  apply([{
    op: "set",
    id: A,
    value: { value: { n: 0, note: "ünïcödé — ✓" } },
  }]);
  for (let index = 1; index <= 15; index++) {
    apply([{
      op: "patch",
      id: A,
      patches: [{ op: "replace", path: "/value/n", value: index }, {
        op: "replace",
        path: "/value/note",
        value: `ünïcödé ${index} ✓`,
      }],
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
    `SELECT count(*) AS n, COALESCE(sum(length(CAST(data AS BLOB))), 0) AS bytes
     FROM revision WHERE id = ? AND (seq < ? OR (seq = ? AND op_index < ?))`,
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
        `SELECT count(*) AS n, COALESCE(sum(length(CAST(value AS BLOB))), 0) AS bytes
         FROM snapshot WHERE id = ?`,
      ).get<{ n: number; bytes: number }>(A)!;
      expect(snapshots.n).toBeGreaterThan(0);
      // Stored bytes, not characters: the fixture's content makes them differ.
      const characters = db.prepare(
        `SELECT sum(length(value)) AS n FROM snapshot WHERE id = ?`,
      ).get<{ n: number }>(A)!.n;
      expect(snapshots.bytes).toBeGreaterThan(characters);
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
      expect(report.compactionCommit.localSeq).toBe(1);
      expect(report.preconditions).toMatchObject({
        singleBranch: true,
        genesisPresent: true,
        foreignKeyViolations: 0,
        opTableRows: 0,
        missingTables: [],
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
      // A window of zero ends at the newest commit's `created_at`, which no
      // commit is later than, so all of them are outside it; commit 1 is the
      // genesis and stays.
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
            `SELECT sum(length(CAST(original AS BLOB))) AS b FROM "commit" WHERE seq <> 1`,
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

  it("counts an earlier run's compaction commit as exempt whichever side of the cutoff it was created on", async () => {
    await withStore((db) => {
      const clients =
        db.prepare(`SELECT count(*) AS n FROM "commit"`).get<{ n: number }>()!
          .n;
      const newest =
        db.prepare(`SELECT MAX(created_at) AS at FROM "commit"`).get<
          { at: string }
        >()!.at;
      // Two earlier runs' commits, their `created_at` written out: one in the
      // newest client commit's own second, one an hour after it.
      const insert = db.prepare(
        `INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution, class, created_at)
         VALUES (?, '', ?, 1, '{}', '{}', 'system', datetime(?, ?))`,
      );
      insert.run(
        clients + 1,
        `${COMPACTION_SESSION_PREFIX}same-second`,
        newest,
        "+0 seconds",
      );
      insert.run(
        clients + 2,
        `${COMPACTION_SESSION_PREFIX}later`,
        newest,
        "+1 hour",
      );

      const zero = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
        keepPayloadsMs: 0,
      });
      expect(zero.payloads.cutoffAt).toBe(newest);
      expect(zero.payloads.commits).toBe(clients + 2);
      expect(zero.payloads.exemptCompaction).toBe(2);
      expect(zero.payloads.insideWindow).toBe(0);
      const text = formatCompactionReport(zero);
      expect(text).toContain("window keeps 0 (created after");
      expect(text).toContain("earlier runs' commits keep 2");

      // A window reaching back past every commit keeps the client commits,
      // and counts no compaction commit among them.
      const wide = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
        keepPayloadsMs: 60 * 60 * 1000,
      });
      expect(wide.payloads.exemptCompaction).toBe(2);
      expect(wide.payloads.insideWindow).toBe(clients);
    });
  });

  it("counts an instance once however many prefixes select it", async () => {
    await withStore((db) => {
      const once = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
      });
      const twice = planCompaction(db, {
        selection: {
          prefixes: ["computed:", "computed:a", "computed:", "computed:a"],
        },
      });
      expect(twice.instances).toEqual(once.instances);
      expect(twice.revisions).toEqual(once.revisions);
      expect(twice.snapshots).toEqual(once.snapshots);
      expect(twice.largest.map((plan) => plan.id)).toEqual([A]);
      expect(normalizePrefixes(["of:", "of:c", "computed:", "of:"])).toEqual([
        "of:",
        "computed:",
      ]);
    });
  });

  it("refuses options it cannot read as intended, by name", async () => {
    await withStore((db) => {
      const plan = (extra: Record<string, unknown>) => () =>
        planCompaction(
          db,
          { selection: { prefixes: ["computed:"] }, ...extra } as never,
        );
      expect(plan({ cut: { before: "2026-10-09T10:30:00Z" } })).toThrow(
        "before",
      );
      expect(plan({ cut: { before: "not-a-date" } })).toThrow("before");
      expect(plan({ cut: { before: "2026-13-45 99:99:99" } })).toThrow(
        "before",
      );
      expect(plan({ cut: { keepLast: -1 } })).toThrow("keepLast");
      expect(plan({ cut: { beforeSeq: 1.5 } })).toThrow("beforeSeq");
      expect(plan({ keepPayloadsMs: -5 })).toThrow("keepPayloadsMs");
      expect(() => planCompaction(db, { selection: { prefixes: [] } })).toThrow(
        "prefix",
      );
      // The canonical spelling of the same instant is accepted.
      expect(plan({ cut: { before: "2026-10-09 10:30:00" } })).not.toThrow();
    });
  });

  it("reports a foreign-key violation as a failed precondition", async () => {
    await withStore((db) => {
      db.exec(`PRAGMA foreign_keys = OFF`);
      db.exec(
        `INSERT INTO revision (branch, id, scope_key, seq, op_index, op, data, commit_seq)
         VALUES ('', 'of:dangling', 'space', 999, 0, 'set', '{"value":1}', 999)`,
      );
      db.exec(`PRAGMA foreign_keys = ON`);
      const report = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
      });
      expect(report.preconditions.foreignKeyViolations).toBe(1);
    });
  });

  it("restricts the selection to one scope kind", async () => {
    await withStore((db) => {
      // Per-user and per-session instances of a computed id, as rows: the
      // planner reads the tables, and a scope key is a column to it.
      const seq = db.prepare(`SELECT MAX(seq) AS seq FROM "commit"`).get<
        { seq: number }
      >()!.seq;
      for (
        const [scopeKey, index] of [["user:did:key:zU", 0], [
          "session:did:key:zU:s1",
          1,
        ]] as const
      ) {
        db.exec(
          `INSERT INTO revision (branch, id, scope_key, seq, op_index, op, data, commit_seq)
           VALUES ('', 'computed:scoped', '${scopeKey}', ${
            seq - 1
          }, ${index}, 'set', '{"value":0}', ${seq - 1}),
                  ('', 'computed:scoped', '${scopeKey}', ${seq}, ${index}, 'patch', '[]', ${seq});
           INSERT INTO head (branch, id, scope_key, seq, op_index, op)
           VALUES ('', 'computed:scoped', '${scopeKey}', ${seq}, ${index}, 'patch');`,
        );
      }
      const all = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
      });
      expect(all.instances.matched).toBe(4);
      const space = planCompaction(db, {
        selection: { prefixes: ["computed:"], scope: "space" },
      });
      expect(space.instances.matched).toBe(2);
      expect(space.largest.map((plan) => plan.scopeKey)).toEqual(["space"]);
      const user = planCompaction(db, {
        selection: { prefixes: ["computed:"], scope: "user" },
      });
      expect(user.instances).toEqual({
        matched: 1,
        truncated: 1,
        materialized: 1,
        headOpChanges: 1,
      });
      expect(user.largest[0].scopeKey).toBe("user:did:key:zU");
      const session = planCompaction(db, {
        selection: { prefixes: ["computed:"], scope: "session" },
      });
      expect(session.largest[0].scopeKey).toBe("session:did:key:zU:s1");
      expect(() => planCompaction(db, { selection: { prefixes: [""] } }))
        .toThrow("not empty");
    });
  });

  it("lists the ten instances losing the most rows", async () => {
    await withStore((db, engine) => {
      // Twelve more instances, the later ones losing more rows than the
      // earlier, so each displaces a listed one; with computed:a that is
      // thirteen candidates for a list of ten.
      let local = 1000;
      for (let index = 0; index < 12; index++) {
        const id = `computed:many-${String(index).padStart(2, "0")}`;
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(local++, [{
            op: "set",
            id,
            value: { value: { n: 0 } },
          }]),
        });
        for (let patch = 0; patch <= index; patch++) {
          applyCommit(engine, {
            sessionId: "s:a",
            commit: commit(local++, [{
              op: "patch",
              id,
              patches: [{ op: "replace", path: "/value/n", value: patch + 1 }],
            }]),
          });
        }
      }
      const report = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
      });
      expect(report.instances.truncated).toBe(13);
      expect(report.largest.length).toBe(10);
      expect(report.largest[0].id).toBe(A);
      expect(
        report.largest.every((plan, i) =>
          i === 0 || plan.rowsDeleted <= report.largest[i - 1].rowsDeleted
        ),
      ).toBe(true);
    });
  });

  it("formats the report an operator reads", async () => {
    await withStore((db) => {
      const plain = formatCompactionReport(
        planCompaction(db, { selection: { prefixes: ["computed:"] } }),
      );
      for (
        const expected of [
          "selection  computed:",
          "the head of every selected instance",
          "2 matched, 1 lose rows, 1 boundaries materialized, 1 head ops change",
          "15 rows deleted",
          "one branch; genesis present; foreign keys intact; op_* rows 0",
          "local_seq 1",
          "largest    rows deleted",
          "computed:a (space)",
          "elapsed",
        ]
      ) {
        expect(plain).toContain(expected);
      }

      const fifth = db.prepare(
        `SELECT seq FROM revision WHERE id = ? ORDER BY seq ASC LIMIT 1 OFFSET 5`,
      )
        .get<{ seq: number }>(A)!.seq;
      const newest =
        db.prepare(`SELECT MAX(created_at) AS at FROM "commit"`).get<
          { at: string }
        >()!.at;
      const bounded = formatCompactionReport(planCompaction(db, {
        selection: { prefixes: ["computed:", "of:"], scope: "space" },
        cut: { beforeSeq: fifth, before: newest, keepLast: 2 },
      }));
      expect(bounded).toContain("scope=space");
      expect(bounded).toContain(`before-seq ${fifth}, before ${newest} (seq `);
      expect(bounded).toContain("keep-last 2");

      // Sizes past a gigabyte print as such; the rest in megabytes.
      const report: CompactionReport = planCompaction(db, {
        selection: { prefixes: ["computed:"] },
      });
      report.revisions.bytesDeleted = 2_500_000_000;
      expect(formatCompactionReport(report)).toContain("2.50 GB");

      // Every refusal the checks line can carry.
      db.exec(`PRAGMA foreign_keys = OFF`);
      db.exec(
        `INSERT INTO revision (branch, id, scope_key, seq, op_index, op, data, commit_seq)
         VALUES ('', 'of:dangling', 'space', 999, 0, 'set', '{"value":1}', 999)`,
      );
      db.exec(
        `DROP TABLE op_field_epoch; DROP TABLE op_checkpoint; DROP TABLE snapshot; DROP TABLE branch;`,
      );
      db.exec(`DELETE FROM "commit" WHERE seq = 1`);
      const refused = formatCompactionReport(
        planCompaction(db, { selection: { prefixes: ["computed:"] } }),
      );
      for (
        const expected of [
          "branch table ABSENT (not checked)",
          "REFUSED: no commit 1",
          // The dangling row, and the genesis revision orphaned with its commit.
          "REFUSED: 2 foreign-key violation(s)",
          "op_* tables ABSENT (op_field_epoch, op_checkpoint)",
          "snapshot table ABSENT",
          "REFUSED: a store missing tables is not one a run will write",
        ]
      ) {
        expect(refused).toContain(expected);
      }
    });
  });
});
