/** Tests compression negotiation on the standalone memory WebSocket host. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "../../v2.ts";
import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  encodeMemoryCompressionControlMessage,
  type MemoryMessageFrame,
  parseMemoryCompressionControlMessage,
} from "../../v2/message-compression.ts";
import { StandaloneMemoryServer } from "../../v2/standalone.ts";

describe("standalone memory compression", () => {
  it("requires hello before accepting a compression control", async () => {
    const server = StandaloneMemoryServer.start();
    const address = new URL(server.url);
    address.protocol = "ws:";
    const socket = new WebSocket(address);
    socket.binaryType = "arraybuffer";
    try {
      await opened(socket);
      const reply = nextMessage(socket);
      socket.send(encodeMemoryCompressionControlMessage({
        requestId: "control-before-hello",
        enabled: false,
      }));
      const frame = await reply;
      expect(typeof frame).toBe("string");
      if (typeof frame !== "string") {
        throw new Error("Expected text protocol error");
      }
      expect(parseMemoryCompressionControlMessage(frame)).toBeNull();
      expect(decodeMemoryBoundary<{
        type: string;
        error?: { name: string };
      }>(frame)).toMatchObject({
        type: "response",
        error: { name: "InvalidMessageError" },
      });
    } finally {
      await closeSocket(socket);
      await server.close();
    }
  });

  it("exchanges compressed messages after an ordinary hello", async () => {
    const server = StandaloneMemoryServer.start();
    const address = new URL(server.url);
    address.protocol = "ws:";
    const socket = new WebSocket(address);
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
      if (typeof helloFrame !== "string") {
        throw new Error("Expected text hello reply");
      }
      expect(decodeMemoryBoundary<{ type: string }>(helloFrame).type).toBe(
        "hello.ok",
      );

      const requestId = "standalone-compressed-session-open-".repeat(100);
      const response = nextMessage(socket);
      socket.send(
        await encodeCompressedMemoryMessage(encodeMemoryBoundary({
          type: "session.open",
          requestId,
          space: "did:key:z6Mk-standalone-compression-test",
          session: {},
        })),
      );
      const responseFrame = await response;
      expect(responseFrame).toBeInstanceOf(ArrayBuffer);
      expect(
        decodeMemoryBoundary<{ requestId: string }>(
          await decodeCompressedMemoryMessage(responseFrame),
        ).requestId,
      ).toBe(requestId);
    } finally {
      if (socket.readyState < WebSocket.CLOSING) {
        const closed = new Promise<void>((resolve) => {
          socket.addEventListener("close", () => resolve(), { once: true });
        });
        socket.close();
        await closed;
      }
      await server.close();
    }
  });

  it("keeps messages textual when the client omits the capability", async () => {
    const server = StandaloneMemoryServer.start();
    const address = new URL(server.url);
    address.protocol = "ws:";
    const socket = new WebSocket(address);
    socket.binaryType = "arraybuffer";
    try {
      await opened(socket);
      const helloReply = nextMessage(socket);
      socket.send(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: {
          ...getMemoryProtocolFlags(),
          messageCompressionV1: false,
        },
      }));
      expect(typeof await helloReply).toBe("string");

      const requestId = "standalone-text-session-open-".repeat(100);
      const response = nextMessage(socket);
      socket.send(encodeMemoryBoundary({
        type: "session.open",
        requestId,
        space: "did:key:z6Mk-standalone-text-test",
        session: {},
      }));
      const responseFrame = await response;
      expect(typeof responseFrame).toBe("string");
      if (typeof responseFrame !== "string") {
        throw new Error("Expected text response");
      }
      expect(
        decodeMemoryBoundary<{ requestId: string }>(responseFrame).requestId,
      ).toBe(requestId);

      const enabledReply = nextMessage(socket);
      socket.send(encodeMemoryCompressionControlMessage({
        requestId: "standalone-enable-control",
        enabled: true,
      }));
      const enabledFrame = await enabledReply;
      expect(typeof enabledFrame).toBe("string");
      if (typeof enabledFrame !== "string") {
        throw new Error("Expected text compression control");
      }
      expect(parseMemoryCompressionControlMessage(enabledFrame)?.enabled).toBe(
        false,
      );
    } finally {
      await closeSocket(socket);
      await server.close();
    }
  });

  it("changes compression without reconnecting", async () => {
    const server = StandaloneMemoryServer.start();
    const address = new URL(server.url);
    address.protocol = "ws:";
    const socket = new WebSocket(address);
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

      const controlReply = nextMessage(socket);
      socket.send(encodeMemoryCompressionControlMessage({
        requestId: "standalone-debug-control",
        enabled: false,
      }));
      const controlFrame = await controlReply;
      expect(typeof controlFrame).toBe("string");
      if (typeof controlFrame !== "string") {
        throw new Error("Expected text compression control");
      }
      expect(parseMemoryCompressionControlMessage(controlFrame)).toEqual({
        type: "memory.compression",
        requestId: "standalone-debug-control",
        enabled: false,
      });

      const requestId = "standalone-visible-session-open-".repeat(100);
      const response = nextMessage(socket);
      socket.send(encodeMemoryBoundary({
        type: "session.open",
        requestId,
        space: "did:key:z6Mk-standalone-visible-compression-test",
        session: {},
      }));
      const responseFrame = await response;
      expect(typeof responseFrame).toBe("string");
      if (typeof responseFrame !== "string") {
        throw new Error("Expected text response after disabling compression");
      }
      expect(
        decodeMemoryBoundary<{ requestId: string }>(responseFrame).requestId,
      ).toBe(requestId);

      const enabledReply = nextMessage(socket);
      socket.send(encodeMemoryCompressionControlMessage({
        requestId: "standalone-enable-control",
        enabled: true,
      }));
      const enabledFrame = await enabledReply;
      expect(typeof enabledFrame).toBe("string");
      if (typeof enabledFrame !== "string") {
        throw new Error("Expected text compression control");
      }
      expect(parseMemoryCompressionControlMessage(enabledFrame)?.enabled).toBe(
        true,
      );

      const compressedRequestId = "standalone-restored-session-open-".repeat(
        100,
      );
      const compressedResponse = nextMessage(socket);
      socket.send(
        await encodeCompressedMemoryMessage(encodeMemoryBoundary({
          type: "session.open",
          requestId: compressedRequestId,
          space: "did:key:z6Mk-standalone-restored-compression-test",
          session: {},
        })),
      );
      const compressedResponseFrame = await compressedResponse;
      expect(compressedResponseFrame).toBeInstanceOf(ArrayBuffer);
      expect(
        decodeMemoryBoundary<{ requestId: string }>(
          await decodeCompressedMemoryMessage(compressedResponseFrame),
        ).requestId,
      ).toBe(compressedRequestId);
    } finally {
      await closeSocket(socket);
      await server.close();
    }
  });

  it("closes with 1003 for binary data without negotiated compression", async () => {
    const server = StandaloneMemoryServer.start();
    const address = new URL(server.url);
    address.protocol = "ws:";
    const socket = new WebSocket(address);
    socket.binaryType = "arraybuffer";
    try {
      await opened(socket);
      const helloReply = nextMessage(socket);
      socket.send(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: {
          ...getMemoryProtocolFlags(),
          messageCompressionV1: false,
        },
      }));
      await helloReply;

      const closed = new Promise<CloseEvent>((resolve) => {
        socket.addEventListener("close", resolve, { once: true });
      });
      socket.send(
        await encodeCompressedMemoryMessage("unexpected binary ".repeat(200)),
      );
      expect((await closed).code).toBe(1003);
    } finally {
      await closeSocket(socket);
      await server.close();
    }
  });

  it("closes with 1003 for binary data before hello", async () => {
    const server = StandaloneMemoryServer.start();
    const address = new URL(server.url);
    address.protocol = "ws:";
    const socket = new WebSocket(address);
    try {
      await opened(socket);
      const closed = new Promise<CloseEvent>((resolve) => {
        socket.addEventListener("close", resolve, { once: true });
      });
      socket.send(new Uint8Array([1, 2, 3]));

      expect((await closed).code).toBe(1003);
    } finally {
      await closeSocket(socket);
      await server.close();
    }
  });

  it("closes with 1011 for an invalid negotiated envelope", async () => {
    const server = StandaloneMemoryServer.start();
    const address = new URL(server.url);
    address.protocol = "ws:";
    const socket = new WebSocket(address);
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
      await server.idle();

      const closed = new Promise<CloseEvent>((resolve) => {
        socket.addEventListener("close", resolve, { once: true });
      });
      socket.send(new Uint8Array([1, 2, 3]));

      expect((await closed).code).toBe(1011);
    } finally {
      await closeSocket(socket);
      await server.close();
    }
  });
});

/** Resolves when `socket` opens and rejects if opening fails. */
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Standalone memory WebSocket failed to open")),
      { once: true },
    );
  });
}

/** Returns the next supported message from `socket`. */
function nextMessage(socket: WebSocket): Promise<MemoryMessageFrame> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup();
      if (
        typeof event.data === "string" || event.data instanceof ArrayBuffer ||
        event.data instanceof Uint8Array || event.data instanceof Blob
      ) {
        resolve(event.data);
      } else {
        reject(new Error("Standalone memory WebSocket sent an invalid frame"));
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("Standalone memory WebSocket failed"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Standalone memory WebSocket closed before replying"));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
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
