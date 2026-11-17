/**
 * Fixture: a pattern whose `[TESTS]` is not an array, which the runner reports
 * as a file-level error.
 */

import { pattern, TESTS } from "commonfabric";

export default pattern(() => {
  // deno-lint-ignore no-explicit-any
  return { [TESTS]: "not a list" as any };
});
