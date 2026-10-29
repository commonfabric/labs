import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { placeCard } from "./placement.ts";
import { HoverPresence } from "./presence.ts";

// How far the card sits from its anchor, and from the edge of the window.
const CARD_GAP_PX = 6;

/**
 * CFHoverCard - A small card that appears beside its content while the pointer
 * rests on the content or focus is inside it, as a reaction count shows who
 * reacted.
 *
 * The card is a popover in the browser's top layer, so no ancestor that clips
 * its overflow can cut it off. It sits above the content, or below when there
 * is no room above, and moves inward from the window's edges. It is placed
 * again whenever its size changes, since what it shows can arrive after it
 * opens, and whenever anything scrolls or the window resizes, so that it
 * follows its content. It hides when the pointer and focus have both left.
 *
 * The pointer cannot reach the card, so what it shows is for reading, not for
 * clicking. The card's content is the caller's, as is the content it belongs
 * to, so a caller that wants the card read as a description of that content
 * points `aria-describedby` from one to the other.
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
        pointer-events: none;
      }
    `,
  ];

  #presence = new HoverPresence();
  #resizeObserver: ResizeObserver | undefined;

  #onPointerEnter = () => {
    this.#presence.enter("pointer");
    this.#show();
  };

  #onPointerLeave = () => {
    this.#presence.leave("pointer");
    this.#hideUnlessInside();
  };

  #onFocusIn = () => {
    this.#presence.enter("focus");
    this.#show();
  };

  #onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.contains(next)) return;
    this.#presence.leave("focus");
    this.#hideUnlessInside();
  };

  #onLayoutChange = () => {
    const card = this.#card;
    if (card && this.open) this.#place(card);
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
    // A focused element that leaves the document gets no `focusout`, so what
    // was inside is forgotten here rather than carried into a reconnection.
    this.#presence.reset();
    this.#hide();
    super.disconnectedCallback();
  }

  override render() {
    return html`
      <slot></slot>
      <div class="card" part="card" popover="manual">
        <slot name="card"></slot>
      </div>
    `;
  }

  get #card(): HTMLElement | null | undefined {
    return this.shadowRoot?.querySelector<HTMLElement>(".card");
  }

  #hideUnlessInside() {
    if (!this.#presence.inside) this.#hide();
  }

  #show() {
    const card = this.#card;
    if (!card) {
      // Not rendered yet: show once it is, if what asked is still inside.
      void this.updateComplete.then(() => {
        if (this.isConnected && this.#presence.inside) {
          this.#show();
        }
      });
      return;
    }
    if (this.open) return;
    card.showPopover();
    this.#place(card);
    this.#resizeObserver = new ResizeObserver(() => this.#place(card));
    this.#resizeObserver.observe(card);
    globalThis.addEventListener("scroll", this.#onLayoutChange, {
      capture: true,
      passive: true,
    });
    globalThis.addEventListener("resize", this.#onLayoutChange);
  }

  #hide() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    globalThis.removeEventListener("scroll", this.#onLayoutChange, {
      capture: true,
    });
    globalThis.removeEventListener("resize", this.#onLayoutChange);
    const card = this.#card;
    if (card && this.open) card.hidePopover();
  }

  #place(card: HTMLElement) {
    const { top, left } = placeCard(
      this.getBoundingClientRect(),
      { width: card.offsetWidth, height: card.offsetHeight },
      { width: globalThis.innerWidth, height: globalThis.innerHeight },
      CARD_GAP_PX,
    );
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }
}
