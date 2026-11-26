import { cors } from "@hono/hono/cors";
import { createFalClient } from "@fal-ai/client";

import { createImageHandlers, type ImageHandlerDeps } from "./img.handlers.ts";
import * as routes from "./img.routes.ts";
import env from "@/env.ts";
import { createRouter } from "@/lib/create-app.ts";

export function createImageRouter(deps: ImageHandlerDeps) {
  const handlers = createImageHandlers(deps);
  const router = createRouter();
  router.use(
    "/api/ai/img/*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Content-Length", "X-Disk-Cache"],
      maxAge: 3600,
      credentials: true,
    }),
  );

  return router
    .openapi(routes.generateImage, handlers.generateImage)
    .openapi(routes.generateImageAdvanced, handlers.generateImageAdvanced);
}

export default createImageRouter({
  client: createFalClient({ credentials: env.FAL_API_KEY }),
  // Looked up on each call, so the global `fetch` in place at request time
  // sends the request.
  fetch: (input, init) => fetch(input, init),
  cacheDir: `${env.CACHE_DIR}/ai-img`,
});
