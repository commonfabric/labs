import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import "../cf-button/index.ts";
import "../cf-copy-button/index.ts";

const AUTO_HIDE_MS = 30_000;

/**
 * CFSecretViewer - Trusted UI component for revealing secret strings
 *
 * Displays a greeked/masked value (e.g., `••••••••••hJ9k`) with click-to-reveal
 * and a copy button. Used by patterns to show webhook URLs, API keys, or other
 * confidential strings without the pattern code itself needing to read the value.
 *
 * @element cf-secret-viewer
 *
 * @attr {string} value - The secret string (bound from a cell)
 * @attr {string} label - Optional label displayed above the value
 * @attr {number} trailing-chars - How many non-greeked chars to show at end (default: 4)
 *
 * @example
 * <cf-secret-viewer
 *   label="Webhook URL"
 *   value="https://api.example.com/webhooks/wh_abc123"
 *   trailing-chars="4"
 * ></cf-secret-viewer>
 */
export class CFSecretViewer extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      .secret-viewer {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-1, 0.25rem);
      }

      .label {
        font-size: var(--font-size-sm, 0.875rem);
        color: var(--color-text-secondary, #6b7280);
        font-weight: 500;
      }

      .value-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-2, 0.5rem);
        background: var(--color-bg-subtle, #f9fafb);
        border: 1px solid var(--color-border, #e5e7eb);
        border-radius: var(--radius-md, 0.375rem);
        padding: var(--spacing-2, 0.5rem) var(--spacing-3, 0.75rem);
      }

      .value {
        flex: 1;
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: var(--font-size-sm, 0.875rem);
        word-break: break-all;
        user-select: none;
        color: var(--color-text-primary, #111827);
      }

      .value.revealed {
        user-select: text;
      }

      .actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-1, 0.25rem);
        flex-shrink: 0;
      }
    `,
  ];

  static override properties = {
    value: { type: String },
    label: { type: String },
    trailingChars: { type: Number, attribute: "trailing-chars" },
  };

  declare value: string;
  declare label: string;
  declare trailingChars: number;

  private _revealed = false;
  private _autoHideTimeout?: ReturnType<typeof setTimeout>;

  constructor() {
    super();
    this.value = "";
    this.label = "";
    this.trailingChars = 4;
  }

  private _getMasked(): string {
    if (!this.value) return "";
    const trailing = Math.max(
      0,
      Math.min(this.trailingChars || 0, this.value.length),
    );
    return trailing > 0
      ? "•".repeat(12) + this.value.slice(-trailing)
      : "•".repeat(12);
  }

  private _toggleReveal() {
    this._revealed = !this._revealed;
    this.requestUpdate();

    if (this._autoHideTimeout) {
      clearTimeout(this._autoHideTimeout);
      this._autoHideTimeout = undefined;
    }

    if (this._revealed) {
      this._autoHideTimeout = setTimeout(() => {
        this._revealed = false;
        this._autoHideTimeout = undefined;
        this.requestUpdate();
      }, AUTO_HIDE_MS);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._autoHideTimeout) {
      clearTimeout(this._autoHideTimeout);
    }
  }

  override render() {
    const displayValue = this._revealed ? this.value : this._getMasked();

    return html`
      <div class="secret-viewer">
        ${this.label
          ? html`
            <div class="label" part="label">${this.label}</div>
          `
          : ""}
        <div class="value-row">
          <code class="value ${this._revealed
            ? "revealed"
            : ""}" part="value">${displayValue}</code>
          <div class="actions">
            <cf-button
              variant="ghost"
              size="sm"
              @click="${this._toggleReveal}"
            >
              ${this._revealed ? "Hide" : "Reveal"}
            </cf-button>
            <cf-copy-button
              .text="${this.value}"
              variant="ghost"
              size="sm"
              icon-only
            ></cf-copy-button>
          </div>
        </div>
      </div>
    `;
  }
}
