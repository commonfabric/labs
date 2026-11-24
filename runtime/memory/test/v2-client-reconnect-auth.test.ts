import { assertEquals, assertRejects } from "@std/assert";
import type { FabricValue } from "@commonfabric/data-model";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "../v2.ts";
import { connect, type Transport } from "../v2/client.ts";

const TEST_AUDIENCE = "did:key:z6Mk-reconnect-auth-audience";

const helloOk = (flags = getMemoryProtocolFlags()) => ({
  type: "hello.ok",
  protocol: MEMORY_PROTOCOL,
  flags,
  sessionOpen: {
    audience: TEST_AUDIENCE,
    challenge: { value: "challenge:reconnect-auth", expiresAt: 1_000_000 },
  },
});

const sessionOpenFor = (id: string) => ({
  audience: TEST_AUDIENCE,
  challenge: {
    value: `challenge:reconnect-auth:${id}`,
    expiresAt: 1_000_000,
  },
});

const transactCommit = {
  localSeq: 1,
  reads: { confirmed: [], pending: [] },
  operations: [{
    op: "set" as const,
    id: "of:doc:1",
    value: { value: { version: 1 } },
  }],
};

/**
 * A transport whose Nth `session.open` returns a chosen response. Open #1 (the
 * initial mount) always succeeds; a later open — a reopen driven by
 * `session.restore()` — can be scripted to fail with an authorization error.
 */
class ScriptedOpenTransport implements Transport {
  #receiver: (payload: string) => void = () => {};
  #openCount = 0;

  readonly #openResponse: (
    count: number,
    requestId: string,
  ) => FabricValue;

  constructor(
    openResponse: (
      count: number,
      requestId: string,
    ) => FabricValue,
  ) {
    this.#openResponse = openResponse;
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(): void {}

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
    };
    switch (message.type) {
      case "hello":
        this.#respond(helloOk());
        return Promise.resolve();
      case "session.open":
        this.#openCount += 1;
        this.#respond(this.#openResponse(this.#openCount, message.requestId!));
        return Promise.resolve();
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

const openOk = (requestId: string): FabricValue => ({
  type: "response",
  requestId,
  ok: {
    sessionId: "session-A",
    sessionToken: "token:session-A",
    serverSeq: 0,
    sessionOpen: sessionOpenFor(requestId),
  },
});

const openAuthError = (
  requestId: string,
  message: string,
  retriable?: boolean,
): FabricValue => ({
  type: "response",
  requestId,
  error: {
    name: "AuthorizationError",
    message,
    ...(retriable ? { retriable: true } : {}),
  },
});

Deno.test(
  "a permanent authorization denial on reopen terminates only that session",
  async () => {
    const transport = new ScriptedOpenTransport((count, requestId) =>
      count === 2
        ? openAuthError(
          requestId,
          "Principal did:key:z6Mk-stranger lacks READ on space",
        )
        : openOk(requestId)
    );
    const client = await connect({ transport });
    const session = await client.mount("did:key:z6Mk-reconnect-auth-space");

    try {
      // Reopen is denied for a reason no retry can change; restore terminates
      // this session with the real error rather than rethrowing into a loop.
      await session.restore();

      const error = await assertRejects(
        () => session.transact(transactCommit),
        Error,
        "lacks READ",
      );
      assertEquals(error.name, "AuthorizationError");

      // The client stays connected; a fresh mount (open #3) still succeeds, so a
      // denial on one space did not kill the whole client.
      assertEquals(client.isConnected(), true);
      const other = await client.mount("did:key:z6Mk-reconnect-auth-other");
      assertEquals(other.sessionId, "session-A");
    } finally {
      await client.close();
    }
  },
);

Deno.test(
  "a retriable authorization race on reopen does not terminate the session",
  async () => {
    const transport = new ScriptedOpenTransport((count, requestId) =>
      count === 2
        ? openAuthError(
          requestId,
          "memory session.open challenge expired",
          true,
        )
        : openOk(requestId)
    );
    const client = await connect({ transport });
    const session = await client.mount("did:key:z6Mk-reconnect-auth-retriable");

    try {
      // A retriable auth race is rethrown (the reconnect loop retries it with a
      // fresh handshake) rather than terminating the session.
      await assertRejects(
        () => session.restore(),
        Error,
        "challenge expired",
      );
      assertEquals(session.sessionId, "session-A");
    } finally {
      await client.close();
    }
  },
);

const EMPTY_SYNC = {
  type: "sync" as const,
  fromSeq: 0,
  toSeq: 0,
  upserts: [],
  removes: [],
};

/**
 * A transport that opens and installs a watch normally, but denies the
 * `session.watch.set` that a fresh (non-resumed) reopen issues to re-establish
 * the watch. This drives the reopen-followup path in `restore()` — the denial
 * arrives AFTER `session.open` succeeded — which must still terminate only this
 * session, not escalate to a client-wide failure.
 */
class DenyWatchSetOnRestoreTransport implements Transport {
  #receiver: (payload: string) => void = () => {};
  #openCount = 0;

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(): void {}

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
    };
    switch (message.type) {
      case "hello":
        this.#respond(helloOk());
        return Promise.resolve();
      case "session.open":
        this.#openCount += 1;
        // A non-resumed reopen (no `resumed: true`), so restore() re-establishes
        // the watch set with a session.watch.set.
        this.#respond(openOk(message.requestId!));
        return Promise.resolve();
      case "session.watch.add":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: { serverSeq: 0, sync: EMPTY_SYNC },
        });
        return Promise.resolve();
      case "session.watch.set":
        // The reopen already succeeded; the watch re-establishment is denied.
        this.#respond(openAuthError(
          message.requestId!,
          "Principal did:key:z6Mk-stranger lacks READ on space",
        ));
        return Promise.resolve();
      default:
        throw new Error(`Unhandled watch-set-deny message: ${message.type}`);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

