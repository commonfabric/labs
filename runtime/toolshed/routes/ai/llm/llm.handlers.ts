import { type BuiltInLLMMessage } from "@commonfabric/api";
import {
  type LLMGenerateObjectRequest,
  llmGenerateObjectRequestProblem,
  type LLMRequest,
  llmRequestProblem,
} from "@commonfabric/llm/types";
import type { Context } from "@hono/hono";
import * as HttpStatusCodes from "stoker/http-status-codes";

import {
  CacheItem,
  hashKey,
  loadFromCache,
  requestsCaching,
  saveToCache,
} from "./cache.ts";
import { httpStatusForError } from "./errors.ts";
import { generateObject as generateObjectCore } from "./generateObject.ts";
import { generateText as generateTextCore } from "./generateText.ts";
import type {
  GenerateObjectRoute,
  GenerateTextRoute,
  GetModelsRoute,
} from "./llm.routes.ts";
import {
  ALIAS_NAMES,
  findModel,
  ModelList,
  MODELS,
  resolveModel,
  TASK_MODELS,
  whenModelsReady,
} from "./models.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

const removeNonCacheableFields = (
  obj: object,
): CacheItem => {
  const { cache: _cache, metadata: _metadata, ...rest } = obj as Record<
    string,
    unknown
  >;
  // FIXME: typing
  // No guarantee that `messages` exists here.
  return rest as unknown as CacheItem;
};

/**
 * Reads the request body as JSON. A body that is not JSON at all reaches the
 * framework as a failure with no status of its own, so it is caught here.
 */
