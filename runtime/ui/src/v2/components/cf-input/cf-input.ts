import { stringSchema } from "@commonfabric/runner/schemas";
import { type CellHandle } from "@commonfabric/runtime-client";
import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";

import { BaseElement } from "../../core/base-element.ts";
import { createStringCellController } from "../../core/cell-controller.ts";
import { createFormFieldController } from "../../core/form-field-controller.ts";
import { type InputTimingOptions } from "../../core/input-timing-controller.ts";
import {
  applyThemeToElement,
  type CFTheme,
  type ComponentSize,
} from "../theme-context.ts";

/**
 * CFInput - Enhanced input field with support for various types, validation patterns, and reactive data binding
 *
 * @element cf-input
 *
 * @attr {string} type - Input type: "text" | "email" | "password" | "number" | "search" | "tel" | "url" | "date" | "time" | "datetime-local" | "month" | "week" | "color" | "file" | "range" | "hidden"
 * @attr {string} placeholder - Placeholder text
 * @attr {string|CellHandle<string>} value - Input value (supports both plain string and CellHandle<string>)
 * @attr {boolean} disabled - Whether the input is disabled
 * @attr {boolean} readonly - Whether the input is read-only
 * @attr {boolean} required - Whether the input is required
 * @attr {string} name - Name attribute for form submission
 * @attr {string|number} min - Minimum value (for number, date, range inputs)
 * @attr {string|number} max - Maximum value (for number, date, range inputs)
 * @attr {string|number} step - Step value (for number, range inputs)
 * @attr {string} pattern - Custom validation pattern (regex)
 * @attr {string} validationPattern - Predefined pattern: "email" | "url" | "tel-us" | "tel-intl" | "credit-card" | "zip-us" | "alphanumeric" | "letters" | "numbers"
 * @attr {string} autocomplete - Autocomplete hint
 * @attr {string} inputmode - Virtual keyboard mode: "none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url"
 * @attr {string} size - Component size variant: "xs" | "sm" | "md" | "lg" | "xl" (default: "md")
 * @attr {number} length - Width of input in characters
 * @attr {boolean} multiple - Allow multiple files (file input only)
 * @attr {string} accept - File types to accept (file input only)
 * @attr {string} list - ID of datalist element for suggestions
 * @attr {string} spellcheck - Enable/disable spellcheck
 * @attr {boolean} showValidation - Show validation state visually
 * @attr {boolean} error - Manual error state override
 * @attr {string} timingStrategy - Input timing strategy: "immediate" | "debounce" | "throttle" | "blur"
 * @attr {number} timingDelay - Delay in milliseconds for debounce/throttle (default: 300)
 *
 * @fires cf-change - Fired when value changes (timing depends on strategy) with detail: { value, oldValue, name, files? }
 * @fires cf-focus - Fired on focus with detail: { value, name }
 * @fires cf-blur - Fired on blur with detail: { value, name }
 * @fires cf-keydown - Fired on keydown with detail: { key, value, shiftKey, ctrlKey, metaKey, altKey, name }
 * @fires cf-submit - Fired on Enter key with detail: { value, name }
 * @fires cf-invalid - Fired on validation failure with detail: { value, name, validationMessage, validity }
 *
 * @example
 * <cf-input type="email" placeholder="Enter email" required showValidation></cf-input>
 *
 * @example
 * <cf-input type="tel" validationPattern="tel-us" placeholder="(123) 456-7890"></cf-input>
 *
 * @example
 * <cf-input type="number" min="0" max="100" step="5"></cf-input>
 *
 * @example
 * <!-- Debounced input - waits 500ms after user stops typing -->
 * <cf-input timingStrategy="debounce" timingDelay="500" placeholder="Search..."></cf-input>
 *
 * @example
 * <!-- Only emit events when input loses focus -->
 * <cf-input timingStrategy="blur" placeholder="Enter value"></cf-input>
 */

export type InputType =
  | "text"
  | "password"
  | "email"
  | "number"
  | "tel"
  | "url"
  | "search"
  | "date"
  | "time"
  | "datetime-local"
  | "month"
  | "week"
  | "color"
  | "file"
  | "range"
  | "hidden";

export type InputMode =
  | "none"
  | "text"
  | "decimal"
  | "numeric"
  | "tel"
  | "search"
  | "email"
  | "url";

