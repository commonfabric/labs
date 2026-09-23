import { internSchema } from "@commonfabric/data-model-schema";

export { LLM_DERIVED_RESULT_STAMP_SCHEMA } from "../cfc/llm-derived-stamp.ts";

/** Runtime schema for {@link BuiltInLLMContent} (packages/api/index.ts). */
export const LLMContentSchema = internSchema(
  {
    anyOf: [
      { type: "string" },
      {
        type: "array",
        items: {
          anyOf: [{
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["text", "image", "tool-call", "tool-result"],
              },
              text: { type: "string" },
              image: { type: "string" },
              toolCallId: { type: "string" },
              toolName: { type: "string" },
              input: { type: "object" },
              output: {},
            },
            required: ["type"],
          }, { type: "string" }],
        },
      },
    ],
  },
);

/** Runtime schema for {@link BuiltInLLMMessage} (packages/api/index.ts). */
export const LLMMessageSchema = internSchema(
  {
    type: "object",
    properties: {
      role: { type: "string", enum: ["user", "assistant", "tool"] },
      content: LLMContentSchema,
    },
    required: ["role", "content"],
  },
);

/** Runtime schema for {@link BuiltInLLMDialogState} (packages/api/index.ts). */
export const LLMDialogResultSchema = internSchema(
  {
    type: "object",
    properties: {
      pending: { type: "boolean", default: false },
      result: {},
      addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
      cancelGeneration: { asCell: ["stream"] },
      pinCell: {
        type: "object",
        properties: {
          path: { type: "string" },
          name: { type: "string" },
        },
        required: ["path", "name"],
        asCell: ["stream"],
      },
      unpinAllCells: { asCell: ["stream"] },
      flattenedTools: { type: "object", default: {} },
      pinnedCells: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            name: { type: "string" },
          },
          required: ["path", "name"],
        },
      },
    },
    required: ["pending", "addMessage", "cancelGeneration"],
  } as const,
);

/** Runtime schema for {@link BuiltInLLMTool} (packages/api/index.ts). */
export const LLMToolSchema = internSchema(
  {
    type: "object",
    properties: {
      description: { type: "string" },
      inputSchema: {
        anyOf: [{ type: "object" }, { type: "boolean" }],
      },
      handler: {
        // Deliberately no schema, so it gets populated from the handler
        asCell: ["stream"],
      },
      pattern: {
        type: "object",
        properties: {
          argumentSchema: {
            anyOf: [{ type: "object" }, { type: "boolean" }],
          },
          resultSchema: {
            anyOf: [{ type: "object" }, { type: "boolean" }],
          },
          nodes: { type: "array", items: { type: "object" } },
          program: { type: "object" },
          initial: { type: "object" },
        },
        required: ["argumentSchema", "resultSchema", "nodes"],
        asCell: ["cell"],
      },
      extraParams: { type: "object" },
      useResultSchemaForObservation: { type: "boolean" },
      piece: {
        // Accept whole piece - its own schema defines its handlers
        asCell: ["cell"],
      },
    },
    required: [],
  } as const,
);

/** Runtime schema for reduced tool info sent to the LLM provider. */
export const LLMReducedToolSchema = internSchema(
  {
    type: "object",
    properties: {
      description: { type: "string" },
      inputSchema: { type: "object" },
    },
  },
);

const LLMContextEntrySchema = {
  anyOf: [
    { type: "unknown", asCell: ["cell"] },
    { type: "unknown", asCell: ["opaque"] },
  ],
} as const;

const JSONSchemaValueSchema = {
  anyOf: [
    { type: "object", additionalProperties: true },
    { type: "boolean" },
  ],
} as const;

/** Runtime schema for {@link BuiltInLLMParams} (packages/api/index.ts). */
export const LLMParamsSchema = internSchema(
  {
    type: "object",
    properties: {
      messages: { type: "array", items: LLMMessageSchema, default: [] },
      model: { type: "string" },
      maxTokens: { type: "number" },
      system: { type: "string" },
      stop: { type: "string" },
      builtinTools: { type: "boolean", default: true },
      observationMaxConfidentiality: {
        type: "array",
        items: {},
      },
      tools: {
        type: "object",
        additionalProperties: LLMToolSchema,
        default: {},
      },
      context: {
        type: "object",
        additionalProperties: LLMContextEntrySchema,
        default: {},
      },
      search: { type: "boolean" },
      nativeModelToolIds: { type: "array", items: { type: "string" } },
      resultSchema: JSONSchemaValueSchema,
    },
    required: ["messages"],
  } as const,
);

