/**
 * The client half of declared holdings (04-protocol.md §4.1.2): on every
 * reconnect the session asks its consumer what the replica holds and puts
 * the answer on the wire — on the resuming `session.open`, and on the
 * `session.watch.set` that re-establishes the watches when the server no
 * longer has the session. The session itself holds no documents; the
 * statement is the consumer's, through `holdingsProvider`.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { defer } from "@commonfabric/utils/defer";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  resetServerExecutionConfig,
  type SessionHolding,
  setServerExecutionConfig,
} from "../v2.ts";
import { connect, type Transport } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-client-holdings";

type Sent = { type?: string; holdings?: SessionHolding[]; views?: unknown[] };

/**
 * A loopback transport over a real server whose connection can be
 * dropped, recording every request the client sends so the reconnect's
 * requests can be inspected. `retarget` points later connections at a
 * different server — the shape of a server that forgot the session.
 * `stripSessionHoldings` erases that flag from the server's `hello.ok` —
 * the shape of a server that cannot take a declaration.
 */
class DroppableTransport implements Transport {
  readonly sent: Sent[] = [];
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;

  #server: Server;
  readonly #stripSessionHoldings: boolean;
  readonly #stripViewReplication: boolean;

  constructor(
    server: Server,
    stripSessionHoldings = false,
    stripViewReplication = false,
  ) {
    this.#server = server;
    this.#stripSessionHoldings = stripSessionHoldings;
    this.#stripViewReplication = stripViewReplication;
  }

  async send(payload: string): Promise<void> {
    this.sent.push(decodeMemoryBoundary(payload) as Sent);
    await this.#openConnection().receive(payload);
  }

  close(): Promise<void> {
    this.disconnect();
    return Promise.resolve();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    queueMicrotask(() => this.#closeReceiver(new Error("disconnect")));
  }

  retarget(server: Server): void {
    this.#server = server;
  }

  #openConnection(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.#connection = this.#server.connect((message) => {
        this.#receiver(encodeMemoryBoundary(this.#project(message)));
      });
    }
    return this.#connection;
  }

  #project<T>(message: T): T {
    if (this.#stripSessionHoldings || this.#stripViewReplication) {
      const framed = message as { type?: string; flags?: object };
      if (framed.type === "hello.ok" && framed.flags !== undefined) {
        return {
          ...framed,
          flags: {
            ...framed.flags,
            ...(this.#stripSessionHoldings ? { sessionHoldings: false } : {}),
            ...(this.#stripViewReplication
              ? { viewScopedReplicationV1: false }
              : {}),
          },
        } as T;
      }
    }
    return message;
  }
}

