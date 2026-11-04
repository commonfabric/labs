import { css, html } from "lit";
import { type CellHandle } from "@commonfabric/runtime-client";
import { stringSchema } from "@commonfabric/runner/schemas";
import { BaseElement } from "../../core/base-element.ts";
import { createStringCellController } from "../../core/cell-controller.ts";
import type { CFTabBarItem } from "./cf-tab-bar-item.ts";

/**
 * CFTabBar - Navigation bar for mobile and app-like UIs
 *
 * The bar is fixed-position by default. When placed in a `slot="footer"`,
 * it participates in layout so containers such as `cf-screen` can reserve
 * space for the footer chrome.
 *
 * @element cf-tab-bar
 *
 * @attr {string} position - "bottom" | "top" (default: "bottom")
 * @attr {string} variant - "default" | "inset" (default: "default")
 * @prop {CellHandle<string>|string} value - Selected item value; use $value for Cell binding
 *
 * @slot - cf-tab-bar-item elements
 * @slot action - Optional primary action element (e.g. a cf-button). Renders to the right of the navigation pill.
 *
 * @fires cf-change - Fired when selected item changes with detail: { value, oldValue }
 *
 * @csspart container - The outermost flex row holding the nav pill and action slot side by side.
 * @csspart bar - The nav pill surface containing the navigation items.
 * @csspart action - The wrapper around the action slot. Hidden when the slot is empty.
 *
 * @cssprop --cf-tab-bar-height - Height of the tab bar container; contributes to footer reserved space when slotted into `cf-screen`.
 * @cssprop --cf-tab-bar-inset-margin - Inset clearance from the screen edge; contributes to footer reserved space for inset footer bars.
 *
 * @example
 * const activeTab = cell("home");
 * <cf-tab-bar $value={activeTab}>
 *   <cf-tab-bar-item value="home" label="Home">
 *     <span slot="icon">&#127968;</span>
 *   </cf-tab-bar-item>
 * </cf-tab-bar>
 */
export class CFTabBar extends BaseElement {
  static override properties = {
    value: { attribute: false }, // Cell or string, not reflected as attribute
    position: { type: String, reflect: true },
    variant: { type: String, reflect: true },
    _hasAction: { state: true },
  };

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        /* Internal fallback defaults for footer tab-bar spacing. */
        --_cf-tab-bar-height-default: 4rem;
        --_cf-tab-bar-inset-margin-default: 1rem;
        --_cf-tab-bar-height: var(
          --cf-tab-bar-height,
          var(--_cf-tab-bar-height-default)
        );
        --_cf-tab-bar-inset-margin: var(
          --cf-tab-bar-inset-margin,
          var(--_cf-tab-bar-inset-margin-default)
        );

