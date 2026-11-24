import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";
import type {
  CategorySummary,
  ComplianceChecklistArgs,
  ComplianceGap,
} from "./compliance-checklist.pattern.ts";

const complianceChecklistScenario: PatternIntegrationScenario<
  Partial<ComplianceChecklistArgs>
> = {
  name: "compliance checklist tracks coverage gaps",
  module: new URL("./compliance-checklist.pattern.ts", import.meta.url),
  exportName: "complianceChecklist",
  steps: [
    {
      expect: [
        { path: "coveragePercent", value: 33 },
        { path: "gapCount", value: 2 },
        { path: "complianceState", value: "Non-Compliant" },
        {
          path: "statusLabel",
          value: "33% coverage (Non-Compliant) with 2 gaps",
        },
        {
          path: "mandatorySummary",
          value: { total: 3, satisfied: 1 },
        },
        {
          path: "gapTasks",
          value: [
            {
              id: "access-review",
              label: "Access Review Audit",
              category: "Audit",
              owner: "Jordan Lee",
              status: "in_progress",
              mandatory: true,
            },
            {
              id: "security-awareness",
              label: "Security Awareness Training",
              category: "Training",
              owner: null,
              status: "pending",
              mandatory: true,
            },
          ] satisfies ComplianceGap[],
        },
        {
          path: "categories",
          value: [
            {
              category: "Audit",
              total: 1,
              mandatory: 1,
              satisfied: 0,
              outstanding: 1,
              coverage: 0,
              label: "Audit: 0/1 mandatory complete (1 outstanding)",
            },
            {
              category: "Policy",
              total: 1,
              mandatory: 1,
              satisfied: 1,
              outstanding: 0,
              coverage: 100,
              label: "Policy: 1/1 mandatory complete",
            },
            {
              category: "Third-Party",
              total: 1,
              mandatory: 0,
              satisfied: 0,
              outstanding: 0,
              coverage: 100,
              label: "Third-Party: no mandatory tasks",
            },
            {
              category: "Training",
              total: 1,
              mandatory: 1,
              satisfied: 0,
              outstanding: 1,
              coverage: 0,
              label: "Training: 0/1 mandatory complete (1 outstanding)",
            },
          ] satisfies CategorySummary[],
        },
        { path: "auditTrail", value: [] },
      ],
    },
    {
      events: [
        {
          stream: "updateTask",
          payload: {
            id: "security-awareness",
            status: "complete",
            owner: "morgan diaz",
          },
        },
      ],
      expect: [
        { path: "tasks.3.status", value: "complete" },
        { path: "coveragePercent", value: 67 },
        { path: "gapCount", value: 1 },
        { path: "complianceState", value: "At Risk" },
        {
          path: "statusLabel",
          value: "67% coverage (At Risk) with 1 gap",
        },
        {
          path: "mandatorySummary",
          value: { total: 3, satisfied: 2 },
        },
        {
          path: "gapTasks",
          value: [
            {
              id: "access-review",
              label: "Access Review Audit",
              category: "Audit",
              owner: "Jordan Lee",
              status: "in_progress",
              mandatory: true,
            },
          ] satisfies ComplianceGap[],
        },
        {
          path: "auditTrail",
          value: [
            "Security Awareness Training: status Complete | owner Morgan Diaz",
          ],
        },
      ],
    },
    {
      events: [
        {
          stream: "updateTask",
          payload: {
            taskId: "access-review",
            status: "waived",
            note: "Risk accepted by leadership",
          },
        },
      ],
      expect: [
        { path: "coveragePercent", value: 100 },
        { path: "gapCount", value: 0 },
        { path: "complianceState", value: "Compliant" },
        {
          path: "statusLabel",
          value: "100% coverage (Compliant) with 0 gaps",
        },
        {
          path: "mandatorySummary",
          value: { total: 3, satisfied: 3 },
        },
        { path: "gapTasks", value: [] },
        {
          path: "auditTrail",
          value: [
            "Security Awareness Training: status Complete | owner Morgan Diaz",
            "Access Review Audit: status Waived | evidence recorded",
          ],
        },
      ],
    },
  ],
};

export const scenarios = [complianceChecklistScenario];

describe("compliance-checklist", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
