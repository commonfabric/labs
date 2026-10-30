/**
 * Memory sockets a test opens, closes and fails by hand, for driving a
 * transport's dials with no network under them.
 */

import type {
  MemorySocket,
  MemorySocketConnection,
  MemorySocketFactory,
} from "../../src/storage/memory-socket.ts";

/** One dialed socket, and the events the test fires on it. */
export type ScriptedDial = {
  /** The address the socket was dialed at. */
  address: URL;

  /** Fires `open` on a socket still connecting. */
  open(): void;

  /** Fires `close` on a socket not yet closed. */
  close(): void;

  /** Fires `error` on a socket not yet closed. */
  fail(): void;
};

/** A socket factory, and every socket it has dialed, in dial order. */
export type ScriptedSockets = {
  createSocket: MemorySocketFactory;
  dials: ScriptedDial[];

  /** Resolves once `count` sockets have been dialed. */
  dialed(count: number): Promise<void>;
};

/**
 * Returns a factory whose sockets stay connecting until the test fires an
 * event on them. Closing one from the transport side fires its `close`, as
 * a native socket does. Frames sent on an open socket are dropped.
 */
export function scriptedSockets(): ScriptedSockets {
  const dials: ScriptedDial[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const createSocket: MemorySocketFactory = (address) => {
    const events = new EventTarget();
    let readyState: number = WebSocket.CONNECTING;
    const fire = (type: "open" | "close" | "error", state: number): void => {
      readyState = state;
      events.dispatchEvent(new Event(type));
    };
    const socket: MemorySocket = {
      get readyState() {
        return readyState;
      },
      addEventListener(type, listener, options) {
        events.addEventListener(
          type,
          () => listener({ type, data: undefined }),
          options,
        );
      },
      close() {
        if (readyState === WebSocket.CLOSED) return;
        readyState = WebSocket.CLOSING;
        queueMicrotask(() => fire("close", WebSocket.CLOSED));
      },
    };
    const dial: ScriptedDial = {
      address,
      open: () => {
        if (readyState !== WebSocket.CONNECTING) {
          throw new Error("Only a connecting socket opens");
        }
        fire("open", WebSocket.OPEN);
      },
      close: () => {
        if (readyState === WebSocket.CLOSED) {
          throw new Error("The socket is already closed");
        }
        fire("close", WebSocket.CLOSED);
      },
      fail: () => {
        if (readyState === WebSocket.CLOSED) {
          throw new Error("The socket is already closed");
        }
        fire("error", WebSocket.CLOSED);
      },
    };
    dials.push(dial);
    for (const waiter of waiters.filter((w) => w.count <= dials.length)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    const connection: MemorySocketConnection = { socket, send: () => {} };
    return connection;
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
