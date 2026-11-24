import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const patientVitalsDashboardScenario: PatternIntegrationScenario<
  {
    patientName?: string;
    thresholds?: Record<string, unknown>;
    initialReadings?: Array<Record<string, unknown>>;
  }
> = {
  name: "patient vitals dashboard derives alerts from thresholds",
  module: new URL("./patient-vitals-dashboard.pattern.ts", import.meta.url),
  exportName: "patientVitalsDashboardPattern",
  steps: [
    {
      expect: [
        { path: "statusLabel", value: "Alice Johnson · Alerts: 0" },
        {
          path: "latestSummary",
          value:
            "Latest: 2024-01-01T12:00Z · HR 78 bpm · BP 116/72 mmHg · Temp 37.0°C · SpO₂ 98%",
        },
        {
          path: "historySummaries.0",
          value:
            "2024-01-01T08:00Z · HR 72 bpm · BP 118/76 mmHg · Temp 36.8°C · SpO₂ 97%",
        },
        { path: "historySummaries.length", value: 2 },
        { path: "alerts", value: [] },
        { path: "alertCount", value: 0 },
        { path: "alertLabel", value: "Alerts: All vitals within range" },
        { path: "isCritical", value: false },
        { path: "alertHistory.0.alerts", value: [] },
      ],
    },
    {
      events: [
        {
          stream: "recordReading",
          payload: {
            id: "clinic-reading",
            recordedAt: "2024-01-01T14:30Z",
            heartRate: 88,
            systolic: 126,
            diastolic: 82,
            temperature: 37.2,
            oxygenSaturation: 98,
          },
        },
      ],
      expect: [
        { path: "readings.length", value: 3 },
        { path: "alertCount", value: 0 },
        {
          path: "latestSummary",
          value:
            "Latest: 2024-01-01T14:30Z · HR 88 bpm · BP 126/82 mmHg · Temp 37.2°C · SpO₂ 98%",
        },
        {
          path: "historySummaries.2",
          value:
            "2024-01-01T14:30Z · HR 88 bpm · BP 126/82 mmHg · Temp 37.2°C · SpO₂ 98%",
        },
        { path: "alertHistory.2.alerts", value: [] },
      ],
    },
    {
      events: [
        {
          stream: "recordReading",
          payload: {
            id: "evening-critical",
            recordedAt: "2024-01-01T18:00Z",
            heartRate: 140,
            systolic: 160,
            diastolic: 102,
            temperature: 39.2,
            oxygenSaturation: 90,
          },
        },
      ],
      expect: [
        { path: "readings.length", value: 4 },
        { path: "alertCount", value: 4 },
        { path: "statusLabel", value: "Alice Johnson · Alerts: 4" },
        { path: "alertLabel", value: "Alerts: 4 active alerts" },
        { path: "isCritical", value: true },
        {
          path: "alerts.0",
          value: "Heart rate high: 140 bpm (max 105)",
        },
        {
          path: "alerts.1",
          value: "Blood pressure high: 160/102 mmHg (max 135/88)",
        },
        {
          path: "alerts.2",
          value: "Temperature high: 39.2°C (max 37.8°C)",
        },
        {
          path: "alerts.3",
          value: "Oxygen saturation low: 90% (min 94%)",
        },
        { path: "alertHistory.3.alerts.length", value: 4 },
      ],
    },
    {
      events: [
        {
          stream: "updateThresholds",
          payload: {
            heartRate: { max: 150 },
            systolic: { max: 170 },
            diastolic: { max: 110 },
            temperature: { max: 40 },
            oxygen: { min: 88 },
          },
        },
      ],
      expect: [
        { path: "alertCount", value: 0 },
        { path: "alerts", value: [] },
        { path: "statusLabel", value: "Alice Johnson · Alerts: 0" },
        { path: "alertLabel", value: "Alerts: All vitals within range" },
        { path: "isCritical", value: false },
        { path: "alertHistory.3.alerts", value: [] },
      ],
    },
  ],
  argument: {
    patientName: " Alice Johnson ",
    thresholds: {
      heartRate: { min: 55, max: 105 },
      systolic: { max: 135 },
      diastolic: { max: 88 },
      temperature: { min: 36, max: 37.8 },
      oxygen: { min: 94 },
    },
    initialReadings: [
      {
        id: "morning",
        recordedAt: "2024-01-01T08:00Z",
        heartRate: 72,
        systolic: 118,
        diastolic: 76,
        temperature: 36.8,
        oxygenSaturation: 97,
      },
      {
        id: " midday ",
        recordedAt: "2024-01-01T12:00Z",
        heartRate: 78,
        systolic: 116,
        diastolic: 72,
        temperature: 37,
        oxygenSaturation: 98,
      },
    ],
  },
};

export const scenarios = [patientVitalsDashboardScenario];

describe("patient-vitals-dashboard", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
