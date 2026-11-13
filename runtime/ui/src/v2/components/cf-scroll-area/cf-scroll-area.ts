/**
 * @fileoverview UI Scroll Area Component - Custom scrollable area with styled scrollbars
 *
 * @module cf-scroll-area
 * @description
 * A scrollable container component that provides custom-styled scrollbars for better
 * visual consistency across browsers and platforms. Supports vertical, horizontal,
 * or bidirectional scrolling with smooth animations and hover effects.
 *
 * @example
 * ```html
 * <cf-scroll-area style="height: 200px" orientation="vertical">
 *   <div>Long content that needs scrolling...</div>
 * </cf-scroll-area>
 * ```
 */

import { html, unsafeCSS } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { scrollAreaStyles } from "./styles.ts";

export type ScrollOrientation = "vertical" | "horizontal" | "both";

/**
 * CFScrollArea provides a customizable scrollable container with styled scrollbars.
 *
 * @tag cf-scroll-area
 * @extends BaseElement
 *
 * @property {ScrollOrientation} orientation - Scroll direction ("vertical" | "horizontal" | "both")
 *
 * @attribute {string} orientation - Sets which directions can be scrolled
 *
 * @slot default - Scrollable content
 *
 * @csspart root - The root container element
 * @csspart viewport - The scrollable viewport container
 * @csspart content - The content wrapper element
 * @csspart scrollbar-vertical - The vertical scrollbar track
 * @csspart scrollbar-horizontal - The horizontal scrollbar track
 * @csspart thumb-vertical - The vertical scrollbar thumb
 * @csspart thumb-horizontal - The horizontal scrollbar thumb
 *
 * @note Scrollbars appear on hover and during scrolling with smooth fade animations
 */
export class CFScrollArea extends BaseElement {
  static override styles = unsafeCSS(scrollAreaStyles);

  static override properties = {
    orientation: { type: String },
    _isDraggingVertical: { type: Boolean, state: true },
    _isDraggingHorizontal: { type: Boolean, state: true },
  };

  declare orientation: ScrollOrientation;
  declare private _isDraggingVertical: boolean;
  declare private _isDraggingHorizontal: boolean;

