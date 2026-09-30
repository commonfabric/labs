import type { FabricValue } from "@commonfabric/data-model";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import {
  type EncodedMemoryMessage,
  encodeMemoryCompressionControlMessage,
  isMemoryMessageFrame,
  MemoryMessageCompressionChannel,
  type MemoryMessageFrame,
  memoryMessageFrameBytes,
  parseMemoryCompressionControlMessage,
} from "@commonfabric/memory/v2/message-compression";
import * as MemoryServer from "@commonfabric/memory/v2/server";
import { getLogger } from "@commonfabric/utils/logger";

import type * as Routes from "./memory.routes.ts";
import { formatMemWriteTrace, type MemWriteOp } from "./memwrite-trace.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import { createSpan } from "@/middlewares/opentelemetry.ts";
import { memoryServer } from "@/routes/storage/memory.ts";

type NegotiatedSocketHandlers = {
  onMessage: (message: MemoryMessageFrame) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
};

type NegotiationOptions = {
  maxBufferedBytes?: number;
};

const NEGOTIATION_BUFFER_MAX_BYTES = 1_048_576;

export const bufferTextMessagesUntilNegotiated = (
  socket: WebSocket,
  options: NegotiationOptions = {},
): {
  firstMessage: Promise<string | undefined>;
  handoff: (handlers: NegotiatedSocketHandlers) => void;
  dispose: () => void;
} => {
  const maxBufferedBytes = options.maxBufferedBytes ??
    NEGOTIATION_BUFFER_MAX_BYTES;
  socket.binaryType = "arraybuffer";
  let settled = false;
  let bufferedMessages: MemoryMessageFrame[] = [];
  let bufferedBytes = 0;
  let cleanup = () => {};
  let handlers: NegotiatedSocketHandlers | null = null;
  let negotiationError: Error | null = null;

  const forwardMessage = (message: MemoryMessageFrame) => {
    if (handlers === null) {
      if (negotiationError !== null) {
        return;
      }
      const messageBytes = memoryMessageFrameBytes(message);
      if (bufferedBytes + messageBytes > maxBufferedBytes) {
        negotiationError = new Error(
          "Memory websocket negotiation buffer exceeded",
        );
        bufferedMessages = [];
        bufferedBytes = 0;
        try {
          socket.close(1009, negotiationError.message);
        } catch {
          // Ignore close races with the peer.
        }
        return;
      }
      bufferedBytes += messageBytes;
      bufferedMessages.push(message);
      return;
    }
    handlers.onMessage(message);
  };

  const firstMessage = new Promise<string | undefined>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const frame = event.data;
      if (
        !isMemoryMessageFrame(frame) || (!settled && typeof frame !== "string")
      ) {
        const error = new Error(
          settled
            ? "Memory websocket expects text or binary frames"
            : "Memory websocket expects text before negotiation",
        );
        if (!settled) {
          cleanup();
          reject(error);
        } else {
          handlers?.onError?.(error);
        }
        return;
      }

      if (!settled) {
        settled = true;
        resolve(frame as string);
        return;
      }

      forwardMessage(frame);
    };

    const onClose = () => {
      cleanup();
      if (!settled) {
        settled = true;
        resolve(undefined);
        return;
      }
      handlers?.onClose?.();
    };

    const onError = () => {
      cleanup();
      if (!settled) {
        reject(new Error("Memory websocket failed before negotiation"));
        return;
      }
      handlers?.onError?.(new Error("Memory websocket receive failure"));
    };

    cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });

  return {
    firstMessage,
    handoff(nextHandlers) {
      handlers = nextHandlers;
      if (negotiationError !== null) {
        nextHandlers.onError?.(negotiationError);
        return;
      }
      const queued = bufferedMessages;
      bufferedMessages = [];
      bufferedBytes = 0;
      for (const message of queued) {
        nextHandlers.onMessage(message);
      }
    },
    dispose: cleanup,
  };
};

// Per-connection ordinal for the gated `CF_DEBUG_MEMORY_WRITES` trace. Each
// WebSocket connection is one client, so tagging every `[memwrite]` line with
// this `c=<n>` attributes a write storm to specific clients. See
// `memwrite-trace.ts`.
let memwriteConnSeq = 0;

const frameSizeLogger = getLogger("memory-socket", {
  enabled: true,
  level: "warn",
});

// Deno's WebSocket client rejects a wire frame over 64 MiB ("Frame too large")
// and closes the connection. Compression raises the logical message ceiling to
// 256 MiB only when its actual binary frame remains below that transport cap.
// Warning at a quarter of the cap surfaces uncompressed or poorly-compressing
// payload growth while every client still loads (labs#6319).
const OUTBOUND_FRAME_WARN_BYTES = 16 * 1024 * 1024;

export const warnOnOversizedOutboundFrame = (
  frame: EncodedMemoryMessage,
  message: unknown,
  warnBytes: number = OUTBOUND_FRAME_WARN_BYTES,
  warn: (key: string, lazyArgs: () => unknown[]) => void = (key, lazyArgs) =>
    frameSizeLogger.warn(key, lazyArgs),
): void => {
  if (typeof frame === "string" && frame.length * 3 <= warnBytes) {
    return;
  }
  const frameBytes = memoryMessageFrameBytes(frame);
  if (frameBytes <= warnBytes) {
    return;
  }
  warn("oversized-outbound-frame", () => [
    "outbound memory frame at",
    frameBytes,
    "bytes approaches the 64 MiB client cap;",
    "type:",
    (message as { type?: string }).type ?? "unknown",
    "space:",
    (message as { space?: string }).space ?? "unknown",
  ]);
};