// Common validation patterns for different input types
// Note: Patterns must be compatible with both legacy and Unicode Sets (/v flag) regex modes
// In /v mode, hyphens in character classes must be at start/end or escaped
export const INPUT_PATTERNS = {
  // Email pattern (basic validation) - hyphen at end of character class for /v compatibility
  email: "[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}",
  // URL pattern (http/https)
  url: "https?://.+",
  // US Phone pattern (various formats)
  "tel-us": "\\+?1?[-.]?\\(?([0-9]{3})\\)?[-.]?([0-9]{3})[-.]?([0-9]{4})",
  // International phone
  "tel-intl":
    "\\+?[0-9]{1,4}?[-.]?\\(?([0-9]{1,4})\\)?[-.]?([0-9]{1,4})[-.]?([0-9]{1,9})",
  // Credit card (basic - digits with optional spaces/dashes)
  "credit-card": "[0-9]{4}[-\\s]?[0-9]{4}[-\\s]?[0-9]{4}[-\\s]?[0-9]{4}",
  // ZIP code (US 5 or 9 digit)
  "zip-us": "[0-9]{5}(-[0-9]{4})?",
  // Alphanumeric only
  alphanumeric: "[a-zA-Z0-9]+",
  // Letters only
  letters: "[a-zA-Z]+",
  // Numbers only
  numbers: "[0-9]+",
} as const;

export class CFInput extends BaseElement {
  static formAssociated = true;

