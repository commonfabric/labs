import { css, html, unsafeCSS } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { oneOf } from "../../core/property-guards.ts";
import type { ColorIntent, ComponentSize } from "../theme-context.ts";
import { pillGeometryCSS } from "../../styles/variables.ts";

/**
 * CFBadge - Status indicator or label with multiple visual variants
 *
 * @element cf-badge
 *
 * @attr {string} variant - Visual style variant: "solid" | "outline"
 * @attr {string} color - Color intent: "neutral" | "primary" | "accent" | "danger"
 * @attr {string} size - Size variant: "xs" | "sm" | "md" | "lg" | "xl" (default: "sm")
 * @attr {boolean} removable - Shows an X button to remove the badge
 *
 * @slot - Default slot for badge text
 *
 * @fires cf-remove - Fired when X button is clicked (if removable)
 *
 * @example
 * <cf-badge variant="solid" color="neutral" removable>Status</cf-badge>
 */

export type BadgeVariant = "solid" | "outline";

const badgeVariants = ["solid", "outline"] as const;
const badgeColors = ["neutral", "primary", "accent", "danger"] as const;
const badgeSizes = ["xs", "sm", "md", "lg", "xl"] as const;

export class CFBadge extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        ${unsafeCSS(pillGeometryCSS)};
        --cf-badge-border-radius: var(
          --cf-pill-border-radius,
          var(--cf-border-radius-full, 9999px)
        );
        --cf-badge-min-height: var(
          --cf-pill-sm-min-height,
          var(--cf-size-sm-height)
        );
        --cf-badge-padding-h: var(
          --cf-pill-sm-padding-h,
          var(--cf-size-sm-padding-h)
        );
        --cf-badge-padding-v: var(
          --cf-pill-sm-padding-v,
          var(--cf-size-sm-padding-v)
        );
        --cf-badge-gap: var(--cf-pill-sm-gap, var(--cf-size-sm-spacing));
        --cf-badge-font-size: var(
          --cf-pill-sm-font-size,
          var(--cf-size-sm-font-size)
        );
        --cf-badge-line-height: var(
          --cf-pill-sm-line-height,
          var(--cf-size-sm-line-height)
        );
        --cf-badge-color-primary: var(
          --cf-theme-color-primary,
          hsl(212, 100%, 47%)
        );
        --cf-badge-color-primary-foreground: var(
          --cf-theme-color-primary-foreground,
          hsl(0, 0%, 100%)
        );
        --cf-badge-color-secondary: var(
          --cf-theme-color-secondary,
          hsl(0, 0%, 96%)
        );
        --cf-badge-color-secondary-foreground: var(
          --cf-theme-color-secondary-foreground,
          hsl(0, 0%, 9%)
        );
        --cf-badge-color-destructive: var(
          --cf-theme-color-error,
          hsl(0, 100%, 50%)
        );
        --cf-badge-color-destructive-foreground: var(
          --cf-theme-color-error-foreground,
          hsl(0, 0%, 100%)
        );
        --cf-badge-color-border: var(--cf-theme-color-border, hsl(0, 0%, 89%));
        --cf-badge-color-text: var(--cf-theme-color-text, hsl(0, 0%, 9%));
        --cf-badge-color-ring: var(--cf-theme-color-primary, hsl(212, 100%, 47%));

        display: inline-block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        min-height: var(--cf-badge-min-height);
        gap: var(--cf-badge-gap);
        padding: var(--cf-badge-padding-v) var(--cf-badge-padding-h);
        font-size: var(--cf-badge-font-size);
        font-weight: var(--cf-font-weight-semibold, 600);
        line-height: var(--cf-badge-line-height);
        border-radius: var(--cf-badge-border-radius);
        border: 1px solid transparent;
        transition: all var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, cubic-bezier(0.4, 0, 0.2, 1));
      }

      :host([size="xs"]) .badge {
        min-height: var(--cf-pill-xs-min-height, var(--cf-size-xs-height));
        padding: var(--cf-pill-xs-padding-v, var(--cf-size-xs-padding-v))
          var(--cf-pill-xs-padding-h, var(--cf-size-xs-padding-h));
        font-size: var(--cf-pill-xs-font-size, var(--cf-size-xs-font-size));
        line-height: var(--cf-pill-xs-line-height, var(--cf-size-xs-line-height));
        gap: var(--cf-pill-xs-gap, var(--cf-size-xs-spacing));
      }

      /* sm is default — no override needed */

      :host([size="md"]) .badge {
        min-height: var(--cf-pill-md-min-height, var(--cf-size-md-height));
        padding: var(--cf-pill-md-padding-v, var(--cf-size-md-padding-v))
          var(--cf-pill-md-padding-h, var(--cf-size-md-padding-h));
        font-size: var(--cf-pill-md-font-size, var(--cf-size-md-font-size));
        line-height: var(--cf-pill-md-line-height, var(--cf-size-md-line-height));
        gap: var(--cf-pill-md-gap, var(--cf-size-md-spacing));
      }

      :host([size="lg"]) .badge {
        min-height: var(--cf-pill-lg-min-height, var(--cf-size-lg-height));
        padding: var(--cf-pill-lg-padding-v, var(--cf-size-lg-padding-v))
          var(--cf-pill-lg-padding-h, var(--cf-size-lg-padding-h));
        font-size: var(--cf-pill-lg-font-size, var(--cf-size-lg-font-size));
        line-height: var(--cf-pill-lg-line-height, var(--cf-size-lg-line-height));
        gap: var(--cf-pill-lg-gap, var(--cf-size-lg-spacing));
      }

      :host([size="xl"]) .badge {
        min-height: var(--cf-pill-xl-min-height, var(--cf-size-xl-height));
        padding: var(--cf-pill-xl-padding-v, var(--cf-size-xl-padding-v))
          var(--cf-pill-xl-padding-h, var(--cf-size-xl-padding-h));
        font-size: var(--cf-pill-xl-font-size, var(--cf-size-xl-font-size));
        line-height: var(--cf-pill-xl-line-height, var(--cf-size-xl-line-height));
        gap: var(--cf-pill-xl-gap, var(--cf-size-xl-spacing));
      }

      /* Variant: solid */
      .badge.solid {
        border-color: transparent;
      }

      .badge.solid.neutral {
        background-color: var(--cf-badge-color-secondary, hsl(0, 0%, 96%));
        color: var(--cf-badge-color-secondary-foreground, hsl(0, 0%, 9%));
      }

      .badge.solid.primary {
        background-color: var(--cf-badge-color-primary, hsl(212, 100%, 47%));
        color: var(--cf-badge-color-primary-foreground, hsl(0, 0%, 100%));
      }

      .badge.solid.accent {
        background-color: var(--cf-theme-color-accent, #8952fd);
        color: var(--cf-theme-color-accent-foreground, hsl(0, 0%, 100%));
      }

      .badge.solid.danger {
        background-color: var(--cf-badge-color-destructive, hsl(0, 100%, 50%));
        color: var(--cf-badge-color-destructive-foreground, hsl(0, 0%, 100%));
      }

      /* Variant: outline */
      .badge.outline {
        background-color: transparent;
        border-color: var(--cf-badge-color-border, hsl(0, 0%, 89%));
        color: var(--cf-badge-color-text, hsl(0, 0%, 9%));
      }

      .badge.outline.primary {
        border-color: var(--cf-badge-color-primary, hsl(212, 100%, 47%));
        color: var(--cf-badge-color-primary, hsl(212, 100%, 47%));
      }

      .badge.outline.accent {
        border-color: var(--cf-theme-color-accent, #8952fd);
        color: var(--cf-theme-color-accent, #8952fd);
      }

      .badge.outline.danger {
        border-color: var(--cf-badge-color-destructive, hsl(0, 100%, 50%));
        color: var(--cf-badge-color-destructive, hsl(0, 100%, 50%));
      }

      /* Close button */
      .close-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--cf-size-sm-icon-sm);
        height: var(--cf-size-sm-icon-sm);
        padding: 0;
        margin: 0;
        margin-left: 0.125rem;
        margin-right: -0.25rem;
        background: none;
        border: none;
        cursor: pointer;
        opacity: 0.7;
        transition: opacity var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease);
        color: currentColor;
      }

      .close-button:hover {
        opacity: 1;
      }

      .close-button:focus-visible {
        outline: 2px solid var(--cf-badge-color-ring, hsl(212, 100%, 47%));
        outline-offset: 2px;
        border-radius: 2px;
      }

      .close-button svg {
        width: 100%;
        height: 100%;
      }

      :host([size="xs"]) .close-button {
        width: var(--cf-size-xs-icon-sm);
        height: var(--cf-size-xs-icon-sm);
      }
      :host([size="md"]) .close-button {
        width: var(--cf-size-md-icon-sm);
        height: var(--cf-size-md-icon-sm);
      }
      :host([size="lg"]) .close-button {
        width: var(--cf-size-lg-icon-sm);
        height: var(--cf-size-lg-icon-sm);
      }
      :host([size="xl"]) .close-button {
        width: var(--cf-size-xl-icon-sm);
        height: var(--cf-size-xl-icon-sm);
      }
    `,
  ];

  static override properties = {
    color: { type: String },
    variant: { type: String },
    removable: { type: Boolean },
    size: { type: String, reflect: true },
  };

  declare color: ColorIntent;
  declare variant: BadgeVariant;
  declare removable: boolean;
  declare size: ComponentSize;

  constructor() {
    super();
    this.color = "neutral";
    this.variant = "solid";
    this.removable = false;
    this.size = "sm";
  }

  protected override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ): void {
    super.willUpdate(changedProperties);
    if (
      changedProperties.has("color") ||
      changedProperties.has("variant") ||
      changedProperties.has("size")
    ) {
      this.color = oneOf(this.color, badgeColors, "neutral");
      this.variant = oneOf(this.variant, badgeVariants, "solid");
      this.size = oneOf(this.size, badgeSizes, "sm");
    }
  }

  override render() {
    return html`
      <div
        class="badge ${this.variant} ${this.color}"
        part="badge"
      >
        <slot></slot>
        ${this.removable
          ? html`
            <button
              type="button"
              class="close-button"
              part="close-button"
              aria-label="Remove"
              @click="${this._handleRemove}"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          `
          : null}
      </div>
    `;
  }

  private _handleRemove(event: Event) {
    event.preventDefault();
    event.stopPropagation();

    // Emit cf-remove event
    this.emit("cf-remove", {
      color: this.color,
      variant: this.variant,
    });
  }
}
