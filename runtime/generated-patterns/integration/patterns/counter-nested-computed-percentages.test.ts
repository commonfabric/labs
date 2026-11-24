import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterNestedComputedPercentagesScenario:
  PatternIntegrationScenario<
    {
      groups?: Array<
        {
          label?: string;
          items?: Array<{ label?: string; value?: number }>;
        }
      >;
    }
  > = {
    name: "nested contributions compute group and item percentages",
    module: new URL(
      "./counter-nested-computed-percentages.pattern.ts",
      import.meta.url,
    ),
    exportName: "counterWithNestedComputedPercentages",
    argument: {
      groups: [
        {
          label: "Product",
          items: [
            { label: "North", value: 120 },
            { label: "South", value: 80 },
          ],
        },
        {
          label: "Services",
          items: [
            { label: "North", value: 50 },
            { label: "South", value: 50 },
          ],
        },
      ],
    },
    steps: [
      {
        expect: [
          { path: "grandTotal", value: 300 },
          {
            path: "groupSummaries",
            value: [
              "Product: 200 (66.67%)",
              "Services: 100 (33.33%)",
            ],
          },
          {
            path: "groupBreakdown.0.percentOfTotal",
            value: 66.67,
          },
          {
            path: "groupBreakdown.0.items.0.percentOfTotal",
            value: 40,
          },
          {
            path: "groupBreakdown.0.items.1.percentOfTotal",
            value: 26.67,
          },
          {
            path: "groupBreakdown.1.items.0.percentOfGroup",
            value: 50,
          },
          {
            path: "sanitizedGroups.1.total",
            value: 100,
          },
          {
            path: "label",
            value: "Grand total 300: Product: 200 (66.67%) | Services: 100 " +
              "(33.33%) | Top Product is 66.67%",
          },
        ],
      },
      {
        events: [
          {
            stream: "recordContribution",
            payload: {
              groupIndex: 1,
              value: 30,
              itemLabel: "Support",
            },
          },
        ],
        expect: [
          { path: "grandTotal", value: 330 },
          {
            path: "sanitizedGroups.1.items.2.label",
            value: "Support",
          },
          {
            path: "sanitizedGroups.1.total",
            value: 130,
          },
          {
            path: "groupBreakdown.1.percentOfTotal",
            value: 39.39,
          },
          {
            path: "groupBreakdown.1.items.2.percentOfTotal",
            value: 9.09,
          },
          {
            path: "label",
            value: "Grand total 330: Product: 200 (60.61%) | Services: 130 " +
              "(39.39%) | Top Product is 60.61%",
          },
        ],
      },
      {
        events: [
          {
            stream: "recordContribution",
            payload: {
              groupIndex: 0,
              itemIndex: 1,
              value: 90,
              itemLabel: "South Ops",
            },
          },
        ],
        expect: [
          { path: "grandTotal", value: 340 },
          {
            path: "sanitizedGroups.0.items.1.label",
            value: "South Ops",
          },
          {
            path: "sanitizedGroups.0.total",
            value: 210,
          },
          {
            path: "groupBreakdown.0.percentOfTotal",
            value: 61.76,
          },
          {
            path: "groupBreakdown.0.items.1.percentOfGroup",
            value: 42.86,
          },
          {
            path: "label",
            value: "Grand total 340: Product: 210 (61.76%) | Services: 130 " +
              "(38.24%) | Top Product is 61.76%",
          },
        ],
      },
    ],
  };

export const scenarios = [counterNestedComputedPercentagesScenario];

describe("counter-nested-computed-percentages", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
