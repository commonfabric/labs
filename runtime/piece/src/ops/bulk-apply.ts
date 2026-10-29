/**
 * The apply engine every bulk write stage runs on: serial, in plan order,
 * each row's precondition proved before its write, stopping at the first
 * failure with the remainder named, and recomputing what is outstanding on
 * every invocation (docs/plans/piece-bulk-operations.md).
 *
 * The plan is the whole input: each row carries the reference pair the piece
 * must still be on (`expect`) and the pair its operation produces (`op`), and
 * classification compares both halves of a pair, never an identity alone. A
 * piece on its row's `expect` pair is outstanding; on the `op` pair it landed
 * and is not rewritten, which is what makes a re-invocation a resume; on
 * neither, something this plan does not account for moved it, and the run
 * stops — or never starts, when preflight finds it first.
 *
 * Sessions are grouped: a fresh session serves a bounded number of pieces
 * and is then released, so the expensive warm-up is paid once per group
 * while the pieces live at once stay bounded by the group size — a knob,
 * not a constant. A group boundary is thereby a resume point: a run that
 * dies inside a group loses at most that group's warm-up, because every
 * landed row reads as landed on the next invocation.
 *
 * What differs between the stages is one step: what a row's write does. That
 * arrives as a {@link PlanOperation} — the retarget's is resolving a local
 * source and setting it, the rollback's is restoring a retained revision —
 * and everything around it is shared, so the two cannot drift in how a
 * precondition is checked, how a stop names its remainder, or what a resume
 * rewrites.
 *
 * Applying implies no verdict. The verification is the survey-diff — a
 * survey taken afterwards, compared against this plan — and it stays a
 * separate invocation by design; this module only applies and reports.
 */

import {
  acceptUnretained,
  normalizePlan,
  type PieceOp,
  type PiecePlan,
} from "./bulk-plan.ts";
import { readPiecePin } from "./bulk-survey.ts";
import type { PiecesController } from "./pieces-controller.ts";

/**
 * The session supply a run draws on. `open` yields a fresh session over the
 * target space; `close` releases one, ending the group whose pieces it kept
 * live. Production closes by disposing the session's runtime; a test
 * harness may defer disposal while still observing every boundary.
 */
export interface ApplySessions {
  open(): Promise<PiecesController>;
  close(pieces: PiecesController): Promise<void>;
}

/**
 * One piece's outcome. `landed` and `outstanding` are the preflight's
 * verdicts — already on the op's pair, or still on the expected one — and
 * an apply turns `outstanding` into `applied`. `moved-elsewhere` is a piece
 * on neither of its row's pairs: nothing in the plan accounts for where it
 * is, so the run stops (or never starts). `refused` is a row this run must
 * not apply — a source resolving to a different reference than the row
 * recorded, a restore the piece's own state cannot accept. `failed` is an
 * operational failure, state-checked; and `unattempted` names the rows a
 * stop leaves untouched — the pieces of a group whose session never opened,
 * or opened onto another space, among them, nothing having been written to
 * them.
 */
export type ApplyVerdict =
  | "landed"
  | "outstanding"
  | "applied"
  | "moved-elsewhere"
  | "refused"
  | "failed"
  | "unattempted";

/** One piece's row in an apply report. */
export interface ApplyRow {
  piece: string;

  /** The plan row's phase label, carried as the plan stamped it. */
  phase?: string;

  verdict: ApplyVerdict;

  /**
   * What a moved, refused, or failed row broke; absent otherwise. A row
   * names its own piece's trouble alone — the run's own, a session that
   * would not open or close, is the report's `stopReason`.
   */
  problem?: string;

  /**
   * What the runtime warned about a write that DID land — the source was
   * saved and something after it complained. Distinct from `problem`, which
   * belongs to a row that did not apply: a warned row is a success the
   * operator still has to read about, so it rides the report rather than
   * only a console nobody keeps.
   */
  warning?: string;

  /**
   * The origin the plan recorded for this piece, absent when the plan
   * recorded none. A survey's reading, carried verbatim: it says what the
   * piece followed when the plan was made and nothing about this run.
   * {@link ApplyRow.detachedOrigin} carries what a write actually detached,
   * and that is the one to re-attach from.
   *
   * A field of its own rather than a `warning`, which is a fact about a
   * write that landed and so cannot reach the dry run — the one moment the
   * operator can still decide what to do about a detach. See
   * [docs/features/piece-bulk-operations.md](../../../../docs/features/piece-bulk-operations.md).
   */
  origin?: string;

