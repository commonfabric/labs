import { css, html } from "lit";
import { property, query } from "lit/decorators.js";
import { provide } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import {
  type FieldRegistration,
  type FormContext,
  formContext,
} from "./form-context.ts";

/**
 * CFForm Component
 *
 * A form wrapper component that provides consistent layout and spacing for forms.
 * Emits a custom cf-submit event when the form is submitted.
 *
 * Provides FormContext to descendant fields for coordinated submission with:
 * - Field validation before submit
 * - Atomic flushing of buffered values on submit
 * - Coordinated reset of all fields
 *
 * @element cf-form
 *
 * @attr {string} method - HTTP method for form submission (GET or POST)
 * @attr {string} action - URL for form submission
 *
 * @event cf-submit - Fired when the form is submitted and all fields are valid (includes form data in detail)
 * @event cf-form-invalid - Fired when submit is attempted but validation fails (includes errors in detail)
 *
 * @slot - Form content (inputs, labels, buttons, etc.)
 *
 * @example
 * ```html
 * <cf-form method="POST" action="/api/submit">
 *   <cf-label for="name">Name</cf-label>
 *   <cf-input id="name" name="name" required></cf-input>
 *
 *   <cf-label for="email">Email</cf-label>
 *   <cf-input id="email" name="email" type="email" required></cf-input>
 *
 *   <div class="form-actions">
 *     <cf-button type="submit">Submit</cf-button>
 *     <cf-button type="button" variant="outline">Cancel</cf-button>
 *   </div>
 * </cf-form>
 * ```
 */
export class CFForm extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;

      /* Default color values if not provided */
      --background: #ffffff;
      --foreground: #0f172a;
      --border: #e2e8f0;
      --ring: #94a3b8;

      /* Form spacing variables */
      --form-gap: 1.5rem;
      --form-field-gap: 0.5rem;
      --form-padding: 0;
    }

    form {
      display: flex;
      flex-direction: column;
      gap: var(--form-gap);
      padding: var(--form-padding);
      width: 100%;
    }

    /* Direct children spacing */
    ::slotted(*) {
      margin: 0;
    }

    /* Common form field patterns */
    ::slotted(cf-label) {
      margin-bottom: var(--form-field-gap);
    }

    /* Field groups (divs, fieldsets) */
    ::slotted(div),
    ::slotted(fieldset) {
      display: flex;
      flex-direction: column;
      gap: var(--form-field-gap);
      margin: 0;
      padding: 0;
      border: none;
    }

    /* Horizontal field groups */
    ::slotted(.form-row),
    ::slotted([data-orientation="horizontal"]) {
      flex-direction: row;
      align-items: center;
      gap: 1rem;
    }

    /* Form sections */
    ::slotted(.form-section) {
      display: flex;
      flex-direction: column;
      gap: var(--form-gap);
    }

    /* Button groups typically at form bottom */
    ::slotted(.form-actions),
    ::slotted(.form-buttons) {
      display: flex;
      gap: 0.75rem;
      margin-top: 0.5rem;
    }

    /* Responsive adjustments */
    @media (max-width: 640px) {
      ::slotted(.form-row),
      ::slotted([data-orientation="horizontal"]) {
        flex-direction: column;
        align-items: stretch;
      }

      ::slotted(.form-actions),
      ::slotted(.form-buttons) {
        flex-direction: column;
      }

      ::slotted(.form-actions) cf-button,
      ::slotted(.form-buttons) cf-button {
        width: 100%;
      }
    }
  `;

  @property()
  accessor method: "GET" | "POST" = "GET";

  @property()
  accessor action = "";

  @query("form")
  private accessor _form: HTMLFormElement | null = null;

  /** Track registered fields for coordinated submit/reset */
  private _fields = new Map<HTMLElement, FieldRegistration>();

  /** Provide FormContext to descendant fields */
  @provide({ context: formContext })
  private accessor _formContext: FormContext = {
    registerField: (reg) => this._registerField(reg),
  };

  /**
   * Register a field with the form
   * @param reg - Field registration with buffer and validation handlers
   * @returns Unregister function to call on disconnectedCallback
   */
  private _registerField(reg: FieldRegistration): () => void {
    this._fields.set(reg.element, reg);
    return () => {
      this._fields.delete(reg.element);
    };
  }

  override render() {
    return html`
      <form method="${this.method}" action="${this.action}" @submit="${this
        .handleSubmit}">
        <slot></slot>
      </form>
    `;
  }

  private async handleSubmit(event: Event): Promise<void> {
    // Prevent default form submission
    event.preventDefault();
    event.stopPropagation();

    if (!this._form) {
      return;
    }

    // 1. Validate all registered fields
    const errors: Array<{ element: HTMLElement; message?: string }> = [];
    for (const [element, field] of this._fields) {
      const result = field.validate();
      if (!result.valid) {
        errors.push({ element, message: result.message });
      }
    }

    // If any fields are invalid, emit error event and return early
    if (errors.length > 0) {
      this.emit("cf-form-invalid", { errors });
      return;
    }

    // 2. Flush all buffered values to their bound cells
    // Await all flush operations to ensure cell updates are committed
    try {
      const flushPromises = Array.from(this._fields.values()).map((field) =>
        field.flush()
      );
      await Promise.all(flushPromises);
    } catch (error) {
      // Emit error event if flush fails (e.g., network error, storage failure)
      this.emit("cf-submit-error", {
        error,
        message: error instanceof Error
          ? error.message
          : "Failed to save form data",
      });
      return;
    }

    // 3. Emit submit event - handlers read from cells directly
    // (Pattern handlers run in the runtime context where cells are updated)
    const submitted = this.emit("cf-submit");

    // 4. If event wasn't prevented, submit the form natively
    if (submitted && this.action) {
      this._form.submit();
    }
  }

  /**
   * Get the form element
   */
  get form(): HTMLFormElement | null {
    return this._form;
  }

  /**
   * Submit the form programmatically
   */
  submit(): void {
    if (this._form) {
      const event = new Event("submit", {
        bubbles: true,
        cancelable: true,
      });
      this._form.dispatchEvent(event);
    }
  }

  /**
   * Reset the form
   */
  reset(): void {
    // Reset all registered fields to their initial cell values
    for (const field of this._fields.values()) {
      field.reset();
    }

    if (this._form) {
      this._form.reset();
    }
  }

  /**
   * Check form validity
   */
  checkValidity(): boolean {
    return this._form?.checkValidity() ?? false;
  }

  /**
   * Report form validity
   */
  reportValidity(): boolean {
    return this._form?.reportValidity() ?? false;
  }

  /**
   * Check if any field in the form has unsaved changes
   */
  isDirty(): boolean {
    for (const field of this._fields.values()) {
      if (field.isDirty()) {
        return true;
      }
    }
    return false;
  }
}
