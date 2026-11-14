import { cors } from "@hono/hono/cors";
import { createFalClient } from "@fal-ai/client";

import {
  createVoiceHandlers,
  type VoiceHandlerDeps,
} from "./voice.handlers.ts";
import * as routes from "./voice.routes.ts";
import env from "@/env.ts";
import { createRouter } from "@/lib/create-app.ts";

export function createVoiceRouter(deps: VoiceHandlerDeps) {
  const router = createRouter();
  router.use(
    "/api/ai/voice/*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Content-Length", "X-Disk-Cache"],
      maxAge: 3600,
      credentials: true,
    }),
  );

  return router.openapi(
    routes.transcribeVoice,
    createVoiceHandlers(deps).transcribeVoice,
  );
}

export default createVoiceRouter({
  client: createFalClient({ credentials: env.FAL_API_KEY }),
  cacheDir: `${env.CACHE_DIR}/ai-voice`,
});
