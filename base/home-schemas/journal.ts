/**
 * Journal schemas for home space data.
 * These define the structure of user's activity journal.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";

/**
 * Journal entry event types - the significant events we track
 */
export const journalEventTypes = [
  "piece:favorited",
  "piece:unfavorited",
  "piece:created",
  "piece:modified",
  "space:entered",
] as const;

export type JournalEventType = (typeof journalEventTypes)[number];

/**
 * Snapshot of a cell's state at a point in time
 */
export const journalSnapshotSchema = {
  type: "object",
  properties: {
    name: { type: "string", default: "" },
    schemaTag: { type: "string", default: "" },
    valueExcerpt: { type: "string", default: "" },
  },
} as const satisfies JSONSchema;

export type JournalSnapshot = Schema<typeof journalSnapshotSchema>;

/**
 * A single journal entry capturing a significant event
 */
export const journalEntrySchema = {
  type: "object",
  properties: {
    timestamp: { type: "number" },
    eventType: {
      type: "string",
      enum: journalEventTypes as unknown as string[],
    },
    // Live cell reference (may update over time)
    // we use type unknown to validate, but avoid including children
    subject: { type: "unknown", asCell: ["cell"] },
    // Frozen snapshot at entry time
    snapshot: journalSnapshotSchema,
    // LLM-generated narrative prose
    narrative: { type: "string", default: "" },
    // Flag to indicate narrative generation is pending
    narrativePending: { type: "boolean", default: false },
    // Tags for filtering/searching
    tags: {
      type: "array",
      items: { type: "string" },
      default: [],
    },
    // Space where event occurred
    space: { type: "string" },
  },
  required: ["timestamp", "eventType", "space"],
} as const satisfies JSONSchema;

export type JournalEntry = Schema<typeof journalEntrySchema>;

/**
 * The journal is an array of entries
 */
export const journalSchema = {
  type: "array",
  items: journalEntrySchema,
  default: [],
} as const satisfies JSONSchema;

export type Journal = Schema<typeof journalSchema>;
