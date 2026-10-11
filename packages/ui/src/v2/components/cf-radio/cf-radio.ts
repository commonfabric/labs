import { css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFRadio - Single selection radio button component that works with cf-radio-group
 *
 * @element cf-radio
 *
 * @attr {boolean} checked - Whether the radio button is checked
 * @attr {boolean} disabled - Whether the radio button is disabled
 * @attr {string} name - Radio button group name (required for grouping)
 * @attr {string} value - The value of the radio button (required)
 * @attr {boolean} required - Whether the radio button is required
 *
 * @slot - Default slot for radio button label content
 *
 * @fires cf-change - Fired when the radio button state changes with detail: { checked, value }
 *
 * @example
 * <cf-radio name="option" value="yes" checked>Yes</cf-radio>
 * <cf-radio name="option" value="no">No</cf-radio>
 *
 * @note Use within cf-radio-group, which handles the arrow keys and the
 * selection among its radios. Each enabled radio is its own Tab stop.
 */

export class CFRadio extends BaseElement {
  static override styles = css`
    :host {
      display: inline-block;
      position: relative;
      cursor: pointer;
      line-height: 0;

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

    :host(:focus) {
      outline: none;
    }

    :host(:focus-visible) .radio {
      outline: 2px solid transparent;
      outline-offset: 2px;
      box-shadow:
        0 0 0 2px var(--background, #fff),
        0 0 0 4px var(--ring, #94a3b8);
    }

    .radio {
      position: relative;
      width: 1rem; /* size-4 */
      height: 1rem; /* size-4 */
      border: 1px solid var(--primary, #0f172a);
      border-radius: 50%; /* Full circle */
      background-color: var(--background, #fff);
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .radio.checked {
      border-color: var(--primary, #0f172a);
    }

    .radio.disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    /* Radio indicator - filled circle */
    .indicator {
      width: 0.5rem; /* Half the size of the radio */
      height: 0.5rem;
      border-radius: 50%;
      background-color: var(--primary, #0f172a);
      opacity: 0;
      transform: scale(0);
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    .radio.checked .indicator {
      opacity: 1;
      transform: scale(1);
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
    :host(:not([disabled]):hover) .radio:not(.checked) {
      border-color: var(--primary, #0f172a);
    }

    /* Animation for indicator */
    .radio.checked .indicator {
      animation: indicator-animation 200ms ease-out;
    }

    @keyframes indicator-animation {
      0% {
        transform: scale(0);
      }
      50% {
        transform: scale(1.2);
      }
      100% {
        transform: scale(1);
      }
    }
  `;

  static override properties = {
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    value: { type: String },
    name: { type: String },
  };

  declare checked: boolean;
  declare disabled: boolean;
  declare value: string;
  declare name: string;

  constructor() {
    super();
    this.checked = false;
    this.disabled = false;
    this.value = "";
    this.name = "";
  }

  override connectedCallback() {
    if (!this.hasAttribute("role")) {
      this.setAttribute("role", "radio");
    }
    if (!this.hasAttribute("exportparts")) {
      this.setAttribute("exportparts", "radio,indicator");
    }
    super.connectedCallback();
    this._updateAriaAttributes();

    // Host owns role="radio" and focus — handle interaction here so
    // keyboard (Space) and click both work regardless of where in the
    // component they land.
    this.addEventListener("click", this._handleClick);
    this.addEventListener("keydown", this._handleKeydown);

    // Check if within a radio group
    const radioGroup = this.closest("cf-radio-group");
    if (radioGroup) {
      // Let the radio group manage the name
      const groupName = radioGroup.getAttribute("name");
      if (groupName && !this.name) {
        this.name = groupName;
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("click", this._handleClick);
    this.removeEventListener("keydown", this._handleKeydown);
  }

  override updated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.updated(changedProperties);

    if (
      changedProperties.has("checked") || changedProperties.has("disabled")
    ) {
      this._updateAriaAttributes();
    }
  }

  override render() {
    const radioClasses = {
      "radio": true,
      "checked": this.checked,
      "disabled": this.disabled,
    };

    const classString = Object.entries(radioClasses)
      .filter(([_, value]) => value)
      .map(([key]) => key)
      .join(" ");

    return html`
      <div
        class="${classString}"
        part="radio"
      >
        <span class="indicator" part="indicator"></span>
      </div>
      <slot></slot>
      <input
        type="radio"
        class="sr-only"
        ?checked="${this.checked}"
        ?disabled="${this.disabled}"
        name="${ifDefined(this.name || undefined)}"
        value="${this.value}"
        tabindex="-1"
        aria-hidden="true"
      />
    `;
  }

  private _updateAriaAttributes() {
    this.setAttribute("aria-checked", String(this.checked));
    this.setAttribute("aria-disabled", String(this.disabled));
    this.tabIndex = this.disabled ? -1 : 0;
  }

  private _handleClick(event: Event) {
    if (this.disabled || this.checked) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Check if within a radio group
    const radioGroup = this.closest("cf-radio-group");
    if (radioGroup) {
      // Let the radio group handle the selection
      radioGroup.dispatchEvent(
        new CustomEvent("radio-click", {
          detail: { radio: this },
          bubbles: true,
        }),
      );
    } else {
      // Standalone radio button
      this.checked = true;
      this.emit("cf-change", { checked: this.checked, value: this.value });
    }
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
   * Focus the radio button programmatically
   */
  override focus(): void {
    super.focus();
  }

  /**
   * Blur the radio button programmatically
   */
  override blur(): void {
    super.blur();
  }
}
