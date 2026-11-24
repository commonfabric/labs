import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const scenarios: PatternIntegrationScenario[] = [
  {
    name: "support triage escalates countdowns by priority",
    module: new URL(
      "./support-ticket-triage.pattern.ts",
      import.meta.url,
    ),
    exportName: "supportTicketTriagePattern",
    steps: [
      {
        expect: [
          {
            path: "tickets",
            value: [
              {
                id: "billing-portal-login",
                subject: "Portal login fails",
                queue: "billing",
                priority: "medium",
                hoursRemaining: 12,
                assignedTo: "Jordan Lee",
              },
              {
                id: "billing-refund-delay",
                subject: "Refund delayed",
                queue: "billing",
                priority: "low",
                hoursRemaining: 24,
                assignedTo: null,
              },
              {
                id: "tech-sync-failure",
                subject: "Background sync failure",
                queue: "technical",
                priority: "high",
                hoursRemaining: 4,
                assignedTo: "Taylor Fox",
              },
              {
                id: "tech-mobile-crash",
                subject: "Mobile app crash on load",
                queue: "technical",
                priority: "medium",
                hoursRemaining: 10,
                assignedTo: null,
              },
            ],
          },
          {
            path: "queueSummaries",
            value: [
              {
                queue: "billing",
                label: "Billing",
                openCount: 2,
                assignedCount: 1,
                unassignedCount: 1,
                criticalCount: 0,
                countdowns: [12, 24],
                nearestHours: 12,
              },
              {
                queue: "technical",
                label: "Technical",
                openCount: 2,
                assignedCount: 1,
                unassignedCount: 1,
                criticalCount: 1,
                countdowns: [4, 10],
                nearestHours: 4,
              },
            ],
          },
          {
            path: "queueAlerts",
            value: [
              "Billing: 12h SLA (stable)",
              "Technical: 4h SLA (1 critical)",
            ],
          },
          {
            path: "summaryLabel",
            value: [
              "Billing next SLA 12h (stable)",
              "Technical next SLA 4h (1 critical)",
            ].join(" | "),
          },
          { path: "backlogSummary", value: "4 open / 2 unassigned" },
          { path: "escalationSummary", value: "Escalations applied: 0" },
          { path: "escalationCount", value: 0 },
          { path: "history", value: [] },
        ],
      },
      {
        events: [
          {
            stream: "controls.triage",
            payload: {
              id: "billing-refund-delay",
              action: "assign",
              assignee: "Morgan Avery",
            },
          },
        ],
        expect: [
          {
            path: "tickets",
            value: [
              {
                id: "billing-portal-login",
                subject: "Portal login fails",
                queue: "billing",
                priority: "medium",
                hoursRemaining: 12,
                assignedTo: "Jordan Lee",
              },
              {
                id: "billing-refund-delay",
                subject: "Refund delayed",
                queue: "billing",
                priority: "low",
                hoursRemaining: 24,
                assignedTo: "Morgan Avery",
              },
              {
                id: "tech-sync-failure",
                subject: "Background sync failure",
                queue: "technical",
                priority: "high",
                hoursRemaining: 4,
                assignedTo: "Taylor Fox",
              },
              {
                id: "tech-mobile-crash",
                subject: "Mobile app crash on load",
                queue: "technical",
                priority: "medium",
                hoursRemaining: 10,
                assignedTo: null,
              },
            ],
          },
          {
            path: "queueSummaries",
            value: [
              {
                queue: "billing",
                label: "Billing",
                openCount: 2,
                assignedCount: 2,
                unassignedCount: 0,
                criticalCount: 0,
                countdowns: [12, 24],
                nearestHours: 12,
              },
              {
                queue: "technical",
                label: "Technical",
                openCount: 2,
                assignedCount: 1,
                unassignedCount: 1,
                criticalCount: 1,
                countdowns: [4, 10],
                nearestHours: 4,
              },
            ],
          },
          {
            path: "queueAlerts",
            value: [
              "Billing: 12h SLA (stable)",
              "Technical: 4h SLA (1 critical)",
            ],
          },
          {
            path: "summaryLabel",
            value: [
              "Billing next SLA 12h (stable)",
              "Technical next SLA 4h (1 critical)",
            ].join(" | "),
          },
          { path: "backlogSummary", value: "4 open / 1 unassigned" },
          { path: "escalationSummary", value: "Escalations applied: 0" },
          { path: "escalationCount", value: 0 },
          {
            path: "history",
            value: [
              "Assigned Morgan Avery to Billing ticket billing-refund-delay",
            ],
          },
        ],
      },
      {
        events: [
          {
            stream: "controls.triage",
            payload: {
              id: "billing-refund-delay",
              action: "escalate",
              priority: "high",
            },
          },
        ],
        expect: [
          {
            path: "tickets",
            value: [
              {
                id: "billing-refund-delay",
                subject: "Refund delayed",
                queue: "billing",
                priority: "high",
                hoursRemaining: 4,
                assignedTo: "Morgan Avery",
              },
              {
                id: "billing-portal-login",
                subject: "Portal login fails",
                queue: "billing",
                priority: "medium",
                hoursRemaining: 12,
                assignedTo: "Jordan Lee",
              },
              {
                id: "tech-sync-failure",
                subject: "Background sync failure",
                queue: "technical",
                priority: "high",
                hoursRemaining: 4,
                assignedTo: "Taylor Fox",
              },
              {
                id: "tech-mobile-crash",
                subject: "Mobile app crash on load",
                queue: "technical",
                priority: "medium",
                hoursRemaining: 10,
                assignedTo: null,
              },
            ],
          },
          {
            path: "queueSummaries",
            value: [
              {
                queue: "billing",
                label: "Billing",
                openCount: 2,
                assignedCount: 2,
                unassignedCount: 0,
                criticalCount: 1,
                countdowns: [4, 12],
                nearestHours: 4,
              },
              {
                queue: "technical",
                label: "Technical",
                openCount: 2,
                assignedCount: 1,
                unassignedCount: 1,
                criticalCount: 1,
                countdowns: [4, 10],
                nearestHours: 4,
              },
            ],
          },
          {
            path: "queueAlerts",
            value: [
              "Billing: 4h SLA (1 critical)",
              "Technical: 4h SLA (1 critical)",
            ],
          },
          {
            path: "summaryLabel",
            value: [
              "Billing next SLA 4h (1 critical)",
              "Technical next SLA 4h (1 critical)",
            ].join(" | "),
          },
          { path: "backlogSummary", value: "4 open / 1 unassigned" },
          { path: "escalationSummary", value: "Escalations applied: 1" },
          { path: "escalationCount", value: 1 },
          {
            path: "history",
            value: [
              "Assigned Morgan Avery to Billing ticket billing-refund-delay",
              "Escalated Billing ticket billing-refund-delay to High (4h SLA)",
            ],
          },
        ],
      },
    ],
  },
];

describe("support-ticket-triage", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
