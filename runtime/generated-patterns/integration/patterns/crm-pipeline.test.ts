import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface StageArgument {
  id?: string;
  label?: string;
  probability?: number;
}

interface DealArgument {
  id?: string;
  name?: string;
  stage?: string;
  amount?: number;
}

export const crmPipelineScenario: PatternIntegrationScenario<
  {
    stages?: StageArgument[];
    deals?: DealArgument[];
    defaultAmount?: number;
  }
> = {
  name: "crm pipeline aggregates forecast totals by stage",
  module: new URL("./crm-pipeline.pattern.ts", import.meta.url),
  exportName: "crmPipeline",
  argument: {
    stages: [
      { id: "Prospect", label: "Prospecting", probability: 0.2 },
      { id: "Qualified", label: "Qualified", probability: 0.45 },
      { id: "Proposal", label: "Proposal", probability: 0.65 },
      { id: "Committed", label: "Committed", probability: 0.85 },
      { id: "Closed-Won", label: "Closed Won", probability: 1 },
    ],
    deals: [
      {
        id: "alpha",
        name: "Alpha Manufacturing",
        stage: "proposal",
        amount: 12000,
      },
      {
        id: "beta",
        name: "Beta Services",
        stage: "qualified",
        amount: 8000,
      },
      {
        id: "gamma",
        name: "Gamma Retail",
        stage: "prospect",
        amount: 5000,
      },
    ],
    defaultAmount: 6000,
  },
  steps: [
    {
      expect: [
        {
          path: "stages",
          value: [
            { id: "prospect", label: "Prospecting", probability: 0.2 },
            { id: "qualified", label: "Qualified", probability: 0.45 },
            { id: "proposal", label: "Proposal", probability: 0.65 },
            { id: "committed", label: "Committed", probability: 0.85 },
            { id: "closed-won", label: "Closed Won", probability: 1 },
          ],
        },
        {
          path: "deals",
          value: [
            {
              id: "gamma",
              name: "Gamma Retail",
              stage: "prospect",
              amount: 5000,
            },
            {
              id: "beta",
              name: "Beta Services",
              stage: "qualified",
              amount: 8000,
            },
            {
              id: "alpha",
              name: "Alpha Manufacturing",
              stage: "proposal",
              amount: 12000,
            },
          ],
        },
        {
          path: "stageStats",
          value: [
            {
              id: "prospect",
              label: "Prospecting",
              probability: 0.2,
              totalAmount: 5000,
              forecastAmount: 1000,
              dealCount: 1,
              share: 0.08,
            },
            {
              id: "qualified",
              label: "Qualified",
              probability: 0.45,
              totalAmount: 8000,
              forecastAmount: 3600,
              dealCount: 1,
              share: 0.29,
            },
            {
              id: "proposal",
              label: "Proposal",
              probability: 0.65,
              totalAmount: 12000,
              forecastAmount: 7800,
              dealCount: 1,
              share: 0.63,
            },
            {
              id: "committed",
              label: "Committed",
              probability: 0.85,
              totalAmount: 0,
              forecastAmount: 0,
              dealCount: 0,
              share: 0,
            },
            {
              id: "closed-won",
              label: "Closed Won",
              probability: 1,
              totalAmount: 0,
              forecastAmount: 0,
              dealCount: 0,
              share: 0,
            },
          ],
        },
        {
          path: "stageForecastRecord",
          value: {
            prospect: 1000,
            qualified: 3600,
            proposal: 7800,
            committed: 0,
            "closed-won": 0,
          },
        },
        { path: "totalForecast", value: 12400 },
        { path: "openPipeline", value: 25000 },
        { path: "stageCount", value: 5 },
        { path: "dealCount", value: 3 },
        {
          path: "summaryLabel",
          value: "5 stages forecast 12400.00 open 25000.00",
        },
        { path: "lastAction", value: "none" },
      ],
    },
    {
      events: [{
        stream: "controls.record",
        payload: { name: "Delta Co", stage: "qualified", amount: 4000 },
      }],
      expect: [
        {
          path: "deals",
          value: [
            {
              id: "gamma",
              name: "Gamma Retail",
              stage: "prospect",
              amount: 5000,
            },
            {
              id: "beta",
              name: "Beta Services",
              stage: "qualified",
              amount: 8000,
            },
            {
              id: "deal-1",
              name: "Delta Co",
              stage: "qualified",
              amount: 4000,
            },
            {
              id: "alpha",
              name: "Alpha Manufacturing",
              stage: "proposal",
              amount: 12000,
            },
          ],
        },
        {
          path: "stageStats",
          value: [
            {
              id: "prospect",
              label: "Prospecting",
              probability: 0.2,
              totalAmount: 5000,
              forecastAmount: 1000,
              dealCount: 1,
              share: 0.07,
            },
            {
              id: "qualified",
              label: "Qualified",
              probability: 0.45,
              totalAmount: 12000,
              forecastAmount: 5400,
              dealCount: 2,
              share: 0.38,
            },
            {
              id: "proposal",
              label: "Proposal",
              probability: 0.65,
              totalAmount: 12000,
              forecastAmount: 7800,
              dealCount: 1,
              share: 0.55,
            },
            {
              id: "committed",
              label: "Committed",
              probability: 0.85,
              totalAmount: 0,
              forecastAmount: 0,
              dealCount: 0,
              share: 0,
            },
            {
              id: "closed-won",
              label: "Closed Won",
              probability: 1,
              totalAmount: 0,
              forecastAmount: 0,
              dealCount: 0,
              share: 0,
            },
          ],
        },
        {
          path: "stageForecastRecord",
          value: {
            prospect: 1000,
            qualified: 5400,
            proposal: 7800,
            committed: 0,
            "closed-won": 0,
          },
        },
        { path: "totalForecast", value: 14200 },
        { path: "openPipeline", value: 29000 },
        { path: "dealCount", value: 4 },
        {
          path: "summaryLabel",
          value: "5 stages forecast 14200.00 open 29000.00",
        },
        { path: "lastAction", value: "record:deal-1" },
      ],
    },
    {
      events: [{
        stream: "controls.advance",
        payload: { id: "beta", direction: 1 },
      }],
      expect: [
        {
          path: "deals",
          value: [
            {
              id: "gamma",
              name: "Gamma Retail",
              stage: "prospect",
              amount: 5000,
            },
            {
              id: "deal-1",
              name: "Delta Co",
              stage: "qualified",
              amount: 4000,
            },
            {
              id: "alpha",
              name: "Alpha Manufacturing",
              stage: "proposal",
              amount: 12000,
            },
            {
              id: "beta",
              name: "Beta Services",
              stage: "proposal",
              amount: 8000,
            },
          ],
        },
        {
          path: "stageStats",
          value: [
            {
              id: "prospect",
              label: "Prospecting",
              probability: 0.2,
              totalAmount: 5000,
              forecastAmount: 1000,
              dealCount: 1,
              share: 0.06,
            },
            {
              id: "qualified",
              label: "Qualified",
              probability: 0.45,
              totalAmount: 4000,
              forecastAmount: 1800,
              dealCount: 1,
              share: 0.11,
            },
            {
              id: "proposal",
              label: "Proposal",
              probability: 0.65,
              totalAmount: 20000,
              forecastAmount: 13000,
              dealCount: 2,
              share: 0.82,
            },
            {
              id: "committed",
              label: "Committed",
              probability: 0.85,
              totalAmount: 0,
              forecastAmount: 0,
              dealCount: 0,
              share: 0,
            },
            {
              id: "closed-won",
              label: "Closed Won",
              probability: 1,
              totalAmount: 0,
              forecastAmount: 0,
              dealCount: 0,
              share: 0,
            },
          ],
        },
        {
          path: "stageForecastRecord",
          value: {
            prospect: 1000,
            qualified: 1800,
            proposal: 13000,
            committed: 0,
            "closed-won": 0,
          },
        },
        { path: "totalForecast", value: 15800 },
        {
          path: "summaryLabel",
          value: "5 stages forecast 15800.00 open 29000.00",
        },
        { path: "lastAction", value: "advance:beta:proposal" },
      ],
    },
    {
      events: [{
        stream: "controls.adjust",
        payload: { stage: "qualified", probability: 0.6 },
      }],
      expect: [
        {
          path: "stages",
          value: [
            { id: "prospect", label: "Prospecting", probability: 0.2 },
            { id: "qualified", label: "Qualified", probability: 0.6 },
            { id: "proposal", label: "Proposal", probability: 0.65 },
            { id: "committed", label: "Committed", probability: 0.85 },
            { id: "closed-won", label: "Closed Won", probability: 1 },
          ],
        },
        {
          path: "stageStats",
          value: [
            {
              id: "prospect",
              label: "Prospecting",
              probability: 0.2,
              totalAmount: 5000,
              forecastAmount: 1000,
              dealCount: 1,
              share: 0.06,
            },
            {
              id: "qualified",
              label: "Qualified",
              probability: 0.6,
              totalAmount: 4000,
              forecastAmount: 2400,
              dealCount: 1,
              share: 0.15,
            },
            {
              id: "proposal",
              label: "Proposal",
              probability: 0.65,
              totalAmount: 20000,
              forecastAmount: 13000,
              dealCount: 2,
              share: 0.79,
            },
            {
              id: "committed",
              label: "Committed",
              probability: 0.85,
              totalAmount: 0,
              forecastAmount: 0,
              dealCount: 0,
              share: 0,
            },
            {
              id: "closed-won",
              label: "Closed Won",
              probability: 1,
              totalAmount: 0,
              forecastAmount: 0,
              dealCount: 0,
              share: 0,
            },
          ],
        },
        {
          path: "stageForecastRecord",
          value: {
            prospect: 1000,
            qualified: 2400,
            proposal: 13000,
            committed: 0,
            "closed-won": 0,
          },
        },
        { path: "totalForecast", value: 16400 },
        {
          path: "summaryLabel",
          value: "5 stages forecast 16400.00 open 29000.00",
        },
        { path: "lastAction", value: "adjust:qualified:0.60" },
      ],
    },
  ],
};

export const scenarios = [crmPipelineScenario];

describe("crm-pipeline", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
