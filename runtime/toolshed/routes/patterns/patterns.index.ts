import { cors } from "@hono/hono/cors";

import * as handlers from "./patterns.handlers.ts";
import * as routes from "./patterns.routes.ts";
import { createRouter } from "@/lib/create-app.ts";

const router = createRouter();

// Apply CORS middleware to all patterns routes
router.use(
  "/api/patterns/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

router.openapi(routes.getPattern, handlers.getPattern);

export default router;
