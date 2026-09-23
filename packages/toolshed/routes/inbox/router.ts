/** Signed, recipient-private inbox routes over the serving database. */

import { bodyLimit } from "@hono/hono/body-limit";
import { z } from "@hono/zod-openapi";
import {
  INBOX_CAPABILITY,
  InboxError,
  validateInboxPayload,
} from "@commonfabric/memory/inbox";
import type { InboxStore } from "@commonfabric/memory/inbox-store";
import { normalizeInviteHost } from "@commonfabric/memory/space-invites";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { createRouter } from "../../lib/create-app.ts";
import { createRateLimiter, rateLimit } from "../../middlewares/rate-limit.ts";

const did = z.string().min(1).max(256);
const operationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const key = z.object({ senderDid: did, operationId }).strict();
const schemas = {
  enable: z.object({}).strict(),
  status: z.object({ recipientDid: did }).strict(),
  send: z.object({ recipientDid: did, operationId, payload: z.unknown() })
    .strict(),
  list: z.object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
  get: key,
  acknowledge: key,
};

/** Mounts only signed POST mutations and reads; capability metadata is public. */
export function createInboxRouter(
  options: { store: () => Promise<InboxStore>; host?: string },
) {
  const router = createRouter();
  const host = options.host === undefined
    ? undefined
    : normalizeInviteHost(options.host);
  router.onError((_error, c) => c.json({ code: "service-error" }, 500));
  router.get("/api/inbox", (c) => c.json(INBOX_CAPABILITY));
  router.use(
    "/api/inbox/*",
    bodyLimit({
      maxSize: 20000,
      onError: (c) => c.json({ code: "invalid-request" }, 413),
    }),
  );
  const limiter = createRateLimiter({ capacity: 120, refillPerSecond: 2 });
  // Acknowledgement has its own capacity so send saturation cannot prevent cleanup.
  const cleanupLimiter = createRateLimiter({
    capacity: 120,
    refillPerSecond: 2,
  });
  for (
    const operation of [
      "enable",
      "status",
      "send",
      "list",
      "get",
      "acknowledge",
    ] as const
  ) {
    router.use(
      `/api/inbox/${operation}`,
      rateLimit(operation === "acknowledge" ? cleanupLimiter : limiter, {
        code: "rate-limited",
      }),
    );
    router.post(`/api/inbox/${operation}`, async (c) => {
      let principal: string;
      try {
        const request = host === undefined ? c.req.raw : new Request(
          new URL(
            new URL(c.req.url).pathname + new URL(c.req.url).search,
            host,
          ),
          c.req.raw.clone(),
        );
        principal = (await verifyFirstPartyHttpRequest({ request })).userDid;
      } catch (error) {
        // The audience is the configured public origin rather than the dialed
        // host, so a deployment carrying the wrong `API_URL` refuses every
        // correctly signed client. Name the authority the proof was checked
        // against; the proof, its signature, and the body stay out of the log.
        c.get("logger")?.warn(
          {
            path: c.req.path,
            method: c.req.method,
            // Production always passes the configured `API_URL` as the host; the
            // dialed origin is only for fixtures that build the router without one.
            authority: host ?? new URL(c.req.url).origin,
            error: error instanceof Error ? error.message : String(error),
          },
          "Rejected unauthenticated first-party HTTP request",
        );
        return c.json({ code: "invalid-proof" }, 401);
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ code: "invalid-request" }, 400);
      }
      try {
        const store = await options.store();
        switch (operation) {
          case "enable":
            schemas.enable.parse(body);
            return c.json(store.enable(principal));
          case "status":
            return c.json(
              store.status(schemas.status.parse(body).recipientDid),
            );
          case "send": {
            const request = schemas.send.parse(body);
            validateInboxPayload(request.payload);
            return c.json(
              store.send(principal, { ...request, payload: request.payload }),
            );
          }
          case "list":
            return c.json(store.list(principal, schemas.list.parse(body)));
          case "get":
            return c.json(store.get(principal, schemas.get.parse(body)));
          case "acknowledge":
            return c.json(
              store.acknowledge(principal, schemas.acknowledge.parse(body)),
            );
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          return c.json({ code: "invalid-request" }, 400);
        }
        if (error instanceof InboxError) {
          return c.json(
            { code: error.code },
            error.code.startsWith("invalid")
              ? 400
              : error.code === "inbox-full"
              ? 429
              : 409,
          );
        }
        throw error;
      }
    });
  }
  return router;
}
