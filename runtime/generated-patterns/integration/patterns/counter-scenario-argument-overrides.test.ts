import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterScenarioArgumentOverridesScenario:
  PatternIntegrationScenario<
    { value?: number; step?: number }
  > = {
    name: "counter rehydrates from scenario argument overrides",
    module: new URL(
      "./counter-scenario-argument-overrides.pattern.ts",
      import.meta.url,
    ),
    exportName: "counterWithScenarioArgumentOverrides",
    argument: { value: 10, step: 2 },
    steps: [
      {
        events: [{
          stream: "controls.applyArgumentOverrides",
          payload: { note: "initial load" },
        }],
        expect: [
          { path: "currentValue", value: 10 },
          { path: "activeStep", value: 2 },
          { path: "history", value: [10] },
          { path: "historyCount", value: 1 },
          { path: "lastRecorded", value: 10 },
          { path: "argumentState.value", value: 10 },
          { path: "argumentState.step", value: 2 },
          { path: "argumentLabel", value: "Argument baseline value 10 step 2" },
          {
            path: "overrideNote",
            value: "Applied initial load -> value 10 step 2",
          },
          { path: "overrideCount", value: 1 },
          {
            path: "summary",
            value: "Current 10 step 2 overrides 1 history 1",
          },
        ],
      },
      {
        events: [{ stream: "controls.increment", payload: {} }],
        expect: [
          { path: "currentValue", value: 12 },
          { path: "history", value: [10, 12] },
          { path: "historyCount", value: 2 },
          { path: "lastRecorded", value: 12 },
          { path: "overrideCount", value: 1 },
          {
            path: "summary",
            value: "Current 12 step 2 overrides 1 history 2",
          },
        ],
      },
      {
        events: [
          { stream: "argumentInputs.value", payload: 31 },
          { stream: "argumentInputs.step", payload: -4 },
        ],
        expect: [
          { path: "argumentState.value", value: 31 },
          { path: "argumentState.step", value: 4 },
          { path: "argumentLabel", value: "Argument baseline value 31 step 4" },
          { path: "currentValue", value: 12 },
          { path: "activeStep", value: 2 },
          {
            path: "summary",
            value: "Current 12 step 2 overrides 1 history 2",
          },
        ],
      },
      {
        events: [{
          stream: "controls.applyArgumentOverrides",
          payload: { note: "scenario override" },
        }],
        expect: [
          { path: "currentValue", value: 31 },
          { path: "activeStep", value: 4 },
          { path: "history", value: [31] },
          { path: "historyCount", value: 1 },
          { path: "lastRecorded", value: 31 },
          { path: "overrideCount", value: 2 },
          {
            path: "overrideNote",
            value: "Applied scenario override -> value 31 step 4",
          },
          {
            path: "summary",
            value: "Current 31 step 4 overrides 2 history 1",
          },
        ],
      },
      {
        events: [{ stream: "controls.increment", payload: {} }],
        expect: [
          { path: "currentValue", value: 35 },
          { path: "history", value: [31, 35] },
          { path: "historyCount", value: 2 },
          { path: "lastRecorded", value: 35 },
          { path: "overrideCount", value: 2 },
          {
            path: "summary",
            value: "Current 35 step 4 overrides 2 history 2",
          },
        ],
      },
    ],
  };

export const scenarios = [counterScenarioArgumentOverridesScenario];

describe("counter-scenario-argument-overrides", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
