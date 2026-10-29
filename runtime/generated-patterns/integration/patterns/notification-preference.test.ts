import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const notificationPreferenceScenario: PatternIntegrationScenario<
  { channels?: unknown }
> = {
  name: "notification preferences derive schedules per channel",
  module: new URL(
    "./notification-preference.pattern.ts",
    import.meta.url,
  ),
  exportName: "notificationPreferences",
  steps: [
    {
      expect: [
        { path: "activeCount", value: 3 },
        {
          path: "scheduleMap",
          value: {
            email: "Daily summary (08:00 local time)",
            sms: "paused",
            push: "Immediate alerts (sent instantly)",
            digest: "Daily summary (08:00 local time)",
          },
        },
        {
          path: "scheduleSummary",
          value: "Notification schedules — 3 active channels: " +
            "Email daily summary, Push immediate alerts, Digest daily summary",
        },
        { path: "lastChange", value: "Preferences loaded" },
        { path: "history", value: ["Preferences loaded"] },
      ],
    },
    {
      events: [
        {
          stream: "configureChannel",
          payload: { channel: "email", frequency: "weekly" },
        },
      ],
      expect: [
        { path: "activeCount", value: 3 },
        {
          path: "scheduleMap.email",
          value: "Weekly digest (Mondays 09:00)",
        },
        {
          path: "scheduleSummary",
          value: "Notification schedules — 3 active channels: " +
            "Email weekly digest, Push immediate alerts, Digest daily summary",
        },
        {
          path: "lastChange",
          value: "Email Weekly digest (Mondays 09:00)",
        },
        {
          path: "history",
          value: [
            "Preferences loaded",
            "Email Weekly digest (Mondays 09:00)",
          ],
        },
      ],
    },
    {
      events: [
        {
          stream: "configureChannel",
          payload: { channel: "sms", enabled: true, frequency: "hourly" },
        },
      ],
      expect: [
        { path: "activeCount", value: 4 },
        {
          path: "scheduleMap.sms",
          value: "Hourly updates (top of every hour)",
        },
        {
          path: "scheduleSummary",
          value: "Notification schedules — 4 active channels: " +
            "Email weekly digest, SMS hourly updates, Push immediate alerts, " +
            "Digest daily summary",
        },
        {
          path: "lastChange",
          value: "SMS Hourly updates (top of every hour)",
        },
        {
          path: "history",
          value: [
            "Preferences loaded",
            "Email Weekly digest (Mondays 09:00)",
            "SMS Hourly updates (top of every hour)",
          ],
        },
      ],
    },
  ],
};

export const scenarios = [notificationPreferenceScenario];

describe("notification-preference", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
