/// <cts-enable />

/**
 * Fixture for an action whose handler throws. On the server-execution arm
 * both the test's speculative run and the served run throw, and the runner
 * reports the throw once.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const note = Writable.of<string>("before");
  return {
    [TESTS]: [
      {
        action: action(() => {
          note.set("written");
          throw new Error("the handler threw");
        }),
      },
      { assertion: assert(() => true) },
    ],
  };
});
