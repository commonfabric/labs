import { assertEquals } from "@std/assert";
import {
  agentFabricCauses,
  recentSessionMessages,
  sessionIndexBuckets,
} from "../src/fabric.ts";

Deno.test("agent connector Fabric causes are stable", () => {
  assertEquals(agentFabricCauses("did:key:test", "did:key:owner"), {
    index: {
      spaceDid: "did:key:test",
      ownerDid: "did:key:owner",
      agentConnector: "recent-session-index",
    },
    allIndex: {
      spaceDid: "did:key:test",
      ownerDid: "did:key:owner",
      agentConnector: "all-session-index",
    },
    health: {
      spaceDid: "did:key:test",
      ownerDid: "did:key:owner",
      agentConnector: "health",
    },
    commands: {
      spaceDid: "did:key:test",
      ownerDid: "did:key:owner",
      agentConnector: "commands",
    },
    receipts: {
      spaceDid: "did:key:test",
      ownerDid: "did:key:owner",
      agentConnector: "receipts",
    },
  });
});

Deno.test("session indexes keep recent sessions and all sessions", () => {
  const generatedAt = "2026-07-10T12:00:00.000Z";
  const entries = [
    { id: "new", updatedAt: "2026-07-10T11:59:00.000Z" },
    { id: "boundary", updatedAt: "2026-07-03T12:00:00.000Z" },
    { id: "old", updatedAt: "2026-07-03T11:59:59.999Z" },
    { id: "unknown", updatedAt: null },
  ];

  const buckets = sessionIndexBuckets(entries, generatedAt);

  assertEquals(buckets.recent.map((entry) => entry.id), [
    "new",
    "boundary",
  ]);
  assertEquals(buckets.all.map((entry) => entry.id), [
    "new",
    "boundary",
    "old",
    "unknown",
  ]);
  assertEquals(buckets.olderCount, 2);
});

Deno.test("session index keeps only the newest normalized message previews", () => {
  const messages = Array.from({ length: 15 }, (_, index) => ({
    id: `message-${index}`,
    role: "assistant" as const,
    kind: "text",
    createdAt: null,
    textPreview: `Preview ${index}`,
    rawIndex: index,
  }));

  assertEquals(
    recentSessionMessages(messages).map((message) => message.id),
    messages.slice(-12).map((message) => message.id),
  );
  assertEquals(recentSessionMessages(messages, 2), messages.slice(-2));
  assertEquals(recentSessionMessages(messages, 0), []);
});