  /**
   * The origin this run's write actually detached, present only on a row
   * this run wrote and only when that write detached one.
   *
   * Separate from {@link ApplyRow.origin} because the two can differ and the
   * difference is the operator's to see. Only the pattern reference is a
   * precondition of a retarget, so a piece whose origin alone moved since
   * the survey is still written — and detached off the origin it holds NOW,
   * not the one the plan recorded. Reporting the recorded one would send an
   * operator re-attaching by hand to the wrong origin, which is worse than
   * recording nothing, a wrong record being confidently actionable.
   *
   * Substituting it silently would be a smaller lie and still a lie: a plan
   * that has gone stale is itself worth knowing, so both values ride the
   * row and the report names both when they disagree. Absent on a row where
   * the write detached nothing, which — beside a recorded `origin` — is
   * exactly the case a substitution would have hidden.
   */
  detachedOrigin?: string;

  /**
   * The row's wall-clock cost in milliseconds, present on every row an
   * apply session began work on: a row reclassified as landed, moved, or
   * refused cost the reads and resolution that reclassified it, and reports
   * that cost as an applied row reports its write. Absent on a preflight
   * classification and on an unattempted row, neither of which an apply
   * session worked on. The number the plan wants reported as the run
   * proceeds: a run whose cost per piece is unknown cannot be improved.
   */
  elapsedMs?: number;
}

/** What one apply run found, and — under `apply` — did. */
export interface ApplyReport {
  rows: readonly ApplyRow[];

  /** Operations applied. Zero on a dry run and on a fully landed re-run. */
  applied: number;

  /**
   * True when every row reached what this run was for and no session
   * boundary failed: under `apply`, every row is `landed` or `applied`;
   * on a dry run, every row is `landed` or `outstanding`, that being the
   * dry run's answer rather than a defect. Either way nothing moved,
   * nothing was refused, nothing failed, nothing went unattempted, and
   * every session this run opened was released. A row that landed with a
   * `warning` is still complete: the write happened.
   */
  complete: boolean;

  /**
   * Why the run stopped when no piece is at fault: a session that could not
   * be opened, could not be released, or opened onto a space other than the
   * plan's. A piece's own trouble rides its row's `problem`; a boundary
   * failure belongs to the run rather than to any one piece, so it is
   * reported here — and its presence makes
   * `complete` false whatever the rows say, since a run whose session
   * accounting broke did not finish cleanly.
   */
  stopReason?: string;
}

/**
 * The operations this engine classifies: the ones whose row records the
 * reference pair the operation produces, which is what "landed" is decided
 * against. A repair's row records a document hash instead — its outcome is
 * read off the document rather than off a reference — so repair is not one
 * of them and runs on its own path.
 */
export type ReferenceOp = Extract<PieceOp, { patternIdentity: string }>;

/** A plan row narrowed to the work one run performs. */
export interface WorkRow<Op extends ReferenceOp> {
  piece: string;
  phase?: string;

  /**
   * The origin the plan recorded for this piece; see {@link ApplyRow.origin}.
   * Beside `expect` rather than inside it: `expect` is the precondition a
   * write is proved against, and the origin is neither proved nor enforced —
   * a piece that left its origin since the survey is not thereby a row to
   * refuse.
   */
  origin?: string;

  expect: { patternIdentity: string; symbol: string };
  op: Op;
}

/**
 * What a write step reports back. `undefined` is the ordinary case: the
 * write landed and there is nothing to add.
 */
export interface WriteOutcome {
  /** Why this row must not apply. Nothing was written. */
  refused?: string;

  /** What the runtime warned about a write that landed anyway. */
  warning?: string;

  /**
   * The origin the write detached, when it detached one. The write step is
   * the only place this can be observed honestly — the detach happens
   * there, and a value read anywhere earlier is a value the write may have
   * moved off. See {@link ApplyRow.detachedOrigin}.
   */
  detachedOrigin?: string;
}

/**
 * The one step that differs between the write stages: what a row's write
 * does, and what this run calls itself when it refuses a plan it cannot
 * run.
 */
export interface PlanOperation<Op extends ReferenceOp> {
  /** The op kind this run applies; a plan carrying any other is refused. */
  kind: Op["kind"];

