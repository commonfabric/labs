import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./exec.handlers.ts";
import * as routes from "./exec.routes.ts";
import { requireFirstPartyHttpAuth } from "@/middlewares/first-party-http-auth.ts";

const router = createRouter();
const requireAuth = requireFirstPartyHttpAuth();

router.use("/api/sandbox/exec", requireAuth);
router.use("/api/sandbox/exec/*", requireAuth);

router.openapi(routes.sandboxExec, handlers.sandboxExec);

export default router;
