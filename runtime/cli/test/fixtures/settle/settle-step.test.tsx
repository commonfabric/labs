/**
 * Fixture for the `{ settle: true }` test step. Exercises the runner's settle
 * handling — a full `runtime.settled()` between steps — plus a skipped settle
 * step. The settle step is transparent: it produces no assertion result and the
 * run passes.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const flag = new Writable(false);
  const setFlag = action(() => flag.set(true));
  const isSet = assert(() => flag.get() === true);

  return {
    [TESTS]: [
      { action: setFlag },
      // Full settle between the action and the assertion.
      { settle: true },
      { assertion: isSet },
      // A skipped settle step is a no-op.
      { settle: true, skip: true },
    ],
  };
});
