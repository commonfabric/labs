import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const sleepJournalScenario: PatternIntegrationScenario<
  { sessions?: Array<Record<string, unknown>> }
> = {
  name: "sleep journal derives tag and weekday averages",
  module: new URL("./sleep-journal.pattern.ts", import.meta.url),
  exportName: "sleepJournalPattern",
  steps: [
    {
      expect: [
        { path: "sessionLog", value: [] },
        { path: "tagAverages", value: [] },
        { path: "weekdayAverages", value: [] },
        {
          path: "metrics",
          value: {
            sessionCount: 0,
            totalHours: 0,
            averageHours: 0,
          },
        },
        { path: "summary", value: "0 sessions averaging 0 hours" },
        { path: "totalsLabel", value: "0 total hours slept" },
        { path: "latestEntry", value: null },
      ],
    },
    {
      events: [
        {
          stream: "log",
          payload: {
            date: "2024-06-10",
            hours: 7,
            tags: ["restorative", "normal"],
          },
        },
      ],
      expect: [
        { path: "sessionLog.0.hours", value: 7 },
        { path: "sessionLog.0.weekday", value: "Monday" },
        {
          path: "tagAverages",
          value: [
            { tag: "normal", averageHours: 7, sessionCount: 1 },
            { tag: "restorative", averageHours: 7, sessionCount: 1 },
          ],
        },
        {
          path: "weekdayAverages",
          value: [
            { weekday: "Monday", averageHours: 7, sessionCount: 1 },
          ],
        },
        {
          path: "metrics",
          value: { sessionCount: 1, totalHours: 7, averageHours: 7 },
        },
        { path: "summary", value: "1 sessions averaging 7 hours" },
        { path: "totalsLabel", value: "7 total hours slept" },
        { path: "latestEntry.weekday", value: "Monday" },
      ],
    },
    {
      events: [
        {
          stream: "log",
          payload: {
            date: "2024-06-11",
            hours: 6.5,
            tags: ["normal"],
          },
        },
      ],
      expect: [
        {
          path: "tagAverages",
          value: [
            { tag: "normal", averageHours: 6.75, sessionCount: 2 },
            { tag: "restorative", averageHours: 7, sessionCount: 1 },
          ],
        },
        {
          path: "weekdayAverages",
          value: [
            { weekday: "Monday", averageHours: 7, sessionCount: 1 },
            { weekday: "Tuesday", averageHours: 6.5, sessionCount: 1 },
          ],
        },
        {
          path: "metrics",
          value: {
            sessionCount: 2,
            totalHours: 13.5,
            averageHours: 6.75,
          },
        },
        { path: "summary", value: "2 sessions averaging 6.75 hours" },
        { path: "totalsLabel", value: "13.5 total hours slept" },
        { path: "latestEntry.weekday", value: "Tuesday" },
      ],
    },
    {
      events: [
        {
          stream: "log",
          payload: {
            date: "2024-06-12",
            hours: 8,
            tags: ["deep", "restorative"],
          },
        },
      ],
      expect: [
        {
          path: "tagAverages",
          value: [
            { tag: "deep", averageHours: 8, sessionCount: 1 },
            { tag: "normal", averageHours: 6.75, sessionCount: 2 },
            { tag: "restorative", averageHours: 7.5, sessionCount: 2 },
          ],
        },
        {
          path: "weekdayAverages",
          value: [
            { weekday: "Monday", averageHours: 7, sessionCount: 1 },
            { weekday: "Tuesday", averageHours: 6.5, sessionCount: 1 },
            { weekday: "Wednesday", averageHours: 8, sessionCount: 1 },
          ],
        },
        {
          path: "metrics",
          value: {
            sessionCount: 3,
            totalHours: 21.5,
            averageHours: 7.17,
          },
        },
        { path: "summary", value: "3 sessions averaging 7.17 hours" },
        { path: "totalsLabel", value: "21.5 total hours slept" },
        { path: "latestEntry.weekday", value: "Wednesday" },
      ],
    },
    {
      events: [
        {
          stream: "log",
          payload: {
            date: "2024-06-17",
            hours: 6,
            tags: ["normal", "travel"],
          },
        },
      ],
      expect: [
        {
          path: "tagAverages",
          value: [
            { tag: "deep", averageHours: 8, sessionCount: 1 },
            { tag: "normal", averageHours: 6.5, sessionCount: 3 },
            { tag: "restorative", averageHours: 7.5, sessionCount: 2 },
            { tag: "travel", averageHours: 6, sessionCount: 1 },
          ],
        },
        {
          path: "weekdayAverages",
          value: [
            { weekday: "Monday", averageHours: 6.5, sessionCount: 2 },
            { weekday: "Tuesday", averageHours: 6.5, sessionCount: 1 },
            { weekday: "Wednesday", averageHours: 8, sessionCount: 1 },
          ],
        },
        {
          path: "metrics",
          value: {
            sessionCount: 4,
            totalHours: 27.5,
            averageHours: 6.88,
          },
        },
        { path: "summary", value: "4 sessions averaging 6.88 hours" },
        { path: "totalsLabel", value: "27.5 total hours slept" },
        { path: "latestEntry.weekday", value: "Monday" },
      ],
    },
  ],
};

export const scenarios = [sleepJournalScenario];

describe("sleep-journal", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
