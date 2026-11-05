// Push-triggered filtering and parent-child action ordering tests.

import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { topologicalSort } from "../src/scheduler/topology.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

type SchedulerTestScope = "space" | "user" | "session";

function scopedAddress(
  scope: SchedulerTestScope | undefined,
  path: readonly string[],
): IMemorySpaceAddress {
  return {
    space,
    id: "of:scheduler-scope-shared",
    type: "application/json",
    scope,
    path,
  };
}

describe("push-triggered filtering", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("should track mightWrite from the static surface at subscribe", async () => {
    const cell = runtime.getCell<number>(
      space,
      "mightwrite-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const declaredWrite = cell.getAsNormalizedFullLink();
    const action = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        cell.withTx(actionTx).send(42);
      }) as Action,
      {
        writes: [declaredWrite],
      },
    );

    expect(runtime.scheduler.getMightWrite(action)).toBeUndefined();
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(declaredWrite)],
      },
      {},
    );

    expect(runtime.scheduler.getMightWrite(action)).toEqual([
      toMemorySpaceAddress(declaredWrite),
    ]);
  });

  it("should keep the static surface over multiple resubscriptions", async () => {
    const cell1 = runtime.getCell<number>(space, "mw-accum-1", undefined, tx);
    const cell2 = runtime.getCell<number>(space, "mw-accum-2", undefined, tx);
    cell1.set(0);
    cell2.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const declaredWrite = cell1.getAsNormalizedFullLink();
    const action = Object.assign((() => {}) as Action, {
      writes: [declaredWrite],
    });
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(declaredWrite)],
      },
      {},
    );

    expect(runtime.scheduler.getMightWrite(action)).toEqual([
      toMemorySpaceAddress(declaredWrite),
    ]);

    runtime.scheduler.resubscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [toMemorySpaceAddress(cell2.getAsNormalizedFullLink())],
    });

    expect(runtime.scheduler.getMightWrite(action)).toEqual([
      toMemorySpaceAddress(declaredWrite),
    ]);
  });

  it("should keep declared writes in current-known writes after empty resubscribe", async () => {
    const output = runtime.getCell<number>(
      space,
      "mw-declared-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const declaredWrite = output.getAsNormalizedFullLink();
    const action = Object.assign((() => {}) as Action, {
      writes: [declaredWrite],
    });

    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(declaredWrite)],
      },
      {},
    );

    runtime.scheduler.resubscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    });

    expect(runtime.scheduler.getMightWrite(action)).toEqual([
      toMemorySpaceAddress(declaredWrite),
    ]);
  });

  it("should keep the declared surface when a run only writes metadata", async () => {
    const declared = runtime.getCell<number>(
      space,
      "mw-declared-surface-output",
      undefined,
      tx,
    );
    const metadata = runtime.getCell<number>(
      space,
      "mw-observed-metadata-write",
      undefined,
      tx,
    );
    declared.set(0);
    metadata.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const declaredWrite = declared.getAsNormalizedFullLink();
    const metadataWrite = metadata.getAsNormalizedFullLink();
    const action = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        metadata.withTx(actionTx).set(1);
      }) as Action,
      {
        writes: [declaredWrite],
      },
    );

    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(declaredWrite)],
      },
      {},
    );

    await runtime.scheduler.run(action);

    expect(runtime.scheduler.getMightWrite(action)).toEqual([
      toMemorySpaceAddress(declaredWrite),
    ]);
    expect(runtime.scheduler.getMightWrite(action)).not.toEqual([
      toMemorySpaceAddress(metadataWrite),
    ]);
  });

  it("should not broaden current-known writes to structural parent paths", async () => {
    const root = runtime.getCell<Record<string, unknown>>(
      space,
      "mw-structural-parent-root",
      undefined,
      tx,
    );
    root.set({ internal: {} });
    await tx.commit().settled;
    tx = runtime.edit();

    const child = root.key("internal").key("__#0");
    const declaredWrite = child.getAsNormalizedFullLink();
    const action = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        child.withTx(actionTx).set({ result: "ready" });
      }) as Action,
      {
        writes: [declaredWrite],
      },
    );

    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(declaredWrite)],
      },
      {},
    );

    await runtime.scheduler.run(action);

    expect(runtime.scheduler.getMightWrite(action)).toEqual([
      toMemorySpaceAddress(declaredWrite),
    ]);
  });

  it("should keep dynamic collection parent writes for numeric children", async () => {
    const root = runtime.getCell<{ list: Record<string, unknown> }>(
      space,
      "mw-dynamic-collection-root",
      undefined,
      tx,
    );
    root.set({ list: {} });
    await tx.commit().settled;
    tx = runtime.edit();

    const list = root.key("list");
    const declaredWrite = list.getAsNormalizedFullLink();
    const firstChild = list.key("0").getAsNormalizedFullLink();
    const action = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        list.withTx(actionTx).key("0").set({ label: "first" });
      }) as Action,
      {
        writes: [declaredWrite],
      },
    );

    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(declaredWrite)],
      },
      {},
    );

    await runtime.scheduler.run(action);

    expect(runtime.scheduler.getMightWrite(action)).toEqual([
      toMemorySpaceAddress(declaredWrite),
    ]);
    expect(runtime.scheduler.getMightWrite(action)).not.toEqual([
      toMemorySpaceAddress(firstChild),
    ]);
  });

  it("should break write-only ties by registration order, not arrival order", () => {
    // Spec §7.4 rule 3: once data edges and parent tie-breaks are applied,
    // remaining ties fall back to REGISTRATION order. Two actions that both
    // write the same address with NO read edge between them get no ordering
    // edge, so last-writer-wins on that address must not flip with the order
    // the actions were invalidated / arrived over the network.
    const registry = new NodeRegistry();
    const writerA: Action = () => {};
    const writerB: Action = () => {};
    // Fixed registration order: A before B (first registration wins).
    registry.register(writerA, "computation");
    registry.register(writerB, "computation");

    const sharedWrite: IMemorySpaceAddress = {
      space,
      id: "of:scheduler-shared-write",
      type: "application/json",
      scope: undefined,
      path: ["value"],
    };

    // Both write the SAME address; neither reads it → no read edge orders them.
    const dependencies = new WeakMap<Action, {
      reads: IMemorySpaceAddress[];
      shallowReads: IMemorySpaceAddress[];
      writes: IMemorySpaceAddress[];
    }>([
      [writerA, { reads: [], shallowReads: [], writes: [sharedWrite] }],
      [writerB, { reads: [], shallowReads: [], writes: [sharedWrite] }],
    ]);
    const mightWrite = new WeakMap<Action, IMemorySpaceAddress[]>([
      [writerA, [sharedWrite]],
      [writerB, [sharedWrite]],
    ]);

    const sortWith = (seed: Action[]) =>
      topologicalSort(new Set(seed), dependencies, mightWrite, registry);

    // Drive the settle with the two actions queued in DIFFERENT orders,
    // simulating opposite network-arrival orders.
    const arrivalAB = sortWith([writerA, writerB]);
    const arrivalBA = sortWith([writerB, writerA]);

    // Deterministic and in registration order, regardless of arrival order.
    expect(arrivalAB).toEqual([writerA, writerB]);
    expect(arrivalBA).toEqual([writerA, writerB]);
    expect(arrivalBA).toEqual(arrivalAB);
  });

  it("should insert newly-ready nodes into the global registration order", () => {
    const registry = new NodeRegistry();
    const upstream: Action = () => {};
    const newlyReady: Action = () => {};
    const alreadyReady: Action = () => {};
    registry.register(upstream, "computation");
    registry.register(newlyReady, "computation");
    registry.register(alreadyReady, "computation");

    const dependents = new WeakMap<Action, Set<Action>>([
      [upstream, new Set([newlyReady])],
    ]);
    const order = topologicalSort(
      new Set([upstream, newlyReady, alreadyReady]),
      new WeakMap(),
      new WeakMap(),
      registry,
      dependents,
    );

    expect(order).toEqual([upstream, newlyReady, alreadyReady]);
  });

  it("should not order materializer writes before readers in other scopes", () => {
    const materializer: Action = () => {};
    const reader: Action = () => {};
    const order = topologicalSort(
      new Set([reader, materializer]),
      new WeakMap<Action, {
        reads: IMemorySpaceAddress[];
        shallowReads: IMemorySpaceAddress[];
        writes: IMemorySpaceAddress[];
      }>([
        [reader, {
          reads: [scopedAddress("space", ["value"])],
          shallowReads: [],
          writes: [],
        }],
        [materializer, { reads: [], shallowReads: [], writes: [] }],
      ]),
      new WeakMap<Action, IMemorySpaceAddress[]>(),
      undefined,
      undefined,
      (action) =>
        action === materializer
          ? [scopedAddress("session", ["value"])]
          : undefined,
    );

    expect(order).toEqual([reader, materializer]);
  });

  it("should track filter stats", async () => {
    runtime.scheduler.resetFilterStats();

    const cell = runtime.getCell<number>(space, "filter-stats", undefined, tx);
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(1);
    };

    runtime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      {},
    );
    await cell.pull();

    const stats = runtime.scheduler.getFilterStats();
    // Action should have executed (not filtered)
    expect(stats.executed).toBeGreaterThan(0);
  });

  it("should allow first run even without pushTriggered (default scheduling)", async () => {
    runtime.scheduler.resetFilterStats();

    const cell = runtime.getCell<number>(
      space,
      "first-run-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCount = 0;
    const cellLink = cell.getAsNormalizedFullLink();
    const action = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runCount++;
        cell.withTx(actionTx).send(runCount);
      }) as Action,
      {
        writes: [cellLink],
      },
    );

    // First run with default scheduling should work
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cellLink)],
      },
      {},
    );
    await cell.pull();

    expect(runCount).toBe(1);
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.executed).toBeGreaterThan(0);
    expect(stats.filtered).toBe(0);
  });

  it("should use pushTriggered to track storage-triggered actions", async () => {
    const cell = runtime.getCell<number>(
      space,
      "push-triggered-test",
      undefined,
      tx,
    );
    cell.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // Subscribe as effect - first run
    runtime.scheduler.subscribe(
      action,
      {
        reads: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await cell.pull();
    expect(runCount).toBe(1);

    runtime.scheduler.resetFilterStats();

    // Change cell via external means (simulating storage change)
    cell.withTx(tx).send(100);
    await tx.commit().settled;
    tx = runtime.edit();
    await cell.pull();

    // Action should have been triggered by storage change and run
    expect(runCount).toBe(2);

    // Verify it was tracked as push-triggered (executed, not filtered)
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.executed).toBeGreaterThan(0);
  });

  it("should not filter actions scheduled with default scheduling", async () => {
    const cell = runtime.getCell<number>(
      space,
      "schedule-immed-filter",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCount = 0;
    const cellLink = cell.getAsNormalizedFullLink();
    const action = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runCount++;
        cell.withTx(actionTx).send(runCount);
      }) as Action,
      {
        writes: [cellLink],
      },
    );

    // Run once to establish mightWrite
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cellLink)],
      },
      {},
    );
    await cell.pull();
    expect(runCount).toBe(1);

    runtime.scheduler.resetFilterStats();

    // Run again with default scheduling - should bypass filter
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cellLink)],
      },
      {},
    );
    await cell.pull();

    expect(runCount).toBe(2);
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.filtered).toBe(0);
  });

  it("should reset filter stats", () => {
    runtime.scheduler.resetFilterStats();
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.filtered).toBe(0);
    expect(stats.executed).toBe(0);
  });
});

