import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const podcastEpisodePlannerScenario: PatternIntegrationScenario<
  { segments?: unknown }
> = {
  name: "podcast episode planner derives outline",
  module: new URL("./podcast-episode-planner.pattern.ts", import.meta.url),
  exportName: "podcastEpisodePlanner",
  steps: [
    {
      expect: [
        {
          path: "segmentsView",
          value: [
            { id: "intro", title: "Intro", duration: 2 },
            { id: "interview", title: "Interview", duration: 25 },
            { id: "outro", title: "Outro", duration: 3 },
          ],
        },
        {
          path: "timeline",
          value: [
            {
              id: "intro",
              title: "Intro",
              duration: 2,
              startMinute: 0,
              endMinute: 2,
              label: "Intro (2m) @0-2",
            },
            {
              id: "interview",
              title: "Interview",
              duration: 25,
              startMinute: 2,
              endMinute: 27,
              label: "Interview (25m) @2-27",
            },
            {
              id: "outro",
              title: "Outro",
              duration: 3,
              startMinute: 27,
              endMinute: 30,
              label: "Outro (3m) @27-30",
            },
          ],
        },
        {
          path: "outline",
          value: "Intro (2m) @0-2 -> Interview (25m) @2-27 -> " +
            "Outro (3m) @27-30",
        },
        { path: "totalMinutes", value: 30 },
        {
          path: "label",
          value:
            "Episode Outline: Intro (2m) @0-2 -> Interview (25m) @2-27 -> " +
            "Outro (3m) @27-30",
        },
      ],
    },
    {
      events: [
        {
          stream: "updateSegment",
          payload: {
            id: "interview",
            title: "Main Interview",
            duration: 28,
          },
        },
      ],
      expect: [
        {
          path: "segmentsView",
          value: [
            { id: "intro", title: "Intro", duration: 2 },
            { id: "interview", title: "Main Interview", duration: 28 },
            { id: "outro", title: "Outro", duration: 3 },
          ],
        },
        {
          path: "timeline",
          value: [
            {
              id: "intro",
              title: "Intro",
              duration: 2,
              startMinute: 0,
              endMinute: 2,
              label: "Intro (2m) @0-2",
            },
            {
              id: "interview",
              title: "Main Interview",
              duration: 28,
              startMinute: 2,
              endMinute: 30,
              label: "Main Interview (28m) @2-30",
            },
            {
              id: "outro",
              title: "Outro",
              duration: 3,
              startMinute: 30,
              endMinute: 33,
              label: "Outro (3m) @30-33",
            },
          ],
        },
        {
          path: "outline",
          value: "Intro (2m) @0-2 -> Main Interview (28m) @2-30 -> " +
            "Outro (3m) @30-33",
        },
        { path: "totalMinutes", value: 33 },
        {
          path: "label",
          value:
            "Episode Outline: Intro (2m) @0-2 -> Main Interview (28m) @2-30 -> " +
            "Outro (3m) @30-33",
        },
      ],
    },
    {
      events: [
        { stream: "reorderSegments", payload: { from: 2, to: 1 } },
      ],
      expect: [
        {
          path: "segmentsView",
          value: [
            { id: "intro", title: "Intro", duration: 2 },
            { id: "outro", title: "Outro", duration: 3 },
            { id: "interview", title: "Main Interview", duration: 28 },
          ],
        },
        {
          path: "timeline",
          value: [
            {
              id: "intro",
              title: "Intro",
              duration: 2,
              startMinute: 0,
              endMinute: 2,
              label: "Intro (2m) @0-2",
            },
            {
              id: "outro",
              title: "Outro",
              duration: 3,
              startMinute: 2,
              endMinute: 5,
              label: "Outro (3m) @2-5",
            },
            {
              id: "interview",
              title: "Main Interview",
              duration: 28,
              startMinute: 5,
              endMinute: 33,
              label: "Main Interview (28m) @5-33",
            },
          ],
        },
        {
          path: "outline",
          value: "Intro (2m) @0-2 -> Outro (3m) @2-5 -> " +
            "Main Interview (28m) @5-33",
        },
        { path: "totalMinutes", value: 33 },
        {
          path: "label",
          value: "Episode Outline: Intro (2m) @0-2 -> Outro (3m) @2-5 -> " +
            "Main Interview (28m) @5-33",
        },
      ],
    },
  ],
};

export const scenarios = [podcastEpisodePlannerScenario];

describe("podcast-episode-planner", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
