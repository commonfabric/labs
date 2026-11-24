/**
 * FormFieldController - Reactive controller for form field buffering
 *
 * This controller implements the "write gate" pattern where form fields
 * buffer writes locally when inside a cf-form, and flush atomically on submit.
 *
 * When NOT in a form context, getValue/setValue delegate directly to the
 * cell controller for immediate writes (existing behavior).
 *
 * When IN a form context, getValue returns buffered value (falling back to cell),
 * and setValue updates the buffer. The form coordinates flush/reset across fields.
 *
 * @example
 * ```typescript
 * class MyFormField extends BaseElement {
 *   private _cellController = createStringCellController(this, { ... });
 *   private _formField = new FormFieldController(this, {
 *     cellController: this._cellController,
 *     validate: () => ({
 *       valid: this.checkValidity(),
 *       message: this.validationMessage,
 *     }),
 *   });
 *
 *   private getValue(): string {
 *     return this._formField.getValue();
 *   }
 *
 *   private setValue(value: string): void {
 *     this._formField.setValue(value);
 *   }
 *
 *   override firstUpdated() {
 *     this._cellController.bind(this.value, stringSchema);
 *     this._formField.register();
 *   }
 * }
 * ```
 */

import { ReactiveController, ReactiveControllerHost } from "lit";
import { ContextConsumer } from "@lit/context";
import {
  type FormContext,
  formContext,
  type ValidationResult,
} from "../components/form/form-context.ts";

/**
 * Interface for cell controller compatibility
 * FormFieldController works with any controller that has getValue/setValue
 */
export interface CellControllerLike<T> {
  getValue(): T;
  setValue(value: T): void;

  /**
   * Optional: run any pending (debounced) write immediately, so a following
   * read or commit sees the latest value.
   */
  flush?(): void;

  /** Returns the bound cell, or `null` for a plain value. */
  getCell?(): { setStrict(value: T): Promise<void> } | null;
}

/**
 * Options for FormFieldController
 */
export interface FormFieldControllerOptions<T> {
  /**
   * The cell controller managing the underlying reactive value.
   * FormFieldController delegates to this when not buffering.
   */
  cellController: CellControllerLike<T>;

  /**
   * Validation function for this field.
   * Called by the form before submit to check all fields.
   * @default () => ({ valid: true })
   */
  validate?: () => ValidationResult;
}

/**
 * A reactive controller that manages form field buffering.
 *
 * Handles the "write gate" pattern: when in a form context, values are
 * buffered locally until the form flushes them. When not in a form,
 * values pass through to the cell controller directly.
 */
export class FormFieldController<T> implements ReactiveController {
  #host: ReactiveControllerHost & HTMLElement;
  #cellController: CellControllerLike<T>;
  #validate: () => ValidationResult;

  /** Form context consumer, which automatically subscribes to the context. */
  #formContextConsumer: ContextConsumer<
    typeof formContext,
    ReactiveControllerHost & HTMLElement
  >;

  /** The buffered value, only used when in a form context. */
  #buffer: { value: T } | undefined;

  /**
   * Original value, captured when the form field is registered and used for
   * reset.
   */
  #originalValue: T | undefined;

  /** Cleanup function for the form registration. */
  #formUnregister?: () => void;

