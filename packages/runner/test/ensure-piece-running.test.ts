import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  ensurePieceRunning,
  ensurePieceRunningVerdict,
} from "../src/ensure-piece-running.ts";
import { trustPattern } from "./support/trusted-builder.ts";
import { getDerivedInternalCell, getMetaCell } from "../src/link-utils.ts";
import { setResultCell } from "../src/result-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("ensurePieceRunning", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should return false for cells without result metadata", async () => {
    // Create a cell that has no piece structure (no result metadata, no pattern)
    const orphanCell = runtime.getCell<unknown>(
      space,
      "orphan-cell-test",
      { asCell: ["stream"] },
      tx,
    );

    await tx.commit();
    tx = runtime.edit();

    // ensurePieceRunning should return false - no piece to start
    const result = await ensurePieceRunning(
      runtime,
      orphanCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(false);
  });

  it("should return false for cells without pattern metadata", async () => {
    // Create a result cell with no pattern metadata.
    const resultCell = runtime.getCell(
      space,
      "no-pattern-test-result",
      undefined,
      tx,
    );

    resultCell.set({ value: 1 });
    resultCell.setMetaRaw("argument", { value: 1 }, rawMetaWriteAuthorization);

    await tx.commit();
    tx = runtime.edit();

    // ensurePieceRunning should return false - no pattern in result metadata
    const result = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(false);
  });

  it("should return false when result cell pattern cannot be loaded", async () => {
    // Create a result cell whose pattern metadata points at a missing pattern.
    const resultCell = runtime.getCell(
      space,
      "no-resultref-test-result",
      undefined,
      tx,
    );

    resultCell.set({ value: 1 });
    resultCell.setMetaRaw("patternIdentity", {
      identity: "missing-pattern-identity",
      symbol: "default",
    }, rawMetaWriteAuthorization);
    resultCell.setMetaRaw("argument", { value: 1 }, rawMetaWriteAuthorization);

    await tx.commit();
    tx = runtime.edit();

    // ensurePieceRunning should return false - pattern cannot be loaded
    const result = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(false);
  });

  it("should start a piece with valid result metadata", async () => {
    // Create a simple pattern
    let patternRan = false;
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { value: { type: "number" } },
      },
      resultSchema: {
        type: "object",
        properties: { doubled: { type: "number" } },
      },
      result: {
        doubled: { $alias: { partialCause: "doubled", path: [] } }, // bound to resultCell.internal.doubled
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => {
              patternRan = true;
              return value * 2;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["value"] } }, // bound to resultCell.argument.value
          outputs: { $alias: { partialCause: "doubled", path: [] } }, // bound to resultCell.internal.doubled
        },
      ],
    };

    const patternIdentity = {
      identity: "test-ensure-piece-1",
      symbol: "default",
    };
    runtime.patternManager.associatePatternIdentity(
      trustPattern(runtime, pattern),
      patternIdentity,
    );

    // Create result cell
    const resultCell = runtime.getCell(
      space,
      "valid-piece-test-result",
      pattern.resultSchema,
      tx,
    );

    const argumentCell = getMetaCell(
      resultCell,
      "argument",
      tx,
      pattern.argumentSchema,
    );
    const doubledCell = getDerivedInternalCell(resultCell, {
      partialCause: "doubled",
    }, tx);

    // Set up the structure
    resultCell.setRaw({
      doubled: doubledCell.getAsWriteRedirectLink(),
    });
    resultCell.setMetaRaw(
      "patternIdentity",
      patternIdentity,
      rawMetaWriteAuthorization,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    setResultCell(doubledCell, resultCell);
    argumentCell.set({ value: 5 });

    await tx.commit();
    tx = runtime.edit();

    // ensurePieceRunning should return true and start the piece
    const result = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(true);

    // Wait for the piece to run
    await resultCell.pull();

    expect(patternRan).toBe(true);
  });

  it("reports the owning root before starting the piece", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { value: { type: "number" } },
      },
      resultSchema: {
        type: "object",
        properties: { doubled: { type: "number" } },
      },
      result: {
        doubled: { $alias: { partialCause: "doubled", path: [] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { cell: "argument", path: ["value"] } },
          outputs: { $alias: { partialCause: "doubled", path: [] } },
        },
      ],
    };
    const patternIdentity = {
      identity: "test-ensure-piece-owning-root",
      symbol: "default",
    };
    runtime.patternManager.associatePatternIdentity(
      trustPattern(runtime, pattern),
      patternIdentity,
    );
    const resultCell = runtime.getCell(
      space,
      "owning root piece result",
      pattern.resultSchema,
      tx,
    );
    const argumentCell = getMetaCell(
      resultCell,
      "argument",
      tx,
      pattern.argumentSchema,
    );
    const doubledCell = getDerivedInternalCell(resultCell, {
      partialCause: "doubled",
    }, tx);
    resultCell.setRaw({ doubled: doubledCell.getAsWriteRedirectLink() });
    resultCell.setMetaRaw(
      "patternIdentity",
      patternIdentity,
      rawMetaWriteAuthorization,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    setResultCell(argumentCell, resultCell);
    setResultCell(doubledCell, resultCell);
    argumentCell.set({ value: 5 });
    await tx.commit();
    tx = runtime.edit();

    // Named through the argument document: the chain resolves to the
    // result cell, and the hook sees that root before the start runs.
    const order: string[] = [];
    const originalStart = runtime.start.bind(runtime);
    runtime.start = (cell) => {
      order.push("start");
      return originalStart(cell);
    };
    try {
      const verdict = await ensurePieceRunningVerdict(
        runtime,
        argumentCell.getAsNormalizedFullLink(),
        {
          onOwningRoot: (rootId) => order.push(`root:${rootId}`),
        },
      );
      expect(verdict.started).toBe(true);
    } finally {
      runtime.start = originalStart;
    }
    const rootId = resultCell.getAsNormalizedFullLink().id;
    expect(order).toEqual([`root:${rootId}`, "start"]);
  });

  it("should be idempotent - calling multiple times is safe", async () => {
    // Create a simple pattern
    let startCount = 0;
    const pattern: Pattern = {
      argumentSchema: { type: "object" },
      resultSchema: { type: "object" },
      result: {},
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: () => {
              startCount++;
            },
          },
          inputs: {},
          outputs: {},
        },
      ],
    };

    const patternIdentity = {
      identity: "test-ensure-piece-2",
      symbol: "default",
    };
    runtime.patternManager.associatePatternIdentity(
      trustPattern(runtime, pattern),
      patternIdentity,
    );

    const resultCell = runtime.getCell(
      space,
      "idempotent-start-test-result",
      undefined,
      tx,
    );

    const argumentCell = getMetaCell(
      resultCell,
      "argument",
      tx,
      pattern.argumentSchema,
    );

    resultCell.set({});
    resultCell.setMetaRaw(
      "patternIdentity",
      patternIdentity,
      rawMetaWriteAuthorization,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    argumentCell.set({});

    await tx.commit();
    tx = runtime.edit();

    // First call should return true (piece started)
    const result1 = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );
    expect(result1).toBe(true);

    await resultCell.pull();

    // Second call should also return true - ensurePieceRunning doesn't track
    // previous calls: starting an already-running piece is a start-registration
    // fast path — `doStart` returns as soon as it finds the piece registered,
    // without running setup at all
    const result2 = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );
    expect(result2).toBe(true);

    // The piece's lift should only have run once: starting an already-running
    // piece returns from the start-registration fast path without
    // re-instantiating it
    expect(startCount).toBe(1);
  });

  it("should restart a stopped piece when called again", async () => {
    // Create a simple pattern that tracks how many times it starts
    let startCount = 0;
    const pattern: Pattern = {
      argumentSchema: { type: "object" },
      resultSchema: { type: "object" },
      result: {},
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: () => {
              startCount++;
            },
          },
          inputs: {},
          outputs: {},
        },
      ],
    };

    const patternIdentity = {
      identity: "test-ensure-piece-3",
      symbol: "default",
    };
    runtime.patternManager.associatePatternIdentity(
      trustPattern(runtime, pattern),
      patternIdentity,
    );

    const resultCell = runtime.getCell(
      space,
      "restart-after-stop-test-result",
      undefined,
      tx,
    );

    const argumentCell = getMetaCell(
      resultCell,
      "argument",
      tx,
      pattern.argumentSchema,
    );

    resultCell.set({});
    resultCell.setMetaRaw(
      "patternIdentity",
      patternIdentity,
      rawMetaWriteAuthorization,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    argumentCell.set({});

    await tx.commit();
    tx = runtime.edit();

    // First call should start the piece
    const result1 = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );
    expect(result1).toBe(true);

    await resultCell.pull();
    expect(startCount).toBe(1);

    // Stop the piece
    runtime.runner.stop(resultCell);

    // Call again - should restart the piece since it was stopped
    const result2 = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );
    expect(result2).toBe(true);

    await resultCell.pull();

    // The piece's lift should have run twice now (once for each start)
    expect(startCount).toBe(2);
  });

  it("should handle events for cells without associated pieces gracefully", async () => {
    // Create a cell that has no piece structure
    const orphanCell = runtime.getCell<unknown>(
      space,
      "orphan-event-cell-test",
      { asCell: ["stream"] },
      tx,
    );

    await tx.commit();
    tx = runtime.edit();

    // Send an event to this cell - should not crash
    runtime.scheduler.queueEvent(
      orphanCell.getAsNormalizedFullLink(),
      { type: "click" },
    );

    // Wait for processing - should complete without errors
    await runtime.idle();
    await runtime.idle();

    // If we get here, the event was handled gracefully (dropped)
    expect(true).toBe(true);
  });
});

