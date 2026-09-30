// @ts-types="@types/ws"
import { WebSocket } from "ws";

import type { MemorySocketConnection } from "./memory-socket.ts";

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
  return {
    socket,
    send: (frame) =>
      new Promise<void>((resolve, reject) => {
        socket.send(frame, (error) => error ? reject(error) : resolve());
      }),
  };
}
