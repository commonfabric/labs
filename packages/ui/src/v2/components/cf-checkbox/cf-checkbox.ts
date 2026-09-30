import { booleanSchema } from "@commonfabric/runner/schemas";
import { type CellHandle } from "@commonfabric/runtime-client";
import { css, html, LitElement } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";

import { BaseElement } from "../../core/base-element.ts";
import { createBooleanCellController } from "../../core/cell-controller.ts";
import { createFormFieldController } from "../../core/form-field-controller.ts";

/**
 * CFCheckbox - Binary selection input with support for indeterminate state
 *
 * @element cf-checkbox
 *
 * @attr {boolean|CellHandle<boolean>} checked - Whether the checkbox is checked (supports both plain boolean and CellHandle<boolean>)
 * @attr {boolean} disabled - Whether the checkbox is disabled
 * @attr {string} name - Name attribute for form submission
 * @attr {string} value - Value attribute for form submission
 * @attr {boolean} required - Whether the checkbox is required
 * @attr {boolean} indeterminate - Whether the checkbox is in indeterminate state
 *
 * @slot - Default slot for checkbox label text
 *
 * @fires cf-change - Fired on change with detail: { checked, indeterminate }
 *
 * @example
 * <cf-checkbox name="terms" checked>Accept terms</cf-checkbox>
 *
 * @example
 * <!-- Reactive Cell binding -->
 * <cf-checkbox $checked={enabledCell}>Enable feature</cf-checkbox>
 */

export class CFCheckbox extends BaseElement {
  static override shadowRootOptions = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      position: relative;
      cursor: pointer;
      line-height: 1.5;