describe("queueEvent with auto-start", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should start piece when event sent to result cell path, but not retry if no handler", async () => {
    // Create a pattern with a reactive lift (to prove it starts) but NO event handler
    let liftRunCount = 0;

    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      },
      resultSchema: {
        type: "object",
        properties: {
          doubled: { type: "number" },
          events: { type: "object" },
        },
      },
      derivedInternalCells: [
        { partialCause: "doubled" },
        {
          partialCause: "events",
          schema: { asCell: ["stream"] },
        },
      ],
      result: {
        doubled: { $alias: { partialCause: "doubled", path: [] } },
        events: { $alias: { partialCause: "events", path: [] } },
      },
      nodes: [
        {
          // This lift will run when the piece starts, proving the piece started
          module: {
            type: "javascript",
            implementation: (value: number) => {
              liftRunCount++;
              return value * 2;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["value"] } },
          outputs: { $alias: { partialCause: "doubled", path: [] } },
        },
        // Note: NO handler node for events - this is intentional
      ],
    };

    const patternIdentity = {
      identity: "test-ensure-piece-4",
      symbol: "default",
    };
    runtime.patternManager.associatePatternIdentity(
      trustPattern(runtime, pattern),
      patternIdentity,
    );

    // Create result cell
    const resultCell = runtime.getCell(
      space,
      "no-handler-start-test-result",
      undefined,
      tx,
    );

    // Create a internal and argument cells, and attach them to resultCell.
    // This would be done inside `Runner.#setupInternal()`, but we want to
    // proactively set up links to that internal cell in our result cell.
    const argumentCell = getMetaCell(resultCell, "argument", tx);
    const doubledCell = getDerivedInternalCell(resultCell, {
      partialCause: "doubled",
    }, tx);
    const eventsCell = getDerivedInternalCell(resultCell, {
      partialCause: "events",
      schema: { asCell: ["stream"] },
    }, tx);

    // Set up result cell - events points to internal/events through metadata
    resultCell.setRaw({
      doubled: doubledCell.getAsWriteRedirectLink(),
      events: eventsCell.getAsWriteRedirectLink(),
    });
    resultCell.setMetaRaw(
      "patternIdentity",
      patternIdentity,
      rawMetaWriteAuthorization,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    setResultCell(doubledCell, resultCell);
    setResultCell(eventsCell, resultCell);
    argumentCell.set({ value: 5 });

    await tx.commit();
    tx = runtime.edit();

    // Verify piece is not running yet
    expect(liftRunCount).toBe(0);

    // Send an event to the result cell's events path
    // ensurePieceRunning will:
    // 1. Get cell at resultCell (with path removed)
    // 2. Find pattern metadata in resultCell
    // 3. Start the piece
    const eventsLink = eventsCell.getAsNormalizedFullLink();
    runtime.scheduler.queueEvent(eventsLink, { type: "click" });

    // Wait for auto-start, then demand the output written by the started piece.
    await runtime.idle();
    await doubledCell.pull();

    // The piece should have been started (lift ran)
    expect(liftRunCount).toBe(1);

    // The result should show the lift's output
    expect(resultCell.getAsQueryResult()).toMatchObject({ doubled: 10 });

    // Send another event - ensurePieceRunning may be called again but
    // Starting an already-running piece returns from the start-registration
    // fast path, so it does not restart
    runtime.scheduler.queueEvent(eventsLink, { type: "click" });

    await runtime.idle();
    await runtime.idle();

    // Lift should still only have run once: the start-registration fast path
    // does not re-instantiate
    expect(liftRunCount).toBe(1);
  });

  it("should start piece and process event when handler is defined", async () => {
    // Create a pattern with a handler that reads from the stream
    let liftRunCount = 0;
    let handlerRunCount = 0;
    const receivedEvents: any[] = [];

    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      },
      resultSchema: {
        type: "object",
        properties: {
          doubled: { type: "number" },
          events: { type: "object" },
          eventCount: { type: "number" },
        },
      },
      derivedInternalCells: [
        { partialCause: "doubled" },
        {
          partialCause: "events",
          schema: { asCell: ["stream"] },
        },
        { partialCause: "eventCount", schema: { default: 0 } },
      ],
      result: {
        doubled: { $alias: { partialCause: "doubled", path: [] } },
        events: { $alias: { partialCause: "events", path: [] } },
        eventCount: { $alias: { partialCause: "eventCount", path: [] } },
      },
      nodes: [
        {
          // This lift will run when the piece starts
          module: {
            type: "javascript",
            implementation: (value: number) => {
              liftRunCount++;
              return value * 2;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["value"] } },
          outputs: { $alias: { partialCause: "doubled", path: [] } },
        },
        {
          // Handler that reads from the stream
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: (event: any, ctx: { eventCount: number }) => {
              handlerRunCount++;
              receivedEvents.push(event);
              ctx.eventCount = (ctx.eventCount || 0) + 1;
            },
          },
          inputs: {
            $event: { $alias: { partialCause: "events", path: [] } },
            $ctx: {
              eventCount: {
                $alias: { partialCause: "eventCount", path: [] },
              },
            },
          },
          outputs: {
            eventCount: { $alias: { partialCause: "eventCount", path: [] } },
          },
        },
      ],
    };

    const patternIdentity = {
      identity: "test-ensure-piece-5",
      symbol: "default",
    };
    runtime.patternManager.associatePatternIdentity(
      trustPattern(runtime, pattern),
      patternIdentity,
    );

    // Create result cell
    const resultCell = runtime.getCell(
      space,
      "with-handler-start-test-result",
      undefined,
      tx,
    );

    // Create a internal and argument cells, and attach them to resultCell.
    // This would be done inside `Runner.#setupInternal()`, but we want to
    // proactively set up links to that internal cell in our result cell.
    const argumentCell = getMetaCell(resultCell, "argument", tx);
    const doubledCell = getDerivedInternalCell(resultCell, {
      partialCause: "doubled",
    }, tx);
    const eventsCell = getDerivedInternalCell(resultCell, {
      partialCause: "events",
      schema: { asCell: ["stream"] },
    }, tx);
    const eventCountCell = getDerivedInternalCell(resultCell, {
      partialCause: "eventCount",
    }, tx);

    // Set up result cell - events points to events in internal cell
    resultCell.setRaw({
      doubled: doubledCell.getAsWriteRedirectLink(),
      events: eventsCell.getAsWriteRedirectLink(),
      eventCount: eventCountCell.getAsWriteRedirectLink(),
    });
    resultCell.setMetaRaw(
      "patternIdentity",
      patternIdentity,
      rawMetaWriteAuthorization,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    setResultCell(doubledCell, resultCell);
    setResultCell(eventsCell, resultCell);
    setResultCell(eventCountCell, resultCell);
    argumentCell.set({ value: 5 });
    eventCountCell.setRaw(0);

    await tx.commit();
    tx = runtime.edit();

    // Verify piece is not running yet
    expect(liftRunCount).toBe(0);
    expect(handlerRunCount).toBe(0);

    // Send an event - should start piece and process the event
    // The handler is registered for the events path on internal cell
    const eventsLink = eventsCell.getAsNormalizedFullLink();
    runtime.scheduler.queueEvent(eventsLink, { type: "click", x: 10 });

    // Wait for processing
    await resultCell.pull();
    await runtime.idle();

    // The piece should have been started
    expect(liftRunCount).toBe(1);

    // The handler should have been called
    expect(handlerRunCount).toBe(1);
    expect(receivedEvents).toEqual([{ type: "click", x: 10 }]);

    // Send another event - handler should be called again
    runtime.scheduler.queueEvent(eventsLink, { type: "click", x: 20 });

    await runtime.idle();
    await runtime.idle();

    // Handler should have run twice now
    expect(handlerRunCount).toBe(2);
    expect(receivedEvents).toEqual([
      { type: "click", x: 10 },
      { type: "click", x: 20 },
    ]);

    // Lift should still only have run once (piece only started once)
    expect(liftRunCount).toBe(1);
  });

  it("should follow chained result metadata before auto-starting for an event", async () => {
    let liftRunCount = 0;
    let handlerRunCount = 0;
    const receivedEvents: any[] = [];

    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      },
      resultSchema: {
        type: "object",
        properties: {
          doubled: { type: "number" },
          events: { type: "object" },
        },
      },
      derivedInternalCells: [
        { partialCause: "doubled" },
        {
          partialCause: "events",
          schema: { asCell: ["stream"] },
        },
      ],
      result: {
        doubled: { $alias: { partialCause: "doubled", path: [] } },
        events: { $alias: { partialCause: "events", path: [] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => {
              liftRunCount++;
              return value * 2;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["value"] } },
          outputs: { $alias: { partialCause: "doubled", path: [] } },
        },
        {
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: (event: any) => {
              handlerRunCount++;
              receivedEvents.push(event);
            },
          },
          inputs: {
            $event: { $alias: { partialCause: "events", path: [] } },
          },
          outputs: {},
        },
      ],
    };

    const patternIdentity = {
      identity: "test-ensure-piece-6",
      symbol: "default",
    };
    runtime.patternManager.associatePatternIdentity(
      trustPattern(runtime, pattern),
      patternIdentity,
    );

    const resultCell = runtime.getCell(
      space,
      "with-handler-chained-result-test-result",
      undefined,
      tx,
    );
    const intermediateCell = runtime.getCell(
      space,
      "with-handler-chained-result-test-intermediate",
      undefined,
      tx,
    );

    const argumentCell = getMetaCell(resultCell, "argument", tx);
    const doubledCell = getDerivedInternalCell(resultCell, {
      partialCause: "doubled",
    }, tx);
    const eventsCell = getDerivedInternalCell(resultCell, {
      partialCause: "events",
      schema: { asCell: ["stream"] },
    }, tx);

    resultCell.setRaw({
      doubled: doubledCell.getAsWriteRedirectLink(),
      events: eventsCell.getAsWriteRedirectLink(),
    });
    resultCell.setMetaRaw(
      "patternIdentity",
      patternIdentity,
      rawMetaWriteAuthorization,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    setResultCell(doubledCell, intermediateCell);
    setResultCell(eventsCell, intermediateCell);
    argumentCell.set({ value: 6 });
    intermediateCell.setRaw({});

    setResultCell(intermediateCell, resultCell);

    await tx.commit();
    tx = runtime.edit();

    expect(liftRunCount).toBe(0);
    expect(handlerRunCount).toBe(0);

    const eventsLink = eventsCell.getAsNormalizedFullLink();
    runtime.scheduler.queueEvent(eventsLink, { type: "click", x: 42 });

    await resultCell.pull();
    await runtime.idle();

    expect(liftRunCount).toBe(1);
    expect(handlerRunCount).toBe(1);
    expect(receivedEvents).toEqual([{ type: "click", x: 42 }]);
    expect(resultCell.getAsQueryResult()).toMatchObject({
      doubled: 12,
    });
  });
});

describe("ensurePieceRunning error propagation (r3739139521)", () => {
  it("collapses failures to false by default; propagateErrors rethrows so the serving loop's failure arm is reachable", async () => {
    // A runtime whose edit() throws stands in for any internal failure
    // (pattern load, start). The default caller (event recovery) keeps
    // best-effort false; the serving loop's demand cycle opts into the
    // rethrow so a real failure counts structureLoadFailures instead of
    // masquerading as a creation-race deferral retried every cycle.
    const boom = new Error("pattern load fell over");
    const runtime = {
      edit: () => {
        throw boom;
      },
    } as unknown as Runtime;
    const link = {
      space: "did:key:z6Mk-ensure-piece-test" as never,
      id: "of:ensure-piece-test" as never,
      path: [],
    } as never;
    await expect(ensurePieceRunning(runtime, link)).resolves.toBe(false);
    await expect(ensurePieceRunning(runtime, link, { propagateErrors: true }))
      .rejects.toThrow("pattern load fell over");
  });
});
