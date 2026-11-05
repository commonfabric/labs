import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFToolbar - Horizontal toolbar for grouping controls
 *
 * @element cf-toolbar
 *
 * @attr {boolean} dense - Reduced padding and height
 * @attr {boolean} elevated - Adds subtle border/shadow separation
 * @attr {boolean} sticky - Sticks to the top of its scroll container
 *
 * @slot start - Left-aligned content
 * @slot center - Center content
 * @slot end - Right-aligned content
 */
export class CFToolbar extends BaseElement {
  static override properties = {
    dense: { type: Boolean, reflect: true },
    elevated: { type: Boolean, reflect: true },
    sticky: { type: Boolean, reflect: true },
  } as const;

  declare dense: boolean;
  declare elevated: boolean;
  declare sticky: boolean;

  constructor() {
    super();
    this.dense = false;
    this.elevated = false;
    this.sticky = false;
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --cf-toolbar-spacing-normal: var(--cf-theme-spacing-normal, 0.5rem);
        --cf-toolbar-spacing-loose: var(--cf-theme-spacing-loose, 1rem);
        --cf-toolbar-color-surface: var(--cf-theme-color-surface, #ffffff);
        --cf-toolbar-color-text: var(--cf-theme-color-text, #0f172a);
        --cf-toolbar-color-border: var(
          --cf-theme-color-border,
          var(--cf-colors-gray-200, #eceef1)
        );

        display: block;
        box-sizing: border-box;
      }

      .toolbar {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: var(--cf-toolbar-spacing-normal, 0.5rem);
        padding: var(--cf-toolbar-spacing-normal, 0.5rem)
          var(--cf-toolbar-spacing-loose, 1rem);
        background: var(--cf-toolbar-color-surface, #ffffff);
        color: var(--cf-toolbar-color-text, #0f172a);
        border-bottom: 1px solid
          var(--cf-toolbar-color-border, var(--cf-colors-gray-200, #eceef1));
      }

      :host([dense]) .toolbar {
        padding: calc(var(--cf-toolbar-spacing-normal, 0.5rem) * 0.5)
          var(--cf-toolbar-spacing-loose, 1rem);
      }

      :host([elevated]) .toolbar {
        box-shadow: 0 1px 0 0
          var(--cf-toolbar-color-border, var(--cf-colors-gray-200, #eceef1));
      }

      :host([sticky]) {
        position: sticky;
        top: 0;
        z-index: 10;
        background: inherit;
      }

      .start,
      .center,
      .end {
        display: flex;
        align-items: center;
        gap: var(--cf-toolbar-spacing-normal, 0.5rem);
        min-width: 0;
      }

      .start {
        justify-content: flex-start;
      }

      .center {
        justify-content: center;
      }

      .end {
        justify-content: flex-end;
      }
    `,
  ];

  override render() {
    return html`
      <div class="toolbar" part="toolbar">
        <div class="start" part="start">
          <slot name="start"></slot>
        </div>
        <div class="center" part="center">
          <slot name="center"></slot>
        </div>
        <div class="end" part="end">
          <slot name="end"></slot>
        </div>
      </div>
    `;
  }
}
