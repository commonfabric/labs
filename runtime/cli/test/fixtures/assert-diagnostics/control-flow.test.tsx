/**
 * Failing assertions built from short-circuit and conditional operators, so
 * the runner's rendering of them can be checked. Run by
 * assert-diagnostics.test.ts, which expects the failures; it is not a pattern
 * under test.
 */

import { assert, cell, pattern, TESTS } from "commonfabric";

export default pattern(() => {
  const a = cell<number>(-1);
  const b = cell<number>(20);

  return {
    [TESTS]: [
      // Fails on the left conjunct, so the right one never evaluates.
      { assertion: assert(() => a.get() > 0 && b.get() < 10) },
      // Both disjuncts evaluate, and both are false.
      { assertion: assert(() => a.get() > 0 || b.get() < 10) },
      // Only the taken branch evaluates.
      { assertion: assert(() => (a.get() > 0 ? b.get() : a.get()) === 5) },
    ],
    a,
    b,
  };
});
