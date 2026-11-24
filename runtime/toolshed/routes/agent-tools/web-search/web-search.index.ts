import { createRouter } from "@/lib/create-app.ts";
import env from "@/env.ts";
import {
  createWebSearchHandlers,
  type WebSearchDeps,
} from "./web-search.handlers.ts";
import * as routes from "./web-search.routes.ts";
import { requireFirstPartyHttpAuth } from "@/middlewares/first-party-http-auth.ts";

/** Builds the web search router over `deps`, behind first-party auth. */
export function createWebSearchRouter(deps: WebSearchDeps) {
  const router = createRouter();
  router.use("/api/agent-tools/web-search/*", requireFirstPartyHttpAuth());

  router.openapi(routes.webSearch, createWebSearchHandlers(deps).webSearch);

  return router;
}

export default createWebSearchRouter({
  // Looked up on each call, so the global `fetch` in place at request time
  // sends the request.
  fetch: (input, init) => fetch(input, init),
  resolveDns: (host, recordType) => Deno.resolveDns(host, recordType),
  gatewayUrl: env.CFTS_AI_GATEWAY_URL,
  cacheDir: env.CACHE_DIR,
});
