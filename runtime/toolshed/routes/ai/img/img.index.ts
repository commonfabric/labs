import { cors } from "@hono/hono/cors";

import * as handlers from "./img.handlers.ts";
import * as routes from "./img.routes.ts";
import { createRouter } from "@/lib/create-app.ts";

const router = createRouter()
  .openapi(routes.generateImage, handlers.generateImage)
  .openapi(routes.generateImageAdvanced, handlers.generateImageAdvanced);

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

export default router;
