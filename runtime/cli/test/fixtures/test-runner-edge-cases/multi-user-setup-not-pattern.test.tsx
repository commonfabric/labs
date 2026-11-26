/// <cts-enable />

/**
 * Fixture: a multi-user test whose `setup` is a function but not a pattern,
 * which the participant's worker reports as it starts.
 */

import { multiUserTest, pattern, TESTS } from "commonfabric";

export const alice = pattern(() => ({ [TESTS]: [] }));

export function notAPattern() {
  return {};
}

export default multiUserTest({ setup: notAPattern, participants: { alice } });
