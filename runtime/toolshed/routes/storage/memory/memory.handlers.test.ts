import { expect } from "@std/expect";
import { afterAll, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "@commonfabric/memory/v2";
import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  type EncodedMemoryMessage,
  encodeMemoryCompressionControlMessage,
  parseMemoryCompressionControlMessage,
} from "@commonfabric/memory/v2/message-compression";

import {
  attachMemorySocketPipeline,
  bufferTextMessagesUntilNegotiated,
  type MemorySocketServer,
  setUpMemorySocket,
  warnOnOversizedOutboundFrame,
} from "./memory.handlers.ts";
import memoryRouter from "./memory.index.ts";
import { memoryServer } from "@/routes/storage/memory.ts";

const HELLO = encodeMemoryBoundary({
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
});

class FakeSocket extends EventTarget {
  readyState: WebSocket["readyState"] = WebSocket.OPEN;
  binaryType: BinaryType = "blob";
  readonly sent: EncodedMemoryMessage[] = [];
  closedWith: { code?: number; reason?: string } | undefined;
  /** When set, `close()` throws this, as a socket racing its peer can. */
  closeError: Error | undefined;
  #sentWaiters: Array<{ count: number; resolve: () => void }> = [];
  #closeCalled = Promise.withResolvers<void>();

  send(payload: EncodedMemoryMessage): void {
    this.sent.push(payload);
    this.#sentWaiters = this.#sentWaiters.filter((waiter) => {
      if (this.sent.length >= waiter.count) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.#closeCalled.resolve();
    if (this.closeError !== undefined) throw this.closeError;
  }

  /** Resolves once `close()` has been called. */
  whenClosed(): Promise<void> {
    return this.#closeCalled.promise;
  }

  /** Resolves once the socket has sent `count` messages. */
  whenSent(count: number): Promise<void> {
    if (this.sent.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#sentWaiters.push({ count, resolve });
    });
  }
}

// Runs the pipeline the way `subscribe` does: deliver the first message
// through the socket while it is OPEN, set the readyState the send callback
// will observe, attach, and resolve once the pipeline hands the negotiated
// socket off. The hello reply is sent while the pipeline awaits
// `connection.receive(firstMessage)`, so it has been attempted by the time
// the handoff happens. Closing the socket afterwards releases the pipeline's
// memory-server connection.
const runHelloThroughPipeline = async (
  fake: FakeSocket,
  readyStateAtReply: WebSocket["readyState"],
): Promise<void> => {
  const socket = fake as unknown as WebSocket;
  const negotiation = bufferTextMessagesUntilNegotiated(socket);
  const handedOff = Promise.withResolvers<void>();
  const handoff = negotiation.handoff;
  negotiation.handoff = (handlers) => {
    handoff(handlers);
    handedOff.resolve();
  };

  fake.dispatchEvent(new MessageEvent("message", { data: HELLO }));
  const firstMessage = await negotiation.firstMessage;
  expect(firstMessage).toBe(HELLO);

  fake.readyState = readyStateAtReply;
  expect(attachMemorySocketPipeline(socket, negotiation, firstMessage!)).toBe(
    true,
  );
  await handedOff.promise;
  fake.dispatchEvent(new CloseEvent("close"));
};

// Returns the arguments of each `console.error()` call made while `act` runs,
// up to the settling of the promise it returns.
const consoleErrorsDuring = async (
  act: () => void | Promise<void>,
): Promise<unknown[][]> => {
  const reported: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    reported.push(args);
  };
  try {
    await act();
  } finally {
    console.error = original;
  }
  return reported;
};

// A memory server that records the frames handed to its connections and how
// often they were closed. Each frame goes to `handle`, which by default hands
// it to the real `memoryServer`'s connection.
const recordingServer = (
  handle?: (payload: string, index: number) => Promise<void>,
) => {
  const received: string[] = [];
  let closes = 0;
  const server: MemorySocketServer = {
    connect(send) {
      const real = memoryServer.connect(send);
      return {
        id: real.id,
        receive(payload) {
          received.push(payload);
          return handle === undefined
            ? real.receive(payload)
            : handle(payload, received.length - 1);
        },
        close() {
          closes++;
          real.close();
        },
      };
    },
  };
  return { server, received, closes: () => closes };
};