describe("parent-child action ordering", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("should execute parent actions before child actions", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-order-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    // Parent action that subscribes a child during execution
    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      const val = source.withTx(actionTx).get();

      // Subscribe child action during parent execution
      runtime.scheduler.subscribe(
        childAction,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );

      return val;
    };

    const childAction: Action = (_actionTx) => {
      executionOrder.push("child");
    };

    // Subscribe parent
    runtime.scheduler.subscribe(
      parentAction,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    // Parent should execute first, then child
    expect(executionOrder).toEqual(["parent", "child"]);
  });

  it("should skip child if parent unsubscribes it", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-unsubscribe-source",
      undefined,
      tx,
    );
    source.set(1);
    const toggle = runtime.getCell<boolean>(
      space,
      "parent-child-unsubscribe-toggle",
      undefined,
      tx,
    );
    toggle.set(true);
    await tx.commit().settled;
    tx = runtime.edit();

    let childCanceler: (() => void) | null = null;

    // Parent action that conditionally subscribes/unsubscribes child
    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      const shouldHaveChild = toggle.withTx(actionTx).get();

      if (shouldHaveChild && !childCanceler) {
        childCanceler = runtime.scheduler.subscribe(
          childAction,
          { reads: [], shallowReads: [], writes: [] },
          {},
        );
      } else if (!shouldHaveChild && childCanceler) {
        childCanceler();
        childCanceler = null;
      }
    };

    const childAction: Action = (_actionTx) => {
      executionOrder.push("child");
    };

    // Subscribe parent as an effect (so it re-runs when toggle changes)
    runtime.scheduler.subscribe(
      parentAction,
      {
        reads: [toMemorySpaceAddress(toggle.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );
    await runtime.idle();

    expect(executionOrder).toEqual(["parent", "child"]);

    // Now toggle to false - parent should unsubscribe child
    executionOrder.length = 0;
    toggle.withTx(tx).send(false);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    // Parent runs (and unsubscribes child), child should NOT run
    expect(executionOrder).toEqual(["parent"]);
  });

  it("should order parent before child even when both become dirty", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-both-dirty-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    let childSubscribed = false;

    // Parent reads source and subscribes child on first run
    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      const val = source.withTx(actionTx).get();

      if (!childSubscribed) {
        childSubscribed = true;
        // Subscribe child as an effect too (so it re-runs when source changes)
        runtime.scheduler.subscribe(
          childAction,
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
      }

      return val;
    };

    // Child also reads source (so both become dirty when source changes)
    const childAction: Action = (actionTx) => {
      executionOrder.push("child");
      source.withTx(actionTx).get();
    };

    // Mark parent as effect so it re-runs when source changes
    runtime.scheduler.subscribe(
      parentAction,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    expect(executionOrder).toEqual(["parent", "child"]);

    // Change source - both parent and child should become dirty
    executionOrder.length = 0;
    source.withTx(tx).send(2);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    // Parent should still execute before child
    expect(executionOrder).toEqual(["parent", "child"]);
  });

  it("should handle nested parent-child-grandchild ordering", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-grandchild-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    let childSubscribed = false;
    let grandchildSubscribed = false;

    const grandparentAction: Action = (actionTx) => {
      executionOrder.push("grandparent");
      source.withTx(actionTx).get();

      if (!childSubscribed) {
        childSubscribed = true;
        // Subscribe parent as effect so it re-runs when source changes
        runtime.scheduler.subscribe(
          parentAction,
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
      }
    };

    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      source.withTx(actionTx).get();

      if (!grandchildSubscribed) {
        grandchildSubscribed = true;
        // Subscribe child as effect so it re-runs when source changes
        runtime.scheduler.subscribe(
          childAction,
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
      }
    };

    const childAction: Action = (actionTx) => {
      executionOrder.push("child");
      source.withTx(actionTx).get();
    };

    // Mark grandparent as effect so the chain re-runs when source changes
    runtime.scheduler.subscribe(
      grandparentAction,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    // Should execute in order: grandparent -> parent -> child
    expect(executionOrder).toEqual(["grandparent", "parent", "child"]);

    // Change source - all three should become dirty and re-execute in order
    executionOrder.length = 0;
    source.withTx(tx).send(2);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    expect(executionOrder).toEqual(["grandparent", "parent", "child"]);
  });

  it("should clean up parent-child relationships on unsubscribe", async () => {
    const source = runtime.getCell<number>(
      space,
      "parent-child-cleanup-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    let childCanceler: (() => void) | undefined;
    let childRunCount = 0;

    const parentAction: Action = (actionTx) => {
      source.withTx(actionTx).get();

      if (!childCanceler) {
        childCanceler = runtime.scheduler.subscribe(
          childAction,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [],
          },
          {},
        );
      }
    };

    const childAction: Action = (actionTx) => {
      childRunCount++;
      source.withTx(actionTx).get();
    };

    const parentCanceler = runtime.scheduler.subscribe(
      parentAction,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );
    await runtime.idle();

    expect(childRunCount).toBe(1);

    // Unsubscribe the parent - this should clean up the relationship
    parentCanceler();

    // Also unsubscribe child to prevent it from running independently
    if (childCanceler) childCanceler();

    // Change source and verify neither runs
    childRunCount = 0;
    source.withTx(tx).send(2);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    expect(childRunCount).toBe(0);
  });
});