Deno.test(
  "a permanent denial re-establishing the watch on reopen terminates only that session",
  async () => {
    const transport = new DenyWatchSetOnRestoreTransport();
    const client = await connect({ transport });
    const session = await client.mount("did:key:z6Mk-reconnect-auth-watchset");

    try {
      await session.watchAdd([{
        id: "root",
        kind: "graph",
        query: {
          roots: [{ id: "of:doc:1", selector: { path: [], schema: false } }],
        },
      }]);

      // Reopen succeeds, but re-establishing the watch is denied permanently.
      // This denial arrives OUTSIDE the reopen() call, so it must be caught by
      // restore()'s outer handler and terminate only this session.
      await session.restore();

      const error = await assertRejects(
        () => session.transact(transactCommit),
        Error,
        "lacks READ",
      );
      assertEquals(error.name, "AuthorizationError");

      // The client is not fatal: a fresh mount still succeeds.
      assertEquals(client.isConnected(), true);
      const other = await client.mount("did:key:z6Mk-reconnect-auth-watchset2");
      assertEquals(other.sessionId, "session-A");
    } finally {
      await client.close();
    }
  },
);

/**
 * A transport that answers the first `hello` compatibly, then — after its close
 * receiver is fired — answers the reconnect `hello` with an incompatible
 * data-model flag, the permanent handshake failure.
 */
class FlagMismatchOnReconnectTransport implements Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #helloCount = 0;

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  triggerClose(): void {
    this.#closeReceiver(new Error("disconnect"));
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
    };
    switch (message.type) {
      case "hello": {
        this.#helloCount += 1;
        const flags = getMemoryProtocolFlags();
        this.#respond(
          this.#helloCount === 1
            ? helloOk()
            : helloOk({ ...flags, modernCellRep: !flags.modernCellRep }),
        );
        return Promise.resolve();
      }
      case "session.open":
        this.#respond(openOk(message.requestId!));
        return Promise.resolve();
      default:
        throw new Error(`Unhandled flag-mismatch message: ${message.type}`);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

Deno.test(
  "a permanent handshake mismatch on reconnect fails fast instead of looping",
  async () => {
    const transport = new FlagMismatchOnReconnectTransport();
    const client = await connect({ transport });
    await client.mount("did:key:z6Mk-reconnect-auth-flags");

    try {
      transport.triggerClose();

      // The reconnect handshake is incompatible and no retry changes that, so
      // the client gives up and every request fails fast with the real error —
      // it does not spin the reconnect loop forever.
      const error = await assertRejects(
        () => client.restoreConnection(),
        Error,
        "flag mismatch",
      );
      assertEquals(error.name, "ProtocolError");
      // Still fatal on the next attempt, without reconnecting.
      await assertRejects(
        () => client.restoreConnection(),
        Error,
        "flag mismatch",
      );
    } finally {
      await client.close();
    }
  },
);
