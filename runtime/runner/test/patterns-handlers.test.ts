// Event handlers: defining and invoking handlers, handler metadata,
// handler-produced side effects, schema-annotated handlers, and handler errors.

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { getPatternIdentityRef } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { type Cell } from "../src/builder/types.ts";
import { recordAuthoredDebugSource } from "../src/harness/authored-debug-source.ts";
import { Runtime } from "../src/runtime.ts";
import { type ErrorWithContext } from "../src/scheduler.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Handlers", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let handler: ReturnType<typeof createBuilder>["commonfabric"]["handler"];
  let Writable: ReturnType<typeof createBuilder>["commonfabric"]["Writable"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ lift, pattern, handler, Writable } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should execute handlers", async () => {
    const incHandler = handler<
      { amount: number },
      { counter: Cell<{ value: number }> }
    >(
      true,
      {
        type: "object",
        properties: { counter: { type: "object", asCell: ["cell"] } },
      },
      ({ amount }, { counter }) => {
        const value = counter.key("value");
        value.set(value.get() + amount);
      },
    );

    const incPattern = pattern<{ counter: { value: number } }>(
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const resultCell = runtime.getCell<
      { counter: { value: number }; stream: any }
    >(space, "should execute handlers", undefined, tx);
    const result = runtime.run(tx, incPattern, {
      counter: { value: 0 },
    }, resultCell);
    tx.commit();

    await result.pull();

    result.key("stream").send({ amount: 1 });
    let value = await result.pull();
    expect(value).toMatchObject({ counter: { value: 1 } });

    result.key("stream").send({ amount: 2 });
    value = await result.pull();
    expect(value).toMatchObject({ counter: { value: 3 } });
  });

  it("throws when a handler writes through a binding its `$ctx` schema left plain", async () => {
    // The builder classifies a cell `computed` on the strength of this refusal:
    // `collectWritablyBoundRoots` reads a plain (non-`asCell`) binding as one
    // the body cannot write through. Asserted here through a dispatched
    // handler, because a view built directly from a cell does not exercise the
    // path the classifier reasons about.
    let caught: unknown;
    const writeHandler = handler<
      { amount: number },
      { counter: { value: number } }
    >(
      true,
      true,
      ({ amount }, { counter }) => {
        try {
          // `HandlerState` already marks a plain binding read-only at the type
          // level; the cast reaches past that to the runtime refusal, which is
          // the half the builder's classification rests on.
          (counter as { value: number }).value = amount;
        } catch (error) {
          caught = error;
        }
      },
    );

    const writePattern = pattern<{ counter: { value: number } }>(
      ({ counter }) => ({ counter, stream: writeHandler({ counter }) }),
    );

    const resultCell = runtime.getCell<
      { counter: { value: number }; stream: any }
    >(space, "plain binding refuses a write", undefined, tx);
    const result = runtime.run(tx, writePattern, {
      counter: { value: 0 },
    }, resultCell);
    tx.commit();
    await result.pull();

    result.key("stream").send({ amount: 7 });
    const value = await result.pull();

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("read-only");
    expect(value).toMatchObject({ counter: { value: 0 } });
  });

  it("defers handler registration for retryable setup transactions until commit", async () => {
    const addEventHandlerSpy = spy(runtime.scheduler, "addEventHandler");

    const incHandler = handler<
      { amount: number },
      { counter: Cell<{ value: number }> }
    >(
      true,
      {
        type: "object",
        properties: { counter: { type: "object", asCell: ["cell"] } },
      },
      ({ amount }, { counter }) => {
        const value = counter.key("value");
        value.set(value.get() + amount);
      },
    );

    const incPattern = pattern<{ counter: { value: number } }>(
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const result = await runtime.editWithRetry((retryTx) => {
      const resultCell = runtime.getCell<
        { counter: { value: number }; stream: any }
      >(space, "defer retryable handler start", undefined, retryTx);
      const cell = runtime.run(retryTx, incPattern, {
        counter: { value: 0 },
      }, resultCell);

      expect(addEventHandlerSpy.calls.length).toBe(0);
      return cell;
    });
    if (result.error) throw new Error(result.error.message);

    await result.ok.pull();

    expect(addEventHandlerSpy.calls.length).toBe(1);

    addEventHandlerSpy.restore();
  });

  it("propagates a handler's authored source location to the scheduler as its name", async () => {
    // Spy on addEventHandler to capture the handler passed to it
    const addEventHandlerSpy = spy(runtime.scheduler, "addEventHandler");

    // This handler is built directly in test code rather than compiled, so
    // record the same debug-sidecar entry the engine would supply.
    const incImplementation = (
      { amount }: { amount: number },
      { counter }: { counter: Cell<{ value: number }> },
    ) => {
      const value = counter.key("value");
      value.set(value.get() + amount);
    };
    const incHandler = handler<
      { amount: number },
      { counter: Cell<{ value: number }> }
    >(
      true,
      {
        type: "object",
        properties: { counter: { type: "object", asCell: ["cell"] } },
      },
      incImplementation,
    );
    recordAuthoredDebugSource(incImplementation, {
      src: "cf:module/HASH/patterns-handlers.tsx:12:4",
    });

    const incPattern = pattern<{ counter: { value: number } }>(
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const resultCell = runtime.getCell<
      { counter: { value: number }; stream: any }
    >(space, "handler source location test", undefined, tx);
    const result = runtime.run(tx, incPattern, {
      counter: { value: 0 },
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    // Verify addEventHandler was called and the handler has .name set
    expect(addEventHandlerSpy.calls.length).toBeGreaterThan(0);
    const registeredHandler = addEventHandlerSpy.calls[0].args[0];

    expect(registeredHandler.name).toBe(
      "handler:cf:module/HASH/patterns-handlers.tsx:12:4",
    );

    addEventHandlerSpy.restore();
  });

  it("should annotate event handlers with write targets", async () => {
    const addEventHandlerSpy = spy(runtime.scheduler, "addEventHandler");

    const incHandler = handler<
      { amount: number },
      { counter: Cell<{ value: number }> }
    >(
      true,
      {
        type: "object",
        properties: { counter: { type: "object", asCell: ["cell"] } },
      },
      ({ amount }, { counter }) => {
        const value = counter.key("value");
        value.set(value.get() + amount);
      },
    );

    const incPattern = pattern<{ counter: { value: number } }>(
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const resultCell = runtime.getCell<
      { counter: { value: number }; stream: any }
    >(space, "handler write target annotation test", undefined, tx);
    const result = runtime.run(tx, incPattern, {
      counter: { value: 0 },
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    expect(addEventHandlerSpy.calls.length).toBeGreaterThan(0);
    const registeredHandler = addEventHandlerSpy.calls[0].args[0] as {
      writes?: unknown[];
    };
    expect(registeredHandler.writes).toBeDefined();

    addEventHandlerSpy.restore();
  });

  it("evaluates a handler-written pattern result only when it is pulled", async () => {
    const counter = runtime.getCell<{ value: number }>(
      space,
      "demand handler-written pattern results 1",
      undefined,
      tx,
    );
    counter.set({ value: 0 });
    const nested = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "demand handler-written pattern results 2",
      undefined,
      tx,
    );
    nested.set({ a: { b: { c: 0 } } });

    const values: [number, number, number][] = [];

    const incLogger = lift<
      { counter: { value: number }; amount: number; nested: { c: number } },
      [number, number, number]
    >(({ counter, amount, nested }) => {
      const tuple: [number, number, number] = [counter.value, amount, nested.c];
      values.push(tuple);
      return tuple;
    });

    // `latest` boxes the node's output, and the handler writes it through
    // `.key("output")`, because the second event has to RE-POINT that slot at
    // a second node. An unboxed `latest` cannot be re-pointed: an `asCell`
    // handle resolves the write-redirect chain and then one step past the
    // first non-redirect link (`schema-links.test.ts`, "returns Cell pointing
    // one step past first non-redirect"), so once `latest` holds a reference
    // to the first node's output document the handle addresses THAT document
    // and a second `.set()` writes into it. Boxing, and naming the slot with
    // `.key()`, is the documented shape for a stored reference —
    // `docs/development/debugging/gotchas/cell-reference-overwrite.md`.
    const incHandler = handler<
      { amount: number },
      {
        counter: Cell<{ value: number }>;
        nested: { a: { b: { c: number } } };
        latest: Cell<{ output?: number[] }>;
      }
    >(
      true,
      {
        type: "object",
        properties: {
          counter: { type: "object", asCell: ["cell"] },
          nested: true,
          latest: {
            type: "object",
            properties: { output: { type: "array" } },
            asCell: ["cell"],
          },
        },
      },
      (event, state) => {
        const value = state.counter.key("value");
        value.set(value.get() + event.amount);
        state.latest.key("output").set(incLogger({
          counter: state.counter,
          amount: event.amount,
          nested: state.nested.a.b,
        }));
      },
    );

    const incPattern = pattern<{
      counter: { value: number };
      nested: { a: { b: { c: number } } };
    }>(({ counter, nested }) => {
      const latest = Writable.of<{ output?: number[] }>({});
      const stream = incHandler({ counter, nested, latest });
      return { stream, latest };
    });

    const resultCell = runtime.getCell<
      { stream: any; latest: { output?: number[] } }
    >(
      space,
      "demand handler-written pattern results",
      undefined,
      tx,
    );
    const result = runtime.run(tx, incPattern, { counter, nested }, resultCell);
    tx.commit();

    await result.pull();

    const output = result.key("latest").key("output");

    // The node the handler built is reached by pulling its cell: dispatching
    // the event and letting the scheduler settle runs nothing, and the pull is
    // what evaluates it.
    result.key("stream").send({ amount: 1 });
    await runtime.idle();
    expect(values).toEqual([]);
    expect(await output.pull()).toEqual([1, 1, 0]);
    expect(values).toEqual([[1, 1, 0]]);

    // A second event builds a second node and re-points `latest.output` at it.
    // The first node's output document is no longer reachable from anything
    // pulled, so it loses demand: it must not re-run against the newer counter
    // and must not be what `latest.output` resolves to.
    result.key("stream").send({ amount: 2 });
    await runtime.idle();
    expect(await output.pull()).toEqual([3, 2, 0]);
    expect(values).toContainEqual([1, 1, 0]);
    expect(values).toContainEqual([3, 2, 0]);
    expect(values.some((tuple) => tuple.join(",") === "3,1,0")).toBe(false);
  });

  it("should execute handlers with schemas", async () => {
    const incHandler = handler<{ amount: number }, { counter: number }>(
      { type: "object", properties: { amount: { type: "number" } } },
      {
        type: "object",
        properties: {
          counter: {
            type: "number",
            asCell: ["cell"],
          },
        },
      },
      ({ amount }, { counter }) => {
        const counterCell = counter as unknown as Cell<number>;
        counterCell.send(counterCell.get() + amount);
      },
    );

    const incPattern = pattern<{ counter: number }>(
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const resultCell = runtime.getCell<{ counter: number; stream: any }>(
      space,
      "should execute handlers with schemas",
      undefined,
      tx,
    );
    const result = runtime.run(tx, incPattern, {
      counter: 0,
    }, resultCell);
    tx.commit();

    await result.pull();

    result.key("stream").send({ amount: 1 });
    let value = await result.pull();
    expect(value).toMatchObject({ counter: 1 });

    result.key("stream").send({ amount: 2 });
    value = await result.pull();
    expect(value).toMatchObject({ counter: 3 });
  });

  it("failed handlers should be ignored", async () => {
    let errors = 0;
    let lastError: ErrorWithContext | undefined;

    runtime.scheduler.onError((error: ErrorWithContext) => {
      lastError = error;
      errors++;
    });

    const divHandler = handler<
      { divisor: number; dividend: number },
      { result: Cell<number> }
    >(
      true,
      {
        type: "object",
        properties: { result: { type: "number", asCell: ["cell"] } },
      },
      ({ divisor, dividend }, state) => {
        if (dividend === 0) {
          throw new Error("division by zero");
        }
        state.result.set(divisor / dividend);
      },
    );

    const divPattern = pattern<{ result: number }>(
      ({ result }) => {
        return { updater: divHandler({ result }), result };
      },
    );

    const pieceCell = runtime.getCell<{ result: number; updater: any }>(
      space,
      "failed handlers should be ignored",
      undefined,
      tx,
    );
    const piece = runtime.run(tx, divPattern, { result: 1 }, pieceCell);
    tx.commit();

    await piece.pull();

    piece.key("updater").send({ divisor: 5, dividend: 1 });
    let value = await piece.pull();
    expect(errors).toBe(0);

    expect(value).toMatchObject({ result: 5 });

    piece.key("updater").send({ divisor: 10, dividend: 0 });
    value = await piece.pull();
    expect(errors).toBe(1);
    expect(value).toMatchObject({ result: 5 });

    // A hand-built (keyless) piece carries no durable pattern pointer
    // (the never-durable contract; L3(a), RULED 2026-08-27); the scheduler
    // diagnostics fall back to the in-hand pattern's session entry ref.
    expect(getPatternIdentityRef(piece)).toBeUndefined();
    const patternIdentity = runtime.patternManager.getArtifactEntryRef(
      divPattern as unknown as object,
    )?.identity;
    expect(patternIdentity).toMatch(/^keyless:/);
    expect(lastError?.patternId).toBe(patternIdentity);
    expect(lastError?.space).toBe(space);
    // Diagnostics carry the FULL schemed sourceURI (see diagnostics.ts:
    // ids copied from error context paste back into tools without a
    // bare-id round trip).
    expect(lastError?.pieceId).toBe(piece.sourceURI);

    // NOTE(ja): this test is really important after a handler
    // fails the entire system crashes!!!!
    piece.key("updater").send({ divisor: 10, dividend: 5 });
    value = await piece.pull();
    expect(value).toMatchObject({ result: 2 });
  });
});
