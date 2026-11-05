/**
 * Form context and types for cf-form system
 *
 * Provides a write-gate pattern where form fields buffer writes locally
 * and flush atomically on submit. This enables transactional form handling
 * without changing the underlying cell binding pattern.
 */

import { createContext } from "@lit/context";

/**
 * Validation result for a field
 */
export interface ValidationResult {
  /** Whether the field value is valid */
  valid: boolean;

  /** Optional validation message (shown when invalid) */
  message?: string;
}

/**
 * Registration for a field participating in form coordination
 */
export interface FieldRegistration {
  /** Reference to the field element */
  element: HTMLElement;

  /** Field name for identifying in form submission */
  name?: string;

  /** Get the current buffered value */
  getValue: () => unknown;

  /** Set the buffered value programmatically */
  setValue: (value: unknown) => void;

  /** Write buffered value to bound cell (async to await cell update) */
  flush: () => Promise<void>;

  /** Restore to initial value from cell */
  reset: () => void;

  /** Validate the current buffered value */
  validate: () => ValidationResult;

  /** Check if the field has unsaved changes */
  isDirty: () => boolean;
}

/**
 * Form context interface for coordinating field buffering and validation
 */
export interface FormContext {
  /**
   * Register a field with the form
   * @param registration - Field registration with buffer and validation handlers
   * @returns Unregister function to call on disconnectedCallback
   */
  registerField(registration: FieldRegistration): () => void;
}

/**
 * Context for sharing FormContext across CF form components
 */
export const formContext = createContext<FormContext | undefined>(
  Symbol("cf.form"),
);
