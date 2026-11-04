import { stringSchema } from "@commonfabric/runner/schemas";
import { type CellHandle } from "@commonfabric/runtime-client";
import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";

import { BaseElement } from "../../core/base-element.ts";
import { createStringCellController } from "../../core/cell-controller.ts";
import { createFormFieldController } from "../../core/form-field-controller.ts";
import {
  applyThemeToElement,
  type CFTheme,
  type ComponentSize,
} from "../theme-context.ts";

export type TimingStrategy = "immediate" | "debounce" | "throttle" | "blur";

/**
 * CFTextarea - Multi-line text input with support for auto-resize, various states, and reactive data binding
 *
 * @element cf-textarea
 *
 * @attr {string} placeholder - Placeholder text
 * @attr {string|CellHandle<string>} value - Textarea value (supports both plain string and CellHandle<string>)
 * @attr {boolean} disabled - Whether the textarea is disabled
 * @attr {boolean} readonly - Whether the textarea is read-only
 * @attr {boolean} required - Whether the textarea is required
 * @attr {string} name - Name attribute for form submission
 * @attr {number} rows - Number of visible text rows
 * @attr {number} cols - Number of visible text columns
 * @attr {number} maxlength - Maximum number of characters allowed
 * @attr {boolean} auto-resize - Whether the textarea automatically resizes to fit content
 * @attr {string} timingStrategy - Input timing strategy: "immediate" | "debounce" | "throttle" | "blur"
 * @attr {number} timingDelay - Delay in milliseconds for debounce/throttle (default: 300)
 *
 * @fires cf-input - Fired on input with detail: { value, oldValue, name }
 * @fires cf-change - Fired on change with detail: { value, oldValue, name }
 * @fires cf-focus - Fired on focus with detail: { value, name }
 * @fires cf-blur - Fired on blur with detail: { value, name }
 * @fires cf-keydown - Fired on keydown with detail: { key, value, shiftKey, ctrlKey, metaKey, altKey, name }
 * @fires cf-submit - Fired on Ctrl/Cmd+Enter with detail: { value, name }
 *
 * @example
 * <cf-textarea rows="4" placeholder="Enter message" auto-resize></cf-textarea>
 *
 * @example
 * <!-- With Cell binding for two-way reactive updates -->
 * <cf-textarea .value="${myCell}" placeholder="Type here..."></cf-textarea>
 *
 * @example
 * <!-- Debounced input - waits 500ms after user stops typing -->
 * <cf-textarea timingStrategy="debounce" timingDelay="500" placeholder="Search..."></cf-textarea>
 */
export class CFTextarea extends BaseElement {
  static formAssociated = true;

  static override properties = {
    placeholder: { type: String },
    value: { type: String },
    disabled: { type: Boolean },
    readonly: { type: Boolean },
    error: { type: Boolean },
    rows: { type: Number },
    cols: { type: Number },
    name: { type: String },
    required: { type: Boolean },
    autofocus: { type: Boolean },
    maxlength: { type: String },
    minlength: { type: String },
    wrap: { type: String },
    spellcheck: { type: Boolean },
    autocomplete: { type: String },
    resize: { type: String },
    autoResize: { type: Boolean, attribute: "auto-resize" },
    timingStrategy: { type: String, attribute: "timing-strategy" },
    timingDelay: { type: Number, attribute: "timing-delay" },
    size: { type: String, reflect: true },
  };
  declare placeholder: string;
  declare value: CellHandle<string> | string;
  declare disabled: boolean;
  declare readonly: boolean;
  declare error: boolean;
  declare rows: number;
  declare cols: number;
  declare name: string;
  declare required: boolean;
  declare autofocus: boolean;
  declare maxlength: string;
  declare minlength: string;
  declare wrap: string;
  declare spellcheck: boolean;
  declare autocomplete: string;
  declare resize: string;
  declare autoResize: boolean;
  declare timingStrategy: TimingStrategy;
  declare timingDelay: number;
  declare size: ComponentSize;

