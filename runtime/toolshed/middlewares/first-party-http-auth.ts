import type { MiddlewareHandler } from "@hono/hono";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { trace } from "@opentelemetry/api";
import type { AppBindings } from "@/lib/types.ts";

/**
 * Admit only a request carrying a valid first-party proof; the verified
 * DID lands on the context for the route's own authorization. A route
 * whose refusals carry a stable code passes the code its 401 should name,
 * so a client branches on it the way it branches on the route's others.
 */
export function requireFirstPartyHttpAuth(
  options: { code?: string } = {},
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    try {
      const { userDid } = await verifyFirstPartyHttpRequest({
        request: c.req.raw,
      });
      c.set("verifiedUserDid", userDid);
      // Enrich the active request span (started by the otel middleware, which
      // runs earlier in the chain) with the verified user. Defensive: no-op if
      // no span/provider is active.
      trace.getActiveSpan()?.setAttribute("user.did", userDid);
      // TODO(auth): Check that the verified DID is authorized for this
      // privileged route before continuing. Authorization is per-route because
      // it depends on the resource: see lib/space-authority.ts, where the
      // ingest control plane resolves the verified DID against the target
      // space's ACL. Routes that spend server-held authority (agent-tools,
      // sandbox) still have no such check.
    } catch (error) {
      const logger = c.get("logger");
      logger.warn(
        {
          path: c.req.path,
          method: c.req.method,
          error: error instanceof Error ? error.message : String(error),
        },
        "Rejected unauthenticated first-party HTTP request",
      );
      return c.json(
        options.code === undefined
          ? { error: "Unauthorized" }
          : { error: "Unauthorized", code: options.code },
        401,
      );
    }
    await next();
  };
}
