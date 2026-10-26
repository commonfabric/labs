/// <cts-enable />

/**
 * Crossing `{ await }` delivers what the announcing participant wrote before
 * `{ label }`. Bob's assertion is read once, so it passes only when the
 * marker brought Alice's write with it.
 */

import {
  action,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

export interface MarkerSetup {
  note: Writable<string>;
}

export const setup = pattern<Record<string, never>, MarkerSetup>(() => ({
  note: Writable.of<string>(""),
}));

export const alice = pattern<{ setup: MarkerSetup }>(({ setup }) => ({
  [TESTS]: [
    { action: action(() => setup.note.set("from alice")) },
    { label: "alice-wrote" },
  ],
}));

export const bob = pattern<{ setup: MarkerSetup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-wrote" },
    { assertion: assert(() => setup.note.get() === "from alice") },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
