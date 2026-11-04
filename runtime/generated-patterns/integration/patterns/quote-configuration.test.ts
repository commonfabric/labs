import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface QuoteConfigurationArgs {
  basePrice?: number;
  discountRate?: number;
  options?: unknown;
}

export const quoteConfigurationScenario: PatternIntegrationScenario<
  QuoteConfigurationArgs
> = {
  name: "quote configuration derives totals from option selections",
  module: new URL(
    "./quote-configuration.pattern.ts",
    import.meta.url,
  ),
  exportName: "quoteConfiguration",
  steps: [
    {
      expect: [
        { path: "basePrice", value: 1800 },
        { path: "discountRate", value: 0 },
        { path: "selectedOptionIds", value: ["support"] },
        { path: "options.0.label", value: "Priority support" },
        { path: "options.0.selected", value: true },
        { path: "optionsTotal", value: 250 },
        { path: "subtotal", value: 2050 },
        { path: "discountAmount", value: 0 },
        { path: "total", value: 2050 },
        {
          path: "summary",
          value: "Quote total $2050.00 (discount $0.00)",
        },
      ],
    },
    {
      events: [{ stream: "toggleOption", payload: { id: "training" } }],
      expect: [
        { path: "selectedOptionIds", value: ["support", "training"] },
        { path: "options.1.selected", value: true },
        { path: "optionsTotal", value: 700 },
        { path: "subtotal", value: 2500 },
        { path: "discountAmount", value: 0 },
        { path: "total", value: 2500 },
        {
          path: "summary",
          value: "Quote total $2500.00 (discount $0.00)",
        },
      ],
    },
    {
      events: [
        {
          stream: "configurePricing",
          payload: { basePrice: 2100.75, discountRate: 0.1 },
        },
        {
          stream: "configureOption",
          payload: {
            id: "analytics",
            price: 680.5,
            selected: true,
            label: "Analytics insights add-on",
          },
        },
      ],
      expect: [
        { path: "basePrice", value: 2100.75 },
        { path: "discountRate", value: 0.1 },
        {
          path: "selectedOptionIds",
          value: ["support", "training", "analytics"],
        },
        { path: "options.2.label", value: "Analytics insights add-on" },
        { path: "options.2.price", value: 680.5 },
        { path: "options.2.selected", value: true },
        { path: "optionsTotal", value: 1380.5 },
        { path: "subtotal", value: 3481.25 },
        { path: "discountAmount", value: 348.13 },
        { path: "total", value: 3133.12 },
        {
          path: "summary",
          value: "Quote total $3133.12 (discount $348.13)",
        },
      ],
    },
  ],
};

export const scenarios = [quoteConfigurationScenario];

describe("quote-configuration", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
