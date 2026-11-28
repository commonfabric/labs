/**
 * Fixture: a test with read budgets whose only step is a `{ settle: true }`
 * step, so the step's budget is measured across that settlement.
 */

import { pattern, TESTS } from "commonfabric";

export const readBudgets = {
  initialization: { total: 100000, perRun: 100000 },
  steps: { total: 100000, perRun: 100000 },
};

export default pattern(() => {
  return { [TESTS]: [{ settle: true }] };
});
