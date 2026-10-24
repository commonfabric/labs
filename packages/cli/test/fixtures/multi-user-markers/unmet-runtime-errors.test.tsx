/// <cts-enable />

/**
 * Each participant's expectation goes unmet: Alice expects two runtime errors
 * and raises one, Bob expects some and raises none, and Carol names a message
 * her one error doesn't hold. Each is reported under its own name.
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
  return { [TESTS]: [{ action: refuse }], expectRuntimeErrors: 2 };
});

export const bob = pattern<{ setup: ErrorSetup }>(({ setup }) => {
  const write = action(() => setup.note.set("from bob"));
  return { [TESTS]: [{ action: write }], expectRuntimeErrors: true };
});

export const carol = pattern<{ setup: ErrorSetup }>(() => {
  const refuse = action(() => {
    throw new Error("Carol's action is refused");
  });
  return {
    [TESTS]: [{ action: refuse }],
    expectRuntimeErrors: ["Carol's action is allowed"],
  };
});

export default multiUserTest({ setup, participants: { alice, bob, carol } });