  static override styles = css`
    :host {
      --cf-input-color-text: var(--cf-theme-color-text, #111827);
      --cf-input-color-background: var(--cf-theme-color-background, #ffffff);
      --cf-input-color-border: var(--cf-theme-color-border, #e5e7eb);
      --cf-input-color-border-hover: var(--cf-theme-color-border-muted, #d1d5db);
      --cf-input-color-primary: var(--cf-theme-color-primary, #3b82f6);
      --cf-input-color-ring: rgba(59, 130, 246, 0.15);
      --cf-input-color-surface: var(--cf-theme-color-surface, #f1f5f9);
      --cf-input-color-text-muted: var(--cf-theme-color-text-muted, #6b7280);
      --cf-input-color-error: var(--cf-theme-color-error, #dc2626);
      --cf-input-color-error-ring: rgba(220, 38, 38, 0.15);
      --cf-input-color-success: var(--cf-theme-color-success, #16a34a);
      --cf-input-border-radius: var(
        --cf-theme-border-radius,
        var(--cf-border-radius-md, 0.375rem)
      );
      --cf-input-animation-duration: var(--cf-theme-animation-duration, 150ms);
      --cf-input-font-family: var(--cf-theme-font-family, inherit);

      /* Sizing scale defaults (size="md") */
      --input-height: var(--cf-size-md-height, 32px);
      --input-padding-x: var(--cf-size-md-padding-h, 8px);
      --input-padding-y: var(--cf-size-md-padding-v, 8px);
      --input-font-size: var(--cf-size-md-font-size, 12px);
      --input-line-height: var(--cf-size-md-line-height, 16px);
      --input-border-radius: var(--cf-size-md-radius, 8px);

      display: block;
      box-sizing: border-box;
    }

    :host([size="xs"]) {
      --input-height: var(--cf-size-xs-height, 16px);
      --input-padding-x: var(--cf-size-xs-padding-h, 4px);
      --input-padding-y: var(--cf-size-xs-padding-v, 2px);
      --input-font-size: var(--cf-size-xs-font-size, 9px);
      --input-line-height: var(--cf-size-xs-line-height, 12px);
      --input-border-radius: var(--cf-size-xs-radius, 4px);
    }

    :host([size="sm"]) {
      --input-height: var(--cf-size-sm-height, 24px);
      --input-padding-x: var(--cf-size-sm-padding-h, 6px);
      --input-padding-y: var(--cf-size-sm-padding-v, 4px);
      --input-font-size: var(--cf-size-sm-font-size, 11px);
      --input-line-height: var(--cf-size-sm-line-height, 16px);
      --input-border-radius: var(--cf-size-sm-radius, 5px);
    }

    :host([size="lg"]) {
      --input-height: var(--cf-size-lg-height, 40px);
      --input-padding-x: var(--cf-size-lg-padding-h, 12px);
      --input-padding-y: var(--cf-size-lg-padding-v, 8px);
      --input-font-size: var(--cf-size-lg-font-size, 16px);
      --input-line-height: var(--cf-size-lg-line-height, 20px);
      --input-border-radius: var(--cf-size-lg-radius, 9px);
    }

    :host([size="xl"]) {
      --input-height: var(--cf-size-xl-height, 48px);
      --input-padding-x: var(--cf-size-xl-padding-h, 16px);
      --input-padding-y: var(--cf-size-xl-padding-v, 12px);
      --input-font-size: var(--cf-size-xl-font-size, 18px);
      --input-line-height: var(--cf-size-xl-line-height, 24px);
      --input-border-radius: var(--cf-size-xl-radius, 10px);
    }

    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }

    input {
      display: block;
      width: 100%;
      min-height: var(--input-height);
      height: auto;
      padding: var(--input-padding-y) var(--input-padding-x);
      font-size: var(--input-font-size);
      line-height: var(--input-line-height);
      color: var(--cf-input-color-text, #111827);
      background-color: var(--cf-input-color-background, #ffffff);
      border: 1px solid var(--cf-input-color-border, #e5e7eb);
      border-radius: var(--input-border-radius);
      transition: all var(--cf-input-animation-duration, 150ms)
        var(--cf-transition-timing-ease);
      font-family: var(--cf-input-font-family, inherit);
    }

    input::placeholder {
      color: var(--cf-input-color-text-muted, #6b7280);
    }

    input:hover:not(:disabled):not(:focus) {
      border-color: var(--cf-input-color-border-hover, #d1d5db);
    }

    input:focus {
      outline: none;
      border-color: var(--cf-input-color-primary, #3b82f6);
      box-shadow: 0 0 0 3px var(--cf-input-color-ring, rgba(59, 130, 246, 0.15));
    }

    input:disabled {
      cursor: not-allowed;
      opacity: 0.5;
      background-color: var(--cf-input-color-surface, #f1f5f9);
    }

    input[readonly] {
      background-color: var(--cf-input-color-surface, #f1f5f9);
    }

    input.error {
      border-color: var(--cf-input-color-error, #dc2626);
    }

    input.error:focus {
      border-color: var(--cf-input-color-error, #dc2626);
      box-shadow: 0 0 0 3px
        var(--cf-input-color-error-ring, rgba(220, 38, 38, 0.15));
    }

    /* Remove spinner buttons from number inputs in Chrome/Safari/Edge */
    input[type="number"]::-webkit-outer-spin-button,
    input[type="number"]::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    /* Remove spinner from number inputs in Firefox */
    input[type="number"] {
      -moz-appearance: textfield;
    }

    /* Style file input */
    input[type="file"] {
      padding: 0.375rem 0.75rem;
      cursor: pointer;
    }

    input[type="file"]::file-selector-button {
      margin-right: 0.5rem;
      padding: 0.125rem 0.5rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--cf-input-color-background, hsl(0, 0%, 100%));
      background-color: var(--cf-input-color-primary, hsl(212, 100%, 47%));
      border: none;
      border-radius: var(--input-border-radius);
      cursor: pointer;
    }

    input[type="file"]::file-selector-button:hover {
      opacity: 0.9;
    }

    /* Date/time inputs */
    input[type="date"],
    input[type="time"],
    input[type="datetime-local"],
    input[type="month"],
    input[type="week"] {
      cursor: pointer;
    }

    /* Color input */
    input[type="color"] {
      padding: 0.25rem;
      cursor: pointer;
    }

    /* Search input */
    input[type="search"]::-webkit-search-decoration,
    input[type="search"]::-webkit-search-cancel-button {
      -webkit-appearance: none;
    }

    /* Range input */
    input[type="range"] {
      padding: 0.5rem 0;
      cursor: pointer;
    }

    input[type="range"]::-webkit-slider-track {
      width: 100%;
      height: 4px;
      background: var(--cf-input-color-surface, #f1f5f9);
      border-radius: 2px;
    }

    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 16px;
      height: 16px;
      background: var(--cf-input-color-primary, #3b82f6);
      border-radius: 50%;
      cursor: pointer;
    }

    input[type="range"]::-moz-range-track {
      width: 100%;
      height: 4px;
      background: var(--cf-input-color-surface, #f1f5f9);
      border-radius: 2px;
    }

    input[type="range"]::-moz-range-thumb {
      width: 16px;
      height: 16px;
      background: var(--cf-input-color-primary, #3b82f6);
      border-radius: 50%;
      border: none;
      cursor: pointer;
    }

    /* Hidden input */
    input[type="hidden"] {
      display: none;
    }

    /* Valid state (when showValidation is true) */
    input:valid:not(:placeholder-shown) {
      border-color: var(--cf-input-color-success, #16a34a);
    }

    input:valid:not(:placeholder-shown):focus {
      border-color: var(--cf-input-color-success, #16a34a);
      box-shadow: 0 0 0 3px
        var(--cf-input-color-success, rgba(22, 163, 74, 0.15));
    }
  `;

