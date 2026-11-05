// A minimal in-process token bucket. Deliberately approximate: an abuse bound,
// not a quota system, and each toolshed instance keeps its own buckets, so the
// deployment-wide budget belongs at trusted ingress. See
// middlewares/rate-limit.ts for how requests are keyed.

export interface RateLimiterOptions {
  /** Burst size — the most a single key may spend at once. */
  capacity: number;

  /** Sustained rate. */
  refillPerSecond: number;

  /**
   * Hard cap on tracked keys, so the limiter cannot itself become the memory
   * exhaustion it exists to prevent. When full, the least-recently-used key is
   * evicted — which grants that key a fresh bucket, so keep this well above the
   * number of distinct clients you expect.
   */
  maxKeys?: number;

  /**
   * Clock source, injectable so refill behavior can be tested by advancing a
   * counter rather than sleeping. A timing-dependent test of a rate limiter is
   * flaky by construction, and the repo's waiting guidance rules sleeps out.
   *
   * Defaults to a MONOTONIC clock, not `Date.now`. Refill is computed from
   * elapsed time, so a wall-clock adjustment — NTP correction, DST on a
   * misconfigured host, an operator setting the date — moves it backwards and
   * a spent bucket refills by a negative amount. `performance.now()` cannot
   * step backwards.
   */
  now?: () => number;
}

export interface RateLimiter {
  /** Spend one token. `false` means the caller is over its limit. */
  take(key: string): boolean;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const {
    capacity,
    refillPerSecond,
    maxKeys = 10_000,
    now = () => performance.now(),
  } = options;
  // Insertion order is iteration order, so the first key is the LRU once every
  // touch re-inserts.
  const buckets = new Map<string, Bucket>();

  return {
    take(key) {
      const at = now();
      const existing = buckets.get(key);
      const bucket: Bucket = existing ?? { tokens: capacity, updatedAt: at };
      if (existing) {
        // Clamped at zero as well as defaulting to a monotonic clock, because
        // the clock is injectable and a caller can still supply a wall clock.
        // Refilling by a negative amount drives a spent bucket BELOW empty, so
        // it stays denied for longer than the configured interval — and the
        // bucket this protects is revoke's, where an extended false denial
        // leaves a credential the caller is trying to kill alive.
        const elapsedSeconds = Math.max(0, at - existing.updatedAt) / 1000;
        // Clamping the ELAPSED value alone is not enough. Storing the earlier
        // `at` would rewind the reference point, so when the clock catches back
        // up the whole excursion is counted as elapsed and refunds a bucket
        // that should still be spent — a backward jump followed by catch-up
        // becomes a bypass rather than a stall. Advancing the stored timestamp
        // monotonically is what makes the clamp hold in both directions.
        const nextUpdatedAt = Math.max(at, existing.updatedAt);
        bucket.tokens = Math.min(
          capacity,
          existing.tokens + elapsedSeconds * refillPerSecond,
        );
        bucket.updatedAt = nextUpdatedAt;
        buckets.delete(key);
      }

      const allowed = bucket.tokens >= 1;
      if (allowed) bucket.tokens -= 1;

      buckets.set(key, bucket);
      while (buckets.size > maxKeys) {
        const oldest = buckets.keys().next();
        if (oldest.done) break;
        buckets.delete(oldest.value);
      }
      return allowed;
    },
  };
}
