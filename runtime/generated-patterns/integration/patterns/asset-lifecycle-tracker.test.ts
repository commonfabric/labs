import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";
import type {
  AssetInput,
  StageCountMap,
} from "./asset-lifecycle-tracker.pattern.ts";

const assetLifecycleTrackerScenario: PatternIntegrationScenario<
  { assets?: AssetInput[] }
> = {
  name: "asset lifecycle updates stage summaries",
  module: new URL("./asset-lifecycle-tracker.pattern.ts", import.meta.url),
  exportName: "assetLifecycleTracker",
  steps: [
    {
      expect: [
        {
          path: "stageCounts",
          value: {
            procured: 1,
            in_service: 1,
            maintenance: 1,
            retired: 0,
          } satisfies StageCountMap,
        },
        { path: "lifecycleLabel", value: "3 active of 3 assets" },
        {
          path: "activeAssetIds",
          value: ["SRV-001", "LPT-104", "PRJ-205"],
        },
        { path: "stageBuckets.0.label", value: "Procured" },
        { path: "stageBuckets.0.count", value: 1 },
        { path: "stageBuckets.1.label", value: "In Service" },
        { path: "stageBuckets.1.count", value: 1 },
        { path: "stageBuckets.2.label", value: "In Maintenance" },
        { path: "stageBuckets.2.count", value: 1 },
        { path: "stageBuckets.3.label", value: "Retired" },
        { path: "stageBuckets.3.count", value: 0 },
        { path: "transitionMessages", value: [] },
        {
          path: "busiestStage",
          value: { label: "Procured", count: 1 },
        },
      ],
    },
    {
      events: [
        { stream: "advanceLifecycle", payload: { assetId: "srv-001" } },
      ],
      expect: [
        {
          path: "stageCounts",
          value: {
            procured: 0,
            in_service: 2,
            maintenance: 1,
            retired: 0,
          } satisfies StageCountMap,
        },
        { path: "lifecycleLabel", value: "3 active of 3 assets" },
        {
          path: "activeAssetIds",
          value: ["SRV-001", "LPT-104", "PRJ-205"],
        },
        { path: "stageBuckets.0.count", value: 0 },
        { path: "stageBuckets.1.count", value: 2 },
        {
          path: "stageBuckets.1.assets",
          value: [
            {
              id: "SRV-001",
              name: "Build Server",
              owner: "Infrastructure",
              stageLabel: "In Service",
            },
            {
              id: "LPT-104",
              name: "Design Laptop",
              owner: "Design",
              stageLabel: "In Service",
            },
          ],
        },
        {
          path: "transitionMessages",
          value: [
            "Build Server moved from Procured to In Service",
          ],
        },
        {
          path: "busiestStage",
          value: { label: "In Service", count: 2 },
        },
      ],
    },
    {
      events: [
        { stream: "markMaintenance", payload: { assetId: "LPT-104" } },
      ],
      expect: [
        {
          path: "stageCounts",
          value: {
            procured: 0,
            in_service: 1,
            maintenance: 2,
            retired: 0,
          } satisfies StageCountMap,
        },
        {
          path: "stageBuckets.2.assets",
          value: [
            {
              id: "LPT-104",
              name: "Design Laptop",
              owner: "Design",
              stageLabel: "In Maintenance",
            },
            {
              id: "PRJ-205",
              name: "Projector Kit",
              owner: "Facilities",
              stageLabel: "In Maintenance",
            },
          ],
        },
        {
          path: "transitionMessages",
          value: [
            "Build Server moved from Procured to In Service",
            "Design Laptop moved from In Service to In Maintenance",
          ],
        },
        {
          path: "busiestStage",
          value: { label: "In Maintenance", count: 2 },
        },
      ],
    },
    {
      events: [
        { stream: "retireAsset", payload: { assetId: "LPT-104" } },
      ],
      expect: [
        {
          path: "stageCounts",
          value: {
            procured: 0,
            in_service: 1,
            maintenance: 1,
            retired: 1,
          } satisfies StageCountMap,
        },
        {
          path: "activeAssetIds",
          value: ["SRV-001", "PRJ-205"],
        },
        { path: "lifecycleLabel", value: "2 active of 3 assets" },
        { path: "lifecycleProgress", value: 67 },
        {
          path: "transitionMessages",
          value: [
            "Build Server moved from Procured to In Service",
            "Design Laptop moved from In Service to In Maintenance",
            "Design Laptop moved from In Maintenance to Retired",
          ],
        },
        {
          path: "busiestStage",
          value: { label: "In Service", count: 1 },
        },
      ],
    },
    {
      events: [
        { stream: "restoreAsset", payload: { assetId: "lpt-104" } },
      ],
      expect: [
        {
          path: "stageCounts",
          value: {
            procured: 0,
            in_service: 2,
            maintenance: 1,
            retired: 0,
          } satisfies StageCountMap,
        },
        {
          path: "activeAssetIds",
          value: ["SRV-001", "LPT-104", "PRJ-205"],
        },
        { path: "lifecycleLabel", value: "3 active of 3 assets" },
        {
          path: "transitionMessages",
          value: [
            "Build Server moved from Procured to In Service",
            "Design Laptop moved from In Service to In Maintenance",
            "Design Laptop moved from In Maintenance to Retired",
            "Design Laptop moved from Retired to In Service",
          ],
        },
        {
          path: "busiestStage",
          value: { label: "In Service", count: 2 },
        },
      ],
    },
  ],
};

export const scenarios = [assetLifecycleTrackerScenario];

describe("asset-lifecycle-tracker", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
