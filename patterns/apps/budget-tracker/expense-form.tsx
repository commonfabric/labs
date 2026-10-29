/**
 * Budget Tracker - Expense Form Sub-Pattern
 *
 * Provides UI and handlers for adding/removing expenses and budgets.
 * Requires Writable<> for write access to data.
 *
 * Can be deployed standalone for testing handlers,
 * or composed into a larger pattern.
 */
import {
  computed,
  equals,
  handler,
  NAME,
  pattern,
  Stream,
  toIndentedDebugString,
  UI,
  Writable,
} from "commonfabric";
import { type CategoryBudget, type Expense, getTodayDate } from "./schemas.tsx";

// ============ INPUT/OUTPUT TYPES ============

// Sub-patterns don't use Default<> - the parent pattern owns initialization
interface Input {
  expenses: Writable<Expense[]>;
  budgets: Writable<CategoryBudget[]>;
}

interface Output {
  // Don't re-export shared cells - parent owns them
  // Handlers typed as Stream<T> for cross-piece communication
  addExpense: Stream<{
    description: string;
    amount: number;
    category?: string;
    date?: string;
  }>;
  setBudget: Stream<{ category: string; limit: number }>;
  removeBudget: Stream<{ category: string }>;
}

// ============ HANDLERS ============

const addExpenseHandler = handler<
  { description: string; amount: number; category?: string; date?: string },
  { expenses: Writable<Expense[]> }
>(({ description, amount, category, date }, { expenses }) => {
  // `NaN` passes `amount <= 0` (`NaN <= 0` is false), so gate finiteness too.
  if (!description?.trim() || !Number.isFinite(amount) || amount <= 0) {
    return;
  }
  expenses.push({
    description: description.trim(),
    amount,
    category: category || "Other",
    date: date || getTodayDate(Date.now()),
  });
});

const setBudgetHandler = handler<
  { category: string; limit: number },
  { budgets: Writable<CategoryBudget[]> }
>(({ category, limit }, { budgets }) => {
  if (!category?.trim() || typeof limit !== "number" || limit < 0) {
    return;
  }
  const current = budgets.get();
  const existingIndex = current.findIndex((b) =>
    b.category === category.trim()
  );

  if (existingIndex >= 0) {
    // Write through the element's cell — rebuilding the array with a fresh
    // object literal for the matched budget would re-mint its entity identity
    // and orphan previously-held references (see
    // patterns/product/primitives/editable-list.tsx).
    budgets.key(existingIndex).key("limit").set(limit);
  } else {
    budgets.push({ category: category.trim(), limit });
  }
});

const removeBudgetHandler = handler<
  { category: string },
  { budgets: Writable<CategoryBudget[]> }
>(({ category }, { budgets }) => {
  const current = budgets.get();
  const index = current.findIndex((b) => b.category === category);
  if (index >= 0) {
    budgets.set(current.toSpliced(index, 1));
  }
});

// ============ PATTERN ============

