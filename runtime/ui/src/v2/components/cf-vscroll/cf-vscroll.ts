import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { layoutSpacingUtilityStyles } from "../../styles/layout-spacing.ts";

/**
 * CFVScroll - Vertical scroll container
 *
 * @element cf-vscroll
 *
 * @attr {boolean} show-scrollbar - Always show scrollbar
 * @attr {boolean} fade-edges - Show fade effect at edges
 * @attr {boolean} snap-to-bottom - Open at the bottom, and follow content as it
 *   grows while the reader is at the bottom
 * @attr {string} padding - Padding inside scroll area
 * @attr {string} height - Fixed height of the container
 * @attr {string} max-height - Maximum height of the container
 *
 * @slot - Content to be scrolled vertically
 *
 * @example
 * <cf-vscroll height="400px">
 *   <cf-vstack gap="4">
 *     <p>Long content...</p>
 *   </cf-vstack>
 * </cf-vscroll>
 */
export class CFVScroll extends BaseElement {
  static override properties = {
    showScrollbar: {
      type: Boolean,
      reflect: true,
      attribute: "show-scrollbar",
    },
    fadeEdges: { type: Boolean, reflect: true, attribute: "fade-edges" },
    snapToBottom: { type: Boolean, reflect: true, attribute: "snap-to-bottom" },
    flex: { type: Boolean, reflect: true },
    padding: { type: String },
    height: { type: String },
    maxHeight: { type: String, attribute: "max-height" },
    _atStart: { type: Boolean, state: true },
    _atEnd: { type: Boolean, state: true },
  };

  static override styles = [
    layoutSpacingUtilityStyles,
    css`
      :host {
        --cf-vscroll-color-surface: var(--cf-theme-color-surface, #f1f5f9);
        --cf-vscroll-color-thumb: var(--cf-theme-color-text-muted, #64748b);
        --cf-vscroll-color-thumb-hover: var(--cf-theme-color-text, #475569);
        --cf-vscroll-color-background: var(--cf-theme-color-background, #ffffff);

        display: block;
        position: relative;
        overflow: hidden;
        min-height: 0;
      }

      :host([flex]) {
        flex: 1;
      }

      .scroll-wrapper {
        position: relative;
        overflow: hidden;
        width: 100%;
        height: 100%;
      }

      .scroll-container {
        overflow-y: auto;
        overflow-x: hidden;
        width: 100%;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: thin;
      }

      /* Hide scrollbar by default */
      :host(:not([show-scrollbar])) .scroll-container {
        scrollbar-width: none;
        -ms-overflow-style: none;
      }

      :host(:not([show-scrollbar])) .scroll-container::-webkit-scrollbar {
        display: none;
      }

      /* Scrollbar styling when visible */
      .scroll-container::-webkit-scrollbar {
        width: 8px;
      }

      .scroll-container::-webkit-scrollbar-track {
        background: var(--cf-vscroll-color-surface, #f1f5f9);
        border-radius: 4px;
      }

      .scroll-container::-webkit-scrollbar-thumb {
        background: var(--cf-vscroll-color-thumb, #64748b);
        border-radius: 4px;
      }

      .scroll-container::-webkit-scrollbar-thumb:hover {
        background: var(--cf-vscroll-color-thumb-hover, #475569);
      }

      /* Fade edges */
      :host([fade-edges]) .scroll-wrapper::before,
      :host([fade-edges]) .scroll-wrapper::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        height: 2rem;
        pointer-events: none;
        z-index: 1;
        transition: opacity 0.2s;
      }

      :host([fade-edges]) .scroll-wrapper::before {
        top: 0;
        background: linear-gradient(
          to bottom,
          var(--cf-vscroll-color-background, white),
          transparent
        );
        opacity: 0;
      }

      :host([fade-edges]) .scroll-wrapper::after {
        bottom: 0;
        background: linear-gradient(
          to top,
          var(--cf-vscroll-color-background, white),
          transparent
        );
        opacity: 0;
      }

      :host([fade-edges]) .scroll-wrapper:not(.at-start)::before {
        opacity: 1;
      }

      :host([fade-edges]) .scroll-wrapper:not(.at-end)::after {
        opacity: 1;
      }
    `,
  ];

  declare showScrollbar: boolean;
  declare fadeEdges: boolean;
  declare snapToBottom: boolean;
  declare flex: boolean;
  declare padding: string;
  declare height: string;
  declare maxHeight: string;
  declare _atStart: boolean;
  declare _atEnd: boolean;

  private _scrollContainer: HTMLElement | null = null;
  /**
   * Watches the container and every slotted element, so any growth of the
   * content (a message added, text streaming in, an image laying out, a
   * hidden panel shown) changes a box it sees. It reports sizes on `observe()` too, which
   * covers content that is already slotted when the element connects: a
   * renderer builds a subtree before inserting it, so a history whose
   * messages are ready on first render arrives whole.
   */
  private _resizeObserver = new ResizeObserver(() => this.snapIfFollowing());
  /**
   * Watches the slotted subtree for growth that changes no observed box: items
   * added inside a `display: contents` wrapper (how the renderer slots an
   * array), or text streaming into a text node.
   */
  private _mutationObserver = new MutationObserver((records) => {
    if (records.some((record) => record.type === "childList")) {
      this.observeContent();
    }
    this.snapIfFollowing();
  });
  /**
   * Whether new content should snap: true until the reader scrolls up, and
   * true again once they reach the bottom. Only a scroll toward the top clears
   * it, so the component's own smooth snaps, which pass through positions
   * short of the bottom, never stop it following.
   */
  private _following = true;
  private _lastScrollTop = 0;

