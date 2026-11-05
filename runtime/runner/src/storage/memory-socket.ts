/** Socket selection and the event surface used by the memory transport. */

import type { EncodedMemoryMessage } from "@commonfabric/memory/v2/message-compression";
import { isDeno } from "@commonfabric/platform/env";

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

  /**
   * Bytes queued for the network and not yet written, where the backend
   * reports them; the sizes read shows them as what a slow peer holds up.
   */
  readonly bufferedAmount?: number;

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

/** Opens a native WebSocket, the backend a browser uses for every address. */
export function createNativeMemorySocket(address: URL): MemorySocketConnection {
  const socket = new WebSocket(address);
  socket.binaryType = "arraybuffer";
  return { socket, send: (frame) => socket.send(frame) };
}

/** Opens a memory socket, using Deno's Node networking stack under Deno. */
export function createMemorySocket(address: URL): MemorySocketConnection {
  // Deno's native WebSocket client fails memory traffic both ways. Over TLS
  // its writer can finish with buffered ciphertext and no surviving write
  // future to drain it. Over plain TCP it leaves Nagle's algorithm on and
  // writes a frame of more than 1,024 bytes as a header and then a payload,
  // so the payload waits for the peer's delayed acknowledgment of the header,
  // about 40 milliseconds on Linux.
  // TODO(gideon): Remove the Node backend once the pinned Deno flushes frames
  // and its native WebSocket can disable Nagle's algorithm and enable TCP
  // keepalive.
  return denoFactory ? denoFactory(address) : createNativeMemorySocket(address);
}
