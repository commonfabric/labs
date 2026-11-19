/**
 * A space's history as its commit log records it: which commits a branch's
 * history holds, and the commit that restores a branch to the state another
 * point of that history held (`docs/specs/memory-v2/06-branching.md` §6.15).
 * Both read through a branch's lineage, so a fork's history runs through its
 * parent's up to the fork point.
 */

import { valueEqual } from "@commonfabric/data-model";
import { aclDocId } from "../acl.ts";
import * as Engine from "./engine.ts";
import {
  type BranchName,
  type ClientCommit,
  type CommitClass,
  type CommitSummary,
  decodeTrustedMemoryBoundary,
  DEFAULT_BRANCH,
  type EntityId,
  type Operation,
  principalOfSessionKey,
  scopeOfScopeKey,
  SERVER_EXECUTION_ATTENTION_DOC_ID,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  type SessionId,
  STREAM_ENTRIES_DOC_PREFIX,
} from "../v2.ts";

/** Which commits {@link listCommits} returns. */
export type CommitListOptions = {
  branch?: BranchName;

  /** Only commits below this seq: the `seq` of the last one already held. */
  before?: number;

  /** At most this many, {@link MAX_COMMIT_PAGE_SIZE} at the most. */
  limit?: number;
};

/** The most commits one {@link listCommits} call returns. */
export const MAX_COMMIT_PAGE_SIZE = 500;

/** One stretch of a branch's history: `branch`'s commits through `through`. */
type LineageSegment = { branch: BranchName; through: number };

/**
 * The stretches of history `branch` holds as of `seq`, its own first and then
 * each ancestor's up to the point the one below forked from it.
 *
 * @throws When the branch does not exist.
 */
const lineageSegments = (
  engine: Engine.Engine,
  branch: BranchName,
  seq: number,
): LineageSegment[] => {
  const branches = new Map(
    Engine.listBranches(engine).map((state) => [state.name, state]),
  );
  const segments: LineageSegment[] = [];
  let name: BranchName | null = branch;
  let through = seq;
  while (name !== null) {
    const state = branches.get(name);
    if (state === undefined) throw new Error(`unknown branch: ${name}`);
    segments.push({ branch: name, through });
    through = Math.min(through, state.forkSeq ?? 0);
    name = state.parentBranch;
  }
  return segments;
};

type CommitRow = {
  seq: number;
  branch: string;
  class: CommitClass;
  created_at: string;
  acting_principal: string | null;
  session_id: string;
  consequence_of: string | null;
  derived_through: number | null;
  original: string;
  writes: number;
};

const SELECT_COMMITS = `
SELECT c.seq, c.branch, c.class, c.created_at, c.acting_principal,
       c.session_id,
       c.consequence_of, c.derived_through, c.original,
       (SELECT COUNT(*) FROM (
          SELECT DISTINCT r.id, r.scope_key FROM revision r
          WHERE r.commit_seq = c.seq
        )) AS writes
FROM "commit" c
WHERE c.branch = :branch AND c.seq <= :through AND c.seq < :before
  AND c.seq >= :floor
ORDER BY c.seq DESC
LIMIT :limit
`;

/**
 * Helper for {@link listCommits}, which reads what a commit's stored payload
 * says of the events it appended and the restore it made. A payload that
 * compaction emptied says neither. Only a `system` commit is a restore:
 * a client's commit is stored as the client sent it, `merge` included, and
 * what it says there is the client's word.
 */
const payloadSummary = (
  original: string,
  commitClass: CommitClass,
): Pick<CommitSummary, "events" | "restored"> => {
  const payload = decodeTrustedMemoryBoundary<Partial<ClientCommit> | null>(
    original,
  );
  const merge = commitClass === "system" ? payload?.merge : undefined;
  return {
    events: Array.isArray(payload?.eventAppends)
      ? payload.eventAppends.length
      : 0,
    ...(typeof merge?.sourceBranch === "string" &&
        typeof merge.sourceSeq === "number"
      ? { restored: { branch: merge.sourceBranch, seq: merge.sourceSeq } }
      : {}),
  };
};

