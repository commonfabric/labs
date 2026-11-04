import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterDerivedSummaryScenario: PatternIntegrationScenario<
  { value?: number; step?: number; history?: number[] }
> = {
  name: "counter derives summary object across adjustments",
  module: new URL(
    "./counter-derived-summary.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithDerivedSummary",
  steps: [
    {
      expect: [
        { path: "currentValue", value: 0 },
        { path: "stepValue", value: 1 },
        { path: "history", value: [] },
        { path: "sequence", value: 0 },
        { path: "trend", value: "flat" },
        { path: "parity", value: "even" },
        { path: "summary.current", value: 0 },
        { path: "summary.previous", value: 0 },
        { path: "summary.delta", value: 0 },
        { path: "summary.trend", value: "flat" },
        { path: "summary.parity", value: "even" },
        { path: "summary.average", value: 0 },
        { path: "summary.historyCount", value: 0 },
        { path: "summary.adjustmentCount", value: 0 },
        { path: "summary.step", value: 1 },
        {
          path: "summary.label",
          value: "Current 0 (flat) avg 0 step 1",
        },
        {
          path: "summaryLabel",
          value: "Current 0 (flat) avg 0 step 1",
        },
        { path: "detail", value: "Step 1 trend flat" },
      ],
    },
    {
      events: [{
        stream: "controls.adjust",
        payload: { amount: 4, label: "boost" },
      }],
      expect: [
        { path: "currentValue", value: 4 },
        { path: "history", value: [4] },
        { path: "sequence", value: 1 },
        { path: "trend", value: "up" },
        { path: "summary.current", value: 4 },
        { path: "summary.previous", value: 0 },
        { path: "summary.delta", value: 4 },
        { path: "summary.trend", value: "up" },
        { path: "summary.parity", value: "even" },
        { path: "summary.average", value: 4 },
        { path: "summary.historyCount", value: 1 },
        { path: "summary.adjustmentCount", value: 1 },
        { path: "summary.step", value: 1 },
        {
          path: "summary.label",
          value: "Current 4 (up) avg 4 step 1",
        },
        {
          path: "summaryLabel",
          value: "Current 4 (up) avg 4 step 1",
        },
        { path: "detail", value: "Step 1 trend up" },
        {
          path: "adjustments",
          value: [{
            sequence: 1,
            delta: 4,
            resulting: 4,
            label: "boost",
          }],
        },
      ],
    },
    {
      events: [{
        stream: "controls.adjust",
        payload: { direction: "decrease", label: "drop" },
      }],
      expect: [
        { path: "currentValue", value: 3 },
        { path: "history", value: [4, 3] },
        { path: "sequence", value: 2 },
        { path: "trend", value: "down" },
        { path: "parity", value: "odd" },
        { path: "summary.current", value: 3 },
        { path: "summary.previous", value: 4 },
        { path: "summary.delta", value: -1 },
        { path: "summary.trend", value: "down" },
        { path: "summary.parity", value: "odd" },
        { path: "summary.average", value: 3.5 },
        { path: "summary.historyCount", value: 2 },
        { path: "summary.adjustmentCount", value: 2 },
        { path: "summary.step", value: 1 },
        {
          path: "summary.label",
          value: "Current 3 (down) avg 3.5 step 1",
        },
        { path: "detail", value: "Step 1 trend down" },
        {
          path: "adjustments",
          value: [
            {
              sequence: 1,
              delta: 4,
              resulting: 4,
              label: "boost",
            },
            {
              sequence: 2,
              delta: -1,
              resulting: 3,
              label: "drop",
            },
          ],
        },
      ],
    },
    {
      events: [{ stream: "controls.setStep", payload: { step: 3 } }],
      expect: [
        { path: "stepValue", value: 3 },
        { path: "summary.step", value: 3 },
        {
          path: "summary.label",
          value: "Current 3 (down) avg 3.5 step 3",
        },
        { path: "detail", value: "Step 3 trend down" },
      ],
    },
    {
      events: [{
        stream: "controls.adjust",
        payload: { direction: "increase" },
      }],
      expect: [
        { path: "currentValue", value: 6 },
        { path: "history", value: [4, 3, 6] },
        { path: "sequence", value: 3 },
        { path: "trend", value: "up" },
        { path: "parity", value: "even" },
        { path: "summary.current", value: 6 },
        { path: "summary.previous", value: 3 },
        { path: "summary.delta", value: 3 },
        { path: "summary.trend", value: "up" },
        { path: "summary.parity", value: "even" },
        { path: "summary.average", value: 4.33 },
        { path: "summary.historyCount", value: 3 },
        { path: "summary.adjustmentCount", value: 3 },
        { path: "summary.step", value: 3 },
        {
          path: "summary.label",
          value: "Current 6 (up) avg 4.33 step 3",
        },
        { path: "detail", value: "Step 3 trend up" },
        {
          path: "adjustments",
          value: [
            {
              sequence: 1,
              delta: 4,
              resulting: 4,
              label: "boost",
            },
            {
              sequence: 2,
              delta: -1,
              resulting: 3,
              label: "drop",
            },
            {
              sequence: 3,
              delta: 3,
              resulting: 6,
              label: "Adjustment 3",
            },
          ],
        },
      ],
    },
  ],
};

export const scenarios = [counterDerivedSummaryScenario];

describe("counter-derived-summary", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
