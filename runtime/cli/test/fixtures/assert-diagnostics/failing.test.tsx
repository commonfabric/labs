/**
 * Assertions that fail on purpose, so the runner's rendering of a failed
 * `assert(...)` can be checked. Run by assert-diagnostics.test.ts, which
 * expects the failures; it is not a pattern under test.
 */

import { assert, cell, pattern, TESTS } from "commonfabric";

function inRange(value: number, low: number, high: number): boolean {
  return value >= low && value <= high;
}

export default pattern(() => {
  const a = cell<number>(1);
  const b = cell<number>(2);
  const c = cell<number>(2);

  return {
    [TESTS]: [
      // 1 + 2 is 3, which is not <= 2.
      { assertion: assert(() => a.get() + b.get() <= c.get()) },
      // 5 is outside 2..2.
      { assertion: assert(() => inRange(5, b.get(), c.get())) },
      // Holds: 1 + 2 === 3.
      { assertion: assert(() => a.get() + b.get() === 3) },
    ],
    a,
    b,
    c,
  };
});
