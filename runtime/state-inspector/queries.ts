// Autopsy queries over a space DB. These answer the "who/what/when" questions
// the proposal lists, using only the durable entity tables (no scheduler graph
// required, since those tables are usually absent).

import type { CommitRow, SpaceDb } from "./db.ts";
import { hasSchedulerBasisTable } from "./db.ts";
import { decodeStored } from "./decode.ts";
import { decodeHollowedPayload } from "@commonfabric/memory/v2/compact";
import { COMPACTION_SESSION_PREFIX } from "@commonfabric/memory/v2/engine";
import { rowLimit } from "./model.ts";
import { branchReadChain, owningLink } from "./reconstruct.ts";
import { utf8Compare } from "@commonfabric/utils/utf8";

export interface SpaceSummary {
  path: string;
  hasSchedulerBasisTable: boolean;

  /** Scheduler basis rows (0 even when the table exists empty). */
  schedulerBasisRows: number;

  commits: number;
  commitSeqRange: [number, number] | null;
  sessions: number;
  revisions: number;
  entities: number;
  ops: Record<string, number>;
  branches: { name: string; head_seq: number; status: string }[];
  scopes: { scope_key: string; count: number }[];
}

export function summarizeSpace(space: SpaceDb): SpaceSummary {
  const db = space.db;
  const one = <T extends object>(sql: string): T =>
    db.prepare(sql).get<T>() as T;

  const commitAgg = one<
    { n: number; lo: number | null; hi: number | null; s: number }
  >(
    `SELECT count(*) n, min(seq) lo, max(seq) hi, count(DISTINCT session_id) s FROM "commit"`,
  );
  const revAgg = one<{ n: number; e: number }>(
    `SELECT count(*) n, count(DISTINCT id) e FROM revision`,
  );
  const ops = db
    .prepare(`SELECT op, count(*) c FROM revision GROUP BY op`)
    .all<{ op: string; c: number }>();
  const branches = db
    .prepare(`SELECT name, head_seq, status FROM branch ORDER BY name`)
    .all<{ name: string; head_seq: number; status: string }>();
  const scopes = db
    .prepare(
      `SELECT scope_key, count(*) count FROM revision GROUP BY scope_key ORDER BY count DESC`,
    )
    .all<{ scope_key: string; count: number }>();

  const hasSched = hasSchedulerBasisTable(db);
  let schedulerBasisRows = 0;
  if (hasSched) {
    try {
      schedulerBasisRows =
        one<{ n: number }>(`SELECT count(*) n FROM scheduler_basis`).n;
    } catch {
      schedulerBasisRows = 0;
    }
  }

  return {
    path: space.path,
    hasSchedulerBasisTable: hasSched,
    schedulerBasisRows,
    commits: commitAgg.n,
    commitSeqRange: commitAgg.lo === null
      ? null
      : [commitAgg.lo, commitAgg.hi!],
    sessions: commitAgg.s,
    revisions: revAgg.n,
    entities: revAgg.e,
    ops: Object.fromEntries(ops.map((r) => [r.op, r.c])),
    branches,
    scopes,
  };
}

export interface CommitInfo {
  seq: number;
  branch: string;
  session: string;
  localSeq: number;
  ops: number;
  reads: number;
  createdAt: string;
  /** For a `cf space compact` run's own commit: the run's id. Its payload is
   * the run's plan, not a client commit, so `ops` and `reads` are zero. */
  compactionRun?: string;
  /** The payload was hollowed by a compaction run (docs/plans/compact-space.md,
   * I6): what remains is a marker naming the run and hashing what it held;
   * `ops` and `reads` are zero because the commit's contents are in the
   * archive the operator took, not here. */
  hollowedBy?: string;
}

/** List commits, most recent first, optionally filtered by session prefix. */
export function listCommits(
  space: SpaceDb,
  opts: { session?: string; limit?: number } = {},
): CommitInfo[] {
  const limit = opts.limit ?? 50;
  const where = opts.session ? `WHERE session_id LIKE ?` : ``;
  const params: string[] = opts.session ? [`${opts.session}%`] : [];
  const rows = space.db
    .prepare(
      `SELECT seq, branch, session_id, local_seq, original, created_at
       FROM "commit" ${where} ORDER BY seq DESC LIMIT ?`,
    )
    .all<CommitRow>(...params, limit);

  return rows.map((r) => {
    let ops = 0;
    let reads = 0;
    let compactionRun: string | undefined;
    let hollowedBy: string | undefined;
    try {
      // `original` is a ClientCommit, stored either codec-encoded or plain
      // JSON — unless compaction wrote it: a compaction run's own commit holds
      // the run's plan, and a hollowed commit holds a marker.
      const marker = decodeHollowedPayload(r.original);
      if (marker !== undefined) {
        hollowedBy = marker.runId;
      } else {
        const parsed = decodeStored(r.original) as {
          operations?: unknown[];
          reads?: { confirmed?: unknown[]; pending?: unknown[] };
          compaction?: {
            runId?: unknown;
            report?: {
              compactionCommit?: { seq?: unknown; sessionId?: unknown };
            };
          };
        };
        // A run's own commit: under the compaction session, and holding a
        // plan that names this very row. The commit's class is not read,
        // because this reader opens stores from before the column existed.
        const named = parsed.compaction?.report?.compactionCommit;
        if (
          r.session_id.startsWith(COMPACTION_SESSION_PREFIX) &&
          typeof parsed.compaction?.runId === "string" &&
          named?.seq === r.seq && named?.sessionId === r.session_id &&
          r.local_seq === 1
        ) {
          compactionRun = parsed.compaction.runId;
        }
        ops = Array.isArray(parsed.operations) ? parsed.operations.length : 0;
        reads = (parsed.reads?.confirmed?.length ?? 0) +
          (parsed.reads?.pending?.length ?? 0);
      }
    } catch {
      // leave zeroed if payload is unparseable
    }
    return {
      seq: r.seq,
      branch: r.branch,
      session: r.session_id,
      localSeq: r.local_seq,
      ops,
      reads,
      createdAt: r.created_at,
      ...(compactionRun === undefined ? {} : { compactionRun }),
      ...(hollowedBy === undefined ? {} : { hollowedBy }),
    };
  });
}

