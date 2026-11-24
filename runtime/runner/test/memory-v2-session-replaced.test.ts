/**
 * The storage manager's report that a space's memory session was replaced on
 * reconnect. A restarted server holds no session to resume, so it answers a
 * reconnect's `session.open` with `resumed` unset; the transport here stands
 * in for that restart by rewriting the reply of a real server, whose session
 * registry still holds the session.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import type * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type {
  IStorageProvider,
  MemorySpace,
} from "../src/storage/interface.ts";
import {
  SingleSessionFactory,
  TEST_MEMORY_SERVER_AUTH,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-session-replaced");
const space = signer.did();

/** A loopback transport over a real server that can drop its connection,
 * and can answer the reconnect's `session.open` as a restarted server
 * would. */
class RestartingTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<MemoryV2Server.Server["connect"]> | null = null;
  #replaceReopen = false;
  #openRequestId: string | null = null;

  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  /** Drops the connection; with `restarted`, the reconnect's reopen is
   * answered without resuming the session. */
  reconnect(options: { restarted: boolean }): void {
    this.#replaceReopen = options.restarted;
    this.#connection?.close();
    this.#connection = null;
    queueMicrotask(() => this.#closeReceiver(new Error("disconnect")));
  }

  async send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type?: string;
      requestId?: string;
    };
    if (message.type === "session.open" && this.#replaceReopen) {
      this.#openRequestId = message.requestId ?? null;
    }
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

  #openConnection(): ReturnType<MemoryV2Server.Server["connect"]> {
    if (this.#connection === null) {
      this.#connection = this.#server.connect((message) => {
        const framed = message as {
          type?: string;
          requestId?: string;
          ok?: { resumed?: boolean };
        };
        if (
          framed.type === "response" && framed.ok !== undefined &&
          framed.requestId !== undefined &&
          framed.requestId === this.#openRequestId
        ) {
          this.#openRequestId = null;
          this.#replaceReopen = false;
          delete framed.ok.resumed;
        }
        this.#receiver(encodeMemoryBoundary(message));
      });
    }
    return this.#connection;
  }
}

describe("memory-v2 session replaced", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("reports the space when a reconnect replaces its session, and not when it resumes", async () => {
    const server = new MemoryV2Server.Server({
      ...TEST_MEMORY_SERVER_AUTH,
      store: new URL(`memory://runner-v2-replaced-${crypto.randomUUID()}`),
    });
    const transport = new RestartingTransport(server);
    const storageManager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://runner-v2-replaced"),
    }, new SingleSessionFactory(transport));
    cleanups.push(() => storageManager.close(), () => server.close());

    const reported: MemorySpace[] = [];
    storageManager.subscribeSpaceSessionReplaced((replacedSpace) => {
      reported.push(replacedSpace);
    });
    const provider = storageManager.open(space) as IStorageProvider & {
      sync(uri: URI): Promise<unknown>;
    };
    const barrier = () =>
      provider.sync(`of:memory-v2-barrier-${crypto.randomUUID()}` as URI);
    await barrier();
    await storageManager.synced();

    transport.reconnect({ restarted: false });
    await barrier();
    expect(reported).toEqual([]);

    transport.reconnect({ restarted: true });
    await barrier();
    expect(reported).toEqual([space]);
  });
});
