/** Authenticated, host-local canonical meeting-room allocation boundary. */

import { bodyLimit } from "@hono/hono/body-limit";
import { cors } from "@hono/hono/cors";

import { normalizeInviteHost } from "@commonfabric/memory/space-invites";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";

import { createRouter } from "@/lib/create-app.ts";
import {
  MeetingRoomError,
  meetingRoomRequestSchema,
  MeetingRooms,
} from "@/lib/meeting-rooms.ts";
import { createRateLimiter, rateLimit } from "@/middlewares/rate-limit.ts";

const BASE = "/api/meeting-rooms";

/** Builds routes for one host authority; an unavailable host refuses mutations. */
export function createMeetingRoomRouter(options: {
  rooms: MeetingRooms;
  host: string;
  available?: boolean;
}) {
  const router = createRouter();
  const host = normalizeInviteHost(options.host);
  const available = options.available ?? true;
  router.onError((_error, c) => {
    c.get("logger")?.error("Meeting room allocation failed");
    return c.json({ code: "service-error" }, 500);
  });
  router.use(
    `${BASE}*`,
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "CF-User-DID",
        "CF-Request-Auth",
        "CF-Request-Proof",
        "CF-Request-Body-SHA256",
      ],
    }),
  );
  router.get(BASE, (c) => c.json({ available, scope: "host" }));
  router.use(
    `${BASE}/ensure`,
    bodyLimit({
      maxSize: 16384,
      onError: (c) => c.json({ code: "invalid-request" }, 413),
    }),
  );
  router.use(
    `${BASE}/ensure`,
    rateLimit(createRateLimiter({ capacity: 60, refillPerSecond: 1 }), {
      code: "rate-limited",
    }),
  );
  router.post(`${BASE}/ensure`, async (c) => {
    if (!available) return c.json({ code: "unavailable" }, 503);
    let principal: string;
    try {
      principal = (await verifyFirstPartyHttpRequest({
        request: new Request(
          new URL(
            new URL(c.req.url).pathname + new URL(c.req.url).search,
            host,
          ),
          c.req.raw.clone(),
        ),
        nowSeconds: Math.floor(Date.now() / 1000),
        maxProofAgeSeconds: 300,
        futureSkewSeconds: 60,
      })).userDid;
    } catch {
      return c.json({ code: "invalid-proof" }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid-request" }, 400);
    }
    const parsed = meetingRoomRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ code: "invalid-request" }, 400);
    try {
      return c.json(await options.rooms.ensure(principal, parsed.data));
    } catch (error) {
      if (error instanceof MeetingRoomError) {
        return c.json(
          { code: error.code },
          error.code === "not-owner" ? 403 : 409,
        );
      }
      throw error;
    }
  });
  return router;
}
