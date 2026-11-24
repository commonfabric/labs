import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterParentChildBubbleScenario: PatternIntegrationScenario<
  { parent?: number; child?: number }
> = {
  name: "parent handler forwards events into child increment",
  module: new URL(
    "./counter-parent-child-bubble.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithParentChildBubbling",
  steps: [
    {
      expect: [
        { path: "parentValue", value: 0 },
        { path: "child.value", value: 0 },
        { path: "child.label", value: "Child count 0" },
        { path: "forwardedCount", value: 0 },
        { path: "bubbleHistory", value: [] },
      ],
    },
    {
      events: [
        {
          stream: "bubbleToChild",
          payload: { amount: 2, via: "parent-step" },
        },
      ],
      expect: [
        { path: "parentValue", value: 2 },
        { path: "child.value", value: 2 },
        { path: "child.label", value: "Child count 2" },
        { path: "forwardedCount", value: 1 },
        { path: "bubbleHistory.0.amount", value: 2 },
        { path: "bubbleHistory.0.via", value: "parent-step" },
      ],
    },
    {
      events: [
        { stream: "child.increment", payload: { amount: 5 } },
      ],
      expect: [
        { path: "parentValue", value: 2 },
        { path: "child.value", value: 7 },
        { path: "child.label", value: "Child count 7" },
        { path: "forwardedCount", value: 1 },
      ],
    },
    {
      events: [
        { stream: "bubbleToChild", payload: { amount: "oops" } },
      ],
      expect: [
        { path: "parentValue", value: 3 },
        { path: "child.value", value: 8 },
        { path: "child.label", value: "Child count 8" },
        { path: "forwardedCount", value: 2 },
        { path: "bubbleHistory.1.amount", value: 1 },
        { path: "bubbleHistory.1.via", value: "parent" },
      ],
    },
    {
      events: [
        { stream: "parentIncrement", payload: { amount: 4 } },
      ],
      expect: [
        { path: "parentValue", value: 7 },
        { path: "child.value", value: 8 },
        { path: "forwardedCount", value: 2 },
        {
          path: "bubbleHistory",
          value: [
            { amount: 2, via: "parent-step" },
            { amount: 1, via: "parent" },
          ],
        },
      ],
    },
  ],
};

export const scenarios = [counterParentChildBubbleScenario];

describe("counter-parent-child-bubble", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
