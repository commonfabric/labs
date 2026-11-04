import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import type { CFResizablePanelGroup } from "../cf-resizable-panel-group/cf-resizable-panel-group.ts";

/**
 * @component cf-resizable-handle
 * @description Drag handle component for resizing panels within a resizable panel group
 *
 * @tag cf-resizable-handle
 *
 * @attribute {boolean} with-handle - Whether to show the visual grip indicator. Defaults to true.
 *
 * @event {CustomEvent} cf-handle-adjust - Fired when handle is adjusted via keyboard
 * @event-detail {Object} detail - Event detail object
 * @event-detail {number} detail.delta - The adjustment amount (-100 to 100)
 *
 * @csspart handle - The handle container element
 * @csspart grip - The visual grip indicator (when with-handle is true)
 *
 * @example
 * ```html
 * <!-- Basic resizable panels with handles -->
 * <cf-resizable-panel-group direction="horizontal">
 *   <cf-resizable-panel default-size="50">
 *     <div>Panel 1</div>
 *   </cf-resizable-panel>
 *   <cf-resizable-handle></cf-resizable-handle>
 *   <cf-resizable-panel default-size="50">
 *     <div>Panel 2</div>
 *   </cf-resizable-panel>
 * </cf-resizable-panel-group>
 *
 * <!-- Handle without visual indicator -->
 * <cf-resizable-handle with-handle="false"></cf-resizable-handle>
 * ```
 *
 * @accessibility
 * - Uses role="separator" for screen reader support
 * - Keyboard navigable with arrow keys
 * - Arrow keys adjust size incrementally based on panel group direction
 * - Home/End keys jump to minimum/maximum sizes
 * - Provides aria-valuenow, aria-valuemin, aria-valuemax
 *
 * @keyboard
 * - ArrowLeft/ArrowRight - Adjust horizontal panels
 * - ArrowUp/ArrowDown - Adjust vertical panels
 * - Home - Set to minimum size
 * - End - Set to maximum size
 *
 * @note Must be used between cf-resizable-panel elements within a cf-resizable-panel-group
 */
export class CFResizableHandle extends BaseElement {
  static override properties = {
    withHandle: { type: Boolean, attribute: "with-handle" },
  };
  declare withHandle: boolean;

  static override styles = css`
    :host {
      display: block;
      position: relative;
      background: var(--border, hsl(0, 0%, 89%));
      transition: background-color 150ms ease;
    }

    :host(:hover) {
      background: var(--border-hover, hsl(0, 0%, 78%));
    }

    :host(:focus-visible) {
      outline: 2px solid var(--ring, hsl(212, 100%, 47%));
      outline-offset: -1px;
    }

    .handle {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    /* Grip icon styles */
    .grip-icon {
      position: relative;
      opacity: 0.5;
      transition: opacity 150ms ease;
    }

    :host(:hover) .grip-icon {
      opacity: 0.8;
    }

    /* Horizontal grip */
    :host([data-orientation="horizontal"]) .grip-icon {
      width: 2px;
      height: 16px;
      background: currentColor;
    }

    :host([data-orientation="horizontal"]) .grip-icon::before,
    :host([data-orientation="horizontal"]) .grip-icon::after {
      content: "";
      position: absolute;
      width: 2px;
      height: 16px;
      background: currentColor;
    }

    :host([data-orientation="horizontal"]) .grip-icon::before {
      left: -3px;
    }

    :host([data-orientation="horizontal"]) .grip-icon::after {
      right: -3px;
    }

    /* Vertical grip */
    :host([data-orientation="vertical"]) .grip-icon {
      width: 16px;
      height: 2px;
      background: currentColor;
    }

    :host([data-orientation="vertical"]) .grip-icon::before,
    :host([data-orientation="vertical"]) .grip-icon::after {
      content: "";
      position: absolute;
      width: 16px;
      height: 2px;
      background: currentColor;
    }

    :host([data-orientation="vertical"]) .grip-icon::before {
      top: -3px;
    }

    :host([data-orientation="vertical"]) .grip-icon::after {
      bottom: -3px;
    }

    /* Active/dragging state */
    :host(.dragging) {
      background: var(--ring, hsl(212, 100%, 47%));
      opacity: 0.8;
    }

    /* Dark mode support */
    @media (prefers-color-scheme: dark) {
      :host {
        background: var(--border, hsl(0, 0%, 20%));
      }

      :host(:hover) {
        background: var(--border-hover, hsl(0, 0%, 25%));
      }
    }
  `;

  constructor() {
    super();
    this.withHandle = true;
  }

  override connectedCallback() {
    super.connectedCallback();

    // Set ARIA attributes
    this.setAttribute("role", "separator");
    this.setAttribute("aria-valuenow", "50");
    this.setAttribute("aria-valuemin", "0");
    this.setAttribute("aria-valuemax", "100");
    this.setAttribute("tabindex", "0");

    // Add keyboard support
    this.addEventListener("keydown", this.handleKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this.handleKeyDown);
  }

  override render() {
    return html`
      <div class="handle" part="handle">
        ${this.withHandle
          ? html`
            <div class="grip-icon" part="grip"></div>
          `
          : ""}
      </div>
    `;
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const panelGroup = this.closest<CFResizablePanelGroup>(
      "cf-resizable-panel-group",
    );
    if (!panelGroup) return;

    // The group's property, not its attribute: a renderer assigns
    // `direction`, and nothing copies it to an attribute.
    const isHorizontal = panelGroup.direction !== "vertical";

    let handled = false;

    switch (e.key) {
      case "ArrowLeft":
        if (isHorizontal) {
          this.adjustSize(-1);
          handled = true;
        }
        break;
      case "ArrowRight":
        if (isHorizontal) {
          this.adjustSize(1);
          handled = true;
        }
        break;
      case "ArrowUp":
        if (!isHorizontal) {
          this.adjustSize(-1);
          handled = true;
        }
        break;
      case "ArrowDown":
        if (!isHorizontal) {
          this.adjustSize(1);
          handled = true;
        }
        break;
      case "Home":
        this.adjustSize(-100);
        handled = true;
        break;
      case "End":
        this.adjustSize(100);
        handled = true;
        break;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private adjustSize(delta: number): void {
    // Emit a custom event that the panel group can listen to
    this.emit("cf-handle-adjust", { delta });
  }
}
