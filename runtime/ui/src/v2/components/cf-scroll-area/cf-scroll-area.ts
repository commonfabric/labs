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

  private _scrollContainer: HTMLElement | null = null;
  private _verticalScrollbar: HTMLElement | null = null;
  private _horizontalScrollbar: HTMLElement | null = null;
  private _verticalThumb: HTMLElement | null = null;
  private _horizontalThumb: HTMLElement | null = null;

  constructor() {
    super();
    this.orientation = "vertical";
    this._isDraggingVertical = false;
    this._isDraggingHorizontal = false;
  }

  get scrollContainer(): HTMLElement | null {
    if (!this._scrollContainer) {
      this._scrollContainer =
        this.shadowRoot?.querySelector(".scroll-container") as HTMLElement ||
        null;
    }
    return this._scrollContainer;
  }

  get verticalScrollbar(): HTMLElement | null {
    if (!this._verticalScrollbar) {
      this._verticalScrollbar =
        this.shadowRoot?.querySelector(".scrollbar-vertical") as HTMLElement ||
        null;
    }
    return this._verticalScrollbar;
  }

  get horizontalScrollbar(): HTMLElement | null {
    if (!this._horizontalScrollbar) {
      this._horizontalScrollbar = this.shadowRoot?.querySelector(
        ".scrollbar-horizontal",
      ) as HTMLElement || null;
    }
    return this._horizontalScrollbar;
  }

  get verticalThumb(): HTMLElement | null {
    if (!this._verticalThumb) {
      this._verticalThumb = this.shadowRoot?.querySelector(
        ".scrollbar-thumb-vertical",
      ) as HTMLElement || null;
    }
    return this._verticalThumb;
  }

  get horizontalThumb(): HTMLElement | null {
    if (!this._horizontalThumb) {
      this._horizontalThumb = this.shadowRoot?.querySelector(
        ".scrollbar-thumb-horizontal",
      ) as HTMLElement || null;
    }
    return this._horizontalThumb;
  }

  private _dragStartY = 0;
  private _dragStartX = 0;
  private _scrollStartY = 0;
  private _scrollStartX = 0;
  private _rafId: number | null = null;
  private _hideTimeoutId: ReturnType<typeof setTimeout> | null = null;

  override firstUpdated() {
    // Set up event listeners
    if (this._scrollContainer) {
      this._scrollContainer.addEventListener("scroll", this.handleScroll);
      this._scrollContainer.addEventListener(
        "mouseenter",
        this.handleMouseEnter,
      );
      this._scrollContainer.addEventListener(
        "mouseleave",
        this.handleMouseLeave,
      );
    }

    // Set up vertical scrollbar
    if (
      this._verticalThumb &&
      (this.orientation === "vertical" || this.orientation === "both")
    ) {
      this._verticalThumb.addEventListener(
        "mousedown",
        this.handleVerticalThumbMouseDown,
      );
      this._verticalScrollbar?.addEventListener(
        "click",
        this.handleVerticalTrackClick,
      );
    }

    // Set up horizontal scrollbar
    if (
      this._horizontalThumb &&
      (this.orientation === "horizontal" || this.orientation === "both")
    ) {
      this._horizontalThumb.addEventListener(
        "mousedown",
        this.handleHorizontalThumbMouseDown,
      );
      this._horizontalScrollbar?.addEventListener(
        "click",
        this.handleHorizontalTrackClick,
      );
    }

    // Initial update
    this.updateScrollbars();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();

    // Clean up event listeners
    if (this._scrollContainer) {
      this._scrollContainer.removeEventListener("scroll", this.handleScroll);
      this._scrollContainer.removeEventListener(
        "mouseenter",
        this.handleMouseEnter,
      );
      this._scrollContainer.removeEventListener(
        "mouseleave",
        this.handleMouseLeave,
      );
    }

    if (this._verticalThumb) {
      this._verticalThumb.removeEventListener(
        "mousedown",
        this.handleVerticalThumbMouseDown,
      );
    }

    if (this._horizontalThumb) {
      this._horizontalThumb.removeEventListener(
        "mousedown",
        this.handleHorizontalThumbMouseDown,
      );
    }

    if (this._verticalScrollbar) {
      this._verticalScrollbar.removeEventListener(
        "click",
        this.handleVerticalTrackClick,
      );
    }

    if (this._horizontalScrollbar) {
      this._horizontalScrollbar.removeEventListener(
        "click",
        this.handleHorizontalTrackClick,
      );
    }

    // Cancel animation frame
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
    }

    // Clear timeout
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
        <div class="scroll-container" part="viewport">
          <div class="scroll-content" part="content">
            <slot></slot>
          </div>
        </div>
        ${showVertical
          ? html`
            <div class="scrollbar scrollbar-vertical" part="scrollbar-vertical">
              <div class="scrollbar-thumb scrollbar-thumb-vertical"
                part="thumb-vertical"></div>
            </div>
          `
          : ""} ${showHorizontal
          ? html`
            <div class="scrollbar scrollbar-horizontal" part="scrollbar-horizontal">
              <div
                class="scrollbar-thumb scrollbar-thumb-horizontal"
                part="thumb-horizontal"
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
    if (!this._scrollContainer) return;

    const {
      scrollTop,
      scrollLeft,
      scrollHeight,
      scrollWidth,
      clientHeight,
      clientWidth,
    } = this._scrollContainer;

    // Update vertical scrollbar
    if (
      this._verticalThumb && this._verticalScrollbar &&
      (this.orientation === "vertical" || this.orientation === "both")
    ) {
      const scrollRatio = clientHeight / scrollHeight;
      const thumbHeight = Math.max(30, clientHeight * scrollRatio);
      const scrollableHeight = clientHeight - thumbHeight;
      const thumbPosition = (scrollTop / (scrollHeight - clientHeight)) *
        scrollableHeight;

      this._verticalThumb.style.height = `${thumbHeight}px`;
      this._verticalThumb.style.transform = `translateY(${thumbPosition}px)`;

      // Show/hide scrollbar based on content
      if (scrollHeight > clientHeight) {
        this._verticalScrollbar.classList.add("scrollbar-visible");
      } else {
        this._verticalScrollbar.classList.remove("scrollbar-visible");
      }
    }

    // Update horizontal scrollbar
    if (
      this._horizontalThumb && this._horizontalScrollbar &&
      (this.orientation === "horizontal" || this.orientation === "both")
    ) {
      const scrollRatio = clientWidth / scrollWidth;
      const thumbWidth = Math.max(30, clientWidth * scrollRatio);
      const scrollableWidth = clientWidth - thumbWidth;
      const thumbPosition = (scrollLeft / (scrollWidth - clientWidth)) *
        scrollableWidth;

      this._horizontalThumb.style.width = `${thumbWidth}px`;
      this._horizontalThumb.style.transform = `translateX(${thumbPosition}px)`;

      // Show/hide scrollbar based on content
      if (scrollWidth > clientWidth) {
        this._horizontalScrollbar.classList.add("scrollbar-visible");
      } else {
        this._horizontalScrollbar.classList.remove("scrollbar-visible");
      }
    }
  }

  private showScrollbars(): void {
    if (this._hideTimeoutId !== null) {
      clearTimeout(this._hideTimeoutId);
      this._hideTimeoutId = null;
    }

    this._verticalScrollbar?.classList.add("scrollbar-hover");
    this._horizontalScrollbar?.classList.add("scrollbar-hover");
  }

  private hideScrollbarsDelayed(): void {
    if (this._hideTimeoutId !== null) {
      clearTimeout(this._hideTimeoutId);
    }

    this._hideTimeoutId = globalThis.setTimeout(() => {
      this._verticalScrollbar?.classList.remove("scrollbar-hover");
      this._horizontalScrollbar?.classList.remove("scrollbar-hover");
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
    this._scrollStartY = this._scrollContainer?.scrollTop || 0;

    document.addEventListener("mousemove", this.handleVerticalThumbMouseMove);
    document.addEventListener("mouseup", this.handleVerticalThumbMouseUp);

    this._verticalScrollbar?.classList.add("scrollbar-dragging");
  };

  private handleVerticalThumbMouseMove = (event: MouseEvent): void => {
    if (
      !this._isDraggingVertical || !this._scrollContainer ||
      !this._verticalThumb
    ) return;

    const deltaY = event.clientY - this._dragStartY;
    const { scrollHeight, clientHeight } = this._scrollContainer;
    const thumbHeight = parseFloat(this._verticalThumb.style.height) || 0;
    const scrollableHeight = clientHeight - thumbHeight;
    const scrollRatio = deltaY / scrollableHeight;
    const newScrollTop = this._scrollStartY +
      scrollRatio * (scrollHeight - clientHeight);

    this._scrollContainer.scrollTop = newScrollTop;
  };

  private handleVerticalThumbMouseUp = (): void => {
    this._isDraggingVertical = false;
    document.removeEventListener(
      "mousemove",
      this.handleVerticalThumbMouseMove,
    );
    document.removeEventListener("mouseup", this.handleVerticalThumbMouseUp);

    this._verticalScrollbar?.classList.remove("scrollbar-dragging");

    // Check if mouse is still over the component
    const isHovering = this.matches(":hover");
    if (!isHovering) {
      this.hideScrollbarsDelayed();
    }
  };

  private handleVerticalTrackClick = (event: MouseEvent): void => {
    if (!this._scrollContainer || !this._verticalThumb) return;

    const target = event.target as HTMLElement;
    if (target === this._verticalThumb) return;

    const rect = this._verticalScrollbar!.getBoundingClientRect();
    const clickY = event.clientY - rect.top;
    const thumbHeight = parseFloat(this._verticalThumb.style.height) || 0;
    const { scrollHeight, clientHeight } = this._scrollContainer;
    const scrollRatio = (clickY - thumbHeight / 2) /
      (clientHeight - thumbHeight);
    const newScrollTop = scrollRatio * (scrollHeight - clientHeight);

    this._scrollContainer.scrollTop = Math.max(
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
    this._scrollStartX = this._scrollContainer?.scrollLeft || 0;

    document.addEventListener("mousemove", this.handleHorizontalThumbMouseMove);
    document.addEventListener("mouseup", this.handleHorizontalThumbMouseUp);

    this._horizontalScrollbar?.classList.add("scrollbar-dragging");
  };

  private handleHorizontalThumbMouseMove = (event: MouseEvent): void => {
    if (
      !this._isDraggingHorizontal || !this._scrollContainer ||
      !this._horizontalThumb
    ) return;

    const deltaX = event.clientX - this._dragStartX;
    const { scrollWidth, clientWidth } = this._scrollContainer;
    const thumbWidth = parseFloat(this._horizontalThumb.style.width) || 0;
    const scrollableWidth = clientWidth - thumbWidth;
    const scrollRatio = deltaX / scrollableWidth;
    const newScrollLeft = this._scrollStartX +
      scrollRatio * (scrollWidth - clientWidth);

    this._scrollContainer.scrollLeft = newScrollLeft;
  };

  private handleHorizontalThumbMouseUp = (): void => {
    this._isDraggingHorizontal = false;
    document.removeEventListener(
      "mousemove",
      this.handleHorizontalThumbMouseMove,
    );
    document.removeEventListener("mouseup", this.handleHorizontalThumbMouseUp);

    this._horizontalScrollbar?.classList.remove("scrollbar-dragging");

    // Check if mouse is still over the component
    const isHovering = this.matches(":hover");
    if (!isHovering) {
      this.hideScrollbarsDelayed();
    }
  };

  private handleHorizontalTrackClick = (event: MouseEvent): void => {
    if (!this._scrollContainer || !this._horizontalThumb) return;

    const target = event.target as HTMLElement;
    if (target === this._horizontalThumb) return;

    const rect = this._horizontalScrollbar!.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const thumbWidth = parseFloat(this._horizontalThumb.style.width) || 0;
    const { scrollWidth, clientWidth } = this._scrollContainer;
    const scrollRatio = (clickX - thumbWidth / 2) / (clientWidth - thumbWidth);
    const newScrollLeft = scrollRatio * (scrollWidth - clientWidth);

    this._scrollContainer.scrollLeft = Math.max(
      0,
      Math.min(newScrollLeft, scrollWidth - clientWidth),
    );
  };
}
