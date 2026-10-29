import type { MiddlewareHandler } from "@hono/hono";
import { getConnInfo } from "@hono/hono/deno";
import type { AppBindings } from "@/lib/types.ts";
import env from "@/env.ts";
import { createRateLimiter, type RateLimiter } from "@/lib/rate-limit.ts";

/**
 * Rate limiting keyed by CLIENT ADDRESS.
 *
 * Not by caller DID: a DID is a free, freshly-generated keypair, so every
 * bucket would start full. `X-Forwarded-For` is consulted only when the
 * deployment declares a trusted proxy (`RATE_LIMIT_TRUST_FORWARDED_FOR`),
 * because there is no way to tell a proxy-set header from a client-set one —
 * and either mistake is total. Trusting a spoofable header makes the limiter a
 * no-op; ignoring a real proxy collapses every caller onto one bucket and lets
 * one client starve the deployment.
 *
 * The RIGHTMOST entry, not the leftmost. A proxy APPENDS the address it saw to
 * whatever the request already carried, so the leftmost entry is whatever the
 * client sent — a caller who sets `X-Forwarded-For: <anything>` gets a fresh
 * full bucket on every request, which is the limiter not existing. The
 * rightmost entry is the one the trusted proxy itself wrote, and it is the only
 * entry in the header the client could not choose.
 *
 * This assumes exactly ONE trusted proxy appends. Behind a chain of N, the
 * client-controlled prefix extends N-1 entries further right, and this needs to
 * count in by the number of trusted hops instead.
 */
export const clientKey = (
  c: { req: { header: (name: string) => string | undefined } },
): string => {
  if (env.RATE_LIMIT_TRUST_FORWARDED_FOR) {
    const chain = c.req.header("x-forwarded-for")?.split(",");
    const forwarded = chain?.[chain.length - 1]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    // deno-lint-ignore no-explicit-any
    return getConnInfo(c as any).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
};

/**
 * Mount ahead of the work being protected — and, where the route authenticates,
 * ahead of that too, so an unauthenticated flood is bounded before it costs a
 * signature verification. A route whose refusals carry a stable code passes
 * the code its 429 should name.
 */
export function rateLimit(
  limiter: RateLimiter,
  options: { code?: string } = {},
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!limiter.take(clientKey(c))) {
      return c.json(
        options.code === undefined
          ? { error: "Too many requests" }
          : { error: "Too many requests", code: options.code },
        429,
      );
    }
    await next();
  };
}

export { createRateLimiter };
