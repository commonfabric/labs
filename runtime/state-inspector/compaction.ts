// Verification of a compacted space store against the backup it was compacted
// from (docs/plans/compact-space.md, §3 "Verification, in order"). Read-only
// on both files, and deliberately a second implementation of what the run
// claims: the heads are compared as rows, the documents through this
// package's replay rather than the engine's, each materialized boundary
// against this package's exact-row reconstruction of the backup, the hollowed
// set against the window the runs recorded, and the structural statements of
// I4, I6 and I7 are checked against the store rather than against the run's
// own report, so that a run that misreported itself is caught by the store it
// left behind. Nothing here throws for what it finds in the files: a payload
// that does not decode, a report that is not a plan, a table that lost rows
// are each a named check that fails.

import { hashStringOf } from "@commonfabric/data-model";
import type { FabricValue } from "@commonfabric/api";
import { isACL } from "@commonfabric/memory/acl";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import {
  type CompactionMarker,
  type CompactionReport,
  decodeHollowedPayload,
  HOLLOWED_MARKER_PREFIX,
} from "@commonfabric/memory/v2/compact";
import { COMPACTION_SESSION_PREFIX } from "@commonfabric/memory/v2/engine";

import { openSpace, type SpaceDb } from "./db.ts";
import { decodeStored } from "./decode.ts";
import {
  contentFingerprint,
  fingerprintReader,
  type FingerprintReport,
} from "./fingerprint.ts";
import {
  type ReconstructOutcome,
  reconstructOutcome,
  reconstructRevision,
} from "./reconstruct.ts";

export type CompactionCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type CompactionCommitRecord = {
  seq: number;
  sessionId: string;
  createdAt: string;
  /** The plan the run stored as its payload, when it decodes as one. */
  report?: CompactionReport;
};

export type CompactionVerification = {
  ok: boolean;
  result: string;
  against: string;
  compactionCommits: CompactionCommitRecord[];
  checks: CompactionCheck[];
  elapsedMs: number;
};

export type VerifyCompactionOptions = {
  /** The compacted store. */
  result: string;
  /** The store it was compacted from: the post-stop backup. */
  against: string;
  /** Reconstruct every n-th document and check every n-th hollowed payload
   * only, and skip the fingerprint: a quick pass during rehearsal, and a
   * weaker claim. Absent, every document and every payload is checked. */
  sample?: number;
};

const ACL_ID_PATTERN = "of:did:%";
/** The tables the history checks cover one by one; every other table is
 * held to the backup whole (I7). */
const HISTORY_TABLES = new Set(["commit", "revision", "snapshot", "head"]);
const OP_TABLES = [
  "op_field_epoch",
  "op_submission",
  "op_integrated",
  "op_checkpoint",
];

const n = (value: number): string => value.toLocaleString("en-US");

const count = (space: SpaceDb, sql: string, ...params: (string | number)[]) =>
  space.get<{ n: number }>(sql, ...params)!.n;

/** Two decoded values compared by their canonical encoding: the one the
 * store writes, with members in key order. */
const sameValue = (left: unknown, right: unknown): boolean =>
  encodeMemoryBoundary(left as FabricValue) ===
    encodeMemoryBoundary(right as FabricValue);

/**
 * The top-level members on which two documents differ: a member present on
 * one side and not the other counts, whatever its value, so an explicit
 * `null` is not the same as an absence.
 */
const differingMembers = (
  left: Record<string, FabricValue>,
  right: Record<string, FabricValue>,
): string[] =>
  [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) =>
    Object.hasOwn(left, key) !== Object.hasOwn(right, key) ||
    !sameValue(left[key] ?? null, right[key] ?? null)
  );

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether a decoded payload is a plan the run stored, shaped as the
 * checks below read it. */
const isReportShape = (value: unknown): value is CompactionReport => {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  const instances = report.instances as Record<string, unknown> | undefined;
  const payloads = report.payloads as Record<string, unknown> | undefined;
  const hollowed = payloads?.hollowed as Record<string, unknown> | undefined;
  const commit = report.compactionCommit as Record<string, unknown> | undefined;
  const commits = (side: unknown) =>
    typeof (side as Record<string, unknown> | undefined)?.commits === "number";
  return typeof instances?.truncated === "number" &&
    typeof instances?.headOpChanges === "number" &&
    (payloads?.cutoffAt === null || typeof payloads?.cutoffAt === "string") &&
    commits(hollowed?.owningHead) && commits(hollowed?.headless) &&
    typeof commit?.seq === "number" && typeof commit?.sessionId === "string";
};

/** The marker a hollowed payload holds, or why it is not one. */
const marker = (
  original: string,
): { marker: NonNullable<ReturnType<typeof decodeHollowedPayload>> } | {
  error: string;
} => {
  try {
    const decoded = decodeHollowedPayload(original);
    if (
      decoded === undefined || typeof decoded.hash !== "string" ||
      typeof decoded.bytes !== "number" ||
      typeof decoded.commitSeq !== "number" || typeof decoded.runId !== "string"
    ) {
      return { error: "not a hollowing marker" };
    }
    return { marker: decoded };
  } catch (error) {
    return { error: message(error) };
  }
};

/**
 * Verifies `result` against `against`: steps 1 to 6 of the plan's §3, each
 * a named check that passes or fails on its own, so a failing verification
 * says which property the result lost. Throws only when a file cannot be
 * opened or attached; everything found inside the files is a check.
 */
