/**
 * Fixture: a throwing action with `allowRuntimeErrors: true`. The runner
 * tolerates the error, reports it as allowed, and the run passes.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const untouched = new Writable(true);
  const throwingAction = action(() => {
    throw new Error("intentional fixture throw");
  });
  return {
    [TESTS]: [
      { action: throwingAction },
      { assertion: assert(() => untouched.get()) },
    ],
    allowRuntimeErrors: true,
  };
});
