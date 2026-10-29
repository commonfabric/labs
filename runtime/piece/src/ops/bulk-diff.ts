/**
 * The survey-diff: one survey compared against the plan it was taken for, or
 * against an earlier survey. This is the verification every write stage uses
 * — an apply that exits zero is not a verdict, and the report of what a run
 * actually did is the before-survey held against the after-survey.
 *
 * Three verdicts matter for a row that carries an operation — a retarget or
 * a restore, both of which name the reference they produce: `landed` (on the
 * reference the op produces), `outstanding` (still on the recorded
 * reference), and `moved-elsewhere` (on neither — nothing in the plan
 * accounts for where it is, which is what a half-converged upgrade looks
 * like). Rows without an op are a pre-state record and diff to
 * `unchanged`/`changed`. Every comparison is on the full executable pointer,
 * `{identity, symbol}` — an identity alone conflates two patterns one module
 * exports. A plan carrying repair rows is refused outright: a repair moves
 * the document and not the reference, so a reference diff would answer
 * `unchanged` about work it cannot see — re-running the fixer is that
 * verification, and it lives with the repair.
 */

import { canonicalPieceAddress, type PiecePlan } from "./bulk-plan.ts";

/** One full executable pointer — `{identity, symbol}` — behind a verdict. */
export interface PatternRef {
  patternIdentity: string;
  symbol: string;
}

/** Where one piece stands, measured against its plan row. */
export type PieceDiffStatus =
  | "landed"
  | "outstanding"
  | "moved-elsewhere"
  | "unchanged"
  | "changed"
  | "missing";

/** One piece's verdict, with the references behind it. */
export interface PieceDiffRow {
  piece: string;
  phase?: string;
  status: PieceDiffStatus;

  /** The reference the plan recorded. */
  before: PatternRef;

  /** The reference the after-survey read; absent when the piece is `missing`. */
  after?: PatternRef;

  /** The reference the row's operation produces, when the row carries one. */
  target?: PatternRef;
}

/** A diff over every plan row, plus what the after-survey saw beyond them. */
export interface PlanDiff {
  rows: readonly PieceDiffRow[];

  /** Pieces the after-survey holds that the plan does not. */
  unplanned: readonly string[];

  counts: Readonly<Record<PieceDiffStatus, number>>;
}

/**
 * Compare an after-survey against the plan it verifies. Every plan row gets
 * a verdict; pieces only the after-survey knows are listed as `unplanned`
 * rather than dropped, so a selection that grew mid-run stays visible.
 *
 * Two comparisons are refused outright: plans from different
 * spaces — matching piece ids across spaces would read as landed while
 * saying nothing about either space — and a plan listing a piece more than
 * once, which the format promises never to hold and this function would
 * otherwise silently collapse.
 */
export function diffPlan(plan: PiecePlan, after: PiecePlan): PlanDiff {
  const repairs = plan.rows.filter((row) => row.op?.kind === "repair");
  if (repairs.length > 0) {
    // A repair moves the document, not the reference, so this diff would
    // answer `unchanged` about work it cannot see; re-running the fixer is
    // the repair's verification, and it lives with the repair.
    throw new Error(
      "A reference diff cannot verify a document repair: " +
        repairs.map((row) => row.piece).join(", ") + ".",
    );
  }
  if (plan.header.space !== after.header.space) {
    throw new Error(
      `Plans are from different spaces: ${plan.header.space} and ` +
        `${after.header.space}.`,
    );
  }
  assertAccountedFor(plan, "plan");
  assertAccountedFor(after, "after-survey");
  assertUniquePieces(plan, "plan");
  assertUniquePieces(after, "after-survey");
  // Keys are canonical, so the `of:` alias and the bare spelling of one
  // piece match rather than reading as a missing piece plus an unplanned one.
  const afterById = new Map(
    after.rows.map((row) => [canonicalPieceAddress(row.piece), row]),
  );
  const counts: Record<PieceDiffStatus, number> = {
    landed: 0,
    outstanding: 0,
    "moved-elsewhere": 0,
    unchanged: 0,
    changed: 0,
    missing: 0,
  };
  const rows = plan.rows.map((row) => {
    const before: PatternRef = {
      patternIdentity: row.expect.patternIdentity,
      symbol: row.expect.symbol,
    };
    // The repair arm is unreachable behind the refusal above; the check is
    // what narrows the op union to the reference-carrying kinds.
    const target: PatternRef | undefined =
      row.op === undefined || row.op.kind === "repair"
        ? undefined
        : { patternIdentity: row.op.patternIdentity, symbol: row.op.symbol };
    const key = canonicalPieceAddress(row.piece);
    const seen = afterById.get(key);
    afterById.delete(key);
    let status: PieceDiffStatus;
    let now: PatternRef | undefined;
    if (seen === undefined) status = "missing";
    else {
      now = {
        patternIdentity: seen.expect.patternIdentity,
        symbol: seen.expect.symbol,
      };
      if (target !== undefined) {
        status = sameRef(now, target)
          ? "landed"
          : sameRef(now, before)
          ? "outstanding"
          : "moved-elsewhere";
      } else status = sameRef(now, before) ? "unchanged" : "changed";
    }
    counts[status]++;
    return {
      piece: row.piece,
      ...(row.phase === undefined ? {} : { phase: row.phase }),
      status,
      before,
      ...(now === undefined ? {} : { after: now }),
      ...(target === undefined ? {} : { target }),
    };
  });
  // Unplanned pieces are reported in the after-survey's own spelling; the
  // canonical form was only the matching key.
  return {
    rows,
    unplanned: [...afterById.values()].map((row) => row.piece),
    counts,
  };
}

function sameRef(left: PatternRef, right: PatternRef): boolean {
  return left.patternIdentity === right.patternIdentity &&
    left.symbol === right.symbol;
}

/**
 * A verdict from an incomplete side is not a verdict: pieces the survey did
 * not account for would read as clean rather than as unknown.
 */
function assertAccountedFor(plan: PiecePlan, label: string): void {
  if (
    (plan.header.problems?.length ?? 0) > 0 ||
    (plan.header.outside?.length ?? 0) > 0
  ) {
    throw new Error(
      `The ${label} is incomplete: its header names pieces the survey did ` +
        `not account for.`,
    );
  }
}

function assertUniquePieces(plan: PiecePlan, label: string): void {
  const seen = new Set<string>();
  for (const row of plan.rows) {
    const key = canonicalPieceAddress(row.piece);
    if (seen.has(key)) {
      throw new Error(`The ${label} lists ${row.piece} more than once.`);
    }
    seen.add(key);
  }
}