const newServer = (name: string): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${name}-${crypto.randomUUID()}`),
  });

/** Resolves once the transport has sent a request of `type` carrying
 * holdings, with those holdings. */
const holdingsSentOn = (
  transport: DroppableTransport,
  type: string,
): Promise<SessionHolding[]> => {
  const seen = defer<SessionHolding[]>();
  const original = transport.send.bind(transport);
  transport.send = async (payload: string) => {
    await original(payload);
    const last = transport.sent.at(-1);
    if (last?.type === type && last.holdings !== undefined) {
      seen.resolve(last.holdings);
    }
  };
  return seen.promise;
};

const DECLARED: SessionHolding[] = [{ id: "of:client-held", seq: 3 }];

describe("client holdings", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("refuses visible roots before sending them to an unsupported server", async () => {
    setServerExecutionConfig(true);
    cleanups.push(() => {
      resetServerExecutionConfig();
      return Promise.resolve();
    });
    const server = newServer("unsupported-view");
    const transport = new DroppableTransport(server, false, true);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    const views = [{
      id: "screen",
      revision: 0,
      mode: "render" as const,
      componentContractVersion: "1",
      query: { roots: [] },
    }];
    const sent = transport.sent.length;
    await expect(session.viewSetSync(views)).rejects.toThrow(
      "Server does not support view-scoped replication",
    );
    await expect(session.watchSetSync([], undefined, views)).rejects.toThrow(
      "Server does not support view-scoped replication",
    );
    expect(transport.sent).toHaveLength(sent);
    expect(server.viewInterestsForSpace(SPACE)).toEqual([]);
    await session.close();
    const closeError = session.closeError;
    session.handleConnectionFailure(new Error("late connection failure"));
    expect(session.closeError).toBe(closeError);
  });

  it("declares current replica holdings when replacing visible roots", async () => {
    setServerExecutionConfig(true);
    const server = newServer("view-holdings");
    const transport = new DroppableTransport(server);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close(), () => {
      resetServerExecutionConfig();
      return Promise.resolve();
    });
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    session.holdingsProvider = () => DECLARED;
    await session.viewSetSync([{
      id: "screen",
      revision: 0,
      mode: "speculate",
      componentContractVersion: "1",
      query: {
        roots: [{ id: "of:view", selector: { path: [], schema: false } }],
      },
    }]);
    expect(
      transport.sent.filter((message) => message.type === "session.watch.set")
        .at(-1)?.holdings,
    ).toEqual(DECLARED);
    session.holdingsProvider = () => [];
    await session.viewSetSync([]);
    expect(
      transport.sent.filter((message) => message.type === "session.watch.set")
        .at(-1)?.holdings,
    ).toEqual([]);
  });

  it("keeps a queued cancellation authoritative during watch restoration", async () => {
    setServerExecutionConfig(true);
    const server = newServer("view-cancel-restore");
    const transport = new DroppableTransport(server);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close(), () => {
      resetServerExecutionConfig();
      return Promise.resolve();
    });
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    await session.viewSetSync([{
      id: "screen",
      revision: 0,
      mode: "speculate",
      componentContractVersion: "1",
      query: {
        roots: [{ id: "of:view", selector: { path: [], schema: false } }],
      },
    }]);
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const restoring = Promise.withResolvers<void>();
    const send = transport.send.bind(transport);
    const heldSend = stub(transport, "send", async (payload) => {
      if (
        (decodeMemoryBoundary(payload) as Sent).type === "session.watch.add"
      ) {
        entered.resolve();
        await released.promise;
      }
      await send(payload);
    });
    const open = client.openSession.bind(client);
    const forgotten = stub(client, "openSession", async (...args) => ({
      ...await open(...args),
      resumed: false,
    }));
    const set = session.watchSetSync.bind(session);
    const observedRestore = stub(session, "watchSetSync", (...args) => {
      const request = set(...args);
      restoring.resolve();
      return request;
    });
    try {
      const prior = session.watchAddSync([{
        id: "ordinary",
        kind: "graph",
        query: {
          roots: [{ id: "of:ordinary", selector: { path: [], schema: false } }],
        },
      }]);
      await entered.promise;
      const cancel = session.viewSetSync([]);
      const restore = session.restore();
      await restoring.promise;
      released.resolve();
      await Promise.all([prior, cancel, restore]);
      expect(server.viewInterestsForSpace(SPACE)).toEqual([]);
      expect(server.demandedInstancesForSpace(SPACE).map((row) => row.id))
        .toContain("of:ordinary");
      await session.restore();
      expect(server.viewInterestsForSpace(SPACE)).toEqual([]);
      expect(server.demandedInstancesForSpace(SPACE).map((row) => row.id))
        .toContain("of:ordinary");
    } finally {
      released.resolve();
      observedRestore.restore();
      forgotten.restore();
      heldSend.restore();
    }
  });

  it("clears view interests on a true resume after capability loss", async () => {
    setServerExecutionConfig(true);
    const server = newServer("view-downgrade-resume");
    const transport = new DroppableTransport(server);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close(), () => {
      resetServerExecutionConfig();
      return Promise.resolve();
    });
    const reopen = Promise.withResolvers<void>();
    let opening = 0;
    const session = await client.mount(SPACE, {}, async (...args) => {
      if (opening++ > 0) await reopen.promise;
      return await testSessionOpenAuthFactory(...args);
    });
    const initialSession = session.sessionId;
    await session.watchSet([{
      id: "ordinary",
      kind: "graph",
      query: {
        roots: [{ id: "of:ordinary", selector: { path: [], schema: false } }],
      },
    }]);
    await session.viewSetSync([{
      id: "screen",
      revision: 0,
      mode: "speculate",
      componentContractVersion: "1",
      query: {
        roots: [{ id: "of:view", selector: { path: [], schema: false } }],
      },
    }]);
    expect(server.viewInterestsForSpace(SPACE)).toHaveLength(1);
    const lost = Promise.withResolvers<void>();
    let restored = false;
    let ready: Promise<void> | undefined;
    session.subscribeViewCapabilityLost(() => {
      ready = session.whenRestored().then(() => {
        restored = true;
      });
      lost.resolve();
    });
    setServerExecutionConfig(false);
    transport.disconnect();
    await lost.promise;
    expect(restored).toBe(false);
    reopen.resolve();
    await ready;
    expect(session.sessionId).toBe(initialSession);
    expect(server.viewInterestsForSpace(SPACE)).toEqual([]);
    expect(restored).toBe(true);
  });

  it("declares the provider's holdings on the reopen that resumes a session", async () => {
    const server = newServer("client-holdings-resume");
    const transport = new DroppableTransport(server);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    session.holdingsProvider = () => DECLARED;
    await session.watchSet([{
      id: "w",
      kind: "graph",
      query: {
        roots: [{
          id: "of:client-held",
          selector: { path: [], schema: false },
        }],
      },
    }]);
    const reopened = holdingsSentOn(transport, "session.open");
    transport.disconnect();
    expect(await reopened).toEqual(DECLARED);
  });

  it("declares the provider's holdings on the watch.set that re-establishes a forgotten session", async () => {
    const server = newServer("client-holdings-forgotten");
    const transport = new DroppableTransport(server);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    session.holdingsProvider = () => DECLARED;
    await session.watchSet([{
      id: "w",
      kind: "graph",
      query: {
        roots: [{
          id: "of:client-held",
          selector: { path: [], schema: false },
        }],
      },
    }]);
    // A server that never saw the session: the open is not resumed, so
    // the client re-establishes its watches — declaring what it holds.
    const forgetful = newServer("client-holdings-forgetful");
    cleanups.push(() => forgetful.close());
    transport.retarget(forgetful);
    const reestablished = holdingsSentOn(transport, "session.watch.set");
    transport.disconnect();
    expect(await reestablished).toEqual(DECLARED);
    expect(transport.sent.at(-1)?.views).toBeUndefined();
  });

  it("terminates the session at restore when the server cannot take its declared holdings", async () => {
    const server = newServer("client-holdings-unsupported");
    const transport = new DroppableTransport(server, true);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    // The initial connection is allowed: nothing is held yet, so nothing
    // needs declaring, and the mount and its watches work in full.
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    session.holdingsProvider = () => DECLARED;
    await session.watchSet([{
      id: "w",
      kind: "graph",
      query: {
        roots: [{
          id: "of:client-held",
          selector: { path: [], schema: false },
        }],
      },
    }]);
    // Restoration is not: a declaration-bearing session cannot fall back
    // to the delivery paths the declaration exists to replace, so the
    // restore terminates the session with the cause.
    await session.restore();
    expect(session.closeError?.message).toContain("sessionHoldings");
    await expect(session.watchSet([])).rejects.toThrow("sessionHoldings");
  });

  it("restores a session without a provider against a server that cannot take holdings", async () => {
    const server = newServer("client-holdings-unsupported-no-provider");
    const transport = new DroppableTransport(server, true);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    // No provider means no declaration to lose: the declaration-less
    // delivery paths are this consumer's contract, on any server.
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    await session.restore();
    expect(session.closeError).toBeUndefined();
  });

  it("declares nothing when no provider is installed", async () => {
    const server = newServer("client-holdings-none");
    const transport = new DroppableTransport(server);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    // The mount's own open is already sent; the next one is the reconnect's.
    const reopened = defer<Sent>();
    const original = transport.send.bind(transport);
    transport.send = async (payload: string) => {
      await original(payload);
      const last = transport.sent.at(-1);
      if (last?.type === "session.open") reopened.resolve(last);
    };
    transport.disconnect();
    const reopen = await reopened.promise;
    assert(reopen !== undefined, "the reconnect reopened the session");
    expect("holdings" in reopen).toBe(false);
  });
});
