/**
 * Independently negotiated router data records. Routing headers precede opaque
 * Memory payloads; every record is a complete, bounded WebSocket message.
 */

import { isCanonicalEd25519DID } from "@commonfabric/identity";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  parseRoutedJson,
  ROUTED_RAW_LIMIT,
  routedIdentifier,
  routedObject,
} from "./routed-parser.ts";
import { requireRouted } from "./routed-wire.ts";

/** Private routing/control contract, independent of Memory API capabilities. */
export const ROUTER_PROTOCOL_VERSION = 1;

/** Maximum opaque bytes in one forwarding record. */
export const ROUTER_CHUNK_BYTES = 32 * 1024;

/** Maximum data records in one logical body, bounding per-record work. */
export const ROUTER_CHUNK_COUNT = 512;

/** Maximum routing header bytes, including its record prefix. */
export const ROUTER_HEADER_BYTES = 4096;

/**
 * Record bytes the toolshed sender passes to its socket ahead of their write
 * callbacks (256 KiB). The sender keeps writing records while the
 * unacknowledged bytes are below this window and resumes from the callback
 * that brings them back under it, so a body drains without one event-loop
 * turn per record. Local to the toolshed; the router does not read it.
 */
export const ROUTER_SEND_WINDOW_BYTES = 256 * 1024;

/**
 * Largest public upload credit window the SDK accepts, in on-wire record
 * bytes. The router offers it in `hello.ok.routerUploadWindow`.
 */
export const ROUTER_UPLOAD_WINDOW = 262_144;

/**
 * Request credit a toolshed grants on one private data socket, in declared
 * body bytes: its whole input budget (`ROUTED_QUEUE_LIMIT`). The toolshed
 * grants the window once the socket is ready and returns each request's bytes
 * when that request's turn ends; the router sends a request header only within
 * the credit it holds, and its body right behind it.
 */
export const ROUTER_REQUEST_WINDOW = 4 * 1024 * 1024;

/**
 * Largest private request ordinal. Ordinals start at 1 on each data socket
 * and increase by exactly one; a socket that reaches this value accepts no
 * further request header.
 */
export const ROUTER_MAX_REQUEST_ORDINAL = Number.MAX_SAFE_INTEGER;

/**
 * Frame-slot cap policy, version 1: the SDK learns the routed frame-slot cap
 * from `hello.ok.routerFrameSlots` on every handshake (`null` disables slot
 * counting, an absent field selects the default) and applies it to the frames
 * it sends and receives. The infra router's preflight reads this constant to
 * confirm the SDK it deploys against follows this policy.
 */
export const ROUTER_HELLO_FRAME_SLOTS_POLICY = 1;

/**
 * Identifies bounded controls whose contents the router must process locally:
 * authentication, negotiation, session opens, and every watch mutation, since
 * `session.watch.remove` counts against `max_watches_per_session` as the
 * additions do.
 */
