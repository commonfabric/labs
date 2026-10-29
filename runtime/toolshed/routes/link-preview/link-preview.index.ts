import { cors } from "@hono/hono/cors";

import * as handlers from "./link-preview.handlers.ts";
import * as routes from "./link-preview.routes.ts";
import { createRouter } from "@/lib/create-app.ts";

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

router.openapi(routes.getLinkPreview, handlers.getLinkPreview);

export default router;
