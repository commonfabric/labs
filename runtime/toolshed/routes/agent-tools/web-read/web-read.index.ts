import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./web-read.handlers.ts";
import * as routes from "./web-read.routes.ts";
import { requireFirstPartyHttpAuth } from "@/middlewares/first-party-http-auth.ts";

const router = createRouter();
const requireAuth = requireFirstPartyHttpAuth();

router.use("/api/agent-tools/web-read", requireAuth);
router.use("/api/agent-tools/web-read/*", requireAuth);

router.openapi(routes.webRead, handlers.webRead);

export default router;
