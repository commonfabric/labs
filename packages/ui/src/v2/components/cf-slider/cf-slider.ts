import { css, html, LitElement } from "lit";
import { type CellHandle } from "@commonfabric/runtime-client";
import { numberSchema } from "@commonfabric/runner/schemas";
import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";

export type SliderOrientation = "horizontal" | "vertical";

/**
 * CFSlider - Range input slider for value selection
 *
 * @element cf-slider
 *
 * @attr {number|CellHandle<number>} value - Current slider value. Bound to a
 *   cell (`$value` in a pattern), a move writes the cell and the slider follows
 *   the cell; a plain number is the slider's own state, as before.
 * @attr {number} min - Minimum allowed value (default: 0)
 * @attr {number} max - Maximum allowed value (default: 100)
 * @attr {number} step - Value increment/decrement step (default: 1)
 * @attr {boolean} disabled - Whether the slider is disabled
 * @attr {SliderOrientation} orientation - Slider orientation ("horizontal" | "vertical")
 *
 * @fires cf-change - Fired when value changes with detail: { value, oldValue }
 * @fires cf-input - Fired during dragging with detail: { value, oldValue }
 *
 * @example
 * <cf-slider min="0" max="100" value="50"></cf-slider>
 * <cf-slider min="0" max="100" value="25" step="5"></cf-slider>
 * <cf-slider orientation="vertical" style="height: 200px"></cf-slider>
 */
export class CFSlider extends BaseElement {
  static override shadowRootOptions = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static override properties = {
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
    disabled: { type: Boolean, reflect: true },
    orientation: { type: String, reflect: true },
  };
  // deno-fmt-ignore
  static override styles = [
    BaseElement.baseStyles,
    css`
    :host {
      /* Default color values if not provided */
      --cf-slider-color-background: var(--cf-theme-color-background, #ffffff);
      --cf-slider-color-foreground: var(--cf-theme-color-text, #0f172a);
      --cf-slider-color-border: var(--cf-theme-color-border, #e2e8f0);
      --cf-slider-color-ring: var(--cf-theme-color-primary, #94a3b8);
      --cf-slider-color-primary: var(--cf-theme-color-primary, #3b82f6);
      --cf-slider-color-primary-foreground: var(
        --cf-theme-color-primary-foreground,
        #ffffff
      );
      --cf-slider-color-muted: var(--cf-theme-color-surface, #f8fafc);
      --cf-slider-color-muted-foreground: var(
        --cf-theme-color-text-muted,
        #64748b
      );

      /* Slider dimensions */
      --cf-slider-height: 1.25rem;
      --cf-slider-track-height: 0.5rem;
      --cf-slider-thumb-size: 1.25rem;
      --cf-slider-border-radius: 9999px;
      --cf-slider-thumb-background: var(--cf-slider-color-background);
      --cf-slider-thumb-border-width: 2px;
      --cf-slider-thumb-shadow:
        0 1px 3px 0 rgba(0, 0, 0, 0.1),
        0 1px 2px -1px rgba(0, 0, 0, 0.1);
      --cf-slider-thumb-shadow-hover:
        0 4px 6px -1px rgba(0, 0, 0, 0.1),
        0 2px 4px -2px rgba(0, 0, 0, 0.1);

      display: inline-block;
      width: 100%;
      min-width: 200px;
    }

    :host([orientation="vertical"]) {
      width: var(--cf-slider-height);
      height: 200px;
      min-width: var(--cf-slider-height);
      min-height: 200px;
    }

    * {
      box-sizing: border-box;
    }

    .slider {
      position: relative;
      width: 100%;
      height: var(--cf-slider-height);
      display: flex;
      align-items: center;
      touch-action: none;
      user-select: none;
    }

    .slider.vertical {
      width: var(--cf-slider-height);
      height: 100%;
      align-items: center;
      justify-content: center;
    }

    .slider.disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Track */
    .track {
      position: relative;
      width: 100%;
      height: var(--cf-slider-track-height);
      background-color: var(--cf-slider-color-border);
      border-radius: var(--cf-slider-border-radius);
      overflow: visible;
      cursor: pointer;
    }

    .slider.vertical .track {
      width: var(--cf-slider-track-height);
      height: 100%;
    }

    .slider.disabled .track {
      cursor: not-allowed;
    }

    /* Range (filled portion) */
    .range {
      position: absolute;
      height: 100%;
      background-color: var(--cf-slider-color-primary);
      border-radius: var(--cf-slider-border-radius);
      pointer-events: none;
    }

    .slider.horizontal .range {
      left: 0;
      top: 0;
    }

    .slider.vertical .range {
      bottom: 0;
      left: 0;
      width: 100%;
    }

    /* Thumb */
    .thumb {
      position: absolute;
      width: var(--cf-slider-thumb-size);
      height: var(--cf-slider-thumb-size);
      background-color: var(--cf-slider-thumb-background);
      border: var(--cf-slider-thumb-border-width) solid
        var(--cf-slider-color-primary);
      border-radius: var(--cf-slider-border-radius);
      box-shadow: var(--cf-slider-thumb-shadow);
      box-sizing: border-box;
      cursor: grab;
      transform: translate(-50%, -50%);
      transition:
        border-color var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, cubic-bezier(0.4, 0, 0.2, 1)),
        box-shadow var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, cubic-bezier(0.4, 0, 0.2, 1)),
        transform var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, cubic-bezier(0.4, 0, 0.2, 1));
      z-index: 1;
    }

    .slider.horizontal .thumb {
      top: 50%;
    }

    .slider.vertical .thumb {
      left: 50%;
      transform: translate(-50%, 50%);
    }

    .slider.disabled .thumb {
      cursor: not-allowed;
      border-color: var(--cf-slider-color-border);
    }

    /* Hover state */
    :host(:not([disabled]):hover) .thumb {
      border-color: var(--cf-slider-color-primary);
      box-shadow: var(--cf-slider-thumb-shadow-hover);
    }

    /* Focus state */
    :host(:focus) {
      outline: none;
    }

    :host(:focus-visible) .thumb {
      outline: 2px solid transparent;
      outline-offset: 2px;
      box-shadow:
        0 0 0 2px var(--cf-slider-color-background),
        0 0 0 4px var(--cf-slider-color-ring);
    }

    /* Active/dragging state */
    :host(.dragging) .thumb,
    .thumb:active {
      cursor: grabbing;
      transform: translate(-50%, -50%) scale(1.1);
    }

    .slider.vertical .thumb:active,
    :host(.dragging) .slider.vertical .thumb {
      transform: translate(-50%, 50%) scale(1.1);
    }

    /* Touch target enhancement */
    .thumb::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 2.5rem;
      height: 2.5rem;
      transform: translate(-50%, -50%);
    }

    /* Transitions */
    .range {
      transition: width var(--cf-transition-duration-fast, 150ms)
        var(--cf-transition-timing-ease, cubic-bezier(0.4, 0, 0.2, 1));
    }

    .slider.vertical .range {
      transition: height var(--cf-transition-duration-fast, 150ms)
        var(--cf-transition-timing-ease, cubic-bezier(0.4, 0, 0.2, 1));
    }

    /* High contrast mode support */
    @media (prefers-contrast: high) {
      .track {
        border: 1px solid;
      }

      .thumb {
        border-width: 3px;
      }
    }

    /* Reduced motion support */
    @media (prefers-reduced-motion: reduce) {
      .thumb,
      .range {
        transition: none;
      }
    }
  `,
  ];

