/// <cts-enable />

/**
 * Alice expects the one runtime error her action raises. Bob expects none and
 * raises one, which fails the run: Alice's expectation covers her own errors,
 * not his.
 */

import { action, multiUserTest, pattern, TESTS, Writable } from "commonfabric";

export interface ErrorSetup {
  note: Writable<string>;
}

export const setup = pattern<Record<string, never>, ErrorSetup>(() => ({
  note: Writable.of<string>(""),
}));

export const alice = pattern<{ setup: ErrorSetup }>(() => {
  const refuse = action(() => {
    throw new Error("Alice's action is refused");
  });
  return { [TESTS]: [{ action: refuse }], expectRuntimeErrors: 1 };
});

export const bob = pattern<{ setup: ErrorSetup }>(() => {
  const refuse = action(() => {
    throw new Error("Bob's action is refused");
  });
  return { [TESTS]: [{ action: refuse }] };
});

export default multiUserTest({ setup, participants: { alice, bob } });
