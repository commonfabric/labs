import { css, html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";

const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 600;

export class XOmniLayout extends LitElement {
  static override styles = css`
    :host {
      display: grid;
      grid-template-rows: 1fr;
      height: 100%;
      width: 100%;
      overflow: hidden;
      transition: grid-template-columns 0.3s ease;
      position: relative;
    }

    /* Desktop: sidebar displaces content */
    @media (min-width: 769px) {
      :host {
        grid-template-columns: 1fr;
      }

      :host([sidebar-open]) {
        grid-template-columns: 1fr var(--sidebar-width, 320px);
      }
    }

    /* Mobile: sidebar overlays content */
    @media (max-width: 768px) {
      :host {
        grid-template-columns: 1fr;
      }
    }

    .main {
      grid-column: 1;
      grid-row: 1;
      position: relative;
      overflow: auto;
    }

    .sidebar-container {
      position: relative;
      overflow: hidden;
      display: none;
    }

    /* Desktop: grid positioning */
    @media (min-width: 769px) {
      .sidebar-container.visible {
        display: block;
        grid-column: 2;
        grid-row: 1;
      }
    }

    /* Mobile: overlay positioning within content area */
    @media (max-width: 768px) {
      .sidebar-container.visible {
        display: block;
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        width: 320px;
        z-index: 100;
        box-shadow: -4px 0 8px rgba(0, 0, 0, 0.1);
      }
    }

    .sidebar {
      height: 100%;
      width: 100%;
      background-color: white;
      border-left: var(--border-width, 2px) solid var(--border-color, #000);
      overflow: auto;
      display: flex;
      flex-direction: column;
    }

    .resize-handle {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 8px;
      cursor: col-resize;
      background: transparent;
      z-index: 10;
      user-select: none;
      touch-action: none;
    }

    .resize-handle:hover,
    .resize-handle.dragging {
      background: var(--border-color, #000);
      opacity: 0.2;
    }

    /* Hide resize handle on mobile */
    @media (max-width: 768px) {
      .resize-handle {
        display: none;
      }
    }

    .sidebar-content {
      flex: 1;
      min-height: 0;
      padding: 1rem;
      box-sizing: border-box;
    }

    .fab {
      position: fixed;
      bottom: calc(4px + env(safe-area-inset-bottom, 0px));
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000;
    }
  `;

  /** Whether the sidebar is open, which shows it only while it has content. */
  @property({ type: Boolean })
  accessor sidebarOpen = false;

  @state()
  private accessor hasSidebarContent = false;

  @state()
  private accessor sidebarWidth = DEFAULT_SIDEBAR_WIDTH;

  @state()
  private accessor isResizing = false;

  #resizeStartX = 0;
  #resizeStartWidth = 0;

  /**
   * Publishes the sidebar's width to the grid as `--sidebar-width`, and gives
   * the host the `sidebar-open` attribute, which opens the sidebar's grid
   * column, only while the sidebar is both open and has content.
   */
  override updated() {
    this.style.setProperty("--sidebar-width", `${this.sidebarWidth}px`);
    this.toggleAttribute(
      "sidebar-open",
      this.sidebarOpen && this.hasSidebarContent,
    );
  }

  // `slotchange` bubbles, so a slot forwarded into the sidebar's slot sends one
  // here too, as its target. What is measured is the sidebar slot the listener
  // is bound on, the event's `currentTarget`.

  #handleSidebarSlotChange = (
    { currentTarget: slot }: { currentTarget: HTMLSlotElement },
  ) => {
    this.hasSidebarContent = slot.assignedNodes({ flatten: true }).some(
      (node) =>
        node.nodeType === Node.ELEMENT_NODE ||
        (node.nodeType === Node.TEXT_NODE &&
          (node.textContent ?? "").trim().length > 0),
    );
  };

  // The handle captures the pointer when a drag starts, so the drag's moves
  // arrive at the handle wherever the pointer goes, and the drag ends when the
  // handle loses the capture, which it does when the pointer is released or
  // the browser cancels the gesture.

  #handleResizeStart = (
    e: PointerEvent & { currentTarget: Pick<Element, "setPointerCapture"> },
  ) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    this.isResizing = true;
    this.#resizeStartX = e.clientX;
    this.#resizeStartWidth = this.sidebarWidth;
  };

  #handleResizeMove = (e: PointerEvent) => {
    if (!this.isResizing) return;

    // The sidebar is on the right, so a drag leftwards widens it.
    const delta = this.#resizeStartX - e.clientX;
    this.sidebarWidth = Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, this.#resizeStartWidth + delta),
    );
  };

  #handleResizeEnd = () => {
    this.isResizing = false;
  };

  override render() {
    const showSidebar = this.hasSidebarContent && this.sidebarOpen;

    return html`
      <div class="main">
        <slot name="main"></slot>
      </div>
      <div class="sidebar-container ${showSidebar ? "visible" : ""}">
        <div class="sidebar">
          <div
            class="resize-handle ${this.isResizing ? "dragging" : ""}"
            @pointerdown="${this.#handleResizeStart}"
            @pointermove="${this.#handleResizeMove}"
            @lostpointercapture="${this.#handleResizeEnd}"
          ></div>
          <div class="sidebar-content">
            <slot
              name="sidebar"
              @slotchange="${this.#handleSidebarSlotChange}"
            ></slot>
          </div>
        </div>
      </div>
      <div class="fab">
        <slot name="fab"></slot>
      </div>
    `;
  }
}

globalThis.customElements.define("x-omni-layout", XOmniLayout);
