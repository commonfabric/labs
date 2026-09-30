import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  BURST_CAPACITY,
  CELL_GROUP_PREFIX,
  type DeliverFn,
  type DeliverOpts,
  holdShapedCell,
  holdShapedEvent,
  shouldShapeDelivery,
  stripClockFields,
  WakeShaper,
} from "../src/scheduler/wake-shaping.ts";
import {
  isRendererTrustedEvent,
  markRendererTrustedEvent,
} from "../src/cfc/ui-contract.ts";
import { MAX_EVENT_BACKLOG_PER_STREAM } from "../src/scheduler/constants.ts";
import { type NormalizedFullLink } from "../src/link-utils.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import type { EventHandler } from "../src/scheduler/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

// The shaper keys are per scope INSTANCE (stage F); the tests resolve
// against one fixed identity, mirroring the OFF arm's cardinality 1.
const TEST_IDENTITY = {
  principal: "did:test:shaper",
  sessionId: "shaper-session",
};

const signer = await Identity.fromPassphrase("delivery shaping test");
const space = signer.did();

function link(id: string, path: string[] = []): NormalizedFullLink {
  return { space, id, path } as unknown as NormalizedFullLink;
}

//
// stripClockFields
//

describe("stripClockFields", () => {
  it("removes a top-level timestamp without mutating the input", () => {
    const event = { type: "tap", timestamp: 1718000000000, x: 3 };
    const out = stripClockFields(event) as Record<string, unknown>;
    expect(out).toEqual({ type: "tap", x: 3 });
    expect("timestamp" in event).toBe(true); // original untouched
  });

  it("removes detail.timestamp without mutating the input", () => {
    const event = { type: "cf-x", detail: { value: "a", timestamp: 42 } };
    const out = stripClockFields(event) as { detail: Record<string, unknown> };
    expect(out.detail).toEqual({ value: "a" });
    expect((event.detail as Record<string, unknown>).timestamp).toBe(42);
  });

  it("removes clock fields nested deeper than detail (e.g. detail.location.timestamp)", () => {
    const event = {
      type: "cf-location-update",
      detail: { location: { lat: 1, lon: 2, timestamp: 1718000000000 } },
      timeStamp: 5,
    };
    expect(stripClockFields(event)).toEqual({
      type: "cf-location-update",
      detail: { location: { lat: 1, lon: 2 } },
    });
  });

  it("scrubs clock fields inside arrays", () => {
    const event = { detail: { points: [{ x: 1, timestamp: 9 }, { x: 2 }] } };
    expect(stripClockFields(event)).toEqual({
      detail: { points: [{ x: 1 }, { x: 2 }] },
    });
  });

  it("leaves events without clock fields untouched (same reference)", () => {
    const event = { type: "tap", detail: { value: "a" } };
    expect(stripClockFields(event)).toBe(event);
  });

  it("passes non-records through", () => {
    expect(stripClockFields(5)).toBe(5);
    expect(stripClockFields(null)).toBe(null);
  });
});

//
// shouldShapeDelivery
//

describe("shouldShapeDelivery", () => {
  it("is true only for renderer-trusted events", () => {
    const trusted = { type: "tap" };
    markRendererTrustedEvent(trusted);
    expect(shouldShapeDelivery(trusted)).toBe(true);
    expect(shouldShapeDelivery({ type: "tap" })).toBe(false);
    expect(shouldShapeDelivery(7)).toBe(false);
  });
});

//
// Wake shaper, event path (unit, deterministic zero-length window)
//

