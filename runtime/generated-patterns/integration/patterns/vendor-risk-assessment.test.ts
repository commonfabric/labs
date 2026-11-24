import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const vendorRiskAssessmentScenario: PatternIntegrationScenario<
  {
    vendors?: {
      id?: string;
      name?: string;
      category?: string;
      responses?: {
        topic?: string;
        rating?: number;
        weight?: number;
      }[];
    }[];
  }
> = {
  name: "vendor risk tiers update when responses change",
  module: new URL(
    "./vendor-risk-assessment.pattern.ts",
    import.meta.url,
  ),
  exportName: "vendorRiskAssessment",
  steps: [
    {
      expect: [
        { path: "riskOverview", value: "High: 1, Medium: 1, Low: 1" },
        {
          path: "tierBreakdown",
          value: [
            {
              tier: "high",
              vendors: [
                {
                  id: "vendor-apex-cloud",
                  name: "Apex Cloud",
                  score: 87,
                },
              ],
            },
            {
              tier: "medium",
              vendors: [
                {
                  id: "vendor-data-harbor",
                  name: "Data Harbor",
                  score: 50,
                },
              ],
            },
            {
              tier: "low",
              vendors: [
                {
                  id: "vendor-orbita-supplies",
                  name: "Orbita Supplies",
                  score: 24,
                },
              ],
            },
          ],
        },
        { path: "highestRiskLabel", value: "Apex Cloud (87)" },
        { path: "auditTrail", value: [] },
      ],
    },
    {
      events: [
        {
          stream: "adjustResponse",
          payload: {
            vendorId: "vendor-data-harbor",
            topic: "security",
            rating: 32,
            weight: 2,
          },
        },
      ],
      expect: [
        { path: "riskOverview", value: "High: 2, Medium: 0, Low: 1" },
        {
          path: "tierBreakdown",
          value: [
            {
              tier: "high",
              vendors: [
                {
                  id: "vendor-data-harbor",
                  name: "Data Harbor",
                  score: 96,
                },
                {
                  id: "vendor-apex-cloud",
                  name: "Apex Cloud",
                  score: 87,
                },
              ],
            },
            { tier: "medium", vendors: [] },
            {
              tier: "low",
              vendors: [
                {
                  id: "vendor-orbita-supplies",
                  name: "Orbita Supplies",
                  score: 24,
                },
              ],
            },
          ],
        },
        { path: "highestRiskLabel", value: "Data Harbor (96)" },
        {
          path: "auditTrail",
          value: [
            "Adjusted security for vendor-data-harbor to 32 @ 2 (total 96)",
          ],
        },
      ],
    },
  ],
};

export const scenarios = [vendorRiskAssessmentScenario];

describe("vendor-risk-assessment", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
