import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const subscriptionBillingScenario: PatternIntegrationScenario<
  { plan?: string; lastInvoiceDate?: string }
> = {
  name: "subscription billing updates renewal after plan changes",
  module: new URL("./subscription-billing.pattern.ts", import.meta.url),
  exportName: "subscriptionBilling",
  steps: [
    {
      expect: [
        { path: "planId", value: "starter" },
        { path: "planName", value: "Starter" },
        { path: "planPrice", value: "$29.00" },
        { path: "cycleDays", value: 30 },
        { path: "cycleLabel", value: "30 days" },
        { path: "lastInvoiceDate", value: "2024-01-01" },
        { path: "nextInvoiceDate", value: "2024-01-31" },
        {
          path: "summary",
          value: "Starter plan renews on 2024-01-31 for $29.00",
        },
        { path: "history", value: [] },
      ],
    },
    {
      events: [
        {
          stream: "changePlan",
          payload: {
            plan: "growth",
            cycleDays: 45,
            lastInvoiceDate: "2024-02-15",
          },
        },
      ],
      expect: [
        { path: "planId", value: "growth" },
        { path: "planName", value: "Growth" },
        { path: "planPrice", value: "$59.00" },
        { path: "cycleDays", value: 45 },
        { path: "cycleLabel", value: "45 days" },
        { path: "lastInvoiceDate", value: "2024-02-15" },
        { path: "nextInvoiceDate", value: "2024-03-31" },
        {
          path: "summary",
          value: "Growth plan renews on 2024-03-31 for $59.00",
        },
        {
          path: "history.0",
          value: "Growth plan uses a 45-day cycle. Next invoice 2024-03-31",
        },
      ],
    },
    {
      events: [
        { stream: "recordInvoice", payload: { date: "2024-03-31" } },
      ],
      expect: [
        { path: "lastInvoiceDate", value: "2024-03-31" },
        { path: "nextInvoiceDate", value: "2024-05-15" },
        {
          path: "summary",
          value: "Growth plan renews on 2024-05-15 for $59.00",
        },
        {
          path: "history.1",
          value:
            "Invoice recorded on 2024-03-31 for Growth. Next invoice 2024-05-15",
        },
      ],
    },
    {
      events: [
        { stream: "changePlan", payload: { plan: "enterprise" } },
      ],
      expect: [
        { path: "planId", value: "enterprise" },
        { path: "planName", value: "Enterprise" },
        { path: "planPrice", value: "$119.00" },
        { path: "cycleDays", value: 90 },
        { path: "cycleLabel", value: "90 days" },
        { path: "lastInvoiceDate", value: "2024-03-31" },
        { path: "nextInvoiceDate", value: "2024-06-29" },
        {
          path: "summary",
          value: "Enterprise plan renews on 2024-06-29 for $119.00",
        },
        {
          path: "history.2",
          value: "Enterprise plan uses a 90-day cycle. Next invoice 2024-06-29",
        },
      ],
    },
  ],
};

export const scenarios = [subscriptionBillingScenario];

describe("subscription-billing", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
