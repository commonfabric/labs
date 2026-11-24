import { createRouter } from "@/lib/create-app.ts";
import env from "@/env.ts";
import {
  createWebReadHandlers,
  type WebReadDeps,
} from "./web-read.handlers.ts";
import * as routes from "./web-read.routes.ts";
import { requireFirstPartyHttpAuth } from "@/middlewares/first-party-http-auth.ts";

/** Builds the web read router over `deps`, behind first-party auth. */
export function createWebReadRouter(deps: WebReadDeps) {
  const router = createRouter();
  router.use("/api/agent-tools/web-read/*", requireFirstPartyHttpAuth());

  router.openapi(routes.webRead, createWebReadHandlers(deps).webRead);

  return router;
}

export default createWebReadRouter({
  // Looked up on each call, so the global `fetch` in place at request time
  // sends the request.
  fetch: (input, init) => fetch(input, init),
  jinaApiKey: env.JINA_API_KEY,
  cacheDir: env.CACHE_DIR,
});
