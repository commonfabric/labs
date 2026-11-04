/** Known OpenAI reasoning-effort contracts shared by Responses adapters. */

import { debugStr } from "@commonfabric/data-model";

const GPT_5_6_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const GPT_6_1_SOL_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Returns known model efforts, or an empty list for an unknown vocabulary. */
export const supportedOpenAIReasoningEfforts = (
  model: string,
): readonly string[] =>
  model === "gpt-6.1-sol"
    ? GPT_6_1_SOL_REASONING_EFFORTS
    : model.startsWith("gpt-5.6")
    ? GPT_5_6_REASONING_EFFORTS
    : [];

/**
 * Rejects an explicit effort outside a known model's vocabulary. An omitted
 * effort uses the provider default; unknown models defer validation to it.
 */
export const assertOpenAIReasoningEffortSupported = (
  model: string,
  effort: string | undefined,
): void => {
  if (effort === undefined) return;
  const supported = supportedOpenAIReasoningEfforts(model);
  if (supported.length > 0 && !supported.includes(effort)) {
    throw new Error(
      debugStr`reasoning effort $quote${effort} is not supported by $quote${model}`,
    );
  }
};
