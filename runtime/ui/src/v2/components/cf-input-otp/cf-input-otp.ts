import { html, PropertyValues, unsafeCSS } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { BaseElement } from "../../core/base-element.ts";
import { inputOTPStyles } from "./styles.ts";

/**
 * CFInputOTP - One-time password input with individual digit fields
 *
 * @element cf-input-otp
 *
 * @attr {number} length - Number of digits (default: 6)
 * @attr {string} value - Current OTP value
 * @attr {boolean} disabled - Whether the input is disabled
 * @attr {string} name - Name attribute for form submission
 *
 * @fires cf-change - Fired on value change with detail: { value, complete }
 * @fires cf-complete - Fired when all digits entered with detail: { value }
 *
 * @method focus() - Focus first input
 * @method clear() - Clear all inputs
 *
 * @example
 * <cf-input-otp length="6" name="otp"></cf-input-otp>
 */
export class CFInputOTP extends BaseElement {
  static override properties = {
    length: { type: Number },
    value: { type: String },
    disabled: { type: Boolean, reflect: true },
    name: { type: String },
    placeholder: { type: String },
    autoComplete: { type: Boolean },
    autofocus: { type: Boolean },
  };
  static override styles = unsafeCSS(inputOTPStyles);

  declare length: number;
  declare value: string;
  declare disabled: boolean;
  declare name: string;
  declare placeholder: string;
  declare autoComplete: boolean;
  declare autofocus: boolean;

  private _inputs: NodeListOf<HTMLInputElement> | null = null;

  constructor() {
    super();
    this.length = 6;
    this.value = "";
    this.disabled = false;
    this.name = "";
    this.placeholder = "○";
    this.autoComplete = false;
    this.autofocus = false;
  }

  get inputs(): NodeListOf<HTMLInputElement> | null {
    if (!this._inputs) {
      this._inputs = this.shadowRoot?.querySelectorAll("input[type='text']") as
        | NodeListOf<HTMLInputElement>
        | null;
    }
    return this._inputs;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Handle autofocus
    if (this.autofocus) {
      setTimeout(() => this.focus(), 0);
    }
  }

  override firstUpdated() {
    // Cache references
    this._inputs = this.shadowRoot?.querySelectorAll("input[type='text']") as
      | NodeListOf<HTMLInputElement>
      | null;
    // Initialize input values
    this._updateInputValues();
  }

  override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);

    if (changedProperties.has("value")) {
      this._updateInputValues();
    }
  }

  override render() {
    const digits = Array.from({ length: this.length }, (_, i) => i);

    return html`
      <div class="otp-container" part="container">
        ${repeat(
          digits,
          (i) => i,
          (i) =>
            html`
              <input
                type="text"
                inputmode="numeric"
                pattern="[0-9]"
                maxlength="1"
                class="${classMap({
                  "otp-input": true,
                  "filled": !!this.value[i],
                })}"
                part="input"
                .value="${this.value[i] || ""}"
                ?disabled="${this.disabled}"
                placeholder="${this.placeholder}"
                autocomplete="${this.autoComplete ? "one-time-code" : "off"}"
                @input="${(e: Event) => this._handleInput(e, i)}"
                @keydown="${(e: KeyboardEvent) => this._handleKeyDown(e, i)}"
                @paste="${(e: ClipboardEvent) => this._handlePaste(e, i)}"
                @focus="${(e: FocusEvent) => this._handleFocus(e, i)}"
                aria-label="${`Digit ${i + 1} of ${this.length}`}"
              />
            `,
        )}
      </div>
      ${this.name
        ? html`
          <input type="hidden" name="${this.name}" .value="${this.value}" />
        `
        : null}
    `;
  }

  private _handleInput(event: Event, index: number): void {
    const input = event.target as HTMLInputElement;
    const value = input.value;

    // Only allow single digit
    if (value.length > 1) {
      input.value = value.slice(-1);
    }

    // Only allow numbers
    if (value && !/^\d$/.test(value)) {
      input.value = "";
      return;
    }

    // Update value
    const newValue = this.value.split("");
    newValue[index] = value;
    this.value = newValue.join("").slice(0, this.length);

    // Move to next input if value entered
    if (value && index < this.length - 1) {
      const nextInput = this.inputs?.[index + 1] as
        | HTMLInputElement
        | undefined;
      nextInput?.focus();
      nextInput?.select();
    }

    // Emit events
    const complete = this.value.length === this.length;
    this.emit("cf-change", { value: this.value, complete });

    if (complete) {
      this.emit("cf-complete", { value: this.value });
    }
  }

  private _handleKeyDown(event: KeyboardEvent, index: number): void {
    const input = event.target as HTMLInputElement;

    switch (event.key) {
      case "Backspace":
        if (!input.value && index > 0) {
          // Move to previous input
          event.preventDefault();
          const prevInput = this.inputs?.[index - 1] as
            | HTMLInputElement
            | undefined;
          prevInput?.focus();
          prevInput?.select();
        }
        break;

      case "ArrowLeft":
        if (index > 0) {
          event.preventDefault();
          (this.inputs?.[index - 1] as HTMLInputElement | undefined)?.focus();
        }
        break;

      case "ArrowRight":
        if (index < this.length - 1) {
          event.preventDefault();
          (this.inputs?.[index + 1] as HTMLInputElement | undefined)?.focus();
        }
        break;

      case "Home":
        event.preventDefault();
        (this.inputs?.[0] as HTMLInputElement | undefined)?.focus();
        break;

      case "End":
        event.preventDefault();
        (this.inputs?.[this.length - 1] as HTMLInputElement | undefined)
          ?.focus();
        break;
    }
  }

  private _handlePaste(event: ClipboardEvent, startIndex: number): void {
    event.preventDefault();
    const pastedData = event.clipboardData?.getData("text") || "";
    const digits = pastedData.replace(/\D/g, "").slice(
      0,
      this.length - startIndex,
    );

    if (digits) {
      const newValue = this.value.split("");
      for (let i = 0; i < digits.length; i++) {
        newValue[startIndex + i] = digits[i];
      }
      this.value = newValue.join("").slice(0, this.length);

      // Focus the next empty input or the last input
      const nextEmptyIndex = this.value.length < this.length
        ? this.value.length
        : this.length - 1;
      (this.inputs?.[nextEmptyIndex] as HTMLInputElement | undefined)?.focus();

      // Emit events
      const complete = this.value.length === this.length;
      this.emit("cf-change", { value: this.value, complete });

      if (complete) {
        this.emit("cf-complete", { value: this.value });
      }
    }
  }

  private _handleFocus(event: FocusEvent, _index: number): void {
    const input = event.target as HTMLInputElement;
    input.select();
  }

  private _updateInputValues(): void {
    const inputs = this.inputs;
    if (!inputs) return;

    inputs.forEach((input: HTMLInputElement, index: number) => {
      input.value = this.value[index] || "";
    });
  }

  /**
   * Focus the first input
   */
  override focus(): void {
    (this.inputs?.[0] as HTMLInputElement | undefined)?.focus();
  }

  /**
   * Clear all inputs
   */
  clear(): void {
    this.value = "";
    this.focus();
  }
}
