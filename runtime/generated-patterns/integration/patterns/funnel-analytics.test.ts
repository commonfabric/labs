import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const funnelAnalyticsScenario: PatternIntegrationScenario<
  { stages?: Array<{ id?: string; label?: string; count?: number }> }
> = {
  name: "funnel analytics derives drop-off across stages",
  module: new URL("./funnel-analytics.pattern.ts", import.meta.url),
  exportName: "funnelAnalytics",
  steps: [
    {
      expect: [
        {
          path: "stageOrder",
          value: ["awareness", "interest", "evaluation", "purchase"],
        },
        {
          path: "stageMetrics",
          value: [
            {
              id: "awareness",
              label: "Awareness",
              count: 1200,
              dropOffRate: 0,
              conversionRate: 1,
              dropOffPercent: "0.0%",
              conversionPercent: "100.0%",
            },
            {
              id: "interest",
              label: "Interest",
              count: 720,
              dropOffRate: 0.4,
              conversionRate: 0.6,
              dropOffPercent: "40.0%",
              conversionPercent: "60.0%",
            },
            {
              id: "evaluation",
              label: "Evaluation",
              count: 320,
              dropOffRate: 0.556,
              conversionRate: 0.267,
              dropOffPercent: "55.6%",
              conversionPercent: "26.7%",
            },
            {
              id: "purchase",
              label: "Purchase",
              count: 96,
              dropOffRate: 0.7,
              conversionRate: 0.08,
              dropOffPercent: "70.0%",
              conversionPercent: "8.0%",
            },
          ],
        },
        {
          path: "dropOffDetails",
          value: [
            {
              fromId: "awareness",
              toId: "interest",
              fromStage: "Awareness",
              toStage: "Interest",
              lost: 480,
              dropOffRate: 0.4,
              dropOffPercent: "40.0%",
            },
            {
              fromId: "interest",
              toId: "evaluation",
              fromStage: "Interest",
              toStage: "Evaluation",
              lost: 400,
              dropOffRate: 0.556,
              dropOffPercent: "55.6%",
            },
            {
              fromId: "evaluation",
              toId: "purchase",
              fromStage: "Evaluation",
              toStage: "Purchase",
              lost: 224,
              dropOffRate: 0.7,
              dropOffPercent: "70.0%",
            },
          ],
        },
        {
          path: "overallConversionPercent",
          value: "8.0%",
        },
        {
          path: "overallConversionLabel",
          value: "Overall conversion 8.0%",
        },
        {
          path: "dropOffSummary",
          value: "Purchase drop-off 70.0%",
        },
        { path: "updateHistory", value: [] },
        {
          path: "lastUpdate",
          value: { stageId: "none", label: "None", count: 0, mode: "delta" },
        },
      ],
    },
    {
      events: [
        {
          stream: "updateStage",
          payload: { stageId: "interest", value: 840 },
        },
      ],
      expect: [
        {
          path: "stageMetrics",
          value: [
            {
              id: "awareness",
              label: "Awareness",
              count: 1200,
              dropOffRate: 0,
              conversionRate: 1,
              dropOffPercent: "0.0%",
              conversionPercent: "100.0%",
            },
            {
              id: "interest",
              label: "Interest",
              count: 840,
              dropOffRate: 0.3,
              conversionRate: 0.7,
              dropOffPercent: "30.0%",
              conversionPercent: "70.0%",
            },
            {
              id: "evaluation",
              label: "Evaluation",
              count: 320,
              dropOffRate: 0.619,
              conversionRate: 0.267,
              dropOffPercent: "61.9%",
              conversionPercent: "26.7%",
            },
            {
              id: "purchase",
              label: "Purchase",
              count: 96,
              dropOffRate: 0.7,
              conversionRate: 0.08,
              dropOffPercent: "70.0%",
              conversionPercent: "8.0%",
            },
          ],
        },
        {
          path: "dropOffDetails",
          value: [
            {
              fromId: "awareness",
              toId: "interest",
              fromStage: "Awareness",
              toStage: "Interest",
              lost: 360,
              dropOffRate: 0.3,
              dropOffPercent: "30.0%",
            },
            {
              fromId: "interest",
              toId: "evaluation",
              fromStage: "Interest",
              toStage: "Evaluation",
              lost: 520,
              dropOffRate: 0.619,
              dropOffPercent: "61.9%",
            },
            {
              fromId: "evaluation",
              toId: "purchase",
              fromStage: "Evaluation",
              toStage: "Purchase",
              lost: 224,
              dropOffRate: 0.7,
              dropOffPercent: "70.0%",
            },
          ],
        },
        {
          path: "dropOffSummary",
          value: "Purchase drop-off 70.0%",
        },
        {
          path: "overallConversionPercent",
          value: "8.0%",
        },
        {
          path: "updateHistory",
          value: [
            {
              stageId: "interest",
              label: "Interest",
              count: 840,
              mode: "value",
            },
          ],
        },
        {
          path: "lastUpdate",
          value: {
            stageId: "interest",
            label: "Interest",
            count: 840,
            mode: "value",
          },
        },
      ],
    },
    {
      events: [
        {
          stream: "loadSnapshot",
          payload: {
            stages: [
              { label: "Awareness", count: 1000 },
              { label: "Consideration Stage", count: 500 },
              { label: "Purchase", count: 450 },
            ],
          },
        },
      ],
      expect: [
        {
          path: "stageOrder",
          value: ["awareness", "consideration-stage", "purchase"],
        },
        {
          path: "stageMetrics",
          value: [
            {
              id: "awareness",
              label: "Awareness",
              count: 1000,
              dropOffRate: 0,
              conversionRate: 1,
              dropOffPercent: "0.0%",
              conversionPercent: "100.0%",
            },
            {
              id: "consideration-stage",
              label: "Consideration Stage",
              count: 500,
              dropOffRate: 0.5,
              conversionRate: 0.5,
              dropOffPercent: "50.0%",
              conversionPercent: "50.0%",
            },
            {
              id: "purchase",
              label: "Purchase",
              count: 450,
              dropOffRate: 0.1,
              conversionRate: 0.45,
              dropOffPercent: "10.0%",
              conversionPercent: "45.0%",
            },
          ],
        },
        {
          path: "dropOffDetails",
          value: [
            {
              fromId: "awareness",
              toId: "consideration-stage",
              fromStage: "Awareness",
              toStage: "Consideration Stage",
              lost: 500,
              dropOffRate: 0.5,
              dropOffPercent: "50.0%",
            },
            {
              fromId: "consideration-stage",
              toId: "purchase",
              fromStage: "Consideration Stage",
              toStage: "Purchase",
              lost: 50,
              dropOffRate: 0.1,
              dropOffPercent: "10.0%",
            },
          ],
        },
        {
          path: "overallConversionLabel",
          value: "Overall conversion 45.0%",
        },
        {
          path: "dropOffSummary",
          value: "Consideration Stage drop-off 50.0%",
        },
        { path: "updateHistory", value: [] },
        {
          path: "lastUpdate",
          value: { stageId: "none", label: "None", count: 0, mode: "delta" },
        },
      ],
    },
  ],
};

export const scenarios = [funnelAnalyticsScenario];

describe("funnel-analytics", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
