import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const studentAttendanceTrackerScenario: PatternIntegrationScenario<
  { roster?: Array<Record<string, unknown>> }
> = {
  name: "student attendance tracker highlights absences per session",
  module: new URL("./student-attendance-tracker.pattern.ts", import.meta.url),
  exportName: "studentAttendanceTrackerPattern",
  argument: {
    roster: [
      { id: "stu-alex", name: "Alex Morgan" },
      { id: "stu-blair", name: "Blair Nguyen" },
      { id: "stu-cody", name: "Cody Patel" },
    ],
  },
  steps: [
    {
      expect: [
        { path: "roster.0.id", value: "stu-alex" },
        { path: "roster.1.name", value: "Blair Nguyen" },
        { path: "attendanceLog", value: [] },
        { path: "sessionSummaries", value: [] },
        { path: "sessionAbsenceLabels", value: [] },
        { path: "latestSummary", value: null },
        { path: "absenceSummaryLabel", value: "0 absences across 0 sessions" },
      ],
    },
    {
      events: [
        {
          stream: "recordAttendance",
          payload: {
            sessionId: "2024-09-03",
            date: "2024-09-03",
            topic: "Orientation",
            attendance: [
              { studentId: "stu-alex", status: "present" },
              { studentId: "stu-blair", status: "present" },
            ],
          },
        },
      ],
      expect: [
        { path: "attendanceLog.0.sessionId", value: "2024-09-03" },
        { path: "attendanceLog.0.absentIds", value: ["stu-cody"] },
        { path: "sessionSummaries.0.absentCount", value: 1 },
        { path: "sessionSummaries.0.presentCount", value: 2 },
        {
          path: "sessionSummaries.0.absentStudents.0.name",
          value: "Cody Patel",
        },
        {
          path: "sessionAbsenceLabels.0",
          value: "2024-09-03 Orientation: 1 absence (Cody Patel)",
        },
        { path: "absenceSummaryLabel", value: "1 absence across 1 session" },
        { path: "latestSummary.topic", value: "Orientation" },
      ],
    },
    {
      events: [
        {
          stream: "recordAttendance",
          payload: {
            sessionId: "2024-09-04",
            date: "2024-09-04",
            topic: "Lab Prep",
            attendance: [
              { studentId: "stu-alex", status: "absent" },
              { studentId: "stu-blair", status: "present" },
              { studentId: "stu-cody", status: "present" },
            ],
          },
        },
      ],
      expect: [
        { path: "sessionSummaries.1.sessionId", value: "2024-09-04" },
        { path: "sessionSummaries.1.absentCount", value: 1 },
        { path: "sessionSummaries.1.absentStudents.0.id", value: "stu-alex" },
        {
          path: "sessionAbsenceLabels.1",
          value: "2024-09-04 Lab Prep: 1 absence (Alex Morgan)",
        },
        { path: "absenceSummaryLabel", value: "2 absences across 2 sessions" },
        { path: "latestSummary.sessionId", value: "2024-09-04" },
      ],
    },
    {
      events: [
        {
          stream: "recordAttendance",
          payload: {
            sessionId: "2024-09-03",
            date: "2024-09-03",
            topic: "Orientation",
            attendance: [
              { studentId: "stu-alex", status: "present" },
              { studentId: "stu-blair", status: "present" },
              { studentId: "stu-cody", status: "present" },
            ],
          },
        },
      ],
      expect: [
        { path: "sessionSummaries.0.absentCount", value: 0 },
        {
          path: "sessionAbsenceLabels.0",
          value: "2024-09-03 Orientation: perfect attendance",
        },
        { path: "attendanceLog.0.absentIds", value: [] },
        { path: "absenceSummaryLabel", value: "1 absence across 2 sessions" },
        { path: "latestSummary.sessionId", value: "2024-09-04" },
      ],
    },
  ],
};

export const scenarios = [studentAttendanceTrackerScenario];

describe("student-attendance-tracker", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
