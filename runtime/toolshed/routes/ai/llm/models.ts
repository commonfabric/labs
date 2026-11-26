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
 * out the boundary, and `base/llm/README.md` redirects a reader who looked
 * in the caller's package first.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createVertex } from "@ai-sdk/google-vertex";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import {
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  isLLMNativeModelToolId,
  type LLMNativeModelToolId,
} from "@commonfabric/llm/types";
import type { LanguageModel } from "ai";

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

const TASK_MODELS: Record<TaskType, string> = {
  coding: "anthropic:claude-sonnet-4-6", // Best for code
  json: "anthropic:claude-sonnet-4-6", // Fast & good at structured output
  creative: "openai:gpt-5", // Best for creative tasks
  vision: "google:gemini-3-pro-preview", // Best for vision tasks
};

//
// Direct provider catalogs
//

/** A model a provider offers, before it is bound to that provider's client. */
type CatalogEntry = Pick<ModelConfig, "name" | "aliases" | "capabilities">;

const ANTHROPIC_CAPABILITIES = {
  contextWindow: 200_000,
  images: true,
  prefill: true,
  systemPrompt: true,
  stopSequences: true,
  streaming: true,
  reasoning: false,
};

const ANTHROPIC_MODELS: readonly CatalogEntry[] = [
  {
    name: "anthropic:claude-opus-4-1",
    aliases: ["anthropic:claude-opus-4-1-latest", "claude-opus-4-1"],
    capabilities: { ...ANTHROPIC_CAPABILITIES, maxOutputTokens: 32000 },
  },
  {
    name: "anthropic:claude-sonnet-4-0",
    aliases: ["anthropic:claude-sonnet-4-0-latest", "claude-sonnet-4-0"],
    capabilities: { ...ANTHROPIC_CAPABILITIES, maxOutputTokens: 64000 },
  },
  {
    name: "anthropic:claude-sonnet-4-5",
    aliases: ["sonnet-4-5", "sonnet-4.5"],
    capabilities: { ...ANTHROPIC_CAPABILITIES, maxOutputTokens: 64000 },
  },
  {
    name: "anthropic:claude-sonnet-4-6",
    aliases: ["sonnet-4-6", "sonnet-4.6"],
    capabilities: { ...ANTHROPIC_CAPABILITIES, maxOutputTokens: 64000 },
  },
  {
    name: "anthropic:claude-haiku-4-5",
    aliases: ["haiku-4-5", "haiku-4.5"],
    capabilities: { ...ANTHROPIC_CAPABILITIES, maxOutputTokens: 8192 },
  },
];

const GROQ_CAPABILITIES = {
  contextWindow: 131_072,
  images: false,
  prefill: false,
  systemPrompt: true,
  stopSequences: true,
  streaming: true,
  reasoning: false,
};

const GROQ_MODELS: readonly CatalogEntry[] = [
  {
    name: "groq:moonshotai/kimi-k2-instruct",
    aliases: ["groq:kimi-k2-instruct", "kimi-k2-instruct"],
    capabilities: { ...GROQ_CAPABILITIES, maxOutputTokens: 16384 },
  },
  {
    name: "groq:openai/gpt-oss-120b",
    aliases: ["groq:gpt-oss-120b", "gpt-oss-120b"],
    capabilities: { ...GROQ_CAPABILITIES, maxOutputTokens: 65536 },
  },
];

const OPENAI_CAPABILITIES = {
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  images: true,
  prefill: false,
  systemPrompt: true,
  stopSequences: true,
  streaming: true,
  reasoning: false,
};

const OPENAI_MODELS: readonly CatalogEntry[] = [
  {
    name: "openai:gpt-5",
    aliases: ["openai:gpt-5-latest", "gpt-5"],
    capabilities: OPENAI_CAPABILITIES,
  },
  {
    name: "openai:gpt-5-mini",
    aliases: ["openai:gpt-5-mini-latest", "gpt-5-mini"],
    capabilities: OPENAI_CAPABILITIES,
  },
];

const GOOGLE_CAPABILITIES = {
  contextWindow: 1_000_000,
  images: true,
  prefill: true,
  systemPrompt: true,
  stopSequences: true,
  streaming: true,
  reasoning: true,
};

