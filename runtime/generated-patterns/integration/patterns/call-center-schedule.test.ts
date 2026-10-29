import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const callCenterScheduleScenario: PatternIntegrationScenario = {
  name: "call center coverage gaps close and reopen across slots",
  module: new URL("./call-center-schedule.pattern.ts", import.meta.url),
  exportName: "callCenterSchedulePattern",
  steps: [
    {
      expect: [
        {
          path: "gapSummary",
          value: "Coverage gaps: Midday Block",
        },
        {
          path: "coverageStatus",
          value: "3/4 slots covered; open gaps 1",
        },
        {
          path: "coverageGaps",
          value: ["10:00-12:00"],
        },
        {
          path: "coverage",
          value: [
            {
              slot: "08:00-10:00",
              label: "Morning Block",
              required: 1,
              assigned: ["Alex Rivera"],
              assignedCount: 1,
              remaining: 0,
              hasGap: false,
            },
            {
              slot: "10:00-12:00",
              label: "Midday Block",
              required: 1,
              assigned: [],
              assignedCount: 0,
              remaining: 1,
              hasGap: true,
            },
            {
              slot: "12:00-14:00",
              label: "Lunch Block",
              required: 1,
              assigned: ["Blair Chen"],
              assignedCount: 1,
              remaining: 0,
              hasGap: false,
            },
            {
              slot: "14:00-16:00",
              label: "Afternoon Block",
              required: 1,
              assigned: ["Casey James"],
              assignedCount: 1,
              remaining: 0,
              hasGap: false,
            },
          ],
        },
        { path: "history", value: [] },
        { path: "latestChange", value: null },
        { path: "remainingCoverage", value: 1 },
      ],
    },
    {
      events: [
        {
          stream: "controls.updateShift",
          payload: {
            slot: "Midday Block",
            agent: "Drew Patel",
            action: "assign",
          },
        },
      ],
      expect: [
        { path: "gapSummary", value: "All slots covered" },
        {
          path: "coverageStatus",
          value: "4/4 slots covered; open gaps 0",
        },
        { path: "coverageGaps", value: [] },
        {
          path: "coverage",
          value: [
            {
              slot: "08:00-10:00",
              label: "Morning Block",
              required: 1,
              assigned: ["Alex Rivera"],
              assignedCount: 1,
              remaining: 0,
              hasGap: false,
            },
            {
              slot: "10:00-12:00",
              label: "Midday Block",
              required: 1,
              assigned: ["Drew Patel"],
              assignedCount: 1,
              remaining: 0,
              hasGap: false,
            },
            {
              slot: "12:00-14:00",
              label: "Lunch Block",
              required: 1,
              assigned: ["Blair Chen"],
              assignedCount: 1,
              remaining: 0,
              hasGap: false,
            },
            {
              slot: "14:00-16:00",
              label: "Afternoon Block",
              required: 1,
              assigned: ["Casey James"],
              assignedCount: 1,
              remaining: 0,
              hasGap: false,
            },
          ],
        },
        {
          path: "history",
          value: ["Assigned Drew Patel to Midday Block"],
        },
        {
          path: "latestChange",
          value: {
            sequence: 1,
            slot: "10:00-12:00",
            label: "Midday Block",
            action: "assign",
            agentId: "drew-patel",
            agentName: "Drew Patel",
            gapCount: 0,
            remaining: 0,
          },
        },
        { path: "remainingCoverage", value: 0 },
      ],
    },
    {
      events: [
        {
          stream: "controls.updateShift",
          payload: {
            slot: "Morning Block",
            agent: "Alex Rivera",
            action: "unschedule",
          },
        },
      ],
      expect: [
        {
          path: "gapSummary",
          value: "Coverage gaps: Morning Block",
        },
        {
          path: "coverageStatus",
          value: "3/4 slots covered; open gaps 1",
        },
        {
          path: "coverageGaps",
          value: ["08:00-10:00"],
        },
        {
          path: "coverage",
          value: [
            {
              slot: "08:00-10:00",
              label: "Morning Block",
              required: 1,
              assigned: [],
              assignedCount: 0,
              remaining: 1,
              hasGap: true,
            },
            {
              slot: "10:00-12:00",
              label: "Midday Block",
              required: 1,
              assigned: ["Drew Patel"],
              assignedCount: 1,
              remaining: 0,
              hasGap: false,
            },
            {
              slot: "12:00-14:00",
              label: "Lunch Block",
              required: 1,
              assigned: ["Blair Chen"],
              assignedCount: 1,
              remaining: 0,
              hasGap: false,
            },
            {
              slot: "14:00-16:00",
              label: "Afternoon Block",
              required: 1,
              assigned: ["Casey James"],
              assignedCount: 1,
              remaining: 0,
              hasGap: false,
            },
          ],
        },
        {
          path: "history",
          value: [
            "Assigned Drew Patel to Midday Block",
            "Removed Alex Rivera from Morning Block",
          ],
        },
        {
          path: "latestChange",
          value: {
            sequence: 2,
            slot: "08:00-10:00",
            label: "Morning Block",
            action: "unschedule",
            agentId: "alex-rivera",
            agentName: "Alex Rivera",
            gapCount: 1,
            remaining: 1,
          },
        },
        { path: "remainingCoverage", value: 1 },
      ],
    },
  ],
};

export const scenarios = [callCenterScheduleScenario];

describe("call-center-schedule", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
