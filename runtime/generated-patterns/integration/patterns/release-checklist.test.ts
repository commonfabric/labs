import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

type ReleaseChecklistArgument = {
  tasks?: Array<{
    id?: string;
    label?: string;
    required?: boolean;
    status?: string;
    owner?: string | null;
    note?: string | null;
  }>;
};

export const releaseChecklistScenario: PatternIntegrationScenario<
  ReleaseChecklistArgument
> = {
  name: "release checklist gates readiness",
  module: new URL("./release-checklist.pattern.ts", import.meta.url),
  exportName: "releaseChecklist",
  argument: {
    tasks: [
      {
        id: "qa-signoff",
        label: "QA Sign-off",
        required: true,
        status: "in_progress",
        owner: "Sam Reed",
        note: null,
      },
      {
        id: "docs",
        label: "Documentation Updated",
        required: true,
        status: "pending",
        owner: "Avery Fox",
        note: null,
      },
      {
        id: "ops-runbook",
        label: "Operations Runbook",
        required: true,
        status: "done",
        owner: "Taylor Young",
        note: null,
      },
      {
        id: "marketing-check",
        label: "Marketing Review",
        required: false,
        status: "pending",
        owner: null,
        note: null,
      },
    ],
  },
  steps: [
    {
      expect: [
        { path: "ready", value: false },
        { path: "status", value: "pending" },
        { path: "summary", value: "1/3 required complete" },
        { path: "headline", value: "PENDING • 1/4 tasks done" },
        {
          path: "gatingNote",
          value: "Pending: Documentation Updated, QA Sign-off",
        },
        {
          path: "remainingRequired",
          value: ["Documentation Updated", "QA Sign-off"],
        },
        { path: "blocked", value: [] },
        { path: "blockedCount", value: 0 },
        { path: "tasks.0.status", value: "pending" },
        { path: "tasks.1.status", value: "done" },
        { path: "tasks.2.status", value: "in_progress" },
        { path: "tasks.3.status", value: "pending" },
      ],
    },
    {
      events: [{
        stream: "updateTask",
        payload: { id: "qa-signoff", status: "done" },
      }],
      expect: [
        { path: "ready", value: false },
        { path: "status", value: "pending" },
        { path: "summary", value: "2/3 required complete" },
        { path: "headline", value: "PENDING • 2/4 tasks done" },
        { path: "blocked", value: [] },
        { path: "remainingRequired", value: ["Documentation Updated"] },
      ],
    },
    {
      events: [{
        stream: "updateTask",
        payload: { id: "docs", status: "done" },
      }],
      expect: [
        { path: "ready", value: true },
        { path: "status", value: "ready" },
        { path: "summary", value: "3/3 required complete" },
        { path: "headline", value: "READY • 3/4 tasks done" },
        { path: "blocked", value: [] },
        { path: "remainingRequired", value: [] },
        { path: "gatingNote", value: "All checks complete" },
      ],
    },
    {
      events: [{
        stream: "updateTask",
        payload: { id: "marketing-check", status: "blocked" },
      }],
      expect: [
        { path: "ready", value: false },
        { path: "status", value: "blocked" },
        { path: "summary", value: "3/3 required complete" },
        { path: "headline", value: "BLOCKED • 3/4 tasks done" },
        { path: "blocked", value: ["Marketing Review"] },
        { path: "blockedCount", value: 1 },
        { path: "remainingRequired", value: [] },
        {
          path: "gatingNote",
          value: "Blocked: Marketing Review",
        },
      ],
    },
  ],
};

export const scenarios = [releaseChecklistScenario];

describe("release-checklist", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
