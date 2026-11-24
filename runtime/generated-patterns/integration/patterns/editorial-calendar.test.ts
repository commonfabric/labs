import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const editorialCalendarScenario: PatternIntegrationScenario<
  { entries?: unknown; channels?: unknown }
> = {
  name: "editorial calendar groups schedule by channel",
  module: new URL("./editorial-calendar.pattern.ts", import.meta.url),
  exportName: "editorialCalendar",
  steps: [
    {
      expect: [
        { path: "channelList", value: ["Blog", "Newsletter", "Podcast"] },
        { path: "channelSchedule.0.channel", value: "Blog" },
        { path: "channelSchedule.0.entries.0.title", value: "Weekly Roundup" },
        {
          path: "channelSchedule.0.entries.0.publishDate",
          value: "2024-07-08",
        },
        { path: "channelSchedule.1.channel", value: "Newsletter" },
        { path: "channelSchedule.2.channel", value: "Podcast" },
        { path: "channelCounts.0.count", value: 1 },
        { path: "channelCounts.1.count", value: 1 },
        { path: "channelCounts.2.count", value: 1 },
        {
          path: "summaryLabel",
          value:
            "3 channels, 3 scheduled, next Weekly Roundup (Blog) on 2024-07-08",
        },
        { path: "nextPublish.title", value: "Weekly Roundup" },
        { path: "nextPublish.channel", value: "Blog" },
        { path: "history.0", value: "Calendar initialized" },
        { path: "latestActivity", value: "Calendar initialized" },
      ],
    },
    {
      events: [{ stream: "defineChannel", payload: { channel: "Social" } }],
      expect: [
        {
          path: "channelList",
          value: ["Blog", "Newsletter", "Podcast", "Social"],
        },
        { path: "channelSchedule.3.channel", value: "Social" },
        { path: "channelSchedule.3.entries", value: [] },
        { path: "channelCounts.3.count", value: 0 },
        {
          path: "summaryLabel",
          value:
            "4 channels, 3 scheduled, next Weekly Roundup (Blog) on 2024-07-08",
        },
        { path: "history.1", value: "Added channel Social" },
        { path: "latestActivity", value: "Added channel Social" },
      ],
    },
    {
      events: [
        {
          stream: "planPublication",
          payload: {
            title: "Launch Teaser",
            channel: "Social",
            publishDate: "2024-07-16",
            summary: "Social announcement teaser.",
          },
        },
      ],
      expect: [
        { path: "channelCounts.3.count", value: 1 },
        { path: "channelSchedule.3.entries.0.title", value: "Launch Teaser" },
        {
          path: "channelSchedule.3.entries.0.publishDate",
          value: "2024-07-16",
        },
        {
          path: "summaryLabel",
          value:
            "4 channels, 4 scheduled, next Weekly Roundup (Blog) on 2024-07-08",
        },
        { path: "history.2", value: "Calendar sanitized" },
        {
          path: "history.3",
          value: "Scheduled Launch Teaser in Social for 2024-07-16",
        },
        {
          path: "latestActivity",
          value: "Scheduled Launch Teaser in Social for 2024-07-16",
        },
      ],
    },
    {
      events: [
        {
          stream: "planPublication",
          payload: {
            id: "blog-weekly-roundup-20240708",
            channel: "Social",
            publishDate: "2024-07-15",
          },
        },
      ],
      expect: [
        { path: "channelCounts.0.count", value: 0 },
        { path: "channelCounts.3.count", value: 2 },
        { path: "channelSchedule.3.entries.0.title", value: "Weekly Roundup" },
        {
          path: "channelSchedule.3.entries.0.publishDate",
          value: "2024-07-15",
        },
        { path: "channelSchedule.3.entries.1.title", value: "Launch Teaser" },
        {
          path: "channelSchedule.3.entries.1.publishDate",
          value: "2024-07-16",
        },
        {
          path: "summaryLabel",
          value:
            "4 channels, 4 scheduled, next Product Update (Newsletter) on " +
            "2024-07-10",
        },
        { path: "nextPublish.title", value: "Product Update" },
        { path: "nextPublish.channel", value: "Newsletter" },
        { path: "history.4", value: "Calendar sanitized" },
        {
          path: "history.5",
          value: "Updated Weekly Roundup to Social on 2024-07-15",
        },
        {
          path: "latestActivity",
          value: "Updated Weekly Roundup to Social on 2024-07-15",
        },
      ],
    },
  ],
};

export const scenarios = [editorialCalendarScenario];

describe("editorial-calendar", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
