import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterNestedParameterizedScenario: PatternIntegrationScenario<
  {
    configs?: Array<
      {
        id?: string;
        start?: number;
        step?: number;
        labelPrefix?: string;
      }
    >;
  }
> = {
  name: "nested parameterized children specialize by config",
  module: new URL(
    "./counter-nested-parameterized.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterNestedParameterized",
  argument: {
    configs: [
      { id: "alpha", start: 4, step: 2, labelPrefix: "Alpha" },
      { start: 0, step: 3, labelPrefix: "Beta" },
    ],
  },
  steps: [
    {
      expect: [
        { path: "childCount", value: 2 },
        { path: "summary", value: "Specializations alpha:2, child-2:3" },
        { path: "children.0.label", value: "Alpha (alpha) value 4" },
        { path: "children.0.step", value: 2 },
        { path: "children.1.label", value: "Beta (child-2) value 0" },
        { path: "children.1.step", value: 3 },
        { path: "manifest.0.labelPrefix", value: "Alpha" },
        { path: "manifest.1.labelPrefix", value: "Beta" },
      ],
    },
    {
      events: [{ stream: "children.0.increment", payload: {} }],
      expect: [
        { path: "children.0.value", value: 6 },
        { path: "children.0.label", value: "Alpha (alpha) value 6" },
      ],
    },
    {
      events: [{ stream: "children.1.increment", payload: { cycles: 2 } }],
      expect: [
        { path: "children.1.value", value: 6 },
        { path: "children.1.label", value: "Beta (child-2) value 6" },
        { path: "children.1.summary", value: "child-2 step 3" },
      ],
    },
    {
      events: [{
        stream: "configure",
        payload: {
          configs: [
            { id: "gamma", start: 5, step: 4, labelPrefix: "Gamma" },
            { id: "alpha", start: 7, step: 2 },
          ],
        },
      }],
      expect: [
        { path: "childCount", value: 2 },
        { path: "summary", value: "Specializations gamma:4, alpha:2" },
        { path: "children.0.label", value: "Gamma (gamma) value 5" },
        { path: "children.0.step", value: 4 },
        { path: "children.1.label", value: "Child (alpha) value 7" },
        { path: "children.1.step", value: 2 },
        { path: "manifest.0.labelPrefix", value: "Gamma" },
        { path: "manifest.1.labelPrefix", value: "Child" },
        { path: "manifest.1.start", value: 7 },
      ],
    },
    {
      events: [{ stream: "children.1.increment", payload: { cycles: 3 } }],
      expect: [
        { path: "children.1.value", value: 13 },
        { path: "children.1.label", value: "Child (alpha) value 13" },
        { path: "children.1.summary", value: "alpha step 2" },
      ],
    },
  ],
};

export const scenarios = [counterNestedParameterizedScenario];

describe("counter-nested-parameterized", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
