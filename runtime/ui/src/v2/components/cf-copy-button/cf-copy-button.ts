import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

// TODO(v2-token-migration): Migrate this component to component-level tokens,
// matching the prior phase-1 token migration pattern.

/**
 * CFCopyButton - Copy to clipboard button with automatic visual feedback
 *
 * @element cf-copy-button
 *
 * @attr {string | Record<string, string>} text - Content to copy to clipboard (required)
 *   - String: Copied as text/plain (backwards compatible)
 *   - Object: Keys are MIME types, values are content for each type.
 *     Common types: "text/plain", "text/html"
 * @attr {string} variant - Button style variant (default: "secondary")
 *   Options: "primary" | "secondary" | "destructive" | "outline" | "ghost" | "link" | "pill"
 * @attr {string} size - Button size (default: "md")
 *   Options: "xs" | "sm" | "md" | "lg" | "xl" | "icon"
 * @attr {boolean} disabled - Disable the button
 * @attr {number} feedback-duration - Success feedback duration in ms (default: 2000)
 * @attr {boolean} icon-only - Only show icon, no text (default: false)
 *
 * @fires cf-copy-success - Fired when copy succeeds
 *   Detail: { text: string, length: number }
 * @fires cf-copy-error - Fired when copy fails
 *   Detail: { error: Error, text: string }
 *
 * @slot - Button label text (optional, defaults based on state)
 *
 * @example
 * // Basic usage
 * <cf-copy-button text="Hello World">Copy</cf-copy-button>
 *
 * // Icon only
 * <cf-copy-button text="Hello" icon-only></cf-copy-button>
 *
 * // Custom styling
 * <cf-copy-button
 *   text="data"
 *   variant="ghost"
 *   size="sm"
 * >📋 Copy List</cf-copy-button>
 *
 * // Rich text with HTML (pastes as formatted text in rich editors)
 * <cf-copy-button
 *   text={{
 *     "text/plain": "Hello World",
 *     "text/html": "<b>Hello World</b>"
 *   }}
 * >Copy</cf-copy-button>
 *
 * // With event handler (in pattern)
 * <cf-copy-button
 *   text={ingredientListText}
 *   oncf-copy-success={handleCopySuccess({})}
 * >Copy</cf-copy-button>
 */
export class CFCopyButton extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      /* Ensure icon-only buttons maintain square aspect ratio */
      :host([icon-only]) cf-button {
        min-width: 2.25rem;
        display: inline-flex;
      }

      /* Adjust for different sizes when icon-only */
      :host([icon-only]) cf-button::part(button) {
        aspect-ratio: 1;
        min-width: fit-content;
      }
    `,
  ];

  static override properties = {
    text: {}, // Can be string or object, no automatic conversion
    variant: { type: String },
    size: { type: String },
    disabled: { type: Boolean, reflect: true },
    feedbackDuration: { type: Number, attribute: "feedback-duration" },
    iconOnly: { type: Boolean, attribute: "icon-only", reflect: true },
  };

  declare text: string | Record<string, string>;
  declare variant?:
    | "primary"
    | "secondary"
    | "destructive"
    | "outline"
    | "ghost"
    | "link"
    | "pill";
  declare size?: "xs" | "sm" | "md" | "lg" | "xl" | "icon";
  declare disabled: boolean;
  declare feedbackDuration: number;
  declare iconOnly: boolean;

  private _copied = false;
  private _resetTimeout?: ReturnType<typeof setTimeout>;

  constructor() {
    super();
    this.text = "";
    this.variant = "secondary";
    this.size = "md";
    this.disabled = false;
    this.feedbackDuration = 2000;
    this.iconOnly = false;
  }

  private async _handleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();

    if (this.disabled || !this.text) return;

    try {
      // Determine the plain text content for events
      const plainText = typeof this.text === "string"
        ? this.text
        : this.text["text/plain"] || Object.values(this.text)[0] || "";

      if (typeof this.text === "string") {
        // Simple case: plain text (backwards compatible)
        await navigator.clipboard.writeText(this.text);
      } else {
        // Rich content: create ClipboardItem with multiple MIME types
        const clipboardData: Record<string, Blob> = {};
        for (const [mimeType, content] of Object.entries(this.text)) {
          clipboardData[mimeType] = new Blob([content], { type: mimeType });
        }
        await navigator.clipboard.write([new ClipboardItem(clipboardData)]);
      }

      this._copied = true;
      this.requestUpdate();

      this.emit("cf-copy-success", {
        text: plainText,
        length: plainText.length,
      });

      // Reset copied state after duration
      if (this._resetTimeout) {
        clearTimeout(this._resetTimeout);
      }
      this._resetTimeout = setTimeout(() => {
        this._copied = false;
        this.requestUpdate();
      }, this.feedbackDuration);
    } catch (error) {
      const plainText = typeof this.text === "string"
        ? this.text
        : this.text["text/plain"] || Object.values(this.text)[0] || "";
      this.emit("cf-copy-error", {
        error: error as Error,
        text: plainText,
      });
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._resetTimeout) {
      clearTimeout(this._resetTimeout);
    }
  }

  override render() {
    const title = this._copied ? "Copied!" : "Copy to clipboard";
    const ariaLabel = this._copied
      ? "Copied to clipboard"
      : "Copy to clipboard";

    return html`
      <cf-button
        variant="${this.variant || "secondary"}"
        size="${this.size || "md"}"
        ?disabled="${this.disabled}"
        @click="${this._handleClick}"
        title="${title}"
        aria-label="${ariaLabel}"
      >
        ${this.iconOnly
          ? html`
            ${this._copied ? "✓" : "📋"}
          `
          : html`
            <slot>
              ${this._copied ? "✓ Copied!" : "📋 Copy"}
            </slot>
          `}
      </cf-button>
    `;
  }
}
