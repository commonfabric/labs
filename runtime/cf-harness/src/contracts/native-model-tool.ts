/**
 * Native tool identities at the harness boundary. Subscription-only tools stay
 * here rather than expanding the gateway's shared LLM protocol.
 */
import type {
  LLMNativeModelToolId,
  LLMNativeModelToolResult,
} from "@commonfabric/llm/types";

/** Hosted web search using the run's existing Codex subscription. */
export const OPENAI_WEB_SEARCH_NATIVE_MODEL_TOOL = "openai_web_search" as const;

/** Native tools a harness provider can explicitly admit. */
export type HarnessNativeModelToolId =
  | LLMNativeModelToolId
  | typeof OPENAI_WEB_SEARCH_NATIVE_MODEL_TOOL;

/** A public URL cited by the search response. */
export interface HarnessWebSearchSource {
  url: string;
  title: string;
}

/** Search evidence retained independently of the assistant's text projection. */
export interface HarnessOpenAIWebSearchResult {
  type: "cf-harness.native-model-tool-result";
  toolId: typeof OPENAI_WEB_SEARCH_NATIVE_MODEL_TOOL;
  provider: "openai-codex";
  providerMetadata: { searchCalls: Record<string, unknown>[] };
  sources: HarnessWebSearchSource[];
}

/** Provider-native results carried by transcripts and delegated returns. */
export type HarnessNativeModelToolResult =
  | LLMNativeModelToolResult
  | HarnessOpenAIWebSearchResult;
