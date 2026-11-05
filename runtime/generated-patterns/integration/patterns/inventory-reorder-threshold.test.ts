import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";
import type { InventoryEntry } from "./inventory-reorder-threshold.pattern.ts";

export const inventoryReorderThresholdScenario: PatternIntegrationScenario<
  { inventory?: InventoryEntry[] }
> = {
  name: "inventory flags low stock and reacts to threshold updates",
  module: new URL("./inventory-reorder-threshold.pattern.ts", import.meta.url),
  exportName: "inventoryReorderThreshold",
  steps: [
    {
      expect: [
        { path: "lowStockSkus", value: ["WIDGET-BETA"] },
        {
          path: "lowStockReport",
          value: [
            {
              sku: "WIDGET-BETA",
              stock: 4,
              reorderLevel: 6,
              recommendedOrder: 3,
            },
          ],
        },
        { path: "alertCount", value: 1 },
        {
          path: "alertLabel",
          value: "1 items below reorder threshold",
        },
        {
          path: "alertMessage",
          value: "Reorder needed for WIDGET-BETA",
        },
        { path: "needsAttention", value: true },
      ],
    },
    {
      events: [
        {
          stream: "receiveShipment",
          payload: { sku: "widget-beta", quantity: 3 },
        },
      ],
      expect: [
        { path: "lowStockSkus", value: [] },
        { path: "lowStockReport", value: [] },
        { path: "alertCount", value: 0 },
        {
          path: "alertLabel",
          value: "0 items below reorder threshold",
        },
        { path: "alertMessage", value: "All items healthy" },
        { path: "needsAttention", value: false },
      ],
    },
    {
      events: [
        {
          stream: "recordSale",
          payload: { sku: "WIDGET-ALPHA", quantity: 8 },
        },
      ],
      expect: [
        { path: "lowStockSkus", value: ["WIDGET-ALPHA"] },
        {
          path: "lowStockReport",
          value: [
            {
              sku: "WIDGET-ALPHA",
              stock: 4,
              reorderLevel: 5,
              recommendedOrder: 2,
            },
          ],
        },
        { path: "alertCount", value: 1 },
        {
          path: "alertLabel",
          value: "1 items below reorder threshold",
        },
        {
          path: "alertMessage",
          value: "Reorder needed for WIDGET-ALPHA",
        },
        { path: "needsAttention", value: true },
      ],
    },
    {
      events: [
        {
          stream: "setThreshold",
          payload: { sku: "widget-gamma", threshold: 10 },
        },
      ],
      expect: [
        {
          path: "lowStockSkus",
          value: ["WIDGET-ALPHA", "WIDGET-GAMMA"],
        },
        {
          path: "lowStockReport",
          value: [
            {
              sku: "WIDGET-ALPHA",
              stock: 4,
              reorderLevel: 5,
              recommendedOrder: 2,
            },
            {
              sku: "WIDGET-GAMMA",
              stock: 9,
              reorderLevel: 10,
              recommendedOrder: 2,
            },
          ],
        },
        { path: "alertCount", value: 2 },
        {
          path: "alertLabel",
          value: "2 items below reorder threshold",
        },
        {
          path: "alertMessage",
          value: "Reorder needed for WIDGET-ALPHA, WIDGET-GAMMA",
        },
        { path: "needsAttention", value: true },
      ],
    },
    {
      events: [
        {
          stream: "setThreshold",
          payload: { sku: "WIDGET-GAMMA", threshold: 3 },
        },
      ],
      expect: [
        { path: "lowStockSkus", value: ["WIDGET-ALPHA"] },
        {
          path: "lowStockReport",
          value: [
            {
              sku: "WIDGET-ALPHA",
              stock: 4,
              reorderLevel: 5,
              recommendedOrder: 2,
            },
          ],
        },
        { path: "alertCount", value: 1 },
        {
          path: "alertLabel",
          value: "1 items below reorder threshold",
        },
        {
          path: "alertMessage",
          value: "Reorder needed for WIDGET-ALPHA",
        },
        { path: "needsAttention", value: true },
      ],
    },
  ],
};

export const scenarios = [inventoryReorderThresholdScenario];

describe("inventory-reorder-threshold", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
