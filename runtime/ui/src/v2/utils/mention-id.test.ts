import { assertEquals, assertThrows } from "@std/assert";
import { CFCodeEditor } from "../components/cf-code-editor/cf-code-editor.ts";
import { mentionIdFromCellId } from "./mention-id.ts";

Deno.test("mentionIdFromCellId strips of: and passes bare ids through", () => {
  assertEquals(mentionIdFromCellId("of:fid1:abc"), "fid1:abc");
  assertEquals(mentionIdFromCellId("fid1:abc"), "fid1:abc");
});

Deno.test("mentionIdFromCellId rejects computed: ids", () => {
  // The scheme is part of the identity; stripping it would silently embed
  // the of: sibling into persisted note content.
  assertThrows(
    () => mentionIdFromCellId("computed:fid1:abc"),
    Error,
    "computed:",
  );
});

Deno.test("cf-code-editor derives mention pieceIds in the bare embed form", () => {
  const proto = CFCodeEditor.prototype as unknown as {
    _getPieceId(index: number): string;
  };
  // Pre-resolved id (the stable piece cell id) is stripped to the bare form.
  const withResolved = {
    _resolvedPieceIds: new Map([[0, "of:fid1:abc"]]),
    _isIndexRow: () => false,
    mentionable: undefined,
  };
  assertEquals(proto._getPieceId.call(withResolved, 0), "fid1:abc");
  // Fallback: no resolved id, not an index row, and no mentionable
  // yields the empty id untouched (nothing to strip).
  const empty = {
    _resolvedPieceIds: new Map(),
    _isIndexRow: () => false,
    mentionable: undefined,
  };
  assertEquals(proto._getPieceId.call(empty, 0), "");
});
