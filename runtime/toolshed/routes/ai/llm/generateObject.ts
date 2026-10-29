import { DEFAULT_GENERATE_OBJECT_MODEL } from "@commonfabric/llm";
import {
  type LLMGenerateObjectRequest,
  type LLMGenerateObjectResponse,
} from "@commonfabric/llm/types";
import { trace } from "@opentelemetry/api";
import {
  generateObject as generateObjectCore,
  jsonSchema,
  type ModelMessage,
} from "ai";
import { Ajv } from "ajv";

import { LLMRequestError } from "./errors.ts";
import { resolveModel } from "./models.ts";
import { normalizeSchemaForProvider } from "./schema.ts";
import { withGatewayOperation } from "@/lib/gateway-provenance.ts";

/**
 * A gateway-bound request reports the route it came from. The whole call is in
 * scope, and the response is complete when it returns, so every request it
 * makes is covered.
 */
export function generateObject(
  params: LLMGenerateObjectRequest,
): Promise<LLMGenerateObjectResponse> {
  return withGatewayOperation(
    "generate-object",
    () => generateObjectCall(params),
  );
}

async function generateObjectCall(
  params: LLMGenerateObjectRequest,
): Promise<LLMGenerateObjectResponse> {
  try {
    const providerSchema = normalizeSchemaForProvider(params.schema) as Record<
      string,
      unknown
    >;
    const modelName = params.model ?? DEFAULT_GENERATE_OBJECT_MODEL;
    const modelConfig = await resolveModel(modelName);
    if (!modelConfig) {
      throw new LLMRequestError(`Unsupported model: ${modelName}`);
    }
    const ajv = new Ajv({ allErrors: true, strict: false });
    // The schema comes from the caller, and Ajv rejects one it cannot compile:
    // an unknown type, a reference to nothing, a keyword given the wrong shape.
    let validator;
    try {
      validator = ajv.compile(providerSchema);
    } catch (error) {
      throw new LLMRequestError(
        `Schema cannot be compiled: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    const activeSpan = trace.getActiveSpan();
    const spanId = activeSpan?.spanContext().spanId;

    // Attach metadata directly to the root span
    if (activeSpan) {
      // Add the metadata from params if available
      if (params.metadata) {
        Object.entries(params.metadata).forEach(([key, value]) => {
          // Only set attributes with valid values (not undefined)
          if (value !== undefined) {
            // Handle different types to ensure we only use valid AttributeValue types
            if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean"
            ) {
              activeSpan.setAttribute(`metadata.${key}`, value);
            } else if (typeof value === "object") {
              // Convert objects to JSON strings
              activeSpan.setAttribute(`metadata.${key}`, JSON.stringify(value));
            }
          }
        });
      }
    }

    // Use messages directly - conversion happens client-side
    const messages = params.messages as ModelMessage[];

    const { object } = await generateObjectCore({
      model: modelConfig.model,
      messages,
      schema: jsonSchema(providerSchema, {
        validate: (value: unknown) => {
          if (!validator(value)) {
            return {
              success: false,
              error: new Error(JSON.stringify(validator.errors)),
            };
          }
          return {
            success: true,
            value,
          };
        },
      }),
      maxOutputTokens: params.maxTokens,
      // The AI SDK otherwise sleeps and sends the request again twice before
      // reporting a failure, and reports it wrapped in an error that carries
      // no status. One attempt leaves the decision to retry with the caller.
      maxRetries: 0,
      // Registering a telemetry integration turns span collection on for every
      // AI SDK call. This route has never emitted AI SDK spans, so it opts out.
      telemetry: { isEnabled: false },
      ...(params.system && { system: params.system }),
    });

    return {
      object: object as Record<string, unknown>,
      id: spanId,
    };
  } catch (error) {
    console.error("Error generating object:", error);
    throw error instanceof Error
      ? error
      : new Error(`Failed to generate object: ${error}`);
  }
}
