import { html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFPiece - Container element that provides piece context to child components
 *
 * @element cf-piece
 *
 * @attr {string} piece-id - The ID of the piece
 * @attr {string} space-name - The name of the space
 *
 * @slot - Default slot for piece content
 *
 * @example
 * <cf-piece piece-id="abc123" space-name="my-space">
 *   <cf-button>Click Me</cf-button>
 * </cf-piece>
 */
export class CFPiece extends BaseElement {
  declare pieceId: string | null;
  declare spaceName: string | null;

  static override properties = {
    pieceId: { required: true, type: String, attribute: "piece-id" },
    spaceName: { required: true, type: String, attribute: "space-name" },
  };

  constructor() {
    super();
    this.pieceId = null;
    this.spaceName = null;
  }

  override render() {
    return html`
      <slot></slot>
    `;
  }
}
