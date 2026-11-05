import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";
import type {
  MessageReactionView,
  MessageTotalEntry,
  ReactionMatrixRow,
  ReactionMessageInput,
  ReactionTotalEntry,
} from "./chat-reaction-tracker.pattern.ts";

const cloneMessageView = (
  entries: MessageReactionView[],
): MessageReactionView[] =>
  entries.map((entry) => ({
    ...entry,
    reactions: entry.reactions.map((reaction) => ({ ...reaction })),
  }));

const cloneMessageTotals = (
  entries: MessageTotalEntry[],
): MessageTotalEntry[] => entries.map((entry) => ({ ...entry }));

const cloneReactionTotals = (
  entries: ReactionTotalEntry[],
): ReactionTotalEntry[] => entries.map((entry) => ({ ...entry }));

const cloneMatrix = (
  entries: ReactionMatrixRow[],
): ReactionMatrixRow[] => entries.map((entry) => ({ ...entry }));

const initialMessages: ReactionMessageInput[] = [
  {
    id: "msg-thread-1",
    content: "Start of thread",
    reactions: { "thumbs-up": 2, sparkle: 1 },
  },
  {
    id: "msg-thread-2",
    content: "Follow up",
    reactions: { heart: 1 },
  },
];

const expectMessages = (
  entries: MessageReactionView[],
): MessageReactionView[] => cloneMessageView(entries);

export const chatReactionTrackerScenario: PatternIntegrationScenario<
  { messages?: ReactionMessageInput[]; reactionCatalog?: string[] }
