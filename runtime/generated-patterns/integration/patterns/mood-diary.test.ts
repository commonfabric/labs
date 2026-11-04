import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const moodDiaryScenario: PatternIntegrationScenario<
  { entries?: Array<Record<string, unknown>> }
> = {
  name: "mood diary aggregates sentiment by tag and time",
  module: new URL("./mood-diary.pattern.ts", import.meta.url),
  exportName: "moodDiaryPattern",
  steps: [
    {
      expect: [
        { path: "entryLog", value: [] },
        { path: "tagSentiment", value: [] },
        { path: "timeSentiment", value: [] },
        {
          path: "metrics",
          value: {
            entryCount: 0,
            averageScore: 0,
            positiveCount: 0,
            negativeCount: 0,
            positiveShare: 0,
          },
        },
        {
          path: "sentimentSummary",
          value: "0 moods logged avg 0 0% positive",
        },
        { path: "latestEntry", value: null },
      ],
    },
    {
      events: [
        {
          stream: "logEntry",
          payload: {
            timestamp: "2024-06-10T08:30:00.000Z",
            mood: "uplifted",
            note: "morning writing session",
            tags: ["Work", "Gratitude"],
          },
        },
      ],
      expect: [
        { path: "entryLog.length", value: 1 },
        { path: "entryLog.0.mood", value: "uplifted" },
        { path: "entryLog.0.timeBucket", value: "morning" },
        { path: "entryLog.0.tags", value: ["gratitude", "work"] },
        {
          path: "metrics",
          value: {
            entryCount: 1,
            averageScore: 1,
            positiveCount: 1,
            negativeCount: 0,
            positiveShare: 1,
          },
        },
        {
          path: "tagSentiment",
          value: [
            {
              tag: "gratitude",
              averageScore: 1,
              entryCount: 1,
              positiveShare: 1,
            },
            {
              tag: "work",
              averageScore: 1,
              entryCount: 1,
              positiveShare: 1,
            },
          ],
        },
        {
          path: "timeSentiment",
          value: [
            {
              bucket: "morning",
              averageScore: 1,
              entryCount: 1,
              positiveShare: 1,
            },
          ],
        },
        {
          path: "sentimentSummary",
          value: "1 moods logged avg 1 100% positive",
        },
        { path: "latestEntry.note", value: "morning writing session" },
      ],
    },
    {
      events: [
        {
          stream: "logEntry",
          payload: {
            timestamp: "2024-06-10T15:45:00.000Z",
            mood: "pressed",
            note: "afternoon crunch",
            tags: ["Work", "Deadline"],
          },
        },
      ],
      expect: [
        { path: "entryLog.length", value: 2 },
        { path: "entryLog.1.mood", value: "pressed" },
        { path: "entryLog.1.timeBucket", value: "afternoon" },
        { path: "entryLog.1.tags", value: ["deadline", "work"] },
        {
          path: "metrics",
          value: {
            entryCount: 2,
            averageScore: 0,
            positiveCount: 1,
            negativeCount: 1,
            positiveShare: 0.5,
          },
        },
        {
          path: "tagSentiment",
          value: [
            {
              tag: "deadline",
              averageScore: -1,
              entryCount: 1,
              positiveShare: 0,
            },
            {
              tag: "gratitude",
              averageScore: 1,
              entryCount: 1,
              positiveShare: 1,
            },
            {
              tag: "work",
              averageScore: 0,
              entryCount: 2,
              positiveShare: 0.5,
            },
          ],
        },
        {
          path: "timeSentiment",
          value: [
            {
              bucket: "morning",
              averageScore: 1,
              entryCount: 1,
              positiveShare: 1,
            },
            {
              bucket: "afternoon",
              averageScore: -1,
              entryCount: 1,
              positiveShare: 0,
            },
          ],
        },
        {
          path: "sentimentSummary",
          value: "2 moods logged avg 0 50% positive",
        },
        { path: "latestEntry.note", value: "afternoon crunch" },
      ],
    },
    {
      events: [
        {
          stream: "logEntry",
          payload: {
            timestamp: "2024-06-10T20:15:00.000Z",
            mood: "radiant",
            note: "evening meetup",
            tags: ["Friends", "Gratitude"],
          },
        },
      ],
      expect: [
        { path: "entryLog.length", value: 3 },
        { path: "entryLog.2.mood", value: "radiant" },
        { path: "entryLog.2.timeBucket", value: "evening" },
        { path: "entryLog.2.tags", value: ["friends", "gratitude"] },
        {
          path: "metrics",
          value: {
            entryCount: 3,
            averageScore: 0.67,
            positiveCount: 2,
            negativeCount: 1,
            positiveShare: 0.67,
          },
        },
        {
          path: "tagSentiment",
          value: [
            {
              tag: "deadline",
              averageScore: -1,
              entryCount: 1,
              positiveShare: 0,
            },
            {
              tag: "friends",
              averageScore: 2,
              entryCount: 1,
              positiveShare: 1,
            },
            {
              tag: "gratitude",
              averageScore: 1.5,
              entryCount: 2,
              positiveShare: 1,
            },
            {
              tag: "work",
              averageScore: 0,
              entryCount: 2,
              positiveShare: 0.5,
            },
          ],
        },
        {
          path: "timeSentiment",
          value: [
            {
              bucket: "morning",
              averageScore: 1,
              entryCount: 1,
              positiveShare: 1,
            },
            {
              bucket: "afternoon",
              averageScore: -1,
              entryCount: 1,
              positiveShare: 0,
            },
            {
              bucket: "evening",
              averageScore: 2,
              entryCount: 1,
              positiveShare: 1,
            },
          ],
        },
        {
          path: "sentimentSummary",
          value: "3 moods logged avg 0.67 67% positive",
        },
        { path: "latestEntry.note", value: "evening meetup" },
        { path: "latestEntry.timeBucket", value: "evening" },
      ],
    },
  ],
};

export const scenarios = [moodDiaryScenario];

describe("mood-diary", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
