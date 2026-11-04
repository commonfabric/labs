import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const shoppingCartAggregationScenario: PatternIntegrationScenario<
  {
    items?: Array<{
      id?: string;
      name?: string;
      price?: number;
      quantity?: number;
      category?: string;
    }>;
    discounts?: Array<{
      id?: string;
      label?: string;
      category?: string;
      threshold?: number;
      percent?: number;
    }>;
  }
> = {
  name: "shopping cart aggregates totals with category discounts",
  module: new URL(
    "./shopping-cart-aggregation.pattern.ts",
    import.meta.url,
  ),
  exportName: "shoppingCartAggregation",
  argument: {
    items: [
      {
        id: "apples",
        name: "Honeycrisp Apples",
        price: 3,
        quantity: 4,
        category: "produce",
      },
      {
        id: "beans",
        name: "Coffee Beans",
        price: 12,
        quantity: 2,
        category: "grocery",
      },
      {
        id: "mug",
        name: "Stoneware Mug",
        price: 8,
        quantity: 1,
        category: "home",
      },
    ],
    discounts: [
      {
        id: "produce-spree",
        label: "Produce bonus",
        category: "produce",
        threshold: 3,
        percent: 10,
      },
      {
        id: "grocery-bundle",
        label: "Grocery saver",
        category: "grocery",
        threshold: 2,
        percent: 5,
      },
    ],
  },
  steps: [
    {
      expect: [
        {
          path: "items",
          value: [
            {
              id: "apples",
              name: "Honeycrisp Apples",
              price: 3,
              quantity: 4,
              category: "produce",
            },
            {
              id: "beans",
              name: "Coffee Beans",
              price: 12,
              quantity: 2,
              category: "grocery",
            },
            {
              id: "mug",
              name: "Stoneware Mug",
              price: 8,
              quantity: 1,
              category: "home",
            },
          ],
        },
        {
          path: "categoryTotals",
          value: [
            { category: "grocery", quantity: 2, subtotal: 24 },
            { category: "home", quantity: 1, subtotal: 8 },
            { category: "produce", quantity: 4, subtotal: 12 },
          ],
        },
        {
          path: "lineTotals",
          value: [
            {
              id: "apples",
              name: "Honeycrisp Apples",
              category: "produce",
              unitPrice: 3,
              quantity: 4,
              subtotal: 12,
            },
            {
              id: "beans",
              name: "Coffee Beans",
              category: "grocery",
              unitPrice: 12,
              quantity: 2,
              subtotal: 24,
            },
            {
              id: "mug",
              name: "Stoneware Mug",
              category: "home",
              unitPrice: 8,
              quantity: 1,
              subtotal: 8,
            },
          ],
        },
        {
          path: "discountBreakdown",
          value: [
            {
              id: "produce-spree",
              label: "Produce bonus",
              category: "produce",
              threshold: 3,
              percent: 10,
              qualified: true,
              amount: 1.2,
            },
            {
              id: "grocery-bundle",
              label: "Grocery saver",
              category: "grocery",
              threshold: 2,
              percent: 5,
              qualified: true,
              amount: 1.2,
            },
          ],
        },
        { path: "subtotal", value: 44 },
        { path: "itemCount", value: 7 },
        { path: "totalDiscount", value: 2.4 },
        { path: "total", value: 41.6 },
        {
          path: "summary",
          value: "Cart subtotal $44.00 • discount $2.40 • total $41.60",
        },
        { path: "history", value: [] },
        {
          path: "lastEvent",
          value: "Cart initialized with 3 item(s)",
        },
      ],
    },
    {
      events: [
        {
          stream: "modify",
          payload: { type: "update", id: "beans", quantity: 1 },
        },
      ],
      expect: [
        {
          path: "items",
          value: [
            {
              id: "apples",
              name: "Honeycrisp Apples",
              price: 3,
              quantity: 4,
              category: "produce",
            },
            {
              id: "beans",
              name: "Coffee Beans",
              price: 12,
              quantity: 1,
              category: "grocery",
            },
            {
              id: "mug",
              name: "Stoneware Mug",
              price: 8,
              quantity: 1,
              category: "home",
            },
          ],
        },
        {
          path: "categoryTotals",
          value: [
            { category: "grocery", quantity: 1, subtotal: 12 },
            { category: "home", quantity: 1, subtotal: 8 },
            { category: "produce", quantity: 4, subtotal: 12 },
          ],
        },
        {
          path: "discountBreakdown",
          value: [
            {
              id: "produce-spree",
              label: "Produce bonus",
              category: "produce",
              threshold: 3,
              percent: 10,
              qualified: true,
              amount: 1.2,
            },
            {
              id: "grocery-bundle",
              label: "Grocery saver",
              category: "grocery",
              threshold: 2,
              percent: 5,
              qualified: false,
              amount: 0,
            },
          ],
        },
        { path: "subtotal", value: 32 },
        { path: "itemCount", value: 6 },
        { path: "totalDiscount", value: 1.2 },
        { path: "total", value: 30.8 },
        {
          path: "summary",
          value: "Cart subtotal $32.00 • discount $1.20 • total $30.80",
        },
        {
          path: "history",
          value: ["Updated beans to 1 x $12.00"],
        },
        {
          path: "lastEvent",
          value: "Updated beans to 1 x $12.00",
        },
      ],
    },
    {
      events: [
        {
          stream: "modify",
          payload: {
            type: "add",
            item: {
              name: "Grocery Snacks",
              price: 4.5,
              quantity: 2,
              category: "grocery",
            },
          },
        },
      ],
      expect: [
        {
          path: "items",
          value: [
            {
              id: "apples",
              name: "Honeycrisp Apples",
              price: 3,
              quantity: 4,
              category: "produce",
            },
            {
              id: "beans",
              name: "Coffee Beans",
              price: 12,
              quantity: 1,
              category: "grocery",
            },
            {
              id: "mug",
              name: "Stoneware Mug",
              price: 8,
              quantity: 1,
              category: "home",
            },
            {
              id: "item-4",
              name: "Grocery Snacks",
              price: 4.5,
              quantity: 2,
              category: "grocery",
            },
          ],
        },
        {
          path: "categoryTotals",
          value: [
            { category: "grocery", quantity: 3, subtotal: 21 },
            { category: "home", quantity: 1, subtotal: 8 },
            { category: "produce", quantity: 4, subtotal: 12 },
          ],
        },
        {
          path: "discountBreakdown",
          value: [
            {
              id: "produce-spree",
              label: "Produce bonus",
              category: "produce",
              threshold: 3,
              percent: 10,
              qualified: true,
              amount: 1.2,
            },
            {
              id: "grocery-bundle",
              label: "Grocery saver",
              category: "grocery",
              threshold: 2,
              percent: 5,
              qualified: true,
              amount: 1.05,
            },
          ],
        },
        { path: "subtotal", value: 41 },
        { path: "itemCount", value: 8 },
        { path: "totalDiscount", value: 2.25 },
        { path: "total", value: 38.75 },
        {
          path: "summary",
          value: "Cart subtotal $41.00 • discount $2.25 • total $38.75",
        },
        {
          path: "history",
          value: [
            "Updated beans to 1 x $12.00",
            "Added item-4 with 2 x $4.50",
          ],
        },
        {
          path: "lastEvent",
          value: "Added item-4 with 2 x $4.50",
        },
      ],
    },
    {
      events: [
        {
          stream: "configureDiscounts",
          payload: {
            type: "replace",
            rules: [
              {
                id: "produce-bulk",
                label: "Produce bulk",
                category: "produce",
                threshold: 5,
                percent: 15,
              },
              {
                id: "grocery-bonus",
                label: "Grocery bonus",
                category: "grocery",
                threshold: 2,
                percent: 8,
              },
              {
                id: "home-bundle",
                label: "Home bundle",
                category: "home",
                threshold: 2,
                percent: 20,
              },
            ],
          },
        },
      ],
      expect: [
        {
          path: "discountRules",
          value: [
            {
              id: "produce-bulk",
              label: "Produce bulk",
              category: "produce",
              threshold: 5,
              percent: 15,
            },
            {
              id: "grocery-bonus",
              label: "Grocery bonus",
              category: "grocery",
              threshold: 2,
              percent: 8,
            },
            {
              id: "home-bundle",
              label: "Home bundle",
              category: "home",
              threshold: 2,
              percent: 20,
            },
          ],
        },
        {
          path: "discountBreakdown",
          value: [
            {
              id: "produce-bulk",
              label: "Produce bulk",
              category: "produce",
              threshold: 5,
              percent: 15,
              qualified: false,
              amount: 0,
            },
            {
              id: "grocery-bonus",
              label: "Grocery bonus",
              category: "grocery",
              threshold: 2,
              percent: 8,
              qualified: true,
              amount: 1.68,
            },
            {
              id: "home-bundle",
              label: "Home bundle",
              category: "home",
              threshold: 2,
              percent: 20,
              qualified: false,
              amount: 0,
            },
          ],
        },
        { path: "totalDiscount", value: 1.68 },
        { path: "total", value: 39.32 },
        {
          path: "summary",
          value: "Cart subtotal $41.00 • discount $1.68 • total $39.32",
        },
        {
          path: "history",
          value: [
            "Updated beans to 1 x $12.00",
            "Added item-4 with 2 x $4.50",
            "Configured 3 discount rule(s)",
          ],
        },
        {
          path: "lastEvent",
          value: "Configured 3 discount rule(s)",
        },
      ],
    },
  ],
};

export const scenarios = [shoppingCartAggregationScenario];

describe("shopping-cart-aggregation", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
