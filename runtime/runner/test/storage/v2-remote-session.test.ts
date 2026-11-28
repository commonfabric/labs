import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import { describe, it } from "@commonfabric/test-support/test";
import { clock } from "@commonfabric/test-support/fake-clock";

import {
  createSignedConnectionAuth,
  MemoryDialLimiter,
  WebSocketTransport,
} from "../../src/storage/v2-remote-session.ts";
import {
  type DrivableSockets,
  drivableSockets,
  type DrivableWebSocket,
} from "./drivable-web-socket.ts";

const owner = await Identity.fromPassphrase("v2-remote-session owner");

/** A blob whose bytes are read only once the test releases them. */
class HeldBlob extends Blob {
  readonly reading = Promise.withResolvers<void>();
  readonly #contents = Promise.withResolvers<ArrayBuffer>();

  /** Hands the reader `contents`. */
  release(contents: Uint8Array<ArrayBuffer>): void {
    this.#contents.resolve(contents.buffer);
  }

  /** Fails the read with `error`. */
  fail(error: Error): void {
    this.#contents.reject(error);
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    this.reading.resolve();
    return this.#contents.promise;
  }
}

/** Encodes the router's acknowledgement of `bytes` uploaded bytes. */
const creditFrame = (bytes: number): Uint8Array<ArrayBuffer> => {
  const frame = new Uint8Array([0x6d, 0x72, 0x63, 0x01, 0, 0, 0, 0]);
  new DataView(frame.buffer).setUint32(4, bytes, false);
  return frame;
};

