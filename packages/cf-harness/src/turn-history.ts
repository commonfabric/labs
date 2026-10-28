/** History and handles explicitly carried between separate root runs. */
import type { HarnessHandleTable } from "./contracts/handle-table.ts";

/**
 * The model-visible note appended after a canceled turn's saved history, so the
 * following turn reads the earlier request as interrupted rather than answered.
 */
export const HARNESS_CHAT_INTERRUPTED_TURN_NOTICE =
  "Host turn notice: the person stopped the previous turn before it finished. Its request above was interrupted, not answered; the work shown after it is what completed before the stop.";

/**
 * The part of a session's handle table a following turn's run starts from:
 * all of it but the skill-context entries. A skill-context handle stands for
 * a skill whose acquired scripts were written under the acquiring run's
 * artifact directory and recorded on that run alone, so a later run holding
 * the token would delegate the skill's instructions without its scripts. Left
 * out, the token names nothing in the later turn, and a delegation on it is
 * refused as an unheld handle, which is how the model learns to acquire the
 * skill again.
 *
 * SHORTCUT: the handle is reported unavailable rather than carried. To
 * harden, carry the run's acquisition records with the checkpoint once the
 * lifetime of the scripts' run directory is settled, and keep these entries.
 */
export const tableForNextTurn = (
  table: HarnessHandleTable,
): HarnessHandleTable => ({
  ...table,
  entries: table.entries.filter((entry) =>
    entry.capability !== "skill-context"
  ),
});
