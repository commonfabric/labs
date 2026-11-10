import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
// deno-lint-ignore no-external-import -- Deno types this builtin by its node: specifier.
import { Socket } from "node:net";

import {
  createMemorySocket,
  type MemorySocket,
} from "../../src/storage/memory-socket.ts";

/** Resolves once `socket` opens, and rejects with its error if it fails. */
function opened(socket: MemorySocket): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", (event) => reject(event.error), {
    once: true,
  });
  return promise;
}

/** Closes `socket` and resolves once its close handshake has finished. */
function closed(socket: MemorySocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.addEventListener("close", () => resolve(), { once: true });
  socket.close();
  return promise;
}

describe("createMemorySocket()", () => {
  it("turns Nagle's algorithm off for a plain `ws:` connection", async () => {
    // With Nagle's algorithm on, a frame written as a header and then a
    // payload holds the payload until the peer acknowledges the header, which
    // a peer delaying its acknowledgments takes tens of milliseconds to do.

    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => Deno.upgradeWebSocket(request).response,
    );
    const setNoDelay = spy(Socket.prototype, "setNoDelay");
    try {
      const { socket } = createMemorySocket(
        new URL(`ws://127.0.0.1:${server.addr.port}/`),
      );
      await opened(socket);
      // `setNoDelay()` with no argument turns the option on.
      expect(setNoDelay.calls.map((call) => call.args[0] ?? true)).toEqual([
        true,
      ]);
      await closed(socket);
    } finally {
      setNoDelay.restore();
      await server.shutdown();
    }
  });
});
