/// <cts-enable />

/**
 * An explicit `{ settle: true }` step runs for a participant. Every step
 * already settles before the next, so this settles again at a point the author
 * names; the run then reaches the assertion after it and reports it.
 */

import {
  action,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

export interface SettleSetup {
  note: Writable<string>;
}

export const setup = pattern<Record<string, never>, SettleSetup>(() => ({
  note: Writable.of<string>(""),
}));

export const alice = pattern<{ setup: SettleSetup }>(({ setup }) => ({
  [TESTS]: [
    { action: action(() => setup.note.set("from alice")) },
    { label: "alice-wrote" },
  ],
}));

export const bob = pattern<{ setup: SettleSetup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-wrote" },
    { settle: true },
    { assertion: assert(() => setup.note.get() === "from alice") },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
