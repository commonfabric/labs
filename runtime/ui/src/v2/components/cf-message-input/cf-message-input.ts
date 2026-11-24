import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFMessageInput - Input component with send button for messages/chat interfaces
 *
 * @element cf-message-input
 *
 * @attr {string} placeholder - Placeholder text for the input
 * @attr {string} buttonText - Text for the send button (default: "Send")
 * @attr {boolean} disabled - Whether the input and button are disabled
 * @attr {string} value - Current input value
 * @attr {string} size - Coordinated control size: "xs" | "sm" | "md" | "lg" | "xl" (default: "lg")
 *
 * @fires cf-send - Fired when send button is clicked or Enter is pressed. detail: { message: string }
 *
 * @example
 * <cf-message-input
 *   placeholder="Type a message..."
 *   button-text="Send"
 *   @cf-send="${(e) => console.log(e.detail.message)}"
 * ></cf-message-input>
 */
export class CFMessageInput extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;
      }

      .container {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: var(--cf-message-input-gap, var(--cf-spacing-2, 0.5rem));
        align-items: stretch;
      }

      cf-input {
        width: 100%;
      }

      cf-button {
        white-space: nowrap;
      }
    `,
  ];

  static override properties = {
    placeholder: { type: String },
    buttonText: { type: String, attribute: "button-text" },
    disabled: { type: Boolean, reflect: true },
    value: { type: String },
    size: { type: String, reflect: true },
  };

  declare placeholder: string;
  declare buttonText: string;
  declare disabled: boolean;
  declare value: string;
  declare size: "xs" | "sm" | "md" | "lg" | "xl";

  private _inputElement?: HTMLElement;

  constructor() {
    super();
    this.placeholder = "";
    this.buttonText = "Send";
    this.disabled = false;
    this.value = "";
    this.size = "lg";
  }

  override firstUpdated() {
    this._inputElement = this.shadowRoot?.querySelector(
      "cf-input",
    ) as HTMLElement;
  }

  private _handleSend(event?: Event) {
    event?.preventDefault();

    const input = this._inputElement as any;
    if (!input || !input.value?.trim()) return;

    const message = input.value;

    // Clear the input
    input.value = "";
    this.value = "";

    // Emit the send event
    this.emit("cf-send", { message });

    // Restore focus to input for rapid entry (chat, list-building workflows)
    input.focus();
  }

  private _handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this._handleSend();
    }
  }

  private _handleInput(event: CustomEvent) {
    this.value = event.detail.value;
  }

  override render() {
    return html`
      <div class="container">
        <cf-input
          type="text"
          size="${this.size}"
          .placeholder="${this.placeholder}"
          .value="${this.value}"
          ?disabled="${this.disabled}"
          @cf-change="${this._handleInput}"
          @keydown="${this._handleKeyDown}"
          part="input"
          timingStrategy="immediate"
        ></cf-input>
        <cf-button
          id="cf-message-input-send-button"
          size="${this.size}"
          ?disabled="${this.disabled}"
          @click="${this._handleSend}"
          part="button"
        >
          ${this.buttonText}
        </cf-button>
      </div>
    `;
  }
}
