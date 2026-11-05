import { NAME, pattern, UI, type VNode } from "commonfabric";

interface SlugPieceOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<void, SlugPieceOutput>(() => ({
  [NAME]: "Slug Piece V2",
  [UI]: (
    <cf-screen>
      <div id="slug-piece-marker">slug piece v2</div>
    </cf-screen>
  ),
}));