// The Gemini models listed with `nativeModelToolIds` are the ones that run
// Google Search for the caller.
const GOOGLE_MODELS: readonly CatalogEntry[] = [
  {
    name: "google:gemini-3-pro-preview",
    aliases: ["gemini-3-pro", "gemini-3-pro-latest"],
    capabilities: { ...GOOGLE_CAPABILITIES, maxOutputTokens: 65_536 },
  },
  {
    name: "google:gemini-3.5-flash",
    aliases: ["google:gemini-3.5-flash-latest", "gemini-3.5-flash"],
    capabilities: {
      ...GOOGLE_CAPABILITIES,
      maxOutputTokens: 8_192,
      nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
    },
  },
  {
    name: "google:gemini-2.5-flash",
    aliases: ["google:gemini-2.5-flash-latest", "gemini-2.5-flash"],
    capabilities: {
      ...GOOGLE_CAPABILITIES,
      maxOutputTokens: 8_192,
      nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
    },
  },
];

//
// The registry
//

/**
 * What a registry is built from. A provider whose key is absent or empty is
 * left out, and so is the gateway when its URL is.
 */
export interface ModelRegistryOptions {
  anthropicApiKey?: string;
  groqApiKey?: string;
  openaiApiKey?: string;
  /** The path of a Google service account key file, for Vertex. */
  googleApplicationCredentials?: string;
  googleVertexProject?: string;
  googleVertexLocation?: string;
  gatewayUrl?: string;
  /** Sends every request the providers make, gateway discovery included. */
  fetch: typeof fetch;
  logger: Pick<Console, "log" | "warn">;
}

export interface ModelRegistry {
  /**
   * Every registered name, primary and alias, mapped to its model. Await
   * {@link ModelRegistry.whenReady} before reading it whole.
   */
  readonly models: ModelList;
  /** The names in {@link ModelRegistry.models} that are aliases. */
  readonly aliasNames: ReadonlySet<string>;
  readonly taskModels: Readonly<Record<TaskType, string>>;
  /** Registers `config` under its name and each of its aliases. */
  register(config: ModelConfig): void;
  /**
   * The model registered under `name`, waiting for gateway discovery only
   * where waiting could change the answer. A model a provider registered as
   * the registry was built is returned straight away, so a request for one of
   * those is served whatever the gateway is doing. A name that is not
   * registered yet is answered once discovery has finished, which is what a
   * gateway model, the `default` alias, and a name that is no model at all
   * have in common.
   */
  resolve(name: string): Promise<ModelConfig | undefined>;
  /** Resolves once the model list holds everything it is going to hold. */
  whenReady(): Promise<void>;
}

