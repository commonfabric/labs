import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

type VariantSeed = { name?: string; weight?: number };

type AssignmentSeed = Record<string, string>;

export const experimentAssignmentScenario: PatternIntegrationScenario<
  { variants?: VariantSeed[]; assignments?: AssignmentSeed }
> = {
  name: "experiment assignment balances allocation ratios",
  module: new URL("./experiment-assignment.pattern.ts", import.meta.url),
  exportName: "experimentAssignmentPattern",
  argument: {
    variants: [
      { name: "control", weight: 1 },
      { name: "experiment", weight: 2 },
      { name: "holdout", weight: 1 },
    ],
    assignments: {},
  },
  steps: [
    {
      expect: [
        {
          path: "variants",
          value: [
            { name: "control", weight: 1 },
            { name: "experiment", weight: 2 },
            { name: "holdout", weight: 1 },
          ],
        },
        {
          path: "assignmentMap",
          value: {},
        },
        {
          path: "counts",
          value: { control: 0, experiment: 0, holdout: 0 },
        },
        {
          path: "allocation",
          value: [
            {
              name: "control",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0,
              assigned: 0,
              difference: 0,
            },
            {
              name: "experiment",
              weight: 2,
              targetShare: 0.5,
              actualShare: 0,
              assigned: 0,
              difference: 0,
            },
            {
              name: "holdout",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0,
              assigned: 0,
              difference: 0,
            },
          ],
        },
        { path: "totalAssignments", value: 0 },
        { path: "assignmentHistory", value: [] },
        {
          path: "balance",
          value: { maxDifference: 0, balanced: true },
        },
        {
          path: "label",
          value: "Assignments 0 [control:0, experiment:0, holdout:0]",
        },
      ],
    },
    {
      events: [{ stream: "assignParticipant", payload: { userId: "user-1" } }],
      expect: [
        {
          path: "assignmentMap",
          value: { "user-1": "experiment" },
        },
        {
          path: "counts",
          value: { control: 0, experiment: 1, holdout: 0 },
        },
        {
          path: "allocation",
          value: [
            {
              name: "control",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0,
              assigned: 0,
              difference: -0.25,
            },
            {
              name: "experiment",
              weight: 2,
              targetShare: 0.5,
              actualShare: 1,
              assigned: 1,
              difference: 0.5,
            },
            {
              name: "holdout",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0,
              assigned: 0,
              difference: -0.25,
            },
          ],
        },
        {
          path: "assignmentHistory",
          value: ["user-1:experiment"],
        },
        { path: "totalAssignments", value: 1 },
        {
          path: "balance",
          value: { maxDifference: 0.5, balanced: false },
        },
        {
          path: "label",
          value: "Assignments 1 [control:0, experiment:1, holdout:0]",
        },
      ],
    },
    {
      events: [{ stream: "assignParticipant", payload: { userId: "user-2" } }],
      expect: [
        {
          path: "assignmentMap",
          value: { "user-1": "experiment", "user-2": "control" },
        },
        {
          path: "counts",
          value: { control: 1, experiment: 1, holdout: 0 },
        },
        {
          path: "allocation",
          value: [
            {
              name: "control",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.5,
              assigned: 1,
              difference: 0.25,
            },
            {
              name: "experiment",
              weight: 2,
              targetShare: 0.5,
              actualShare: 0.5,
              assigned: 1,
              difference: 0,
            },
            {
              name: "holdout",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0,
              assigned: 0,
              difference: -0.25,
            },
          ],
        },
        {
          path: "assignmentHistory",
          value: ["user-1:experiment", "user-2:control"],
        },
        { path: "totalAssignments", value: 2 },
        {
          path: "balance",
          value: { maxDifference: 0.25, balanced: true },
        },
        {
          path: "label",
          value: "Assignments 2 [control:1, experiment:1, holdout:0]",
        },
      ],
    },
    {
      events: [{ stream: "assignParticipant", payload: { userId: "user-3" } }],
      expect: [
        {
          path: "assignmentMap",
          value: {
            "user-1": "experiment",
            "user-2": "control",
            "user-3": "experiment",
          },
        },
        {
          path: "counts",
          value: { control: 1, experiment: 2, holdout: 0 },
        },
        {
          path: "allocation",
          value: [
            {
              name: "control",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.333,
              assigned: 1,
              difference: 0.083,
            },
            {
              name: "experiment",
              weight: 2,
              targetShare: 0.5,
              actualShare: 0.667,
              assigned: 2,
              difference: 0.167,
            },
            {
              name: "holdout",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0,
              assigned: 0,
              difference: -0.25,
            },
          ],
        },
        {
          path: "assignmentHistory",
          value: [
            "user-1:experiment",
            "user-2:control",
            "user-3:experiment",
          ],
        },
        { path: "totalAssignments", value: 3 },
        {
          path: "balance",
          value: { maxDifference: 0.25, balanced: true },
        },
        {
          path: "label",
          value: "Assignments 3 [control:1, experiment:2, holdout:0]",
        },
      ],
    },
    {
      events: [{ stream: "assignParticipant", payload: { userId: "user-4" } }],
      expect: [
        {
          path: "assignmentMap",
          value: {
            "user-1": "experiment",
            "user-2": "control",
            "user-3": "experiment",
            "user-4": "holdout",
          },
        },
        {
          path: "counts",
          value: { control: 1, experiment: 2, holdout: 1 },
        },
        {
          path: "allocation",
          value: [
            {
              name: "control",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.25,
              assigned: 1,
              difference: 0,
            },
            {
              name: "experiment",
              weight: 2,
              targetShare: 0.5,
              actualShare: 0.5,
              assigned: 2,
              difference: 0,
            },
            {
              name: "holdout",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.25,
              assigned: 1,
              difference: 0,
            },
          ],
        },
        {
          path: "assignmentHistory",
          value: [
            "user-1:experiment",
            "user-2:control",
            "user-3:experiment",
            "user-4:holdout",
          ],
        },
        { path: "totalAssignments", value: 4 },
        {
          path: "balance",
          value: { maxDifference: 0, balanced: true },
        },
        {
          path: "label",
          value: "Assignments 4 [control:1, experiment:2, holdout:1]",
        },
      ],
    },
    {
      events: [{ stream: "assignParticipant", payload: { userId: "user-5" } }],
      expect: [
        {
          path: "assignmentMap",
          value: {
            "user-1": "experiment",
            "user-2": "control",
            "user-3": "experiment",
            "user-4": "holdout",
            "user-5": "experiment",
          },
        },
        {
          path: "counts",
          value: { control: 1, experiment: 3, holdout: 1 },
        },
        {
          path: "allocation",
          value: [
            {
              name: "control",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.2,
              assigned: 1,
              difference: -0.05,
            },
            {
              name: "experiment",
              weight: 2,
              targetShare: 0.5,
              actualShare: 0.6,
              assigned: 3,
              difference: 0.1,
            },
            {
              name: "holdout",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.2,
              assigned: 1,
              difference: -0.05,
            },
          ],
        },
        {
          path: "assignmentHistory",
          value: [
            "user-1:experiment",
            "user-2:control",
            "user-3:experiment",
            "user-4:holdout",
            "user-5:experiment",
          ],
        },
        { path: "totalAssignments", value: 5 },
        {
          path: "balance",
          value: { maxDifference: 0.1, balanced: true },
        },
        {
          path: "label",
          value: "Assignments 5 [control:1, experiment:3, holdout:1]",
        },
      ],
    },
    {
      events: [{ stream: "assignParticipant", payload: { userId: "user-6" } }],
      expect: [
        {
          path: "assignmentMap",
          value: {
            "user-1": "experiment",
            "user-2": "control",
            "user-3": "experiment",
            "user-4": "holdout",
            "user-5": "experiment",
            "user-6": "control",
          },
        },
        {
          path: "counts",
          value: { control: 2, experiment: 3, holdout: 1 },
        },
        {
          path: "allocation",
          value: [
            {
              name: "control",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.333,
              assigned: 2,
              difference: 0.083,
            },
            {
              name: "experiment",
              weight: 2,
              targetShare: 0.5,
              actualShare: 0.5,
              assigned: 3,
              difference: 0,
            },
            {
              name: "holdout",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.167,
              assigned: 1,
              difference: -0.083,
            },
          ],
        },
        {
          path: "assignmentHistory",
          value: [
            "user-1:experiment",
            "user-2:control",
            "user-3:experiment",
            "user-4:holdout",
            "user-5:experiment",
            "user-6:control",
          ],
        },
        { path: "totalAssignments", value: 6 },
        {
          path: "balance",
          value: { maxDifference: 0.083, balanced: true },
        },
        {
          path: "label",
          value: "Assignments 6 [control:2, experiment:3, holdout:1]",
        },
      ],
    },
    {
      events: [{ stream: "assignParticipant", payload: { userId: "user-7" } }],
      expect: [
        {
          path: "assignmentMap",
          value: {
            "user-1": "experiment",
            "user-2": "control",
            "user-3": "experiment",
            "user-4": "holdout",
            "user-5": "experiment",
            "user-6": "control",
            "user-7": "experiment",
          },
        },
        {
          path: "counts",
          value: { control: 2, experiment: 4, holdout: 1 },
        },
        {
          path: "allocation",
          value: [
            {
              name: "control",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.286,
              assigned: 2,
              difference: 0.036,
            },
            {
              name: "experiment",
              weight: 2,
              targetShare: 0.5,
              actualShare: 0.571,
              assigned: 4,
              difference: 0.071,
            },
            {
              name: "holdout",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.143,
              assigned: 1,
              difference: -0.107,
            },
          ],
        },
        {
          path: "assignmentHistory",
          value: [
            "user-1:experiment",
            "user-2:control",
            "user-3:experiment",
            "user-4:holdout",
            "user-5:experiment",
            "user-6:control",
            "user-7:experiment",
          ],
        },
        { path: "totalAssignments", value: 7 },
        {
          path: "balance",
          value: { maxDifference: 0.107, balanced: true },
        },
        {
          path: "label",
          value: "Assignments 7 [control:2, experiment:4, holdout:1]",
        },
      ],
    },
    {
      events: [{ stream: "assignParticipant", payload: { userId: "user-8" } }],
      expect: [
        {
          path: "assignmentMap",
          value: {
            "user-1": "experiment",
            "user-2": "control",
            "user-3": "experiment",
            "user-4": "holdout",
            "user-5": "experiment",
            "user-6": "control",
            "user-7": "experiment",
            "user-8": "holdout",
          },
        },
        {
          path: "counts",
          value: { control: 2, experiment: 4, holdout: 2 },
        },
        {
          path: "allocation",
          value: [
            {
              name: "control",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.25,
              assigned: 2,
              difference: 0,
            },
            {
              name: "experiment",
              weight: 2,
              targetShare: 0.5,
              actualShare: 0.5,
              assigned: 4,
              difference: 0,
            },
            {
              name: "holdout",
              weight: 1,
              targetShare: 0.25,
              actualShare: 0.25,
              assigned: 2,
              difference: 0,
            },
          ],
        },
        {
          path: "assignmentHistory",
          value: [
            "user-1:experiment",
            "user-2:control",
            "user-3:experiment",
            "user-4:holdout",
            "user-5:experiment",
            "user-6:control",
            "user-7:experiment",
            "user-8:holdout",
          ],
        },
        { path: "totalAssignments", value: 8 },
        {
          path: "balance",
          value: { maxDifference: 0, balanced: true },
        },
        {
          path: "label",
          value: "Assignments 8 [control:2, experiment:4, holdout:2]",
        },
      ],
    },
  ],
};

export const scenarios = [experimentAssignmentScenario];

describe("experiment-assignment", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
