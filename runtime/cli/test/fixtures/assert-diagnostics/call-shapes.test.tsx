/**
 * Failing assertions whose operands sit in call positions that recording has
 * to leave alone or reach past: a spread argument, and a receiver whose
 * arguments say nothing. Run by assert-diagnostics.test.ts, which expects the
 * failures; it is not a pattern under test.
 */

import { assert, cell, pattern, TESTS } from "commonfabric";

function allPositive(...values: number[]): boolean {
  return values.every((value) => value > 0);
}

export default pattern(() => {
  const nums = cell<number[]>([1, -2, 3]);

  return {
    [TESTS]: [
      // Fails: -2 is not positive. Recording the spread would pass only the
      // first element and turn this into `allPositive(1)`, which is true.
      { assertion: assert(() => allPositive(...nums.get())) },
      // Fails: -2 is not positive. The callback says nothing, so the value
      // worth reporting is the receiver.
      { assertion: assert(() => nums.get().every((value) => value > 0)) },
      // Fails: the literal argument says nothing, so again the receiver is
      // what gets reported.
      { assertion: assert(() => nums.get().includes(99)) },
    ],
    nums,
  };
});