/** The model id a provider knows `name` by: what follows its first colon. */
function providerModelId(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

export function createModelRegistry(
  options: ModelRegistryOptions,
): ModelRegistry {
  const { fetch, logger } = options;

  // A registry with no prototype, so a name is registered here or it is not a
  // model. A plain object answers a lookup for `constructor` or `toString`
  // with something off `Object.prototype`, and a request naming one of those
  // would be taken for a model and then fail on reading its capabilities,
  // rather than being turned away as the unknown model it is.
  const models: ModelList = Object.create(null);
  const aliasNames = new Set<string>();
  const taskModels = { ...TASK_MODELS };

  const register = (config: ModelConfig) => {
    models[config.name] = config;
    for (const alias of config.aliases) {
      models[alias] = config;
      aliasNames.add(alias);
    }
  };

  const registerCatalog = (
    provider: (modelId: string) => LanguageModel,
    catalog: readonly CatalogEntry[],
    nativeModelToolFactories?: ModelConfig["nativeModelToolFactories"],
  ) => {
    for (const entry of catalog) {
      register({
        ...entry,
        model: provider(providerModelId(entry.name)),
        ...(nativeModelToolFactories !== undefined &&
            entry.capabilities.nativeModelToolIds !== undefined
          ? { nativeModelToolFactories }
          : {}),
      });
    }
  };

  if (options.anthropicApiKey) {
    logger.log(" Adding 🤖 anthropic");
    registerCatalog(
      createAnthropic({ apiKey: options.anthropicApiKey, fetch }),
      ANTHROPIC_MODELS,
    );
  }

  if (options.groqApiKey) {
    logger.log(" Adding 🤖 groq");
    registerCatalog(
      createGroq({ apiKey: options.groqApiKey, fetch }),
      GROQ_MODELS,
    );
  }

  if (options.openaiApiKey) {
    logger.log(" Adding 🤖 openai");
    registerCatalog(
      createOpenAI({ apiKey: options.openaiApiKey, fetch }),
      OPENAI_MODELS,
    );
  }

  if (options.googleApplicationCredentials) {
    const credentials = JSON.parse(
      Deno.readTextFileSync(options.googleApplicationCredentials),
    );
    logger.log(" Adding 🤖 google");
    const vertexProvider = createVertex({
      googleAuthOptions: { credentials },
      project: options.googleVertexProject,
      location: options.googleVertexLocation,
      fetch,
    });
    registerCatalog(vertexProvider, GOOGLE_MODELS, {
      [GOOGLE_SEARCH_NATIVE_MODEL_TOOL]: () =>
        vertexProvider.tools.googleSearch({}),
    });
  }

  const loadGatewayModels = async (gatewayUrl: string) => {
    const url = gatewayUrl.replace(/\/+$/, "");
    try {
      const res = await fetch(`${url}/v1/models`, {
        headers: gatewayProvenanceHeaders("list-models"),
      });

      if (!res.ok) {
        logger.warn(
          `[gateway] Skipping gateway models: ${res.status} ${res.statusText} from ${url}`,
        );
        return;
      }

      const body: GatewayModelsResponse = await res.json();
      // Force HTTP/1.1 to avoid Deno HTTP/2 SSE streaming bug
      const http1Client = Deno.createHttpClient({ http2: false });
      // Every request through this provider reaches the gateway, so provenance
      // is attached here rather than at each call site: the gateway needs it
      // to attribute the request, and no vendor API is on the other end of it.
      const gatewayProvider = createOpenAI({
        baseURL: `${url}/v1`,
        apiKey: "gateway-internal",
        name: "gateway",
        fetch: withGatewayProvenance((input, init) =>
          fetch(input, { ...init, client: http1Client } as RequestInit)
        ),
      });

      let count = 0;
      for (const m of body.data) {
        // Skip image-generation models
        if (m.capabilities.type === "image-generation") continue;

        // Aliases: the bare model id and owned_by:model-id, where no model
        // registered so far holds either name.
        const aliases = [m.id, `${m.owned_by}:${m.id}`].filter((alias) =>
          models[alias] === undefined
        );

        register({
          // `.chat()` sends to /v1/chat/completions rather than /v1/responses.
          model: gatewayProvider.chat(m.id),
          name: `gateway:${m.id}`,
          aliases,
          capabilities: {
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
          },
        });
        count++;
      }
      logger.log(` Adding 🤖 gateway (${count} models from ${url})`);
    } catch (err) {
      // The gateway is only reachable on Tailscale; an unreachable URL is
      // expected off-network. Log as a warning and continue without gateway
      // models — direct provider entries (Anthropic, etc.) remain available.
      logger.warn(
        `[gateway] Could not reach ${url} (${
          describeFailure(err)
        }); skipping gateway models.`,
      );
    }
  };

  const registerDefaultModel = () => {
    const chosenName = DEFAULT_MODEL_CANDIDATES.find((name) => models[name]);
    if (!chosenName) {
      logger.warn(
        `[models] No default model available (tried ${
          DEFAULT_MODEL_CANDIDATES.join(", ")
        }).`,
      );
      return;
    }
    models[DEFAULT_MODEL_ALIAS] = models[chosenName];
    aliasNames.add(DEFAULT_MODEL_ALIAS);
    taskModels.coding = chosenName;
    taskModels.json = chosenName;
    logger.log(` Default model: ${chosenName}`);
  };

  // Gateway model discovery is a network call to a host that answers only on
  // Tailscale, and the list it returns is only needed by a request that names
  // a model. It runs alongside the server coming up rather than in front of
  // it, so a gateway that is slow to answer, or that never answers, delays no
  // more than the requests that need what it says.
  const ready: Promise<void> = (async () => {
    if (options.gatewayUrl) {
      await loadGatewayModels(options.gatewayUrl);
    }
    registerDefaultModel();
  })();

  return {
    models,
    aliasNames,
    taskModels,
    register,
    async resolve(name) {
      const registered = models[name];
      if (registered !== undefined) return registered;
      await ready;
      return models[name];
    },
    whenReady: () => ready,
  };
}
