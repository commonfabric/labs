/**
 * @component cf-radio-group
 * @description Container for managing multiple radio buttons with keyboard navigation support.
 * Supports both declarative items array and slotted cf-radio elements.
 *
 * @tag cf-radio-group
 *
 * @attribute {string} name - The name for all radio buttons in the group
 * @attribute {string} value - The currently selected radio button value
 * @attribute {boolean} disabled - Whether all radio buttons in the group are disabled
 * @attribute {string} orientation - Layout orientation: "vertical" (default) or "horizontal"
 *
 * @property {RadioItem[]} items - Array of items to render as radio buttons (alternative to slotted cf-radio elements)
 * @property {CellHandle<unknown>|unknown} value - Selected value - supports both Cell and plain values for bidirectional binding
 *
 * @event {CustomEvent} cf-change - Fired when the selected radio changes
 * @event-detail {Object} detail - Event detail object
 * @event-detail {unknown} detail.value - The value of the newly selected radio
 *
 * @slot default - Container for cf-radio elements (used when items prop is not provided)
 *
 * @csspart group - The radio group container element
 * @csspart item - Individual radio item container (when using items prop)
 * @csspart radio - The radio button element (when using items prop)
 * @csspart label - The label element (when using items prop)
 *
 * @example
 * ```html
 * <!-- Simple usage with items array (recommended) -->
 * <cf-radio-group
 *   items='[{"label":"Small","value":"small"},{"label":"Medium","value":"medium"},{"label":"Large","value":"large"}]'
 *   value="medium"
 * ></cf-radio-group>
 *
 * <!-- With bidirectional binding in patterns -->
 * <cf-radio-group
 *   $value={selectedSize}
 *   .items=${[
 *     { label: "Small", value: "small" },
 *     { label: "Medium", value: "medium" },
 *     { label: "Large", value: "large" },
 *   ]}
 *   orientation="horizontal"
 * />
 *
 * <!-- Using slotted cf-radio elements (for custom rendering) -->
 * <cf-radio-group name="size" value="medium">
 *   <cf-radio value="small">Small</cf-radio>
 *   <cf-radio value="medium">Medium</cf-radio>
 *   <cf-radio value="large">Large</cf-radio>
 * </cf-radio-group>
 * ```
 *
 * @accessibility
 * - Uses role="radiogroup" for proper screen reader support
 * - Keyboard navigation with the arrow keys: Down and Right select the next radio, Up and Left the previous
 * - Manages focus and selection state for radio buttons
 * - Automatically assigns group name to child radios if not specified
 *
 * @methods
 * - getValue() - Get the currently selected radio value
 * - setValue(value) - Set the selected radio by value
 * - clear() - Clear the selection
 */

import type { CellHandle } from "@commonfabric/runtime-client";
import { html, PropertyValues, unsafeCSS } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import type { CFRadio } from "../cf-radio/cf-radio.ts";
import { applyThemeToElement, type CFTheme } from "../theme-context.ts";
import { radioGroupStyles } from "./styles.ts";

// TODO(v2-token-migration): Migrate this component to component-level tokens,
// matching the prior phase-1 token migration pattern.

/**
 * Represents a single radio option item
 */
export interface RadioItem {
  /** Text shown to the user */
  label: string;

  /** Value returned when this option is selected */
  value: unknown;

  /** Disabled state for this option */
  disabled?: boolean;
}

export type RadioGroupOrientation = "vertical" | "horizontal";

export class CFRadioGroup extends BaseElement {
  static override styles = unsafeCSS(radioGroupStyles);

