/**
 * Test Pattern: Budget Tracker (confidential notes)
 *
 * Exercises the labelled-contract tracker end to end: the confidential
 * `description` writes and reads back like any string inside the space (the
 * label governs flows across the commit boundary, not local use), the inert
 * fields aggregate, and the tracker exposes its arrays.
 *
 * Run: deno task cf test patterns/apps/budget-tracker/confidential.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import ConfidentialTracker, {
  type ConfidentialExpense,
} from "./confidential.tsx";
import type { CategoryBudget } from "./schemas.tsx";

export default pattern(() => {
  const expensesCell = new Writable<ConfidentialExpense[]>([]);
  const budgetsCell = new Writable<CategoryBudget[]>([]);

  ConfidentialTracker({
    expenses: expensesCell,
    budgets: budgetsCell,
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_add_expenses = action(() => {
    expensesCell.set([
      {
        description: "pharmacy — the prescription nobody else needs to know",
        amount: 42.5,
        category: "Health",
        date: "2026-08-01",
      },
      {
        description: "coffee with A. before the interview",
        amount: 6.5,
        category: "Dining",
        date: "2026-08-02",
      },
    ]);
  });

  const action_set_budget = action(() => {
    budgetsCell.set([{ category: "Health", limit: 100 }]);
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_expenses_exposed = assert(() => {
    const cur = expensesCell.get();
    return cur.length === 2 &&
      cur[0]?.description ===
        "pharmacy — the prescription nobody else needs to know" &&
      cur[0]?.amount === 42.5;
  });

  const assert_inert_fields_aggregate = assert(() => {
    const cur = expensesCell.get();
    return cur.reduce(
          (sum: number, e: ConfidentialExpense) => sum + e.amount,
          0,
        ) === 49 &&
      cur.every((e: ConfidentialExpense) => typeof e.category === "string");
  });

  const assert_budgets_exposed = assert(() => {
    const cur = budgetsCell.get();
    return cur.length === 1 && cur[0]?.category === "Health" &&
      cur[0]?.limit === 100;
  });

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      { action: action_add_expenses },
      { assertion: assert_expenses_exposed },
      { assertion: assert_inert_fields_aggregate },
      { action: action_set_budget },
      { assertion: assert_budgets_exposed },
    ],
  };
});
