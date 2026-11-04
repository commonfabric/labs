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
 *     this._formField.register(this.name);
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
  private _host: ReactiveControllerHost & HTMLElement;
  private _cellController: CellControllerLike<T>;
  private _validate: () => ValidationResult;

  /** Form context consumer, which automatically subscribes to the context. */
  private _formContextConsumer: ContextConsumer<
    typeof formContext,
    ReactiveControllerHost & HTMLElement
  >;

  /** The buffered value, only used when in a form context. */
  private _buffer: T | undefined;

  /**
   * Whether the buffer has been set, which allows `undefined` as a valid
   * buffered value.
   */
  private _hasBuffer = false;

  /**
   * Original value, captured when the form field is registered and used for
   * reset.
   */
  private _originalValue: T | undefined;

  /** Cleanup function for the form registration. */
  private _formUnregister?: () => void;

  constructor(
    host: ReactiveControllerHost & HTMLElement,
    options: FormFieldControllerOptions<T>,
  ) {
    this._host = host;
    this._cellController = options.cellController;
    this._validate = options.validate ?? (() => ({ valid: true }));

    // Set up context consumer to access FormContext from ancestor cf-form
    this._formContextConsumer = new ContextConsumer(host, {
      context: formContext,
      subscribe: false, // Don't need updates, just initial value
    });

    host.addController(this);
  }

  /**
   * Get the form context (if we're inside a cf-form)
   */
  private get _formContext(): FormContext | undefined {
    return this._formContextConsumer.value;
  }

  /**
   * Check if this field is participating in a form
   */
  get inFormContext(): boolean {
    return this._formContext !== undefined;
  }

  /**
   * Get the current value.
   * Returns buffer if in form context and buffer is set, otherwise cell value.
   */
  getValue(): T {
    if (this._formContext && this._hasBuffer) {
      return this._buffer as T;
    }
    return this._cellController.getValue();
  }

  /**
   * Set the value.
   * Updates buffer if in form context, otherwise writes directly to cell.
   */
  setValue(value: T): void {
    if (this._formContext) {
      this._buffer = value;
      this._hasBuffer = true;
      this._host.requestUpdate();
    } else {
      this._cellController.setValue(value);
    }
  }

  /**
   * Flush the field's current value to the bound cell and await its confirmed
   * write. This is for standalone fields: it drains any pending
   * debounced/throttled write, then writes the current value (buffered value if
   * present, otherwise the cell controller's value) to the bound cell, and
   * rebaselines dirty/reset tracking to the committed value. Resolves once the
   * runtime confirms the commit and rejects when the write fails. When no Cell
   * is bound, it falls back to the cell controller's setValue.
   *
   * In a form context the form owns durable writes: each field buffers its edit
   * and the form flushes them together on submit. So when this field is in a
   * form, commit() returns without writing and without rebaselining; the edit
   * stays in the buffer for the form to flush, and dirty tracking is unchanged
   * so the value still counts as unsaved until the form submits.
   */
  async commit(): Promise<void> {
    // In a form context the form owns durable writes via its atomic submit;
    // leave the edit buffered and do not write or rebaseline here.
    if (this._formContext) return;

    this._cellController.flush?.();
    const valueToFlush = this._hasBuffer
      ? this._buffer as T
      : this._cellController.getValue();
    const cell = this._cellController.getCell?.();
    if (cell) {
      await cell.setStrict(valueToFlush);
    } else {
      this._cellController.setValue(valueToFlush);
    }
    // Rebaseline dirty/reset tracking so a later isDirty()/reset() stays
    // coherent with what was committed (mirrors the form-registered flush).
    this._originalValue = valueToFlush;
  }

  /**
   * Clear the buffer and update original value from current cell.
   * Call this when the underlying cell binding changes (e.g., switching records).
   * This ensures reset/dirty tracking uses the new cell's value as baseline.
   */
  clearBuffer(): void {
    this._buffer = undefined;
    this._hasBuffer = false;
    // Update original value to the new cell's value so reset works correctly
    // when reusing the same field for a different record
    this._originalValue = this._cellController.getValue();
  }

  /**
   * Register this field with the form.
   * Call this in firstUpdated() after the cell controller is bound.
   *
   * @param name - Field name for form submission (e.g., "email", "username")
   */
  register(name?: string): void {
    // Only register once
    if (this._formUnregister) return;

    // Only register if we have a form context
    if (!this._formContext) return;

    // Capture the original value at registration time for proper reset behavior
    this._originalValue = this._cellController.getValue();

    this._formUnregister = this._formContext.registerField({
      element: this._host,
      name,
      // Return buffer if set, otherwise fall back to cell value
      getValue: () =>
        this._hasBuffer ? this._buffer as T : this._cellController.getValue(),
      setValue: (v) => {
        this._buffer = v as T;
        this._hasBuffer = true;
        this._host.requestUpdate();
      },
      flush: async () => {
        const valueToFlush = this._hasBuffer
          ? this._buffer as T
          : this._cellController.getValue();
        const cell = this._cellController.getCell?.();
        if (cell) {
          await cell.setStrict(valueToFlush);
        } else {
          this._cellController.setValue(valueToFlush);
        }
        // Update original value after successful flush
        this._originalValue = valueToFlush;
      },
      reset: () => {
        // Restore to original value captured at registration time
        // This ensures "cancel" restores the value from when the form opened
        if (this._originalValue !== undefined) {
          this._cellController.setValue(this._originalValue);
        }
        this._buffer = undefined;
        this._hasBuffer = false;
        this._host.requestUpdate();
      },
      validate: this._validate,
      isDirty: () => this.isDirty(),
    });
  }

  /**
   * Unregister from the form.
   * Called automatically in hostDisconnected, but can be called manually.
   */
  unregister(): void {
    this._formUnregister?.();
    this._formUnregister = undefined;
    this._buffer = undefined;
    this._hasBuffer = false;
    this._originalValue = undefined;
  }

  /**
   * Check if the field has unsaved changes.
   * Compares current value (buffer or cell) against the original value.
   */
  isDirty(): boolean {
    if (!this._formContext) return false;

    const currentValue = this._hasBuffer
      ? this._buffer
      : this._cellController.getValue();
    // Deep equality check for objects/arrays
    return !this._deepEqual(currentValue, this._originalValue);
  }

  /**
   * Reset the original value to the current cell value.
   * Useful after programmatic updates that should be considered "saved".
   */
  captureOriginalValue(): void {
    this._originalValue = this._cellController.getValue();
  }

  /**
   * Simple deep equality check for comparing values
   */
  private _deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== "object") return false;

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);

    if (aKeys.length !== bKeys.length) return false;

    return aKeys.every((key) => this._deepEqual(aObj[key], bObj[key]));
  }

  // ReactiveController lifecycle

  hostConnected(): void {
    // Context consumer is set up in constructor
    // Registration happens in register() called by component's firstUpdated
  }

  hostDisconnected(): void {
    this.unregister();
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
