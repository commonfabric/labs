import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

// How far the card sits from its anchor, and from the edge of the window.
const CARD_GAP_PX = 6;

/**
 * CFHoverCard - A small card that appears beside its content while the pointer
 * rests on the content or focus is inside it, as a reaction count shows who
 * reacted.
 *
 * The card is a popover in the browser's top layer, so no ancestor that clips
 * its overflow can cut it off. It sits above the content, or below when there
 * is no room above, and moves inward from the window's edges. It hides when the
 * pointer and focus have both left, and when the page scrolls, since it is
 * placed against where the content was when it appeared.
 *
 * @element cf-hover-card
 *
 * @slot - The content the card belongs to
 * @slot card - What the card shows
 *
 * @csspart card - The card
 *
 * @example
 * <cf-hover-card>
 *   <cf-button size="sm">😺 2</cf-button>
 *   <div slot="card">Alice, Bob</div>
 * </cf-hover-card>
 */
export class CFHoverCard extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
      }

      .card {
        position: fixed;
        inset: auto;
        margin: 0;
        padding: var(--cf-spacing-2, 0.5rem);
        border: 1px solid var(--cf-theme-color-border, #e5e7eb);
        border-radius: var(--cf-border-radius-md, 0.5rem);
        background: var(--cf-theme-color-surface, #ffffff);
        color: inherit;
        box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);
      }
    `,
  ];

  #pointerInside = false;
  #focusInside = false;

  #onPointerEnter = () => {
    this.#pointerInside = true;
    this.#show();
  };

  #onPointerLeave = () => {
    this.#pointerInside = false;
    this.#hideUnlessInside();
  };

  #onFocusIn = () => {
    this.#focusInside = true;
    this.#show();
  };

  #onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.contains(next)) return;
    this.#focusInside = false;
    this.#hideUnlessInside();
  };

  #onScroll = () => {
    this.#hide();
  };

  /** Whether the card is showing. */
  get open(): boolean {
    return this.#card?.matches(":popover-open") ?? false;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("pointerenter", this.#onPointerEnter);
    this.addEventListener("pointerleave", this.#onPointerLeave);
    this.addEventListener("focusin", this.#onFocusIn);
    this.addEventListener("focusout", this.#onFocusOut);
  }

  override disconnectedCallback() {
    this.removeEventListener("pointerenter", this.#onPointerEnter);
    this.removeEventListener("pointerleave", this.#onPointerLeave);
    this.removeEventListener("focusin", this.#onFocusIn);
    this.removeEventListener("focusout", this.#onFocusOut);
    this.#hide();
    super.disconnectedCallback();
  }

  override render() {
    return html`
      <slot></slot>
      <div class="card" part="card" role="tooltip" popover="manual">
        <slot name="card"></slot>
      </div>
    `;
  }

  get #card(): HTMLElement | null | undefined {
    return this.shadowRoot?.querySelector<HTMLElement>(".card");
  }

  #hideUnlessInside() {
    if (!this.#pointerInside && !this.#focusInside) this.#hide();
  }

  #show() {
    const card = this.#card;
    if (!card || this.open) return;
    card.showPopover();
    this.#place(card);
    globalThis.addEventListener("scroll", this.#onScroll, {
      capture: true,
      passive: true,
    });
  }

  #hide() {
    globalThis.removeEventListener("scroll", this.#onScroll, { capture: true });
    const card = this.#card;
    if (card && this.open) card.hidePopover();
  }

  #place(card: HTMLElement) {
    const anchor = this.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const above = anchor.top - CARD_GAP_PX - height;
    const top = above >= CARD_GAP_PX ? above : anchor.bottom + CARD_GAP_PX;
    const maxLeft = globalThis.innerWidth - CARD_GAP_PX - width;
    const left = Math.max(CARD_GAP_PX, Math.min(anchor.left, maxLeft));
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }
}
