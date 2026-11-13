import { assert, assertEquals } from "@std/assert";
import { defer } from "@commonfabric/async/defer";
import { Server } from "../v2/server.ts";
import {
  connect,
  isUnacknowledgedError,
  type Transport,
} from "../v2/client.ts";
import { decodeMemoryBoundary, encodeMemoryBoundary } from "../v2.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-restore-flush-test";

/**
 * Transport that wraps a real Server with lazy connection creation and
 * controlled disconnect/reconnect. Follows the same pattern as
 * ReconnectableLoopbackTransport in v2-client.test.ts.
 */
class ReconnectableTransport implements Transport {
  connectionCount = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connectionCache: ReturnType<Server["connect"]> | null = null;
  #delayTransacts = false;
  #transactRequestLocalSeqById = new Map<string, number>();
  #delayedTransactResponses: Array<{
    payload: string;
    localSeq: number;
  }> = [];
  #deliveredTransactLocalSeqs: number[] = [];
  #firstPendingTransact = defer<void>();

  readonly #server: Server;

  constructor(server: Server) {
    this.#server = server;
  }

  async send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type?: string;
      requestId?: string;
      commit?: { localSeq?: number };
    };
    if (
      message.type === "transact" &&
      typeof message.requestId === "string" &&
      typeof message.commit?.localSeq === "number"
    ) {
      this.#transactRequestLocalSeqById.set(
        message.requestId,
        message.commit.localSeq,
      );
    }
    await this.#deliver(payload);
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
    this.#connectionCache?.close();
    this.#connectionCache = null;
    queueMicrotask(() => this.#closeReceiver(new Error("disconnect")));
  }

  set delayTransacts(value: boolean) {
    this.#delayTransacts = value;
  }

  get pendingTransactCount(): number {
    return this.#delayedTransactResponses.length;
  }

  get firstPendingTransact(): Promise<void> {
    return this.#firstPendingTransact.promise;
  }

  get delayedTransactLocalSeqs(): number[] {
    return this.#delayedTransactResponses.map(({ localSeq }) => localSeq);
  }

  get deliveredTransactLocalSeqs(): number[] {
    return [...this.#deliveredTransactLocalSeqs];
  }

  releaseTransacts(): Promise<void> {
    const delayed = this.#delayedTransactResponses.splice(0);
    for (const { payload } of delayed) {
      this.#receiver(payload);
    }
    return Promise.resolve();
  }

  async #deliver(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      commit?: { localSeq?: number };
    };
    if (typeof message.commit?.localSeq === "number") {
      this.#deliveredTransactLocalSeqs.push(message.commit.localSeq);
    }
    await this.#connection().receive(payload);
  }

  #connection(): ReturnType<Server["connect"]> {
    if (this.#connectionCache === null) {
      this.connectionCount++;
      this.#connectionCache = this.#server.connect((message) => {
        const response = message as { requestId?: string };
        const requestId = response.requestId;
        const localSeq = typeof requestId === "string"
          ? this.#transactRequestLocalSeqById.get(requestId)
          : undefined;
        const payload = encodeMemoryBoundary(message);
        if (
          this.#delayTransacts &&
          typeof requestId === "string" &&
          typeof localSeq === "number"
        ) {
          this.#transactRequestLocalSeqById.delete(requestId);
          this.#delayedTransactResponses.push({ payload, localSeq });
          this.#firstPendingTransact.resolve();
          return;
        }
        if (typeof requestId === "string") {
          this.#transactRequestLocalSeqById.delete(requestId);
        }
        this.#receiver(payload);
      });
    }
    return this.#connectionCache;
  }
}

Deno.test(
  "a commit a drop caught, sent again once its session is back, is answered from the server's record, and a later commit lands after it",
  async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://restore-flush-test"),
    });

    const transport = new ReconnectableTransport(server);
    const client = await connect({ transport });
    const session = await client.mount(
      SPACE,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:a", value: { value: { v: 1 } } }],
      });

      // The server handles commit B, and its answer is held when the
      // connection drops.
      transport.delayTransacts = true;
      const commitB = {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set" as const,
          id: "doc:b",
          value: { value: { v: 2 } },
        }],
      };
      const failedB = session.transact(commitB).catch((e) => e);
      await transport.firstPendingTransact;
      transport.disconnect();
      const error = await failedB;
      assert(isUnacknowledgedError(error), String(error));
      transport.delayTransacts = false;

      await error.readyToRetry();
      const appliedB = await session.transact(commitB);
      const appliedC = await session.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:c", value: { value: { v: 3 } } }],
      });
      assert(appliedC.seq > appliedB.seq);

      const queried = await session.queryGraph({
        roots: [
          { id: "doc:b", selector: { path: [], schema: false } },
          { id: "doc:c", selector: { path: [], schema: false } },
        ],
      });
      assertEquals(
        Object.fromEntries(
          queried.entities.map((entity) => [entity.id, entity.document?.value]),
        ),
        {
          "doc:b": { v: 2 },
          "doc:c": { v: 3 },
        },
      );
      assertEquals(transport.connectionCount, 2);
    } finally {
      await client.close();
      await server.flushSessions();
      await server.close();
    }
  },
);
