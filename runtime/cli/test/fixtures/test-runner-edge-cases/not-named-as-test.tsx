/**
 * Fixture: a passing pattern test in a file whose name does not end in
 * `.test.tsx`, which `cf test` runs when named directly, with a warning.
 */

import { assert, pattern, TESTS } from "commonfabric";

export default pattern(() => ({
  [TESTS]: [{ assertion: assert(() => true) }],
}));
