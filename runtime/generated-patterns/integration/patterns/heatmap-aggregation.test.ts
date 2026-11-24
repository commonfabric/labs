import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface HeatmapArguments {
  width?: number;
  height?: number;
  interactions?: Array<{ x?: number; y?: number; weight?: number }>;
}

export const heatmapAggregationScenario: PatternIntegrationScenario<
  HeatmapArguments
> = {
  name: "heatmap aggregation normalizes intensity",
  module: new URL("./heatmap-aggregation.pattern.ts", import.meta.url),
  exportName: "heatmapAggregation",
  argument: {
    width: 4,
    height: 3,
    interactions: [
      { x: 0, y: 0, weight: 1 },
      { x: 1.2, y: 0.4, weight: 2 },
      { x: 1, y: 2, weight: 3 },
      { x: 3, y: 1.6, weight: 1 },
    ],
  },
  steps: [
    {
      expect: [
        {
          path: "bucketGrid",
          value: [
            [1, 2, 0, 0],
            [0, 0, 0, 1],
            [0, 3, 0, 0],
          ],
        },
        {
          path: "normalizedGrid",
          value: [
            [0.33, 0.67, 0, 0],
            [0, 0, 0, 0.33],
            [0, 1, 0, 0],
          ],
        },
        { path: "maxIntensity", value: 3 },
        { path: "interactionCount", value: 7 },
        {
          path: "peaks",
          value: [{ x: 1, y: 2, intensity: 3 }],
        },
        { path: "peakSummary", value: "(1,2)" },
        { path: "label", value: "Peak intensity 3 at (1,2)" },
      ],
    },
    {
      events: [{ stream: "record", payload: { x: 3.7, y: 2.2, weight: 2.5 } }],
      expect: [
        {
          path: "bucketGrid",
          value: [
            [1, 2, 0, 0],
            [0, 0, 0, 1],
            [0, 3, 0, 2.5],
          ],
        },
        {
          path: "normalizedGrid",
          value: [
            [0.33, 0.67, 0, 0],
            [0, 0, 0, 0.33],
            [0, 1, 0, 0.83],
          ],
        },
        { path: "maxIntensity", value: 3 },
        { path: "interactionCount", value: 9.5 },
        {
          path: "peaks",
          value: [{ x: 1, y: 2, intensity: 3 }],
        },
        { path: "label", value: "Peak intensity 3 at (1,2)" },
      ],
    },
    {
      events: [{ stream: "record", payload: { x: 1, y: 2, weight: 4 } }],
      expect: [
        {
          path: "bucketGrid",
          value: [
            [1, 2, 0, 0],
            [0, 0, 0, 1],
            [0, 7, 0, 2.5],
          ],
        },
        {
          path: "normalizedGrid",
          value: [
            [0.14, 0.29, 0, 0],
            [0, 0, 0, 0.14],
            [0, 1, 0, 0.36],
          ],
        },
        { path: "maxIntensity", value: 7 },
        { path: "interactionCount", value: 13.5 },
        {
          path: "peaks",
          value: [{ x: 1, y: 2, intensity: 7 }],
        },
        { path: "label", value: "Peak intensity 7 at (1,2)" },
      ],
    },
    {
      events: [{
        stream: "record",
        payload: {
          points: [
            { x: -4, y: 10, weight: 1 },
            { x: 2, y: 0 },
          ],
        },
      }],
      expect: [
        {
          path: "bucketGrid",
          value: [
            [1, 2, 1, 0],
            [0, 0, 0, 1],
            [1, 7, 0, 2.5],
          ],
        },
        {
          path: "normalizedGrid",
          value: [
            [0.14, 0.29, 0.14, 0],
            [0, 0, 0, 0.14],
            [0.14, 1, 0, 0.36],
          ],
        },
        { path: "maxIntensity", value: 7 },
        { path: "interactionCount", value: 15.5 },
        {
          path: "peaks",
          value: [{ x: 1, y: 2, intensity: 7 }],
        },
        { path: "label", value: "Peak intensity 7 at (1,2)" },
      ],
    },
  ],
};

export const scenarios = [heatmapAggregationScenario];

describe("heatmap-aggregation", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
