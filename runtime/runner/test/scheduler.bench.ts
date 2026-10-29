/**
 * Scheduler benchmarks - measuring scheduler-specific operations
 *
 * For cell layer benchmarks, see cell.bench.ts
 * For storage layer benchmarks, see storage.bench.ts
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { toMemorySpaceAddress } from "../src/link-utils.ts";
import {
  addressesToPathByEntity,
  sortAndCompactPaths,
} from "../src/reactive-dependencies.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";

const signer = await Identity.fromPassphrase("bench operator");
const space = signer.did();

// Setup helper

// Identity entity keys resolve scoped addresses against (stage E).
const TEST_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

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

Deno.bench(
  "Scheduler - 100 computations, shared entity reads",
  { group: "dependency-lookup" },
  async () => {
    // Benchmark: Many independent computations writing to same entity
    // This tests the writersByEntity index lookup

    const { runtime, storageManager, tx } = setup();

    // Create a shared source cell that many computations read from
    const source = runtime.getCell<number>(
      space,
      "bench-source",
      undefined,
      tx,
    );
    source.set(0);

    // Create 100 computations that each write to their own cell
    // deno-lint-ignore no-explicit-any
    const outputs: any[] = [];
    const actions: Action[] = [];

    for (let i = 0; i < 100; i++) {
      const output = runtime.getCell<number>(
        space,
        `bench-output-${i}`,
        undefined,
        tx,
      );
      output.set(0);
      outputs.push(output);

      const action: Action = (actionTx) => {
        const val = source.withTx(actionTx).get();
        output.withTx(actionTx).send(val + i);
      };
      actions.push(action);

      runtime.scheduler.subscribe(
        action,
        {
          reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        },
        {},
      );
    }

    // Trigger all computations
    await runtime.idle();

    // Cleanup
    for (const action of actions) {
      runtime.scheduler.unsubscribe(action);
    }
    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Scheduler - deep chain (50 levels)",
  { group: "dirty-propagation" },
  async () => {
    // Benchmark: Deep dependency chain (A -> B -> C -> D -> ...)
    // Tests markDirty propagation with early termination

    const { runtime, storageManager, tx } = setup();

    // deno-lint-ignore no-explicit-any
    const cells: any[] = [];
    const actions: Action[] = [];

    // Create chain of 50 cells
    for (let i = 0; i < 50; i++) {
      const cell = runtime.getCell<number>(
        space,
        `bench-chain-${i}`,
        undefined,
        tx,
      );
      cell.set(i);
      cells.push(cell);
    }

    // Create computations: cell[i+1] = cell[i] + 1
    for (let i = 0; i < 49; i++) {
      const input = cells[i];
      const output = cells[i + 1];

      const action: Action = (actionTx) => {
        const val = input.withTx(actionTx).get();
        output.withTx(actionTx).send(val + 1);
      };
      actions.push(action);

      runtime.scheduler.subscribe(
        action,
        {
          reads: [toMemorySpaceAddress(input.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        },
        {},
      );
    }

    // Trigger chain
    await runtime.idle();

    // Cleanup
    for (const action of actions) {
      runtime.scheduler.unsubscribe(action);
    }
    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Scheduler - wide graph (1 source, 100 readers)",
  { group: "dependency-lookup" },
  async () => {
    // Benchmark: Wide dependency graph (1 source -> 100 outputs)
    // Tests updateDependents with many readers of same entity

    const { runtime, storageManager, tx } = setup();

    const source = runtime.getCell<number>(
      space,
      "bench-wide-source",
      undefined,
      tx,
    );
    source.set(0);

    // deno-lint-ignore no-explicit-any
    const outputs: any[] = [];
    const actions: Action[] = [];

    for (let i = 0; i < 100; i++) {
      const output = runtime.getCell<number>(
        space,
        `bench-wide-output-${i}`,
        undefined,
        tx,
      );
      output.set(0);
      outputs.push(output);

      const action: Action = (actionTx) => {
        const val = source.withTx(actionTx).get();
        output.withTx(actionTx).send(val * i);
      };
      actions.push(action);

      runtime.scheduler.subscribe(
        action,
        {
          reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        },
        {},
      );
    }

    // Run all computations
    await runtime.idle();

    // Update source and propagate
    source.send(1);
    await runtime.idle();

    // Cleanup
    for (const action of actions) {
      runtime.scheduler.unsubscribe(action);
    }
    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Scheduler - subscribe/unsubscribe cycle (100x)",
  { group: "subscription" },
  async () => {
    // Benchmark: Subscribe/unsubscribe cycle
    // Tests the overhead of index maintenance

    const { runtime, storageManager, tx } = setup();

    const source = runtime.getCell<number>(
      space,
      "bench-sub-source",
      undefined,
      tx,
    );
    source.set(0);
    const output = runtime.getCell<number>(
      space,
      "bench-sub-output",
      undefined,
      tx,
    );
    output.set(0);

    const action: Action = (actionTx) => {
      output.withTx(actionTx).send(source.withTx(actionTx).get() + 1);
    };

    // Subscribe and unsubscribe 100 times
    for (let i = 0; i < 100; i++) {
      runtime.scheduler.subscribe(
        action,
        {
          reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        },
        {},
      );
      runtime.scheduler.unsubscribe(action);
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Scheduler - 100 entities, sparse deps",
  { group: "dependency-lookup" },
  async () => {
    // Benchmark: Many entities, sparse dependencies
    // Tests that we don't iterate all actions when looking up writers

    const { runtime, storageManager, tx } = setup();

    // deno-lint-ignore no-explicit-any
    const cells: any[] = [];
    const actions: Action[] = [];

    // Create 100 independent cells
    for (let i = 0; i < 100; i++) {
      const cell = runtime.getCell<number>(
        space,
        `bench-sparse-${i}`,
        undefined,
        tx,
      );
      cell.set(i);
      cells.push(cell);
    }

    // Create 100 computations, each reading from one cell and writing to next
    for (let i = 0; i < 99; i++) {
      const input = cells[i];
      const output = cells[i + 1];

      const action: Action = (actionTx) => {
        output.withTx(actionTx).send(input.withTx(actionTx).get());
      };
      actions.push(action);

      runtime.scheduler.subscribe(
        action,
        {
          reads: [toMemorySpaceAddress(input.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        },
        {},
      );
    }

    await runtime.idle();

    // Cleanup
    for (const action of actions) {
      runtime.scheduler.unsubscribe(action);
    }
    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Scheduler - diamond pattern (10 diamonds)",
  { group: "dirty-propagation" },
  async () => {
    // Benchmark: Diamond dependency pattern
    // A -> B, A -> C, B -> D, C -> D

    const { runtime, storageManager, tx } = setup();

    const actions: Action[] = [];

    for (let d = 0; d < 10; d++) {
      const a = runtime.getCell<number>(
        space,
        `bench-diamond-${d}-a`,
        undefined,
        tx,
      );
      const b = runtime.getCell<number>(
        space,
        `bench-diamond-${d}-b`,
        undefined,
        tx,
      );
      const c = runtime.getCell<number>(
        space,
        `bench-diamond-${d}-c`,
        undefined,
        tx,
      );
      const result = runtime.getCell<number>(
        space,
        `bench-diamond-${d}-d`,
        undefined,
        tx,
      );

      a.set(d);
      b.set(0);
      c.set(0);
      result.set(0);

      // A -> B
      const actionAB: Action = (actionTx) => {
        b.withTx(actionTx).send(a.withTx(actionTx).get() * 2);
      };
      actions.push(actionAB);
      runtime.scheduler.subscribe(
        actionAB,
        {
          reads: [toMemorySpaceAddress(a.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(b.getAsNormalizedFullLink())],
        },
        {},
      );

      // A -> C
      const actionAC: Action = (actionTx) => {
        c.withTx(actionTx).send(a.withTx(actionTx).get() * 3);
      };
      actions.push(actionAC);
      runtime.scheduler.subscribe(
        actionAC,
        {
          reads: [toMemorySpaceAddress(a.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(c.getAsNormalizedFullLink())],
        },
        {},
      );

      // B, C -> D
      const actionBCD: Action = (actionTx) => {
        result.withTx(actionTx).send(
          b.withTx(actionTx).get() + c.withTx(actionTx).get(),
        );
      };
      actions.push(actionBCD);
      runtime.scheduler.subscribe(
        actionBCD,
        {
          reads: [
            toMemorySpaceAddress(b.getAsNormalizedFullLink()),
            toMemorySpaceAddress(c.getAsNormalizedFullLink()),
          ],
          shallowReads: [],
          writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
        },
        {},
      );
    }

    await runtime.idle();

    // Cleanup
    for (const action of actions) {
      runtime.scheduler.unsubscribe(action);
    }
    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Scheduler - repeated dirty marking",
  { group: "dirty-propagation" },
  async () => {
    // Benchmark: repeated dirty propagation over already-marked nodes.
    // Tests that markDirty stops at already-marked nodes.

    const { runtime, storageManager, tx } = setup();

    // deno-lint-ignore no-explicit-any
    const cells: any[] = [];
    const actions: Action[] = [];

    // Create a chain
    for (let i = 0; i < 20; i++) {
      const cell = runtime.getCell<number>(
        space,
        `bench-repeat-${i}`,
        undefined,
        tx,
      );
      cell.set(i);
      cells.push(cell);
    }

    // Chain computations
    for (let i = 0; i < 19; i++) {
      const input = cells[i];
      const output = cells[i + 1];

      const action: Action = (actionTx) => {
        output.withTx(actionTx).send(input.withTx(actionTx).get() + 1);
      };
      actions.push(action);

      runtime.scheduler.subscribe(
        action,
        {
          reads: [toMemorySpaceAddress(input.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        },
        {},
      );
    }

    // Initial run
    await runtime.idle();

    // Multiple updates to first cell before idle
    // Should mark dirty once, not repeatedly traverse
    cells[0].send(100);
    cells[0].send(101);
    cells[0].send(102);
    await runtime.idle();

    // Cleanup
    for (const action of actions) {
      runtime.scheduler.unsubscribe(action);
    }
    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Scheduler - pull with resubscribe (50 pulls)",
  { group: "subscription" },
  async () => {
    // Benchmark: Pull-mode resubscribe cycle
    // Tests the unsubscribe/resubscribe that happens during pull()

    const { runtime, storageManager, tx } = setup();

    // Enable pull mode for this test

    const source = runtime.getCell<number>(
      space,
      "bench-pull-source",
      undefined,
      tx,
    );
    source.set(0);
    const output = runtime.getCell<number>(
      space,
      "bench-pull-output",
      undefined,
      tx,
    );
    output.set(0);

    const action: Action = (actionTx) => {
      output.withTx(actionTx).send(source.withTx(actionTx).get() + 1);
    };

    runtime.scheduler.subscribe(
      action,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      {},
    );

    // Multiple pulls - each causes unsubscribe/resubscribe
    for (let i = 0; i < 50; i++) {
      source.send(i);
      await output.pull();
    }

    runtime.scheduler.unsubscribe(action);
    await cleanup(runtime, storageManager, tx);
  },
);

//
// MICRO-BENCHMARKS: Isolated operations to measure overhead
//

Deno.bench(
  "Overhead - setup/teardown only",
  { group: "overhead" },
  async () => {
    const { runtime, storageManager, tx } = setup();
    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Overhead - create 100 cells (getCell + set)",
  { group: "overhead" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      const cell = runtime.getCell<number>(
        space,
        `overhead-cell-${i}`,
        undefined,
        tx,
      );
      cell.set(i);
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Overhead - 100x getCell only (no set)",
  { group: "overhead" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      runtime.getCell<number>(
        space,
        `overhead-getcell-${i}`,
        undefined,
        tx,
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Overhead - 100x set on existing cells",
  { group: "overhead" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Pre-create cells
    // deno-lint-ignore no-explicit-any
    const cells: any[] = [];
    for (let i = 0; i < 100; i++) {
      cells.push(
        runtime.getCell<number>(space, `overhead-set-${i}`, undefined, tx),
      );
    }

    // Measure just the sets
    for (let i = 0; i < 100; i++) {
      cells[i].set(i);
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Overhead - runtime.idle() empty",
  { group: "overhead" },
  async () => {
    const { runtime, storageManager, tx } = setup();
    await runtime.idle();
    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Overhead - commit after 100 sets",
  { group: "overhead" },
  async () => {
    // Benchmark: commit after writes (triggers scheduler storage subscriptions)

    const { runtime, storageManager, tx } = setup();

    // Create and set 100 cells
    for (let i = 0; i < 100; i++) {
      const cell = runtime.getCell<number>(
        space,
        `overhead-commit-${i}`,
        undefined,
        tx,
      );
      cell.set(i);
    }

    // Measure commit separately
    const start = performance.now();
    await tx.commit().settled;
    const commitTime = performance.now() - start;

    if (commitTime > 100 && Deno.env.get("BENCH_DIAGNOSTICS") === "1") {
      benchDiagnostic(`Commit took ${commitTime.toFixed(1)}ms`);
    }

    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Overhead - empty commit",
  { group: "overhead" },
  async () => {
    const { runtime, storageManager, tx } = setup();
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Overhead - 100 raw tx.write + commit",
  { group: "overhead" },
  async () => {
    // Benchmark: raw transaction writes (bypass Cell layer)

    const { runtime, storageManager, tx } = setup();

    // Write directly to transaction, bypassing Cell
    for (let i = 0; i < 100; i++) {
      tx.writeValueOrThrow(
        {
          space,
          scope: "space",
          id: `test:raw-write-${i}`,
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
// MICRO-BENCHMARKS: Utility functions
//

// Generate test addresses for micro-benchmarks
function generateAddresses(
  count: number,
  entitiesCount: number,
): IMemorySpaceAddress[] {
  const addresses: IMemorySpaceAddress[] = [];
  for (let i = 0; i < count; i++) {
    addresses.push({
      space: space,
      scope: "space",
      id: `test:entity-${i % entitiesCount}`,
      path: ["field", `sub${i % 5}`, `deep${i % 3}`],
    });
  }
  return addresses;
}

Deno.bench(
  "Utility - sortAndCompactPaths (100 paths)",
  { group: "utilities" },
  () => {
    const addresses = generateAddresses(100, 10);
    sortAndCompactPaths(addresses);
  },
);

Deno.bench(
  "Utility - sortAndCompactPaths (1000 paths)",
  { group: "utilities" },
  () => {
    const addresses = generateAddresses(1000, 50);
    sortAndCompactPaths(addresses);
  },
);

Deno.bench(
  "Utility - addressesToPathByEntity (100 paths)",
  { group: "utilities" },
  () => {
    const addresses = generateAddresses(100, 10);
    addressesToPathByEntity(addresses, TEST_IDENTITY);
  },
);

Deno.bench(
  "Utility - addressesToPathByEntity (1000 paths)",
  { group: "utilities" },
  () => {
    const addresses = generateAddresses(1000, 50);
    addressesToPathByEntity(addresses, TEST_IDENTITY);
  },
);

//
// MICRO-BENCHMARKS: Scheduler operations in isolation
//

Deno.bench(
  "Scheduler - bare subscribe (100x)",
  { group: "scheduler-ops" },
  async () => {
    // Benchmark: Just subscribe without any cell operations

    const { runtime, storageManager, tx } = setup();

    const actions: Action[] = [];
    const baseLink = {
      space,
      scope: "space",
      id: "test:entity" as const,
      path: ["value"],
    } as const;

    for (let i = 0; i < 100; i++) {
      const action: Action = () => {};
      actions.push(action);
      runtime.scheduler.subscribe(
        action,
        {
          reads: [{ ...baseLink, id: `test:read-${i}` }],
          shallowReads: [],
          writes: [{ ...baseLink, id: `test:write-${i}` }],
        },
        {},
      );
    }

    for (const action of actions) {
      runtime.scheduler.unsubscribe(action);
    }
    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Scheduler - subscribe 100 actions reading same entity",
  { group: "scheduler-ops" },
  async () => {
    // Benchmark: Subscribe with shared reads (tests writersByEntity)

    const { runtime, storageManager, tx } = setup();

    const actions: Action[] = [];
    const sharedRead = {
      space,
      scope: "space",
      id: "test:shared-source" as const,
      path: ["value"],
    } as const;

    for (let i = 0; i < 100; i++) {
      const action: Action = () => {};
      actions.push(action);
      runtime.scheduler.subscribe(
        action,
        {
          reads: [sharedRead],
          shallowReads: [],
          writes: [{
            space,
            scope: "space",
            id: `test:output-${i}` as const,
            path: ["value"],
          }],
        },
        {},
      );
    }

    for (const action of actions) {
      runtime.scheduler.unsubscribe(action);
    }
    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Scheduler - resubscribe cycle (100x)",
  { group: "scheduler-ops" },
  async () => {
    // Benchmark: resubscribe cycle (simulates what happens during pull)

    const { runtime, storageManager, tx } = setup();

    const action: Action = () => {};
    const reads: IMemorySpaceAddress[] = [
      {
        space,
        scope: "space",
        id: "test:source",
        path: ["value"],
      },
    ];
    const writes: IMemorySpaceAddress[] = [
      {
        space,
        scope: "space",
        id: "test:output",
        path: ["value"],
      },
    ];

    // Initial subscribe
    runtime.scheduler.subscribe(
      action,
      { reads, shallowReads: [], writes },
      {},
    );

    // Simulate 100 resubscribe cycles
    for (let i = 0; i < 100; i++) {
      runtime.scheduler.resubscribe(action, {
        reads,
        shallowReads: [],
        writes,
      });
    }

    runtime.scheduler.unsubscribe(action);
    await cleanup(runtime, storageManager, tx);
  },
);
