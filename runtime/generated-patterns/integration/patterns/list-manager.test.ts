import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface ListManagerScenarioArgs {
  items?: { label: string; count: number }[];
}

export const listManagerScenario: PatternIntegrationScenario<
  ListManagerScenarioArgs
> = {
  name: "list manager updates nested items",
  module: new URL("./list-manager.pattern.ts", import.meta.url),
  exportName: "listManager",
  argument: { items: [{ label: "Alpha", count: 1 }] },
  steps: [
    {
      expect: [
        { path: "items.0.label", value: "Alpha" },
        { path: "items.0.count", value: 1 },
        { path: "summary", value: "Items: 1" },
        { path: "names.0", value: "Alpha" },
      ],
    },
    {
      events: [
        {
          stream: "controls.add",
          payload: { label: "Beta", count: 2 },
        },
      ],
      expect: [
        { path: "items.1.label", value: "Beta" },
        { path: "items.1.count", value: 2 },
        { path: "summary", value: "Items: 2" },
        { path: "names.1", value: "Beta" },
      ],
    },
    {
      events: [
        {
          stream: "controls.increment",
          payload: { index: 1, amount: 3 },
        },
      ],
      expect: [
        { path: "items.1.count", value: 5 },
        { path: "summary", value: "Items: 2" },
      ],
    },
    {
      events: [
        {
          stream: "controls.add",
          payload: { label: "Gamma" },
        },
      ],
      expect: [
        { path: "items.2.label", value: "Gamma" },
        { path: "items.2.count", value: 0 },
        { path: "summary", value: "Items: 3" },
        { path: "names.2", value: "Gamma" },
      ],
    },
  ],
};

export const scenarios = [listManagerScenario];

describe("list-manager", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
