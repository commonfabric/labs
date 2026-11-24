import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const logisticsRoutingScenario: PatternIntegrationScenario = {
  name: "logistics routing enforces per-route capacity when reassigning",
  module: new URL("./logistics-routing.pattern.ts", import.meta.url),
  exportName: "logisticsRouting",
  steps: [
    {
      expect: [
        {
          path: "shipments",
          value: [
            { id: "PKG-100", route: "NORTH", weight: 5 },
            { id: "PKG-101", route: "NORTH", weight: 4 },
            { id: "PKG-200", route: "EAST", weight: 3 },
            { id: "PKG-201", route: "EAST", weight: 2 },
            { id: "PKG-300", route: "SOUTH", weight: 5 },
            { id: "PKG-301", route: "SOUTH", weight: 6 },
          ],
        },
        {
          path: "loadMetrics",
          value: [
            {
              route: "NORTH",
              label: "North Loop",
              capacity: 18,
              used: 9,
              remaining: 9,
              utilization: 0.5,
              isOverCapacity: false,
            },
            {
              route: "EAST",
              label: "East Express",
              capacity: 12,
              used: 5,
              remaining: 7,
              utilization: 0.42,
              isOverCapacity: false,
            },
            {
              route: "SOUTH",
              label: "South Freight",
              capacity: 16,
              used: 11,
              remaining: 5,
              utilization: 0.69,
              isOverCapacity: false,
            },
          ],
        },
        {
          path: "availableRoutes",
          value: ["EAST", "NORTH", "SOUTH"],
        },
        { path: "overloadedRoutes", value: [] },
        {
          path: "status",
          value: "6 shipments across 3 routes; overloaded 0",
        },
        { path: "history", value: [] },
        { path: "lastAction", value: "initialized" },
      ],
    },
    {
      events: [
        {
          stream: "assignShipment",
          payload: { shipment: "pkg-300", targetRoute: "east" },
        },
      ],
      expect: [
        {
          path: "shipments",
          value: [
            { id: "PKG-100", route: "NORTH", weight: 5 },
            { id: "PKG-101", route: "NORTH", weight: 4 },
            { id: "PKG-200", route: "EAST", weight: 3 },
            { id: "PKG-201", route: "EAST", weight: 2 },
            { id: "PKG-300", route: "EAST", weight: 5 },
            { id: "PKG-301", route: "SOUTH", weight: 6 },
          ],
        },
        {
          path: "loadMetrics",
          value: [
            {
              route: "NORTH",
              label: "North Loop",
              capacity: 18,
              used: 9,
              remaining: 9,
              utilization: 0.5,
              isOverCapacity: false,
            },
            {
              route: "EAST",
              label: "East Express",
              capacity: 12,
              used: 10,
              remaining: 2,
              utilization: 0.83,
              isOverCapacity: false,
            },
            {
              route: "SOUTH",
              label: "South Freight",
              capacity: 16,
              used: 6,
              remaining: 10,
              utilization: 0.38,
              isOverCapacity: false,
            },
          ],
        },
        {
          path: "history",
          value: ["Moved PKG-300 from SOUTH to EAST"],
        },
        {
          path: "lastAction",
          value: "Moved PKG-300 from SOUTH to EAST",
        },
      ],
    },
    {
      events: [
        {
          stream: "assignShipment",
          payload: { shipment: "PKG-301", targetRoute: "EAST" },
        },
      ],
      expect: [
        {
          path: "shipments",
          value: [
            { id: "PKG-100", route: "NORTH", weight: 5 },
            { id: "PKG-101", route: "NORTH", weight: 4 },
            { id: "PKG-200", route: "EAST", weight: 3 },
            { id: "PKG-201", route: "EAST", weight: 2 },
            { id: "PKG-300", route: "EAST", weight: 5 },
            { id: "PKG-301", route: "SOUTH", weight: 6 },
          ],
        },
        {
          path: "loadMetrics",
          value: [
            {
              route: "NORTH",
              label: "North Loop",
              capacity: 18,
              used: 9,
              remaining: 9,
              utilization: 0.5,
              isOverCapacity: false,
            },
            {
              route: "EAST",
              label: "East Express",
              capacity: 12,
              used: 10,
              remaining: 2,
              utilization: 0.83,
              isOverCapacity: false,
            },
            {
              route: "SOUTH",
              label: "South Freight",
              capacity: 16,
              used: 6,
              remaining: 10,
              utilization: 0.38,
              isOverCapacity: false,
            },
          ],
        },
        {
          path: "history",
          value: [
            "Moved PKG-300 from SOUTH to EAST",
            "Blocked move of PKG-301 to EAST; capacity 12",
          ],
        },
        {
          path: "lastAction",
          value: "Blocked move of PKG-301 to EAST; capacity 12",
        },
      ],
    },
    {
      events: [
        {
          stream: "assignShipment",
          payload: { shipment: "PKG-301", targetRoute: "NORTH" },
        },
      ],
      expect: [
        {
          path: "shipments",
          value: [
            { id: "PKG-100", route: "NORTH", weight: 5 },
            { id: "PKG-101", route: "NORTH", weight: 4 },
            { id: "PKG-200", route: "EAST", weight: 3 },
            { id: "PKG-201", route: "EAST", weight: 2 },
            { id: "PKG-300", route: "EAST", weight: 5 },
            { id: "PKG-301", route: "NORTH", weight: 6 },
          ],
        },
        {
          path: "loadMetrics",
          value: [
            {
              route: "NORTH",
              label: "North Loop",
              capacity: 18,
              used: 15,
              remaining: 3,
              utilization: 0.83,
              isOverCapacity: false,
            },
            {
              route: "EAST",
              label: "East Express",
              capacity: 12,
              used: 10,
              remaining: 2,
              utilization: 0.83,
              isOverCapacity: false,
            },
            {
              route: "SOUTH",
              label: "South Freight",
              capacity: 16,
              used: 0,
              remaining: 16,
              utilization: 0,
              isOverCapacity: false,
            },
          ],
        },
        {
          path: "history",
          value: [
            "Moved PKG-300 from SOUTH to EAST",
            "Blocked move of PKG-301 to EAST; capacity 12",
            "Moved PKG-301 from SOUTH to NORTH",
          ],
        },
        {
          path: "lastAction",
          value: "Moved PKG-301 from SOUTH to NORTH",
        },
      ],
    },
  ],
};

export const scenarios = [logisticsRoutingScenario];

describe("logistics-routing", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
