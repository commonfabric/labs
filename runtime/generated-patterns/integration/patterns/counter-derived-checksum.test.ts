import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterDerivedChecksumScenario: PatternIntegrationScenario<
  { value?: number; values?: number[]; prefix?: string }
> = {
  name: "counter derives checksum from recorded values",
  module: new URL(
    "./counter-derived-checksum.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithDerivedChecksum",
  steps: [
    {
      expect: [
        { path: "value", value: 0 },
        { path: "values", value: [] },
        { path: "checksum", value: 0 },
        { path: "updates", value: 0 },
        { path: "label", value: "Checksum 0" },
        { path: "summary", value: "Checksum 0 after 0" },
        { path: "audit", value: { updates: 0, checksum: 0 } },
        {
          path: "lastEvent",
          value: { amount: 0, nextValue: 0, checksum: 0 },
        },
      ],
    },
    {
      events: [{ stream: "record", payload: { amount: 3 } }],
      expect: [
        { path: "value", value: 3 },
        { path: "values", value: [3] },
        { path: "checksum", value: 3 },
        { path: "updates", value: 1 },
        { path: "label", value: "Checksum 3" },
        { path: "summary", value: "Checksum 3 after 1" },
        { path: "audit", value: { updates: 1, checksum: 3 } },
        {
          path: "lastEvent",
          value: { amount: 3, nextValue: 3, checksum: 3 },
        },
      ],
    },
    {
      events: [{ stream: "record", payload: { amount: -2 } }],
      expect: [
        { path: "value", value: 1 },
        { path: "values", value: [3, 1] },
        { path: "checksum", value: 5 },
        { path: "updates", value: 2 },
        { path: "label", value: "Checksum 5" },
        { path: "summary", value: "Checksum 5 after 2" },
        { path: "audit", value: { updates: 2, checksum: 5 } },
        {
          path: "lastEvent",
          value: { amount: -2, nextValue: 1, checksum: 5 },
        },
      ],
    },
    {
      events: [{ stream: "record", payload: { amount: 10 } }],
      expect: [
        { path: "value", value: 11 },
        { path: "values", value: [3, 1, 11] },
        { path: "checksum", value: 38 },
        { path: "updates", value: 3 },
        { path: "label", value: "Checksum 38" },
        { path: "summary", value: "Checksum 38 after 3" },
        { path: "audit", value: { updates: 3, checksum: 38 } },
        {
          path: "lastEvent",
          value: { amount: 10, nextValue: 11, checksum: 38 },
        },
      ],
    },
    {
      events: [{ stream: "record", payload: {} }],
      expect: [
        { path: "value", value: 12 },
        { path: "values", value: [3, 1, 11, 12] },
        { path: "checksum", value: 86 },
        { path: "updates", value: 4 },
        { path: "label", value: "Checksum 86" },
        { path: "summary", value: "Checksum 86 after 4" },
        { path: "audit", value: { updates: 4, checksum: 86 } },
        {
          path: "lastEvent",
          value: { amount: 1, nextValue: 12, checksum: 86 },
        },
      ],
    },
  ],
};

export const scenarios = [counterDerivedChecksumScenario];

describe("counter-derived-checksum", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
