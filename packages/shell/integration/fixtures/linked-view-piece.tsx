import { type Default, NAME, pattern, UI, type VNode } from "commonfabric";

/** The piece a linked view shows, as the view reads it. */
interface ShownPiece {
  /** The shown piece's name. */
  [NAME]?: string;
}

interface LinkedViewInput {
  /** The piece to show, which may live in a space of its own. */
  shown: Default<ShownPiece | null, null>;
}

interface LinkedViewOutput {
  [NAME]: string;
  [UI]: VNode;
}

/**
 * A view showing a marker of its own and, beneath it, the piece its input
 * links to, which a test places in a space the viewer may not be granted.
 */
export default pattern<LinkedViewInput, LinkedViewOutput>(({ shown }) => ({
  [NAME]: "Linked View Piece",
  [UI]: (
    <cf-screen>
      <div id="linked-view-marker">linked view</div>
      <cf-render $cell={shown} />
    </cf-screen>
  ),
}));
