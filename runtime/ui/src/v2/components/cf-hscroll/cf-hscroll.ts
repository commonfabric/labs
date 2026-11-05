import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { layoutSpacingUtilityStyles } from "../../styles/layout-spacing.ts";

/**
 * CFHScroll - Horizontal scroll container
 *
 * @element cf-hscroll
 *
 * @attr {boolean} show-scrollbar - Always show scrollbar
 * @attr {boolean} fade-edges - Show fade effect at edges
 * @attr {string} padding - Padding inside scroll area
 *
 * @slot - Content to be scrolled horizontally
 *
 * @example
 * <cf-hscroll>
 *   <cf-hstack gap="4">
 *     <cf-card>Card 1</cf-card>
 *     <cf-card>Card 2</cf-card>
 *     <cf-card>Card 3</cf-card>
 *   </cf-hstack>
 * </cf-hscroll>
 */
export class CFHScroll extends BaseElement {
  static override properties = {
    showScrollbar: {
      type: Boolean,
      reflect: true,
      attribute: "show-scrollbar",
    },
    fadeEdges: { type: Boolean, reflect: true, attribute: "fade-edges" },
    padding: { type: String },
    _atStart: { type: Boolean, state: true },
    _atEnd: { type: Boolean, state: true },
  };
  declare showScrollbar: boolean;
  declare fadeEdges: boolean;
  declare padding: string;
  declare _atStart: boolean;
  declare _atEnd: boolean;

  static override styles = [
    layoutSpacingUtilityStyles,
    css`
      :host {
        --cf-hscroll-color-surface: var(--cf-theme-color-surface, #f1f5f9);
        --cf-hscroll-color-thumb: var(--cf-theme-color-text-muted, #64748b);
        --cf-hscroll-color-thumb-hover: var(--cf-theme-color-text, #475569);
        --cf-hscroll-color-background: var(--cf-theme-color-background, #ffffff);

        display: block;
        position: relative;
        overflow: hidden;
      }

      .scroll-wrapper {
        position: relative;
        width: 100%;
        height: 100%;
      }

      .scroll-container {
        overflow-x: auto;
        overflow-y: hidden;
        width: 100%;
        height: 100%;
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
        height: 8px;
      }

      .scroll-container::-webkit-scrollbar-track {
        background: var(--cf-hscroll-color-surface, #f1f5f9);
        border-radius: 4px;
      }

      .scroll-container::-webkit-scrollbar-thumb {
        background: var(--cf-hscroll-color-thumb, #64748b);
        border-radius: 4px;
      }

      .scroll-container::-webkit-scrollbar-thumb:hover {
        background: var(--cf-hscroll-color-thumb-hover, #475569);
      }

      /* Fade edges */
      :host([fade-edges]) .scroll-wrapper::before,
      :host([fade-edges]) .scroll-wrapper::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2rem;
        pointer-events: none;
        z-index: 1;
        transition: opacity 0.2s;
      }

      :host([fade-edges]) .scroll-wrapper::before {
        left: 0;
        background: linear-gradient(
          to right,
          var(--cf-hscroll-color-background, white),
          transparent
        );
        opacity: 0;
      }

      :host([fade-edges]) .scroll-wrapper::after {
        right: 0;
        background: linear-gradient(
          to left,
          var(--cf-hscroll-color-background, white),
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

      /* Ensure content doesn't wrap */
      ::slotted(*) {
        flex-shrink: 0;
      }
    `,
  ];

  private _scrollContainer: HTMLElement | null = null;

  constructor() {
    super();
    this.showScrollbar = false;
    this.fadeEdges = false;
    this.padding = "0";
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
  }

  override connectedCallback() {
    super.connectedCallback();
    // Set up scroll listener after element is ready
    this.updateComplete.then(() => {
      if (this.scrollContainer) {
        (this.scrollContainer as HTMLElement).addEventListener(
          "scroll",
          this.handleScroll,
        );
      }
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.scrollContainer) {
      (this.scrollContainer as HTMLElement).removeEventListener(
        "scroll",
        this.handleScroll,
      );
    }
  }

  private handleScroll = () => {
    this.updateScrollState();
    this.emit("cf-scroll", {
      scrollLeft: (this.scrollContainer as HTMLElement)?.scrollLeft || 0,
      scrollWidth: (this.scrollContainer as HTMLElement)?.scrollWidth || 0,
      clientWidth: (this.scrollContainer as HTMLElement)?.clientWidth || 0,
    });
  };

  private updateScrollState() {
    if (!this.scrollContainer || !this.fadeEdges) return;

    const { scrollLeft, scrollWidth, clientWidth } = this
      .scrollContainer as HTMLElement;
    this._atStart = scrollLeft <= 0;
    this._atEnd = scrollLeft + clientWidth >= scrollWidth - 1;
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

    return html`
      <div class="${classMap(wrapperClasses)}" part="wrapper">
        <div class="${classMap(containerClasses)}" part="container">
          <slot></slot>
        </div>
      </div>
    `;
  }

  /**
   * Scroll to a specific horizontal position
   */
  scrollToX(x: number, smooth: boolean = true) {
    if (this.scrollContainer) {
      (this.scrollContainer as HTMLElement).scrollTo({
        left: x,
        behavior: smooth ? "smooth" : "auto",
      });
    }
  }

  /**
   * Scroll by a specific horizontal amount
   */
  scrollByX(x: number, smooth: boolean = true) {
    if (this.scrollContainer) {
      (this.scrollContainer as HTMLElement).scrollBy({
        left: x,
        behavior: smooth ? "smooth" : "auto",
      });
    }
  }
}
