/**
 * Restoring a piece to a retained revision: the runtime operation
 * `PieceController.changeSource({kind: "restore"})` performs, read and
 * driven from one place.
 *
 * A piece keeps an append-only log of the source states it has accepted
 * (`docs/specs/piece-source-lifecycle.md`). Restoring means picking one of
 * those revisions and running the source the space still retains behind it —
 * no local file, no recompilation of anything but the retained bytes. This
 * module holds the two things a caller needs around that operation: which
 * revisions a piece could be returned to, and the resolution from the
 * reference a rollback plan recorded to the revision that carries it.
 *
 * The single-piece restore and the bulk rollback share both, so the two
 * cannot disagree about which revision a reference names or about whether a
 * revision can be restored at all.
 */

import type { CellScope } from "@commonfabric/api";
import { type Cell, getPatternSource } from "@commonfabric/runner";

import { isSourceRetained } from "./bulk-survey.ts";
import {
  type PieceController,
  PieceSourceChangedError,
} from "./piece-controller.ts";
import {
  type PieceSourceRevisionState,
  readPieceSourceMetadata,
} from "./piece-origin.ts";
import type { PiecesController } from "./pieces-controller.ts";

/** One revision a piece could be returned to, and whether it could be. */
export interface RestorableRevision {
  revisionId: string;

  /** When the piece accepted this source state, as an epoch millisecond. */
  timestamp: number;

  patternIdentity: string;

  /** The export the revision runs — the executable pointer's other half. */
  symbol: string;

  /** The transition that recorded it: a baseline, an edit, a revert. */
  operation: PieceSourceRevisionState["operation"];

  /**
   * Whether the source behind `patternIdentity` is verifiably retained in
   * the space — the canonical loader can produce its closure. A revision
   * whose source is not retained names a state nothing can return the piece
   * to, which a caller has to know before it starts rather than during an
   * incident.
   */
  retained: boolean;

  /**
   * Whether the piece runs this revision's reference right now. A fact
   * about the reference alone: a piece that runs it while still following
   * an origin is not where a restore of this revision would leave it, the
   * restore severing that origin. {@link RestorableSource.origin} carries
   * the other half.
   */
  current: boolean;
}

/** What one restore run read, and — under `apply` — did. */
export interface RestoreOutcome {
  /** The piece's canonical address. */
  piece: string;

  /** Every revision the piece's log holds, oldest first. */
  revisions: readonly RestorableRevision[];

  /**
   * The revision this run named, when it named one that exists. A copy of
   * the matching `revisions` entry rather than that entry itself: the CLI's
   * JSON serializer reports any second reference to one object as a
   * circular one, so an alias here would render as `<circular reference>`
   * instead of the revision, in exactly the mode a script reads.
   */
  selected?: RestorableRevision;

  /**
   * The origin the piece follows, when it follows one; absent when it is
   * detached. A restore severs it, so this is what tells a piece that is
   * where the restore would leave it from one that merely runs the same
   * reference and would still take the origin's next update.
   */
  origin?: string;

  /** Whether this run wrote the restore. False on every dry run. */
  restored: boolean;

  /**
   * Why the named revision was not restored: no such revision in this
   * piece's log, a source no longer retained, or a compatibility verdict
   * against the piece as it now stands. Absent when nothing is wrong —
   * including on a dry run, and on a piece already standing where the
   * restore would leave it.
   *
   * Not every refusal arrives here. An argument the restored source cannot
   * use at all is the runtime's hard refusal and throws out of this call
   * rather than settling into an outcome.
   */
  problem?: string;

  /**
   * What the runtime warned about a transition that committed anyway — the
   * restored source ran and something in its execution complained. The
   * restore stands; the warning is the operator's to read.
   */
  warning?: string;
}

/** What a restore run is asked to do. */
export interface RestoreOptions {
  /**
   * The revision to restore. Absent, the run is the listing alone: which
   * revisions this piece could be returned to, and which of them a restore
   * could actually load.
   */
  revisionId?: string;

  /** Perform the restore. Absent, the run reads and writes nothing. */
  apply?: boolean;

