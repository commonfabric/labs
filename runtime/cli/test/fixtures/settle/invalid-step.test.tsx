/**
 * Fixture: a step with no `action` / `assertion` / `settle` key. The runner must
 * reject it; the error surfaces as a file-level error on the run result.
 */

import { pattern, TESTS } from "commonfabric";

export default pattern(() => {
  return {
    // deno-lint-ignore no-explicit-any
    [TESTS]: [{ notAValidStep: true } as any],
  };
});