export function isRouterControl(kind: unknown): boolean {
  return typeof kind === "string" && (
    kind === "hello" || kind.startsWith("connection.") ||
    kind === "memory.compression" || kind === "session.open" ||
    kind === "session.watch.set" || kind === "session.watch.add" ||
    kind === "session.watch.remove"
  );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const prefix = new Uint8Array([0x6d, 0x72, 0x74, 1]);

/** Routing facts the private peer supplies independently of its payload. */
export interface RouterHeader {
  /** Number of encoded body bytes, bounded at the endpoint's message limit. */
  readonly bytes: number;

  /** WebSocket representation of the reassembled public message. */
  readonly binary: boolean;

  /** Small public-envelope projection used for request and session binding. */
  readonly route: Record<string, unknown>;

  /** Private request sequence; absent on public and response headers. */
  readonly requestOrdinal?: number;
}

/** Returns the routing projection of an endpoint-owned Memory message. */
export function routerRoute(value: unknown): Record<string, unknown> {
  const body = routedObject(value);
  requireRouted(typeof body.type === "string");
  const route: Record<string, unknown> = { type: body.type };
  for (const name of ["requestId", "space", "sessionId", "principal"]) {
    if (body[name] !== undefined) route[name] = body[name];
  }
  if (body.error !== undefined) route.error = true;
  if (isPlainObject(body.ok) && typeof body.ok.sessionId === "string") {
    route.ok = { sessionId: body.ok.sessionId };
  }
  if (isPlainObject(body.session) && body.session.sessionId !== undefined) {
    route.session = { sessionId: body.session.sessionId };
  }
  return route;
}

/** Checks the bounded transport header before a body is accepted. */
export function routerHeader(value: unknown): RouterHeader {
  const header = routedObject(value);
  requireRouted(
    Number.isSafeInteger(header.bytes) && typeof header.bytes === "number" &&
      header.bytes > 0 && header.bytes <= ROUTED_RAW_LIMIT &&
      typeof header.binary === "boolean",
  );
  const route = routedObject(header.route);
  requireRouted(
    Object.keys(route).every((key) =>
      [
        "type",
        "requestId",
        "space",
        "sessionId",
        "principal",
        "error",
        "ok",
        "session",
      ].includes(key)
    ),
  );
  requireRouted(
    typeof route.type === "string" &&
      /^[A-Za-z0-9./_:-]{1,64}$/.test(route.type),
  );
  for (const name of ["requestId", "sessionId"]) {
    if (route[name] !== undefined) routedIdentifier(route[name]);
  }
  for (const name of ["space", "principal"]) {
    if (route[name] !== undefined) {
      requireRouted(
        typeof route[name] === "string" && isCanonicalEd25519DID(route[name]),
      );
    }
  }
  if (route.error !== undefined) requireRouted(route.error === true);
  for (const name of ["ok", "session"]) {
    if (route[name] !== undefined) {
      const value = routedObject(route[name]);
      requireRouted(Object.keys(value).length === 1);
      routedIdentifier(value.sessionId);
    }
  }
  requireRouted(
    Object.keys(header).every((key) =>
      ["bytes", "binary", "route", "requestOrdinal"].includes(key)
    ),
  );
  requireRouted(
    header.requestOrdinal === undefined ||
      Number.isSafeInteger(header.requestOrdinal) &&
        typeof header.requestOrdinal === "number" && header.requestOrdinal > 0,
  );
  return {
    bytes: header.bytes,
    binary: header.binary,
    route,
    ...(header.requestOrdinal === undefined
      ? {}
      : { requestOrdinal: header.requestOrdinal }),
  };
}

/** Identifies private request credit independently of response records. */
export function isRouterRequestCredit(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x6d && bytes[1] === 0x72 &&
    bytes[2] === 0x69 && bytes[3] === 2;
}

/**
 * Encodes request credit: eight bytes, `mri\x02` and an unsigned big-endian
 * count of declared body bytes, positive and within
 * {@link ROUTER_REQUEST_WINDOW}. Credit is additive.
 */
export function encodeRouterRequestCredit(
  bytes: number,
): Uint8Array<ArrayBuffer> {
  requireRouted(
    Number.isSafeInteger(bytes) && bytes > 0 &&
      bytes <= ROUTER_REQUEST_WINDOW,
  );
  const record = new Uint8Array(8);
  record.set([0x6d, 0x72, 0x69, 2]);
  new DataView(record.buffer).setUint32(4, bytes);
  return record;
}

/** Decodes an exact request credit record without interpreting payloads. */
export function decodeRouterRequestCredit(record: Uint8Array): number {
  requireRouted(record.length === 8 && isRouterRequestCredit(record));
  const bytes = new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength,
  ).getUint32(4);
  requireRouted(bytes > 0 && bytes <= ROUTER_REQUEST_WINDOW);
  return bytes;
}

/** Encodes a start record without copying or parsing the application body. */
export function encodeRouterHeader(
  header: RouterHeader,
): Uint8Array<ArrayBuffer> {
  routerHeader(header);
  const body = encoder.encode(JSON.stringify(header));
  requireRouted(body.length + 5 <= ROUTER_HEADER_BYTES);
  return routerRecord(0, body);
}

/** Encodes one data or completion record. Completion carries no bytes. */
export function routerRecord(
  kind: 0 | 1 | 2,
  body: Uint8Array = new Uint8Array(),
): Uint8Array<ArrayBuffer> {
  requireRouted(
    body.length <= ROUTER_CHUNK_BYTES && (kind !== 2 || body.length === 0),
  );
  const result = new Uint8Array(body.length + 5);
  result.set(prefix);
  result[4] = kind;
  result.set(body, 5);
  return result;
}

