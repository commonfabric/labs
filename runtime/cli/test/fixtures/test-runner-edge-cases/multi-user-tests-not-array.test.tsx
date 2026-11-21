/// <cts-enable />

/**
 * Fixture: a multi-user participant whose `[TESTS]` is not a list, which the
 * participant's worker reports as it starts.
 */

import { multiUserTest, pattern, TESTS } from "commonfabric";

// deno-lint-ignore no-explicit-any
export const alice = pattern(() => ({ [TESTS]: "not a list" as any }));

export default multiUserTest({ participants: { alice } });
