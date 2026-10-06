/**
 * Covers the connection state `Client` reports and the promise it hands a
 * caller waiting for the next report of it. The states are the branches
 * `#ensureConnected()` takes, and the cases hold the getter to the part of
 * that order a caller can observe — `#connected` ahead of the fall through
 * to `reconnecting`, and `#closed` ahead of `#fatalError` — checking it
 * against `isConnected()` where the two are meant to agree.
 *
 * The transport these cases run on can be severed on demand by firing the
 * close receiver the client registered, which is the entry point a lost
 * socket takes. Each transition is therefore observed as it happens rather
 * than waited out: nothing polls and nothing sleeps.
 *
 * How a failure here reads is worth knowing before debugging one. A
 * transition the client makes without notifying leaves a case awaiting a
 * promise nothing will resolve, and Deno fails the run on the drained event
 * loop with `Promise resolution is still pending but the event loop has
 * already resolved`, the transcript's last unfinished line naming the case.
 * Where a later notification resolves that waiter instead, the case fails on
 * the state it then reads, as an ordinary value diff. Both land immediately:
 * nothing here waits out a timeout, so neither reads as a flake.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { FabricValue } from "@commonfabric/data-model";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "../v2.ts";
import { connect, type ConnectionState, type Transport } from "../v2/client.ts";

const TEST_AUDIENCE = "did:key:z6Mk-connection-state-audience";

const helloOk = (flags = getMemoryProtocolFlags()): FabricValue => ({
  type: "hello.ok",
  protocol: MEMORY_PROTOCOL,
  flags,
  sessionOpen: {
    audience: TEST_AUDIENCE,
    challenge: { value: "challenge:connection-state", expiresAt: 1_000_000 },
  },
});

const openOk = (requestId: string): FabricValue => ({
  type: "response",
  requestId,
  ok: {
    sessionId: "session-A",
    sessionToken: "token:session-A",
    serverSeq: 0,
    sessionOpen: {
      audience: TEST_AUDIENCE,
      challenge: {
        value: `challenge:connection-state:${requestId}`,
        expiresAt: 1_000_000,
      },
    },
  },
});

const retriableDenial = (requestId: string): FabricValue => ({
  type: "response",
  requestId,
  error: {
    name: "AuthorizationError",
    message: "memory session.open challenge expired",
    retriable: true,
  },
});

/** What a reconnect's `hello` receives, which is what decides whether that
 *  reconnect completes, stalls, or is given up on. */
type ReconnectHello = "ok" | "mismatch" | "silence";

/**
 * A transport that answers the first `hello` compatibly and can be severed on
 * demand, the way a lost socket severs a real one. Every `session.open` runs
 * `onSessionOpen` before it is answered, so a test can read the client from
 * inside the reopen that a completing reconnect performs.
 */
class SeverableTransport implements Transport {
  /** Runs at the top of each `session.open`, the mount's included. */
  onSessionOpen: () => void = () => {};

  /** Whether to deny the reopen a reconnect performs, retriably. The mount's
   *  own open is always answered, so a test reaches this by severing. */
  denyReopen = false;

  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #helloCount = 0;
  #helloAccepted = false;
  #openCount = 0;
  readonly #reconnectHello: ReconnectHello;