  /**
   * The piece scope to read and write under, when the caller named one. A
   * scoped reference names a different cell from the default-scope one, so a
   * run that dropped it would list and restore a piece nobody asked about.
   */
  scope?: CellScope;
}

/** What one read of a piece's source state yields a restore. */
export interface RestorableSource {
  /**
   * The reference the piece runs, as THIS read observed it. A caller that
   * goes on to write pins it, so a writer landing between the read and the
   * write is refused rather than written over; deriving it from `revisions`
   * instead would lose exactly the case that matters, a piece running
   * something its own log does not hold. Absent when the piece carries no
   * pattern identity at all.
   */
  pattern?: { identity: string; symbol: string };

  /**
   * The origin the piece follows as THIS read observed it, and null when it
   * follows none — the same fact the runtime's own source snapshot carries,
   * read raw rather than classified, because an origin nothing can classify
   * is still one a restore severs. A restore detaches the piece and runs
   * the retained bytes, so this is the half of "already restored" that the
   * reference cannot answer.
   */
  origin: string | null;

  /** Every revision the log holds, oldest first. */
  revisions: RestorableRevision[];
}

/**
 * Read a piece's source state: the reference it runs, the origin it
 * follows, and every revision it could be returned to, oldest first, each
 * carrying whether its source is still retained and whether the piece runs
 * it now. One synced read of the piece plus one retained-source load per
 * distinct identity in its log — the piece is never run.
 */
export async function readRestorableSource(
  pieces: PiecesController,
  controller: PieceController<unknown>,
): Promise<RestorableSource> {
  const cell = controller.getCell() as Cell<unknown>;
  const state = readPieceSourceMetadata(pieces.runtime, cell);
  const retainedByIdentity = new Map<string, boolean>();
  const revisions: RestorableRevision[] = [];
  for (const revision of state.history) {
    revisions.push({
      revisionId: revision.revisionId,
      timestamp: revision.timestamp,
      patternIdentity: revision.pattern.identity,
      symbol: revision.pattern.symbol,
      operation: revision.operation,
      retained: await isSourceRetained(
        pieces,
        revision.pattern.identity,
        retainedByIdentity,
      ),
      current: state.pattern !== undefined &&
        state.pattern.identity === revision.pattern.identity &&
        state.pattern.symbol === revision.pattern.symbol,
    });
  }
  return {
    ...(state.pattern === undefined ? {} : { pattern: state.pattern }),
    origin: getPatternSource(cell) ?? null,
    revisions,
  };
}

/** The reference a restore is asked to return a piece to. */
export interface RestoreTarget {
  patternIdentity: string;
  symbol: string;

  /**
   * The revision itself, when the caller recorded one. Absent, the
   * reference selects it — the case a rollback row carries for a piece
   * whose log began with the baseline its retarget appended.
   */
  revisionId?: string;
}

/**
 * Resolve a restore target to the revision of this piece's log that carries
 * it — the resolution the runtime's own restore cannot do, since it takes a
 * revision id and a rollback row records a reference.
 *
 * A recorded revision id must both exist here and carry the recorded
 * reference: a log that holds it under a different reference is not the log
 * the plan was derived from, and restoring it would return the piece to
 * something the plan's reader never saw. Without one, the reference selects
 * the most recent revision carrying it — every revision on one
 * `{identity, symbol}` pair restores the same retained source, so which is
 * chosen changes only which revision the transition records itself as
 * having selected.
 */
export function selectRestoreRevision(
  revisions: readonly RestorableRevision[],
  target: RestoreTarget,
): { revision: RestorableRevision } | { problem: string } {
  const reference = `${target.patternIdentity}#${target.symbol}`;
  if (target.revisionId !== undefined) {
    const named = revisions.find((candidate) =>
      candidate.revisionId === target.revisionId
    );
    if (named === undefined) {
      return {
        problem: `The piece's source log holds no revision ` +
          `${target.revisionId}.`,
      };
    }
    if (
      named.patternIdentity !== target.patternIdentity ||
      named.symbol !== target.symbol
    ) {
      return {
        problem: `Revision ${target.revisionId} is on ` +
          `${named.patternIdentity}#${named.symbol}, not the ${reference} ` +
          `this row recorded.`,
      };
    }
    return retainedOrProblem(named);
  }
  const matching = revisions.filter((candidate) =>
    candidate.patternIdentity === target.patternIdentity &&
    candidate.symbol === target.symbol
  );
  const selected = matching.at(-1);
  if (selected === undefined) {
    return {
      problem: `The piece's source log holds no revision on ${reference}.`,
    };
  }
  return retainedOrProblem(selected);
}

