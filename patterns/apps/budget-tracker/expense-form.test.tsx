/**
 * Test Pattern: Budget Tracker — Expense Form
 *
 * Exercises the budget streams' identity contract (CT-1715):
 * - setBudget creates a budget for a new category
 * - setBudget UPDATES the limit for an existing category
 * - held-reference survival: a reference stashed in a cell BEFORE a limit
 *   update must still `equals()`-match and still drive a subsequent
 *   equals()-located removal AFTER the update. The update writes through
 *   the element's cell; replacing the array slot with a fresh object
 *   literal would re-mint the budget's entity identity and orphan every
 *   held reference.
 * - removeBudget removes by category
 *
 * Run: deno task cf test patterns/apps/budget-tracker/expense-form.test.tsx --verbose
 */
import {
  action,
  assert,
  equals,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import ExpenseForm from "./expense-form.tsx";
import type { CategoryBudget, Expense } from "./schemas.tsx";

// Test plumbing: remove the budget the held reference points at, locating
// it with equals() — proves a reference held across a limit update still
// drives operations (it would silently no-op if the update had re-minted
// the budget's entity identity).
const removeHeldBudget = handler<
  void,
  { budgets: Writable<CategoryBudget[]>; held: Writable<CategoryBudget> }
>((_event, { budgets, held }) => {
  const cur = budgets.get();
  const idx = cur.findIndex((b) => equals(held, b));
  if (idx >= 0) {
    budgets.set(cur.toSpliced(idx, 1));
  }
});

export default pattern(() => {
  const expensesCell = new Writable<Expense[]>([]);
  const budgetsCell = new Writable<CategoryBudget[]>([]);

  const form = ExpenseForm({
    expenses: expensesCell,
    budgets: budgetsCell,
  });

  // Simulates an external holder (a dashboard row / selection cell) that
  // read a budget once and keeps the reference across later mutations.
  // Typed non-null (placeholder initial value) so the cell can be bound
  // directly as handler state.
  const heldBudget = new Writable<CategoryBudget>({
    category: "",
    limit: 0,
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_set_food_budget = action(() => {
    form.setBudget.send({ category: "Food", limit: 100 });
  });

  const action_stash_held = action(() => {
    const b = budgetsCell.get()[0];
    if (b) heldBudget.set(b);
  });

  const action_update_food_budget = action(() => {
    form.setBudget.send({ category: "Food", limit: 250 });
  });

  const action_remove_via_held = removeHeldBudget({
    budgets: budgetsCell,
    held: heldBudget,
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_food_created = assert(() => {
    const cur = budgetsCell.get();
    return cur.length === 1 && cur[0]?.category === "Food" &&
      cur[0]?.limit === 100;
  });

  const assert_held_stashed = assert(() => {
    const h = heldBudget.get();
    return h.category === "Food" && equals(budgetsCell.get()[0], h);
  });

  const assert_food_updated_in_place = assert(() => {
    const cur = budgetsCell.get();
    return cur.length === 1 && cur[0]?.category === "Food" &&
      cur[0]?.limit === 250;
  });
  // KEY: the stale-but-once-valid reference still equals()-matches the
  // budget AFTER setBudget updated its limit.
  const assert_held_survives_update = assert(() => {
    const h = heldBudget.get();
    return equals(budgetsCell.get()[0], h);
  });
  // The held reference also READS the update (it would show the stale,
  // orphaned entity if setBudget had re-minted identity).
  const assert_held_reads_update = assert(() => heldBudget.get().limit === 250);

  // KEY: the held reference still DRIVES an equals()-located removal.
  const assert_removed_via_held = assert(() => budgetsCell.get().length === 0);

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // Create
      { action: action_set_food_budget },
      { assertion: assert_food_created },

      // Held-reference survival: stash → update limit → the old reference
      // still matches, reads the update, and still drives removal.
      { action: action_stash_held },
      { assertion: assert_held_stashed },
      { action: action_update_food_budget },
      { assertion: assert_food_updated_in_place },
      { assertion: assert_held_survives_update },
      { assertion: assert_held_reads_update },
      { action: action_remove_via_held },
      { assertion: assert_removed_via_held },
    ],
    form,
  };
});
