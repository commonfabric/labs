import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterBatchedHandlerUpdatesScenario: PatternIntegrationScenario<
  { value?: number }
> = {
  name: "counter applies batched handler updates across multiple cells",
  module: new URL(
    "./counter-batched-handler-updates.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithBatchedHandlerUpdates",
  steps: [
    {
      expect: [
        { path: "currentValue", value: 0 },
        { path: "processed", value: 0 },
        { path: "batches", value: 0 },
        { path: "history", value: [] },
        { path: "note", value: "idle" },
        {
          path: "summary",
          value: "Processed 0 increments over 0 batches (idle)",
        },
        { path: "lastTotal", value: 0 },
      ],
    },
    {
      events: [
        {
          stream: "applyBatch",
          payload: { amounts: [2, 3], note: "first run" },
        },
      ],
      expect: [
        { path: "currentValue", value: 5 },
        { path: "processed", value: 2 },
        { path: "batches", value: 1 },
        { path: "history", value: [5] },
        { path: "note", value: "first run" },
        {
          path: "summary",
          value: "Processed 2 increments over 1 batches (first run)",
        },
        { path: "lastTotal", value: 5 },
      ],
    },
    {
      events: [
        {
          stream: "applyBatch",
          payload: { amounts: [-1, 4, 6] },
        },
      ],
      expect: [
        { path: "currentValue", value: 14 },
        { path: "processed", value: 5 },
        { path: "batches", value: 2 },
        { path: "history", value: [5, 14] },
        { path: "note", value: "batch 3" },
        {
          path: "summary",
          value: "Processed 5 increments over 2 batches (batch 3)",
        },
        { path: "lastTotal", value: 14 },
      ],
    },
    {
      events: [
        {
          stream: "applyBatch",
          payload: { amounts: [], note: "manual note" },
        },
      ],
      expect: [
        { path: "currentValue", value: 14 },
        { path: "processed", value: 5 },
        { path: "batches", value: 2 },
        { path: "history", value: [5, 14] },
        { path: "note", value: "manual note" },
        {
          path: "summary",
          value: "Processed 5 increments over 2 batches (manual note)",
        },
        { path: "lastTotal", value: 14 },
      ],
    },
    {
      events: [
        {
          stream: "applyBatch",
          payload: { amounts: [10], note: "final batch" },
        },
      ],
      expect: [
        { path: "currentValue", value: 24 },
        { path: "processed", value: 6 },
        { path: "batches", value: 3 },
        { path: "history", value: [5, 14, 24] },
        { path: "note", value: "final batch" },
        {
          path: "summary",
          value: "Processed 6 increments over 3 batches (final batch)",
        },
        { path: "lastTotal", value: 24 },
      ],
    },
  ],
};

export const scenarios = [counterBatchedHandlerUpdatesScenario];

describe("counter-batched-handler-updates", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
