import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFHoverReveal - Content with actions that appear while the pointer rests on
 * it or focus is inside it, as a chat message shows its reaction button.
 *
 * The actions stay laid out and focusable while hidden, so revealing them
 * never moves the content and a keyboard can still reach them. Setting
 * `revealed` keeps them shown, for instance while a picker they opened is
 * still open. On a device that cannot hover, they are always shown.
 *
 * @element cf-hover-reveal
 *
 * @attr {boolean} revealed - Keeps the actions shown whatever the pointer does
 *
 * @slot - The content
 * @slot actions - The controls to reveal
 *
 * @csspart hover-reveal - The outer container
 * @csspart content - The content container
 * @csspart actions - The actions container
 *
 * @example
 * <cf-hover-reveal>
 *   <div>A message</div>
 *   <cf-button slot="actions" size="sm">React</cf-button>
 * </cf-hover-reveal>
 */
export class CFHoverReveal extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --cf-hover-reveal-gap: var(--cf-spacing-2, 0.5rem);

        display: block;
        box-sizing: border-box;
      }

      .hover-reveal {
        display: flex;
        align-items: flex-start;
        gap: var(--cf-hover-reveal-gap);
      }

      .content {
        flex: 1;
        min-width: 0;
      }

      .actions {
        display: flex;
        align-items: center;
        gap: var(--cf-hover-reveal-gap);
        opacity: 0;
      }

      :host(:hover) .actions,
      :host(:focus-within) .actions,
      :host([revealed]) .actions {
        opacity: 1;
      }

      @media (hover: none) {
        .actions {
          opacity: 1;
        }
      }
    `,
  ];

  static override properties = {
    revealed: { type: Boolean, reflect: true },
  };

  declare revealed: boolean;

  constructor() {
    super();
    this.revealed = false;
  }

  override render() {
    return html`
      <div class="hover-reveal" part="hover-reveal">
        <div class="content" part="content"><slot></slot></div>
        <div class="actions" part="actions"><slot name="actions"></slot></div>
      </div>
    `;
  }
}
