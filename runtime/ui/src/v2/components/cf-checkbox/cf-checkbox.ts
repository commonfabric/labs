import { booleanSchema } from "@commonfabric/runner/schemas";
import { type CellHandle, isCellHandle } from "@commonfabric/runtime-client";
import { css, html } from "lit";

import { BaseElement } from "../../core/base-element.ts";
import { createBooleanCellController } from "../../core/cell-controller.ts";
import { createFormFieldController } from "../../core/form-field-controller.ts";
import { HostActivationController } from "../../core/host-activation-controller.ts";

/**
 * CFCheckbox - Binary selection input with support for indeterminate state
 *
 * @element cf-checkbox
 *
 * @attr {boolean|CellHandle<boolean>} checked - Whether the checkbox is checked (supports both plain boolean and CellHandle<boolean>)
 * @attr {boolean} disabled - Whether the checkbox is disabled
 * @attr {boolean} required - Whether the checkbox is required
 * @attr {boolean} indeterminate - Whether the checkbox is in indeterminate state
 *
 * @slot - Default slot for checkbox label text
 *
 * @fires cf-change - Fired on change with detail: { checked, indeterminate }
 *
 * @example
 * <cf-checkbox checked>Accept terms</cf-checkbox>
 *
 * @example
 * <!-- Reactive Cell binding -->
 * <cf-checkbox $checked={enabledCell}>Enable feature</cf-checkbox>
 */

export class CFCheckbox extends BaseElement {
  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      position: relative;
      cursor: pointer;
      line-height: 1.5;

      /* Default color values if not provided */
      --background: var(--cf-theme-color-surface, #ffffff);
      --foreground: var(--cf-theme-color-text, #0f172a);
      --primary: var(--cf-theme-color-primary, #0f172a);
      --primary-foreground: var(--cf-theme-color-primary-foreground, #f8fafc);
      --border: var(--cf-theme-color-border, #e2e8f0);
      --ring: #94a3b8;
    }

    :host([disabled]) {
      cursor: not-allowed;
      opacity: 0.5;
    }

    :host(:focus) {
      outline: none;
    }

    :host(:focus-visible) .checkbox {
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
    };

    declare checked: CellHandle<boolean> | boolean;
    declare disabled: boolean;
    declare indeterminate: boolean;
    declare required: boolean;

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

    #activation = new HostActivationController(this, {
      role: "checkbox",
      keys: [" ", "Spacebar"],
      isDisabled: () => this.disabled,
      activate: () => this._toggle(),
    });

    constructor() {
      super();
      this.checked = false;
      this.disabled = false;
      this.indeterminate = false;
      this.required = false;
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
      if (!this.hasAttribute("exportparts")) {
        this.setAttribute("exportparts", "checkbox,checkmark");
      }
      super.connectedCallback();
      this._updateAriaAttributes();
      // Bind initial checked value
      this._checkedCellController.bind(this.checked, booleanSchema);
    }

    override firstUpdated() {
      // Register with form after first render when context is available
      this._formField.register();
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
        <div class="${classString}" part="checkbox">
          <span class="checkmark" part="checkmark"></span>
        </div>
        <slot></slot>
      `;
    }

    private _updateAriaAttributes() {
      const isChecked = this.getChecked();
      this.setAttribute(
        "aria-checked",
        this.indeterminate ? "mixed" : String(isChecked),
      );
    }

    private _toggle() {
      // A click settles an indeterminate checkbox, so the change it makes
      // reports `indeterminate: false`.
      if (this.indeterminate) {
        this.indeterminate = false;
      }

      // In a form, the toggle is buffered until the form submits.
      if (this._formField.inFormContext) {
        this.setChecked(!this.getChecked());
      } else if (isCellHandle(this.checked)) {
        // A bound cell's toggle is computed from what the cell holds, asking
        // the worker first where it has read nothing, and the controller's
        // onChange fires cf-change.
        void this._checkedCellController.toggle().then(() =>
          this._updateAriaAttributes()
        );
      } else {
        // A plain boolean is the checkbox's own property, which it flips
        // itself. It is read from the property, not the controller, which
        // catches up with it only on the next update.
        this.checked = !this.checked;
        this.emit("cf-change", {
          checked: this.checked,
          indeterminate: this.indeterminate,
        });
      }
    }
  }