export const attachMemorySocketPipeline = (
  socket: WebSocket,
  negotiation: ReturnType<typeof bufferTextMessagesUntilNegotiated>,
  firstMessage: string,
): boolean => {
  const parsedFirstMessage = MemoryServer.parseClientMessage(firstMessage);
  if (parsedFirstMessage === null) {
    return false;
  }
  const helloReceived = parsedFirstMessage.type === "hello";
  const compressionNegotiated = parsedFirstMessage.type === "hello" &&
    parsedFirstMessage.flags.messageCompressionV1 === true &&
    getMemoryProtocolFlags().messageCompressionV1;

  const safeSocketClose = (code: number, reason: string) => {
    if (
      socket.readyState === WebSocket.CLOSING ||
      socket.readyState === WebSocket.CLOSED
    ) {
      return;
    }
    try {
      socket.close(code, reason);
    } catch {
      // Ignore close races with the peer.
    }
  };
  let closed = false;
  const channel = new MemoryMessageCompressionChannel(
    (frame) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(frame);
      }
    },
    () => {
      safeSocketClose(1011, "Memory websocket message failure");
      closeConnection();
    },
  );
  const connection = memoryServer.connect((message) => {
    const encoded = encodeMemoryBoundary(message);
    channel.send(
      encoded,
      (frame) => warnOnOversizedOutboundFrame(frame, message),
    );
    if (compressionNegotiated && message.type === "hello.ok") {
      channel.enable();
    }
  });
  function closeConnection(): void {
    if (closed) return;
    closed = true;
    channel.close();
    connection.close();
  }

  // Gated diagnostic write trace (off by default). `CF_DEBUG_MEMORY_WRITES=1`
  // logs one `[memwrite]` line per committed op, tagged with this connection's
  // `c=<n>` so a write storm can be attributed to specific clients;
  // `CF_DEBUG_MEMORY_WRITE_VALUES=1` additionally dumps raw values (avoid on
  // real data — see memwrite-trace.ts).
  const debugMemWrites = Deno.env.get("CF_DEBUG_MEMORY_WRITES") === "1";
  const debugMemWriteValues =
    Deno.env.get("CF_DEBUG_MEMORY_WRITE_VALUES") === "1";
  const memConnId = debugMemWrites ? ++memwriteConnSeq : 0;
  const logMemWrites = (payload: string): void => {
    if (!debugMemWrites) return;
    try {
      const parsed = MemoryServer.parseClientMessage(payload) as unknown as {
        commit?: { operations?: Array<Record<string, FabricValue>> };
      };
      for (const op of parsed?.commit?.operations ?? []) {
        console.error(
          formatMemWriteTrace(op as MemWriteOp, memConnId, debugMemWriteValues),
        );
      }
    } catch {
      // Logging only.
    }
  };

  void (async () => {
    try {
      await connection.receive(firstMessage);
      logMemWrites(firstMessage);
      negotiation.handoff({
        onMessage(message) {
          if (closed) return;
          if (!compressionNegotiated && typeof message !== "string") {
            safeSocketClose(
              1003,
              "Memory websocket expects text without compression negotiation",
            );
            closeConnection();
            return;
          }
          channel.receive(message, async (payload) => {
            const control = parseMemoryCompressionControlMessage(payload);
            if (control && helloReceived) {
              const enabled = compressionNegotiated && control.enabled;
              channel.setSendCompressionEnabled(enabled);
              channel.send(encodeMemoryCompressionControlMessage({
                requestId: control.requestId,
                enabled,
              }));
              return;
            }
            await connection.receive(payload);
            logMemWrites(payload);
          });
        },
        onClose: closeConnection,
        onError(error) {
          safeSocketClose(
            error.message.startsWith("Memory websocket expects") ? 1003 : 1011,
            error.message,
          );
          closeConnection();
        },
      });
    } catch {
      safeSocketClose(1011, "Memory websocket setup failure");
      closeConnection();
    }
  })();

  return true;
};

export const subscribe: AppRouteHandler<typeof Routes.subscribe> = (c) => {
  return createSpan("memory.subscribe", (span) => {
    try {
      span.setAttribute("memory.operation", "subscribe");

      // Deno's default idle timeout can mistake a legitimate synchronous
      // memory-server stretch for a dead peer, then close every connection
      // together when the event loop yields. Disable that transport-level
      // pong deadline rather than turning server load into a reconnect storm.
      const { socket, response } = Deno.upgradeWebSocket(c.req.raw, {
        idleTimeout: 0,
      });
      span.setAttribute("websocket.upgrade", "success");

      void createSpan("memory.socket.setup", async (setupSpan) => {
        const negotiation = bufferTextMessagesUntilNegotiated(socket);
        const firstMessage = await negotiation.firstMessage;
        if (firstMessage === undefined) {
          negotiation.dispose();
          setupSpan.setAttribute("socket.setup", "closed-before-message");
          return;
        }

        if (attachMemorySocketPipeline(socket, negotiation, firstMessage)) {
          setupSpan.setAttribute("socket.setup", "memory");
          return;
        }

        negotiation.dispose();
        setupSpan.setAttribute("socket.setup", "unsupported-protocol");
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1002, "Memory websocket expects memory protocol");
        }
      }).catch(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.close(1011, "Memory websocket setup failure");
          } catch {
            // Ignore close races with the peer.
          }
        }
      });

      return response;
    } catch (error) {
      span.setAttribute("memory.status", "exception");
      span.setAttribute(
        "error.message",
        error instanceof Error ? error.message : String(error),
      );
      span.setAttribute(
        "error.type",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw error;
    }
  });
};
