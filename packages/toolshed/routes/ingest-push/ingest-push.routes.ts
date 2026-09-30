/**
 * Routes for push deliveries from external services into ingest channels.
 *
 * The prefix is its own literal string, apart from `/api/ingest/*`, where a
 * route here would be shadowed by `POST /api/ingest/:id` and would pick up
 * that prefix's wildcard CORS. A push delivery is server to server and needs
 * no CORS at all.
 */

import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Ingest Push"];

/** The prefix every push route sits under. */
export const BASE = "/api/ingest-push";

const jsonError = {
  content: { "application/json": { schema: z.object({ error: z.string() }) } },
};

/**
 * `POST /api/ingest-push/gmail`, which a Cloud Pub/Sub push subscription
 * calls with each Gmail `users.watch` notification. The body is parsed in the
 * handler, after the push token is verified, so no request body schema is
 * declared here.
 */
export const gmail = createRoute({
  path: `${BASE}/gmail`,
  method: "post",
  tags,
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
