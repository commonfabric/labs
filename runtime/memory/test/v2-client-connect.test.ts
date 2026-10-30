import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "../v2.ts";
import {
  connect,
  connectionError,
  isFirstHandshakeFailure,
  type Transport,
  transportClosedError,
} from "../v2/client.ts";

/**
 * What a transport does with one `hello`: `lost` loses the connection before
 * it opens, reporting the loss to the close receiver and then refusing the
 * send, as a socket closing before its open event does; `closed` refuses the
 * send as a transport closed for good; `ok` answers it.
 */
type HandshakeOutcome = "lost" | "closed" | "ok";

/** A transport whose handshakes go as the outcomes it is given, in order. */
class ScriptedHandshakes implements Transport {
  /** Runs each time the client discards a failed connection. */
  onReset: () => void = () => {};

  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #hellos = 0;
  readonly #outcomes: readonly HandshakeOutcome[];

  constructor(outcomes: readonly HandshakeOutcome[]) {
    this.#outcomes = outcomes;
  }

  /** How many `hello`s the client has sent. */
  get hellos(): number {
    return this.#hellos;
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as { type: string };
    if (message.type !== "hello") {
      return Promise.reject(new Error(`Unscripted ${message.type}`));
    }
    const outcome = this.#outcomes[this.#hellos++];
    switch (outcome) {
      case "lost": {
        // A socket's close arrives as an event, after the send that dialed it.
        const lost = Promise.withResolvers<void>();
        queueMicrotask(() => {
          this.#closeReceiver();
          lost.reject(
            connectionError("memory websocket transport closed before opening"),
          );
        });
        return lost.promise;
      }
      case "closed":
        return Promise.reject(transportClosedError("Memory transport closed"));
      case "ok":
        this.#receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          sessionOpen: {
            audience: "did:key:z6Mk-connect-audience",
            challenge: { value: "challenge:connect", expiresAt: 1_000_000 },
          },
        }));
        return Promise.resolve();
      default:
        return Promise.reject(new Error("Unscripted hello"));
    }
  }

  reset(): void {
    this.onReset();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("connect()", () => {
  describe("with `firstHandshakeAttempts`", () => {
    // Each attempt after the first waits out the client's reconnect backoff
    // on the real clock, which is tens of milliseconds for the first few.

    it("returns a connected client once a handshake after failed ones completes", async () => {
      const transport = new ScriptedHandshakes(["lost", "lost", "ok"]);
      const client = await connect({ transport, firstHandshakeAttempts: 3 });
      try {
        expect(client.connectionState).toBe("connected");
        expect(transport.hellos).toBe(3);
      } finally {
        await client.close();
      }
    });

    it("rejects with `firstHandshakeFailedError()` once every attempt fails, naming the address, the attempts and the last failure", async () => {
      const transport = new ScriptedHandshakes(["lost", "lost", "lost", "ok"]);
      const error = await connect({
        transport,
        address: "wss://memory.test/api/storage/memory",
        firstHandshakeAttempts: 3,
      }).then(() => undefined, (error: Error) => error);
      expect(transport.hellos).toBe(3);
      expect(isFirstHandshakeFailure(error)).toBe(true);
      expect(error?.message).toBe(
        "Memory connection to `wss://memory.test/api/storage/memory` failed " +
          "its first handshake 3 times; the last failure was " +
          '"ConnectionError": "memory transport closed"',
      );
      expect(error?.cause).toMatchObject({ name: "ConnectionError" });
    });

    it("rejects with the error of a handshake that fails permanently, without another attempt", async () => {
      const transport = new ScriptedHandshakes(["lost", "closed", "ok"]);
      await expect(connect({ transport, firstHandshakeAttempts: 5 }))
        .rejects.toThrow("Memory transport closed");
      expect(transport.hellos).toBe(2);
    });

    it("rejects with the abort reason when `signal` aborts between attempts", async () => {
      const transport = new ScriptedHandshakes(["lost", "ok"]);
      const controller = new AbortController();
      transport.onReset = () => controller.abort(new Error("route replaced"));
      await expect(connect({
        transport,
        signal: controller.signal,
        firstHandshakeAttempts: 5,
      })).rejects.toThrow("route replaced");
      expect(transport.hellos).toBe(1);
    });

    for (const attempts of [0, 1.5]) {
      it(`throws a \`RangeError\` given ${attempts}`, async () => {
        const transport = new ScriptedHandshakes(["ok"]);
        await expect(connect({ transport, firstHandshakeAttempts: attempts }))
          .rejects.toThrow(RangeError);
        expect(transport.hellos).toBe(0);
      });
    }
  });

  it("rejects when its only handshake is lost, without `firstHandshakeAttempts`", async () => {
    const transport = new ScriptedHandshakes(["lost", "lost"]);
    await expect(connect({ transport })).rejects.toMatchObject({
      name: "ConnectionError",
    });
  });
});
