// Conflicts & async — the contested/concurrent dimension of multiplayer state.
//
// The durable store records enough to reconstruct who fought over what:
//   - `revision` — every write, joinable to `commit.session_id` (the writer).
//   - `commit.original.reads.confirmed[]` — `ConfirmedRead { id, scope?, branch?,
//     path, seq, nonRecursive? }`: what each commit READ and at which seq,
//     where the row keeps them. A row stored in digest form
//     (`docs/specs/memory-v2/02-storage.md` §3.3) holds a digest of the whole
//     submission in their place, and compaction hollows old payloads; the
//     stale-read scan counts such rows as unchecked (`readSetsNotKept`).
//
// Two grounded views:
//   1. CONTENTION (write-write): entities written by ≥2 distinct sessions, with
//      the interleaved writer timeline — the back-and-forth of concurrent edits.
//   2. ANOMALOUS STALE READS (read-write): a committed confirmed read that the
//      engine's OWN conflict check would have rejected. We replay that exact
//      check here — resolving each read's declared scope via the engine's
//      `resolveScopeKey` and testing patch overlap with the engine's exported
//      `patchOverlapsRead`, the definition its check is held to — so a hit is
//      genuinely anomalous, not a benign cross-scope or disjoint-path
//      interleaving the runtime tolerates.
//
// HONESTY: the server VALIDATES every confirmed read before inserting a commit
// (`validateConfirmedReads` → `findConflictSeq` in `runtime/memory/v2`), so a
// healthy store should yield ZERO stale reads here. A hit therefore flags an
// invariant violation / corruption, NOT normal "lost update" history. Rejected
// client commits aren't persisted; we never see them.

import {
  type CellScope,
  encodeMemoryBoundary,
  type PatchOp,
  resolveScopeKey,
} from "@commonfabric/memory/v2";
import {
  COMPACTION_SESSION_PREFIX,
  historyCompactedBelowRow,
  isLogSeq,
  type OldestRevisionAttribution,
  patchOverlapsNonRecursiveRead,
  patchOverlapsRead,
  SELECT_OLDEST_REVISION_ATTRIBUTION,
} from "@commonfabric/memory/v2/engine";
import {
  HOLLOWED_MARKER_PREFIX,
  isHollowedPayload,
} from "@commonfabric/memory/v2/compact";
import { storedReadCounts } from "@commonfabric/memory/v2/stored-commit";
import { utf8Compare } from "@commonfabric/text/utf8";

import { rowLimit } from "./model.ts";

import type { SpaceDb } from "./db.ts";
import {
  branchReadChain,
  type BranchReadLink,
  owningLink,
} from "./reconstruct.ts";
import { decodeStored } from "./decode.ts";
import { parseScope } from "./scopes.ts";

export interface Writer {
  seq: number;
  commitSeq: number;
  session: string;

  /** The writer's identity (principal DID parsed from the session). */
  principal?: string;

  op: string;
  createdAt: string;
}

export interface ContendedEntity {
  id: string;

  /** Distinct writer sessions. */
  sessions: number;

  /** Distinct writer IDENTITIES — `>=2` is real cross-user contention vs the
   * same user editing from multiple tabs/devices. */
  principals: number;

  /** True when ≥2 distinct identities wrote it (multi-user, not multi-session). */
  multiUser: boolean;

  writes: number;

  /** Writer timeline, seq-ordered. */
  writers: Writer[];

  /** Sessions alternate (A→B→A) — concurrent back-and-forth, not a handoff. */
  interleaved: boolean;

  /** Lost-update reads (attached by the explorer bundle for multi-user cells). */
  staleReads?: StaleRead[];

  /** Attached with {@link staleReads}: commits the analysis could not check,
   * see {@link EntityConflicts.readSetsNotKept}. */
  readSetsNotKept?: number;

  /** True once stale-read analysis ran for this cell. `false`/absent on a
   * multi-user cell means analysis was SKIPPED (a cap), not that it's clean —
   * the UI must distinguish "no anomaly" from "not analyzed". */
  staleReadsAnalyzed?: boolean;
}

/** Distinct writer identities (principals) across a writer list. */
function principalCount(writers: Writer[]): number {
  return new Set(writers.map((w) => w.principal).filter(Boolean)).size;
}

