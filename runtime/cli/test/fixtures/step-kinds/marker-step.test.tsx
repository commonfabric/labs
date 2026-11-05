/**
 * Fixture for multi-user marker steps in a single-user run. `{ label }` and
 * `{ await }` synchronize participants; a single-user run has none, so they
 * are inert and the run reports only the assertion.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const flag = new Writable(false);
  return {
    [TESTS]: [
      { label: "before" },
      { action: action(() => flag.set(true)) },
      { await: "before" },
      { assertion: assert(() => flag.get() === true) },
    ],
  };
});
