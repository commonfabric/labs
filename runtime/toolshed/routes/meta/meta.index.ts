import { cors } from "@hono/hono/cors";
import { createRouter } from "@/lib/create-app.ts";

import * as handlers from "./meta.handlers.ts";
import * as routes from "./meta.routes.ts";

const router = createRouter();
router.use(
  routes.index.path,
  cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }),
);
router.openapi(routes.index, handlers.index);

export default router;
