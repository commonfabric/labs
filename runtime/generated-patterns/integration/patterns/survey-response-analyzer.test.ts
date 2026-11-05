import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface SurveyResponseEvent {
  respondent?: string;
  demographic?: string;
  answers?: Record<string, number>;
}

export const surveyResponseAnalyzerScenario: PatternIntegrationScenario<
  { responses?: SurveyResponseEvent[]; questions?: string[] }
> = {
  name: "survey response analyzer aggregates per question and demographic",
  module: new URL("./survey-response-analyzer.pattern.ts", import.meta.url),
  exportName: "surveyResponseAnalyzer",
  argument: {
    questions: ["Satisfaction", "Ease of Use", "Support"],
    responses: [
      {
        respondent: "Alice",
        demographic: "north",
        answers: {
          "Satisfaction": 4,
          "Ease of Use": 3,
          "Support": 5,
        },
      },
      {
        respondent: "Bob",
        demographic: "south",
        answers: {
          "Satisfaction": 2,
          "Ease of Use": 4,
        },
      },
    ],
  },
  steps: [
    {
      expect: [
        {
          path: "summary",
          value: "2 responses · 3 questions · 2 demographics · avg 3.60",
        },
        {
          path: "questionSummaries",
          value: [
            { question: "Ease of Use", total: 7, answered: 2, average: 3.5 },
            { question: "Satisfaction", total: 6, answered: 2, average: 3 },
            { question: "Support", total: 5, answered: 1, average: 5 },
          ],
        },
        {
          path: "questionAverages",
          value: {
            "Ease of Use": 3.5,
            "Satisfaction": 3,
            "Support": 5,
          },
        },
        {
          path: "demographicSummaries",
          value: [
            {
              demographic: "north",
              responseCount: 1,
              questionAverages: {
                "Ease of Use": 3,
                "Satisfaction": 4,
                "Support": 5,
              },
              overallAverage: 4,
            },
            {
              demographic: "south",
              responseCount: 1,
              questionAverages: {
                "Ease of Use": 4,
                "Satisfaction": 2,
                "Support": 0,
              },
              overallAverage: 3,
            },
          ],
        },
        {
          path: "demographicAverages",
          value: {
            north: {
              "Ease of Use": 3,
              "Satisfaction": 4,
              "Support": 5,
            },
            south: {
              "Ease of Use": 4,
              "Satisfaction": 2,
              "Support": 0,
            },
          },
        },
        { path: "overallAverage", value: 3.6 },
        { path: "overallAverageLabel", value: "3.60" },
        { path: "responseCount", value: 2 },
        { path: "questionCount", value: 3 },
        { path: "demographicCount", value: 2 },
      ],
    },
    {
      events: [
        {
          stream: "recordResponse",
          payload: {
            respondent: "Cara",
            demographic: "north",
            answers: {
              "Satisfaction": 5,
              "Ease of Use": 4,
              "Support": 4,
            },
          },
        },
      ],
      expect: [
        {
          path: "summary",
          value: "3 responses · 3 questions · 2 demographics · avg 3.88",
        },
        {
          path: "questionSummaries",
          value: [
            { question: "Ease of Use", total: 11, answered: 3, average: 3.67 },
            { question: "Satisfaction", total: 11, answered: 3, average: 3.67 },
            { question: "Support", total: 9, answered: 2, average: 4.5 },
          ],
        },
        {
          path: "questionAverages",
          value: {
            "Ease of Use": 3.67,
            "Satisfaction": 3.67,
            "Support": 4.5,
          },
        },
        {
          path: "demographicSummaries",
          value: [
            {
              demographic: "north",
              responseCount: 2,
              questionAverages: {
                "Ease of Use": 3.5,
                "Satisfaction": 4.5,
                "Support": 4.5,
              },
              overallAverage: 4.17,
            },
            {
              demographic: "south",
              responseCount: 1,
              questionAverages: {
                "Ease of Use": 4,
                "Satisfaction": 2,
                "Support": 0,
              },
              overallAverage: 3,
            },
          ],
        },
        {
          path: "demographicAverages",
          value: {
            north: {
              "Ease of Use": 3.5,
              "Satisfaction": 4.5,
              "Support": 4.5,
            },
            south: {
              "Ease of Use": 4,
              "Satisfaction": 2,
              "Support": 0,
            },
          },
        },
        { path: "overallAverage", value: 3.88 },
        { path: "overallAverageLabel", value: "3.88" },
        { path: "responseCount", value: 3 },
      ],
    },
  ],
};

export const scenarios = [surveyResponseAnalyzerScenario];

describe("survey-response-analyzer", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
