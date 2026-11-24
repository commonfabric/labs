import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
  type Writable,
} from "commonfabric";

interface RangeSliderArgs {
  min: Default<number, 0>;
  max: Default<number, 100>;
  value: Default<number, 50>;
  step: Default<number, 5>;
}

interface SliderSnapshot {
  interaction: number;
  value: number;
  percentage: number;
}

const toFiniteNumber = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return input;
};

const clampNumber = (value: number, minValue: number, maxValue: number) => {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
};

const normalizePercentage = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return clampNumber(value / 100, 0, 1);
  return clampNumber(value, 0, 1);
};

const computePercentage = (
  value: number,
  minValue: number,
  maxValue: number,
) => {
  const span = maxValue - minValue;
  if (!Number.isFinite(span) || span <= 0) return 0;
  const ratio = clampNumber((value - minValue) / span, 0, 1);
  const percent = ratio * 100;
  return Math.round(percent * 10) / 10;
};

const sanitizeSnapshots = (entries: SliderSnapshot[] | undefined) => {
  if (!Array.isArray(entries)) return [] as SliderSnapshot[];
  return entries.map((entry) => ({
    interaction: toFiniteNumber(entry?.interaction, 0),
    value: toFiniteNumber(entry?.value, 0),
    percentage: toFiniteNumber(entry?.percentage, 0),
  }));
};

const applySliderUpdate = (
  context: {
    value: Cell<number>;
    min: Cell<number>;
    max: Cell<number>;
    interactions: Cell<number>;
    history: Cell<SliderSnapshot[]>;
  },
  desired: number,
) => {
  const rawMin = context.min.get();
  const rawMax = context.max.get();
  const minValue = toFiniteNumber(rawMin, 0);
  const maxCandidate = toFiniteNumber(rawMax, minValue + 100);
  const maxValue = maxCandidate > minValue ? maxCandidate : minValue + 100;
  const next = clampNumber(
    toFiniteNumber(desired, minValue),
    minValue,
    maxValue,
  );

  context.value.set(next);

  const counter = toFiniteNumber(context.interactions.get(), 0) + 1;
  context.interactions.set(counter);
  const percentage = computePercentage(next, minValue, maxValue);
  const snapshot: SliderSnapshot = {
    interaction: counter,
    value: next,
    percentage,
  };

  const existing = context.history.get();
  const list = Array.isArray(existing) ? existing.slice() : [];
  list.push(snapshot);
  context.history.set(list);
};

const setSliderValue = handler(
  (
    event: { value?: number; percentage?: number } | undefined,
    context: {
      value: Cell<number>;
      min: Cell<number>;
      max: Cell<number>;
      interactions: Cell<number>;
      history: Cell<SliderSnapshot[]>;
    },
  ) => {
    const rawMin = context.min.get();
    const rawMax = context.max.get();
    const minValue = toFiniteNumber(rawMin, 0);
    const maxCandidate = toFiniteNumber(rawMax, minValue + 100);
    const maxValue = maxCandidate > minValue ? maxCandidate : minValue + 100;

    if (typeof event?.value === "number") {
      applySliderUpdate(context, event.value);
      return;
    }
    if (typeof event?.percentage === "number") {
      const ratio = normalizePercentage(event.percentage);
      const desired = minValue + (maxValue - minValue) * ratio;
      applySliderUpdate(context, desired);
      return;
    }

    const current = toFiniteNumber(context.value.get(), minValue);
    applySliderUpdate(context, current);
  },
);

const nudgeSlider = handler(
  (
    event: { direction?: "increase" | "decrease"; ticks?: number } | undefined,
    context: {
      value: Cell<number>;
      min: Cell<number>;
      max: Cell<number>;
      step: Cell<number>;
      interactions: Cell<number>;
      history: Cell<SliderSnapshot[]>;
    },
  ) => {
    const direction = event?.direction === "decrease" ? -1 : 1;
    const ticks = typeof event?.ticks === "number"
      ? Math.max(1, Math.abs(Math.trunc(event.ticks)))
      : 1;
    const rawStep = context.step.get();
    const baseStep = toFiniteNumber(rawStep, 1);
    const stepSize = baseStep > 0 ? baseStep : 1;

    const current = toFiniteNumber(context.value.get(), 0);
    const desired = current + stepSize * ticks * direction;
    applySliderUpdate(context, desired);
  },
);

const liftSliderState = lift<
  { min: Writable<number>; max: Writable<number>; value: Writable<number> }
>(({ min, max, value }) => {
  const rawMin = min.get();
  const rawMax = max.get();
  const minValue = toFiniteNumber(rawMin, 0);
  const maxCandidate = toFiniteNumber(rawMax, minValue + 100);
  const maxValue = maxCandidate > minValue ? maxCandidate : minValue + 100;
  const current = clampNumber(
    toFiniteNumber(value.get(), minValue),
    minValue,
    maxValue,
  );
  const span = maxValue - minValue;
  return {
    min: minValue,
    max: maxValue,
    span: span > 0 ? span : 1,
    value: current,
  };
});

const liftStepSize = lift((raw: number | undefined) => {
  const normalized = toFiniteNumber(raw, 1);
  return normalized > 0 ? normalized : 1;
});

const liftInteractionCount = lift((count: number | undefined) =>
  toFiniteNumber(count, 0)
);

const liftSanitizeSnapshots = lift(sanitizeSnapshots);

export const counterRangeSliderSimulation = pattern<RangeSliderArgs>(
  ({ min, max, value, step }) => {
    const interactions = cell(0);
    const history = cell<SliderSnapshot[]>([]);

    const sliderState = liftSliderState({ min, max, value });

    const currentValue = sliderState.value;
    const minView = sliderState.min;
    const maxView = sliderState.max;
    const percentage = computePercentage(
      sliderState.value,
      sliderState.min,
      sliderState.max,
    );

    const stepSize = liftStepSize(step);

    const interactionCount = liftInteractionCount(interactions);
    const historyView = liftSanitizeSnapshots(history);
    const rangeSummary = str`Range ${minView} to ${maxView}`;
    const label = str`Slider at ${currentValue} (${percentage}%)`;

    return {
      min,
      max,
      step: stepSize,
      currentValue,
      percentage,
      label,
      rangeSummary,
      interactions: interactionCount,
      history: historyView,
      controls: {
        setPosition: setSliderValue({
          value,
          min,
          max,
          interactions,
          history,
        }),
        nudge: nudgeSlider({
          value,
          min,
          max,
          step,
          interactions,
          history,
        }),
      },
    };
  },
);

export default counterRangeSliderSimulation;
