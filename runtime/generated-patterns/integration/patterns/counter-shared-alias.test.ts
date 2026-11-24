import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterSharedAliasScenario: PatternIntegrationScenario<
  { value?: number }
> = {
  name: "counter exposes shared alias across branches",
  module: new URL("./counter-shared-alias.pattern.ts", import.meta.url),
  exportName: "counterWithSharedAlias",
  steps: [
    {
      expect: [
        { path: "current", value: 0 },
        { path: "mirrors.left", value: 0 },
        { path: "mirrors.right", value: 0 },
        { path: "label", value: "Value 0" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [
        { path: "current", value: 2 },
        { path: "mirrors.left", value: 2 },
        { path: "mirrors.right", value: 2 },
        { path: "label", value: "Value 2" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: -1 } }],
      expect: [
        { path: "current", value: 1 },
        { path: "mirrors.left", value: 1 },
        { path: "mirrors.right", value: 1 },
        { path: "label", value: "Value 1" },
      ],
    },
  ],
};

export const scenarios = [counterSharedAliasScenario];

describe("counter-shared-alias", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
