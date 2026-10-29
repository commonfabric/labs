// The pattern-lifecycle router: the verbs' routes behind the middleware
// order the control plane needs — the body cap first, then the rate limit,
// then the first-party request proof — mounted under one prefix
// (docs/features/server-pattern-lifecycle.md).

import { bodyLimit } from "@hono/hono/body-limit";

import * as handlers from "./pattern-lifecycle.handlers.ts";
import * as routes from "./pattern-lifecycle.routes.ts";
import { createRouter } from "@/lib/create-app.ts";
import { requireFirstPartyHttpAuth } from "@/middlewares/first-party-http-auth.ts";
import { createRateLimiter, rateLimit } from "@/middlewares/rate-limit.ts";

const router = createRouter();

// The body limit runs BEFORE the auth middleware: signature verification
// buffers the whole body to hash it before it verifies anything, so the cap
// is what keeps an unauthenticated caller from forcing the allocation. A
// program's files ride inline, which is why the cap is megabytes rather than
// the control plane's kilobytes.
router.use(
  `${routes.BASE}/*`,
  bodyLimit({
    maxSize: routes.MAX_BODY_BYTES,
    onError: (c) =>
      c.json({ error: "Payload too large", code: "payload-too-large" }, 413),
  }),
);

// Ahead of auth as well, so a flood is bounded before it costs an Ed25519
// verification. Each verb compiles on the serving side, which is real work,
// so the bucket is sized for a deploy loop rather than a burst.
const verbLimiter = createRateLimiter({ capacity: 30, refillPerSecond: 1 });
router.use(
  `${routes.BASE}/*`,
  rateLimit(verbLimiter, { code: "rate-limited" }),
);

// No cors(): a credentialed control plane; the app-wide policy allows only
// GET/OPTIONS cross-origin, so a signed POST from another origin fails its
// preflight.
router.use(
  `${routes.BASE}/*`,
  requireFirstPartyHttpAuth({ code: "unauthorized" }),
);

export default router
  .openapi(routes.upload, handlers.upload)
  .openapi(routes.instantiate, handlers.instantiate)
  .openapi(routes.setsrc, handlers.setsrc);
