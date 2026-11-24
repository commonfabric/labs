/// <cts-enable />

/**
 * Both participants announce before either crosses the other's marker, so
 * each announces from a replica that predates the other's announcement. Each
 * writes its own marker document, so announcing in that order is
 * conflict-free and both markers arrive.
 */

import { assert, multiUserTest, pattern, TESTS, Writable } from "commonfabric";

export interface MarkerSetup {
  note: Writable<string>;
}

export const setup = pattern<Record<string, never>, MarkerSetup>(() => ({
  note: Writable.of<string>(""),
}));

export const alice = pattern<{ setup: MarkerSetup }>(({ setup }) => ({
  [TESTS]: [
    { label: "alice-1" },
    { await: "bob-1" },
    { assertion: assert(() => setup.note.get() === "") },
  ],
}));

export const bob = pattern<{ setup: MarkerSetup }>(({ setup }) => ({
  [TESTS]: [
    { label: "bob-1" },
    { await: "alice-1" },
    { assertion: assert(() => setup.note.get() === "") },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
