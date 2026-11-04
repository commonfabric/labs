/**
 * Counts a number up and down by a configurable step, stopping at optional
 * minimum and maximum bounds, and resets it to zero. Exposes the current
 * value alongside increment, decrement and reset streams.
 *
 * Embed it as `<Counter value={myCell} step={5} label="Score" />` and it
 * mutates the host's own cell: the host wires nothing, because passing the
 * cell is the wiring. Run it standalone and it counts its own default.
 *
 * This atom is also the pattern index's measurement control. "Build me a
 * counter" is the task the loop's before/after numbers are anchored on, so the
 * corpus holds a counter that takes real inputs rather than only whole counter
 * applications that take none.
 *
 * @hashtags counter, increment, decrement, number, stepper, tally
 * @keywords count, counting, increment, decrement, plus, minus, step, tally,
 * score, quantity, bump, up down, numeric input
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface CounterInput {
  /** The number being counted. A host passes its own cell to share it. */
  value?: Writable<number | Default<0>>;

  /** How much one increment or decrement moves `value`. */
  step?: Writable<number | Default<1>>;

  /** Heading shown above the number. */
  label?: Writable<string | Default<"Count">>;

  /** Lowest value the buttons will reach. `null` leaves it unbounded. */
  min?: Writable<number | null | Default<null>>;

  /** Highest value the buttons will reach. `null` leaves it unbounded. */
  max?: Writable<number | null | Default<null>>;
}

export interface CounterOutput {
  [NAME]: string;
  [UI]: VNode;
  value: number;
  atMin: boolean;
  atMax: boolean;
  increment: Stream<void>;
  decrement: Stream<void>;
  reset: Stream<void>;
}

/** `value` moved by `delta` and held inside whichever bounds are set. */
const clamp = (
  value: number,
  min: number | null,
  max: number | null,
): number => {
  if (min !== null && value < min) return min;
  if (max !== null && value > max) return max;
  return value;
};

export const Counter = pattern<CounterInput, CounterOutput>(
  ({ value, step, label, min, max }) => {
    const increment = action(() => {
      value.set(
        clamp((value.get() ?? 0) + (step.get() ?? 1), min.get(), max.get()),
      );
    });
    const decrement = action(() => {
      value.set(
        clamp((value.get() ?? 0) - (step.get() ?? 1), min.get(), max.get()),
      );
    });
    const reset = action(() => {
      value.set(clamp(0, min.get(), max.get()));
    });

    const atMin = computed(() => {
      const floor = min.get();
      return floor !== null && (value.get() ?? 0) <= floor;
    });
    const atMax = computed(() => {
      const ceiling = max.get();
      return ceiling !== null && (value.get() ?? 0) >= ceiling;
    });

    return {
      [NAME]: computed(() => `${label.get()}: ${value.get() ?? 0}`),
      [UI]: (
        <cf-vstack gap="2" align="center" padding="3">
          <cf-text tone="muted">{label}</cf-text>
          <div
            style={{
              fontSize: "2.5rem",
              fontWeight: "bold",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {value}
          </div>
          <cf-hstack gap="2">
            <cf-button
              variant="secondary"
              disabled={atMin}
              onClick={decrement}
            >
              −
            </cf-button>
            <cf-button
              variant="ghost"
              color="neutral"
              onClick={reset}
            >
              Reset
            </cf-button>
            <cf-button
              variant="primary"
              disabled={atMax}
              onClick={increment}
            >
              +
            </cf-button>
          </cf-hstack>
        </cf-vstack>
      ),
      value,
      atMin,
      atMax,
      increment,
      decrement,
      reset,
    };
  },
);

export default Counter;