/** Runtime schema for {@link BuiltInGenerateTextParams} (packages/api/index.ts). */
export const GenerateTextParamsSchema = internSchema(
  {
    type: "object",
    properties: {
      prompt: LLMContentSchema,
      messages: { type: "array", items: LLMMessageSchema },
      context: {
        type: "object",
        additionalProperties: LLMContextEntrySchema,
        default: {},
      },
      system: { type: "string" },
      model: { type: "string" },
      maxTokens: { type: "number" },
      tools: {
        type: "object",
        additionalProperties: LLMToolSchema,
        default: {},
      },
      search: { type: "boolean" },
      nativeModelToolIds: { type: "array", items: { type: "string" } },
    },
  },
);

/** Runtime schema for {@link BuiltInGenerateObjectParams} (packages/api/index.ts). */
export const GenerateObjectParamsSchema = internSchema(
  {
    type: "object",
    properties: {
      prompt: LLMContentSchema,
      messages: { type: "array", items: LLMMessageSchema },
      context: {
        type: "object",
        additionalProperties: LLMContextEntrySchema,
        default: {},
      },
      schema: JSONSchemaValueSchema,
      system: { type: "string" },
      model: { type: "string" },
      maxTokens: { type: "number" },
      observationMaxConfidentiality: {
        type: "array",
        items: {},
      },
      schemaSanitizePromptInjection: { type: "boolean" },
      cache: { type: "boolean" },
      metadata: { type: "object" },
      tools: { type: "object", additionalProperties: LLMToolSchema },
      search: { type: "boolean" },
      nativeModelToolIds: { type: "array", items: { type: "string" } },
    },
    required: ["schema"],
  },
);

/** Runtime schema for the result of the `llm` builtin. */
export const LLMResultSchema = internSchema(
  {
    type: "object",
    properties: {
      pending: { type: "boolean", default: false },
      // `result`/`partial` are model output; the `LlmDerived` stamp is applied
      // at the writeback (llm.ts), not declared here — see
      // {@link LLM_DERIVED_RESULT_STAMP_SCHEMA}.
      result: {
        anyOf: [
          { type: "string" },
          { type: "array", items: { type: "object" } },
        ],
      },
      error: { type: "string" },
      partial: { type: "string" },
      requestHash: { type: "string" },
      groundingSources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            snippet: { type: "string" },
          },
        },
      },
    },
    required: ["pending"],
  } as const,
);

/** Runtime schema for the result of the `generateText` builtin. */
export const GenerateTextResultSchema = internSchema(
  {
    type: "object",
    properties: {
      pending: { type: "boolean", default: false },
      // `result`/`partial` are model output; stamped at the writeback (llm.ts),
      // not declared here — see {@link LLM_DERIVED_RESULT_STAMP_SCHEMA}.
      result: { type: "string" },
      error: { type: "string" },
      partial: { type: "string" },
      requestHash: { type: "string" },
      groundingSources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            snippet: { type: "string" },
          },
        },
      },
    },
    required: ["pending"],
  } as const,
);

/** Runtime schema for the result of the `generateObject` builtin. */
export const GenerateObjectResultSchema = internSchema(
  {
    type: "object",
    properties: {
      pending: { type: "boolean", default: false },
      // `result` is model output; generateObject writes it through a (possibly
      // custom user) `resultSchema` via `asSchema`, and merges the `LlmDerived`
      // stamp into that schema's root at the write (`withLlmDerivedStamp` in
      // llm.ts) — so it is not declared here.
      result: { type: "object" },
      messages: { type: "array", items: LLMMessageSchema },
      error: { type: "string" },
      partial: { type: "string" },
      requestHash: { type: "string" },
      // No `groundingSources` here — generateObject's JSON-mode path returns
      // only the object, not the grounded response. Use generateText for sources.
    },
    required: ["pending"],
  } as const,
);
