import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";
import type {
  FulfillmentStatusCounts,
  OrderInput,
} from "./order-fulfillment-tracker.pattern.ts";

const orderFulfillmentTrackerScenario: PatternIntegrationScenario<
  { orders?: OrderInput[] }
> = {
  name: "order fulfillment tracker splits status buckets",
  module: new URL(
    "./order-fulfillment-tracker.pattern.ts",
    import.meta.url,
  ),
  exportName: "orderFulfillmentTracker",
  steps: [
    {
      expect: [
        {
          path: "statusCounts",
          value: {
            pending: 1,
            picking: 1,
            packed: 1,
            shipped: 1,
            delivered: 0,
            cancelled: 0,
          } satisfies FulfillmentStatusCounts,
        },
        {
          path: "queueSummary",
          value: "Pending 1, Picking 1, " +
            "Packed 1, Shipped 1",
        },
        { path: "progressLabel", value: "4 active / 4 total orders" },
        {
          path: "inFlightOrderIds",
          value: ["ORD-1001", "ORD-1002", "ORD-1003", "ORD-1004"],
        },
        { path: "statusBuckets.0.label", value: "Pending" },
        { path: "statusBuckets.0.count", value: 1 },
        { path: "statusBuckets.0.orders.0.customer", value: "Acme Labs" },
        { path: "statusBuckets.4.count", value: 0 },
        { path: "transitionMessages", value: [] },
      ],
    },
    {
      events: [
        { stream: "advanceFulfillment", payload: { orderId: "ord-1001" } },
      ],
      expect: [
        {
          path: "statusCounts",
          value: {
            pending: 0,
            picking: 2,
            packed: 1,
            shipped: 1,
            delivered: 0,
            cancelled: 0,
          } satisfies FulfillmentStatusCounts,
        },
        {
          path: "queueSummary",
          value: "Pending 0, Picking 2, " +
            "Packed 1, Shipped 1",
        },
        { path: "progressLabel", value: "4 active / 4 total orders" },
        {
          path: "statusBuckets.1.orders.0.id",
          value: "ORD-1001",
        },
        {
          path: "statusBuckets.1.orders.1.id",
          value: "ORD-1002",
        },
        {
          path: "transitionMessages",
          value: [
            "ORD-1001 moved from Pending to Picking",
          ],
        },
      ],
    },
    {
      events: [
        { stream: "advanceFulfillment", payload: { orderId: "ORD-1001" } },
      ],
      expect: [
        {
          path: "statusCounts",
          value: {
            pending: 0,
            picking: 1,
            packed: 2,
            shipped: 1,
            delivered: 0,
            cancelled: 0,
          } satisfies FulfillmentStatusCounts,
        },
        {
          path: "queueSummary",
          value: "Pending 0, Picking 1, " +
            "Packed 2, Shipped 1",
        },
        {
          path: "statusBuckets.2.orders.0.id",
          value: "ORD-1001",
        },
        {
          path: "statusBuckets.2.orders.1.id",
          value: "ORD-1003",
        },
        {
          path: "transitionMessages.1",
          value: "ORD-1001 moved from Picking to Packed",
        },
      ],
    },
    {
      events: [
        { stream: "advanceFulfillment", payload: { orderId: "ORD-1001" } },
      ],
      expect: [
        {
          path: "statusCounts",
          value: {
            pending: 0,
            picking: 1,
            packed: 1,
            shipped: 2,
            delivered: 0,
            cancelled: 0,
          } satisfies FulfillmentStatusCounts,
        },
        {
          path: "queueSummary",
          value: "Pending 0, Picking 1, " +
            "Packed 1, Shipped 2",
        },
        {
          path: "statusBuckets.3.orders.0.id",
          value: "ORD-1001",
        },
        {
          path: "statusBuckets.3.orders.1.id",
          value: "ORD-1004",
        },
        {
          path: "transitionMessages.2",
          value: "ORD-1001 moved from Packed to Shipped",
        },
      ],
    },
    {
      events: [
        { stream: "advanceFulfillment", payload: { orderId: "ORD-1001" } },
      ],
      expect: [
        {
          path: "statusCounts",
          value: {
            pending: 0,
            picking: 1,
            packed: 1,
            shipped: 1,
            delivered: 1,
            cancelled: 0,
          } satisfies FulfillmentStatusCounts,
        },
        {
          path: "queueSummary",
          value: "Pending 0, Picking 1, " +
            "Packed 1, Shipped 1",
        },
        { path: "progressLabel", value: "3 active / 4 total orders" },
        {
          path: "inFlightOrderIds",
          value: ["ORD-1002", "ORD-1003", "ORD-1004"],
        },
        {
          path: "statusBuckets.4.orders.0.statusLabel",
          value: "Delivered",
        },
        {
          path: "transitionMessages.3",
          value: "ORD-1001 moved from Shipped to Delivered",
        },
      ],
    },
    {
      events: [
        { stream: "cancelOrder", payload: { orderId: "ORD-1003" } },
      ],
      expect: [
        {
          path: "statusCounts",
          value: {
            pending: 0,
            picking: 1,
            packed: 0,
            shipped: 1,
            delivered: 1,
            cancelled: 1,
          } satisfies FulfillmentStatusCounts,
        },
        {
          path: "queueSummary",
          value: "Pending 0, Picking 1, " +
            "Packed 0, Shipped 1",
        },
        { path: "progressLabel", value: "2 active / 4 total orders" },
        {
          path: "inFlightOrderIds",
          value: ["ORD-1002", "ORD-1004"],
        },
        {
          path: "statusBuckets.5.orders.0.id",
          value: "ORD-1003",
        },
        {
          path: "transitionMessages.4",
          value: "ORD-1003 moved from Packed to Cancelled",
        },
      ],
    },
    {
      events: [
        { stream: "reopenOrder", payload: { orderId: "ORD-1003" } },
      ],
      expect: [
        {
          path: "statusCounts",
          value: {
            pending: 1,
            picking: 1,
            packed: 0,
            shipped: 1,
            delivered: 1,
            cancelled: 0,
          } satisfies FulfillmentStatusCounts,
        },
        {
          path: "queueSummary",
          value: "Pending 1, Picking 1, " +
            "Packed 0, Shipped 1",
        },
        { path: "progressLabel", value: "3 active / 4 total orders" },
        {
          path: "inFlightOrderIds",
          value: ["ORD-1002", "ORD-1003", "ORD-1004"],
        },
        {
          path: "statusBuckets.0.orders.0.id",
          value: "ORD-1003",
        },
        {
          path: "transitionMessages",
          value: [
            "ORD-1001 moved from Pending to Picking",
            "ORD-1001 moved from Picking to Packed",
            "ORD-1001 moved from Packed to Shipped",
            "ORD-1001 moved from Shipped to Delivered",
            "ORD-1003 moved from Packed to Cancelled",
            "ORD-1003 moved from Cancelled to Pending",
          ],
        },
      ],
    },
  ],
};

export const scenarios = [orderFulfillmentTrackerScenario];

describe("order-fulfillment-tracker", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
