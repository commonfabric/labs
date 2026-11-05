/**
 * Learned/Profile schemas for home space data.
 * These define the structure of user's learned profile information.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";

export const factSchema = {
  type: "object",
  properties: {
    content: { type: "string" },
    confidence: { type: "number" },
    source: { type: "string" },
    timestamp: { type: "number" },
  },
  required: ["content", "confidence", "source", "timestamp"],
} as const satisfies JSONSchema;

export type Fact = Schema<typeof factSchema>;

export const preferenceSchema = {
  type: "object",
  properties: {
    key: { type: "string" },
    value: { type: "string" },
    confidence: { type: "number" },
    source: { type: "string" },
  },
  required: ["key", "value", "confidence", "source"],
} as const satisfies JSONSchema;

export type Preference = Schema<typeof preferenceSchema>;

export const questionSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    question: { type: "string" },
    category: { type: "string" },
    priority: { type: "number" },
    options: { type: "array", items: { type: "string" } },
    status: {
      type: "string",
      enum: ["pending", "asked", "answered", "skipped"],
    },
    answer: { type: "string" },
    askedAt: { type: "number" },
    answeredAt: { type: "number" },
  },
  required: ["id", "question", "category", "priority", "status"],
} as const satisfies JSONSchema;

export type Question = Schema<typeof questionSchema>;

export const learnedSectionSchema = {
  type: "object",
  properties: {
    facts: { type: "array", items: factSchema, default: [] },
    preferences: { type: "array", items: preferenceSchema, default: [] },
    openQuestions: { type: "array", items: questionSchema, default: [] },
    personas: { type: "array", items: { type: "string" }, default: [] },
    lastJournalProcessed: { type: "number", default: 0 },
    summary: { type: "string", default: "" },
    summaryVersion: { type: "number", default: 0 },
  },
} as const satisfies JSONSchema;

export type LearnedSection = Schema<typeof learnedSectionSchema>;
