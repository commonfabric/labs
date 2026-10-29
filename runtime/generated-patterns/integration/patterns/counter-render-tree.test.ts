import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterRenderTreeScenario: PatternIntegrationScenario<
  { step?: number }
> = {
  name: "counter exposes render tree with handlers",
  module: new URL(
    "./counter-render-tree.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithRenderTree",
  argument: { step: 2 },
  steps: [
    {
      expect: [
        { path: "value", value: 0 },
        { path: "step", value: 2 },
        { path: "heading", value: "Value 0" },
        { path: "renderTree.body.description", value: "Step size 2" },
        {
          path: "renderTree.body.controls.increase.label",
          value: "Add 2",
        },
        {
          path: "renderTree.body.controls.decrease.label",
          value: "Subtract 2",
        },
      ],
    },
    {
      events: [{
        stream: "renderTree.body.controls.increase.onPress",
        payload: {},
      }],
      expect: [
        { path: "value", value: 2 },
        { path: "heading", value: "Value 2" },
      ],
    },
    {
      events: [{
        stream: "renderTree.body.controls.decrease.onPress",
        payload: { amount: 5 },
      }],
      expect: [
        { path: "value", value: -3 },
        { path: "heading", value: "Value -3" },
      ],
    },
  ],
};

export const scenarios = [counterRenderTreeScenario];

describe("counter-render-tree", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
