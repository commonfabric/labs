import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const educationCoursePlannerScenario: PatternIntegrationScenario<
  {
    modules?: Array<{ id?: string; title?: string; durationWeeks?: number }>;
    startWeek?: number;
  }
> = {
  name: "education course planner reorders modules",
  module: new URL("./education-course-planner.pattern.ts", import.meta.url),
  exportName: "educationCoursePlanner",
  steps: [
    {
      expect: [
        {
          path: "moduleOrder",
          value: ["orientation", "foundations", "project"],
        },
        {
          path: "timelineSummary",
          value: "Orientation (W1-W1) → Core Foundations (W2-W3) " +
            "→ Capstone Project (W4-W6)",
        },
        { path: "totalDuration", value: 6 },
        { path: "reorderCount", value: 0 },
        { path: "lastAction", value: "initialized" },
      ],
    },
    {
      events: [{ stream: "reorder", payload: { from: 2, to: 0 } }],
      expect: [
        {
          path: "moduleOrder",
          value: ["project", "orientation", "foundations"],
        },
        {
          path: "timelineSummary",
          value: "Capstone Project (W1-W3) → Orientation (W4-W4) " +
            "→ Core Foundations (W5-W6)",
        },
        { path: "timeline.0.startWeek", value: 1 },
        { path: "timeline.0.endWeek", value: 3 },
        { path: "reorderCount", value: 1 },
        { path: "lastAction", value: "Moved Capstone Project to position 1" },
      ],
    },
    {
      events: [{ stream: "reorder", payload: { from: 1, to: 2 } }],
      expect: [
        {
          path: "moduleOrder",
          value: ["project", "foundations", "orientation"],
        },
        {
          path: "timelineSummary",
          value: "Capstone Project (W1-W3) → Core Foundations (W4-W5) " +
            "→ Orientation (W6-W6)",
        },
        { path: "timeline.1.startWeek", value: 4 },
        { path: "timeline.1.endWeek", value: 5 },
        { path: "reorderCount", value: 2 },
        { path: "lastAction", value: "Moved Orientation to position 3" },
      ],
    },
  ],
};

export const scenarios = [educationCoursePlannerScenario];

describe("education-course-planner", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
