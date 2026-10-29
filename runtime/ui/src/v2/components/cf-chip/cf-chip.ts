import { css, html, unsafeCSS } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import type { ColorIntent, ComponentSize } from "../theme-context.ts";
import { pillGeometryCSS } from "../../styles/variables.ts";

/**
 * CFChip - Reusable pill/chip component
 *
 * @element cf-chip
 *
 * @attr {string} label - Chip label text to display
 * @attr {string} color - Color intent: "neutral" | "primary" | "accent" | "danger" (default: "neutral")
 * @attr {string} size - Size variant: "xs" | "sm" | "md" | "lg" | "xl" (default: "sm")
 * @attr {boolean} removable - Whether to show remove button (default: false)
 * @attr {boolean} interactive - Whether chip is clickable (default: false)
 *
 * @fires cf-remove - Fired when remove button is clicked
 * @fires cf-click - Fired when chip is clicked (if interactive)
 *
 * @slot icon - Optional icon before the label
 * @slot - Non-interactive main content (overrides label). When `interactive`,
 *   this slot is rendered inside the primary button and must not contain links,
 *   buttons, or other interactive descendants.
 *
 * @example
 * <cf-chip label="Tools" color="neutral"></cf-chip>
 * <cf-chip label="Alice" color="primary" removable></cf-chip>
 */
