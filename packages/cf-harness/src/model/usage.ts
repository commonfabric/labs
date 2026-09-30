import {
  isObjectNotArray,
  type ReadonlyRecord,
} from "@commonfabric/utils/types";

import {
  HARNESS_COST_ESTIMATE_WITHHELD_REASONS,
  HARNESS_MODEL_USAGE_NUMERIC_FIELDS,
  type HarnessCostEstimateWithheldReason,
  type HarnessModelUsage,
} from "./client.ts";

const finiteNonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const recordValue = (value: unknown): ReadonlyRecord | undefined =>
  isObjectNotArray(value) ? value : undefined;

/** Reads recognized, valid usage fields from a stored run report. */
export const readHarnessModelUsage = (
  value: unknown,
): HarnessModelUsage | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const usage: HarnessModelUsage = {};
  for (const field of HARNESS_MODEL_USAGE_NUMERIC_FIELDS) {
    const number = finiteNonNegativeNumber(value[field]);
    if (number !== undefined) usage[field] = number;
  }
  const reason = HARNESS_COST_ESTIMATE_WITHHELD_REASONS.find((reason) =>
    reason === value.estimateWithheldReason
  );
  if (reason !== undefined) usage.estimateWithheldReason = reason;
  return Object.keys(usage).length > 0 ? usage : undefined;
};

const firstNumber = (
  record: ReadonlyRecord,
  names: readonly string[],
): number | undefined => {
  for (const name of names) {
    const value = finiteNonNegativeNumber(record[name]);
    if (value !== undefined) return value;
  }
  return undefined;
};

/**
 * Normalizes usage returned by either the Responses API or Chat Completions.
 */
