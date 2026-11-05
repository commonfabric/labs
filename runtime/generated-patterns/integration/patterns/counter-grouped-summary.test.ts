import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface EntryArgument {
  id?: string;
  group?: string;
  value?: number;
}

export const counterGroupedSummaryScenario: PatternIntegrationScenario<
  { entries?: EntryArgument[]; defaultAmount?: number }
> = {
  name: "counter groups entries into derived summary totals",
  module: new URL("./counter-grouped-summary.pattern.ts", import.meta.url),
  exportName: "counterWithGroupedSummary",
  argument: {
    entries: [
      { id: "north", group: "alpha", value: 2 },
      { id: "east", group: "beta", value: 5 },
      { id: "west", group: "alpha", value: 3 },
    ],
    defaultAmount: 2,
  },
  steps: [
    {
      expect: [
        {
          path: "entries",
          value: [
            { id: "north", group: "alpha", value: 2 },
            { id: "east", group: "beta", value: 5 },
            { id: "west", group: "alpha", value: 3 },
          ],
        },
        {
          path: "summaries",
          value: [
            { group: "alpha", total: 5, count: 2 },
            { group: "beta", total: 5, count: 1 },
          ],
        },
        { path: "groupTotals", value: { alpha: 5, beta: 5 } },
        { path: "overallTotal", value: 10 },
        { path: "groupCount", value: 2 },
        {
          path: "dominantGroup",
          value: { group: "alpha", total: 5, count: 2 },
        },
        {
          path: "summaryLabel",
          value: "Group totals alpha: 5 (2) • beta: 5 (1)",
        },
      ],
    },
    {
      events: [{
        stream: "controls.record",
        payload: { id: "east", delta: 4 },
      }],
      expect: [
        {
          path: "entries",
          value: [
            { id: "north", group: "alpha", value: 2 },
            { id: "east", group: "beta", value: 9 },
            { id: "west", group: "alpha", value: 3 },
          ],
        },
        {
          path: "summaries",
          value: [
            { group: "alpha", total: 5, count: 2 },
            { group: "beta", total: 9, count: 1 },
          ],
        },
        { path: "groupTotals", value: { alpha: 5, beta: 9 } },
        { path: "overallTotal", value: 14 },
        { path: "dominantGroup", value: { group: "beta", total: 9, count: 1 } },
        {
          path: "summaryLabel",
          value: "Group totals alpha: 5 (2) • beta: 9 (1)",
        },
      ],
    },
    {
      events: [{ stream: "controls.record", payload: { group: "beta" } }],
      expect: [
        {
          path: "entries",
          value: [
            { id: "north", group: "alpha", value: 2 },
            { id: "east", group: "beta", value: 9 },
            { id: "west", group: "alpha", value: 3 },
            { id: "entry-4", group: "beta", value: 2 },
          ],
        },
        {
          path: "summaries",
          value: [
            { group: "alpha", total: 5, count: 2 },
            { group: "beta", total: 11, count: 2 },
          ],
        },
        { path: "groupTotals", value: { alpha: 5, beta: 11 } },
        { path: "overallTotal", value: 16 },
        { path: "groupCount", value: 2 },
        {
          path: "dominantGroup",
          value: { group: "beta", total: 11, count: 2 },
        },
        {
          path: "summaryLabel",
          value: "Group totals alpha: 5 (2) • beta: 11 (2)",
        },
      ],
    },
    {
      events: [{
        stream: "controls.record",
        payload: { id: "north", group: "gamma", value: 6 },
      }],
      expect: [
        {
          path: "entries",
          value: [
            { id: "north", group: "gamma", value: 6 },
            { id: "east", group: "beta", value: 9 },
            { id: "west", group: "alpha", value: 3 },
            { id: "entry-4", group: "beta", value: 2 },
          ],
        },
        {
          path: "summaries",
          value: [
            { group: "alpha", total: 3, count: 1 },
            { group: "beta", total: 11, count: 2 },
            { group: "gamma", total: 6, count: 1 },
          ],
        },
        {
          path: "groupTotals",
          value: { alpha: 3, beta: 11, gamma: 6 },
        },
        { path: "overallTotal", value: 20 },
        { path: "groupCount", value: 3 },
        {
          path: "dominantGroup",
          value: { group: "beta", total: 11, count: 2 },
        },
        {
          path: "summaryLabel",
          value: "Group totals alpha: 3 (1) • beta: 11 (2) • gamma: 6 (1)",
        },
      ],
    },
  ],
};

export const scenarios = [counterGroupedSummaryScenario];

describe("counter-grouped-summary", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