const toCommitSummary = (row: CommitRow): CommitSummary => {
  const principal = row.acting_principal ??
    principalOfSessionKey(row.session_id);
  return {
    seq: row.seq,
    branch: row.branch,
    class: row.class,
    createdAt: `${row.created_at.replace(" ", "T")}Z`,
    ...(row.acting_principal !== null
      ? { actingPrincipal: row.acting_principal }
      : {}),
    ...(principal !== undefined ? { principal } : {}),
    ...(row.consequence_of !== null
      ? {
        consequenceOf: decodeTrustedMemoryBoundary<string[]>(
          row.consequence_of,
        ),
      }
      : {}),
    ...(row.derived_through !== null
      ? { derivedThrough: row.derived_through }
      : {}),
    ...payloadSummary(row.original, row.class),
    writes: row.writes,
  };
};

/**
 * Returns the commits of a branch's history, newest first: the branch's own,
 * then those it inherits from each ancestor up to its fork point. History
 * below the store's compaction floor (`Engine.compactionFloor()`) is closed,
 * and its commits are left out.
 *
 * @throws When the branch does not exist.
 */
export const listCommits = (
  engine: Engine.Engine,
  options: CommitListOptions = {},
): CommitSummary[] => {
  const branch = options.branch ?? DEFAULT_BRANCH;
  const before = options.before ?? Number.MAX_SAFE_INTEGER;
  const limit = Math.min(
    options.limit ?? MAX_COMMIT_PAGE_SIZE,
    MAX_COMMIT_PAGE_SIZE,
  );
  const statement = engine.prepare(SELECT_COMMITS);
  const floor = Engine.compactionFloor(engine);
  const commits: CommitSummary[] = [];
  for (
    const segment of lineageSegments(engine, branch, Number.MAX_SAFE_INTEGER)
  ) {
    if (commits.length >= limit) break;
    const rows = statement.all({
      branch: segment.branch,
      through: segment.through,
      before,
      floor,
      limit: limit - commits.length,
    }) as CommitRow[];
    for (const row of rows) commits.push(toCommitSummary(row));
  }
  return commits;
};

/** What {@link restoreBranch} restores, and to what. */
export type RestoreOptions = {
  /** The space the engine holds, whose access list a restore leaves alone. */
  space: string;

  /** The branch whose head the restore moves. */
  target?: BranchName;

  /** The branch whose history holds the state to restore. */
  source?: BranchName;

  /** The point of `source`'s history to restore, its head when absent. */
  sourceSeq?: number;

  /** The session the restoring commit is recorded under. */
  sessionId: SessionId;

  /** That session's sequence number for the commit. */
  localSeq: number;
};

/** A document one point of history holds, in one instance of its scope. */
type Instance = { id: EntityId; scopeKey: string };

const SELECT_WRITTEN_INSTANCES = `
SELECT DISTINCT id, scope_key FROM revision
WHERE branch = :branch AND seq > :above AND seq <= :through
`;

/**
 * Helper for {@link restoreBranch}, which returns every instance the two
 * histories can hold different documents of: those written on either side
 * above the point where the histories part.
 */
const divergedInstances = (
  engine: Engine.Engine,
  target: LineageSegment[],
  source: LineageSegment[],
): { instances: Instance[]; base: LineageSegment } => {
  const sourceByBranch = new Map(source.map((s) => [s.branch, s]));
  // Every lineage ends at the default branch, so the two always share one.
  const shared = target.find((s) => sourceByBranch.has(s.branch))!;
  const base = {
    branch: shared.branch,
    through: Math.min(
      shared.through,
      sourceByBranch.get(shared.branch)!.through,
    ),
  };
  const statement = engine.prepare(SELECT_WRITTEN_INSTANCES);
  const found = new Map<string, Instance>();
  for (const lineage of [target, source]) {
    for (const segment of lineage) {
      const above = segment.branch === base.branch ? base.through : 0;
      const rows = statement.all({
        branch: segment.branch,
        above,
        through: segment.through,
      }) as { id: EntityId; scope_key: string }[];
      for (const row of rows) {
        found.set(`${row.scope_key}\u0000${row.id}`, {
          id: row.id,
          scopeKey: row.scope_key,
        });
      }
      if (segment.branch === base.branch) break;
    }
  }
  return { instances: [...found.values()], base };
};

