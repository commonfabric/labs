import { html, unsafeCSS } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { aspectRatioStyles } from "./styles.ts";

/**
 * CFAspectRatio - Maintains a specific aspect ratio for its content
 *
 * @element cf-aspect-ratio
 *
 * @attr {string} ratio - Aspect ratio as a fraction (e.g., "16/9", "1/1", "4/3"). Default: "16/9"
 *
 * @slot - Default slot for content that will maintain the aspect ratio
 *
 * @example
 * <cf-aspect-ratio ratio="16/9">
 *   <div style="background: gray">Video placeholder</div>
 * </cf-aspect-ratio>
 */
export class CFAspectRatio extends BaseElement {
  static override styles = unsafeCSS(aspectRatioStyles);

  static override properties = {
    ratio: { type: String },
  };

  declare ratio: string;

  constructor() {
    super();
    this.ratio = "16/9";
  }

  override render() {
    // Calculate padding percentage based on ratio
    const paddingBottom = this.calculatePaddingBottom();

    const containerStyles = {
      "padding-bottom": `${paddingBottom}%`,
    };

    return html`
      <div
        class="aspect-ratio-container"
        part="container"
        style="${styleMap(containerStyles)}"
      >
        <div class="aspect-ratio-content" part="content">
          <slot></slot>
        </div>
      </div>
    `;
  }

  private calculatePaddingBottom(): number {
    // Parse the ratio string (e.g., "16/9", "4/3", "1/1")
    const parts = this.ratio.split("/");
    if (parts.length !== 2) {
      console.warn(`Invalid aspect ratio: ${this.ratio}. Using default 16/9.`);
      return 56.25; // 16/9 default
    }

    const width = parseFloat(parts[0]);
    const height = parseFloat(parts[1]);

    if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
      console.warn(`Invalid aspect ratio: ${this.ratio}. Using default 16/9.`);
      return 56.25; // 16/9 default
    }

    // Calculate padding percentage (height / width * 100)
    return (height / width) * 100;
  }
}
