import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const procurementRequestScenario: PatternIntegrationScenario = {
  name: "procurement request updates spending summary as approvals change",
  module: new URL("./procurement-request.pattern.ts", import.meta.url),
  exportName: "procurementRequest",
  steps: [
    {
      expect: [
        { path: "requestList.0.id", value: "monitor-upgrade" },
        { path: "requestList.0.status", value: "routing" },
        { path: "requestList.0.stages.0.status", value: "approved" },
        { path: "requestList.0.stages.1.status", value: "pending" },
        { path: "requestList.1.id", value: "ergonomic-chairs" },
        { path: "requestList.1.status", value: "routing" },
        { path: "requestList.2.status", value: "approved" },
        { path: "totals.requested", value: 7450 },
        { path: "totals.routing", value: 5050 },
        { path: "totals.approved", value: 2400 },
        { path: "totals.rejected", value: 0 },
        { path: "counts.routing", value: 2 },
        { path: "counts.approved", value: 1 },
        { path: "counts.rejected", value: 0 },
        {
          path: "summaryLine",
          value: "3 requests: 2 routing (USD 5050.00), " +
            "1 approved (USD 2400.00), 0 rejected (USD 0.00)",
        },
        { path: "stageHeadline", value: "2 requests awaiting review" },
        { path: "departmentTotals.0.department", value: "Engineering" },
        { path: "departmentTotals.0.routing", value: 3200 },
        { path: "departmentTotals.2.approved", value: 2400 },
        { path: "routingAssignments.0.id", value: "ergonomic-chairs" },
        { path: "routingAssignments.0.stage", value: "Department Review" },
        { path: "routingAssignments.1.id", value: "monitor-upgrade" },
        { path: "routingAssignments.1.stage", value: "Procurement Desk" },
        { path: "activityLog.0", value: "1. Procurement queue initialized" },
      ],
    },
    {
      events: [
        {
          stream: "recordDecision",
          payload: {
            id: "monitor-upgrade",
            stage: "procurement",
            decision: "approved",
          },
        },
      ],
      expect: [
        { path: "requestList.0.stages.1.status", value: "approved" },
        { path: "requestList.0.status", value: "routing" },
        { path: "totals.routing", value: 5050 },
        { path: "routingAssignments.1.stage", value: "Finance Approval" },
        {
          path: "activityLog.1",
          value:
            "2. Approved Procurement Desk for monitor-upgrade (Ariana Flores)",
        },
      ],
    },
    {
      events: [
        {
          stream: "recordDecision",
          payload: {
            id: "monitor-upgrade",
            stage: "finance",
            decision: "approved",
          },
        },
      ],
      expect: [
        { path: "requestList.0.status", value: "approved" },
        { path: "counts.routing", value: 1 },
        { path: "totals.routing", value: 1850 },
        { path: "totals.approved", value: 5600 },
        {
          path: "summaryLine",
          value: "3 requests: 1 routing (USD 1850.00), " +
            "2 approved (USD 5600.00), 0 rejected (USD 0.00)",
        },
        { path: "routingAssignments.length", value: 1 },
        { path: "departmentTotals.0.approved", value: 3200 },
        {
          path: "activityLog.2",
          value: "3. Completed approval for Display Hub " +
            "(monitor-upgrade) USD 3200.00",
        },
      ],
    },
    {
      events: [
        {
          stream: "recordDecision",
          payload: {
            id: "ergonomic-chairs",
            stage: "department",
            decision: "approved",
          },
        },
      ],
      expect: [
        { path: "requestList.1.stages.0.status", value: "approved" },
        { path: "requestList.1.status", value: "routing" },
        { path: "totals.routing", value: 1850 },
        { path: "routingAssignments.0.stage", value: "Procurement Desk" },
        {
          path: "activityLog.3",
          value:
            "4. Approved Department Review for ergonomic-chairs (Jamie Lynn)",
        },
      ],
    },
    {
      events: [
        {
          stream: "recordDecision",
          payload: {
            id: "ergonomic-chairs",
            stage: "procurement",
            decision: "rejected",
          },
        },
      ],
      expect: [
        { path: "requestList.1.status", value: "rejected" },
        { path: "requestList.1.stages.1.status", value: "rejected" },
        { path: "totals.routing", value: 0 },
        { path: "totals.rejected", value: 1850 },
        { path: "counts.rejected", value: 1 },
        { path: "routingAssignments", value: [] },
        {
          path: "summaryLine",
          value: "3 requests: 0 routing (USD 0.00), " +
            "2 approved (USD 5600.00), 1 rejected (USD 1850.00)",
        },
        {
          path: "activityLog.4",
          value:
            "5. Rejected ergonomic-chairs at Procurement Desk (USD 1850.00)",
        },
      ],
    },
    {
      events: [
        {
          stream: "rerouteStage",
          payload: {
            id: "ergonomic-chairs",
            stage: "procurement",
            approver: "Taylor Reed",
          },
        },
      ],
      expect: [
        { path: "requestList.1.status", value: "routing" },
        { path: "requestList.1.stages.1.status", value: "pending" },
        { path: "requestList.1.stages.1.approver", value: "Taylor Reed" },
        { path: "totals.routing", value: 1850 },
        { path: "totals.rejected", value: 0 },
        {
          path: "summaryLine",
          value: "3 requests: 1 routing (USD 1850.00), " +
            "2 approved (USD 5600.00), 0 rejected (USD 0.00)",
        },
        {
          path: "routingAssignments.0.approver",
          value: "Taylor Reed",
        },
        {
          path: "activityLog.5",
          value: "6. Rerouted ergonomic-chairs to Taylor Reed " +
            "for Procurement Desk (USD 1850.00)",
        },
      ],
    },
  ],
};

export const scenarios = [procurementRequestScenario];

describe("procurement-request", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
