import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

// TODO(v2-token-migration): Migrate this component to component-level tokens,
// matching the prior phase-1 token migration pattern.

/**
 * CFKbd - Inline keyboard hint element
 *
 * @element cf-kbd
 *
 * @slot - Shortcut text (e.g. ⌘N)
 */
export class CFKbd extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
      }

      .kbd {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 0.375rem;
        height: 1.25rem;
        border-radius: 0.25rem;
        background: var(
          --cf-theme-color-surface,
          #f3f4f6
        );
        border: 1px solid var(--cf-theme-color-border, #d1d5db);
        color: var(--cf-theme-color-text, #1f2937);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.75rem;
        line-height: 1;
        user-select: none;
        vertical-align: middle;
        margin-left: 0.375rem;
      }
    `,
  ];

  override render() {
    return html`
      <span class="kbd" part="kbd"><slot></slot></span>
    `;
  }
}
