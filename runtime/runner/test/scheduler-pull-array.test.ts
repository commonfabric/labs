// Pull scheduler array materialization and idempotency regression tests.

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
  JSONSchema,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import type {
  NonIdempotentReport,
  SchedulerDiagnosisResult,
} from "../src/telemetry.ts";

function nonIdempotentReportsForAction(
  result: SchedulerDiagnosisResult,
  action: Action,
): NonIdempotentReport[] {
  return result.nonIdempotent.filter((report) =>
    report.actionId === action.name
  );
}

describe("pull mode array reactivity", () => {
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

  it("should trigger sink when array element is pushed", async () => {
    // Create a cell with an array
    const arrayCell = runtime.getCell<string[]>(
      space,
      "array-push-test",
      undefined,
      tx,
    );
    arrayCell.set(["a", "b"]);
    await tx.commit().settled;
    tx = runtime.edit();

    // Track sink calls
    const sinkValues: string[][] = [];
    const cancel = arrayCell.withTx(tx).sink((value) => {
      sinkValues.push([...value]);
    });

    // Wait for initial sink call
    await runtime.scheduler.idle();
    expect(sinkValues.length).toBe(1);
    expect(sinkValues[0]).toEqual(["a", "b"]);

    // Push a new element using the current transaction
    arrayCell.withTx(tx).push("c");
    await tx.commit().settled;
    tx = runtime.edit();

    // Wait for scheduler to process
    await runtime.scheduler.idle();

    // Verify sink was called with updated array
    expect(sinkValues.length).toBe(2);
    expect(sinkValues[1]).toEqual(["a", "b", "c"]);

    cancel();
  });

  it("should record schema array sinks as shallow structural reads", async () => {
    const arrayCell = runtime.getCell<string[]>(
      space,
      "schema-array-structural-sink",
      { type: "array", items: { type: "string" } },
      tx,
    );
    arrayCell.set(["a", "b"]);
    await tx.commit().settled;
    tx = runtime.edit();

    const cancel = arrayCell.withTx(tx).sink(() => {});
    await runtime.scheduler.idle();

    const link = arrayCell.getAsNormalizedFullLink();
    const expectedAddress = toMemorySpaceAddress(link);
    const expectedRead =
      `${expectedAddress.space}/${expectedAddress.id}/${expectedAddress.scope}/${
        expectedAddress.path.join("/")
      }`;
    const graph = runtime.scheduler.getGraphSnapshot();
    const sinkNode = graph.nodes.find((node) =>
      node.type === "effect" &&
      node.id.startsWith(`sink:${link.space}/${link.id}/`)
    );

    expect(sinkNode?.shallowReads ?? []).toContain(expectedRead);
    const inputNode = graph.nodes.find((node) =>
      node.type === "input" &&
      node.id.includes(expectedAddress.id)
    );
    expect(inputNode).toBeDefined();
    expect(
      graph.edges.some((edge) =>
        edge.from === inputNode?.id && edge.to === sinkNode?.id
      ),
    ).toBe(true);

    cancel();
  });

  it("should trigger sink when array length changes via set", async () => {
    // Create a cell with an array
    const arrayCell = runtime.getCell<number[]>(
      space,
      "array-length-test",
      undefined,
      tx,
    );
    arrayCell.set([1, 2, 3]);
    await tx.commit().settled;
    tx = runtime.edit();

    // Track sink calls
    const sinkLengths: number[] = [];
    const cancel = arrayCell.withTx(tx).sink((value) => {
      sinkLengths.push(value.length);
    });

    // Wait for initial sink call
    await runtime.scheduler.idle();
    expect(sinkLengths).toEqual([3]);

    // Set a new array with different length using the current transaction
    arrayCell.withTx(tx).set([1, 2, 3, 4, 5]);
    await tx.commit().settled;
    tx = runtime.edit();

    // Wait for scheduler to process
    await runtime.scheduler.idle();

    // Verify sink was called with new length
    expect(sinkLengths).toEqual([3, 5]);

    cancel();
  });

  it("should trigger computation when array source changes via push", async () => {
    // This tests: when a source array has an element pushed, a computation
    // that reads it should be marked dirty and re-run on pull.
    // This simulates: visiblePieces = computed(() => pieceRegistry.filter(...))

    const sourceArray = runtime.getCell<{ name: string; hidden: boolean }[]>(
      space,
      "source-array-map-test",
      undefined,
      tx,
    );
    sourceArray.set([
      { name: "item1", hidden: false },
      { name: "item2", hidden: true },
    ]);

    const filteredCell = runtime.getCell<string[]>(
      space,
      "filtered-array-map-test",
      undefined,
      tx,
    );
    filteredCell.set([]);
    await tx.commit().settled;
    tx = runtime.edit();

    // Track how many times the computation runs
    let computationRunCount = 0;

    // Create a computation that filters the source
    const filterAction: Action = (actionTx) => {
      computationRunCount++;
      const source = sourceArray.withTx(actionTx).get();
      const filtered = source
        .filter((item) => !item.hidden)
        .map((item) => item.name);
      filteredCell.withTx(actionTx).send(filtered);
    };

    runtime.scheduler.subscribe(
      filterAction,
      {
        reads: [toMemorySpaceAddress(sourceArray.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(filteredCell.getAsNormalizedFullLink())],
      },
      {},
    );

    // Pull to trigger initial computation
    await filteredCell.withTx(tx).pull();
    await runtime.scheduler.idle();
    expect(computationRunCount).toBe(1);
    expect(filteredCell.withTx(tx).get()).toEqual(["item1"]);

    // Now push a new item to the source array
    sourceArray.withTx(tx).push({ name: "item3", hidden: false });
    await tx.commit().settled;
    tx = runtime.edit();

    // Pull again - the computation SHOULD run because its input changed
    await filteredCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    // BUG: If computationRunCount is still 1, the computation didn't re-run
    // when the source array changed via push
    expect(computationRunCount).toBe(2);
    expect(filteredCell.withTx(tx).get()).toEqual(["item1", "item3"]);
  });

  it("should notify sink on computed result when source array grows (no explicit pull)", async () => {
    // This tests the renderer pattern: sink observes computed result,
    // and should be notified when source array (which feeds the computation)
    // has elements added. This is the pattern used in the Notes UI.
    //
    // Expected behavior:
    // 1. Source array changes (push)
    // 2. Computation that reads source is marked dirty
    // 3. The invalidated computation and dependent sink settle together
    // 4. Computation runs, then sink is notified with new value

    const sourceArray = runtime.getCell<string[]>(
      space,
      "renderer-source-array",
      undefined,
      tx,
    );
    sourceArray.set(["a", "b"]);

    const computedCell = runtime.getCell<string[]>(
      space,
      "renderer-computed",
      undefined,
      tx,
    );
    computedCell.set([]);
    await tx.commit().settled;
    tx = runtime.edit();

    // Track sink notifications
    const sinkValues: string[][] = [];

    // Create a computation that transforms the source
    const transformAction: Action = (actionTx) => {
      const source = sourceArray.withTx(actionTx).get();
      const transformed = source.map((s) => s.toUpperCase());
      computedCell.withTx(actionTx).send(transformed);
    };

    runtime.scheduler.subscribe(
      transformAction,
      {
        reads: [toMemorySpaceAddress(sourceArray.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computedCell.getAsNormalizedFullLink())],
      },
      {},
    );

    // Set up sink on computed result (simulating renderer effect)
    const cancel = computedCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        sinkValues.push([...value]);
      }
    });

    // Pull to trigger initial computation
    await computedCell.withTx(tx).pull();
    await runtime.scheduler.idle();
    expect(sinkValues.length).toBeGreaterThanOrEqual(1);
    expect(sinkValues[sinkValues.length - 1]).toEqual(["A", "B"]);

    // Push to source array - use a FRESH transaction to avoid consistency issues
    // (the previous tx was used by the sink which read computedCell)
    const pushTx = runtime.edit();
    sourceArray.withTx(pushTx).push("c");
    await pushTx.commit().settled;

    // The sink SHOULD be notified with the updated computed value
    // Without explicit pull - just let the scheduler run
    runtime.scheduler.queueExecution();
    await runtime.scheduler.idle();

    // Verify sink was notified with updated value
    expect(sinkValues.length).toBeGreaterThanOrEqual(2);
    expect(sinkValues[sinkValues.length - 1]).toEqual(["A", "B", "C"]);

    cancel();
  });

  it("should notify renderer when pieceRegistry is pushed (Notes UI simulation)", async () => {
    // This simulates the actual Notes UI flow:
    // - Space has a pieceRegistry Cell (array of pieces)
    // - visiblePieces computation filters pieceRegistry
    // - Renderer effect observes visiblePieces and renders the list
    // - User creates a new note which pushes to pieceRegistry
    // - Renderer should be notified and re-render with new note

    // Define schemas for realistic data
    const pieceSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        isHidden: { type: "boolean" },
      },
      required: ["name"],
    } as const satisfies JSONSchema;

    const pieceRegistrySchema = {
      type: "array",
      items: pieceSchema,
    } as const satisfies JSONSchema;

    const spaceSchema = {
      type: "object",
      properties: {
        // Not using asCell: ["cell"] here - we want inline array data for simplicity
        pieceRegistry: pieceRegistrySchema,
      },
    } as const satisfies JSONSchema;

    // Create space cell with pieceRegistry
    const spaceCell = runtime.getCell(space, "notes-ui-space", spaceSchema, tx);
    spaceCell.set({
      pieceRegistry: [
        { name: "Existing Note 1", isHidden: false },
        { name: "Hidden Note", isHidden: true },
      ],
    });
    await tx.commit().settled;
    tx = runtime.edit();

    // Get the pieceRegistry subcell
    const pieceRegistryCell = spaceCell.key("pieceRegistry");

    // Create visiblePieces cell for computed output
    const visiblePiecesCell = runtime.getCell(
      space,
      "visible-pieces",
      { type: "array", items: pieceSchema },
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit().settled;
    tx = runtime.edit();

    // Track renderer notifications
    const renderedValues: { name: string }[][] = [];

    // Create computation: visiblePieces = pieceRegistry.filter(c => !c.isHidden)
    const computeVisiblePieces: Action = function computeVisiblePieces(
      actionTx,
    ) {
      const pieces = pieceRegistryCell.withTx(actionTx).get() ?? [];
      // Now pieces should be an array since we don't have asCell: ["cell"]
      const visible = pieces.filter((c) => !c.isHidden);
      visiblePiecesCell.withTx(actionTx).send(visible);
    };

    // Subscribe computation with schema-aware reads/writes
    runtime.scheduler.subscribe(
      computeVisiblePieces,
      {
        reads: [
          toMemorySpaceAddress(pieceRegistryCell.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
      },
      {},
    );

    // Create renderer effect (sink on visiblePieces)
    const cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Initial pull to trigger computation and renderer
    await visiblePiecesCell.withTx(tx).pull();

    // Verify initial render shows only visible pieces
    expect(renderedValues.length).toBeGreaterThanOrEqual(1);
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Existing Note 1", isHidden: false },
    ]);

    // Simulate creating a new note and pushing to pieceRegistry
    // (This is what happens when user creates a note in notebook.tsx)
    const createNoteTx = runtime.edit();
    pieceRegistryCell.withTx(createNoteTx).push({
      name: "New Note",
      isHidden: false,
    });
    await createNoteTx.commit().settled;

    // Let the scheduler process the change
    await runtime.scheduler.idle();

    // Renderer should have been notified with updated visible pieces
    expect(renderedValues.length).toBeGreaterThanOrEqual(2);
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Existing Note 1", isHidden: false },
      { name: "New Note", isHidden: false },
    ]);

    cancelRenderer();
    runtime.scheduler.unsubscribe(computeVisiblePieces);
  });

  it("should handle nested cell updates in pieceRegistry", async () => {
    // More complex test: pieceRegistry contains cell references (like real usage)
    // When a new piece is pushed, the renderer should see it

    const spaceSchema = {
      type: "object",
      properties: {
        pieceRegistry: {
          type: "array",
          items: { type: "object" },
          // Not using asCell: ["cell"] - testing inline array data
        },
      },
    } as const satisfies JSONSchema;

    // Create space with pieceRegistry - start with 1 item like the first test
    const spaceCell = runtime.getCell(
      space,
      "nested-piece-registry-space",
      spaceSchema,
      tx,
    );
    spaceCell.set({ pieceRegistry: [{ name: "Initial Piece" }] });
    await tx.commit().settled;
    tx = runtime.edit();

    const pieceRegistryCell = spaceCell.key("pieceRegistry");

    // Track what the "renderer" sees
    const renderedPieceCount: number[] = [];

    // Create a simple computation that counts pieces
    const countCell = runtime.getCell(
      space,
      "piece-count",
      { type: "number" },
      tx,
    );
    countCell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const countPieces: Action = function countPieces(actionTx) {
      const pieces = pieceRegistryCell.withTx(actionTx).get() ?? [];
      countCell.withTx(actionTx).send(pieces.length);
    };

    runtime.scheduler.subscribe(
      countPieces,
      {
        reads: [
          toMemorySpaceAddress(pieceRegistryCell.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [toMemorySpaceAddress(countCell.getAsNormalizedFullLink())],
      },
      {},
    );

    // Renderer effect
    const cancelRenderer = countCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedPieceCount.push(value);
      }
    });

    // Initial pull - we start with 1 item
    await countCell.withTx(tx).pull();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(1);

    // Push first new piece (total should be 2)
    const tx1 = runtime.edit();
    pieceRegistryCell.withTx(tx1).push({ name: "Piece 1" });
    await tx1.commit().settled;

    await runtime.scheduler.idle();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(2);

    // Push second piece (total should be 3)
    const tx2 = runtime.edit();
    pieceRegistryCell.withTx(tx2).push({ name: "Piece 2" });
    await tx2.commit().settled;

    await runtime.scheduler.idle();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(3);

    // Push third piece (total should be 4)
    const tx3 = runtime.edit();
    pieceRegistryCell.withTx(tx3).push({ name: "Piece 3" });
    await tx3.commit().settled;

    await runtime.scheduler.idle();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(4);

    cancelRenderer();
    runtime.scheduler.unsubscribe(countPieces);
  });

  it("should see updated data after unsubscribe/resubscribe (navigation flow)", async () => {
    // This simulates the ACTUAL bug flow:
    // 1. Default app is mounted (sink subscribed)
    // 2. Navigate to note editor (sink unsubscribed)
    // 3. Create note (push while unsubscribed)
    // 4. Navigate back (sink re-subscribed)
    // 5. Should see new data

    const arraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    } as const satisfies JSONSchema;

    // Create pieceRegistry with initial data
    const pieceRegistryCell = runtime.getCell(
      space,
      "nav-flow-piece-registry",
      arraySchema,
      tx,
    );
    pieceRegistryCell.set([{ name: "Initial Note" }]);
    await tx.commit().settled;
    tx = runtime.edit();

    // Create computed cell (visiblePieces)
    const visiblePiecesCell = runtime.getCell(
      space,
      "nav-flow-visible",
      arraySchema,
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit().settled;
    tx = runtime.edit();

    // Track what renderer sees
    const renderedValues: { name: string }[][] = [];

    // Computation: copy pieceRegistry to visiblePieces
    const computeVisible: Action = function computeVisible(actionTx) {
      const pieces = pieceRegistryCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    runtime.scheduler.subscribe(
      computeVisible,
      {
        reads: [
          toMemorySpaceAddress(pieceRegistryCell.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
      },
      {},
    );

    // STEP 1: Mount default app (subscribe renderer)
    let cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Initial pull to see data
    await visiblePiecesCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
    ]);

    // STEP 2: Navigate away (unmount default app, unsubscribe renderer)
    cancelRenderer();

    // STEP 3: Create note while on another page (push while unsubscribed)
    const createTx = runtime.edit();
    pieceRegistryCell.withTx(createTx).push({ name: "New Note" });
    await createTx.commit().settled;

    // STEP 4: Navigate back (remount default app, resubscribe renderer)
    const tx2 = runtime.edit();
    cancelRenderer = visiblePiecesCell.withTx(tx2).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Pull to get fresh data
    await visiblePiecesCell.withTx(tx2).pull();
    await runtime.scheduler.idle();

    // STEP 5: Should see both notes
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
      { name: "New Note" },
    ]);

    cancelRenderer();
    runtime.scheduler.unsubscribe(computeVisible);
  });

  it("should see updated data when computation is also unsubscribed (full navigation)", async () => {
    // Even more realistic: when navigating away, the WHOLE piece (including
    // its computation) might get stopped, not just the renderer sink.
    // This is what runner.stop() does.

    const arraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    } as const satisfies JSONSchema;

    // Create pieceRegistry with initial data
    const pieceRegistryCell = runtime.getCell(
      space,
      "full-nav-piece-registry",
      arraySchema,
      tx,
    );
    pieceRegistryCell.set([{ name: "Initial Note" }]);
    await tx.commit().settled;
    tx = runtime.edit();

    // Create computed cell (visiblePieces)
    const visiblePiecesCell = runtime.getCell(
      space,
      "full-nav-visible",
      arraySchema,
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit().settled;
    tx = runtime.edit();

    // Track what renderer sees
    const renderedValues: { name: string }[][] = [];

    // Computation: copy pieceRegistry to visiblePieces
    const computeVisible: Action = function computeVisible(actionTx) {
      const pieces = pieceRegistryCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    // STEP 1: Mount default app piece
    let cancelComputation = runtime.scheduler.subscribe(
      computeVisible,
      {
        reads: [
          toMemorySpaceAddress(pieceRegistryCell.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
      },
      {},
    );

    let cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    await visiblePiecesCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
    ]);

    // STEP 2: Navigate away - unsubscribe BOTH renderer AND computation
    cancelRenderer();
    cancelComputation();

    // STEP 3: Create note while on another page
    const createTx = runtime.edit();
    pieceRegistryCell.withTx(createTx).push({ name: "New Note" });
    await createTx.commit().settled;

    // STEP 4: Navigate back - resubscribe BOTH computation AND renderer
    cancelComputation = runtime.scheduler.subscribe(
      computeVisible,
      {
        reads: [
          toMemorySpaceAddress(pieceRegistryCell.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
      },
      {},
    );

    const tx2 = runtime.edit();
    cancelRenderer = visiblePiecesCell.withTx(tx2).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Pull to get fresh data
    await visiblePiecesCell.withTx(tx2).pull();
    await runtime.scheduler.idle();

    // Should see both notes
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
      { name: "New Note" },
    ]);

    cancelRenderer();
    cancelComputation();
  });

  it("should see fresh data when a NEW computation is created (pattern remount)", async () => {
    // This simulates what happens when a pattern remounts:
    // - The computed value output cell is REUSED (same cause = same cell)
    // - But a NEW computation action is created each time
    // - The sink reads from the output cell which has CACHED old value
    // - The new computation should run and update the value

    const arraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    } as const satisfies JSONSchema;

    // Create pieceRegistry with initial data
    const pieceRegistryCell = runtime.getCell(
      space,
      "pattern-remount-piece-registry",
      arraySchema,
      tx,
    );
    pieceRegistryCell.set([{ name: "Initial Note" }]);
    await tx.commit().settled;
    tx = runtime.edit();

    // IMPORTANT: The computed output cell is created with a FIXED cause
    // so it will be the SAME cell when the pattern remounts
    const visiblePiecesCell = runtime.getCell(
      space,
      "pattern-remount-visible-FIXED-CAUSE", // This cause stays same across remounts
      arraySchema,
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit().settled;
    tx = runtime.edit();

    // Track what renderer sees
    const renderedValues: { name: string }[][] = [];

    // FIRST MOUNT: Create computation #1
    const computeVisible1: Action = function computeVisible1(actionTx) {
      const pieces = pieceRegistryCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    let cancelComputation = runtime.scheduler.subscribe(
      computeVisible1,
      {
        reads: [
          toMemorySpaceAddress(pieceRegistryCell.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
      },
      {},
    );

    let cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    await visiblePiecesCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
    ]);

    // UNMOUNT: Stop pattern
    cancelRenderer();
    cancelComputation();

    // PUSH while unmounted
    const createTx = runtime.edit();
    pieceRegistryCell.withTx(createTx).push({ name: "New Note" });
    await createTx.commit().settled;

    // REMOUNT: Create computation #2 (NEW action, but SAME output cell)
    const computeVisible2: Action = function computeVisible2(actionTx) {
      const pieces = pieceRegistryCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    cancelComputation = runtime.scheduler.subscribe(
      computeVisible2,
      {
        reads: [
          toMemorySpaceAddress(pieceRegistryCell.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
      },
      {},
    );

    const tx2 = runtime.edit();
    cancelRenderer = visiblePiecesCell.withTx(tx2).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // DON'T call pull() - just let the scheduler work naturally like the UI does
    runtime.scheduler.queueExecution();
    await runtime.scheduler.idle();

    // Should eventually see both notes
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
      { name: "New Note" },
    ]);

    cancelRenderer();
    cancelComputation();
  });

  describe("runIdempotencyCheck", () => {
    it("detects non-idempotent accumulator", async () => {
      // An accumulator: each run appends to the array
      const log = runtime.getCell<string[]>(
        space,
        "idempotency-accumulator-log",
        undefined,
        tx,
      );
      log.set([]);
      await tx.commit().settled;
      tx = runtime.edit();

      const accumulator: Action = (tx) => {
        const current = log.withTx(tx).get() ?? [];
        log.withTx(tx).send([...current, "entry"]);
      };
      runtime.scheduler.subscribe(
        accumulator,
        { reads: [], shallowReads: [], writes: [] },
        {},
      );
      await runtime.scheduler.idle();

      const result = await runtime.scheduler.runIdempotencyCheck();
      expect(
        nonIdempotentReportsForAction(result, accumulator).length,
      ).toBeGreaterThan(0);
    });

    it("passes idempotent computation", async () => {
      // Idempotent: always writes the same derived value
      const input = runtime.getCell<number>(
        space,
        "idempotency-idempotent-input",
        undefined,
        tx,
      );
      input.set(5);
      const output = runtime.getCell<number>(
        space,
        "idempotency-idempotent-output",
        undefined,
        tx,
      );
      output.set(0);
      await tx.commit().settled;
      tx = runtime.edit();

      const doubler: Action = (tx) => {
        output.withTx(tx).send(input.withTx(tx).get() * 2);
      };
      runtime.scheduler.subscribe(doubler, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {});
      await runtime.scheduler.idle();

      const result = await runtime.scheduler.runIdempotencyCheck();
      const ourResult = nonIdempotentReportsForAction(
        result,
        doubler,
      );
      expect(ourResult.length).toBe(0);
    });

    it("detects Math.random non-idempotency", async () => {
      const output = runtime.getCell<number>(
        space,
        "idempotency-random-output",
        undefined,
        tx,
      );
      output.set(0);
      await tx.commit().settled;
      tx = runtime.edit();

      const randomWriter: Action = (tx) => {
        output.withTx(tx).send(Math.random());
      };
      runtime.scheduler.subscribe(
        randomWriter,
        { reads: [], shallowReads: [], writes: [] },
        {},
      );
      await runtime.scheduler.idle();

      const result = await runtime.scheduler.runIdempotencyCheck();
      expect(
        nonIdempotentReportsForAction(result, randomWriter).length,
      ).toBeGreaterThan(0);
    });
  });
});
