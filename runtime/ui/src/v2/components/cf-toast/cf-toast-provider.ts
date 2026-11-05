import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFToastProvider - Fixed-position container that manages a stack of cf-toast elements
 *
 * @element cf-toast-provider
 *
 * @attr {string} position - Screen position: "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right"
 * @attr {number} max - Maximum number of simultaneously visible toasts
 *
 * @slot - cf-toast elements to manage
 *
 * @cssprop --cf-toast-provider-gap - Vertical gap between toasts (default: 0.5rem)
 * @cssprop --cf-toast-provider-margin - Inset from screen edge (default: 1rem)
 * @cssprop --cf-toast-provider-z-index - Z-index of fixed container (default: 1100)
 */
export class CFToastProvider extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      position: fixed;
      z-index: var(--cf-toast-provider-z-index, 1100);
      pointer-events: none;
    }

    .container {
      display: flex;
      flex-direction: column;
      gap: var(--cf-toast-provider-gap, 0.5rem);
      pointer-events: auto;
      padding: var(--cf-toast-provider-margin, 1rem);
    }

    /* bottom (default): centered horizontally, stack upward */
    :host([position="bottom"]),
    :host(:not([position])) {
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
    }

    :host([position="bottom"]) .container,
    :host(:not([position])) .container {
      flex-direction: column-reverse;
    }

    /* top: centered horizontally, stack downward */
    :host([position="top"]) {
      top: 0;
      left: 50%;
      transform: translateX(-50%);
    }

    /* bottom-right */
    :host([position="bottom-right"]) {
      bottom: 0;
      right: 0;
    }

    :host([position="bottom-right"]) .container {
      flex-direction: column-reverse;
      align-items: flex-end;
    }

    /* bottom-left */
    :host([position="bottom-left"]) {
      bottom: 0;
      left: 0;
    }

    :host([position="bottom-left"]) .container {
      flex-direction: column-reverse;
      align-items: flex-start;
    }

    /* top-right */
    :host([position="top-right"]) {
      top: 0;
      right: 0;
    }

    :host([position="top-right"]) .container {
      align-items: flex-end;
    }

    /* top-left */
    :host([position="top-left"]) {
      top: 0;
      left: 0;
    }

    :host([position="top-left"]) .container {
      align-items: flex-start;
    }

    ::slotted(cf-toast) {
      pointer-events: auto;
    }
  `;

  static override properties = {
    position: { type: String, reflect: true },
    max: { type: Number },
  };

  declare position:
    | "top"
    | "bottom"
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right";
  declare max: number;

  private _observer: MutationObserver | null = null;

  constructor() {
    super();
    this.position = "bottom";
    this.max = 3;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._observer = new MutationObserver((mutations) => {
      const relevant = mutations.some(
        (m) =>
          m.type === "childList" ||
          (m.type === "attributes" && m.attributeName === "open"),
      );
      if (relevant) {
        this._updateStack();
      }
    });
    this._observer.observe(this, {
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
      subtree: true,
    });
    this._updateStack();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  }

  private _updateStack(): void {
    const openToasts = Array.from(
      this.querySelectorAll<HTMLElement>("cf-toast[open]"),
    );
    if (openToasts.length > this.max) {
      const toEvict = openToasts.slice(0, openToasts.length - this.max);
      for (const toast of toEvict) {
        toast.removeAttribute("open");
        toast.dispatchEvent(
          new CustomEvent("cf-toast-dismiss", {
            detail: { reason: "timeout" },
            bubbles: true,
            composed: true,
          }),
        );
      }
    }
  }

  override render() {
    return html`
      <div class="container" part="container">
        <slot></slot>
      </div>
    `;
  }
}
