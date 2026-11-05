import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const workoutRoutinePlannerScenario: PatternIntegrationScenario<
  { days?: string[]; catalog?: unknown; plan?: unknown }
> = {
  name: "workout routine planner updates muscle volume",
  module: new URL(
    "./workout-routine-planner.pattern.ts",
    import.meta.url,
  ),
  exportName: "workoutRoutinePlanner",
  steps: [
    {
      expect: [
        { path: "plan", value: [] },
        { path: "volumeByGroup", value: [] },
        { path: "totalVolume", value: 0 },
        { path: "status", value: "0 total reps across 0 muscle groups" },
        { path: "focusSummary", value: "Top focus: None" },
        { path: "lastAction", value: "initialized" },
        { path: "scheduleByDay.Monday", value: [] },
        { path: "scheduleByDay.Tuesday", value: [] },
        { path: "scheduleByDay.Wednesday", value: [] },
        { path: "scheduleByDay.Thursday", value: [] },
        { path: "scheduleByDay.Friday", value: [] },
        { path: "scheduleByDay.Saturday", value: [] },
        { path: "scheduleByDay.Sunday", value: [] },
      ],
    },
    {
      events: [
        {
          stream: "scheduleWorkout",
          payload: {
            day: "Monday",
            exercise: "Back Squat",
            sets: 4,
            reps: 6,
          },
        },
      ],
      expect: [
        { path: "plan.0.day", value: "Monday" },
        { path: "plan.0.exercise", value: "Back Squat" },
        { path: "plan.0.muscleGroup", value: "Legs" },
        { path: "plan.0.sets", value: 4 },
        { path: "plan.0.reps", value: 6 },
        {
          path: "scheduleByDay.Monday",
          value: [
            {
              day: "Monday",
              exercise: "Back Squat",
              muscleGroup: "Legs",
              sets: 4,
              reps: 6,
            },
          ],
        },
        {
          path: "volumeByGroup",
          value: [
            {
              muscleGroup: "Legs",
              sessionCount: 1,
              totalSets: 4,
              totalReps: 6,
              totalVolume: 24,
            },
          ],
        },
        { path: "totalVolume", value: 24 },
        {
          path: "status",
          value: "24 total reps across 1 muscle groups",
        },
        {
          path: "focusSummary",
          value: "Top focus: Legs (24 reps)",
        },
        {
          path: "lastAction",
          value: "Scheduled Back Squat for Monday (4x6)",
        },
      ],
    },
    {
      events: [
        {
          stream: "scheduleWorkout",
          payload: {
            day: "Tuesday",
            exercise: "Bench Press",
            sets: 3,
            reps: 8,
          },
        },
      ],
      expect: [
        { path: "plan.1.day", value: "Tuesday" },
        { path: "plan.1.exercise", value: "Bench Press" },
        { path: "plan.1.muscleGroup", value: "Chest" },
        { path: "plan.1.sets", value: 3 },
        { path: "plan.1.reps", value: 8 },
        {
          path: "scheduleByDay.Tuesday",
          value: [
            {
              day: "Tuesday",
              exercise: "Bench Press",
              muscleGroup: "Chest",
              sets: 3,
              reps: 8,
            },
          ],
        },
        {
          path: "volumeByGroup",
          value: [
            {
              muscleGroup: "Chest",
              sessionCount: 1,
              totalSets: 3,
              totalReps: 8,
              totalVolume: 24,
            },
            {
              muscleGroup: "Legs",
              sessionCount: 1,
              totalSets: 4,
              totalReps: 6,
              totalVolume: 24,
            },
          ],
        },
        { path: "totalVolume", value: 48 },
        {
          path: "status",
          value: "48 total reps across 2 muscle groups",
        },
        {
          path: "focusSummary",
          value: "Top focus: Chest (24 reps)",
        },
        {
          path: "lastAction",
          value: "Scheduled Bench Press for Tuesday (3x8)",
        },
      ],
    },
    {
      events: [
        {
          stream: "scheduleWorkout",
          payload: {
            day: "Monday",
            exercise: "Back Squat",
            sets: 5,
          },
        },
      ],
      expect: [
        { path: "plan.0.sets", value: 5 },
        { path: "plan.0.reps", value: 6 },
        {
          path: "volumeByGroup",
          value: [
            {
              muscleGroup: "Chest",
              sessionCount: 1,
              totalSets: 3,
              totalReps: 8,
              totalVolume: 24,
            },
            {
              muscleGroup: "Legs",
              sessionCount: 1,
              totalSets: 5,
              totalReps: 6,
              totalVolume: 30,
            },
          ],
        },
        { path: "totalVolume", value: 54 },
        {
          path: "status",
          value: "54 total reps across 2 muscle groups",
        },
        {
          path: "focusSummary",
          value: "Top focus: Legs (30 reps)",
        },
        {
          path: "lastAction",
          value: "Scheduled Back Squat for Monday (5x6)",
        },
      ],
    },
    {
      events: [
        {
          stream: "removeWorkout",
          payload: {
            day: "Tuesday",
            exercise: "Bench Press",
          },
        },
      ],
      expect: [
        {
          path: "plan",
          value: [
            {
              day: "Monday",
              exercise: "Back Squat",
              muscleGroup: "Legs",
              sets: 5,
              reps: 6,
            },
          ],
        },
        {
          path: "scheduleByDay.Tuesday",
          value: [],
        },
        {
          path: "volumeByGroup",
          value: [
            {
              muscleGroup: "Legs",
              sessionCount: 1,
              totalSets: 5,
              totalReps: 6,
              totalVolume: 30,
            },
          ],
        },
        { path: "totalVolume", value: 30 },
        {
          path: "status",
          value: "30 total reps across 1 muscle groups",
        },
        {
          path: "focusSummary",
          value: "Top focus: Legs (30 reps)",
        },
        {
          path: "lastAction",
          value: "Removed Bench Press on Tuesday",
        },
      ],
    },
  ],
};

export const scenarios = [workoutRoutinePlannerScenario];

describe("workout-routine-planner", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
