import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const budgetPlannerScenario: PatternIntegrationScenario<
  { total?: number; categories?: unknown }
> = {
  name: "budget planner enforces balanced allocations",
  module: new URL("./budget-planner.pattern.ts", import.meta.url),
  exportName: "budgetPlanner",
  steps: [
    {
      expect: [
        { path: "totalBudget", value: 4000 },
        { path: "allocatedTotal", value: 0 },
        { path: "remainingBudget", value: 4000 },
        { path: "overflowAmount", value: 0 },
        { path: "balanced", value: false },
        {
          path: "summaryLabel",
          value: "Allocated $0.00 of $4000.00 ($4000.00 remaining)",
        },
        { path: "statusMessage", value: "Remaining allocation $4000.00" },
        { path: "categorySummary.0.name", value: "Housing" },
        { path: "categorySummary.0.allocation", value: 0 },
        { path: "categorySummary.0.variance", value: -1800 },
        { path: "history", value: ["Budget initialized"] },
      ],
    },
    {
      events: [
        { stream: "allocate", payload: { category: "Housing", amount: 1500 } },
      ],
      expect: [
        { path: "categorySummary.0.allocation", value: 1500 },
        { path: "allocatedTotal", value: 1500 },
        { path: "remainingBudget", value: 2500 },
        {
          path: "summaryLabel",
          value: "Allocated $1500.00 of $4000.00 ($2500.00 remaining)",
        },
        {
          path: "lastAction",
          value:
            "Allocated $1500.00 to Housing (change $1500.00). Remaining $2500.00",
        },
        {
          path: "history.1",
          value:
            "Allocated $1500.00 to Housing (change $1500.00). Remaining $2500.00",
        },
      ],
    },
    {
      events: [
        { stream: "allocate", payload: { category: "Savings", amount: 2000 } },
      ],
      expect: [
        { path: "categorySummary.3.allocation", value: 2000 },
        { path: "allocatedTotal", value: 3500 },
        { path: "remainingBudget", value: 500 },
        {
          path: "statusMessage",
          value: "Remaining allocation $500.00",
        },
        {
          path: "history.2",
          value:
            "Allocated $2000.00 to Savings (change $2000.00). Remaining $500.00",
        },
      ],
    },
    {
      events: [
        { stream: "allocate", payload: { category: "Food", amount: 1000 } },
      ],
      expect: [
        { path: "categorySummary.1.allocation", value: 500 },
        { path: "remainingBudget", value: 0 },
        { path: "balanced", value: true },
        {
          path: "summaryLabel",
          value: "Allocated $4000.00 of $4000.00 ($0.00 remaining)",
        },
        {
          path: "lastAction",
          value: "Allocated $500.00 to Food (change $500.00). Remaining $0.00",
        },
        {
          path: "overflowAmount",
          value: 0,
        },
      ],
    },
    {
      events: [
        { stream: "allocate", payload: { category: "Leisure", amount: 600 } },
      ],
      expect: [
        { path: "categorySummary.4.allocation", value: 0 },
        { path: "remainingBudget", value: 0 },
        {
          path: "lastAction",
          value: "Allocated $0.00 to Leisure (change $0.00). Remaining $0.00",
        },
      ],
    },
    {
      events: [{ stream: "rebalance", payload: { mode: "even" } }],
      expect: [
        { path: "categorySummary.0.allocation", value: 800 },
        { path: "categorySummary.4.allocation", value: 800 },
        { path: "balanced", value: true },
        {
          path: "lastAction",
          value: "Distributed budget evenly across categories",
        },
      ],
    },
    {
      events: [{ stream: "rebalance", payload: {} }],
      expect: [
        { path: "categorySummary.0.allocation", value: 1800 },
        { path: "categorySummary.1.allocation", value: 600 },
        { path: "categorySummary.2.allocation", value: 400 },
        { path: "categorySummary.3.allocation", value: 800 },
        { path: "categorySummary.4.allocation", value: 400 },
        {
          path: "lastAction",
          value: "Distributed budget using target proportions",
        },
      ],
    },
    {
      events: [{ stream: "reset", payload: {} }],
      expect: [
        { path: "allocatedTotal", value: 0 },
        { path: "remainingBudget", value: 4000 },
        { path: "balanced", value: false },
        {
          path: "summaryLabel",
          value: "Allocated $0.00 of $4000.00 ($4000.00 remaining)",
        },
        {
          path: "lastAction",
          value: "Reset all allocations to $0.00",
        },
      ],
    },
  ],
};

export const scenarios = [budgetPlannerScenario];

describe("budget-planner", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
