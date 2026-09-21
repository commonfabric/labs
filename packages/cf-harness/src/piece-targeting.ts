import type { HarnessInputCell } from "./contracts/input-cells.ts";
import { inputCellsContextMessage } from "./input-cells.ts";

/**
 * Shared model guidance for choosing an existing piece before working on it.
 * The lookup bound is an instruction, not a runtime tool quota.
 */
export const PIECE_TARGETING_GUIDANCE = [
  "For a request about an existing piece, first identify the target from an explicit attachment or user-supplied reference, or a piece unambiguously selected in this conversation. A follow-up about the piece just created can use that established target. A registry grant, connector, indexed pattern, or unrelated historical receipt does not select a piece.",
  "If the target is unresolved and the user supplied no piece name, make zero registry reads and ask the user to attach or name the piece. Do not delegate discovery of an unnamed target. For example, 'add a total to this bills pane' with no attachment or established conversation target needs a question, not discovery.",
  "If the user supplied a piece slug or pattern:<space>/<slug>, call resolve_piece before any author delegation or registry read. This applies to both a fresh request ('change my recent-emails list') and an answer to your question in the same conversation ('the recent-emails one'): resolve recent-emails and pass its returned resultRef to the author. A slug is the piece's address, not its display name. Do not author a name matcher. If resolution fails or the tool is unavailable, ask for an exact piece address or attachment; do not crawl the registry or try another delegation to repair the lookup.",
  "If the user supplied only a display name rather than a slug, make at most one registry read to resolve that name across the parent and its children together. A delegated lookup consumes the same allowance. Proceed only if released evidence identifies exactly one matching piece. Plan that one read to return the count and the reference or requested data together. A match count alone proves uniqueness, not the requested values; never infer an omitted value from the piece name. If the needed data is missing, or the reference is an empty object or otherwise unusable, ask for an attachment instead of rereading the registry to repair the projection. Zero matches, multiple matches, a refused read, or an unavailable result means ask the user to attach or identify the piece. Do not enumerate references and inspect candidates, retry the lookup through another pattern or delegation, or create a replacement to guess what they meant.",
  "This bound applies to selecting a missing target, not to an explicit request to list or analyze the space. Research and authoring children return an unresolved target to the parent rather than planning a registry crawl; the parent asks with finish_task outcome question.",
].join("\n");

/** Target selection context for both configured sessions and unattached turns. */
export const pieceTargetingContextMessages = (
  inputCells: readonly HarnessInputCell[],
): string[] => [inputCellsContextMessage(inputCells), PIECE_TARGETING_GUIDANCE];
