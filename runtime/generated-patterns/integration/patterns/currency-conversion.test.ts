import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const currencyConversionScenario: PatternIntegrationScenario<
  {
    baseCurrency?: string;
    amount?: number;
    rates?: Record<string, number>;
    targets?: string[];
  }
> = {
  name: "currency conversion updates derived amounts when rates change",
  module: new URL("./currency-conversion.pattern.ts", import.meta.url),
  exportName: "currencyConversionPattern",
  argument: {
    baseCurrency: "usd",
    amount: 90.125,
    targets: ["eur", "gbp"],
  },
  steps: [
    {
      expect: [
        { path: "baseCode", value: "USD" },
        { path: "normalizedAmount", value: 90.13 },
        { path: "currencyCodes", value: ["EUR", "GBP", "USD"] },
        {
          path: "conversions",
          value: { EUR: 82.92, GBP: 70.3, USD: 90.13 },
        },
        {
          path: "conversionList",
          value: ["EUR 82.92", "GBP 70.30", "USD 90.13"],
        },
        { path: "currencyCount", value: 3 },
        { path: "summary", value: "90.13 USD across 3 currencies" },
      ],
    },
    {
      events: [
        { stream: "updateRate", payload: { currency: "eur", rate: 1.2 } },
      ],
      expect: [
        {
          path: "normalizedRates",
          value: { EUR: 1.2, GBP: 0.78, USD: 1 },
        },
        {
          path: "conversions",
          value: { EUR: 108.16, GBP: 70.3, USD: 90.13 },
        },
        {
          path: "conversionList",
          value: ["EUR 108.16", "GBP 70.30", "USD 90.13"],
        },
      ],
    },
    {
      events: [
        { stream: "updateRate", payload: { currency: "JPY", rate: 140.456 } },
      ],
      expect: [
        {
          path: "currencyCodes",
          value: ["EUR", "GBP", "JPY", "USD"],
        },
        {
          path: "targets",
          value: ["EUR", "GBP", "JPY", "USD"],
        },
        {
          path: "conversions",
          value: { EUR: 108.16, GBP: 70.3, JPY: 12659.3, USD: 90.13 },
        },
        {
          path: "conversionList",
          value: [
            "EUR 108.16",
            "GBP 70.30",
            "JPY 12659.30",
            "USD 90.13",
          ],
        },
        { path: "currencyCount", value: 4 },
        { path: "summary", value: "90.13 USD across 4 currencies" },
      ],
    },
    {
      events: [
        { stream: "setAmount", payload: { amount: 250 } },
      ],
      expect: [
        { path: "normalizedAmount", value: 250 },
        {
          path: "conversions",
          value: { EUR: 300, GBP: 195, JPY: 35114, USD: 250 },
        },
        {
          path: "conversionList",
          value: [
            "EUR 300.00",
            "GBP 195.00",
            "JPY 35114.00",
            "USD 250.00",
          ],
        },
        { path: "summary", value: "250.00 USD across 4 currencies" },
      ],
    },
  ],
};

export const scenarios = [currencyConversionScenario];

describe("currency-conversion", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
