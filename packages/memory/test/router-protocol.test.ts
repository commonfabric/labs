import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { ROUTED_QUEUE_LIMIT, ROUTED_RAW_LIMIT } from "../v2/routed-parser.ts";
import {
  decodeRouterHeader,
  decodeRouterRecord,
  decodeRouterRequestCredit,
  encodeRouterHeader,
  encodeRouterRequestCredit,
  isRouterControl,
  isRouterRequestCredit,
  ROUTER_CHUNK_BYTES,
  ROUTER_CHUNK_COUNT,
  ROUTER_HELLO_FRAME_SLOTS_POLICY,
  ROUTER_MAX_REQUEST_ORDINAL,
  ROUTER_REQUEST_WINDOW,
  ROUTER_SEND_WINDOW_BYTES,
  ROUTER_UPLOAD_WINDOW,
  RouterAssembler,
  routerRecord,
  routerRecords,
  RouterSender,
} from "../v2/router-protocol.ts";

describe("router-protocol", () => {
  const route = { type: "response", requestId: "r" };

  /** A sender whose socket records every write and holds its callbacks. */
  function heldSender(limit: number | null, now?: () => number) {
    const writes: Uint8Array[] = [];
    const callbacks: ((error?: Error | null) => void)[] = [];
    const errors: Error[] = [];
    let acknowledged = 0;
    const sender = new RouterSender(
      (record, done) => {
        writes.push(record);
        callbacks.push(done);
      },
      (error) => errors.push(error),
      limit,
      now === undefined ? {} : { now },
    );
    return {
      sender,
      writes,
      callbacks,
      errors,
      /** Runs the oldest held callback successfully. */
      ack: () => {
        callbacks.shift()!();
        acknowledged++;
      },
      /** Bytes passed to the socket whose callbacks have not run. */
      inFlight: () =>
        writes.slice(acknowledged).reduce(
          (total, record) => total + record.length,
          0,
        ),
      get acknowledged() {
        return acknowledged;
      },
    };
  }

  describe("isRouterControl()", () => {
    it("identifies authentication, negotiation, and watch-admission controls", () => {
      for (
        const type of [
          "hello",
          "connection.auth",
          "connection.challenge",
          "connection.renew",
          "connection.release",
          "memory.compression",
          "session.open",
          "session.watch.set",
          "session.watch.add",
          "session.watch.remove",
        ]
      ) expect(isRouterControl(type)).toBe(true);
    });

    it("leaves transaction, query, and session payloads for opaque forwarding", () => {
      for (
        const type of [
          "transact",
          "graph.query",
          "session.ack",
          "session.close",
          "session.report",
          "presence.join",
          "session/effect",
          "response",
        ]
      ) expect(isRouterControl(type)).toBe(false);
    });

    it("returns false for non-string discriminants and control-name lookalikes", () => {
      for (
        const type of [
          undefined,
          null,
          false,
          1,
          ["hello"],
          { type: "hello" },
          "",
          "connection",
          "connection/auth",
          "hello.ok",
          "session.watch.addition",
        ]
      ) expect(isRouterControl(type)).toBe(false);
    });
  });

  it("exports the cross-repo constants as one-line literals the infra preflight can read", async () => {
    // The infra router's preflight reads these by name from the source text,
    // so each must stay `export const NAME = <literal>;` on one line.
    const source = await Deno.readTextFile(
      new URL("../v2/router-protocol.ts", import.meta.url),
    );
    for (
      const [name, value, literal] of [
        ["ROUTER_UPLOAD_WINDOW", ROUTER_UPLOAD_WINDOW, "262_144"],
        [
          "ROUTER_MAX_REQUEST_ORDINAL",
          ROUTER_MAX_REQUEST_ORDINAL,
          "Number.MAX_SAFE_INTEGER",
        ],
        [
          "ROUTER_HELLO_FRAME_SLOTS_POLICY",
          ROUTER_HELLO_FRAME_SLOTS_POLICY,
          "1",
        ],
      ] as const
    ) {
      expect(source).toContain(`\nexport const ${name} = ${literal};\n`);
      expect(value).toBe(
        name === "ROUTER_MAX_REQUEST_ORDINAL"
          ? Number.MAX_SAFE_INTEGER
          : Number(literal.replaceAll("_", "")),
      );
    }
  });

  it("preserves a leading BOM and reserves its exact wire length", () => {
    const reserved: number[] = [];
    const receiver = new RouterAssembler((bytes) => reserved.push(bytes));
    const body = "\uFEFFbody";
    let complete;
    for (const record of routerRecords(route, body)) {
      complete = receiver.receive(record);
    }
    expect(complete?.payload).toBe(body);
    expect(complete?.header.bytes).toBe(7);
    expect(reserved).toEqual([7]);
  });

  it("encodes request credit in the exact private record layout and bounds it by the window", () => {
    // The infra router's `tests/protocol.rs` decodes the same vector.
    expect([...encodeRouterRequestCredit(0x010203)])
      .toEqual([109, 114, 105, 2, 0, 1, 2, 3]);
    // The window is the host's whole input budget.
    expect(ROUTER_REQUEST_WINDOW).toBe(ROUTED_QUEUE_LIMIT);
    for (const bytes of [1, ROUTER_REQUEST_WINDOW]) {
      expect(decodeRouterRequestCredit(encodeRouterRequestCredit(bytes)))
        .toBe(bytes);
    }
    for (const bytes of [0, -1, 1.5, ROUTER_REQUEST_WINDOW + 1]) {
      expect(() => encodeRouterRequestCredit(bytes)).toThrow();
    }
    const valid = encodeRouterRequestCredit(1);
    expect(() => decodeRouterRequestCredit(valid.subarray(1))).toThrow();
    expect(() => decodeRouterRequestCredit(new Uint8Array([...valid, 0])))
      .toThrow();
    const version = valid.slice();
    version[3] = 1;
    expect(isRouterRequestCredit(version)).toBe(false);
    expect(() => decodeRouterRequestCredit(version)).toThrow();
    const over = valid.slice();
    new DataView(over.buffer).setUint32(4, ROUTER_REQUEST_WINDOW + 1);
    expect(() => decodeRouterRequestCredit(over)).toThrow();
    for (const requestOrdinal of [1, Number.MAX_SAFE_INTEGER]) {
      expect(
        decodeRouterHeader(
          encodeRouterHeader({
            route,
            bytes: 1,
            binary: false,
            requestOrdinal,
          }),
        ).requestOrdinal,
      ).toBe(requestOrdinal);
    }
    for (const ordinal of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        encodeRouterHeader({
          route,
          bytes: 1,
          binary: false,
          requestOrdinal: ordinal,
        })
      ).toThrow();
    }
  });

  it("returns credit after the records already passed to the socket, coalescing returns not yet written", async () => {
    const { sender, writes, callbacks } = heldSender(4 * 1024 * 1024);
    sender.send(route, "body");
    const drained = sender.drain();
    // A small body is passed to the socket whole; the credit follows its end
    // record and is not part of the body's output.
    expect(writes.map((record) => decodeRouterRecord(record).kind)).toEqual([
      0,
      1,
      2,
    ]);
    sender.sendCredit(3);
    expect(writes).toHaveLength(4);
    expect(decodeRouterRequestCredit(writes[3])).toBe(3);
    expect(sender.bufferedBytes).toBe(4);
    for (let i = 0; i < 3; i++) callbacks.shift()!();
    expect(await drained).toBe(true);
    expect(sender.bufferedBytes).toBe(0);
    callbacks.shift()!();
    // A return beyond the window is refused before it is written.
    expect(() => sender.sendCredit(ROUTER_REQUEST_WINDOW + 1)).toThrow();
    const receiver = new RouterAssembler();
    receiver.receive(writes[0]);
    receiver.receive(writes[1]);
    expect(receiver.receive(writes[2])?.payload).toBe("body");
    expect(decodeRouterHeader(writes[0]).requestOrdinal).toBeUndefined();
  });

  for (const acknowledged of [0, 1, 2]) {
    it(`returns credit before the next body record after \`${acknowledged}\` callbacks on a full window, as one record for every return still waiting`, async () => {
      const held = heldSender(ROUTED_RAW_LIMIT);
      const { sender, writes, ack, inFlight } = held;
      const bytes = 16 * ROUTER_CHUNK_BYTES;
      sender.send(route, new Uint8Array(bytes));
      expect(inFlight()).toBeGreaterThanOrEqual(ROUTER_SEND_WINDOW_BYTES);
      for (let i = 0; i < acknowledged; i++) ack();
      const pipelined = writes.length;
      const drained = sender.drain();
      // Each callback refills the window at once, so the credit finds it full
      // and waits; it is still the next record passed to the socket, ahead of
      // the body's remaining records, and later returns join it.
      expect(inFlight()).toBeGreaterThanOrEqual(ROUTER_SEND_WINDOW_BYTES);
      sender.sendCredit(4);
      sender.sendCredit(6);
      expect(writes).toHaveLength(pipelined);
      while (writes.length === pipelined) ack();
      expect(decodeRouterRequestCredit(writes[pipelined])).toBe(10);
      expect(writes.slice(0, pipelined).some(isRouterRequestCredit)).toBe(
        false,
      );
      expect(sender.bufferedBytes).toBe(bytes);
      while (held.callbacks.length) ack();
      expect(await drained).toBe(true);
      expect(sender.snapshot().completedBodies).toBe(1);
      expect(sender.snapshot().completedBytes).toBe(bytes);
      expect(writes.filter(isRouterRequestCredit)).toHaveLength(1);
    });
  }

  for (const failure of ["close", "write-error"] as const) {
    it(`drops waiting credit on \`${failure}\` and refuses more`, () => {
      let done: (error?: Error | null) => void = () => {};
      const writes: Uint8Array[] = [];
      const sender = new RouterSender(
        (record, callback) => {
          writes.push(record);
          done = callback;
        },
        () => {},
        1024,
      );
      sender.sendCredit(1);
      if (failure === "close") sender.close();
      else done(new Error("write"));
      done();
      expect(() => sender.sendCredit(1)).toThrow();
      expect(writes).toHaveLength(1);
      expect(sender.bufferedBytes).toBe(0);
    });
  }

  it("bounds per-message record work and resets the count between messages", () => {
    const receiver = new RouterAssembler();
    const chunk = routerRecord(1, new Uint8Array([1]));
    for (let message = 0; message < 2; message++) {
      receiver.receive(
        encodeRouterHeader({ route, bytes: ROUTER_CHUNK_COUNT, binary: true }),
      );
      for (let i = 0; i < ROUTER_CHUNK_COUNT; i++) receiver.receive(chunk);
      expect(receiver.receive(routerRecord(2))?.payload).toEqual(
        new Uint8Array(ROUTER_CHUNK_COUNT).fill(1),
      );
    }
    receiver.receive(
      encodeRouterHeader({
        route,
        bytes: ROUTER_CHUNK_COUNT + 1,
        binary: true,
      }),
    );
    for (let i = 0; i < ROUTER_CHUNK_COUNT; i++) receiver.receive(chunk);
    expect(() => receiver.receive(chunk)).toThrow();
  });

  it("delivers a body only after its exact length and completion record", () => {
    const body = "é".repeat(ROUTER_CHUNK_BYTES);
    const records = [...routerRecords(route, body)];
    const receiver = new RouterAssembler();
    for (const record of records.slice(0, -1)) {
      expect(record.length).toBeLessThanOrEqual(ROUTER_CHUNK_BYTES + 5);
      expect(receiver.receive(record)).toBeUndefined();
    }
    expect(receiver.receive(records.at(-1)!)).toEqual({
      header: { route, bytes: ROUTER_CHUNK_BYTES * 2, binary: false },
      payload: body,
    });
  });

  it("rejects truncation, overflow, interleaving, and unsupported versions", () => {
    const header = encodeRouterHeader({ route, bytes: 2, binary: true });
    for (
      const next of [
        routerRecord(2),
        routerRecord(1, new Uint8Array(3)),
        header,
      ]
    ) {
      const receiver = new RouterAssembler();
      receiver.receive(header);
      expect(() => receiver.receive(next)).toThrow();
    }
    const unsupported = header.slice();
    unsupported[3] = 2;
    expect(() => new RouterAssembler().receive(unsupported)).toThrow();
    expect(() =>
      new RouterAssembler().receive(routerRecord(1, new Uint8Array(1)))
    )
      .toThrow();
  });

  it("discards an interrupted body without exposing it", () => {
    const receiver = new RouterAssembler();
    const records = [...routerRecords(route, new Uint8Array([1, 2]))];
    receiver.receive(records[0]);
    receiver.receive(records[1]);
    receiver.close();
    expect(() => receiver.receive(records[2])).toThrow();
  });

  it("pipelines records up to the send window and resumes from the callback that brings it under", () => {
    const limit = 2 * ROUTER_SEND_WINDOW_BYTES;
    const held = heldSender(limit);
    const { sender, writes, errors, ack, inFlight } = held;
    sender.send(route, new Uint8Array(limit));
    // Records go out until the unacknowledged bytes reach the window, and the
    // record that reaches it is the last one passed to the socket.
    expect(inFlight()).toBeGreaterThanOrEqual(ROUTER_SEND_WINDOW_BYTES);
    expect(inFlight() - writes.at(-1)!.length).toBeLessThan(
      ROUTER_SEND_WINDOW_BYTES,
    );
    expect(writes.map((record) => decodeRouterRecord(record).kind)).toEqual([
      0,
      ...Array<number>(writes.length - 1).fill(1),
    ]);
    expect(sender.bufferedBytes).toBe(limit);
    expect(sender.snapshot()).toMatchObject({
      pendingRecords: writes.length,
      pendingRecordBytes: inFlight(),
      pendingRecordKind: 0,
      dispatchedRecords: writes.length,
      completedRecords: 0,
    });
    // Callbacks that leave the window full pass nothing on; the first that
    // brings it under refills it.
    const pipelined = writes.length;
    for (;;) {
      const remaining = inFlight() - writes[held.acknowledged].length;
      ack();
      if (remaining < ROUTER_SEND_WINDOW_BYTES) break;
      expect(writes).toHaveLength(pipelined);
    }
    expect(writes.length).toBeGreaterThan(pipelined);
    expect(inFlight()).toBeGreaterThanOrEqual(ROUTER_SEND_WINDOW_BYTES);
    expect(sender.bufferedBytes).toBe(limit);
    while (held.callbacks.length) ack();
    expect(writes.map((record) => decodeRouterRecord(record).kind)).toEqual([
      0,
      ...Array<number>(limit / ROUTER_CHUNK_BYTES).fill(1),
      2,
    ]);
    expect(sender.bufferedBytes).toBe(0);
    expect(errors).toHaveLength(0);
    const snapshot = sender.snapshot();
    expect(snapshot.pendingRecords).toBe(0);
    expect(snapshot.completedRecords).toBe(snapshot.dispatchedRecords);
  });

  it("abandons queued bodies on a failed socket write and ignores the other pipelined callbacks", () => {
    const { sender, callbacks, errors } = heldSender(1024);
    sender.send(route, "first");
    sender.send(route, "second");
    expect(callbacks).toHaveLength(6);
    const error = new Error("closed");
    callbacks.shift()!(error);
    expect(sender.bufferedBytes).toBe(0);
    expect(errors).toEqual([error]);
    while (callbacks.length) callbacks.shift()!();
    expect(sender.snapshot()).toMatchObject({
      completedRecords: 0,
      completedBodies: 0,
      callbackErrors: 1,
      pendingRecords: 0,
      retainedBytes: 0,
    });
    expect(() => sender.send(route, "third")).toThrow();
  });

  it("resolves a shared drain only after the final body's completion callback", async () => {
    const callbacks: (() => void)[] = [];
    const sender = new RouterSender(
      (_record, done) => callbacks.push(done),
      () => {},
      1024,
    );
    expect(await sender.drain()).toBe(true);
    sender.send(route, "first");
    sender.send(route, "second");
    const drained = sender.drain();
    expect(sender.drain()).toBe(drained);
    let released = false;
    void drained.then(() => released = true);
    for (let record = 0; record < 5; record++) {
      callbacks.shift()!();
      // Drain resolution queues its observers as microtasks.
      await Promise.resolve();
      expect(released).toBe(false);
    }
    expect(sender.bufferedBytes).toBe(6);
    callbacks.shift()!();
    expect(await drained).toBe(true);
    expect(sender.bufferedBytes).toBe(0);
  });

  for (const ending of ["close", "callback-error", "send-error"] as const) {
    it(`cancels drain on \`${ending}\` and ignores late callbacks`, async () => {
      let done: (error?: Error | null) => void = () => {};
      let writes = 0;
      const sender = new RouterSender(
        (_record, callback) => {
          if (++writes > 1 && ending === "send-error") throw new Error("write");
          done = callback;
        },
        () => {},
        1024,
      );
      sender.send(route, "body");
      const drained = sender.drain();
      if (ending === "close") sender.close();
      else done(ending === "callback-error" ? new Error("write") : undefined);
      expect(await drained).toBe(false);
      const failedWrites = writes;
      done();
      expect(writes).toBe(failedWrites);
      expect(await sender.drain()).toBe(false);
    });
  }

  it("accepts a null socket completion as a successful write, through a body wider than the window", () => {
    const writes: Uint8Array[] = [];
    const errors: Error[] = [];
    const sender = new RouterSender(
      (bytes, done) => {
        writes.push(bytes);
        done(null);
      },
      (error) => errors.push(error),
      ROUTED_RAW_LIMIT,
    );
    sender.send(route, "body");
    expect(writes.map((record) => decodeRouterRecord(record).kind)).toEqual([
      0,
      1,
      2,
    ]);
    expect(sender.bufferedBytes).toBe(0);
    // A callback that runs inside the write passes the next record on from
    // the running loop, not from a nested one.
    writes.length = 0;
    sender.send(route, new Uint8Array(2 * ROUTER_SEND_WINDOW_BYTES));
    expect(writes.map((record) => decodeRouterRecord(record).kind)).toEqual([
      0,
      ...Array<number>(2 * ROUTER_SEND_WINDOW_BYTES / ROUTER_CHUNK_BYTES).fill(
        1,
      ),
      2,
    ]);
    expect(sender.bufferedBytes).toBe(0);
    expect(sender.snapshot().pendingRecords).toBe(0);
    expect(errors).toHaveLength(0);
  });

  it("admits a lone body up to the raw limit under any queue bound and never one past it", () => {
    for (const limit of [5, null]) {
      const errors: Error[] = [];
      const sender = new RouterSender(
        () => {},
        (error) => errors.push(error),
        limit,
      );
      // Alone, a body is bounded only by what the router and SDK accept.
      sender.send(route, new Uint8Array(ROUTED_RAW_LIMIT));
      expect(sender.bufferedBytes).toBe(ROUTED_RAW_LIMIT);
      // Behind it, the queue bound applies when enabled.
      if (limit === null) sender.send(route, "x");
      else expect(() => sender.send(route, "x")).toThrow();
      const fresh = new RouterSender(
        () => {},
        (error) => errors.push(error),
        limit,
      );
      expect(() => fresh.send(route, new Uint8Array(ROUTED_RAW_LIMIT + 1)))
        .toThrow();
    }
  });

  it("terminates output when a queued body exceeds the byte budget", () => {
    const errors: Error[] = [];
    const sender = new RouterSender(() => {}, (error) => errors.push(error), 5);
    sender.send(route, "first");
    expect(() => sender.send(route, "x")).toThrow();
    expect(errors).toHaveLength(1);
    expect(sender.bufferedBytes).toBe(0);
    expect(() => sender.send(route, "x")).toThrow();
  });

  it("distinguishes retained bodies from successful record writes and measures their ages", () => {
    let now = 10;
    const { sender, writes, callbacks, inFlight } = heldSender(
      4 * ROUTER_CHUNK_BYTES,
      () => now,
    );
    const bytes = 2 * ROUTER_CHUNK_BYTES + 3;
    sender.send(route, new Uint8Array(bytes));
    now = 12;
    sender.send(route, "second");
    now = 15;
    // Both bodies fit the window: eight records are in flight, and the ages
    // of the pending records are those of the oldest.
    expect(sender.snapshot()).toMatchObject({
      admittedBodies: 2,
      admittedBytes: bytes + 6,
      retainedBytes: bytes + 6,
      queuedBodies: 2,
      completedBodies: 0,
      completedRecords: 0,
      dispatchedRecords: 8,
      pendingRecords: 8,
      pendingRecordKind: 0,
      pendingRecordBytes: inFlight(),
      pendingCallbackAgeMs: 5,
      oldestQueuedAgeMs: 5,
      lastCallbackAgeMs: null,
    });
    callbacks.shift()!();
    now = 20;
    callbacks.shift()!();
    expect(sender.snapshot()).toMatchObject({
      retainedBytes: bytes + 6,
      activeBodyBytes: bytes,
      activeBodyWrittenBytes: ROUTER_CHUNK_BYTES,
      completedRecords: 2,
      completedRecordBytes: writes[0].length + writes[1].length,
      dispatchedRecords: 8,
      pendingRecords: 6,
      pendingRecordKind: 1,
      pendingRecordBytes: writes.slice(2).reduce(
        (total, record) => total + record.length,
        0,
      ),
      pendingCallbackAgeMs: 10,
      oldestQueuedAgeMs: 10,
      lastCallbackAgeMs: 0,
    });
    callbacks.shift()!();
    callbacks.shift()!();
    expect(sender.snapshot()).toMatchObject({
      activeBodyWrittenBytes: bytes,
      completedBodies: 0,
      pendingRecords: 4,
      pendingRecordKind: 2,
      retainedBytes: bytes + 6,
    });
    now = 30;
    callbacks.shift()!();
    expect(sender.snapshot()).toMatchObject({
      completedBodies: 1,
      completedBytes: bytes,
      retainedBytes: 6,
      queuedBodies: 1,
      activeBodyBytes: 6,
      activeBodyWrittenBytes: 0,
      oldestQueuedAgeMs: 18,
      pendingRecords: 3,
      pendingRecordKind: 0,
      pendingCallbackAgeMs: 18,
    });
    while (callbacks.length) callbacks.shift()!();
    now = 40;
    const snapshot = sender.snapshot();
    expect(snapshot).toMatchObject({
      admittedBodies: 2,
      completedBodies: 2,
      completedBytes: bytes + 6,
      completedRecords: 8,
      retainedBytes: 0,
      queuedBodies: 0,
      oldestQueuedAgeMs: null,
      pendingRecords: 0,
      pendingCallbackAgeMs: null,
      pendingRecordKind: null,
      pendingRecordBytes: 0,
      lastCallbackAgeMs: 10,
      callbackErrors: 0,
    });
    expect(snapshot.dispatchedRecords).toBe(snapshot.completedRecords);
    expect(snapshot.dispatchedRecordBytes).toBe(snapshot.completedRecordBytes);
    expect(snapshot.completedRecordBytes).toBe(
      writes.reduce((total, record) => total + record.length, 0),
    );
  });

  it("records failed callbacks without counting a completed body or late writes", () => {
    let now = 10;
    const callbacks: ((error?: Error | null) => void)[] = [];
    const events: string[] = [];
    const errors: Error[] = [];
    const sender = new RouterSender(
      (_record, callback) => {
        callbacks.push(callback);
      },
      (error) => errors.push(error),
      10,
      {
        now: () => now,
        observe: (event) => events.push(event),
      },
    );
    sender.send(route, "body");
    now = 20;
    const error = new Error("socket closed");
    expect(callbacks).toHaveLength(3);
    callbacks[0](error);
    const failed = sender.snapshot();
    expect(failed).toMatchObject({
      admittedBodies: 1,
      admittedBytes: 4,
      dispatchedRecords: 3,
      completedRecords: 0,
      completedBodies: 0,
      callbackErrors: 1,
      retainedBytes: 0,
      pendingRecords: 0,
      pendingCallbackAgeMs: null,
      lastCallbackAgeMs: 0,
    });
    // The header's own late callback and the other records' callbacks.
    for (const done of callbacks) done();
    sender.close();
    expect(sender.snapshot()).toEqual(failed);
    expect(events).toEqual(["enqueue", "write-error", "close"]);
    expect(errors).toEqual([error]);
  });
});