/** Number of times the writing session changes across the seq-ordered list. */
function sessionSwitches(writers: Writer[]): number {
  let switches = 0;
  for (let i = 1; i < writers.length; i++) {
    if (writers[i].session !== writers[i - 1].session) switches++;
  }
  return switches;
}

/**
 * Entities written by ≥2 distinct sessions — contested cells. Cheap: one join,
 * then per-contested-entity the writer timeline. `interleaved` flags real
 * back-and-forth (≥2 session switches) vs a one-time handoff.
 */
export function contendedEntities(
  space: SpaceDb,
  opts: { branch?: string; scope?: string; limit?: number } = {},
): ContendedEntity[] {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  // Resolved at ENTRY — see `hotEntities`: the refusal belongs before the scan,
  // where the SQL this replaced put it.
  const end = rowLimit(opts.limit ?? 100);

  // Counted on the branch that OWNS each entity's visible row: a child branch
  // inherits its parent's entities, and reading local rows only would report no
  // contention at all on a branch whose visible entities are contended.
  const perBranch = space.db.prepare(
    `SELECT r.id, count(DISTINCT c.session_id) sessions, count(*) writes
     FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
     WHERE r.branch = ? AND r.scope_key = ? AND r.seq <= ?
     GROUP BY r.id`,
  );
  const owners = new Map<string, BranchReadLink>();
  const counted: { id: string; sessions: number; writes: number }[] = [];
  for (const link of branchReadChain(space, branch)) {
    for (
      const r of perBranch.all<
        { id: string; sessions: number; writes: number }
      >(
        link.branch,
        scope,
        link.atSeq,
      )
    ) {
      if (owners.has(r.id)) continue;
      owners.set(r.id, link);
      if (r.sessions >= 2) counted.push(r);
    }
  }
  const ids = counted
    .sort((a, b) =>
      b.sessions - a.sessions || b.writes - a.writes || utf8Compare(a.id, b.id)
    )
    .slice(0, end);

  const writersStmt = space.db.prepare(
    `SELECT r.seq, r.commit_seq, r.op, c.session_id, c.created_at
     FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
     WHERE r.branch = ? AND r.id = ? AND r.scope_key = ? AND r.seq <= ?
     ORDER BY r.seq ASC, r.op_index ASC`,
  );

  return ids.map((e) => {
    const writers: Writer[] = writersStmt
      .all<{
        seq: number;
        commit_seq: number;
        op: string;
        session_id: string;
        created_at: string;
      }>(owners.get(e.id)!.branch, e.id, scope, owners.get(e.id)!.atSeq)
      .map((w) => ({
        seq: w.seq,
        commitSeq: w.commit_seq,
        session: w.session_id,
        principal: parseScope(w.session_id).principal,
        op: w.op,
        createdAt: w.created_at,
      }));
    const principals = principalCount(writers);
    return {
      id: e.id,
      sessions: e.sessions,
      principals,
      multiUser: principals >= 2,
      writes: e.writes,
      writers,
      interleaved: sessionSwitches(writers) >= 2,
    };
  }).sort((a, b) =>
    (b.multiUser ? 1 : 0) - (a.multiUser ? 1 : 0) ||
    b.principals - a.principals || b.sessions - a.sessions
  );
}

export interface StaleRead {
  /** The commit that read the entity. */
  readerCommitSeq: number;

  readerSession: string;

  /** The seq the reader saw the entity at. */
  readAtSeq: number;

  /** The read's declared path within the entity (`[]` = whole document). */
  readPath: string[];

  /** The branch the read resolved against (`read.branch ?? readerCommit.branch`). */
  readBranch: string;

  /** The resolved scope_key the read targeted (engine `resolveScopeKey`). */
  readScopeKey: string;

  /** A conflicting write the engine's own check would have rejected. */
  missedWriteSeq: number;

  missedWriteSession: string;

  /** The op of the conflicting write (`set`/`delete` always conflict; `patch`
   * only when its paths overlap the read — `patchOverlapsRead`). */
  missedWriteOp: string;

  /** True when the reader ALSO wrote the entity (a real lost-update risk). */
  readerAlsoWrote: boolean;
}

export interface EntityConflicts {
  id: string;
  writers: Writer[];
  writerSessions: number;

  /** Distinct writer identities — `>=2` is real cross-user contention. */
  writerPrincipals: number;

  multiUser: boolean;
  interleaved: boolean;

  /** Stale reads: the reader committed without seeing a prior concurrent write. */
  staleReads: StaleRead[];

