/// <cts-enable />

/**
 * Each participant requires the runtime errors its own actions raise: Alice
 * exactly two, Bob the one his refusal names. Both are met, so the run
 * passes.
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
  return {
    [TESTS]: [{ action: refuse }, { action: refuse }],
    expectRuntimeErrors: 2,
  };
});

export const bob = pattern<{ setup: ErrorSetup }>(() => {
  const refuse = action(() => {
    throw new Error("Bob's action is refused");
  });
  return {
    [TESTS]: [{ action: refuse }],
    expectRuntimeErrors: ["Bob's action is refused"],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
