import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createNativeMemorySocket } from "../../src/storage/memory-socket.ts";
import {
  MemoryDialLimiter,
  ROUTED_FRAME_SLOTS,
  WebSocketTransport,
} from "../../src/storage/v2-remote-session.ts";
import {
  type ScriptedDial,
  type ScriptedSockets,
  scriptedSockets,
} from "./scripted-memory-socket.ts";

describe("WebSocketTransport", () => {
  it("receives a large native frame with a null limit and rejects it after the limit is omitted", async () => {
    const frame = `fvj1:${
      JSON.stringify({
        type: "response",
        requestId: "large",
        ok: Array.from({ length: ROUTED_FRAME_SLOTS }, (_, i) => i),
      })
    }`;
    const peerClosed = Promise.withResolvers<void>();
    const socketClosed = Promise.withResolvers<void>();
    let peer: WebSocket | undefined;
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request, {
        idleTimeout: 0,
      });
      peer = socket;
      socket.addEventListener("close", () => peerClosed.resolve());
      socket.addEventListener("message", (event) => {
        if (event.data !== "hello") socket.send(frame);
      });
      return response;
    });
    const transport = new WebSocketTransport(
      new URL(`ws://127.0.0.1:${server.addr.port}/memory`),
      true,
      () => {},
      (address) => {
        const connection = createNativeMemorySocket(address);
        connection.socket.addEventListener(
          "close",
          () => socketClosed.resolve(),
        );
        return connection;
      },
    );
    const received: string[] = [];
    const delivered = Promise.withResolvers<void>();
    const rejected = Promise.withResolvers<Error | undefined>();
    transport.setReceiver((payload) => {
      received.push(payload);
      delivered.resolve();
    });
    transport.setCloseReceiver(rejected.resolve);
    try {
      await transport.send("hello");
      transport.setRoutedMessagesEnabled(true, undefined, undefined, null);
      await transport.send('fvj1:{"type":"graph.query"}');
      await Promise.race([
        delivered.promise,
        rejected.promise.then((error) => {
          throw error ?? new Error("Socket closed before delivery");
        }),
      ]);
      expect(received).toEqual([frame]);
      transport.setRoutedMessagesEnabled(true);
      await transport.send('fvj1:{"type":"graph.query"}');
      expect(await rejected.promise).toMatchObject({
        cause: { message: "Routed memory request denied" },
      });
      await socketClosed.promise;
      expect(received).toEqual([frame]);
    } finally {
      await transport.close();
      peer?.close();
      await Promise.all([socketClosed.promise, peerClosed.promise]);
      await server.shutdown();
    }
  });

  it("closes a native socket on a routed decode failure and reports the cause once", async () => {
    const frame = `fvj1:${
      JSON.stringify({
        type: "session.sync",
        values: Array(ROUTED_FRAME_SLOTS).fill(null),
      })
    }`;
    const peerClosed = Promise.withResolvers<CloseEvent>();
    const peers: WebSocket[] = [];
    const peerClosures: Promise<void>[] = [];
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request, {
        idleTimeout: 0,
      });
      peers.push(socket);
      peerClosures.push(
        new Promise((resolve) => {
          socket.addEventListener("close", (event) => {
            peerClosed.resolve(event);
            resolve();
          }, { once: true });
        }),
      );
      socket.addEventListener("message", (event) => {
        if (event.data === 'fvj1:{"type":"graph.query"}') {
          socket.send(frame);
          socket.send(frame);
        }
      });
      return response;
    });
    const closeAttempt = Promise.withResolvers<unknown>();
    const sockets: WebSocket[] = [];
    const cleanupSockets: (() => void)[] = [];
    const socketClosures: Promise<void>[] = [];
    const transport = new WebSocketTransport(
      new URL(`ws://127.0.0.1:${server.addr.port}/memory`),
      true,
      () => {},
      (address) => {
        const socket = new WebSocket(address);
        sockets.push(socket);
        socketClosures.push(
          new Promise((resolve) => {
            socket.addEventListener("close", () => resolve(), { once: true });
          }),
        );
        const close = socket.close.bind(socket);
        cleanupSockets.push(() => close());
        socket.close = (code, reason) => {
          // The native method enforces close-code restrictions. Capture its
          // exception so the assertion fails without an unhandled error.
          try {
            close(code, reason);
            closeAttempt.resolve(undefined);
          } catch (error) {
            closeAttempt.resolve(error);
          }
        };
        return { socket, send: (payload) => socket.send(payload) };
      },
    );
    const errors: (Error | undefined)[] = [];
    const received: string[] = [];
    transport.setCloseReceiver((error) => errors.push(error));
    transport.setReceiver((payload) => received.push(payload));
    try {
      await transport.send("hello");
      transport.setRoutedMessagesEnabled(true);
      await transport.send('fvj1:{"type":"graph.query"}');
      expect(await closeAttempt.promise).toBeUndefined();
      const closed = await peerClosed.promise;
      await socketClosures[0];
      expect(closed.code).toBe(4007);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect(errors[0]?.message).toBe(
        "Unable to decode compressed memory websocket message",
      );
      expect(errors[0]?.cause).toBeInstanceOf(Error);
      expect(errors[0]?.cause).toMatchObject({
        message: "Routed memory request denied",
      });
      expect(closed.reason).toBe(errors[0]?.message);
      expect(received).toEqual([]);

      await transport.send("reconnected");
      expect(sockets).toHaveLength(2);
      expect(errors).toHaveLength(1);
    } finally {
      await transport.close();
      for (const close of cleanupSockets) close();
      for (const peer of peers) peer.close();
      await Promise.all([...socketClosures, ...peerClosures]);
      await server.shutdown();
    }
  });

  describe("dials", () => {
    // `send()` reaches its transport's dial before it first waits, so every
    // dial the limiter admits is in `dials` by the time `send()` returns.

    /** A transport per space at `origin`, all dialing through `limiter`. */
    const transportsFor = (
      sockets: ScriptedSockets,
      limiter: MemoryDialLimiter,
      origin: string,
      spaces: string[],
    ): WebSocketTransport[] =>
      spaces.map((space) =>
        new WebSocketTransport(
          new URL(`${origin}/api/storage/memory?space=${space}`),
          true,
          () => {},
          sockets.createSocket,
          limiter,
        )
      );

    /** Sends on each transport, and returns how each send settled. */
    const sendOn = (
      transports: WebSocketTransport[],
    ): Promise<"sent" | Error>[] =>
      transports.map((transport) =>
        transport.send("hello").then(() => "sent" as const, (error) => error)
      );

    /** The space each dial so far names. */
    const dialedSpaces = (sockets: ScriptedSockets): (string | null)[] =>
      sockets.dials.map((dial) => dial.address.searchParams.get("space"));

    const events: [string, (dial: ScriptedDial) => void][] = [
      ["opens", (dial) => dial.open()],
      ["closes", (dial) => dial.close()],
      ["fails", (dial) => dial.fail()],
    ];
    for (const [event, fire] of events) {
      it(`starts a host's next dial once a dial in flight ${event}`, async () => {
        const sockets = scriptedSockets();
        const transports = transportsFor(
          sockets,
          new MemoryDialLimiter(2),
          "ws://memory.test",
          ["one", "two", "three"],
        );
        const sends = sendOn(transports);
        try {
          expect(dialedSpaces(sockets)).toEqual(["one", "two"]);
          fire(sockets.dials[1]);
          await sockets.dialed(3);
          expect(dialedSpaces(sockets)).toEqual(["one", "two", "three"]);
        } finally {
          await Promise.all(transports.map((transport) => transport.close()));
          await Promise.all(sends);
        }
      });
    }

    it("dials another host while one host's dials wait", async () => {
      const sockets = scriptedSockets();
      const limiter = new MemoryDialLimiter(1);
      const transports = [
        ...transportsFor(sockets, limiter, "ws://memory.test", ["one", "two"]),
        ...transportsFor(sockets, limiter, "ws://other.test", ["three"]),
      ];
      const sends = sendOn(transports);
      try {
        expect(dialedSpaces(sockets)).toEqual(["one", "three"]);
      } finally {
        await Promise.all(transports.map((transport) => transport.close()));
        await Promise.all(sends);
      }
    });

    it("refuses a send whose dial is waiting when its transport closes, and never dials it", async () => {
      const sockets = scriptedSockets();
      const transports = transportsFor(
        sockets,
        new MemoryDialLimiter(1),
        "ws://memory.test",
        ["one", "two", "three"],
      );
      const sends = sendOn(transports);
      try {
        await transports[1].close();
        expect(await sends[1]).toMatchObject({
          name: "ConnectionError",
          message: "Memory transport closed",
        });
        sockets.dials[0].close();
        await sockets.dialed(2);
        expect(dialedSpaces(sockets)).toEqual(["one", "three"]);
      } finally {
        await Promise.all(transports.map((transport) => transport.close()));
        await Promise.all(sends);
      }
    });
  });
});