  /**
   * Commits after this entity's first write, on any branch and in any scope,
   * whose reads the scan could not check: stored with a digest in place of
   * confirmed reads (02-storage.md §3.3), hollowed by compaction, held in a
   * payload that does not show them, reading the entity by a read the scan
   * could not replay or resolve, or reading it at a basis older than what
   * compaction kept of the instance read. Any of them may have read the
   * entity stale, so an empty {@link staleReads} shows the entity coherent
   * only when this is 0.
   */
  readSetsNotKept: number;
}

/**
 * What the stale-read scan cannot see in a space, gathered once per report by
 * {@link readCoverage} and shared by every entity's analysis in it.
 */
export interface ReadCoverage {
  /**
   * Seqs, ascending, of the commits whose confirmed reads the log does not
   * hold where the scan can see them: stored with a digest of a commit that
   * had any, hollowed by compaction (whose marker does not say whether the
   * commit read anything), held in a payload that is not JSON, or in JSON
   * that does not show a read set whose every read names its entity.
   */
  unread: number[];

  /** Seqs, ascending, of compaction runs' own commits. */
  compactions: number[];

  /** The branches that hold revisions, where an entity's writes are. */
  branches: string[];

  /**
   * For each entity some read names with a backslash in its own text (so
   * every read that names it only by an escaped spelling, which a search of
   * the payload text for the id would not find), the seqs, ascending, of the
   * commits holding such a read.
   */
  escapedReaders: Map<string, number[]>;

  /**
   * Seqs of the commits an analysis found reading its entity but could not
   * check: an undecodable payload, a read missing a field it is replayed by
   * or holding one of the wrong type, a read whose scope it could not
   * resolve, or a read at a basis older than what compaction kept of the
   * instance it read, which may have missed a write that is gone. Each
   * analysis adds what it finds.
   */
  skipped: Set<number>;

  /**
   * Whether the report analyzes every entity, so that the first time one
   * needs its first write, {@link firstWrites} is filled for all of them by
   * one grouped query rather than by a lookup per entity and branch.
   */
  everyEntity: boolean;

  /** Each written entity's first write, once {@link everyEntity} fills it. */
  firstWrites?: Map<string, number>;

  /** The latest compaction commit holding the oldest revision of one of
   * each entity's instances, once asked for. */
  squashedAt?: Map<string, number>;
}

/** The text a codec-encoded payload starts with. */
const ENCODED_PREFIX = encodeMemoryBoundary({}).slice(0, -"{}".length);

/** SQL for a `"commit"` row's payload without the codec prefix, as JSON
 * text when it is JSON; it binds {@link BODY_PARAMS}. */
const BODY_SQL =
  `CASE WHEN substr(original, 1, ?) = ? THEN substr(original, ?) ELSE original END`;
const BODY_PARAMS = [
  ENCODED_PREFIX.length,
  ENCODED_PREFIX,
  ENCODED_PREFIX.length + 1,
] as const;

/** The least text greater than every text that starts with `prefix`. */
const pastPrefix = (prefix: string): string =>
  prefix.slice(0, -1) +
  String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

/**
 * Returns what the stale-read scan cannot see in `space`, from one pass over
 * the commit log and one over the payloads holding a backslash, each holding
 * one row at a time. `everyEntity` says the report analyzes every entity;
 * see {@link ReadCoverage.everyEntity}.
 */