/**
 * Helper for {@link restoreBranch}, which returns whether a restore rewrites
 * the document `id`. It leaves alone the space's access list, and the
 * records a serving loop keeps of its own progress through the branch's
 * commits: the event logs, the watermark, and the effect and attention
 * indexes. Those describe what has happened on the branch, which a restore
 * adds to and does not undo.
 */
const isRestored = (id: EntityId, space: string): boolean =>
  id !== aclDocId(space) &&
  !id.startsWith(STREAM_ENTRIES_DOC_PREFIX) &&
  id !== SERVER_EXECUTION_WATERMARK_DOC_ID &&
  id !== SERVER_EXECUTION_ATTENTION_DOC_ID &&
  id !== SERVER_EXECUTION_EFFECTS_DOC_ID;

/**
 * Restores `target` to the state `source` held as of `sourceSeq`, as one
 * commit on `target` that sets every document the two differ in to what
 * `source` holds and deletes each one `source` lacks. The commit records
 * where it restored from, so the history of `target` keeps every state it
 * went through, the one the restore replaced included. Session-scoped
 * documents stay as they are, as do the space's access list and its serving
 * loop's records. Returns
 * `undefined`, writing nothing, when the two hold the same documents.
 *
 * A collaborative field of a document the commit sets ends there, and its
 * editors start it again from the restored value.
 *
 * @throws When either branch does not exist, or when `sourceSeq` lies outside
 * `source`'s history or below the store's compaction floor.
 */
export const restoreBranch = (
  engine: Engine.Engine,
  options: RestoreOptions,
): Engine.AppliedCommit | undefined =>
  Engine.runAtomicCommit(engine, (apply) => {
    const target = options.target ?? DEFAULT_BRANCH;
    const source = options.source ?? DEFAULT_BRANCH;
    const sourceState = Engine.branchState(engine, source);
    if (sourceState === null) throw new Error(`unknown branch: ${source}`);
    const sourceSeq = options.sourceSeq ?? sourceState.headSeq;
    const firstSeq = source === DEFAULT_BRANCH ? 0 : sourceState.createdSeq;
    if (
      !Number.isSafeInteger(sourceSeq) || sourceSeq < firstSeq ||
      sourceSeq > sourceState.headSeq
    ) {
      throw new Error(`seq ${sourceSeq} is out of range for branch ${source}`);
    }
    Engine.assertAboveCompactionFloor(engine, sourceSeq);
    const { instances, base } = divergedInstances(
      engine,
      lineageSegments(engine, target, Number.MAX_SAFE_INTEGER),
      lineageSegments(engine, source, sourceSeq),
    );
    const operations: Operation[] = [];
    const scopeKeys = new Map<number, string>();
    for (const { id, scopeKey } of instances) {
      const scope = scopeOfScopeKey(scopeKey);
      if (scope === "session" || !isRestored(id, options.space)) continue;
      const held = Engine.readState(engine, { id, scopeKey, branch: target })
        ?.document ?? null;
      const wanted = Engine.readState(engine, {
        id,
        scopeKey,
        branch: source,
        seq: sourceSeq,
      })?.document ?? null;
      if (held === null ? wanted === null : valueEqual(held, wanted)) continue;
      if (scope !== "space") scopeKeys.set(operations.length, scopeKey);
      operations.push(
        wanted === null
          ? { op: "delete", id, scope }
          : { op: "set", id, scope, value: wanted },
      );
    }
    if (operations.length === 0) return undefined;
    return apply({
      sessionId: options.sessionId,
      space: options.space,
      commit: {
        localSeq: options.localSeq,
        reads: { confirmed: [], pending: [] },
        operations,
        ...(target === DEFAULT_BRANCH ? {} : { branch: target }),
        merge: {
          sourceBranch: source,
          sourceSeq,
          baseBranch: base.branch,
          baseSeq: base.through,
        },
      },
      commitClass: "system",
      scopeKeys,
      releasesOperationFields: true,
    });
  });
