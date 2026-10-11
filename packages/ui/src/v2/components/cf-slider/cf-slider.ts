import { css, html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { createRef, ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { type CellHandle, isCellHandle } from "@commonfabric/runtime-client";
import { numberSchema } from "@commonfabric/runner/schemas";
import { BaseElement } from "../../core/base-element.ts";
import {
  createCellController,
  sameCellDoc,
} from "../../core/cell-controller.ts";

export type SliderOrientation = "horizontal" | "vertical";

/** A person's move, which is announced; a call from code is not. */
type Gesture = "drag" | "key";

/** Stops a key moves: one for an arrow, ten for a page key. */
const KEY_STOPS: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowDown: -1,
  ArrowRight: 1,
  ArrowUp: 1,
  PageDown: -10,
  PageUp: 10,
};

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
 * Values land on stops: `min`, each `step` above it, and `max`. Mouse, touch
 * and pen drag alike, each pointer captured until it is released.
 *
 * @fires cf-input - Fired for every move a person makes, once it is written,
 *   with detail: { value, oldValue }
 * @fires cf-change - Fired when a person commits a move: a key press at once,
 *   a drag when it is released (if it wrote a value), with detail:
 *   { value, oldValue }: for a drag, the value it last wrote and the value
 *   shown when it began. A key pressed mid-drag is part of the drag.
 *   A call from code (`setValue`, `increment`, `decrement`) fires neither.
 *
 * @example
 * <cf-slider min="0" max="100" value="50"></cf-slider>
 * <cf-slider min="0" max="100" value="25" step="5"></cf-slider>
 * <cf-slider orientation="vertical" style="height: 200px"></cf-slider>
 */
export class CFSlider extends BaseElement {
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

    :host(:not([disabled]):focus-visible) .thumb {
      outline: 2px solid transparent;
      outline-offset: 2px;
      box-shadow:
        0 0 0 2px var(--cf-slider-color-background),
        0 0 0 4px var(--cf-slider-color-ring);
    }

    /* Dragging state */
    .slider.dragging,
    .slider.dragging .track {
      cursor: grabbing;
    }

    .slider.dragging .thumb {
      cursor: grabbing;
      transform: translate(-50%, -50%) scale(1.1);
    }

    .slider.vertical.dragging .thumb {
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

  /** The value: a plain number, or a cell bound with `$value`. */
  @property({ type: Number })
  accessor value: CellHandle<number | undefined> | number | undefined = 50;

  @property({ type: Number })
  accessor min = 0;

  @property({ type: Number })
  accessor max = 100;

  @property({ type: Number })
  accessor step = 1;

  @property({ type: Boolean, reflect: true })
  accessor disabled = false;

  @property({ type: String, reflect: true })
  accessor orientation: SliderOrientation = "horizontal";

  // Immediate: a move is announced only once its write is made.
  // `undefined` is a cell holding nothing, which a move may leave so.
  #controller = createCellController<number | undefined>(this, {
    timing: { strategy: "immediate" },
  });

  #track = createRef<HTMLDivElement>();

  /** The pointer dragging the slider, captured until it is released. */
  #pointer: number | undefined;

  /**
   * Moves run in the order they were made. The cell puts their writes in
   * order itself; this queue keeps what the slider does around them, its
   * announcements and a drag's start and commit, in that order too. A step
   * on a cell not yet read waits for the worker; while one waits, later moves
   * queue behind it. A move belongs to the binding it was made on: binding
   * `value` anew drops the queue, so no move made for one cell reaches
   * another, and a read the old cell never answers holds nothing up.
   */
  #queue: Promise<void> | undefined;
  #binding = 0;

  /**
   * The drag under way, until it is released: the value shown when it
   * began, whether that value was known (read) then, and the last value the
   * drag itself wrote. What other writers do meanwhile is not the drag's.
   */
  #drag: { from: number; known: boolean; to?: number } | undefined;

  /**
   * Gestures without a browser: key presses, and a drag by value rather
   * than by pointer position; whether a drag is under way; and the update
   * Lit runs when the named properties change, which an element never
   * connected does not run on its own.
   */
  get accessForTestingOnly(): {
    press(key: string): void;
    beginDrag(): void;
    dragTo(value: number): void;
    endDrag(): void;
    readonly dragging: boolean;
    update(changed: Readonly<Record<string, unknown>>): void;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      press: (key) => this.#press(key),
      update: (changed) => {
        const properties = new Map(Object.entries(changed));
        this.willUpdate(properties);
        this.updated(properties);
      },
      beginDrag: () => this.#beginDrag(-1),
      dragTo: (value) => this.#moveTo(value, "drag"),
      endDrag: () => this.#endDrag(true),
      get dragging() {
        return outerThis.#pointer !== undefined;
      },
    };
  }

  constructor() {
    super();
    this.addEventListener("keydown", (event) => {
      if (this.#press(event.key)) event.preventDefault();
    });
  }

  override connectedCallback() {
    if (!this.hasAttribute("role")) {
      this.setAttribute("role", "slider");
    }
    if (!this.hasAttribute("exportparts")) {
      this.setAttribute("exportparts", "base,track,range,thumb");
    }
    super.connectedCallback();
    this.#controller.bind(this.value, numberSchema);
    // A plain value is the slider's own, so it is brought within bounds here.
    // A cell's value belongs to the cell: it is shown clamped, never rewritten.
    if (!this.#controller.hasCell()) {
      this.value = this.#snap(this.#current);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // A removed slider commits nothing, as a removed native input fires no
    // change, and the moves still queued go with it, as on a new binding.
    this.#forgetMoves();
  }

  protected override willUpdate(changed: PropertyValues) {
    super.willUpdate(changed);
    if (changed.has("value")) {
      if (!this.#sameBinding(changed.get("value"), this.value)) {
        // A drag on one cell neither commits to another nor goes on there.
        this.#forgetMoves();
      }
      this.#controller.bind(this.value, numberSchema);
    }
  }

  protected override updated(changed: PropertyValues) {
    super.updated(changed);
    if (
      !this.#controller.hasCell() &&
      (changed.has("min") || changed.has("max") || changed.has("step"))
    ) {
      // A plain value follows its bounds.
      const snapped = this.#snap(this.#current);
      if (snapped !== this.value) this.value = snapped;
    }
    // A bound cell's value arrives without any property changing, so ARIA
    // state follows every update rather than named ones.
    this.setAttribute("aria-valuemin", String(this.min));
    this.setAttribute("aria-valuemax", String(this.max));
    this.setAttribute("aria-valuenow", String(this.#current));
    this.setAttribute("aria-disabled", String(this.disabled));
    this.setAttribute("aria-orientation", this.orientation);
    this.tabIndex = this.disabled ? -1 : 0;
  }

  override render() {
    const percent = `${this.getPercentageValue()}%`;
    const vertical = this.orientation === "vertical";
    return html`
      <div
        class="${classMap({
          slider: true,
          [this.orientation]: true,
          disabled: this.disabled,
          dragging: this.#pointer !== undefined,
        })}"
        part="base"
        @pointerdown="${this.#onPointerDown}"
        @pointermove="${this.#onPointerMove}"
        @pointerup="${this.#onPointerUp}"
        @pointercancel="${this.#onPointerUp}"
        @lostpointercapture="${this.#onPointerUp}"
      >
        <div class="track" part="track" ${ref(this.#track)}>
          <div
            class="range"
            part="range"
            style="${styleMap(
              vertical ? { height: percent } : { width: percent },
            )}"
          ></div>
          <div
            class="thumb"
            part="thumb"
            role="presentation"
            style="${styleMap(
              vertical ? { bottom: percent } : { left: percent },
            )}"
          ></div>
        </div>
      </div>
    `;
  }

  /** Set the value from code, which fires no event. */
  setValue(value: number): void {
    if (!Number.isFinite(value)) {
      throw new RangeError(
        `cf-slider: setValue needs a finite number, got ${value}`,
      );
    }
    this.#moveTo(value, undefined);
  }

  /** Where the shown value sits between `min` and `max`, from 0 to 100. */
  getPercentageValue(): number {
    const range = this.max - this.min;
    return range > 0 ? ((this.#current - this.min) / range) * 100 : 0;
  }

  /** Move up one stop from code, which fires no event. */
  increment(): void {
    this.#moveBy((current) => this.#stopFrom(current, 1), undefined);
  }

  /** Move down one stop from code, which fires no event. */
  decrement(): void {
    this.#moveBy((current) => this.#stopFrom(current, -1), undefined);
  }

  /**
   * Whether `next` continues the binding `old` was: a fresh handle for the
   * same persistent cell, which the controller also keeps, or a plain value
   * followed by another, whether the slider's own move or its owner's (a
   * controlled slider echoing its moves back). Switching between a cell and
   * a plain value, or to another cell, is a new binding.
   */
  #sameBinding(old: unknown, next: unknown): boolean {
    if (isCellHandle(old) && isCellHandle(next)) {
      return sameCellDoc(old.ref(), next.ref());
    }
    return !isCellHandle(old) && !isCellHandle(next);
  }

  /** Drop the queued moves and any drag, which then commits nothing. */
  #forgetMoves(): void {
    this.#binding++;
    this.#queue = undefined;
    this.#drag = undefined;
    this.#endDrag(false);
  }

  /** `value` as the slider shows it: within bounds, the minimum if unset. */
  #shown(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
      ? this.#clamp(value)
      : this.min;
  }

  /**
   * What the slider holds: the bound cell's value, or the plain property,
   * read directly so a move made in this tick is seen by the next one. It may
   * lie out of bounds; `undefined` is a cell holding nothing.
   */
  get #held(): number | undefined {
    const value = this.#controller.hasCell()
      ? this.#controller.getValue()
      : this.value;
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }

  /** The value shown. */
  get #current(): number {
    return this.#shown(this.#held);
  }

  /** Whether `#held` is known: a plain value, or a cell the worker has read. */
  get #known(): boolean {
    const cell = this.#controller.getCell();
    return cell === null || !("unread" in cell.lastRead());
  }

  #inOrder(move: () => Promise<void> | void): void {
    if (this.#queue === undefined) {
      this.#enqueue(move());
      return;
    }
    const binding = this.#binding;
    const onBinding = () => {
      if (binding === this.#binding) return move();
    };
    // A move that failed is reported, and the queue goes on without it.
    this.#enqueue(this.#queue.then(onBinding, (error) => {
      reportError(error);
      return onBinding();
    }));
  }

  #enqueue(run: Promise<void> | void): void {
    if (run === undefined) return;
    const queued: Promise<void> = run.finally(() => {
      if (this.#queue === queued) this.#queue = undefined;
    });
    this.#queue = queued;
  }

  /**
   * Move to `value`: a drag, Home or End, or `setValue`. A move to where the
   * slider already holds writes nothing; on a cell not yet read that is not
   * known, so the move is written.
   */
  #moveTo(value: number, gesture: Gesture | undefined): void {
    this.#inOrder(() => {
      const held = this.#held;
      const next = this.#snap(value);
      // A place was chosen: an empty cell gets it, even the minimum shown.
      if (this.#known && next === held) return;
      if (this.#controller.hasCell()) {
        if (this.#controller.refusal !== undefined) return;
        this.#controller.setValue(next);
      } else {
        this.value = next;
      }
      this.#moved(next, held ?? this.#shown(held), gesture);
    });
  }

  /**
   * Move by what `step` makes of the shown value: an arrow or page key, or
   * `increment`/`decrement`. On a cell not yet read the controller asks the
   * worker first, so a step is never taken from the minimum shown meanwhile.
   * A step that leaves the value where it is writes nothing.
   */
  #moveBy(
    step: (current: number) => number,
    gesture: Gesture | undefined,
  ): void {
    this.#inOrder(() => {
      if (!this.#controller.hasCell()) {
        const held = this.#held;
        const next = step(this.#shown(held));
        if (next === (held ?? this.#shown(held))) return;
        this.value = next;
        this.#moved(next, held ?? this.#shown(held), gesture);
        return;
      }
      // A step still waiting on the worker when the slider is removed or
      // bound anew belongs to the old binding: it writes and announces nothing.
      const binding = this.#binding;
      let written: { value: number; oldValue: number } | undefined;
      const announce = () => {
        if (written && binding === this.#binding) {
          this.#moved(written.value, written.oldValue, gesture);
        }
      };
      const settled = this.#controller.updateValue((held) => {
        if (binding !== this.#binding) return held;
        const value = step(this.#shown(held));
        // Unchanged, empty cell included: nothing is written.
        if (value === (held ?? this.#shown(held))) return held;
        written = { value, oldValue: held ?? this.#shown(held) };
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

  /** A move a person made has been written: report it. */
  #moved(value: number, oldValue: number, gesture: Gesture | undefined): void {
    if (gesture === undefined) return;
    if (gesture === "drag" && this.#drag) this.#drag.to = value;
    this.emit("cf-input", { value, oldValue });
    // A key press commits at once; a drag commits when it is released.
    if (gesture === "key") this.emit("cf-change", { value, oldValue });
  }

  /** Handle a key; whether it was the slider's. */
  #press(key: string): boolean {
    if (this.disabled) return false;
    // A key pressed mid-drag is part of the drag.
    const gesture: Gesture = this.#pointer === undefined ? "key" : "drag";
    if (key === "Home" || key === "End") {
      this.#moveTo(key === "Home" ? this.min : this.max, gesture);
      return true;
    }
    const count = KEY_STOPS[key];
    if (count === undefined) return false;
    this.#moveBy((current) => this.#stopFrom(current, count), gesture);
    return true;
  }

  /** Begin a drag by `pointer`, or keep the one under way. */
  #beginDrag(pointer: number): void {
    if (this.#pointer !== undefined) return;
    this.#pointer = pointer;
    this.requestUpdate();
    // In order, so a step still waiting on the worker lands first.
    this.#inOrder(() => {
      this.#drag ??= { from: this.#current, known: this.#known };
    });
  }

  /**
   * End the drag under way. `commit` sends one `cf-change` for what it wrote;
   * a drag ended by a new binding or removal commits nothing.
   */
  #endDrag(commit: boolean): void {
    const pointer = this.#pointer;
    if (pointer === undefined) return;
    this.#pointer = undefined;
    this.requestUpdate();
    if (this.#track.value?.hasPointerCapture(pointer)) {
      this.#track.value.releasePointerCapture(pointer);
    }
    if (!commit) return;
    this.#inOrder(() => {
      const drag = this.#drag;
      this.#drag = undefined;
      if (drag?.to === undefined) return;
      // From a value not yet read, any write is a change.
      if (drag.known && drag.to === drag.from) return;
      this.emit("cf-change", { value: drag.to, oldValue: drag.from });
    });
  }

  #onPointerDown = (event: PointerEvent): void => {
    const track = this.#track.value;
    // One pointer drags: a second finger, or a second button, is ignored, as
    // on a native range.
    if (
      this.disabled || event.button !== 0 || !event.isPrimary ||
      this.#pointer !== undefined || track === undefined
    ) return;
    event.preventDefault();
    // Focused for the keys that follow, without scrolling the press away from
    // where it landed, and without a focus ring for a pointer.
    this.focus({ preventScroll: true, focusVisible: false });
    track.setPointerCapture(event.pointerId);
    this.#beginDrag(event.pointerId);
    // Pressing the track moves there; grabbing the thumb keeps its value.
    const onThumb = event.composedPath().some((target) =>
      target instanceof Element && target.classList.contains("thumb")
    );
    if (!onThumb) this.#moveToPointer(event);
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointer || this.disabled) return;
    this.#moveToPointer(event);
  };

  #onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId === this.#pointer) this.#endDrag(true);
  };

  #moveToPointer(event: PointerEvent): void {
    const track = this.#track.value;
    if (track === undefined) return;
    const rect = track.getBoundingClientRect();
    // Vertical sliders put the minimum at the bottom.
    const fraction = this.orientation === "horizontal"
      ? (event.clientX - rect.left) / rect.width
      : 1 - (event.clientY - rect.top) / rect.height;
    const clamped = Math.max(0, Math.min(1, fraction));
    this.#moveTo(this.min + clamped * (this.max - this.min), "drag");
  }

  #clamp(value: number): number {
    return Math.min(Math.max(value, this.min), this.max);
  }

  /** `n` without binary-fraction noise: 3 steps of 0.1 are 0.3. */
  #tidy(n: number): number {
    return Number(n.toPrecision(15));
  }

  /** The step, or 1 where it is not a positive number, as a native range has it. */
  get #stepSize(): number {
    return this.step > 0 && Number.isFinite(this.step) ? this.step : 1;
  }

  /** The highest stop a whole number of steps above `min`. */
  get #lastStep(): number {
    const steps = Math.floor((this.max - this.min) / this.#stepSize + 1e-9);
    return this.#tidy(this.min + Math.max(0, steps) * this.#stepSize);
  }

  /** The stop nearest `value`. */
  #snap(value: number): number {
    const v = this.#clamp(value);
    const last = this.#lastStep;
    if (v >= last) return v - last < this.max - v ? last : this.max;
    return this.#tidy(
      this.min + Math.round((v - this.min) / this.#stepSize) * this.#stepSize,
    );
  }

  /**
   * The stop `count` stops above `value`, or below it when `count` is
   * negative: from a value between stops, the first stop that way.
   */
  #stopFrom(value: number, count: number): number {
    const v = this.#clamp(value);
    const position = (v - this.min) / this.#stepSize;
    const index = count > 0
      ? Math.floor(position + 1e-9) + count
      : Math.ceil(position - 1e-9) + count;
    const stop = this.#tidy(this.min + Math.max(0, index) * this.#stepSize);
    return stop > this.#lastStep ? this.max : stop;
  }
}
