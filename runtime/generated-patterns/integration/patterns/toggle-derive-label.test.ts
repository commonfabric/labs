import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const toggleWithLabelScenario: PatternIntegrationScenario<
  { active?: boolean }
> = {
  name: "toggle derives status label",
  module: new URL("./toggle-derive-label.pattern.ts", import.meta.url),
  exportName: "toggleWithLabel",
  argument: { active: false },
  steps: [
    {
      expect: [
        { path: "active", value: false },
        { path: "status", value: "disabled" },
      ],
    },
    {
      events: [{ stream: "toggle", payload: {} }],
      expect: [
        { path: "active", value: true },
        { path: "status", value: "enabled" },
      ],
    },
    {
      events: [{ stream: "toggle", payload: {} }],
      expect: [
        { path: "active", value: false },
        { path: "status", value: "disabled" },
      ],
    },
  ],
};

export const scenarios = [toggleWithLabelScenario];

describe("toggle-derive-label", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