export const normalizeOpenAIUsage = (
  usage: ReadonlyRecord | undefined,
): HarnessModelUsage | undefined => {
  if (usage === undefined) return undefined;
  const inputDetails = recordValue(
    usage.input_tokens_details ?? usage.prompt_tokens_details,
  );
  const outputDetails = recordValue(
    usage.output_tokens_details ?? usage.completion_tokens_details,
  );
  const inputTokens = firstNumber(usage, ["input_tokens", "prompt_tokens"]);
  const cachedInputTokens = inputDetails === undefined
    ? undefined
    : firstNumber(inputDetails, ["cached_tokens"]);
  const cacheWriteTokens = inputDetails === undefined
    ? undefined
    : firstNumber(inputDetails, ["cache_write_tokens"]);
  const outputTokens = firstNumber(usage, [
    "output_tokens",
    "completion_tokens",
  ]);
  const reasoningTokens = outputDetails === undefined
    ? undefined
    : firstNumber(outputDetails, ["reasoning_tokens"]);
  const totalTokens = firstNumber(usage, ["total_tokens"]);
  const costUsd = firstNumber(usage, ["cost_usd"]);
  const normalized: HarnessModelUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

/**
 * Sums reported token fields while preserving "not reported" as absent.
 *
 * Cost fields are all-or-nothing: a partial cost would look like the whole
 * run's cost, so they are omitted unless every entry reports them.
 */
export const sumHarnessModelUsage = (
  entries: readonly (HarnessModelUsage | undefined)[],
): HarnessModelUsage | undefined => {
  const reportedEntries = entries.filter(
    (entry): entry is HarnessModelUsage => entry !== undefined,
  );
  const total: HarnessModelUsage = {};
  for (const field of HARNESS_MODEL_USAGE_NUMERIC_FIELDS) {
    const values = reportedEntries.flatMap((entry) => {
      const value = entry[field];
      return value === undefined ? [] : [value];
    });
    const requiresCompleteCoverage = field === "costUsd" ||
      field === "estimatedCostUsd";
    if (
      values.length > 0 &&
      (!requiresCompleteCoverage ||
        values.length === entries.length)
    ) {
      total[field] = values.reduce((sum, value) => sum + value, 0);
    }
  }
  if (
    reportedEntries.length > 0 &&
    reportedEntries.length === entries.length &&
    reportedEntries.every((entry) => entry.estimatedCostUsd !== undefined)
  ) {
    // Every estimate was summed above, so no withheld reason applies.
  } else if (entries.length > 0) {
    const reasons = reportedEntries.flatMap((entry) =>
      entry.estimateWithheldReason === undefined
        ? []
        : [entry.estimateWithheldReason]
    );
    total.estimateWithheldReason =
      reasons.length === entries.length && new Set(reasons).size === 1
        ? reasons[0]
        : "incomplete-estimates";
  }
  return Object.keys(total).length > 0 ? total : undefined;
};

interface OpenAIModelTokenPrices {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

const OPENAI_MODEL_TOKEN_PRICES: Record<string, OpenAIModelTokenPrices> = {
  "gpt-5.6": {
    inputPerMillionUsd: 5,
    cachedInputPerMillionUsd: 0.5,
    outputPerMillionUsd: 30,
  },
  "gpt-5.6-sol": {
    inputPerMillionUsd: 5,
    cachedInputPerMillionUsd: 0.5,
    outputPerMillionUsd: 30,
  },
  "gpt-5.6-terra": {
    inputPerMillionUsd: 2.5,
    cachedInputPerMillionUsd: 0.25,
    outputPerMillionUsd: 15,
  },
  "gpt-5.6-luna": {
    inputPerMillionUsd: 1,
    cachedInputPerMillionUsd: 0.1,
    outputPerMillionUsd: 6,
  },
};

type OpenAICostEstimateResult =
  | { estimatedCostUsd: number }
  | { estimateWithheldReason: HarnessCostEstimateWithheldReason };

const estimateOpenAIModelUsageCost = (
  model: string,
  usage: HarnessModelUsage | undefined,
): OpenAICostEstimateResult => {
  const prices = OPENAI_MODEL_TOKEN_PRICES[model];
  if (prices === undefined) {
    return { estimateWithheldReason: "unknown-model" };
  }
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
    return { estimateWithheldReason: "missing-token-counts" };
  }
  if (
    usage.cachedInputTokens === undefined ||
    usage.cacheWriteTokens === undefined
  ) {
    return { estimateWithheldReason: "missing-cache-detail" };
  }
  const tokenCounts = [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
    ...(usage.reasoningTokens === undefined ? [] : [usage.reasoningTokens]),
    ...(usage.totalTokens === undefined ? [] : [usage.totalTokens]),
  ];
  if (
    tokenCounts.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    return { estimateWithheldReason: "invalid-token-counts" };
  }
  // OpenAI reports cache reads and cache writes as disjoint subsets of input
  // tokens. Anthropic-style additive cache-creation accounting would require a
  // different estimator.
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens -
    usage.cacheWriteTokens;
  if (uncachedInputTokens < 0) {
    return { estimateWithheldReason: "inconsistent-token-counts" };
  }
  if (
    usage.totalTokens !== undefined &&
    usage.totalTokens !== usage.inputTokens + usage.outputTokens
  ) {
    return { estimateWithheldReason: "inconsistent-token-counts" };
  }
  if (
    usage.reasoningTokens !== undefined &&
    usage.reasoningTokens > usage.outputTokens
  ) {
    return { estimateWithheldReason: "inconsistent-token-counts" };
  }
  // The GPT-5.6 model pages apply these multipliers to the full request above
  // 272K input tokens.
  const longContextInputMultiplier = usage.inputTokens > 272_000 ? 2 : 1;
  const longContextOutputMultiplier = usage.inputTokens > 272_000 ? 1.5 : 1;
  return {
    estimatedCostUsd: (
      (
          uncachedInputTokens * prices.inputPerMillionUsd +
          usage.cachedInputTokens * prices.cachedInputPerMillionUsd +
          usage.cacheWriteTokens * prices.inputPerMillionUsd * 1.25
        ) * longContextInputMultiplier +
      usage.outputTokens * prices.outputPerMillionUsd *
        longContextOutputMultiplier
    ) / 1_000_000,
  };
};

/**
 * Estimates GPT-5.6 token cost from the public OpenAI price schedule.
 *
 * Source: https://developers.openai.com/api/docs/models (verified 2026-07-30).
 *
 * Cache writes are priced at 1.25x uncached input. An estimate is withheld
 * unless the response reports both cache reads and writes, since treating
 * missing cache detail as zero would make a cache experiment misleading.
 */
export const estimateOpenAIModelUsageCostUsd = (
  model: string,
  usage: HarnessModelUsage | undefined,
): number | undefined => {
  const estimate = estimateOpenAIModelUsageCost(model, usage);
  return "estimatedCostUsd" in estimate ? estimate.estimatedCostUsd : undefined;
};

export const withEstimatedOpenAIModelUsageCost = (
  model: string,
  usage: HarnessModelUsage | undefined,
): HarnessModelUsage | undefined => {
  if (usage === undefined) return undefined;
  const estimate = estimateOpenAIModelUsageCost(model, usage);
  const {
    estimatedCostUsd: _estimatedCostUsd,
    estimateWithheldReason: _estimateWithheldReason,
    ...reportedUsage
  } = usage;
  return { ...reportedUsage, ...estimate };
};
