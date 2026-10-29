/**
 * Fixture: expectRuntimeErrors is `1.5`, which is not an expectation, and
 * nothing throws. A malformed expectation must fail the run rather than be
 * read as none, or the test passes without the errors it meant to require.
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
    expectRuntimeErrors: 1.5,
  };
});
