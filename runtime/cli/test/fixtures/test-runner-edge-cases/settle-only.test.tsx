/**
 * Fixture: a single `{ settle: true }` step, so the run's only full settle is
 * the step's own.
 */

import { pattern, TESTS } from "commonfabric";

export default pattern(() => {
  return { [TESTS]: [{ settle: true }] };
});
