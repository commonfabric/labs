import { css, html, LitElement } from "lit";
import { type CellHandle } from "@commonfabric/runtime-client";
import { numberSchema } from "@commonfabric/runner/schemas";
import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";

export type SliderOrientation = "horizontal" | "vertical";

/** A person's move, which is announced; a call from code is not. */
type Gesture = "drag" | "key";

/**
 * CFSlider - Range input slider for value selection
 *
 * @element cf-slider
 *
 * @prop {number|CellHandle<number>} value - Current slider value. Bound to a
 *   cell (`$value` in a pattern), a move writes the cell and the slider follows
 *   the cell; a plain number (or the `value` attribute) is the slider's own
 *   state.
 * @attr {number} min - Minimum allowed value (default: 0)
 * @attr {number} max - Maximum allowed value (default: 100)
 * @attr {number} step - Value increment/decrement step (default: 1)
 * @attr {boolean} disabled - Whether the slider is disabled
 * @attr {SliderOrientation} orientation - Slider orientation ("horizontal" | "vertical")
 *
 * @fires cf-change - Fired when a person moves the value, after the move is
 *   written, with detail: { value, oldValue }. A call from code
 *   (`setValue`, `increment`, `decrement`) fires nothing.
 * @fires cf-input - Fired with cf-change for a move made while dragging
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

  declare value: CellHandle<number | undefined> | number | undefined;
  declare min: number;
  declare max: number;
  declare step: number;
  declare disabled: boolean;
  declare orientation: SliderOrientation;

  // Immediate: a move is announced only once its write is made.
  // `undefined` is a cell holding nothing, which a move may leave so.
  private _valueCellController = createCellController<number | undefined>(
    this,
    {
      timing: { strategy: "immediate" },
    },
  );

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
   * What the slider holds: the bound cell's value, or the plain property,
   * read directly so a move made in this tick is seen by the next one. It may
   * lie out of bounds; `undefined` is a cell holding nothing.
   */
  private get _held(): number | undefined {
    const value = this._valueCellController.hasCell()
      ? this._valueCellController.getValue()
      : this.value;
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }

  /** The value shown. */
  private get _current(): number {
    return this._shown(this._held);
  }

  /** Whether `_held` is known: a plain value, or a cell the worker has read. */
  private get _known(): boolean {
    const cell = this._valueCellController.getCell();
    return cell === null || !("unread" in cell.lastRead());
  }

  /**
   * Moves run in the order they were made. A step on a cell not yet read
   * waits for the worker; while one waits, later moves queue behind it.
   */
  private _queue: Promise<void> | undefined;

  private _inOrder(move: () => Promise<void> | void): void {
    const run = this._queue ? this._queue.then(move) : move();
    if (run === undefined) return;
    const queued: Promise<void> = run.then(() => {
      if (this._queue === queued) this._queue = undefined;
    });
    this._queue = queued;
  }

  /**
   * Move to `value`: a drag, Home or End, or `setValue`. A move to where the
   * slider already holds writes nothing; on a cell not yet read that is not
   * known, so the move is written.
   */
  private _moveTo(
    value: number,
    gesture: Gesture | undefined,
    snap = true,
  ): void {
    this._inOrder(() => {
      const held = this._held;
      const next = this._clampValue(snap ? this._snapToStep(value) : value);
      if (this._known && next === (held ?? this._shown(held))) return;
      if (this._valueCellController.hasCell()) {
        if (this._valueCellController.refusal !== undefined) return;
        this._valueCellController.setValue(next);
      } else {
        this.value = next;
      }
      if (gesture) this._announce(next, held ?? this._shown(held), gesture);
    });
  }

  /**
   * Move by what `step` makes of the shown value: an arrow or page key, or
   * `increment`/`decrement`. On a cell not yet read the controller asks the
   * worker first, so a step is never taken from the minimum shown meanwhile.
   * A step that leaves the value where it is writes nothing.
   */
  private _moveBy(
    step: (current: number) => number,
    gesture: Gesture | undefined,
  ): void {
    this._inOrder(() => {
      if (!this._valueCellController.hasCell()) {
        const held = this._held;
        const next = step(this._shown(held));
        if (next === (held ?? this._shown(held))) return;
        this.value = next;
        if (gesture) this._announce(next, held ?? this._shown(held), gesture);
        return;
      }
      let written: { value: number; oldValue: number } | undefined;
      const announce = () => {
        if (written && gesture) {
          this._announce(written.value, written.oldValue, gesture);
        }
      };
      const settled = this._valueCellController.updateValue((held) => {
        const value = step(this._shown(held));
        // Unchanged, empty cell included: nothing is written.
        if (value === (held ?? this._shown(held))) return held;
        written = { value, oldValue: held ?? this._shown(held) };
        return value;
      });
      // A cell already read is written now, and announced now; one the
      // worker is still answering for is announced once its write is made.
      if (written) {
        announce();
        return;
      }
      return settled.then(announce);
    });
  }

  /** `cf-input` for a move made while dragging, and `cf-change` for any gesture. */
  private _announce(value: number, oldValue: number, gesture: Gesture): void {
    if (gesture === "drag") this.emit("cf-input", { value, oldValue });
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
    if (!(this.step > 0)) return value;
    const steps = Math.round((value - this.min) / this.step);
    // Rounded to drop binary-fraction noise: 3 steps of 0.1 are 0.3.
    return Number((this.min + steps * this.step).toFixed(10));
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
    this._moveTo(newValue, "drag");
  }

  private _handleKeyDown = (event: KeyboardEvent): void => {
    if (this.disabled) return;

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      // To the very end, as the ARIA slider pattern has it, even off the step.
      this._moveTo(event.key === "Home" ? this.min : this.max, "key", false);
      return;
    }
    const bigStep = this.step * 10;
    const deltas: Record<string, number> = {
      ArrowLeft: -this.step,
      ArrowDown: -this.step,
      ArrowRight: this.step,
      ArrowUp: this.step,
      PageDown: -bigStep,
      PageUp: bigStep,
    };
    const delta = deltas[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    this._moveBy((current) => this._clampValue(current + delta), "key");
  };

  /**
   * Set the slider value programmatically
   */
  setValue(value: number): void {
    this._moveTo(value, undefined);
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
    this._moveBy(
      (current) => this._clampValue(this._snapToStep(current + this.step)),
      undefined,
    );
  }

  /**
   * Decrement the slider value by one step
   */
  decrement(): void {
    this._moveBy(
      (current) => this._clampValue(this._snapToStep(current - this.step)),
      undefined,
    );
  }
}