export function readCoverage(
  space: SpaceDb,
  opts: { everyEntity?: boolean } = {},
): ReadCoverage {
  const unread: number[] = [];
  // The scan sees a commit's reads when its payload shows them as JSON: a
  // `reads.confirmed` array of objects that each name their entity in text,
  // by which the entity scans then find them. SQLite passes over those rows
  // and hands on the rest, whether or not they still name an entity: a
  // digest, a hollowed payload, text that is not JSON, and JSON shaped like
  // no commit. A compaction run's own commit records the run, not reads, and
  // is left out by its session and its `compaction` member. Each test runs
  // only where the one before it held, so none parses what is not JSON.
  const rows = space.db
    .prepare(
      `SELECT seq, original FROM (
         SELECT seq, original, session_id, ${BODY_SQL} AS body FROM "commit"
       )
       WHERE CASE
         WHEN substr(original, 1, ?) = ? THEN 1
         WHEN NOT json_valid(body) THEN 1
         WHEN session_id >= ? AND session_id < ?
           AND json_type(body, '$.compaction') = 'object' THEN 0
         WHEN json_type(body, '$.reads.confirmed') IS NOT 'array' THEN 1
         ELSE EXISTS (
           SELECT 1 FROM json_each(body, '$.reads.confirmed')
           WHERE CASE WHEN type = 'object'
             THEN json_type(value, '$.id') IS NOT 'text' ELSE 1 END
         )
       END
       ORDER BY seq ASC`,
    )
    .iter([
      ...BODY_PARAMS,
      HOLLOWED_MARKER_PREFIX.length,
      HOLLOWED_MARKER_PREFIX,
      COMPACTION_SESSION_PREFIX,
      pastPrefix(COMPACTION_SESSION_PREFIX),
    ]) as Iterable<{ seq: number; original: string }>;
  for (const { seq, original } of rows) {
    let decoded: unknown;
    try {
      decoded = isHollowedPayload(original)
        ? undefined
        : decodeStored(original);
    } catch {
      decoded = undefined;
    }
    // Of these, only a digest of pending reads alone hides no confirmed read
    // the audit would replay.
    const counts = storedReadCounts(decoded);
    if (!(counts?.kept === false && counts.confirmed === 0)) unread.push(seq);
  }
  const compactions = space.db
    .prepare(
      `SELECT seq FROM "commit" WHERE session_id >= ? AND session_id < ?
       ORDER BY seq ASC`,
    )
    .all<{ seq: number }>(
      COMPACTION_SESSION_PREFIX,
      pastPrefix(COMPACTION_SESSION_PREFIX),
    )
    .map(({ seq }) => seq);
  const branches = space.db
    .prepare(`SELECT DISTINCT branch FROM revision`)
    .all<{ branch: string }>()
    .map(({ branch }) => branch);
  // JSON spells a string otherwise than as written only with a backslash
  // escape, so only a read whose own text holds a backslash can name an id
  // the payload's text does not show. SQLite keeps each read's text as
  // stored, escapes included, so the test looks at that read alone, never
  // the whole payload again. Those reads are collected here, in one pass
  // over the payloads holding a backslash, for every entity's candidate
  // search; one whose backslash is elsewhere than its id only adds a
  // candidate the decode then sets aside.
  const escapedReaders = new Map<string, number[]>();
  const escaped = space.db
    .prepare(
      `SELECT c.seq AS seq, json_extract(r.value, '$.id') AS id
       FROM (
         SELECT seq, original, ${BODY_SQL} AS body FROM "commit"
         WHERE instr(original, char(92)) > 0
       ) AS c,
       json_each(
         CASE
           WHEN NOT json_valid(c.body) THEN '{}'
           WHEN json_type(c.body, '$.reads.confirmed') IS NOT 'array'
             THEN '{}'
           ELSE c.body
         END,
         '$.reads.confirmed'
       ) AS r
       WHERE CASE WHEN r.type = 'object'
         THEN json_type(r.value, '$.id') = 'text'
           AND instr(r.value, char(92)) > 0
         ELSE 0 END
       ORDER BY c.seq ASC`,
    )
    .iter([...BODY_PARAMS]) as Iterable<{ seq: number; id: string }>;
  for (const { seq, id } of escaped) {
    const seqs = escapedReaders.get(id) ?? [];
    if (seqs.at(-1) !== seq) seqs.push(seq);
    escapedReaders.set(id, seqs);
  }
  return {
    unread,
    compactions,
    branches,
    escapedReaders,
    skipped: new Set(),
    everyEntity: opts.everyEntity ?? false,
  };
}

/** Returns how many commits {@link coverage} cannot see, in all. */
export function readSetsNotKeptIn(coverage: ReadCoverage): number {
  const all = new Set(coverage.unread);
  for (const seq of coverage.skipped) all.add(seq);
  return all.size;
}

/**
 * Returns the seq of the first commit that wrote `id` on any branch, in any
 * scope, or undefined when none did. The stale-read scan looks for writes
 * across branches and scopes, so no commit at or before this seq can have
 * read `id` stale.
 */
