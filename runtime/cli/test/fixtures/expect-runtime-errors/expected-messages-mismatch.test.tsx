/**
 * Fixture: expectRuntimeErrors names two messages, and as many errors fire,
 * but one of them is another error than the one named. A listed message pins
 * what an error says, not only how many fire, so the run fails.
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const fine = new Writable(true);
  const stillFine = assert(() => fine.get());

  const first = action(() => {
    throw new Error("first refusal");
  });
  const other = action(() => {
    throw new TypeError("something else went wrong");
  });

  return {
    [TESTS]: [
      { action: first },
      { action: other },
      { assertion: stillFine },
    ],
    expectRuntimeErrors: ["first refusal", "second refusal"],
  };
});