  declare value: CellHandle<number> | number;
  declare min: number;
  declare max: number;
  declare step: number;
  declare disabled: boolean;
  declare orientation: SliderOrientation;

  // Immediate, so a move's announcement and its write happen together: a
  // write held back by a timer can be cancelled (by a rebind, a refusal or a
  // disconnect) after its move was announced.
  private _valueCellController = createCellController<number>(this, {
    timing: { strategy: "immediate" },
  });

  private _trackElement: HTMLElement | null = null;
  private _thumbElement: HTMLElement | null = null;
  private _rangeElement: HTMLElement | null = null;

  constructor() {
    super();
    this.value = 50;
    this.min = 0;
    this.max = 100;
    this.step = 1;
    this.disabled = false;
    this.orientation = "horizontal";
  }

  get trackElement(): HTMLElement | null {
    if (!this._trackElement) {
      this._trackElement =
        this.shadowRoot?.querySelector(".track") as HTMLElement || null;
    }
    return this._trackElement;
  }

  get thumbElement(): HTMLElement | null {
    if (!this._thumbElement) {
      this._thumbElement =
        this.shadowRoot?.querySelector(".thumb") as HTMLElement || null;
    }
    return this._thumbElement;
  }

  get rangeElement(): HTMLElement | null {
    if (!this._rangeElement) {
      this._rangeElement =
        this.shadowRoot?.querySelector(".range") as HTMLElement || null;
    }
    return this._rangeElement;
  }

  private _isDragging = false;