      /* Default color values if not provided */
      --background: #ffffff;
      --foreground: #0f172a;
      --primary: #0f172a;
      --primary-foreground: #f8fafc;
      --border: #e2e8f0;
      --ring: #94a3b8;
    }

    :host([disabled]) {
      cursor: not-allowed;
      opacity: 0.5;
    }

    :host:focus {
      outline: none;
    }

    :host:focus-visible .checkbox {
      outline: 2px solid transparent;
      outline-offset: 2px;
      box-shadow:
        0 0 0 2px var(--background, #fff),
        0 0 0 4px var(--ring, #94a3b8);
      }

      .checkbox {
        position: relative;
        width: 1rem; /* size-4 */
        height: 1rem; /* size-4 */
        border: 1px solid var(--primary, #0f172a);
        border-radius: 0.25rem; /* rounded */
        background-color: var(--background, #fff);
        transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .checkbox.checked,
      .checkbox.indeterminate {
        background-color: var(--primary, #0f172a);
        border-color: var(--primary, #0f172a);
      }

      .checkbox.disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      /* Checkmark using CSS transforms */
      .checkmark {
        display: none;
        width: 10px;
        height: 6px;
        position: relative;
      }

      .checkbox.checked .checkmark {
        display: block;
      }

      .checkbox.checked .checkmark::after {
        content: "";
        position: absolute;
        left: 2.5px;
        top: -2.5px;
        width: 4px;
        height: 7px;
        border: solid var(--primary-foreground, #f8fafc);
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
      }

      /* Indeterminate state - horizontal line */
      .checkbox.indeterminate .checkmark {
        display: block;
        width: 8px;
        height: 2px;
        background-color: var(--primary-foreground, #f8fafc);
      }

      .checkbox.indeterminate .checkmark::after {
        display: none;
      }

      /* Hidden native input for form compatibility */
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border-width: 0;
      }

      /* Hover state */
      :host(:not([disabled]):hover) .checkbox:not(.checked):not(.indeterminate) {
        border-color: var(--primary, #0f172a);
      }

      /* Animation for checkmark */
      .checkbox.checked .checkmark::after {
        animation: checkmark-animation 200ms ease-out;
      }

      @keyframes checkmark-animation {
        0% {
          transform: rotate(45deg) scale(0);
        }
        100% {
          transform: rotate(45deg) scale(1);
        }
      }
    `;

    static override properties = {
      checked: { type: Boolean, reflect: true },
      disabled: { type: Boolean, reflect: true },
      indeterminate: { type: Boolean, reflect: true },
      required: { type: Boolean, reflect: true },
      name: { type: String },
      value: { type: String },
    };

    declare checked: CellHandle<boolean> | boolean;
    declare disabled: boolean;
    declare indeterminate: boolean;
    declare required: boolean;
    declare name: string;
    declare value: string;

    private _checkedCellController = createBooleanCellController(this, {
      timing: {
        strategy: "immediate",
        delay: 0,
      },
      onChange: (newValue: boolean, _oldValue: boolean) => {
        this.emit("cf-change", {
          checked: newValue,
          indeterminate: this.indeterminate,
        });
      },
    });

    /**
     * Form field controller, which handles buffering when in a `cf-form`
     * context.
     */
    private _formField = createFormFieldController<boolean>(this, {
      cellController: this._checkedCellController,
      validate: () => {
        // Disabled fields should not cause form invalidation
        if (this.disabled) {
          return { valid: true };
        }
        // Required checkbox must be checked
        if (this.required && !this.getChecked()) {
          return { valid: false, message: "This checkbox is required" };
        }
        return { valid: true };
      },
    });

    constructor() {
      super();
      this.checked = false;
      this.disabled = false;
      this.indeterminate = false;
      this.required = false;
      this.name = "";
      this.value = "on";
    }

    private getChecked(): boolean {
      return this._formField.getValue();
    }

    private setChecked(newValue: boolean): void {
      this._formField.setValue(newValue);
      // Update aria attributes immediately since checked property doesn't change
      // when buffering (the buffer is internal, not reflected to the property)
      this._updateAriaAttributes();
    }

    override connectedCallback() {
      // Set host attributes before super.connectedCallback() triggers rendering.
      // Cannot be in the constructor — the custom element spec forbids
      // setAttribute during construction.
      if (!this.hasAttribute("role")) {
        this.setAttribute("role", "checkbox");
      }
      if (!this.hasAttribute("exportparts")) {
        this.setAttribute("exportparts", "checkbox,checkmark");
      }
      super.connectedCallback();
      this._updateAriaAttributes();
      // Bind initial checked value
      this._checkedCellController.bind(this.checked, booleanSchema);
      // Add event listeners to the host element to make entire component clickable
      this.addEventListener("click", this._handleClick);
      this.addEventListener("keydown", this._handleKeydown);
    }

    override firstUpdated() {
      // Register with form after first render when context is available
      this._formField.register(this.name);
    }

    override disconnectedCallback() {
      super.disconnectedCallback();
      // Clean up event listeners
      this.removeEventListener("click", this._handleClick);
      this.removeEventListener("keydown", this._handleKeydown);
      // Controllers handle form cleanup automatically via ReactiveController
    }

    override willUpdate(
      changedProperties: Map<string | number | symbol, unknown>,
    ) {
      super.willUpdate(changedProperties);

      // If the checked property itself changed (e.g., switched to a different cell)
      if (changedProperties.has("checked")) {
        // Bind the new cell first so getValue() returns the new value
        this._checkedCellController.bind(this.checked, booleanSchema);
        // Then clear buffer - this captures the new cell's value as baseline for reset/dirty
        this._formField.clearBuffer();
      }
    }

    override updated(
      changedProperties: Map<string | number | symbol, unknown>,
    ) {
      super.updated(changedProperties);

      // Cell deliveries and form buffers can rerender without a property change.
      this._updateAriaAttributes();
    }

    override render() {
      const isChecked = this.getChecked();
      const checkboxClasses = {
        "checkbox": true,
        "checked": isChecked && !this.indeterminate,
        "indeterminate": this.indeterminate,
        "disabled": this.disabled,
      };

      const classString = Object.entries(checkboxClasses)
        .filter(([_, value]) => value)
        .map(([key]) => key)
        .join(" ");

      return html`
        <!-- The host carries role="checkbox" and tabindex for accessibility.
          delegatesFocus: true routes focus here, so aria-hidden must NOT be
          set on this div — browsers refuse to apply aria-hidden on focused
          elements. The host ARIA attributes are the a11y surface. -->
        <div
          class="${classString}"
          part="checkbox"
          tabindex="-1"
        >
          <span class="checkmark" part="checkmark"></span>
        </div>
        <slot></slot>
        <input
          type="checkbox"
          class="sr-only"
          ?checked="${isChecked}"
          ?disabled="${this.disabled}"
          name="${ifDefined(this.name || undefined)}"
          value="${this.value}"
          tabindex="-1"
          aria-hidden="true"
        />
      `;
    }

    private _updateAriaAttributes() {
      const isChecked = this.getChecked();
      this.setAttribute(
        "aria-checked",
        this.indeterminate ? "mixed" : String(isChecked),
      );
      this.setAttribute("aria-disabled", String(this.disabled));
      this.tabIndex = this.disabled ? -1 : 0;
    }

    private _handleClick(event: Event) {
      if (this.disabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // Toggle checked state
      const oldChecked = this.getChecked();
      this.setChecked(!oldChecked);

      // Clear indeterminate state when clicked
      if (this.indeterminate) {
        this.indeterminate = false;
      }

      // Note: cf-change event is emitted by the cell controller's onChange callback
    }

    private _handleKeydown(event: KeyboardEvent) {
      if (this.disabled) {
        return;
      }

      // Handle Space key
      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        this._handleClick(event);
      }
    }

    /**
     * Focus the checkbox programmatically
     */
    override focus(): void {
      super.focus();
    }

    /**
     * Blur the checkbox programmatically
     */
    override blur(): void {
      super.blur();
    }
  }
