/**
 * Benches the per-doc frozen-reads cache invalidation policy in the v2
 * storage transaction. Several shapes exercise different axes:
 *
 * 1. **Hot sibling-rich pattern (default)**: prime K sibling cache entries,
 *    then loop {write into subtree 0; read K-1 other siblings}. With
 *    blanket `frozenReads.clear()` every write evicts every sibling entry;
 *    with prefix-aware invalidation those sibling entries survive.
 *
 * 2. **1-sibling control**: as above but only one post-write sibling read,
 *    isolating the per-write overhead from the per-saved-read win.
 *
 * 3. **Cache-size scaling**: the same sibling-rich shape at K=16/64/256
 *    cached siblings. With an O(N) sibling-sweep invalidator the cost
 *    grows linearly; an O(D) trie walker is flat. This makes the algorithmic
 *    crossover visible.
 *
 * 4. **Deep nested-path write**: writes at a depth-7 path to confirm the
 *    per-write cost scales with path depth, not total cache size.
 *
 * Run with:
 *   deno bench --allow-ffi --allow-env --allow-read \
 *     --allow-write=/tmp,/var/folders test/frozen-reads-cache.bench.ts
 */

import type { MutableFabricPlainObjectLayer } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("frozen-reads-cache-bench");
const space = signer.did();
const type = "application/json" as const;

const ITERATIONS = 200;

const ID = "of:frozen-reads-cache-bench" as const;

const seedSiblings = (subtreeCount: number) => {
  const value: MutableFabricPlainObjectLayer = {};
  for (let i = 0; i < subtreeCount; i++) {
    value[`sub${i}`] = { count: 0, label: `sub${i}` };
  }
  return { value };
};

const setupPrimedSiblingTransaction = (subtreeCount: number) => {
  const storage = StorageManager.emulate({ as: signer });
  const tx = storage.edit();

  const write = tx.write(
    { space, id: ID, type, path: [] },
    seedSiblings(subtreeCount),
  );
  if (write.error) throw write.error;

  // Prime the per-doc cache with one read per sibling subtree.
  for (let i = 0; i < subtreeCount; i++) {
    const r = tx.read({
      space,
      id: ID,
      type,
      path: ["value", `sub${i}`],
    });
    if (r.error) throw r.error;
  }

  return { storage, tx };
};

//
// 1. Hot sibling-rich pattern at K=16 (the baseline shape).
//

Deno.bench({
  name: `frozenReads: ${ITERATIONS}x {write sub0; read other 15 siblings}`,
  baseline: true,
  async fn() {
    const { storage, tx } = setupPrimedSiblingTransaction(16);
    for (let i = 0; i < ITERATIONS; i++) {
      const w = tx.write({
        space,
        id: ID,
        type,
        path: ["value", "sub0", "count"],
      }, i + 1);
      if (w.error) throw w.error;
      for (let k = 1; k < 16; k++) {
        const r = tx.read({
          space,
          id: ID,
          type,
          path: ["value", `sub${k}`],
        });
        if (r.error) throw r.error;
      }
    }
    await storage.close();
  },
});

//
// 2. 1-sibling control at K=16.
//

Deno.bench({
  name: `frozenReads: ${ITERATIONS}x {write sub0; read same sibling once}`,
  async fn() {
    const { storage, tx } = setupPrimedSiblingTransaction(16);
    for (let i = 0; i < ITERATIONS; i++) {
      const w = tx.write({
        space,
        id: ID,
        type,
        path: ["value", "sub0", "count"],
      }, i + 1);
      if (w.error) throw w.error;
      const r = tx.read({ space, id: ID, type, path: ["value", "sub1"] });
      if (r.error) throw r.error;
    }
    await storage.close();
  },
});

//
// 3. Cache-size scaling: K=16, 64, 256.
//
// Loop shape is fixed at {write sub0/count; read sub1}. The cache holds K
// cached sibling reads.
//
// Historical caveat (preserved for context): pre-#3704, per-write cost
// was the SUM of two K-dependent things: structural-sharing cost
// (`{ ...obj, sub0: newSub0 }` rebuilding the K-wide `value` container)
// AND cache invalidation cost (the sibling sweep). Post-#3704 the
// production write path applies a planned write, by way of
// `cloneForMutation()`, which does per-spine shallow thaw and then
// in-place mutates -- so the structural-sharing-of-K-wide-container
// cost is gone, and PathKeyMap brings invalidation to O(D). The bench
// remains shaped to flag any future change that re-introduces K-scaling.
// To isolate just the invalidator's O(K)-vs-O(D) behavior, see
// `packages/utils/test/path-key-map.bench.ts`.
//

for (const K of [16, 64, 256]) {
  Deno.bench({
    name: `frozenReads: K=${K} cache; ${ITERATIONS}x {write sub0; read sub1}`,
    group: "cache-size-scaling",
    async fn(b) {
      const { storage, tx } = setupPrimedSiblingTransaction(K);
      b.start();
      for (let i = 0; i < ITERATIONS; i++) {
        const w = tx.write({
          space,
          id: ID,
          type,
          path: ["value", "sub0", "count"],
        }, i + 1);
        if (w.error) throw w.error;
        const r = tx.read({
          space,
          id: ID,
          type,
          path: ["value", "sub1"],
        });
        if (r.error) throw r.error;
      }
      b.end();
      await storage.close();
    },
  });
}

//
// 4. Deep nested-path write.
//
// Writes at depth-7 path `value/a/b/c/d/e/items/0`, with three cached
// sibling reads at varying depths along the chain. Stresses the per-write
// walk's depth dependence; a trie walker pays O(D), an O(N) scanner pays
// the same as the K=16 case.
//

const seedDeep = () => ({
  value: {
    a: {
      b: {
        c: {
          d: {
            e: {
              items: [{ count: 0 }],
              other: { hello: "world" },
            },
            sibAtD: { kept: true },
          },
        },
      },
      sibAtA: { kept: true },
    },
    topSib: { kept: true },
  },
});

const setupPrimedDeepTransaction = () => {
  const storage = StorageManager.emulate({ as: signer });
  const tx = storage.edit();
  const w = tx.write({ space, id: ID, type, path: [] }, seedDeep());
  if (w.error) throw w.error;
  // Prime cache at sibling paths off the deep write chain.
  const paths: string[][] = [
    ["value", "topSib"],
    ["value", "a", "sibAtA"],
    ["value", "a", "b", "c", "d", "sibAtD"],
    ["value", "a", "b", "c", "d", "e", "other"],
  ];
  for (const path of paths) {
    const r = tx.read({ space, id: ID, type, path });
    if (r.error) throw r.error;
  }
  return { storage, tx };
};

Deno.bench({
  name:
    `frozenReads: ${ITERATIONS}x {write depth-7 path; read 4 chain-sibling paths}`,
  group: "deep-path",
  async fn() {
    const { storage, tx } = setupPrimedDeepTransaction();
    const writePath = ["value", "a", "b", "c", "d", "e", "items", "0"];
    const readPaths: string[][] = [
      ["value", "topSib"],
      ["value", "a", "sibAtA"],
      ["value", "a", "b", "c", "d", "sibAtD"],
      ["value", "a", "b", "c", "d", "e", "other"],
    ];
    for (let i = 0; i < ITERATIONS; i++) {
      const w = tx.write(
        { space, id: ID, type, path: writePath },
        { count: i + 1 },
      );
      if (w.error) throw w.error;
      for (const path of readPaths) {
        const r = tx.read({ space, id: ID, type, path });
        if (r.error) throw r.error;
      }
    }
    await storage.close();
  },
});