/** The tail of a commit's listing line: what its payload holds. */
export function describeCommitPayload(commit: CommitInfo): string {
  if (commit.compactionRun !== undefined) {
    return `compaction run ${commit.compactionRun}`;
  }
  if (commit.hollowedBy !== undefined) {
    return `payload hollowed by compaction run ${commit.hollowedBy}`;
  }
  return `ops=${commit.ops}\treads=${commit.reads}`;
}

export interface WriteEvent {
  seq: number;
  commitSeq: number;
  opIndex: number;
  op: string;
  session: string;
  localSeq: number;
  createdAt: string;
}

/**
 * Every write that touched an entity, in order — the "who wrote this" answer.
 *
 * Read from the branch that OWNS the entity's visible row, not the branch
 * asked about. A child branch inherits its parent's entities, so reading local
 * rows only would answer "no history" for an entity the same branch reads
 * fine; and for one the child overrode, the parent's writes produced nothing
 * the reader can see, so they are not this entity's history from here.
 */
export function entityHistory(
  space: SpaceDb,
  opts: { id: string; scope?: string; branch?: string; limit?: number },
): WriteEvent[] {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const limit = opts.limit ?? 200;
  const owner = owningLink(space, { branch, scope, id: opts.id });
  if (owner === undefined) return [];
  return space.db
    .prepare(
      `SELECT r.seq, r.commit_seq, r.op_index, r.op,
              c.session_id, c.local_seq, c.created_at
       FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.branch = ? AND r.id = ? AND r.scope_key = ? AND r.seq <= ?
       ORDER BY r.seq ASC, r.op_index ASC LIMIT ?`,
    )
    .all<{
      seq: number;
      commit_seq: number;
      op_index: number;
      op: string;
      session_id: string;
      local_seq: number;
      created_at: string;
    }>(owner.branch, opts.id, scope, owner.atSeq, limit)
    .map((r) => ({
      seq: r.seq,
      commitSeq: r.commit_seq,
      opIndex: r.op_index,
      op: r.op,
      session: r.session_id,
      localSeq: r.local_seq,
      createdAt: r.created_at,
    }));
}

export interface HotEntity {
  id: string;
  scope: string;
  writes: number;
  sessions: number;
}

/**
 * Entities ranked by write count — a contention/hot-path proxy.
 *
 * Counted per entity on the branch that OWNS its visible row, so an entity a
 * child branch inherited is ranked by the history the child can reach rather
 * than dropped for having no local rows.
 */
export function hotEntities(
  space: SpaceDb,
  opts: { branch?: string; limit?: number } = {},
): HotEntity[] {
  const branch = opts.branch ?? "";
  // Resolved at ENTRY, not at the terminal slice: the SQL this replaced refused
  // a bad limit before reading a row, and evaluating it last would make a
  // library caller pay the whole chain walk, group-bys and sort before the
  // refusal landed.
  const end = rowLimit(opts.limit ?? 20);
  const perBranch = space.db.prepare(
    `SELECT r.id, r.scope_key,
            count(*) writes, count(DISTINCT c.session_id) sessions
     FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
     WHERE r.branch = ? AND r.seq <= ?
     GROUP BY r.id, r.scope_key`,
  );
  const out: HotEntity[] = [];
  const claimed = new Set<string>();
  for (const link of branchReadChain(space, branch)) {
    for (
      const r of perBranch.all<
        { id: string; scope_key: string; writes: number; sessions: number }
      >(link.branch, link.atSeq)
    ) {
      // Nearest link wins, as a read resolves it.
      const key = `${r.scope_key}\u0000${r.id}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      out.push({
        id: r.id,
        scope: r.scope_key,
        writes: r.writes,
        sessions: r.sessions,
      });
    }
  }
  return out
    // Scope breaks the last tie: the same id can be held in several scopes, so
    // id alone leaves equal-write rows in whatever order the walk produced, and
    // a limited result would return an arbitrary one of them.
    .sort((a, b) =>
      b.writes - a.writes || utf8Compare(a.id, b.id) ||
      utf8Compare(a.scope, b.scope)
    )
    .slice(0, end);
}

// Entity classification / listing moved to model.ts (`listEntityModels`),
// which reads the WHOLE entity document instead of value-shape alone.
