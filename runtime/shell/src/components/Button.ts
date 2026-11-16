import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

/** Whether a button submits the form around it. */
type ButtonType = "button" | "submit";

/** How a button is drawn: plainly, or filled in as the primary action. */
type VariantType = "none" | "primary";

/** The shell's own button, which submits the form around it when asked to. */
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

    button:hover {
      transform: translateY(-2px);
      box-shadow: 2px 2px 0px 0px rgba(0, 0, 0, 0.5);
    }

    button[x-variant="primary"] {
      background-color: var(--font-color);
      color: var(--shell-surface);
    }

    button[x-variant="primary"]:hover {
      background-color: var(--shell-text-muted);
    }
  `;

  /** Whether the button submits the form around it. */
  @property()
  accessor type: ButtonType = "button";

  /** How the button is drawn. */
  @property()
  accessor variant: VariantType = "none";

  #onClick(e: Event) {
    // The button inside the shadow root belongs to no form, so a submit button
    // submits the form around the host itself, as a click on a submit button
    // in that form would, validation included.
    // https://www.hjorthhansen.dev/shadow-dom-and-forms/
    //
    // Probably should also handle keyboard events
    // that can submit forms.
    if (this.type === "submit") {
      const form = this.closest("form");
      if (!form) return;
      e.preventDefault();
      form.requestSubmit();
    }
  }

  override render() {
    return html`
      <button
        @click="${this.#onClick}"
        type="${this.type}"
        x-variant="${this.variant}"
      >
        <slot></slot>
      </button>
    `;
  }
}

globalThis.customElements.define("x-button", XButtonElement);
