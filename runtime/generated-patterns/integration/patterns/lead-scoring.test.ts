import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface LeadArgument {
  id?: string;
  name?: string;
  base?: number;
  signals?: Record<string, number>;
}

interface SignalWeightArgument {
  signal?: string;
  label?: string;
  weight?: number;
}

interface LeadScoringArgument {
  leads?: LeadArgument[];
  signalWeights?: SignalWeightArgument[];
  defaultWeight?: number;
}

export const leadScoringScenario: PatternIntegrationScenario<
  LeadScoringArgument
> = {
  name: "lead scoring updates totals as signals mutate",
  module: new URL("./lead-scoring.pattern.ts", import.meta.url),
  exportName: "leadScoring",
  argument: {
    leads: [
      {
        id: "acme",
        name: "Acme Manufacturing",
        base: 35,
        signals: { engagement: 3, fit: 2 },
      },
      {
        id: "nova",
        name: "Nova Retail",
        base: 20,
        signals: { engagement: 4 },
      },
      {
        id: "bright",
        name: "Bright Ventures",
        base: 15,
        signals: { fit: 3, timing: 2 },
      },
    ],
    signalWeights: [
      { signal: "Engagement", label: "Engagement", weight: 2.5 },
      { signal: "Fit", label: "Product Fit", weight: 3.5 },
      { signal: "Timing", label: "Timing", weight: 1.2 },
    ],
    defaultWeight: 1.5,
  },
  steps: [
    {
      expect: [
        {
          path: "leads",
          value: [
            {
              id: "acme",
              name: "Acme Manufacturing",
              base: 35,
              signals: { engagement: 3, fit: 2 },
            },
            {
              id: "bright",
              name: "Bright Ventures",
              base: 15,
              signals: { fit: 3, timing: 2 },
            },
            {
              id: "nova",
              name: "Nova Retail",
              base: 20,
              signals: { engagement: 4 },
            },
          ],
        },
        {
          path: "signalWeights",
          value: [
            { signal: "engagement", label: "Engagement", weight: 2.5 },
            { signal: "fit", label: "Product Fit", weight: 3.5 },
            { signal: "timing", label: "Timing", weight: 1.2 },
          ],
        },
        {
          path: "leaderboard",
          value: [
            {
              id: "acme",
              name: "Acme Manufacturing",
              base: 35,
              signals: { engagement: 3, fit: 2 },
              score: 49.5,
              signalBreakdown: [
                {
                  signal: "engagement",
                  label: "Engagement",
                  count: 3,
                  weight: 2.5,
                  contribution: 7.5,
                },
                {
                  signal: "fit",
                  label: "Product Fit",
                  count: 2,
                  weight: 3.5,
                  contribution: 7,
                },
              ],
            },
            {
              id: "nova",
              name: "Nova Retail",
              base: 20,
              signals: { engagement: 4 },
              score: 30,
              signalBreakdown: [
                {
                  signal: "engagement",
                  label: "Engagement",
                  count: 4,
                  weight: 2.5,
                  contribution: 10,
                },
              ],
            },
            {
              id: "bright",
              name: "Bright Ventures",
              base: 15,
              signals: { fit: 3, timing: 2 },
              score: 27.9,
              signalBreakdown: [
                {
                  signal: "fit",
                  label: "Product Fit",
                  count: 3,
                  weight: 3.5,
                  contribution: 10.5,
                },
                {
                  signal: "timing",
                  label: "Timing",
                  count: 2,
                  weight: 1.2,
                  contribution: 2.4,
                },
              ],
            },
          ],
        },
        {
          path: "scoreByLead",
          value: { acme: 49.5, nova: 30, bright: 27.9 },
        },
        { path: "totalScore", value: 107.4 },
        {
          path: "signalSummary",
          value: [
            {
              signal: "engagement",
              label: "Engagement",
              totalCount: 7,
              weightedTotal: 17.5,
            },
            {
              signal: "fit",
              label: "Product Fit",
              totalCount: 5,
              weightedTotal: 17.5,
            },
            {
              signal: "timing",
              label: "Timing",
              totalCount: 2,
              weightedTotal: 2.4,
            },
          ],
        },
        {
          path: "signalTotals",
          value: { engagement: 7, fit: 5, timing: 2 },
        },
        {
          path: "weightedSignalTotals",
          value: { engagement: 17.5, fit: 17.5, timing: 2.4 },
        },
        { path: "leadCount", value: 3 },
        { path: "signalCount", value: 3 },
        { path: "topLead", value: "Acme Manufacturing" },
        { path: "topScore", value: 49.5 },
        {
          path: "summaryLabel",
          value:
            "3 leads scored; top Acme Manufacturing 49.50 across 3 signals",
        },
        { path: "lastMutation", value: "none" },
        { path: "history", value: [] },
      ],
    },
    {
      events: [{
        stream: "controls.applySignal",
        payload: { leadId: "nova", signal: "fit", delta: 2 },
      }],
      expect: [
        {
          path: "leaderboard",
          value: [
            {
              id: "acme",
              name: "Acme Manufacturing",
              base: 35,
              signals: { engagement: 3, fit: 2 },
              score: 49.5,
              signalBreakdown: [
                {
                  signal: "engagement",
                  label: "Engagement",
                  count: 3,
                  weight: 2.5,
                  contribution: 7.5,
                },
                {
                  signal: "fit",
                  label: "Product Fit",
                  count: 2,
                  weight: 3.5,
                  contribution: 7,
                },
              ],
            },
            {
              id: "nova",
              name: "Nova Retail",
              base: 20,
              signals: { engagement: 4, fit: 2 },
              score: 37,
              signalBreakdown: [
                {
                  signal: "engagement",
                  label: "Engagement",
                  count: 4,
                  weight: 2.5,
                  contribution: 10,
                },
                {
                  signal: "fit",
                  label: "Product Fit",
                  count: 2,
                  weight: 3.5,
                  contribution: 7,
                },
              ],
            },
            {
              id: "bright",
              name: "Bright Ventures",
              base: 15,
              signals: { fit: 3, timing: 2 },
              score: 27.9,
              signalBreakdown: [
                {
                  signal: "fit",
                  label: "Product Fit",
                  count: 3,
                  weight: 3.5,
                  contribution: 10.5,
                },
                {
                  signal: "timing",
                  label: "Timing",
                  count: 2,
                  weight: 1.2,
                  contribution: 2.4,
                },
              ],
            },
          ],
        },
        {
          path: "scoreByLead",
          value: { acme: 49.5, nova: 37, bright: 27.9 },
        },
        {
          path: "signalSummary",
          value: [
            {
              signal: "engagement",
              label: "Engagement",
              totalCount: 7,
              weightedTotal: 17.5,
            },
            {
              signal: "fit",
              label: "Product Fit",
              totalCount: 7,
              weightedTotal: 24.5,
            },
            {
              signal: "timing",
              label: "Timing",
              totalCount: 2,
              weightedTotal: 2.4,
            },
          ],
        },
        {
          path: "signalTotals",
          value: { engagement: 7, fit: 7, timing: 2 },
        },
        {
          path: "weightedSignalTotals",
          value: { engagement: 17.5, fit: 24.5, timing: 2.4 },
        },
        {
          path: "summaryLabel",
          value:
            "3 leads scored; top Acme Manufacturing 49.50 across 3 signals",
        },
        { path: "lastMutation", value: "nova>fit +2.00" },
        { path: "history", value: ["nova>fit +2.00"] },
      ],
    },
    {
      events: [{
        stream: "controls.applySignal",
        payload: { leadId: "acme", signal: "engagement", weight: 3 },
      }],
      expect: [
        {
          path: "signalWeights",
          value: [
            { signal: "engagement", label: "Engagement", weight: 3 },
            { signal: "fit", label: "Product Fit", weight: 3.5 },
            { signal: "timing", label: "Timing", weight: 1.2 },
          ],
        },
        {
          path: "leaderboard",
          value: [
            {
              id: "acme",
              name: "Acme Manufacturing",
              base: 35,
              signals: { engagement: 3, fit: 2 },
              score: 51,
              signalBreakdown: [
                {
                  signal: "engagement",
                  label: "Engagement",
                  count: 3,
                  weight: 3,
                  contribution: 9,
                },
                {
                  signal: "fit",
                  label: "Product Fit",
                  count: 2,
                  weight: 3.5,
                  contribution: 7,
                },
              ],
            },
            {
              id: "nova",
              name: "Nova Retail",
              base: 20,
              signals: { engagement: 4, fit: 2 },
              score: 39,
              signalBreakdown: [
                {
                  signal: "engagement",
                  label: "Engagement",
                  count: 4,
                  weight: 3,
                  contribution: 12,
                },
                {
                  signal: "fit",
                  label: "Product Fit",
                  count: 2,
                  weight: 3.5,
                  contribution: 7,
                },
              ],
            },
            {
              id: "bright",
              name: "Bright Ventures",
              base: 15,
              signals: { fit: 3, timing: 2 },
              score: 27.9,
              signalBreakdown: [
                {
                  signal: "fit",
                  label: "Product Fit",
                  count: 3,
                  weight: 3.5,
                  contribution: 10.5,
                },
                {
                  signal: "timing",
                  label: "Timing",
                  count: 2,
                  weight: 1.2,
                  contribution: 2.4,
                },
              ],
            },
          ],
        },
        {
          path: "scoreByLead",
          value: { acme: 51, nova: 39, bright: 27.9 },
        },
        {
          path: "signalSummary",
          value: [
            {
              signal: "engagement",
              label: "Engagement",
              totalCount: 7,
              weightedTotal: 21,
            },
            {
              signal: "fit",
              label: "Product Fit",
              totalCount: 7,
              weightedTotal: 24.5,
            },
            {
              signal: "timing",
              label: "Timing",
              totalCount: 2,
              weightedTotal: 2.4,
            },
          ],
        },
        {
          path: "weightedSignalTotals",
          value: { engagement: 21, fit: 24.5, timing: 2.4 },
        },
        { path: "topScore", value: 51 },
        { path: "totalScore", value: 117.9 },
        {
          path: "summaryLabel",
          value:
            "3 leads scored; top Acme Manufacturing 51.00 across 3 signals",
        },
        {
          path: "history",
          value: ["nova>fit +2.00", "acme>engagement w=3.00"],
        },
        { path: "lastMutation", value: "acme>engagement w=3.00" },
      ],
    },
  ],
};

export const scenarios = [leadScoringScenario];

describe("lead-scoring", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
