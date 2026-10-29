import { assert, assertEquals } from "@std/assert";
import { defer } from "@commonfabric/utils/defer";
import { Server } from "../v2/server.ts";
import { connect, type Transport } from "../v2/client.ts";
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

const waitFor = async (
  predicate: () => boolean,
  timeout = 2000,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

Deno.test(
  "commits enqueued during restore are eventually flushed",
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
    const suppressDisconnectRejection = (event: PromiseRejectionEvent) => {
      if (
        event.reason instanceof Error &&
        event.reason.name === "ConnectionError" &&
        event.reason.message === "disconnect"
      ) {
        event.preventDefault();
      }
    };
    globalThis.addEventListener(
      "unhandledrejection",
      suppressDisconnectRejection,
    );

    try {
      // Seed doc:a.
      await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:a", value: { value: { v: 1 } } }],
      });

      // Hold transact responses so we can enqueue during the replay window.
      transport.delayTransacts = true;

      // Start commit B — it will be held at the transport layer.
      const commitBPromise = session.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:b", value: { value: { v: 2 } } }],
      });

      // Wait for the transact to reach the transport.
      await transport.firstPendingTransact;
      assertEquals(transport.delayedTransactLocalSeqs, [2]);

      // Disconnect while commit B's transact is held — commit B becomes
      // outstanding and will be replayed during restore.
      transport.disconnect();

      // Wait for reconnect replay of commit B to reach the transport so we know
      // restore is actively replaying while commit C is enqueued.
      await waitFor(
        () =>
          transport.delayedTransactLocalSeqs.filter((localSeq) =>
            localSeq === 2
          ).length >= 2,
      );

      // While the replay transact is held (and #restoring is true), enqueue
      // commit C.
      const commitCPromise = session.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:c", value: { value: { v: 3 } } }],
      });
      await Promise.resolve();
      assert(
        !transport.delayedTransactLocalSeqs.includes(3),
        "commit C should wait for restore to finish instead of sending during replay",
      );

      // Release all delayed transacts.
      transport.delayTransacts = false;
      await transport.releaseTransacts();

      // Both commits should resolve.
      let timeoutId: ReturnType<typeof setTimeout>;
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), 5000);
      });

      const result = await Promise.race([
        Promise.all([commitBPromise, commitCPromise]).then(
          () => "resolved" as const,
        ).catch((e) => `error:${e.message}` as const),
        timeout,
      ]);
      clearTimeout(timeoutId!);

      assert(
        result === "resolved",
        `Commits enqueued during restore should flush, but got: ${result}`,
      );

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
      assertEquals(
        transport.deliveredTransactLocalSeqs.filter((localSeq) =>
          localSeq === 3
        )
          .length,
        1,
      );
      assertEquals(transport.deliveredTransactLocalSeqs.at(-1), 3);
      assertEquals(transport.connectionCount, 2);
    } finally {
      globalThis.removeEventListener(
        "unhandledrejection",
        suppressDisconnectRejection,
      );
      await client.close();
      await server.flushSessions();
      await server.close();
    }
  },
);

Deno.test(
  "closing a session during restore does not replay queued commits after close begins",
  async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://restore-flush-close-test"),
    });

    const transport = new ReconnectableTransport(server);
    const client = await connect({ transport });
    const session = await client.mount(
      SPACE,
      {},
      testSessionOpenAuthFactory,
    );
    const suppressDisconnectRejection = (event: PromiseRejectionEvent) => {
      if (
        event.reason instanceof Error &&
        event.reason.name === "ConnectionError" &&
        event.reason.message === "disconnect"
      ) {
        event.preventDefault();
      }
    };
    globalThis.addEventListener(
      "unhandledrejection",
      suppressDisconnectRejection,
    );

    try {
      await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:a", value: { value: { v: 1 } } }],
      });

      transport.delayTransacts = true;

      const commitBPromise = session.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:b", value: { value: { v: 2 } } }],
      });

      await transport.firstPendingTransact;
      transport.disconnect();

      await waitFor(
        () =>
          transport.delayedTransactLocalSeqs.filter((localSeq) =>
            localSeq === 2
          ).length >= 2,
      );

      const commitCPromise = session.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:c", value: { value: { v: 3 } } }],
      });
      await Promise.resolve();
      assertEquals(transport.delayedTransactLocalSeqs.includes(3), false);

      const closePromise = session.close();
      await Promise.resolve();

      transport.delayTransacts = false;
      await transport.releaseTransacts();

      const [commitBResult, commitCResult, closeResult] = await Promise
        .allSettled([
          commitBPromise,
          commitCPromise,
          closePromise,
        ]);

      assertEquals(commitBResult.status, "fulfilled");
      assertEquals(closeResult.status, "fulfilled");
      assertEquals(commitCResult.status, "rejected");
      if (commitCResult.status !== "rejected") {
        throw new Error("Expected commit C to be rejected after close()");
      }
      assertEquals(
        commitCResult.reason instanceof Error,
        true,
      );
      assertEquals(
        (commitCResult.reason as Error).message,
        "memory session closed",
      );
      assertEquals(
        transport.deliveredTransactLocalSeqs.filter((localSeq) =>
          localSeq === 3
        ).length,
        0,
      );
    } finally {
      globalThis.removeEventListener(
        "unhandledrejection",
        suppressDisconnectRejection,
      );
      await client.close();
      await server.flushSessions();
      await server.close();
    }
  },
);
