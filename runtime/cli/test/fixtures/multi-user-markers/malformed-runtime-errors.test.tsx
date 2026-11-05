/// <cts-enable />

/**
 * Alice's `expectRuntimeErrors` is `1.5`, which is not an expectation, and
 * nothing throws. The run fails naming the value, rather than reading it as
 * no expectation and passing.
 */

import { action, multiUserTest, pattern, TESTS, Writable } from "commonfabric";

export interface ErrorSetup {
  note: Writable<string>;
}

export const setup = pattern<Record<string, never>, ErrorSetup>(() => ({
  note: Writable.of<string>(""),
}));

export const alice = pattern<{ setup: ErrorSetup }>(() => {
  const quiet = action(() => {
    // Deliberately does not throw.
  });
  return { [TESTS]: [{ action: quiet }], expectRuntimeErrors: 1.5 };
});

export default multiUserTest({ setup, participants: { alice } });
