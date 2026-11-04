import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { StorageNetworkGate } from "./storage-network-gate.ts";

describe("storage network gate", () => {
  it("forwards HTTP requests with the target host and original body", async () => {
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, async (request) =>
      Response.json({
        host: request.headers.get("host"),
        path: new URL(request.url).pathname,
        query: new URL(request.url).search,
        method: request.method,
        body: await request.text(),
      }));
    const gate = new StorageNetworkGate(
      new URL(`http://127.0.0.1:${server.addr.port}`),
    );
    try {
      const response = await fetch(new URL("inspect?case=host", gate.url), {
        method: "POST",
        body: "relay payload",
      });
      expect(await response.json()).toEqual({
        host: `127.0.0.1:${server.addr.port}`,
        path: "/inspect",
        query: "?case=host",
        method: "POST",
        body: "relay payload",
      });
    } finally {
      await gate.close();
      await server.shutdown();
    }
  });

  it("closes a connecting upstream when its reader disconnects", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<WebSocket>();
    const downstreamClosed = Promise.withResolvers<void>();
    const NativeWebSocket = WebSocket;
    const nativeUpgrade = Deno.upgradeWebSocket;
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, async () => {
      entered.resolve();
      await release.promise;
      return new Response("Handshake held by test", { status: 503 });
    });
    const gate = new StorageNetworkGate(
      new URL(`http://127.0.0.1:${server.addr.port}`),
    );
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(...args: ConstructorParameters<typeof NativeWebSocket>) {
        super(...args);
        captured.resolve(this);
      }
    };
    const upgrade = stub(Deno, "upgradeWebSocket", (request, options) => {
      const result = nativeUpgrade(request, options);
      result.socket.addEventListener(
        "close",
        () => downstreamClosed.resolve(),
        {
          once: true,
        },
      );
      return result;
    });
    const url = gate.url;
    url.protocol = "ws:";
    const reader = new NativeWebSocket(url);
    try {
      await new Promise<void>((resolve, reject) => {
        reader.addEventListener("open", () => resolve(), { once: true });
        reader.addEventListener(
          "error",
          () => reject(new Error("Reader failed")),
          {
            once: true,
          },
        );
      });
      await entered.promise;
      const upstream = await captured.promise;
      expect(upstream.readyState).toBe(WebSocket.CONNECTING);
      const upstreamClosed = new Promise<void>((resolve) => {
        upstream.addEventListener("close", () => resolve(), { once: true });
      });
      reader.close();
      await downstreamClosed.promise;
      expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(
        upstream.readyState,
      );
      await upstreamClosed;
      expect(upstream.readyState).toBe(WebSocket.CLOSED);
    } finally {
      reader.close();
      globalThis.WebSocket = NativeWebSocket;
      upgrade.restore();
      try {
        await gate.close();
      } finally {
        release.resolve();
        await server.shutdown();
      }
    }
  });
});
