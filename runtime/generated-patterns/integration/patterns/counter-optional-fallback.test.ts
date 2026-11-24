import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterOptionalFallbackScenario: PatternIntegrationScenario<
  { value?: number; defaultValue?: number }
> = {
  name: "counter falls back to optional default argument",
  module: new URL(
    "./counter-optional-fallback.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithOptionalFallback",
  steps: [
    {
      expect: [
        { path: "current", value: 10 },
        { path: "effectiveDefault", value: 10 },
        { path: "label", value: "Value 10 (default 10)" },
      ],
    },
    {
      events: [{ stream: "increment", payload: {} }],
      expect: [
        { path: "current", value: 11 },
        { path: "label", value: "Value 11 (default 10)" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 4 } }],
      expect: [
        { path: "current", value: 15 },
        { path: "label", value: "Value 15 (default 10)" },
      ],
    },
  ],
};

export const scenarios = [counterOptionalFallbackScenario];

describe("counter-optional-fallback", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
