/**
 * Algorithm-only microbench for `PathKeyMap.invalidateChain`. Each
 * iteration primes K sibling cache entries, then runs a tight loop of
 * `invalidateChain` calls that drop one of them. Setup is excluded from
 * measurement via `b.start()` / `b.end()`.
 *
 * Why this bench exists: the v2-transaction-level frozenReads bench
 * (`runtime/runner/test/frozen-reads-cache.bench.ts`) historically
 * measured the SUM of cache invalidation cost and structural-sharing
 * write-rebuild cost, both K-dependent. This bench isolates the
 * invalidation algorithm and shows its scaling with cache size
 * directly.
 *
 * Expected shape:
 *   - `Map.clear()` baseline: roughly constant (V8's Map.clear is O(1)
 *     for the bookkeeping, though GC of dropped entries is amortized).
 *   - hypothetical O(K) sibling sweep (the previous PR's design): linear
 *     in K.
 *   - `PathKeyMap.invalidateChain`: O(D) in path depth, independent of K.
 *
 * Run with: deno bench test/path-key-map.bench.ts
 */

import { PathKeyMap } from "../src/path-key-map.ts";

const ITERATIONS = 1000;

const prime = (m: PathKeyMap<number>, k: number) => {
  for (let i = 0; i < k; i++) {
    m.set(["root", "subtree", `s${i}`], i);
  }
};

for (const K of [16, 64, 256, 1024]) {
  Deno.bench({
    name:
      `PathKeyMap.invalidateChain: K=${K} primed; ${ITERATIONS}x drop one chain`,
    group: "invalidate-scaling",
    fn(b) {
      const m = new PathKeyMap<number>();
      prime(m, K);
      b.start();
      for (let i = 0; i < ITERATIONS; i++) {
        // Drop one chain. Each call drops the entry at index (i % K),
        // which has been freshly primed. We re-prime that same path
        // before the next drop so the cache stays at size ~K throughout.
        const idx = i % K;
        m.invalidateChain(["root", "subtree", `s${idx}`]);
        m.set(["root", "subtree", `s${idx}`], idx);
      }
      b.end();
    },
  });
}