  /** Cell controller for value binding */
  #cellController = createCellController<unknown>(this, {
    timing: { strategy: "immediate" }, // Radio changes should be immediate
    onChange: (newValue, oldValue) => {
      this.#syncRadios();

      // Emit change events
      this.emit("cf-change", {
        value: newValue,
        oldValue,
        items: this.items,
      });

      this.emit("change", {
        value: newValue,
        oldValue,
        items: this.items,
      });
    },
  });

  static override properties = {
    name: { type: String },
    disabled: { type: Boolean, reflect: true },
    orientation: { type: String, reflect: true },

    // Non-attribute properties
    items: { attribute: false },
    value: { attribute: false },
  };

  declare name: string;
  declare disabled: boolean;
  declare orientation: RadioGroupOrientation;
  declare items: RadioItem[];
  declare value: CellHandle<unknown> | unknown;

  /** Radios the group disabled, which it enables again once it is enabled. */
  #disabledRadios = new WeakSet<CFRadio>();

  constructor() {
    super();
    this.name = "";
    this.disabled = false;
    this.orientation = "vertical";
    this.items = [];
    this.value = undefined;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Set ARIA attributes
    this.setAttribute("role", "radiogroup");

    // Add event listeners for slotted cf-radio elements
    this.addEventListener("radio-click", this.#handleRadioClick);
    this.addEventListener("keydown", this.#handleKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up event listeners
    this.removeEventListener("radio-click", this.#handleRadioClick);
    this.removeEventListener("keydown", this.#handleKeydown);
  }

  /**
   * A theme given to this element directly, written over the theme it would
   * otherwise inherit. Left unset, the element draws the ambient theme.
   */
  @property({ attribute: false })
  accessor theme: CFTheme | undefined = undefined;

  override willUpdate(changedProperties: Map<string, unknown>) {
    super.willUpdate(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      this.#cellController.bind(this.value);
    }
  }

  override updated(changedProperties: PropertyValues) {
    this.#syncRadios();
    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme);
    }
  }

  override render() {
    // If items are provided, render them directly
    if (this.items && this.items.length > 0) {
      return html`
        <div class="radio-group" part="group">
          ${this.items.map((item, index) => this.#renderItem(item, index))}
        </div>
      `;
    }

    // Otherwise, use slot for cf-radio children
    return html`
      <div class="radio-group" part="group">
        <slot @slotchange="${this.#syncRadios}"></slot>
      </div>
    `;
  }

  #renderItem(item: RadioItem, index: number) {
    const currentValue = this.#getCurrentValue();
    const isChecked = areLinksSame(currentValue, item.value);
    const isDisabled = this.disabled || item.disabled;
    const itemId = `radio-${this.name || "group"}-${index}`;

    return html`
      <label
        class="radio-item ${isChecked ? "checked" : ""} ${isDisabled
          ? "disabled"
          : ""}"
        part="item"
        for="${itemId}"
      >
        <input
          type="radio"
          id="${itemId}"
          name="${this.name || `radio-group-${this.#uniqueId}`}"
          .checked="${isChecked}"
          ?disabled="${isDisabled}"
          @change="${() => this.#handleItemChange(item)}"
          @keydown="${this.#handleItemKeydown}"
          part="radio"
        />
        <span class="radio-indicator" part="indicator">
          <span class="radio-dot"></span>
        </span>
        <span class="radio-label" part="label">${item.label}</span>
      </label>
    `;
  }

  #uniqueId = Math.random().toString(36).substring(2, 9);

  #handleItemChange(item: RadioItem) {
    if (this.disabled || item.disabled) return;
    this.#cellController.setValue(item.value);
  }

  #handleItemKeydown = (event: KeyboardEvent) => {
    const inputs = this.shadowRoot?.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    ) ?? [];
    this.#arrowTo(event, Array.from(inputs).filter((input) => !input.disabled));
  };

  /**
   * Brings the slotted radios in line with the group: names each one that has
   * no name of its own, checks the one holding the group's value, and
   * disables them all while the group is disabled.
   */
  #syncRadios(): void {
    const currentValue = this.#getCurrentValue();
    for (const radio of this.querySelectorAll("cf-radio")) {
      if (this.name && !radio.name) radio.name = this.name;
      radio.checked = areLinksSame(radio.value, currentValue);
      if (this.disabled && !radio.disabled) {
        radio.disabled = true;
        this.#disabledRadios.add(radio);
      } else if (!this.disabled && this.#disabledRadios.delete(radio)) {
        radio.disabled = false;
      }
    }
  }

  #handleRadioClick = (event: CustomEvent<{ radio: CFRadio }>): void => {
    const { value } = event.detail.radio;
    if (value) this.#cellController.setValue(value);
  };

  #handleKeydown = (event: KeyboardEvent): void => {
    // Only handle for slotted radios
    if (this.items && this.items.length > 0) return;

    const radios = Array.from(this.querySelectorAll("cf-radio"));
    this.#arrowTo(event, radios.filter((radio) => !radio.disabled));
  };

  /**
   * Focuses and selects the enabled radio after the event's target for Down
   * and Right, or the one before it for Up and Left, wrapping at either end.
   * From a target that is none of them, it goes to the first or the last.
   */
  #arrowTo(event: KeyboardEvent, enabled: readonly HTMLElement[]): void {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight"
      ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
      ? -1
      : 0;
    if (step === 0 || enabled.length === 0) return;

    event.preventDefault();
    const current = enabled.findIndex((radio) => radio === event.target);
    const from = current === -1 && step === -1 ? 0 : current;
    const next = enabled[(from + step + enabled.length) % enabled.length];
    next.focus();
    next.click();
  }

  /**
   * Get the current value from the cell controller
   */
  #getCurrentValue(): unknown {
    return this.#cellController.getValue();
  }

  /**
   * Get the currently selected radio value
   */
  getValue(): unknown {
    return this.#getCurrentValue();
  }

  /**
   * Set the selected radio by value
   */
  setValue(value: unknown): void {
    this.#cellController.setValue(value);
  }

  /**
   * Clear the selection
   */
  clear(): void {
    this.#cellController.setValue(undefined);
  }
}

/** Simple value equality for comparing radio values (strings, numbers, etc.) */
function areLinksSame(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  // Compare stringified values for attribute-based comparisons
  return String(a) === String(b);
}
