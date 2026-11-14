/**
 * Model registries for the LLM route tests: built with no provider keys and no
 * gateway, holding only the mock models a test registers, so no test reaches
 * a provider.
 */

import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { CacheItem } from "@/routes/ai/llm/cache.ts";
import type { ResponseCache } from "@/routes/ai/llm/llm.handlers.ts";
import {
  type Capabilities,
  createModelRegistry,
  type ModelRegistry,
} from "@/routes/ai/llm/models.ts";

/** Capabilities that let a request through every capability check. */
export const MOCK_CAPABILITIES: Capabilities = {
  contextWindow: 1000,
  maxOutputTokens: 100,
  streaming: true,
  systemPrompt: true,
  stopSequences: true,
  prefill: false,
  images: false,
  reasoning: false,
};

/** A logger that keeps what it is given, for a test to read back. */
export function recordingLogger(): {
  log(line: string): void;
  warn(line: string): void;
  lines: string[];
  warnings: string[];
} {
  const lines: string[] = [];
  const warnings: string[] = [];
  return {
    log: (line) => lines.push(line),
    warn: (line) => warnings.push(line),
    lines,
    warnings,
  };
}

/** A fetch that fails the test that reached it. */
export const refusingFetch: typeof fetch = (input) => {
  throw new Error(`Unexpected fetch of ${String(input)}`);
};

/** A registry holding `model` under `name`, and nothing else. */
export function registryWith(
  name: string,
  model: LanguageModel,
  capabilities: Partial<Capabilities> = {},
): ModelRegistry {
  const registry = createModelRegistry({
    fetch: refusingFetch,
    logger: recordingLogger(),
  });
  registry.register({
    name,
    model,
    capabilities: { ...MOCK_CAPABILITIES, ...capabilities },
    aliases: [],
  });
  return registry;
}

/** A response cache held in memory, whose entries a test can read. */
export function memoryCache(): ResponseCache & {
  entries: Map<string, CacheItem>;
} {
  const entries = new Map<string, CacheItem>();
  return {
    entries,
    load: (key) => Promise.resolve(entries.get(key) ?? null),
    save: (key, item) => {
      entries.set(key, item);
      return Promise.resolve();
    },
  };
}

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that streams `text` and finishes for `reason`. */
export function textModel(
  text: string,
  reason: "stop" | "length" = "stop",
): MockLanguageModelV4 {
  return streamingModel([
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: text },
    { type: "text-end", id: "1" },
  ], reason);
}

type StreamPart = Parameters<
  ReadableStreamDefaultController<
    Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends
      ReadableStream<infer T> ? T : never
  >["enqueue"]
>[0];

/**
 * A model that streams `parts` between its stream start and a finish for
 * `reason`, answering every call the same way.
 */
export function streamingModel(
  parts: readonly StreamPart[],
  reason: "stop" | "length" | "tool-calls" = "stop",
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const part of parts) controller.enqueue(part);
            controller.enqueue({
              type: "finish",
              finishReason: { unified: reason, raw: reason },
              usage: USAGE,
            });
            controller.close();
          },
        }),
      }),
  });
}

/** A model that answers a generateObject call with `object` as JSON. */
export function objectModel(object: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(object) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      }),
  });
}
