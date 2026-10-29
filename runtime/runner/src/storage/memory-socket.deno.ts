// @ts-types="@types/ws"
import { WebSocket } from "ws";

import type { MemorySocketConnection } from "./memory-socket.ts";

/**
 * How long a connection carries nothing before the operating system starts
 * sending TCP keepalive probes on it. When the probes go unanswered, the
 * kernel fails the socket and the memory client reconnects, so a peer that
 * vanished without closing the connection (a dead network path, a host that
 * slept) does not leave the client waiting forever for frames.
 */
export const MEMORY_SOCKET_KEEPALIVE_IDLE_MS = 30_000;

/** Opens a memory WebSocket whose writes are driven by Deno's Node TLS stack. */
export function createDenoMemorySocket(address: URL): MemorySocketConnection {
  const socket = new WebSocket(address, {
    // Fabric negotiates compression in its own message envelope.
    perMessageDeflate: false,
    // The compression decoder owns the expanded-message bound. Native sockets
    // impose no extra wire-size limit on uncompressed memory messages.
    maxPayload: 0,
  });
  socket.binaryType = "arraybuffer";
  socket.on("upgrade", (response) => {
    response.socket.setKeepAlive(true, MEMORY_SOCKET_KEEPALIVE_IDLE_MS);
  });
  return {
    socket,
    send: (frame) =>
      new Promise<void>((resolve, reject) => {
        socket.send(frame, (error) => error ? reject(error) : resolve());
      }),
  };
}
