/**
 * The push handlers: thin transport wrappers over `gmail-push.utils.ts`, where
 * the verification and delivery rules live and are tested against a real
 * runtime.
 */

import { bodyLimit } from "@hono/hono/body-limit";
import type { Runtime } from "@commonfabric/runner";
import { createRouter } from "@/lib/create-app.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import { type GmailPushDeps, processGmailPush } from "./gmail-push.utils.ts";
import * as routes from "./ingest-push.routes.ts";
import { ingestGate } from "./gate.ts";

/** What the push handlers reach outside the request. */
export interface IngestPushHandlerDeps
  extends Omit<GmailPushDeps, "runtime" | "logger"> {
  /**
   * The runtime that holds the registry and the channels' cells. A function,
   * because the server assigns its runtime after the module graph loads.
   */
  runtime: () => Runtime;
}

/** The push route handlers, over `deps`. */
export function createIngestPushHandlers(deps: IngestPushHandlerDeps) {
  /**
   * Handles one Gmail notification delivered by a Pub/Sub push subscription.
   */
  const gmail: AppRouteHandler<routes.GmailPushRoute> = async (c) => {
    // A push addressed to another registry is one this deployment cannot
    // deliver, and saying so with a 404 has Pub/Sub redeliver it;
    // acknowledging it would lose the notification.
    if (c.req.valid("param").space !== deps.serviceSpace) {
      return c.json({ error: "Not found" }, 404);
    }
    const result = await processGmailPush(
      { ...deps, runtime: deps.runtime(), logger: c.get("logger") },
      c.req.header("Authorization"),
      await c.req.text(),
    );
    if (result.status === 200) return c.json(result.body, 200);
    return c.json(result.body, result.status);
  };

  return { gmail };
}

/**
 * The router for push deliveries into ingest channels, over `deps`. With
 * `enabled` false it answers 404 to every request.
 */
export function createIngestPushRouter(
  deps: IngestPushHandlerDeps & { enabled: boolean },
) {
  const router = createRouter();

  // First, so nothing downstream runs for a deployment that has not configured
  // Gmail push.
  router.use(`${routes.BASE}/*`, ingestGate(deps.enabled));

  // Ahead of token verification, so an unauthenticated caller cannot make the
  // handler buffer an arbitrary body. A Pub/Sub envelope around a Gmail
  // notification is a few hundred bytes.
  router.use(
    `${routes.BASE}/*`,
    bodyLimit({
      maxSize: 16_384,
      onError: (c) => c.json({ error: "Payload too large" }, 413),
    }),
  );

  return router.openapi(routes.gmail, createIngestPushHandlers(deps).gmail);
}
