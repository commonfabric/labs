/**
 * Zod schemas for HTTP validation of LLM endpoints.
 *
 * Canonical TS types: base/api/index.ts (BuiltInLLMMessage, etc.)
 * Runtime JSON schemas: runtime/runner/src/builtins/llm-schemas.ts
 *
 * When modifying these Zod schemas, run the alignment tests to check for drift:
 *   deno test --allow-all runtime/runner/test/llm-schema-alignment.test.ts
 */

import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { z } from "zod";
import { toZod } from "../../../lib/zod-utils.ts";
import {
  LLM_NATIVE_MODEL_TOOL_IDS,
  type LLMGenerateObjectRequest,
  type LLMRequest,
} from "@commonfabric/llm/types";

const tags = ["AI Language Models"];

const ErrorSchema = z.object({ error: z.string() });

// The shape stoker's validation hook answers with, which differs from the one
// the handlers write.
const ValidationErrorSchema = z.object({
  success: z.boolean(),
  error: z.object({
    name: z.string(),
    issues: z.array(z.record(z.string(), z.any())),
  }),
});

/**
 * The ways a request to these routes fails, told apart by status so a caller
 * knows whether to change the request, repeat it later, or report the service
 * as broken. A streaming request that fails once its response body has begun
 * cannot use any of these: its status is already 200 and the failure arrives
 * as an `error` event in the stream.
 */
const failureResponses = {
  [HttpStatusCodes.BAD_REQUEST]: jsonContent(
    ErrorSchema,
    "The request names something this service does not offer, asks for more than the model can produce, or carries something the model refused.",
  ),
  [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
    ValidationErrorSchema,
    "The request body does not match the schema for this route.",
  ),
  [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
    ErrorSchema,
    "The model provider is rate limiting these requests. Make the request again later.",
  ),
  [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
    ErrorSchema,
    "This service is misconfigured, or failed for a reason it does not recognize.",
  ),
  [HttpStatusCodes.BAD_GATEWAY]: jsonContent(
    ErrorSchema,
    "The model provider failed, or answered with something this service could not use.",
  ),
  [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
    ErrorSchema,
    "The model provider is overloaded. Make the request again later.",
  ),
  [HttpStatusCodes.GATEWAY_TIMEOUT]: jsonContent(
    ErrorSchema,
    "The exchange with the model provider ran out of time.",
  ),
} as const;

const NativeModelToolIdSchema = z.enum(LLM_NATIVE_MODEL_TOOL_IDS);

const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ImagePartSchema = z.object({
  type: z.literal("image"),
  image: z.string(),
});

const ToolCallPartSchema = z.object({
  type: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.any()),
});

const ToolResultPartSchema = z.object({
  type: z.literal("tool-result"),
  toolCallId: z.string(),
  toolName: z.string(),
  output: z.any(),
  error: z.string().optional(),
});

const MessageContentSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ImagePartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
]);

export const MessageSchema = z.object({
  // A system instruction is not a message. `BuiltInLLMMessage` leaves the role
  // out and the provider SDK refuses one inside `messages`, so a caller that
  // sends one is told which field to move it to rather than only which values
  // the enum takes. Every other role falls through to zod's own wording.
  role: z.enum(["user", "assistant", "tool"], {
    error: (issue) =>
      issue.input === "system"
        ? "A system instruction travels in the request's 'system' field, " +
          "not as a message in 'messages'"
        : undefined,
  }),
  content: z.union([z.string(), z.array(MessageContentSchema)]),
  nativeModelToolResults: z.array(z.object({
    type: z.literal("cf-harness.native-model-tool-result"),
    toolId: NativeModelToolIdSchema,
    provider: z.string().optional(),
    providerMetadata: z.any().optional(),
    sources: z.any().optional(),
  })).optional(),
});

export const LLMRequestSchema = toZod<LLMRequest>().with({
  messages: z.array(MessageSchema) as any, // Trust our BuiltInLLMMessage = CoreMessage alignment
  system: z.string().optional(),
  model: z.string().openapi({
    example: "default",
  }),
  maxTokens: z.number().optional(),
  stop: z.string().optional(),
  stream: z.boolean().optional(),
  mode: z.enum(["json"]).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.any()])).optional(),
  cache: z.boolean().default(true).optional(),
  tools: z.record(
    z.string(),
    z.object({
      description: z.string(),
      inputSchema: z.record(z.string(), z.any()),
      handler: z.function().optional().openapi({
        type: "object",
        description:
          "Function handler for tool execution (not serialized in API)",
      }),
    }),
  ).optional(),
  nativeModelToolIds: z.array(NativeModelToolIdSchema).optional(),
});

export const GenerateObjectRequestSchema = toZod<LLMGenerateObjectRequest>()
  .with({
    messages: z.array(MessageSchema) as any,
    schema: z.record(z.string(), z.any()),
    system: z.string().optional(),
    cache: z.boolean().default(true).optional(),
    maxTokens: z.number().optional(),
    model: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  });

