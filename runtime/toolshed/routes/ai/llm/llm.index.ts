import { diskResponseCache } from "./llm.handlers.ts";
import { createLLMRouter } from "./llm.router.ts";
import { createModelRegistry } from "./models.ts";
import env from "@/env.ts";

/**
 * The LLM routes this process serves, over the registry its configuration
 * describes. Building it starts gateway discovery.
 */
export default createLLMRouter({
  models: createModelRegistry({
    anthropicApiKey: env.CFTS_AI_LLM_ANTHROPIC_API_KEY,
    groqApiKey: env.CFTS_AI_LLM_GROQ_API_KEY,
    openaiApiKey: env.CFTS_AI_LLM_OPENAI_API_KEY,
    googleApplicationCredentials:
      env.CFTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS,
    googleVertexProject: env.CFTS_AI_LLM_GOOGLE_VERTEX_PROJECT,
    googleVertexLocation: env.CFTS_AI_LLM_GOOGLE_VERTEX_LOCATION,
    gatewayUrl: env.CFTS_AI_GATEWAY_URL,
    fetch: globalThis.fetch,
    logger: console,
  }),
  cache: diskResponseCache,
});