function firstWriteSeq(
  space: SpaceDb,
  coverage: ReadCoverage,
  id: string,
): number | undefined {
  if (coverage.everyEntity) {
    coverage.firstWrites ??= new Map(
      space.db
        .prepare(`SELECT id, min(commit_seq) AS seq FROM revision GROUP BY id`)
        .all<{ id: string; seq: number }>()
        .map(({ id, seq }) => [id, seq]),
    );
    return coverage.firstWrites.get(id);
  }
  const first = space.db.prepare(
    `SELECT min(commit_seq) AS seq FROM revision WHERE branch = ? AND id = ?`,
  );
  let seq: number | undefined;
  for (const branch of coverage.branches) {
    const found = first.get<{ seq: number | null }>(branch, id)?.seq;
    if (found != null && (seq === undefined || found < seq)) seq = found;
  }
  return seq;
}

/**
 * Returns the latest compaction commit that holds the oldest revision of an
 * instance of `id`, or undefined when compaction never truncated any
 * instance of it. Compaction attributes a truncated instance's oldest
 * surviving revision to its own commit, and the writes before it are gone,
 * the entity's first write with them.
 */
function squashedAt(
  space: SpaceDb,
  coverage: ReadCoverage,
  id: string,
): number | undefined {
  if (coverage.compactions.length === 0) return undefined;
  // The instance's oldest row, as the engine's rule reads it: a row a run
  // appended above older ones (the ACL document's audit revision) cut
  // nothing. The compaction commits are bound as one JSON array, so no number
  // of runs takes the statement past SQLite's limit on bound parameters.
  coverage.squashedAt ??= new Map(
    space.db
      .prepare(
        `SELECT r.id, max(r.commit_seq) AS seq FROM revision r
         WHERE r.commit_seq IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (
             SELECT 1 FROM revision o
             WHERE o.branch = r.branch AND o.id = r.id
               AND o.scope_key = r.scope_key
               AND (o.seq < r.seq OR (o.seq = r.seq AND o.op_index < r.op_index))
           )
         GROUP BY r.id`,
      )
      .all<{ id: string; seq: number }>([
        JSON.stringify(coverage.compactions),
      ])
      .map(({ id, seq }) => [id, seq]),
  );
  return coverage.squashedAt.get(id);
}

/** Whether the ascending `seqs` hold `seq`. */
function holdsSeq(seqs: readonly number[], seq: number): boolean {
  return countAfter(seqs, seq - 1) - countAfter(seqs, seq) === 1;
}

/** Returns how many of the ascending `seqs` are greater than `after`. */
function countAfter(seqs: readonly number[], after: number): number {
  let low = 0;
  let high = seqs.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (seqs[mid] <= after) low = mid + 1;
    else high = mid;
  }
  return seqs.length - low;
}

interface ConfirmedReadRef {
  id: string;
  seq: number;
  scope?: CellScope;
  branch?: string;
  path: string[];
  nonRecursive?: boolean;
}

const CELL_SCOPES: ReadonlySet<unknown> = new Set<CellScope>([
  "space",
  "user",
  "session",
]);

/**
 * Whether a stored read naming the entity has each field the scan replays
 * it by, of its type: a basis seq, as the engine's `isLogSeq()` decides (not
 * negative zero, which the SQLite binding throws on), and a path, which
 * admission requires (an empty one reads the whole document), and any
 * branch, scope or shallow flag. The log holds what was stored, not what
 * admission accepted, and a read without them cannot be checked.
 */
function isReplayableRead(read: ConfirmedReadRef): boolean {
  return isLogSeq(read.seq) &&
    Array.isArray(read.path) &&
    read.path.every((part) => typeof part === "string") &&
    (read.branch === undefined || typeof read.branch === "string") &&
    (read.scope === undefined || CELL_SCOPES.has(read.scope)) &&
    (read.nonRecursive === undefined ||
      typeof read.nonRecursive === "boolean");
}

interface WriteRow {
  seq: number;
  commit_seq: number;
  op: string;
  data: string | null;
  session_id: string;
}

/**
 * Deep per-entity conflict analysis: the writer timeline (in `opts.scope`) plus
 * ANOMALOUS stale-read detection that replays the engine's own conflict check.
 *
 * For each committed confirmed read of this entity at seq N, we resolve the
 * read's declared scope to a scope_key the same way the engine does
 * (`resolveScopeKey` against the reader's principal/session), then look for a
 * write to that (id, scope_key) by a DIFFERENT session with N < W < the reader's
 * commit seq — applying the engine's granularity: `set`/`delete` always
 * conflict, a `patch` only when `patchOverlapsRead` (or the nonRecursive
 * variant) says its paths overlap the read. Because the engine validates exactly
 * this before persisting, any hit is anomalous (see file header), not routine.
 */