// The old DeliveryShaper surface, expressed over the unified WakeShaper +
// holdShapedEvent adapter, so the event-path contract assertions below stay
// exactly as they were.
function eventShaper(
  deliver: DeliverFn,
  windowMs?: number,
  capacity?: number,
) {
  const engine = new WakeShaper(windowMs, capacity);
  return {
    engine,
    hold: (
      groupKey: string | undefined,
      eventLink: NormalizedFullLink,
      event: unknown,
      retries: boolean,
      onCommit: ((tx: IExtendedStorageTransaction) => void) | undefined,
      opts: DeliverOpts = {},
    ) =>
      holdShapedEvent(
        engine,
        deliver,
        groupKey,
        eventLink,
        TEST_IDENTITY,
        event,
        retries,
        onCommit,
        opts,
      ),
    hasPending: () => engine.hasPending(),
    whenDrained: () => engine.whenDrained(),
    dispose: () => engine.dispose(),
  };
}

describe("wake shaper (event path)", () => {
  function recorder() {
    const calls: Array<{ id: string; event: unknown }> = [];
    const deliver: DeliverFn = (eventLink, event) => {
      calls.push({ id: eventLink.id, event });
    };
    return { calls, deliver };
  }

  it("delivers a burst up to capacity in realtime (synchronously)", () => {
    const { calls, deliver } = recorder();
    const shaper = eventShaper(deliver, 0, 3); // burst budget of 3
    shaper.hold(undefined, link("a"), { n: 1 }, true, undefined);
    shaper.hold(undefined, link("a"), { n: 2 }, true, undefined);
    shaper.hold(undefined, link("a"), { n: 3 }, true, undefined);
    // All within the burst budget: delivered immediately, no window wait.
    expect(calls.map((c) => c.event)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(shaper.hasPending()).toBe(false);
    shaper.dispose();
  });

  it("holds sustained input beyond the burst and releases it in order, without dropping", async () => {
    const { calls, deliver } = recorder();
    const shaper = eventShaper(deliver, 0, 2); // burst budget of 2
    for (let n = 1; n <= 5; n++) {
      shaper.hold(undefined, link("a"), { n }, true, undefined);
    }
    // First two burst through immediately; the rest are held (rate-capped).
    expect(calls.map((c) => c.event)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(shaper.hasPending()).toBe(true);
    await shaper.whenDrained();
    // Every event is delivered, in order — the overflow is queued, not last-wins,
    // so a counter still counts every click.
    expect(calls.map((c) => c.event)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
      { n: 4 },
      { n: 5 },
    ]);
    shaper.dispose();
  });

  it("holds the overflow for the window and releases it together (rate cap)", async () => {
    const { calls, deliver } = recorder();
    const shaper = eventShaper(deliver, 40, 1); // 40ms window, burst 1
    shaper.hold(undefined, link("a"), { n: 1 }, true, undefined); // burst
    shaper.hold(undefined, link("a"), { n: 2 }, true, undefined); // held
    shaper.hold(undefined, link("a"), { n: 3 }, true, undefined); // held
    // Only the burst is out immediately; the overflow waits for the window.
    expect(calls.map((c) => c.event)).toEqual([{ n: 1 }]);
    await shaper.whenDrained();
    // The two held events release together at the trailing edge, in order.
    expect(calls.map((c) => c.event)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    shaper.dispose();
  });

  it("refills the burst after quiet time (group closes, then a fresh burst)", async () => {
    const { calls, deliver } = recorder();
    const shaper = eventShaper(deliver, 20, 1); // 20ms window, burst 1
    shaper.hold(undefined, link("a"), { n: 1 }, true, undefined); // burst
    shaper.hold(undefined, link("a"), { n: 2 }, true, undefined); // held (rate-capped)
    await shaper.whenDrained();
    expect(calls.map((c) => c.event)).toEqual([{ n: 1 }, { n: 2 }]);
    // Let the bucket refill to full and the idle group close.
    await clock.tick(80);
    // A fresh event bursts immediately again — synchronously, since the delivery
    // shaper's burst is synchronous and the bucket is full.
    shaper.hold(undefined, link("a"), { n: 3 }, true, undefined);
    expect(calls.map((c) => c.event)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    shaper.dispose();
  });

  it("shares one token bucket across a pattern's streams (grouped by pattern)", async () => {
    const { calls, deliver } = recorder();
    const shaper = eventShaper(deliver, 0, 1); // one shared burst token
    shaper.hold("piece-1", link("a"), { n: 1 }, true, undefined); // consumes the token
    shaper.hold("piece-1", link("b"), { n: 2 }, true, undefined); // held (bucket empty)
    shaper.hold("piece-1", link("c"), { n: 3 }, true, undefined); // held
    expect(calls.map((c) => c.id)).toEqual(["a"]); // only the leading, synchronously
    expect(shaper.hasPending()).toBe(true);
    await shaper.whenDrained();
    expect(calls.map((c) => c.id).sort()).toEqual(["a", "b", "c"]); // all delivered
    shaper.dispose();
  });

  it("gives ungrouped streams independent buckets", () => {
    const { calls, deliver } = recorder();
    const shaper = eventShaper(deliver, 0, 1); // burst 1 each
    shaper.hold(undefined, link("a"), { n: 1 }, true, undefined); // a's own bucket
    shaper.hold(undefined, link("b"), { n: 2 }, true, undefined); // b's own bucket
    // Distinct streams, distinct buckets: both burst through immediately.
    expect(calls.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(shaper.hasPending()).toBe(false);
    shaper.dispose();
  });

  it("does not drop repeated events to one stream (queued, all delivered)", async () => {
    const { calls, deliver } = recorder();
    const shaper = eventShaper(deliver, 0, 1); // burst 1
    shaper.hold("piece-1", link("a"), { n: 1 }, true, undefined); // burst
    shaper.hold("piece-1", link("a"), { n: 2 }, true, undefined); // held
    shaper.hold("piece-1", link("a"), { n: 3 }, true, undefined); // held
    await shaper.whenDrained();
    // A counter must see every click: all three delivered, in order, not last-wins.
    expect(calls.filter((c) => c.id === "a").map((c) => c.event)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
    shaper.dispose();
  });

  it("strips clock fields from the delivered event", () => {
    const { calls, deliver } = recorder();
    const shaper = eventShaper(deliver, 0);
    shaper.hold(
      undefined,
      link("a"),
      { type: "tap", timestamp: 99 },
      true,
      undefined,
    );
    // Within the burst budget, delivered synchronously.
    expect(calls[0].event).toEqual({ type: "tap" });
    shaper.dispose();
  });

  it("preserves renderer-trust on the stripped (copied) event", () => {
    const { calls, deliver } = recorder();
    const shaper = eventShaper(deliver, 0);
    const event = { type: "tap", timestamp: 99 };
    markRendererTrustedEvent(event);
    shaper.hold(undefined, link("a"), event, true, undefined);
    // The delivered object is a fresh copy (clock stripped) but must still be
    // recognized as renderer-trusted so UI-contract write authorization holds.
    expect(calls[0].event).not.toBe(event);
    expect(isRendererTrustedEvent(calls[0].event)).toBe(true);
    shaper.dispose();
  });

  it("carries eventId/originTx through both burst and overflow delivery", async () => {
    const calls: Array<{ id: string; opts: DeliverOpts }> = [];
    const deliver: DeliverFn = (
      eventLink,
      _event,
      _retries,
      _onCommit,
      opts,
    ) => {
      calls.push({ id: eventLink.id, opts });
    };
    const shaper = eventShaper(deliver, 0, 1); // burst budget of 1
    const tx1 = {} as unknown as IExtendedStorageTransaction;
    const tx2 = {} as unknown as IExtendedStorageTransaction;
    shaper.hold(undefined, link("a"), { n: 1 }, true, undefined, {
      eventId: "e1",
      originTx: tx1,
    }); // burst
    shaper.hold(undefined, link("a"), { n: 2 }, true, undefined, {
      eventId: "e2",
      originTx: tx2,
    }); // overflow
    await shaper.whenDrained();
    // The causal origin is preserved on both delivery paths — not dropped to
    // undefined (which would defeat speculation-lineage and the W4 collapse guard).
    expect(calls.map((c) => c.opts.eventId)).toEqual(["e1", "e2"]);
    expect(calls[0].opts.originTx).toBe(tx1);
    expect(calls[1].opts.originTx).toBe(tx2);
    shaper.dispose();
  });

  it("carries runtimeInjectedEventKeys through both burst and overflow delivery", async () => {
    // Injection provenance must ride a held delivery unchanged: dropping it
    // at release would strip the closed-world gate's exemption from a shaped
    // event, turning a legitimate runtime-injected key into a rejection.
    const calls: Array<{ opts: DeliverOpts }> = [];
    const deliver: DeliverFn = (
      _eventLink,
      _event,
      _retries,
      _onCommit,
      opts,
    ) => {
      calls.push({ opts });
    };
    const shaper = eventShaper(deliver, 0, 1); // burst budget of 1
    shaper.hold(undefined, link("a"), { n: 1 }, true, undefined, {
      runtimeInjectedEventKeys: ["result"],
    }); // burst
    shaper.hold(undefined, link("a"), { n: 2 }, true, undefined, {
      runtimeInjectedEventKeys: ["result"],
    }); // overflow
    await shaper.whenDrained();
    expect(calls.map((c) => c.opts.runtimeInjectedEventKeys)).toEqual([
      ["result"],
      ["result"],
    ]);
    shaper.dispose();
  });

  it("delivers no held overflow after dispose", async () => {
    const { calls, deliver } = recorder();
    const shaper = eventShaper(deliver, 0, 1); // burst 1
    shaper.hold(undefined, link("a"), { n: 1 }, true, undefined); // burst (out)
    shaper.hold(undefined, link("a"), { n: 2 }, true, undefined); // held
    expect(calls.map((c) => c.event)).toEqual([{ n: 1 }]);
    shaper.dispose();
    expect(shaper.hasPending()).toBe(false);
    await clock.tick(5);
    expect(calls.map((c) => c.event)).toEqual([{ n: 1 }]); // n:2 never delivered
    shaper.dispose();
  });
});

//
// Unified engine (plan C): properties specific to one shaper serving both paths
//

describe("WakeShaper (unified engine)", () => {
  it("keeps event-path and cell-path budgets separate for the same pattern", async () => {
    const engine = new WakeShaper(0, 1); // ONE token per group
    const seen: string[] = [];
    const deliver: DeliverFn = (eventLink) => {
      seen.push(`event:${eventLink.id}`);
    };
    // Same logical pattern key on both paths. With a shared bucket the second
    // hold would overflow; with namespaced groups both deliver realtime.
    holdShapedEvent(
      engine,
      deliver,
      "piece-1",
      link("a"),
      TEST_IDENTITY,
      { n: 1 },
      true,
      undefined,
    );
    holdShapedCell(engine, "piece-1", "cell-1", {}, () => seen.push("cell:1"));
    expect(seen).toEqual(["event:a"]); // cell leading edge is deferred
    await engine.whenDrained();
    expect(seen.sort()).toEqual(["cell:1", "event:a"]);
    engine.dispose();
  });

  it("filters hasPending by group namespace", () => {
    const engine = new WakeShaper(1000, 1);
    const deliver: DeliverFn = () => {};
    // Overflow the EVENT path only (second event queues behind the spent token).
    holdShapedEvent(
      engine,
      deliver,
      "piece-1",
      link("a"),
      TEST_IDENTITY,
      { n: 1 },
      true,
      undefined,
    );
    holdShapedEvent(
      engine,
      deliver,
      "piece-1",
      link("a"),
      TEST_IDENTITY,
      { n: 2 },
      true,
      undefined,
    );
    expect(engine.hasPending()).toBe(true);
    expect(engine.hasPending(CELL_GROUP_PREFIX)).toBe(false);
    engine.dispose();
  });

  it("does not let an uncharged hold ride a prior charged token", async () => {
    const engine = new WakeShaper(0, 1);
    const order: string[] = [];
    const charge = {};
    holdShapedCell(engine, "piece-1", "cell-1", charge, () => order.push("c1"));
    // Same commit rides the token; a DIFFERENT commit must not.
    holdShapedCell(
      engine,
      "piece-1",
      "cell-2",
      charge,
      () => order.push("c1-rider"),
    );
    holdShapedCell(engine, "piece-1", "cell-3", {}, () => order.push("c2"));
    await engine.whenDrained();
    expect(order.sort()).toEqual(["c1", "c1-rider", "c2"]);
    engine.dispose();
  });
});

//
// Scheduler integration (real Runtime, default shaper)
//

const STREAM_SCHEMA = {
  type: "object",
  properties: { events: { type: "object", asCell: ["stream"] } },
} as const satisfies JSONSchema;

describe("delivery shaping (scheduler integration)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  function makeRuntime(): Runtime {
    return new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  }

  // Register a recording handler on a fresh stream, returning its link and the
  // list of events the handler receives.
  function streamWithHandler(runtime: Runtime, cause: string) {
    const tx = runtime.edit();
    const c = runtime.getCell(space, cause, undefined, tx);
    const stream = c.asSchema(STREAM_SCHEMA).key("events");
    const linkRef = stream.getAsNormalizedFullLink();
    const received: unknown[] = [];
    const handler: EventHandler = (
      _tx: IExtendedStorageTransaction,
      event: unknown,
    ) => {
      received.push(event);
    };
    runtime.scheduler.addEventHandler(handler, linkRef);
    return { tx, linkRef, received };
  }

  function trusted(event: Record<string, unknown>): Record<string, unknown> {
    markRendererTrustedEvent(event);
    return event;
  }

  it("delivers a small burst of user input in realtime, without dropping", async () => {
    const runtime = makeRuntime();
    try {
      const { tx, linkRef, received } = streamWithHandler(runtime, "w3/on");
      await tx.commit();
      // A handful of clicks is well within the burst budget, so every one is
      // delivered — none coalesced away.
      runtime.scheduler.queueEvent(linkRef, trusted({ n: 1 }));
      runtime.scheduler.queueEvent(linkRef, trusted({ n: 2 }));
      runtime.scheduler.queueEvent(linkRef, trusted({ n: 3 }));
      await runtime.idle();
      expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    } finally {
      await runtime.dispose();
    }
  });

  it("holds sustained input beyond the burst and releases it, without dropping", async () => {
    const runtime = makeRuntime();
    try {
      const { tx, linkRef, received } = streamWithHandler(runtime, "w3/burst");
      await tx.commit();
      // More than a full burst: the overflow is held and released one batch per
      // window (the sustained rate cap), but no click is lost.
      const total = BURST_CAPACITY + 3;
      const expected: Array<{ n: number }> = [];
      for (let n = 1; n <= total; n++) {
        runtime.scheduler.queueEvent(linkRef, trusted({ n }));
        expected.push({ n });
      }
      await runtime.idle();
      expect(received).toEqual(expected);
    } finally {
      await runtime.dispose();
    }
  });

  it("does not shape non-renderer (internal) events", async () => {
    const runtime = makeRuntime();
    try {
      const { tx, linkRef, received } = streamWithHandler(
        runtime,
        "w3/internal",
      );
      await tx.commit();
      // Not marked renderer-trusted -> delivered normally, not coalesced.
      runtime.scheduler.queueEvent(linkRef, { n: 1 });
      runtime.scheduler.queueEvent(linkRef, { n: 2 });
      runtime.scheduler.queueEvent(linkRef, { n: 3 });
      await runtime.idle();
      expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    } finally {
      await runtime.dispose();
    }
  });

  it("strips clock fields from a delivered input event", async () => {
    const runtime = makeRuntime();
    try {
      const { tx, linkRef, received } = streamWithHandler(runtime, "w3/strip");
      await tx.commit();
      runtime.scheduler.queueEvent(
        linkRef,
        trusted({
          type: "tap",
          timestamp: 123,
          detail: { timestamp: 9, v: 1 },
        }),
      );
      await runtime.idle();
      expect(received).toEqual([{ type: "tap", detail: { v: 1 } }]);
    } finally {
      await runtime.dispose();
    }
  });

  it("caps the per-stream in-queue backlog, collapsing the overflow", async () => {
    // W4: the in-queue backlog cap. Non-renderer events go straight to the
    // queue (the shaper only holds renderer input), so they exercise the cap.

    const runtime = makeRuntime();
    try {
      const { tx, linkRef, received } = streamWithHandler(runtime, "w4/cap");
      await tx.commit();
      const total = MAX_EVENT_BACKLOG_PER_STREAM + 3;
      for (let i = 1; i <= total; i++) {
        runtime.scheduler.queueEvent(linkRef, { n: i });
      }
      await runtime.idle();
      // The backlog is capped; the overflow collapsed into the last pending
      // entry (last-wins), so the final delivery carries the newest payload.
      expect(received.length).toBe(MAX_EVENT_BACKLOG_PER_STREAM);
      expect(received[received.length - 1]).toEqual({ n: total });
    } finally {
      await runtime.dispose();
    }
  });

  it("refuses a caller-id send at the backlog cap instead of collapsing it", async () => {
    // W4 exclusion: a caller-supplied durable id names an invocation whose
    // receipt address derives from it, so it must never be last-wins-merged.
    // At the cap it is refused loudly before dispatch — callback settled
    // errored, nothing executed — rather than silently folded into another
    // event's identity.

    const runtime = makeRuntime();
    try {
      const { tx, linkRef, received } = streamWithHandler(runtime, "w4/refuse");
      await tx.commit();
      for (let i = 1; i <= MAX_EVENT_BACKLOG_PER_STREAM; i++) {
        runtime.scheduler.queueEvent(linkRef, { n: i });
      }
      const outcomes: string[] = [];
      runtime.scheduler.queueEvent(
        linkRef,
        { marker: "caller-payload" },
        true,
        (t: IExtendedStorageTransaction) => {
          const status = t.status();
          if (status.status === "error") {
            // The drop settles the callback with an aborted transaction whose
            // error carries the refusal as its `reason`.
            const error = status.error as {
              message?: unknown;
              reason?: unknown;
            };
            const reason = error.reason as { message?: unknown } | undefined;
            outcomes.push(String(reason?.message ?? error.message));
          } else {
            outcomes.push(status.status);
          }
        },
        false,
        { eventId: "inv-refused" },
      );
      // The refusal settles the callback before dispatch, with the reason.
      expect(outcomes.length).toBe(1);
      expect(outcomes[0]).toContain("backlog");
      await runtime.idle();
      // Nothing of the refused send was delivered, and no queued payload was
      // rewritten by it: the cap-many minted events arrive as sent.
      expect(received.length).toBe(MAX_EVENT_BACKLOG_PER_STREAM);
      expect(received).not.toContainEqual({ marker: "caller-payload" });
      expect(received[received.length - 1]).toEqual({
        n: MAX_EVENT_BACKLOG_PER_STREAM,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("coalesces a same-id send at the cap onto its pending invocation", async () => {
    // Same pair, same stream: the same invocation. At the cap a retry rides the
    // already-pending entry — first payload wins, matching the create-only
    // receipt arbitration it would get after dispatch — and both senders settle
    // on the one outcome.

    const runtime = makeRuntime();
    try {
      const { tx, linkRef, received } = streamWithHandler(
        runtime,
        "w4/coalesce",
      );
      await tx.commit();
      for (let i = 1; i < MAX_EVENT_BACKLOG_PER_STREAM; i++) {
        runtime.scheduler.queueEvent(linkRef, { n: i });
      }
      let settledOriginal = 0;
      let settledRetry = 0;
      let settledSecondRetry = 0;
      runtime.scheduler.queueEvent(
        linkRef,
        { marker: "original" },
        true,
        () => settledOriginal++,
        false,
        { eventId: "inv-coalesced" },
      );
      runtime.scheduler.queueEvent(
        linkRef,
        { marker: "retry" },
        true,
        () => settledRetry++,
        false,
        { eventId: "inv-coalesced" },
      );
      runtime.scheduler.queueEvent(
        linkRef,
        { marker: "second-retry" },
        true,
        () => settledSecondRetry++,
        false,
        { eventId: "inv-coalesced" },
      );
      await runtime.idle();
      // One delivery carries the FIRST payload. Every retry callback settles
      // on that outcome, including a callback appended to the existing flat
      // callback chain.
      expect(received).toContainEqual({ marker: "original" });
      expect(received).not.toContainEqual({ marker: "retry" });
      expect(received).not.toContainEqual({ marker: "second-retry" });
      expect(received.length).toBe(MAX_EVENT_BACKLOG_PER_STREAM);
      expect(settledOriginal).toBe(1);
      expect(settledRetry).toBe(1);
      expect(settledSecondRetry).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("never rewrites a queued caller-id entry when a minted flood collapses", async () => {
    // The other direction of the exclusion: a minted flood collapsing at the
    // cap must never select a caller-id entry as its survivor, which would
    // rewrite the payload that entry's receipt is about to witness.

    const runtime = makeRuntime();
    try {
      const { tx, linkRef, received } = streamWithHandler(runtime, "w4/keep");
      await tx.commit();
      runtime.scheduler.queueEvent(
        linkRef,
        { marker: "keep" },
        true,
        undefined,
        false,
        { eventId: "inv-kept" },
      );
      const total = MAX_EVENT_BACKLOG_PER_STREAM + 3;
      for (let i = 1; i <= total; i++) {
        runtime.scheduler.queueEvent(linkRef, { n: i });
      }
      await runtime.idle();
      // The caller-id payload arrives exactly as sent, once; the overflow
      // collapsed into the newest MINTED entry instead.
      expect(
        received.filter((e) => (e as { marker?: string }).marker === "keep")
          .length,
      ).toBe(1);
      expect(received.length).toBe(MAX_EVENT_BACKLOG_PER_STREAM);
      expect(received[received.length - 1]).toEqual({ n: total });
    } finally {
      await runtime.dispose();
    }
  });

  it("collapse carries the newest event's time, not the first collapsed one", async () => {
    // The collapse is last-wins for the event TIME as well as the payload: a
    // dispatched handler must read the instant of the event it actually runs,
    // not the first event that happened to occupy the collapsed slot. These
    // events are origin-less (no originTx) with distinct instants — the case
    // where the times genuinely differ (a same-origin flood shares one frozen
    // instant).

    const runtime = makeRuntime();
    try {
      const tx = runtime.edit();
      const c = runtime.getCell(space, "w4/collapse-time", undefined, tx);
      const linkRef = c.asSchema(STREAM_SCHEMA).key("events")
        .getAsNormalizedFullLink();
      await tx.commit();
      const times: (number | undefined)[] = [];
      const handler: EventHandler = (t: IExtendedStorageTransaction) => {
        times.push(t.dispatchedEventTime);
      };
      runtime.scheduler.addEventHandler(handler, linkRef);

      const BASE = 1_700_000_000_000;
      const total = MAX_EVENT_BACKLOG_PER_STREAM + 3;
      for (let i = 1; i <= total; i++) {
        runtime.scheduler.queueEvent(
          linkRef,
          { n: i },
          true,
          undefined,
          false,
          { time: BASE + i * 1000 },
        );
      }
      await runtime.idle();
      expect(times.length).toBe(MAX_EVENT_BACKLOG_PER_STREAM);
      // The surviving collapsed delivery reports the NEWEST event's instant.
      expect(times[times.length - 1]).toBe(BASE + total * 1000);
    } finally {
      await runtime.dispose();
    }
  });
});
