import { html, PropertyValues, unsafeCSS } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { toggleGroupStyles } from "./styles.ts";

/**
 * CFToggleGroup - Container for managing multiple toggle buttons with single or multiple selection
 *
 * @element cf-toggle-group
 *
 * @attr {string} type - Selection type: "single" | "multiple"
 * @attr {string} value - Currently selected value(s) - string for single, comma-separated for multiple
 * @attr {boolean} disabled - Whether all toggles in the group are disabled
 *
 * @slot - Default slot for cf-toggle elements
 *
 * @fires cf-change - Fired on selection change with detail: { value }
 *
 * @example
 * <cf-toggle-group type="single" value="bold">
 *   <cf-toggle value="bold">Bold</cf-toggle>
 *   <cf-toggle value="italic">Italic</cf-toggle>
 *   <cf-toggle value="underline">Underline</cf-toggle>
 * </cf-toggle-group>
 */
export type ToggleGroupType = "single" | "multiple";

export class CFToggleGroup extends BaseElement {
  static override styles = unsafeCSS(toggleGroupStyles);

  static override properties = {
    type: { type: String },
    value: { type: String },
    disabled: { type: Boolean, reflect: true },
  };

  declare type: ToggleGroupType;
  declare value: string | string[];
  declare disabled: boolean;

  constructor() {
    super();
    this.type = "single";
    this.value = "";
    this.disabled = false;
  }

  override willUpdate(changedProperties: PropertyValues) {
    if (changedProperties.has("type") && !changedProperties.has("value")) {
      // Reset value when type changes
      this.value = this.type === "multiple" ? [] : "";
    }

    // Parse value from attribute for multiple type
    if (
      changedProperties.has("value") && typeof this.value === "string" &&
      this.type === "multiple"
    ) {
      const valueAttr = this.getAttribute("value");
      if (valueAttr) {
        this.value = valueAttr.split(",").filter((v) => v);
      }
    }
  }

  override updated(changedProperties: PropertyValues) {
    if (changedProperties.has("type") || changedProperties.has("value")) {
      this.updateToggleSelection();

      // Update attribute for persistence
      if (this.type === "single" && typeof this.value === "string") {
        this.setAttribute("value", this.value);
      } else if (this.type === "multiple" && Array.isArray(this.value)) {
        this.setAttribute("value", this.value.join(","));
      }

      // Emit change if value changed
      if (changedProperties.has("value")) {
        const oldValue = changedProperties.get("value");
        const changed = this.type === "single"
          ? oldValue !== this.value
          : JSON.stringify(oldValue) !== JSON.stringify(this.value);

        if (changed && oldValue !== undefined) {
          this.emit("cf-change", { value: this.value });
        }
      }
    }

    if (changedProperties.has("disabled")) {
      this.updateToggleDisabled();
    }
  }

  override connectedCallback() {
    super.connectedCallback();

    // Parse value attribute for multiple type
    const valueAttr = this.getAttribute("value");
    if (valueAttr && this.type === "multiple") {
      this.value = valueAttr.split(",").filter((v) => v);
    }

    // Set ARIA attributes
    this.setAttribute("role", "group");

    // Add event listeners
    this.addEventListener("cf-change", this.handleToggle);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up event listeners
    this.removeEventListener("cf-change", this.handleToggle);
  }

  override firstUpdated() {
    this.updateToggleSelection();
    this.updateToggleDisabled();
  }

  override render() {
    return html`
      <div class="toggle-group" part="group">
        <slot @slotchange="${this.handleSlotChange}"></slot>
      </div>
    `;
  }

  private handleSlotChange = () => {
    this.updateToggleSelection();
    this.updateToggleDisabled();
  };

  private getToggles(): NodeListOf<Element> {
    return this.querySelectorAll("cf-toggle");
  }

  private updateToggleSelection(): void {
    const toggles = this.getToggles();

    toggles.forEach((toggle) => {
      const toggleValue = toggle.getAttribute("value") ||
        toggle.textContent?.trim() || "";

      if (this.type === "single") {
        const isPressed = toggleValue === this.value;
        toggle.setAttribute("pressed", isPressed ? "" : "false");
        (toggle as any).pressed = isPressed;
      } else if (this.type === "multiple" && Array.isArray(this.value)) {
        const isPressed = this.value.includes(toggleValue);
        toggle.setAttribute("pressed", isPressed ? "" : "false");
        (toggle as any).pressed = isPressed;
      }
    });
  }

  private updateToggleDisabled(): void {
    const toggles = this.getToggles();
    toggles.forEach((toggle) => {
      if (this.disabled) {
        toggle.setAttribute("disabled", "");
        (toggle as any).disabled = true;
      } else if (!toggle.hasAttribute("disabled")) {
        // Only enable if the toggle itself doesn't have disabled attribute
        (toggle as any).disabled = false;
      }
    });
  }

  private handleToggle = (event: Event): void => {
    const customEvent = event as CustomEvent;
    const toggle = event.target as Element;

    if (!toggle || !toggle.matches("cf-toggle")) return;
    event.stopPropagation();

    const toggleValue = toggle.getAttribute("value") ||
      toggle.textContent?.trim() || "";
    const isPressed = customEvent.detail.pressed;

    if (this.type === "single") {
      if (isPressed) {
        // Select this toggle, deselect others
        this.value = toggleValue;
      } else {
        // Allow deselecting in single mode
        this.value = "";
      }
    } else if (this.type === "multiple") {
      const currentValues = Array.isArray(this.value) ? [...this.value] : [];

      if (isPressed) {
        // Add to selection if not already present
        if (!currentValues.includes(toggleValue)) {
          currentValues.push(toggleValue);
        }
      } else {
        // Remove from selection
        const index = currentValues.indexOf(toggleValue);
        if (index > -1) {
          currentValues.splice(index, 1);
        }
      }

      this.value = currentValues;
    }
  };

  /**
   * Get the currently selected value(s)
   */
  getValue(): string | string[] {
    return this.value;
  }

  /**
   * Set the selected value(s)
   */
  setValue(value: string | string[]): void {
    this.value = value;
  }

  /**
   * Clear all selections
   */
  clear(): void {
    this.value = this.type === "multiple" ? [] : "";
  }

  /**
   * Select all toggles (multiple mode only)
   */
  selectAll(): void {
    if (this.type !== "multiple") return;

    const toggles = this.getToggles();
    const values: string[] = [];

    toggles.forEach((toggle) => {
      const value = toggle.getAttribute("value") ||
        toggle.textContent?.trim() || "";
      if (value) {
        values.push(value);
      }
    });

    this.value = values;
  }
}
