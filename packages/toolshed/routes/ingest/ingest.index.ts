import { bodyLimit } from "@hono/hono/body-limit";
import { cors } from "@hono/hono/cors";

import * as handlers from "./ingest.handlers.ts";
import * as routes from "./ingest.routes.ts";
import { createRouter } from "@/lib/create-app.ts";

const router = createRouter();

// The data plane answers at two prefixes: with the channel's space in the
// path, which is the form mint and rotate hand out, and by channel id alone.
for (const prefix of ["/api/spaces/:space/ingest/*", "/api/ingest/*"]) {
  router.use(
    prefix,
    bodyLimit({
      maxSize: 1_000_000,
      onError: (c) => c.json({ error: "Payload too large (max 1MB)" }, 413),
    }),
  );

  router.use(
    prefix,
    cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Content-Length"],
      maxAge: 3600,
    }),
  );
}

export default router
  .openapi(routes.ingest, handlers.ingest)
  .openapi(routes.ingestById, handlers.ingestById);
