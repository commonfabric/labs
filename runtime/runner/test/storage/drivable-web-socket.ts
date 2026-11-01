/**
 * A WebSocket stand-in that a test opens, closes, and errors by hand, and a
 * socket factory that dials one per address.
 */

import type {
  EncodedMemoryMessage,
  MemoryMessageFrame,
} from "@commonfabric/memory/v2/message-compression";

import type {
  MemorySocket,
  MemorySocketFactory,
} from "../../src/storage/memory-socket.ts";

/**
 * A socket that stays connecting until the test opens it, and receives,
 * fails, or closes only when the test says. Each event is dispatched
 * synchronously, so a transport's handler for it has run when the call
 * returns. Its state is plain properties, as the transport reads and writes
 * a native socket's.
 */
export class DrivableWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: DrivableWebSocket[] = [];
  readyState = DrivableWebSocket.CONNECTING;
  bufferedAmount = 0;
  /** Models native buffering, drained only by an explicit peer event. */
  trackBuffer = false;

  /** Largest observed native queue. */
  peakBuffer = 0;

  /** Peer notification when a frame enters the native queue. */
  onSend?: (payload: EncodedMemoryMessage) => void;

  binaryType: BinaryType = "blob";
  readonly sent: EncodedMemoryMessage[] = [];
  #sentWaiters: Array<{ count: number; resolve: () => void }> = [];
  constructor(readonly url: string | URL) {
    super();
    DrivableWebSocket.instances.push(this);
  }
  send(payload: EncodedMemoryMessage): void {
    if (this.trackBuffer) {
      this.bufferedAmount += typeof payload === "string"
        ? new TextEncoder().encode(payload).length
        : payload.length;
      this.peakBuffer = Math.max(this.peakBuffer, this.bufferedAmount);
    }
    this.sent.push(payload);
    this.onSend?.(payload);
    this.#sentWaiters = this.#sentWaiters.filter((waiter) => {
      if (this.sent.length >= waiter.count) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  }
  whenSent(count: number): Promise<void> {
    if (this.sent.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.#sentWaiters.push({ count, resolve }));
  }
  openConnection(): void {
    this.readyState = DrivableWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  receive(payload: MemoryMessageFrame): void {
    this.dispatchEvent(new MessageEvent("message", { data: payload }));
  }
  fail(error: Error): void {
    this.dispatchEvent(new ErrorEvent("error", { error }));
  }
  close(): void {
    this.readyState = DrivableWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

/** A socket factory of `DrivableWebSocket`s, and every socket it has dialed. */
export type DrivableSockets = {
  createSocket: MemorySocketFactory;

  /** Every socket dialed so far, in dial order. */
  dials: DrivableWebSocket[];

  /** Resolves once `count` sockets have been dialed. */
  dialed(count: number): Promise<void>;
};

/** Returns a socket factory that dials a `DrivableWebSocket` per address. */
export function drivableSockets(): DrivableSockets {
  const dials: DrivableWebSocket[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const createSocket: MemorySocketFactory = (address) => {
    const socket = new DrivableWebSocket(address);
    dials.push(socket);
    for (const waiter of waiters.filter((w) => w.count <= dials.length)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    return {
      socket: socket as MemorySocket,
      send: (frame) => socket.send(frame),
    };
  };
  return {
    createSocket,
    dials,
    dialed: (count) => {
      if (dials.length >= count) return Promise.resolve();
      const waiter = Promise.withResolvers<void>();
      waiters.push({ count, resolve: waiter.resolve });
      return waiter.promise;
    },
  };
}
