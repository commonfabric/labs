/**
 * Fixture: expectRuntimeErrors: true but nothing throws.
 * The expectation asserts the loudness FIRES — zero errors must fail the run,
 * so a rejection quietly reverting to a silent return cannot pass.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const fine = new Writable(true);
  const stillFine = assert(() => fine.get());

  const silentAction = action(() => {
    // Deliberately does not throw.
  });

  return {
    [TESTS]: [
      { action: silentAction },
      { assertion: stillFine },
    ],
    expectRuntimeErrors: true,
  };
});
