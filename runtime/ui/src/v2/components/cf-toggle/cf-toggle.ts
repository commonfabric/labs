import { html, PropertyValues, unsafeCSS } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { HostActivationController } from "../../core/host-activation-controller.ts";
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

  #activation = new HostActivationController(this, {
    role: "button",
    keys: ["Enter", " "],
    isDisabled: () => this.disabled,
    activate: () => {
      this.pressed = !this.pressed;
      this.emit("cf-change", { pressed: this.pressed });
    },
  });

  constructor() {
    super();
    this.pressed = false;
    this.disabled = false;
    this.variant = "default";
    this.size = "md";
    this.ariaLabel = "";
  }

  override updated(changedProperties: PropertyValues) {
    // cf-change is emitted on activation only — NOT here.
    // Emitting from updated() causes infinite loops when a parent
    // (cf-toggle-group) programmatically sets pressed.
    if (changedProperties.has("pressed")) {
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
    if (!this.hasAttribute("exportparts")) {
      this.setAttribute("exportparts", "toggle");
    }
    super.connectedCallback();
    this._updateAriaAttributes();
  }

  private _updateAriaAttributes(): void {
    this.setAttribute("aria-pressed", this.pressed ? "true" : "false");
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

  /**
   * Toggle the pressed state programmatically
   */
  toggle(): void {
    if (!this.disabled) {
      this.pressed = !this.pressed;
    }
  }
}
