// The compaction planner: what `cf space compact` would do to a space store,
// computed without writing anything (docs/plans/compact-space.md, §2's dry
// run). The write path is stage 4 of that plan and is not here.
//
// The planner opens nothing itself: it takes a `Database` the caller opened,
// read-only, so that a dry run can never touch a store, and so that the
// caller decides which file is being read. It runs the engine's migrations
// no more than the state inspector does — it reads the tables as they are.

import type { Database } from "@db/sqlite";

import type { CellScope } from "../v2.ts";

/**
 * Which instances a compaction selects. Prefixes match `id` (the namespaces
 * are `of:`, `computed:` and `cid:`); the ACL document, the one id of the
 * form `of:did:…`, is never selected whatever the prefixes say — its history
 * is the membership audit, and the compaction commit is the one change
 * compaction makes to it. `scope` restricts the selection to one scope kind.
 */
export type CompactionSelection = {
  prefixes: readonly string[];
  scope?: CellScope;
};

/**
 * Where each selected instance's history is cut. Absent, the cut is the
 * instance's head: everything behind it goes. The three bounds combine as the
 * most conservative of what they allow — a row survives if any of them keeps
 * it. `before` is a UTC timestamp in the store's own `created_at` format
 * (`YYYY-MM-DD HH:MM:SS`); it resolves to the newest commit created before
 * it, and rows at or above that seq survive.
 */
export type CompactionCut = {
  beforeSeq?: number;
  before?: string;
  keepLast?: number;
};

export type PlanOptions = {
  selection: CompactionSelection;
  cut?: CompactionCut;
  /** Commits created within this many milliseconds of the newest commit keep
   * their payload (`--keep-payloads`); the default is a day. */
  keepPayloadsMs?: number;
};

/** One selected instance the plan would change. */
export type InstancePlan = {
  id: string;
  scopeKey: string;
  rows: number;
  headSeq: number;
  headOp: string;
  /** The oldest row the cut keeps: the base the instance has afterward. */
  boundary: { seq: number; opIndex: number; op: string };
  /** The boundary is a patch and becomes a `set` holding the document at
   * exactly that row. */
  materialized: boolean;
  /** The boundary is the head, so `head.op` changes with it. */
  headOpChanges: boolean;
  rowsDeleted: number;
  bytesDeleted: number;
  snapshotsDeleted: number;
  snapshotBytesDeleted: number;
};

export type CompactionReport = {
  selection: CompactionSelection;
  cut: CompactionCut & { resolvedBeforeSeq?: number };
  keepPayloadsMs: number;
  /** What the run would check before writing; each false is a refusal. */
  preconditions: {
    singleBranch: boolean;
    branches: string[];
    genesisPresent: boolean;
    opTableRows: number;
  };
  instances: {
    matched: number;
    truncated: number;
    materialized: number;
    headOpChanges: number;
  };
  revisions: { rowsDeleted: number; bytesDeleted: number };
  snapshots: { rowsDeleted: number; bytesDeleted: number };
  payloads: {
    /** The newest commit's `created_at`, which the window is measured from. */
    newestCommitAt: string | null;
    /** Commits at or before this `created_at` are outside the window. */
    cutoffAt: string | null;
    commits: number;
    insideWindow: number;
    exemptGenesis: number;
    exemptOpReferenced: number;
    hollowed: {
      owningHead: { commits: number; bytes: number };
      headless: { commits: number; bytes: number };
    };
  };
  /** The instances contributing the most deleted rows, up to ten. */
  largest: InstancePlan[];
  /** The seq and session id the run's compaction commit would take. */
  compactionCommit: { seq: number; sessionId: string };
  elapsedMs: number;
};

const DEFAULT_KEEP_PAYLOADS_MS = 24 * 60 * 60 * 1000;
const LARGEST = 10;

/** The id range a prefix selects, as the index serves it. */
const prefixRange = (prefix: string): { lo: string; hi: string } => ({
  lo: prefix,
  hi: prefix.slice(0, -1) +
    String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1),
});

const scopeKeyPredicate = (scope: CellScope | undefined): string => {
  switch (scope) {
    case undefined:
      return "1";
    case "space":
      return "r.scope_key = 'space'";
    case "user":
      return "r.scope_key LIKE 'user:%'";
    case "session":
      return "r.scope_key LIKE 'session:%'";
  }
};

