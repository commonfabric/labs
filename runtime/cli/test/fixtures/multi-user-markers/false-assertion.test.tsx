/// <cts-enable />

/**
 * A false assertion after a marker. Bob reads a note Alice did write, and
 * compares it against something she never wrote, so the value is settled and
 * the comparison is the failure.
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
    { assertion: assert(() => setup.note.get() === "from nobody") },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