  static override styles = css`
    :host {
      --cf-textarea-color-background: var(--cf-theme-color-background, #ffffff);
      --cf-textarea-color-text: var(--cf-theme-color-text, #0f172a);
      --cf-textarea-color-border: var(--cf-theme-color-border, #e2e8f0);
      --cf-textarea-color-primary: var(--cf-theme-color-primary, #3b82f6);
      --cf-textarea-color-error: var(--cf-theme-color-error, #dc2626);
      --cf-textarea-color-surface: var(--cf-theme-color-surface, #f1f5f9);
      --cf-textarea-color-text-muted: var(--cf-theme-color-text-muted, #64748b);
      --cf-textarea-color-placeholder: #94a3b8;
      --cf-textarea-border-radius: var(--cf-theme-border-radius, 0.375rem);
      --cf-textarea-font-family: var(--cf-theme-font-family, inherit);
      --cf-textarea-animation-duration: var(--cf-theme-animation-duration, 150ms);

      /* Default color values if not provided */
      --background: var(--cf-textarea-color-background, #ffffff);
      --foreground: var(--cf-textarea-color-text, #0f172a);
      --border: var(--cf-textarea-color-border, #e2e8f0);
      --ring: var(--cf-textarea-color-primary, #3b82f6);
      --destructive: var(--cf-textarea-color-error, #dc2626);
      --muted: var(--cf-textarea-color-surface, #f1f5f9);
      --muted-foreground: var(--cf-textarea-color-text-muted, #64748b);
      --placeholder: var(--cf-textarea-color-placeholder, #94a3b8);

      /* Textarea dimensions — default size md */
      --textarea-padding-x: var(--cf-size-md-padding-h, 8px);
      --textarea-padding-y: var(--cf-size-md-padding-v, 8px);
      --textarea-font-size: var(--cf-size-md-font-size, 12px);
      --textarea-line-height: var(--cf-size-md-line-height, 16px);
      --textarea-border-radius: var(--cf-size-md-radius, 8px);
      --textarea-min-height: 5rem;

      display: block;
      width: 100%;
    }

    :host([size="xs"]) {
      --textarea-padding-x: var(--cf-size-xs-padding-h, 4px);
      --textarea-padding-y: var(--cf-size-xs-padding-v, 2px);
      --textarea-font-size: var(--cf-size-xs-font-size, 9px);
      --textarea-line-height: var(--cf-size-xs-line-height, 12px);
      --textarea-border-radius: var(--cf-size-xs-radius, 4px);
    }

    :host([size="sm"]) {
      --textarea-padding-x: var(--cf-size-sm-padding-h, 6px);
      --textarea-padding-y: var(--cf-size-sm-padding-v, 4px);
      --textarea-font-size: var(--cf-size-sm-font-size, 11px);
      --textarea-line-height: var(--cf-size-sm-line-height, 16px);
      --textarea-border-radius: var(--cf-size-sm-radius, 5px);
    }

    :host([size="lg"]) {
      --textarea-padding-x: var(--cf-size-lg-padding-h, 12px);
      --textarea-padding-y: var(--cf-size-lg-padding-v, 8px);
      --textarea-font-size: var(--cf-size-lg-font-size, 16px);
      --textarea-line-height: var(--cf-size-lg-line-height, 20px);
      --textarea-border-radius: var(--cf-size-lg-radius, 9px);
    }

    :host([size="xl"]) {
      --textarea-padding-x: var(--cf-size-xl-padding-h, 16px);
      --textarea-padding-y: var(--cf-size-xl-padding-v, 12px);
      --textarea-font-size: var(--cf-size-xl-font-size, 18px);
      --textarea-line-height: var(--cf-size-xl-line-height, 24px);
      --textarea-border-radius: var(--cf-size-xl-radius, 10px);
    }

    textarea {
      all: unset;
      box-sizing: border-box;
      width: 100%;
      min-height: var(--textarea-min-height);
      padding: var(--textarea-padding-y) var(--textarea-padding-x);
      font-size: var(--textarea-font-size);
      line-height: var(--textarea-line-height);
      font-family: var(--cf-textarea-font-family, inherit);
      color: var(--foreground);
      background-color: var(--background);
      border: 1px solid var(--border);
      border-radius: var(--textarea-border-radius);
      transition: all var(--cf-textarea-animation-duration, 150ms)
        var(--cf-transition-timing-ease);
      display: block;
      overflow: auto;
      word-wrap: break-word;
      white-space: pre-wrap;
    }

    /* Default resize behavior */
    textarea {
      resize: vertical;
    }

    /* Override resize when specified */
    textarea[style*="resize: none"] {
      resize: none !important;
    }

    textarea[style*="resize: horizontal"] {
      resize: horizontal !important;
    }

    textarea[style*="resize: both"] {
      resize: both !important;
    }

    textarea::placeholder {
      color: var(--placeholder);
      opacity: 1;
    }

    textarea::-webkit-input-placeholder {
      color: var(--placeholder);
      opacity: 1;
    }

    textarea::-moz-placeholder {
      color: var(--placeholder);
      opacity: 1;
    }

    textarea:-ms-input-placeholder {
      color: var(--placeholder);
      opacity: 1;
    }

    /* Focus state */
    textarea:focus {
      outline: 2px solid transparent;
      outline-offset: 2px;
      border-color: var(--ring);
      box-shadow: 0 0 0 3px
        var(--cf-textarea-color-primary, rgba(59, 130, 246, 0.15));
    }

    textarea:focus-visible {
      outline: 2px solid transparent;
      outline-offset: 2px;
      border-color: var(--ring);
      box-shadow: 0 0 0 3px
        var(--cf-textarea-color-primary, rgba(59, 130, 246, 0.15));
    }

    /* Disabled state */
    textarea:disabled {
      cursor: not-allowed;
      opacity: 0.5;
      background-color: var(--muted);
      resize: none;
    }

    /* Readonly state */
    textarea:read-only {
      background-color: var(--muted);
      cursor: default;
    }

    /* Error state */
    textarea.error {
      border-color: var(--destructive);
    }

    textarea.error:focus,
    textarea.error:focus-visible {
      border-color: var(--destructive);
      box-shadow: 0 0 0 3px
        var(--cf-textarea-color-error, rgba(220, 38, 38, 0.1));
    }

    /* Scrollbar styling */
    textarea::-webkit-scrollbar {
      width: 0.5rem;
      height: 0.5rem;
    }

    textarea::-webkit-scrollbar-track {
      background-color: var(--muted);
      border-radius: calc(var(--textarea-border-radius) * 0.5);
    }

    textarea::-webkit-scrollbar-thumb {
      background-color: var(--border);
      border-radius: calc(var(--textarea-border-radius) * 0.5);
      transition: background-color var(--cf-textarea-animation-duration, 150ms);
    }

    textarea::-webkit-scrollbar-thumb:hover {
      background-color: var(--muted-foreground);
    }

    /* Firefox scrollbar styling */
    textarea {
      scrollbar-width: thin;
      scrollbar-color: var(--border) var(--muted);
    }

    /* Autofill styles */
    textarea:-webkit-autofill,
    textarea:-webkit-autofill:hover,
    textarea:-webkit-autofill:focus {
      -webkit-text-fill-color: var(--foreground);
      -webkit-box-shadow: 0 0 0px 1000px var(--muted) inset;
      transition: background-color 5000s ease-in-out 0s;
    }

    /* Selection styles */
    textarea::selection {
      background-color: var(--ring);
      color: var(--background);
      opacity: 0.3;
    }

    textarea::-moz-selection {
      background-color: var(--ring);
      color: var(--background);
      opacity: 0.3;
    }

    /* Auto-resize specific styles */
    :host([auto-resize]) textarea {
      overflow-y: hidden;
    }
  `;

