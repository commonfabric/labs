import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface EmailMessageArgument {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  timestamp: number;
  snippet: string;
}

export const emailInboxThreadingScenario: PatternIntegrationScenario<
  { messages?: EmailMessageArgument[]; activeThreadId?: string | null }
> = {
  name: "email inbox threads reorder by latest activity",
  module: new URL("./email-inbox-threading.pattern.ts", import.meta.url),
  exportName: "emailInboxThreading",
  argument: {
    messages: [
      {
        id: "m-1",
        threadId: "support-1",
        subject: "Password reset support",
        sender: "alice@example.com",
        timestamp: 1,
        snippet: "I cannot login to my account.",
      },
      {
        id: "m-2",
        threadId: "product-1",
        subject: "Feature request: dark mode",
        sender: "bob@example.com",
        timestamp: 3,
        snippet: "Dark mode would be helpful.",
      },
      {
        id: "m-3",
        threadId: "support-1",
        subject: "Re: Password reset support",
        sender: "support@example.com",
        timestamp: 4,
        snippet: "Please confirm your username.",
      },
    ],
  },
  steps: [
    {
      expect: [
        { path: "summary", value: "2 threads" },
        { path: "orderedThreadIds", value: ["support-1", "product-1"] },
        { path: "topThread.threadId", value: "support-1" },
        {
          path: "topThreadStatus",
          value: "Top thread: Re: Password reset support (2)",
        },
        { path: "threadCount", value: 2 },
        { path: "activeThreadView", value: null },
        { path: "activeThreadSummary", value: null },
        { path: "threadActivity", value: [] },
        {
          path: "threads.0.senders",
          value: ["alice@example.com", "support@example.com"],
        },
        { path: "threads.0.messageCount", value: 2 },
        { path: "threads.1.messageCount", value: 1 },
      ],
    },
    {
      events: [
        {
          stream: "receive",
          payload: {
            id: "m-4",
            threadId: "product-1",
            subject: "Re: Feature request: dark mode",
            sender: "product@example.com",
            timestamp: 6,
            snippet: "Sharing prototype mockups.",
          },
        },
      ],
      expect: [
        { path: "summary", value: "2 threads" },
        { path: "orderedThreadIds", value: ["product-1", "support-1"] },
        { path: "topThread.threadId", value: "product-1" },
        {
          path: "topThreadStatus",
          value: "Top thread: Re: Feature request: dark mode (2)",
        },
        { path: "activeThreadId", value: "product-1" },
        {
          path: "activeThreadSummary.threadId",
          value: "product-1",
        },
        { path: "activeThreadView", value: "product-1" },
        {
          path: "threadActivity",
          value: ["product-1:6"],
        },
        { path: "threads.0.messageCount", value: 2 },
        {
          path: "threads.0.senders",
          value: ["bob@example.com", "product@example.com"],
        },
        { path: "threads.0.snippet", value: "Sharing prototype mockups." },
      ],
    },
    {
      events: [
        {
          stream: "receive",
          payload: {
            id: "m-5",
            threadId: "support-1",
            subject: "Re: Password reset support (resolved)",
            sender: "alice@example.com",
            timestamp: 7,
            snippet: "Thanks, it is working now.",
          },
        },
      ],
      expect: [
        { path: "orderedThreadIds", value: ["support-1", "product-1"] },
        { path: "threadCount", value: 2 },
        {
          path: "topThreadStatus",
          value: "Top thread: Re: Password reset support (resolved) (3)",
        },
        { path: "activeThreadId", value: "support-1" },
        {
          path: "activeThreadSummary.messageCount",
          value: 3,
        },
        { path: "activeThreadView", value: "support-1" },
        {
          path: "threadActivity",
          value: ["product-1:6", "support-1:7"],
        },
        { path: "threads.0.messageCount", value: 3 },
        {
          path: "threads.0.messages.2.timestamp",
          value: 7,
        },
        {
          path: "threads.0.senders",
          value: ["alice@example.com", "support@example.com"],
        },
      ],
    },
  ],
};

export const scenarios = [emailInboxThreadingScenario];

describe("email-inbox-threading", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
