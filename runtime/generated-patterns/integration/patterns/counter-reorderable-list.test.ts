import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterReorderableListScenario: PatternIntegrationScenario<
  { items?: number[] }
> = {
  name: "counter reorders list entries",
  module: new URL("./counter-reorderable-list.pattern.ts", import.meta.url),
  exportName: "counterWithReorderableList",
  argument: { items: [2, 4, 6, 8] },
  steps: [
    {
      expect: [
        { path: "items", value: [2, 4, 6, 8] },
        {
          path: "positions",
          value: [
            { index: 0, value: 2 },
            { index: 1, value: 4 },
            { index: 2, value: 6 },
            { index: 3, value: 8 },
          ],
        },
        { path: "size", value: 4 },
        { path: "label", value: "Order: 2 -> 4 -> 6 -> 8" },
      ],
    },
    {
      events: [{ stream: "reorder", payload: { from: 0, to: 3 } }],
      expect: [
        { path: "items", value: [4, 6, 8, 2] },
        {
          path: "positions",
          value: [
            { index: 0, value: 4 },
            { index: 1, value: 6 },
            { index: 2, value: 8 },
            { index: 3, value: 2 },
          ],
        },
        { path: "label", value: "Order: 4 -> 6 -> 8 -> 2" },
      ],
    },
    {
      events: [{ stream: "reorder", payload: { from: 2, to: 0 } }],
      expect: [
        { path: "items", value: [8, 4, 6, 2] },
        {
          path: "positions",
          value: [
            { index: 0, value: 8 },
            { index: 1, value: 4 },
            { index: 2, value: 6 },
            { index: 3, value: 2 },
          ],
        },
        { path: "label", value: "Order: 8 -> 4 -> 6 -> 2" },
      ],
    },
    {
      events: [{ stream: "reorder", payload: { from: 10, to: -2 } }],
      expect: [
        { path: "items", value: [2, 8, 4, 6] },
        {
          path: "positions",
          value: [
            { index: 0, value: 2 },
            { index: 1, value: 8 },
            { index: 2, value: 4 },
            { index: 3, value: 6 },
          ],
        },
        { path: "label", value: "Order: 2 -> 8 -> 4 -> 6" },
      ],
    },
  ],
};

export const scenarios = [counterReorderableListScenario];

describe("counter-reorderable-list", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
