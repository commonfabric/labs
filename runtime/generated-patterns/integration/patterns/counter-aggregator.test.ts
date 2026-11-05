import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterAggregatorScenario: PatternIntegrationScenario<
  {
    counters?: Array<{ id?: string; label?: string; value?: number }>;
  }
> = {
  name: "counter aggregator derives totals from nested counters",
  module: new URL("./counter-aggregator.pattern.ts", import.meta.url),
  exportName: "counterAggregator",
  argument: {
    counters: [
      { id: "north", label: "North Branch", value: 12 },
      { id: "south", value: 5 },
      { label: "Warehouse", value: -2 },
    ],
  },
  steps: [
    {
      expect: [
        { path: "counters.0.id", value: "north" },
        { path: "counters.0.label", value: "North Branch" },
        { path: "counters.0.value", value: 12 },
        { path: "counters.1.id", value: "south" },
        { path: "counters.1.label", value: "Counter 2" },
        { path: "counters.1.value", value: 5 },
        { path: "counters.2.id", value: "counter-3" },
        { path: "counters.2.label", value: "Warehouse" },
        { path: "counters.2.value", value: -2 },
        { path: "values", value: [12, 5, -2] },
        {
          path: "labels",
          value: ["North Branch", "Counter 2", "Warehouse"],
        },
        { path: "total", value: 15 },
        { path: "count", value: 3 },
        { path: "largest", value: 12 },
        {
          path: "summary",
          value: "Aggregate total 15 across 3 counters",
        },
      ],
    },
    {
      events: [
        { stream: "adjust", payload: { id: "south", delta: 4 } },
      ],
      expect: [
        { path: "counters.1.value", value: 9 },
        { path: "values", value: [12, 9, -2] },
        {
          path: "labels",
          value: ["North Branch", "Counter 2", "Warehouse"],
        },
        { path: "total", value: 19 },
        { path: "count", value: 3 },
        { path: "largest", value: 12 },
        {
          path: "summary",
          value: "Aggregate total 19 across 3 counters",
        },
      ],
    },
    {
      events: [
        {
          stream: "append",
          payload: { id: "east", label: "East Branch", value: 7 },
        },
      ],
      expect: [
        { path: "counters.3.id", value: "east" },
        { path: "counters.3.label", value: "East Branch" },
        { path: "counters.3.value", value: 7 },
        { path: "values", value: [12, 9, -2, 7] },
        {
          path: "labels",
          value: [
            "North Branch",
            "Counter 2",
            "Warehouse",
            "East Branch",
          ],
        },
        { path: "total", value: 26 },
        { path: "count", value: 4 },
        { path: "largest", value: 12 },
        {
          path: "summary",
          value: "Aggregate total 26 across 4 counters",
        },
      ],
    },
    {
      events: [
        { stream: "append", payload: { label: "West Branch", value: 4 } },
      ],
      expect: [
        { path: "counters.4.id", value: "counter-5" },
        { path: "counters.4.label", value: "West Branch" },
        { path: "counters.4.value", value: 4 },
        { path: "values", value: [12, 9, -2, 7, 4] },
        {
          path: "labels",
          value: [
            "North Branch",
            "Counter 2",
            "Warehouse",
            "East Branch",
            "West Branch",
          ],
        },
        { path: "total", value: 30 },
        { path: "count", value: 5 },
        { path: "largest", value: 12 },
        {
          path: "summary",
          value: "Aggregate total 30 across 5 counters",
        },
      ],
    },
    {
      events: [
        { stream: "adjust", payload: { id: "east", set: 15 } },
      ],
      expect: [
        { path: "counters.3.value", value: 15 },
        { path: "values", value: [12, 9, -2, 15, 4] },
        {
          path: "labels",
          value: [
            "North Branch",
            "Counter 2",
            "Warehouse",
            "East Branch",
            "West Branch",
          ],
        },
        { path: "total", value: 38 },
        { path: "count", value: 5 },
        { path: "largest", value: 15 },
        {
          path: "summary",
          value: "Aggregate total 38 across 5 counters",
        },
      ],
    },
  ],
};

export const scenarios = [counterAggregatorScenario];

describe("counter-aggregator", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
