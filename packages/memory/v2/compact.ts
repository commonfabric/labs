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
    /** Rows `PRAGMA foreign_key_check` reports; any means the store is not
     * one the run will write. */
    foreignKeyViolations: number;
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
  /** The identity the run's compaction commit would take: its seq, and the
   * `(session_id, local_seq)` pair the commit table holds unique. */
  compactionCommit: { seq: number; sessionId: string; localSeq: number };
  elapsedMs: number;
};

const DEFAULT_KEEP_PAYLOADS_MS = 24 * 60 * 60 * 1000;
const LARGEST = 10;

/** The store's own `created_at` format, which `before` must be written in. */
const CREATED_AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Refuses options the planner cannot read as intended, by name.
 *
 * `before` is compared with `created_at` as text, so a value in any other
 * spelling — an ISO `T`, an offset, a bare date — would still compare and
 * would move the cut rather than fail; a non-negative integer bound that is
 * not one would keep or delete the wrong rows the same way.
 */
const validateOptions = (options: PlanOptions): void => {
  const nonNegativeInteger = (name: string, value: number | undefined) => {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(
        `${name} must be a non-negative integer, not ${value}`,
      );
    }
  };
  if (options.selection.prefixes.length === 0) {
    throw new TypeError("a compaction selects at least one id prefix");
  }
  for (const prefix of options.selection.prefixes) {
    if (prefix.length === 0) throw new TypeError("an id prefix is not empty");
  }
  const cut = options.cut ?? {};
  nonNegativeInteger("beforeSeq", cut.beforeSeq);
  nonNegativeInteger("keepLast", cut.keepLast);
  nonNegativeInteger("keepPayloadsMs", options.keepPayloadsMs);
  if (cut.before !== undefined) {
    const parsed = new Date(cut.before.replace(" ", "T") + "Z");
    if (
      !CREATED_AT.test(cut.before) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 19).replace("T", " ") !== cut.before
    ) {
      throw new TypeError(
        `before must be a UTC timestamp in the store's format, YYYY-MM-DD HH:MM:SS, not ${cut.before}`,
      );
    }
  }
};

/**
 * The prefixes as one selection: repeats dropped, and a prefix another one
 * covers dropped with them, so that no instance is scanned twice and the
 * totals count each once.
 */
export const normalizePrefixes = (prefixes: readonly string[]): string[] => {
  const unique = [...new Set(prefixes)];
  return unique.filter((prefix) =>
    !unique.some((other) => other !== prefix && prefix.startsWith(other))
  );
};

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

// Stored sizes are measured on the BLOB: `length()` of a TEXT column counts
// characters, and these JSON columns hold whatever the documents hold.
const BYTES_OF = (column: string): string => `length(CAST(${column} AS BLOB))`;

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
  validateOptions(options);
  const prefixes = normalizePrefixes(options.selection.prefixes);
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

  // A store the current server has opened carries every table below; one it
  // has not — a snapshot from before a migration — may lack some, and reads
  // as if they were empty rather than failing the dry run on a table it was
  // never going to touch.
  const tableExists = (table: string): boolean =>
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) !== undefined;
  const countOf = (table: string): number =>
    tableExists(table)
      ? db.prepare(`SELECT count(*) AS n FROM "${table}"`).get<{ n: number }>()!
        .n
      : 0;
  const branches = tableExists("branch")
    ? db.prepare(
      `SELECT name FROM branch WHERE name <> '' AND status <> 'deleted'`,
    ).all<{ name: string }>().map((row) => row.name)
    : [];
  const genesisPresent =
    db.prepare(`SELECT 1 FROM "commit" WHERE seq = 1`).get() !== undefined;
  const foreignKeyViolations =
    db.prepare(`PRAGMA foreign_key_check`).all().length;
  const opTables = [
    "op_field_epoch",
    "op_submission",
    "op_integrated",
    "op_checkpoint",
  ];
  const opTableRows = opTables.reduce((sum, table) => sum + countOf(table), 0);
  const hasSnapshots = tableExists("snapshot");

  const instances = {
    matched: 0,
    truncated: 0,
    materialized: 0,
    headOpChanges: 0,
  };
  const revisions = { rowsDeleted: 0, bytesDeleted: 0 };
  const snapshots = { rowsDeleted: 0, bytesDeleted: 0 };
  const largest: InstancePlan[] = [];
  // A total is summed as REAL: the driver hands back an INTEGER column as a
  // 32-bit value, which a store's bytes exceed.
  const snapshotsBelow = db.prepare(
    hasSnapshots
      ? `SELECT count(*) AS n, CAST(COALESCE(sum(${
        BYTES_OF("value")
      }), 0) AS REAL) AS bytes
         FROM snapshot
         WHERE branch = '' AND id = ? AND scope_key = ? AND seq <= ?`
      : `SELECT 0 AS n, 0.0 AS bytes WHERE ? IS NULL AND ? IS NULL AND ? IS NULL`,
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
    const snapshotRow = hasSnapshots
      ? snapshotsBelow.get<{ n: number; bytes: number }>(
        head.id,
        head.scope_key,
        boundary.seq,
      )!
      : { n: 0, bytes: 0 };
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
  for (const prefix of prefixes) {
    const { lo, hi } = prefixRange(prefix);
    const statement = db.prepare(
      `SELECT r.id, r.scope_key, r.seq, r.op_index, r.op, ${
        BYTES_OF("r.data")
      } AS bytes
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
       ${
      opTables.filter(tableExists).map((table) =>
        `SELECT commit_seq AS seq FROM "${table}"`
      ).join(" UNION ") || "SELECT NULL AS seq WHERE 0"
    }
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
       CAST(COALESCE(sum(${BYTES_OF("c.original")}), 0) AS REAL) AS bytes
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
      foreignKeyViolations,
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
      localSeq: 1,
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
    `commit     seq ${report.compactionCommit.seq} as ${report.compactionCommit.sessionId}` +
      ` local_seq ${report.compactionCommit.localSeq}`,
  );
  const checks = [
    preconditions.singleBranch
      ? "one branch"
      : `REFUSED: branches ${preconditions.branches.join(", ")}`,
    preconditions.genesisPresent ? "genesis present" : "REFUSED: no commit 1",
    preconditions.foreignKeyViolations === 0
      ? "foreign keys intact"
      : `REFUSED: ${
        n(preconditions.foreignKeyViolations)
      } foreign-key violation(s)`,
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
