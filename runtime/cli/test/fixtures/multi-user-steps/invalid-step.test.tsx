/// <cts-enable />

/**
 * Fixture for a step carrying no discriminant in a multi-user run. The
 * orchestrator has to name the step's own keys, so an author can see which
 * key they wrote.
 */

import { multiUserTest, pattern, TESTS } from "commonfabric";

export const setup = pattern<Record<string, never>, { ok: boolean }>(() => ({
  ok: true,
}));

export const alice = pattern<{ setup: { ok: boolean } }>(() => ({
  [TESTS]: [{ notAValidStep: true } as never],
}));

export default multiUserTest({ setup, participants: { alice } });
