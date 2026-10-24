import { cors } from "@hono/hono/cors";

import * as handlers from "./health.handlers.ts";
import * as routes from "./health.routes.ts";
import { createRouter } from "@/lib/create-app.ts";

const router = createRouter();

router.use(
  "/_health",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  }),
);

const Router = router
  .openapi(routes.index, handlers.index)
  .openapi(routes.stats, handlers.stats)
  .openapi(routes.documentInterests, handlers.documentInterests)
  .openapi(routes.dash, handlers.dash);

export default Router;