export class CFChip extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        ${unsafeCSS(pillGeometryCSS)};
        --cf-chip-border-radius: var(
          --cf-pill-border-radius,
          var(--cf-border-radius-full, 9999px)
        );
        --cf-chip-min-height: var(
          --cf-pill-sm-min-height,
          var(--cf-size-sm-height)
        );
        --cf-chip-padding-h: var(
          --cf-pill-sm-padding-h,
          var(--cf-size-sm-padding-h)
        );
        --cf-chip-padding-v: var(
          --cf-pill-sm-padding-v,
          var(--cf-size-sm-padding-v)
        );
        --cf-chip-gap: var(--cf-pill-sm-gap, var(--cf-size-sm-spacing));
        --cf-chip-font-size: var(
          --cf-pill-sm-font-size,
          var(--cf-size-sm-font-size)
        );
        --cf-chip-line-height: var(
          --cf-pill-sm-line-height,
          var(--cf-size-sm-line-height)
        );
        display: inline-block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        min-height: var(--cf-chip-min-height);
        gap: var(--cf-chip-gap);
        padding: var(--cf-chip-padding-v) var(--cf-chip-padding-h);
        background: var(
          --cf-chip-background,
          var(
            --cf-theme-color-surface,
            var(--cf-colors-gray-100, #f2f3f6)
          )
        );
        color: var(
          --cf-chip-color,
          var(
            --cf-theme-color-text,
            var(--cf-colors-gray-900, #16181d)
          )
        );
        border: 1px solid
          var(
          --cf-chip-border-color,
          var(
            --cf-theme-color-border,
            var(--cf-colors-gray-300, #d5d7dd)
          )
        );
        border-radius: var(
          --cf-chip-border-radius,
          var(--cf-border-radius-full, 9999px)
        );
        font-size: var(--cf-chip-font-size);
        line-height: var(--cf-chip-line-height);
        user-select: none;
        transition:
          background-color var(--cf-theme-animation-duration, 200ms) ease,
          border-color var(--cf-theme-animation-duration, 200ms) ease;
      }

      :host([size="xs"]) .chip {
        min-height: var(--cf-pill-xs-min-height, var(--cf-size-xs-height));
        padding: var(--cf-pill-xs-padding-v, var(--cf-size-xs-padding-v))
          var(--cf-pill-xs-padding-h, var(--cf-size-xs-padding-h));
        font-size: var(--cf-pill-xs-font-size, var(--cf-size-xs-font-size));
        line-height: var(--cf-pill-xs-line-height, var(--cf-size-xs-line-height));
        gap: var(--cf-pill-xs-gap, var(--cf-size-xs-spacing));
      }

      /* sm is default — no override needed */

      :host([size="md"]) .chip {
        min-height: var(--cf-pill-md-min-height, var(--cf-size-md-height));
        padding: var(--cf-pill-md-padding-v, var(--cf-size-md-padding-v))
          var(--cf-pill-md-padding-h, var(--cf-size-md-padding-h));
        font-size: var(--cf-pill-md-font-size, var(--cf-size-md-font-size));
        line-height: var(--cf-pill-md-line-height, var(--cf-size-md-line-height));
        gap: var(--cf-pill-md-gap, var(--cf-size-md-spacing));
      }

      :host([size="lg"]) .chip {
        min-height: var(--cf-pill-lg-min-height, var(--cf-size-lg-height));
        padding: var(--cf-pill-lg-padding-v, var(--cf-size-lg-padding-v))
          var(--cf-pill-lg-padding-h, var(--cf-size-lg-padding-h));
        font-size: var(--cf-pill-lg-font-size, var(--cf-size-lg-font-size));
        line-height: var(--cf-pill-lg-line-height, var(--cf-size-lg-line-height));
        gap: var(--cf-pill-lg-gap, var(--cf-size-lg-spacing));
      }

      :host([size="xl"]) .chip {
        min-height: var(--cf-pill-xl-min-height, var(--cf-size-xl-height));
        padding: var(--cf-pill-xl-padding-v, var(--cf-size-xl-padding-v))
          var(--cf-pill-xl-padding-h, var(--cf-size-xl-padding-h));
        font-size: var(--cf-pill-xl-font-size, var(--cf-size-xl-font-size));
        line-height: var(--cf-pill-xl-line-height, var(--cf-size-xl-line-height));
        gap: var(--cf-pill-xl-gap, var(--cf-size-xl-spacing));
      }

      .chip.interactive {
        cursor: pointer;
      }

      .chip.interactive:hover {
        background: var(
          --cf-theme-color-surface-hover,
          var(--cf-colors-gray-200, #eceef1)
        );
      }

      .chip:has(.chip-action:focus-visible) {
        outline: 2px solid
          var(
          --cf-theme-color-focus-ring,
          var(--cf-theme-color-primary, var(--cf-colors-primary-500, #4979fa))
        );
        outline-offset: 2px;
      }

      .chip-action,
      .chip-content {
        display: inline-flex;
        align-items: center;
        gap: var(--cf-chip-gap);
        min-width: 0;
        color: inherit;
        font: inherit;
        line-height: inherit;
      }

      .chip-action {
        appearance: none;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        cursor: pointer;
      }

      .chip-action:focus {
        outline: none;
      }

      /* Color: primary (blue - for mentions) */
      .chip.primary {
        background: var(
          --cf-chip-primary-background,
          color-mix(
            in srgb,
            var(
              --cf-theme-color-primary,
              var(--cf-colors-primary-500, #4979fa)
            ) 12%,
            var(--cf-theme-color-surface, var(--cf-colors-gray-50, #ffffff))
          )
        );
        border-color: var(
          --cf-chip-primary-border-color,
          color-mix(
            in srgb,
            var(
              --cf-theme-color-primary,
              var(--cf-colors-primary-500, #4979fa)
            ) 28%,
            var(--cf-theme-color-surface, var(--cf-colors-gray-50, #ffffff))
          )
        );
        color: var(
          --cf-chip-primary-color,
          var(--cf-theme-color-primary, var(--cf-colors-primary-700, #376bf9))
        );
      }

      /* Color: accent (purple - for clipboard) */
      .chip.accent {
        background: var(
          --cf-chip-accent-background,
          color-mix(
            in srgb,
            var(--cf-theme-color-accent, var(--cf-colors-purple, #8952fd)) 12%,
            var(--cf-theme-color-surface, var(--cf-colors-gray-50, #ffffff))
          )
        );
        border-color: var(
          --cf-chip-accent-border-color,
          color-mix(
            in srgb,
            var(--cf-theme-color-accent, var(--cf-colors-purple, #8952fd)) 28%,
            var(--cf-theme-color-surface, var(--cf-colors-gray-50, #ffffff))
          )
        );
        color: var(
          --cf-chip-accent-color,
          var(--cf-theme-color-accent, var(--cf-colors-purple, #8952fd))
        );
      }

      /* Color: danger (red) */
      .chip.danger {
        background: var(
          --cf-chip-danger-background,
          color-mix(
            in srgb,
            var(--cf-theme-color-error, #dc2626) 12%,
            var(--cf-theme-color-surface, var(--cf-colors-gray-50, #ffffff))
          )
        );
        border-color: var(
          --cf-chip-danger-border-color,
          color-mix(
            in srgb,
            var(--cf-theme-color-error, #dc2626) 28%,
            var(--cf-theme-color-surface, var(--cf-colors-gray-50, #ffffff))
          )
        );
        color: var(
          --cf-chip-danger-color,
          var(--cf-theme-color-error, #dc2626)
        );
      }

      .chip-icon {
        display: flex;
        align-items: center;
        font-size: var(--cf-font-body-compact-size, 0.8125rem);
        line-height: 1;
      }

      :host:not(:has([slot="icon"])) .chip-icon {
        display: none;
      }

      .chip-label {
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .chip-remove {
        appearance: none;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 0.75rem;
        height: 0.75rem;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        border-radius: 50%;
        cursor: pointer;
        transition: background-color 0.1s;
        color: currentColor;
        font: inherit;
        line-height: 1;
        opacity: 0.6;
      }

      .chip-remove:hover {
        background: rgba(0, 0, 0, 0.1);
        opacity: 1;
      }

      .chip-remove:focus-visible {
        outline: 2px solid
          var(
          --cf-theme-color-focus-ring,
          var(--cf-theme-color-primary, var(--cf-colors-primary-500, #4979fa))
        );
        outline-offset: 2px;
        opacity: 1;
      }

      .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ];

  @property({ type: String })
  accessor label = "";

  @property({ type: String, reflect: true })
  accessor color: ColorIntent = "neutral";

  @property({ type: Boolean })
  accessor removable = false;

  @property({ type: Boolean })
  accessor interactive = false;

  @property({ type: String, reflect: true })
  accessor size: ComponentSize = "sm";

  private _handleRemove(e: Event): void {
    e.stopPropagation();
    this.emit("cf-remove");
  }

  private _handleClick(): void {
    if (this.interactive) {
      this.emit("cf-click");
    }
  }

  override render() {
    const classes = [
      "chip",
      this.color,
      this.interactive && "interactive",
    ].filter(Boolean).join(" ");

    return html`
      <div class="${classes}" @click="${this._handleClick}">
        ${this.interactive
          ? html`
            <button
              type="button"
              class="chip-action"
              part="action"
              aria-labelledby="chip-label"
            >
              <slot name="icon" class="chip-icon"></slot>
              <span id="chip-label" class="chip-label">
                <slot>${this.label}</slot>
              </span>
            </button>
          `
          : html`
            <span class="chip-content">
              <slot name="icon" class="chip-icon"></slot>
              <span id="chip-label" class="chip-label">
                <slot>${this.label}</slot>
              </span>
            </span>
          `} ${this.removable
          ? html`
            <button
              type="button"
              class="chip-remove"
              part="remove"
              aria-labelledby="chip-remove-prefix chip-label"
              @click="${this._handleRemove}"
            >
              <span id="chip-remove-prefix" class="visually-hidden">
                Remove
              </span>
              <span aria-hidden="true">×</span>
            </button>
          `
          : ""}
      </div>
    `;
  }
}
