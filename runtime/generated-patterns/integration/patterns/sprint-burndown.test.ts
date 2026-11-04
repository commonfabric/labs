import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const sprintBurndownScenario: PatternIntegrationScenario<
  {
    totalScope?: number;
    sprintLength?: number;
    snapshots?: Array<{ day: number; remaining: number }>;
  }
> = {
  name: "sprint burndown projects remaining work and projection",
  module: new URL("./sprint-burndown.pattern.ts", import.meta.url),
  exportName: "sprintBurndown",
  argument: {
    totalScope: 40,
    sprintLength: 5,
    snapshots: [],
  },
  steps: [
    {
      expect: [
        { path: "totalScope", value: 40 },
        { path: "sprintLength", value: 5 },
        {
          path: "history",
          value: [{ day: 0, remaining: 40 }],
        },
        { path: "remaining", value: 40 },
        { path: "burned", value: 0 },
        { path: "completion", value: 0 },
        {
          path: "burndownCurve",
          value: [
            { day: 0, actual: 40, projected: 40, ideal: 40 },
            { day: 1, actual: null, projected: 40, ideal: 32 },
            { day: 2, actual: null, projected: 40, ideal: 24 },
            { day: 3, actual: null, projected: 40, ideal: 16 },
            { day: 4, actual: null, projected: 40, ideal: 8 },
            { day: 5, actual: null, projected: 40, ideal: 0 },
          ],
        },
        {
          path: "idealLine",
          value: [
            { day: 0, remaining: 40 },
            { day: 1, remaining: 32 },
            { day: 2, remaining: 24 },
            { day: 3, remaining: 16 },
            { day: 4, remaining: 8 },
            { day: 5, remaining: 0 },
          ],
        },
        { path: "activityLog", value: [] },
        {
          path: "statusLabel",
          value: "Day 0/5 — burned 0 (0%)",
        },
      ],
    },
    {
      events: [{ stream: "logDay", payload: { completed: 5 } }],
      expect: [
        {
          path: "history",
          value: [
            { day: 0, remaining: 40 },
            { day: 1, remaining: 35 },
          ],
        },
        { path: "remaining", value: 35 },
        { path: "burned", value: 5 },
        { path: "completion", value: 13 },
        {
          path: "burndownCurve",
          value: [
            { day: 0, actual: 40, projected: 40, ideal: 40 },
            { day: 1, actual: 35, projected: 35, ideal: 32 },
            { day: 2, actual: null, projected: 30, ideal: 24 },
            { day: 3, actual: null, projected: 25, ideal: 16 },
            { day: 4, actual: null, projected: 20, ideal: 8 },
            { day: 5, actual: null, projected: 15, ideal: 0 },
          ],
        },
        {
          path: "activityLog",
          value: ["Day 1: burned 5 (total 5) remaining 35"],
        },
        {
          path: "statusLabel",
          value: "Day 1/5 — burned 5 (13%)",
        },
      ],
    },
    {
      events: [{ stream: "logDay", payload: { completed: 9 } }],
      expect: [
        {
          path: "history",
          value: [
            { day: 0, remaining: 40 },
            { day: 1, remaining: 35 },
            { day: 2, remaining: 26 },
          ],
        },
        { path: "remaining", value: 26 },
        { path: "burned", value: 14 },
        { path: "completion", value: 35 },
        {
          path: "burndownCurve",
          value: [
            { day: 0, actual: 40, projected: 40, ideal: 40 },
            { day: 1, actual: 35, projected: 35, ideal: 32 },
            { day: 2, actual: 26, projected: 26, ideal: 24 },
            { day: 3, actual: null, projected: 19, ideal: 16 },
            { day: 4, actual: null, projected: 12, ideal: 8 },
            { day: 5, actual: null, projected: 5, ideal: 0 },
          ],
        },
        {
          path: "activityLog",
          value: [
            "Day 1: burned 5 (total 5) remaining 35",
            "Day 2: burned 9 (total 14) remaining 26",
          ],
        },
        {
          path: "statusLabel",
          value: "Day 2/5 — burned 14 (35%)",
        },
      ],
    },
    {
      events: [{
        stream: "logDay",
        payload: { day: 3, remaining: 15, note: "scope trimmed" },
      }],
      expect: [
        {
          path: "history",
          value: [
            { day: 0, remaining: 40 },
            { day: 1, remaining: 35 },
            { day: 2, remaining: 26 },
            { day: 3, remaining: 15 },
          ],
        },
        { path: "remaining", value: 15 },
        { path: "burned", value: 25 },
        { path: "completion", value: 63 },
        {
          path: "burndownCurve",
          value: [
            { day: 0, actual: 40, projected: 40, ideal: 40 },
            { day: 1, actual: 35, projected: 35, ideal: 32 },
            { day: 2, actual: 26, projected: 26, ideal: 24 },
            { day: 3, actual: 15, projected: 15, ideal: 16 },
            { day: 4, actual: null, projected: 6.67, ideal: 8 },
            { day: 5, actual: null, projected: 0, ideal: 0 },
          ],
        },
        {
          path: "activityLog",
          value: [
            "Day 1: burned 5 (total 5) remaining 35",
            "Day 2: burned 9 (total 14) remaining 26",
            "Day 3: burned 11 (total 25) remaining 15 — scope trimmed",
          ],
        },
        {
          path: "statusLabel",
          value: "Day 3/5 — burned 25 (63%)",
        },
      ],
    },
  ],
};

export const scenarios = [sprintBurndownScenario];

describe("sprint-burndown", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
