// Conflicts & async — the contested/concurrent dimension of multiplayer state.
//
// The durable store records enough to reconstruct who fought over what:
//   - `revision` — every write, joinable to `commit.session_id` (the writer).
//   - `commit.original.reads.confirmed[]` — `ConfirmedRead { id, scope?, branch?,
//     path, seq, nonRecursive? }`: what each commit READ and at which seq.
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
  type PatchOp,
  resolveScopeKey,
} from "@commonfabric/memory/v2";
import {
  patchOverlapsNonRecursiveRead,
  patchOverlapsRead,
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
   * their reads (02-storage.md §3.3), hollowed by compaction, or mentioning
   * the entity in a payload or read the scan could not decode or resolve.
   * Any of them may have read the entity stale, so an empty
   * {@link staleReads} shows the entity coherent only when this is 0.
   */
  readSetsNotKept: number;
}

/**
 * What the stale-read scan cannot see in a space, gathered once per report by
 * {@link readCoverage} and shared by every entity's analysis in it.
 */
export interface ReadCoverage {
  /**
   * Seqs, ascending, of the commits whose reads the log does not hold: stored
   * with a digest in their place, or hollowed by compaction, whose marker
   * does not say whether the commit read anything.
   */
  unread: number[];

  /** The branches that hold revisions, where an entity's writes are. */
  branches: string[];

  /**
   * Seqs of the commits an analysis found mentioning its entity but could
   * not read: an undecodable payload, or a read whose scope it could not
   * resolve. Each analysis adds what it finds.
   */
  skipped: Set<number>;
}

/**
 * Returns what the stale-read scan cannot see in `space`, from one pass over
 * the commit log that holds one row at a time.
 */
export function readCoverage(space: SpaceDb): ReadCoverage {
  const unread: number[] = [];
  // Every digest-form row holds the text `"digest"` and every hollowed one
  // starts with the marker prefix; the checks below decide, since a commit's
  // operations may hold the same text.
  const rows = space.db
    .prepare(
      `SELECT seq, original FROM "commit"
       WHERE original LIKE '%"digest"%' OR substr(original, 1, ?) = ?
       ORDER BY seq ASC`,
    )
    .iter(HOLLOWED_MARKER_PREFIX.length, HOLLOWED_MARKER_PREFIX) as Iterable<
      { seq: number; original: string }
    >;
  for (const { seq, original } of rows) {
    if (isHollowedPayload(original)) {
      unread.push(seq);
      continue;
    }
    let decoded: unknown;
    try {
      decoded = decodeStored(original);
    } catch {
      unread.push(seq);
      continue;
    }
    if (storedReadCounts(decoded)?.kept === false) unread.push(seq);
  }
  const branches = space.db
    .prepare(`SELECT DISTINCT branch FROM revision`)
    .all<{ branch: string }>()
    .map(({ branch }) => branch);
  return { unread, branches, skipped: new Set() };
}

/** Returns how many commits {@link coverage} cannot see, in all. */
export function readSetsNotKeptIn(coverage: ReadCoverage): number {
  const all = new Set(coverage.unread);
  for (const seq of coverage.skipped) all.add(seq);
  return all.size;
}

/**
 * Returns the seq of the first commit that wrote `id` on any of `branches`,
 * in any scope, or undefined when none did. The stale-read scan looks for
 * writes across branches and scopes, so no commit at or before this seq can
 * have read `id` stale.
 */
function firstWriteSeq(
  space: SpaceDb,
  id: string,
  branches: readonly string[],
): number | undefined {
  const first = space.db.prepare(
    `SELECT min(commit_seq) AS seq FROM revision WHERE branch = ? AND id = ?`,
  );
  let seq: number | undefined;
  for (const branch of branches) {
    const found = first.get<{ seq: number | null }>(branch, id)?.seq;
    if (found != null && (seq === undefined || found < seq)) seq = found;
  }
  return seq;
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
  path?: string[];
  nonRecursive?: boolean;
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

  // Candidate reader commits: those whose stored ClientCommit mentions this id.
  // (Pre-filter by LIKE to avoid decoding every commit in the space.) The
  // commit's own `branch` is the default for any read that omits one.
  const candidates = space.db
    .prepare(
      `SELECT seq, branch, session_id, original FROM "commit"
       WHERE original LIKE '%' || ? || '%' ORDER BY seq ASC`,
    )
    .all<
      { seq: number; branch: string; session_id: string; original: string }
    >(id);

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
      const readPath = rd.path ?? [];
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
    readSetsNotKept: unchecked(
      coverage,
      firstWriteSeq(space, id, coverage.branches),
      skipped,
    ),
  };
}

/**
 * Returns how many commits after `firstWrite` the scan of one entity could
 * not check: those {@link coverage} cannot see, and the entity's own
 * `skipped` ones, which it adds to {@link coverage}. With no write, no read
 * of the entity can be stale.
 */
function unchecked(
  coverage: ReadCoverage,
  firstWrite: number | undefined,
  skipped: ReadonlySet<number>,
): number {
  for (const seq of skipped) coverage.skipped.add(seq);
  if (firstWrite === undefined) return 0;
  let count = countAfter(coverage.unread, firstWrite);
  for (const seq of skipped) {
    if (seq > firstWrite && !coverage.unread.includes(seq)) count++;
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
