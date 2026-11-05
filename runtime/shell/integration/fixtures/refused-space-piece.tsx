import { NAME, pattern, UI, type VNode } from "commonfabric";

interface RefusedSpacePieceOutput {
  [NAME]: string;
  [UI]: VNode;
}

/**
 * A piece showing nothing but a marker, which a member of its space sees
 * while they are admitted and loses while they are refused.
 */
export default pattern<void, RefusedSpacePieceOutput>(() => ({
  [NAME]: "Refused Space Piece",
  [UI]: (
    <cf-screen>
      <div id="refused-space-marker">refused space piece</div>
    </cf-screen>
  ),
}));
