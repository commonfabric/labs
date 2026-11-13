import { createRouter } from "@/lib/create-app.ts";
import env from "@/env.ts";
import {
  createSandboxExecHandlers,
  type SandboxExecHandlerDeps,
} from "./exec.handlers.ts";
import * as routes from "./exec.routes.ts";
import { requireFirstPartyHttpAuth } from "@/middlewares/first-party-http-auth.ts";

export function createSandboxExecRouter(deps: SandboxExecHandlerDeps) {
  const router = createRouter();
  router.use("/api/sandbox/exec/*", requireFirstPartyHttpAuth());

  router.openapi(
    routes.sandboxExec,
    createSandboxExecHandlers(deps).sandboxExec,
  );

  return router;
}

export default createSandboxExecRouter({
  // Looked up on each call, so the global `fetch` in place at request time
  // sends the request.
  fetch: (input, init) => fetch(input, init),
  sandboxUrl: env.SANDBOX_SERVICE_URL,
  toolshedUrl: env.SANDBOX_TOOLSHED_URL || env.API_URL,
});
