import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

const initialMilestones = {
  kickoff: { label: "Kickoff review", weight: 30, completed: true },
  design: { label: "Design lock", weight: 40, completed: false },
  launch: { label: "Launch readiness", weight: 30, completed: false },
};

export const goalProgressTrackerScenario: PatternIntegrationScenario<
  { milestones?: Record<string, unknown> }
> = {
  name: "goal progress tracker adjusts weighted completion",
  module: new URL(
    "./goal-progress-tracker.pattern.ts",
    import.meta.url,
  ),
  exportName: "goalProgressTracker",
  argument: { milestones: initialMilestones },
  steps: [
    {
      expect: [
        { path: "totalWeight", value: 100 },
        { path: "completedWeight", value: 30 },
        { path: "remainingWeight", value: 70 },
        { path: "completionPercent", value: 30 },
        { path: "milestones.design.completed", value: false },
        { path: "milestones.kickoff.weight", value: 30 },
        {
          path: "milestoneList",
          value: [
            {
              id: "design",
              label: "Design lock",
              weight: 40,
              completed: false,
              percentOfTotal: 40,
              completedShare: 0,
            },
            {
              id: "kickoff",
              label: "Kickoff review",
              weight: 30,
              completed: true,
              percentOfTotal: 30,
              completedShare: 30,
            },
            {
              id: "launch",
              label: "Launch readiness",
              weight: 30,
              completed: false,
              percentOfTotal: 30,
              completedShare: 0,
            },
          ],
        },
        {
          path: "summary",
          value: "30.0% complete (30/100)",
        },
      ],
    },
    {
      events: [{
        stream: "complete",
        payload: { id: "design", completed: true },
      }],
      expect: [
        { path: "completedWeight", value: 70 },
        { path: "remainingWeight", value: 30 },
        { path: "completionPercent", value: 70 },
        { path: "milestones.design.completed", value: true },
        {
          path: "milestoneList",
          value: [
            {
              id: "design",
              label: "Design lock",
              weight: 40,
              completed: true,
              percentOfTotal: 40,
              completedShare: 40,
            },
            {
              id: "kickoff",
              label: "Kickoff review",
              weight: 30,
              completed: true,
              percentOfTotal: 30,
              completedShare: 30,
            },
            {
              id: "launch",
              label: "Launch readiness",
              weight: 30,
              completed: false,
              percentOfTotal: 30,
              completedShare: 0,
            },
          ],
        },
        {
          path: "summary",
          value: "70.0% complete (70/100)",
        },
      ],
    },
    {
      events: [{ stream: "reweight", payload: { id: "launch", delta: 30 } }],
      expect: [
        { path: "totalWeight", value: 130 },
        { path: "completedWeight", value: 70 },
        { path: "remainingWeight", value: 60 },
        { path: "completionPercent", value: 53.8 },
        { path: "milestones.launch.weight", value: 60 },
        {
          path: "milestoneList",
          value: [
            {
              id: "design",
              label: "Design lock",
              weight: 40,
              completed: true,
              percentOfTotal: 30.8,
              completedShare: 30.8,
            },
            {
              id: "kickoff",
              label: "Kickoff review",
              weight: 30,
              completed: true,
              percentOfTotal: 23.1,
              completedShare: 23.1,
            },
            {
              id: "launch",
              label: "Launch readiness",
              weight: 60,
              completed: false,
              percentOfTotal: 46.2,
              completedShare: 0,
            },
          ],
        },
        {
          path: "summary",
          value: "53.8% complete (70/130)",
        },
      ],
    },
    {
      events: [{ stream: "reweight", payload: { id: "design", weight: 50 } }],
      expect: [
        { path: "totalWeight", value: 140 },
        { path: "completedWeight", value: 80 },
        { path: "remainingWeight", value: 60 },
        { path: "completionPercent", value: 57.1 },
        { path: "milestones.design.weight", value: 50 },
        {
          path: "milestoneList",
          value: [
            {
              id: "design",
              label: "Design lock",
              weight: 50,
              completed: true,
              percentOfTotal: 35.7,
              completedShare: 35.7,
            },
            {
              id: "kickoff",
              label: "Kickoff review",
              weight: 30,
              completed: true,
              percentOfTotal: 21.4,
              completedShare: 21.4,
            },
            {
              id: "launch",
              label: "Launch readiness",
              weight: 60,
              completed: false,
              percentOfTotal: 42.9,
              completedShare: 0,
            },
          ],
        },
        {
          path: "summary",
          value: "57.1% complete (80/140)",
        },
      ],
    },
  ],
};

export const scenarios = [goalProgressTrackerScenario];

describe("goal-progress-tracker", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
