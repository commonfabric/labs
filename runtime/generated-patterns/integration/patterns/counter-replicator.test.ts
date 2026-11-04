import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterReplicatorScenario: PatternIntegrationScenario<
  { seeds?: number[] }
> = {
  name: "counter replicator creates independent children",
  module: new URL(
    "./counter-replicator.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterReplicator",
  argument: { seeds: [1, 4, 7] },
  steps: [
    {
      expect: [
        { path: "summary", value: "Replicas 3 total 12" },
        { path: "replicas.0.value", value: 1 },
        { path: "replicas.1.value", value: 4 },
        { path: "replicas.2.value", value: 7 },
      ],
    },
    {
      events: [{
        stream: "replicas.0.controls.increment",
        payload: {},
      }],
      expect: [
        { path: "replicas.0.value", value: 2 },
        { path: "summary", value: "Replicas 3 total 13" },
      ],
    },
    {
      events: [{
        stream: "replicas.1.controls.increment",
        payload: { amount: 3 },
      }],
      expect: [
        { path: "replicas.1.value", value: 7 },
        { path: "summary", value: "Replicas 3 total 16" },
      ],
    },
    {
      events: [{
        stream: "replicas.2.controls.increment",
        payload: { amount: -10 },
      }],
      expect: [
        { path: "replicas.2.value", value: -3 },
        { path: "total", value: 6 },
        { path: "summary", value: "Replicas 3 total 6" },
      ],
    },
  ],
};

export const scenarios = [counterReplicatorScenario];

describe("counter-replicator", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