export function entityConflicts(
  space: SpaceDb,
  id: string,
  opts: { branch?: string; scope?: string; coverage?: ReadCoverage } = {},
): EntityConflicts {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const coverage = opts.coverage ?? readCoverage(space);
  const squash = squashedAt(space, coverage, id);
  const skipped = new Set<number>();

  // Who wrote this entity, from the branch that OWNS its visible row — a child
  // branch inherits its parent's entities, and local rows only would report no
  // writers for one it reads fine. The stale-read scan below is a different
  // question and keeps its own branch resolution: it replicates the engine's
  // `validateConfirmedReads`, where an unqualified read defaults to the READER
  // COMMIT's branch.
  const owner = owningLink(space, { branch, scope, id });
  const writers: Writer[] = (owner === undefined ? [] : space.db
    .prepare(
      `SELECT r.seq, r.commit_seq, r.op, c.session_id, c.created_at
       FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.branch = ? AND r.id = ? AND r.scope_key = ? AND r.seq <= ?
       ORDER BY r.seq ASC, r.op_index ASC`,
    )
    .all<{
      seq: number;
      commit_seq: number;
      op: string;
      session_id: string;
      created_at: string;
    }>(owner.branch, id, scope, owner.atSeq))
    .map((w) => ({
      seq: w.seq,
      commitSeq: w.commit_seq,
      session: w.session_id,
      principal: parseScope(w.session_id).principal,
      op: w.op,
      createdAt: w.created_at,
    }));

  // Commits that wrote this entity (to flag reader-also-wrote).
  const wroteByCommit = new Set<number>();
  for (const w of writers) wroteByCommit.add(w.commitSeq);

  // Writes to (id) in a given resolved scope_key, after a seq, by a non-reader
  // session — the candidate conflicts for one read. Decodes patch data so the
  // engine's path-overlap test can run.
  const writesStmt = space.db.prepare(
    `SELECT r.seq, r.commit_seq, r.op, r.data, c.session_id
     FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
     WHERE r.branch = ? AND r.id = ? AND r.scope_key = ? AND r.seq > ?
     ORDER BY r.seq ASC, r.op_index ASC`,
  );

  // Whether compaction deleted history of the instance a read names below
  // its basis, from the instance's oldest row, looked up once per instance.
  // Only an entity compaction truncated has such an instance.
  const oldestStmt = squash === undefined
    ? undefined
    : space.db.prepare(SELECT_OLDEST_REVISION_ATTRIBUTION);
  const oldestRows = new Map<string, OldestRevisionAttribution | undefined>();
  const compactedBelow = (
    onBranch: string,
    scopeKey: string,
    basisSeq: number,
  ): boolean => {
    if (oldestStmt === undefined) return false;
    const key = `${onBranch}\0${scopeKey}`;
    if (!oldestRows.has(key)) {
      oldestRows.set(
        key,
        oldestStmt.get<OldestRevisionAttribution>({
          branch: onBranch,
          id,
          scope_key: scopeKey,
        }),
      );
    }
    return historyCompactedBelowRow(oldestRows.get(key), basisSeq);
  };

  // Candidate reader commits: those whose stored ClientCommit mentions this id.
  // (Pre-filter by LIKE to avoid decoding every commit in the space.) The
  // commits whose read names it only by an escaped spelling come from the
  // coverage pass, bound as one JSON array, so however long the history no
  // statement runs past SQLite's limit on bound parameters. The commit's own
  // `branch` is the default for any read that omits one.
  const candidates = space.db
    .prepare(
      `SELECT seq, branch, session_id, original FROM "commit"
       WHERE original LIKE '%' || ? || '%'
          OR seq IN (SELECT value FROM json_each(?))
       ORDER BY seq ASC`,
    )
    .all<
      { seq: number; branch: string; session_id: string; original: string }
    >([id, JSON.stringify(coverage.escapedReaders.get(id) ?? [])]);

  const staleReads: StaleRead[] = [];
  for (const c of candidates) {
    let reads: ConfirmedReadRef[] = [];
    try {
      const o = decodeStored(c.original) as {
        reads?: { confirmed?: ConfirmedReadRef[] };
      };
      reads = (o.reads?.confirmed ?? []).filter((r) => r.id === id);
    } catch {
      skipped.add(c.seq);
      continue;
    }
    // The reader's identity context, for scope resolution (same as the engine's
    // `scopeContext` = the writer principal/session of the commit).
    const readerScope = parseScope(c.session_id);
    for (const rd of reads) {
      if (!isReplayableRead(rd)) {
        skipped.add(c.seq);
        continue;
      }
      const readPath = rd.path;
      // An unqualified read defaults to the READER COMMIT'S branch, not the
      // branch being inspected — exactly as the engine's validateConfirmedReads
      // does (`read.branch ?? commitBranch`). Using the inspected branch would
      // flag cross-branch reads as false anomalies.
      const readBranch = rd.branch ?? c.branch;
      let readScopeKey: string;
      try {
        readScopeKey = resolveScopeKey(rd.scope, {
          principal: readerScope.principal,
          sessionId: readerScope.sessionId,
        });
      } catch {
        // A user/session read with no principal context: unchecked.
        skipped.add(c.seq);
        continue;
      }
      // A read whose basis is older than what compaction kept of its
      // instance may have missed a write that is gone, by the engine's own
      // rule; what the scan still finds, it reports.
      if (compactedBelow(readBranch, readScopeKey, rd.seq)) skipped.add(c.seq);
      const conflict = writesStmt
        .all<WriteRow>(readBranch, id, readScopeKey, rd.seq)
        .find((w) =>
          w.commit_seq < c.seq && w.session_id !== c.session_id &&
          writeConflictsRead(w, readPath, rd.nonRecursive ?? false)
        );
      if (conflict) {
        staleReads.push({
          readerCommitSeq: c.seq,
          readerSession: c.session_id,
          readAtSeq: rd.seq,
          readPath,
          readBranch,
          readScopeKey,
          missedWriteSeq: conflict.seq,
          missedWriteSession: conflict.session_id,
          missedWriteOp: conflict.op,
          readerAlsoWrote: wroteByCommit.has(c.seq),
        });
      }
    }
  }

  const writerPrincipals = principalCount(writers);
  return {
    id,
    writers,
    writerSessions: new Set(writers.map((w) => w.session)).size,
    writerPrincipals,
    multiUser: writerPrincipals >= 2,
    interleaved: sessionSwitches(writers) >= 2,
    staleReads,
    readSetsNotKept: unchecked(space, coverage, id, squash, skipped),
  };
}

