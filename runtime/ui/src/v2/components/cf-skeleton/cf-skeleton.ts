/**
 * @fileoverview UI Skeleton Component - Loading placeholder with animations
 *
 * @module cf-skeleton
 * @description
 * A loading placeholder component that displays an animated skeleton screen
 * while content is being loaded. Helps improve perceived performance by
 * showing users where content will appear. Supports different variants
 * and custom sizing.
 *
 * @example
 * ```html
 * <!-- Basic skeleton -->
 * <cf-skeleton style="width: 200px; height: 20px"></cf-skeleton>
 *
 * <!-- Text skeleton -->
 * <cf-skeleton variant="text" width="100%" height="1em"></cf-skeleton>
 *
 * <!-- Circular skeleton (avatar placeholder) -->
 * <cf-skeleton variant="circular" width="40px" height="40px"></cf-skeleton>
 *
 * <!-- Static skeleton (no animation) -->
 * <cf-skeleton animated="false"></cf-skeleton>
 * ```
 */

import { css, html } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { oneOf } from "../../core/property-guards.ts";

export type SkeletonVariant = "default" | "text" | "circular";

const skeletonVariants = ["default", "text", "circular"] as const;

/**
 * CFSkeleton displays an animated loading placeholder.
 *
 * @tag cf-skeleton
 * @extends BaseElement
 *
 * @property {SkeletonVariant} variant - Visual style variant ("default" | "text" | "circular")
 * @property {boolean} animated - Whether to show loading animation
 * @property {string|null} width - Custom width (CSS value)
 * @property {string|null} height - Custom height (CSS value)
 *
 * @attribute {string} variant - Sets the visual style variant
 * @attribute {boolean} animated - Enables/disables animation (default: true)
 * @attribute {string} width - Sets custom width
 * @attribute {string} height - Sets custom height
 *
 * @csspart skeleton - The skeleton element
 *
 * @note Style with CSS width/height or use width/height attributes
 * @note Has role="status" and aria-label="Loading" for accessibility
 */
export class CFSkeleton extends BaseElement {
  static override styles = css`
    :host {
      display: inline-block;
      box-sizing: border-box;
    }

    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }

    .skeleton {
      display: block;
      background-color: var(--skeleton-bg, hsl(0, 0%, 90%));
      position: relative;
      overflow: hidden;
    }

    /* Variants */
    .skeleton.default {
      border-radius: var(--radius, 0.375rem);
    }

    .skeleton.text {
      border-radius: var(--radius, 0.375rem);
      height: 1em;
      transform: scaleY(0.8);
      transform-origin: center;
    }

    .skeleton.circular {
      border-radius: 50%;
    }

    /* Animation */
    .skeleton.animate::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(
        90deg,
        transparent,
        var(--skeleton-shimmer, rgba(255, 255, 255, 0.5)),
        transparent
      );
      animation: shimmer 1.5s infinite;
    }

    @keyframes shimmer {
      from {
        transform: translateX(-100%);
      }
      to {
        transform: translateX(100%);
      }
    }

    /* Screen reader only text */
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border-width: 0;
    }
  `;

  static override properties = {
    variant: { type: String },
    animated: { type: Boolean },
    width: { type: String },
    height: { type: String },
  };

  declare variant: SkeletonVariant;
  declare animated: boolean;
  declare width: string | null;
  declare height: string | null;

  constructor() {
    super();
    this.variant = "default";
    this.animated = true;
    this.width = null;
    this.height = null;
  }

  protected override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ): void {
    super.willUpdate(changedProperties);
    if (changedProperties.has("variant")) {
      this.variant = oneOf(this.variant, skeletonVariants, "default");
    }
  }

  override render() {
    const styles = {
      ...(this.width && { width: this.width }),
      ...(this.height && { height: this.height }),
    };

    return html`
      <div
        class="skeleton ${this.variant} ${this.animated ? "animate" : ""}"
        part="skeleton"
        style="${styleMap(styles)}"
        role="status"
        aria-label="Loading"
      >
        <span class="sr-only">Loading...</span>
      </div>
    `;
  }
}