/** Decodes a bounded record without interpreting opaque chunk bytes. */
export function decodeRouterRecord(bytes: Uint8Array): {
  kind: number;
  body: Uint8Array;
} {
  requireRouted(
    bytes.length >= 5 && bytes.length <= ROUTER_CHUNK_BYTES + 5 &&
      prefix.every((byte, index) => bytes[index] === byte) && bytes[4] <= 2,
  );
  return { kind: bytes[4], body: bytes.subarray(5) };
}

/** Decodes only the start record's bounded routing metadata. */
export function decodeRouterHeader(bytes: Uint8Array): RouterHeader {
  requireRouted(bytes.length <= ROUTER_HEADER_BYTES);
  const record = decodeRouterRecord(bytes);
  requireRouted(record.kind === 0);
  return routerHeader(parseRoutedJson(decoder.decode(record.body), 256));
}

/**
 * Endpoint assembly for one logical message. A completion record is required
 * even after all declared bytes arrive; an interrupted body is never delivered.
 */
export class RouterAssembler {
  #header: RouterHeader | undefined;
  #body: Uint8Array | undefined;
  #offset = 0;
  #chunks = 0;
  #reserve: (bytes: number) => void;

  /** Constructs an instance that reserves body bytes before allocating them. */
  constructor(reserve: (bytes: number) => void = () => {}) {
    this.#reserve = reserve;
  }

  /** Whether an admitted body still needs data or its completion record. */
  get receiving(): boolean {
    return this.#header !== undefined;
  }

  /** Discards an incomplete message on connection loss. */
  close(): void {
    this.#header = undefined;
    this.#body = undefined;
    this.#offset = 0;
    this.#chunks = 0;
  }

