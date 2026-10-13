import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  decodeRouterAdmission,
  decodeRouterHeader,
  decodeRouterRecord,
  encodeRouterAdmission,
  encodeRouterHeader,
  isRouterControl,
  ROUTER_CHUNK_BYTES,
  ROUTER_CHUNK_COUNT,
  RouterAssembler,
  routerRecord,
  routerRecords,
  RouterSender,
} from "../v2/router-protocol.ts";

describe("router-protocol", () => {
  const route = { type: "response", requestId: "r" };

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
          "session.watch.remove",
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

  it("encodes admission bytes and ordinals in the exact private record layout", () => {
    expect([...encodeRouterAdmission(0x010203, 0x010203040506)])
      .toEqual([109, 114, 105, 1, 0, 1, 2, 3, 0, 0, 1, 2, 3, 4, 5, 6]);
    for (const requestOrdinal of [1, Number.MAX_SAFE_INTEGER]) {
      expect(
        decodeRouterAdmission(
          encodeRouterAdmission(4 * 1024 * 1024, requestOrdinal),
        ),
      )
        .toEqual({ bytes: 4 * 1024 * 1024, requestOrdinal });
      expect(
        decodeRouterHeader(
          encodeRouterHeader({
            route,
            bytes: 1,
            binary: false,
            requestOrdinal,
          }),
        ).requestOrdinal,
      )
        .toBe(requestOrdinal);
    }
    for (const ordinal of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => encodeRouterAdmission(1, ordinal)).toThrow();
      expect(() =>
        encodeRouterHeader({
          route,
          bytes: 1,
          binary: false,
          requestOrdinal: ordinal,
        })
      ).toThrow();
    }
    for (const bytes of [0, 4 * 1024 * 1024 + 1]) {
      expect(() => encodeRouterAdmission(bytes, 1)).toThrow();
    }
    const valid = encodeRouterAdmission(1, 1);
    expect(() => decodeRouterAdmission(valid.subarray(1))).toThrow();
    const unsafe = valid.slice();
    new DataView(unsafe.buffer).setBigUint64(8, 1n << 53n);
    expect(() => decodeRouterAdmission(unsafe)).toThrow();
  });

  it("inserts one admission at a response record boundary without releasing body credit", async () => {
    const writes: Uint8Array[] = [];
    const callbacks: ((error?: Error | null) => void)[] = [];
    const sender = new RouterSender(
      (record, done) => {
        writes.push(record);
        callbacks.push(done);
      },
      () => {},
      4 * 1024 * 1024,
    );
    sender.send(route, "body");
    const drained = sender.drain();
    let admitted = false;
    sender.sendAdmission(3, 1, () => admitted = true);
    expect(writes).toHaveLength(1);
    expect(() => sender.sendAdmission(3, 2, () => {})).toThrow();
    callbacks.shift()!();
    expect(decodeRouterAdmission(writes[1])).toEqual({
      bytes: 3,
      requestOrdinal: 1,
    });
    expect(sender.bufferedBytes).toBe(4);
    expect(admitted).toBe(false);
    callbacks.shift()!();
    expect(admitted).toBe(true);
    expect(sender.bufferedBytes).toBe(4);
    expect(decodeRouterRecord(writes[2]).kind).toBe(1);
    callbacks.shift()!();
    callbacks.shift()!();
    expect(await drained).toBe(true);
    const receiver = new RouterAssembler();
    receiver.receive(writes[0]);
    receiver.receive(writes[2]);
    expect(receiver.receive(writes[3])?.payload).toBe("body");
    expect(decodeRouterHeader(writes[0]).requestOrdinal).toBeUndefined();
  });

  for (const boundary of [0, 1, 2]) {
    it(`serializes admission after response record \`${boundary}\` and attributes completion only to the response end`, async () => {
      const writes: Uint8Array[] = [];
      const callbacks: (() => void)[] = [];
      const sender = new RouterSender(
        (record, done) => {
          writes.push(record);
          callbacks.push(done);
        },
        () => {},
        1024,
      );
      sender.send(route, "body");
      for (let i = 0; i < boundary; i++) callbacks.shift()!();
      const drained = sender.drain();
      let admitted = false;
      sender.sendAdmission(4, 7, () => admitted = true);
      expect(sender.bufferedBytes).toBe(4);
      callbacks.shift()!();
      expect(decodeRouterAdmission(writes.at(-1)!)).toEqual({
        bytes: 4,
        requestOrdinal: 7,
      });
      expect(admitted).toBe(false);
      expect(sender.bufferedBytes).toBe(boundary === 2 ? 0 : 4);
      const snapshot = sender.snapshot();
      expect(snapshot.pendingRecordKind).toBeNull();
      callbacks.shift()!();
      expect(admitted).toBe(true);
      expect(sender.bufferedBytes).toBe(boundary === 2 ? 0 : 4);
      while (callbacks.length) callbacks.shift()!();
      expect(await drained).toBe(true);
      expect(sender.snapshot().completedBodies).toBe(1);
      expect(sender.snapshot().completedBytes).toBe(4);
    });
  }

  for (const failure of ["close", "write-error"] as const) {
    it(`cancels an admission on \`${failure}\` without enabling input through a late callback`, () => {
      let done: (error?: Error | null) => void = () => {};
      let admitted = false;
      const sender = new RouterSender(
        (_record, callback) => done = callback,
        () => {},
        1024,
      );
      sender.sendAdmission(1, 1, () => admitted = true);
      if (failure === "close") sender.close();
      else done(new Error("write"));
      done();
      expect(admitted).toBe(false);
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

  it("waits for each socket completion while retaining a bounded output budget", () => {
    const writes: Uint8Array[] = [];
    const callbacks: ((error?: Error) => void)[] = [];
    const errors: Error[] = [];
    const limit = ROUTER_CHUNK_BYTES * 2;
    const sender = new RouterSender(
      (record, done) => {
        writes.push(record);
        callbacks.push(done);
      },
      (error) => errors.push(error),
      limit,
    );
    sender.send(route, new Uint8Array(limit));
    expect(writes).toHaveLength(1);
    expect(sender.bufferedBytes).toBe(limit);
    callbacks.shift()!();
    expect(writes).toHaveLength(2);
    expect(decodeRouterRecord(writes[1]).kind).toBe(1);
    expect(sender.bufferedBytes).toBe(limit);
    while (callbacks.length) callbacks.shift()!();
    expect(writes.map((bytes) => decodeRouterRecord(bytes).kind)).toEqual([
      0,
      1,
      1,
      2,
    ]);
    expect(sender.bufferedBytes).toBe(0);
    expect(errors).toHaveLength(0);
  });

  it("abandons queued bodies on a failed socket write", () => {
    const callbacks: ((error?: Error) => void)[] = [];
    const errors: Error[] = [];
    const sender = new RouterSender(
      (_record, done) => callbacks.push(done),
      (error) => errors.push(error),
      1024,
    );
    sender.send(route, "first");
    sender.send(route, "second");
    const error = new Error("closed");
    callbacks.shift()!(error);
    expect(sender.bufferedBytes).toBe(0);
    expect(callbacks).toHaveLength(0);
    expect(errors).toEqual([error]);
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

  it("accepts a null socket completion as a successful write", () => {
    const writes: Uint8Array[] = [];
    const errors: Error[] = [];
    const sender = new RouterSender(
      (bytes, done) => {
        writes.push(bytes);
        done(null);
      },
      (error) => errors.push(error),
      1024,
    );
    sender.send(route, "body");
    expect(writes.map((record) => decodeRouterRecord(record).kind)).toEqual([
      0,
      1,
      2,
    ]);
    expect(sender.bufferedBytes).toBe(0);
    expect(errors).toHaveLength(0);
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
    const writes: Uint8Array[] = [];
    const callbacks: ((error?: Error | null) => void)[] = [];
    const sender = new RouterSender(
      (record, done) => {
        writes.push(record);
        callbacks.push(done);
      },
      () => {},
      4 * ROUTER_CHUNK_BYTES,
      { now: () => now },
    );
    const bytes = 2 * ROUTER_CHUNK_BYTES + 3;
    sender.send(route, new Uint8Array(bytes));
    now = 12;
    sender.send(route, "second");
    now = 15;
    expect(sender.snapshot()).toMatchObject({
      admittedBodies: 2,
      admittedBytes: bytes + 6,
      retainedBytes: bytes + 6,
      queuedBodies: 2,
      completedBodies: 0,
      completedRecords: 0,
      dispatchedRecords: 1,
      pendingRecordKind: 0,
      pendingRecordBytes: writes[0].length,
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
      dispatchedRecords: 3,
      pendingRecordKind: 1,
      pendingCallbackAgeMs: 0,
      oldestQueuedAgeMs: 10,
      lastCallbackAgeMs: 0,
    });
    callbacks.shift()!();
    callbacks.shift()!();
    expect(sender.snapshot()).toMatchObject({
      activeBodyWrittenBytes: bytes,
      completedBodies: 0,
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
    let done: (error?: Error | null) => void = () => {};
    const events: string[] = [];
    const errors: Error[] = [];
    const sender = new RouterSender(
      (_record, callback) => {
        done = callback;
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
    done(error);
    const failed = sender.snapshot();
    expect(failed).toMatchObject({
      admittedBodies: 1,
      admittedBytes: 4,
      dispatchedRecords: 1,
      completedRecords: 0,
      completedBodies: 0,
      callbackErrors: 1,
      retainedBytes: 0,
      pendingCallbackAgeMs: null,
      lastCallbackAgeMs: 0,
    });
    done();
    sender.close();
    expect(sender.snapshot()).toEqual(failed);
    expect(events).toEqual(["enqueue", "write-error", "close"]);
    expect(errors).toEqual([error]);
  });
});