export function verifyCompaction(
  options: VerifyCompactionOptions,
): CompactionVerification {
  const started = performance.now();
  const checks: CompactionCheck[] = [];
  let records: CompactionCommitRecord[] = [];
  const check = (name: string, passed: boolean, detail: string) => {
    checks.push({ name, passed, detail });
  };
  const finish = (ok: boolean): CompactionVerification => ({
    ok,
    result: options.result,
    against: options.against,
    compactionCommits: records,
    checks,
    elapsedMs: performance.now() - started,
  });
  const stride = options.sample === undefined || options.sample <= 0
    ? 1
    : Math.floor(options.sample);
  const sampled = stride > 1 || options.sample !== undefined;

  const main = openSpace(options.result);
  const backup = openSpace(options.against);
  try {
    // The backup is attached to the result's connection, so that every
    // row-level comparison is one SQL statement over both files. The
    // connection is read-only, and so is what it attaches.
    main.db.prepare(`ATTACH DATABASE ? AS against`).run(options.against);

    // 1. The file itself.
    const integrity = main.all<{ integrity_check: string }>(
      `PRAGMA integrity_check`,
    );
    check(
      "integrity_check",
      integrity.length === 1 && integrity[0].integrity_check === "ok",
      integrity.map((row) => row.integrity_check).join("; "),
    );
    const violations = main.all(`PRAGMA main.foreign_key_check`).length;
    check(
      "foreign_key_check",
      violations === 0,
      violations === 0 ? "no violations" : `${n(violations)} violation(s)`,
    );

    // The compaction commits: what the run inserted, and what it planned.
    const commits = main.all<{
      seq: number;
      branch: string;
      session_id: string;
      local_seq: number;
      created_at: string;
      original: string;
      class: string;
    }>(
      `SELECT seq, branch, session_id, local_seq, created_at, original, class
       FROM main."commit" WHERE session_id LIKE ? ORDER BY seq`,
      `${COMPACTION_SESSION_PREFIX}%`,
    );
    const malformed: string[] = [];
    records = commits.map((row) => {
      let report: CompactionReport | undefined;
      try {
        const payload = decodeStored(row.original) as {
          compaction?: { report?: unknown };
        };
        const candidate = payload?.compaction?.report;
        if (isReportShape(candidate)) {
          report = candidate;
          if (
            candidate.compactionCommit.seq !== row.seq ||
            candidate.compactionCommit.sessionId !== row.session_id
          ) {
            malformed.push(
              `seq ${row.seq}: its plan names ${candidate.compactionCommit.sessionId} at seq ${candidate.compactionCommit.seq}`,
            );
          }
        } else {
          malformed.push(`seq ${row.seq}: payload is not a run's plan`);
        }
      } catch (error) {
        malformed.push(
          `seq ${row.seq}: payload does not decode (${message(error)})`,
        );
      }
      if (row.class !== "system") {
        malformed.push(`seq ${row.seq}: class ${row.class}`);
      }
      if (row.local_seq !== 1) {
        malformed.push(`seq ${row.seq}: local_seq ${row.local_seq}`);
      }
      if (row.branch !== "") {
        malformed.push(`seq ${row.seq}: branch ${row.branch}`);
      }
      return {
        seq: row.seq,
        sessionId: row.session_id,
        createdAt: row.created_at,
        ...(report === undefined ? {} : { report }),
      };
    });
    check(
      "compaction commit recorded",
      commits.length > 0 && malformed.length === 0,
      commits.length === 0
        ? "no compaction commit in the result"
        : `${commits.length} run(s): ${
          commits.map((row) => `seq ${row.seq} (${row.session_id})`).join(", ")
        }${malformed.length === 0 ? "" : `; ${malformed.join("; ")}`}`,
    );
    if (commits.length === 0) return finish(false);
    const seqs = commits.map((row) => row.seq);
    const inCompaction = `IN (${seqs.join(", ")})`;
    // The runs this result adds to the backup, as against the runs the backup
    // already held: an earlier run's commit, audit revision and markers are
    // the backup's rows, held to it like any other; this result's own are
    // what the checks below judge.
    const preexisting = new Set(
      main.all<{ seq: number }>(
        `SELECT seq FROM against."commit" WHERE session_id LIKE ?`,
        `${COMPACTION_SESSION_PREFIX}%`,
      ).map((row) => row.seq),
    );
    const newSeqs = seqs.filter((seq) => !preexisting.has(seq));
    check(
      "compaction commit added",
      newSeqs.length > 0,
      newSeqs.length > 0
        ? `${newSeqs.length} run(s) this result adds: seq ${
          newSeqs.join(", ")
        }` + (preexisting.size > 0
          ? `; ${preexisting.size} already in the backup`
          : "")
        : "every compaction commit is already in the backup: the result is not a compaction of it",
    );
    if (newSeqs.length === 0) return finish(false);
    const inNew = `IN (${newSeqs.join(", ")})`;
    const last = newSeqs[newSeqs.length - 1];
    const headSeq = main.get<{ head_seq: number }>(
      `SELECT head_seq FROM main.branch WHERE name = ''`,
    )?.head_seq;
    check(
      "branch head at the compaction commit",
      headSeq === last,
      `branch.head_seq ${headSeq}, compaction commit ${last}`,
    );
    const newer = count(
      main,
      `SELECT count(*) AS n FROM main."commit" WHERE seq > ?`,
      last,
    );
    check(
      "no commit after the compaction commit",
      newer === 0,
      newer === 0
        ? "the compaction commit is the newest"
        : `${n(newer)} commit(s) after it: the result was written to`,
    );

    // 2. Heads unchanged, one excepted.
    const headColumns = "branch, id, scope_key, seq, op_index";
    const missingHeads = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT ${headColumns} FROM against.head WHERE id NOT LIKE ?
         EXCEPT SELECT ${headColumns} FROM main.head WHERE id NOT LIKE ?)`,
      ACL_ID_PATTERN,
      ACL_ID_PATTERN,
    );
    const extraHeads = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT ${headColumns} FROM main.head WHERE id NOT LIKE ?
         EXCEPT SELECT ${headColumns} FROM against.head WHERE id NOT LIKE ?)`,
      ACL_ID_PATTERN,
      ACL_ID_PATTERN,
    );
    const heads = count(
      main,
      `SELECT count(*) AS n FROM main.head WHERE id NOT LIKE ?`,
      ACL_ID_PATTERN,
    );
    check(
      "heads keep their addresses",
      missingHeads === 0 && extraHeads === 0,
      `${n(heads)} heads; ${n(missingHeads)} moved or lost, ${
        n(extraHeads)
      } unexpected`,
    );
    const unjoined = count(
      main,
      `SELECT count(*) AS n FROM main.head h
       LEFT JOIN main.revision r ON r.branch = h.branch AND r.id = h.id
         AND r.scope_key = h.scope_key AND r.seq = h.seq AND r.op_index = h.op_index
       WHERE r.seq IS NULL`,
    );
    check(
      "every head has its revision row",
      unjoined === 0,
      unjoined === 0 ? "all join" : `${n(unjoined)} head(s) join to no row`,
    );
    const opChanges = main.all<{ before: string; after: string; n: number }>(
      `SELECT a.op AS before, m.op AS after, count(*) AS n
       FROM main.head m JOIN against.head a
         ON a.branch = m.branch AND a.id = m.id AND a.scope_key = m.scope_key
       WHERE m.op <> a.op AND m.id NOT LIKE ?
       GROUP BY a.op, m.op`,
      ACL_ID_PATTERN,
    );
    const materializedHeads = opChanges.find((row) =>
      row.before === "patch" && row.after === "set"
    )?.n ?? 0;
    const otherOpChanges = opChanges.filter((row) =>
      !(row.before === "patch" && row.after === "set")
    );
    check(
      "head ops change only from patch to set",
      otherOpChanges.length === 0,
      `${n(materializedHeads)} head(s) materialized` +
        (otherOpChanges.length === 0
          ? ""
          : `; ${
            otherOpChanges.map((row) =>
              `${n(row.n)} ${row.before}→${row.after}`
            )
              .join(", ")
          }`),
    );

    // The rows pointing at a compaction commit, and what they may be: an
    // instance's oldest row (its boundary), or an ACL audit revision at the
    // commit's own seq.
    const notAudit =
      `NOT (r.id LIKE '${ACL_ID_PATTERN}' AND r.seq = r.commit_seq AND r.op_index = 0)`;
    const boundaries = count(
      main,
      `SELECT count(*) AS n FROM main.revision r
       WHERE r.commit_seq ${inCompaction} AND ${notAudit}`,
    );
    const aclRevisions = count(
      main,
      `SELECT count(*) AS n FROM main.revision r
       WHERE r.commit_seq ${inCompaction} AND r.id LIKE ? AND r.seq = r.commit_seq
         AND r.op_index = 0 AND r.op = 'set'`,
      ACL_ID_PATTERN,
    );
    const newAudits = main.all<{ seq: number }>(
      `SELECT r.seq FROM main.revision r
       WHERE r.commit_seq ${inNew} AND r.id LIKE ? AND r.seq = r.commit_seq
         AND r.op_index = 0 AND r.op = 'set' ORDER BY r.seq`,
      ACL_ID_PATTERN,
    ).map((row) => row.seq);
    const boundariesWithRowsBelow = count(
      main,
      `SELECT count(*) AS n FROM main.revision r
       WHERE r.commit_seq ${inCompaction} AND ${notAudit}
         AND EXISTS (SELECT 1 FROM main.revision b
           WHERE b.branch = r.branch AND b.id = r.id AND b.scope_key = r.scope_key
             AND (b.seq < r.seq OR (b.seq = r.seq AND b.op_index < r.op_index)))`,
    );
    const boundariesNotBases = count(
      main,
      `SELECT count(*) AS n FROM main.revision r
       WHERE r.commit_seq ${inCompaction} AND r.op NOT IN ('set', 'delete')`,
    );
    check(
      "rows attributed to a compaction commit are boundaries",
      boundariesWithRowsBelow === 0 && boundariesNotBases === 0,
      `${n(boundaries)} boundary row(s), ${n(aclRevisions)} ACL revision(s)` +
        (boundariesWithRowsBelow === 0
          ? ""
          : `; ${n(boundariesWithRowsBelow)} with rows still below them`) +
        (boundariesNotBases === 0
          ? ""
          : `; ${n(boundariesNotBases)} that are not a set or delete`),
    );

    // Every row not attributed to a compaction commit is the backup's, byte
    // for byte, attribution included; every boundary row sits where a backup
    // row sat and changed only as the plan states; every backup row the
    // result lacks is below a surviving row of its instance and above none.
    const rowColumns =
      "branch, id, scope_key, seq, op_index, op, data, commit_seq";
    const changedRows = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT ${rowColumns} FROM main.revision WHERE commit_seq NOT ${inCompaction}
         EXCEPT SELECT ${rowColumns} FROM against.revision)`,
    );
    check(
      "rows above the boundaries are byte-identical",
      changedRows === 0,
      changedRows === 0
        ? "every untouched row matches the backup"
        : `${n(changedRows)} row(s) differ from the backup or were added`,
    );
    const boundaryColumns = "branch, id, scope_key, seq, op_index";
    const boundariesMoved = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT ${boundaryColumns} FROM main.revision r
         WHERE r.commit_seq ${inCompaction} AND ${notAudit}
         EXCEPT SELECT ${boundaryColumns} FROM against.revision)`,
    );
    const boundariesRewrittenWrong = count(
      main,
      `SELECT count(*) AS n FROM main.revision r JOIN against.revision a
         ON a.branch = r.branch AND a.id = r.id AND a.scope_key = r.scope_key
         AND a.seq = r.seq AND a.op_index = r.op_index
       WHERE r.commit_seq ${inCompaction} AND ${notAudit}
         AND NOT ((a.op = 'patch' AND r.op = 'set')
               OR (a.op = r.op AND a.data IS r.data))`,
    );
    check(
      "boundaries keep their addresses and change only as the plan states",
      boundariesMoved === 0 && boundariesRewrittenWrong === 0,
      (boundariesMoved === 0
        ? "every boundary sits where a backup row sat"
        : `${
          n(boundariesMoved)
        } boundary row(s) at addresses the backup lacks`) +
        (boundariesRewrittenWrong === 0
          ? ""
          : `; ${
            n(boundariesRewrittenWrong)
          } boundary row(s) whose op or data changed other than patch to set`),
    );
    // A materialized boundary holds exactly what the backup reconstructs at
    // that row — not merely something the retained rows then patch into the
    // right head. This package's exact-row reconstruction, against the
    // engine's.
    const materialized = main.all<{
      branch: string;
      id: string;
      scope_key: string;
      seq: number;
      op_index: number;
      data: string | null;
    }>(
      `SELECT r.branch, r.id, r.scope_key, r.seq, r.op_index, r.data
       FROM main.revision r JOIN against.revision a
         ON a.branch = r.branch AND a.id = r.id AND a.scope_key = r.scope_key
         AND a.seq = r.seq AND a.op_index = r.op_index
       WHERE r.commit_seq ${inCompaction} AND ${notAudit}
         AND a.op = 'patch' AND r.op = 'set'
       ORDER BY r.id, r.scope_key, r.seq, r.op_index`,
    );
    const wrongBoundaries: string[] = [];
    let boundariesCompared = 0;
    for (let index = 0; index < materialized.length; index += stride) {
      const row = materialized[index];
      boundariesCompared++;
      let same = false;
      try {
        const expected = reconstructRevision(backup, {
          branch: row.branch,
          id: row.id,
          scope: row.scope_key,
          seq: row.seq,
          opIndex: row.op_index,
        });
        same = row.data !== null && expected !== undefined &&
          sameValue(decodeStored(row.data), expected);
      } catch {
        same = false;
      }
      if (!same && wrongBoundaries.length < 5) {
        wrongBoundaries.push(
          `${row.id} (${row.scope_key}) at ${row.seq}/${row.op_index}`,
        );
      }
    }
    check(
      "materialized boundaries hold the backup's state at their row",
      wrongBoundaries.length === 0,
      `${n(boundariesCompared)} of ${n(materialized.length)} compared` +
        (stride > 1 ? ` (every ${stride}th)` : "") +
        (wrongBoundaries.length === 0
          ? ""
          : `; differ: ${wrongBoundaries.join(", ")}`),
    );
    const deletedRows = count(
      main,
      `SELECT count(*) AS n FROM against.revision a
       WHERE NOT EXISTS (SELECT 1 FROM main.revision m
         WHERE m.branch = a.branch AND m.id = a.id AND m.scope_key = a.scope_key
           AND m.seq = a.seq AND m.op_index = a.op_index)`,
    );
    const holes = count(
      main,
      `SELECT count(*) AS n FROM against.revision a
       WHERE NOT EXISTS (SELECT 1 FROM main.revision m
         WHERE m.branch = a.branch AND m.id = a.id AND m.scope_key = a.scope_key
           AND m.seq = a.seq AND m.op_index = a.op_index)
         AND (
           EXISTS (SELECT 1 FROM main.revision b
             WHERE b.branch = a.branch AND b.id = a.id AND b.scope_key = a.scope_key
               AND (b.seq < a.seq OR (b.seq = a.seq AND b.op_index < a.op_index)))
           OR NOT EXISTS (SELECT 1 FROM main.revision u
             WHERE u.branch = a.branch AND u.id = a.id AND u.scope_key = a.scope_key
               AND (u.seq > a.seq OR (u.seq = a.seq AND u.op_index > a.op_index))
               AND u.commit_seq ${inCompaction}))`,
    );
    check(
      "deleted rows lie below a boundary and above no surviving row",
      holes === 0,
      `${n(deletedRows)} row(s) deleted` +
        (holes === 0 ? "" : `; ${n(holes)} left a hole or lost an instance`),
    );
    // Snapshots: none added or altered; none removed except at or below a
    // boundary of a compacted instance, where the run deletes them.
    const snapshotColumns = "branch, id, scope_key, seq, value";
    const snapshotsAdded = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT ${snapshotColumns} FROM main.snapshot
         EXCEPT SELECT ${snapshotColumns} FROM against.snapshot)`,
    );
    const snapshotsRemoved = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT ${snapshotColumns} FROM against.snapshot
         EXCEPT SELECT ${snapshotColumns} FROM main.snapshot)`,
    );
    const snapshotsRemovedWrongly = count(
      main,
      `SELECT count(*) AS n FROM against.snapshot s
       WHERE NOT EXISTS (SELECT 1 FROM main.snapshot m
           WHERE m.branch = s.branch AND m.id = s.id AND m.scope_key = s.scope_key AND m.seq = s.seq)
         AND NOT EXISTS (SELECT 1 FROM main.revision r
           WHERE r.branch = s.branch AND r.id = s.id AND r.scope_key = s.scope_key
             AND r.commit_seq ${inCompaction} AND ${notAudit}
             AND s.seq <= r.seq)`,
    );
    const snapshotsBelowBoundary = count(
      main,
      `SELECT count(*) AS n FROM main.snapshot s
       WHERE EXISTS (SELECT 1 FROM main.revision r
         WHERE r.branch = s.branch AND r.id = s.id AND r.scope_key = s.scope_key
           AND r.commit_seq ${inCompaction} AND ${notAudit}
           AND s.seq <= r.seq)`,
    );
    check(
      "snapshots are the backup's, removed only at or below a boundary",
      snapshotsAdded === 0 && snapshotsRemovedWrongly === 0 &&
        snapshotsBelowBoundary === 0,
      `${n(snapshotsRemoved)} snapshot(s) removed` +
        (snapshotsAdded === 0
          ? ""
          : `; ${n(snapshotsAdded)} added or altered`) +
        (snapshotsRemovedWrongly === 0
          ? ""
          : `; ${
            n(snapshotsRemovedWrongly)
          } removed above a boundary or from an untouched instance`) +
        (snapshotsBelowBoundary === 0
          ? ""
          : `; ${n(snapshotsBelowBoundary)} still at or below a boundary`),
    );

    // 3. Every document reads back identical, one excepted.
    const instances = main.all<{ id: string; scope_key: string }>(
      `SELECT id, scope_key FROM main.head WHERE branch = '' AND id NOT LIKE ?
       ORDER BY id, scope_key`,
      ACL_ID_PATTERN,
    );
    let compared = 0;
    const mismatches: { index: number; address: string }[] = [];
    const visited = new Uint8Array(instances.length);
    const leftReader = sampled ? undefined : fingerprintReader(main);

    /** Checks one head, optionally using a fingerprint's primary read. */
    const compareHead = (index: number, knownRight?: ReconstructOutcome) => {
      const { id, scope_key } = instances[index];
      visited[index] = 1;
      compared++;
      const at = { id, scope: scope_key };
      const left = leftReader === undefined
        ? reconstructOutcome(main, at)
        : leftReader.read(at);
      const right = knownRight ?? reconstructOutcome(backup, at);
      // Two unreadable payloads are not the same document: an identical
      // status proves nothing when the status is that nothing could be read.
      const same = left.status === right.status &&
        left.status !== "undecodable" &&
        (left.status !== "present" || right.status !== "present" ||
          sameValue(left.document, right.document));
      if (!same) {
        mismatches.push({ index, address: `${id} (${scope_key})` });
        mismatches.sort((a, b) => a.index - b.index);
        if (mismatches.length > 5) mismatches.pop();
      }
    };

    let rightPrint: FingerprintReport | undefined;
    let rightPrintError: { error: unknown } | undefined;
    let comparisonError: { index: number; error: unknown } | undefined;
    if (!sampled) {
      const headIndices = new Map<string, Map<string, number>>();
      for (const [index, row] of instances.entries()) {
        let ids = headIndices.get(row.scope_key);
        if (ids === undefined) headIndices.set(row.scope_key, ids = new Map());
        ids.set(row.id, index);
      }
      try {
        rightPrint = contentFingerprint(backup, {
          onEntity: (at, outcome) => {
            const index = headIndices.get(at.scope)?.get(at.id);
            if (index === undefined) return;
            try {
              compareHead(index, outcome);
            } catch (error) {
              if (
                comparisonError === undefined || index < comparisonError.index
              ) {
                comparisonError = { index, error };
              }
            }
          },
        });
      } catch (error) {
        rightPrintError = { error };
      }
    }
    // A fingerprint may refuse a cap or fail before reaching a head. A head
    // may also have no revision. Every such address still gets its comparison.
    for (let index = 0; index < instances.length; index += stride) {
      if (visited[index] !== 0) continue;
      try {
        compareHead(index);
      } catch (error) {
        if (comparisonError === undefined || index < comparisonError.index) {
          comparisonError = { index, error };
        }
      }
    }
    if (comparisonError !== undefined) throw comparisonError.error;
    check(
      "every document reads back identical",
      mismatches.length === 0,
      `${n(compared)} of ${n(instances.length)} instance(s) compared` +
        (stride > 1 ? ` (every ${stride}th)` : "") +
        (mismatches.length === 0
          ? ""
          : `; differ or unreadable: ${
            mismatches.map((entry) => entry.address).join(", ")
          }`),
    );

    // The ACL document. With a live one in the backup: a `set` at the newest
    // compaction commit, `value` unchanged and an ACL, `compaction` the only
    // member that differs and naming that commit. With a tombstone or none:
    // untouched — the head exactly where the backup's was, no audit revision.
    type AclHead = { id: string; seq: number; op_index: number; op: string };
    const aclHeads = main.all<AclHead>(
      `SELECT id, seq, op_index, op FROM main.head WHERE branch = '' AND scope_key = 'space' AND id LIKE ?`,
      ACL_ID_PATTERN,
    );
    const aclHeadsBefore = main.all<AclHead>(
      `SELECT id, seq, op_index, op FROM against.head WHERE branch = '' AND scope_key = 'space' AND id LIKE ?`,
      ACL_ID_PATTERN,
    );
    if (aclHeadsBefore.length === 0) {
      check(
        "ACL document",
        aclHeads.length === 0 && newAudits.length === 0,
        aclHeads.length === 0
          ? "the space has no ACL document; none was written"
          : "the backup has no ACL document but the result does",
      );
    } else if (aclHeadsBefore.length > 1 || aclHeads.length > 1) {
      check(
        "ACL document",
        false,
        `${aclHeadsBefore.length} ACL document(s) in the backup, ${aclHeads.length} in the result`,
      );
    } else {
      const before = aclHeadsBefore[0];
      const head = aclHeads.find((row) => row.id === before.id);
      const headText = head === undefined
        ? "missing"
        : `${head.seq}/${head.op_index} ${head.op}`;
      if (before.op === "delete") {
        const untouched = head !== undefined && head.seq === before.seq &&
          head.op_index === before.op_index && head.op === "delete" &&
          newAudits.length === 0;
        check(
          "ACL document",
          untouched,
          `tombstone in the backup at ${before.seq}/${before.op_index}; result head ${headText}` +
            (newAudits.length === 0
              ? ""
              : `; ${n(newAudits.length)} audit revision(s) written over it`),
        );
      } else {
        const left = reconstructOutcome(main, {
          id: before.id,
          scope: "space",
        });
        const right = reconstructOutcome(backup, {
          id: before.id,
          scope: "space",
        });
        let passed = false;
        let detail: string;
        if (left.status !== "present" || right.status !== "present") {
          detail =
            `the ACL document is ${left.status} in the result and ${right.status} in the backup`;
        } else {
          const was = right.document as Record<string, FabricValue>;
          // Every audit revision this result adds is held to the backup's
          // document — not only the one the head reads. A run interrupted
          // after its audit left one behind, and a changed owner in it would
          // be history a reader of the log believes.
          const audits = main.all<{ seq: number; data: string | null }>(
            `SELECT seq, data FROM main.revision
             WHERE id = ? AND scope_key = 'space' AND branch = '' AND op_index = 0 AND op = 'set'
               AND seq IN (${newAudits.join(", ") || "NULL"}) ORDER BY seq`,
            before.id,
          );
          const problems: string[] = [];
          for (const audit of audits) {
            let document: Record<string, FabricValue>;
            try {
              document = decodeStored(audit.data ?? "") as Record<
                string,
                FabricValue
              >;
              if (typeof document !== "object" || document === null) {
                throw new Error("not a document");
              }
            } catch (error) {
              problems.push(
                `seq ${audit.seq}: does not decode (${message(error)})`,
              );
              continue;
            }
            const differing = differingMembers(document, was);
            if (!differing.every((key) => key === "compaction")) {
              problems.push(
                `seq ${audit.seq}: differs from the backup in ${
                  differing.join(", ")
                }`,
              );
            }
            if (!isACL(document.value)) {
              problems.push(`seq ${audit.seq}: value is not an ACL`);
            }
            // The marker is read as data: a member that is not an object
            // holding `runs`, or whose newest run is another commit, fails.
            const record = document.compaction;
            const marker = typeof record === "object" && record !== null &&
                Array.isArray((record as CompactionMarker).runs)
              ? record as CompactionMarker
              : undefined;
            const lastRun = marker?.runs[marker.runs.length - 1];
            if (
              marker === undefined || typeof lastRun !== "object" ||
              lastRun === null || lastRun.commitSeq !== audit.seq
            ) {
              problems.push(
                `seq ${audit.seq}: marker ${
                  marker === undefined
                    ? "malformed or missing"
                    : "names another run"
                }`,
              );
            }
          }
          const headAtCommit = head !== undefined && head.seq === last &&
            head.op_index === 0 && head.op === "set";
          // The newest run this result adds wrote the audit the head reads;
          // an earlier new run wrote one only if it got that far before an
          // interruption, and none if it did not.
          const auditAtLast = newAudits.length > 0 &&
            newAudits[newAudits.length - 1] === last;
          passed = problems.length === 0 && headAtCommit && auditAtLast;
          detail =
            `${n(newAudits.length)} audit revision(s) for ${
              n(newSeqs.length)
            } new run(s)${
              auditAtLast
                ? `, the newest at seq ${last}`
                : ", none at the newest run"
            }; head ${headText}` +
            (problems.length === 0
              ? "; value unchanged and an ACL in each"
              : `; ${problems.join("; ")}`);
        }
        check("ACL document", passed, detail);
      }
    }

    // I7: everything that is not revision history is untouched — the schema,
    // and every table but the four the checks above take apart, row for row
    // with multiplicity. Pattern-created tables are among them.
    const schemaDiff = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT type, name, tbl_name, sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%'
         EXCEPT SELECT type, name, tbl_name, sql FROM against.sqlite_master WHERE name NOT LIKE 'sqlite_%')
       UNION ALL
       SELECT count(*) FROM (
         SELECT type, name, tbl_name, sql FROM against.sqlite_master WHERE name NOT LIKE 'sqlite_%'
         EXCEPT SELECT type, name, tbl_name, sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%')`,
    ) + (main.all<{ n: number }>(
      `SELECT count(*) AS n FROM (
         SELECT type, name, tbl_name, sql FROM against.sqlite_master WHERE name NOT LIKE 'sqlite_%'
         EXCEPT SELECT type, name, tbl_name, sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%')`,
    )[0]?.n ?? 0);
    check(
      "schema identical",
      schemaDiff === 0,
      schemaDiff === 0
        ? "every table, index, view and trigger declared alike"
        : `${n(schemaDiff)} schema object(s) differ`,
    );
    const otherTables = main.all<{ name: string }>(
      `SELECT name FROM against.sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).map((row) => row.name).filter((name) => !HISTORY_TABLES.has(name));
    const tableDiffs: string[] = [];
    for (const table of otherTables) {
      const inMain = main.get(
        `SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?`,
        table,
      ) !== undefined;
      if (!inMain) {
        tableDiffs.push(`${table} missing from the result`);
        continue;
      }
      // Each value is compared under BINARY collation beside its storage
      // class: the collation compares a text's full bytes (a declared NOCASE
      // cannot merge two cases, an embedded NUL ends nothing), and the class
      // keeps an integer 1 apart from a real 1.0 and a text '1', which the
      // value comparison alone would not. Nothing is rendered or cast, so
      // nothing is lost on the way.
      const columns = main.all<{ name: string }>(
        `SELECT name FROM pragma_table_info(?)`,
        table,
      ).map((column) => `"${column.name.replace(/"/g, '""')}"`)
        // The branch head advances to the compaction commit by design.
        .filter((column) => !(table === "branch" && column === '"head_seq"'))
        .flatMap((column) => [
          `typeof(${column})`,
          `${column} COLLATE BINARY`,
        ]);
      const list = columns.join(", ");
      const quoted = `"${table.replace(/"/g, '""')}"`;
      const grouped = (schema: string) =>
        `SELECT ${list}, count(*) AS n FROM ${schema}.${quoted} GROUP BY ${list}`;
      const diff = count(
        main,
        `SELECT count(*) AS n FROM (${grouped("main")} EXCEPT ${
          grouped("against")
        })`,
      ) + count(
        main,
        `SELECT count(*) AS n FROM (${grouped("against")} EXCEPT ${
          grouped("main")
        })`,
      );
      if (diff > 0) tableDiffs.push(`${table}: ${n(diff)} row group(s) differ`);
    }
    check(
      "tables outside the history are untouched",
      tableDiffs.length === 0,
      `${n(otherTables.length)} table(s) compared` +
        (tableDiffs.length === 0 ? "" : `; ${tableDiffs.join("; ")}`),
    );

    // 4. Complete the fingerprints whose primary reads also served the head
    // comparison. Fingerprint failures are reported in result/backup order.
    if (!sampled) {
      try {
        const leftPrint = leftReader!.finish();
        if (rightPrintError !== undefined) throw rightPrintError.error;
        if (rightPrint === undefined) {
          throw new Error("The backup fingerprint has no result.");
        }
        check(
          "fingerprint",
          leftPrint.hash === rightPrint.hash,
          leftPrint.hash === rightPrint.hash
            ? `${leftPrint.hash} on both`
            : `${leftPrint.hash} ≠ ${rightPrint.hash}`,
        );
      } catch (error) {
        check("fingerprint", false, `could not be computed: ${message(error)}`);
      }
    }

    // 5. Hollowed payloads: exactly the set the runs' windows reach, each
    //    marker naming a compaction commit and the bytes it replaced; every
    //    other commit column and every commit row the backup's.
    const hollowedRows = main.all<{ seq: number; original: string }>(
      `SELECT seq, original FROM main."commit" WHERE substr(original, 1, ?) = ? ORDER BY seq`,
      HOLLOWED_MARKER_PREFIX.length,
      HOLLOWED_MARKER_PREFIX,
    );
    const hollowedSeqs = new Set(hollowedRows.map((row) => row.seq));
    const cutoffs = records.map((record) => record.report?.payloads.cutoffAt)
      .filter((at): at is string => typeof at === "string");
    const payloadProblems: string[] = [];
    if (cutoffs.length === 0) {
      payloadProblems.push("no run recorded a payload window");
    } else {
      const cutoff = cutoffs.reduce((a, b) => (a > b ? a : b));
      const opTables = OP_TABLES.filter((table) =>
        main.get(
          `SELECT 1 FROM against.sqlite_master WHERE type = 'table' AND name = ?`,
          table,
        ) !==
          undefined
      );
      const opref = opTables.length === 0
        ? "SELECT NULL WHERE 0"
        : opTables.map((table) => `SELECT commit_seq FROM against."${table}"`)
          .join(" UNION ");
      const eligible = main.all<{ seq: number }>(
        `SELECT seq FROM against."commit"
         WHERE created_at <= ? AND seq <> 1 AND session_id NOT LIKE ?
           AND seq NOT IN (${opref})
         ORDER BY seq`,
        cutoff,
        `${COMPACTION_SESSION_PREFIX}%`,
      ).map((row) => row.seq);
      const eligibleSet = new Set(eligible);
      const notHollowed = eligible.filter((seq) => !hollowedSeqs.has(seq));
      const notEligible = hollowedRows.filter((row) =>
        !eligibleSet.has(row.seq)
      );
      if (notHollowed.length > 0) {
        payloadProblems.push(
          `${n(notHollowed.length)} payload(s) outside the window kept (seq ${
            notHollowed.slice(0, 5).join(", ")
          }${notHollowed.length > 5 ? ", …" : ""})`,
        );
      }
      if (notEligible.length > 0) {
        payloadProblems.push(
          `${
            n(notEligible.length)
          } payload(s) hollowed inside the window or exempt (seq ${
            notEligible.slice(0, 5).map((row) => row.seq).join(", ")
          }${notEligible.length > 5 ? ", …" : ""})`,
        );
      }
    }
    let hashed = 0;
    let hashMismatches = 0;
    const badMarkers: string[] = [];
    const backupPayload = (seq: number) =>
      backup.get<{ original: string; bytes: number }>(
        `SELECT original, length(CAST(original AS BLOB)) AS bytes FROM "commit" WHERE seq = ?`,
        seq,
      );
    for (let index = 0; index < hollowedRows.length; index += stride) {
      const row = hollowedRows[index];
      hashed++;
      const decoded = marker(row.original);
      if ("error" in decoded) {
        if (badMarkers.length < 5) {
          badMarkers.push(`seq ${row.seq}: ${decoded.error}`);
        }
        continue;
      }
      const before = backupPayload(row.seq);
      if (before === undefined) {
        hashMismatches++;
        continue;
      }
      // A payload an earlier run hollowed is a marker in the backup too, and
      // stays byte for byte; a payload this run hollowed hashes to its marker.
      const same = before.original.startsWith(HOLLOWED_MARKER_PREFIX)
        ? before.original === row.original
        : decoded.marker.hash === hashStringOf(before.original) &&
          decoded.marker.bytes === before.bytes &&
          seqs.includes(decoded.marker.commitSeq);
      if (!same) hashMismatches++;
    }
    check(
      "hollowed payloads",
      payloadProblems.length === 0 && hashMismatches === 0 &&
        badMarkers.length === 0,
      `${n(hollowedRows.length)} hollowed; ${
        n(hashed)
      } marker(s) checked against the backup` +
        (stride > 1 ? ` (every ${stride}th)` : "") +
        (hashMismatches === 0 ? "" : `, ${n(hashMismatches)} mismatch`) +
        (badMarkers.length === 0
          ? ""
          : `; malformed: ${badMarkers.join("; ")}`) +
        (payloadProblems.length === 0 ? "" : `; ${payloadProblems.join("; ")}`),
    );
    const commitColumns = main.all<{ name: string }>(
      `SELECT name FROM pragma_table_info('commit')`,
    ).map((column) => column.name).filter((name) => name !== "original")
      .map((name) => `"${name}"`).join(", ");
    const commitsChanged = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT ${commitColumns} FROM main."commit" WHERE seq NOT ${inNew}
         EXCEPT SELECT ${commitColumns} FROM against."commit")`,
    );
    const commitsLost = count(
      main,
      `SELECT count(*) AS n FROM against."commit" a
       WHERE NOT EXISTS (SELECT 1 FROM main."commit" m WHERE m.seq = a.seq)`,
    );
    const payloadsChanged = count(
      main,
      `SELECT count(*) AS n FROM main."commit" m JOIN against."commit" a ON a.seq = m.seq
       WHERE m.original <> a.original AND substr(m.original, 1, ?) <> ?`,
      HOLLOWED_MARKER_PREFIX.length,
      HOLLOWED_MARKER_PREFIX,
    );
    check(
      "every commit row survives; only payloads go",
      commitsChanged === 0 && commitsLost === 0 && payloadsChanged === 0,
      (commitsLost === 0
        ? "no commit row lost"
        : `${n(commitsLost)} commit row(s) lost`) +
        (commitsChanged === 0
          ? ""
          : `; ${
            n(commitsChanged)
          } commit row(s) changed in a column other than the payload`) +
        (payloadsChanged === 0
          ? ""
          : `; ${n(payloadsChanged)} payload(s) changed without a marker`),
    );

    // The cross-check against the plan, when this result adds exactly one
    // run: what that run attributed, materialized and hollowed, as against
    // what the backup already held.
    const newRecord = records.find((record) => record.seq === last);
    if (newSeqs.length === 1 && newRecord?.report !== undefined) {
      const plan = newRecord.report;
      const plannedHollowed = plan.payloads.hollowed.owningHead.commits +
        plan.payloads.hollowed.headless.commits;
      const newBoundaries = count(
        main,
        `SELECT count(*) AS n FROM main.revision r
         WHERE r.commit_seq ${inNew} AND ${notAudit}`,
      );
      const newlyHollowed = count(
        main,
        `SELECT count(*) AS n FROM main."commit" m JOIN against."commit" a ON a.seq = m.seq
         WHERE substr(m.original, 1, ?) = ? AND substr(a.original, 1, ?) <> ?`,
        HOLLOWED_MARKER_PREFIX.length,
        HOLLOWED_MARKER_PREFIX,
        HOLLOWED_MARKER_PREFIX.length,
        HOLLOWED_MARKER_PREFIX,
      );
      const agrees = plan.instances.truncated === newBoundaries &&
        plan.instances.headOpChanges === materializedHeads &&
        plannedHollowed === newlyHollowed;
      check(
        "the run did what it planned",
        agrees,
        `planned ${n(plan.instances.truncated)} truncated / ${
          n(plan.instances.headOpChanges)
        } head ops / ${n(plannedHollowed)} hollowed; found ${
          n(newBoundaries)
        } / ${n(materializedHeads)} / ${n(newlyHollowed)}`,
      );
    }

    // 6. Live metadata: the genesis receipt is byte-identical.
    const genesisSame = main.get<{ same: number }>(
      `SELECT (SELECT original FROM main."commit" WHERE seq = 1) =
              (SELECT original FROM against."commit" WHERE seq = 1) AS same`,
    )?.same === 1;
    check(
      "genesis receipt byte-identical",
      genesisSame,
      genesisSame ? "commit 1's payload matches" : "commit 1's payload differs",
    );

    return finish(checks.every((c) => c.passed));
  } finally {
    backup.close();
    main.close();
  }
}

/** The verification as an operator reads it. */
export function formatCompactionVerification(
  verification: CompactionVerification,
): string {
  const lines = verification.checks.map((check) =>
    `${check.passed ? "ok  " : "FAIL"} ${check.name.padEnd(64)} ${check.detail}`
  );
  lines.push(
    verification.ok
      ? `OK — ${verification.checks.length} checks passed in ${
        (verification.elapsedMs / 1000).toFixed(1)
      } s`
      : `FAILED — ${
        verification.checks.filter((c) => !c.passed).length
      } of ${verification.checks.length} checks failed`,
  );
  return lines.join("\n");
}
