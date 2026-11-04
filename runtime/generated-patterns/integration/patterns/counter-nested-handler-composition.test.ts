import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterNestedHandlerCompositionScenario:
  PatternIntegrationScenario = {
    name: "nested handler composition pipelines",
    module: new URL(
      "./counter-nested-handler-composition.pattern.ts",
      import.meta.url,
    ),
    exportName: "counterWithNestedHandlerComposition",
    steps: [
      {
        expect: [
          { path: "value", value: 0 },
          { path: "stats.prepared", value: 0 },
          { path: "stats.applied", value: 0 },
          { path: "stageStatus", value: "idle" },
          { path: "history", value: [] },
          { path: "lastPrepared.delta", value: 0 },
          { path: "lastPrepared.tag", value: "pipeline" },
          { path: "label", value: "0 prepared, 0 applied" },
        ],
      },
      {
        events: [
          {
            stream: "pipeline.stage",
            payload: { amount: 2, multiplier: 4, tag: "stage-only" },
          },
        ],
        expect: [
          { path: "value", value: 0 },
          { path: "stats.prepared", value: 1 },
          { path: "stats.applied", value: 0 },
          { path: "stageStatus", value: "staged:stage-only" },
          { path: "lastPrepared.delta", value: 8 },
          { path: "lastPrepared.tag", value: "stage-only" },
          { path: "history", value: [] },
          { path: "label", value: "1 prepared, 0 applied" },
        ],
      },
      {
        events: [{ stream: "pipeline.commit", payload: {} }],
        expect: [
          { path: "value", value: 8 },
          { path: "stats.prepared", value: 1 },
          { path: "stats.applied", value: 1 },
          { path: "stageStatus", value: "idle" },
          { path: "history.0.value", value: 8 },
          { path: "history.0.delta", value: 8 },
          { path: "history.0.tag", value: "stage-only" },
          { path: "label", value: "1 prepared, 1 applied" },
        ],
      },
      {
        events: [
          {
            stream: "pipeline.process",
            payload: { amount: 3, multiplier: 2, tag: "composed" },
          },
        ],
        expect: [
          { path: "value", value: 14 },
          { path: "stats.prepared", value: 2 },
          { path: "stats.applied", value: 2 },
          { path: "stageStatus", value: "idle" },
          { path: "lastPrepared.delta", value: 6 },
          { path: "lastPrepared.tag", value: "composed" },
          { path: "history.1.value", value: 14 },
          { path: "history.1.delta", value: 6 },
          { path: "history.1.tag", value: "composed" },
          { path: "label", value: "2 prepared, 2 applied" },
        ],
      },
    ],
  };

export const scenarios = [counterNestedHandlerCompositionScenario];

describe("counter-nested-handler-composition", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