  constructor(
    host: ReactiveControllerHost & HTMLElement,
    options: FormFieldControllerOptions<T>,
  ) {
    this.#host = host;
    this.#cellController = options.cellController;
    this.#validate = options.validate ?? (() => ({ valid: true }));

    // Set up context consumer to access FormContext from ancestor cf-form
    this.#formContextConsumer = new ContextConsumer(host, {
      context: formContext,
      subscribe: false, // Don't need updates, just initial value
    });

    host.addController(this);
  }

  /**
   * Check if this field is participating in a form
   */
  get inFormContext(): boolean {
    return this.#formContext !== undefined;
  }

  /**
   * Get the current value.
   * Returns buffer if in form context and buffer is set, otherwise cell value.
   */
  getValue(): T {
    if (this.#formContext && this.#buffer) return this.#buffer.value;
    return this.#cellController.getValue();
  }

  /**
   * Set the value.
   * Updates buffer if in form context, otherwise writes directly to cell.
   */
  setValue(value: T): void {
    if (this.#formContext) {
      this.#buffer = { value };
      this.#host.requestUpdate();
    } else {
      this.#cellController.setValue(value);
    }
  }

  /**
   * Flush the field's current value to the bound cell and await its confirmed
   * write. This is for standalone fields: it drains any pending
   * debounced/throttled write, then writes the current value (buffered value if
   * present, otherwise the cell controller's value) to the bound cell, and
   * rebaselines reset tracking to the committed value. Resolves once the
   * runtime confirms the commit and rejects when the write fails. When no Cell
   * is bound, it falls back to the cell controller's setValue.
   *
   * In a form context the form owns durable writes: each field buffers its edit
   * and the form flushes them together on submit. So when this field is in a
   * form, commit() returns without writing and without rebaselining; the edit
   * stays in the buffer for the form to flush.
   */
  async commit(): Promise<void> {
    // In a form context the form owns durable writes via its atomic submit;
    // leave the edit buffered and do not write or rebaseline here.
    if (this.#formContext) return;

    this.#cellController.flush?.();
    await this.#write();
  }

  /**
   * Clear the buffer and update original value from current cell.
   * Call this when the underlying cell binding changes (e.g., switching records).
   * This ensures reset tracking uses the new cell's value as baseline.
   */
  clearBuffer(): void {
    this.#buffer = undefined;
    // Update original value to the new cell's value so reset works correctly
    // when reusing the same field for a different record
    this.#originalValue = this.#cellController.getValue();
  }

  /**
   * Register this field with the form.
   * Call this in firstUpdated() after the cell controller is bound.
   */
  register(): void {
    // Only register once
    if (this.#formUnregister) return;

    // Only register if we have a form context
    if (!this.#formContext) return;

    // Capture the original value at registration time for proper reset behavior
    this.#originalValue = this.#cellController.getValue();

    this.#formUnregister = this.#formContext.registerField({
      element: this.#host,
      flush: () => this.#write(),
      reset: () => {
        // Restore to original value captured at registration time
        // This ensures "cancel" restores the value from when the form opened
        if (this.#originalValue !== undefined) {
          this.#cellController.setValue(this.#originalValue);
        }
        this.#buffer = undefined;
        this.#host.requestUpdate();
      },
      validate: this.#validate,
    });
  }

  /**
   * Unregister from the form.
   * Called automatically in hostDisconnected, but can be called manually.
   */
  unregister(): void {
    this.#formUnregister?.();
    this.#formUnregister = undefined;
    this.#buffer = undefined;
    this.#originalValue = undefined;
  }

  // ReactiveController lifecycle

  hostDisconnected(): void {
    this.unregister();
  }

  /**
   * Get the form context (if we're inside a cf-form)
   */
  get #formContext(): FormContext | undefined {
    return this.#formContextConsumer.value;
  }

  /**
   * Writes the current value (the buffered one if present, otherwise the cell
   * controller's) to the bound cell, awaiting its confirmed write, or through
   * the cell controller's setValue when no cell is bound, and makes it the
   * value a reset restores.
   */
  async #write(): Promise<void> {
    const valueToFlush = this.#buffer
      ? this.#buffer.value
      : this.#cellController.getValue();
    const cell = this.#cellController.getCell?.();
    if (cell) {
      await cell.setStrict(valueToFlush);
    } else {
      this.#cellController.setValue(valueToFlush);
    }
    this.#originalValue = valueToFlush;
  }
}

/**
 * Factory function for creating FormFieldController instances
 */
export function createFormFieldController<T>(
  host: ReactiveControllerHost & HTMLElement,
  options: FormFieldControllerOptions<T>,
): FormFieldController<T> {
  return new FormFieldController(host, options);
}
