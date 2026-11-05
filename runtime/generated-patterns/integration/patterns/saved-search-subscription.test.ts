import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface SavedSearchArgument {
  savedSubscriptions?: Array<{
    id?: string;
    name?: string;
    query?: string;
    frequency?: string;
    channels?: unknown;
  }>;
}

const savedSearchSubscriptionScenario: PatternIntegrationScenario<
  SavedSearchArgument
> = {
  name: "saved search subscriptions append and replay triggers",
  module: new URL("./saved-search-subscription.pattern.ts", import.meta.url),
  exportName: "savedSearchSubscription",
  argument: {
    savedSubscriptions: [
      {
        id: " design-scout ",
        name: "design scout",
        query: " design manager remote ",
        frequency: "WEEKLY",
        channels: ["Email", "Push", "Email"],
      },
      {
        name: "market signals ",
        query: " product analytics ",
        frequency: "Monthly",
        channels: ["push", "digest", "push", "sms"],
      },
    ],
  },
  steps: [
    {
      expect: [
        { path: "subscriptions.0.id", value: "design-scout" },
        {
          path: "subscriptions.0.channels",
          value: ["email", "push"],
        },
        { path: "subscriptions.1.id", value: "market-signals-monthly" },
        {
          path: "subscriptions.1.channels",
          value: ["push", "sms", "digest"],
        },
        { path: "views.total", value: 2 },
        {
          path: "views.summaries.0",
          value:
            'Design Scout • weekly • Email, Push • "design manager remote"',
        },
        {
          path: "views.summaries.1",
          value:
            'Market Signals • monthly • Push, Sms, Digest • "product analytics"',
        },
        {
          path: "views.queries",
          value: ["design manager remote", "product analytics"],
        },
        { path: "views.status", value: "2 saved searches active" },
        { path: "views.latestTrigger", value: "No triggers yet" },
        { path: "logs.saved", value: [] },
        { path: "logs.triggers", value: [] },
      ],
    },
    {
      events: [
        {
          stream: "controls.addSubscription",
          payload: {
            name: "supply chain insights",
            query: "supply chain risk",
            frequency: "weekly",
            channels: ["Email", "Digest"],
          },
        },
      ],
      expect: [
        {
          path: "subscriptions.2.id",
          value: "supply-chain-insights-weekly",
        },
        {
          path: "subscriptions.2.channels",
          value: ["email", "digest"],
        },
        { path: "views.total", value: 3 },
        {
          path: "views.queries",
          value: [
            "design manager remote",
            "product analytics",
            "supply chain risk",
          ],
        },
        {
          path: "views.summaries.2",
          value:
            'Supply Chain Insights • weekly • Email, Digest • "supply chain risk"',
        },
        {
          path: "logs.saved.0",
          value:
            'Saved Supply Chain Insights (weekly) via Email, Digest for "supply chain risk"',
        },
        { path: "views.status", value: "3 saved searches active" },
        { path: "views.latestTrigger", value: "No triggers yet" },
        { path: "logs.triggers", value: [] },
      ],
    },
    {
      events: [
        { stream: "controls.triggerAll", payload: {} },
      ],
      expect: [
        {
          path: "logs.triggers.0",
          value:
            'Triggered Design Scout (weekly) via Email, Push for "design manager remote"',
        },
        {
          path: "logs.triggers.1",
          value:
            'Triggered Market Signals (monthly) via Push, Sms, Digest for "product analytics"',
        },
        {
          path: "logs.triggers.2",
          value:
            'Triggered Supply Chain Insights (weekly) via Email, Digest for "supply chain risk"',
        },
        {
          path: "views.latestTrigger",
          value:
            'Triggered Supply Chain Insights (weekly) via Email, Digest for "supply chain risk"',
        },
        { path: "views.status", value: "3 saved searches active" },
      ],
    },
    {
      events: [
        {
          stream: "controls.triggerSubscription",
          payload: { id: "market-signals-monthly" },
        },
      ],
      expect: [
        {
          path: "logs.triggers.3",
          value:
            'Triggered Market Signals (monthly) via Push, Sms, Digest for "product analytics"',
        },
        {
          path: "views.latestTrigger",
          value:
            'Triggered Market Signals (monthly) via Push, Sms, Digest for "product analytics"',
        },
      ],
    },
  ],
};

export const scenarios = [savedSearchSubscriptionScenario];

describe("saved-search-subscription", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
