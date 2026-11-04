import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFAutoLayout - Responsive multi-panel layout component
 *
 * Automatically arranges children:
 * - Desktop: Optional left/right sidebars and center content grid
 * - Mobile: Degrades to a tabbed interface (left | content | right)
 *
 * @element cf-autolayout
 *
 * @example
 * <cf-autolayout tabNames={["Chat", "Tools", "Lists"]}>
 *   <div>Messages</div>
 *   <div>Calculator results</div>
 *   <div>Todo items</div>
 * </cf-autolayout>
 *
 * @example With sidebars
 * <cf-autolayout
 *   tabNames={["Chat", "Tools"]}
 *   leftTabName="Outline"
 *   rightTabName="Details"
 * >
 *   <aside slot="left">Outline here</aside>
 *   <div>Chat</div>
 *   <div>Tools</div>
 *   <aside slot="right">Extra details</aside>
 * </cf-autolayout>
 */
export class CFAutoLayout extends BaseElement {
  static override properties = {
    tabNames: { type: Array, attribute: false },
    leftTabName: { type: String, attribute: false },
    rightTabName: { type: String, attribute: false },

    /**
     * Position of tabs on mobile: "top" | "bottom".
     * Default is "bottom".
     */
    tabsPosition: { type: String, reflect: true },

    /**
     * Whether the left sidebar is open. Reflected to attribute.
     */
    leftOpen: { type: Boolean, reflect: true },

    /**
     * Whether the right sidebar is open. Reflected to attribute.
     */
    rightOpen: { type: Boolean, reflect: true },
  };
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
    }

    .tabs {
      display: none; /* hidden on desktop */
      gap: 0.25rem;
      align-items: center;
      justify-content: center;
    }

    .tab {
      padding: 0.75rem 1rem;
      border: none;
      background: none;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      font-size: 0.9rem;
    }

    .tab:hover {
      background: #f5f5f5;
    }

    .tab.active {
      border-bottom-color: #007acc;
      font-weight: 500;
    }

    .layout {
      flex: 1;
      overflow: hidden;
      order: 1; /* Content comes first, tabs at bottom */
      display: grid;
      grid-template-columns: 0px 1fr 0px; /* toggled by classes below */
      gap: 1rem;
      position: relative;
    }

    /* Hide toolbar by default (desktop); shown in mobile query */
    .mobile-bar {
      display: none;
    }

    /* Mobile bar styles are defined in the mobile media query */

    .sidebar-left,
    .sidebar-right,
    .content {
      min-height: 0;
      min-width: 0;
    }

    /* Scrim should not affect desktop layout */
    .scrim {
      display: none;
    }

    .sidebar-left,
    .sidebar-right {
      overflow: hidden;
      background: var(
        --cf-theme-color-surface,
        var(--cf-surface, #f1f5f9)
      );
      padding: var(--cf-theme-spacing-normal, 0.5rem);
      /* Visual separation and rounding on content-adjacent corners */
      border: none;
    }
    .sidebar-left {
      border-right: 1px solid
        var(
        --cf-theme-color-border,
        #e5e7eb
      );
      border-top-right-radius: var(
        --cf-theme-border-radius,
        var(--cf-border-radius-md, 0.375rem)
      );
      border-bottom-right-radius: var(
        --cf-theme-border-radius,
        var(--cf-border-radius-md, 0.375rem)
      );
    }
    .sidebar-right {
      border-left: 1px solid
        var(
        --cf-theme-color-border,
        #e5e7eb
      );
      border-top-left-radius: var(
        --cf-theme-border-radius,
        var(--cf-border-radius-md, 0.375rem)
      );
      border-bottom-left-radius: var(
        --cf-theme-border-radius,
        var(--cf-border-radius-md, 0.375rem)
      );
    }

    .content {
      background: var(
        --cf-theme-color-background,
        #ffffff
      );
    }

    /* Track sizes are overridden in desktop media query */

    /* Desktop: Grid layout */
    @media (min-width: 769px) {
      /* Define grid tracks for desktop */
      .layout {
        display: grid;
        grid-template-columns: 1fr; /* default: only content */
        gap: var(--cf-theme-spacing-loose, 1rem);
      }
      .left-open {
        grid-template-columns: 280px 1fr;
      }
      .right-open {
        grid-template-columns: 1fr 280px;
      }
      .left-open.right-open {
        grid-template-columns: 280px 1fr 280px;
      }

      /* Lay out default panes side by side inside content area */
      .content {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: var(--cf-theme-spacing-loose, 1rem);
      }
      /* Visual separators for default content items */
      .content > ::slotted(:not([slot])) {
        background: transparent;
        border: 1px solid
          var(
          --cf-theme-color-border,
          #e5e7eb
        );
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        padding: var(--cf-theme-spacing-loose, 1rem);
        box-sizing: border-box;
      }

      .tabs {
        display: none;
      }

      /* Desktop: only show sidebars when open */
      .sidebar-left,
      .sidebar-right {
        display: none;
      }
      .left-open .sidebar-left {
        display: block;
      }
      .right-open .sidebar-right {
        display: block;
      }

      /* Desktop floating toggle buttons */
      .desktop-toggle {
        position: absolute;
        bottom: 0.5rem;
        z-index: 35;
      }
      .desktop-toggle-left {
        left: 0.5rem;
      }
      .desktop-toggle-right {
        right: 0.5rem;
      }
      /* When a sidebar is open, move toggle just inside the panel */
      .left-open .desktop-toggle-left {
        left: calc(280px - 2.5rem - 0.5rem);
      }
      .right-open .desktop-toggle-right {
        right: calc(280px - 2.5rem - 0.5rem);
      }
    }

    /* Mobile: Tabbed layout + off-canvas sidebars */
    @media (max-width: 768px) {
      /* Collapse to single pane; hide wrappers by default */
      .layout {
        display: block;
        position: relative; /* scope overlays within layout */
      }
      /* Main content is visible for active content tab */
      .content {
        display: none;
        width: 100%;
        height: 100%;
      }
      .layout.active-content .content {
        display: block;
      }

      /* Hide default-slotted children by default; keep named slots visible */
      ::slotted(:not([slot])) {
        display: none;
        height: 100%;
      }

      /* Show only the active child inside content */
      .layout.active-content ::slotted(.active-tab) {
        display: flex !important;
        width: 100%;
        flex-direction: column;
      }

      /* Off-canvas panels for sidebars */
      .sidebar-left,
      .sidebar-right {
        display: block;
        position: absolute; /* within layout only */
        top: 0;
        bottom: 0;
        width: min(80vw, 320px);
        max-width: 90vw;
        background: var(
          --cf-theme-color-surface,
          var(--cf-surface, #f1f5f9)
        );
        /*box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);*/
        transition: transform 0.25s ease;
        will-change: transform;
        z-index: 30;
        padding: var(--cf-theme-spacing-normal, 0.5rem);
      }
      @media (prefers-reduced-motion: reduce) {
        .sidebar-left,
        .sidebar-right {
          transition: none;
        }
      }
      .sidebar-left {
        left: 0;
        transform: translateX(-100%);
      }
      .sidebar-right {
        right: 0;
        transform: translateX(100%);
      }
      :host([leftopen]) .sidebar-left {
        transform: translateX(0);
      }
      :host([rightopen]) .sidebar-right {
        transform: translateX(0);
      }

      /* Scrim overlay when any off-canvas is open */
      .scrim {
        display: block;
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.28);
        z-index: 25;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }
      :host([leftopen]) .scrim,
      :host([rightopen]) .scrim {
        opacity: 1;
        pointer-events: auto;
      }

      /* Bottom/Top toolbar with centered tabs */
      .mobile-bar {
        --cf-mobile-bar-height: 3rem;
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: var(--cf-mobile-bar-height);
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 0.25rem;
        background: var(
          --cf-theme-color-surface,
          var(--cf-surface, #f1f5f9)
        );
        border-top: 1px solid
          var(
          --cf-theme-color-border,
          #e0e0e0
        );
        padding: 0 var(--cf-theme-spacing-normal, 0.5rem);
        z-index: 40;
      }
      .mobile-bar.top {
        top: 0;
        bottom: auto;
        border-top: none;
        border-bottom: 1px solid
          var(
          --cf-theme-color-border,
          #e0e0e0
        );
      }
      .mobile-bar .tabs {
        display: flex;
        justify-content: center;
        align-items: center;
        overflow-x: auto;
        scrollbar-width: thin;
        border: 0;
      }
      .mobile-bar .tab {
        padding: var(--cf-theme-spacing-tight, 0.25rem)
          var(--cf-theme-spacing-normal, 0.5rem);
        border: none;
        background: none;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        font-size: 0.9rem;
      }
      .mobile-bar .tab.active {
        border-bottom-color: #007acc;
        font-weight: 500;
      }

      /* Reserve space for the mobile bar so content is full height */
      .layout {
        padding-bottom: var(--cf-mobile-bar-height, 3rem);
      }
      :host([tabsposition="top"]) .layout {
        padding-bottom: 0;
        padding-top: var(--cf-mobile-bar-height, 3rem);
      }
      /* Show the bar on mobile */
      .mobile-bar {
        display: grid;
      }

      /* Hide desktop floating toggles on mobile */
      .desktop-toggle {
        display: none;
      }
    }
  `;

  private _activeTab = 0;
  private _children: Element[] = [];
  private _leftEl: Element | null = null;
  private _rightEl: Element | null = null;
  private _hasLeft = false;
  private _hasRight = false;
  private _lastToggleEl: Element | null = null;

  declare tabNames: string[];
  declare leftTabName?: string;
  declare rightTabName?: string;
  declare tabsPosition: "top" | "bottom";
  declare leftOpen: boolean;
  declare rightOpen: boolean;

  constructor() {
    super();
    this.tabNames = [];
    this.leftTabName = "Left";
    this.rightTabName = "Right";
    this.tabsPosition = "bottom";
    this.leftOpen = true;
    this.rightOpen = true;
  }

  override connectedCallback() {
    super.connectedCallback();
    this._updateChildren();
    this._updateActiveTab();
    this._onKeydown = this._onKeydown.bind(this);
    globalThis.addEventListener("keydown", this._onKeydown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    globalThis.removeEventListener("keydown", this._onKeydown);
  }

  /**
   * Keeps attributes/props as the single source of truth and enforces mobile
   * exclusivity even when set programmatically.
   */
  override updated(changed: Map<string, unknown>) {
    if (changed.has("leftOpen") || changed.has("rightOpen")) {
      // Enforce exclusivity on mobile when both become true.
      if (this._isMobile() && this.leftOpen && this.rightOpen) {
        const last = changed.has("leftOpen") ? "left" : "right";
        if (last === "left") this.rightOpen = false;
        else this.leftOpen = false;
      }
      // Emit change events so hosts can react even on attribute changes.
      if (changed.has("leftOpen")) {
        this.dispatchEvent(
          new CustomEvent("cf-toggle-left", {
            bubbles: true,
            composed: true,
            detail: { open: this.leftOpen },
          }),
        );
      }
      if (changed.has("rightOpen")) {
        this.dispatchEvent(
          new CustomEvent("cf-toggle-right", {
            bubbles: true,
            composed: true,
            detail: { open: this.rightOpen },
          }),
        );
      }
    }
    super.updated?.(changed as any);
  }

  private _updateChildren() {
    this._children = Array.from(this.children);
    this._leftEl = this._children.find((el) =>
      el.getAttribute("slot") ===
        "left"
    ) ?? null;
    this._rightEl = this._children.find((el) =>
      el.getAttribute("slot") ===
        "right"
    ) ?? null;
    this._hasLeft = !!this._leftEl;
    this._hasRight = !!this._rightEl;
  }

  private _handleTabClick(index: number) {
    this._activeTab = index;
    this._updateActiveTab();
    this.requestUpdate();
  }

  private _toggleLeft(trigger?: Element) {
    if (!this._hasLeft) return;
    this._lastToggleEl = trigger ?? null;
    const opening = !this.leftOpen;
    this.leftOpen = opening;
    if (opening && this._isMobile()) {
      this.rightOpen = false;
    }
    this.dispatchEvent(
      new CustomEvent("cf-toggle-left", {
        bubbles: true,
        composed: true,
        detail: { open: this.leftOpen },
      }),
    );
    this.requestUpdate();
  }

  private _toggleRight(trigger?: Element) {
    if (!this._hasRight) return;
    this._lastToggleEl = trigger ?? null;
    const opening = !this.rightOpen;
    this.rightOpen = opening;
    if (opening && this._isMobile()) {
      this.leftOpen = false;
    }
    this.dispatchEvent(
      new CustomEvent("cf-toggle-right", {
        bubbles: true,
        composed: true,
        detail: { open: this.rightOpen },
      }),
    );
    this.requestUpdate();
  }

  private _isMobile(): boolean {
    try {
      return globalThis.matchMedia?.("(max-width: 768px)")?.matches ?? false;
    } catch {
      return false;
    }
  }

  private _closePanels() {
    const wasOpen = this.leftOpen || this.rightOpen;
    this.leftOpen = false;
    this.rightOpen = false;
    if (wasOpen && this._lastToggleEl instanceof HTMLElement) {
      // Return focus to the last toggle trigger
      this._lastToggleEl.focus();
    }
    this.requestUpdate();
  }

  private _onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (this.leftOpen || this.rightOpen) {
        e.stopPropagation();
        this._closePanels();
      }
    }
  }

  private _updateActiveTab() {
    // Only default (content) panes participate in tab switching
    const defaults = this._children.filter((el) => !el.getAttribute("slot"));
    const panes: Element[] = [...defaults];

    // Remove active-tab class from all children
    this._children.forEach((child) => child.classList.remove("active-tab"));

    // Add active-tab class to current pane
    const active = panes[this._activeTab];
    if (active) active.classList.add("active-tab");
  }

  override render() {
    this._updateChildren();

    // Build tab names for content panes only (exclude sidebars)
    const defaults = this._children.filter((el) => !el.getAttribute("slot"));
    const contentTabs: string[] = (this.tabNames.length === defaults.length)
      ? this.tabNames
      : defaults.map((_, i) => `Pane ${i + 1}`);

    const layoutClass = classMap({
      layout: true,
      "has-left": this._hasLeft,
      "has-right": this._hasRight,
      "left-open": this._hasLeft && this.leftOpen,
      "right-open": this._hasRight && this.rightOpen,
      // On mobile, we always show the content container and only swap
      // which default child is marked active.
      "active-content": true,
    });

    return html`
      <!-- Grid layout: left | content | right -->
      <div class="${layoutClass}">
        <div class="sidebar-left">
          <slot name="left"></slot>
        </div>
        <div class="content">
          <slot></slot>
        </div>
        <div class="sidebar-right">
          <slot name="right"></slot>
        </div>
        <!-- Mobile-only overlays and toolbar (scoped within layout) -->
        <div
          class="scrim"
          @click="${() => this._closePanels()}"
          aria-hidden="true"
        ></div>

        <div class="mobile-bar ${classMap({
          top: this.tabsPosition === "top",
        })}">
          <cf-button
            size="icon"
            color="neutral"
            variant="outline"
            aria-label="Toggle left sidebar"
            @click="${(e: Event) =>
              this._toggleLeft(e.currentTarget as Element)}"
          >
            ←
          </cf-button>
          <div class="tabs">
            ${contentTabs.map((name, index) =>
              html`
                <button
                  class="${classMap({
                    tab: true,
                    active: index === this._activeTab,
                  })}"
                  @click="${() => this._handleTabClick(index)}"
                >
                  ${name}
                </button>
              `
            )}
          </div>
          <cf-button
            size="icon"
            color="neutral"
            variant="outline"
            aria-label="Toggle right sidebar"
            @click="${(e: Event) =>
              this._toggleRight(e.currentTarget as Element)}"
          >
            →
          </cf-button>
        </div>

        <!-- Desktop floating toggles -->
        <div class="desktop-toggle desktop-toggle-left">
          <cf-button
            size="icon"
            color="neutral"
            variant="outline"
            aria-label="Toggle left sidebar"
            @click="${(e: Event) =>
              this._toggleLeft(e.currentTarget as Element)}"
          >
            ←
          </cf-button>
        </div>
        <div class="desktop-toggle desktop-toggle-right">
          <cf-button
            size="icon"
            color="neutral"
            variant="outline"
            aria-label="Toggle right sidebar"
            @click="${(e: Event) =>
              this._toggleRight(e.currentTarget as Element)}"
          >
            →
          </cf-button>
        </div>
      </div>
    `;
  }
}
