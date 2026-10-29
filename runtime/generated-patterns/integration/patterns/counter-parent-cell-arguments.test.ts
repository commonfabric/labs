import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterParentCellArgumentsScenario: PatternIntegrationScenario<
  { value?: number; step?: number }
> = {
  name: "child pattern mutates parent cells via shared arguments",
  module: new URL(
    "./counter-parent-cell-arguments.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithParentCellArguments",
  steps: [
    {
      expect: [
        { path: "current", value: 0 },
        { path: "stepSize", value: 1 },
        { path: "parentPreview", value: 1 },
        { path: "alignment", value: true },
        { path: "sharedLabel", value: "Parent 0 child 0" },
        { path: "child.current", value: 0 },
        { path: "child.step", value: 1 },
        { path: "child.parity", value: "even" },
        { path: "child.nextPreview", value: 1 },
        { path: "child.label", value: "Child sees 0 (step 1) [even]" },
      ],
    },
    {
      events: [
        { stream: "child.increment", payload: {} },
      ],
      expect: [
        { path: "current", value: 1 },
        { path: "parentPreview", value: 2 },
        { path: "alignment", value: true },
        { path: "sharedLabel", value: "Parent 1 child 1" },
        { path: "child.current", value: 1 },
        { path: "child.parity", value: "odd" },
        { path: "child.step", value: 1 },
        { path: "child.nextPreview", value: 2 },
        { path: "child.label", value: "Child sees 1 (step 1) [odd]" },
      ],
    },
    {
      events: [
        { stream: "setStep", payload: { step: 3 } },
      ],
      expect: [
        { path: "stepSize", value: 3 },
        { path: "parentPreview", value: 4 },
        { path: "child.step", value: 3 },
        { path: "child.nextPreview", value: 4 },
        { path: "child.label", value: "Child sees 1 (step 3) [odd]" },
      ],
    },
    {
      events: [
        { stream: "child.increment", payload: {} },
      ],
      expect: [
        { path: "current", value: 4 },
        { path: "parentPreview", value: 7 },
        { path: "alignment", value: true },
        { path: "sharedLabel", value: "Parent 4 child 4" },
        { path: "child.current", value: 4 },
        { path: "child.parity", value: "even" },
        { path: "child.nextPreview", value: 7 },
        { path: "child.label", value: "Child sees 4 (step 3) [even]" },
      ],
    },
    {
      events: [
        { stream: "child.setAbsolute", payload: { value: 10 } },
      ],
      expect: [
        { path: "current", value: 10 },
        { path: "parentPreview", value: 13 },
        { path: "alignment", value: true },
        { path: "sharedLabel", value: "Parent 10 child 10" },
        { path: "child.current", value: 10 },
        { path: "child.parity", value: "even" },
        { path: "child.nextPreview", value: 13 },
        { path: "child.label", value: "Child sees 10 (step 3) [even]" },
      ],
    },
    {
      events: [
        { stream: "setStep", payload: { step: -4 } },
      ],
      expect: [
        { path: "stepSize", value: 4 },
        { path: "parentPreview", value: 14 },
        { path: "child.step", value: 4 },
        { path: "child.nextPreview", value: 14 },
        { path: "child.label", value: "Child sees 10 (step 4) [even]" },
      ],
    },
    {
      events: [
        { stream: "child.increment", payload: { amount: 0 } },
      ],
      expect: [
        { path: "current", value: 14 },
        { path: "parentPreview", value: 18 },
        { path: "alignment", value: true },
        { path: "sharedLabel", value: "Parent 14 child 14" },
        { path: "child.current", value: 14 },
        { path: "child.parity", value: "even" },
        { path: "child.nextPreview", value: 18 },
        { path: "child.label", value: "Child sees 14 (step 4) [even]" },
      ],
    },
  ],
};

export const scenarios = [counterParentCellArgumentsScenario];

describe("counter-parent-cell-arguments", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