describe("v2-remote-session", () => {
  describe("MemoryDialLimiter", () => {
    describe("constructor()", () => {
      for (const perHost of [0, -1, 1.5, Number.NaN]) {
        it(`throws a RangeError given ${perHost} dials per host`, () => {
          expect(() => new MemoryDialLimiter(perHost)).toThrow(
            RangeError,
          );
        });
      }

      it("admits one dial at a time given one dial per host", () => {
        const limiter = new MemoryDialLimiter(1);
        const first = Promise.withResolvers<void>();
        const started: string[] = [];
        const host = new URL("ws://memory.test/");
        limiter.enqueue(host, () => {
          started.push("first");
          return first.promise;
        });
        limiter.enqueue(host, () => {
          started.push("second");
          return Promise.resolve();
        });
        expect(started).toEqual(["first"]);
        first.resolve();
      });
    });
  });

  describe("WebSocketTransport", () => {
    /** A transport over drivable sockets, and the sockets it has dialed. */
    const drivenTransport = (): {
      transport: WebSocketTransport;
      sockets: DrivableSockets;
    } => {
      const sockets = drivableSockets();
      const transport = new WebSocketTransport(
        new URL("ws://memory.test/api/storage/memory"),
        true,
        () => {},
        sockets.createSocket,
      );
      return { transport, sockets };
    };

    /** Sends a hello on `transport` and opens the socket it dials. */
    const openSocket = async (
      transport: WebSocketTransport,
      sockets: DrivableSockets,
    ): Promise<DrivableWebSocket> => {
      const hello = transport.send('fvj1:{"type":"hello"}');
      const socket = sockets.dials.at(-1)!;
      socket.openConnection();
      await hello;
      return socket;
    };

    /** Opens a socket and selects router streaming with `window` credit. */
    const selectCredits = async (
      transport: WebSocketTransport,
      sockets: DrivableSockets,
      window: number,
    ): Promise<DrivableWebSocket> => {
      const socket = await openSocket(transport, sockets);
      transport.setRoutedMessagesEnabled(true, 1, window);
      await socket.whenSent(2);
      return socket;
    };

    describe("setRoutedMessagesEnabled()", () => {
      it("sends no transport selection on a socket reset before the selection's turn", async () => {
        const { transport, sockets } = drivenTransport();
        try {
          const first = await openSocket(transport, sockets);
          transport.setRoutedMessagesEnabled(true, 1);
          transport.reset();
          const second = await openSocket(transport, sockets);
          expect(first.sent).toEqual(['fvj1:{"type":"hello"}']);
          expect(second.sent).toEqual(['fvj1:{"type":"hello"}']);

          // The same selection made on an open socket is sent there.
          transport.setRoutedMessagesEnabled(true, 1);
          await second.whenSent(2);
          expect(second.sent[1]).toBe(
            'fvj1:{"type":"router.transport","version":1}',
          );
        } finally {
          await transport.close();
        }
      });
    });

    describe("receiving", () => {
      it("does not count credit read from a reset socket toward the upload blocked on its replacement", async () => {
        const { transport, sockets } = drivenTransport();
        try {
          const old = await selectCredits(transport, sockets, 32_773);
          const stale = new HeldBlob();
          old.receive(stale);
          await stale.reading.promise;
          transport.reset();
          const active = await selectCredits(transport, sockets, 32_773);
          const upload = transport.send(
            `fvj1:${
              JSON.stringify({ type: "transact", value: "x".repeat(40_000) })
            }`,
          );
          const rejected = expect(upload).rejects.toMatchObject({
            name: "ConnectionError",
          });
          // The header record fits the window; the first body record waits.
          await active.whenSent(3);
          const header = active.sent[2];
          if (typeof header === "string") throw new Error("Expected a record");

          stale.release(creditFrame(header.length));
          await clock.settle();
          expect(active.sent).toHaveLength(3);

          // The same credit from the replacement releases the upload.
          active.receive(creditFrame(header.length).buffer);
          await active.whenSent(4);
          expect(active.readyState).toBe(1);
          await transport.close();
          await rejected;
        } finally {
          await transport.close();
        }
      });

      it("reports and closes a socket whose frame failed to decode even when describing the failure throws", async () => {
        const { transport, sockets } = drivenTransport();
        try {
          const socket = await openSocket(transport, sockets);
          transport.setRoutedMessagesEnabled(true);
          const closed = Promise.withResolvers<Error | undefined>();
          transport.setCloseReceiver(closed.resolve);
          const frame = new HeldBlob();
          socket.receive(frame);
          await frame.reading.promise;
          // An error whose name cannot be read, which the decode-failure
          // record reads.
          const cause = new (class extends Error {
            override get name(): string {
              throw new Error("unreadable name");
            }
          })("unreadable blob");
          frame.fail(cause);

          const error = await closed.promise;
          expect(error?.message).toBe(
            "Unable to decode compressed memory websocket message",
          );
          expect(error?.cause).toBe(cause);
          expect(socket.readyState).toBe(3);
        } finally {
          await transport.close();
        }
      });
    });

    describe("requestMessageCompression()", () => {
      it("sends its control as a memory boundary over routed messages without credit, and returns the answer", async () => {
        const { transport, sockets } = drivenTransport();
        try {
          const socket = await openSocket(transport, sockets);
          transport.setRoutedMessagesEnabled(true);
          transport.setMessageCompressionEnabled(true);
          const changing = transport.requestMessageCompression(false);
          await socket.whenSent(2);
          const control = socket.sent[1];
          if (typeof control !== "string") throw new Error("Expected text");
          const decoded = decodeMemoryBoundary<{
            type: string;
            requestId: string;
            enabled: boolean;
          }>(control);
          expect(decoded).toMatchObject({
            type: "memory.compression",
            enabled: false,
          });

          socket.receive(encodeMemoryBoundary({
            type: "memory.compression",
            requestId: decoded.requestId,
            enabled: false,
          }));
          expect(await changing).toBe(false);
        } finally {
          await transport.close();
        }
      });
    });
  });

  describe("createSignedConnectionAuth()", () => {
    it("throws the error its signer reports", async () => {
      const failure = new Error("signer refused");
      const signer: Signer = {
        did: () => owner.did(),
        sign: () => Promise.resolve({ error: failure }),
        verifier: owner.verifier,
      };
      await expect(
        createSignedConnectionAuth(signer, {
          audience: owner.did(),
          challenge: { value: "11".repeat(32), expiresAt: 0 },
        }),
      ).rejects.toBe(failure);
    });
  });
});
