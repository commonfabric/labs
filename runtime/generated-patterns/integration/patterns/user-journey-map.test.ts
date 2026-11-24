import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const userJourneyMapScenario: PatternIntegrationScenario<
  { milestones?: unknown; anchorDay?: number }
> = {
  name: "user journey map builds sequential timeline",
  module: new URL("./user-journey-map.pattern.ts", import.meta.url),
  exportName: "userJourneyMap",
  steps: [
    {
      expect: [
        {
          path: "timeline",
          value: [
            {
              id: "discover",
              title: "Discovery",
              status: "completed",
              startDay: 0,
              endDay: 1,
              durationDays: 1,
            },
            {
              id: "activate",
              title: "Activation",
              status: "in_progress",
              startDay: 1,
              endDay: 3,
              durationDays: 2,
            },
            {
              id: "adopt",
              title: "Adoption",
              status: "planned",
              startDay: 3,
              endDay: 6,
              durationDays: 3,
            },
          ],
        },
        {
          path: "statusCounts",
          value: { planned: 1, in_progress: 1, completed: 1 },
        },
        { path: "progress", value: 33 },
        {
          path: "label",
          value:
            "Journey timeline: 3 milestones from day 0 to day 6 (33% complete)",
        },
        { path: "changeLog", value: [] },
      ],
    },
    {
      events: [
        {
          stream: "updateMilestone",
          payload: { id: "activate", status: "completed" },
        },
      ],
      expect: [
        {
          path: "timeline.1.status",
          value: "completed",
        },
        {
          path: "statusCounts",
          value: { planned: 1, in_progress: 0, completed: 2 },
        },
        { path: "progress", value: 67 },
        {
          path: "label",
          value:
            "Journey timeline: 3 milestones from day 0 to day 6 (67% complete)",
        },
        {
          path: "changeLog",
          value: ["Activation:1-3:completed"],
        },
      ],
    },
    {
      events: [
        {
          stream: "updateMilestone",
          payload: {
            id: "advocate",
            title: "Advocacy",
            status: "planned",
            dayOffset: 6,
            durationDays: 2,
          },
        },
      ],
      expect: [
        {
          path: "timeline",
          value: [
            {
              id: "discover",
              title: "Discovery",
              status: "completed",
              startDay: 0,
              endDay: 1,
              durationDays: 1,
            },
            {
              id: "activate",
              title: "Activation",
              status: "completed",
              startDay: 1,
              endDay: 3,
              durationDays: 2,
            },
            {
              id: "adopt",
              title: "Adoption",
              status: "planned",
              startDay: 3,
              endDay: 6,
              durationDays: 3,
            },
            {
              id: "advocate",
              title: "Advocacy",
              status: "planned",
              startDay: 6,
              endDay: 8,
              durationDays: 2,
            },
          ],
        },
        {
          path: "statusCounts",
          value: { planned: 2, in_progress: 0, completed: 2 },
        },
        { path: "progress", value: 50 },
        {
          path: "label",
          value:
            "Journey timeline: 4 milestones from day 0 to day 8 (50% complete)",
        },
        {
          path: "changeLog",
          value: [
            "Activation:1-3:completed",
            "Advocacy:6-8:planned",
          ],
        },
      ],
    },
    {
      events: [
        {
          stream: "updateMilestone",
          payload: {
            id: "adopt",
            status: "in_progress",
            dayOffset: 5,
          },
        },
      ],
      expect: [
        {
          path: "timeline",
          value: [
            {
              id: "discover",
              title: "Discovery",
              status: "completed",
              startDay: 0,
              endDay: 1,
              durationDays: 1,
            },
            {
              id: "activate",
              title: "Activation",
              status: "completed",
              startDay: 1,
              endDay: 3,
              durationDays: 2,
            },
            {
              id: "adopt",
              title: "Adoption",
              status: "in_progress",
              startDay: 5,
              endDay: 8,
              durationDays: 3,
            },
            {
              id: "advocate",
              title: "Advocacy",
              status: "planned",
              startDay: 8,
              endDay: 10,
              durationDays: 2,
            },
          ],
        },
        {
          path: "statusCounts",
          value: { planned: 1, in_progress: 1, completed: 2 },
        },
        { path: "progress", value: 50 },
        {
          path: "label",
          value: "Journey timeline: 4 milestones from day 0 to day 10 " +
            "(50% complete)",
        },
        {
          path: "changeLog",
          value: [
            "Activation:1-3:completed",
            "Advocacy:6-8:planned",
            "Adoption:5-8:in_progress",
          ],
        },
      ],
    },
  ],
};

export const scenarios = [userJourneyMapScenario];

describe("user-journey-map", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