  static override properties = {
    type: { type: String },
    placeholder: { type: String },
    value: { type: String },
    disabled: { type: Boolean },
    readonly: { type: Boolean },
    error: { type: Boolean },
    name: { type: String },
    required: { type: Boolean },
    autofocus: { type: Boolean },
    autocomplete: { type: String },
    min: { type: String },
    max: { type: String },
    step: { type: String },
    pattern: { type: String },
    maxlength: { type: String },
    minlength: { type: String },
    inputmode: { type: String },
    size: { type: String, reflect: true },
    length: { type: Number, attribute: "length" },
    multiple: { type: Boolean },
    accept: { type: String },
    list: { type: String },
    spellcheck: { type: Boolean },
    validationPattern: { type: String },
    showValidation: { type: Boolean },
    timingStrategy: { type: String },
    timingDelay: { type: Number },
  };

  declare type: InputType;
  declare placeholder: string;
  declare value: CellHandle<string> | string;
  declare disabled: boolean;
  declare readonly: boolean;
  declare error: boolean;
  declare name: string;
  declare required: boolean;
  declare autofocus: boolean;
  declare autocomplete: string;
  declare min: string;
  declare max: string;
  declare step: string;
  declare pattern: string;
  declare maxlength: string;
  declare minlength: string;
  declare inputmode: InputMode;
  declare size: ComponentSize;
  declare length: number;
  declare multiple: boolean;
  declare accept: string;
  declare list: string;
  declare spellcheck: boolean;
  declare validationPattern: keyof typeof INPUT_PATTERNS | "";
  declare showValidation: boolean;
  declare timingStrategy: InputTimingOptions["strategy"];
  declare timingDelay: number;

  private _input: HTMLInputElement | null = null;
  private _generatedAriaLabel: string | null = null;
  #internals: ElementInternals;
  private _cellController = createStringCellController(this, {
    timing: {
      strategy: "debounce",
      delay: 300,
    },
    onChange: (newValue: string, oldValue: string) => {
      // cf-change is emitted via timing controller to honor timingStrategy
      this.emit("cf-change", {
        value: newValue,
        oldValue,
        name: this.name,
        files: this.type === "file" ? this._input?.files : undefined,
      });
    },
  });

  /**
   * Form field controller, which handles buffering when in a `cf-form`
   * context.
   */
  private _formField = createFormFieldController<string>(this, {
    cellController: this._cellController,
    validate: () => ({
      valid: this.checkValidity(),
      message: this.validationMessage,
    }),
  });

  constructor() {
    super();
    this.#internals = this.attachInternals();
    this.type = "text";
    this.placeholder = "";
    this.value = "";
    this.disabled = false;
    this.readonly = false;
    this.error = false;
    this.name = "";
    this.required = false;
    this.autofocus = false;
    this.autocomplete = "";
    this.min = "";
    this.max = "";
    this.step = "";
    this.pattern = "";
    this.maxlength = "";
    this.minlength = "";
    this.inputmode = "text";
    this.size = "md";
    this.length = 0;
    this.multiple = false;
    this.accept = "";
    this.list = "";
    this.spellcheck = true;
    this.validationPattern = "";
    this.showValidation = false;
    this.timingStrategy = "debounce";
    this.timingDelay = 300;
    this.addEventListener("focus", this._forwardFocusToInput);
  }

  /**
   * A theme given to this element directly, written over the theme it would
   * otherwise inherit. Left unset, the element draws the ambient theme.
   */
  @property({ attribute: false })
  accessor theme: CFTheme | undefined = undefined;

  private get input(): HTMLInputElement | null {
    if (!this._input) {
      this._input = this.shadowRoot?.querySelector("input") || null;
    }
    return this._input;
  }

  private getValue(): string {
    return this._formField.getValue();
  }

  private setValue(newValue: string): void {
    this._formField.setValue(newValue);
  }

