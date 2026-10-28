// Compaction of a space store's revision history (docs/plans/compact-space.md).
//
// Two halves. The planner, `planCompaction`, computes what a run would do
// without writing anything: it takes a `Database` the caller opened,
// read-only, so that a dry run can never touch a store, and it runs the
// engine's migrations no more than the state inspector does — it reads the
// tables as they are. The run, `compactStore`, is the plan's §1 option (a),
// materialize-and-truncate: it plans the same way first, refuses a store the
// plan says it must not write, and then opens the store through the engine so
// that the schema it rewrites is the one the server writes and the document
// it materializes at a boundary is the engine's own reconstruction.

import { Database } from "@db/sqlite";
import { resolve, toFileUrl } from "@std/path";
import { hashStringOf } from "@commonfabric/data-model";
import type { FabricValue } from "@commonfabric/api";

import {
  type CellScope,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
  type EntityDocument,
} from "../v2.ts";
import {
  close,
  COMPACTION_SESSION_PREFIX,
  open,
  read,
  readRevision,
} from "./engine.ts";
import { isACL } from "../acl.ts";

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
  /** Called with every instance the plan changes, in selection order: the
   * run's worklist. The report itself keeps only the ten largest. */
  onInstance?: (plan: InstancePlan) => void;
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
    /** Tables the store lacks, from before a migration the server would run
     * on opening it. A check that reads one of them was not made, and a
     * store missing any is not one the run will write. */
    missingTables: string[];
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
    /**
     * The newest client commit's `created_at`, which the window is measured
     * from.
     */
    newestCommitAt: string | null;

    /** Commits at or before this `created_at` are outside the window. */
    cutoffAt: string | null;

    commits: number;

    /**
     * Commits created after `cutoffAt`, other than the compaction commits
     * `exemptCompaction` counts.
     */
    insideWindow: number;

    exemptGenesis: number;
    exemptOpReferenced: number;

    /**
     * Earlier runs' compaction commits, on either side of `cutoffAt`: their
     * payload is the run's record.
     */
    exemptCompaction: number;

    /** Commits an earlier run already hollowed; a resumed run skips them. */
    alreadyHollowed: number;

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

/**
 * What a hollowed commit's `original` holds in place of its payload (I6): a
 * hash of the bytes it held and their length, under the run that hollowed it.
 * A client commit always carries `localSeq`, `reads` and `operations`, so
 * nothing a client writes can resemble this, and a reader of the log can
 * tell a hollowed commit from an elided write. Stage 8 of the plan answers a
 * resubmission whose bytes hash to `hash` as a replay.
 */
export type HollowedPayload = {
  hollowed: {
    /** `hashStringOf` of the original payload text. */
    hash: string;
    /** The original payload's stored length in bytes. */
    bytes: number;
    /** The compaction commit of the run that hollowed it. */
    commitSeq: number;
    runId: string;
  };
};

const hollowedPayload = (marker: HollowedPayload): string =>
  encodeMemoryBoundary(marker as FabricValue);

/**
 * Every hollowed payload begins with this text: the codec writes members in
 * key order, so the marker's first member is fixed, and a stored payload is a
 * marker if and only if it starts this way. Derived from the codec rather
 * than spelled out, so a codec change cannot leave a marker unrecognized.
 */
export const HOLLOWED_MARKER_PREFIX = (() => {
  const probe = hollowedPayload({
    hollowed: { hash: "", bytes: 0, commitSeq: 0, runId: "" },
  });
  const at = probe.indexOf('"bytes":');
  if (at < 0) throw new Error("the hollowed-payload marker did not encode");
  return probe.slice(0, at + '"bytes":'.length);
})();

/** Whether a stored commit payload is a hollowing marker rather than a
 * client commit. */
export const isHollowedPayload = (original: string): boolean =>
  original.startsWith(HOLLOWED_MARKER_PREFIX);

