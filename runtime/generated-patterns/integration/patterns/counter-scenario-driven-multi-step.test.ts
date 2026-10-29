import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterScenarioDrivenMultiStep: PatternIntegrationScenario = {
  name: "counter handles scenario driven multi step events",
  module: new URL(
    "./counter-scenario-driven-multi-step.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithScenarioDrivenSteps",
  steps: [
    {
      expect: [
        { path: "currentValue", value: 0 },
        { path: "currentPhase", value: "idle" },
        { path: "stepCount", value: 0 },
        { path: "steps", value: [] },
        { path: "phases", value: [] },
        { path: "lastRecordedTotal", value: 0 },
        {
          path: "summary",
          value: "Phase idle total 0 over 0 steps",
        },
      ],
    },
    {
      events: [
        { stream: "sequence.start", payload: { label: "warm-up" } },
        {
          stream: "sequence.apply",
          payload: { amount: 2, note: "boost" },
        },
        { stream: "sequence.apply", payload: { amount: 3 } },
        {
          stream: "sequence.complete",
          payload: { note: "initial lap" },
        },
      ],
      expect: [
        { path: "currentValue", value: 5 },
        { path: "currentPhase", value: "warm-up" },
        { path: "stepCount", value: 2 },
        {
          path: "steps",
          value: [
            { index: 1, delta: 2, total: 2, note: "boost" },
            { index: 2, delta: 3, total: 5, note: "step warm-up" },
          ],
        },
        {
          path: "phases",
          value: ["warm-up (initial lap) steps: 2 total: 5"],
        },
        { path: "lastRecordedTotal", value: 5 },
        {
          path: "summary",
          value: "Phase warm-up total 5 over 2 steps",
        },
      ],
    },
    {
      events: [
        { stream: "sequence.start", payload: { label: "speed-run" } },
        {
          stream: "sequence.apply",
          payload: { amount: -1, note: "correction" },
        },
        { stream: "sequence.apply", payload: { amount: 4 } },
        {
          stream: "sequence.apply",
          payload: { amount: 6, note: "finish" },
        },
        {
          stream: "sequence.complete",
          payload: { note: "final lap" },
        },
      ],
      expect: [
        { path: "currentValue", value: 14 },
        { path: "currentPhase", value: "speed-run" },
        { path: "stepCount", value: 3 },
        {
          path: "steps",
          value: [
            { index: 1, delta: -1, total: 4, note: "correction" },
            { index: 2, delta: 4, total: 8, note: "step speed-run" },
            { index: 3, delta: 6, total: 14, note: "finish" },
          ],
        },
        {
          path: "phases",
          value: [
            "warm-up (initial lap) steps: 2 total: 5",
            "speed-run (final lap) steps: 3 total: 14",
          ],
        },
        { path: "lastRecordedTotal", value: 14 },
        {
          path: "summary",
          value: "Phase speed-run total 14 over 3 steps",
        },
      ],
    },
  ],
};

export const scenarios = [counterScenarioDrivenMultiStep];

describe("counter-scenario-driven-multi-step", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
