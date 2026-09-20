/** Signed invitation HTTP boundary with bounded, strictly validated request bodies. */
import { bodyLimit } from "@hono/hono/body-limit";
import { cors } from "@hono/hono/cors";
import { z } from "@hono/zod-openapi";
import {
  normalizeInviteHost,
  SPACE_INVITE_CAPABILITY,
  SpaceInviteError,
} from "@commonfabric/memory/space-invites";
import type { Server } from "@commonfabric/memory/v2/server";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { createRouter } from "@/lib/create-app.ts";
import { isValidSpaceDid } from "@/lib/space-authority.ts";
import { createRateLimiter, rateLimit } from "@/middlewares/rate-limit.ts";

const BASE = "/api/spaces/:space/invites";
const inviteId = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const schemas = {
  create: z.object({
    inviteId,
    codeVerifier: secret,
    access: z.enum(["READ", "WRITE"]),
    ttlSeconds: z.number().int().min(1).max(
      SPACE_INVITE_CAPABILITY.maxTtlSeconds,
    ),
    maxUses: z.number().int().min(1).max(SPACE_INVITE_CAPABILITY.maxUses)
      .optional(),
  }).strict(),
  redeem: z.object({ inviteId, code: secret }).strict(),
  revoke: z.object({ inviteId }).strict(),
  list: z.object({}).strict(),
  receipts: z.object({ inviteId: inviteId.optional() }).strict(),
};

/** Builds routes around the serving memory instance; tests supply a controlled clock. */
export function createSpaceInviteRouter(
  options: { server: Server; now?: () => number; host?: string },
) {
  const router = createRouter();
  const now = options.now ?? Date.now;
  const configuredHost = options.host === undefined
    ? undefined
    : normalizeInviteHost(options.host);
  router.use(
    "/api/space-invites",
    cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }),
  );
  router.get("/api/space-invites", (c) => c.json(SPACE_INVITE_CAPABILITY));
  router.use(
    `${BASE}/*`,
    cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "CF-User-DID",
        "CF-Request-Auth",
        "CF-Request-Proof",
        "CF-Request-Body-SHA256",
      ],
    }),
  );
  router.use(
    `${BASE}/*`,
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ code: "invalid-request" }, 413),
    }),
  );
  const mutationLimiter = createRateLimiter({
    capacity: 60,
    refillPerSecond: 1,
  });
  const revocationLimiter = createRateLimiter({
    capacity: 30,
    refillPerSecond: 0.5,
  });
  for (
    const operation of [
      "create",
      "redeem",
      "revoke",
      "list",
      "receipts",
    ] as const
  ) {
    router.use(
      `${BASE}/${operation}`,
      rateLimit(operation === "revoke" ? revocationLimiter : mutationLimiter, {
        code: "rate-limited",
      }),
    );
    router.post(`${BASE}/${operation}`, async (c) => {
      const time = now();
      let principal: string;
      try {
        principal = (await verifyFirstPartyHttpRequest({
          request: configuredHost === undefined ? c.req.raw : new Request(
            new URL(
              new URL(c.req.url).pathname + new URL(c.req.url).search,
              configuredHost,
            ),
            c.req.raw.clone(),
          ),
          nowSeconds: Math.floor(time / 1000),
          maxProofAgeSeconds: 300,
          futureSkewSeconds: 60,
        })).userDid;
      } catch {
        return c.json({ code: "invalid-proof" }, 401);
      }
      const space = c.req.param("space");
      if (!isValidSpaceDid(space)) {
        return c.json({ code: "invalid-request" }, 400);
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ code: "invalid-request" }, 400);
      }
      try {
        const host = configuredHost ??
          normalizeInviteHost(new URL(c.req.url).origin);
        // Each branch carries the schema's exact inferred body type into the
        // service. Unknown fields, including a proposed recipient DID, fail.
        const envelope = { host, space, principal, now };
        switch (operation) {
          case "create":
            return c.json(
              await options.server.invite({
                ...envelope,
                operation,
                body: schemas.create.parse(body),
              }),
            );
          case "redeem":
            return c.json(
              await options.server.invite({
                ...envelope,
                operation,
                body: schemas.redeem.parse(body),
              }),
            );
          case "revoke":
            return c.json(
              await options.server.invite({
                ...envelope,
                operation,
                body: schemas.revoke.parse(body),
              }),
            );
          case "list":
            return c.json(
              await options.server.invite({
                ...envelope,
                operation,
                body: schemas.list.parse(body),
              }),
            );
          case "receipts":
            return c.json(
              await options.server.invite({
                ...envelope,
                operation,
                body: schemas.receipts.parse(body),
              }),
            );
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          return c.json({ code: "invalid-request" }, 400);
        }
        if (error instanceof SpaceInviteError) {
          return c.json(
            { code: error.code },
            error.code === "not-owner"
              ? 403
              : error.code === "invalid-request" ||
                  error.code === "invalid-host"
              ? 400
              : 409,
          );
        }
        // The shared error boundary records failures without private storage
        // diagnostics, invitation credentials, or request bodies.
        throw new Error("Space invitation service failed");
      }
    });
  }
  return router;
}
