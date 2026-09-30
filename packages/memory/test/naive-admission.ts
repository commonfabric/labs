// Naive reference model for commit admission and value application.
//
// This is the "obviously correct, unoptimized" half of the differential
// consistency harness (v2-differential-consistency.test.ts): no SQL, no
// tier shortcuts, no memoization — a direct transcription of the admission
// rules in docs/specs/memory-v2/03-commit-model.md §3.6 over an in-memory
// history of accepted commits.
//
// The refinement obligation it checks is one-directional (INV-2 in
// docs/specs/memory-v2/09-invariants.md): the engine MAY reject commits this
// model would accept (over-approximation costs a retry), but MUST NOT accept
// a commit this model rejects.
//
// Deliberate fidelity notes:
//   - Overlap is exact ancestor/descendant path prefixing; `set`/`delete`
//     overlap every read of the entity. The engine's matcher may only be
//     coarser than this, never finer.
//   - Pending-read staleness: a read declaring its true confirmed basis
//     (`basisSeq`, the CT-1910 repair) is scanned over the FULL interval
//     from that basis, excluding only the own-session layers the read's
//     dependency array NAMES — the layers whose inclusion in the reader's
//     view the array attests. An own write the array does not name
//     conflicts like a foreign one, whether accepted out of submission
//     order or omitted while durably integrated (the declared-set
//     validation of §3.6.3). A legacy read (no `basisSeq`) is
//     based at the HIGHEST dependency's resolution seq — the pre-repair
//     semantics whose over-advance is recorded against INV-1 in
//     09-invariants.md and kept here as the reference for legacy traffic.
//   - Scope and branch dimensions are not modeled; the generator stays on
//     the default branch and space scope.

import { type FabricValue, valueEqual } from "@commonfabric/data-model";

import type { ClientCommit, Operation, PatchOp } from "../v2.ts";

export interface NaiveOp {
  id: string;
  kind: "set" | "patch";

  /** Leaf value paths touched by a patch (unused for `set`). */
  leafPaths: string[][];
}

export interface NaiveCommit {
  seq: number;
  sessionId: string;
  localSeq: number;
  ops: NaiveOp[];
}

export interface NaiveHistory {
  accepted: NaiveCommit[];

  /** sessionId -> localSeq -> resolution seq (accepted commits only). */
  resolution: Map<string, Map<number, number>>;
}

export const emptyHistory = (): NaiveHistory => ({
  accepted: [],
  resolution: new Map(),
});

export type NaiveVerdict =
  | { accepted: true }
  | { accepted: false; reason: string };

