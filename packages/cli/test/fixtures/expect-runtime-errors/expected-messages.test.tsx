/**
 * Fixture: expectRuntimeErrors names each error's message, listed in another
 * order than the errors fire. Each listed message is one error's, so the run
 * passes.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const fine = new Writable(true);
  const stillFine = assert(() => fine.get());

  const first = action(() => {
    throw new Error("first refusal");
  });
  const second = action(() => {
    throw new Error("second refusal");
  });

  return {
    [TESTS]: [
      { action: first },
      { action: second },
      { assertion: stillFine },
    ],
    expectRuntimeErrors: ["second refusal", "first refusal"],
  };
});
