/**
 * Bulk rollback: the retarget's reversal, run from the retarget's own plan.
 * The rows come from {@link deriveRollbackPlan} — each row's precondition is
 * the reference the retarget produced, and its operation restores the
 * retained revision carrying the reference the row recorded — and they run
 * on the shared apply engine ([bulk-apply.ts](./bulk-apply.ts)), so a
 * rollback checks preconditions, stops, names its remainder, and resumes
 * exactly as the retarget does (docs/plans/piece-bulk-operations.md, stage
 * 4).
 *
 * What lives here is the one step that is the rollback's own: resolving the
 * reference a row recorded to the revision of the piece's own log that
 * carries it, and asking the runtime to restore that revision. Nothing is
 * resolved from disk, so unlike the retarget this module reads no
 * filesystem: a rollback runs from what the space retains, which is the
 * whole reason it is the reversal available during an incident.
 */

import {
  type ApplyOptions,
  applyPlan,
  type ApplyReport,
  type ApplySessions,
  type PlanOperation,
} from "./bulk-apply.ts";
import type { RestoreOp } from "./bulk-plan.ts";
import { PieceSourceChangedError } from "./piece-controller.ts";
import {
  readRestorableSource,
  selectRestoreRevision,
} from "./piece-restore.ts";
import type { PiecesController } from "./pieces-controller.ts";

/** The rollback's own knobs: the engine's, minus the operation it supplies. */
export type RollbackOptions = Omit<ApplyOptions<RestoreOp>, "operation">;

/**
 * Restore one row's piece to the revision its recorded reference names. The
 * engine has already proved the piece is on the row's `expect` pair, so the
 * only questions left belong to the piece's own log: does it hold a
 * revision on the reference this row recorded, and is that revision's source
 * still there to load.
 */
const ROLLBACK: PlanOperation<RestoreOp> = {
  kind: "restore",
  noun: "restore",
  async write(pieces: PiecesController, row) {
    const controller = await pieces.get(row.piece, false);
    const { revisions } = await readRestorableSource(pieces, controller);
    const selected = selectRestoreRevision(revisions, {
      patternIdentity: row.op.patternIdentity,
      symbol: row.op.symbol,
      ...(row.op.revisionId === undefined
        ? {}
        : { revisionId: row.op.revisionId }),
    });
    if ("problem" in selected) return { refused: selected.problem };
    let result;
    try {
      // The reference the engine's recheck just proved, handed to the write
      // as its own precondition. Without it the restore would adopt
      // whatever it found and commit over a change this plan never saw;
      // with it the write is conditional on the standing the recheck
      // proved, from the read through to the transaction that commits it.
      result = await controller.changeSource({
        kind: "restore",
        revisionId: selected.revision.revisionId,
      }, {
        expectedPattern: {
          identity: row.expect.patternIdentity,
          symbol: row.expect.symbol,
        },
      });
    } catch (error) {
      // A piece something else moved is a row this run must not apply, not
      // a write that broke — so it is refused by name rather than reported
      // as an operational failure.
      if (error instanceof PieceSourceChangedError) {
        return { refused: error.message };
      }
      throw error;
    }
    // A compatibility verdict is a row this run must not apply rather than
    // a failure of the run: the piece's documents have moved on since it
    // ran this source. No restore forces one back — neither this nor the
    // per-piece command carries an override — so the operator's recourse
    // is a retarget onto that source, whose plan does carry a per-row one.
    //
    // Not every such refusal arrives this way. An argument the restored
    // source cannot use at all is the runtime's hard refusal and throws,
    // which reaches the engine as an operational failure — state-checked
    // after the fact, so the row still names the piece and the reason and
    // still reports that nothing was written. Both stop the run; they
    // differ only in which verdict the row carries.
    if (result.status === "incompatible") return { refused: result.message };
    // The restore committed and its execution complained. The row landed, so
    // this is not a refusal — but an operator told nothing would read a
    // silent success, so the warning rides the row it belongs to.
    return result.executionWarning === undefined
      ? undefined
      : { warning: result.executionWarning };
  },
};

/**
 * Apply a rollback plan's restore rows, or — without `apply` — report where
 * every piece stands. The engine owns everything but the write: see
 * {@link applyPlan}. A retarget or repair row is refused outright, this run
 * applying restores alone.
 */
export function rollbackPieces(
  sessions: ApplySessions,
  options: RollbackOptions,
): Promise<ApplyReport> {
  return applyPlan(sessions, { ...options, operation: ROLLBACK });
}