// Use single type param to avoid conflict bug when composed
export default pattern<Input>(({ expenses, budgets }) => {
  // Local state for form inputs
  const newDescription = new Writable("");
  const newAmount = new Writable("");
  const newCategory = new Writable("Other");

  // Budget form inputs
  const budgetCategory = new Writable("");
  const budgetLimit = new Writable("");

  // Counts for display
  const expenseCount = computed(() => expenses.get().length);
  const budgetCount = computed(() => budgets.get().length);

  // Bound handlers
  const addExpense = addExpenseHandler({ expenses });
  const setBudget = setBudgetHandler({ budgets });
  const removeBudget = removeBudgetHandler({ budgets });

  return {
    [NAME]: "Expense Form",
    [UI]: (
      <div style={{ fontFamily: "system-ui", padding: "1rem" }}>
        <h3 style={{ margin: "0 0 0.5rem 0" }}>Add Expense</h3>

        {/* Add Expense Form - using $value binding */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            marginBottom: "1rem",
          }}
        >
          <cf-input $value={newDescription} placeholder="Description" />
          <cf-input $value={newAmount} placeholder="Amount" />
          <cf-input $value={newCategory} placeholder="Category" />
          <cf-button
            onClick={() => {
              const desc = newDescription.get().trim();
              const amt = parseFloat(newAmount.get());
              const cat = newCategory.get().trim() || "Other";

              if (desc && !isNaN(amt) && amt > 0) {
                expenses.push({
                  description: desc,
                  amount: amt,
                  category: cat,
                  date: getTodayDate(Date.now()),
                });
                // Clear form
                newDescription.set("");
                newAmount.set("");
                newCategory.set("Other");
              }
            }}
          >
            Add Expense
          </cf-button>
        </div>

        {/* Expense List with Remove */}
        <h4 style={{ margin: "0 0 0.5rem 0" }}>Expenses ({expenseCount})</h4>
        <div style={{ marginBottom: "1rem" }}>
          {expenses.map((expense) => (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.5rem",
                borderBottom: "1px solid #eee",
              }}
            >
              <span>
                {expense.description} - ${expense.amount} ({expense.category})
              </span>
              <cf-button
                variant="ghost"
                onClick={() => {
                  const current = expenses.get();
                  const index = current.findIndex((el) => equals(expense, el));
                  if (index >= 0) {
                    expenses.set(current.toSpliced(index, 1));
                  }
                }}
              >
                ×
              </cf-button>
            </div>
          ))}
        </div>

        {/* Budget Management */}
        <h3 style={{ margin: "1rem 0 0.5rem 0" }}>Set Budget Limit</h3>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            marginBottom: "1rem",
          }}
        >
          <cf-input
            $value={budgetCategory}
            placeholder="Category (e.g. Food)"
          />
          <cf-input $value={budgetLimit} placeholder="Monthly limit" />
          <cf-button
            onClick={() => {
              const cat = budgetCategory.get().trim();
              const limitVal = parseFloat(budgetLimit.get());

              if (cat && !isNaN(limitVal) && limitVal >= 0) {
                const current = budgets.get();
                const existingIndex = current.findIndex((b) =>
                  b.category === cat
                );

                if (existingIndex >= 0) {
                  // In-place element-cell write — a fresh literal would
                  // re-mint the budget's entity identity (see
                  // setBudgetHandler above).
                  budgets.key(existingIndex).key("limit").set(limitVal);
                } else {
                  budgets.push({ category: cat, limit: limitVal });
                }
                // Clear form
                budgetCategory.set("");
                budgetLimit.set("");
              }
            }}
          >
            Set Budget
          </cf-button>
        </div>

        {/* Budget List */}
        <h4 style={{ margin: "0 0 0.5rem 0" }}>Budgets ({budgetCount})</h4>
        <div style={{ marginBottom: "1rem" }}>
          {budgets.map((budget) => (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.5rem",
                borderBottom: "1px solid #eee",
              }}
            >
              <span>
                {budget.category}: ${budget.limit}
              </span>
              <cf-button
                variant="ghost"
                onClick={() => {
                  const current = budgets.get();
                  const index = current.findIndex((b) => equals(budget, b));
                  if (index >= 0) {
                    budgets.set(current.toSpliced(index, 1));
                  }
                }}
              >
                ×
              </cf-button>
            </div>
          ))}
        </div>

        {/* Debug */}
        <details>
          <summary style={{ cursor: "pointer", color: "#666" }}>
            Debug: Form State
          </summary>
          <pre
            style={{
              fontSize: "11px",
              background: "#f5f5f5",
              padding: "0.5rem",
            }}
          >
            {computed(() =>
              toIndentedDebugString(
                {
                  newDescription: newDescription.get(),
                  newAmount: newAmount.get(),
                  newCategory: newCategory.get(),
                  budgetCategory: budgetCategory.get(),
                  budgetLimit: budgetLimit.get(),
                },
              )
            )}
          </pre>
        </details>

        <details>
          <summary style={{ cursor: "pointer", color: "#666" }}>
            Debug: Raw Data
          </summary>
          <pre
            style={{
              fontSize: "11px",
              background: "#f5f5f5",
              padding: "0.5rem",
            }}
          >
            {computed(() =>
              toIndentedDebugString(
                {
                  expenses: expenses.get(),
                  budgets: budgets.get(),
                },
              )
            )}
          </pre>
        </details>
      </div>
    ),

    // Export bound handlers as Streams (not shared cells - parent owns those)
    addExpense,
    setBudget,
    removeBudget,
  };
});