export const ModelInfoSchema = z.object({
  capabilities: z.object({
    contextWindow: z.number(),
    maxOutputTokens: z.number(),
    streaming: z.boolean(),
    systemPrompt: z.boolean(),
    systemPromptWithImages: z.boolean().optional(),
    stopSequences: z.boolean(),
    prefill: z.boolean(),
    images: z.boolean(),
    nativeModelToolIds: z.array(NativeModelToolIdSchema).optional(),
  }),
  name: z.string(),
  aliases: z.array(z.string()),
});

export const ModelsResponseSchema = z.record(z.string(), ModelInfoSchema);

// The streamed branch of this route writes one JSON event per line straight to
// the response body, with no envelope around the sequence. The events are
// `text-delta`, `tool-call`, `tool-result`, `finish` and `error`, each tagged by
// its own `type` field. The body is UTF-8 text, so it is a plain string; the
// line-delimited structure inside it is beyond what JSON Schema can state, and
// the description carries it.
const StreamResponse = z.string().openapi({
  description:
    'Newline-delimited JSON events, one per line, each tagged by a "type" ' +
    'field: "text-delta" carries the next piece of text in "textDelta", ' +
    '"tool-call" and "tool-result" report tool activity, "finish" ends a ' +
    'complete response, and "error" reports a failure mid-stream.',
});

// The non-streaming branch of this route answers with the model's reply message
// written straight to the response body, with no envelope around it. The message
// carries a `role` and its `content`, and the client parses those fields
// directly from the body.
const JsonResponse = MessageSchema.openapi({
  example: {
    role: "assistant",
    content:
      "Arr! That be a mighty fine tongue-twister ye got there, matey! *adjusts eye patch*\n\nAs any seasoned sea dog would tell ye, a woodchuck (if the scurvy beast could chuck wood) would chuck as much wood as a woodchuck could chuck if a woodchuck could chuck wood! \n\nBut between you and me, shipmate, we pirates care more about how much booty we can plunder than how much wood them landlubbing woodchucks can chuck! Yarr har har! 🏴‍☠️",
  },
});

const GetModelsRouteQueryParams = z.object({
  search: z.string().optional(),
  capability: z.string().optional(),
  task: z.string().optional(),
});

export type GetModelsRouteQueryParams = z.infer<
  typeof GetModelsRouteQueryParams
>;

//
// Route definitions
//

export const getModels = createRoute({
  path: "/api/ai/llm/models",
  method: "get",
  tags,
  request: {
    query: GetModelsRouteQueryParams,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      ModelsResponseSchema.openapi({
        example: {
          "claude-3-5-sonnet": {
            name: "claude-3-5-sonnet",
            capabilities: {
              contextWindow: 200000,
              maxOutputTokens: 8192,
              images: true,
              prefill: true,
              systemPrompt: true,
              stopSequences: true,
              streaming: true,
            },
            aliases: [
              "anthropic:claude-3-5-sonnet-latest",
              "claude-3-5-sonnet",
            ],
          },
        },
      }),
      "Available LLM models and their capabilities",
    ),
  },
});

export const generateText = createRoute({
  path: "/api/ai/llm",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: LLMRequestSchema.openapi({
            example: {
              model: "default",
              system: "You are a pirate, make sure you talk like one.",
              stream: false,
              cache: true,
              messages: [
                {
                  role: "user",
                  content:
                    "how much wood would a woodchuck chuck if a woodchuck could chuck wood?",
                },
              ],
            },
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: JsonResponse,
        },
        "text/event-stream": {
          schema: StreamResponse,
        },
      },
      description:
        "Generated text response. NOTE: If you make a request with `stream: true`, the server answers with a `text/event-stream` of newline-delimited JSON events instead of a single message object; the message is assembled from the `text-delta` events as they arrive.",
    },
    ...failureResponses,
  },
});

export const generateObject = createRoute({
  path: "/api/ai/llm/generateObject",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: GenerateObjectRequestSchema.openapi({
            example: {
              messages: [{
                role: "user",
                content:
                  "What is the first thing that comes to mind when I say 'apple'?",
              }],
              schema: {
                type: "object",
                properties: {
                  idea: { type: "string" },
                  reason: { type: "string" },
                  silliness: { type: "number" },
                },
                required: ["idea", "reason", "silliness"],
              },
            },
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        object: z.any(),
        id: z.string().optional(),
      }).openapi({
        example: {
          object: {
            idea: "apple",
            reason: "It's a fruit",
            silliness: 0.5,
          },
          id: "123",
        },
      }),
      "Generated object",
    ),
    ...failureResponses,
  },
});

export type GetModelsRoute = typeof getModels;
export type GenerateTextRoute = typeof generateText;
export type GenerateObjectRoute = typeof generateObject;
