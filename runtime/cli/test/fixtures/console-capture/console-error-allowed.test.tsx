/**
 * Fixture: console.error with allowConsoleErrors: true.
 * The test runner must NOT fail this despite the error.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const triggered = new Writable(false);
  const didTrigger = assert(() => triggered.get());

  const triggerError = action(() => {
    console.error("intentional-test-error: allowed by flag");
    triggered.set(true);
  });

  return {
    [TESTS]: [
      { action: triggerError },
      { assertion: didTrigger },
    ],
    allowConsoleErrors: true,
  };
});
