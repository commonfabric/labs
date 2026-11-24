import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterCrossFieldValidationScenario: PatternIntegrationScenario<
  { value?: number; limit?: number; step?: number }
> = {
  name: "counter flags cross-field validation error",
  module: new URL(
    "./counter-cross-field-validation.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithCrossFieldValidation",
  argument: { value: 0, limit: 10, step: 1 },
  steps: [
    {
      expect: [
        { path: "currentValue", value: 0 },
        { path: "limitValue", value: 10 },
        { path: "difference", value: -10 },
        { path: "hasError", value: false },
        { path: "summary", value: "Value 0 / Limit 10 (Δ -10)" },
        { path: "auditTrail", value: [] },
      ],
    },
    {
      events: [{ stream: "adjustValue", payload: { amount: 4 } }],
      expect: [
        { path: "currentValue", value: 4 },
        { path: "limitValue", value: 10 },
        { path: "difference", value: -6 },
        { path: "hasError", value: false },
        { path: "summary", value: "Value 4 / Limit 10 (Δ -6)" },
        {
          path: "auditTrail",
          value: [{ value: 4, limit: 10, hasError: false }],
        },
      ],
    },
    {
      events: [{ stream: "updateLimit", payload: { limit: 2 } }],
      expect: [
        { path: "currentValue", value: 4 },
        { path: "limitValue", value: 2 },
        { path: "difference", value: 2 },
        { path: "hasError", value: true },
        { path: "summary", value: "Value 4 / Limit 2 (Δ 2)" },
        {
          path: "auditTrail",
          value: [
            { value: 4, limit: 10, hasError: false },
            { value: 4, limit: 2, hasError: true },
          ],
        },
      ],
    },
    {
      events: [{ stream: "adjustValue", payload: { amount: -3 } }],
      expect: [
        { path: "currentValue", value: 1 },
        { path: "limitValue", value: 2 },
        { path: "difference", value: -1 },
        { path: "hasError", value: false },
        { path: "summary", value: "Value 1 / Limit 2 (Δ -1)" },
        {
          path: "auditTrail",
          value: [
            { value: 4, limit: 10, hasError: false },
            { value: 4, limit: 2, hasError: true },
            { value: 1, limit: 2, hasError: false },
          ],
        },
      ],
    },
  ],
};

export const scenarios = [counterCrossFieldValidationScenario];

describe("counter-cross-field-validation", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
