import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { sandboxDateNow, sandboxRandom } from "../src/builder/safe-builtins.ts";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const STREAM_SCHEMA = {
  type: "object",
  properties: { events: { type: "object", asCell: ["stream"] } },
} as const satisfies JSONSchema;

// Gate behavior for the gated ambient clock/entropy intrinsics sandboxDateNow()/
// sandboxRandom() (W1 keystone). They read the lift-vs-handler context from the
// active frame — coarse inside a handler, throwing everywhere else — so we
// exercise them by pushing a frame with or without `inHandler` rather than
// spinning up a full pattern.

function fakeRuntime(): Runtime {
  return { experimental: {} } as unknown as Runtime;
}

function inFrame<T>(
  props: { inHandler?: boolean; eventTime?: number },
  fn: () => T,
): T {
  const frame = pushFrame({
    runtime: fakeRuntime(),
    // A handler frame carries the dispatching event's instant; the ambient clock
    // reads this frozen value, not the live clock. Default to a fixed instant so
    // a test reads a deterministic coarse time.
    ...(props.inHandler
      ? { inHandler: true, eventTime: props.eventTime ?? 1_700_000_123_456 }
      : {}),
  });
  try {
    return fn();
  } finally {
    popFrame(frame);
  }
}

describe("time/entropy capability gate", () => {
  it("lift/pattern-body context: both throw", () => {
    inFrame({}, () => {
      expect(() => sandboxDateNow()).toThrow("not available in this context");
      expect(() => sandboxRandom()).toThrow("not available in this context");
    });
  });

  it("handler context: clock is the event's time coarsened to 1s, entropy passes", () => {
    inFrame({ inHandler: true, eventTime: 1_700_000_123_456 }, () => {
      const t = sandboxDateNow();
      expect(typeof t).toBe("number");
      expect(t % 1000).toBe(0);
      // The event's instant floored to the second, not the live wall clock.
      expect(t).toBe(1_700_000_123_000);
      expect(typeof sandboxRandom()).toBe("number");
    });
  });

  it("handler context: the clock is frozen — repeated reads never advance", async () => {
    // The load-bearing property: time does not move during a handler's own work,
    // so a read before and after elapsed live time is identical and cannot serve
    // as an intra-run clock. Advance the live clock between the two reads — a
    // handler clock that read it would change; the event-bound one does not.
    const frame = pushFrame({
      runtime: fakeRuntime(),
      inHandler: true,
      eventTime: 1_700_000_000_500,
    });
    try {
      const first = sandboxDateNow();
      await clock.tick(5000);
      expect(Date.now()).toBeGreaterThan(first);
      expect(sandboxDateNow()).toBe(first);
    } finally {
      popFrame(frame);
    }
  });

  it("handler context with no event time recorded: throws (no live-clock fallback)", () => {
    // A handler frame must carry an event instant; there is no path that reads
    // the live clock. createPatternFrame always sets one.
    const frame = pushFrame({ runtime: fakeRuntime(), inHandler: true });
    try {
      expect(() => sandboxDateNow()).toThrow("not available in this context");
    } finally {
      popFrame(frame);
    }
  });

  it("no frame at all: both throw (ambient time/entropy is never exposed)", () => {
    expect(() => sandboxDateNow()).toThrow();
    expect(() => sandboxRandom()).toThrow();
  });
});

describe("lift event-emit gate", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  function makeStream(
    rt: Runtime,
    t: IExtendedStorageTransaction,
    cause: string,
  ) {
    const c = rt.getCell(space, cause, undefined, t);
    return c.asSchema(STREAM_SCHEMA).key("events");
  }

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

  it("lift frame: emitting to a stream throws", () => {
    const stream = makeStream(runtime, tx, "emit-gate/lift");
    const frame = pushFrame({ frameKind: "lift" });
    try {
      expect(() => stream.send({ n: 1 })).toThrow("must be pure");
    } finally {
      popFrame(frame);
    }
  });

  it("handler frame: emitting to a stream is allowed", () => {
    const stream = makeStream(runtime, tx, "emit-gate/handler");
    const frame = pushFrame({ frameKind: "handler" });
    try {
      expect(() => stream.send({ n: 1 })).not.toThrow();
    } finally {
      popFrame(frame);
    }
  });

  it("no pattern frame (internal/renderer send): allowed", () => {
    const stream = makeStream(runtime, tx, "emit-gate/internal");
    expect(() => stream.send({ n: 1 })).not.toThrow();
  });
});