/**
 * A revision nothing can load is not a restore target, whichever way it was
 * selected: the check belongs to the selection rather than to each caller.
 */
function retainedOrProblem(
  revision: RestorableRevision,
): { revision: RestorableRevision } | { problem: string } {
  return revision.retained ? { revision } : {
    problem: `The source behind ${revision.patternIdentity}#` +
      `${revision.symbol} is not retained in this space, so revision ` +
      `${revision.revisionId} cannot be restored.`,
  };
}

/**
 * Restore one piece to a retained revision, or — without `apply` — report
 * what a restore would do. Dry by default, like every other operation in
 * this group. A piece already standing where the restore would leave it —
 * running the named revision's reference AND following no origin — is
 * reported as such and not rewritten, which is what makes restoring
 * resumable one piece at a time as much as in bulk.
 */
export async function restorePiece(
  pieces: PiecesController,
  piece: string,
  options: RestoreOptions = {},
): Promise<RestoreOutcome> {
  const controller = await pieces.get(piece, false, undefined, options.scope);
  const { pattern, origin, revisions } = await readRestorableSource(
    pieces,
    controller,
  );
  const outcome: RestoreOutcome = {
    piece: controller.id,
    revisions,
    ...(origin === null ? {} : { origin }),
    restored: false,
  };
  if (options.revisionId === undefined) return outcome;
  const named = revisions.find((candidate) =>
    candidate.revisionId === options.revisionId
  );
  if (named === undefined) {
    return {
      ...outcome,
      problem: revisions.length === 0
        ? `The piece keeps no source revision log, so it has no revision ` +
          `${options.revisionId} — or any other — to restore.`
        : `The piece's source log holds no revision ` +
          `${options.revisionId}; it holds ` +
          revisions.map((revision) => revision.revisionId).join(", ") + ".",
    };
  }
  // The same retention check the bulk path makes, from the same place: a
  // second copy of it here is a second answer to "can this revision be
  // restored", and the two would drift.
  const restorable = retainedOrProblem(named);
  if ("problem" in restorable) {
    return { ...outcome, selected: { ...named }, problem: restorable.problem };
  }
  // Already where this restore would leave the piece: nothing to write, and
  // nothing wrong. Both halves are required, because a restore is a detach
  // as much as it is a reload — the runtime severs the active origin and
  // runs the retained bytes — so a piece that runs the reference while
  // still following an origin has not had this operation performed on it,
  // and skipping the write would leave it taking that origin's next update.
  // The reference alone is what the bulk rollback classifies on, its rows
  // recording a reference and nothing else.
  if ((named.current && origin === null) || options.apply !== true) {
    return { ...outcome, selected: { ...named } };
  }
  let result;
  try {
    // The reference the read above observed, handed to the write as its own
    // precondition — the same rule the bulk paths hold to. Without it this
    // write would adopt whatever it found and commit over a change made
    // since the listing this run reported.
    result = await controller.changeSource({
      kind: "restore",
      revisionId: named.revisionId,
    }, ...(pattern === undefined ? [] : [{ expectedPattern: pattern }]));
  } catch (error) {
    // A piece something else moved is this run's answer, not a crash: it is
    // reported the way an incompatible restore is, so the caller exits
    // nonzero with the reason rather than a stack.
    if (error instanceof PieceSourceChangedError) {
      return { ...outcome, selected: { ...named }, problem: error.message };
    }
    throw error;
  }
  if (result.status === "incompatible") {
    return { ...outcome, selected: { ...named }, problem: result.message };
  }
  return {
    ...outcome,
    selected: { ...named },
    restored: true,
    ...(result.executionWarning === undefined
      ? {}
      : { warning: result.executionWarning }),
  };
}
