import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

type ButtonSize = "small" | "medium" | "large";
type ButtonType = "text" | "submit" | "number";
type VariantType = "none" | "primary";

export class XButtonElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    button {
      width: 100%;
      padding: 0.75rem 1rem;
      font-family: var(--font-primary);
      color: var(--font-color);
      background-color: var(--shell-surface);
      border: var(--border-width, 2px) solid var(--border-color, #000);
      cursor: pointer;
      transition: all 0.1s ease-in-out;
    }

    button:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 2px 2px 0px 0px rgba(0, 0, 0, 0.5);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button[x-variant="primary"] {
      background-color: var(--font-color);
      color: var(--shell-surface);
    }

    button[x-variant="primary"]:hover:not(:disabled) {
      background-color: var(--shell-text-muted);
    }

    button[x-size="small"] {
      padding: 0.5rem 0.5rem;
    }
  `;
  @property()
  accessor size: ButtonSize = "medium";

  @property()
  accessor type: ButtonType = "text";

  @property({ attribute: true })
  accessor disabled = false;

  @property({ attribute: true })
  accessor variant: VariantType = "none";

  #onClick(e: Event) {
    // If this is a "submit" button, then we need
    // to handle execution as the shadow DOM prevents
    // default mapping of the button to a parent form.
    // https://www.hjorthhansen.dev/shadow-dom-and-forms/
    //
    // Probably should also handle keyboard events
    // that can submit forms.
    if (this.type === "submit") {
      const form = this.closest("form");
      if (!form) return;
      e.preventDefault();
      const pseudo = document.createElement("button");
      pseudo.type = "submit";
      pseudo.style.display = "none";
      form.appendChild(pseudo);
      pseudo.click();
      pseudo.remove();
    }
  }

  override render() {
    return html`
      <button
        @click="${this.#onClick}"
        type="${this.type}"
        ?disabled="${this.disabled}"
        x-variant="${this.variant}"
        x-size="${this.size}"
      >
        <slot></slot>
      </button>
    `;
  }
}

globalThis.customElements.define("x-button", XButtonElement);
