import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterDynamicHandlerListScenario: PatternIntegrationScenario<
  { values?: number[] }
> = {
  name: "counter exposes dynamic handlers per slot",
  module: new URL(
    "./counter-dynamic-handler-list.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithDynamicHandlerList",
  argument: { values: [2, 5] },
  steps: [
    {
      expect: [
        { path: "values", value: [2, 5] },
        { path: "count", value: 2 },
        { path: "total", value: 7 },
        { path: "average", value: 3.5 },
        { path: "averageLabel", value: "Average 3.5" },
        { path: "slots.0.value", value: 2 },
        { path: "slots.0.label", value: "Slot 1: 2" },
        { path: "slots.1.value", value: 5 },
        { path: "slots.1.label", value: "Slot 2: 5" },
        { path: "sequence", value: 0 },
        {
          path: "lastAdjustment",
          value: { index: -1, amount: 0, nextValue: 0 },
        },
        { path: "history", value: [] },
      ],
    },
    {
      events: [{ stream: "handlers.0", payload: { amount: 3 } }],
      expect: [
        { path: "values", value: [5, 5] },
        { path: "total", value: 10 },
        { path: "summary", value: "2 counter slots total 10" },
        { path: "averageLabel", value: "Average 5" },
        { path: "slots.0.value", value: 5 },
        { path: "slots.0.label", value: "Slot 1: 5" },
        { path: "sequence", value: 1 },
        {
          path: "lastAdjustment",
          value: { index: 0, amount: 3, nextValue: 5 },
        },
        {
          path: "history",
          value: [{ index: 0, amount: 3, nextValue: 5 }],
        },
      ],
    },
    {
      events: [{ stream: "controls.add", payload: { initial: 10 } }],
      expect: [
        { path: "values", value: [5, 5, 10] },
        { path: "count", value: 3 },
        { path: "total", value: 20 },
        { path: "summary", value: "3 counter slots total 20" },
        { path: "averageLabel", value: "Average 6.67" },
        { path: "slots.2.value", value: 10 },
        { path: "slots.2.label", value: "Slot 3: 10" },
        { path: "sequence", value: 2 },
        {
          path: "history",
          value: [
            { index: 0, amount: 3, nextValue: 5 },
            { index: 2, amount: 0, nextValue: 10 },
          ],
        },
        {
          path: "lastAdjustment",
          value: { index: 2, amount: 0, nextValue: 10 },
        },
      ],
    },
    {
      events: [{ stream: "handlers.2", payload: { amount: -4 } }],
      expect: [
        { path: "values", value: [5, 5, 6] },
        { path: "total", value: 16 },
        { path: "averageLabel", value: "Average 5.33" },
        { path: "slots.2.value", value: 6 },
        { path: "slots.2.label", value: "Slot 3: 6" },
        { path: "sequence", value: 3 },
        {
          path: "history",
          value: [
            { index: 0, amount: 3, nextValue: 5 },
            { index: 2, amount: 0, nextValue: 10 },
            { index: 2, amount: -4, nextValue: 6 },
          ],
        },
        {
          path: "lastAdjustment",
          value: { index: 2, amount: -4, nextValue: 6 },
        },
      ],
    },
    {
      events: [{ stream: "handlers.1", payload: { amount: -2 } }],
      expect: [
        { path: "values", value: [5, 3, 6] },
        { path: "total", value: 14 },
        { path: "averageLabel", value: "Average 4.67" },
        { path: "slots.1.value", value: 3 },
        { path: "slots.1.label", value: "Slot 2: 3" },
        { path: "sequence", value: 4 },
        {
          path: "history",
          value: [
            { index: 0, amount: 3, nextValue: 5 },
            { index: 2, amount: 0, nextValue: 10 },
            { index: 2, amount: -4, nextValue: 6 },
            { index: 1, amount: -2, nextValue: 3 },
          ],
        },
        {
          path: "lastAdjustment",
          value: { index: 1, amount: -2, nextValue: 3 },
        },
      ],
    },
  ],
};

export const scenarios = [counterDynamicHandlerListScenario];

describe("counter-dynamic-handler-list", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
