/**
 * A frame the transport receives and cannot decode (past the negotiated size
 * or slot cap, a compressed frame that does not inflate, an invalid router
 * credit) may already count as delivered on the server. The transport
 * reports it with `receiveFailedError()`, and the client then treats every
 * session's delivery as invalid before the reconnect, exactly as it does for
 * a frame it decoded but could not parse: a session with a holdings provider
 * restores by declaring what the replica holds, and one without a provider
 * against a server that cannot take a declaration is terminated.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { defer } from "@commonfabric/utils/defer";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type SessionHolding,
} from "../v2.ts";
import { connect, receiveFailedError, type Transport } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-client-receive-failure";

type Sent = { type?: string; holdings?: SessionHolding[] };

/**
 * A loopback transport over a real server that can report a frame it could
 * not decode, the way the runner's WebSocket transport does: it drops the
 * connection and hands the tagged error to the close receiver.
 */
class FailingReceiveTransport implements Transport {
  readonly sent: Sent[] = [];
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  readonly #server: Server;
  readonly #stripSessionHoldings: boolean;

  constructor(server: Server, stripSessionHoldings: boolean) {
    this.#server = server;
    this.#stripSessionHoldings = stripSessionHoldings;
  }

  async send(payload: string): Promise<void> {
    this.sent.push(decodeMemoryBoundary(payload) as Sent);
    await this.#openConnection().receive(payload);
  }

  close(): Promise<void> {
    this.#connection?.close();
    this.#connection = null;
    return Promise.resolve();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  /** Reports a frame past the negotiated cap, as the WebSocket transport does. */
  failReceive(): void {
    this.#connection?.close();
    this.#connection = null;
    queueMicrotask(() =>
      this.#closeReceiver(
        receiveFailedError(
          "Unable to decode compressed memory websocket message",
          new Error("Routed memory request denied"),
        ),
      )
    );
  }

  #openConnection(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.#connection = this.#server.connect((message) => {
        const framed = message as { type?: string; flags?: object };
        const projected =
          this.#stripSessionHoldings && framed.type === "hello.ok" &&
            framed.flags !== undefined
            ? { ...framed, flags: { ...framed.flags, sessionHoldings: false } }
            : message;
        this.#receiver(encodeMemoryBoundary(projected));
      });
    }
    return this.#connection;
  }
}

const newServer = (name: string): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${name}-${crypto.randomUUID()}`),
  });

const DECLARED: SessionHolding[] = [{ id: "of:client-held", seq: 3 }];

describe("client receive failures", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("terminates a session without a provider when a transport decode failure needs a baseline the server cannot take", async () => {
    const server = newServer("receive-failure-no-provider");
    const transport = new FailingReceiveTransport(server, true);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
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
    transport.failReceive();
    // The close is reported a microtask later; the reconnect that follows
    // restores the session, which cannot resume against the server's
    // delivery cache, and this server takes no declaration, so the session
    // ends.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await client.restoreConnection();
    await session.whenRestored().catch(() => {});
    expect(session.closeError?.message).toContain("sessionHoldings");
    await expect(session.watchSet([])).rejects.toThrow("sessionHoldings");
  });

  it("restores a session with a provider by declaring the replica's holdings after a transport decode failure", async () => {
    const server = newServer("receive-failure-provider");
    const transport = new FailingReceiveTransport(server, false);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    session.holdingsProvider = () => DECLARED;
    const reopened = defer<Sent>();
    const original = transport.send.bind(transport);
    transport.send = async (payload: string) => {
      await original(payload);
      const last = transport.sent.at(-1);
      if (last?.type === "session.open") reopened.resolve(last);
    };
    transport.failReceive();
    expect((await reopened.promise).holdings).toEqual(DECLARED);
    await session.whenRestored();
    expect(session.closeError).toBeUndefined();
  });
});
