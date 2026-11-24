// Thin transport wrappers over ingest-channels.utils.ts, mirroring how
// ingest.handlers.ts wraps processIngest: everything security-relevant lives in
// the utils module and is tested against a real runtime. Rate limiting is
// middleware (see `createIngestChannelsRouter()`), so what is left in each
// handler is the verified caller DID and the call itself.

import { bodyLimit } from "@hono/hono/body-limit";
import type { Runtime } from "@commonfabric/runner";
import { createRouter } from "@/lib/create-app.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import { requireFirstPartyHttpAuth } from "@/middlewares/first-party-http-auth.ts";
import { createRateLimiter, rateLimit } from "@/middlewares/rate-limit.ts";
import {
  type ControlDeps,
  processList,
  processMint,
  processRevoke,
  processRotate,
} from "./ingest-channels.utils.ts";
import * as routes from "./ingest-channels.routes.ts";

/** What the control-plane handlers reach outside the request. */
export interface IngestChannelHandlerDeps
  extends Omit<ControlDeps, "runtime" | "logger"> {
  /**
   * The runtime that holds the registry. A function, because the server
   * assigns its runtime after the module graph loads.
   */
  runtime: () => Runtime;
}

/** The control-plane route handlers, over `handlerDeps`. */
export function createIngestChannelHandlers(
  handlerDeps: IngestChannelHandlerDeps,
) {
  const deps = (logger: ControlDeps["logger"]): ControlDeps => ({
    ...handlerDeps,
    runtime: handlerDeps.runtime(),
    logger,
  });

  const mint: AppRouteHandler<routes.MintRoute> = async (c) => {
    const callerDid = c.get("verifiedUserDid");
    if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
    const result = await processMint(
      deps(c.get("logger")),
      callerDid,
      { ...c.req.valid("json"), space: c.req.valid("param").space },
    );
    if (result.status === 200) return c.json(result.body, 200);
    return c.json(result.body, result.status);
  };

  const rotate: AppRouteHandler<routes.RotateRoute> = async (c) => {
    const callerDid = c.get("verifiedUserDid");
    if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
    const result = await processRotate(
      deps(c.get("logger")),
      callerDid,
      { ...c.req.valid("json"), space: c.req.valid("param").space },
    );
    if (result.status === 200) return c.json(result.body, 200);
    return c.json(result.body, result.status);
  };

  const revoke: AppRouteHandler<routes.RevokeRoute> = async (c) => {
    const callerDid = c.get("verifiedUserDid");
    if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
    const result = await processRevoke(
      deps(c.get("logger")),
      callerDid,
      { ...c.req.valid("json"), space: c.req.valid("param").space },
    );
    if (result.status === 200) return c.json(result.body, 200);
    return c.json(result.body, result.status);
  };

  const list: AppRouteHandler<routes.ListRoute> = async (c) => {
    const callerDid = c.get("verifiedUserDid");
    if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
    const result = await processList(
      deps(c.get("logger")),
      callerDid,
      { space: c.req.valid("param").space },
    );
    if (result.status === 200) return c.json(result.body, 200);
    return c.json(result.body, result.status);
  };

  const listOwn: AppRouteHandler<routes.ListOwnRoute> = async (c) => {
    const callerDid = c.get("verifiedUserDid");
    if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
    const result = await processList(deps(c.get("logger")), callerDid, {});
    if (result.status === 200) return c.json(result.body, 200);
    return c.json(result.body, result.status);
  };

  return { mint, rotate, revoke, list, listOwn };
}

/** The control-plane router, over `deps`. */
export function createIngestChannelsRouter(deps: IngestChannelHandlerDeps) {
  const handlers = createIngestChannelHandlers(deps);
  const router = createRouter();

  // What middleware covering the whole control plane is mounted on: every verb
  // under a space, and the one verb that names none.
  const everyVerb = [`${routes.SPACE_BASE}/*`, `${routes.CALLER_BASE}/list`];

  // ORDER MATTERS: the body limit must run BEFORE the auth middleware.
  // `verifyFirstPartyHttpRequest` buffers the entire body (to hash it) *before*
  // it verifies the Ed25519 signature, so without a cap here an attacker with a
  // fresh-looking auth header and a garbage signature can force arbitrary
  // allocation without ever being authenticated. These payloads are a few
  // hundred bytes; 16 KB is generous.
  for (const path of everyVerb) {
    router.use(
      path,
      bodyLimit({
        maxSize: 16_384,
        onError: (c) => c.json({ error: "Payload too large" }, 413),
      }),
    );
  }

  // Also ahead of auth: an unauthenticated flood should be bounded before it
  // costs an Ed25519 verification. Minting is durable work an anonymous keypair
  // can trigger, so it gets the tighter bucket; listing is read-only.
  const mintLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 0.1 });
  const readLimiter = createRateLimiter({ capacity: 60, refillPerSecond: 1 });
  // Revoke gets its OWN bucket, deliberately not shared with mint and rotate.
  // These limiters run ahead of auth and are keyed by client address, so
  // anything that drains the mint bucket also refuses revoke — and "come back
  // in a few minutes" is the wrong answer to "kill this credential". Under the
  // deployment misconfiguration the clientKey comment describes (a real proxy
  // with RATE_LIMIT_TRUST_FORWARDED_FOR off), every caller collapses onto one
  // bucket and one client's minting would refuse everyone else's revokes.
  //
  // Same asymmetry the claim-store-full path answers on the other side: minting
  // and rotating are safe to refuse, because nothing bad happens when they do
  // not run. Revoke is the verb where refusing IS the bad outcome.
  const revokeLimiter = createRateLimiter({
    capacity: 30,
    refillPerSecond: 0.5,
  });
  for (const verb of ["mint", "rotate"]) {
    router.use(`${routes.SPACE_BASE}/${verb}`, rateLimit(mintLimiter));
  }
  router.use(`${routes.SPACE_BASE}/revoke`, rateLimit(revokeLimiter));
  for (const base of [routes.SPACE_BASE, routes.CALLER_BASE]) {
    router.use(`${base}/list`, rateLimit(readLimiter));
  }

  // Deliberately NO cors(): a credentialed control plane must not opt into the
  // data plane's wildcard origin. Note this does NOT yield an absent
  // `access-control-allow-origin` — routes/static and routes/shell register
  // `cors({ origin: "*" })` on `"*"`, which applies app-wide. What blocks CSRF
  // is that those policies allow only GET/OPTIONS, so a cross-origin POST
  // carrying the mandatory CF-Request-* headers always preflights and the
  // preflight refuses the method. Pinned by .routes.test.ts.
  for (const path of everyVerb) {
    router.use(path, requireFirstPartyHttpAuth());
  }

  return router
    .openapi(routes.mint, handlers.mint)
    .openapi(routes.list, handlers.list)
    .openapi(routes.listOwn, handlers.listOwn)
    .openapi(routes.rotate, handlers.rotate)
    .openapi(routes.revoke, handlers.revoke);
}
