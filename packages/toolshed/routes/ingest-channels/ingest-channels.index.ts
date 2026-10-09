import { bodyLimit } from "@hono/hono/body-limit";

import { ingestGate } from "./gate.ts";
import * as handlers from "./ingest-channels.handlers.ts";
import * as routes from "./ingest-channels.routes.ts";
import env from "@/env.ts";
import { createRouter } from "@/lib/create-app.ts";
import { requireFirstPartyHttpAuth } from "@/middlewares/first-party-http-auth.ts";
import { createRateLimiter, rateLimit } from "@/middlewares/rate-limit.ts";
import { gmailPushEnabled } from "@/routes/ingest-push/gmail-push.config.ts";

const router = createRouter();

// What middleware covering the whole control plane is mounted on: every verb
// under a space, and the one verb that names none.
const everyVerb = [`${routes.SPACE_BASE}/*`, `${routes.CALLER_BASE}/list`];

// Mounted FIRST so nothing downstream — not the body limit, not the rate
// limiter, not signature verification — runs for a disabled deployment. See
// INGEST_SELF_SERVE_ENABLED in env.ts for why the default is off: minting
// issues a durable capability that outlives the trust conditions that
// authorized it.
for (const path of everyVerb) {
  router.use(path, ingestGate(env.INGEST_SELF_SERVE_ENABLED));
}
// The Gmail binding verbs are gated a second time, on Gmail push being
// configured: a binding nothing will ever deliver to is not worth making.
for (const verb of ["gmail-bind", "gmail-unbind"]) {
  router.use(`${routes.SPACE_BASE}/${verb}`, ingestGate(gmailPushEnabled));
}

// ORDER MATTERS: the body limit must run BEFORE the auth middleware.
// `verifyFirstPartyHttpRequest` buffers the entire body (to hash it) *before*
// it verifies the Ed25519 signature, so without a cap here an attacker with a
// fresh-looking auth header and a garbage signature can force arbitrary
// allocation without ever being authenticated. These payloads are a few hundred
// bytes; 16 KB is generous.
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
// These limiters run ahead of auth and are keyed by client address, so anything
// that drains the mint bucket also refuses revoke — and "come back in a few
// minutes" is the wrong answer to "kill this credential". Under the
// deployment misconfiguration the clientKey comment describes (a real proxy
// with RATE_LIMIT_TRUST_FORWARDED_FOR off), every caller collapses onto one
// bucket and one client's minting would refuse everyone else's revokes.
//
// Same asymmetry the claim-store-full path answers on the other side: minting
// and rotating are safe to refuse, because nothing bad happens when they do not
// run. Revoke is the verb where refusing IS the bad outcome.
const revokeLimiter = createRateLimiter({ capacity: 30, refillPerSecond: 0.5 });
// Binding shares the mint bucket, because each bind costs an outbound call to
// Gmail. Unbinding, like revoking, is the verb that must stay available, so it
// stays out of that bucket; and it has one of its own rather than revoke's, so
// that unbind traffic can never refuse a revoke.
const unbindLimiter = createRateLimiter({ capacity: 30, refillPerSecond: 0.5 });
for (const verb of ["mint", "rotate", "gmail-bind"]) {
  router.use(`${routes.SPACE_BASE}/${verb}`, rateLimit(mintLimiter));
}
router.use(`${routes.SPACE_BASE}/revoke`, rateLimit(revokeLimiter));
router.use(`${routes.SPACE_BASE}/gmail-unbind`, rateLimit(unbindLimiter));
for (const base of [routes.SPACE_BASE, routes.CALLER_BASE]) {
  router.use(`${base}/list`, rateLimit(readLimiter));
}

// Deliberately NO cors(): a credentialed control plane must not opt into the
// data plane's wildcard origin. Note this does NOT yield an absent
// `access-control-allow-origin` — routes/static and routes/shell register
// `cors({ origin: "*" })` on `"*"`, which applies app-wide. What blocks CSRF is
// that those policies allow only GET/OPTIONS, so a cross-origin POST carrying
// the mandatory CF-Request-* headers always preflights and the preflight
// refuses the method. Pinned by .routes.test.ts.
for (const path of everyVerb) {
  router.use(path, requireFirstPartyHttpAuth());
}

export default router
  .openapi(routes.mint, handlers.mint)
  .openapi(routes.list, handlers.list)
  .openapi(routes.listOwn, handlers.listOwn)
  .openapi(routes.rotate, handlers.rotate)
  .openapi(routes.revoke, handlers.revoke)
  .openapi(routes.gmailBind, handlers.gmailBind)
  .openapi(routes.gmailUnbind, handlers.gmailUnbind);
