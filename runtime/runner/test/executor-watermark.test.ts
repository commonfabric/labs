// Server-execution v2 stage F: waitForSettled's subscription lifecycle
// (PR #5439 thread r3731191498). Cell.sink invokes its callback with the
// CURRENT value before returning, so a watermark that already satisfies
// `seq` settles synchronously — before the sink's cancel exists. The
// wait must still cancel the subscription (replayed after assignment):
// tests and serving code call waitForSettled repeatedly against an
// already-settled W, and each leaked sink would keep triggering
// scheduler work for the rest of the runtime's life.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { waitForSettled } from "../src/executor/watermark.ts";
import type { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const space = "did:key:z6Mk-watermark-test" as MemorySpace;

type SinkCallback = (value: { seq?: number } | undefined) => void;

/** A stub runtime whose watermark cell fires its sink SYNCHRONOUSLY with
 * a fixed current value — the shape the real Cell.sink has when W
 * already satisfies the wait. */
const stubRuntime = (currentSeq: number): {
  runtime: Runtime;
  counters: { sinks: number; cancels: number };
  fire: (seq: number) => void;
} => {
  const counters = { sinks: 0, cancels: 0 };
  const callbacks = new Set<SinkCallback>();
  const cell = {
    sink: (callback: SinkCallback) => {
      counters.sinks += 1;
      callbacks.add(callback);
      callback({ seq: currentSeq });
      return () => {
        counters.cancels += 1;
        callbacks.delete(callback);
      };
    },
  };
  const runtime = {
    getCellFromLink: () => cell,
  } as unknown as Runtime;
  return {
    runtime,
    counters,
    fire: (seq: number) => {
      for (const callback of [...callbacks]) callback({ seq });
    },
  };
};

describe("waitForSettled subscription lifecycle", () => {
  it("cancels the sink when W already satisfies seq (the synchronous-fire path must not leak the subscription)", async () => {
    const { runtime, counters, fire } = stubRuntime(100);
    const settled = await waitForSettled(runtime, space, 42);
    expect(settled).toBe(100);
    expect(counters.sinks).toBe(1);
    expect(counters.cancels).toBe(1);
    // No zombie subscription: a later watermark movement reaches nobody.
    fire(200);
    expect(counters.cancels).toBe(1);
  });

  it("cancels exactly once on the asynchronous path too", async () => {
    const { runtime, counters, fire } = stubRuntime(0);
    const wait = waitForSettled(runtime, space, 42);
    expect(counters.sinks).toBe(1);
    expect(counters.cancels).toBe(0);
    fire(50);
    expect(await wait).toBe(50);
    expect(counters.cancels).toBe(1);
    fire(60);
    expect(counters.cancels).toBe(1);
  });
});
