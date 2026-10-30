import type { HarnessInputCell } from "./contracts/input-cells.ts";
import { inputCellsContextMessage } from "./input-cells.ts";

/** Technical guidance for working with existing pieces. */
export const PIECE_TARGETING_GUIDANCE =
  "resolve_piece resolves a piece slug or pattern:<space>/<slug> to a resultRef. A slug is the piece's address, not its display name. A registry grant or connector reference grants access within its scope; it is not itself an attached piece. Use a held piece reference when revising a piece. A match count alone does not establish requested values; use only released evidence.";

/**
 * What a task about the pieces it holds is told about them, in place of the
 * piece-targeting rules a pattern-authoring task needs.
 */
export const HELD_PIECES_GUIDANCE =
  "The input cells are the pieces of the loom the person is in, named by where each was: focused_piece, on_screen_…, in_loom_…. Use describe_handle for a held piece's shape and verbs, read_value for its data, and call_verb to act on it. Never search for or make a pattern that is already in hand.";

/** What a task not tagged as about its pieces is told about them. */
export const MAY_HOLD_PIECES_GUIDANCE =
  "Handles may be held; if the request turns out to be about one, describe it with describe_handle.";

/** Target selection context for both configured sessions and unattached turns. */
export const pieceTargetingContextMessages = (
  inputCells: readonly HarnessInputCell[],
): string[] => [inputCellsContextMessage(inputCells), PIECE_TARGETING_GUIDANCE];