  /** Returns a complete payload only after its exact length and end record. */
  receive(bytes: Uint8Array): {
    header: RouterHeader;
    payload: string | Uint8Array;
  } | undefined {
    const record = decodeRouterRecord(bytes);
    if (record.kind === 0) {
      requireRouted(this.#header === undefined);
      this.#header = decodeRouterHeader(bytes);
      this.#reserve(this.#header.bytes);
      this.#body = new Uint8Array(this.#header.bytes);
      this.#offset = 0;
      return;
    }
    requireRouted(this.#header !== undefined && this.#body !== undefined);
    if (record.kind === 1) {
      requireRouted(
        record.body.length > 0 &&
          this.#offset + record.body.length <= this.#body.length &&
          ++this.#chunks <= ROUTER_CHUNK_COUNT,
      );
      this.#body.set(record.body, this.#offset);
      this.#offset += record.body.length;
      return;
    }
    requireRouted(
      record.body.length === 0 && this.#offset === this.#body.length,
    );
    const header = this.#header;
    const payload = header.binary ? this.#body : decoder.decode(this.#body);
    this.close();
    return { header, payload };
  }
}

/**
 * Yields bounded records around a body already owned by an endpoint. Only a
 * router's private request header carries `requestOrdinal`; the router adds it
 * when it forwards a request, and refuses one on a public header, so the SDK
 * and a toolshed's responses omit it.
 */
export function* routerRecords(
  route: Record<string, unknown>,
  payload: string | Uint8Array,
  requestOrdinal?: number,
): Generator<Uint8Array<ArrayBuffer>> {
  const body = typeof payload === "string" ? encoder.encode(payload) : payload;
  yield encodeRouterHeader({
    route,
    bytes: body.length,
    binary: typeof payload !== "string",
    ...(requestOrdinal === undefined ? {} : { requestOrdinal }),
  });
  for (let offset = 0; offset < body.length; offset += ROUTER_CHUNK_BYTES) {
    yield routerRecord(1, body.subarray(offset, offset + ROUTER_CHUNK_BYTES));
  }
  yield routerRecord(2);
}

/** Output state sampled without inspecting or copying a logical body. */
export interface RouterSenderSnapshot {
  /** Logical body bytes still retained, including written prefixes. */
  readonly retainedBytes: number;

  /** Active body plus bodies waiting to start. */
  readonly queuedBodies: number;

  /** Lifetime counts of admitted logical bodies and their payload bytes. */
  readonly admittedBodies: number;

  /** Total payload bytes accepted into the logical queue. */
  readonly admittedBytes: number;

  /** Bodies released after successful completion-record callbacks. */
  readonly completedBodies: number;

  /** Total payload bytes released after completion records. */
  readonly completedBytes: number;

  /** Records handed to the socket and their bytes, including routing overhead. */
  readonly dispatchedRecords: number;

  /** Total record bytes handed to the socket, including routing overhead. */
  readonly dispatchedRecordBytes: number;

  /** Successful record callbacks and record bytes, including routing overhead. */
  readonly completedRecords: number;

  /** Total bytes covered by successful record callbacks, including overhead. */
  readonly completedRecordBytes: number;

  /** Failed socket callbacks; late callbacks after close are ignored. */
  readonly callbackErrors: number;

  /** Oldest body's size and payload bytes whose callbacks succeeded. */
  readonly activeBodyBytes: number;

  /** Payload prefix whose data-record callbacks have succeeded. */
  readonly activeBodyWrittenBytes: number;

  /** Age of the oldest retained body, or null when the queue is empty. */
  readonly oldestQueuedAgeMs: number | null;

  /** Records passed to the socket whose write callbacks have not run. */
  readonly pendingRecords: number;

  /** Bytes of those records, including their routing overhead. */
  readonly pendingRecordBytes: number;

  /**
   * Routing kind of the oldest record awaiting a callback, or null for a
   * request credit record and when no write is pending.
   */
  readonly pendingRecordKind: number | null;

  /** Elapsed monotonic time since the oldest pending record was passed to the socket, or null. */
  readonly pendingCallbackAgeMs: number | null;

  /** Elapsed monotonic time since any callback, or null before the first. */
  readonly lastCallbackAgeMs: number | null;
}

/** Queue transitions available to an endpoint's bounded diagnostic recorder. */
export type RouterSenderEvent =
  | "enqueue"
  | "callback"
  | "complete"
  | "write-error"
  | "close";

/** One logical body: its record cursor and the credit it retains. */
interface QueuedBody {
  /** Header, data and end records, yielded as they are passed to the socket. */
  records: Generator<Uint8Array>;

  /** Payload bytes charged against the output budget until the end record's callback. */
  bytes: number;

  /** Monotonic time of admission, for the oldest-body age. */
  enqueuedAt: number;

  /** Payload bytes whose data-record callbacks have run, not bytes passed to the socket. */
  writtenBytes: number;
}

/** One record passed to the socket, until its write callback runs. */
interface PendingRecord {
  /** Record length including its routing overhead. */
  bytes: number;

  /** Routing kind, or null for a request credit record. */
  kind: number | null;

  /** Monotonic time the record was passed to the socket. */
  at: number;
}

/**
 * Bounded endpoint output. Records are passed to the socket in order while
 * the bytes awaiting write callbacks stay below `ROUTER_SEND_WINDOW_BYTES`;
 * queued logical bodies remain charged until their final record is written.
 */
export class RouterSender {
  #send: (record: Uint8Array, done: (error?: Error | null) => void) => void;
  #fail: (error: Error) => void;
  #limit: number | null;
  #bytes = 0;
  #queue: QueuedBody[] = [];
  /** Queue prefix whose records have all been passed to the socket. */
  #dispatchedBodies = 0;
  #pending: PendingRecord[] = [];
  #pendingBytes = 0;
  #pumping = false;
  #closed = false;
  #now: () => number;
  #observe: ((event: RouterSenderEvent) => void) | undefined;
  #admittedBodies = 0;
  #admittedBytes = 0;
  #completedBodies = 0;
  #completedBytes = 0;
  #dispatchedRecords = 0;
  #dispatchedRecordBytes = 0;
  #completedRecords = 0;
  #completedRecordBytes = 0;
  #callbackErrors = 0;
  #lastCallbackAt: number | undefined;
  #drained: PromiseWithResolvers<boolean> | undefined;
  /** Request credit to return, coalesced into the next record boundary. */
  #credit = 0;
  /** Request credit returned and not yet written to the socket. */
  get unsentCredit(): number {
    return this.#credit;
  }

  /**
   * Constructs an instance with a socket-completion callback and the bound on
   * bytes queued behind other output; `null` disables that bound. A body sent
   * while nothing is retained is admitted up to `ROUTED_RAW_LIMIT` either way,
   * and no body larger than that is admitted.
   */
  constructor(
    send: (record: Uint8Array, done: (error?: Error | null) => void) => void,
    fail: (error: Error) => void,
    limit: number | null,
    diagnostics: {
      /** Monotonic clock, injectable for deterministic diagnostic tests. */
      now?: () => number;

      /** Synchronous diagnostic observer; must not throw or mutate the sender. */
      observe?: (event: RouterSenderEvent) => void;
    } = {},
  ) {
    this.#send = send;
    this.#fail = fail;
    this.#limit = limit;
    this.#now = diagnostics.now ?? (() => performance.now());
    this.#observe = diagnostics.observe;
  }

  /** Logical bytes retained across the active body and waiting bodies. */
  get bufferedBytes(): number {
    return this.#bytes;
  }

  /**
   * Resolves `true` when all bodies finish writing, or `false` on close/error.
   * Concurrent callers share one notification. The host holds request dispatch
   * on its retained-output marks rather than on this; tests and diagnostics
   * use it to observe completion.
   */
  drain(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    if (this.#queue.length === 0) return Promise.resolve(true);
    this.#drained ??= Promise.withResolvers<boolean>();
    return this.#drained.promise;
  }

  /**
   * Returns request credit at the next response-record boundary, ahead of
   * further body records. Credit returned before an earlier return is written
   * joins it in one record.
   */
  sendCredit(bytes: number): void {
    requireRouted(
      !this.#closed && Number.isSafeInteger(bytes) && bytes > 0 &&
        this.#credit + bytes <= ROUTER_REQUEST_WINDOW,
    );
    this.#credit += bytes;
    this.#pump();
  }

  /** Returns counters and ages at one monotonic instant, without draining output. */
  snapshot(): RouterSenderSnapshot {
    const now = this.#now();
    const active = this.#queue[0];
    const oldest = this.#pending[0];
    return {
      retainedBytes: this.#bytes,
      queuedBodies: this.#queue.length,
      admittedBodies: this.#admittedBodies,
      admittedBytes: this.#admittedBytes,
      completedBodies: this.#completedBodies,
      completedBytes: this.#completedBytes,
      dispatchedRecords: this.#dispatchedRecords,
      dispatchedRecordBytes: this.#dispatchedRecordBytes,
      completedRecords: this.#completedRecords,
      completedRecordBytes: this.#completedRecordBytes,
      callbackErrors: this.#callbackErrors,
      activeBodyBytes: active?.bytes ?? 0,
      activeBodyWrittenBytes: active?.writtenBytes ?? 0,
      oldestQueuedAgeMs: active === undefined ? null : now - active.enqueuedAt,
      pendingRecords: this.#pending.length,
      pendingRecordBytes: this.#pendingBytes,
      pendingRecordKind: oldest === undefined ? null : oldest.kind,
      pendingCallbackAgeMs: oldest === undefined ? null : now - oldest.at,
      lastCallbackAgeMs: this.#lastCallbackAt === undefined
        ? null
        : now - this.#lastCallbackAt,
    };
  }

  /** Submits a body, refusing it before enqueueing if its budget is exhausted. */
  send(route: Record<string, unknown>, payload: string | Uint8Array): void {
    requireRouted(!this.#closed);
    const body = typeof payload === "string"
      ? encoder.encode(payload)
      : payload;
    try {
      requireRouted(
        body.length <= ROUTED_RAW_LIMIT &&
          (this.#bytes === 0 || this.#limit === null ||
            this.#bytes + body.length <= this.#limit),
      );
      encodeRouterHeader({
        route,
        bytes: body.length,
        binary: typeof payload !== "string",
      });
    } catch (cause) {
      this.close();
      const error = cause instanceof Error
        ? cause
        : new Error("Router output refused", { cause });
      this.#fail(error);
      throw error;
    }
    this.#bytes += body.length;
    this.#admittedBodies++;
    this.#admittedBytes += body.length;
    const records = this.#records(route, body, typeof payload !== "string");
    this.#queue.push({
      records,
      bytes: body.length,
      enqueuedAt: this.#now(),
      writtenBytes: 0,
    });
    this.#observe?.("enqueue");
    this.#pump();
  }

  /** Releases all pending output and ignores late socket callbacks. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    this.#dispatchedBodies = 0;
    this.#credit = 0;
    this.#bytes = 0;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#drained?.resolve(false);
    this.#drained = undefined;
    this.#observe?.("close");
  }

  /** Yields records using the body's original public WebSocket representation. */
  *#records(
    route: Record<string, unknown>,
    body: Uint8Array,
    binary: boolean,
  ): Generator<Uint8Array> {
    yield encodeRouterHeader({ route, bytes: body.length, binary });
    for (let offset = 0; offset < body.length; offset += ROUTER_CHUNK_BYTES) {
      yield routerRecord(1, body.subarray(offset, offset + ROUTER_CHUNK_BYTES));
    }
    yield routerRecord(2);
  }

  /**
   * Passes records to the socket, in order, while the bytes awaiting callbacks
   * are below the send window. Request credit waiting to be returned goes out
   * before the next body record. Re-entry from a synchronous callback returns to the
   * running loop, which sees the released bytes on its next iteration.
   */
  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (
        !this.#closed && this.#pendingBytes < ROUTER_SEND_WINDOW_BYTES
      ) {
        if (this.#credit > 0) {
          const record = encodeRouterRequestCredit(this.#credit);
          this.#credit = 0;
          this.#write(record, null);
          continue;
        }
        const next = this.#queue[this.#dispatchedBodies];
        if (next === undefined) return;
        const record = next.records.next();
        requireRouted(!record.done);
        const kind = record.value[4];
        if (kind === 2) this.#dispatchedBodies++;
        this.#write(record.value, kind, next);
      }
    } finally {
      this.#pumping = false;
    }
  }

  /** Releases logical credit on the response end callback, independently of ACKs. */
  #completeBody(body: QueuedBody): void {
    // Write callbacks run in write order, so this is the queue head. Removing
    // by identity keeps the accounting right regardless, and a completed
    // body's end record was passed to the socket, so it is in the dispatched
    // prefix.
    const index = this.#queue.indexOf(body);
    requireRouted(index !== -1);
    this.#queue.splice(index, 1);
    this.#dispatchedBodies--;
    this.#bytes -= body.bytes;
    this.#completedBodies++;
    this.#completedBytes += body.bytes;
    if (this.#queue.length === 0) {
      this.#drained?.resolve(true);
      this.#drained = undefined;
    }
    this.#observe?.("complete");
  }

