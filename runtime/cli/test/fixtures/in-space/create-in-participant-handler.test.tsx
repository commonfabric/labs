/// <cts-enable />

/**
 * Fixture for a multi-user participant whose handler instantiates a pattern in
 * a space of its own, with `inSpace()`. As in `create-in-handler.test.tsx`,
 * the run fails on the replication's error unless the participant's runner
 * wrote the test's compiled closure into the shared space.
 */

import {
  assert,
  handler,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

interface Child {
  label: string;
}

const Child = pattern<{ label: string }, Child>(({ label }) => ({ label }));

export interface InSpaceSetup {
  children: Writable<Child[]>;
}

export const setup = pattern<Record<string, never>, InSpaceSetup>(() => ({
  children: Writable.of<Child[]>([]),
}));

const create = handler<{ label: string }, { children: Writable<Child[]> }>(
  (event, { children }) => {
    children.push(Child.inSpace()({ label: event.label }) as Child);
  },
);

export const alice = pattern<{ setup: InSpaceSetup }>(({ setup }) => ({
  [TESTS]: [
    {
      action: create({ children: setup.children }),
      event: { label: "first" },
    },
    { assertion: assert(() => setup.children.get().length === 1) },
  ],
}));

export default multiUserTest({ setup, participants: { alice } });
