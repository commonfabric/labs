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

  override firstUpdated() {
    const slot = this.shadowRoot?.querySelector(
      'slot[name="sidebar"]',
    ) as HTMLSlotElement | null;
    if (slot) {
      this.#updateSidebarContent(slot);
      slot.addEventListener("slotchange", () => {
        this.#updateSidebarContent(slot);
      });
    }
  }

  override updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has("sidebarWidth")) {
      this.style.setProperty("--sidebar-width", `${this.sidebarWidth}px`);
    }

    // Only show sidebar grid column when both open AND has content
    if (
      changedProperties.has("sidebarOpen") ||
      changedProperties.has("hasSidebarContent")
    ) {
      const shouldExpand = this.sidebarOpen && this.hasSidebarContent;
      if (shouldExpand) {
        this.setAttribute("sidebar-open", "");
      } else {
        this.removeAttribute("sidebar-open");
      }
    }
  }

  #updateSidebarContent(slot: HTMLSlotElement) {
    const nodes = slot.assignedNodes({ flatten: true });
    const hasContent = nodes.some((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) return true;
      if (node.nodeType === Node.TEXT_NODE) {
        return (node.textContent ?? "").trim().length > 0;
      }
      return false;
    });
    this.hasSidebarContent = hasContent;
  }

  #handleResizeStart = (e: PointerEvent) => {
    e.preventDefault();
    this.isResizing = true;
    this.#resizeStartX = e.clientX;
    this.#resizeStartWidth = this.sidebarWidth;

    const handle = e.target as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");

    document.addEventListener("pointermove", this.#handleResizeMove);
    document.addEventListener("pointerup", this.#handleResizeEnd);
  };

  #handleResizeMove = (e: PointerEvent) => {
    if (!this.isResizing) return;

    const delta = this.#resizeStartX - e.clientX;
    const newWidth = Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, this.#resizeStartWidth + delta),
    );

    this.sidebarWidth = newWidth;
  };

  #handleResizeEnd = (_e: PointerEvent) => {
    if (!this.isResizing) return;

    this.isResizing = false;
    const handle = this.shadowRoot?.querySelector(
      ".resize-handle",
    ) as HTMLElement;
    if (handle) {
      handle.classList.remove("dragging");
    }

    document.removeEventListener("pointermove", this.#handleResizeMove);
    document.removeEventListener("pointerup", this.#handleResizeEnd);
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
            class="resize-handle"
            @pointerdown="${this.#handleResizeStart}"
          ></div>
          <div class="sidebar-content">
            <slot name="sidebar"></slot>
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
