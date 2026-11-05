import { html, PropertyValues, unsafeCSS } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { oneOf } from "../../core/property-guards.ts";
import { toggleStyles } from "./styles.ts";

/** @deprecated Use ComponentSize instead */
export type ToggleSize = "sm" | "md" | "lg";

/**
 * CFToggle - Toggle button that can be pressed/unpressed with multiple variants and sizes
 *
 * @element cf-toggle
 *
 * @attr {boolean} pressed - Whether the toggle is pressed
 * @attr {boolean} disabled - Whether the toggle is disabled
 * @attr {string} variant - Visual style variant: "default" | "outline"
 * @attr {string} size - Toggle size: "sm" | "md" | "lg" (default: "md")
 * @attr {string} value - Value attribute for use in toggle groups
 *
 * @slot - Default slot for toggle content
 *
 * @fires cf-change - Fired on toggle with detail: { pressed }
 *
 * @example
 * <cf-toggle pressed>Bold</cf-toggle>
 */
export type ToggleVariant = "default" | "outline";

const toggleVariants = ["default", "outline"] as const;
const toggleSizes = ["sm", "md", "lg"] as const;

export class CFToggle extends BaseElement {
  // No delegatesFocus — the host owns role="button", tabindex, and all
  // event handlers. Focus stays on the host; the inner button is purely
  // visual and aria-hidden.

  static override properties = {
    pressed: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    variant: { type: String },
    size: { type: String },
    ariaLabel: { type: String, attribute: "aria-label" },
  };
  static override styles = unsafeCSS(toggleStyles);

  declare pressed: boolean;
  declare disabled: boolean;
  declare variant: ToggleVariant;
  declare size: "sm" | "md" | "lg";
  declare ariaLabel: string;

  private _buttonElement: HTMLButtonElement | null = null;

  constructor() {
    super();
    this.pressed = false;
    this.disabled = false;
    this.variant = "default";
    this.size = "md";
    this.ariaLabel = "";
  }

  get buttonElement(): HTMLButtonElement | null {
    if (!this._buttonElement) {
      this._buttonElement =
        this.shadowRoot?.querySelector("button") as HTMLButtonElement || null;
    }
    return this._buttonElement;
  }

  override updated(changedProperties: PropertyValues) {
    // cf-change is emitted from click/keydown handlers only — NOT here.
    // Emitting from updated() causes infinite loops when a parent
    // (cf-toggle-group) programmatically sets pressed.
    if (changedProperties.has("pressed") || changedProperties.has("disabled")) {
      this._updateAriaAttributes();
    }
  }

  protected override willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);
    if (changedProperties.has("variant") || changedProperties.has("size")) {
      this.variant = oneOf(this.variant, toggleVariants, "default");
      this.size = oneOf(this.size, toggleSizes, "md");
    }
  }

  override connectedCallback() {
    if (!this.hasAttribute("role")) {
      this.setAttribute("role", "button");
    }
    if (!this.hasAttribute("exportparts")) {
      this.setAttribute("exportparts", "toggle");
    }
    super.connectedCallback();
    this._updateAriaAttributes();

    // Add event listeners
    this.addEventListener("click", this.handleClick);
    this.addEventListener("keydown", this.handleKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up event listeners
    this.removeEventListener("click", this.handleClick);
    this.removeEventListener("keydown", this.handleKeydown);
  }

  private _updateAriaAttributes(): void {
    this.setAttribute("aria-pressed", this.pressed ? "true" : "false");
    this.setAttribute("aria-disabled", this.disabled ? "true" : "false");
    this.tabIndex = this.disabled ? -1 : 0;
  }

  override render() {
    const classes = {
      toggle: true,
      [`variant-${this.variant}`]: true,
      [`size-${this.size}`]: true,
      pressed: this.pressed,
    };

    return html`
      <!-- aria-hidden and tabindex="-1" prevent the inner button from creating a
        duplicate interactive role — the host element already exposes role="button"
        with all ARIA attributes to the accessibility tree. -->
      <button
        type="button"
        class="${classMap(classes)}"
        ?disabled="${this.disabled}"
        aria-hidden="true"
        tabindex="-1"
        part="toggle"
      >
        <slot></slot>
      </button>
    `;
  }

  private handleClick = (event: Event): void => {
    if (this.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    this.pressed = !this.pressed;
    this.emit("cf-change", { pressed: this.pressed });
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    if (this.disabled) return;

    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      this.pressed = !this.pressed;
      this.emit("cf-change", { pressed: this.pressed });
    }
  };

  /**
   * Toggle the pressed state programmatically
   */
  toggle(): void {
    if (!this.disabled) {
      this.pressed = !this.pressed;
    }
  }

  /**
   * Focus the toggle programmatically
   */
  override focus(): void {
    super.focus();
  }

  /**
   * Blur the toggle programmatically
   */
  override blur(): void {
    super.blur();
  }
}
