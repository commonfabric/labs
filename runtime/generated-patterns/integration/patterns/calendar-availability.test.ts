import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const calendarAvailabilityScenario: PatternIntegrationScenario<
  {
    participants?: {
      name?: string;
      slots?: Array<string | { start?: string; end?: string }>;
    }[];
    blocked?: Array<string | { start?: string; end?: string }>;
  }
> = {
  name: "calendar merges shared availability and respects block edits",
  module: new URL("./calendar-availability.pattern.ts", import.meta.url),
  exportName: "calendarAvailabilityPattern",
  steps: [
    {
      expect: [
        {
          path: "sharedAvailability",
          value: ["13:00-14:00", "15:00-16:00"],
        },
        { path: "blockedView", value: [] },
        { path: "freeSlotCount", value: 2 },
        {
          path: "sharedSummary",
          value: "Shared slots: 13:00-14:00, 15:00-16:00",
        },
        { path: "nextAvailableSlot", value: "13:00-14:00" },
        { path: "nextSlotSummary", value: "Next slot: 13:00-14:00" },
        { path: "actionHistory", value: [] },
        { path: "latestChange", value: null },
      ],
    },
    {
      events: [
        {
          stream: "controls.updateAvailability",
          payload: { slot: "13:00-14:00", action: "block" },
        },
      ],
      expect: [
        { path: "sharedAvailability", value: ["15:00-16:00"] },
        { path: "blockedView", value: ["13:00-14:00"] },
        { path: "freeSlotCount", value: 1 },
        { path: "sharedSummary", value: "Shared slots: 15:00-16:00" },
        { path: "nextAvailableSlot", value: "15:00-16:00" },
        { path: "nextSlotSummary", value: "Next slot: 15:00-16:00" },
        {
          path: "actionHistory",
          value: ["blocked 13:00-14:00"],
        },
        {
          path: "latestChange",
          value: { slot: "13:00-14:00", status: "blocked" },
        },
      ],
    },
    {
      events: [
        {
          stream: "controls.updateAvailability",
          payload: { slot: "15:00-16:00", action: "block" },
        },
      ],
      expect: [
        { path: "sharedAvailability", value: [] },
        {
          path: "blockedView",
          value: ["13:00-14:00", "15:00-16:00"],
        },
        { path: "freeSlotCount", value: 0 },
        { path: "sharedSummary", value: "Shared slots: none" },
        { path: "nextAvailableSlot", value: "none" },
        { path: "nextSlotSummary", value: "Next slot: none" },
        {
          path: "actionHistory",
          value: ["blocked 13:00-14:00", "blocked 15:00-16:00"],
        },
        {
          path: "latestChange",
          value: { slot: "15:00-16:00", status: "blocked" },
        },
      ],
    },
    {
      events: [
        {
          stream: "controls.updateAvailability",
          payload: { slot: "13:00-14:00", action: "unblock" },
        },
      ],
      expect: [
        { path: "sharedAvailability", value: ["13:00-14:00"] },
        { path: "blockedView", value: ["15:00-16:00"] },
        { path: "freeSlotCount", value: 1 },
        { path: "sharedSummary", value: "Shared slots: 13:00-14:00" },
        { path: "nextAvailableSlot", value: "13:00-14:00" },
        {
          path: "actionHistory",
          value: [
            "blocked 13:00-14:00",
            "blocked 15:00-16:00",
            "unblocked 13:00-14:00",
          ],
        },
        {
          path: "latestChange",
          value: { slot: "13:00-14:00", status: "unblocked" },
        },
      ],
    },
    {
      events: [
        {
          stream: "controls.updateAvailability",
          payload: { slot: "15:00-16:00", action: "toggle" },
        },
      ],
      expect: [
        {
          path: "sharedAvailability",
          value: ["13:00-14:00", "15:00-16:00"],
        },
        { path: "blockedView", value: [] },
        { path: "freeSlotCount", value: 2 },
        {
          path: "sharedSummary",
          value: "Shared slots: 13:00-14:00, 15:00-16:00",
        },
        { path: "nextAvailableSlot", value: "13:00-14:00" },
        {
          path: "actionHistory",
          value: [
            "blocked 13:00-14:00",
            "blocked 15:00-16:00",
            "unblocked 13:00-14:00",
            "unblocked 15:00-16:00",
          ],
        },
        {
          path: "latestChange",
          value: { slot: "15:00-16:00", status: "unblocked" },
        },
      ],
    },
  ],
};

export const scenarios = [calendarAvailabilityScenario];

describe("calendar-availability", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
