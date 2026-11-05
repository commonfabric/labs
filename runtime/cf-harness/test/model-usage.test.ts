import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  estimateOpenAIModelUsageCostUsd,
  normalizeOpenAIUsage,
  sumHarnessModelUsage,
  withEstimatedOpenAIModelUsageCost,
} from "../src/model/usage.ts";

Deno.test("normalizeOpenAIUsage maps Responses cache and reasoning details", () => {
  assertEquals(
    normalizeOpenAIUsage({
      input_tokens: 2_000,
      input_tokens_details: {
        cached_tokens: 1_200,
        cache_write_tokens: 600,
      },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 200 },
      total_tokens: 2_300,
      cost_usd: 0.0123,
    }),
    {
      inputTokens: 2_000,
      cachedInputTokens: 1_200,
      cacheWriteTokens: 600,
      outputTokens: 300,
      reasoningTokens: 200,
      totalTokens: 2_300,
      costUsd: 0.0123,
    },
  );
});

Deno.test("normalizeOpenAIUsage maps Chat Completions token names", () => {
  assertEquals(
    normalizeOpenAIUsage({
      prompt_tokens: 1_500,
      prompt_tokens_details: {
        cached_tokens: 1_024,
        cache_write_tokens: 0,
      },
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 40 },
      total_tokens: 1_600,
    }),
    {
      inputTokens: 1_500,
      cachedInputTokens: 1_024,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 40,
      totalTokens: 1_600,
    },
  );
});

Deno.test("sumHarnessModelUsage preserves absent fields", () => {
  assertEquals(
    sumHarnessModelUsage([
      { inputTokens: 10, cachedInputTokens: 0, outputTokens: 3 },
      { inputTokens: 20, cachedInputTokens: 12, outputTokens: 5 },
    ]),
    {
      inputTokens: 30,
      cachedInputTokens: 12,
      outputTokens: 8,
      estimateWithheldReason: "incomplete-estimates",
    },
  );
});

Deno.test("sumHarnessModelUsage never presents a partial cost as a total", () => {
  assertEquals(
    sumHarnessModelUsage([
      {
        inputTokens: 10,
        costUsd: 0.1,
        estimatedCostUsd: 0.08,
      },
      {
        inputTokens: 20,
        estimateWithheldReason: "missing-cache-detail",
      },
    ]),
    {
      inputTokens: 30,
      estimateWithheldReason: "incomplete-estimates",
    },
  );
  assertEquals(
    sumHarnessModelUsage([
      { costUsd: 0.1, estimatedCostUsd: 0.08 },
      { costUsd: 0.2, estimatedCostUsd: 0.16 },
    ]),
    { costUsd: 0.30000000000000004, estimatedCostUsd: 0.24 },
  );
});

Deno.test("GPT-5.6 Terra estimates distinguish reads, writes, and output", () => {
  assertEquals(
    estimateOpenAIModelUsageCostUsd("gpt-5.6-terra", {
      inputTokens: 2_000,
      cachedInputTokens: 1_200,
      cacheWriteTokens: 600,
      outputTokens: 300,
      reasoningTokens: 200,
      totalTokens: 2_300,
    }),
    (
      200 * 2.5 +
      1_200 * 0.25 +
      600 * 2.5 * 1.25 +
      300 * 15
    ) / 1_000_000,
  );
});

Deno.test("cost estimate is withheld when cache detail is unavailable", () => {
  assertEquals(
    estimateOpenAIModelUsageCostUsd("gpt-5.6-terra", {
      inputTokens: 2_000,
      outputTokens: 300,
    }),
    undefined,
  );
  assertEquals(
    withEstimatedOpenAIModelUsageCost("gpt-5.6-terra", {
      inputTokens: 2_000,
      outputTokens: 300,
    }),
    {
      inputTokens: 2_000,
      outputTokens: 300,
      estimateWithheldReason: "missing-cache-detail",
    },
  );
});

Deno.test("cost estimate is withheld for inconsistent cache detail", () => {
  assertEquals(
    estimateOpenAIModelUsageCostUsd("gpt-5.6-terra", {
      inputTokens: 1_000,
      cachedInputTokens: 800,
      cacheWriteTokens: 300,
      outputTokens: 100,
    }),
    undefined,
  );
});

Deno.test("cost estimate is withheld for inconsistent total usage", () => {
  assertEquals(
    estimateOpenAIModelUsageCostUsd("gpt-5.6-terra", {
      inputTokens: 1_000,
      cachedInputTokens: 500,
      cacheWriteTokens: 0,
      outputTokens: 100,
      totalTokens: 1_099,
    }),
    undefined,
  );
});

Deno.test("cost estimate is withheld for impossible reasoning usage", () => {
  assertEquals(
    estimateOpenAIModelUsageCostUsd("gpt-5.6-terra", {
      inputTokens: 1_000,
      cachedInputTokens: 500,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 101,
      totalTokens: 1_100,
    }),
    undefined,
  );
});

Deno.test("cost estimate is withheld for invalid token counts", () => {
  assertEquals(
    estimateOpenAIModelUsageCostUsd("gpt-5.6-terra", {
      inputTokens: 1_000.5,
      cachedInputTokens: 500,
      cacheWriteTokens: 0,
      outputTokens: 100,
    }),
    undefined,
  );
});

Deno.test("GPT-5.6 long-context pricing applies to the full request", () => {
  assertEquals(
    estimateOpenAIModelUsageCostUsd("gpt-5.6-terra", {
      inputTokens: 272_001,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
    }),
    (272_001 * 2.5 * 2 + 100 * 15 * 1.5) / 1_000_000,
  );
});

describe("current OpenAI model usage estimates", () => {
  it("estimates GPT-6.1 Sol prices for cached reads, writes, and long context", () => {
    expect(estimateOpenAIModelUsageCostUsd("gpt-6.1-sol", {
      inputTokens: 2_000,
      cachedInputTokens: 1_200,
      cacheWriteTokens: 600,
      outputTokens: 300,
    })).toBe(0.00502);
    expect(estimateOpenAIModelUsageCostUsd("gpt-6.1-sol", {
      inputTokens: 300_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 100_000,
      outputTokens: 1_000,
    })).toBe(0.935);
  });

  it("prices Luna 6 cache details and long context", () => {
    expect(estimateOpenAIModelUsageCostUsd("gpt-6-luna", {
      inputTokens: 2_000,
      cachedInputTokens: 1_200,
      cacheWriteTokens: 600,
      outputTokens: 300,
    })).toBe(0.000257);
    expect(estimateOpenAIModelUsageCostUsd("gpt-6-luna", {
      inputTokens: 300_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 100_000,
      outputTokens: 1_000,
    })).toBe(0.04775);
  });

  it("withholds a Sol 6.1 estimate when either token total is missing", () => {
    for (const usage of [{ inputTokens: 100 }, { outputTokens: 10 }]) {
      expect(withEstimatedOpenAIModelUsageCost("gpt-6.1-sol", usage))
        .toEqual({ ...usage, estimateWithheldReason: "missing-token-counts" });
    }
  });
});
