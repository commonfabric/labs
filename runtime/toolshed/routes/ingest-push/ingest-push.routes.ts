/**
 * Routes for push deliveries from external services into ingest channels.
 *
 * A push names no user's space: the sender knows a mailbox, and which
 * channels that reaches is what the registry says. So the space in the path
 * is the one holding the registry, which lets whatever dispatches requests by
 * space send a push to the deployment whose registry it should be read
 * against.
 *
 * The `ingest-push` path segment is its own literal string, apart from the
 * data plane's `ingest`, where a route here would be shadowed by
 * `POST /api/spaces/:space/ingest/:id` and would pick up that prefix's
 * wildcard CORS. A push delivery is server to server and needs no CORS at all.
 */

import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Ingest Push"];

/** The prefix every push route sits under. */
export const BASE = "/api/spaces/:space/ingest-push";

const jsonError = {
  content: { "application/json": { schema: z.object({ error: z.string() }) } },
};

/**
 * `POST /api/spaces/:space/ingest-push/gmail`, which a Cloud Pub/Sub push
 * subscription calls with each Gmail `users.watch` notification. The body is
 * parsed in the handler, after the push token is verified, so no request body
 * schema is declared here.
 */
export const gmail = createRoute({
  path: `${BASE}/gmail`,
  method: "post",
  tags,
  request: {
    params: z.object({
      space: z.string().describe(
        "The space this deployment keeps its ingest registry in",
      ),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({ delivered: z.number() }),
        },
      },
      description:
        "Acknowledged. `delivered` counts the channels the notification " +
        "was appended to, which is zero for a mailbox nobody has bound",
    },
    [HttpStatusCodes.UNAUTHORIZED]: {
      ...jsonError,
      description: "Missing push token, or not one from an accepted account",
    },
    [HttpStatusCodes.NOT_FOUND]: {
      ...jsonError,
      description:
        "The path names a space other than the one this deployment keeps " +
        "its ingest registry in. Where Gmail push is not configured at all, " +
        "a gate ahead of the route answers every request with the server's " +
        "plain 404 rather than this body",
    },
    [HttpStatusCodes.REQUEST_TOO_LONG]: {
      ...jsonError,
      description: "Request body exceeds the limit (checked before auth)",
    },
    [HttpStatusCodes.BAD_GATEWAY]: {
      ...jsonError,
      description: "Storage or key-fetch failure; Pub/Sub redelivers",
    },
  },
});

/** The type of the `gmail` route. */
export type GmailPushRoute = typeof gmail;
