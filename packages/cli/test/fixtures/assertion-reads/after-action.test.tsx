/**
 * Fixture for the two verdicts an assertion after an action can reach. The
 * action leaves the counter at one, so the first assertion holds and the
 * second does not. The test that runs it counts how many times the runner read
 * each of them.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const count = new Writable(0);
  const increment = action(() => count.set(count.get() + 1));
  const reachedOne = assert(() => count.get() === 1);
  const reachedTwo = assert(() => count.get() === 2);

  return {
    [TESTS]: [
      { action: increment },
      { assertion: reachedOne },
      { assertion: reachedTwo },
    ],
  };
});
