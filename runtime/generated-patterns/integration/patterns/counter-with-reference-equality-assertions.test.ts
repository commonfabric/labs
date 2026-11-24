import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterReferenceEqualityScenario: PatternIntegrationScenario<
  { value?: number }
> = {
  name: "counter maintains derived reference stability",
  module: new URL(
    "./counter-with-reference-equality-assertions.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithReferenceEqualityAssertions",
  steps: [
    {
      expect: [
        { path: "current", value: 0 },
        { path: "summary.value", value: 0 },
        { path: "summary.parity", value: "even" },
        { path: "summary.version", value: 0 },
        { path: "referenceStatus", value: { stable: true, confirmations: 1 } },
        { path: "label", value: "Value 0 is even" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 3 } }],
      expect: [
        { path: "current", value: 3 },
        { path: "summary.value", value: 3 },
        { path: "summary.parity", value: "odd" },
        { path: "summary.version", value: 1 },
        { path: "referenceStatus", value: { stable: false, confirmations: 0 } },
        { path: "label", value: "Value 3 is odd" },
      ],
    },
    {
      events: [{ stream: "override", payload: { value: 3 } }],
      expect: [
        { path: "current", value: 3 },
        { path: "summary.value", value: 3 },
        { path: "summary.parity", value: "odd" },
        { path: "summary.version", value: 1 },
        { path: "referenceStatus", value: { stable: true, confirmations: 1 } },
        { path: "label", value: "Value 3 is odd" },
      ],
    },
    {
      events: [{ stream: "override", payload: { value: 3 } }],
      expect: [
        { path: "summary.version", value: 1 },
        { path: "referenceStatus", value: { stable: true, confirmations: 2 } },
      ],
    },
    {
      events: [{ stream: "override", payload: { value: 6 } }],
      expect: [
        { path: "current", value: 6 },
        { path: "summary.value", value: 6 },
        { path: "summary.parity", value: "even" },
        { path: "referenceStatus", value: { stable: false, confirmations: 0 } },
        { path: "label", value: "Value 6 is even" },
      ],
    },
  ],
};

export const scenarios = [counterReferenceEqualityScenario];

describe("counter-with-reference-equality-assertions", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
