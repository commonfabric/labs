import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * @component cf-resizable-panel
 * @description Individual resizable panel component that works within a resizable panel group
 *
 * @tag cf-resizable-panel
 *
 * @attribute {number} default-size - Default size of the panel as a percentage (0-100). Defaults to 50.
 * @attribute {number} min-size - Minimum size of the panel as a percentage (0-100). Defaults to 0.
 * @attribute {number} max-size - Maximum size of the panel as a percentage (0-100). Defaults to 100.
 * @attribute {boolean} collapsible - Whether the panel can be collapsed to zero size
 *
 * @slot default - Content of the resizable panel
 *
 * @csspart panel - The panel container element
 *
 * @example
 * ```html
 * <!-- Basic resizable panels -->
 * <cf-resizable-panel-group direction="horizontal">
 *   <cf-resizable-panel default-size="30" min-size="20">
 *     <div>Sidebar content</div>
 *   </cf-resizable-panel>
 *   <cf-resizable-handle></cf-resizable-handle>
 *   <cf-resizable-panel default-size="70">
 *     <div>Main content</div>
 *   </cf-resizable-panel>
 * </cf-resizable-panel-group>
 *
 * <!-- Collapsible panel -->
 * <cf-resizable-panel-group direction="vertical">
 *   <cf-resizable-panel default-size="50">
 *     <div>Top panel</div>
 *   </cf-resizable-panel>
 *   <cf-resizable-handle></cf-resizable-handle>
 *   <cf-resizable-panel default-size="50" collapsible>
 *     <div>Bottom panel (collapsible)</div>
 *   </cf-resizable-panel>
 * </cf-resizable-panel-group>
 *
 * <!-- With size constraints -->
 * <cf-resizable-panel
 *   default-size="40"
 *   min-size="25"
 *   max-size="60"
 * >
 *   <div>Constrained panel</div>
 * </cf-resizable-panel>
 * ```
 *
 * @note
 * - Must be used within a cf-resizable-panel-group
 * - Panels are separated by cf-resizable-handle components
 * - Size values are percentages of the total available space
 * - The component automatically validates that min <= default <= max
 */
export class CFResizablePanel extends BaseElement {
  static override properties = {
    minSize: { type: Number, attribute: "min-size" },
    defaultSize: { type: Number, attribute: "default-size" },
    maxSize: { type: Number, attribute: "max-size" },
    collapsible: { type: Boolean },
  };
  declare minSize: number;
  declare defaultSize: number;
  declare maxSize: number;
  declare collapsible: boolean;

  static override styles = css`
    :host {
      display: block;
      overflow: auto;
      position: relative;
    }

    .panel {
      width: 100%;
      height: 100%;
      position: relative;
    }

    /* Ensure content respects panel bounds */
    .panel > ::slotted(*) {
      max-width: 100%;
      max-height: 100%;
    }
  `;

  constructor() {
    super();
    this.minSize = 0;
    this.defaultSize = 50;
    this.maxSize = 100;
    this.collapsible = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.validateSizes();
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (
      changedProperties.has("minSize") ||
      changedProperties.has("defaultSize") ||
      changedProperties.has("maxSize")
    ) {
      this.validateSizes();
    }
  }

  override render() {
    return html`
      <div class="panel" part="panel">
        <slot></slot>
      </div>
    `;
  }

  private validateSizes(): void {
    // Ensure values are within valid range
    this.minSize = Math.max(0, Math.min(100, this.minSize));
    this.maxSize = Math.max(0, Math.min(100, this.maxSize));
    this.defaultSize = Math.max(0, Math.min(100, this.defaultSize));

    // Ensure min <= default <= max
    if (this.minSize > this.maxSize) {
      const temp = this.minSize;
      this.minSize = this.maxSize;
      this.maxSize = temp;
    }

    if (this.defaultSize < this.minSize) {
      this.defaultSize = this.minSize;
    } else if (this.defaultSize > this.maxSize) {
      this.defaultSize = this.maxSize;
    }

    // If collapsible, ensure minSize is 0
    if (this.collapsible) {
      this.minSize = 0;
    }
  }
}
