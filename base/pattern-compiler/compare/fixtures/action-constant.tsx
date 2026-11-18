/// <cts-enable />
import { action, computed, Default, pattern, Writable } from "commonfabric";

interface CounterInput {
  value: Writable<number | Default<0>>;
  step?: Writable<number | Default<1>>;
  max?: Writable<number | null | Default<null>>;
}

// A pattern that is compiled into its caller and declares each path of
// its argument as a handle. `increment` reads `step` and `max` through
// their handles and writes `value`. `widen` writes `step`.
const Counter = pattern<CounterInput>(({ value, step, max }) => {
  const increment = action(() => {
    const next = value.get() + step.get();
    const limit = max.get();
    value.set(limit === null ? next : Math.min(limit, next));
  });
  const widen = action(() => {
    step.set(step.get() + 1);
  });
  return { increment, widen, stepNow: computed(() => step.get()) };
});

// The call writes `step` as a literal and leaves `max` out, so each is a
// constant at a position of handle type: a handle that reads the
// constant, and a write through it is refused. `value` is bound to an
// input.
export default pattern<{ score: Writable<number> }>(({ score }) => {
  const counter = Counter({ value: score, step: 5 });
  return {
    score,
    stepNow: counter.stepNow,
    increment: counter.increment,
    widen: counter.widen,
  };
});
