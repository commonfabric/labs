/**
 * Storage layer benchmarks - measuring raw transaction read/write performance
 */

import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  largeStringA,
  largeStringB,
  largeStringC,
  manySmallObjectsA,
  manySmallObjectsB,
  manySmallObjectsC,
  manySmallObjectsD,
  medianComplexityA,
  medianComplexityB,
  medianComplexityC,
  medianComplexityD,
} from "./bench-fixtures.ts";

const signer = await Identity.fromPassphrase("bench storage");
const space = signer.did();

// Setup helper
function setup() {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

// Cleanup helper
async function cleanup(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  tx: IExtendedStorageTransaction,
) {
  await tx.commit().settled;
  await runtime.dispose();
  await storageManager.close();
}

const writeDocument = (
  tx: IExtendedStorageTransaction,
  id: string,
  value: FabricValue,
) => {
  tx.writeValueOrThrow({
    space,
    scope: "space",
    id: id as `test:${string}`,
    path: [],
  }, value);
};

const readDocument = (
  tx: IExtendedStorageTransaction,
  id: string,
) => {
  tx.readValueOrThrow({
    space,
    scope: "space",
    id: id as `test:${string}`,
    path: [],
  });
};

//
// Write operations
//

Deno.bench(
  "Storage - tx.write raw (100x)",
  { group: "write-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:raw-w-${i}`,
          path: ["value"],
        },
        i,
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.writeOrThrow (100x)",
  { group: "write-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.writeOrThrow(
        {
          space,
          scope: "space",
          id: `test:throw-w-${i}`,
          path: ["value"],
        },
        i,
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.writeValueOrThrow (100x)",
  { group: "write-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.writeValueOrThrow(
        {
          space,
          scope: "space",
          id: `test:value-w-${i}`,
          path: [],
        },
        i,
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.write to root path (100x)",
  { group: "write-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:root-write-${i}`,
          path: [],
        },
        { value: i },
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.writeValueOrThrow nested loop (100x)",
  { group: "write-batch" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.writeValueOrThrow(
        {
          space,
          scope: "space",
          id: `test:nested-loop-${i}`,
          path: ["profile", "name"],
        },
        `user-${i}`,
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.writeValuesOrThrow nested batch (100x)",
  { group: "write-batch" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    tx.writeValuesOrThrow?.(
      Array.from({ length: 100 }, (_, i) => ({
        address: {
          space,
          scope: "space",
          id: `test:nested-batch-${i}`,
          path: ["profile", "name"],
        },
        value: `user-${i}`,
      })),
    );

    await cleanup(runtime, storageManager, tx);
  },
);

//
// Read operations
//

Deno.bench(
  "Storage - tx.read after tx.write (100x)",
  { group: "read-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write with tx.write to root
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:read-raw-${i}`,
          path: [],
        },
        { value: i },
      );
    }

    // Read with tx.read
    for (let i = 0; i < 100; i++) {
      tx.read({
        space,
        scope: "space",
        id: `test:read-raw-${i}`,
        path: ["value"],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.readOrThrow after tx.write (100x)",
  { group: "read-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write with tx.write to root
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:read-throw-${i}`,
          path: [],
        },
        { value: i },
      );
    }

    // Read with tx.readOrThrow
    for (let i = 0; i < 100; i++) {
      tx.readOrThrow({
        space,
        scope: "space",
        id: `test:read-throw-${i}`,
        path: ["value"],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - readValueOrThrow after writeValueOrThrow (100x)",
  { group: "read-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write with writeValueOrThrow
    for (let i = 0; i < 100; i++) {
      tx.writeValueOrThrow(
        {
          space,
          scope: "space",
          id: `test:read-value-${i}`,
          path: [],
        },
        i,
      );
    }

    // Read with readValueOrThrow
    for (let i = 0; i < 100; i++) {
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: `test:read-value-${i}`,
        path: [],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.read only, pre-written (1000x)",
  { group: "read-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Pre-write with tx.write to root
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:prewrite-${i}`,
          path: [],
        },
        { value: i },
      );
    }

    // Many reads on same entities
    for (let j = 0; j < 1000; j++) {
      tx.read({
        space,
        scope: "space",
        id: `test:prewrite-${j % 100}`,
        path: ["value"],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

//
// Entity creation overhead
//

Deno.bench(
  "Storage - new entity overhead (100x)",
  { group: "entity-creation" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Each write to a new entity root
    for (let i = 0; i < 100; i++) {
      const result = tx.write(
        {
          space,
          scope: "space",
          id: `test:create-${i}`,
          path: [],
        },
        { value: i },
      );
      if (result.error) throw new Error("Write failed");
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - same entity writes (100x)",
  { group: "entity-creation" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // First write creates entity
    tx.write(
      {
        space,
        scope: "space",
        id: "test:same-entity-repeat",
        path: [],
      },
      { value: 0 },
    );

    // Subsequent writes just update
    for (let i = 1; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: "test:same-entity-repeat",
          path: [],
        },
        { value: i },
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - nested path on existing (100x)",
  { group: "entity-creation" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Create 100 entities first
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:existing-${i}`,
          path: [],
        },
        { value: 0 },
      );
    }

    // Now write to nested path (should be fast, entity exists)
    for (let i = 0; i < 100; i++) {
      const result = tx.write(
        {
          space,
          scope: "space",
          id: `test:existing-${i}`,
          path: ["value"],
        },
        i,
      );
      if (result.error) throw new Error("Nested write failed");
    }

    await cleanup(runtime, storageManager, tx);
  },
);

//
// Path depth comparison
//

Deno.bench(
  "Storage - read shallow path (100x)",
  { group: "path-depth" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write deeply nested structure
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:path-${i}`,
          path: [],
        },
        { a: { b: { c: { d: { e: { f: i } } } } } },
      );
    }

    // Read shallow path
    for (let i = 0; i < 100; i++) {
      tx.read({
        space,
        scope: "space",
        id: `test:path-${i}`,
        path: ["a"],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - read deep path (100x)",
  { group: "path-depth" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write deeply nested structure
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:deep-path-${i}`,
          path: [],
        },
        { a: { b: { c: { d: { e: { f: i } } } } } },
      );
    }

    // Read deep path (6 levels)
    for (let i = 0; i < 100; i++) {
      tx.read({
        space,
        scope: "space",
        id: `test:deep-path-${i}`,
        path: ["a", "b", "c", "d", "e", "f"],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

//
// Commit overhead
//

Deno.bench(
  "Storage - empty commit",
  { group: "commit" },
  async () => {
    const { runtime, storageManager, tx } = setup();
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Storage - commit after 100 writes",
  { group: "commit" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write 100 entities
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:commit-${i}`,
          path: [],
        },
        { value: i },
      );
    }

    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  },
);

//
// Overhead sources (microbenchmarks)
//

Deno.bench(
  "Overhead - object creation (1000x)",
  { group: "overhead" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _addr = {
        space,
        scope: "space",
        id: `test:obj-${i}`,
        path: ["value", "nested"],
      };
    }
  },
);

Deno.bench(
  "Overhead - object spread (1000x)",
  { group: "overhead" },
  () => {
    const base = {
      space,
      scope: "space",
      id: "test:base",
      path: [] as string[],
    };
    for (let i = 0; i < 1000; i++) {
      const _addr = { ...base, path: ["value", ...base.path] };
    }
  },
);

Deno.bench(
  "Overhead - Map operations (1000x)",
  { group: "overhead" },
  () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const key = `test:entity-${i % 100}/application/json`;
      map.set(key, i);
      map.get(key);
    }
  },
);

Deno.bench(
  "Overhead - string template keys (1000x)",
  { group: "overhead" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _key = `test:entity-${i % 100}/application/json`;
    }
  },
);

Deno.bench(
  "Overhead - array push (1000x)",
  { group: "overhead" },
  () => {
    const activity: unknown[] = [];
    for (let i = 0; i < 1000; i++) {
      activity.push({
        read: {
          space,
          scope: "space",
          id: `test:activity-${i}`,
          path: ["value"],
          meta: {},
        },
      });
    }
  },
);

//
// Entity creation breakdown - isolate what makes first write slow
//

Deno.bench(
  "Entity creation breakdown - first write only (100x new entities)",
  { group: "entity-breakdown" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Each iteration writes to a NEW entity (forces entity creation)
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:first-write-${i}`,
          path: [],
        },
        { value: i },
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Entity creation breakdown - 100 writes to 1 entity",
  { group: "entity-breakdown" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // First write creates the entity
    tx.write(
      {
        space,
        scope: "space",
        id: "test:single-entity",
        path: [],
      },
      { value: 0 },
    );

    // Subsequent writes reuse the working copy
    for (let i = 1; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: "test:single-entity",
          path: [],
        },
        { value: i },
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Entity creation breakdown - 100 writes to 10 entities (10 each)",
  { group: "entity-breakdown" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // 10 entities, 10 writes each
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:ten-entities-${i % 10}`,
          path: [],
        },
        { value: i },
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Entity creation breakdown - nested path after entity exists (100x)",
  { group: "entity-breakdown" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Create 100 entities first
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:nested-${i}`,
          path: [],
        },
        { data: { nested: { value: 0 } } },
      );
    }

    // Now write to nested paths (entity already exists, has working copy)
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:nested-${i}`,
          path: ["data", "nested", "value"],
        },
        i,
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

//
// Microbenchmarks to isolate entity creation overhead sources
//

Deno.bench(
  "Overhead - Map get/set (1000x)",
  { group: "entity-overhead" },
  () => {
    const map = new Map<string, object>();
    for (let i = 0; i < 1000; i++) {
      const key = `test:entity-${i}/application/json`;
      if (!map.get(key)) {
        map.set(key, { value: i });
      }
    }
  },
);

Deno.bench(
  "Overhead - Map get only, cache hit (1000x)",
  { group: "entity-overhead" },
  () => {
    const map = new Map<string, object>();
    map.set("test:entity/application/json", { value: 0 });
    for (let i = 0; i < 1000; i++) {
      map.get("test:entity/application/json");
    }
  },
);

Deno.bench(
  "Overhead - template literal key creation (1000x)",
  { group: "entity-overhead" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const id = `test:entity-${i}`;
      const type = "application/json";
      const _key = `${id}/${type}`;
    }
  },
);

Deno.bench(
  "Overhead - JSON.stringify empty array (1000x)",
  { group: "entity-overhead" },
  () => {
    const path: string[] = [];
    for (let i = 0; i < 1000; i++) {
      JSON.stringify(path);
    }
  },
);

Deno.bench(
  "Overhead - object spread (1000x)",
  { group: "entity-overhead" },
  () => {
    const base = { id: "test:entity", type: "application/json" };
    for (let i = 0; i < 1000; i++) {
      const _copy = { ...base, path: [] };
    }
  },
);

Deno.bench(
  "Overhead - nested object creation (1000x)",
  { group: "entity-overhead" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _obj = {
        address: { id: `test:entity-${i}`, type: "application/json", path: [] },
        value: { data: i },
      };
    }
  },
);

Deno.bench(
  "Overhead - new Map creation (1000x)",
  { group: "entity-overhead" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _map = new Map<string, unknown>();
    }
  },
);

//
// Isolate write vs commit overhead
//

Deno.bench(
  "Write vs Commit - 100 new entities, measure writes only",
  { group: "write-vs-commit" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    b.start();
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:wvc-new-${i}`,
          path: [],
        },
        { value: i },
      );
    }
    b.end();

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Write vs Commit - 100 writes to 1 entity, measure writes only",
  { group: "write-vs-commit" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    b.start();
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: "test:wvc-same",
          path: [],
        },
        { value: i },
      );
    }
    b.end();

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Write vs Commit - 100 new entities, measure commit only",
  { group: "write-vs-commit" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: `test:wvc-commit-new-${i}`,
          path: [],
        },
        { value: i },
      );
    }

    b.start();
    await tx.commit().settled;
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Write vs Commit - 100 writes to 1 entity, measure commit only",
  { group: "write-vs-commit" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          scope: "space",
          id: "test:wvc-commit-same",
          path: [],
        },
        { value: i },
      );
    }

    b.start();
    await tx.commit().settled;
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

