import { css, html, nothing } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFField - Labeled form field wrapper.
 *
 * Replaces the hand-rolled "muted label above a control" stack used
 * throughout patterns:
 *
 * ```html
 * <cf-vstack>
 *   <label style="font-size: 12px; color: #6b7280">Label</label>
 *   <cf-input $value={field} />
 * </cf-vstack>
 * ```
 *
 * This is a layout/typography wrapper only — it renders a small muted label
 * above the slotted control, plus optional help and error text below it. It
 * is not a form engine: validation wiring belongs to cf-form / the control.
 *
 * Accessibility: shadow DOM prevents a programmatic `for`/`id` association
 * between the internal label and the slotted (light DOM) control, and cf-*
 * controls are not native labelable elements anyway. As a pragmatic
 * substitute, clicking the label focuses (and for custom elements, clicks)
 * the first slotted element — the same approach cf-label takes. For full
 * AT support, also set an `aria-label` on the control itself.
 *
 * @element cf-field
 *
 * @attr {string} label - Field label text shown above the control
 * @attr {boolean} required - Shows a required indicator (asterisk) after the label
 * @attr {string} error - Error text shown below the control in the danger color (replaces help)
 * @attr {string} help - Muted helper text shown below the control
 *
 * @slot - Default slot for the field control (cf-input, cf-select, cf-textarea, ...)
 *
 * @example
 * <cf-field label="Email" required help="We never share this.">
 *   <cf-input type="email" placeholder="email@example.com"></cf-input>
 * </cf-field>
 */

export class CFField extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --cf-field-gap: var(--cf-spacing-1, 0.25rem);
        --cf-field-font-size: var(--cf-font-caption-size, 0.75rem);
        --cf-field-line-height: var(--cf-font-caption-line-height, 1rem);
        --cf-field-label-weight: var(--cf-font-caption-weight, 500);
        --cf-field-color-label: var(--cf-theme-color-text-muted, #71747a);
        --cf-field-color-help: var(--cf-theme-color-text-muted, #71747a);
        --cf-field-color-error: var(--cf-theme-color-error, hsl(0, 100%, 50%));

        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: var(--cf-field-gap);
      }

      .label {
        font-size: var(--cf-field-font-size);
        line-height: var(--cf-field-line-height);
        font-weight: var(--cf-field-label-weight);
        letter-spacing: var(--cf-font-caption-letter-spacing, 0);
        color: var(--cf-field-color-label);
        cursor: pointer;
        user-select: none;
      }

      .required-indicator {
        color: var(--cf-field-color-error);
        font-weight: var(--cf-font-weight-semibold, 600);
        margin-left: 0.125rem;
      }

      .help,
      .error {
        font-size: var(--cf-field-font-size);
        line-height: var(--cf-field-line-height);
        margin: 0;
      }

      .help {
        color: var(--cf-field-color-help);
      }

      .error {
        color: var(--cf-field-color-error);
      }
    `,
  ];

  static override properties = {
    label: { type: String },
    required: { type: Boolean },
    error: { type: String },
    help: { type: String },
  };

  declare label: string;
  declare required: boolean;
  declare error: string;
  declare help: string;

  constructor() {
    super();
    this.label = "";
    this.required = false;
    this.error = "";
    this.help = "";
  }

  override render() {
    return html`
      <div class="field" part="field">
        ${this.label
          ? html`
            <label class="label" part="label" @click="${this
              ._handleLabelClick}">
              ${this.label} ${this.required
                ? html`
                  <span class="required-indicator" part="required" aria-hidden="true">*</span>
                `
                : nothing}
            </label>
          `
          : nothing}
        <slot></slot>
        ${this.error
          ? html`
            <div class="error" part="error" role="alert">${this.error}</div>
          `
          : this.help
          ? html`
            <div class="help" part="help">${this.help}</div>
          `
          : nothing}
      </div>
    `;
  }

  /**
   * Shadow DOM blocks native label/control association, so clicking the
   * label focuses (and for custom elements, clicks) the slotted control.
   */
  private _handleLabelClick = (): void => {
    const control = this.getControl();
    if (!control) return;

    if ("focus" in control && typeof control.focus === "function") {
      control.focus();
      // Custom elements often delegate focus internally on click
      if (control.tagName.includes("-")) {
        control.click();
      }
    }
  };

  /**
   * Get the first slotted control element
   */
  getControl(): HTMLElement | null {
    const slot = this.shadowRoot?.querySelector(
      "slot:not([name])",
    ) as HTMLSlotElement | null;
    const assigned = slot?.assignedElements({ flatten: true }) ?? [];
    return (assigned[0] as HTMLElement) ?? null;
  }
}
