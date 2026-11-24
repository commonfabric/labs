import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface InvoiceItemArgument {
  id?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  itemDiscountRate?: number;
}

export const invoiceGeneratorScenario: PatternIntegrationScenario<
  {
    items?: InvoiceItemArgument[];
    taxRate?: number;
    invoiceDiscountRate?: number;
  }
> = {
  name: "invoice generator computes totals with taxes and discounts",
  module: new URL("./invoice-generator.pattern.ts", import.meta.url),
  exportName: "invoiceGeneratorPattern",
  steps: [
    {
      expect: [
        { path: "normalizedItems.0.id", value: "design-services" },
        { path: "normalizedItems.1.quantity", value: 40 },
        { path: "normalizedItems.2.unitPrice", value: 12.5 },
        { path: "lineSummaries.0.baseTotal", value: 1440 },
        { path: "lineSummaries.0.itemDiscountAmount", value: 144 },
        { path: "lineSummaries.0.lineTotal", value: 1296 },
        { path: "lineSummaries.1.lineTotal", value: 3610 },
        { path: "lineSummaries.2.lineTotal", value: 150 },
        { path: "itemDiscountTotal", value: 334 },
        { path: "subtotal", value: 5056 },
        { path: "invoiceDiscountAmount", value: 252.8 },
        { path: "discountedSubtotal", value: 4803.2 },
        { path: "taxAmount", value: 348.23 },
        { path: "totalDue", value: 5151.43 },
        { path: "taxRatePercent", value: "7.25%" },
        { path: "invoiceDiscountPercent", value: "5.00%" },
        { path: "lineCount", value: 3 },
        {
          path: "lineLabels",
          value: [
            "Design sprint and prototyping: $1296.00",
            "Implementation sprint: $3610.00",
            "Managed hosting: $150.00",
          ],
        },
        { path: "formattedTotalDue", value: "$5151.43" },
        {
          path: "summary",
          value: "Total due $5151.43 (tax 7.25%, discount 5.00%)",
        },
      ],
    },
    {
      events: [
        {
          stream: "controls.updateItem",
          payload: {
            id: "implementation",
            quantity: 32,
            unitPrice: 102.75,
            itemDiscountRate: 0.08,
          },
        },
      ],
      expect: [
        { path: "lineSummaries.1.quantity", value: 32 },
        { path: "lineSummaries.1.unitPrice", value: 102.75 },
        { path: "lineSummaries.1.itemDiscountRate", value: 0.08 },
        { path: "lineSummaries.1.baseTotal", value: 3288 },
        { path: "lineSummaries.1.itemDiscountAmount", value: 263.04 },
        { path: "lineSummaries.1.lineTotal", value: 3024.96 },
        { path: "itemDiscountTotal", value: 407.04 },
        { path: "subtotal", value: 4470.96 },
        { path: "invoiceDiscountAmount", value: 223.55 },
        { path: "discountedSubtotal", value: 4247.41 },
        { path: "taxAmount", value: 307.94 },
        { path: "totalDue", value: 4555.35 },
        { path: "lineLabels.1", value: "Implementation sprint: $3024.96" },
        { path: "formattedTotalDue", value: "$4555.35" },
        {
          path: "summary",
          value: "Total due $4555.35 (tax 7.25%, discount 5.00%)",
        },
      ],
    },
    {
      events: [
        {
          stream: "controls.updateRates",
          payload: { taxRate: 0.08125, invoiceDiscountRate: 0.08 },
        },
      ],
      expect: [
        { path: "invoiceDiscountAmount", value: 357.68 },
        { path: "discountedSubtotal", value: 4113.28 },
        { path: "taxAmount", value: 334.41 },
        { path: "totalDue", value: 4447.69 },
        { path: "formattedTotalDue", value: "$4447.69" },
        { path: "taxRatePercent", value: "8.13%" },
        { path: "invoiceDiscountPercent", value: "8.00%" },
        {
          path: "summary",
          value: "Total due $4447.69 (tax 8.13%, discount 8.00%)",
        },
      ],
    },
  ],
};

export const scenarios = [invoiceGeneratorScenario];

describe("invoice-generator", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
