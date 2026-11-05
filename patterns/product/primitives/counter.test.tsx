/**
 * Tests Counter: the step, the bounds, and what the bounds report.
 *
 * Run: deno task cf test patterns/product/primitives/counter.test.tsx
 */
import { action, assert, NAME, pattern, TESTS } from "commonfabric";
import Counter from "./counter.tsx";

export default pattern(() => {
  const plain = Counter({});
  const bounded = Counter({ value: 5, step: 5, min: 0, max: 10 });

  const increment = action(() => plain.increment.send());
  const decrement = action(() => plain.decrement.send());
  const reset = action(() => plain.reset.send());

  const stepUp = action(() => bounded.increment.send());
  const stepDown = action(() => bounded.decrement.send());

  return {
    [TESTS]: [
      { assertion: assert(() => plain.value === 0) },
      // A counter with no bounds is at neither of them.
      { assertion: assert(() => plain.atMin === false) },
      { assertion: assert(() => plain.atMax === false) },

      { action: increment },
      { assertion: assert(() => plain.value === 1) },
      { action: decrement },
      { action: decrement },
      // Unbounded below, so it passes zero rather than stopping there.
      { assertion: assert(() => plain.value === -1) },
      { action: reset },
      { assertion: assert(() => plain.value === 0) },

      // The step is the input's, not one.
      { assertion: assert(() => bounded.value === 5) },
      { action: stepUp },
      { assertion: assert(() => bounded.value === 10) },
      { assertion: assert(() => bounded.atMax === true) },
      // Already at the ceiling: a further step holds rather than exceeding it.
      { action: stepUp },
      { assertion: assert(() => bounded.value === 10) },
      { action: stepDown },
      { action: stepDown },
      { assertion: assert(() => bounded.value === 0) },
      { assertion: assert(() => bounded.atMin === true) },
      { action: stepDown },
      { assertion: assert(() => bounded.value === 0) },

      // The name a piece list shows, which carries the label and the value.
      { assertion: assert(() => plain[NAME] === "Count: 0") },
      { assertion: assert(() => bounded[NAME] === "Count: 0") },
    ],
  };
});