  /**
   * A theme given to this element directly, written over the theme it would
   * otherwise inherit. Left unset, the element draws the ambient theme.
   */
  @property({ attribute: false })
  accessor theme: CFTheme | undefined = undefined;

  #internals: ElementInternals;
  private _generatedAriaLabel: string | null = null;

  //
  // Cache + initial setup
  //

  private _textarea: HTMLTextAreaElement | null = null;
  private _cellController = createStringCellController(this, {
    timing: {
      strategy: "debounce",
      delay: 300,
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
    this.placeholder = "";
    this.value = "";
    this.disabled = false;
    this.readonly = false;
    this.error = false;
    this.rows = 4;
    this.cols = 50;
    this.name = "";
    this.required = false;
    this.autofocus = false;
    this.maxlength = "";
    this.minlength = "";
    this.wrap = "soft";
    this.spellcheck = true;
    this.autocomplete = "off";
    this.resize = "vertical";
    this.autoResize = false;
    this.timingStrategy = "debounce";
    this.timingDelay = 300;
    this.size = "md";
    this.addEventListener("focus", this._forwardFocusToTextarea);
  }

  private getValue(): string {
    return this._formField.getValue();
  }

  private setValue(newValue: string): void {
    this._formField.setValue(newValue);
  }

  get textarea(): HTMLTextAreaElement | null {
    if (!this._textarea) {
      this._textarea = this.shadowRoot?.querySelector("textarea") as
        | HTMLTextAreaElement
        | null;
    }
    return this._textarea;
  }

  private _minHeight = 0;

  override firstUpdated() {
    // Cache reference
    this._textarea = this.shadowRoot?.querySelector("textarea") as
      | HTMLTextAreaElement
      | null;

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
      this.textarea?.focus();
    }

    // Store initial height for auto-resize
    if (this.autoResize && this.textarea) {
      this._minHeight = this.textarea.scrollHeight;
      this.adjustHeight();
    }

    this._updateAccessibilityAttributes();
  }

  override connectedCallback() {
    // Set host attributes before super triggers rendering.
    // Cannot be in the constructor — the custom element spec forbids
    // setAttribute during construction.
    if (!this.hasAttribute("role")) {
      this.setAttribute("role", "textbox");
    }
    if (!this.hasAttribute("exportparts")) {
      this.setAttribute("exportparts", "textarea");
    }
    super.connectedCallback();
    this._updateAccessibilityAttributes();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Controllers handle cleanup automatically via ReactiveController
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);

    // Bind value in willUpdate (before render) to avoid extra render cycle
    if (changedProperties.has("value")) {
      // Bind the new cell first so getValue() returns the new value
      this._cellController.bind(this.value, stringSchema);
      // Then clear buffer - this captures the new cell's value as baseline for reset/dirty
      this._formField.clearBuffer();
    }
  }

