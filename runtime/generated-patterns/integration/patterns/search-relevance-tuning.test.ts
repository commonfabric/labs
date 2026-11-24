import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const searchRelevanceTuningScenario: PatternIntegrationScenario<
  {
    results?: {
      id?: string;
      title?: string;
      textScore?: number;
      clickRate?: number;
      freshness?: number;
    }[];
    weights?: { text?: number; clicks?: number; freshness?: number };
  }
> = {
  name: "search relevance adjusts ordering with weight tuning",
  module: new URL(
    "./search-relevance-tuning.pattern.ts",
    import.meta.url,
  ),
  exportName: "searchRelevanceTuning",
  argument: {
    weights: { text: 2, clicks: 1, freshness: 0.5 },
    results: [
      {
        id: "alpha",
        title: "Alpha result",
        textScore: 0.9,
        clickRate: 0.2,
        freshness: 0.5,
      },
      {
        id: "beta",
        title: "Beta doc",
        textScore: 0.7,
        clickRate: 0.6,
        freshness: 0.4,
      },
      {
        id: "gamma",
        title: "Gamma article",
        textScore: 0.6,
        clickRate: 0.1,
        freshness: 0.9,
      },
    ],
  },
  steps: [
    {
      expect: [
        {
          path: "sanitizedWeights",
          value: { text: 2, clicks: 1, freshness: 0.5 },
        },
        {
          path: "normalizedWeights",
          value: { text: 0.571, clicks: 0.286, freshness: 0.143 },
        },
        {
          path: "relevanceOrder",
          value: ["alpha", "beta", "gamma"],
        },
        {
          path: "scoreSample",
          value: [
            "Alpha result: 0.643",
            "Beta doc: 0.629",
            "Gamma article: 0.501",
          ],
        },
        {
          path: "scoreSummary",
          value:
            "Alpha result leads at 0.643 with Weights text 0.571 | clicks 0.286 | freshness 0.143",
        },
        {
          path: "contributionSummary",
          value: "text 0.514 | clicks 0.057 | freshness 0.072",
        },
      ],
    },
    {
      events: [{
        stream: "tuneWeights",
        payload: { text: 1.2, clicks: 3.8, freshness: 0.5 },
      }],
      expect: [
        {
          path: "sanitizedWeights",
          value: { text: 1.2, clicks: 3.8, freshness: 0.5 },
        },
        {
          path: "normalizedWeights",
          value: { text: 0.218, clicks: 0.691, freshness: 0.091 },
        },
        {
          path: "relevanceOrder",
          value: ["beta", "alpha", "gamma"],
        },
        {
          path: "scoreSample",
          value: [
            "Beta doc: 0.604",
            "Alpha result: 0.380",
            "Gamma article: 0.282",
          ],
        },
        {
          path: "scoreSummary",
          value:
            "Beta doc leads at 0.604 with Weights text 0.218 | clicks 0.691 | freshness 0.091",
        },
        {
          path: "contributionSummary",
          value: "text 0.153 | clicks 0.415 | freshness 0.036",
        },
      ],
    },
    {
      events: [{
        stream: "updateResult",
        payload: {
          id: "gamma",
          textDelta: 0.05,
          clickRate: 0.8,
          freshness: 0.95,
        },
      }],
      expect: [
        {
          path: "sanitizedResults",
          value: [
            {
              id: "alpha",
              title: "Alpha result",
              textScore: 0.9,
              clickRate: 0.2,
              freshness: 0.5,
            },
            {
              id: "beta",
              title: "Beta doc",
              textScore: 0.7,
              clickRate: 0.6,
              freshness: 0.4,
            },
            {
              id: "gamma",
              title: "Gamma article",
              textScore: 0.65,
              clickRate: 0.8,
              freshness: 0.95,
            },
          ],
        },
        {
          path: "relevanceOrder",
          value: ["gamma", "beta", "alpha"],
        },
        {
          path: "scoreSample",
          value: [
            "Gamma article: 0.781",
            "Beta doc: 0.604",
            "Alpha result: 0.380",
          ],
        },
        {
          path: "scoreSummary",
          value:
            "Gamma article leads at 0.781 with Weights text 0.218 | clicks 0.691 | freshness 0.091",
        },
        {
          path: "contributionSummary",
          value: "text 0.142 | clicks 0.553 | freshness 0.086",
        },
      ],
    },
  ],
};

export const scenarios = [searchRelevanceTuningScenario];

describe("search-relevance-tuning", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
