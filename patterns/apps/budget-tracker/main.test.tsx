/**
 * Test Pattern: Budget Tracker
 *
 * Writes expenses and budgets into the cells the composed tracker owns and
 * reads the data view's summary back after each change: totals, the
 * per-category breakdown, and each category's budget status.
 * `expense-form.test.tsx` drives the form's streams and controls.
 *
 * Run: deno task cf test patterns/apps/budget-tracker/main.test.tsx --verbose
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  hasText,
  innermostNode,
  readValue,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import BudgetTracker from "./main.tsx";
import type { CategoryBudget, Expense } from "./schemas.tsx";

/** The background of the innermost budget-status row that shows `text`. */
function statusBackground(ui: unknown, text: string): unknown {
  return styleOf(
    innermostNode(
      ui,
      (node) =>
        hasText(node, text) && styleOf(node, "background") !== undefined,
    ),
    "background",
  );
}

export default pattern(() => {
  const expenses = new Writable<Expense[]>([]);
  const budgets = new Writable<CategoryBudget[]>([]);
  const tracker = BudgetTracker({ expenses, budgets });

  const assert_names_itself = assert(() => tracker[NAME] === "Budget Tracker");
  const assert_starts_empty = assert(() => {
    const ui = readValue(tracker[UI]);
    return hasText(ui, "Expenses (0)") &&
      hasText(ui, "Budgets (0)") &&
      hasText(ui, "$0.00") &&
      tracker.expenses.length === 0 &&
      tracker.budgets.length === 0;
  });

  const action_record_expenses = action(() =>
    expenses.set([
      {
        description: "Groceries",
        amount: 40,
        category: "Food",
        date: "2026-11-01",
      },
      {
        description: "Bus",
        amount: 2.5,
        category: "Other",
        date: "2026-11-02",
      },
    ])
  );
  const assert_summary_totals = assert(() => {
    const ui = readValue(tracker[UI]);
    return tracker.expenses.length === 2 &&
      hasText(ui, "Expenses (2)") &&
      hasText(ui, "Groceries - $40 (Food)") &&
      hasText(ui, "$42.50") &&
      hasText(ui, "Food: $40.00") &&
      hasText(ui, "Other: $2.50");
  });

  const action_set_food_budget = action(() =>
    budgets.set([{ category: "Food", limit: 30 }])
  );
  const assert_food_over_budget = assert(() => {
    const ui = readValue(tracker[UI]);
    return tracker.budgets.length === 1 &&
      hasText(ui, "Food: $30") &&
      hasText(ui, "/ $30 (133%)") &&
      statusBackground(ui, "(133%)") === "#fee" &&
      statusBackground(ui, "Other: $2.50") === "#efe";
  });

  const action_raise_food_budget = action(() =>
    budgets.set([{ category: "Food", limit: 80 }])
  );
  const assert_food_within_budget = assert(() => {
    const ui = readValue(tracker[UI]);
    return hasText(ui, "/ $80 (50%)") &&
      statusBackground(ui, "(50%)") === "#efe";
  });

  const action_drop_budgets = action(() => budgets.set([]));
  const assert_no_budget_status = assert(() => {
    const ui = readValue(tracker[UI]);
    return hasText(ui, "Budgets (0)") &&
      hasText(ui, "Food: $40.00") &&
      !hasText(ui, "(50%)");
  });

  return {
    [TESTS]: [
      { assertion: assert_names_itself },
      { assertion: assert_starts_empty },
      { action: action_record_expenses },
      { assertion: assert_summary_totals },
      { action: action_set_food_budget },
      { assertion: assert_food_over_budget },
      { action: action_raise_food_budget },
      { assertion: assert_food_within_budget },
      { action: action_drop_budgets },
      { assertion: assert_no_budget_status },
    ],
    tracker,
  };
});
