import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const expenseReimbursementScenario: PatternIntegrationScenario = {
  name: "expense reimbursements update statuses and totals",
  module: new URL(
    "./expense-reimbursement.pattern.ts",
    import.meta.url,
  ),
  exportName: "expenseReimbursement",
  steps: [
    {
      expect: [
        { path: "claimList.0.id", value: "travel-001" },
        { path: "claimList.0.status", value: "submitted" },
        { path: "claimList.1.status", value: "submitted" },
        { path: "claimList.2.status", value: "approved" },
        { path: "claimList.3.status", value: "paid" },
        { path: "totals.totalRequested", value: 547.15 },
        { path: "totals.submitted", value: 278.65 },
        { path: "totals.approved", value: 48.5 },
        { path: "totals.paid", value: 220 },
        { path: "totals.pendingPayment", value: 48.5 },
        {
          path: "summaryLabel",
          value:
            "Recorded $547.15 in claims; reimbursed $220.00; pending $48.50.",
        },
        { path: "statusHeadline", value: "4 claims ready for review" },
        { path: "latestAction", value: "Reimbursement tracker initialized" },
        { path: "activityLog", value: ["Reimbursement tracker initialized"] },
      ],
    },
    {
      events: [{ stream: "approveClaim", payload: { id: "travel-001" } }],
      expect: [
        { path: "claimList.0.status", value: "approved" },
        { path: "totals.submitted", value: 92.4 },
        { path: "approvedTotal", value: 234.75 },
        { path: "pendingPayment", value: 234.75 },
        {
          path: "summaryLabel",
          value:
            "Recorded $547.15 in claims; reimbursed $220.00; pending $234.75.",
        },
        {
          path: "activityLog",
          value: [
            "Reimbursement tracker initialized",
            "Approved travel-001 for Avery ($186.25)",
          ],
        },
        {
          path: "latestAction",
          value: "Approved travel-001 for Avery ($186.25)",
        },
      ],
    },
    {
      events: [{ stream: "recordPayment", payload: { id: "travel-001" } }],
      expect: [
        { path: "claimList.0.status", value: "paid" },
        { path: "totals.paid", value: 406.25 },
        { path: "pendingPayment", value: 48.5 },
        {
          path: "summaryLabel",
          value:
            "Recorded $547.15 in claims; reimbursed $406.25; pending $48.50.",
        },
        {
          path: "activityLog",
          value: [
            "Reimbursement tracker initialized",
            "Approved travel-001 for Avery ($186.25)",
            "Recorded payment for travel-001 ($186.25)",
          ],
        },
        {
          path: "latestAction",
          value: "Recorded payment for travel-001 ($186.25)",
        },
      ],
    },
    {
      events: [{ stream: "rejectClaim", payload: { id: "supplies-002" } }],
      expect: [
        { path: "claimList.1.status", value: "rejected" },
        { path: "submittedTotal", value: 0 },
        { path: "totals.rejected", value: 92.4 },
        { path: "pendingPayment", value: 48.5 },
        {
          path: "summaryLabel",
          value:
            "Recorded $547.15 in claims; reimbursed $406.25; pending $48.50.",
        },
        {
          path: "activityLog",
          value: [
            "Reimbursement tracker initialized",
            "Approved travel-001 for Avery ($186.25)",
            "Recorded payment for travel-001 ($186.25)",
            "Rejected supplies-002 for Briar ($92.40)",
          ],
        },
        {
          path: "latestAction",
          value: "Rejected supplies-002 for Briar ($92.40)",
        },
      ],
    },
  ],
};

export const scenarios = [expenseReimbursementScenario];

describe("expense-reimbursement", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
