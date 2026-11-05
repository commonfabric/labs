/**
 * A/B bench: is `compactChangeSet()` worth re-enabling on the write path?
 *
 * Historically `applyChangeSet()` called `compactChangeSet()` to drop
 * child writes that overlap a parent write at the same address. That was
 * removed (see the comment at the top of `applyChangeSet` in
 * `data-updating.ts`) because structural-sharing writes made the
 * redundant writes cheap enough that compaction's O(N^2) overhead lost.
 *
 * This bench preserves that comparison on the *current* production write
 * path: `tx.writeValuesOrThrow()` -> `writeBatch` ->
 * a planned write's `apply()` (i.e. mutate-in-place along the spine, with
 * the rest of the doc structurally shared). If a future change makes
 * compaction look profitable again, this bench is where it should show.
 *
 * Run with:
 *   deno bench --allow-ffi --allow-env --allow-read \
 *     --allow-write=/tmp,/var/folders test/compact-real.bench.ts
 */

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { type ChangeSet, compactChangeSet } from "../src/data-updating.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("compact-real-bench");
const space = signer.did();
const ID = "of:compact-real-bench" as const;

const makeSourceValue = (size: number): FabricValue => {
  const value: Record<string, FabricValue> = {};
  for (let i = 0; i < size; i++) {
    value[`item${i}`] = { a: 1, b: 2, c: 3 };
  }
  return { value };
};

const makeChanges = (count: number, overlapPercent: number): ChangeSet => {
  const changes: ChangeSet = [];
  const parentCount = Math.floor((count * overlapPercent) / 100);

  // Parent writes (whole-object replacements).
  for (let i = 0; i < parentCount; i++) {
    changes.push({
      location: {
        id: ID,
        space,
        scope: "space",
        path: ["value", `item${i}`],
      },
      value: { a: 1, b: 2, c: 3 },
    });
  }

  // Overlapping child writes -- each one is redundant once its parent
  // write above has been applied. `compactChangeSet` should drop these.
  for (let i = 0; i < count - parentCount; i++) {
    const parentIdx = i % Math.max(1, parentCount);
    changes.push({
      location: {
        id: ID,
        space,
        scope: "space",
        path: ["value", `item${parentIdx}`, "a"],
      },
      value: 1,
    });
  }

  return changes;
};

/**
 * Set up a single primed transaction with the initial source value
 * already written. Returns the runtime/storage handles and a tx ready
 * for the benchmarked writes. Caller is responsible for cleanup.
 */
const setupPrimedTransaction = (sourceSize: number) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  tx.writeValueOrThrow(
    { space, id: ID, scope: "space", path: [] },
    makeSourceValue(sourceSize),
  );
  return { runtime, storageManager, tx };
};

/**
 * Apply a changeset to a primed tx via the production batched write
 * path. Mirrors what `applyChangeSet()` would do for an external caller
 * (which routes through `tx.writeValuesOrThrow`).
 */
const applyAll = (
  tx: ReturnType<Runtime["edit"]>,
  changes: ChangeSet,
): void => {
  // `writeValuesOrThrow` is optional on the interface but always present
  // on the runtime tx; the `!` assertion is fine for a bench.
  tx.writeValuesOrThrow!(
    changes.map((change) => ({
      address: change.location,
      value: change.value,
    })),
  );
};

const writesWithoutCompact = async (
  b: Deno.BenchContext,
  sourceSize: number,
  changes: ChangeSet,
): Promise<void> => {
  const { runtime, storageManager, tx } = setupPrimedTransaction(sourceSize);
  b.start();
  applyAll(tx, changes);
  b.end();
  tx.abort();
  await runtime.dispose();
  await storageManager.close();
};

const writesWithCompact = async (
  b: Deno.BenchContext,
  sourceSize: number,
  changes: ChangeSet,
): Promise<void> => {
  const { runtime, storageManager, tx } = setupPrimedTransaction(sourceSize);
  b.start();
  const compacted = compactChangeSet(changes);
  applyAll(tx, compacted);
  b.end();
  tx.abort();
  await runtime.dispose();
  await storageManager.close();
};

const changes20_25 = makeChanges(20, 25); // 5 parents + 15 children = 15 redundant
const changes20_50 = makeChanges(20, 50); // 10 parents + 10 children = 10 redundant
const changes100_40 = makeChanges(100, 40); // 40 parents + 60 children = 60 redundant

Deno.bench({
  name: "20 changes, 25% overlap - WITHOUT compactChangeSet",
  group: "20_25",
}, async (b) => await writesWithoutCompact(b, 20, changes20_25));

Deno.bench({
  name: "20 changes, 25% overlap - WITH compactChangeSet",
  group: "20_25",
}, async (b) => await writesWithCompact(b, 20, changes20_25));

Deno.bench({
  name: "20 changes, 50% overlap - WITHOUT compactChangeSet",
  group: "20_50",
}, async (b) => await writesWithoutCompact(b, 20, changes20_50));

Deno.bench({
  name: "20 changes, 50% overlap - WITH compactChangeSet",
  group: "20_50",
}, async (b) => await writesWithCompact(b, 20, changes20_50));

Deno.bench({
  name: "100 changes, 40% overlap - WITHOUT compactChangeSet",
  group: "100_40",
}, async (b) => await writesWithoutCompact(b, 100, changes100_40));

Deno.bench({
  name: "100 changes, 40% overlap - WITH compactChangeSet",
  group: "100_40",
}, async (b) => await writesWithCompact(b, 100, changes100_40));