  /**
   * Flushes any pending edit and awaits its confirmed commit to the bound cell.
   * Resolves once the runtime commits the typed value, and rejects when the
   * write fails. When the field is not bound to a cell, falls back to the cell
   * controller's `setValue()`.
   *
   * This is for standalone inputs. Inside a cf-form the form owns durable writes
   * and flushes every field atomically on submit, so commit() resolves without
   * writing: the edit stays buffered for the form's submit rather than
   * persisting on its own.
   */
  commit(): Promise<void> {
    return this._formField.commit();
  }

  private getPattern(): string {
    // Use custom pattern if provided
    if (this.pattern) {
      return this.pattern;
    }

    // Use validation pattern if specified
    if (
      this.validationPattern && this.validationPattern in INPUT_PATTERNS
    ) {
      return INPUT_PATTERNS[this.validationPattern];
    }

    // Use default patterns for specific types
    if (this.type === "email" && !this.pattern) {
      return INPUT_PATTERNS.email;
    }
    if (this.type === "url" && !this.pattern) {
      return INPUT_PATTERNS.url;
    }

    return "";
  }

  private getInputMode(): InputMode {
    // Use explicit inputmode if provided
    if (this.inputmode && this.inputmode !== "text") {
      return this.inputmode;
    }

    // Return appropriate inputmode based on type
    switch (this.type) {
      case "email":
        return "email";
      case "tel":
        return "tel";
      case "url":
        return "url";
      case "number":
        return "numeric";
      case "search":
        return "search";
      default:
        return "text";
    }
  }

  private getValidationClass(): string {
    if (!this.showValidation) {
      return this.error ? "error" : "";
    }

    // Check native validation
    const isValid = this.checkValidity();
    return isValid ? "" : "error";
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Controllers handle cleanup automatically via ReactiveController
  }

