/**
 * What a space's history says of its pieces' pattern code: each step of the
 * history joined with the source revisions the pieces recorded while it
 * happened, as a piece's own source history lists them
 * (`docs/specs/piece-source-lifecycle.md`).
 */

import type { CellScope } from "@commonfabric/api";
import {
  describeOrigin,
  type HistoryStep,
  type PieceOriginView,
  type PiecePatternRefView,
  type PieceSourceRevisionOperation,
  type PieceSourceView,
  sourceOperationLabel,
} from "@commonfabric/runtime-client";

/** One change of a piece's pattern code, as a step of history shows it. */
export type PatternChange = {
  /** The piece whose source changed. */
  pieceId: string;

  /** The scope that completes `pieceId` into a document address. */
  scope?: CellScope;

  /** The piece's name, where it has one. */
  pieceName?: string;

  /** The source revision the change recorded. */
  revisionId: string;

  /**
   * When the revision was made, in milliseconds since the epoch, by the
   * clock of the runtime that made it.
   */
  madeAt: number;

  /** What produced the revision. */
  operation: PieceSourceRevisionOperation;

  /** What that operation is called, as the piece's source history calls it. */
  label: string;

  /** The pattern the piece pointed at afterwards. */
  pattern: PiecePatternRefView;

  /** Where that pattern came from, for one that came from anywhere. */
  origin?: PieceOriginView;

  /** What kind of origin that is, or that the piece followed none. */
  originLabel: string;

  /** Whether the piece is on this revision now. */
  current: boolean;
};

/** A step of a space's history, with the pattern changes made during it. */
export type SpaceHistoryStep = HistoryStep & {
  /** The pattern changes the step's pieces recorded, oldest first. */
  patternChanges: readonly PatternChange[];
};

/** A piece's source, and the scope its id was read in. */
export type PieceSourceOfScope = {
  source: PieceSourceView;
  scope?: CellScope;
};

/**
 * How long after a source revision's own time its commit may be admitted and
 * still be taken for that revision's: the two times come from different
 * clocks, the revision's from whichever runtime changed the source and the
 * commit's from the memory server.
 */
const REVISION_COMMIT_WINDOW_MS = 60_000;

/** A commit's time is kept to the second, so it can read up to this early. */
const COMMIT_TIME_GRAIN_MS = 1000;

/**
 * Returns `steps`, newest first as a history listing gives them, each with
 * the pattern changes its pieces recorded. A source revision carries the
 * time it was made and no seq, so a revision is given to the first step that
 * began at or after that time, when the step began within
 * {@link REVISION_COMMIT_WINDOW_MS} of it. A revision none of `steps` began
 * that close to is left out: it belongs to a stretch of history not listed.
 */
export function withPatternChanges(
  steps: readonly HistoryStep[],
  sources: readonly PieceSourceOfScope[],
): SpaceHistoryStep[] {
  const changes: PatternChange[] = [];
  for (const { source, scope } of sources) {
    for (const revision of source.history) {
      changes.push({
        pieceId: source.pieceId,
        ...(scope !== undefined ? { scope } : {}),
        ...(source.name !== undefined ? { pieceName: source.name } : {}),
        revisionId: revision.revisionId,
        madeAt: revision.timestamp,
        operation: revision.operation,
        label: sourceOperationLabel(revision.operation),
        pattern: revision.pattern,
        ...(revision.origin !== undefined ? { origin: revision.origin } : {}),
        originLabel: describeOrigin(revision.origin).label,
        current: revision.revisionId === source.currentRevisionId,
      });
    }
  }
  return placeChanges(steps, changes);
}

/**
 * Returns the steps listed so far followed by an `older` stretch of the same
 * history, with the pattern changes of both placed over the whole, each once
for its piece, scope and revision. A change
 * made shortly before the oldest step of a stretch is placed on that step
 * while the stretch stands alone, and on the older step it belongs to once
 * that one is listed.
 */
export function withOlderSteps(
  listed: readonly SpaceHistoryStep[],
  older: readonly SpaceHistoryStep[],
): SpaceHistoryStep[] {
  const steps = [...listed, ...older];
  const changes = new Map<string, PatternChange>();
  for (const step of steps) {
    for (const change of step.patternChanges) {
      changes.set(
        `${change.scope ?? "space"}\n${change.pieceId}\n${change.revisionId}`,
        change,
      );
    }
  }
  return placeChanges(steps, [...changes.values()]);
}

/**
 * Returns `steps`, newest first, each with those of `changes` placed on it
 * by the rule {@link withPatternChanges} states, oldest first.
 */
function placeChanges(
  steps: readonly HistoryStep[],
  changes: readonly PatternChange[],
): SpaceHistoryStep[] {
  const result: SpaceHistoryStep[] = steps.map((step) => ({
    ...step,
    patternChanges: [],
  }));
  // Oldest first, so that the first step found is the earliest one.
  const byTime = result.map((step) => ({
    step,
    began: Date.parse(step.at),
  })).reverse();
  const found = new Map<SpaceHistoryStep, PatternChange[]>();
  for (const change of changes) {
    const first = byTime.find(({ began }) =>
      began + COMMIT_TIME_GRAIN_MS > change.madeAt
    );
    if (
      first === undefined ||
      first.began - change.madeAt >= REVISION_COMMIT_WINDOW_MS
    ) continue;
    const placed = found.get(first.step) ?? [];
    found.set(first.step, placed);
    placed.push(change);
  }
  for (const [step, placed] of found) {
    step.patternChanges = placed.sort((a, b) => a.madeAt - b.madeAt);
  }
  return result;
}
