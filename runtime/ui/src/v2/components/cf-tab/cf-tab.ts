import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFTab - Individual tab button component used within cf-tab-list
 *
 * @element cf-tab
 *
 * @attr {string} value - Unique identifier for the tab
 * @attr {boolean} disabled - Whether the tab is disabled
 * @attr {boolean} selected - Whether the tab is currently selected
 *
 * @slot - Default slot for tab label content
 *
 * @fires tab-click - Fired when tab is clicked with detail: { tab }
 *
 * @example
 * <cf-tab value="profile" selected>Profile</cf-tab>
 */
export class CFTab extends BaseElement {
  static override properties = {
    value: { type: String, reflect: true },
    disabled: { type: Boolean },
    selected: { type: Boolean },
  };
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-flex;
      }

      .tab {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
        border-radius: var(--cf-theme-border-radius, var(--cf-border-radius-md));
        padding: var(--cf-spacing-2) var(--cf-spacing-3);
        font-size: var(--cf-font-size-sm);
        font-weight: var(--cf-font-weight-medium);
        transition: all var(--cf-transition-duration-fast)
          var(--cf-transition-timing-ease);
        cursor: pointer;
        background: transparent;
        border: none;
        color: var(--cf-theme-color-text-muted, #6b7280);
        font-family: inherit;
        position: relative;
      }

      .tab:hover:not(:disabled) {
        color: var(--cf-theme-color-text, #111827);
      }

      .tab:focus-visible {
        outline: 2px solid
          var(--cf-theme-color-primary, var(--cf-colors-primary-500));
        outline-offset: 2px;
      }

      .tab:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .tab[data-selected="true"] {
        color: var(--cf-theme-color-text, #111827);
      }

      /* Indicator for selected state */
      .tab[data-selected="true"]::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: -1px;
        height: 2px;
        background-color: var(
          --cf-theme-color-primary,
          var(--cf-colors-primary-500)
        );
      }

      /* Vertical orientation styles */
      :host-context(cf-tab-list[orientation="vertical"]) .tab[data-selected="true"]::after {
        top: 0;
        bottom: 0;
        left: -1px;
        right: auto;
        width: 2px;
        height: auto;
      }

      /*
      ** Chip variant styles
      */

      /* Suppress underline indicator in chip mode */
      :host([data-variant="chip"]) .tab[data-selected="true"]::after {
        display: none;
      }

      /* Base chip tab styling */
      :host([data-variant="chip"]) .tab {
        border-radius: var(--cf-border-radius-full, 9999px);
        padding: var(--cf-pill-sm-padding-v, 2px) var(--cf-pill-sm-padding-h, 10px);
        font-size: var(--cf-pill-sm-font-size, var(--cf-size-sm-font-size, 11px));
        line-height: var(
          --cf-pill-sm-line-height,
          var(--cf-size-sm-line-height, 16px)
        );
        min-height: var(--cf-pill-sm-min-height, var(--cf-size-sm-height, 24px));
        color: var(--cf-theme-color-text-muted, #6b7280);
        background: transparent;
        border: 1px solid transparent;
        transition:
          background-color var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease),
          border-color var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease),
          color var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease);
      }

      /* Hover on unselected chip tab */
      :host([data-variant="chip"]) .tab:hover:not(:disabled):not([data-selected="true"]) {
        background: var(
          --cf-theme-color-surface-hover,
          var(--cf-colors-gray-200, #eceef1)
        );
        color: var(--cf-theme-color-text, #111827);
      }

      /* Selected chip tab - filled pill appearance */
      :host([data-variant="chip"]) .tab[data-selected="true"] {
        background: var(
          --cf-theme-color-surface,
          var(--cf-colors-gray-100, #f2f3f6)
        );
        border: 1px solid
          var(
          --cf-theme-color-border,
          var(--cf-colors-gray-300, #d5d7dd)
        );
        color: var(--cf-theme-color-text, var(--cf-colors-gray-900, #16181d));
        font-weight: var(--cf-font-weight-medium, 500);
      }
    `,
  ];

  declare value: string;
  declare disabled: boolean;
  declare selected: boolean;

  private _button: HTMLButtonElement | null = null;

  constructor() {
    super();
    this.value = "";
    this.disabled = false;
    this.selected = false;
  }

  get button(): HTMLButtonElement | null {
    if (!this._button) {
      this._button =
        this.shadowRoot?.querySelector(".tab") as HTMLButtonElement || null;
    }
    return this._button;
  }

  override connectedCallback() {
    super.connectedCallback();

    // Set ARIA attributes
    this.setAttribute("role", "tab");
    this.updateAriaAttributes();
  }

  override updated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.updated(changedProperties);

    if (
      changedProperties.has("selected") || changedProperties.has("disabled")
    ) {
      this.updateAriaAttributes();
    }
  }

  override render() {
    return html`
      <button
        class="tab"
        part="tab"
        ?disabled="${this.disabled}"
        data-selected="${this.selected}"
        data-disabled="${this.disabled}"
        @click="${this.handleClick}"
      >
        <slot></slot>
      </button>
    `;
  }

  private updateAriaAttributes(): void {
    this.setAttribute("aria-selected", String(this.selected));
    this.setAttribute("aria-disabled", String(this.disabled));
    this.setAttribute(
      "tabindex",
      this.selected && !this.disabled ? "0" : "-1",
    );
  }

  private handleClick = (event: Event): void => {
    if (this.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Emit custom event for parent tabs component
    this.emit("tab-click", { tab: this });
  };

  /**
   * Focus the tab button
   */
  override focus(): void {
    this.button?.focus();
  }

  /**
   * Blur the tab button
   */
  override blur(): void {
    this.button?.blur();
  }
}