  /**
   * The word a refusal uses for one of this run's rows — "retarget",
   * "restore" — pluralized by the engine where a message needs it. Both
   * spellings are regular, and a run whose noun is not would be naming an
   * operation this vocabulary does not hold.
   */
  noun: string;

  /**
   * Write one outstanding row, in the session in hand, immediately after
   * its precondition was proved. Returns `undefined` when the write landed
   * with nothing to say, `{refused}` when the row must not apply — as
   * opposed to a throw, which is an operational failure the engine
   * state-checks after the fact — and `{warning}` when the write DID land
   * and the runtime complained about it.
   *
   * The proof is `row.expect`, and carrying it into the write is this
   * step's obligation rather than the engine's: the engine's read can only
   * classify, so a write that re-derives its own expectation reopens the
   * window between the two. Every implementation here hands `row.expect`
   * to the runtime call as its precondition and refuses the row when the
   * piece has moved off it.
   */
  write(
    pieces: PiecesController,
    row: WorkRow<Op>,
  ): Promise<WriteOutcome | undefined>;
}

export interface ApplyOptions<Op extends ReferenceOp> {
  plan: PiecePlan;
  operation: PlanOperation<Op>;

  /**
   * Perform each row's operation. Absent, the run is the preflight
   * classification alone — where every piece stands, and no write at all.
   */
  apply?: boolean;

  /**
   * Pieces the operator has accepted, by name, as ones no reversal can
   * return — their prior source is not retained. Only a run that writes
   * needs them: a dry run is free to report over such rows, since reporting
   * moves nothing. See {@link acceptUnretained}.
   */
  accepted?: readonly string[];

  /**
   * Pieces served by one session before it is replaced. The knob the
   * design requires: warm-up amortizes across a group while the pieces
   * live at once stay bounded by it.
   */
  groupSize?: number;

  /**
   * Called as each row settles, for reporting as the run proceeds. A throw
   * from it is the caller's error rather than the run's: it reaches the
   * caller in place of a report, having released the session in hand, and
   * is never mistaken for the operational failure that turns a row
   * `failed`.
   */
  onRow?: (row: ApplyRow) => void;

  /** The clock behind `elapsedMs`, injectable for deterministic tests. */
  now?: () => number;
}

const DEFAULT_GROUP_SIZE = 25;

/**
 * Classify one pin against its row: both halves of a pair, never the
 * identity alone — two patterns one module exports share an identity and
 * differ only in symbol.
 */
function classify<Op extends ReferenceOp>(
  pin: { patternIdentity: string; symbol: string } | undefined,
  row: WorkRow<Op>,
): "landed" | "outstanding" | "moved-elsewhere" {
  if (
    pin !== undefined && pin.patternIdentity === row.op.patternIdentity &&
    pin.symbol === row.op.symbol
  ) return "landed";
  if (
    pin !== undefined && pin.patternIdentity === row.expect.patternIdentity &&
    pin.symbol === row.expect.symbol
  ) return "outstanding";
  return "moved-elsewhere";
}

/**
 * The fields a report row takes from its plan row whatever its verdict: the
 * phase label the plan stamped, and the origin the plan recorded. Both
 * describe the row rather than its outcome, so every report of a row spreads
 * these rather than assembling its own — a row reported down one path and
 * not another is how one of them would go missing from a stop.
 *
 * What the run OBSERVED does not belong here and is added by the path that
 * observed it: `detachedOrigin` exists only where a write happened, and
 * carrying it from the plan row is what made the plan's stale reading
 * readable as the run's own.
 */
function carriedFields<Op extends ReferenceOp>(
  row: WorkRow<Op>,
): { phase?: string; origin?: string } {
  return {
    ...(row.phase === undefined ? {} : { phase: row.phase }),
    ...(row.origin === undefined ? {} : { origin: row.origin }),
  };
}

/**
 * Release a session, handing back what a failure broke instead of throwing
 * it. Once a run holds outcomes worth reporting, a session boundary that
 * fails must not throw them away — the rows a partial migration produced
 * are exactly what its operator needs — so the failure is returned to be
 * named as the run's stop reason.
 */