  private _dragStartY = 0;
  private _dragStartX = 0;
  private _scrollStartY = 0;
  private _scrollStartX = 0;
  private _rafId: number | null = null;
  private _hideTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.orientation = "vertical";
    this._isDraggingVertical = false;
    this._isDraggingHorizontal = false;
  }

  get #scrollContainer(): HTMLElement | null {
    return this.renderRoot.querySelector(".scroll-container");
  }

  get #verticalScrollbar(): HTMLElement | null {
    return this.renderRoot.querySelector(".scrollbar-vertical");
  }

  get #horizontalScrollbar(): HTMLElement | null {
    return this.renderRoot.querySelector(".scrollbar-horizontal");
  }

  get #verticalThumb(): HTMLElement | null {
    return this.renderRoot.querySelector(".scrollbar-thumb-vertical");
  }

  get #horizontalThumb(): HTMLElement | null {
    return this.renderRoot.querySelector(".scrollbar-thumb-horizontal");
  }

  override updated() {
    this.updateScrollbars();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();

    if (this._isDraggingVertical) this.handleVerticalThumbMouseUp();
    if (this._isDraggingHorizontal) this.handleHorizontalThumbMouseUp();

    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
    }

    if (this._hideTimeoutId !== null) {
      clearTimeout(this._hideTimeoutId);
    }
  }

  override render() {
    const showVertical = this.orientation === "vertical" ||
      this.orientation === "both";
    const showHorizontal = this.orientation === "horizontal" ||
      this.orientation === "both";

    return html`
      <div class="scroll-area" part="root">
        <div
          class="scroll-container"
          part="viewport"
          @scroll="${this.handleScroll}"
          @mouseenter="${this.handleMouseEnter}"
          @mouseleave="${this.handleMouseLeave}"
        >
          <div class="scroll-content" part="content">
            <slot></slot>
          </div>
        </div>
        ${showVertical
          ? html`
            <div
              class="scrollbar scrollbar-vertical"
              part="scrollbar-vertical"
              @click="${this.handleVerticalTrackClick}"
            >
              <div
                class="scrollbar-thumb scrollbar-thumb-vertical"
                part="thumb-vertical"
                @mousedown="${this.handleVerticalThumbMouseDown}"
              ></div>
            </div>
          `
          : ""} ${showHorizontal
          ? html`
            <div
              class="scrollbar scrollbar-horizontal"
              part="scrollbar-horizontal"
              @click="${this.handleHorizontalTrackClick}"
            >
              <div
                class="scrollbar-thumb scrollbar-thumb-horizontal"
                part="thumb-horizontal"
                @mousedown="${this.handleHorizontalThumbMouseDown}"
              ></div>
            </div>
          `
          : ""}
      </div>
    `;
  }

  private handleScroll = (): void => {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
    }

    this._rafId = requestAnimationFrame(() => {
      this.updateScrollbars();
      this._rafId = null;
    });
  };

  private handleMouseEnter = (): void => {
    this.showScrollbars();
  };

  private handleMouseLeave = (): void => {
    if (!this._isDraggingVertical && !this._isDraggingHorizontal) {
      this.hideScrollbarsDelayed();
    }
  };

  private updateScrollbars(): void {
    const container = this.#scrollContainer;
    const verticalThumb = this.#verticalThumb;
    const verticalScrollbar = this.#verticalScrollbar;
    if (container && verticalThumb && verticalScrollbar) {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const scrollRatio = clientHeight / scrollHeight;
      const thumbHeight = Math.max(30, clientHeight * scrollRatio);
      const scrollableHeight = clientHeight - thumbHeight;
      const thumbPosition = (scrollTop / (scrollHeight - clientHeight)) *
        scrollableHeight;

      verticalThumb.style.height = `${thumbHeight}px`;
      verticalThumb.style.transform = `translateY(${thumbPosition}px)`;

      // Show/hide scrollbar based on content
      if (scrollHeight > clientHeight) {
        verticalScrollbar.classList.add("scrollbar-visible");
      } else {
        verticalScrollbar.classList.remove("scrollbar-visible");
      }
    }

    const horizontalThumb = this.#horizontalThumb;
    const horizontalScrollbar = this.#horizontalScrollbar;
    if (container && horizontalThumb && horizontalScrollbar) {
      const { scrollLeft, scrollWidth, clientWidth } = container;
      const scrollRatio = clientWidth / scrollWidth;
      const thumbWidth = Math.max(30, clientWidth * scrollRatio);
      const scrollableWidth = clientWidth - thumbWidth;
      const thumbPosition = (scrollLeft / (scrollWidth - clientWidth)) *
        scrollableWidth;

      horizontalThumb.style.width = `${thumbWidth}px`;
      horizontalThumb.style.transform = `translateX(${thumbPosition}px)`;

      // Show/hide scrollbar based on content
      if (scrollWidth > clientWidth) {
        horizontalScrollbar.classList.add("scrollbar-visible");
      } else {
        horizontalScrollbar.classList.remove("scrollbar-visible");
      }
    }
  }

  private showScrollbars(): void {
    if (this._hideTimeoutId !== null) {
      clearTimeout(this._hideTimeoutId);
      this._hideTimeoutId = null;
    }

    this.#verticalScrollbar?.classList.add("scrollbar-hover");
    this.#horizontalScrollbar?.classList.add("scrollbar-hover");
  }

  private hideScrollbarsDelayed(): void {
    if (this._hideTimeoutId !== null) {
      clearTimeout(this._hideTimeoutId);
    }

    this._hideTimeoutId = globalThis.setTimeout(() => {
      this.#verticalScrollbar?.classList.remove("scrollbar-hover");
      this.#horizontalScrollbar?.classList.remove("scrollbar-hover");
      this._hideTimeoutId = null;
    }, 1000);
  }

  //
  // Vertical scrollbar handlers
  //

  private handleVerticalThumbMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();

    this._isDraggingVertical = true;
    this._dragStartY = event.clientY;
    this._scrollStartY = this.#scrollContainer?.scrollTop || 0;

    document.addEventListener("mousemove", this.handleVerticalThumbMouseMove);
    document.addEventListener("mouseup", this.handleVerticalThumbMouseUp);

    this.#verticalScrollbar?.classList.add("scrollbar-dragging");
  };

  private handleVerticalThumbMouseMove = (event: MouseEvent): void => {
    const container = this.#scrollContainer;
    const thumb = this.#verticalThumb;
    if (!this._isDraggingVertical || !container || !thumb) return;

    const deltaY = event.clientY - this._dragStartY;
    const { scrollHeight, clientHeight } = container;
    const thumbHeight = parseFloat(thumb.style.height) || 0;
    const scrollableHeight = clientHeight - thumbHeight;
    const scrollRatio = deltaY / scrollableHeight;
    const newScrollTop = this._scrollStartY +
      scrollRatio * (scrollHeight - clientHeight);

    container.scrollTop = newScrollTop;
  };

  private handleVerticalThumbMouseUp = (): void => {
    this._isDraggingVertical = false;
    document.removeEventListener(
      "mousemove",
      this.handleVerticalThumbMouseMove,
    );
    document.removeEventListener("mouseup", this.handleVerticalThumbMouseUp);

    this.#verticalScrollbar?.classList.remove("scrollbar-dragging");

    // Check if mouse is still over the component
    const isHovering = this.matches(":hover");
    if (!isHovering) {
      this.hideScrollbarsDelayed();
    }
  };

  private handleVerticalTrackClick = (event: MouseEvent): void => {
    const container = this.#scrollContainer;
    const scrollbar = this.#verticalScrollbar;
    const thumb = this.#verticalThumb;
    if (!container || !scrollbar || !thumb || event.target === thumb) return;

    const rect = scrollbar.getBoundingClientRect();
    const clickY = event.clientY - rect.top;
    const thumbHeight = parseFloat(thumb.style.height) || 0;
    const { scrollHeight, clientHeight } = container;
    const scrollRatio = (clickY - thumbHeight / 2) /
      (clientHeight - thumbHeight);
    const newScrollTop = scrollRatio * (scrollHeight - clientHeight);

    container.scrollTop = Math.max(
      0,
      Math.min(newScrollTop, scrollHeight - clientHeight),
    );
  };

  //
  // Horizontal scrollbar handlers
  //

  private handleHorizontalThumbMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();

    this._isDraggingHorizontal = true;
    this._dragStartX = event.clientX;
    this._scrollStartX = this.#scrollContainer?.scrollLeft || 0;

    document.addEventListener("mousemove", this.handleHorizontalThumbMouseMove);
    document.addEventListener("mouseup", this.handleHorizontalThumbMouseUp);

    this.#horizontalScrollbar?.classList.add("scrollbar-dragging");
  };

  private handleHorizontalThumbMouseMove = (event: MouseEvent): void => {
    const container = this.#scrollContainer;
    const thumb = this.#horizontalThumb;
    if (!this._isDraggingHorizontal || !container || !thumb) return;

    const deltaX = event.clientX - this._dragStartX;
    const { scrollWidth, clientWidth } = container;
    const thumbWidth = parseFloat(thumb.style.width) || 0;
    const scrollableWidth = clientWidth - thumbWidth;
    const scrollRatio = deltaX / scrollableWidth;
    const newScrollLeft = this._scrollStartX +
      scrollRatio * (scrollWidth - clientWidth);

    container.scrollLeft = newScrollLeft;
  };

  private handleHorizontalThumbMouseUp = (): void => {
    this._isDraggingHorizontal = false;
    document.removeEventListener(
      "mousemove",
      this.handleHorizontalThumbMouseMove,
    );
    document.removeEventListener("mouseup", this.handleHorizontalThumbMouseUp);

    this.#horizontalScrollbar?.classList.remove("scrollbar-dragging");

    // Check if mouse is still over the component
    const isHovering = this.matches(":hover");
    if (!isHovering) {
      this.hideScrollbarsDelayed();
    }
  };

  private handleHorizontalTrackClick = (event: MouseEvent): void => {
    const container = this.#scrollContainer;
    const scrollbar = this.#horizontalScrollbar;
    const thumb = this.#horizontalThumb;
    if (!container || !scrollbar || !thumb || event.target === thumb) return;

    const rect = scrollbar.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const thumbWidth = parseFloat(thumb.style.width) || 0;
    const { scrollWidth, clientWidth } = container;
    const scrollRatio = (clickX - thumbWidth / 2) / (clientWidth - thumbWidth);
    const newScrollLeft = scrollRatio * (scrollWidth - clientWidth);

    container.scrollLeft = Math.max(
      0,
      Math.min(newScrollLeft, scrollWidth - clientWidth),
    );
  };
}