  override connectedCallback() {
    if (!this.hasAttribute("role")) {
      this.setAttribute("role", "slider");
    }
    if (!this.hasAttribute("exportparts")) {
      this.setAttribute("exportparts", "base,track,range,thumb");
    }
    super.connectedCallback();

    this._valueCellController.bind(this.value, numberSchema);
    // A plain value is the slider's own, so it is brought within bounds here.
    // A cell's value belongs to the cell: it is shown clamped, never rewritten.
    if (!this._valueCellController.hasCell()) {
      this.value = this._clampValue(this._snapToStep(this._current));
    }
    this._updateAriaAttributes();

    // Add keyboard event listener
    this.addEventListener("keydown", this._handleKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this._handleKeyDown);

    // Remove document listeners if dragging
    if (this._isDragging) {
      this._stopDragging();
    }
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);
    if (changedProperties.has("value")) {
      this._valueCellController.bind(this.value, numberSchema);
    }
  }

  override updated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.updated(changedProperties);

    if (
      !this._valueCellController.hasCell() &&
      (changedProperties.has("min") || changedProperties.has("max") ||
        changedProperties.has("step"))
    ) {
      // Re-clamp and snap the value when constraints change
      const clampedValue = this._clampValue(this._snapToStep(this._current));
      if (clampedValue !== this.value) {
        this.value = clampedValue;
      }
    }

    // A bound cell's value arrives without any property changing, so the
    // position and ARIA state follow every update rather than named ones.
    this._updateAriaAttributes();
    this._updateSliderPosition();
  }

  /** `value` as the slider shows it: within bounds, the minimum if unset. */
  private _shown(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
      ? this._clampValue(value)
      : this.min;
  }

  /**
   * The value shown: what the bound cell holds, or the plain property. The
   * plain property is read directly, so a move made in this tick is seen by
   * the next one rather than after Lit's update rebinds the controller.
   */
  private get _current(): number {
    return this._shown(
      this._valueCellController.hasCell()
        ? this._valueCellController.getValue()
        : this.value,
    );
  }

  /**
   * Move the value to what `next` makes of the current one. Bound to a cell,
   * the controller computes it from what the cell holds, asking the worker
   * first where the cell has not been read, so a step is never taken from the
   * placeholder shown before it answered. The move is announced as it is
   * computed, which happens only when the cell can be written, so a refused
   * read announces nothing. A plain value moves now.
   */
  private _move(next: (current: number) => number): void {
    // Snapped, then clamped: a step that does not divide the range would
    // otherwise snap past the maximum.
    const target = (current: number) =>
      this._clampValue(this._snapToStep(next(current)));
    // Taken now: on a cell not yet read the move is computed after the worker
    // answers, by which time a short drag may have ended.
    const dragging = this._isDragging;
    if (this._valueCellController.hasCell()) {
      void this._valueCellController.updateValue((held) => {
        const oldValue = this._shown(held);
        const value = target(oldValue);
        // A move that leaves the shown value alone is not announced, and
        // writes nothing to a cell that holds a value, even one out of bounds.
        if (value === oldValue) return held ?? value;
        this._announce(value, oldValue, dragging);
        return value;
      });
      return;
    }
    const oldValue = this._current;
    const value = target(oldValue);
    if (value === oldValue) return;
    this.value = value;
    this._announce(value, oldValue, dragging);
  }

  /** `cf-input` for a move made while dragging, and `cf-change` for every move. */
  private _announce(value: number, oldValue: number, dragging: boolean): void {
    if (dragging) this.emit("cf-input", { value, oldValue });
    this.emit("cf-change", { value, oldValue });
  }

  override firstUpdated() {
    // Cache references
    this._trackElement =
      this.shadowRoot?.querySelector(".track") as HTMLElement || null;
    this._thumbElement =
      this.shadowRoot?.querySelector(".thumb") as HTMLElement || null;
    this._rangeElement =
      this.shadowRoot?.querySelector(".range") as HTMLElement || null;

    this._updateSliderPosition();
  }

  override render() {
    const sliderClasses = {
      "slider": true,
      [this.orientation]: true,
      "disabled": this.disabled,
    };

    const classString = Object.entries(sliderClasses)
      .filter(([_, value]) => value)
      .map(([key]) => key)
      .join(" ");

    return html`
      <div class="${classString}" part="base">
        <div
          class="track"
          part="track"
          @mousedown="${this._handleTrackMouseDown}"
          @touchstart="${this._handleTrackTouchStart}"
        >
          <div class="range" part="range"></div>
          <div
            class="thumb"
            part="thumb"
            role="presentation"
            @mousedown="${this._handleThumbMouseDown}"
            @touchstart="${this._handleThumbTouchStart}"
          ></div>
        </div>
      </div>
    `;
  }

  private _clampValue(value: number): number {
    return Math.min(Math.max(value, this.min), this.max);
  }

  private _snapToStep(value: number): number {
    const steps = Math.round((value - this.min) / this.step);
    return this.min + steps * this.step;
  }

  private _getPercentage(): number {
    const range = this.max - this.min;
    return range > 0 ? ((this._current - this.min) / range) * 100 : 0;
  }

  private _updateSliderPosition(): void {
    if (!this.thumbElement || !this.rangeElement) return;

    const percentage = this._getPercentage();

    if (this.orientation === "horizontal") {
      this.thumbElement.style.left = `${percentage}%`;
      this.thumbElement.style.top = "";
      this.rangeElement.style.width = `${percentage}%`;
      this.rangeElement.style.height = "";
    } else {
      // For vertical sliders, 0% is at the bottom
      this.thumbElement.style.bottom = `${percentage}%`;
      this.thumbElement.style.left = "";
      this.thumbElement.style.top = "";
      this.rangeElement.style.height = `${percentage}%`;
      this.rangeElement.style.width = "";
    }
  }

  private _updateAriaAttributes() {
    this.setAttribute("aria-valuemin", this.min.toString());
    this.setAttribute("aria-valuemax", this.max.toString());
    this.setAttribute("aria-valuenow", this._current.toString());
    this.setAttribute("aria-disabled", this.disabled.toString());
    this.setAttribute("aria-orientation", this.orientation);
    this.tabIndex = this.disabled ? -1 : 0;
  }

  private _handleTrackMouseDown = (event: MouseEvent): void => {
    if (this.disabled) return;
    event.preventDefault();
    this._updateValueFromPosition(event.clientX, event.clientY);
    this._startDragging();
  };

  private _handleTrackTouchStart = (event: TouchEvent): void => {
    if (this.disabled) return;
    event.preventDefault();
    const touch = event.touches[0];
    this._updateValueFromPosition(touch.clientX, touch.clientY);
    this._startDragging();
  };

  private _handleThumbMouseDown = (event: MouseEvent): void => {
    if (this.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    this._startDragging();
  };

  private _handleThumbTouchStart = (event: TouchEvent): void => {
    if (this.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    this._startDragging();
  };

  private _startDragging(): void {
    this._isDragging = true;
    document.addEventListener("mousemove", this._handleMouseMove);
    document.addEventListener("mouseup", this._handleMouseUp);
    document.addEventListener("touchmove", this._handleTouchMove, {
      passive: false,
    });
    document.addEventListener("touchend", this._handleTouchEnd);
    this.classList.add("dragging");
  }

  private _stopDragging(): void {
    this._isDragging = false;
    document.removeEventListener("mousemove", this._handleMouseMove);
    document.removeEventListener("mouseup", this._handleMouseUp);
    document.removeEventListener("touchmove", this._handleTouchMove);
    document.removeEventListener("touchend", this._handleTouchEnd);
    this.classList.remove("dragging");
  }

  private _handleMouseMove = (event: MouseEvent): void => {
    if (!this._isDragging || this.disabled) return;
    event.preventDefault();
    this._updateValueFromPosition(event.clientX, event.clientY);
  };

  private _handleTouchMove = (event: TouchEvent): void => {
    if (!this._isDragging || this.disabled) return;
    event.preventDefault();
    const touch = event.touches[0];
    this._updateValueFromPosition(touch.clientX, touch.clientY);
  };

  private _handleMouseUp = (): void => {
    this._stopDragging();
  };

  private _handleTouchEnd = (): void => {
    this._stopDragging();
  };

  private _updateValueFromPosition(
    clientX: number,
    clientY: number,
  ): void {
    if (!this.trackElement) return;

    const rect = this.trackElement.getBoundingClientRect();
    let percentage: number;

    if (this.orientation === "horizontal") {
      const x = clientX - rect.left;
      percentage = (x / rect.width) * 100;
    } else {
      // For vertical sliders, invert the percentage (0% at bottom)
      const y = clientY - rect.top;
      percentage = (1 - y / rect.height) * 100;
    }

    percentage = Math.max(0, Math.min(100, percentage));
    const range = this.max - this.min;
    const newValue = this.min + (percentage / 100) * range;
    this._move(() => newValue);
  }

  private _handleKeyDown = (event: KeyboardEvent): void => {
    if (this.disabled) return;

    const bigStep = this.step * 10;
    const moves: Record<string, (current: number) => number> = {
      ArrowLeft: (current) => current - this.step,
      ArrowDown: (current) => current - this.step,
      ArrowRight: (current) => current + this.step,
      ArrowUp: (current) => current + this.step,
      PageDown: (current) => current - bigStep,
      PageUp: (current) => current + bigStep,
      Home: () => this.min,
      End: () => this.max,
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    this._move(move);
  };

  /**
   * Set the slider value programmatically
   */
  setValue(value: number): void {
    this._move(() => value);
  }

  /**
   * Get the current value as a percentage (0-100)
   */
  getPercentageValue(): number {
    return this._getPercentage();
  }

  /**
   * Increment the slider value by one step
   */
  increment(): void {
    this._move((current) => current + this.step);
  }

  /**
   * Decrement the slider value by one step
   */
  decrement(): void {
    this._move((current) => current - this.step);
  }
}
