import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import {
  FabricBytes,
  FabricKeyPair,
} from "@commonfabric/data-model/fabric-primitives";
import type { DID } from "@commonfabric/identity";
import { toValuePath } from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";

import { $conn, CellHandle, type RuntimeClient } from "@/mod.ts";
import { RuntimeConnection } from "@/client/connection.ts";
import { EventEmitter } from "@/client/emitter.ts";
import {
  type InitializationData,
  type IPCClientMessage,
  type IPCClientNotification,
  NotificationType,
  type OperationUpdateNotification,
  RequestType,
  RuntimeErrorCode,
  type RuntimeSecurityContext,
} from "@/protocol/mod.ts";
import type {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "@/client/transport.ts";

/**
 * Transport that records everything sent and auto-acknowledges every request
 * except the types in `holdTypes`, which are left pending (simulating
 * in-flight work).
 */
class FakeTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  readonly sent: Array<IPCClientMessage | IPCClientNotification> = [];
  disposeCalls = 0;

  #holdTypes: RequestType[];

  constructor(holdTypes: RequestType[] = []) {
    super();
    this.#holdTypes = holdTypes;
  }

  send(original: IPCClientMessage | IPCClientNotification): void {
    // Encoded, cloned and decoded, which is what the real transport does and
    // what a bare `structuredClone` would misreport: the clone alone strips a
    // `FabricBytes` to a plain object, so a double using it would model a
    // transport that loses exactly what this connection carries. The round
    // trip also gives the capture its own copy, so what is captured cannot
    // change under later mutation by the sender.
    const message = fabricFromRealmValue(
      structuredClone(realmFromFabricValue(original)),
    ) as IPCClientMessage | IPCClientNotification;
    this.sent.push(message);
    // Notifications carry no msgId and get no reply.
    if (!("msgId" in message)) return;
    if (this.#holdTypes.includes(message.data.type)) return;
    // Acknowledge asynchronously, like a real worker round-trip.
    queueMicrotask(() => {
      this.emit("message", { msgId: message.msgId, data: undefined });
    });
  }

  dispose(): Promise<void> {
    this.disposeCalls++;
    return Promise.resolve();
  }
}

async function initializedConnection(
  transport: FakeTransport,
): Promise<RuntimeConnection> {
  const connection = new RuntimeConnection(transport);
  await connection.initialize({} as InitializationData);
  return connection;
}

/**
 * Transport whose `send()` throws, as the real one does two ways: the
 * envelope's encode refuses a value that has no encoding, and `postMessage()`
 * refuses one structured cloning cannot carry.
 */
class ThrowingTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  readonly #failOn: RequestType;

  constructor(failOn: RequestType) {
    super();
    this.#failOn = failOn;
  }

  send(message: IPCClientMessage | IPCClientNotification): void {
    if (!("msgId" in message)) return;
    if (message.data.type === this.#failOn) {
      throw new Error("no encoding for value");
    }
    // Everything else is acknowledged, so the connection can initialize.
    queueMicrotask(() => {
      this.emit("message", { msgId: message.msgId, data: undefined });
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("connection", () => {
  it("separates subscriptions and cached values by acquisition token", async () => {
    const transport = new FakeTransport();
    const connection = await initializedConnection(transport);
    const runtime = { [$conn]: () => connection } as unknown as RuntimeClient;
    const address = {
      space: "did:key:test" as const,
      id: "of:acquired" as const,
      scope: "space" as const,
      path: [],
    };
    const first = new CellHandle<string>(runtime, {
      ...address,
      cfcReferenceToken: "first",
    });
    const second = new CellHandle<string>(runtime, {
      ...address,
      cfcReferenceToken: "second",
    });
    try {
      await connection.subscribe(first);
      transport.emit("message", {
        type: NotificationType.CellUpdate,
        cell: first.ref(),
        value: "first value",
      });
      await connection.subscribe(second);
      expect(first.get()).toBe("first value");
      expect(second.get()).toBeUndefined();
      expect(
        transport.sent.filter((message) =>
          "data" in message && message.data.type === RequestType.CellSubscribe
        ),
      ).toHaveLength(2);
      transport.emit("message", {
        type: NotificationType.CellUpdate,
        cell: second.ref(),
        value: "second value",
      });
      expect(first.get()).toBe("first value");
      expect(second.get()).toBe("second value");
      await connection.unsubscribe(first);
      transport.emit("message", {
        type: NotificationType.CellUpdate,
        cell: second.ref(),
        value: "still subscribed",
      });
      expect(second.get()).toBe("still subscribed");
      await connection.unsubscribe(second);
    } finally {
      await connection.dispose();
    }
  });

  it("records an abandoned request exactly once even if its reply arrives late", async () => {
    // Disposal ends the wait; the worker knows nothing of that and answers
    // later. The late reply finds no pending entry, and must not record a
    // second terminal wait for the same request.
    const transport = new FakeTransport([RequestType.Idle]);
    const connection = await initializedConnection(transport);
    const logger = getLogger("runtime-client");
    logger.resetTimeStats();
    const request = connection.request({ type: RequestType.Idle });
    const rejection = expect(request).rejects.toThrow();
    await connection.dispose();
    await rejection;

    expect(connection.getPendingRequestDiagnostics()).toEqual([]);
    const idleEntry = () =>
      connection.getRequestTimelineDiagnostics().find((entry) =>
        entry.type === RequestType.Idle
      );
    expect(idleEntry()).toMatchObject({
      type: RequestType.Idle,
      error: true,
      outcome: "cancelled",
    });
    expect(logger.getTimeStats("ipc", RequestType.Idle)).toMatchObject({
      count: 1,
    });
    expect(logger.getTimeStats("ipc-outcome", "cancelled", RequestType.Idle))
      .toMatchObject({ count: 1 });

    using _warning = stub(console, "warn");
    const sent = transport.sent.find((message) =>
      "msgId" in message && message.data.type === RequestType.Idle
    ) as IPCClientMessage;
    transport.emit("message", { msgId: sent.msgId });
    expect(logger.getTimeStats("ipc", RequestType.Idle)?.count).toBe(1);
    expect(idleEntry()).toMatchObject({ outcome: "cancelled" });
  });

  it("keeps outcome statistics after the boot timeline fills", async () => {
    // The timeline is capped at the boot window, so a later request records no
    // entry in it. The outcome statistics are uncapped and must still count it.
    const transport = new FakeTransport([RequestType.Idle]);
    const connection = await initializedConnection(transport);
    for (let index = 0; index < 100; index++) {
      await connection.request({ type: RequestType.GetLoggerCounts });
    }
    const timeline = connection.getRequestTimelineDiagnostics();
    const logger = getLogger("runtime-client");
    logger.resetTimeStats();
    const request = connection.request({ type: RequestType.Idle });
    const rejection = expect(request).rejects.toThrow();
    await connection.dispose();
    await rejection;
    expect(connection.getRequestTimelineDiagnostics()).toEqual(timeline);
    expect(
      logger.getTimeStats("ipc-outcome", "cancelled", RequestType.Idle)?.count,
    )
      .toBe(1);
  });

  it("records cancellation as a terminal outcome", async () => {
    const transport = new FakeTransport([RequestType.Idle]);
    const connection = await initializedConnection(transport);
    const request = connection.request({ type: RequestType.Idle });
    const rejection = expect(request).rejects.toThrow();
    await connection.dispose();
    await rejection;
    expect(
      connection.getRequestTimelineDiagnostics().find((entry) =>
        entry.type === RequestType.Idle
      ),
    ).toMatchObject({
      doneAtMs: expect.any(Number),
      outcome: "cancelled",
      error: true,
    });
  });

  it("routes terminal event-attention notifications", async () => {
    const transport = new FakeTransport();
    const connection = await initializedConnection(transport);
    const messages: unknown[] = [];
    connection.on("eventneedsattention", (message) => messages.push(message));
    const notification = {
      type: NotificationType.EventNeedsAttention,
      space: "did:key:z6Mk-connection-attention",
      eventId: "evt-attention",
      seq: 17,
      sidecarId: "of:stream-events:connection-attention",
      reason: "delivery needs attention",
      attention: {
        phase: "dispatch-load",
        failureClass: "session-revoked",
        code: "permanent-delivery-failure",
        firstFailureAt: 10,
        lastFailureAt: 10,
        accumulatedFailureMs: 0,
        failureCount: 1,
        recovery: "explicit-retry",
      },
    } as const;

    transport.emit("message", notification);

    expect(messages).toEqual([notification]);
    await connection.dispose();
  });

  it("routes collaborative operation notifications", async () => {
    const transport = new FakeTransport();
    const connection = await initializedConnection(transport);
    const messages: unknown[] = [];
    connection.on("operationupdate", (message) => messages.push(message));

    const notification: OperationUpdateNotification = {
      type: NotificationType.OperationUpdate,
      subscriptionId: "subscription:1",
      field: {
        branch: "",
        id: "of:connection",
        scopeKey: "space",
        path: toValuePath([]),
        active: false,
        codec: null,
        cursor: null,
        baselineHash: "baseline",
        materialized: "value",
        operations: [],
      },
    };
    transport.emit("message", notification);

    expect(messages).toEqual([notification]);
    await connection.dispose();
  });

  describe("RuntimeConnection disposal", () => {
    it("settles in-flight requests as cancellation on dispose", async () => {
      const transport = new FakeTransport([RequestType.Idle]);
      const connection = await initializedConnection(transport);

      const inFlight = connection.request<RequestType.Idle>({
        type: RequestType.Idle,
      });
      // Avoid an unhandled rejection between dispose() and the assertion.
      const settled = inFlight.then(() => undefined, (error) => error);

      await connection.dispose();

      const error = await settled;
      expect(connection.signal.aborted).toBe(true);
      // Cancelled with the standard abort reason, not a bespoke error.
      expect(error).toBe(connection.signal.reason);
      expect((error as { name?: string })?.name).toBe("AbortError");
    });

    it("runs registered teardown synchronously, before transport teardown", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);

      const order: string[] = [];
      connection.onDispose(() => order.push("teardown"));
      const realDispose = transport.dispose.bind(transport);
      transport.dispose = () => {
        order.push("transport");
        return realDispose();
      };

      await connection.dispose();

      expect(order).toEqual(["teardown", "transport"]);
    });

    it("does not send requests issued after dispose", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      await connection.dispose();

      const sentBefore = transport.sent.length;
      const error = await connection
        .request<RequestType.Idle>({ type: RequestType.Idle })
        .then(() => undefined, (e) => e);

      expect(connection.signal.aborted).toBe(true);
      expect(error).toBe(connection.signal.reason);
      // The request never reached the transport.
      expect(transport.sent.length).toBe(sentBefore);
    });

    it("runs teardown immediately when registered after dispose", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      await connection.dispose();

      let ran = false;
      connection.onDispose(() => {
        ran = true;
      });
      expect(ran).toBe(true);
    });

    it("is idempotent", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);

      await connection.dispose();
      await connection.dispose();

      expect(transport.disposeCalls).toBe(1);
    });

    it("waits for the worker to confirm dispose before tearing down", async () => {
      // Hold the Dispose reply: the worker has not yet confirmed its flush.
      const transport = new FakeTransport([RequestType.Dispose]);
      const connection = await initializedConnection(transport);

      let done = false;
      const disposing = connection.dispose().then(() => {
        done = true;
      });

      // Dispose stays pending until the worker confirms its flush. Draining the
      // task queue (all microtasks, then one macrotask) runs every continuation a
      // completed dispose would take; the held Dispose reply never arrives, so a
      // correct dispose is still pending and the transport is untouched.
      // `dispose()` has already aborted the lifetime by this point, and the
      // Dispose request carries no abort listener, so what is observed here is
      // a request only its reply can settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(done).toBe(false);
      expect(transport.disposeCalls).toBe(0);

      // The worker finishes flushing and replies; teardown then completes.
      const disposeMsg = transport.sent.find(
        (m): m is IPCClientMessage =>
          "msgId" in m && m.data.type === RequestType.Dispose,
      );
      transport.emit("message", { msgId: disposeMsg!.msgId });

      await disposing;
      expect(done).toBe(true);
      expect(transport.disposeCalls).toBe(1);
    });

    it("ignores incoming messages without warning once dead", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      await connection.dispose();

      const warnings: unknown[][] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args);
      try {
        // A late response for an unknown request, a malformed message, and a
        // stray notification — all ignored silently in the dead state.
        transport.emit("message", { msgId: 9999 });
        transport.emit("message", "garbage" as never);
        transport.emit(
          "message",
          { type: "cell:update", cell: {}, value: 1 } as never,
        );
      } finally {
        console.warn = original;
      }

      expect(warnings.length).toBe(0);
    });

    it("leaves nothing pending when the send itself throws", async () => {
      // The throw reaches the caller, and the promise `request()` would have
      // returned is never returned at all -- so the abort hook and pending
      // entry registered before the send must not be left holding it. Were
      // they, disposal would reject a promise nobody holds, which is an
      // unhandled rejection rather than a caught one.
      const connection = new RuntimeConnection(
        new ThrowingTransport(RequestType.CellSet),
      );
      await connection.initialize({} as InitializationData);

      expect(() =>
        connection.request({
          type: RequestType.CellSet,
          cell: { id: "of:c", space: "did:key:t", scope: "space", path: [] },
          value: 1,
        } as never)
      ).toThrow("no encoding for value");

      expect(connection.getPendingRequestDiagnostics()).toHaveLength(0);

      // And the timeline says so too: a missing `doneAtMs` reads as still in
      // flight, which is the one thing this request is not.
      const entry = connection.getRequestTimelineDiagnostics().find((e) =>
        e.type === RequestType.CellSet
      );
      expect(entry?.doneAtMs).toEqual(expect.any(Number));
      expect(entry?.error).toBe(true);
      expect(entry?.outcome).toBe("send-error");

      // Would reject the orphan, if the bookkeeping still held one.
      await connection.dispose();
    });

    it("throws when a notification is sent after disposal", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      const session = connection.attachVDom(() => {});
      await connection.dispose();

      const sentBefore = transport.sent.length;
      // Notifications come only from owned consumers torn down before disposal,
      // so a post-disposal send is a contract violation, not a benign race.
      expect(() => session.sendEvent(1, 2, { type: "click" } as never, 3))
        .toThrow();
      expect(() => session.ackBatch(1, 7)).toThrow();
      // Nothing reached the transport.
      expect(transport.sent.length).toBe(sentBefore);
    });
  });

  describe("RuntimeConnection.attachVDom", () => {
    it("runs the consumer teardown on disposal", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      let torn = false;
      connection.attachVDom(() => {
        torn = true;
      });
      await connection.dispose();
      expect(torn).toBe(true);
    });

    it("does not run the teardown after `detach()`", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      let torn = false;
      const session = connection.attachVDom(() => {
        torn = true;
      });
      session.detach();
      await connection.dispose();
      expect(torn).toBe(false);
    });

    it("sends events and acks through the session while alive", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      const session = connection.attachVDom(() => {});
      session.sendEvent(1, 2, { type: "click" } as never, 3);
      session.ackBatch(1, 9);
      const notifications = transport.sent.filter((m) => !("msgId" in m));
      expect(notifications.length).toBe(2);
      session.detach();
    });

    it("cancels a mount whose response fails before forgetting its id", async () => {
      const transport = new FakeTransport([RequestType.VDomMount]);
      const connection = await initializedConnection(transport);
      const session = connection.attachVDom(() => {});
      try {
        const mounting = session.mount(37, {
          id: "of:mount-failure",
          space: "did:key:test",
          scope: "space",
          path: [],
        });
        const rejected = expect(mounting).rejects.toThrow("mount refused");
        const held = transport.sent.find((message) =>
          "msgId" in message && message.data.type === RequestType.VDomMount
        ) as IPCClientMessage;
        transport.emit("message", {
          msgId: held.msgId,
          error: "mount refused",
        });
        await rejected;
        const requests = transport.sent.filter(
          (message): message is IPCClientMessage => "msgId" in message,
        );
        const cancellations = requests.filter((message) =>
          message.data.type === RequestType.VDomUnmount
        );
        expect(cancellations).toHaveLength(1);
        expect(cancellations[0].data).toMatchObject({ mountId: 37 });
        expect(connection.getPendingRequestDiagnostics()).toEqual([]);

        const mounted = requests.find((message) =>
          message.data.type === RequestType.VDomMount
        )!;
        using _warning = stub(console, "warn");
        transport.emit("message", {
          msgId: mounted.msgId,
          data: { rootId: 5 },
        });
        expect(connection.getPendingRequestDiagnostics()).toEqual([]);
        expect(
          transport.sent.filter((message) =>
            "msgId" in message && message.data.type === RequestType.VDomUnmount
          ),
        ).toHaveLength(1);
      } finally {
        session.detach();
        await connection.dispose();
      }
    });

    it("mounts, unmounts, and routes batch notifications via the session", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      const session = connection.attachVDom(() => {});

      const cellRef = {
        id: "of:mount-cell",
        space: "did:key:test",
        scope: "space",
        path: [],
      };
      // mount/unmount are awaited round-trips, auto-acked by the transport.
      await session.mount(1, cellRef as never);
      await session.unmount(1);
      const sentTypes = transport.sent
        .filter((m): m is IPCClientMessage => "msgId" in m)
        .map((m) => m.data.type);
      expect(sentTypes).toContain(RequestType.VDomMount);
      expect(sentTypes).toContain(RequestType.VDomUnmount);

      // onBatch/offBatch wire and unwire the vdombatch subscription.
      const batches: number[] = [];
      const handler = (n: { batchId: number }) => batches.push(n.batchId);
      session.onBatch(handler as never);
      transport.emit(
        "message",
        { type: "vdom:batch", batchId: 7, ops: [] } as never,
      );
      expect(batches).toEqual([7]);
      session.offBatch(handler as never);
      transport.emit(
        "message",
        { type: "vdom:batch", batchId: 8, ops: [] } as never,
      );
      expect(batches).toEqual([7]);

      session.detach();
    });

    it("skips the unmount round-trip once disposed", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      const session = connection.attachVDom(() => {});
      await connection.dispose();

      const sentBefore = transport.sent.length;
      // The worker tears down every mount wholesale on dispose, so a per-mount
      // unmount is redundant and is skipped.
      await session.unmount(1);
      expect(transport.sent.length).toBe(sentBefore);
    });
  });

  describe("RuntimeConnection request timeline", () => {
    it("records send and settle offsets for boot-window requests", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      await connection.request<RequestType.Idle>({ type: RequestType.Idle });

      const timeline = connection.getRequestTimelineDiagnostics();
      expect(timeline.map((entry) => entry.type)).toEqual([
        RequestType.Initialize,
        RequestType.Idle,
      ]);
      for (const entry of timeline) {
        expect(typeof entry.msgId).toBe("number");
        expect(typeof entry.sentAtMs).toBe("number");
        // Both requests settled, so both are stamped done — at or after send.
        expect(typeof entry.doneAtMs).toBe("number");
        expect(entry.doneAtMs!).toBeGreaterThanOrEqual(entry.sentAtMs);
        expect(entry.error).toBeUndefined();
      }
      await connection.dispose();
    });

    it("leaves doneAtMs unset while in flight and flags error replies", async () => {
      const transport = new FakeTransport([RequestType.Idle]);
      const connection = await initializedConnection(transport);
      const inFlight = connection.request<RequestType.Idle>({
        type: RequestType.Idle,
      });
      const settled = inFlight.then(() => undefined, (error) => error);

      const pendingEntry = connection.getRequestTimelineDiagnostics()
        .find((entry) => entry.type === RequestType.Idle);
      expect(pendingEntry).toBeDefined();
      expect(pendingEntry!.doneAtMs).toBeUndefined();
      expect(pendingEntry!.error).toBeUndefined();

      // The worker answers with an error; the entry is stamped done + error.
      const sent = transport.sent.find(
        (m): m is IPCClientMessage =>
          "msgId" in m && m.data.type === RequestType.Idle,
      );
      transport.emit("message", { msgId: sent!.msgId, error: "boom" });
      const error = await settled;
      expect((error as Error).message).toBe("boom");

      const doneEntry = connection.getRequestTimelineDiagnostics()
        .find((entry) => entry.type === RequestType.Idle);
      expect(doneEntry!.error).toBe(true);
      expect(typeof doneEntry!.doneAtMs).toBe("number");
      await connection.dispose();
    });

    it("surfaces coded request failures as lifecycle error events", async () => {
      const transport = new FakeTransport([RequestType.Idle]);
      const connection = await initializedConnection(transport);
      const errors: unknown[] = [];
      connection.on("error", (error) => errors.push(error));

      const request = connection.request<RequestType.Idle>({
        type: RequestType.Idle,
      });
      const settled = request.then(() => undefined, (error) => error);
      const sent = transport.sent.find(
        (message): message is IPCClientMessage =>
          "msgId" in message && message.data.type === RequestType.Idle,
      );
      transport.emit("message", {
        msgId: sent!.msgId,
        error: "Failed to load the compiler stack",
        code: RuntimeErrorCode.CompilerStackLoadFailed,
      });

      const error = await settled as Error & { code?: RuntimeErrorCode };
      expect(error.code).toBe(RuntimeErrorCode.CompilerStackLoadFailed);
      expect(errors).toEqual([{
        type: NotificationType.ErrorReport,
        message: "Failed to load the compiler stack",
        code: RuntimeErrorCode.CompilerStackLoadFailed,
      }]);
      await connection.dispose();
    });

    it("rejects a request that finds no space with its code, and emits no lifecycle error", async () => {
      const transport = new FakeTransport([RequestType.Idle]);
      const connection = await initializedConnection(transport);
      const errors: unknown[] = [];
      connection.on("error", (error) => errors.push(error));

      const request = connection.request<RequestType.Idle>({
        type: RequestType.Idle,
      });
      const settled = request.then(() => undefined, (error) => error);
      const sent = transport.sent.find(
        (message): message is IPCClientMessage =>
          "msgId" in message && message.data.type === RequestType.Idle,
      );
      transport.emit("message", {
        msgId: sent!.msgId,
        error: "No space answers to did:key:z6MkMissing",
        code: RuntimeErrorCode.SpaceNotFound,
      });

      const error = await settled as Error & { code?: RuntimeErrorCode };
      expect(error.code).toBe(RuntimeErrorCode.SpaceNotFound);
      expect(errors).toEqual([]);
      await connection.dispose();
    });

    it("returns a copy that does not expose the internal ledger", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);

      const first = connection.getRequestTimelineDiagnostics();
      expect(first.length).toBe(1);
      // Mutate the returned array and its entries every way a caller could.
      first[0].type = "mutated" as RequestType;
      first[0].doneAtMs = -1;
      first.push({ msgId: 999, type: RequestType.Idle, sentAtMs: 0 });

      const second = connection.getRequestTimelineDiagnostics();
      expect(second.length).toBe(1);
      expect(second[0].type).toBe(RequestType.Initialize);
      expect(second[0].doneAtMs).not.toBe(-1);
      await connection.dispose();
    });
  });

  describe("RuntimeConnection pending-request diagnostics", () => {
    it("snapshots in-flight requests with their ages, oldest first", async () => {
      const transport = new FakeTransport([RequestType.Idle]);
      const connection = await initializedConnection(transport);

      // Give the two in-flight requests a deterministic age gap without sleeping:
      // freeze performance.now() and step it forward between the sends, so the
      // first request is measurably older. This is what exercises the
      // descending-age sort — with equal ages a stable sort preserves insertion
      // order whichever way the comparator runs, leaving the direction untested.
      const realNow = performance.now;
      let fakeNow = realNow.call(performance);
      Reflect.set(performance, "now", () => fakeNow);
      try {
        const first = connection.request<RequestType.Idle>({
          type: RequestType.Idle,
        });
        const firstSettled = first.then(() => undefined, (error) => error);
        fakeNow += 5;
        const second = connection.request<RequestType.Idle>({
          type: RequestType.Idle,
        });
        const secondSettled = second.then(() => undefined, (error) => error);

        const pending = connection.getPendingRequestDiagnostics();
        expect(pending.length).toBe(2);
        for (const entry of pending) {
          expect(entry.type).toBe(RequestType.Idle);
          expect(typeof entry.msgId).toBe("number");
          expect(entry.ageMs).toBeGreaterThanOrEqual(0);
        }
        // Sorted oldest (largest age) first — the request a stalled caller has
        // been waiting on longest names the wedged layer.
        expect(pending[0].ageMs).toBeGreaterThan(pending[1].ageMs);
        expect(pending[0].msgId).toBeLessThan(pending[1].msgId);

        await connection.dispose();
        await firstSettled;
        await secondSettled;
        // Disposal settled both as cancellation; nothing is pending anymore.
        expect(connection.getPendingRequestDiagnostics()).toEqual([]);
      } finally {
        Reflect.set(performance, "now", realNow);
      }
    });
  });

  describe("RuntimeConnection request lifetime", () => {
    it("leaves a request the worker has not answered pending however long it waits", async () => {
      // A request settles on its reply or on disposal, and on nothing else.
      // The wait is what a `FakeTime` makes assertable: advancing an hour of
      // fake time runs every timer a bound would have been armed on, so a
      // request still pending afterwards is one no clock is going to reject.
      // Real time does not move, so the case costs nothing to run.
      //
      // The connection is built before the clock is faked. Its loop-lag probe
      // arms an interval through `unrefTimer`, which hands the id to
      // `Deno.unrefTimer`, and a faked id names an unrelated real timer.
      // Building first also keeps that interval off the fake clock, where an
      // hour of ticks would run it thirty-six thousand times.
      const transport = new FakeTransport([RequestType.Idle]);
      const connection = await initializedConnection(transport);
      using time = new FakeTime();

      const inFlight = connection.request<RequestType.Idle>({
        type: RequestType.Idle,
      });
      let outcome: "pending" | "settled" = "pending";
      const settled = inFlight.then(
        () => (outcome = "settled"),
        (error) => {
          outcome = "settled";
          return error;
        },
      );

      await time.tickAsync(60 * 60 * 1000);

      expect(outcome).toBe("pending");
      expect(connection.getPendingRequestDiagnostics()).toHaveLength(1);

      // Disposal is what settles it, so the case leaves nothing unhandled.
      const disposing = connection.dispose();
      await time.tickAsync(0);
      await disposing;
      await settled;
      expect(outcome).toBe("settled");
      expect(connection.getPendingRequestDiagnostics()).toEqual([]);
    });
  });

  describe("RuntimeConnection loop-lag probe", () => {
    it("samples main-thread lag while alive and clears its timer on dispose", async () => {
      const logger = getLogger("runtime-client");
      const lagCountBefore = logger.getTimeStats("loop", "mainLag")?.count ?? 0;

      // Spy on clearInterval: the loop-lag interval is the only interval the
      // connection owns, so dispose must clear exactly one.
      const originalClearInterval = globalThis.clearInterval;
      const cleared: unknown[] = [];
      globalThis.clearInterval = ((id?: number) => {
        cleared.push(id);
        return originalClearInterval(id);
      }) as typeof clearInterval;

      try {
        const transport = new FakeTransport();
        const connection = await initializedConnection(transport);

        // Block the thread past the first 100ms sample: the tick due during the
        // block can only fire late, so the probe records a positive mainLag.
        // (Structure/counter assertion only — the magnitude is not asserted.)
        const end = performance.now() + 110;
        while (performance.now() < end) {
          // busy
        }
        await new Promise((resolve) => setTimeout(resolve, 5));

        const lagCountAfter = logger.getTimeStats("loop", "mainLag")?.count ??
          0;
        expect(lagCountAfter).toBeGreaterThan(lagCountBefore);

        expect(cleared.length).toBe(0);
        await connection.dispose();
        expect(cleared.length).toBe(1);
      } finally {
        globalThis.clearInterval = originalClearInterval;
      }
    });
  });

  describe("FakeTransport", () => {
    it("delivers a message unshared with the sender", () => {
      // `RuntimeTransport.send()` requires the far end to receive a value it
      // owns, which is what lets a handler cede a byte payload rather than copy
      // it. A double that passed the sender's object through would model
      // something no real transport does.
      const transport = new FakeTransport();
      const body = new FabricBytes(new Uint8Array([1, 2, 3]));
      // A plain nested container alongside it: the codec rebuilds a
      // `FabricBytes` either way, so that arm alone cannot tell whether the
      // clone is there. An encode passes a subtree needing no encoding through
      // by identity, and a decode hands that same object back -- so without the
      // clone this is the sender's own object, frozen under it.
      const nested = { note: "unshared" };
      const message: IPCClientMessage = {
        msgId: 1,
        data: {
          type: RequestType.UploadBlob,
          space: "did:key:test-space",
          contentType: "image/png",
          body,
          nested,
        } as never,
      };

      transport.send(message);

      const captured = transport.sent[0];
      expect(
        (captured as unknown as { data: { nested: unknown } }).data.nested,
      ).not.toBe(nested);
      expect(Object.isFrozen(nested)).toBe(false);
      expect(captured).not.toBe(message);
      if (
        !("msgId" in captured) || captured.data.type !== RequestType.UploadBlob
      ) {
        throw new Error("Expected the upload request to have been captured.");
      }
      expect(captured.data.body).not.toBe(body);
      // The bytes arrive as a `FabricBytes` and not as the plain object a bare
      // structured clone would leave, which is the whole point of encoding the
      // envelope. Read both rather than compare identity alone: a shallow copy
      // differs by identity while still sharing the buffer beneath, and the
      // sender's still reading after the captured one did is what says the two
      // do not share one.
      expect(captured.data.body).toBeInstanceOf(FabricBytes);
      expect(captured.data.body.slice()).toEqual(new Uint8Array([1, 2, 3]));
      expect(body.slice()).toEqual(new Uint8Array([1, 2, 3]));
    });
  });
});

