import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import {
  groupOf,
  joinGroup,
  leaveGroup,
} from "../cf-resizable-panel-group/membership.ts";

/**
 * @component cf-resizable-handle
 * @description Drag handle component for resizing panels within a resizable panel group
 *
 * @tag cf-resizable-handle
 *
 * @property {boolean} withHandle - Whether to show the visual grip
 *   indicator. Defaults to true; the property turns it off, since a boolean
 *   attribute is true whatever its value.
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
 * ```
 *
 * A handle without the grip, in a pattern:
 * ```tsx
 * <cf-resizable-handle withHandle={false} />
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
 * @note Moves the nearest panel on each side of it in its group: the nearest
 *   cf-resizable-panel-group above it, whatever elements stand between them
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

    /* Set by the group: the handle is a line across the axis the panels lie
    * on. */
    :host([data-orientation]) {
      flex-shrink: 0;
      z-index: 10;
    }

    :host([data-orientation="horizontal"]) {
      width: 6px;
      height: 100%;
      cursor: col-resize;
    }

    :host([data-orientation="vertical"]) {
      width: 100%;
      height: 6px;
      cursor: row-resize;
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
    joinGroup(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this.handleKeyDown);
    leaveGroup(this);
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
    const panelGroup = groupOf(this);
    if (!panelGroup) return;

    // The group's orientation, not its attribute: a renderer assigns
    // `direction`, nothing copies it to an attribute, and a group narrower
    // than its `stackBelow` lies vertically whatever its direction.
    const isHorizontal = panelGroup.orientation !== "vertical";

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
    groupOf(this)?.handleAdjusted(this, delta);
  }
}
