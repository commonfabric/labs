/** Socket selection and the event surface used by the memory transport. */

import type { EncodedMemoryMessage } from "@commonfabric/memory/v2/message-compression";
import { isDeno } from "@commonfabric/utils/env";

/** Event fields consumed by the memory transport. */
export interface MemorySocketEvents {
  /** Connection establishment. */
  open: { type: string };

  /** Connection termination. */
  close: { type: string };

  /** One complete incoming frame, validated by the compression channel. */
  message: { type: string; data: unknown };

  /** Transport failure, with its cause when the backend provides one. */
  error: { type: string; error?: unknown };
}

/** Common event and lifecycle surface of native and Node WebSockets. */
export interface MemorySocket {
  /** WebSocket connection state. */
  readonly readyState: number;

  /** Registers a listener using WebSocket event names. */
  addEventListener<K extends keyof MemorySocketEvents>(
    type: K,
    listener: (event: MemorySocketEvents[K]) => void,
    options?: { once?: boolean },
  ): void;

  /** Starts the close handshake, or cancels a connection still opening. */
  close(code?: number, reason?: string): void;
}

/** A socket with its backend's send-completion contract. */
export interface MemorySocketConnection {
  /** Socket whose binary messages arrive as `ArrayBuffer`s. */
  readonly socket: MemorySocket;

  /**
   * Submits one frame. A promise awaits local write completion where the
   * backend exposes it; neither form acknowledges the peer's processing.
   */
  send(frame: EncodedMemoryMessage): void | Promise<void>;
}

/** Constructs an unopened connection with listeners attachable immediately. */
export type MemorySocketFactory = (address: URL) => MemorySocketConnection;

// The Node backend can only be evaluated in Deno. Loading it before socket
// creation keeps construction synchronous, including listener registration.
const denoFactory = isDeno()
  // deno-lint-ignore cf-imports/no-inline-module-import
  ? (await import("./memory-socket.deno.ts")).createDenoMemorySocket
  : undefined;

/** Opens a native WebSocket for a browser or a plain TCP connection. */
export function createNativeMemorySocket(address: URL): MemorySocketConnection {
  const socket = new WebSocket(address);
  socket.binaryType = "arraybuffer";
  return { socket, send: (frame) => socket.send(frame) };
}

/** Opens a memory socket, using Node TLS for Deno's secure connections. */
export function createMemorySocket(address: URL): MemorySocketConnection {
  // Deno's native TLS WebSocket writer can finish with buffered ciphertext
  // and no surviving write future to drain it.
  // TODO(gideon): Remove the Node backend once the pinned Deno flushes frames.
  return denoFactory && address.protocol === "wss:"
    ? denoFactory(address)
    : createNativeMemorySocket(address);
}
