import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface FeatureUsageArgument {
  events?: Array<{
    feature?: string;
    cohort?: string;
    count?: number;
  }>;
  defaultDelta?: number;
}

export const featureUsageAnalyticsScenario: PatternIntegrationScenario<
  FeatureUsageArgument
> = {
  name: "feature usage analytics aggregates counts by feature and cohort",
  module: new URL("./feature-usage-analytics.pattern.ts", import.meta.url),
  exportName: "featureUsageAnalytics",
  argument: {
    events: [
      { feature: "search", cohort: "free", count: 4 },
      { feature: "search", cohort: "free", count: 3 },
      { feature: "search", cohort: "pro", count: 5 },
      { feature: "upload", cohort: "free", count: 6 },
      { feature: "upload", cohort: "team", count: 2 },
      { feature: "share", cohort: "team", count: 8 },
    ],
    defaultDelta: 2,
  },
  steps: [
    {
      expect: [
        {
          path: "usage",
          value: [
            { feature: "search", cohort: "free", count: 7 },
            { feature: "search", cohort: "pro", count: 5 },
            { feature: "share", cohort: "team", count: 8 },
            { feature: "upload", cohort: "free", count: 6 },
            { feature: "upload", cohort: "team", count: 2 },
          ],
        },
        {
          path: "featureTotals",
          value: { search: 12, share: 8, upload: 8 },
        },
        {
          path: "cohortTotals",
          value: { free: 13, pro: 5, team: 10 },
        },
        {
          path: "matrix",
          value: {
            search: { free: 7, pro: 5 },
            share: { team: 8 },
            upload: { free: 6, team: 2 },
          },
        },
        { path: "totalCount", value: 28 },
        { path: "featureCount", value: 3 },
        { path: "cohortCount", value: 3 },
        { path: "topFeature", value: "search" },
        { path: "topFeatureCount", value: 12 },
        { path: "topCohort", value: "free" },
        { path: "topCohortCount", value: 13 },
        {
          path: "statusLabel",
          value: "Top feature search (12 events) across 3 cohorts",
        },
        { path: "lastEvent", value: "none" },
        {
          path: "metricsSnapshot",
          value: {
            total: 28,
            features: { search: 12, share: 8, upload: 8 },
            cohorts: { free: 13, pro: 5, team: 10 },
            featureCount: 3,
            cohortCount: 3,
            topFeature: "search",
            topFeatureCount: 12,
            topCohort: "free",
            topCohortCount: 13,
          },
        },
      ],
    },
    {
      events: [{
        stream: "controls.record",
        payload: { feature: "search", cohort: "free", delta: 3 },
      }],
      expect: [
        {
          path: "usage",
          value: [
            { feature: "search", cohort: "free", count: 10 },
            { feature: "search", cohort: "pro", count: 5 },
            { feature: "share", cohort: "team", count: 8 },
            { feature: "upload", cohort: "free", count: 6 },
            { feature: "upload", cohort: "team", count: 2 },
          ],
        },
        {
          path: "featureTotals",
          value: { search: 15, share: 8, upload: 8 },
        },
        {
          path: "cohortTotals",
          value: { free: 16, pro: 5, team: 10 },
        },
        { path: "totalCount", value: 31 },
        { path: "topFeature", value: "search" },
        { path: "topFeatureCount", value: 15 },
        { path: "topCohort", value: "free" },
        { path: "topCohortCount", value: 16 },
        {
          path: "statusLabel",
          value: "Top feature search (15 events) across 3 cohorts",
        },
        { path: "lastEvent", value: "search>free +3" },
        {
          path: "metricsSnapshot",
          value: {
            total: 31,
            features: { search: 15, share: 8, upload: 8 },
            cohorts: { free: 16, pro: 5, team: 10 },
            featureCount: 3,
            cohortCount: 3,
            topFeature: "search",
            topFeatureCount: 15,
            topCohort: "free",
            topCohortCount: 16,
          },
        },
      ],
    },
    {
      events: [{
        stream: "controls.record",
        payload: { feature: "search", cohort: "enterprise" },
      }],
      expect: [
        {
          path: "usage",
          value: [
            { feature: "search", cohort: "enterprise", count: 2 },
            { feature: "search", cohort: "free", count: 10 },
            { feature: "search", cohort: "pro", count: 5 },
            { feature: "share", cohort: "team", count: 8 },
            { feature: "upload", cohort: "free", count: 6 },
            { feature: "upload", cohort: "team", count: 2 },
          ],
        },
        {
          path: "featureTotals",
          value: { search: 17, share: 8, upload: 8 },
        },
        {
          path: "cohortTotals",
          value: { free: 16, pro: 5, team: 10, enterprise: 2 },
        },
        { path: "totalCount", value: 33 },
        { path: "cohortCount", value: 4 },
        { path: "topFeature", value: "search" },
        { path: "topFeatureCount", value: 17 },
        {
          path: "statusLabel",
          value: "Top feature search (17 events) across 4 cohorts",
        },
        { path: "lastEvent", value: "search>enterprise +2" },
        {
          path: "metricsSnapshot",
          value: {
            total: 33,
            features: { search: 17, share: 8, upload: 8 },
            cohorts: { free: 16, pro: 5, team: 10, enterprise: 2 },
            featureCount: 3,
            cohortCount: 4,
            topFeature: "search",
            topFeatureCount: 17,
            topCohort: "free",
            topCohortCount: 16,
          },
        },
      ],
    },
    {
      events: [{
        stream: "controls.record",
        payload: { feature: "upload", cohort: "team", value: 12 },
      }],
      expect: [
        {
          path: "usage",
          value: [
            { feature: "search", cohort: "enterprise", count: 2 },
            { feature: "search", cohort: "free", count: 10 },
            { feature: "search", cohort: "pro", count: 5 },
            { feature: "share", cohort: "team", count: 8 },
            { feature: "upload", cohort: "free", count: 6 },
            { feature: "upload", cohort: "team", count: 12 },
          ],
        },
        {
          path: "featureTotals",
          value: { search: 17, share: 8, upload: 18 },
        },
        {
          path: "cohortTotals",
          value: { free: 16, pro: 5, team: 20, enterprise: 2 },
        },
        { path: "totalCount", value: 43 },
        { path: "topFeature", value: "upload" },
        { path: "topFeatureCount", value: 18 },
        { path: "topCohort", value: "team" },
        { path: "topCohortCount", value: 20 },
        {
          path: "statusLabel",
          value: "Top feature upload (18 events) across 4 cohorts",
        },
        { path: "lastEvent", value: "upload>team =12" },
        {
          path: "metricsSnapshot",
          value: {
            total: 43,
            features: { search: 17, share: 8, upload: 18 },
            cohorts: { free: 16, pro: 5, team: 20, enterprise: 2 },
            featureCount: 3,
            cohortCount: 4,
            topFeature: "upload",
            topFeatureCount: 18,
            topCohort: "team",
            topCohortCount: 20,
          },
        },
      ],
    },
  ],
};

export const scenarios = [featureUsageAnalyticsScenario];

describe("feature-usage-analytics", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