/** The store's `created_at` text for `ms` before a `created_at` value. */
const earlierBy = (createdAt: string, ms: number): string => {
  const at = new Date(createdAt.replace(" ", "T") + "Z").getTime() - ms;
  return new Date(at).toISOString().slice(0, 19).replace("T", " ");
};

type RevisionRow = {
  id: string;
  scope_key: string;
  seq: number;
  op_index: number;
  op: string;
  bytes: number;
};

/**
 * Computes the plan for `options` against `db`, reading only.
 *
 * The walk is one ordered scan of the selected instances' rows, newest first
 * within each instance, grouped as it goes; the keep rules all keep a prefix
 * of that order, so the boundary is the last kept row and everything after
 * it is deleted. Payload accounting is one aggregate over the `commit` table,
 * which reads every payload's length and is the slow part on a large store.
 */
export const planCompaction = (
  db: Database,
  options: PlanOptions,
): CompactionReport => {
  const started = performance.now();
  const keepPayloadsMs = options.keepPayloadsMs ?? DEFAULT_KEEP_PAYLOADS_MS;
  const cut: CompactionReport["cut"] = { ...(options.cut ?? {}) };
  if (cut.before !== undefined) {
    const row = db.prepare(
      `SELECT MAX(seq) AS seq FROM "commit" WHERE created_at < ?`,
    ).get<{ seq: number | null }>(cut.before);
    cut.resolvedBeforeSeq = row?.seq ?? 0;
  }
  // A row survives if any bound keeps it, so the seq bound in force is the
  // smaller of the two spellings, and no bound at all keeps nothing by seq.
  const seqBounds = [cut.beforeSeq, cut.resolvedBeforeSeq].filter(
    (bound): bound is number => bound !== undefined,
  );
  const beforeSeq = seqBounds.reduce(
    (bound, candidate) => Math.min(bound, candidate),
    Number.POSITIVE_INFINITY,
  );
  const keepLast = cut.keepLast ?? 0;

  const branches = db.prepare(
    `SELECT name FROM branch WHERE name <> '' AND status <> 'deleted'`,
  ).all<{ name: string }>().map((row) => row.name);
  const genesisPresent =
    db.prepare(`SELECT 1 FROM "commit" WHERE seq = 1`).get() !== undefined;
  const opTableRows = db.prepare(
    `SELECT (SELECT count(*) FROM op_field_epoch) + (SELECT count(*) FROM op_submission) +
            (SELECT count(*) FROM op_integrated) + (SELECT count(*) FROM op_checkpoint) AS n`,
  ).get<{ n: number }>()!.n;

  const instances = {
    matched: 0,
    truncated: 0,
    materialized: 0,
    headOpChanges: 0,
  };
  const revisions = { rowsDeleted: 0, bytesDeleted: 0 };
  const snapshots = { rowsDeleted: 0, bytesDeleted: 0 };
  const largest: InstancePlan[] = [];
  const snapshotsBelow = db.prepare(
    `SELECT count(*) AS n, COALESCE(sum(length(value)), 0) AS bytes FROM snapshot
     WHERE branch = '' AND id = ? AND scope_key = ? AND seq <= ?`,
  );

  const finishInstance = (rows: RevisionRow[]): void => {
    instances.matched++;
    let boundaryIndex = 0;
    for (let index = 0; index < rows.length; index++) {
      const keep = index === 0 || index < keepLast ||
        rows[index].seq >= beforeSeq;
      if (keep) boundaryIndex = index;
      else break;
    }
    const deleted = rows.slice(boundaryIndex + 1);
    if (deleted.length === 0) return;
    const head = rows[0];
    const boundary = rows[boundaryIndex];
    const snapshotRow = snapshotsBelow.get<{ n: number; bytes: number }>(
      head.id,
      head.scope_key,
      boundary.seq,
    )!;
    const plan: InstancePlan = {
      id: head.id,
      scopeKey: head.scope_key,
      rows: rows.length,
      headSeq: head.seq,
      headOp: head.op,
      boundary: {
        seq: boundary.seq,
        opIndex: boundary.op_index,
        op: boundary.op,
      },
      materialized: boundary.op === "patch",
      headOpChanges: boundary.op === "patch" && boundaryIndex === 0,
      rowsDeleted: deleted.length,
      bytesDeleted: deleted.reduce((sum, row) => sum + row.bytes, 0),
      snapshotsDeleted: snapshotRow.n,
      snapshotBytesDeleted: snapshotRow.bytes,
    };
    instances.truncated++;
    if (plan.materialized) instances.materialized++;
    if (plan.headOpChanges) instances.headOpChanges++;
    revisions.rowsDeleted += plan.rowsDeleted;
    revisions.bytesDeleted += plan.bytesDeleted;
    snapshots.rowsDeleted += plan.snapshotsDeleted;
    snapshots.bytesDeleted += plan.snapshotBytesDeleted;
    if (
      largest.length < LARGEST ||
      plan.rowsDeleted > largest[largest.length - 1].rowsDeleted
    ) {
      largest.push(plan);
      largest.sort((a, b) => b.rowsDeleted - a.rowsDeleted);
      if (largest.length > LARGEST) largest.pop();
    }
  };

  const scopePredicate = scopeKeyPredicate(options.selection.scope);
  for (const prefix of options.selection.prefixes) {
    const { lo, hi } = prefixRange(prefix);
    const statement = db.prepare(
      `SELECT r.id, r.scope_key, r.seq, r.op_index, r.op, length(r.data) AS bytes
       FROM revision r
       JOIN head h ON h.branch = r.branch AND h.id = r.id AND h.scope_key = r.scope_key
       WHERE r.branch = '' AND r.id >= ? AND r.id < ? AND r.id NOT LIKE 'of:did:%'
         AND ${scopePredicate}
       ORDER BY r.id, r.scope_key, r.seq DESC, r.op_index DESC`,
    );
    let current: RevisionRow[] = [];
    // The iterator is run to exhaustion: the pinned driver resets a statement
    // only when its iteration ends.
    for (const row of statement.iter(lo, hi) as Iterable<RevisionRow>) {
      const last = current[current.length - 1];
      if (
        last !== undefined &&
        (last.id !== row.id || last.scope_key !== row.scope_key)
      ) {
        finishInstance(current);
        current = [];
      }
      current.push(row);
    }
    if (current.length > 0) finishInstance(current);
  }

  const newest = db.prepare(
    `SELECT MAX(created_at) AS at, MAX(seq) AS seq FROM "commit"`,
  )
    .get<{ at: string | null; seq: number | null }>()!;
  const cutoffAt = newest.at === null
    ? null
    : earlierBy(newest.at, keepPayloadsMs);
  const payloadRows = cutoffAt === null ? [] : db.prepare(
    `WITH owners AS (
       SELECT DISTINCT r.commit_seq AS seq FROM revision r
       JOIN head h ON h.branch = r.branch AND h.id = r.id AND h.scope_key = r.scope_key
         AND h.seq = r.seq AND h.op_index = r.op_index
     ),
     opref AS (
       SELECT commit_seq AS seq FROM op_submission
       UNION SELECT commit_seq FROM op_integrated
       UNION SELECT commit_seq FROM op_checkpoint
       UNION SELECT commit_seq FROM op_field_epoch
     )
     SELECT
       CASE
         WHEN c.created_at > ? THEN 'inside'
         WHEN c.seq = 1 THEN 'genesis'
         WHEN c.seq IN (SELECT seq FROM opref) THEN 'op'
         WHEN c.seq IN (SELECT seq FROM owners) THEN 'owning'
         ELSE 'headless'
       END AS kind,
       count(*) AS n,
       COALESCE(sum(length(c.original)), 0) AS bytes
     FROM "commit" c
     GROUP BY kind`,
  ).all<{ kind: string; n: number; bytes: number }>(cutoffAt);
  const byKind = (kind: string) =>
    payloadRows.find((row) => row.kind === kind) ?? { n: 0, bytes: 0 };

  return {
    selection: options.selection,
    cut,
    keepPayloadsMs,
    preconditions: {
      singleBranch: branches.length === 0,
      branches,
      genesisPresent,
      opTableRows,
    },
    instances,
    revisions,
    snapshots,
    payloads: {
      newestCommitAt: newest.at,
      cutoffAt,
      commits: payloadRows.reduce((sum, row) => sum + row.n, 0),
      insideWindow: byKind("inside").n,
      exemptGenesis: byKind("genesis").n,
      exemptOpReferenced: byKind("op").n,
      hollowed: {
        owningHead: {
          commits: byKind("owning").n,
          bytes: byKind("owning").bytes,
        },
        headless: {
          commits: byKind("headless").n,
          bytes: byKind("headless").bytes,
        },
      },
    },
    largest,
    compactionCommit: {
      seq: (newest.seq ?? 0) + 1,
      sessionId: `compaction:${new Date().toISOString()}`,
    },
    elapsedMs: performance.now() - started,
  };
};

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(2)} GB`;
const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;
const size = (bytes: number): string => (bytes >= 1e9 ? gb(bytes) : mb(bytes));
const n = (value: number): string => value.toLocaleString("en-US");

/** The report as an operator reads it before deciding to run. */
export const formatCompactionReport = (report: CompactionReport): string => {
  const lines: string[] = [];
  const { instances, revisions, snapshots, payloads, preconditions } = report;
  lines.push(
    `selection  ${report.selection.prefixes.join(", ")}` +
      (report.selection.scope ? `  scope=${report.selection.scope}` : ""),
  );
  const cut = report.cut;
  const cutText = [
    cut.beforeSeq !== undefined ? `before-seq ${cut.beforeSeq}` : "",
    cut.before !== undefined
      ? `before ${cut.before} (seq ${cut.resolvedBeforeSeq})`
      : "",
    cut.keepLast !== undefined ? `keep-last ${cut.keepLast}` : "",
  ].filter((part) => part !== "").join(", ");
  lines.push(`cut        ${cutText || "the head of every selected instance"}`);
  lines.push(
    `instances  ${n(instances.matched)} matched, ${
      n(instances.truncated)
    } lose rows, ` +
      `${n(instances.materialized)} boundaries materialized, ${
        n(instances.headOpChanges)
      } head ops change`,
  );
  lines.push(
    `revisions  ${n(revisions.rowsDeleted)} rows deleted, ${
      size(revisions.bytesDeleted)
    }`,
  );
  lines.push(
    `snapshots  ${n(snapshots.rowsDeleted)} rows deleted, ${
      size(snapshots.bytesDeleted)
    }`,
  );
  const h = payloads.hollowed;
  lines.push(
    `payloads   ${n(payloads.commits)} commits; window keeps ${
      n(payloads.insideWindow)
    } ` +
      `(created after ${payloads.cutoffAt ?? "-"}); genesis keeps ${
        n(payloads.exemptGenesis)
      }; ` +
      `op_* keep ${n(payloads.exemptOpReferenced)}`,
  );
  lines.push(
    `           hollowed: ${n(h.owningHead.commits)} owning a head, ${
      size(h.owningHead.bytes)
    }; ` +
      `${n(h.headless.commits)} owning none, ${size(h.headless.bytes)}`,
  );
  lines.push(
    `commit     seq ${report.compactionCommit.seq} as ${report.compactionCommit.sessionId}`,
  );
  const checks = [
    preconditions.singleBranch
      ? "one branch"
      : `REFUSED: branches ${preconditions.branches.join(", ")}`,
    preconditions.genesisPresent ? "genesis present" : "REFUSED: no commit 1",
    `op_* rows ${n(preconditions.opTableRows)}`,
  ];
  lines.push(`checks     ${checks.join("; ")}`);
  if (report.largest.length > 0) {
    lines.push("largest    rows deleted  boundary           instance");
    for (const plan of report.largest) {
      lines.push(
        `           ${String(n(plan.rowsDeleted)).padStart(12)}  ` +
          `${String(plan.boundary.seq).padStart(9)}/${plan.boundary.opIndex} ${
            plan.boundary.op.padEnd(6)
          } ` +
          `${plan.id.slice(0, 40)} (${plan.scopeKey})`,
      );
    }
  }
  lines.push(`elapsed    ${(report.elapsedMs / 1000).toFixed(1)} s`);
  return lines.join("\n");
};
