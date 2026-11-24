import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

type WorkflowStage =
  | "draft"
  | "in_review"
  | "approved"
  | "scheduled"
  | "published"
  | "archived";

type WorkflowArgs = {
  stage?: WorkflowStage;
};

export const workflowStateMachineScenario: PatternIntegrationScenario<
  WorkflowArgs
> = {
  name: "workflow state machine enforces allowed transitions",
  module: new URL(
    "./workflow-state-machine.pattern.ts",
    import.meta.url,
  ),
  exportName: "workflowStateMachine",
  steps: [
    {
      expect: [
        { path: "stage", value: "draft" },
        { path: "stageIndex", value: 0 },
        { path: "availableLabel", value: "in_review" },
        { path: "availableTransitions.0", value: "in_review" },
        { path: "history.length", value: 0 },
        { path: "attemptCount", value: 0 },
        { path: "acceptedCount", value: 0 },
        { path: "rejectedCount", value: 0 },
        { path: "lastTransitionStatus", value: "none" },
        {
          path: "summary",
          value: "stage:draft attempts:0 accepted:0 rejected:0",
        },
        { path: "stageMetadata.0.stage", value: "draft" },
        { path: "stageMetadata.0.isCurrent", value: true },
        { path: "stageMetadata.1.isReachable", value: true },
      ],
    },
    {
      events: [
        { stream: "transition", payload: { target: "published" } },
      ],
      expect: [
        { path: "stage", value: "draft" },
        { path: "attemptCount", value: 1 },
        { path: "acceptedCount", value: 0 },
        { path: "rejectedCount", value: 1 },
        { path: "history.length", value: 1 },
        { path: "history.0.result", value: "rejected" },
        { path: "history.0.reason", value: "not-allowed" },
        { path: "history.0.from", value: "draft" },
        { path: "history.0.to", value: "published" },
        {
          path: "history.0.note",
          value: "reject:draft->published",
        },
        {
          path: "lastTransitionStatus",
          value: "rejected:draft->published",
        },
        {
          path: "summary",
          value: "stage:draft attempts:1 accepted:0 rejected:1",
        },
      ],
    },
    {
      events: [
        { stream: "transition", payload: {} },
      ],
      expect: [
        { path: "stage", value: "draft" },
        { path: "attemptCount", value: 2 },
        { path: "acceptedCount", value: 0 },
        { path: "rejectedCount", value: 2 },
        { path: "history.length", value: 2 },
        { path: "history.1.result", value: "rejected" },
        { path: "history.1.reason", value: "invalid-target" },
        { path: "history.1.note", value: "reject:draft->invalid" },
        {
          path: "lastTransitionStatus",
          value: "rejected:draft->draft",
        },
        {
          path: "summary",
          value: "stage:draft attempts:2 accepted:0 rejected:2",
        },
      ],
    },
    {
      events: [
        {
          stream: "transition",
          payload: { target: "in_review", note: "submit" },
        },
      ],
      expect: [
        { path: "stage", value: "in_review" },
        { path: "stageIndex", value: 1 },
        { path: "attemptCount", value: 3 },
        { path: "acceptedCount", value: 1 },
        { path: "rejectedCount", value: 2 },
        { path: "history.length", value: 3 },
        { path: "history.2.result", value: "accepted" },
        { path: "history.2.note", value: "submit" },
        { path: "history.2.reason", value: "transition" },
        { path: "history.2.from", value: "draft" },
        { path: "history.2.to", value: "in_review" },
        { path: "availableLabel", value: "draft,approved" },
        { path: "lastTransitionStatus", value: "accepted:draft->in_review" },
        {
          path: "summary",
          value: "stage:in_review attempts:3 accepted:1 rejected:2",
        },
      ],
    },
    {
      events: [
        { stream: "transition", payload: { target: "in_review" } },
      ],
      expect: [
        { path: "stage", value: "in_review" },
        { path: "attemptCount", value: 4 },
        { path: "acceptedCount", value: 1 },
        { path: "rejectedCount", value: 3 },
        { path: "history.length", value: 4 },
        { path: "history.3.reason", value: "no-op" },
        { path: "history.3.note", value: "reject:in_review->in_review" },
        {
          path: "lastTransitionStatus",
          value: "rejected:in_review->in_review",
        },
        {
          path: "summary",
          value: "stage:in_review attempts:4 accepted:1 rejected:3",
        },
      ],
    },
    {
      events: [
        {
          stream: "transition",
          payload: { target: "draft", note: "rework" },
        },
      ],
      expect: [
        { path: "stage", value: "draft" },
        { path: "stageIndex", value: 0 },
        { path: "attemptCount", value: 5 },
        { path: "acceptedCount", value: 2 },
        { path: "rejectedCount", value: 3 },
        { path: "history.length", value: 5 },
        { path: "history.4.result", value: "accepted" },
        { path: "history.4.note", value: "rework" },
        { path: "history.4.reason", value: "transition" },
        { path: "history.4.from", value: "in_review" },
        { path: "history.4.to", value: "draft" },
        { path: "availableLabel", value: "in_review" },
        {
          path: "lastTransitionStatus",
          value: "accepted:in_review->draft",
        },
        {
          path: "summary",
          value: "stage:draft attempts:5 accepted:2 rejected:3",
        },
      ],
    },
  ],
};

export const scenarios = [workflowStateMachineScenario];

describe("workflow-state-machine", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
