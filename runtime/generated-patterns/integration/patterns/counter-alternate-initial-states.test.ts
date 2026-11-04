import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface AlternateInitialStateSeed {
  id: string;
  label: string;
  value: number;
  step: number;
}

const alternateStates: AlternateInitialStateSeed[] = [
  { id: "baseline", label: "Baseline ramp", value: 3, step: 1 },
  { id: "boost", label: "Momentum Boost", value: 8, step: 3 },
  { id: "reset", label: "Recovery Reset", value: -2, step: 2 },
];

export const counterAlternateInitialStatesScenario: PatternIntegrationScenario<
  { states: AlternateInitialStateSeed[] }
> = {
  name: "counter resets from alternate initial states",
  module: new URL(
    "./counter-alternate-initial-states.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithAlternateInitialStates",
  argument: { states: alternateStates },
  steps: [
    {
      events: [
        {
          stream: "selectInitial",
          payload: { id: "baseline", reason: "initial" },
        },
      ],
      expect: [
        { path: "value", value: 3 },
        { path: "step", value: 1 },
        { path: "activeState.id", value: "baseline" },
        { path: "activeState.label", value: "Baseline ramp" },
        { path: "label", value: "State Baseline ramp=3 (step 1)" },
        { path: "availableStates.1.id", value: "boost" },
        { path: "availableStates.2.label", value: "Recovery Reset" },
        { path: "selectionCount", value: 1 },
        { path: "selectionLog.0.reason", value: "initial" },
        { path: "selectionLog.0.index", value: 1 },
      ],
    },
    {
      events: [
        {
          stream: "selectInitial",
          payload: { id: "boost", reason: "fast start" },
        },
      ],
      expect: [
        { path: "value", value: 8 },
        { path: "step", value: 3 },
        { path: "activeState.label", value: "Momentum Boost" },
        { path: "label", value: "State Momentum Boost=8 (step 3)" },
        { path: "selectionCount", value: 2 },
        { path: "selectionLog.1.id", value: "boost" },
        { path: "selectionLog.1.reason", value: "fast start" },
        { path: "selectionLog.1.index", value: 2 },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [
        { path: "value", value: 10 },
        { path: "label", value: "State Momentum Boost=10 (step 3)" },
        { path: "selectionCount", value: 2 },
      ],
    },
    {
      events: [
        { stream: "selectInitial", payload: { id: "reset", reason: 42 } },
      ],
      expect: [
        { path: "value", value: -2 },
        { path: "step", value: 2 },
        { path: "activeState.id", value: "reset" },
        { path: "label", value: "State Recovery Reset=-2 (step 2)" },
        { path: "selectionCount", value: 3 },
        { path: "selectionLog.2.reason", value: "selectInitial" },
        { path: "selectionLog.2.index", value: 3 },
      ],
    },
    {
      events: [{ stream: "selectInitial", payload: { id: "missing" } }],
      expect: [
        { path: "value", value: 3 },
        { path: "step", value: 1 },
        { path: "activeState.id", value: "baseline" },
        { path: "label", value: "State Baseline ramp=3 (step 1)" },
        { path: "selectionCount", value: 4 },
        { path: "selectionLog.3.id", value: "baseline" },
      ],
    },
  ],
};

export const scenarios = [counterAlternateInitialStatesScenario];

describe("counter-alternate-initial-states", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