describe("RuntimeConnection.attach()", () => {
  // The choke point: the last thing before a frame reaches a transport. A
  // caller holding a `RuntimeConnection` directly does not pass through
  // `RuntimeClient.attach`, so the guarantee that no key material crosses a
  // port has to live here rather than only there.

  const context: RuntimeSecurityContext = {
    identity: "did:key:z6Mk-connection-attach" as DID,
    apiUrl: "http://connection.test/",
    spaceDid: "did:key:z6Mk-connection-attach" as DID,
  };

  it("sends the asserted context and marks the connection usable", async () => {
    const transport = new FakeTransport();
    const conn = new RuntimeConnection(transport);
    await conn.attach(context);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      data: { type: RequestType.Attach, data: context },
    });
  });

  it("refuses a context holding key material, sending nothing", async () => {
    const transport = new FakeTransport();
    const conn = new RuntimeConnection(transport);
    const keyPair = new FabricKeyPair(
      "Ed25519",
      new Uint8Array(32),
      new Uint8Array(32),
    );
    await expect(conn.attach({
      ...context,
      trustSnapshot: {
        id: "principal",
        signer: keyPair,
      } as unknown as RuntimeSecurityContext["trustSnapshot"],
    })).rejects.toThrow("no key material");
    expect(transport.sent).toEqual([]);
  });
});
