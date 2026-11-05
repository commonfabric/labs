/**
 * Bulk retarget: the upgrade apply. One source package moves across the
 * pieces a plan names, on the shared apply engine
 * ([bulk-apply.ts](./bulk-apply.ts)) that owns selection, preconditions,
 * ordering, stopping, and resumption (docs/plans/piece-bulk-operations.md,
 * stage 3). What lives here is the one step that is the retarget's own: what
 * a row's write does.
 *
 * Deno-only, like the local resolution it builds on: each row's source is
 * resolved from disk and its identity recomputed — without compiling —
 * immediately before the write, and a source that no longer produces the
 * reference its row recorded is refused rather than applied.
 *
 * The write detaches the piece from the origin it follows: the source it
 * runs afterwards is the one this plan names, chosen by a human, and a piece
 * still carrying that origin could be repointed afterwards to whatever the
 * origin ships, leaving the plan's reviewer having approved a reference the
 * piece no longer keeps. What the run detaches is recorded and re-attached
 * by hand or not at all, and it is recorded from the write rather than from
 * the plan: the row's `expect.origin` is the survey's reading, while the
 * origin a write detaches is the one the piece holds when the write commits,
 * and only the pattern reference stands between the two as a precondition.
 * Nothing here
 * re-attaches: the runtime's `follow` resolves the origin NOW and adopts
 * whatever source it currently ships, which is not the reference a rollback
 * promises to land, and the restore a rollback runs detaches in its own
 * right by design (`docs/specs/piece-source-lifecycle.md`).
 *
 * The row's own precondition rides into the write rather than stopping at
 * the recheck that proved it. A piece is read once to classify it and again
 * by the write itself, and a writer landing between those two reads is
 * invisible to the first; the reference the recheck proved is therefore
 * handed to `setPattern`, which refuses the write rather than adopting
 * whatever it finds. The rollback's write step carries the same pin, so
 * "checks preconditions the same way" holds through the write and not only
 * up to it.
 */

import type { RuntimeProgram } from "@commonfabric/runner";

import {
  type ApplyOptions,
  applyPlan,
  type ApplyReport,
  type ApplySessions,
  type PlanOperation,
} from "./bulk-apply.ts";
import {
  programEntryIdentity,
  resolveLocalSourceProgram,
} from "./bulk-local.deno.ts";
import type { RetargetOp } from "./bulk-plan.ts";
import { PieceSourceChangedError } from "./piece-controller.ts";
import type { PiecesController } from "./pieces-controller.ts";

export type {
  ApplyReport,
  ApplyRow,
  ApplySessions,
  ApplyVerdict,
} from "./bulk-apply.ts";

/** The retarget's own knobs: the engine's, minus the operation it supplies. */
export type RetargetOptions = Omit<ApplyOptions<RetargetOp>, "operation">;

/**
 * Resolve a row's source from disk and set it on the piece. The identity
 * the source produces NOW decides whether the row may apply: a source
 * edited since the plan was reviewed no longer lands the row's recorded
 * reference, and applying it would land something the plan's reviewer never
 * saw.
 */
const RETARGET: PlanOperation<RetargetOp> = {
  kind: "retarget",
  noun: "retarget",
  async write(pieces: PiecesController, row) {
    const program: RuntimeProgram = await resolveLocalSourceProgram(
      pieces.runtime,
      row.op.source,
    );
    const identity = await programEntryIdentity(program);
    if (identity !== row.op.patternIdentity) {
      return {
        refused: `The source resolves to ${identity}, not the ` +
          `${row.op.patternIdentity} this row recorded.`,
      };
    }
    // No separate export check: the codec refuses a row whose symbol
    // disagrees with its source's requested export, and the resolver
    // echoes that request — so a decoded row's `op.symbol` is the export
    // this program runs, by construction. A source that lost the export
    // outright fails resolution above, named.
    const controller = await pieces.get(row.piece, false);
    let written;
    try {
      // The override comes from the row and nowhere else, so the plan shows
      // exactly which rows ran with the gate open. The reference the
      // engine's recheck just proved rides alongside it as the write's own
      // precondition: without it the write would adopt whatever it found
      // and commit over a change this plan never saw, and with it the
      // write is conditional on the standing the recheck proved, from the
      // read through to the transaction that commits it. It is a
      // precondition and not a confirmation — it opens no gate the row's
      // own override does not.
      written = await controller.setPattern(program, {
        ...(row.op.allowIncompatible === true
          ? { dangerouslyAllowIncompatibleSchema: true }
          : {}),
        expectedPattern: {
          identity: row.expect.patternIdentity,
          symbol: row.expect.symbol,
        },
      });
    } catch (error) {
      // A piece something else moved is a row this run must not apply, not
      // a write that broke — refused by name, exactly as the rollback's
      // write step refuses one.
      if (error instanceof PieceSourceChangedError) {
        return { refused: error.message };
      }
      throw error;
    }
    // What this write detached, from the write itself. The row's recorded
    // origin is the survey's reading and may be older than the piece: only
    // the pattern reference is a precondition here, so a piece whose origin
    // alone moved since the survey is written, and detached off the origin
    // it holds now. Reporting the recorded one would send an operator
    // re-attaching by hand to an origin this run never touched.
    return written.detachedOrigin === null
      ? undefined
      : { detachedOrigin: written.detachedOrigin };
  },
};

/**
 * Apply a plan's retarget rows, or — without `apply` — report where every
 * piece stands. The engine owns everything but the write: see
 * {@link applyPlan}. A restore or repair row is refused outright, this run
 * applying retargets alone.
 */
export function retargetPieces(
  sessions: ApplySessions,
  options: RetargetOptions,
): Promise<ApplyReport> {
  return applyPlan(sessions, { ...options, operation: RETARGET });
}
