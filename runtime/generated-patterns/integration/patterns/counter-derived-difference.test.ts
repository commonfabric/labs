import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterDerivedDifferenceScenario: PatternIntegrationScenario<
  {
    primary?: number;
    secondary?: number;
    primaryStep?: number;
    secondaryStep?: number;
  }
> = {
  name: "counter derives difference between primary and secondary values",
  module: new URL(
    "./counter-derived-difference.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithDerivedDifference",
  steps: [
    {
      expect: [
        { path: "primaryValue", value: 0 },
        { path: "secondaryValue", value: 0 },
        { path: "differenceValue", value: 0 },
        { path: "differenceSummary.primary", value: 0 },
        { path: "differenceSummary.secondary", value: 0 },
        { path: "differenceSummary.difference", value: 0 },
        { path: "primaryStepValue", value: 1 },
        { path: "secondaryStepValue", value: 1 },
        {
          path: "summaryLabel",
          value: "Difference 0 (primary 0, secondary 0)",
        },
        { path: "differenceHistory", value: [] },
        { path: "auditLog", value: [] },
      ],
    },
    {
      events: [{
        stream: "controls.primary.adjust",
        payload: { amount: 4 },
      }],
      expect: [
        { path: "primaryValue", value: 4 },
        { path: "differenceValue", value: 4 },
        { path: "differenceSummary.primary", value: 4 },
        { path: "differenceSummary.difference", value: 4 },
        {
          path: "summaryLabel",
          value: "Difference 4 (primary 4, secondary 0)",
        },
        { path: "differenceHistory", value: [4] },
        {
          path: "auditLog",
          value: [{
            sequence: 1,
            via: "primary",
            primary: 4,
            secondary: 0,
            difference: 4,
          }],
        },
      ],
    },
    {
      events: [{
        stream: "controls.secondary.adjust",
        payload: { direction: "increase" },
      }],
      expect: [
        { path: "secondaryValue", value: 1 },
        { path: "differenceValue", value: 3 },
        { path: "differenceSummary.secondary", value: 1 },
        { path: "differenceSummary.difference", value: 3 },
        {
          path: "summaryLabel",
          value: "Difference 3 (primary 4, secondary 1)",
        },
        { path: "differenceHistory", value: [4, 3] },
        {
          path: "auditLog",
          value: [
            {
              sequence: 1,
              via: "primary",
              primary: 4,
              secondary: 0,
              difference: 4,
            },
            {
              sequence: 2,
              via: "secondary",
              primary: 4,
              secondary: 1,
              difference: 3,
            },
          ],
        },
      ],
    },
    {
      events: [
        { stream: "controls.secondary.setStep", payload: { step: 2 } },
        { stream: "controls.secondary.adjust", payload: { amount: 2 } },
      ],
      expect: [
        { path: "secondaryStepValue", value: 2 },
        { path: "secondaryValue", value: 3 },
        { path: "differenceValue", value: 1 },
        { path: "differenceSummary.secondary", value: 3 },
        { path: "differenceSummary.difference", value: 1 },
        {
          path: "summaryLabel",
          value: "Difference 1 (primary 4, secondary 3)",
        },
        { path: "differenceHistory", value: [4, 3, 1] },
        {
          path: "auditLog",
          value: [
            {
              sequence: 1,
              via: "primary",
              primary: 4,
              secondary: 0,
              difference: 4,
            },
            {
              sequence: 2,
              via: "secondary",
              primary: 4,
              secondary: 1,
              difference: 3,
            },
            {
              sequence: 3,
              via: "secondary",
              primary: 4,
              secondary: 3,
              difference: 1,
            },
          ],
        },
      ],
    },
    {
      events: [{
        stream: "controls.primary.adjust",
        payload: { direction: "decrease" },
      }],
      expect: [
        { path: "primaryValue", value: 3 },
        { path: "differenceValue", value: 0 },
        { path: "differenceSummary.primary", value: 3 },
        { path: "differenceSummary.difference", value: 0 },
        {
          path: "summaryLabel",
          value: "Difference 0 (primary 3, secondary 3)",
        },
        { path: "differenceHistory", value: [4, 3, 1, 0] },
        {
          path: "auditLog",
          value: [
            {
              sequence: 1,
              via: "primary",
              primary: 4,
              secondary: 0,
              difference: 4,
            },
            {
              sequence: 2,
              via: "secondary",
              primary: 4,
              secondary: 1,
              difference: 3,
            },
            {
              sequence: 3,
              via: "secondary",
              primary: 4,
              secondary: 3,
              difference: 1,
            },
            {
              sequence: 4,
              via: "primary",
              primary: 3,
              secondary: 3,
              difference: 0,
            },
          ],
        },
      ],
    },
  ],
};

export const scenarios = [counterDerivedDifferenceScenario];

describe("counter-derived-difference", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
