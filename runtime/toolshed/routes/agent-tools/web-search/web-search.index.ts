import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./web-search.handlers.ts";
import * as routes from "./web-search.routes.ts";
import { requireFirstPartyHttpAuth } from "@/middlewares/first-party-http-auth.ts";

const router = createRouter();
const requireAuth = requireFirstPartyHttpAuth();

router.use("/api/agent-tools/web-search", requireAuth);
router.use("/api/agent-tools/web-search/*", requireAuth);

router.openapi(routes.webSearch, handlers.webSearch);

export default router;
