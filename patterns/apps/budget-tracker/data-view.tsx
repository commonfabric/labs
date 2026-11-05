/**
 * Budget Tracker - Data View Sub-Pattern
 *
 * Displays computed summaries: totals, by-category breakdown, budget status.
 * Read-only view - uses Reactive<> since it only reads data.
 */
import { computed, NAME, pattern, Reactive, UI } from "commonfabric";
import { type CategoryBudget, type Expense } from "./schemas.tsx";

// Sub-patterns use Reactive for read-only access (no Writable<> needed)
interface Input {
  expenses: Reactive<Expense[]>;
  budgets: Reactive<CategoryBudget[]>;
}

// Use single type param to avoid conflict bug
export default pattern<Input>(({ expenses, budgets }) => {
  // Computed values
  const totalSpent = computed(() => {
    if (!Array.isArray(expenses)) return 0;
    return expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  });

  const spentByCategory = computed(() => {
    if (!Array.isArray(expenses)) return {};
    const result: Record<string, number> = {};
    for (const expense of expenses) {
      const cat = expense.category || "Other";
      result[cat] = (result[cat] || 0) + (expense.amount || 0);
    }
    return result;
  });

  const budgetStatus = computed(() => {
    const spent = spentByCategory;
    if (!spent || typeof spent !== "object") return [];

    const allCategories = new Set<string>(Object.keys(spent));
    if (Array.isArray(budgets)) {
      for (const b of budgets) {
        allCategories.add(b.category);
      }
    }

    const budgetMap = new Map<string, number>();
    if (Array.isArray(budgets)) {
      for (const b of budgets) {
        budgetMap.set(b.category, b.limit);
      }
    }

    return Array.from(allCategories)
      .sort()
      .map((category) => {
        const categorySpent = spent[category] || 0;
        const limit = budgetMap.get(category) ?? null;
        const remaining = limit !== null ? limit - categorySpent : null;
        const percentUsed = limit !== null && limit > 0
          ? (categorySpent / limit) * 100
          : null;

        return {
          category,
          spent: categorySpent,
          limit,
          remaining,
          percentUsed,
        };
      });
  });

  return {
    [NAME]: "Budget Data View",
    [UI]: (
      <div style={{ fontFamily: "system-ui", padding: "1rem" }}>
        <h3 style={{ margin: "0 0 1rem 0" }}>Summary</h3>

        <div style={{ marginBottom: "1rem" }}>
          <strong>Total Spent:</strong> ${computed(() => totalSpent.toFixed(2))}
        </div>

        <h4 style={{ margin: "0 0 0.5rem 0" }}>By Category</h4>
        <div style={{ marginBottom: "1rem" }}>
          {computed(() =>
            Object.entries(spentByCategory).map(([cat, amount]) => (
              <div>
                {cat}: ${(amount as number).toFixed(2)}
              </div>
            ))
          )}
        </div>

        <h4 style={{ margin: "0 0 0.5rem 0" }}>Budget Status</h4>
        <div>
          {computed(() =>
            budgetStatus.map((status) => (
              <div
                style={{
                  padding: "0.5rem",
                  marginBottom: "0.25rem",
                  background:
                    status.percentUsed !== null && status.percentUsed > 100
                      ? "#fee"
                      : "#efe",
                  borderRadius: "4px",
                }}
              >
                <strong>{status.category}</strong>: ${status.spent.toFixed(2)}
                {status.limit !== null && (
                  <span>
                    / ${status.limit} ({status.percentUsed?.toFixed(0)}%)
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    ),
    totalSpent,
    spentByCategory,
    budgetStatus,
  };
});
