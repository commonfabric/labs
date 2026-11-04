import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

type HierarchyArg = {
  hierarchy?: {
    clusters: {
      north: { nodes: Array<{ metrics: { alpha: number; beta: number } }> };
      south: { nodes: Array<{ metrics: { alpha: number; beta: number } }> };
    };
  };
};

const createInitialHierarchy = () => ({
  clusters: {
    north: {
      nodes: [
        { metrics: { alpha: 1, beta: 0 } },
        { metrics: { alpha: 0, beta: 2 } },
      ],
    },
    south: {
      nodes: [{ metrics: { alpha: 0, beta: 1 } }],
    },
  },
});

const hierarchyAfterNorthBeta = () => ({
  clusters: {
    north: {
      nodes: [
        { metrics: { alpha: 1, beta: 0 } },
        { metrics: { alpha: 0, beta: 5 } },
      ],
    },
    south: {
      nodes: [{ metrics: { alpha: 0, beta: 1 } }],
    },
  },
});

const hierarchyAfterSouthAlpha = () => ({
  clusters: {
    north: {
      nodes: [
        { metrics: { alpha: 1, beta: 0 } },
        { metrics: { alpha: 0, beta: 5 } },
      ],
    },
    south: {
      nodes: [{ metrics: { alpha: 2, beta: 1 } }],
    },
  },
});

const hierarchyAfterDefaultPath = () => ({
  clusters: {
    north: {
      nodes: [
        { metrics: { alpha: 6, beta: 0 } },
        { metrics: { alpha: 0, beta: 5 } },
      ],
    },
    south: {
      nodes: [{ metrics: { alpha: 2, beta: 1 } }],
    },
  },
});

export const counterHierarchicalKeyPathScenario: PatternIntegrationScenario<
  HierarchyArg
> = {
  name: "counter updates via hierarchical key paths",
  module: new URL(
    "./counter-hierarchical-key-path.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithHierarchicalKeyPath",
  argument: { hierarchy: createInitialHierarchy() },
  steps: [
    {
      expect: [
        { path: "hierarchy", value: createInitialHierarchy() },
        { path: "updates", value: 0 },
        {
          path: "defaultPath",
          value: "clusters.north.nodes.0.metrics.alpha",
        },
        {
          path: "lastUpdatedPath",
          value: "clusters.north.nodes.0.metrics.alpha",
        },
        { path: "pathLog", value: [] },
        { path: "totals", value: { north: 3, south: 1 } },
        { path: "overall", value: 4 },
        {
          path: "label",
          value: "0 updates via clusters.north.nodes.0.metrics.alpha",
        },
      ],
    },
    {
      events: [
        {
          stream: "adjust",
          payload: {
            path: [
              "clusters",
              "north",
              "nodes",
              1,
              "metrics",
              "beta",
            ],
            amount: 3,
          },
        },
      ],
      expect: [
        { path: "hierarchy", value: hierarchyAfterNorthBeta() },
        { path: "updates", value: 1 },
        {
          path: "lastUpdatedPath",
          value: "clusters.north.nodes.1.metrics.beta",
        },
        {
          path: "pathLog",
          value: ["clusters.north.nodes.1.metrics.beta"],
        },
        { path: "totals", value: { north: 6, south: 1 } },
        { path: "overall", value: 7 },
        {
          path: "label",
          value: "1 updates via clusters.north.nodes.1.metrics.beta",
        },
      ],
    },
    {
      events: [
        {
          stream: "adjust",
          payload: {
            path: ["south", "nodes", 0, "metrics", "alpha"],
            amount: 2,
          },
        },
      ],
      expect: [
        { path: "hierarchy", value: hierarchyAfterSouthAlpha() },
        { path: "updates", value: 2 },
        {
          path: "lastUpdatedPath",
          value: "clusters.south.nodes.0.metrics.alpha",
        },
        {
          path: "pathLog",
          value: [
            "clusters.north.nodes.1.metrics.beta",
            "clusters.south.nodes.0.metrics.alpha",
          ],
        },
        { path: "totals", value: { north: 6, south: 3 } },
        { path: "overall", value: 9 },
        {
          path: "label",
          value: "2 updates via clusters.south.nodes.0.metrics.alpha",
        },
      ],
    },
    {
      events: [
        {
          stream: "adjust",
          payload: { amount: 5 },
        },
      ],
      expect: [
        { path: "hierarchy", value: hierarchyAfterDefaultPath() },
        { path: "updates", value: 3 },
        {
          path: "lastUpdatedPath",
          value: "clusters.north.nodes.0.metrics.alpha",
        },
        {
          path: "pathLog",
          value: [
            "clusters.north.nodes.1.metrics.beta",
            "clusters.south.nodes.0.metrics.alpha",
            "clusters.north.nodes.0.metrics.alpha",
          ],
        },
        { path: "totals", value: { north: 11, south: 3 } },
        { path: "overall", value: 14 },
        {
          path: "label",
          value: "3 updates via clusters.north.nodes.0.metrics.alpha",
        },
      ],
    },
  ],
};

export const scenarios = [counterHierarchicalKeyPathScenario];

describe("counter-hierarchical-key-path", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
