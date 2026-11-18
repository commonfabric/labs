import type { BuiltInLLMMessage } from "@commonfabric/api";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
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
import type { ModelList, ModelRegistry } from "./models.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

/** Where the routes keep the responses a request asked to have cached. */
export interface ResponseCache {
  load(key: string): Promise<CacheItem | null>;
  save(key: string, item: CacheItem): Promise<void>;
}

/** The response cache on disk under `CACHE_DIR`. */
export const diskResponseCache: ResponseCache = {
  load: loadFromCache,
  save: saveToCache,
};

export interface LLMHandlerDeps {
  models: ModelRegistry;
  cache: ResponseCache;
}

/** The request without the fields that do not decide its response. */
function removeNonCacheableFields<
  T extends { cache?: boolean; metadata?: unknown },
>({ cache: _cache, metadata: _metadata, ...rest }: T) {
  return rest;
}

/** The message a failed generation reports to the caller. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

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
      error: `Request body is not JSON: ${describeFailure(error)}`,
    };
  }
}

/**
 * The model a text request names, or the response refusing it: a name that is
 * no model, or JSON mode streamed from Groq, which Groq does not support.
 */
async function modelForTextRequest(
  c: Context,
  models: ModelRegistry,
  modelString: string | undefined,
  mode: string | undefined,
) {
  const model = modelString ? await models.resolve(modelString) : undefined;

  if (!model) {
    return {
      refusal: c.json(
        {
          error:
            `Unknown model '${modelString}'. GET /api/ai/llm/models for available models.`,
        },
        HttpStatusCodes.BAD_REQUEST,
      ),
    };
  }

  if (
    mode === "json" && c.req.query("stream") === "true" &&
    modelString?.startsWith("groq:")
  ) {
    return {
      refusal: c.json(
        {
          error:
            "Groq models don't support streaming in JSON mode. Please set stream to false.",
        },
        HttpStatusCodes.BAD_REQUEST,
      ),
    };
  }

  return { model };
}

/** The handlers for the LLM routes, serving the models in `deps.models`. */
export function createLLMHandlers({ models, cache }: LLMHandlerDeps): {
  getModels: AppRouteHandler<GetModelsRoute>;
  generateText: AppRouteHandler<GenerateTextRoute>;
  generateObject: AppRouteHandler<GenerateObjectRoute>;
} {
  return {
    /** Lists the models, narrowed by name, capability, and task. */
    getModels: async (c) => {
      // The list is what this route answers for, so it waits for the whole of
      // it. A route naming one model asks `models.resolve`, which waits only
      // when the name is not registered yet; there is no such shortcut for
      // all of them, and a list quietly missing every gateway model is a
      // wrong answer rather than an early one.
      await models.whenReady();
      const { search, capability, task } = c.req.query();
      const capabilities = capability?.split(",");

      const modelInfo: ModelList = {};
      for (const [name, modelConfig] of Object.entries(models.models)) {
        // Only primary names are listed; each carries its aliases.
        if (models.aliasNames.has(name)) continue;
        const nameMatches = !search ||
          name.toLowerCase().includes(search.toLowerCase());
        const capabilitiesMatch = !capabilities ||
          capabilities.every((cap) =>
            modelConfig
              .capabilities[cap as keyof typeof modelConfig.capabilities]
          );
        const taskMatches = !task ||
          models.taskModels[task as keyof typeof models.taskModels] === name;
        if (nameMatches && capabilitiesMatch && taskMatches) {
          modelInfo[name] = {
            name,
            model: modelConfig.model,
            capabilities: modelConfig.capabilities,
            aliases: Object.entries(models.models)
              .filter(([alias, m]) => m === modelConfig && alias !== name)
              .map(([alias]) => alias),
          };
        }
      }

      return c.json(modelInfo);
    },

    /** Generates text with the model the request names. */
    generateText: async (c) => {
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
      // `llmRequestProblem()` returning `undefined` is what makes this hold,
      // and it is the only thing that does: `body.payload` is whatever the
      // JSON parser returned.
      const payload: LLMRequest = body.payload;

      payload.metadata ??= {};
      const user = c.req.header("Tailscale-User-Login");
      if (user) {
        payload.metadata.user = user;
      }

      // Each request carries its complete context — the conversation, the
      // tool definitions, and the results of earlier tool rounds — so its
      // response is cacheable, client-side tools included.
      //
      // Provider-native tools such as Google Search are time-sensitive, so a
      // request using one is answered live.
      const cacheKey = requestsCaching(payload) &&
          (payload.nativeModelToolIds?.length ?? 0) === 0
        ? await hashKey(JSON.stringify(removeNonCacheableFields(payload)))
        : undefined;
      if (cacheKey !== undefined) {
        const cachedResult = await cache.load(cacheKey);
        if (cachedResult) {
          return c.json(
            cachedResult.messages[cachedResult.messages.length - 1],
          );
        }
      }

      const persistCache = async (messages: BuiltInLLMMessage[]) => {
        if (cacheKey === undefined) return;
        try {
          await cache.save(cacheKey, {
            ...removeNonCacheableFields(payload),
            messages,
          });
        } catch (e) {
          console.error("Error saving response to cache:", e);
        }
      };

      const { model, refusal } = await modelForTextRequest(
        c,
        models,
        payload.model,
        payload.mode,
      );
      if (refusal) {
        return refusal;
      }

      payload.metadata.model = model.name;
      payload.maxTokens ||= model.capabilities.maxOutputTokens || 8000;

      try {
        const result = await generateTextCore({
          ...payload,
          abortSignal: c.req.raw.signal,
          // A streamed response is cached once the stream is complete.
          onStreamComplete: (result) => persistCache(result.messages),
        }, models);

        const traceHeaders: Record<string, string> = result.spanId
          ? { "x-cf-llm-trace-id": result.spanId }
          : {};
        if (!payload.stream) {
          await persistCache(result.messages);
          return c.json(result.message, HttpStatusCodes.OK, traceHeaders);
        }

        return new Response(result.stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Transfer-Encoding": "chunked",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...traceHeaders,
          },
        });
      } catch (error) {
        console.error("Error in generateText:", error);
        return c.json(
          { error: errorMessage(error) },
          httpStatusForError(error),
        );
      }
    },

    /** Generates a JSON object satisfying the request's schema. */
    generateObject: async (c) => {
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
      // `llmGenerateObjectRequestProblem()` returning `undefined` is what
      // makes this hold, and it is the only thing that does: `body.payload` is
      // whatever the JSON parser returned.
      const payload: LLMGenerateObjectRequest = body.payload;

      payload.metadata ??= {};
      const user = c.req.header("Tailscale-User-Login");
      if (user) {
        payload.metadata.user = user;
      }

      const cacheKey = requestsCaching(payload)
        ? await hashKey(JSON.stringify(removeNonCacheableFields(payload)))
        : undefined;
      if (cacheKey !== undefined) {
        const cachedResult = await cache.load(cacheKey);
        if (cachedResult) {
          return c.json({ object: cachedResult.object }, HttpStatusCodes.OK);
        }
      }

      try {
        const result = await generateObjectCore(payload, models);
        if (cacheKey !== undefined) {
          try {
            await cache.save(cacheKey, {
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
        return c.json(
          { error: errorMessage(error) },
          httpStatusForError(error),
        );
      }
    },
  };
}
