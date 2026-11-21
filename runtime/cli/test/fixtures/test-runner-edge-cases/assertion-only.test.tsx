/**
 * Fixture: a single assertion that holds.
 */

import { assert, pattern, TESTS } from "commonfabric";

export default pattern(() => ({
  [TESTS]: [{ assertion: assert(() => true) }],
}));
