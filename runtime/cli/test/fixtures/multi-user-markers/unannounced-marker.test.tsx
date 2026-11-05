/// <cts-enable />

/**
 * Bob parks on a marker nobody announces. Alice finishes, leaving Bob the
 * only unfinished participant and nothing left to release him, which the
 * orchestrator reports as a deadlock.
 */

import { assert, multiUserTest, pattern, TESTS, Writable } from "commonfabric";

export interface MarkerSetup {
  note: Writable<string>;
}

export const setup = pattern<Record<string, never>, MarkerSetup>(() => ({
  note: Writable.of<string>(""),
}));

export const alice = pattern<{ setup: MarkerSetup }>(({ setup }) => ({
  [TESTS]: [{ assertion: assert(() => setup.note.get() === "") }],
}));

export const bob = pattern<{ setup: MarkerSetup }>(({ setup }) => ({
  [TESTS]: [
    { await: "never-announced" },
    { assertion: assert(() => setup.note.get() === "") },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