const pointerToPath = (pointer: string): string[] =>
  pointer.replace(/^\//, "").split("/");

const isPrefix = (a: readonly string[], b: readonly string[]): boolean =>
  a.length <= b.length && a.every((seg, i) => seg === b[i]);

/** Exact bidirectional overlap: ancestor, descendant, or equal. */
export const naivePathsOverlap = (
  a: readonly string[],
  b: readonly string[],
): boolean => isPrefix(a, b) || isPrefix(b, a);

export const toNaiveOps = (operations: Operation[]): NaiveOp[] =>
  operations.map((op) => {
    if (op.op === "patch") {
      return {
        id: op.id,
        kind: "patch" as const,
        leafPaths: op.patches.map((p: PatchOp) => pointerToPath(p.path)),
      };
    }
    if (op.op === "set" || op.op === "delete") {
      // Both are path-blind: they overlap every read of the entity.
      return { id: op.id, kind: "set" as const, leafPaths: [] };
    }
    throw new Error(`naive model: unsupported operation kind ${op.op}`);
  });

const writeOverlapsRead = (
  op: NaiveOp,
  readPath: readonly string[],
): boolean =>
  op.kind === "set" ||
  op.leafPaths.some((leaf) => naivePathsOverlap(leaf, readPath));

const conflictSeq = (
  history: NaiveHistory,
  id: string,
  readPath: readonly string[],
  afterSeq: number,
  // CT-1910 true-basis scans exclude the own-session layers the read
  // NAMES in its dependency array: those are the layers whose inclusion in
  // the reader's materialized view the array attests. Any own write the
  // array does not name — a higher localSeq accepted first (out-of-order
  // submission) or an omitted predecessor whose write is durable —
  // conflicts like a foreign write.
  exclude?: { sessionId: string; namedLocalSeqs: readonly number[] },
): number | null => {
  for (const commit of history.accepted) {
    if (commit.seq <= afterSeq) continue;
    if (
      exclude !== undefined && commit.sessionId === exclude.sessionId &&
      exclude.namedLocalSeqs.includes(commit.localSeq)
    ) {
      continue;
    }
    for (const op of commit.ops) {
      if (op.id === id && writeOverlapsRead(op, readPath)) return commit.seq;
    }
  }
  return null;
};

/**
 * Whether `commit` leaves every document `store` holds as it is: an identity
 * commit, which the engine accepts without a staleness check because
 * applying it changes nothing (03-commit-model.md §3.6.1). Per document,
 * the commit's `set` and `patch` operations replayed in order on the stored
 * document must leave it unchanged. The engine's rule also replays the
 * sequence from the view the reader saw, which this model has no history to
 * reconstruct, so the engine accepts a subset of what this predicate
 * admits, the direction INV-2 requires.
 */
export const naiveIsIdentityCommit = (
  store: ReadonlyMap<string, Record<string, unknown>>,
  commit: ClientCommit,
): boolean => {
  if (commit.operations.length === 0) return false;
  const ids = new Set<string>();
  for (const op of commit.operations) {
    if (op.op !== "set" && op.op !== "patch") return false;
    ids.add(op.id);
  }
  // Replay every operation on a document, in order, over the stored
  // document; the sequence is an identity where it lands back on it.
  for (const id of ids) {
    const stored = store.get(id);
    if (stored === undefined) return false;
    const replayed = new Map([[id, clone(stored)]]);
    try {
      naiveApply(
        replayed,
        commit.operations.filter((op) => op.op !== "sqlite" && op.id === id),
      );
    } catch {
      return false;
    }
    if (!valueEqual(replayed.get(id) as FabricValue, stored as FabricValue)) {
      return false;
    }
  }
  return true;
};

/**
 * The reference admission decision for `commit` from `sessionId`, given the
 * accepted history so far. Mirrors §3.6 exactly, without shortcuts.
 */
export const naiveAdmit = (
  history: NaiveHistory,
  sessionId: string,
  commit: ClientCommit,
  store?: ReadonlyMap<string, Record<string, unknown>>,
): NaiveVerdict => {
  // Identity admission waives only explicitly elidable staleness.
  const identity = store !== undefined &&
    naiveIsIdentityCommit(store, commit);
  for (const read of commit.reads.confirmed) {
    if (identity && read.validation === "elidable") continue;
    const cs = conflictSeq(history, read.id, read.path, read.seq);
    if (cs !== null) {
      return {
        accepted: false,
        reason: `stale confirmed read: ${read.id}@${read.seq} vs seq ${cs}`,
      };
    }
  }
  const sessionRes = history.resolution.get(sessionId);
  for (const read of commit.reads.pending) {
    const layers = Array.isArray(read.localSeq)
      ? read.localSeq
      : [read.localSeq];
    let basis: number | undefined;
    for (const localSeq of layers) {
      const seq = sessionRes?.get(localSeq);
      if (seq === undefined) {
        return {
          accepted: false,
          reason: `pending dependency not resolved: ${localSeq}`,
        };
      }
      if (basis === undefined || seq > basis) basis = seq;
    }
    if (identity && read.validation === "elidable") continue;
    const cs = read.basisSeq !== undefined
      ? conflictSeq(history, read.id, read.path, read.basisSeq, {
        sessionId,
        namedLocalSeqs: layers,
      })
      : conflictSeq(history, read.id, read.path, basis!);
    if (cs !== null) {
      return {
        accepted: false,
        reason: `stale pending read: ${read.id} vs seq ${cs}`,
      };
    }
  }
  return { accepted: true };
};

/** Records an engine-accepted commit into the reference history. */
export const naiveRecord = (
  history: NaiveHistory,
  sessionId: string,
  commit: ClientCommit,
  seq: number,
  // The operations the engine elided as changing nothing; they wrote no
  // revision, so a later reader's scan must not find them either.
  elidedOpIndexes: readonly number[] = [],
): void => {
  history.accepted.push({
    seq,
    sessionId,
    localSeq: commit.localSeq,
    ops: toNaiveOps(
      commit.operations.filter((_, index) => !elidedOpIndexes.includes(index)),
    ),
  });
  let sessionRes = history.resolution.get(sessionId);
  if (!sessionRes) {
    sessionRes = new Map();
    history.resolution.set(sessionId, sessionRes);
  }
  sessionRes.set(commit.localSeq, seq);
};

//
// Reference value semantics (INV-9's naive fold)
//

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Applies accepted operations to the naive value store. Supports the op
 * shapes the differential generator emits: whole-document `set`, object-key
 * `replace`/`add`, and array append (`.../-`).
 */
export const naiveApply = (
  store: Map<string, Record<string, unknown>>,
  operations: Operation[],
): void => {
  for (const op of operations) {
    if (op.op === "set") {
      store.set(op.id, clone(op.value) as Record<string, unknown>);
      continue;
    }
    if (op.op !== "patch") {
      throw new Error(`naiveApply: unsupported op ${op.op}`);
    }
    const doc = store.get(op.id);
    if (!doc) throw new Error(`naiveApply: patch on missing entity ${op.id}`);
    for (const patch of op.patches) {
      if (patch.op !== "replace" && patch.op !== "add") {
        throw new Error(`naiveApply: unsupported patch op ${patch.op}`);
      }
      const path = pointerToPath(patch.path);
      let container: Record<string, unknown> = doc;
      for (const seg of path.slice(0, -1)) {
        container = container[seg] as Record<string, unknown>;
        if (container === undefined) {
          throw new Error(`naiveApply: missing container at ${patch.path}`);
        }
      }
      const last = path[path.length - 1];
      if (last === "-") {
        (container as unknown as unknown[]).push(clone(patch.value));
      } else {
        container[last] = clone(patch.value);
      }
    }
  }
};
