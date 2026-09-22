import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";

import { textContent } from "../test/vnode-helpers.ts";
import BudgetVsActual, { type SpendRow } from "./budget-vs-actual.tsx";

export default pattern(() => {
  const spend = new Writable<SpendRow[]>([
    { category: "FOOD_AND_DRINK", total: 80 },
    { category: "food-and-drink", total: 30 },
    { category: "TRANSPORTATION", total: 20 },
  ]);
  const comparison = BudgetVsActual({
    budgets: [
      { category: "groceries", budget: 100 },
      { category: "transport", budget: 50 },
    ],
    spend,
  });
  const names = BudgetVsActual({
    budgets: [
      { category: "constructor", budget: 10 },
      { category: "__proto__", budget: 20 },
    ],
    spend: [{ category: "FOOD_AND_DRINK", total: 30 }],
  });

  return {
    [TESTS]: [
      { assertion: assert(() => comparison.rows[0].actual === 110) },
      { assertion: assert(() => comparison.totalActual === 130) },
      { assertion: assert(() => comparison.unmatchedSpend.length === 0) },
      { assertion: assert(() => comparison.rows[0].matchedVia === "alias") },
      { assertion: assert(() => comparison.overCount === 1) },
      {
        assertion: assert(() =>
          textContent(comparison[UI]).includes("FOOD_AND_DRINK") &&
          textContent(comparison[UI]).includes("TRANSPORTATION") &&
          textContent(comparison[UI]).indexOf("FOOD_AND_DRINK") <
            textContent(comparison[UI]).indexOf("TRANSPORTATION")
        ),
      },
      {
        action: action(() =>
          spend.set([
            { category: "FOOD_AND_DRINK", total: 10 },
            { category: "TRANSPORTATION", total: 100 },
          ])
        ),
      },
      {
        assertion: assert(() =>
          comparison.rows[0].category === "TRANSPORTATION"
        ),
      },
      {
        assertion: assert(() =>
          textContent(comparison[UI]).includes("FOOD_AND_DRINK") &&
          textContent(comparison[UI]).includes("TRANSPORTATION") &&
          textContent(comparison[UI]).indexOf("TRANSPORTATION") <
            textContent(comparison[UI]).indexOf("FOOD_AND_DRINK")
        ),
      },
      { assertion: assert(() => names.unmatchedBudgets.length === 2) },
      { assertion: assert(() => names.rows.length === 0) },
    ],
  };
});
