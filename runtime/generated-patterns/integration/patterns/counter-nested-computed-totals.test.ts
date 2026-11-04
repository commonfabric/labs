import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterNestedComputedTotalsScenario: PatternIntegrationScenario<
  { groups?: Array<{ label?: string; values?: number[] }> }
> = {
  name: "nested subgroups roll into grand total",
  module: new URL(
    "./counter-nested-computed-totals.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithNestedComputedTotals",
  argument: {
    groups: [
      { label: "Alpha", values: [4, 1] },
      { label: "  ", values: [3, 2] },
      { values: [10] },
    ],
  },
  steps: [
    {
      expect: [
        { path: "groupCount", value: 3 },
        { path: "totalItems", value: 5 },
        { path: "groups.0.label", value: "Alpha" },
        { path: "groups.1.label", value: "Group 2" },
        { path: "groups.2.label", value: "Group 3" },
        { path: "groups.0.items", value: [4, 1] },
        { path: "groups.1.items", value: [3, 2] },
        { path: "groups.2.items", value: [10] },
        { path: "groups.0.subtotal", value: 5 },
        { path: "groups.1.subtotal", value: 5 },
        { path: "groups.2.subtotal", value: 10 },
        { path: "groups.1.subtotalLabel", value: "Group 2 subtotal 5" },
        { path: "groupTotals", value: [5, 5, 10] },
        {
          path: "summary",
          value: "Alpha: 5 | Group 2: 5 | Group 3: 10 => total 20",
        },
        { path: "grandTotal", value: 20 },
      ],
    },
    {
      events: [
        { stream: "groups.1.append", payload: { value: 7 } },
      ],
      expect: [
        { path: "groups.1.items", value: [3, 2, 7] },
        { path: "groups.1.subtotal", value: 12 },
        { path: "groupTotals", value: [5, 12, 10] },
        {
          path: "summary",
          value: "Alpha: 5 | Group 2: 12 | Group 3: 10 => total 27",
        },
        { path: "grandTotal", value: 27 },
        { path: "totalItems", value: 6 },
      ],
    },
    {
      events: [
        { stream: "appendToGroup", payload: { index: 0, value: 6 } },
      ],
      expect: [
        { path: "groups.0.items", value: [4, 1, 6] },
        { path: "groups.0.subtotal", value: 11 },
        { path: "groupTotals", value: [11, 12, 10] },
        {
          path: "summary",
          value: "Alpha: 11 | Group 2: 12 | Group 3: 10 => total 33",
        },
        { path: "grandTotal", value: 33 },
        { path: "totalItems", value: 7 },
      ],
    },
    {
      events: [
        { stream: "appendToGroup", payload: { label: "Group 3", value: -4 } },
      ],
      expect: [
        { path: "groups.2.items", value: [10, -4] },
        { path: "groups.2.subtotal", value: 6 },
        { path: "groupTotals", value: [11, 12, 6] },
        {
          path: "summary",
          value: "Alpha: 11 | Group 2: 12 | Group 3: 6 => total 29",
        },
        { path: "grandTotal", value: 29 },
        { path: "totalItems", value: 8 },
      ],
    },
    {
      events: [
        // Sanitized by the pattern's own `sanitizeNumber` (non-finite -> 0):
        // the event carries `NaN` faithfully, and the handler catches it.
        { stream: "groups.0.append", payload: { value: Number.NaN } },
        { stream: "groups.0.append", payload: { value: 0 } },
        { stream: "appendToGroup", payload: { index: 9, value: 100 } },
      ],
      expect: [
        { path: "groups.0.items", value: [4, 1, 6, 0, 0] },
        { path: "groups.0.subtotal", value: 11 },
        { path: "groupTotals", value: [11, 12, 6] },
        { path: "grandTotal", value: 29 },
        { path: "totalItems", value: 10 },
      ],
    },
  ],
};

export const scenarios = [counterNestedComputedTotalsScenario];

describe("counter-nested-computed-totals", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