async function closeSession(
  sessions: ApplySessions,
  pieces: PiecesController,
): Promise<string | undefined> {
  try {
    await sessions.close(pieces);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Apply a plan's rows of one operation kind, or — without `apply` — report
 * where every piece stands. Serial in plan order; preflight proves every
 * row's precondition before the first write; grouped sessions bound what
 * stays live; a stop names every unattempted piece. The plan's space is
 * held against every session's, so a plan replayed elsewhere is refused
 * before it reads rather than run against whatever pieces happen to answer
 * to its addresses — the preflight's mismatch refusing the run outright, a
 * later group's stopping it with the remainder named. A session boundary
 * that fails once outcomes exist is a stop like any other — the rows stand,
 * the remainder is named, and `stopReason` says what broke; only the
 * preflight's own open throws, there being no report to lose. Op-less rows
 * — the pre-state record, a collection's holder among them — carry no work
 * and are left out of the report; a row of another operation's kind is
 * refused outright, one run applying one kind.
 */
export async function applyPlan<Op extends ReferenceOp>(
  sessions: ApplySessions,
  options: ApplyOptions<Op>,
): Promise<ApplyReport> {
  const { operation } = options;
  const plan = normalizePlan(options.plan);
  if (
    (plan.header.problems?.length ?? 0) > 0 ||
    (plan.header.outside?.length ?? 0) > 0
  ) {
    throw new Error(
      `No ${operation.noun} can run from an incomplete plan: its header ` +
        `names pieces the survey did not account for.`,
    );
  }
  const foreign = plan.rows.filter((row) =>
    row.op !== undefined && row.op.kind !== operation.kind
  );
  if (foreign.length > 0) {
    throw new Error(
      `This run applies ${operation.noun}s alone; the plan carries other ` +
        "operations on: " + foreign.map((row) => row.piece).join(", ") + ".",
    );
  }
  const work: WorkRow<Op>[] = plan.rows.flatMap((row) =>
    row.op?.kind === operation.kind
      ? [{
        piece: row.piece,
        ...(row.phase === undefined ? {} : { phase: row.phase }),
        ...(row.expect.origin === undefined
          ? {}
          : { origin: row.expect.origin }),
        expect: {
          patternIdentity: row.expect.patternIdentity,
          symbol: row.expect.symbol,
        },
        op: row.op as Op,
      }]
      : []
  );
  if (work.length === 0) {
    throw new Error(
      `The plan has no ${operation.noun} rows, so there is nothing to apply.`,
    );
  }
  // The reversibility gate, and it belongs before the first write rather
  // than at the reversal: accepting "this piece cannot be rolled back" is
  // only a decision while the piece has not moved yet. Asked after the
  // forward run, it is asked past the point of no return, which is not a
  // decision at all. A dry run is not gated — it moves nothing, and
  // reporting where an unretained piece stands is how the operator finds
  // out there is something to decide.
  if (options.apply === true) {
    acceptUnretained(
      plan.rows,
      options.accepted,
      `This ${operation.noun} cannot start`,
    );
  }
  const now = options.now ?? Date.now;
  const groupSize = options.groupSize ?? DEFAULT_GROUP_SIZE;
  if (!Number.isSafeInteger(groupSize) || groupSize < 1) {
    throw new Error("groupSize must be a positive integer.");
  }
  const rows: ApplyRow[] = [];
  // Set when a caller's `onRow` throws, so the row handling below can tell
  // that error from the operational ones it classifies: the row it was
  // handed has already settled, and re-reporting it would put one plan row
  // in the report twice under two verdicts.
  let reporterThrew = false;
  const report = (row: ApplyRow) => {
    rows.push(row);
    if (options.onRow === undefined) return;
    try {
      options.onRow(row);
    } catch (error) {
      reporterThrew = true;
      throw error;
    }
  };

  // Preflight: every row classified from one read, before the first write.
  // A piece on neither of its row's references — or one that cannot be
  // read — keeps the run from starting at all, with every row reporting
  // where it stands and nothing applied.
  const preflight = new Map<
    string,
    "landed" | "outstanding" | { blocked: ApplyRow }
  >();
  let startBlocked = false;

  /** The run's own trouble, as opposed to any piece's: see `stopReason`. */
  let sessionProblem: string | undefined;

  {
    const pieces = await sessions.open();
    try {
      // A piece address names a piece within a space, so the same address
      // names a different piece in another one. A plan surveyed elsewhere
      // is refused here, before any read is classified from it.
      if (pieces.getSpace() !== plan.header.space) {
        throw new Error(
          `The plan names space ${plan.header.space}; this run targets ` +
            `${pieces.getSpace()}.`,
        );
      }
      // One retained-source cache for the session: a board on one identity
      // pays its retained load once, not once per row.
      const retainedByIdentity = new Map<string, boolean>();
      for (const row of work) {
        const carried = carriedFields(row);
        try {
          const pin = await readPiecePin(pieces, row.piece, retainedByIdentity);
          const standing = classify(pin, row);
          if (standing === "moved-elsewhere") {
            preflight.set(row.piece, {
              blocked: {
                piece: row.piece,
                ...carried,
                verdict: "moved-elsewhere",
                problem: pin === undefined
                  ? "The piece carries no pattern identity to compare."
                  : `The piece is on ${pin.patternIdentity}#${pin.symbol}, ` +
                    `which is neither the reference this row recorded nor ` +
                    `the one it produces.`,
              },
            });
            startBlocked = true;
            continue;
          }
          preflight.set(row.piece, standing);
        } catch (error) {
          preflight.set(row.piece, {
            blocked: {
              piece: row.piece,
              ...carried,
              verdict: "failed",
              problem:
                (error instanceof Error ? error.message : String(error)) +
                "; the run did not start, so nothing was written.",
            },
          });
          startBlocked = true;
        }
      }
    } finally {
      // The classification exists by now, so a preflight session that will
      // not release keeps its report rather than losing it to a rejection —
      // and blocks the start, nothing having been written yet.
      const problem = await closeSession(sessions, pieces);
      if (problem !== undefined) {
        sessionProblem = problem +
          "; the preflight session could not be released, so nothing was " +
          "written.";
        startBlocked = true;
      }
    }
  }
  if (startBlocked || options.apply !== true) {
    for (const row of work) {
      const carried = carriedFields(row);
      // Every work row was classified above — the loop writes one of the
      // three outcomes for each, and duplicates cannot collapse two rows
      // onto one key, the codec having refused them.
      const standing = preflight.get(row.piece)!;
      if (standing === "landed" || standing === "outstanding") {
        report({ piece: row.piece, ...carried, verdict: standing });
      } else {
        report(standing.blocked);
      }
    }
    const complete = sessionProblem === undefined &&
      rows.every((row) =>
        row.verdict === "landed" ||
        (options.apply !== true && row.verdict === "outstanding")
      );
    return {
      rows,
      applied: 0,
      complete,
      ...(sessionProblem === undefined ? {} : { stopReason: sessionProblem }),
    };
  }

  // The serial apply, in plan order, over bounded session groups. Every
  // row's standing is proved again in its group's own session immediately
  // before its write, the preflight's verdict deciding nothing here: a row
  // proved landed there is reported without a write — a resume must not
  // rewrite one — and a row another writer moved since is caught by the
  // same read that would have skipped it.
  let applied = 0;
  let stopped = false;
  for (let start = 0; start < work.length; start += groupSize) {
    const group = work.slice(start, start + groupSize);
    if (stopped) {
      for (const row of group) {
        const carried = carriedFields(row);
        report({ piece: row.piece, ...carried, verdict: "unattempted" });
      }
      continue;
    }
    let pieces: PiecesController;
    try {
      pieces = await sessions.open();
    } catch (error) {
      // A session that never opened wrote nothing, so its group's pieces
      // are unattempted rather than failed — their state is known, not
      // unknown — and no row is at fault, so the reason is the run's. The
      // stop names the remainder the way every other stop does.
      sessionProblem =
        (error instanceof Error ? error.message : String(error)) +
        "; this group's session could not be opened, so its pieces were " +
        "not attempted.";
      for (const row of group) {
        const carried = carriedFields(row);
        report({ piece: row.piece, ...carried, verdict: "unattempted" });
      }
      stopped = true;
      continue;
    }
    if (pieces.getSpace() !== plan.header.space) {
      // Every session, not just the preflight's: the factory is the
      // caller's, and a later one can answer for another space, where these
      // addresses name different pieces — or nothing at all. The rows are
      // untouched, so they are unattempted and the reason is the run's.
      const mismatch = `The plan names space ${plan.header.space}; this ` +
        `group's session targets ${pieces.getSpace()}.`;
      stopped = true;
      try {
        for (const row of group) {
          const carried = carriedFields(row);
          report({ piece: row.piece, ...carried, verdict: "unattempted" });
        }
      } finally {
        // This session opened, so it is released like any other — in a
        // `finally`, because reporting runs a caller's callback and one
        // that throws must take a session with it. A release that fails
        // too is named after the mismatch and never instead of it: the
        // wrong space is why the run stopped.
        const closeProblem = await closeSession(sessions, pieces);
        sessionProblem = mismatch +
          (closeProblem === undefined
            ? ""
            : ` Its session could not be released either: ${closeProblem}.`);
      }
      continue;
    }
    // One retained-source cache for this group's session, as in preflight.
    const retainedByIdentity = new Map<string, boolean>();
    try {
      for (const row of group) {
        const carried = carriedFields(row);
        if (stopped) {
          report({ piece: row.piece, ...carried, verdict: "unattempted" });
          continue;
        }
        const startedAt = now();
        try {
          // The precondition again, in this session, immediately before
          // the write: preflight's read has aged by up to a group's worth
          // of work. This read classifies; it does not guard. The write
          // itself carries the reference proved here as its own
          // precondition, so a writer landing between the two is refused
          // by the write rather than overwritten by it — see the
          // operations' write steps.
          const pin = await readPiecePin(pieces, row.piece, retainedByIdentity);
          const standing = classify(pin, row);
          if (standing === "landed") {
            report({
              piece: row.piece,
              ...carried,
              verdict: "landed",
              elapsedMs: now() - startedAt,
            });
            continue;
          }
          if (standing === "moved-elsewhere") {
            report({
              piece: row.piece,
              ...carried,
              verdict: "moved-elsewhere",
              problem: "The piece left its recorded reference after " +
                "preflight; something other than this plan moved it.",
              elapsedMs: now() - startedAt,
            });
            stopped = true;
            continue;
          }
          const outcome = await operation.write(pieces, row);
          if (outcome?.refused !== undefined) {
            report({
              piece: row.piece,
              ...carried,
              verdict: "refused",
              problem: outcome.refused,
              elapsedMs: now() - startedAt,
            });
            stopped = true;
            continue;
          }
          applied += 1;
          report({
            piece: row.piece,
            ...carried,
            verdict: "applied",
            // The write's own observation, beside the plan's record rather
            // than over it: this row is the only one that has both, and a
            // disagreement between them is what tells the operator their
            // plan went stale before the run reached it.
            ...(outcome?.detachedOrigin === undefined
              ? {}
              : { detachedOrigin: outcome.detachedOrigin }),
            ...(outcome?.warning === undefined
              ? {}
              : { warning: outcome.warning }),
            elapsedMs: now() - startedAt,
          });
        } catch (error) {
          // A reporting callback that threw is the caller's own error, and
          // the row it was handed has already settled: state-checking it
          // would report that one plan row a second time, under a verdict
          // contradicting the one the caller just saw. It leaves instead,
          // the group's `finally` releasing the session on the way.
          if (reporterThrew) throw error;
          // Every other failure is classified by a state check made after
          // it, the way the design requires — never a probe before.
          const problem = error instanceof Error
            ? error.message
            : String(error);
          let state =
            "; the piece could not be re-read, so its state is unknown";
          try {
            const pin = await readPiecePin(
              pieces,
              row.piece,
              retainedByIdentity,
            );
            const standing = classify(pin, row);
            state = standing === "landed"
              ? "; the piece is on the row's target reference, so the " +
                "write landed"
              : standing === "outstanding"
              ? "; the piece is still on its recorded reference"
              : "; the piece is on neither of the row's references";
          } catch {
            // The re-read failing changes nothing: `state` already says so.
          }
          report({
            piece: row.piece,
            ...carried,
            verdict: "failed",
            problem: problem + state,
            elapsedMs: now() - startedAt,
          });
          stopped = true;
        }
      }
    } finally {
      // This group's rows have settled, and its writes are committed. A
      // session that will not release loses none of that: the run stops
      // here, later groups are named as any stop names its remainder, and
      // the reason is the run's rather than any piece's.
      const problem = await closeSession(sessions, pieces);
      if (problem !== undefined) {
        sessionProblem = problem +
          "; the session serving this group could not be released, so the " +
          "run stopped.";
        stopped = true;
      }
    }
  }
  const complete = sessionProblem === undefined &&
    rows.every((row) => row.verdict === "landed" || row.verdict === "applied");
  return {
    rows,
    applied,
    complete,
    ...(sessionProblem === undefined ? {} : { stopReason: sessionProblem }),
  };
}
