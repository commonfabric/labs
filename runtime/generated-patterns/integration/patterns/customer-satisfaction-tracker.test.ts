import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface SatisfactionScenarioEntry {
  id?: string;
  date?: string;
  score?: number;
  responses?: number;
  channel?: string;
}

export const customerSatisfactionTrackerScenario: PatternIntegrationScenario<
  { responses?: SatisfactionScenarioEntry[] }
> = {
  name:
    "customer satisfaction tracker updates moving averages after new surveys",
  module: new URL(
    "./customer-satisfaction-tracker.pattern.ts",
    import.meta.url,
  ),
  exportName: "customerSatisfactionTracker",
  argument: {
    responses: [
      {
        id: "legacy-entry",
        date: "2024-07-01",
        score: 5.2,
        responses: 50,
        channel: "Email",
      },
      {
        date: "2024-07-02T12:00:00.000Z",
        score: 2,
        responses: 20,
        channel: "Chat",
      },
      {
        date: "2024-07-02",
        score: 4,
        responses: 10,
        channel: " chat ",
      },
    ],
  },
  steps: [
    {
      expect: [
        { path: "responseLog.length", value: 3 },
        { path: "responseLog.0.id", value: "legacy-entry" },
        { path: "responseLog.0.score", value: 5 },
        { path: "responseLog.1.id", value: "2024-07-02-chat-seed-2" },
        { path: "responseLog.2.channel", value: "chat" },
        {
          path: "dailySummaries",
          value: [
            { date: "2024-07-01", average: 5, responseCount: 50 },
            { date: "2024-07-02", average: 2.67, responseCount: 30 },
          ],
        },
        {
          path: "movingAverages",
          value: [
            {
              date: "2024-07-01",
              dailyAverage: 5,
              trailing3: 5,
              trailing7: 5,
            },
            {
              date: "2024-07-02",
              dailyAverage: 2.67,
              trailing3: 4.13,
              trailing7: 4.13,
            },
          ],
        },
        { path: "overallAverage", value: 4.13 },
        { path: "overallAverageLabel", value: "4.13" },
        { path: "responseCount", value: 80 },
        { path: "dayCount", value: 2 },
        { path: "trendDirection", value: "falling" },
        {
          path: "channelAverages",
          value: { chat: 2.67, email: 5 },
        },
        {
          path: "summary",
          value: "80 responses across 2 days avg 4.13 trend falling",
        },
      ],
    },
    {
      events: [
        {
          stream: "recordResponse",
          payload: {
            date: "2024-07-03",
            score: 4.6,
            responses: 40,
            channel: "Email",
          },
        },
      ],
      expect: [
        { path: "responseLog.length", value: 4 },
        { path: "responseLog.3.date", value: "2024-07-03" },
        {
          path: "dailySummaries",
          value: [
            { date: "2024-07-01", average: 5, responseCount: 50 },
            { date: "2024-07-02", average: 2.67, responseCount: 30 },
            { date: "2024-07-03", average: 4.6, responseCount: 40 },
          ],
        },
        {
          path: "movingAverages",
          value: [
            {
              date: "2024-07-01",
              dailyAverage: 5,
              trailing3: 5,
              trailing7: 5,
            },
            {
              date: "2024-07-02",
              dailyAverage: 2.67,
              trailing3: 4.13,
              trailing7: 4.13,
            },
            {
              date: "2024-07-03",
              dailyAverage: 4.6,
              trailing3: 4.28,
              trailing7: 4.28,
            },
          ],
        },
        { path: "overallAverage", value: 4.28 },
        { path: "overallAverageLabel", value: "4.28" },
        { path: "responseCount", value: 120 },
        { path: "dayCount", value: 3 },
        { path: "trendDirection", value: "rising" },
        {
          path: "channelAverages",
          value: { chat: 2.67, email: 4.82 },
        },
        {
          path: "summary",
          value: "120 responses across 3 days avg 4.28 trend rising",
        },
      ],
    },
    {
      events: [
        {
          stream: "recordResponse",
          payload: {
            date: "2024-07-04T10:00:00.000Z",
            score: 1.4,
            responses: 25,
            channel: "Support",
          },
        },
      ],
      expect: [
        { path: "responseLog.length", value: 5 },
        { path: "responseLog.4.channel", value: "support" },
        {
          path: "dailySummaries",
          value: [
            { date: "2024-07-01", average: 5, responseCount: 50 },
            { date: "2024-07-02", average: 2.67, responseCount: 30 },
            { date: "2024-07-03", average: 4.6, responseCount: 40 },
            { date: "2024-07-04", average: 1.4, responseCount: 25 },
          ],
        },
        {
          path: "movingAverages",
          value: [
            {
              date: "2024-07-01",
              dailyAverage: 5,
              trailing3: 5,
              trailing7: 5,
            },
            {
              date: "2024-07-02",
              dailyAverage: 2.67,
              trailing3: 4.13,
              trailing7: 4.13,
            },
            {
              date: "2024-07-03",
              dailyAverage: 4.6,
              trailing3: 4.28,
              trailing7: 4.28,
            },
            {
              date: "2024-07-04",
              dailyAverage: 1.4,
              trailing3: 3.15,
              trailing7: 3.79,
            },
          ],
        },
        { path: "overallAverage", value: 3.79 },
        { path: "overallAverageLabel", value: "3.79" },
        { path: "responseCount", value: 145 },
        { path: "dayCount", value: 4 },
        { path: "trendDirection", value: "falling" },
        {
          path: "channelAverages",
          value: { chat: 2.67, email: 4.82, support: 1.4 },
        },
        {
          path: "summary",
          value: "145 responses across 4 days avg 3.79 trend falling",
        },
      ],
    },
  ],
};

export const scenarios = [customerSatisfactionTrackerScenario];

describe("customer-satisfaction-tracker", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
