import { type Default, NAME, pattern, UI, type VNode } from "commonfabric";

/** The piece a linked view shows, as the view reads it. */
interface ShownPiece {
  /** The shown piece's name. */
  [NAME]?: string;

  /** The shown piece's view. */
  [UI]: VNode;
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
 * links to, which a test places in a space the viewer may not be granted. The
 * piece is a cell child of the view, which the renderer replaces with the
 * access placeholder while the piece's space refuses the viewer. As the cell of
 * a `cf-render` it would show nothing then: a `$` binding is withheld while a
 * space its read reaches is out of reach
 * (`docs/specs/cfc-render-boundary-composition.md`).
 */
export default pattern<LinkedViewInput, LinkedViewOutput>(({ shown }) => ({
  [NAME]: "Linked View Piece",
  [UI]: (
    <cf-screen>
      <div id="linked-view-marker">linked view</div>
      <div>{shown}</div>
    </cf-screen>
  ),
}));
