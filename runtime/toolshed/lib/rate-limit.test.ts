/**
 * This is the whole of toolshed's rate limiting. The properties worth pinning
 * are the ones an abuse bound depends on: that a burst is actually capped,
 * that keys do not share a bucket, that eviction cannot be used as a reset
 * primitive, and that a caller cannot choose which bucket they land in.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createRateLimiter } from "@/lib/rate-limit.ts";
import { clientKey } from "@/middlewares/rate-limit.ts";

describe("token bucket", () => {
  it("allows a burst up to capacity, then refuses", () => {
    const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 0 });
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.take("a")).toBe(false);
  });

  it("keeps buckets per key", () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    // A different caller is unaffected by the first one's spend.
    expect(limiter.take("b")).toBe(true);
  });

  it("refills over time", () => {
    let clock = 0;
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 100,
      now: () => clock,
    });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    clock += 10; // 100/s -> one token back after 10ms
    expect(limiter.take("a")).toBe(true);
  });

  it("neither penalises nor refunds a backward clock excursion", () => {
    // Refill is elapsed-time arithmetic, so a clock that steps BACKWARDS — an
    // NTP correction, an operator setting the date — used to refill a spent
    // bucket by a negative amount and drive it below empty, leaving it denied
    // for longer than the configured interval. Clamping the elapsed value alone
    // then left the opposite hole: the stored timestamp had been rewound, so
    // the catch-up back to real time counted as elapsed and refunded the
    // bucket.
    //
    // A backward excursion must cost the caller nothing and earn them nothing.
    // The bucket this most matters for is revoke's, where a false denial leaves
    // live the credential the caller is trying to kill, and a false refund is
    // the abuse bound not existing.

    const start = 1_000_000;
    let clock = start;
    const limiter = createRateLimiter({
      capacity: 2,
      refillPerSecond: 1,
      now: () => clock,
    });
    expect([limiter.take("a"), limiter.take("a")]).toEqual([true, true]);
    expect(limiter.take("a")).toBe(false);

    // An hour backwards. Naive arithmetic banks -3600 tokens here.
    clock -= 3_600_000;
    expect(limiter.take("a")).toBe(false);

    // ...and back to where it started. No real time has passed, so nothing is
    // owed: clamping elapsed but rewinding `updatedAt` would hand back a full
    // bucket at this point.
    clock = start;
    expect(limiter.take("a")).toBe(false);

    // One real second past the high-water mark buys exactly one token, as it
    // would have if the excursion had never happened.
    clock = start + 1_000;
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("never refills past capacity", () => {
    let clock = 0;
    const limiter = createRateLimiter({
      capacity: 2,
      refillPerSecond: 1000,
      now: () => clock,
    });
    clock += 60_000; // a minute of idle must not bank more than the burst
    expect([limiter.take("a"), limiter.take("a")]).toEqual([true, true]);
    expect(limiter.take("a")).toBe(false);
  });

  it("evicts the least recently used key once maxKeys is exceeded", () => {
    // The LRU exists so the limiter cannot become the memory exhaustion it
    // prevents. It has a sharp edge: an evicted key gets a fresh full bucket,
    // so a flood of distinct keys is a reset primitive against a throttled one.
    // The defense is the size of maxKeys, and this pins that the eviction is
    // real.

    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 0,
      maxKeys: 2,
    });
    expect(limiter.take("old")).toBe(true);
    expect(limiter.take("old")).toBe(false);

    limiter.take("b");
    limiter.take("c"); // pushes "old" out

    // "old" is a fresh bucket again, which is the documented trade-off.
    expect(limiter.take("old")).toBe(true);
  });
});

describe("clientKey", () => {
  it("survives a context with no connection info", () => {
    // `getConnInfo` throws when there is no Deno connection behind the request,
    // which is exactly the case under `app.request`; it must not take the route
    // down with it.

    expect(clientKey({ req: { header: () => undefined } })).toBe("unknown");
  });

  const req = (headers: Record<string, string>) => ({
    req: { header: (name: string) => headers[name.toLowerCase()] },
  });

  it("takes the rightmost X-Forwarded-For entry when a proxy is trusted", () => {
    // .env.test sets RATE_LIMIT_TRUST_FORWARDED_FOR=true, so this exercises the
    // trusted-proxy branch.
    // The RIGHTMOST entry. A proxy appends what it saw to whatever the request
    // already carried, so everything to its left is client-authored.

    expect(
      clientKey(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" })),
    ).toBe("10.0.0.2");
  });

  it("gives a client no way to pick its own bucket by forging the header", () => {
    // The property that matters: a caller cannot choose their own bucket.
    // Taking the leftmost entry made every request from one client look like a
    // different one, which is the limiter not existing.

    const proxySaw = "10.0.0.2";
    const forged = ["evil-1", "evil-2", "evil-3"].map((spoof) =>
      clientKey(req({ "x-forwarded-for": `${spoof}, ${proxySaw}` }))
    );
    expect(new Set(forged).size).toBe(1);
    expect(forged[0]).toBe(proxySaw);
  });

  it("falls back to unknown when there is no header and no connection info", () => {
    expect(clientKey(req({}))).toBe("unknown");
  });
});