//
// Realistic commit benchmarks - using "median complexity" data
//
// These measure commit performance with realistic Cell data, testing the
// differential change detection (which now uses deepEqual).
//

Deno.bench(
  "Realistic commit - equal values, no change (100x)",
  { group: "realistic-commit" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    // Write 100 entities with medianComplexityA, then "update" with equal value
    for (let i = 0; i < 100; i++) {
      writeDocument(tx, `test:realistic-eq-${i}`, medianComplexityA);
    }
    // Commit first batch
    await tx.commit().settled;

    // Start new transaction and write identical values
    const tx2 = runtime.edit();
    for (let i = 0; i < 100; i++) {
      writeDocument(tx2, `test:realistic-eq-${i}`, medianComplexityB);
    }

    b.start();
    await tx2.commit().settled;
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Realistic commit - unequal late (100x)",
  { group: "realistic-commit" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    // Write 100 entities with medianComplexityA
    for (let i = 0; i < 100; i++) {
      writeDocument(tx, `test:realistic-late-${i}`, medianComplexityA);
    }
    await tx.commit().settled;

    // Update with values that differ at end of structure
    const tx2 = runtime.edit();
    for (let i = 0; i < 100; i++) {
      writeDocument(tx2, `test:realistic-late-${i}`, medianComplexityC);
    }

    b.start();
    await tx2.commit().settled;
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Realistic commit - unequal early (100x)",
  { group: "realistic-commit" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    // Write 100 entities with medianComplexityA
    for (let i = 0; i < 100; i++) {
      writeDocument(tx, `test:realistic-early-${i}`, medianComplexityA);
    }
    await tx.commit().settled;

    // Update with values that differ at start of structure
    const tx2 = runtime.edit();
    for (let i = 0; i < 100; i++) {
      writeDocument(tx2, `test:realistic-early-${i}`, medianComplexityD);
    }

    b.start();
    await tx2.commit().settled;
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

//
// Realistic commit benchmarks with large strings (100k chars)
//
// This tests the case where deepEqual should clearly win: comparing large
// strings. JSON.stringify must serialize both 100k strings every comparison,
// while deepEqual just uses === on strings directly (no construction).
//

Deno.bench(
  "Large string commit - equal values (50x)",
  { group: "large-string-commit" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    // Write 50 entities with largeStringA (contains 100k string)
    for (let i = 0; i < 50; i++) {
      writeDocument(tx, `test:large-eq-${i}`, largeStringA);
    }
    await tx.commit().settled;

    // "Update" with identical values
    const tx2 = runtime.edit();
    for (let i = 0; i < 50; i++) {
      writeDocument(tx2, `test:large-eq-${i}`, largeStringB);
    }

    b.start();
    await tx2.commit().settled;
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Large string commit - diff at end of string (50x)",
  { group: "large-string-commit" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    // Write 50 entities with largeStringA
    for (let i = 0; i < 50; i++) {
      writeDocument(tx, `test:large-diff-${i}`, largeStringA);
    }
    await tx.commit().settled;

    // Update with values where 100k string differs only at last char
    const tx2 = runtime.edit();
    for (let i = 0; i < 50; i++) {
      writeDocument(tx2, `test:large-diff-${i}`, largeStringC);
    }

    b.start();
    await tx2.commit().settled;
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

//
// Read invariant validation benchmarks (exercises attestation.claim())
//
// At commit time, each read invariant is validated via attestation.claim()
// which compares expected vs actual values using JSON.stringify. This tests
// the impact of that comparison with large string data.
//

Deno.bench(
  "Read validation - large string, unchanged (50x)",
  { group: "read-validation" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    // Write 50 entities with large strings
    for (let i = 0; i < 50; i++) {
      writeDocument(tx, `test:read-val-${i}`, largeStringA);
    }
    await tx.commit().settled;

    // New transaction: read all entities (creates read invariants)
    const tx2 = runtime.edit();
    for (let i = 0; i < 50; i++) {
      readDocument(tx2, `test:read-val-${i}`);
    }

    // Commit validates each read invariant via attestation.claim()
    b.start();
    await tx2.commit().settled;
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

//
// Value comparison: JSON.stringify vs deepEqual
//
// These benchmarks compare the two approaches used for equality checking in
// the storage layer. Uses shared "median complexity" fixtures defined at top.
//

Deno.bench(
  "Compare - JSON.stringify, equal values (1000x)",
  { group: "value-comparison" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _result =
        JSON.stringify(medianComplexityA) === JSON.stringify(medianComplexityB);
    }
  },
);

Deno.bench(
  "Compare - deepEqual, equal values (1000x)",
  { group: "value-comparison" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _result = deepEqual(medianComplexityA, medianComplexityB);
    }
  },
);

Deno.bench(
  "Compare - JSON.stringify, unequal late (1000x)",
  { group: "value-comparison" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _result =
        JSON.stringify(medianComplexityA) === JSON.stringify(medianComplexityC);
    }
  },
);

Deno.bench(
  "Compare - deepEqual, unequal late (1000x)",
  { group: "value-comparison" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _result = deepEqual(medianComplexityA, medianComplexityC);
    }
  },
);

Deno.bench(
  "Compare - JSON.stringify, unequal early (1000x)",
  { group: "value-comparison" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _result =
        JSON.stringify(medianComplexityA) === JSON.stringify(medianComplexityD);
    }
  },
);

Deno.bench(
  "Compare - deepEqual, unequal early (1000x)",
  { group: "value-comparison" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _result = deepEqual(medianComplexityA, medianComplexityD);
    }
  },
);

//
// Value comparison: JSON.stringify vs deepEqual (many small objects)
//
// Tests comparison performance on wide, shallow object graphs with many
// properties spread across many small objects (4,500 properties total).
//

Deno.bench(
  "Compare - JSON.stringify, many small objects equal (100x)",
  { group: "value-comparison-small-objects" },
  () => {
    for (let i = 0; i < 100; i++) {
      const _result = JSON.stringify(manySmallObjectsA) ===
        JSON.stringify(manySmallObjectsB);
    }
  },
);

Deno.bench(
  "Compare - deepEqual, many small objects equal (100x)",
  { group: "value-comparison-small-objects" },
  () => {
    for (let i = 0; i < 100; i++) {
      const _result = deepEqual(manySmallObjectsA, manySmallObjectsB);
    }
  },
);

Deno.bench(
  "Compare - JSON.stringify, many small objects unequal late (100x)",
  { group: "value-comparison-small-objects" },
  () => {
    for (let i = 0; i < 100; i++) {
      const _result = JSON.stringify(manySmallObjectsA) ===
        JSON.stringify(manySmallObjectsC);
    }
  },
);

Deno.bench(
  "Compare - deepEqual, many small objects unequal late (100x)",
  { group: "value-comparison-small-objects" },
  () => {
    for (let i = 0; i < 100; i++) {
      const _result = deepEqual(manySmallObjectsA, manySmallObjectsC);
    }
  },
);

Deno.bench(
  "Compare - JSON.stringify, many small objects unequal early (100x)",
  { group: "value-comparison-small-objects" },
  () => {
    for (let i = 0; i < 100; i++) {
      const _result = JSON.stringify(manySmallObjectsA) ===
        JSON.stringify(manySmallObjectsD);
    }
  },
);

Deno.bench(
  "Compare - deepEqual, many small objects unequal early (100x)",
  { group: "value-comparison-small-objects" },
  () => {
    for (let i = 0; i < 100; i++) {
      const _result = deepEqual(manySmallObjectsA, manySmallObjectsD);
    }
  },
);
