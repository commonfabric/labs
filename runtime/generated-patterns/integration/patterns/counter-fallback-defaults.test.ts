import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

const sparseSlots: (number | null)[] = [];
sparseSlots[0] = 4;
sparseSlots[2] = 8;

export const counterFallbackDefaultsScenario: PatternIntegrationScenario<
  { slots?: (number | null)[]; fallback?: number; expectedLength?: number }
> = {
  name: "counter fills sparse slots with fallback values",
  module: new URL(
    "./counter-fallback-defaults.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithFallbackDefaults",
  argument: {
    slots: sparseSlots,
    fallback: 5,
    expectedLength: 4,
  },
  steps: [
    {
      expect: [
        { path: "fallback", value: 5 },
        { path: "expectedLength", value: 4 },
        { path: "dense.0", value: 4 },
        { path: "dense.1", value: 5 },
        { path: "dense.2", value: 8 },
        { path: "dense.3", value: 5 },
        { path: "densePreview", value: "4, 5, 8, 5" },
        { path: "total", value: 22 },
        { path: "label", value: "Dense values [4, 5, 8, 5] total 22" },
      ],
    },
    {
      events: [{ stream: "updateSlot", payload: { index: 1, amount: 3 } }],
      expect: [
        { path: "dense.0", value: 4 },
        { path: "dense.1", value: 8 },
        { path: "dense.2", value: 8 },
        { path: "dense.3", value: 5 },
        { path: "slots.1", value: 8 },
        { path: "slots.3", value: 5 },
        { path: "densePreview", value: "4, 8, 8, 5" },
        { path: "total", value: 25 },
        { path: "label", value: "Dense values [4, 8, 8, 5] total 25" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { index: 4, amount: 2 } }],
      expect: [
        { path: "dense.3", value: 5 },
        { path: "dense.4", value: 7 },
        { path: "slots.4", value: 7 },
        { path: "densePreview", value: "4, 8, 8, 5, 7" },
        { path: "total", value: 32 },
        { path: "label", value: "Dense values [4, 8, 8, 5, 7] total 32" },
      ],
    },
    {
      events: [{ stream: "updateSlot", payload: { index: 0, value: 10 } }],
      expect: [
        { path: "dense.0", value: 10 },
        { path: "dense.1", value: 8 },
        { path: "dense.2", value: 8 },
        { path: "dense.4", value: 7 },
        { path: "densePreview", value: "10, 8, 8, 5, 7" },
        { path: "total", value: 38 },
        { path: "label", value: "Dense values [10, 8, 8, 5, 7] total 38" },
      ],
    },
  ],
};

export const scenarios = [counterFallbackDefaultsScenario];

describe("counter-fallback-defaults", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
