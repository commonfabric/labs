import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const contentPublishingWorkflowScenario: PatternIntegrationScenario = {
  name: "content publishing workflow orders queue by priority and schedule",
  module: new URL(
    "./content-publishing-workflow.pattern.ts",
    import.meta.url,
  ),
  exportName: "contentPublishingWorkflow",
  steps: [
    {
      expect: [
        { path: "nextDraft.id", value: "draft-launch-announcement" },
        { path: "queue.0.title", value: "Launch Announcement" },
        { path: "queue.1.title", value: "Finch Story" },
        { path: "queue.2.title", value: "Quarterly Recap" },
        {
          path: "queuePreview",
          value:
            "Launch Announcement (high @ 2024-07-02) | Finch Story (medium @ 2024-07-04) | Quarterly Recap (medium @ 2024-07-06)",
        },
        { path: "statusLine", value: "3 drafts awaiting, 0 scheduled" },
        { path: "stageTotals.review", value: 1 },
        { path: "stageTotals.ready", value: 1 },
        { path: "stageTotals.drafting", value: 1 },
        { path: "activityLog.0", value: "Workflow initialized" },
      ],
    },
    {
      events: [
        {
          stream: "addDraft",
          payload: {
            title: "Changelog Draft",
            summary: "Release log for version 1.12.",
            priority: "high",
            stage: "drafting",
            scheduledDate: "2024-07-03",
            assignedEditor: "Lena",
          },
        },
      ],
      expect: [
        { path: "queue.1.title", value: "Changelog Draft" },
        {
          path: "queuePreview",
          value:
            "Launch Announcement (high @ 2024-07-02) | Changelog Draft (high @ 2024-07-03) | Finch Story (medium @ 2024-07-04)",
        },
        { path: "statusLine", value: "4 drafts awaiting, 0 scheduled" },
        {
          path: "activityLog.1",
          value: "Changelog Draft queued as high priority due 2024-07-03",
        },
      ],
    },
    {
      events: [
        {
          stream: "rescheduleDraft",
          payload: {
            id: "draft-launch-announcement",
            scheduledDate: "2024-07-05",
          },
        },
      ],
      expect: [
        {
          path: "queuePreview",
          value:
            "Changelog Draft (high @ 2024-07-03) | Launch Announcement (high @ 2024-07-05) | Finch Story (medium @ 2024-07-04)",
        },
        {
          path: "priorityScheduleOrder.0.title",
          value: "Changelog Draft",
        },
        {
          path: "priorityScheduleOrder.1.title",
          value: "Launch Announcement",
        },
        {
          path: "priorityScheduleOrder.1.scheduledDate",
          value: "2024-07-05",
        },
        {
          path: "priorityScheduleOrder.2.title",
          value: "Finch Story",
        },
        {
          path: "activityLog.2",
          value: "Launch Announcement rescheduled for 2024-07-05",
        },
      ],
    },
    {
      events: [
        {
          stream: "reprioritizeDraft",
          payload: {
            id: "draft-quarterly-recap",
            priority: "low",
          },
        },
      ],
      expect: [
        { path: "queue.3.priority", value: "low" },
        {
          path: "activityLog.3",
          value: "Quarterly Recap reprioritized to low",
        },
        { path: "statusLine", value: "4 drafts awaiting, 0 scheduled" },
      ],
    },
    {
      events: [
        {
          stream: "advanceStage",
          payload: { id: "draft-customer-story", stage: "scheduled" },
        },
      ],
      expect: [
        {
          path: "queuePreview",
          value:
            "Changelog Draft (high @ 2024-07-03) | Launch Announcement (high @ 2024-07-05) | Quarterly Recap (low @ 2024-07-06)",
        },
        { path: "statusLine", value: "3 drafts awaiting, 1 scheduled" },
        { path: "stageTotals.scheduled", value: 1 },
        {
          path: "activityLog",
          value: [
            "Workflow initialized",
            "Changelog Draft queued as high priority due 2024-07-03",
            "Launch Announcement rescheduled for 2024-07-05",
            "Quarterly Recap reprioritized to low",
            "Finch Story moved to scheduled",
          ],
        },
        { path: "nextDraft.title", value: "Changelog Draft" },
      ],
    },
  ],
};

export const scenarios = [contentPublishingWorkflowScenario];

describe("content-publishing-workflow", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