  constructor() {
    super();
    this.showScrollbar = false;
    this.fadeEdges = false;
    this.snapToBottom = false;
    this.flex = false;
    this.padding = "0";
    this.height = "";
    this.maxHeight = "";
    this._atStart = true;
    this._atEnd = true;
  }

  get scrollContainer(): HTMLElement | null {
    if (!this._scrollContainer) {
      this._scrollContainer = this.shadowRoot?.querySelector(
        ".scroll-container",
      ) as HTMLElement | null;
    }
    return this._scrollContainer;
  }

  override firstUpdated() {
    // Cache reference
    this._scrollContainer = this.shadowRoot?.querySelector(
      ".scroll-container",
    ) as HTMLElement | null;
    this.updateScrollState();
    this.observeContent();
  }

  override connectedCallback() {
    super.connectedCallback();
    // A disconnected element loses its scroll position, so it opens afresh.
    this._following = true;
    this._lastScrollTop = 0;
    if (this.hasUpdated) this.observeContent();
    // Listen for cf-chat-updated events
    this.addEventListener("cf-chat-updated", this._handleChatUpdate);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver.disconnect();
    this._mutationObserver.disconnect();
    this.removeEventListener("cf-chat-updated", this._handleChatUpdate);
  }

  private _handleChatUpdate = () => {
    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(() => this.snapIfFollowing());
  };

  private observeContent = () => {
    const slot = this.shadowRoot?.querySelector("slot");
    if (!this.scrollContainer || !slot) return;
    this._resizeObserver.disconnect();
    this._resizeObserver.observe(this.scrollContainer);
    this.observeBoxes(slot.assignedElements());
    this._mutationObserver.observe(this, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  /**
   * Observes each element's box, or, for a `display: contents` element (the
   * renderer wraps an array of children in one), which has no box, its
   * children's, so an image loading inside the wrapper still reports.
   */
  private observeBoxes(elements: Iterable<Element>) {
    for (const element of elements) {
      if (getComputedStyle(element).display === "contents") {
        this.observeBoxes(element.children);
      } else {
        this._resizeObserver.observe(element);
      }
    }
  }

  /**
   * With `snapToBottom` set and the reader following, scroll to the bottom:
   * a jump when it is more than a screen away, as when a history opens, so
   * the reader is not carried down through every message; a smooth scroll
   * for anything nearer, as when a message arrives.
   */
  private snapIfFollowing() {
    const container = this.scrollContainer;
    if (!this.snapToBottom || !this._following || !container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distance = scrollHeight - clientHeight - scrollTop;
    if (distance <= 0) return;
    this.scrollToBottom(distance <= clientHeight);
  }

  private handleScroll = () => {
    this.updateScrollState();
    const { scrollTop } = this.scrollContainer as HTMLElement;
    if (this._atEnd) this._following = true;
    else if (scrollTop < this._lastScrollTop) this._following = false;
    this._lastScrollTop = scrollTop;
    this.emit("cf-scroll", {
      scrollTop: (this.scrollContainer as HTMLElement)?.scrollTop || 0,
      scrollHeight: (this.scrollContainer as HTMLElement)?.scrollHeight || 0,
      clientHeight: (this.scrollContainer as HTMLElement)?.clientHeight || 0,
    });
  };

  private updateScrollState() {
    if (!this.scrollContainer) return;

    const { scrollTop, scrollHeight, clientHeight } = this
      .scrollContainer as HTMLElement;
    this._atStart = scrollTop <= 0;
    this._atEnd = scrollTop + clientHeight >= scrollHeight - 1;
  }

  override render() {
    const wrapperClasses = {
      "scroll-wrapper": true,
      "at-start": this._atStart,
      "at-end": this._atEnd,
    };

    const containerClasses = {
      "scroll-container": true,
      [`p-${this.padding}`]: true,
    };

    const containerStyles = {
      height: this.height || "100%",
      "max-height": this.maxHeight || "none",
    };

    return html`
      <div class="${classMap(wrapperClasses)}" part="wrapper">
        <div
          class="${classMap(containerClasses)}"
          style="${styleMap(containerStyles)}"
          part="container"
          @scroll="${this.handleScroll}"
        >
          <slot @slotchange="${this.observeContent}"></slot>
        </div>
      </div>
    `;
  }

  /**
   * Scroll to a specific vertical position
   */
  scrollToY(y: number, smooth: boolean = true) {
    if (this.scrollContainer) {
      (this.scrollContainer as HTMLElement).scrollTo({
        top: y,
        behavior: smooth ? "smooth" : "auto",
      });
    }
  }

  /**
   * Scroll by a specific vertical amount
   */
  scrollByY(y: number, smooth: boolean = true) {
    if (this.scrollContainer) {
      (this.scrollContainer as HTMLElement).scrollBy({
        top: y,
        behavior: smooth ? "smooth" : "auto",
      });
    }
  }

  /**
   * Scroll to the bottom of the container
   */
  scrollToBottom(smooth: boolean = true) {
    if (this.scrollContainer) {
      const { scrollHeight } = this.scrollContainer as HTMLElement;
      this.scrollToY(scrollHeight, smooth);
    }
  }
}