  /** Passes one record of either kind to the socket and accounts for its callback. */
  #write(
    record: Uint8Array,
    recordKind: number | null,
    body?: QueuedBody,
  ): void {
    const pending: PendingRecord = {
      bytes: record.length,
      kind: recordKind,
      at: this.#now(),
    };
    this.#pending.push(pending);
    this.#pendingBytes += pending.bytes;
    this.#dispatchedRecords++;
    this.#dispatchedRecordBytes += pending.bytes;
    let completed = false;
    try {
      this.#send(record, (error) => {
        if (completed) return;
        completed = true;
        if (this.#closed) return;
        const index = this.#pending.indexOf(pending);
        requireRouted(index !== -1);
        this.#pending.splice(index, 1);
        this.#pendingBytes -= pending.bytes;
        this.#lastCallbackAt = this.#now();
        if (error) {
          this.#callbackErrors++;
          this.#observe?.("write-error");
          this.close();
          this.#fail(error);
        } else {
          this.#completedRecords++;
          this.#completedRecordBytes += pending.bytes;
          if (recordKind === 1) body!.writtenBytes += pending.bytes - 5;
          this.#observe?.("callback");
          if (recordKind === 2) this.#completeBody(body!);
          this.#pump();
        }
      });
    } catch (cause) {
      this.#observe?.("write-error");
      this.close();
      this.#fail(
        cause instanceof Error
          ? cause
          : new Error("Router write failed", { cause }),
      );
    }
  }
}
