import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const medicationAdherenceScenario: PatternIntegrationScenario<
  { doses?: Array<Record<string, unknown>> }
> = {
  name: "medication adherence derives percentage and remaining doses",
  module: new URL("./medication-adherence.pattern.ts", import.meta.url),
  exportName: "medicationAdherencePattern",
  steps: [
    {
      expect: [
        { path: "schedule.length", value: 3 },
        { path: "schedule.0.medication", value: "Levothyroxine" },
        { path: "schedule.1.scheduledTime", value: "12:30" },
        { path: "stats.total", value: 3 },
        { path: "stats.taken", value: 0 },
        { path: "adherencePercentage", value: 0 },
        { path: "adherenceLabel", value: "0 of 3 doses taken" },
        { path: "percentageLabel", value: "0% adherence" },
        { path: "upcomingDoses.length", value: 3 },
        { path: "history", value: [] },
      ],
    },
    {
      events: [
        {
          stream: "markDose",
          payload: { doseId: "dose-1", takenAt: "06:15" },
        },
      ],
      expect: [
        { path: "takenRecords.length", value: 1 },
        { path: "takenRecords.0.medication", value: "Levothyroxine" },
        { path: "stats.taken", value: 1 },
        { path: "stats.pending", value: 2 },
        { path: "adherencePercentage", value: 33.33 },
        { path: "adherenceLabel", value: "1 of 3 doses taken" },
        { path: "percentageLabel", value: "33.33% adherence" },
        { path: "remainingLabel", value: "2 doses remaining" },
        { path: "upcomingDoses.length", value: 2 },
        {
          path: "history.0",
          value: "Took Levothyroxine scheduled for 06:30 at 06:15",
        },
      ],
    },
    {
      events: [
        {
          stream: "markDose",
          payload: { doseId: "dose-2", takenAt: "12:40" },
        },
      ],
      expect: [
        { path: "stats.taken", value: 2 },
        { path: "stats.pending", value: 1 },
        { path: "adherencePercentage", value: 66.67 },
        { path: "percentageLabel", value: "66.67% adherence" },
        { path: "remainingLabel", value: "1 dose remaining" },
        { path: "upcomingDoses.0.medication", value: "Atorvastatin" },
        {
          path: "history.1",
          value: "Took Metformin scheduled for 12:30 at 12:40",
        },
      ],
    },
    {
      events: [
        {
          stream: "markDose",
          payload: { doseId: "dose-3", takenAt: "21:05" },
        },
      ],
      expect: [
        { path: "stats.taken", value: 3 },
        { path: "stats.pending", value: 0 },
        { path: "adherencePercentage", value: 100 },
        { path: "percentageLabel", value: "100% adherence" },
        { path: "remainingLabel", value: "0 doses remaining" },
        { path: "upcomingDoses", value: [] },
        {
          path: "history.2",
          value: "Took Atorvastatin scheduled for 21:00 at 21:05",
        },
      ],
    },
    {
      events: [{ stream: "reset", payload: {} }],
      expect: [
        { path: "takenRecords", value: [] },
        { path: "history", value: [] },
        { path: "stats.taken", value: 0 },
        { path: "percentageLabel", value: "0% adherence" },
        { path: "remainingLabel", value: "3 doses remaining" },
        { path: "upcomingDoses.length", value: 3 },
      ],
    },
  ],
  argument: {
    doses: [
      {
        id: "dose-1",
        name: "Levothyroxine",
        dosage: "75 mcg",
        scheduledTime: "06:30",
        instructions: "Take on an empty stomach",
      },
      {
        id: "dose-2",
        name: "Metformin",
        dosage: "500 mg",
        scheduledTime: "12:30",
        instructions: "Take with lunch",
      },
      {
        id: "dose-3",
        name: "Atorvastatin",
        dosage: "20 mg",
        scheduledTime: "21:00",
        instructions: "Take with water",
      },
    ],
  },
};

export const scenarios = [medicationAdherenceScenario];

describe("medication-adherence", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