  override willUpdate(changedProperties: Map<string, any>) {
    super.willUpdate(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      // Bind the new cell first so getValue() returns the new value
      this._cellController.bind(this.value, stringSchema);
      // Then clear buffer - this captures the new cell's value as baseline for reset/dirty
      this._formField.clearBuffer();
    }
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    // If value changed, ensure the DOM input is synchronized
    if (changedProperties.has("value") && this.input) {
      const currentValue = this.getValue();
      if (this.input.value !== currentValue) {
        this.input.value = currentValue;
      }
    }

    // Update timing controller if timing options changed
    if (
      changedProperties.has("timingStrategy") ||
      changedProperties.has("timingDelay")
    ) {
      this._cellController.updateTimingOptions({
        strategy: this.timingStrategy,
        delay: this.timingDelay,
      });
    }

    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme);
    }

    if (
      changedProperties.has("disabled") ||
      changedProperties.has("readonly") ||
      changedProperties.has("required") ||
      changedProperties.has("error") ||
      changedProperties.has("showValidation") ||
      changedProperties.has("placeholder") ||
      changedProperties.has("type") ||
      changedProperties.has("value")
    ) {
      this._updateAccessibilityAttributes();
    }
  }

  override firstUpdated() {
    // Cache the input element reference
    this._input = this.shadowRoot?.querySelector("input") || null;

    // Bind the initial value to the cell controller
    this._cellController.bind(this.value, stringSchema);

    // Update timing options to match current properties
    this._cellController.updateTimingOptions({
      strategy: this.timingStrategy,
      delay: this.timingDelay,
    });

    // Register with form after binding is complete
    this._formField.register(this.name);

    if (this.autofocus) {
      this._input?.focus();
    }

    this._updateAccessibilityAttributes();
  }

  override connectedCallback() {
    super.connectedCallback();
    this._updateAccessibilityAttributes();
  }

  override render() {
    const pattern = this.getPattern();
    const inputMode = this.getInputMode();
    const validationClass = this.getValidationClass();

    // For file inputs, we can't set the value programmatically
    const inputValue = this.type === "file" ? undefined : this.getValue();

    // The host element carries the ARIA role and tabindex for accessibility.
    // The inner input is removed from the sequential tab order; when the host
    // receives focus, we forward focus here so typing and selection work.
    // Avoid delegatesFocus: it can make the shadow control appear to be the
    // active tab stop instead of the host that owns the ARIA surface.
    return html`
      <input
        type="${this.type}"
        data-cf-input
        class="${validationClass}"
        placeholder="${ifDefined(this.placeholder || undefined)}"
        .value="${ifDefined(inputValue)}"
        ?disabled="${this.disabled}"
        ?readonly="${this.readonly}"
        ?required="${this.required}"
        name="${ifDefined(this.name || undefined)}"
        autocomplete="${ifDefined(this.autocomplete || undefined)}"
        min="${ifDefined(this.min || undefined)}"
        max="${ifDefined(this.max || undefined)}"
        step="${ifDefined(this.step || undefined)}"
        pattern="${ifDefined(pattern || undefined)}"
        maxlength="${ifDefined(this.maxlength || undefined)}"
        minlength="${ifDefined(this.minlength || undefined)}"
        inputmode="${ifDefined(inputMode || undefined)}"
        size="${ifDefined(this.length || undefined)}"
        ?multiple="${this.multiple && this.type === "file"}"
        accept="${ifDefined(
          this.accept && this.type === "file" ? this.accept : undefined,
        )}"
        list="${ifDefined(this.list || undefined)}"
        ?spellcheck="${this.spellcheck}"
        @input="${this._handleInput}"
        @change="${this._handleChange}"
        @focus="${this._handleFocus}"
        @blur="${this._handleBlur}"
        @keydown="${this._handleKeyDown}"
        @invalid="${this._handleInvalid}"
        part="input"
        tabindex="-1"
      />
    `;
  }

  private _handleInput(event: Event) {
    const input = event.target as HTMLInputElement;
    const oldValue = this.getValue();

    // For file inputs, we can't set the value programmatically
    if (this.type !== "file") {
      this.setValue(input.value);
    } else {
      // For file inputs, still emit the event with files
      this.setValue("");
    }

    // Emit cf-input event directly for non-cell interop
    this.emit("cf-input", {
      value: this.type === "file" ? "" : input.value,
      oldValue,
      name: this.name,
      files: this.type === "file" ? input.files : undefined,
    });
  }

  private _handleChange(event: Event) {
    const input = event.target as HTMLInputElement;

    // Update value through form field controller
    // cf-change is emitted by the cell controller's onChange callback
    // which honors the configured timingStrategy (debounce/throttle/blur)
    if (this.type !== "file") {
      this.setValue(input.value);
    } else {
      this.setValue("");
    }
  }

  private _handleFocus(_event: Event) {
    this._cellController.onFocus();
    this.emit("cf-focus", {
      value: this.getValue(),
      name: this.name,
    });
  }

  private _handleBlur(_event: Event) {
    this._cellController.onBlur();
    this.emit("cf-blur", {
      value: this.getValue(),
      name: this.name,
    });
  }

  private _handleKeyDown(event: KeyboardEvent) {
    this.emit("cf-keydown", {
      key: event.key,
      value: this.getValue(),
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      name: this.name,
    });

    // Special handling for Enter key
    if (event.key === "Enter") {
      this.emit("cf-submit", {
        value: this.getValue(),
        name: this.name,
      });
    }
  }

  private _forwardFocusToInput = () => {
    if (this.disabled) return;
    this.input?.focus();
  };

  private _handleInvalid(event: Event) {
    event.preventDefault(); // Prevent browser's default validation UI

    const input = event.target as HTMLInputElement;
    this.emit("cf-invalid", {
      value: this.getValue(),
      name: this.name,
      validationMessage: input.validationMessage,
      validity: input.validity,
    });

    // Update visual state if showValidation is enabled
    if (this.showValidation) {
      this.requestUpdate();
    }
    this._updateAccessibilityAttributes();
  }

  private _updateAccessibilityAttributes() {
    this._syncHostRole();
    if (!this.hasAttribute("exportparts")) {
      this.setAttribute("exportparts", "input");
    }
    this.tabIndex = this.disabled ? -1 : 0;
    this.setAttribute("aria-disabled", String(this.disabled));
    this.setAttribute("aria-readonly", String(this.readonly));
    this.setAttribute("aria-required", String(this.required));
    this._updateGeneratedAriaLabel();
    // Read .validity.valid directly instead of checkValidity() to avoid
    // firing the 'invalid' event, which would re-enter _handleInvalid.
    const nativeValid = this.input?.validity?.valid ?? true;
    this.setAttribute(
      "aria-invalid",
      String(this.error || !nativeValid),
    );
    this._syncValueAttributes();
    this._syncInternals();
  }

  /** Sync aria-valuemin/max/now for spinbutton and slider roles. */
  private _syncValueAttributes() {
    const role = this.getAttribute("role");
    if (role === "spinbutton" || role === "slider") {
      const min = this.min || (this.input?.min ?? "");
      const max = this.max || (this.input?.max ?? "");
      const val = this.input?.value ?? this.getValue();
      if (min) this.setAttribute("aria-valuemin", min);
      else this.removeAttribute("aria-valuemin");
      if (max) this.setAttribute("aria-valuemax", max);
      else this.removeAttribute("aria-valuemax");
      if (val) this.setAttribute("aria-valuenow", val);
      else this.removeAttribute("aria-valuenow");
    } else {
      this.removeAttribute("aria-valuemin");
      this.removeAttribute("aria-valuemax");
      this.removeAttribute("aria-valuenow");
    }
  }

  /** Sync value and validity to ElementInternals for native form participation. */
  private _syncInternals() {
    this.#internals.setFormValue(this.getValue());
    if (this.input) {
      this.#internals.setValidity(
        this.input.validity,
        this.input.validationMessage,
        this.input,
      );
    }
  }

  /** Map input type to the appropriate ARIA role on the host. */
  private _syncHostRole() {
    // Respect author-provided roles
    if (
      this.hasAttribute("role") &&
      this.getAttribute("role") !== this._lastGeneratedRole
    ) {
      return;
    }
    const role = this._roleForType(this.type);
    if (role) {
      this.setAttribute("role", role);
      this._lastGeneratedRole = role;
    } else if (this._lastGeneratedRole) {
      this.removeAttribute("role");
      this._lastGeneratedRole = null;
    }
  }

  private _lastGeneratedRole: string | null = null;

  private _roleForType(type: InputType): string | null {
    switch (type) {
      case "text":
      case "email":
      case "password":
      case "search":
      case "tel":
      case "url":
        return "textbox";
      case "number":
        return "spinbutton";
      case "range":
        return "slider";
      default:
        // date, time, datetime-local, month, week, color, file, hidden
        // — no widely-supported ARIA role; leave unset
        return null;
    }
  }

  private _updateGeneratedAriaLabel() {
    const ariaLabel = this.getAttribute("aria-label");
    const hasAuthorProvidedName = this.hasAttribute("aria-labelledby") ||
      (ariaLabel !== null && ariaLabel !== this._generatedAriaLabel);

    if (hasAuthorProvidedName) {
      this._generatedAriaLabel = null;
      return;
    }

    if (this.placeholder) {
      this.setAttribute("aria-label", this.placeholder);
      this._generatedAriaLabel = this.placeholder;
      return;
    }

    if (
      this._generatedAriaLabel !== null &&
      ariaLabel === this._generatedAriaLabel
    ) {
      this.removeAttribute("aria-label");
      this._generatedAriaLabel = null;
    }
  }

  override focus(options?: FocusOptions): void {
    if (this.disabled) return;
    const input = this.input;
    if (input) {
      input.focus(options);
      return;
    }

    // If focus is requested before the first render, keep focus on the
    // semantic host now, then forward it once the native input exists.
    super.focus(options);
    void this.updateComplete.then(() => {
      if (this.disabled || this.ownerDocument.activeElement !== this) {
        return;
      }
      this.input?.focus(options);
    });
  }

  /**
   * Blur the input programmatically
   */
  override blur(): void {
    this.input?.blur();
  }

  /**
   * Select all text in the input
   */
  select(): void {
    this.input?.select();
  }

  /**
   * Set selection range in the input
   */
  setSelectionRange(
    start: number,
    end: number,
    direction?: "forward" | "backward" | "none",
  ): void {
    this.input?.setSelectionRange(start, end, direction);
  }

  /**
   * Check validity of the input
   */
  checkValidity(): boolean {
    return this.input?.checkValidity() ?? true;
  }

  /**
   * Report validity of the input
   */
  reportValidity(): boolean {
    return this.input?.reportValidity() ?? true;
  }

  /**
   * Get the validity state
   */
  get validity(): ValidityState | undefined {
    return this.input?.validity;
  }

  /**
   * Get validation message
   */
  get validationMessage(): string {
    return this.input?.validationMessage || "";
  }

  /**
   * Set custom validity message
   */
  setCustomValidity(message: string): void {
    this.input?.setCustomValidity(message);
  }
}
