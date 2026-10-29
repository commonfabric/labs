/**
 * Fixture: console.error in a computed handler with NO allowConsoleErrors flag.
 * The test runner must fail this even though the assertion passes.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const triggered = new Writable(false);
  const didTrigger = assert(() => triggered.get());

  const triggerError = action(() => {
    console.error("intentional-test-error: this should fail the test");
    triggered.set(true);
  });

  return {
    [TESTS]: [
      { action: triggerError },
      { assertion: didTrigger },
    ],
  };
});
