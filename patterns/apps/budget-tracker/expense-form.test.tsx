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
 * It then checks what the streams refuse and default, and drives the rendered
 * form: typing into its inputs, the Add Expense and Set Budget buttons act on
 * what was typed, refuse an amount that is not a number and a negative limit,
 * and clear the drafts; each row's × removes it.
 *
 * Run: deno task cf test patterns/apps/budget-tracker/expense-form.test.tsx --verbose
 */
import {
  action,
  assert,
  type Cell,
  equals,
  handler,
  pattern,
  TESTS,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  clickButton,
  clickInRow,
  findElementByText,
  hasText,
  readValue,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
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

/** Types each entry's text into the input with its placeholder, writing
 * through the cell the input's `$value` binds, as typing does. A handler's
 * view of the tree keeps that binding a cell; a plain read resolves it to its
 * text. */
const typeEntries = handler<
  void,
  { ui: Cell<VNode>; entries: { placeholder: string; text: string }[] }
>((_event, { ui, entries }) => {
  for (const { placeholder, text } of entries) typeInto(ui, placeholder, text);
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
  // The exported streams refuse what they cannot record
  // ==========================================================================

  const action_send_invalid = action(() => {
    form.addExpense.send({ description: "  ", amount: 5 });
    form.addExpense.send({ description: "Refund", amount: 0 });
    form.addExpense.send({ description: "Refund", amount: -3 });
    form.setBudget.send({ category: "  ", limit: 10 });
    form.setBudget.send({ category: "Travel", limit: -1 });
    form.removeBudget.send({ category: "Travel" });
  });
  const assert_invalid_ignored = assert(() =>
    expensesCell.get().length === 0 && budgetsCell.get().length === 0
  );
  const action_send_bare_expense = action(() =>
    form.addExpense.send({ description: " Bus ", amount: 2.5 })
  );
  const assert_bare_expense_defaulted = assert(() =>
    expensesCell.get().length === 1 &&
    expensesCell.get()[0].description === "Bus" &&
    expensesCell.get()[0].category === "Other" &&
    /^\d{4}-\d{2}-\d{2}$/.test(expensesCell.get()[0].date)
  );

  const action_set_travel = action(() =>
    form.setBudget.send({ category: "Travel", limit: 20 })
  );
  const assert_travel_set = assert(() =>
    budgetsCell.get().length === 1 && budgetsCell.get()[0].limit === 20
  );
  const action_remove_travel = action(() =>
    form.removeBudget.send({ category: "Travel" })
  );
  const assert_travel_removed = assert(() => budgetsCell.get().length === 0);

  // ==========================================================================
  // The rendered form: its buttons act on the drafts its inputs bind
  // ==========================================================================

  const action_click_add_expense = action(() =>
    clickButton(form[UI], "Add Expense")
  );
  const assert_empty_draft_adds_nothing = assert(() =>
    expensesCell.get().length === 1 && hasText(form[UI], "Expenses (1)")
  );
  const action_type_bad_amount = typeEntries({
    ui: form[UI],
    entries: [
      { placeholder: "Description", text: " Coffee " },
      { placeholder: "Amount", text: "a few" },
      { placeholder: "Category", text: " " },
    ],
  });
  const assert_draft_shown_not_added = assert(() => {
    const draft = findElementByText(form[UI], "pre", "newDescription");
    return hasText(draft, 'newDescription: " Coffee "') &&
      hasText(draft, 'newAmount: "a few"') &&
      expensesCell.get().length === 1;
  });
  const action_type_amount = typeEntries({
    ui: form[UI],
    entries: [{ placeholder: "Amount", text: "4.5" }],
  });
  const assert_expense_added_and_draft_cleared = assert(() => {
    const ui = readValue(form[UI]);
    const draft = findElementByText(ui, "pre", "newDescription");
    return expensesCell.get().length === 2 &&
      expensesCell.get()[1].description === "Coffee" &&
      expensesCell.get()[1].amount === 4.5 &&
      expensesCell.get()[1].category === "Other" &&
      hasText(draft, 'newDescription: ""') &&
      hasText(draft, 'newAmount: ""') &&
      hasText(draft, 'newCategory: "Other"') &&
      hasText(ui, "Coffee - $4.5 (Other)") &&
      hasText(findElementByText(ui, "pre", "expenses"), "Coffee");
  });

  const action_click_set_budget = action(() =>
    clickButton(form[UI], "Set Budget")
  );
  const assert_empty_budget_draft_sets_nothing = assert(() =>
    budgetsCell.get().length === 0
  );
  const action_type_negative_limit = typeEntries({
    ui: form[UI],
    entries: [
      { placeholder: "Category (e.g. Food)", text: " Food " },
      { placeholder: "Monthly limit", text: "-5" },
    ],
  });
  const assert_negative_limit_refused = assert(() =>
    budgetsCell.get().length === 0 &&
    hasText(
      findElementByText(form[UI], "pre", "budgetLimit"),
      'budgetLimit: "-5"',
    )
  );
  const action_type_limit = typeEntries({
    ui: form[UI],
    entries: [
      { placeholder: "Monthly limit", text: "50" },
    ],
  });
  const assert_budget_set_and_draft_cleared = assert(() => {
    const ui = readValue(form[UI]);
    const draft = findElementByText(ui, "pre", "budgetLimit");
    return budgetsCell.get().length === 1 &&
      budgetsCell.get()[0].category === "Food" &&
      budgetsCell.get()[0].limit === 50 &&
      hasText(draft, 'budgetCategory: ""') &&
      hasText(draft, 'budgetLimit: ""') &&
      hasText(ui, "Food: $50");
  });
  const action_type_budget_update = typeEntries({
    ui: form[UI],
    entries: [
      { placeholder: "Category (e.g. Food)", text: "Food" },
      { placeholder: "Monthly limit", text: "80" },
    ],
  });
  const assert_budget_updated = assert(() =>
    budgetsCell.get().length === 1 &&
    budgetsCell.get()[0].limit === 80 &&
    hasText(form[UI], "Food: $80")
  );

  const action_remove_coffee = action(() =>
    clickInRow(form[UI], "Coffee - $4.5", "×")
  );
  const assert_coffee_removed = assert(() =>
    expensesCell.get().length === 1 &&
    expensesCell.get()[0].description === "Bus" &&
    hasText(form[UI], "Expenses (1)")
  );
  const action_remove_food_row = action(() =>
    clickInRow(form[UI], "Food: $80", "×")
  );
  const assert_food_row_removed = assert(() =>
    budgetsCell.get().length === 0 && hasText(form[UI], "Budgets (0)")
  );

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

      // The streams' refusals and defaults
      { action: action_send_invalid },
      { assertion: assert_invalid_ignored },
      { action: action_send_bare_expense },
      { assertion: assert_bare_expense_defaulted },
      { action: action_set_travel },
      { assertion: assert_travel_set },
      { action: action_remove_travel },
      { assertion: assert_travel_removed },

      // The rendered form
      { action: action_click_add_expense },
      { assertion: assert_empty_draft_adds_nothing },
      { action: action_type_bad_amount },
      { action: action_click_add_expense },
      { assertion: assert_draft_shown_not_added },
      { action: action_type_amount },
      { action: action_click_add_expense },
      { assertion: assert_expense_added_and_draft_cleared },
      { action: action_click_set_budget },
      { assertion: assert_empty_budget_draft_sets_nothing },
      { action: action_type_negative_limit },
      { action: action_click_set_budget },
      { assertion: assert_negative_limit_refused },
      { action: action_type_limit },
      { action: action_click_set_budget },
      { assertion: assert_budget_set_and_draft_cleared },
      { action: action_type_budget_update },
      { action: action_click_set_budget },
      { assertion: assert_budget_updated },
      { action: action_remove_coffee },
      { assertion: assert_coffee_removed },
      { action: action_remove_food_row },
      { assertion: assert_food_row_removed },
    ],
    form,
  };
});
