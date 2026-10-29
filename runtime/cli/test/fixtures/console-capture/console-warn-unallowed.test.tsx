/**
 * Fixture: console.warn in a computed handler with NO allowConsoleWarnings flag.
 * The test runner must fail this even though the assertion passes.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const triggered = new Writable(false);
  const didTrigger = assert(() => triggered.get());

  const triggerWarn = action(() => {
    console.warn("intentional-test-warning: this should fail the test");
    triggered.set(true);
  });

  return {
    [TESTS]: [
      { action: triggerWarn },
      { assertion: didTrigger },
    ],
  };
});
