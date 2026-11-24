/**
 * Fixture: a test with read budgets whose only step carries no discriminant,
 * so the step fails before its budget is measured.
 */

import { pattern, TESTS } from "commonfabric";

export const readBudgets = {
  initialization: { total: 100000, perRun: 100000 },
  steps: { total: 100000, perRun: 100000 },
};

export default pattern(() => {
  return {
    // deno-lint-ignore no-explicit-any
    [TESTS]: [{ notAValidStep: true } as any],
  };
});
