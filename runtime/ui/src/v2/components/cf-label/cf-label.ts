import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFLabel - Form field label with accessibility features.
 *
 * Use cf-text for generic captions, helper copy, metadata, or muted display
 * text that does not label a specific control.
 *
 * @element cf-label
 *
 * @attr {string} for - ID of associated input element
 * @attr {boolean} required - Shows asterisk for required fields
 * @attr {boolean} disabled - Whether the label is disabled
 *
 * @slot - Default slot for label text
 *
 * @fires cf-label-click - Fired on click with detail: { targetId, targetElement }
 *
 * @example
 * <cf-label for="email" required>Email Address</cf-label>
 * <cf-input id="email" type="email"></cf-input>
 */

export class CFLabel extends BaseElement {
  static override styles = css`
    :host {
      --cf-label-color-text: var(--cf-theme-color-text, hsl(0, 0%, 9%));
      --cf-label-color-required: var(--cf-theme-color-error, hsl(0, 100%, 50%));

      display: inline-block;
      box-sizing: border-box;
    }

    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }

    .label {
      display: inline-flex;
      align-items: baseline;
      gap: 0.25rem;
      font-size: var(--cf-font-body-compact-size, 0.8125rem);
      font-weight: var(--cf-font-body-compact-weight, 500);
      line-height: var(--cf-font-body-compact-line-height, 1.25rem);
      letter-spacing: var(--cf-font-body-compact-letter-spacing, 0);
      color: var(--cf-label-color-text, hsl(0, 0%, 9%));
      cursor: pointer;
      user-select: none;
    }

    .label.disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .required-indicator {
      color: var(--cf-label-color-required, hsl(0, 100%, 50%));
      font-weight: var(--cf-font-weight-semibold, 600);
      line-height: var(--cf-line-height-none, 1);
      margin-left: 0.125rem;
    }

    /* When used with peer elements */
    :host(:has(+ :disabled)),
    :host(:has(+ [disabled])) .label {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;

  static override properties = {
    for: { type: String },
    required: { type: Boolean },
    disabled: { type: Boolean },
  };

  declare for: string | null;
  declare required: boolean;
  declare disabled: boolean;

  constructor() {
    super();
    this.for = null;
    this.required = false;
    this.disabled = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("click", this._handleClick);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("click", this._handleClick);
  }

  override render() {
    return html`
      <label
        class="label ${this.disabled ? "disabled" : ""}"
        part="label"
      >
        <slot></slot>
        ${this.required
          ? html`
            <span class="required-indicator" part="required">*</span>
          `
          : null}
      </label>
    `;
  }

  private _handleClick = (_event: Event): void => {
    // If label has a 'for' attribute, find and focus the associated element
    if (this.for && !this.disabled) {
      // Look for the element in the parent document
      const root = this.getRootNode() as Document | ShadowRoot;
      const targetElement = root.querySelector(
        `#${CSS.escape(this.for)}`,
      ) as HTMLElement;

      if (targetElement) {
        // Focus the element if it's focusable
        if (
          "focus" in targetElement && typeof targetElement.focus === "function"
        ) {
          targetElement.focus();

          // For custom elements, also try clicking them
          if (targetElement.tagName.includes("-")) {
            targetElement.click();
          }
        }

        // Emit custom event
        this.emit("cf-label-click", {
          targetId: this.for,
          targetElement: targetElement,
        });
      }
    }
  };

  /**
   * Get the associated control element
   */
  getControl(): HTMLElement | null {
    if (!this.for) return null;

    const root = this.getRootNode() as Document | ShadowRoot;
    return root.querySelector(`#${CSS.escape(this.for)}`) as HTMLElement;
  }

  /**
   * Focus the associated control element
   */
  focusControl(): void {
    const control = this.getControl();
    if (control && "focus" in control && typeof control.focus === "function") {
      control.focus();
    }
  }
}
