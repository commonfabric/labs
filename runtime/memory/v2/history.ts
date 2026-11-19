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
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  type EntityId,
  type Operation,
  scopeOfScopeKey,
  type SessionId,
} from "../v2.ts";

/** One commit of a branch's history, without the documents it wrote. */
export type CommitSummary = {
  seq: number;

  /** The branch the commit landed on, which a fork's history inherits from. */
  branch: BranchName;
  class: CommitClass;

  /** When the server admitted the commit, as an ISO 8601 UTC time. */
  createdAt: string;

  /** The user a server-produced authored commit acted for. */
  actingPrincipal?: string;

  /** How many events the commit appended to streams. */
  events: number;

  /** The ids of the events whose handler consequences the commit carries. */
  consequenceOf?: string[];

  /** The point of history the commit restored its branch to. */
  restored?: { branch: BranchName; seq: number };

  /** How many documents the commit wrote. */
  writes: number;
};

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
  consequence_of: string | null;
  original: string;
  writes: number;
};

const SELECT_COMMITS = `
SELECT c.seq, c.branch, c.class, c.created_at, c.acting_principal,
       c.consequence_of, c.original,
       (SELECT COUNT(*) FROM (
          SELECT DISTINCT r.id, r.scope_key FROM revision r
          WHERE r.commit_seq = c.seq
        )) AS writes
FROM "commit" c
WHERE c.branch = :branch AND c.seq <= :through AND c.seq < :before
ORDER BY c.seq DESC
LIMIT :limit
`;

/**
 * Helper for {@link listCommits}, which reads what a commit's stored payload
 * says of the events it appended and the restore it made. A payload that
 * compaction emptied says neither.
 */
const payloadSummary = (
  original: string,
): Pick<CommitSummary, "events" | "restored"> => {
  const payload = decodeMemoryBoundary<Partial<ClientCommit>>(original);
  const merge = payload.merge;
  return {
    events: Array.isArray(payload.eventAppends)
      ? payload.eventAppends.length
      : 0,
    ...(merge !== undefined
      ? { restored: { branch: merge.sourceBranch, seq: merge.sourceSeq } }
      : {}),
  };
};

const toCommitSummary = (row: CommitRow): CommitSummary => ({
  seq: row.seq,
  branch: row.branch,
  class: row.class,
  createdAt: `${row.created_at.replace(" ", "T")}Z`,
  ...(row.acting_principal !== null
    ? { actingPrincipal: row.acting_principal }
    : {}),
  ...(row.consequence_of !== null
    ? { consequenceOf: decodeMemoryBoundary<string[]>(row.consequence_of) }
    : {}),
  ...payloadSummary(row.original),
  writes: row.writes,
});

/**
 * Returns the commits of a branch's history, newest first: the branch's own,
 * then those it inherits from each ancestor up to its fork point.
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
  const commits: CommitSummary[] = [];
  for (
    const segment of lineageSegments(engine, branch, Number.MAX_SAFE_INTEGER)
  ) {
    if (commits.length >= limit) break;
    const rows = statement.all({
      branch: segment.branch,
      through: segment.through,
      before,
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
  sessionId: SessionId;
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
  const shared = target.find((s) => sourceByBranch.has(s.branch));
  // Every lineage ends at the default branch, so the two always share one.
  if (shared === undefined) throw new Error("branches share no history");
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
 * Restores `target` to the state `source` held as of `sourceSeq`, as one
 * commit on `target` that sets every document the two differ in to what
 * `source` holds and deletes each one `source` lacks. The commit records
 * where it restored from, so the history of `target` keeps every state it
 * went through, the one the restore replaced included. A space's access
 * list and its session-scoped documents stay as they are. Returns
 * `undefined`, writing nothing, when the two hold the same documents.
 *
 * @throws When either branch does not exist, when `sourceSeq` lies outside
 * `source`'s history, or when a document to restore holds a collaborative
 * field whose value the restore would change.
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
    const { instances, base } = divergedInstances(
      engine,
      lineageSegments(engine, target, Number.MAX_SAFE_INTEGER),
      lineageSegments(engine, source, sourceSeq),
    );
    const operations: Operation[] = [];
    const scopeKeys = new Map<number, string>();
    for (const { id, scopeKey } of instances) {
      const scope = scopeOfScopeKey(scopeKey);
      if (scope === "session" || id === aclDocId(options.space)) continue;
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
    });
  });