/** The marker a hollowed payload holds, or undefined for an intact one. */
export const decodeHollowedPayload = (
  original: string,
): HollowedPayload["hollowed"] | undefined =>
  isHollowedPayload(original)
    ? (decodeTrustedMemoryBoundary(original) as unknown as HollowedPayload)
      .hollowed
    : undefined;

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
  // has not — a snapshot from before a migration — may lack some. The dry run
  // still reads what is there, and names what is not, so the report says
  // which checks it could not make rather than passing them.
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
  const missingTables = ["branch", "snapshot", ...opTables].filter((table) =>
    !tableExists(table)
  );

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
    options.onInstance?.(plan);
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

  // The window is measured from the newest commit a client made: a compaction
  // commit from an earlier run is not an event the window should move for,
  // and excluding it is what lets a resumed run hollow the same rows the
  // interrupted one planned to. The count below sorts a compaction commit
  // ahead of the window for the same reason. Such a commit keeps its payload
  // on either side of the cutoff, and its `created_at` is the wall clock of
  // the run that inserted it, which says nothing about the client commits the
  // window is measured over.
  const newest = db.prepare(
    `SELECT MAX(created_at) AS at, MAX(seq) AS seq FROM "commit"
     WHERE session_id NOT LIKE ?`,
  ).get<{ at: string | null; seq: number | null }>(
    `${COMPACTION_SESSION_PREFIX}%`,
  )!;
  const nextSeq =
    db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM "commit"`)
      .get<{ seq: number }>()!.seq;
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
         WHEN c.session_id LIKE ? THEN 'compaction'
         WHEN c.created_at > ? THEN 'inside'
         WHEN c.seq = 1 THEN 'genesis'
         WHEN c.seq IN (SELECT seq FROM opref) THEN 'op'
         WHEN substr(c.original, 1, ?) = ? THEN 'hollowed'
         WHEN c.seq IN (SELECT seq FROM owners) THEN 'owning'
         ELSE 'headless'
       END AS kind,
       count(*) AS n,
       CAST(COALESCE(sum(${BYTES_OF("c.original")}), 0) AS REAL) AS bytes
     FROM "commit" c
     GROUP BY kind`,
  ).all<{ kind: string; n: number; bytes: number }>(
    `${COMPACTION_SESSION_PREFIX}%`,
    cutoffAt,
    HOLLOWED_MARKER_PREFIX.length,
    HOLLOWED_MARKER_PREFIX,
  );
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
      missingTables,
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
      exemptCompaction: byKind("compaction").n,
      alreadyHollowed: byKind("hollowed").n,
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
      seq: nextSeq,
      sessionId: `${COMPACTION_SESSION_PREFIX}${new Date().toISOString()}`,
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
      `op_* keep ${n(payloads.exemptOpReferenced)}` +
      (payloads.exemptCompaction > 0
        ? `; earlier runs' commits keep ${n(payloads.exemptCompaction)}`
        : "") +
      (payloads.alreadyHollowed > 0
        ? `; ${n(payloads.alreadyHollowed)} hollowed by an earlier run`
        : ""),
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
  const missing = new Set(preconditions.missingTables);
  const missingOps = preconditions.missingTables.filter((table) =>
    table.startsWith("op_")
  );
  const checks = [
    missing.has("branch")
      ? "branch table ABSENT (not checked)"
      : preconditions.singleBranch
      ? "one branch"
      : `REFUSED: branches ${preconditions.branches.join(", ")}`,
    preconditions.genesisPresent ? "genesis present" : "REFUSED: no commit 1",
    preconditions.foreignKeyViolations === 0
      ? "foreign keys intact"
      : `REFUSED: ${
        n(preconditions.foreignKeyViolations)
      } foreign-key violation(s)`,
    missingOps.length > 0
      ? `op_* tables ABSENT (${missingOps.join(", ")})`
      : `op_* rows ${n(preconditions.opTableRows)}`,
    ...(missing.has("snapshot") ? ["snapshot table ABSENT"] : []),
    ...(missing.size > 0
      ? ["REFUSED: a store missing tables is not one a run will write"]
      : []),
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

// ---------------------------------------------------------------------------
// The run.

/** The id of a space's ACL document: the one `of:did:…` id a store holds. */
const ACL_ID_PATTERN = "of:did:%";

/**
 * A store the run will not write, by name. The planner's preconditions, the
 * file's companions and the migrations a store may predate are each a reason
 * here; none is an error in the tool, so the caller reports it as a refusal.
 */
export class CompactionRefused extends Error {
  override readonly name = "CompactionRefused";
}

/**
 * The record a run leaves on the space's ACL document, beside `value`
 * (docs/plans/compact-space.md, "What a user sees"). One member for the
 * lifetime of the space, appended to by every run.
 */
export type CompactionMarker = {
  /** The newest seq any hollowed or deleted row had: a reader wanting older
   * history knows to ask for the archive. */
  lastCommitSeq: number;
  /** When the newest run finished, UTC. */
  compactedAt: string;
  runs: Array<{
    commitSeq: number;
    documents: string;
    truncated: number;
    hollowed: number;
    lastCommitSeq: number;
    runId: string;
  }>;
};

/** What the run did to the ACL document. */
export type AclOutcome =
  | { status: "marked"; id: string }
  /** The store holds no ACL document; the space predates ACL genesis and is
   * open to authenticated principals. Writing one would close it — an ACL
   * document whose `value` is not an ACL fails closed — so none is written,
   * and the compaction commit is the run's only record in the store. */
  | { status: "absent" }
  /** The ACL document is a tombstone; a `set` would recreate it. */
  | { status: "deleted"; id: string };

export type CompactionProgress =
  | { phase: "planned"; report: CompactionReport }
  | { phase: "instance"; completed: number; of: number; plan: InstancePlan }
  | { phase: "hollowing"; completed: number; of: number }
  | { phase: "vacuum"; out: string };

export type CompactionRunOptions = {
  /** The store to compact. It is rewritten in place; the operator runs the
   * tool against a copy of the backup, never the backup itself. */
  store: string;
  /** Where `VACUUM INTO` writes the result; `<store>.compacted.sqlite`
   * beside the source by default. Must not exist. */
  out?: string;
  selection: CompactionSelection;
  cut?: CompactionCut;
  keepPayloadsMs?: number;
  /** The run's identity, `compaction:<runId>`; the UTC time of the run by
   * default. Two runs with one id would collide on the commit table's
   * unique `(session_id, local_seq)`. */
  runId?: string;
  /** Progress, after each instance's transaction and each hollowing batch.
   * An exception thrown from here stops the run after the transaction it
   * reports on, which a second run then resumes. */
  onProgress?: (progress: CompactionProgress) => void;
};

export type CompactionRun = {
  report: CompactionReport;
  runId: string;
  commitSeq: number;
  sessionId: string;
  instancesCompacted: number;
  materialized: number;
  rowsDeleted: number;
  snapshotsDeleted: number;
  hollowed: number;
  hollowedBytes: number;
  acl: AclOutcome;
  lastCommitSeq: number;
  out: string;
  outBytes: number;
  elapsedMs: number;
};

const HOLLOW_BATCH = 10_000;

/** A FabricValue of `value`, with every `undefined` member dropped. */
const storable = (value: unknown): FabricValue =>
  JSON.parse(JSON.stringify(value)) as FabricValue;

/** The file's stat, or undefined for a file that is not there. Any other
 * failure — a permission refused, an I/O error — is not absence and is
 * rethrown: a companion the run cannot read is not a companion it may
 * treat as empty. */
const statIfPresent = (path: string): Deno.FileInfo | undefined => {
  try {
    return Deno.statSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
};

const fileSize = (path: string): number => statIfPresent(path)?.size ?? 0;

/** Whether any directory entry is at `path` — a file, a directory, or a
 * symlink whether or not its target exists. The result is written through
 * whatever is there, so nothing may be. */
const entryExists = (path: string): boolean => {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

type SchemaObject = { type: string; name: string; tbl_name: string };
type SchemaColumn = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

/** Every table and index a database declares, with each table's columns. */
const readSchema = (
  db: Database,
): { objects: SchemaObject[]; columns: Map<string, SchemaColumn[]> } => {
  const objects = db.prepare(
    `SELECT type, name, tbl_name FROM sqlite_master
     WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  ).all<SchemaObject>();
  const columns = new Map<string, SchemaColumn[]>();
  for (const object of objects) {
    if (object.type !== "table") continue;
    columns.set(
      object.name,
      db.prepare(
        `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid`,
      ).all<SchemaColumn>(object.name),
    );
  }
  return { objects, columns };
};

/** The schema text of a database, for an exact before/after comparison. */
const schemaText = (db: Database): string =>
  db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
  ).all().map((row) => JSON.stringify(row)).join("\n");

/**
 * Tables the engine's migrations remove or rename on opening: a store
 * holding one is a store the engine would rewrite.
 */
const LEGACY_TABLES = [
  "scheduler_observation_replay",
  "scheduler_read_index",
  "scheduler_write_index",
  "scheduler_action_state",
  "scheduler_action_snapshot",
  "scheduler_observation",
  "scheduler_context_floor",
  "op_integrated_id_migration",
  "revision_unscoped_migration",
  "head_unscoped_migration",
  "snapshot_unscoped_migration",
  "head_current_op_migration",
];

/**
 * Why opening `db` through the engine would migrate it, or nothing. The
 * engine's `open` creates every table and index it declares, adds every
 * column a migration added since the store was written, and drops the
 * tables earlier schemas kept; each is a write to the store before the run
 * has decided to write anything. So the preflight compares the store's
 * schema with the one a fresh engine declares — every object present, every
 * declared column present with the declared type, nullability, default and
 * key position — rather than re-deriving each migration's trigger, which a
 * migration added later would silently miss. Pattern-created tables and
 * their indexes are the store's own and are not held to the comparison.
 */
const schemaMigrationReasons = (
  store: Database,
  current: ReturnType<typeof readSchema>,
): string[] => {
  const actual = readSchema(store);
  const reasons: string[] = [];
  const have = new Set(actual.objects.map((o) => `${o.type}:${o.name}`));
  const missing = current.objects.filter((o) =>
    !have.has(`${o.type}:${o.name}`)
  );
  if (missing.length > 0) {
    reasons.push(
      `the store lacks ${missing.map((o) => `${o.type} ${o.name}`).join(", ")}`,
    );
  }
  for (const [table, declared] of current.columns) {
    const stored = actual.columns.get(table);
    if (stored === undefined) continue;
    const byName = new Map(stored.map((c) => [c.name, c]));
    for (const column of declared) {
      const found = byName.get(column.name);
      if (found === undefined) {
        reasons.push(`${table} has no ${column.name} column`);
      } else if (
        found.type !== column.type || found.notnull !== column.notnull ||
        found.dflt_value !== column.dflt_value || found.pk !== column.pk
      ) {
        reasons.push(
          `${table}.${column.name} is declared ${
            describeColumn(found)
          } where the engine declares ${describeColumn(column)}`,
        );
      }
    }
  }
  const legacy = LEGACY_TABLES.filter((table) => have.has(`table:${table}`));
  if (legacy.length > 0) {
    reasons.push(`the store holds the legacy table(s) ${legacy.join(", ")}`);
  }
  return reasons;
};

const describeColumn = (column: SchemaColumn): string =>
  `${column.type || "ANY"}${column.notnull ? " NOT NULL" : ""}${
    column.dflt_value === null ? "" : ` DEFAULT ${column.dflt_value}`
  }${column.pk ? " PRIMARY KEY" : ""}`;

/**
 * Why opening the store at `db` through the engine would migrate it — each
 * a reason the run refuses it — or nothing. For the dry run to report, so an
 * operator does not read a plan as write eligibility.
 */
export const storeSchemaRefusals = async (db: Database): Promise<string[]> =>
  schemaMigrationReasons(db, await currentEngineSchema());

/** The schema a fresh engine declares, read from one opened on nothing. */
const currentEngineSchema = async (): Promise<
  ReturnType<typeof readSchema>
> => {
  const fresh = await open({ url: new URL("memory:engine-schema") });
  try {
    return readSchema(fresh.database);
  } finally {
    close(fresh);
  }
};

/**
 * The reasons a planned run must not write, in the order the plan states
 * them; empty when the store is one the run will write.
 */
export const refusals = (report: CompactionReport): string[] => {
  const { preconditions } = report;
  const reasons: string[] = [];
  if (preconditions.missingTables.length > 0) {
    reasons.push(
      `the store lacks ${
        preconditions.missingTables.join(", ")
      }: it predates a migration the server runs on opening it, and a run writes only a store the server has opened`,
    );
  }
  if (!preconditions.singleBranch) {
    reasons.push(
      `the store has a second branch (${
        preconditions.branches.join(", ")
      }); a forked branch reads its parent's rows, which compaction removes (I8)`,
    );
  }
  if (!preconditions.genesisPresent) {
    reasons.push("the store has no commit 1");
  }
  if (preconditions.foreignKeyViolations > 0) {
    reasons.push(
      `PRAGMA foreign_key_check reports ${preconditions.foreignKeyViolations} violation(s)`,
    );
  }
  return reasons;
};

/**
 * Compacts the store at `options.store` in place and writes the result with
 * `VACUUM INTO` (docs/plans/compact-space.md, §1 option (a) and §2).
 *
 * In order: plan read-only and refuse what the plan refuses; open through
 * the engine and take the exclusive lock; insert the compaction commit at
 * the next seq in its own transaction; compact each instance in its own
 * transaction — materialize a patch boundary as a `set` holding the engine's
 * reconstruction at exactly that row, re-attribute the boundary whatever its
 * op, delete the rows and snapshots behind it; hollow every payload outside
 * the window in seq-ranged batches, except commit 1, the commits an `op_*`
 * row references, and every compaction commit, whose payload is a run's
 * record; write the ACL document's audit revision where the store has a live
 * ACL document; check the
 * foreign keys and the file; `VACUUM INTO`. A run interrupted anywhere
 * leaves a store every reader can use, and a second run resumes it: an
 * instance whose boundary already points at a compaction commit with nothing
 * below it is not in the plan, and a hollowed payload is recognized by its
 * marker.
 */
export const compactStore = async (
  options: CompactionRunOptions,
): Promise<CompactionRun> => {
  const started = performance.now();
  // Resolved against the working directory: the engine opens a file URL,
  // which a relative path cannot become, and the result sits beside the
  // store wherever the store is.
  const store = resolve(options.store);
  const out = options.out === undefined
    ? `${store}.compacted.sqlite`
    : resolve(options.out);
  const runId = options.runId ?? new Date().toISOString();
  const sessionId = `${COMPACTION_SESSION_PREFIX}${runId}`;

  // Preflight on the file: a store some process holds open in WAL mode has
  // a log beside it, and a stale log left beside a replaced database is
  // recovered onto the replacement.
  try {
    Deno.statSync(store);
  } catch {
    throw new CompactionRefused(`no store at ${store}`);
  }
  for (const companion of ["-wal", "-journal"]) {
    if (fileSize(`${store}${companion}`) > 0) {
      throw new CompactionRefused(
        `${store}${companion} is not empty: a process holds the store open, or a log was left beside it; the run writes only a store nothing has open`,
      );
    }
  }
  if (entryExists(out)) {
    throw new CompactionRefused(
      `${out} exists; the result is never overwritten`,
    );
  }

  // Plan read-only, on a connection that cannot write, before anything opens
  // the store for writing.
  const worklist: InstancePlan[] = [];
  let report: CompactionReport;
  let aclHeads: Array<{ id: string; op: string; data: string | null }>;
  const planning = new Database(store, { readonly: true });
  let schemaBefore: string;
  try {
    // The engine's `open` migrates a store that is behind its schema, and a
    // refusal must leave the input unchanged; so the store is held to the
    // current schema here, on a connection that cannot write.
    const migrations = await storeSchemaRefusals(planning);
    if (migrations.length > 0) {
      throw new CompactionRefused(
        `${
          migrations.join("; ")
        }: the store predates a migration the server runs on opening it, and a run writes only a store the server has opened`,
      );
    }
    schemaBefore = schemaText(planning);
    report = planCompaction(planning, {
      selection: options.selection,
      cut: options.cut,
      keepPayloadsMs: options.keepPayloadsMs,
      onInstance: (plan) => worklist.push(plan),
    });
    // The plan names the commit this run inserts, not a commit a plan taken
    // at another moment would have.
    report.compactionCommit.sessionId = sessionId;
    const reasons = refusals(report);
    if (reasons.length > 0) {
      throw new CompactionRefused(`refused: ${reasons.join("; ")}`);
    }
    aclHeads = planning.prepare(
      `SELECT h.id, h.op, r.data FROM head h
       JOIN revision r ON r.branch = h.branch AND r.id = h.id AND r.scope_key = h.scope_key
         AND r.seq = h.seq AND r.op_index = h.op_index
       WHERE h.branch = '' AND h.scope_key = 'space' AND h.id LIKE ?`,
    ).all<{ id: string; op: string; data: string | null }>(ACL_ID_PATTERN);
    if (aclHeads.length > 1) {
      throw new CompactionRefused(
        `the store holds ${aclHeads.length} ACL documents (${
          aclHeads.map((row) => row.id).join(", ")
        }); a space has one`,
      );
    }
    // The audit revision repeats the document's `value` as it stands, so
    // what stands must be an ACL: a malformed one is the server's to repair
    // (it fails closed on it), not the run's to re-state under its name.
    if (aclHeads.length === 1 && aclHeads[0].op === "set") {
      const value = aclHeads[0].data === null
        ? undefined
        : (decodeTrustedMemoryBoundary(aclHeads[0].data) as EntityDocument)
          .value;
      if (!isACL(value)) {
        throw new CompactionRefused(
          `${
            aclHeads[0].id
          } holds a value that is not an ACL; the run writes the audit revision only over a valid ACL document`,
        );
      }
    }
  } finally {
    planning.close();
  }
  options.onProgress?.({ phase: "planned", report });

  const engine = await open({ url: toFileUrl(store) });
  try {
    const db = engine.database;
    // A store whose commit refs are NOT NULL (the legacy placeholder schema)
    // fails the nullability comparison above, so none reaches here.
    if (schemaText(db) !== schemaBefore) {
      // The preflight above is what should have caught this; the store is a
      // copy, and the operator takes a fresh one.
      throw new Error(
        "opening the store through the engine changed its schema although the preflight found it current; take a fresh copy of the backup and report this",
      );
    }
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    const tx = <T>(fn: () => T): T => db.transaction(fn).immediate();

    // 1. The compaction commit, at the next seq, with the run's plan as its
    //    payload (I4). The branch head advances to it so the head read keeps
    //    using the head statement.
    const commitSeq = tx(() => {
      const seq = db.prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM "commit"`,
      ).get<{ seq: number }>()!.seq;
      if (seq !== report.compactionCommit.seq) {
        throw new Error(
          `the next seq is ${seq}, not the plan's ${report.compactionCommit.seq}: the store changed since it was planned`,
        );
      }
      db.prepare(
        `INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution, class)
         VALUES (?, '', ?, 1, ?, ?, 'system')`,
      ).run(
        seq,
        sessionId,
        encodeMemoryBoundary(storable({ compaction: { runId, report } })),
        encodeMemoryBoundary({ seq }),
      );
      db.prepare(`UPDATE branch SET head_seq = ? WHERE name = ''`).run(seq);
      return seq;
    });

    // 2. Each instance, in its own transaction.
    const rewriteBoundary = db.prepare(
      `UPDATE revision SET op = 'set', data = ?, commit_seq = ?
       WHERE branch = '' AND id = ? AND scope_key = ? AND seq = ? AND op_index = ? AND op = 'patch'`,
    );
    const attributeBoundary = db.prepare(
      `UPDATE revision SET commit_seq = ?
       WHERE branch = '' AND id = ? AND scope_key = ? AND seq = ? AND op_index = ? AND op = ?`,
    );
    const rewriteHeadOp = db.prepare(
      `UPDATE head SET op = 'set'
       WHERE branch = '' AND id = ? AND scope_key = ? AND seq = ? AND op_index = ?`,
    );
    const newestBelow = db.prepare(
      `SELECT seq FROM revision
       WHERE branch = '' AND id = ? AND scope_key = ?
         AND (seq < ? OR (seq = ? AND op_index < ?))
       ORDER BY seq DESC, op_index DESC LIMIT 1`,
    );
    const deleteBelow = db.prepare(
      `DELETE FROM revision
       WHERE branch = '' AND id = ? AND scope_key = ?
         AND (seq < ? OR (seq = ? AND op_index < ?))`,
    );
    const deleteSnapshots = db.prepare(
      `DELETE FROM snapshot WHERE branch = '' AND id = ? AND scope_key = ? AND seq <= ?`,
    );
    let instancesCompacted = 0;
    let materialized = 0;
    let rowsDeleted = 0;
    let snapshotsDeleted = 0;
    let lastCommitSeq = 0;
    for (const plan of worklist) {
      const { id, scopeKey, boundary } = plan;
      tx(() => {
        if (boundary.op === "patch") {
          const document = readRevision(engine, {
            id: id as never,
            scopeKey,
            seq: boundary.seq,
            opIndex: boundary.opIndex,
          });
          if (document === null) {
            throw new Error(
              `${id} (${scopeKey}) reconstructs to no document at its patch boundary ${boundary.seq}/${boundary.opIndex}`,
            );
          }
          const changed = rewriteBoundary.run(
            encodeMemoryBoundary(document as FabricValue),
            commitSeq,
            id,
            scopeKey,
            boundary.seq,
            boundary.opIndex,
          );
          if (changed !== 1) {
            throw new Error(
              `${id} (${scopeKey}): the planned patch boundary ${boundary.seq}/${boundary.opIndex} is not there`,
            );
          }
          if (plan.headOpChanges) {
            rewriteHeadOp.run(id, scopeKey, boundary.seq, boundary.opIndex);
          }
          materialized++;
        } else {
          const changed = attributeBoundary.run(
            commitSeq,
            id,
            scopeKey,
            boundary.seq,
            boundary.opIndex,
            boundary.op,
          );
          if (changed !== 1) {
            throw new Error(
              `${id} (${scopeKey}): the planned ${boundary.op} boundary ${boundary.seq}/${boundary.opIndex} is not there`,
            );
          }
        }
        const newest = newestBelow.get<{ seq: number }>(
          id,
          scopeKey,
          boundary.seq,
          boundary.seq,
          boundary.opIndex,
        );
        if (newest !== undefined) {
          lastCommitSeq = Math.max(lastCommitSeq, newest.seq);
        }
        rowsDeleted += deleteBelow.run(
          id,
          scopeKey,
          boundary.seq,
          boundary.seq,
          boundary.opIndex,
        );
        snapshotsDeleted += deleteSnapshots.run(id, scopeKey, boundary.seq);
      });
      instancesCompacted++;
      options.onProgress?.({
        phase: "instance",
        completed: instancesCompacted,
        of: worklist.length,
        plan,
      });
    }

    // 3. Hollowing, in seq-ranged batches (I6). The window is the plan's:
    //    measured from the newest client commit, which the compaction commit
    //    inserted above is not. Exempt: commit 1 (the genesis receipt), the
    //    commits an op_* row references, and every compaction commit, whose
    //    payload is a run's record rather than a client's write.
    let hollowed = 0;
    let hollowedBytes = 0;
    const cutoffAt = report.payloads.cutoffAt;
    if (cutoffAt !== null) {
      const opTables = [
        "op_field_epoch",
        "op_submission",
        "op_integrated",
        "op_checkpoint",
      ];
      const opref = opTables.map((table) => `SELECT commit_seq FROM "${table}"`)
        .join(" UNION ");
      const selectBatch = db.prepare(
        `SELECT seq, original, ${BYTES_OF("original")} AS bytes FROM "commit"
         WHERE seq >= ? AND seq < ? AND seq <> 1 AND created_at <= ?
           AND session_id NOT LIKE ?
           AND seq NOT IN (${opref})
           AND substr(original, 1, ?) <> ?`,
      );
      const hollow = db.prepare(
        `UPDATE "commit" SET original = ? WHERE seq = ?`,
      );
      const maxSeq = db.prepare(`SELECT MAX(seq) AS seq FROM "commit"`).get<
        { seq: number }
      >()!.seq;
      for (let from = 1; from <= maxSeq; from += HOLLOW_BATCH) {
        tx(() => {
          const rows = selectBatch.all<
            { seq: number; original: string; bytes: number }
          >(
            from,
            from + HOLLOW_BATCH,
            cutoffAt,
            `${COMPACTION_SESSION_PREFIX}%`,
            HOLLOWED_MARKER_PREFIX.length,
            HOLLOWED_MARKER_PREFIX,
          );
          for (const row of rows) {
            hollow.run(
              hollowedPayload({
                hollowed: {
                  hash: hashStringOf(row.original),
                  bytes: row.bytes,
                  commitSeq,
                  runId,
                },
              }),
              row.seq,
            );
            hollowed++;
            hollowedBytes += row.bytes;
            lastCommitSeq = Math.max(lastCommitSeq, row.seq);
          }
        });
        options.onProgress?.({
          phase: "hollowing",
          completed: Math.min(from + HOLLOW_BATCH - 1, maxSeq),
          of: maxSeq,
        });
      }
    }

    // 4. The audit revision on the ACL document: a whole-document `set` of
    //    the document as it stands with the `compaction` member beside
    //    `value`, at the compaction commit's seq (INV-12's shape; the head's
    //    one permitted move, I1).
    const acl = tx((): AclOutcome => {
      if (aclHeads.length === 0) return { status: "absent" };
      const id = aclHeads[0].id;
      const document = read(engine, { id: id as never });
      if (document === null) return { status: "deleted", id };
      const previous = document.compaction as CompactionMarker | undefined;
      const runs = Array.isArray(previous?.runs) ? [...previous.runs] : [];
      runs.push({
        commitSeq,
        documents: report.selection.prefixes.join(","),
        truncated: instancesCompacted,
        hollowed,
        lastCommitSeq,
        runId,
      });
      const marker: CompactionMarker = {
        lastCommitSeq: Math.max(
          lastCommitSeq,
          typeof previous?.lastCommitSeq === "number"
            ? previous.lastCommitSeq
            : 0,
        ),
        compactedAt: new Date().toISOString(),
        runs,
      };
      const next: EntityDocument = {
        ...document,
        compaction: storable(marker),
      };
      db.prepare(
        `INSERT INTO revision (branch, id, scope_key, seq, op_index, op, data, commit_seq)
         VALUES ('', ?, 'space', ?, 0, 'set', ?, ?)`,
      ).run(
        id,
        commitSeq,
        encodeMemoryBoundary(next as FabricValue),
        commitSeq,
      );
      db.prepare(
        `UPDATE head SET seq = ?, op_index = 0, op = 'set'
         WHERE branch = '' AND id = ? AND scope_key = 'space'`,
      ).run(commitSeq, id);
      return { status: "marked", id };
    });

    // 5. The checks the plan ends a run with, then the fresh file.
    const violations = db.prepare(`PRAGMA foreign_key_check`).all();
    if (violations.length > 0) {
      throw new Error(
        `PRAGMA foreign_key_check reports ${violations.length} violation(s) after the run; the store is left as it is`,
      );
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const integrity = db.prepare(`PRAGMA integrity_check`).all<
      { integrity_check: string }
    >();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new Error(
        `PRAGMA integrity_check: ${
          integrity.map((row) => row.integrity_check).join("; ")
        }`,
      );
    }
    options.onProgress?.({ phase: "vacuum", out });
    db.prepare(`VACUUM main INTO ?`).run(out);

    return {
      report,
      runId,
      commitSeq,
      sessionId,
      instancesCompacted,
      materialized,
      rowsDeleted,
      snapshotsDeleted,
      hollowed,
      hollowedBytes,
      acl,
      lastCommitSeq,
      out,
      outBytes: fileSize(out),
      elapsedMs: performance.now() - started,
    };
  } finally {
    close(engine);
  }
};

/** The run as an operator reads it. */
export const formatCompactionRun = (run: CompactionRun): string => {
  const lines = [
    `commit     seq ${run.commitSeq} as ${run.sessionId}`,
    `instances  ${n(run.instancesCompacted)} compacted, ${
      n(run.materialized)
    } boundaries materialized`,
    `revisions  ${n(run.rowsDeleted)} rows deleted; snapshots ${
      n(run.snapshotsDeleted)
    } rows deleted`,
    `payloads   ${n(run.hollowed)} commits hollowed, ${
      size(run.hollowedBytes)
    }`,
    `acl        ${
      run.acl.status === "marked"
        ? `${run.acl.id} marked at seq ${run.commitSeq}`
        : run.acl.status === "deleted"
        ? `${run.acl.id} is a tombstone; left as it is`
        : "the store has no ACL document; nothing marked"
    }`,
    `history    compacted through seq ${run.lastCommitSeq}`,
    `result     ${run.out} (${size(run.outBytes)})`,
    `elapsed    ${(run.elapsedMs / 1000).toFixed(1)} s`,
  ];
  return lines.join("\n");
};