/**
 * Returns how many commits after the first write of `id` its scan could not
 * check: those {@link coverage} cannot see, and the entity's own `skipped`
 * ones, which it adds to {@link coverage}. With no write, no read of the
 * entity can be stale. When compaction squashed its history at `squash`, the
 * first write is gone with the rest, so every such commit counts.
 */
function unchecked(
  space: SpaceDb,
  coverage: ReadCoverage,
  id: string,
  squash: number | undefined,
  skipped: ReadonlySet<number>,
): number {
  for (const seq of skipped) coverage.skipped.add(seq);
  // With nothing unchecked there is no cutoff to look up.
  if (coverage.unread.length === 0 && skipped.size === 0) return 0;
  const after = squash === undefined ? firstWriteSeq(space, coverage, id) : 0;
  if (after === undefined) return 0;
  let count = countAfter(coverage.unread, after);
  for (const seq of skipped) {
    if (seq > after && !holdsSeq(coverage.unread, seq)) count++;
  }
  return count;
}

/**
 * Does a write conflict with a read at `readPath`, by the engine's rule? A
 * `set`/`delete` replaces/removes the whole document the read observed, so it
 * always conflicts (path-blind, as `findConflictSeq` does). A `patch` conflicts
 * only when its touched paths overlap the read — reusing the engine's exported
 * `patchOverlapsRead` / `patchOverlapsNonRecursiveRead` so the granularity is
 * identical, never re-derived.
 */
function writeConflictsRead(
  w: WriteRow,
  readPath: string[],
  nonRecursive: boolean,
): boolean {
  if (w.op === "set" || w.op === "delete") return true;
  if (w.op !== "patch") return false;
  let patches: PatchOp[];
  try {
    patches = (w.data ? decodeStored(w.data) : []) as PatchOp[];
  } catch {
    return true; // undecodable patch — conservatively treat as conflicting
  }
  return nonRecursive
    ? patchOverlapsNonRecursiveRead(patches, readPath)
    : patchOverlapsRead(patches, readPath);
}
