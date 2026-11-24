import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface Item {
  id?: string;
}

interface MinimalConflictReproArgument {
  items?: Item[];
}

export const minimalLeadScoringScenario: PatternIntegrationScenario<
  MinimalConflictReproArgument
> = {
  name: "minimal conflict repro",
  module: new URL("./minimal-conflict-repro.pattern.ts", import.meta.url),
  exportName: "conflictRepro",
  argument: {
    items: [
      {
        id: "acme",
      },
    ],
  },
  steps: [
    {
      events: [{
        stream: "action",
        payload: {},
      }],
      expect: [],
    },
  ],
};

export const scenarios = [minimalLeadScoringScenario];

describe("minimal conflict repro", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