        display: block;
        position: fixed;
        z-index: var(--cf-tab-bar-z-index, 50);
      }

      :host([position="bottom"]) {
        bottom: 0;
        left: 0;
        right: 0;
      }

      :host([position="top"]) {
        top: 0;
        left: 0;
        right: 0;
      }

      /* === Container === */
      .container {
        display: flex;
        align-items: center;
        justify-content: center;
        height: var(--_cf-tab-bar-height);
        gap: var(--cf-spacing-2, 0.5rem);
        padding-inline: var(--cf-spacing-2, 0.5rem);
      }

      /* === Bar (nav items) - always the visual surface === */
      .bar {
        display: flex;
        align-items: center;
        flex: 1;
        height: 100%;
        background: var(--cf-tab-bar-background, rgba(241, 245, 249, 0.88));
        backdrop-filter: blur(var(--cf-tab-bar-backdrop-blur, 12px));
        -webkit-backdrop-filter: blur(var(--cf-tab-bar-backdrop-blur, 12px));
      }

      /* Default: bar spans full width with top/bottom border */
      :host([position="bottom"]:not([variant="inset"])) .bar {
        border-top: 1px solid
          var(--cf-tab-bar-border-color, var(--cf-theme-color-border, #e5e7eb));
      }

      :host([position="top"]:not([variant="inset"])) .bar {
        border-bottom: 1px solid
          var(--cf-tab-bar-border-color, var(--cf-theme-color-border, #e5e7eb));
      }

      :host([position="bottom"]) .container {
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }

      :host([position="top"]) .container {
        padding-top: env(safe-area-inset-top, 0px);
      }

      /* === Action slot === */
      .action {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        align-self: center;
      }

      .action.empty {
        display: none;
      }

      /* === Inset variant === */
      :host([variant="inset"]) {
        left: 0;
        right: 0;
      }

      :host([variant="inset"][position="bottom"]) {
        bottom: calc(
          var(--_cf-tab-bar-inset-margin) + env(safe-area-inset-bottom, 0px)
        );
      }

      :host([variant="inset"][position="top"]) {
        top: calc(var(--_cf-tab-bar-inset-margin) + env(safe-area-inset-top, 0px));
      }

      :host([variant="inset"]) .container {
        width: fit-content;
        margin: 0 auto;
        padding-bottom: 0;
      }

      :host([variant="inset"][position="top"]) .container {
        padding-top: 0;
      }

      :host([variant="inset"]) .bar {
        flex: 0 1 auto;
        border-radius: var(
          --cf-tab-bar-inset-radius,
          var(--cf-border-radius-full, 9999px)
        );
        box-shadow: var(
          --cf-shadow-lg,
          0 10px 15px -3px rgba(0, 0, 0, 0.1)
        );
        border: 1px solid
          var(--cf-tab-bar-border-color, var(--cf-theme-color-border, #e5e7eb));
        padding-inline: var(
          --cf-tab-bar-padding-inline,
          var(--cf-spacing-2, 0.5rem)
        );
      }

      :host([variant="inset"]) ::slotted(cf-tab-bar-item) {
        flex: 0 0 auto;
        min-width: 3.5rem;
      }

      /* Footer-slotted bars are in-flow so cf-screen can reserve space. */
      :host([slot="footer"]) {
        position: relative;
        top: auto;
        right: auto;
        bottom: auto;
        left: auto;
      }

      :host([slot="footer"][variant="inset"][position="bottom"]) {
        bottom: auto;
        padding-bottom: calc(
          var(--_cf-tab-bar-inset-margin) + env(safe-area-inset-bottom, 0px)
        );
      }

      :host([slot="footer"][variant="inset"][position="top"]) {
        top: auto;
        padding-top: calc(
          var(--_cf-tab-bar-inset-margin) + env(safe-area-inset-top, 0px)
        );
      }

      /* === Reduced Motion === */
      @media (prefers-reduced-motion: reduce) {
        .bar,
        .container {
          transition: none;
        }
      }
    `,
  ];

  declare value: CellHandle<string> | string;
  declare position: "bottom" | "top";
  declare variant: "default" | "inset";
  declare _hasAction: boolean;

  private _lastKnownValue: string = "";

  private _cellController = createStringCellController(this, {
    timing: { strategy: "immediate" },
    onChange: (newValue: string, oldValue: string) => {
      this._lastKnownValue = newValue;
      this.updateItemSelection();
      this.emit("cf-change", { value: newValue, oldValue });
    },
  });

  private _pendingRetry: number | null = null;

  constructor() {
    super();
    this.value = "";
    this.position = "bottom";
    this.variant = "default";
    this._hasAction = false;
  }

  override connectedCallback() {
    super.connectedCallback();

    this.setAttribute("role", "navigation");

    // Set default aria-label if not already set by the author
    if (!this.hasAttribute("aria-label")) {
      this.setAttribute("aria-label", "Main navigation");
    }

    this.addEventListener(
      "tab-bar-click",
      this._handleItemClick as EventListener,
    );
    this.addEventListener("keydown", this._handleKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener(
      "tab-bar-click",
      this._handleItemClick as EventListener,
    );
    this.removeEventListener("keydown", this._handleKeydown);
  }

  override firstUpdated() {
    this._cellController.bind(this.value, stringSchema);

    const slot = this.shadowRoot?.querySelector("slot");
    if (slot) {
      slot.addEventListener("slotchange", this._handleSlotChange);
    }

    this._lastKnownValue = this._cellController.getValue();
    this.updateItemSelection();
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);

    if (changedProperties.has("value")) {
      this._cellController.bind(this.value, stringSchema);
    }
  }

  override updated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.updated(changedProperties);

    const currentValue = this._cellController.getValue();
    if (currentValue !== this._lastKnownValue) {
      this._lastKnownValue = currentValue;
      this.updateItemSelection();
    }
  }

  override render() {
    return html`
      <div class="container" part="container">
        <div class="bar" part="bar">
          <slot></slot>
        </div>
        <div class="action ${this._hasAction ? "" : "empty"}" part="action">
          <slot name="action" @slotchange="${this
            ._handleActionSlotChange}"></slot>
        </div>
      </div>
    `;
  }

  private _handleActionSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    this._hasAction = slot.assignedElements().length > 0;
  };

  private _getItems(): NodeListOf<Element> {
    return this.querySelectorAll("cf-tab-bar-item");
  }

  updateItemSelection(): void {
    const items = this._getItems();
    const currentValue = this._cellController.getValue();

    // Defer selection until next frame if items exist but values aren't set yet
    if (
      items.length > 0 && (items[0] as CFTabBarItem).value === undefined
    ) {
      if (this._pendingRetry !== null) {
        cancelAnimationFrame(this._pendingRetry);
      }
      this._pendingRetry = requestAnimationFrame(() => {
        this._pendingRetry = null;
        this.updateItemSelection();
      });
      return;
    }

    items.forEach((item) => {
      const tabBarItem = item as CFTabBarItem;
      tabBarItem.selected = tabBarItem.value === currentValue;
    });
  }

  private _handleSlotChange = () => {
    this.updateItemSelection();
  };

  private _handleItemClick = (
    event: CustomEvent<{ item: CFTabBarItem }>,
  ): void => {
    const item = event.detail.item;
    if (item && item.value && !item.disabled) {
      const currentValue = this._cellController.getValue();
      if (currentValue !== item.value) {
        this._cellController.setValue(item.value);
      }
    }
  };

  private _handleKeydown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (target.tagName !== "CF-TAB-BAR-ITEM") return;

    const items = Array.from(this._getItems()) as CFTabBarItem[];
    const enabledItems = items.filter((item) => !item.disabled);

    if (enabledItems.length === 0) return;

    const currentIndex = enabledItems.findIndex((item) => item === target);
    let nextIndex = currentIndex;

    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? 0
          : (currentIndex + 1) % enabledItems.length;
        break;
      case "ArrowLeft":
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? enabledItems.length - 1
          : (currentIndex - 1 + enabledItems.length) % enabledItems.length;
        break;
      case "Home":
        event.preventDefault();
        nextIndex = 0;
        break;
      case "End":
        event.preventDefault();
        nextIndex = enabledItems.length - 1;
        break;
      default:
        return;
    }

    const nextItem = enabledItems[nextIndex];
    if (nextItem) {
      nextItem.focus();
      const button = nextItem.button;
      if (button) {
        button.click();
      } else {
        nextItem.click();
      }
    }
  };

  /**
   * Get the currently selected item value
   */
  getValue(): string {
    return this._cellController.getValue();
  }

  /**
   * Set the selected item by value
   */
  setValue(value: string): void {
    this._cellController.setValue(value);
  }
}
