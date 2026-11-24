/**
 * The response cache's policy. `requestsCaching()` reads an LLM request's
 * `cache` field, and `/api/ai/llm` acts on what it reads. The default the
 * field carries when a request leaves it out is part of what both POST routes
 * publish in their OpenAPI schemas, so it is pinned here at both levels.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { CACHE_DIR, requestsCaching } from "./cache.ts";
import { diskResponseCache } from "./llm.handlers.ts";
import { createLLMRouter } from "./llm.router.ts";
import { registryWith } from "@/test/fixtures/llm-models.ts";

const MOCK_MODEL_NAME = "mock:cache-model";

/** A model that answers with the number of times it has been asked. */
function countingModel(): { model: LanguageModel; asked: () => number } {
  let asked = 0;
  const model = new MockLanguageModelV4({
    doStream: () => {
      asked += 1;
      const answer = `Answer ${asked}`;
      return Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({ type: "text-delta", id: "1", delta: answer });
            controller.enqueue({ type: "text-end", id: "1" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      });
    },
  });
  return { model, asked: () => asked };
}

/** The names of the files the response cache is holding right now. */
async function cachedFiles(): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    for await (const entry of Deno.readDir(CACHE_DIR)) names.add(entry.name);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names;
}

/**
 * Runs `body` with a poster for routes serving `model` alone over the disk
 * cache, then removes whatever `body` left in the response cache.
 */
async function withMockModel<T>(
  model: LanguageModel,
  body: (post: (requestBody: unknown) => Promise<Posted>) => Promise<T>,
): Promise<T> {
  const router = createLLMRouter({
    models: registryWith(MOCK_MODEL_NAME, model),
    cache: diskResponseCache,
  });
  const post = async (requestBody: unknown): Promise<Posted> => {
    const response = await router.request("/api/ai/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    return {
      status: response.status,
      content: (await response.json()).content,
    };
  };
  const before = await cachedFiles();
  try {
    return await body(post);
  } finally {
    for (const name of await cachedFiles()) {
      if (!before.has(name)) await Deno.remove(`${CACHE_DIR}/${name}`);
    }
  }
}

/** The status of a response and the message content it carried. */
type Posted = { status: number; content: unknown };

describe("cache", () => {
  describe("requestsCaching()", () => {
    it("returns `true` for a request that leaves `cache` out", () => {
      expect(requestsCaching({})).toBe(true);
    });

    it("returns `true` for `cache: true`", () => {
      expect(requestsCaching({ cache: true })).toBe(true);
    });

    it("returns `false` for `cache: false`", () => {
      expect(requestsCaching({ cache: false })).toBe(false);
    });
  });

  describe("POST /api/ai/llm", () => {
    // Each case sends a conversation no earlier run can have sent, so what it
    // finds in the cache is only what it put there.

    it("answers an identical second request without asking the model again", async () => {
      const { model, asked } = countingModel();
      await withMockModel(model, async (post) => {
        const request = {
          model: MOCK_MODEL_NAME,
          messages: [{ role: "user", content: `Hi ${crypto.randomUUID()}` }],
        };
        const first = await post(request);
        const second = await post(request);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.content).toEqual(first.content);
        expect(asked()).toBe(1);
      });
    });

    it("asks the model again for a request that sets `cache` to `false`", async () => {
      const { model, asked } = countingModel();
      await withMockModel(model, async (post) => {
        const request = {
          model: MOCK_MODEL_NAME,
          messages: [{ role: "user", content: `Hi ${crypto.randomUUID()}` }],
          cache: false,
        };
        const first = await post(request);
        const second = await post(request);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.content).not.toEqual(first.content);
        expect(asked()).toBe(2);
      });
    });
  });
});