> = {
  name: "chat reaction tracker rolls up nested reaction totals",
  module: new URL("./chat-reaction-tracker.pattern.ts", import.meta.url),
  exportName: "chatReactionTracker",
  argument: {
    messages: initialMessages,
    reactionCatalog: ["thumbs-up", "heart", "sparkle"],
  },
  steps: [
    {
      expect: [
        {
          path: "reactionCatalog",
          value: ["heart", "sparkle", "thumbs-up"],
        },
        {
          path: "messages",
          value: expectMessages([
            {
              id: "msg-thread-1",
              content: "Start of thread",
              reactions: [
                { reaction: "heart", count: 0 },
                { reaction: "sparkle", count: 1 },
                { reaction: "thumbs-up", count: 2 },
              ],
            },
            {
              id: "msg-thread-2",
              content: "Follow up",
              reactions: [
                { reaction: "heart", count: 1 },
                { reaction: "sparkle", count: 0 },
                { reaction: "thumbs-up", count: 0 },
              ],
            },
          ]),
        },
        {
          path: "messageTotals",
          value: cloneMessageTotals([
            { id: "msg-thread-1", content: "Start of thread", total: 3 },
            { id: "msg-thread-2", content: "Follow up", total: 1 },
          ]),
        },
        {
          path: "reactionTotals",
          value: cloneReactionTotals([
            { reaction: "heart", count: 1 },
            { reaction: "sparkle", count: 1 },
            { reaction: "thumbs-up", count: 2 },
          ]),
        },
        { path: "totalReactions", value: 4 },
        { path: "summary", value: "4 reactions across 2 messages" },
        {
          path: "reactionMatrix",
          value: cloneMatrix([
            { messageId: "msg-thread-1", reaction: "heart", count: 0 },
            { messageId: "msg-thread-1", reaction: "sparkle", count: 1 },
            { messageId: "msg-thread-1", reaction: "thumbs-up", count: 2 },
            { messageId: "msg-thread-2", reaction: "heart", count: 1 },
            { messageId: "msg-thread-2", reaction: "sparkle", count: 0 },
            { messageId: "msg-thread-2", reaction: "thumbs-up", count: 0 },
          ]),
        },
      ],
    },
    {
      events: [
        {
          stream: "recordReaction",
          payload: {
            messageId: "msg-thread-1",
            reaction: "heart",
            delta: 2,
          },
        },
      ],
      expect: [
        {
          path: "messageTotals",
          value: cloneMessageTotals([
            { id: "msg-thread-1", content: "Start of thread", total: 5 },
            { id: "msg-thread-2", content: "Follow up", total: 1 },
          ]),
        },
        {
          path: "reactionTotals",
          value: cloneReactionTotals([
            { reaction: "heart", count: 3 },
            { reaction: "sparkle", count: 1 },
            { reaction: "thumbs-up", count: 2 },
          ]),
        },
        { path: "totalReactions", value: 6 },
        { path: "summary", value: "6 reactions across 2 messages" },
      ],
    },
    {
      events: [
        {
          stream: "recordReaction",
          payload: {
            messageId: "msg-thread-2",
            reaction: "sparkle",
          },
        },
      ],
      expect: [
        {
          path: "reactionTotals",
          value: cloneReactionTotals([
            { reaction: "heart", count: 3 },
            { reaction: "sparkle", count: 2 },
            { reaction: "thumbs-up", count: 2 },
          ]),
        },
        { path: "totalReactions", value: 7 },
        { path: "summary", value: "7 reactions across 2 messages" },
      ],
    },
    {
      events: [
        {
          stream: "recordReaction",
          payload: {
            messageId: "msg-thread-1",
            reaction: "pin",
          },
        },
      ],
      expect: [
        {
          path: "reactionCatalog",
          value: ["heart", "pin", "sparkle", "thumbs-up"],
        },
        {
          path: "messages",
          value: expectMessages([
            {
              id: "msg-thread-1",
              content: "Start of thread",
              reactions: [
                { reaction: "heart", count: 2 },
                { reaction: "pin", count: 1 },
                { reaction: "sparkle", count: 1 },
                { reaction: "thumbs-up", count: 2 },
              ],
            },
            {
              id: "msg-thread-2",
              content: "Follow up",
              reactions: [
                { reaction: "heart", count: 1 },
                { reaction: "pin", count: 0 },
                { reaction: "sparkle", count: 1 },
                { reaction: "thumbs-up", count: 0 },
              ],
            },
          ]),
        },
        {
          path: "reactionTotals",
          value: cloneReactionTotals([
            { reaction: "heart", count: 3 },
            { reaction: "pin", count: 1 },
            { reaction: "sparkle", count: 2 },
            { reaction: "thumbs-up", count: 2 },
          ]),
        },
        { path: "totalReactions", value: 8 },
        { path: "summary", value: "8 reactions across 2 messages" },
      ],
    },
    {
      events: [
        {
          stream: "recordReaction",
          payload: {
            messageId: "msg-thread-1",
            reaction: "thumbs-up",
            delta: -3,
          },
        },
      ],
      expect: [
        {
          path: "messages",
          value: expectMessages([
            {
              id: "msg-thread-1",
              content: "Start of thread",
              reactions: [
                { reaction: "heart", count: 2 },
                { reaction: "pin", count: 1 },
                { reaction: "sparkle", count: 1 },
                { reaction: "thumbs-up", count: 0 },
              ],
            },
            {
              id: "msg-thread-2",
              content: "Follow up",
              reactions: [
                { reaction: "heart", count: 1 },
                { reaction: "pin", count: 0 },
                { reaction: "sparkle", count: 1 },
                { reaction: "thumbs-up", count: 0 },
              ],
            },
          ]),
        },
        {
          path: "reactionTotals",
          value: cloneReactionTotals([
            { reaction: "heart", count: 3 },
            { reaction: "pin", count: 1 },
            { reaction: "sparkle", count: 2 },
            { reaction: "thumbs-up", count: 0 },
          ]),
        },
        { path: "totalReactions", value: 6 },
        { path: "summary", value: "6 reactions across 2 messages" },
      ],
    },
  ],
};

export const scenarios = [chatReactionTrackerScenario];

describe("chat-reaction-tracker", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
