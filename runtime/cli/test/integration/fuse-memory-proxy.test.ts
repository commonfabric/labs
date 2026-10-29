/** Tests frame relay and trace ordering in the FUSE memory proxy. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "@commonfabric/memory/v2";
import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  type MemoryMessageFrame,
} from "@commonfabric/memory/v2/message-compression";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import {
  type RelayFrame,
  startFuseMemoryProxy,
  TraceBeforeRelayQueue,
} from "../../integration/fuse-memory-proxy.ts";

describe("fuse-memory-proxy", () => {
  it("persists a trace before relaying its upstream frame", async () => {
    const queue = new TraceBeforeRelayQueue();
    const traceStarted = Promise.withResolvers<void>();
    const finishTrace = Promise.withResolvers<void>();
    const events: string[] = [];

    queue.enqueue(
      "frame",
      async () => {
        events.push("trace started");
        traceStarted.resolve();
        await finishTrace.promise;
        events.push("trace persisted");
      },
      () => events.push("frame relayed"),
      (cause) => {
        throw cause;
      },
    );

    await traceStarted.promise;
    expect(events).toEqual(["trace started"]);
    finishTrace.resolve();
    await queue.idle();
    expect(events).toEqual([
      "trace started",
      "trace persisted",
      "frame relayed",
    ]);
  });

  it("continues relaying after a trace failure", async () => {
    const queue = new TraceBeforeRelayQueue();
    const relayed: string[] = [];
    const errors: unknown[] = [];
    const appendTrace = (frame: RelayFrame) => {
      if (frame === "bad") throw new Error("trace write failed");
      return Promise.resolve();
    };
    const relay = (frame: RelayFrame) => {
      if (typeof frame !== "string") throw new Error("expected text frame");
      relayed.push(frame);
    };
    const onError = (cause: unknown) => errors.push(cause);

    queue.enqueue("bad", appendTrace, relay, onError);
    queue.enqueue("good-1", appendTrace, relay, onError);
    queue.enqueue("good-2", appendTrace, relay, onError);
    await queue.idle();

    expect(relayed).toEqual(["good-1", "good-2"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(new Error("trace write failed"));
  });

  it("relays binary frames and records their expanded text", async () => {
    const directory = await Deno.makeTempDir();
    const tracePath = `${directory}/memory-frames`;
    const upstream = StandaloneMemoryServer.start();
    const proxy = startFuseMemoryProxy(new URL(upstream.url), tracePath);
    const address = proxy.server.addr as Deno.NetAddr;
    const socket = new WebSocket(`ws://${address.hostname}:${address.port}`);
    socket.binaryType = "arraybuffer";
    try {
      await opened(socket);
      const helloReply = nextMessage(socket);
      socket.send(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: getMemoryProtocolFlags(),
      }));
      const helloFrame = await helloReply;
      expect(typeof helloFrame).toBe("string");

      const marker = "fuse-binary-trace-marker-".repeat(100);
      const response = nextMessage(socket);
      // Drive the binary relay explicitly instead of depending on the shape or
      // compression ratio of the upstream response.
      const requestFrame = await encodeCompressedMemoryMessage(
        encodeMemoryBoundary({
          type: "session.open",
          requestId: marker,
          space: "did:key:z6Mk-fuse-memory-proxy-test",
          session: {},
        }),
      );
      expect(requestFrame).toBeInstanceOf(Uint8Array);
      socket.send(requestFrame);
      const responseFrame = await response;
      expect(
        decodeMemoryBoundary<{ requestId: string }>(
          await decodeCompressedMemoryMessage(responseFrame),
        ).requestId,
      ).toBe(marker);

      await proxy.idle();
      expect(await Deno.readTextFile(tracePath)).toContain(marker);
    } finally {
      await closeSocket(socket);
      await proxy.server.shutdown();
      await upstream.close();
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("records each upstream frame before forwarding it", async () => {
    const directory = await Deno.makeTempDir();
    const tracePath = `${directory}/memory-frames`;
    const upstream = StandaloneMemoryServer.start();
    const proxy = startFuseMemoryProxy(new URL(upstream.url), tracePath);
    const address = proxy.server.addr as Deno.NetAddr;
    const socket = new WebSocket(`ws://${address.hostname}:${address.port}`);
    socket.binaryType = "arraybuffer";
    try {
      await opened(socket);
      const helloReply = nextMessage(socket);
      socket.send(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: getMemoryProtocolFlags(),
      }));
      await helloReply;

      // The large, compressible identifier makes the upstream wire response
      // small while its trace append remains substantial, exposing a relay
      // that forwards before awaiting expansion and persistence.
      const marker = `fuse-trace-order-${"x".repeat(2 * 1_024 * 1_024)}`;
      const response = nextMessage(socket);
      socket.send(
        await encodeCompressedMemoryMessage(encodeMemoryBoundary({
          type: "session.open",
          requestId: marker,
          space: "did:key:z6Mk-fuse-memory-proxy-trace-order-test",
          session: {},
        })),
      );
      const responseFrame = await response;
      expect(
        decodeMemoryBoundary<{ requestId: string }>(
          await decodeCompressedMemoryMessage(responseFrame),
        ).requestId,
      ).toBe(marker);

      // Receiving the response is the completion barrier used by FUSE. The
      // corresponding trace entry must already be durable at this point.
      expect(await Deno.readTextFile(tracePath)).toContain(marker);
    } finally {
      await closeSocket(socket);
      await proxy.server.shutdown();
      await upstream.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
});

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("open failed")), {
      once: true,
    });
  });
}

function nextMessage(socket: WebSocket): Promise<MemoryMessageFrame> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup();
      const frame = event.data;
      if (
        typeof frame === "string" || frame instanceof ArrayBuffer ||
        frame instanceof Uint8Array || frame instanceof Blob
      ) {
        resolve(frame);
      } else {
        reject(new Error("invalid memory frame"));
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("receive failed"));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState >= WebSocket.CLOSING) return;
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });
  socket.close();
  await closed;
}
