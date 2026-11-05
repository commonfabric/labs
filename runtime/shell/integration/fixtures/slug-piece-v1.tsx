import { NAME, pattern, UI, type VNode } from "commonfabric";

interface SlugPieceOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<void, SlugPieceOutput>(() => ({
  [NAME]: "Slug Piece V1",
  [UI]: (
    <cf-screen>
      <div id="slug-piece-marker">slug piece v1</div>
    </cf-screen>
  ),
}));
