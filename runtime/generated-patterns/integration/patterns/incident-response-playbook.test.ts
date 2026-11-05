import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const incidentResponsePlaybookScenario: PatternIntegrationScenario<
  {
    steps?: Array<
      {
        id?: string;
        title?: string;
        owner?: string;
        status?: "pending" | "in_progress" | "blocked" | "complete";
        expectedMinutes?: number;
        elapsedMinutes?: number;
      }
    >;
  }
> = {
  name: "incident response playbook escalates stalled steps",
  module: new URL(
    "./incident-response-playbook.pattern.ts",
    import.meta.url,
  ),
  exportName: "incidentResponsePlaybook",
  steps: [
    {
      expect: [
        { path: "steps.0.id", value: "triage" },
        { path: "steps.0.status", value: "pending" },
        { path: "summary.pending", value: 3 },
        { path: "summary.inProgress", value: 0 },
        {
          path: "statusLabel",
          value: "Pending 3 | Active 0 | Blocked 0 | Done 0",
        },
        { path: "needsEscalation", value: false },
        { path: "escalationLabel", value: "Escalation clear (0)" },
        { path: "activeStepId", value: "" },
        { path: "activeStepTitle", value: "idle" },
        { path: "latestLogEntry", value: "ready" },
        { path: "clockMinutes", value: 0 },
      ],
    },
    {
      events: [
        {
          stream: "handlers.start",
          payload: { stepId: "triage" },
        },
      ],
      expect: [
        { path: "steps.0.status", value: "in_progress" },
        { path: "summary.pending", value: 2 },
        { path: "summary.inProgress", value: 1 },
        { path: "activeStepId", value: "triage" },
        { path: "activeStepTitle", value: "Triage incident" },
        { path: "timeline.0", value: "Started triage" },
        { path: "latestLogEntry", value: "Started triage" },
        {
          path: "statusLabel",
          value: "Pending 2 | Active 1 | Blocked 0 | Done 0",
        },
      ],
    },
    {
      events: [
        {
          stream: "handlers.logElapsed",
          payload: { minutes: 30 },
        },
      ],
      expect: [
        { path: "steps.0.elapsedMinutes", value: 30 },
        { path: "clockMinutes", value: 30 },
        { path: "timeline.1", value: "Logged 30m on triage" },
        { path: "latestLogEntry", value: "Logged 30m on triage" },
        { path: "needsEscalation", value: true },
        { path: "stalledSteps.0", value: "triage" },
        { path: "stalledCount", value: 1 },
        { path: "escalationLabel", value: "Escalation required (1)" },
      ],
    },
    {
      events: [
        {
          stream: "handlers.updateStatus",
          payload: { status: "complete", minutes: 5 },
        },
      ],
      expect: [
        { path: "steps.0.status", value: "complete" },
        { path: "summary.done", value: 1 },
        { path: "summary.inProgress", value: 0 },
        { path: "activeStepId", value: "" },
        { path: "activeStepTitle", value: "idle" },
        { path: "needsEscalation", value: false },
        { path: "stalledSteps", value: [] },
        { path: "stalledCount", value: 0 },
        { path: "escalationLabel", value: "Escalation clear (0)" },
        { path: "timeline.2", value: "Marked triage as complete" },
        { path: "latestLogEntry", value: "Marked triage as complete" },
        {
          path: "statusLabel",
          value: "Pending 2 | Active 0 | Blocked 0 | Done 1",
        },
      ],
    },
    {
      events: [{ stream: "handlers.reset", payload: {} }],
      expect: [
        { path: "steps.0.status", value: "pending" },
        { path: "summary.pending", value: 3 },
        { path: "summary.done", value: 0 },
        { path: "timeline", value: [] },
        { path: "latestLogEntry", value: "ready" },
        { path: "clockMinutes", value: 0 },
        {
          path: "statusLabel",
          value: "Pending 3 | Active 0 | Blocked 0 | Done 0",
        },
      ],
    },
  ],
};

export const scenarios = [incidentResponsePlaybookScenario];

describe("incident-response-playbook", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
