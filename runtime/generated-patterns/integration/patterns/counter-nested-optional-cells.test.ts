import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterNestedOptionalCellsScenario: PatternIntegrationScenario = {
  name: "counter manages nested optional cells",
  module: new URL(
    "./counter-nested-optional-cells.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithNestedOptionalCells",
  steps: [
    {
      expect: [
        { path: "current", value: 0 },
        { path: "history", value: [] },
        { path: "branchTitle", value: "Unnamed branch" },
        { path: "label", value: "Unnamed branch 0" },
        { path: "status", value: "Count 0 (nested:no branch:no)" },
        { path: "hasNested", value: false },
        { path: "hasBranch", value: false },
        { path: "state.nested", value: undefined },
      ],
    },
    {
      events: [{
        stream: "increment",
        payload: { amount: 2, label: "Primary" },
      }],
      expect: [
        { path: "current", value: 2 },
        { path: "history", value: [2] },
        { path: "branchTitle", value: "Primary" },
        { path: "label", value: "Primary 2" },
        { path: "status", value: "Count 2 (nested:yes branch:yes)" },
        { path: "hasNested", value: true },
        { path: "hasBranch", value: true },
        { path: "state.nested.branch.counter", value: 2 },
        { path: "state.nested.branch.history", value: [2] },
        { path: "state.nested.branch.label", value: "Primary" },
      ],
    },
    {
      events: [{ stream: "clear", payload: { target: "branch" } }],
      expect: [
        { path: "current", value: 0 },
        { path: "history", value: [] },
        { path: "branchTitle", value: "Unnamed branch" },
        { path: "label", value: "Unnamed branch 0" },
        { path: "status", value: "Count 0 (nested:yes branch:no)" },
        { path: "hasNested", value: true },
        { path: "hasBranch", value: false },
        { path: "state.nested.branch", value: undefined },
      ],
    },
    {
      events: [{
        stream: "increment",
        payload: { amount: 3, label: "Rebuilt" },
      }],
      expect: [
        { path: "current", value: 3 },
        { path: "history", value: [3] },
        { path: "branchTitle", value: "Rebuilt" },
        { path: "label", value: "Rebuilt 3" },
        { path: "status", value: "Count 3 (nested:yes branch:yes)" },
        { path: "hasNested", value: true },
        { path: "hasBranch", value: true },
        { path: "state.nested.branch.counter", value: 3 },
        { path: "state.nested.branch.history", value: [3] },
        { path: "state.nested.branch.label", value: "Rebuilt" },
      ],
    },
    {
      events: [{ stream: "clear", payload: { target: "nested" } }],
      expect: [
        { path: "current", value: 0 },
        { path: "history", value: [] },
        { path: "branchTitle", value: "Unnamed branch" },
        { path: "label", value: "Unnamed branch 0" },
        { path: "status", value: "Count 0 (nested:no branch:no)" },
        { path: "hasNested", value: false },
        { path: "hasBranch", value: false },
        { path: "state.nested", value: undefined },
      ],
    },
    {
      events: [{ stream: "increment", payload: {} }],
      expect: [
        { path: "current", value: 1 },
        { path: "history", value: [1] },
        { path: "branchTitle", value: "Unnamed branch" },
        { path: "label", value: "Unnamed branch 1" },
        { path: "status", value: "Count 1 (nested:yes branch:yes)" },
        { path: "hasNested", value: true },
        { path: "hasBranch", value: true },
        { path: "state.nested.branch.counter", value: 1 },
        { path: "state.nested.branch.history", value: [1] },
        { path: "state.nested.branch.label", value: undefined },
      ],
    },
  ],
};

export const scenarios = [counterNestedOptionalCellsScenario];

describe("counter-nested-optional-cells", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
