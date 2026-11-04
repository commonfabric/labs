import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterComputedDefaultStringsScenario: PatternIntegrationScenario<
  { value?: number; prefix?: string }
> = {
  name: "counter computes default label from numeric value",
  module: new URL(
    "./counter-computed-default-strings.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithComputedDefaultStrings",
  argument: {
    value: 3,
    prefix: "Total",
  },
  steps: [
    {
      expect: [
        { path: "current", value: 3 },
        { path: "fallbackLabel", value: "Total 3" },
        { path: "label", value: "Total 3" },
        { path: "summary", value: "Total 3 (current: 3)" },
        { path: "overrides.label", value: null },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [
        { path: "current", value: 5 },
        { path: "fallbackLabel", value: "Total 5" },
        { path: "label", value: "Total 5" },
        { path: "summary", value: "Total 5 (current: 5)" },
      ],
    },
    {
      events: [{ stream: "setLabel", payload: { text: "Primary total" } }],
      expect: [
        { path: "current", value: 5 },
        { path: "fallbackLabel", value: "Total 5" },
        { path: "label", value: "Primary total" },
        { path: "summary", value: "Primary total (current: 5)" },
        { path: "overrides.label", value: "Primary total" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: -3 } }],
      expect: [
        { path: "current", value: 2 },
        { path: "fallbackLabel", value: "Total 2" },
        {
          path: "label",
          value: "Primary total",
        },
        { path: "summary", value: "Primary total (current: 2)" },
      ],
    },
    {
      events: [{ stream: "setLabel", payload: {} }],
      expect: [
        { path: "current", value: 2 },
        { path: "fallbackLabel", value: "Total 2" },
        { path: "label", value: "Total 2" },
        { path: "summary", value: "Total 2 (current: 2)" },
        { path: "overrides.label", value: null },
      ],
    },
  ],
};

export const scenarios = [counterComputedDefaultStringsScenario];

describe("counter-computed-default-strings", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
