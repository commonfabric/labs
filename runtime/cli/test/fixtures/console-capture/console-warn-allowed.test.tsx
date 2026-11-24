/**
 * Fixture: console.warn with allowConsoleWarnings: true.
 * The test runner must NOT fail this despite the warning.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const triggered = new Writable(false);
  const didTrigger = assert(() => triggered.get());

  const triggerWarn = action(() => {
    console.warn("intentional-test-warning: allowed by flag");
    triggered.set(true);
  });

  return {
    [TESTS]: [
      { action: triggerWarn },
      { assertion: didTrigger },
    ],
    allowConsoleWarnings: true,
  };
});