  constructor(reconnectHello: ReconnectHello) {
    this.#reconnectHello = reconnectHello;
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  /** Drops the connection by firing the close receiver the client registered,
   *  which is the same entry point a real transport's socket loss takes. */
  sever(): void {
    this.reset();
    this.#closeReceiver(new Error("socket lost"));
  }

  /** Drops the scripted connection's handshake state. */
  reset(): void {
    this.#helloAccepted = false;
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
    };
    switch (message.type) {
      case "hello":
        if (this.#helloAccepted) {
          throw new Error("scripted connection already accepted hello");
        }
        this.#helloAccepted = true;
        this.#helloCount += 1;
        this.#respondToHello();
        return Promise.resolve();
      case "session.open":
        this.#openCount += 1;
        this.onSessionOpen();
        this.#respond(
          this.denyReopen && this.#openCount > 1
            ? retriableDenial(message.requestId!)
            : openOk(message.requestId!),
        );
        return Promise.resolve();
      default:
        throw new Error(`Unhandled message: ${message.type}`);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #respondToHello(): void {
    if (this.#helloCount === 1 || this.#reconnectHello === "ok") {
      this.#respond(helloOk());
      return;
    }
    if (this.#reconnectHello === "mismatch") {
      const flags = getMemoryProtocolFlags();
      this.#respond(helloOk({ ...flags, modernCellRep: !flags.modernCellRep }));
    }
    // "silence" answers nothing, leaving the reconnect in flight. `close()`
    // still ends it: rejecting the pending hello unblocks the handshake, and
    // the reconnect loop then sees the client closed and stops.
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

const connectSeverable = async (reconnectHello: ReconnectHello) => {
  const transport = new SeverableTransport(reconnectHello);
  const client = await connect({ transport });
  const session = await client.mount("did:key:z6Mk-connection-state-space");
  return { transport, client, session };
};

describe("Client", () => {
  describe("instance members", () => {
    describe("connectionState and whenStateChanged()", () => {
      // `whenStateChanged()` says when to look and `.connectionState` says
      // what is there, and most cases here use both, driving the client
      // through one to three notifications and waiting on each in turn. Two
      // use the getter alone, where what is under test is what it returns
      // rather than when.
      //
      // A notification need not carry a transition. A second `close()`
      // raises one that does not, and so does the reconnect loop's catch on
      // a refused handshake, where the client is `reconnecting` both before
      // the notification and after it. So a case asserts the state it reads
      // on waking, never that a wakeup means a change.
      //
      // Every wait resolves on an event the client raises: a severed
      // socket, a refused handshake or reopen, a `close()`. Nothing polls
      // and nothing sleeps.
      //
      // Each waiter is registered before the notification it observes. That
      // is how a caller uses it too: the loop in the doc comment reads the
      // getter and calls `whenStateChanged()` in one synchronous step, with
      // no chance for the state to move in between.

      it("returns `connected` for a client whose transport is up", async () => {
        const { client } = await connectSeverable("ok");

        try {
          expect(client.connectionState).toBe("connected");
          expect(client.isConnected()).toBe(true);
        } finally {
          await client.close();
        }
      });

      it("moves to `reconnecting` when the transport is severed", async () => {
        const { transport, client } = await connectSeverable("silence");

        try {
          const changed = client.whenStateChanged();
          transport.sever();
          await changed;

          expect(client.connectionState).toBe("reconnecting");
          expect(client.isConnected()).toBe(false);
        } finally {
          await client.close();
        }
      });

      it("moves back to `connected` when a reconnect succeeds", async () => {
        const { transport, client } = await connectSeverable("ok");

        try {
          const severed = client.whenStateChanged();
          transport.sever();
          await severed;
          expect(client.connectionState).toBe("reconnecting");

          const restored = client.whenStateChanged();
          await restored;

          expect(client.connectionState).toBe("connected");
          expect(client.isConnected()).toBe(true);
        } finally {
          await client.close();
        }
      });

      it("moves to `failed` when the client gives up reconnecting", async () => {
        const { transport, client } = await connectSeverable("mismatch");

        try {
          const severed = client.whenStateChanged();
          transport.sever();
          await severed;
          expect(client.connectionState).toBe("reconnecting");

          // The refused handshake is still travelling: its rejection was
          // queued behind this waiter's wakeup, so registering the next waiter
          // here happens before the client gives up.
          const gaveUp = client.whenStateChanged();
          await gaveUp;

          expect(client.connectionState).toBe("failed");
          expect(client.isConnected()).toBe(false);
        } finally {
          await client.close();
        }
      });

      it("rejects pending session restoration when reconnecting fails permanently", async () => {
        const { transport, client, session } = await connectSeverable(
          "mismatch",
        );
        const opening = Promise.withResolvers<void>();
        const failedOpen = Promise.withResolvers<never>();
        const transient = new Error("transient reopen failure");
        const held = stub(client, "openSession", () => {
          opening.resolve();
          return failedOpen.promise;
        });
        try {
          const first = session.restore();
          const failed = expect(first).rejects.toBe(transient);
          let state = "pending";
          const ready = session.whenRestored().then(() => {
            state = "restored";
          }, (error) => {
            state = "rejected";
            return error;
          });
          await opening.promise;
          failedOpen.reject(transient);
          await failed;
          expect(state).toBe("pending");
          held.restore();

          transport.sever();
          await expect(client.restoreConnection()).rejects.toThrow(
            "flag mismatch",
          );
          expect(client.connectionState).toBe("failed");
          expect(session.closeError).toBeInstanceOf(Error);
          expect(session.closeError?.message).toContain("flag mismatch");
          expect(await ready).toBe(session.closeError);
          expect(state).toBe("rejected");
          await expect(session.whenRestored()).rejects.toBe(session.closeError);
        } finally {
          if (!held.restored) held.restore();
          await client.close();
        }
      });

      it("rejects session restoration when the handshake fails before reopening", async () => {
        const { transport, client, session } = await connectSeverable(
          "mismatch",
        );
        const restore = stub(session, "restore", () => {
          throw new Error("incompatible handshake must not reopen a session");
        });
        try {
          transport.sever();
          await expect(client.restoreConnection()).rejects.toThrow(
            "flag mismatch",
          );
          expect(restore.calls).toHaveLength(0);
          expect(session.closeError).toBeInstanceOf(Error);
          expect(session.closeError?.message).toContain("flag mismatch");
          await expect(session.whenRestored()).rejects.toBe(session.closeError);
        } finally {
          restore.restore();
          await client.close();
        }
      });

      it("moves back to `reconnecting` when reopening a session fails", async () => {
        const { transport, client } = await connectSeverable("ok");
        transport.denyReopen = true;

        try {
          const severed = client.whenStateChanged();
          transport.sever();
          await severed;

          // The handshake succeeds, so the client is connected again before
          // it reopens its sessions. The reopen is then denied for a reason a
          // retry can change, which drops it back without a fresh close.
          const reconnected = client.whenStateChanged();
          await reconnected;
          expect(client.connectionState).toBe("connected");

          const lost = client.whenStateChanged();
          await lost;

          expect(client.connectionState).toBe("reconnecting");
          expect(client.isConnected()).toBe(false);
        } finally {
          await client.close();
        }
      });

      it("moves to `closed` when a failed client is closed", async () => {
        const { transport, client } = await connectSeverable("mismatch");

        const severed = client.whenStateChanged();
        transport.sever();
        await severed;
        const gaveUp = client.whenStateChanged();
        await gaveUp;
        expect(client.connectionState).toBe("failed");

        const closed = client.whenStateChanged();
        await client.close();
        await closed;

        expect(client.connectionState).toBe("closed");
      });

      it("wakes a waiter on a closed client when it is closed again", async () => {
        // The wakeup is unconditional rather than conditioned on the state
        // having moved. Suppressing it would need a second copy of the state
        // to compare against, and a notification missed at any write site
        // would then leave that copy stale, turning a missed wakeup into a
        // suppressed later one.

        const { client } = await connectSeverable("ok");
        await client.close();

        const changed = client.whenStateChanged();
        await client.close();
        await changed;

        expect(client.connectionState).toBe("closed");
      });

      it("moves to `closed` when the client is closed", async () => {
        const { client } = await connectSeverable("ok");
        const changed = client.whenStateChanged();

        await client.close();
        await changed;

        expect(client.connectionState).toBe("closed");
        expect(client.isConnected()).toBe(false);
      });

      it("returns `connected` while a reconnect reopens its sessions", async () => {
        const { transport, client } = await connectSeverable("ok");
        const readings: ConnectionState[] = [];

        try {
          // The reopen runs after the reconnect's handshake has marked the
          // client connected and before the reconnect itself has finished.
          // The window stays open until the `finally` clears `#reconnecting`
          // a microtask after the loop returns; this hook is where a
          // synchronous reader can catch it.
          transport.onSessionOpen = () => {
            readings.push(client.connectionState);
          };
          transport.sever();
          await client.restoreConnection();

          expect(readings).toEqual(["connected"]);
          expect(client.isConnected()).toBe(true);
        } finally {
          await client.close();
        }
      });
    });
  });
});
