import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterToggledDerivePipelinesScenario: PatternIntegrationScenario<
  { count?: number; mode?: "double" | "mirror" }
> = {
  name: "counter toggles derive pipeline functions by mode",
  module: new URL(
    "./counter-toggled-derive-pipelines.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithToggledDerivePipelines",
  steps: [
    {
      expect: [
        { path: "pipelineName", value: "double" },
        { path: "mappedValue", value: 0 },
        { path: "status", value: "0 doubled to 0" },
        { path: "label", value: "double mapped 0" },
        { path: "mode", value: "double" },
        { path: "pipelineHistory", value: [] },
        { path: "switchCount", value: 0 },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 3 } }],
      expect: [
        { path: "pipelineName", value: "double" },
        { path: "mappedValue", value: 6 },
        { path: "status", value: "3 doubled to 6" },
        { path: "label", value: "double mapped 6" },
        { path: "mode", value: "double" },
        { path: "pipelineHistory", value: [] },
        { path: "switchCount", value: 0 },
      ],
    },
    {
      events: [{ stream: "togglePipeline", payload: { mode: "mirror" } }],
      expect: [
        { path: "mode", value: "mirror" },
        { path: "pipelineName", value: "mirror" },
        { path: "mappedValue", value: -3 },
        { path: "status", value: "3 mirrored to -3" },
        { path: "label", value: "mirror mapped -3" },
        { path: "pipelineHistory", value: ["mirror"] },
        { path: "switchCount", value: 1 },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [
        { path: "pipelineName", value: "mirror" },
        { path: "mappedValue", value: -5 },
        { path: "status", value: "5 mirrored to -5" },
        { path: "label", value: "mirror mapped -5" },
        { path: "mode", value: "mirror" },
        { path: "pipelineHistory", value: ["mirror"] },
        { path: "switchCount", value: 1 },
      ],
    },
    {
      events: [{ stream: "togglePipeline", payload: {} }],
      expect: [
        { path: "pipelineName", value: "double" },
        { path: "mappedValue", value: 10 },
        { path: "status", value: "5 doubled to 10" },
        { path: "label", value: "double mapped 10" },
        { path: "mode", value: "double" },
        { path: "pipelineHistory", value: ["mirror", "double"] },
        { path: "switchCount", value: 2 },
      ],
    },
    {
      events: [{ stream: "togglePipeline", payload: {} }],
      expect: [
        { path: "pipelineName", value: "mirror" },
        { path: "mappedValue", value: -5 },
        { path: "status", value: "5 mirrored to -5" },
        { path: "label", value: "mirror mapped -5" },
        { path: "mode", value: "mirror" },
        { path: "pipelineHistory", value: ["mirror", "double", "mirror"] },
        { path: "switchCount", value: 3 },
      ],
    },
  ],
};

export const scenarios = [counterToggledDerivePipelinesScenario];

describe("counter-toggled-derive-pipelines", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
