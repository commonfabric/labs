import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterComplexUnionStateScenario: PatternIntegrationScenario = {
  name: "counter transitions maintain union state integrity",
  module: new URL(
    "./counter-complex-union-state.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithComplexUnionState",
  steps: [
    {
      expect: [
        { path: "mode", value: "loading" },
        { path: "attemptCount", value: 0 },
        { path: "readyValue", value: 0 },
        { path: "historyView", value: [] },
        { path: "summary", value: "mode:loading value:0 attempts:0 history:0" },
        { path: "state.status", value: "loading" },
        { path: "state.note", value: "booting" },
        { path: "state.attempts", value: 0 },
        { path: "transitions", value: [] },
      ],
    },
    {
      events: [{
        stream: "load",
        payload: { value: 3, note: "ready to go" },
      }],
      expect: [
        { path: "mode", value: "ready" },
        { path: "readyValue", value: 3 },
        { path: "historyView", value: [3] },
        { path: "summary", value: "mode:ready value:3 attempts:0 history:1" },
        { path: "state.status", value: "ready" },
        { path: "state.value", value: 3 },
        { path: "state.history", value: [3] },
        { path: "state.note", value: "ready to go" },
        { path: "state.attempts", value: 0 },
        { path: "attemptCount", value: 0 },
        { path: "transitions", value: ["ready:3:ready to go"] },
      ],
    },
    {
      events: [{
        stream: "increment",
        payload: { amount: 2, note: "plus two" },
      }],
      expect: [
        { path: "mode", value: "ready" },
        { path: "readyValue", value: 5 },
        { path: "historyView", value: [3, 5] },
        { path: "summary", value: "mode:ready value:5 attempts:0 history:2" },
        { path: "state.value", value: 5 },
        { path: "state.history", value: [3, 5] },
        { path: "state.note", value: "plus two" },
        {
          path: "transitions",
          value: ["ready:3:ready to go", "increment:5:plus two"],
        },
      ],
    },
    {
      events: [{ stream: "reset", payload: { note: "retry" } }],
      expect: [
        { path: "mode", value: "loading" },
        { path: "readyValue", value: 0 },
        { path: "historyView", value: [] },
        { path: "summary", value: "mode:loading value:0 attempts:1 history:0" },
        { path: "attemptCount", value: 1 },
        { path: "state.status", value: "loading" },
        { path: "state.note", value: "retry" },
        { path: "state.attempts", value: 1 },
        {
          path: "transitions",
          value: [
            "ready:3:ready to go",
            "increment:5:plus two",
            "loading:1:retry",
          ],
        },
      ],
    },
    {
      events: [{ stream: "load", payload: { value: 4 } }],
      expect: [
        { path: "mode", value: "ready" },
        { path: "readyValue", value: 4 },
        { path: "historyView", value: [4] },
        { path: "summary", value: "mode:ready value:4 attempts:1 history:1" },
        { path: "attemptCount", value: 1 },
        { path: "state.status", value: "ready" },
        { path: "state.value", value: 4 },
        { path: "state.history", value: [4] },
        { path: "state.note", value: "ready" },
        { path: "state.attempts", value: 1 },
        {
          path: "transitions",
          value: [
            "ready:3:ready to go",
            "increment:5:plus two",
            "loading:1:retry",
            "ready:4:ready",
          ],
        },
      ],
    },
  ],
};

export const scenarios = [counterComplexUnionStateScenario];

describe("counter-complex-union-state", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
