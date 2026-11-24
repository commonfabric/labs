import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const warehouseBinMapScenario: PatternIntegrationScenario = {
  name: "warehouse bin map maintains occupancy after relocations",
  module: new URL("./warehouse-bin-map.pattern.ts", import.meta.url),
  exportName: "warehouseBinMap",
  steps: [
    {
      expect: [
        {
          path: "placements",
          value: [
            { id: "WIDGET-100", bin: "A1" },
            { id: "WIDGET-200", bin: "A1" },
            { id: "WIDGET-300", bin: "B2" },
          ],
        },
        {
          path: "occupancy",
          value: {
            A1: { capacity: 2, used: 2, available: 0 },
            B2: { capacity: 3, used: 1, available: 2 },
            C3: { capacity: 1, used: 0, available: 1 },
          },
        },
        { path: "availableBins", value: ["B2", "C3"] },
        { path: "status", value: "3 items across 3 bins" },
        { path: "lastAction", value: "initialized" },
      ],
    },
    {
      events: [
        {
          stream: "relocate",
          payload: { itemId: "widget-200", targetBin: "b2" },
        },
      ],
      expect: [
        {
          path: "placements",
          value: [
            { id: "WIDGET-100", bin: "A1" },
            { id: "WIDGET-200", bin: "B2" },
            { id: "WIDGET-300", bin: "B2" },
          ],
        },
        {
          path: "occupancy",
          value: {
            A1: { capacity: 2, used: 1, available: 1 },
            B2: { capacity: 3, used: 2, available: 1 },
            C3: { capacity: 1, used: 0, available: 1 },
          },
        },
        { path: "availableBins", value: ["A1", "B2", "C3"] },
        {
          path: "lastAction",
          value: "Moved WIDGET-200 from A1 to B2",
        },
      ],
    },
    {
      events: [
        {
          stream: "relocate",
          payload: { itemId: "widget-300", targetBin: "C3" },
        },
      ],
      expect: [
        {
          path: "placements",
          value: [
            { id: "WIDGET-100", bin: "A1" },
            { id: "WIDGET-200", bin: "B2" },
            { id: "WIDGET-300", bin: "C3" },
          ],
        },
        {
          path: "occupancy",
          value: {
            A1: { capacity: 2, used: 1, available: 1 },
            B2: { capacity: 3, used: 1, available: 2 },
            C3: { capacity: 1, used: 1, available: 0 },
          },
        },
        { path: "availableBins", value: ["A1", "B2"] },
        {
          path: "lastAction",
          value: "Moved WIDGET-300 from B2 to C3",
        },
      ],
    },
    {
      events: [
        {
          stream: "relocate",
          payload: { itemId: "widget-100", targetBin: "c3" },
        },
      ],
      expect: [
        {
          path: "placements",
          value: [
            { id: "WIDGET-100", bin: "A1" },
            { id: "WIDGET-200", bin: "B2" },
            { id: "WIDGET-300", bin: "C3" },
          ],
        },
        {
          path: "occupancy",
          value: {
            A1: { capacity: 2, used: 1, available: 1 },
            B2: { capacity: 3, used: 1, available: 2 },
            C3: { capacity: 1, used: 1, available: 0 },
          },
        },
        { path: "availableBins", value: ["A1", "B2"] },
        {
          path: "lastAction",
          value: "Moved WIDGET-300 from B2 to C3",
        },
      ],
    },
    {
      events: [
        {
          stream: "relocate",
          payload: { itemId: "widget-100", targetBin: "b2" },
        },
      ],
      expect: [
        {
          path: "placements",
          value: [
            { id: "WIDGET-100", bin: "B2" },
            { id: "WIDGET-200", bin: "B2" },
            { id: "WIDGET-300", bin: "C3" },
          ],
        },
        {
          path: "occupancy",
          value: {
            A1: { capacity: 2, used: 0, available: 2 },
            B2: { capacity: 3, used: 2, available: 1 },
            C3: { capacity: 1, used: 1, available: 0 },
          },
        },
        { path: "availableBins", value: ["A1", "B2"] },
        {
          path: "history",
          value: [
            "Moved WIDGET-200 from A1 to B2",
            "Moved WIDGET-300 from B2 to C3",
            "Moved WIDGET-100 from A1 to B2",
          ],
        },
        {
          path: "lastAction",
          value: "Moved WIDGET-100 from A1 to B2",
        },
      ],
    },
  ],
};

export const scenarios = [warehouseBinMapScenario];

describe("warehouse-bin-map", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
