/**
 * The client half of a session's declared read ceiling
 * (`SessionDescriptor.readCeiling`, 04-protocol.md §4.1.2). The server takes
 * the ceiling from the descriptor of a session's LAST open, so the session
 * has to re-declare it on every reopen, and it may only ever open against a
 * server that records one.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type SessionReadCeiling,
} from "../v2.ts";
import { connect, type Transport } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-client-read-ceiling";

const ceiling: SessionReadCeiling = {
  maxConfidentiality: ["did:key:z6Mk-owner"],
  onExceed: "skip",
};

/**
 * A loopback transport over a real server whose connection can be dropped,
 * recording the type of every request the client sends. `stripFlag` erases
 * `sessionReadCeiling` from every `hello.ok` from then on — the shape of a
 * server that does not record a session's ceiling.
 */
class DroppableTransport implements Transport {
  readonly sent: string[] = [];
  stripFlag = false;

  /** Resolved when the client sends its second `session.open`: a reopen. */
  readonly reopened = Promise.withResolvers<void>();
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  readonly #server: Server;

  constructor(server: Server) {
    this.#server = server;
  }

  async send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as { type?: string };
    this.sent.push(message.type ?? "");
    if (this.sent.filter((type) => type === "session.open").length === 2) {
      this.reopened.resolve();
    }
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

  #openConnection(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.#connection = this.#server.connect((message) => {
        this.#receiver(encodeMemoryBoundary(this.#project(message)));
      });
    }
    return this.#connection;
  }

  #project<T>(message: T): T {
    const framed = message as { type?: string; flags?: object };
    if (this.stripFlag && framed.type === "hello.ok" && framed.flags) {
      return {
        ...framed,
        flags: { ...framed.flags, sessionReadCeiling: false },
      } as T;
    }
    return message;
  }
}

describe("v2-client-read-ceiling", () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const newServer = (): Server => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL(`memory://client-read-ceiling-${crypto.randomUUID()}`),
    });
    cleanups.push(() => server.close());
    return server;
  };

  it("re-declares the ceiling on the reopen that follows a dropped connection", async () => {
    const server = newServer();
    const transport = new DroppableTransport(server);
    const client = await connect({ transport });
    cleanups.push(() => client.close());
    const session = await client.mount(
      SPACE,
      { readCeiling: ceiling },
      testSessionOpenAuthFactory,
    );
    expect(server.sessionReadCeiling(SPACE, session.sessionId)).toEqual(
      ceiling,
    );
    transport.disconnect();
    await transport.reopened.promise;
    await session.whenRestored();
    expect(transport.sent.filter((type) => type === "session.open"))
      .toHaveLength(2);
    expect(server.sessionReadCeiling(SPACE, session.sessionId)).toEqual(
      ceiling,
    );
  });

  it("throws on a mount declaring a ceiling against a server that does not advertise `sessionReadCeiling`, sending no `session.open`", async () => {
    const server = newServer();
    const transport = new DroppableTransport(server);
    transport.stripFlag = true;
    const client = await connect({ transport });
    cleanups.push(() => client.close());
    await expect(
      client.mount(SPACE, { readCeiling: ceiling }, testSessionOpenAuthFactory),
    ).rejects.toThrow(/sessionReadCeiling/);
    expect(transport.sent).not.toContain("session.open");
  });

  it("mounts a session declaring no ceiling against such a server", async () => {
    const server = newServer();
    const transport = new DroppableTransport(server);
    transport.stripFlag = true;
    const client = await connect({ transport });
    cleanups.push(() => client.close());
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    expect(server.sessionReadCeiling(SPACE, session.sessionId))
      .toBeUndefined();
  });
});
