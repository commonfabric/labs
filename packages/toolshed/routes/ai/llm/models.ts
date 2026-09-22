/**
 * The provider abstraction for language models: the model catalog, the
 * aliases, the capability records, the provider clients, and the chain that
 * decides what `default` means. A request names a model; this is where that
 * name becomes a provider to call.
 *
 * Which models a deployment has depends on the credentials it was configured
 * with and, for the gateway's, on what the gateway answers when asked. Both
 * are known only to this process, which is what keeps the catalog here rather
 * than in the caller's package. `docs/features/llm-provider-boundary.md` sets
 * out the boundary, and `packages/llm/README.md` redirects a reader who looked
 * in the caller's package first.
 */
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createVertex, vertex } from "@ai-sdk/google-vertex";
import { createGroq, groq } from "@ai-sdk/groq";
import { createOpenAI, openai } from "@ai-sdk/openai";
import {
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  isLLMNativeModelToolId,
  type LLMNativeModelToolId,
} from "@commonfabric/llm/types";
import type { LanguageModel } from "ai";

import env from "@/env.ts";
import {
  gatewayProvenanceHeaders,
  withGatewayProvenance,
} from "@/lib/gateway-provenance.ts";

export type Capabilities = {
  contextWindow: number;
  maxOutputTokens: number;
  streaming: boolean;
  systemPrompt: boolean;
  systemPromptWithImages?: boolean;
  stopSequences: boolean;
  prefill: boolean;
  images: boolean;
  reasoning: boolean;
  nativeModelToolIds?: LLMNativeModelToolId[];
};

//
// Gateway /v1/models response types
//

type GatewayModelCapabilities = {
  type?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  streaming?: boolean;
  systemPrompt?: boolean;
  stopSequences?: boolean;
  prefill?: boolean;
  images?: boolean;
  reasoning?: boolean;
  nativeModelToolIds?: string[];
};

type GatewayModel = {
  id: string;
  object: string;
  owned_by: string;
  capabilities: GatewayModelCapabilities;
};

type GatewayModelsResponse = {
  object: string;
  data: GatewayModel[];
};

export type ModelConfig = {
  model: LanguageModel;
  name: string;
  capabilities: Capabilities;
  aliases: string[];
  nativeModelToolFactories?: Partial<Record<LLMNativeModelToolId, () => any>>;
};

export type ModelList = Record<string, ModelConfig>;

// A registry with no prototype, so a name is registered here or it is not a
// model. A plain object answers a lookup for `constructor` or `toString` with
// something off `Object.prototype`, and a request naming one of those would be
// taken for a model and then fail on reading its capabilities, rather than
// being turned away as the unknown model it is.
export const MODELS: ModelList = Object.create(null);
export const ALIAS_NAMES: string[] = [];
export const PROVIDER_NAMES: Set<string> = new Set();

export type TaskType = "coding" | "json" | "creative" | "vision";

/**
 * Allowed defaults, in order. After provider discovery, the first registered
 * candidate wins; the default remains unavailable when none is registered.
 */
export const DEFAULT_MODEL_CANDIDATES = [
  "gateway:claude-sonnet-5",
  "gateway:gpt-5.6-luna",
  "gateway:gemini-3.5-flash",
] as const;

export const DEFAULT_MODEL_ALIAS = "default";

export const TASK_MODELS: Record<TaskType, string> = {
  coding: "anthropic:claude-sonnet-4-6", // Best for code
  json: "anthropic:claude-sonnet-4-6", // Fast & good at structured output
  creative: "openai:gpt-5", // Best for creative tasks
  vision: "google:gemini-3-preview-pro", // Best for vision tasks
};

const addModel = ({
  provider,
  name,
  aliases,
  capabilities,
  nativeModelToolFactories,
}: {
  provider:
    | typeof anthropic
    | typeof groq
    | typeof openai
    | typeof vertex;
  name: string;
  aliases: string[];
  capabilities: Capabilities;
  nativeModelToolFactories?: Partial<Record<LLMNativeModelToolId, () => any>>;
}) => {
  let modelName = name.includes(":")
    ? name.split(":").slice(1).join(":")
    : name;

  // AWS includes colons in their model names, so we need to special case it.
  if (name.includes("us.amazon")) {
    modelName = name;
  }

  const model = provider(modelName);

  const config: ModelConfig = {
    model,
    name,
    capabilities,
    aliases,
    ...(nativeModelToolFactories !== undefined
      ? { nativeModelToolFactories }
      : {}),
  };

  MODELS[name] = config;
  for (const alias of aliases) {
    MODELS[alias] = config;
    ALIAS_NAMES.push(alias);
  }
  PROVIDER_NAMES.add(name.split(":")[0]);
};