async function readJsonBody(
  c: Context,
): Promise<{ ok: true; payload: any } | { ok: false; error: string }> {
  try {
    return { ok: true, payload: await c.req.json() };
  } catch (error) {
    return {
      ok: false,
      error: `Request body is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Validates that the model and JSON mode settings are compatible
 * @returns An error response object if validation fails, or null if validation passes
 */
async function validateModelAndJsonMode(
  c: Context,
  modelString: string | undefined,
  mode: string | undefined,
) {
  const model = modelString ? await resolveModel(modelString) : null;

  if (!model) {
    return c.json(
      {
        error:
          `Unknown model '${modelString}'. GET /api/ai/llm/models for available models.`,
      },
      HttpStatusCodes.BAD_REQUEST,
    );
  }

  // Validate JSON mode support if requested
  const isJsonMode = mode === "json";

  // Groq models don't support streaming with JSON mode
  if (
    isJsonMode && c.req.query("stream") === "true" &&
    modelString?.startsWith("groq:")
  ) {
    return c.json(
      {
        error:
          "Groq models don't support streaming in JSON mode. Please set stream to false.",
      },
      HttpStatusCodes.BAD_REQUEST,
    );
  }

  return null;
}

/**
 * Handler for GET /models endpoint
 * Returns filtered list of available LLM models based on search criteria
 */
export const getModels: AppRouteHandler<GetModelsRoute> = async (c) => {
  // The list is what this route answers for, so it waits for the whole of it.
  // A route naming one model asks `resolveModel`, which waits only when the
  // name is not registered yet; there is no such shortcut for all of them, and
  // a list quietly missing every gateway model is a wrong answer rather than
  // an early one.
  await whenModelsReady();
  const { search, capability, task } = c.req.query();
  const capabilities = capability?.split(",");

  const modelInfo = Object.entries(MODELS).reduce(
    (acc, [name, modelConfig]) => {
      // Skip alias names, we only want primary model names
      if (!ALIAS_NAMES.includes(name)) {
        // Apply filters: name search, capabilities, and task matching
        const nameMatches = !search ||
          name.toLowerCase().includes(search.toLowerCase());
        const capabilitiesMatch = !capabilities ||
          capabilities.every(
            (cap) =>
              modelConfig
                .capabilities[cap as keyof typeof modelConfig.capabilities],
          );
        const taskMatches = !task ||
          TASK_MODELS[task as keyof typeof TASK_MODELS] === name;

        // Include model if it passes all filters
        if (nameMatches && capabilitiesMatch && taskMatches) {
          acc[name] = {
            name,
            model: modelConfig.model,
            capabilities: modelConfig.capabilities,
            aliases: Object.entries(MODELS)
              .filter(([_, m]) => m === modelConfig && name !== _)
              .map(([alias]) => alias),
          };
        }
      }
      return acc;
    },
    {} as ModelList,
  );

  return c.json(modelInfo);
};

/**
 * Handler for POST / endpoint
 * Generates text using specified LLM model or task
 */
export const generateText: AppRouteHandler<GenerateTextRoute> = async (c) => {
  const body = await readJsonBody(c);
  if (!body.ok) {
    return c.json({ error: body.error }, HttpStatusCodes.BAD_REQUEST);
  }
  const problem = llmRequestProblem(body.payload);
  if (problem !== undefined) {
    return c.json(
      { error: `Invalid request: ${problem}` },
      HttpStatusCodes.BAD_REQUEST,
    );
  }
  // `llmRequestProblem()` answering `undefined` is what makes this hold, and
  // it is the only thing that does: `body.payload` is whatever the JSON
  // parser returned.
  const payload: LLMRequest = body.payload;

  if (!payload.metadata) {
    payload.metadata = {};
  }

  const user = c.req.header("Tailscale-User-Login");
  if (user) {
    payload.metadata.user = user;
  }

  // Enable caching for deterministic requests including client-side tools.
  // With the sequential request architecture, each request includes complete context
  // (including tool results from previous rounds), making each response cacheable.
  //
  // Cache key naturally includes:
  // - Original user message
  // - Tool definitions
  // - Tool results (in messages array for subsequent rounds)
  // - Full conversation history
  //
  // Provider-native tools such as Google Search are intentionally time-sensitive.
  // Treat them as live requests until we have a freshness-aware cache policy.
  const shouldCache = requestsCaching(payload) &&
    (payload.nativeModelToolIds?.length ?? 0) === 0;

  let cacheKey: string | undefined;
  if (shouldCache) {
    cacheKey = await hashKey(
      JSON.stringify(removeNonCacheableFields(payload)),
    );
    // First, check whether the request is cached, if so return the cached result
    const cachedResult = await loadFromCache(cacheKey);
    if (cachedResult) {
      const lastMessage =
        cachedResult.messages[cachedResult.messages.length - 1];
      return c.json(lastMessage);
    }
  }

  const persistCache = async (
    messages: BuiltInLLMMessage[],
  ) => {
    if (!shouldCache || !cacheKey) {
      return;
    }
    try {
      await saveToCache(cacheKey, {
        ...removeNonCacheableFields(payload),
        messages,
      });
    } catch (e) {
      console.error("Error saving response to cache:", e);
    }
  };

  const validationError = await validateModelAndJsonMode(
    c,
    payload.model,
    payload.mode,
  );
  if (validationError) {
    return validationError;
  }

  const model = findModel(payload.model);
  payload.metadata.model = model.name;
  payload.maxTokens = payload.maxTokens ||
    model?.capabilities.maxOutputTokens || 8000;

  try {
    const result = await generateTextCore({
      ...payload,
      abortSignal: c.req.raw.signal,
      // If response is streaming, save to cache after the stream is complete
      onStreamComplete: async (result) => await persistCache(result.messages),
    });

    // If response is not streaming, save to cache and return the message
    if (!payload.stream) {
      await persistCache(result.messages);
      const response = c.json(result.message);
      if (result.spanId) {
        response.headers.set("x-cf-llm-trace-id", result.spanId);
      }
      return response;
    }

    return new Response(result.stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...(result.spanId ? { "x-cf-llm-trace-id": result.spanId } : {}),
      },
    });
  } catch (error) {
    console.error("Error in generateText:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, httpStatusForError(error));
  }
};

/**
 * Handler for POST /generateObject endpoint
 * Generates structured JSON objects using specified LLM model
 */
export const generateObject: AppRouteHandler<GenerateObjectRoute> = async (
  c,
) => {
  const body = await readJsonBody(c);
  if (!body.ok) {
    return c.json({ error: body.error }, HttpStatusCodes.BAD_REQUEST);
  }
  const problem = llmGenerateObjectRequestProblem(body.payload);
  if (problem !== undefined) {
    return c.json(
      { error: `Invalid request: ${problem}` },
      HttpStatusCodes.BAD_REQUEST,
    );
  }
  // `llmGenerateObjectRequestProblem()` answering `undefined` is what makes
  // this hold, and it is the only thing that does: `body.payload` is whatever
  // the JSON parser returned.
  const payload: LLMGenerateObjectRequest = body.payload;

  if (!payload.metadata) {
    payload.metadata = {};
  }

  const user = c.req.header("Tailscale-User-Login");
  if (user) {
    payload.metadata.user = user;
  }

  const cacheKey = await hashKey(
    JSON.stringify(removeNonCacheableFields(payload)),
  );
  const shouldCache = requestsCaching(payload);

  // Check cache if enabled
  if (shouldCache) {
    const cachedResult = await loadFromCache(cacheKey);
    if (cachedResult) {
      return c.json({
        object: cachedResult.object,
      }, HttpStatusCodes.OK);
    }
  }

  try {
    const result = await generateObjectCore(payload);

    // Save to cache if enabled
    if (shouldCache) {
      try {
        await saveToCache(cacheKey, {
          ...removeNonCacheableFields(payload),
          object: result.object,
        });
      } catch (e) {
        console.error("Error saving generateObject response to cache:", e);
      }
    }

    return c.json(result, HttpStatusCodes.OK);
  } catch (error) {
    console.error("Error in generateObject:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, httpStatusForError(error));
  }
};