  override updated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.updated(changedProperties);

    // Update timing options if they changed
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

    if (changedProperties.has("value") && this.autoResize) {
      this.adjustHeight();
    }

    if (changedProperties.has("autoResize")) {
      if (this.autoResize) {
        this.resize = "none";
        if (this.textarea) {
          this._minHeight = this.textarea.scrollHeight;
          this.adjustHeight();
        }
      } else {
        this.resize = "vertical";
      }
    }

    if (
      changedProperties.has("disabled") ||
      changedProperties.has("readonly") ||
      changedProperties.has("required") ||
      changedProperties.has("error") ||
      changedProperties.has("placeholder") ||
      changedProperties.has("value")
    ) {
      this._updateAccessibilityAttributes();
    }
  }

  override render() {
    const resizeStyle = this.resize === "none" || this.autoResize
      ? "resize: none;"
      : `resize: ${this.resize};`;

    // The host carries the ARIA role and tabindex. The inner textarea is
    // removed from sequential tab order; host focus forwards here so
    // typing and selection work. Avoid delegatesFocus: it can make the
    // shadow control appear to be the active tab stop instead of the host
    // that owns the ARIA surface.
    return html`
      <textarea
        class="${this.error ? "error" : ""}"
        style="${resizeStyle}"
        placeholder="${ifDefined(this.placeholder || undefined)}"
        .value="${this.getValue()}"
        ?disabled="${this.disabled}"
        ?readonly="${this.readonly}"
        ?required="${this.required}"
        name="${ifDefined(this.name || undefined)}"
        rows="${this.rows}"
        cols="${this.cols}"
        wrap="${this.wrap}"
        ?spellcheck="${this.spellcheck}"
        autocomplete="${this.autocomplete}"
        maxlength="${ifDefined(this.maxlength || undefined)}"
        minlength="${ifDefined(this.minlength || undefined)}"
        @input="${this._handleInput}"
        @change="${this._handleChange}"
        @focus="${this._handleFocus}"
        @blur="${this._handleBlur}"
        @keydown="${this._handleKeyDown}"
        part="textarea"
        tabindex="-1"
      ></textarea>
    `;
  }

  private _handleInput(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    const oldValue = this.getValue();
    this.setValue(textarea.value);

    // Auto-resize if enabled
    if (this.autoResize) {
      this.adjustHeight();
    }

    // Emit custom input event
    this.emit("cf-input", {
      value: textarea.value,
      oldValue,
      name: this.name,
    });
  }

  private _handleChange(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    const oldValue = this.getValue();

    // Emit custom change event
    this.emit("cf-change", {
      value: textarea.value,
      oldValue,
      name: this.name,
    });
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

    // Special handling for Enter key with modifiers
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      this.emit("cf-submit", {
        value: this.getValue(),
        name: this.name,
      });
    }
  }

  private _forwardFocusToTextarea = () => {
    if (this.disabled) return;
    this.textarea?.focus();
  };

  private _updateAccessibilityAttributes() {
    // Respect author-provided role; only set our generated role when none exists
    if (!this.hasAttribute("role")) {
      this.setAttribute("role", "textbox");
    }
    if (!this.hasAttribute("exportparts")) {
      this.setAttribute("exportparts", "textarea");
    }
    this.tabIndex = this.disabled ? -1 : 0;
    this.setAttribute("aria-disabled", String(this.disabled));
    this.setAttribute("aria-readonly", String(this.readonly));
    this.setAttribute("aria-required", String(this.required));
    this._updateGeneratedAriaLabel();
    // Read .validity.valid directly to avoid firing the 'invalid' event.
    const nativeValid = this.textarea?.validity?.valid ?? true;
    this.setAttribute(
      "aria-invalid",
      String(this.error || !nativeValid),
    );
    this._syncInternals();
  }

  /** Sync value and validity to ElementInternals for native form participation. */
  private _syncInternals() {
    this.#internals.setFormValue(this.getValue());
    if (this.textarea) {
      this.#internals.setValidity(
        this.textarea.validity,
        this.textarea.validationMessage,
        this.textarea,
      );
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

  /**
   * Adjust height for auto-resize functionality
   */
  private adjustHeight(): void {
    if (!this.textarea || !this.autoResize) return;

    // Reset height to recalculate
    (this.textarea as HTMLTextAreaElement).style.height = "auto";

    // Set new height based on scrollHeight
    const newHeight = Math.max(
      this._minHeight,
      (this.textarea as HTMLTextAreaElement).scrollHeight,
    );
    (this.textarea as HTMLTextAreaElement).style.height = `${newHeight}px`;
  }

  override focus(options?: FocusOptions): void {
    if (this.disabled) return;
    this.textarea?.focus(options);
  }

  /**
   * Blur the textarea programmatically
   */
  override blur(): void {
    this.textarea?.blur();
  }

  /**
   * Select all text in the textarea
   */
  select(): void {
    this.textarea?.select();
  }

  /**
   * Set selection range in the textarea
   */
  setSelectionRange(
    start: number,
    end: number,
    direction?: "forward" | "backward" | "none",
  ): void {
    this.textarea?.setSelectionRange(start, end, direction);
  }

  /**
   * Check validity of the textarea
   */
  checkValidity(): boolean {
    return this.textarea?.checkValidity() ?? true;
  }

  /**
   * Report validity of the textarea
   */
  reportValidity(): boolean {
    return this.textarea?.reportValidity() ?? true;
  }

  /**
   * Get the validity state
   */
  get validity(): ValidityState | undefined {
    return this.textarea?.validity;
  }

  /**
   * Get validation message
   */
  get validationMessage(): string {
    return this.textarea?.validationMessage || "";
  }

  /**
   * Set custom validity message
   */
  setCustomValidity(message: string): void {
    this.textarea?.setCustomValidity(message);
  }
}
