import { css, html, nothing } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFTabBarItem - Individual navigation item for cf-tab-bar
 *
 * @element cf-tab-bar-item
 *
 * @attr {string} value - Unique identifier for this item
 * @attr {string} label - Text label rendered below the icon
 * @attr {boolean} hide-label - Hide the text label for icon-only items (default: false).
 * @attr {boolean} disabled - Prevents selection and keyboard navigation
 * @prop {boolean} selected - Set by parent bar when this item is active
 *
 * @slot icon - Icon content (emoji, SVG, or glyph), rendered above the label
 * @slot - Alternative label content; overrides the label attribute when present
 *
 * @fires tab-bar-click - Fired when item is clicked with detail: { item }
 */
export class CFTabBarItem extends BaseElement {
  static override properties = {
    value: { type: String, reflect: true },
    label: { type: String, reflect: true },
    hideLabel: { type: Boolean, reflect: true, attribute: "hide-label" },
    disabled: { type: Boolean, reflect: true },
    selected: { type: Boolean },
  };

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-flex;
        flex: 1;
      }

      .item {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--cf-tab-bar-item-gap, var(--cf-spacing-1, 0.25rem));
        width: 100%;
        border: none;
        background: transparent;
        cursor: pointer;
        padding: var(--cf-spacing-1, 0.25rem) var(--cf-spacing-2, 0.5rem);
        color: var(
          --cf-tab-bar-item-color,
          var(--cf-theme-color-text-muted, #6b7280)
        );
        font-family: inherit;
        transition: all var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease);
      }

      .item:focus-visible {
        outline: 2px solid
          var(--cf-theme-color-primary, var(--cf-colors-primary-500));
        outline-offset: 2px;
        border-radius: var(--cf-border-radius-sm, 0.25rem);
      }

      .item[data-selected="true"] {
        color: var(
          --cf-tab-bar-item-color-active,
          var(--cf-theme-color-primary, var(--cf-colors-primary-500))
        );
      }

      .item:disabled,
      .item[aria-disabled="true"] {
        opacity: 0.5;
        cursor: not-allowed;
        pointer-events: none;
      }

      .icon {
        display: flex;
        align-items: center;
        justify-content: center;
        height: var(--cf-tab-bar-item-icon-size, 1.5rem);
      }

      .label {
        font-size: var(
          --cf-tab-bar-item-label-size,
          var(--cf-font-size-xs, 0.75rem)
        );
        line-height: 1;
        white-space: nowrap;
      }

      @media (prefers-reduced-motion: reduce) {
        .item {
          transition: none;
        }
      }
    `,
  ];

  declare value: string;
  declare label: string;
  declare hideLabel: boolean;
  declare disabled: boolean;
  declare selected: boolean;

  private _button: HTMLButtonElement | null = null;

  constructor() {
    super();
    this.value = "";
    this.label = "";
    this.hideLabel = false;
    this.disabled = false;
    this.selected = false;
  }

  get button(): HTMLButtonElement | null {
    if (!this._button) {
      this._button =
        (this.shadowRoot?.querySelector(".item") as HTMLButtonElement) ||
        null;
    }
    return this._button;
  }

  override updated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.updated(changedProperties);

    if (
      changedProperties.has("selected") || changedProperties.has("disabled")
    ) {
      this._updateAriaAttributes();
    }
  }

  override render() {
    return html`
      <button
        type="button"
        class="item"
        ?disabled="${this.disabled}"
        part="item"
        data-selected="${this.selected}"
        aria-label="${this.hideLabel ? this.label : nothing}"
        @click="${this._handleClick}"
      >
        <div class="icon" part="icon" aria-hidden="true">
          <slot name="icon"></slot>
        </div>
        ${this.hideLabel ? "" : html`
          <div class="label" part="label">
            <slot>${this.label}</slot>
          </div>
        `}
      </button>
    `;
  }

  private _updateAriaAttributes(): void {
    const button = this.button;
    if (!button) return;

    if (this.selected) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }

    if (this.disabled) {
      button.setAttribute("aria-disabled", "true");
      button.setAttribute("tabindex", "-1");
    } else {
      button.removeAttribute("aria-disabled");
      button.setAttribute("tabindex", this.selected ? "0" : "-1");
    }

    // Also update data-selected on host for ::part() CSS selectors
    if (this.selected) {
      this.setAttribute("data-selected", "true");
    } else {
      this.removeAttribute("data-selected");
    }
  }

  private _handleClick = (event: Event): void => {
    if (this.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    this.emit("tab-bar-click", { item: this });
  };

  /**
   * Focus the inner button
   */
  override focus(): void {
    this.button?.focus();
  }

  /**
   * Blur the inner button
   */
  override blur(): void {
    this.button?.blur();
  }
}
