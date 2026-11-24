/**
 * Fixture: a pattern whose body writes to the console. The body runs as the
 * module is evaluated, before the run begins, so that output is not the
 * test's behavior and the run passes.
 */

import { assert, pattern, TESTS } from "commonfabric";

export default pattern(() => {
  console.error("pattern-body output before the run");
  return {
    [TESTS]: [{ assertion: assert(() => true) }],
  };
});
