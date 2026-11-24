import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
// deno-lint-ignore no-external-import -- Deno types this builtin by its node: specifier.
import { Socket } from "node:net";

import {
  createDenoMemorySocket,
  MEMORY_SOCKET_KEEPALIVE_IDLE_MS,
} from "../../src/storage/memory-socket.deno.ts";

describe("createDenoMemorySocket()", () => {
  it("turns on TCP keepalive for the connection it opens", async () => {
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => Deno.upgradeWebSocket(request).response,
    );
    const setKeepAlive = spy(Socket.prototype, "setKeepAlive");
    try {
      const { socket } = createDenoMemorySocket(
        new URL(`ws://127.0.0.1:${server.addr.port}/`),
      );
      const opened = Promise.withResolvers<void>();
      socket.addEventListener("open", () => opened.resolve(), { once: true });
      socket.addEventListener(
        "error",
        (event) => opened.reject(event.error),
        { once: true },
      );
      await opened.promise;
      expect(setKeepAlive.calls.map((call) => call.args)).toEqual([
        [true, MEMORY_SOCKET_KEEPALIVE_IDLE_MS],
      ]);
      const closed = Promise.withResolvers<void>();
      socket.addEventListener("close", () => closed.resolve(), { once: true });
      socket.close();
      await closed.promise;
    } finally {
      setKeepAlive.restore();
      await server.shutdown();
    }
  });
});