if (env.CFTS_AI_LLM_ANTHROPIC_API_KEY) {
  const anthropicProvider = createAnthropic({
    apiKey: env.CFTS_AI_LLM_ANTHROPIC_API_KEY,
  });
  console.log(" Adding 🤖 anthropic");

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-opus-4-1",
    aliases: ["anthropic:claude-opus-4-1-latest", "claude-opus-4-1"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 32000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-sonnet-4-0",
    aliases: ["anthropic:claude-sonnet-4-0-latest", "claude-sonnet-4-0"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 64000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-sonnet-4-5",
    aliases: ["sonnet-4-5", "sonnet-4.5"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 64000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-sonnet-4-6",
    aliases: ["sonnet-4-6", "sonnet-4.6"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 64000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-haiku-4-5",
    aliases: ["haiku-4-5", "haiku-4.5"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });
}

if (env.CFTS_AI_LLM_GROQ_API_KEY) {
  const groqProvider = createGroq({
    apiKey: env.CFTS_AI_LLM_GROQ_API_KEY,
  });
  console.log(" Adding 🤖 groq");

  addModel({
    provider: groqProvider,
    name: "groq:moonshotai/kimi-k2-instruct",
    aliases: ["groq:kimi-k2-instruct", "kimi-k2-instruct"],
    capabilities: {
      contextWindow: 131_072,
      maxOutputTokens: 16384,
      images: false,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: groqProvider,
    name: "groq:openai/gpt-oss-120b",
    aliases: ["groq:gpt-oss-120b", "gpt-oss-120b"],
    capabilities: {
      contextWindow: 131_072,
      maxOutputTokens: 65536,
      images: false,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });
}

if (env.CFTS_AI_LLM_OPENAI_API_KEY) {
  const openAIProvider = createOpenAI({
    apiKey: env.CFTS_AI_LLM_OPENAI_API_KEY,
  });
  console.log(" Adding 🤖 openai");
  addModel({
    provider: openAIProvider,
    name: "openai:gpt-5",
    aliases: ["openai:gpt-5-latest", "gpt-5"],
    capabilities: {
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      images: true,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:gpt-5-mini",
    aliases: ["openai:gpt-5-mini-latest", "gpt-5-mini"],
    capabilities: {
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      images: true,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });
}

if (env.CFTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS) {
  const credentials = JSON.parse(
    Deno.readTextFileSync(env.CFTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS),
  );
  console.log(" Adding 🤖 google");
  const vertexProvider = createVertex({
    googleAuthOptions: {
      credentials,
    },
    project: env.CFTS_AI_LLM_GOOGLE_VERTEX_PROJECT,
    location: env.CFTS_AI_LLM_GOOGLE_VERTEX_LOCATION,
  });
  const googleSearchNativeModelToolFactories = {
    [GOOGLE_SEARCH_NATIVE_MODEL_TOOL]: () =>
      vertexProvider.tools.googleSearch({}),
  };
  const googleSearchNativeModelToolIds: LLMNativeModelToolId[] = [
    GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  ];

  addModel({
    provider: vertexProvider,
    name: "google:gemini-3-pro-preview",
    aliases: ["gemini-3-pro", "gemini-3-pro-latest"],
    capabilities: {
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
    },
  });

  addModel({
    provider: vertexProvider,
    name: "google:gemini-3.5-flash",
    aliases: ["google:gemini-3.5-flash-latest", "gemini-3.5-flash"],
    capabilities: {
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
      nativeModelToolIds: googleSearchNativeModelToolIds,
    },
    nativeModelToolFactories: googleSearchNativeModelToolFactories,
  });

  addModel({
    provider: vertexProvider,
    name: "google:gemini-2.5-flash",
    aliases: ["google:gemini-2.5-flash-latest", "gemini-2.5-flash"],
    capabilities: {
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
      nativeModelToolIds: googleSearchNativeModelToolIds,
    },
    nativeModelToolFactories: googleSearchNativeModelToolFactories,
  });
}

async function loadGatewayModels() {
  const url = env.CFTS_AI_GATEWAY_URL.replace(/\/+$/, "");
  try {
    const res = await fetch(`${url}/v1/models`, {
      headers: gatewayProvenanceHeaders("list-models"),
    });

    if (!res.ok) {
      console.warn(
        `[gateway] Skipping gateway models: ${res.status} ${res.statusText} from ${url}`,
      );
      return;
    }

    const body: GatewayModelsResponse = await res.json();
    // Force HTTP/1.1 to avoid Deno HTTP/2 SSE streaming bug
    const http1Client = Deno.createHttpClient({ http2: false });
    // Every request through this provider reaches the gateway, so provenance
    // is attached here rather than at each call site: the gateway needs it to
    // attribute the request, and no vendor API is on the other end of it.
    const gatewayFetch: typeof fetch = withGatewayProvenance((input, init) => {
      return fetch(input, { ...init, client: http1Client } as RequestInit);
    });
    const gatewayProvider = createOpenAI({
      baseURL: `${url}/v1`,
      apiKey: "gateway-internal",
      name: "gateway",
      fetch: gatewayFetch,
    });

    let count = 0;
    for (const m of body.data) {
      // Skip image-generation models
      if (m.capabilities.type === "image-generation") continue;

      const primaryName = `gateway:${m.id}`;
      const capabilities: Capabilities = {
        contextWindow: m.capabilities.contextWindow ?? 128_000,
        maxOutputTokens: m.capabilities.maxOutputTokens ?? 4_096,
        streaming: m.capabilities.streaming ?? true,
        systemPrompt: m.capabilities.systemPrompt ?? true,
        stopSequences: m.capabilities.stopSequences ?? true,
        prefill: m.capabilities.prefill ?? false,
        images: m.capabilities.images ?? false,
        reasoning: m.capabilities.reasoning ?? false,
        nativeModelToolIds: m.capabilities.nativeModelToolIds?.filter(
          isLLMNativeModelToolId,
        ),
      };

      // Build aliases: bare model id + owned_by:model-id
      const aliases: string[] = [];
      if (!MODELS[m.id]) {
        aliases.push(m.id);
      }
      const ownerAlias = `${m.owned_by}:${m.id}`;
      if (!MODELS[ownerAlias]) {
        aliases.push(ownerAlias);
      }

      // Use .chat() to force /v1/chat/completions (not /v1/responses)
      addModel({
        provider: gatewayProvider.chat as typeof openai,
        name: primaryName,
        aliases,
        capabilities,
      });
      count++;
    }
    console.log(` Adding 🤖 gateway (${count} models from ${url})`);
  } catch (err) {
    // The gateway is only reachable on Tailscale; an unreachable URL is
    // expected off-network. Log as a warning and continue without gateway
    // models — direct provider entries (Anthropic, etc.) remain available.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[gateway] Could not reach ${url} (${message}); skipping gateway models.`,
    );
  }
}

export const findModel = (name: string) => {
  return MODELS[name];
};

/**
 * The model registered under `name`, waiting for gateway discovery only where
 * waiting could change the answer. A model a provider registered as this
 * module loaded is returned straight away, so a request for one of those is
 * served whatever the gateway is doing. A name that is not registered yet is
 * answered once discovery has finished, which is what a gateway model, the
 * `default` alias, and a name that is no model at all have in common.
 */
export async function resolveModel(
  name: string,
): Promise<ModelConfig | undefined> {
  const registered = MODELS[name];
  if (registered !== undefined) return registered;
  await modelsReady;
  return MODELS[name];
}

const registerDefaultModel = () => {
  const chosenName = DEFAULT_MODEL_CANDIDATES.find((name) => MODELS[name]);
  if (!chosenName) {
    console.warn(
      `[models] No default model available (tried ${
        DEFAULT_MODEL_CANDIDATES.join(", ")
      }).`,
    );
    return;
  }
  const chosen = MODELS[chosenName];
  MODELS[DEFAULT_MODEL_ALIAS] = chosen;
  ALIAS_NAMES.push(DEFAULT_MODEL_ALIAS);
  TASK_MODELS.coding = chosenName;
  TASK_MODELS.json = chosenName;
  console.log(` Default model: ${chosenName}`);
};

// Gateway model discovery is a network call to a host that answers only on
// Tailscale, and the list it returns is only needed by a request that names a
// model. It runs alongside the server coming up rather than in front of it, so
// a gateway that is slow to answer, or that never answers, delays no more than
// the requests that need what it says.
const modelsReady: Promise<void> = (async () => {
  if (env.CFTS_AI_GATEWAY_URL) {
    await loadGatewayModels();
  }
  registerDefaultModel();
})();

/**
 * Resolves once the model list holds everything it is going to hold. Await
 * this before reading {@link MODELS} whole; to answer for one model, prefer
 * {@link resolveModel}, which waits only where the answer is still open.
 */
export function whenModelsReady(): Promise<void> {
  return modelsReady;
}
