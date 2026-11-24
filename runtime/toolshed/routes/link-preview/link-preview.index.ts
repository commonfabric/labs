import { cors } from "@hono/hono/cors";

import {
  createLinkPreviewHandlers,
  type LinkPreviewHandlerDeps,
} from "./link-preview.handlers.ts";
import * as routes from "./link-preview.routes.ts";
import env from "@/env.ts";
import { createRouter } from "@/lib/create-app.ts";

export function createLinkPreviewRouter(deps: LinkPreviewHandlerDeps) {
  const router = createRouter();

  router.use(
    "/api/link-preview/*",
    cors({
      origin: "*",
      allowMethods: ["GET", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      exposeHeaders: ["Content-Length", "X-Disk-Cache"],
      maxAge: 3600,
    }),
  );

  router.openapi(
    routes.getLinkPreview,
    createLinkPreviewHandlers(deps).getLinkPreview,
  );

  return router;
}

export default createLinkPreviewRouter({
  // Looked up on each call, so the global `fetch` in place at request time
  // sends the request.
  fetch: (input, init) => fetch(input, init),
  jinaApiKey: env.JINA_API_KEY,
  cacheDir: `${env.CACHE_DIR}/link-preview`,
});