// Delivers the hello to `fake`, attaches the pipeline over `server`, and
// resolves once the negotiated socket has been handed off to it.
const attachOver = async (
  fake: FakeSocket,
  server: MemorySocketServer,
  hello: string = HELLO,
): Promise<void> => {
  const socket = fake as unknown as WebSocket;
  const negotiation = bufferTextMessagesUntilNegotiated(socket);
  const handedOff = Promise.withResolvers<void>();
  const handoff = negotiation.handoff;
  negotiation.handoff = (handlers) => {
    handoff(handlers);
    handedOff.resolve();
  };
  fake.dispatchEvent(new MessageEvent("message", { data: hello }));
  const firstMessage = await negotiation.firstMessage;
  expect(attachMemorySocketPipeline(socket, negotiation, firstMessage!, server))
    .toBe(true);
  await handedOff.promise;
};

describe("memory.handlers", () => {
  // The toolshed `memoryServer` is a module-level singleton constructed when
  // memory.ts is imported. Deno isolates each test file's module graph, so
  // this instance is owned by this file alone. Closing it releases its
  // resources.
  afterAll(async () => {
    await memoryServer.close();
  });

  describe("bufferTextMessagesUntilNegotiated()", () => {
    // Settles `firstMessage`, returning the error it rejects with, or
    // `undefined` when it resolves.
    const rejectionOf = (firstMessage: Promise<unknown>): Promise<unknown> =>
      firstMessage.then(() => undefined, (error: unknown) => error);

    it("rejects `.firstMessage` with the message and error an `ErrorEvent` carries", async () => {
      const fake = new FakeSocket();
      const negotiation = bufferTextMessagesUntilNegotiated(
        fake as unknown as WebSocket,
      );
      const failure = new Error("Unexpected EOF");

      fake.dispatchEvent(
        new ErrorEvent("error", { message: failure.message, error: failure }),
      );

      const rejection = await rejectionOf(negotiation.firstMessage);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe(
        "Memory websocket failed before negotiation: Unexpected EOF",
      );
      expect((rejection as Error).cause).toBe(failure);
    });

    it("rejects `.firstMessage` with the fixed text alone for a plain `error` event", async () => {
      const fake = new FakeSocket();
      const negotiation = bufferTextMessagesUntilNegotiated(
        fake as unknown as WebSocket,
      );

      fake.dispatchEvent(new Event("error"));

      const rejection = await rejectionOf(negotiation.firstMessage);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe(
        "Memory websocket failed before negotiation",
      );
      expect((rejection as Error).cause).toBeUndefined();
    });

    it("closes with 1009 and drops later frames once the buffer before negotiation overflows", async () => {
      const fake = new FakeSocket();
      const negotiation = bufferTextMessagesUntilNegotiated(
        fake as unknown as WebSocket,
        { maxBufferedBytes: 8 },
      );
      fake.dispatchEvent(new MessageEvent("message", { data: "first" }));
      expect(await negotiation.firstMessage).toBe("first");

      fake.dispatchEvent(new MessageEvent("message", { data: "1234" }));
      expect(fake.closedWith).toBeUndefined();
      fake.dispatchEvent(new MessageEvent("message", { data: "56789" }));
      expect(fake.closedWith).toEqual({
        code: 1009,
        reason: "Memory websocket negotiation buffer exceeded",
      });
      fake.closedWith = undefined;
      fake.dispatchEvent(new MessageEvent("message", { data: "123456789" }));
      expect(fake.closedWith).toBeUndefined();

      const delivered: unknown[] = [];
      const errors: Error[] = [];
      negotiation.handoff({
        onMessage: (message) => delivered.push(message),
        onError: (error) => errors.push(error),
      });
      expect(delivered).toEqual([]);
      expect(errors.map((error) => error.message)).toEqual([
        "Memory websocket negotiation buffer exceeded",
      ]);
      negotiation.dispose();
    });

    it("hands frames buffered within the limit over in order", async () => {
      const fake = new FakeSocket();
      const negotiation = bufferTextMessagesUntilNegotiated(
        fake as unknown as WebSocket,
        { maxBufferedBytes: 8 },
      );
      fake.dispatchEvent(new MessageEvent("message", { data: "first" }));
      await negotiation.firstMessage;
      fake.dispatchEvent(new MessageEvent("message", { data: "1234" }));
      fake.dispatchEvent(new MessageEvent("message", { data: "5678" }));

      const delivered: unknown[] = [];
      negotiation.handoff({ onMessage: (message) => delivered.push(message) });
      fake.dispatchEvent(new MessageEvent("message", { data: "after" }));

      expect(delivered).toEqual(["1234", "5678", "after"]);
      expect(fake.closedWith).toBeUndefined();
      negotiation.dispose();
    });

    it("still reports an overflow to the handoff when closing the socket throws", async () => {
      const fake = new FakeSocket();
      fake.closeError = new Error("socket already closing");
      const negotiation = bufferTextMessagesUntilNegotiated(
        fake as unknown as WebSocket,
        { maxBufferedBytes: 4 },
      );
      fake.dispatchEvent(new MessageEvent("message", { data: "first" }));
      await negotiation.firstMessage;

      fake.dispatchEvent(new MessageEvent("message", { data: "12345" }));

      expect(fake.closedWith?.code).toBe(1009);
      const errors: Error[] = [];
      negotiation.handoff({
        onMessage: () => {},
        onError: (error) => errors.push(error),
      });
      expect(errors).toHaveLength(1);
      negotiation.dispose();
    });
  });

  describe("attachMemorySocketPipeline", () => {
    for (const commitLabelTableV1 of [false, true]) {
      it(`traces inline and compact writes identically while preserving admission with commitLabelTableV1=${commitLabelTableV1}`, async () => {
        const envGet = Deno.env.get.bind(Deno.env);
        using _env = stub(
          Deno.env,
          "get",
          (name) =>
            name === "CF_DEBUG_MEMORY_WRITES"
              ? "1"
              : name === "CF_DEBUG_MEMORY_WRITE_VALUES"
              ? "0"
              : envGet(name),
        );
        const lines: string[] = [];
        using _console = stub(console, "error", (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].startsWith("[memwrite]")) {
            lines.push(args[0]);
          }
        });
        const fake = new FakeSocket();
        const socket: Partial<WebSocket> = fake;
        const negotiation = bufferTextMessagesUntilNegotiated(
          socket as WebSocket,
        );
        const handedOff = Promise.withResolvers<void>();
        const handoff = negotiation.handoff;
        negotiation.handoff = (handlers) => {
          handoff(handlers);
          handedOff.resolve();
        };
        const hello = encodeMemoryBoundary({
          type: "hello",
          protocol: MEMORY_PROTOCOL,
          flags: {
            ...getMemoryProtocolFlags(),
            messageCompressionV1: false,
            commitLabelTableV1,
          },
        });
        try {
          fake.dispatchEvent(new MessageEvent("message", { data: hello }));
          await negotiation.firstMessage;
          expect(
            attachMemorySocketPipeline(socket as WebSocket, negotiation, hello),
          ).toBe(true);
          await handedOff.promise;
          const label = { confidentiality: ["recipe"], integrity: [] };
          const path = ["ingredients"];
          for (const compact of [false, true]) {
            fake.dispatchEvent(
              new MessageEvent("message", {
                data: encodeMemoryBoundary({
                  type: "transact",
                  requestId: compact ? "compact" : "inline",
                  space: "did:key:diagnostic",
                  sessionId: "missing-session",
                  commit: {
                    localSeq: 1,
                    reads: { confirmed: [], pending: [] },
                    ...(compact
                      ? { labelTable: [label], labelPathTable: [path] }
                      : {}),
                    operations: [{
                      op: "set",
                      id: "of:donuts",
                      value: {
                        value: { ingredients: "chocolate" },
                        cfc: {
                          labelMap: {
                            entries: [{
                              label: compact ? 0 : label,
                              path: compact ? 0 : path,
                            }],
                          },
                        },
                      },
                    }],
                  },
                }),
              }),
            );
            await fake.whenSent(compact ? 3 : 2);
          }
          expect(lines).toHaveLength(2);
          expect(lines[1]).toBe(lines[0]);
          expect(lines[0]).toContain("op=set id=of:donuts");
          const response = fake.sent[2];
          if (typeof response !== "string") {
            throw new Error("Expected text response");
          }
          // Either refusal answers on the request's own id: an unsolicited
          // table fails parsing, a negotiated one reaches session admission.
          expect(decodeMemoryBoundary(response)).toMatchObject({
            type: "response",
            requestId: "compact",
            error: {
              name: commitLabelTableV1 ? "SessionError" : "InvalidMessageError",
            },
          });
        } finally {
          fake.dispatchEvent(new CloseEvent("close"));
          negotiation.dispose();
        }
      });
    }

    it("sends the hello reply while the socket is OPEN", async () => {
      const fake = new FakeSocket();

      await runHelloThroughPipeline(fake, WebSocket.OPEN);

      expect(fake.sent.length).toBe(1);
      const frame = fake.sent[0];
      expect(typeof frame).toBe("string");
      if (typeof frame !== "string") throw new Error("Expected text hello");
      const reply = decodeMemoryBoundary<{ type: string }>(frame);
      expect(reply.type).toBe("hello.ok");
    });

    it("drops server messages once the socket has left OPEN", async () => {
      const fake = new FakeSocket();

      await runHelloThroughPipeline(fake, WebSocket.CLOSED);

      expect(fake.sent).toEqual([]);
    });

    it("exchanges compressed messages after the uncompressed hello", async () => {
      const fake = new FakeSocket();
      const socket = fake as unknown as WebSocket;
      const negotiation = bufferTextMessagesUntilNegotiated(socket);
      const handedOff = Promise.withResolvers<void>();
      const handoff = negotiation.handoff;
      negotiation.handoff = (handlers) => {
        handoff(handlers);
        handedOff.resolve();
      };

      fake.dispatchEvent(new MessageEvent("message", { data: HELLO }));
      const firstMessage = await negotiation.firstMessage;
      const requestId = "compressed-session-open-".repeat(100);
      const request = encodeMemoryBoundary({
        type: "session.open",
        requestId,
        space: "did:key:z6Mk-compression-test",
        session: {},
      });
      fake.dispatchEvent(
        new MessageEvent("message", {
          data: await encodeCompressedMemoryMessage(request),
        }),
      );
      expect(attachMemorySocketPipeline(
        socket,
        negotiation,
        firstMessage!,
      )).toBe(true);
      await handedOff.promise;
      expect(typeof fake.sent[0]).toBe("string");
      await fake.whenSent(2);

      expect(fake.sent[1]).toBeInstanceOf(Uint8Array);
      const response = decodeMemoryBoundary<{ requestId: string }>(
        await decodeCompressedMemoryMessage(fake.sent[1]),
      );
      expect(response.requestId).toBe(requestId);
      fake.dispatchEvent(new CloseEvent("close"));
    });

    it("closes with 1003 for binary data without negotiated compression", async () => {
      const fake = new FakeSocket();
      const socket = fake as unknown as WebSocket;
      const negotiation = bufferTextMessagesUntilNegotiated(socket);
      const handedOff = Promise.withResolvers<void>();
      const handoff = negotiation.handoff;
      negotiation.handoff = (handlers) => {
        handoff(handlers);
        handedOff.resolve();
      };
      fake.dispatchEvent(
        new MessageEvent("message", {
          data: encodeMemoryBoundary({
            type: "hello",
            protocol: MEMORY_PROTOCOL,
            flags: {
              ...getMemoryProtocolFlags(),
              messageCompressionV1: false,
            },
          }),
        }),
      );
      const firstMessage = await negotiation.firstMessage;
      expect(attachMemorySocketPipeline(
        socket,
        negotiation,
        firstMessage!,
      )).toBe(true);
      await handedOff.promise;

      fake.dispatchEvent(
        new MessageEvent("message", {
          data: await encodeCompressedMemoryMessage(
            "binary request ".repeat(200),
          ),
        }),
      );

      expect(fake.closedWith?.code).toBe(1003);
    });

    it("requires hello before accepting a compression control", async () => {
      const fake = new FakeSocket();
      const socket = fake as unknown as WebSocket;
      const negotiation = bufferTextMessagesUntilNegotiated(socket);
      const handedOff = Promise.withResolvers<void>();
      const handoff = negotiation.handoff;
      negotiation.handoff = (handlers) => {
        handoff(handlers);
        handedOff.resolve();
      };
      fake.dispatchEvent(
        new MessageEvent("message", {
          data: encodeMemoryBoundary({
            type: "session.open",
            requestId: "session-before-hello",
            space: "did:key:z6Mk-toolshed-control-before-hello",
            session: {},
          }),
        }),
      );
      const firstMessage = await negotiation.firstMessage;
      expect(attachMemorySocketPipeline(
        socket,
        negotiation,
        firstMessage!,
      )).toBe(true);
      await handedOff.promise;

      fake.dispatchEvent(
        new MessageEvent("message", {
          data: encodeMemoryCompressionControlMessage({
            requestId: "toolshed-control-before-hello",
            enabled: false,
          }),
        }),
      );
      await fake.whenSent(2);
      expect(typeof fake.sent[1]).toBe("string");
      if (typeof fake.sent[1] !== "string") {
        throw new Error("Expected text protocol error");
      }
      expect(parseMemoryCompressionControlMessage(fake.sent[1])).toBeNull();
      expect(decodeMemoryBoundary<{
        type: string;
        error?: { name: string };
      }>(fake.sent[1])).toMatchObject({
        type: "response",
        error: { name: "InvalidMessageError" },
      });
      fake.dispatchEvent(new CloseEvent("close"));
    });

    it("changes compression without replacing the socket", async () => {
      const fake = new FakeSocket();
      const socket = fake as unknown as WebSocket;
      const negotiation = bufferTextMessagesUntilNegotiated(socket);
      const handedOff = Promise.withResolvers<void>();
      const handoff = negotiation.handoff;
      negotiation.handoff = (handlers) => {
        handoff(handlers);
        handedOff.resolve();
      };
      fake.dispatchEvent(new MessageEvent("message", { data: HELLO }));
      const firstMessage = await negotiation.firstMessage;
      expect(attachMemorySocketPipeline(
        socket,
        negotiation,
        firstMessage!,
      )).toBe(true);
      await handedOff.promise;

      fake.dispatchEvent(
        new MessageEvent("message", {
          data: encodeMemoryCompressionControlMessage({
            requestId: "toolshed-debug-control",
            enabled: false,
          }),
        }),
      );
      await fake.whenSent(2);
      expect(typeof fake.sent[1]).toBe("string");
      if (typeof fake.sent[1] !== "string") {
        throw new Error("Expected text compression control");
      }
      expect(parseMemoryCompressionControlMessage(fake.sent[1])).toEqual({
        type: "memory.compression",
        requestId: "toolshed-debug-control",
        enabled: false,
      });

      const requestId = "toolshed-visible-session-open-".repeat(100);
      fake.dispatchEvent(
        new MessageEvent("message", {
          data: encodeMemoryBoundary({
            type: "session.open",
            requestId,
            space: "did:key:z6Mk-toolshed-visible-compression-test",
            session: {},
          }),
        }),
      );
      await fake.whenSent(3);
      expect(typeof fake.sent[2]).toBe("string");
      if (typeof fake.sent[2] !== "string") {
        throw new Error("Expected text response after disabling compression");
      }
      expect(
        decodeMemoryBoundary<{ requestId: string }>(fake.sent[2]).requestId,
      ).toBe(requestId);
      fake.dispatchEvent(new CloseEvent("close"));
    });
  });

  describe("attachMemorySocketPipeline failures", () => {
    // Attaches the pipeline to `fake` after a hello, and resolves once the
    // negotiated socket has been handed off to it.
    const attachAfterHello = async (fake: FakeSocket): Promise<void> => {
      const socket = fake as unknown as WebSocket;
      const negotiation = bufferTextMessagesUntilNegotiated(socket);
      const handedOff = Promise.withResolvers<void>();
      const handoff = negotiation.handoff;
      negotiation.handoff = (handlers) => {
        handoff(handlers);
        handedOff.resolve();
      };
      fake.dispatchEvent(new MessageEvent("message", { data: HELLO }));
      const firstMessage = await negotiation.firstMessage;
      expect(attachMemorySocketPipeline(socket, negotiation, firstMessage!))
        .toBe(true);
      await handedOff.promise;
    };

    it("logs a socket failure after the handoff before closing with 1011", async () => {
      // Found in review: this close said nothing about why, though it ends
      // every session the connection carries.
      const fake = new FakeSocket();
      await attachAfterHello(fake);

      const reported = await consoleErrorsDuring(() => {
        fake.dispatchEvent(new Event("error"));
      });
      expect(fake.closedWith?.code).toBe(1011);
      expect(
        reported.some(([text, cause]) =>
          String(text).includes("after its socket failed") &&
          cause instanceof Error &&
          cause.message === "Memory websocket receive failure"
        ),
      ).toBe(true);
      fake.dispatchEvent(new CloseEvent("close"));
    });

    it("logs the message and error an `ErrorEvent` carries with the socket failure", async () => {
      const fake = new FakeSocket();
      await attachAfterHello(fake);
      const failure = new Error("Connection reset by peer (os error 104)");

      const reported = await consoleErrorsDuring(() => {
        fake.dispatchEvent(
          new ErrorEvent("error", { message: failure.message, error: failure }),
        );
      });

      expect(reported).toHaveLength(1);
      const [text, logged] = reported[0];
      expect(String(text)).toContain("after its socket failed");
      expect(logged).toBeInstanceOf(Error);
      expect((logged as Error).message).toBe(
        "Memory websocket receive failure: " +
          "Connection reset by peer (os error 104)",
      );
      expect((logged as Error).cause).toBe(failure);
    });

    it("returns `false` and connects nothing for a first frame that is not a memory message", async () => {
      const fake = new FakeSocket();
      const socket = fake as unknown as WebSocket;
      const negotiation = bufferTextMessagesUntilNegotiated(socket);
      const recorder = recordingServer();
      fake.dispatchEvent(new MessageEvent("message", { data: "not memory" }));
      const firstMessage = await negotiation.firstMessage;

      expect(
        attachMemorySocketPipeline(
          socket,
          negotiation,
          firstMessage!,
          recorder.server,
        ),
      ).toBe(false);
      expect(recorder.received).toEqual([]);
      negotiation.dispose();
    });

    it("closes with 1003 for a frame that is neither text nor binary", async () => {
      const fake = new FakeSocket();
      const recorder = recordingServer();
      await attachOver(fake, recorder.server);

      const reported = await consoleErrorsDuring(() => {
        fake.dispatchEvent(new MessageEvent("message", { data: 42 }));
      });

      expect(fake.closedWith).toEqual({
        code: 1003,
        reason: "Memory websocket expects text or binary frames",
      });
      expect(reported).toHaveLength(1);
      expect(recorder.received).toEqual([HELLO]);
      expect(recorder.closes()).toBe(1);
    });

    it("does not close a socket that has already closed when it fails", async () => {
      const fake = new FakeSocket();
      const recorder = recordingServer();
      await attachOver(fake, recorder.server);
      fake.readyState = WebSocket.CLOSED;

      const reported = await consoleErrorsDuring(() => {
        fake.dispatchEvent(new Event("error"));
      });

      expect(fake.closedWith).toBeUndefined();
      expect(reported).toHaveLength(1);
      expect(recorder.closes()).toBe(1);
    });

    it("closes its connection when closing the failed socket throws", async () => {
      const fake = new FakeSocket();
      fake.closeError = new Error("socket already closing");
      const recorder = recordingServer();
      await attachOver(fake, recorder.server);

      await consoleErrorsDuring(() => {
        fake.dispatchEvent(new Event("error"));
      });

      expect(fake.closedWith?.code).toBe(1011);
      expect(recorder.closes()).toBe(1);
    });

    it("closes with 1011 and ignores later frames after a frame that cannot be decoded", async () => {
      // The hello negotiates compression, so a binary frame must carry a
      // compressed message; three bytes do not.
      const fake = new FakeSocket();
      const recorder = recordingServer();
      await attachOver(fake, recorder.server);

      const reported = await consoleErrorsDuring(async () => {
        fake.dispatchEvent(
          new MessageEvent("message", { data: new Uint8Array([1, 2, 3]) }),
        );
        await fake.whenClosed();
      });
      fake.dispatchEvent(new MessageEvent("message", { data: "later" }));
      fake.dispatchEvent(new CloseEvent("close"));

      expect(fake.closedWith).toEqual({
        code: 1011,
        reason: "Memory websocket message failure",
      });
      expect(String(reported[0]?.[0])).toContain("after a frame failure");
      expect(recorder.received).toEqual([HELLO]);
      expect(recorder.closes()).toBe(1);
    });

    it("closes with 1011 when its server cannot handle a later frame", async () => {
      const fake = new FakeSocket();
      const failure = new Error("store unavailable");
      const recorder = recordingServer((_payload, index) =>
        index === 0 ? Promise.resolve() : Promise.reject(failure)
      );
      await attachOver(fake, recorder.server);

      const reported = await consoleErrorsDuring(async () => {
        fake.dispatchEvent(new MessageEvent("message", { data: "second" }));
        await fake.whenClosed();
      });

      expect(fake.closedWith).toEqual({
        code: 1011,
        reason: "Memory websocket message failure",
      });
      expect(reported).toHaveLength(1);
      expect(String(reported[0][0])).toContain(
        "after a frame its server could not handle",
      );
      expect(reported[0][1]).toBe(failure);
      expect(recorder.received).toEqual([HELLO, "second"]);
      expect(recorder.closes()).toBe(1);
    });

    it("closes with 1011 without a handoff when its server cannot handle the first frame", async () => {
      const fake = new FakeSocket();
      const socket = fake as unknown as WebSocket;
      const failure = new Error("store unavailable");
      const recorder = recordingServer(() => Promise.reject(failure));
      const negotiation = bufferTextMessagesUntilNegotiated(socket);
      let handedOff = false;
      const handoff = negotiation.handoff;
      negotiation.handoff = (handlers) => {
        handedOff = true;
        handoff(handlers);
      };
      fake.dispatchEvent(new MessageEvent("message", { data: HELLO }));
      const firstMessage = await negotiation.firstMessage;

      const reported = await consoleErrorsDuring(async () => {
        attachMemorySocketPipeline(
          socket,
          negotiation,
          firstMessage!,
          recorder.server,
        );
        await fake.whenClosed();
      });

      expect(fake.closedWith).toEqual({
        code: 1011,
        reason: "Memory websocket setup failure",
      });
      expect(handedOff).toBe(false);
      expect(String(reported[0][0])).toContain("after its first frame failed");
      expect(reported[0][1]).toBe(failure);
      expect(recorder.closes()).toBe(1);
      negotiation.dispose();
    });

    it("keeps serving frames when writing the write trace fails", async () => {
      const envGet = Deno.env.get.bind(Deno.env);
      using _env = stub(
        Deno.env,
        "get",
        (name) => name === "CF_DEBUG_MEMORY_WRITES" ? "1" : envGet(name),
      );
      let traceAttempts = 0;
      using _console = stub(console, "error", (...args: unknown[]) => {
        if (String(args[0]).startsWith("[memwrite]")) {
          traceAttempts++;
          throw new Error("stderr closed");
        }
      });
      const fake = new FakeSocket();
      const hello = encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: { ...getMemoryProtocolFlags(), messageCompressionV1: false },
      });
      await attachOver(fake, recordingServer().server, hello);

      fake.dispatchEvent(
        new MessageEvent("message", {
          data: encodeMemoryBoundary({
            type: "transact",
            requestId: "traced",
            space: "did:key:diagnostic",
            sessionId: "missing-session",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{ op: "set", id: "of:donuts", value: { value: 1 } }],
            },
          }),
        }),
      );
      await Promise.race([fake.whenSent(2), fake.whenClosed()]);

      expect(traceAttempts).toBe(1);
      expect(fake.closedWith).toBeUndefined();
      const response = fake.sent[1];
      if (typeof response !== "string") {
        throw new Error("Expected text response");
      }
      expect(decodeMemoryBoundary(response)).toMatchObject({
        type: "response",
        requestId: "traced",
      });
      fake.dispatchEvent(new CloseEvent("close"));
    });
  });

  describe("setUpMemorySocket()", () => {
    it("logs the cause of a socket that fails before its first frame", async () => {
      const fake = new FakeSocket();
      const failure = new Error("Unexpected EOF");

      const reported = await consoleErrorsDuring(async () => {
        const setup = setUpMemorySocket(fake as unknown as WebSocket);
        // Deno marks a socket closed before it dispatches `error`.
        fake.readyState = WebSocket.CLOSED;
        fake.dispatchEvent(
          new ErrorEvent("error", { message: failure.message, error: failure }),
        );
        await setup;
      });

      expect(reported).toHaveLength(1);
      const [text, logged] = reported[0];
      expect(text).toBe("memory websocket: setup failed");
      expect(logged).toBeInstanceOf(Error);
      expect((logged as Error).message).toBe(
        "Memory websocket failed before negotiation: Unexpected EOF",
      );
      expect((logged as Error).cause).toBe(failure);
      expect(fake.closedWith).toBeUndefined();
    });

    it("logs a first frame that is not text", async () => {
      const fake = new FakeSocket();

      const reported = await consoleErrorsDuring(async () => {
        const setup = setUpMemorySocket(fake as unknown as WebSocket);
        fake.dispatchEvent(
          new MessageEvent("message", { data: new ArrayBuffer(3) }),
        );
        await setup;
      });

      expect(reported).toHaveLength(1);
      const [text, logged] = reported[0];
      expect(text).toBe("memory websocket: setup failed");
      expect(logged).toBeInstanceOf(Error);
      expect((logged as Error).message).toBe(
        "Memory websocket expects text before negotiation",
      );
    });

    it("logs nothing for a socket closed before its first frame", async () => {
      const fake = new FakeSocket();

      const reported = await consoleErrorsDuring(async () => {
        const setup = setUpMemorySocket(fake as unknown as WebSocket);
        fake.dispatchEvent(new CloseEvent("close"));
        await setup;
      });

      expect(reported).toEqual([]);
      expect(fake.closedWith).toBeUndefined();
    });

    it("closes with 1002 for a first frame that is not a memory message", async () => {
      const fake = new FakeSocket();
      const recorder = recordingServer();

      const setup = setUpMemorySocket(
        fake as unknown as WebSocket,
        recorder.server,
      );
      fake.dispatchEvent(new MessageEvent("message", { data: "not memory" }));
      await setup;

      expect(fake.closedWith).toEqual({
        code: 1002,
        reason: "Memory websocket expects memory protocol",
      });
      expect(recorder.received).toEqual([]);
    });

    it("does not close a socket that is no longer open for a first frame that is not a memory message", async () => {
      const fake = new FakeSocket();

      const setup = setUpMemorySocket(fake as unknown as WebSocket);
      fake.dispatchEvent(new MessageEvent("message", { data: "not memory" }));
      fake.readyState = WebSocket.CLOSING;
      await setup;

      expect(fake.closedWith).toBeUndefined();
    });

    it("attaches the pipeline to its server for a memory hello", async () => {
      const fake = new FakeSocket();
      const recorder = recordingServer();

      const setup = setUpMemorySocket(
        fake as unknown as WebSocket,
        recorder.server,
      );
      fake.dispatchEvent(new MessageEvent("message", { data: HELLO }));
      await setup;
      await fake.whenSent(1);

      expect(recorder.received).toEqual([HELLO]);
      const reply = fake.sent[0];
      if (typeof reply !== "string") throw new Error("Expected text hello");
      expect(decodeMemoryBoundary<{ type: string }>(reply).type).toBe(
        "hello.ok",
      );
      expect(fake.closedWith).toBeUndefined();
      fake.dispatchEvent(new CloseEvent("close"));
    });

    it("resolves when closing a socket whose setup failed throws", async () => {
      const fake = new FakeSocket();
      fake.closeError = new Error("socket already closing");

      const reported = await consoleErrorsDuring(async () => {
        const setup = setUpMemorySocket(fake as unknown as WebSocket);
        fake.dispatchEvent(
          new MessageEvent("message", { data: new ArrayBuffer(3) }),
        );
        await setup;
      });

      expect(fake.closedWith?.code).toBe(1011);
      expect(reported).toHaveLength(1);
    });
  });

  describe("subscribe", () => {
    it("answers 500 for a request it cannot upgrade to a websocket", async () => {
      const response = await memoryRouter.request("/api/storage/memory", {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });

      expect(response.status).toBe(500);
    });
  });

  describe("warnOnOversizedOutboundFrame", () => {
    const captureWarn = () => {
      const calls: { key: string; args: unknown[] }[] = [];
      const warn = (key: string, lazyArgs: () => unknown[]) => {
        calls.push({ key, args: lazyArgs() });
      };
      return { calls, warn };
    };

    it("stays silent for a frame at or under the byte threshold", () => {
      const { calls, warn } = captureWarn();

      warnOnOversizedOutboundFrame("a".repeat(30), {}, 30, warn);

      expect(calls).toEqual([]);
    });

    it("measures a binary frame by its compressed wire bytes", () => {
      const { calls, warn } = captureWarn();

      warnOnOversizedOutboundFrame(new Uint8Array(30), {}, 30, warn);
      expect(calls).toEqual([]);

      warnOnOversizedOutboundFrame(new Uint8Array(31), {}, 30, warn);
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toContain(31);
    });

    it("warns past the threshold with the byte size, type, and space", () => {
      const { calls, warn } = captureWarn();

      warnOnOversizedOutboundFrame(
        "a".repeat(31),
        { type: "session/effect", space: "did:key:zExample" },
        30,
        warn,
      );

      expect(calls.length).toBe(1);
      expect(calls[0].key).toBe("oversized-outbound-frame");
      expect(calls[0].args).toContain(31);
      expect(calls[0].args).toContain("session/effect");
      expect(calls[0].args).toContain("did:key:zExample");
    });

    it("measures bytes, not code units, for non-ASCII content", () => {
      // Eight emoji are 16 code units but 32 UTF-8 bytes: under a
      // code-unit reading of the 30-byte threshold, over a byte reading.
      const { calls, warn } = captureWarn();

      warnOnOversizedOutboundFrame("😀".repeat(8), {}, 30, warn);

      expect(calls.length).toBe(1);
      expect(calls[0].args).toContain(32);
    });

    it("names an absent type and space as unknown", () => {
      const { calls, warn } = captureWarn();

      warnOnOversizedOutboundFrame("a".repeat(31), {}, 30, warn);

      expect(calls.length).toBe(1);
      expect(calls[0].args).toContain("unknown");
    });
  });
});
