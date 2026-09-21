import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { llmToolExecutionHelpers } from "../../src/builtins/llm-dialog.ts";

const { prepareSchemaForLLM } = llmToolExecutionHelpers;

describe("prepareSchemaForLLM()", () => {
  it("preserves the reported subject schema byte-for-byte", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { subject: { type: "string" } },
      required: ["subject"],
    } as const;
    const before = JSON.stringify(schema);

    expect(JSON.stringify(prepareSchemaForLLM(schema))).toBe(before);
  });

  it("preserves a closed schema byte-for-byte at the root and inside objects and arrays", () => {
    const schema = {
      type: "object",
      properties: {
        summary: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "items"],
      additionalProperties: false,
    } as const;
    const before = JSON.stringify(schema);

    expect(JSON.stringify(prepareSchemaForLLM(schema))).toBe(before);
    expect(JSON.stringify(schema)).toBe(before);
  });

  it("inlines references in properties and `additionalProperties` while preserving closed definitions", () => {
    const schema = {
      type: "object",
      $defs: {
        Entry: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
      properties: {
        entry: { $ref: "#/$defs/Entry", asCell: ["cell"] },
        byName: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/Entry" },
        },
      },
      required: ["entry", "byName"],
      additionalProperties: false,
    } as const;

    expect(prepareSchemaForLLM(schema)).toEqual({
      type: "object",
      properties: {
        entry: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        byName: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      },
      required: ["entry", "byName"],
      additionalProperties: false,
    });
  });
});
