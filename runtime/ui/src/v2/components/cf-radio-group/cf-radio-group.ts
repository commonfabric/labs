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
 * - Keyboard navigation with arrow keys (Up/Down for vertical, Left/Right for horizontal)
 * - Manages focus and selection state for radio buttons
 * - Automatically assigns group name to child radios if not specified
 *
 * @methods
 * - getValue() - Get the currently selected radio value
 * - setValue(value) - Set the selected radio by value
 * - clear() - Clear the selection
 */

import { type CellHandle } from "@commonfabric/runtime-client";
import { html, PropertyValues, unsafeCSS } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
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
  private _cellController = createCellController<unknown>(this, {
    timing: { strategy: "immediate" }, // Radio changes should be immediate
    onChange: (newValue, oldValue) => {
      // Sync selection to DOM (for slotted radios)
      this.updateRadioSelection();

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
    this.addEventListener("radio-click", this.handleRadioClick);
    this.addEventListener("keydown", this.handleKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up event listeners
    this.removeEventListener("radio-click", this.handleRadioClick);
    this.removeEventListener("keydown", this.handleKeydown);
  }

  /**
   * A theme given to this element directly, written over the theme it would
   * otherwise inherit. Left unset, the element draws the ambient theme.
   */
  @property({ attribute: false })
  accessor theme: CFTheme | undefined = undefined;

  override firstUpdated() {
    // Initialize cell controller binding
    this._cellController.bind(this.value);

    // Update slotted radios if present
    this.updateRadioNames();
    this.updateRadioSelection();
    this.updateRadioDisabled();
  }

  override willUpdate(changedProperties: Map<string, unknown>) {
    super.willUpdate(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      this._cellController.bind(this.value);
    }
  }

  override updated(changedProperties: PropertyValues) {
    if (changedProperties.has("name")) {
      this.updateRadioNames();
    }
    if (changedProperties.has("value") || changedProperties.has("items")) {
      this.updateRadioSelection();
    }
    if (changedProperties.has("disabled")) {
      this.updateRadioDisabled();
    }
    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme);
    }
  }

  override render() {
    // If items are provided, render them directly
    if (this.items && this.items.length > 0) {
      return html`
        <div class="radio-group" part="group">
          ${this.items.map((item, index) => this._renderItem(item, index))}
        </div>
      `;
    }

    // Otherwise, use slot for cf-radio children
    return html`
      <div class="radio-group" part="group">
        <slot @slotchange="${this.handleSlotChange}"></slot>
      </div>
    `;
  }

  private _renderItem(item: RadioItem, index: number) {
    const currentValue = this.getCurrentValue();
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
          name="${this.name || `radio-group-${this._uniqueId}`}"
          .checked="${isChecked}"
          ?disabled="${isDisabled}"
          @change="${() => this._handleItemChange(item)}"
          @keydown="${this._handleItemKeydown}"
          part="radio"
        />
        <span class="radio-indicator" part="indicator">
          <span class="radio-dot"></span>
        </span>
        <span class="radio-label" part="label">${item.label}</span>
      </label>
    `;
  }

  private _uniqueId = Math.random().toString(36).substring(2, 9);

  private _handleItemChange(item: RadioItem) {
    if (this.disabled || item.disabled) return;
    this._cellController.setValue(item.value);
  }

  private _handleItemKeydown = (event: KeyboardEvent) => {
    const inputs = Array.from(
      this.shadowRoot?.querySelectorAll('input[type="radio"]') || [],
    ) as HTMLInputElement[];
    const enabledInputs = inputs.filter((input) => !input.disabled);

    if (enabledInputs.length === 0) return;

    const currentIndex = enabledInputs.findIndex(
      (input) => input === event.target,
    );
    let nextIndex = currentIndex;

    const isHorizontal = this.orientation === "horizontal";
    const nextKey = isHorizontal ? "ArrowRight" : "ArrowDown";
    const prevKey = isHorizontal ? "ArrowLeft" : "ArrowUp";

    switch (event.key) {
      case nextKey:
      case (isHorizontal ? "ArrowDown" : "ArrowRight"):
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? 0
          : (currentIndex + 1) % enabledInputs.length;
        break;
      case prevKey:
      case (isHorizontal ? "ArrowUp" : "ArrowLeft"):
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? enabledInputs.length - 1
          : (currentIndex - 1 + enabledInputs.length) % enabledInputs.length;
        break;
      default:
        return;
    }

    // Focus and select the next radio
    const nextInput = enabledInputs[nextIndex];
    if (nextInput) {
      nextInput.focus();
      nextInput.click();
    }
  };

  private handleSlotChange = () => {
    this.updateRadioNames();
    this.updateRadioSelection();
    this.updateRadioDisabled();
  };

  private getRadios(): NodeListOf<Element> {
    return this.querySelectorAll("cf-radio");
  }

  private updateRadioNames(): void {
    if (!this.name) return;

    const radios = this.getRadios();
    radios.forEach((radio) => {
      if (!radio.hasAttribute("name")) {
        radio.setAttribute("name", this.name);
      }
    });
  }

  private updateRadioSelection(): void {
    const radios = this.getRadios();
    const currentValue = this.getCurrentValue();

    radios.forEach((radio) => {
      const radioValue = radio.getAttribute("value");
      const isSelected = areLinksSame(radioValue, currentValue);
      if (isSelected) {
        radio.setAttribute("checked", "");
        (radio as any).checked = true;
      } else {
        radio.removeAttribute("checked");
        (radio as any).checked = false;
      }
    });
  }

  private updateRadioDisabled(): void {
    const radios = this.getRadios();
    radios.forEach((radio) => {
      if (this.disabled) {
        radio.setAttribute("disabled", "");
        (radio as any).disabled = true;
      } else if (!radio.hasAttribute("disabled")) {
        // Only enable if the radio itself doesn't have disabled attribute
        (radio as any).disabled = false;
      }
    });
  }

  private handleRadioClick = (event: Event): void => {
    const customEvent = event as CustomEvent;
    const radio = customEvent.detail.radio;

    if (radio && radio.getAttribute("value")) {
      this._cellController.setValue(radio.getAttribute("value"));
    }
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    // Only handle for slotted radios
    if (this.items && this.items.length > 0) return;

    const radios = Array.from(this.getRadios()) as HTMLElement[];
    const enabledRadios = radios.filter(
      (radio) => !radio.hasAttribute("disabled"),
    );

    if (enabledRadios.length === 0) return;

    const currentIndex = enabledRadios.findIndex(
      (radio) => radio === document.activeElement,
    );
    let nextIndex = currentIndex;

    const isHorizontal = this.orientation === "horizontal";
    const nextKey = isHorizontal ? "ArrowRight" : "ArrowDown";
    const prevKey = isHorizontal ? "ArrowLeft" : "ArrowUp";

    switch (event.key) {
      case nextKey:
      case (isHorizontal ? "ArrowDown" : "ArrowRight"):
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? 0
          : (currentIndex + 1) % enabledRadios.length;
        break;
      case prevKey:
      case (isHorizontal ? "ArrowUp" : "ArrowLeft"):
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? enabledRadios.length - 1
          : (currentIndex - 1 + enabledRadios.length) % enabledRadios.length;
        break;
      default:
        return;
    }

    // Focus and select the next radio
    const nextRadio = enabledRadios[nextIndex];
    if (nextRadio) {
      nextRadio.focus();
      // Trigger click to select the radio
      nextRadio.click();
    }
  };

  /**
   * Get the current value from the cell controller
   */
  private getCurrentValue(): unknown {
    return this._cellController.getValue();
  }

  /**
   * Get the currently selected radio value
   */
  getValue(): unknown {
    return this.getCurrentValue();
  }

  /**
   * Set the selected radio by value
   */
  setValue(value: unknown): void {
    this._cellController.setValue(value);
  }

  /**
   * Clear the selection
   */
  clear(): void {
    this._cellController.setValue(undefined);
  }
}

/** Simple value equality for comparing radio values (strings, numbers, etc.) */
function areLinksSame(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  // Compare stringified values for attribute-based comparisons
  return String(a) === String(b);
}
