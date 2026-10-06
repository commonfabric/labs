// Async scheduling: how the runtime handles promises returned (or not returned)
// by lifts and handlers, and the interaction between async work and idle/pull.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { type Cell } from "../src/builder/types.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Async", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let handler: ReturnType<typeof createBuilder>["commonfabric"]["handler"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({
      lift,
      pattern,
      handler,
    } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("idle should wait for slow async lifted functions", async () => {
    let liftCalled = false;
    let timeoutCalled = false;

    const slowLift = lift<{ x: number }, number>(({ x }) => {
      liftCalled = true;
      return new Promise((resolve) =>
        setTimeout(() => {
          timeoutCalled = true;
          resolve(x * 2);
        }, 100)
      ) as unknown as number;
      // Cast is a hack, because we don't actually want lift to be async as API.
      // This is just temporary support.
    });

    const slowPattern = pattern<{ x: number }>(
      ({ x }) => {
        return { result: slowLift({ x }) };
      },
    );

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "idle should wait for slow async lifted functions",
      undefined,
      tx,
    );
    const result = runtime.run(tx, slowPattern, { x: 1 }, resultCell);
    tx.commit();

    // In pull-based scheduling, the lift won't run until something pulls on it.
    // Start the pull (but don't await yet) to trigger the computation.
    const pullPromise = result.pull();

    // Give time for the lift to start but not complete
    await clock.tick(10);
    expect(liftCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    await clock.tick(100);

    // Now await the pull to wait for completion
    const value = await pullPromise;
    expect(timeoutCalled).toBe(true);
    expect(value).toMatchObject({ result: 2 });
  });

  it("idle should wait for slow async handlers", async () => {
    let handlerCalled = false;
    let timeoutCalled = false;

    const slowHandler = handler<{ value: number }, { result: Cell<number> }>(
      true,
      {
        type: "object",
        properties: { result: { type: "number", asCell: ["cell"] } },
      },
      ({ value }, state) => {
        handlerCalled = true;
        // Using Promise to simulate an async operation
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            timeoutCalled = true;
            state.result.set(value * 2);
            resolve();
          }, 100)
        );
      },
    );

    const slowHandlerPattern = pattern<{ result: number }>(
      ({ result }) => {
        return { result, updater: slowHandler({ result }) };
      },
    );

    const pieceCell = runtime.getCell<{ result: number; updater: any }>(
      space,
      "idle should wait for slow async handlers",
      undefined,
      tx,
    );
    const piece = runtime.run(tx, slowHandlerPattern, { result: 0 }, pieceCell);
    tx.commit();

    await piece.pull();

    // Trigger the handler
    piece.key("updater").send({ value: 5 });

    // Give a small delay to start the handler but not enough to complete
    await clock.tick(10);
    expect(handlerCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    await clock.tick(100);

    // Now pull should wait for the handler's promise to resolve
    const value = await piece.pull();
    expect(timeoutCalled).toBe(true);
    expect(value).toMatchObject({ result: 10 });
  });

  it("idle should not wait for deliberately async handlers and writes should fail", async () => {
    let handlerCalled = false;
    let timeoutCalled = false;
    let timeoutPromise: Promise<void> | undefined;
    let caughtErrorTryingToSetResult: Error | undefined;

    const slowHandler = handler<{ value: number }, { result: Cell<number> }>(
      true,
      {
        type: "object",
        properties: { result: { type: "number", asCell: ["cell"] } },
      },
      ({ value }, state) => {
        handlerCalled = true;
        // Capturing the promise, but _not_ returning it.
        timeoutPromise = new Promise<void>((resolve) =>
          setTimeout(() => {
            timeoutCalled = true;
            try {
              state.result.set(value * 2);
            } catch (error) {
              caughtErrorTryingToSetResult = error as Error;
            }
            resolve();
          }, 10)
        );
      },
    );

    const slowHandlerPattern = pattern<{ result: number }>(
      ({ result }) => {
        return { result, updater: slowHandler({ result }) };
      },
    );

    const pieceCell = runtime.getCell<{ result: number; updater: any }>(
      space,
      "idle should not wait for deliberately async handlers",
      undefined,
      tx,
    );
    const piece = runtime.run(tx, slowHandlerPattern, { result: 0 }, pieceCell);
    tx.commit();

    await piece.pull();

    // Trigger the handler
    piece.key("updater").send({ value: 5 });

    await piece.pull();
    expect(handlerCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    await clock.tick(100);

    // Now wait for the timeout promise to resolve
    await timeoutPromise;
    expect(timeoutCalled).toBe(true);
    expect(caughtErrorTryingToSetResult).toBeDefined();
    // Named, so a `state.result` that read `undefined` — a TypeError from the
    // property access — cannot stand in for the refusal under test.
    expect(caughtErrorTryingToSetResult?.name).toBe(
      "StorageTransactionCompleteError",
    );
    const value = await piece.pull();
    expect(value?.result).toBe(0); // No change
  });
});
