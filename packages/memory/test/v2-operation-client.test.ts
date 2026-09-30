import { ChangeSet } from "@codemirror/state";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { defer } from "@commonfabric/utils/defer";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  connect,
  loopback,
  SpaceSession,
  type Transport,
} from "../v2/client.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import { sameWatchSpec } from "../v2/server-sync.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
  OperationCodecRegistry,
} from "../v2/operation-codec.ts";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  toValuePath,
} from "../v2.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

class ReconnectableOperationTransport implements Transport {
  connectionCount = 0;
  watchSetCount = 0;
  lastOperationAfter: { epoch: number; version: number } | undefined;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connectionCache: ReturnType<Server["connect"]> | null = null;
  #reconnected = defer<void>();
  #secondWatchSet = defer<void>();
  #reconnectGate: ReturnType<typeof defer<void>> | undefined;
  #failNextEffect = false;

  readonly #server: Server;

  constructor(server: Server) {
    this.#server = server;
  }

  get reconnected(): Promise<void> {
    return this.#reconnected.promise;
  }

  get secondWatchSet(): Promise<void> {
    return this.#secondWatchSet.promise;
  }

  async send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type?: string;
      watches?: Array<{
        kind?: string;
        query?: { after?: { epoch: number; version: number } };
      }>;
    };
    if (
      this.#connectionCache === null && this.connectionCount > 0 &&
      this.#reconnectGate !== undefined
    ) {
      await this.#reconnectGate.promise;
      this.#reconnectGate = undefined;
    }
    await this.#connection().receive(payload);
    if (message.type === "session.watch.set") {
      this.watchSetCount++;
      this.lastOperationAfter = message.watches?.find((watch) =>
        watch.kind === "operation"
      )?.query?.after;
      if (this.watchSetCount >= 2) this.#secondWatchSet.resolve();
    }
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
    this.#closeReceiver(new Error("disconnect"));
  }

  holdReconnect(): void {
    this.#reconnectGate = defer<void>();
  }

  releaseReconnect(): void {
    this.#reconnectGate?.resolve();
  }

  failNextEffect(): void {
    this.#failNextEffect = true;
  }

  #connection(): ReturnType<Server["connect"]> {
    if (this.#connectionCache === null) {
      this.connectionCount++;
      if (this.connectionCount >= 2) this.#reconnected.resolve();
      this.#connectionCache = this.#server.connect((message) => {
        if (this.#failNextEffect && message.type === "session/effect") {
          this.#failNextEffect = false;
          throw new Error("synthetic operation effect failure");
        }
        this.#receiver(encodeMemoryBoundary(message));
      });
    }
    return this.#connectionCache;
  }
}

describe("v2-operation-client", () => {
  it("compares every operation-watch cursor and address dimension", () => {
    const watch = {
      id: "operation:body",
      kind: "operation" as const,
      query: {
        id: "of:watch",
        path: toValuePath(["body"]),
      },
    };

    expect(sameWatchSpec(watch, structuredClone(watch))).toBe(true);
    expect(sameWatchSpec(watch, {
      ...watch,
      query: { ...watch.query, branch: "feature" },
    })).toBe(false);
    expect(sameWatchSpec(watch, {
      ...watch,
      query: { ...watch.query, scope: "user" },
    })).toBe(false);
    expect(sameWatchSpec(watch, {
      ...watch,
      query: { ...watch.query, after: { epoch: 1, version: 2 } },
    })).toBe(false);
  });

  it("rejects operation requests when the server lacks the capability", async () => {
    const client = {
      serverFlags: { applyOp: false },
      isConnected: () => true,
      restoreConnection: () => Promise.resolve(),
      request: () => Promise.reject(new Error("request should not be sent")),
    };
    const session = new SpaceSession(
      client as never,
      "did:key:z6Mk-operation-unsupported",
      "session:unsupported",
      "token",
      0,
    );

    await expect(session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "apply-op",
        id: "of:unsupported",
        path: toValuePath([]),
        codec: CODEMIRROR_CHANGESET_CODEC,
        submissionId: "unsupported:1",
        base: null,
        baselineHash: operationBaselineHash(null),
        payload: { updates: [] },
      }],
    })).rejects.toThrow("does not support apply-op");
    await expect(session.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "release-op-field",
        id: "of:unsupported",
        path: toValuePath([]),
        codec: CODEMIRROR_CHANGESET_CODEC,
        cursor: { epoch: 1, version: 0 },
      }],
    })).rejects.toThrow("does not support apply-op");
    await expect(session.queryOperationField({
      id: "of:unsupported",
      path: toValuePath([]),
    })).rejects.toThrow("does not support apply-op");
  });

  it("reports operation query, reset, and codec failures through the server", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-server-errors"),
      operationCheckpointInterval: 1,
    });
    const client = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-server-errors";
    const session = await client.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      const missing = new SpaceSession(
        client,
        spaceId,
        "session:missing",
        "token",
        0,
      );
      await expect(missing.queryOperationField({
        id: "of:missing",
        path: toValuePath([]),
      })).rejects.toThrow("Session is not open");
      expect(
        (await server.operationFieldQuery({
          type: "op.query",
          requestId: "query:unknown-session",
          space: spaceId,
          sessionId: "session:missing",
          query: { id: "of:missing", path: toValuePath([]) },
        })).error?.name,
      ).toBe("SessionError");

      expect(
        (await server.operationFieldQuery({
          type: "op.query",
          requestId: "query:malformed",
          space: spaceId,
          sessionId: session.sessionId,
          query: { id: "", path: toValuePath([]) },
        })).error?.name,
      ).toBe("ProtocolError");

      await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:reset-query",
          value: { value: { body: "a" } },
        }],
      });
      await session.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:reset-query",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "reset:1",
          base: null,
          baselineHash: operationBaselineHash("a"),
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
            }],
          },
        }],
      });
      await session.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:reset-query",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "reset:2",
          base: { epoch: 1, version: 1 },
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 2, insert: "c" }, 2).toJSON(),
            }],
          },
        }],
      });
      const reset = await server.operationFieldQuery({
        type: "op.query",
        requestId: "query:reset",
        space: spaceId,
        sessionId: session.sessionId,
        query: {
          id: "of:reset-query",
          path: toValuePath(["body"]),
          after: { epoch: 1, version: 0 },
        },
      });
      expect(reset.ok?.field.reset).toBe(true);

      const codecFailure = await server.transact({
        type: "transact",
        requestId: "transact:codec-failure",
        space: spaceId,
        sessionId: session.sessionId,
        commit: {
          localSeq: 4,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:reset-query",
            path: toValuePath(["body"]),
            codec: "other@1",
            submissionId: "reset:bad-codec",
            base: { epoch: 1, version: 2 },
            payload: { updates: [] },
          }],
        },
      });
      expect(codecFailure.error?.name).toBe("OpCodecError");

      const releaseCodecFailure = await server.transact({
        type: "transact",
        requestId: "transact:release-codec-failure",
        space: spaceId,
        sessionId: session.sessionId,
        commit: {
          localSeq: 5,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "release-op-field",
            id: "of:reset-query",
            path: toValuePath(["body"]),
            codec: "malformed",
            cursor: { epoch: 1, version: 2 },
          }],
        },
      });
      expect(releaseCodecFailure.error?.name).toBe("OpCodecError");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects an operation query whose session closes during authorization", async () => {
    const sessions = new SessionRegistry();
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-query-close-race"),
      sessions,
    });
    const client = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-query-close-race";
    const session = await client.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      const response = server.operationFieldQuery({
        type: "op.query",
        requestId: "query:closing-session",
        space: spaceId,
        sessionId: session.sessionId,
        query: { id: "of:closing-session", path: toValuePath([]) },
      });
      sessions.remove(spaceId, session.sessionId);
      expect((await response).error?.name).toBe("SessionError");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("omits operation snapshots when a watch session closes mid-request", async () => {
    const sessions = new SessionRegistry();
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-watch-close-race"),
      sessions,
    });
    const client = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-watch-close-race";
    const session = await client.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      const response = server.watchSet({
        type: "session.watch.set",
        requestId: "watch:closing-session",
        space: spaceId,
        sessionId: session.sessionId,
        watches: [{
          id: "closing-operation",
          kind: "operation",
          query: { id: "of:closing-operation", path: toValuePath([]) },
        }],
      });
      sessions.remove(spaceId, session.sessionId);
      expect((await response).ok?.sync.operationFields).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("replays preceding operation cursors onto a newly installed watch", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = {
      isConnected: () => true,
      request: (request: Record<string, unknown>) => {
        requests.push(request);
        if (request.type === "session.ack") return Promise.resolve({});
        return Promise.resolve({
          serverSeq: 1,
          sync: {
            type: "sync",
            fromSeq: 1,
            toSeq: 1,
            upserts: [],
            removes: [],
          },
        });
      },
    };
    const session = new SpaceSession(
      client as never,
      "did:key:z6Mk-operation-cursor-race",
      "session:cursor-race",
      "token",
      0,
    );
    session.handleEffect({
      type: "sync",
      fromSeq: 0,
      toSeq: 1,
      upserts: [],
      removes: [],
      operationFields: [{
        watchId: "racing-operation",
        field: {
          branch: "",
          id: "of:racing-operation",
          scopeKey: "space",
          path: toValuePath(["body"]),
          active: true,
          codec: CODEMIRROR_CHANGESET_CODEC,
          cursor: { epoch: 1, version: 3 },
          baselineHash: "baseline",
          materialized: "abc",
          operations: [],
        },
      }],
    });
    await session.watchAddSync([{
      id: "racing-operation",
      kind: "operation",
      query: {
        id: "of:racing-operation",
        path: toValuePath(["body"]),
      },
    }]);
    await session.watchRemoveSync([]);

    const set = requests.find((request) =>
      request.type === "session.watch.set"
    ) as { watches: Array<{ query: { after?: unknown } }> };
    expect(set.watches[0].query.after).toEqual({ epoch: 1, version: 3 });
  });

  it("returns a typed error when operation telemetry cannot encode a payload", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-malformed-telemetry"),
    });
    const client = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-malformed-telemetry";
    const session = await client.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      const response = await server.transact({
        type: "transact",
        requestId: "malformed-operation-payload",
        space: spaceId,
        sessionId: session.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:malformed-payload",
            path: toValuePath([]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "malformed:1",
            base: null,
            baselineHash: operationBaselineHash(null),
            payload: (() => {}) as never,
          }],
        },
      });
      expect(response.error?.name).toBe("TransactionError");
      expect(response.error?.message).toContain(
        "Cannot encode function",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("transacts and queries operation history over a memory session", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-client"),
    });
    const client = await connect({ transport: loopback(server) });
    const space = await client.mount(
      "did:key:z6Mk-memory-v2-operation-client",
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await space.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:collaborative",
          value: { value: { body: "ac" } },
        }],
      });
      const applied = await space.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:collaborative",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "client:1",
          base: null,
          baselineHash: operationBaselineHash("ac"),
          payload: {
            updates: [{
              clientId: "client",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 2).toJSON(),
            }],
          },
        }],
      });
      const queried = await space.queryOperationField({
        id: "of:collaborative",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 0 },
      });

      expect(applied.operationResolutions?.[0]).toMatchObject({
        submissionId: "client:1",
        to: { epoch: 1, version: 1 },
      });
      expect(queried.field).toMatchObject({
        active: true,
        materialized: "abc",
        cursor: { epoch: 1, version: 1 },
      });
      expect(queried.field.operations).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("delivers operation snapshots through session watches", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-watch"),
      subscriptionRefreshDelayMs: "manual",
    });
    const writerClient = await connect({ transport: loopback(server) });
    const watcherClient = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-watch";
    const writer = await writerClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const watcher = await watcherClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:collaborative",
          value: { value: { body: "ac" } },
        }],
      });
      const watched = await watcher.watchSetSync([{
        id: "body-operations",
        kind: "operation",
        query: {
          id: "of:collaborative",
          path: toValuePath(["body"]),
        },
      }]);
      expect(watched.sync.operationFields?.[0]).toMatchObject({
        watchId: "body-operations",
        field: { active: false, materialized: "ac" },
      });
      const syncs = watched.view.subscribeSync();

      await writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:collaborative",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:1",
          base: null,
          baselineHash: operationBaselineHash("ac"),
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 2).toJSON(),
            }],
          },
        }],
      });
      await server.flushSessions();
      const delivered = await syncs.next();

      expect(delivered.done).toBe(false);
      expect(delivered.value.operationFields?.[0]).toMatchObject({
        watchId: "body-operations",
        field: {
          active: true,
          materialized: "abc",
          cursor: { epoch: 1, version: 1 },
        },
      });
      expect(delivered.value.operationFields?.[0].field.operations)
        .toHaveLength(
          1,
        );

      await writer.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "release-op-field",
          id: "of:collaborative",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          cursor: { epoch: 1, version: 1 },
        }],
      });
      await server.flushSessions();
      expect((await syncs.next()).value.operationFields?.[0]).toMatchObject({
        watchId: "body-operations",
        field: {
          active: false,
          cursor: null,
          materialized: "abc",
          operations: [],
        },
      });

      await writer.transact({
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:collaborative",
          patches: [{
            op: "replace",
            path: "/value/body",
            value: "ordinary",
          }],
        }],
      });
      await server.flushSessions();
      expect((await syncs.next()).value.operationFields?.[0]).toMatchObject({
        field: {
          active: false,
          cursor: null,
          materialized: "ordinary",
        },
      });

      await writer.transact({
        localSeq: 5,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "of:collaborative" }],
      });
      await server.flushSessions();
      expect((await syncs.next()).value.operationFields?.[0]).toMatchObject({
        field: {
          active: false,
          cursor: null,
          materialized: null,
        },
      });
    } finally {
      await writerClient.close();
      await watcherClient.close();
      await server.close();
    }
  });

  it("redelivers operation history after a mixed frame send fails", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-mixed-rollback"),
      subscriptionRefreshDelayMs: "manual",
    });
    const transport = new ReconnectableOperationTransport(server);
    const watcherClient = await connect({ transport });
    const writerClient = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-mixed-rollback";
    const watcher = await watcherClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const writer = await writerClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:mixed",
          value: { value: { body: "a" } },
        }],
      });
      const watched = await watcher.watchSetSync([{
        id: "mixed-document",
        kind: "graph",
        query: {
          roots: [{
            id: "of:mixed",
            selector: { path: [], schema: false },
          }],
        },
      }, {
        id: "mixed-operations",
        kind: "operation",
        query: {
          id: "of:mixed",
          path: toValuePath(["body"]),
        },
      }]);
      const syncs = watched.view.subscribeSync();

      transport.failNextEffect();
      await writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:mixed",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:mixed",
          base: null,
          baselineHash: operationBaselineHash("a"),
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
            }],
          },
        }],
      });
      await server.flushSessions([spaceId]);
      await server.flushSessions([spaceId]);

      const delivered = await syncs.next();
      expect(delivered.value.upserts).toEqual([
        expect.objectContaining({
          id: "of:mixed",
          doc: { value: { body: "ab" } },
        }),
      ]);
      expect(delivered.value.operationFields).toEqual([{
        watchId: "mixed-operations",
        field: expect.objectContaining({
          cursor: { epoch: 1, version: 1 },
          materialized: "ab",
          operations: [expect.objectContaining({
            cursor: { epoch: 1, version: 1 },
            submissionId: "writer:mixed",
          })],
        }),
      }]);
    } finally {
      await writerClient.close();
      await watcherClient.close();
      await server.close();
    }
  });

  it("does not retain an operation watch whose initial snapshot fails", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-watch-add-staging"),
    });
    const writerClient = await connect({ transport: loopback(server) });
    const watcherClient = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-watch-add-staging";
    const writer = await writerClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const watcher = await watcherClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:staged-watch",
          value: { value: { body: "a" } },
        }],
      });
      await writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:staged-watch",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:staged",
          base: null,
          baselineHash: operationBaselineHash("a"),
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
            }],
          },
        }],
      });

      await expect(watcher.watchAddSync([{
        id: "staged-operations",
        kind: "operation",
        query: {
          id: "of:staged-watch",
          path: toValuePath(["body"]),
          after: { epoch: 1, version: 99 },
        },
      }])).rejects.toThrow("cursor is in the future");

      const added = await watcher.watchAddSync([{
        id: "staged-operations",
        kind: "operation",
        query: {
          id: "of:staged-watch",
          path: toValuePath(["body"]),
          after: { epoch: 1, version: 0 },
        },
      }]);
      expect(added.sync.operationFields?.[0].field).toMatchObject({
        cursor: { epoch: 1, version: 1 },
        materialized: "ab",
      });
    } finally {
      await writerClient.close();
      await watcherClient.close();
      await server.close();
    }
  });

  it("keeps operation-only watches out of server-execution demand", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-watch-demand"),
    });
    const client = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-watch-demand";
    const session = await client.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await session.watchSetSync([{
        id: "operation-only",
        kind: "operation",
        query: {
          id: "of:operation-only",
          path: toValuePath(["body"]),
        },
      }]);
      expect(server.watchedRootsForSpace(spaceId)).toEqual([]);
      expect(server.demandedInstancesForSpace(spaceId)).toEqual([]);

      await session.watchAddSync([{
        id: "graph-demand",
        kind: "graph",
        query: {
          roots: [{
            id: "of:operation-only",
            selector: { path: [], schema: false },
          }],
        },
      }]);
      expect(server.demandedInstancesForSpace(spaceId)).toMatchObject([{
        id: "of:operation-only",
        scope: "space",
        root: true,
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("removes an operation watch without disturbing graph watches", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-watch-remove"),
      subscriptionRefreshDelayMs: "manual",
    });
    const writerClient = await connect({ transport: loopback(server) });
    const watcherClient = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-watch-remove";
    const writer = await writerClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const watcher = await watcherClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:removed-watch",
          value: { value: { body: "a" } },
        }],
      });
      const watched = await watcher.watchSetSync([{
        id: "removed-document",
        kind: "graph",
        query: {
          roots: [{
            id: "of:removed-watch",
            selector: { path: [], schema: false },
          }],
        },
      }, {
        id: "removed-operations",
        kind: "operation",
        query: {
          id: "of:removed-watch",
          path: toValuePath(["body"]),
        },
      }]);
      const removed = await watcher.watchRemoveSync(["removed-operations"]);
      expect(removed.sync.operationFields).toBeUndefined();
      const syncs = watched.view.subscribeSync();

      await writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:removed-watch",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:removed",
          base: null,
          baselineHash: operationBaselineHash("a"),
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
            }],
          },
        }],
      });
      await server.flushSessions([spaceId]);
      const delivered = await syncs.next();
      expect(delivered.value.operationFields).toBeUndefined();
      expect(delivered.value.upserts).toEqual([
        expect.objectContaining({
          id: "of:removed-watch",
          doc: { value: { body: "ab" } },
        }),
      ]);
    } finally {
      await writerClient.close();
      await watcherClient.close();
      await server.close();
    }
  });

  it("negotiates and executes a configured non-text codec", async () => {
    const operationCodecs = new OperationCodecRegistry([{
      id: "test-counter@1",
      integrate({ materialized, submitted }) {
        const by = isObjectNotArray(submitted)
          ? (submitted as { by?: unknown }).by
          : undefined;
        if (
          typeof materialized !== "number" || typeof by !== "number"
        ) {
          throw new Error("counter operation requires numeric values");
        }
        return {
          materialized: materialized + by,
          operations: [{ by }],
        };
      },
    }]);
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-custom-codec"),
      operationCodecs,
    });
    const client = await connect({ transport: loopback(server) });
    const space = await client.mount(
      "did:key:z6Mk-memory-v2-operation-custom-codec",
      {},
      testSessionOpenAuthFactory,
    );

    try {
      expect(client.serverFlags?.operationCodecs).toEqual(["test-counter@1"]);
      await space.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:counter",
          value: { value: { count: 1 } },
        }],
      });
      await space.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:counter",
          path: toValuePath(["count"]),
          codec: "test-counter@1",
          submissionId: "counter:1",
          base: null,
          baselineHash: operationBaselineHash(1),
          payload: { by: 2 },
        }],
      });

      expect(
        await space.queryOperationField({
          id: "of:counter",
          path: toValuePath(["count"]),
        }),
      ).toMatchObject({
        field: {
          active: true,
          codec: "test-counter@1",
          materialized: 3,
          operations: [{ payload: { by: 2 } }],
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("resumes an operation watch across reconnect without duplicating cursors", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-reconnect"),
    });
    const transport = new ReconnectableOperationTransport(server);
    const watcherClient = await connect({ transport });
    const writerClient = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-reconnect";
    const watcher = await watcherClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const writer = await writerClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const originalSessionId = watcher.sessionId;

    try {
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:reconnect",
          value: { value: { body: "a" } },
        }],
      });
      const watched = await watcher.watchSetSync([{
        id: "body-operations",
        kind: "operation",
        query: {
          id: "of:reconnect",
          path: toValuePath(["body"]),
        },
      }]);
      const syncs = watched.view.subscribeSync();

      transport.disconnect();
      await writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:reconnect",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:1",
          base: null,
          baselineHash: operationBaselineHash("a"),
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
            }],
          },
        }],
      });
      await transport.reconnected;

      const resumed = await syncs.next();
      expect(resumed.done).toBe(false);
      expect(resumed.value.operationFields).toEqual([{
        watchId: "body-operations",
        field: expect.objectContaining({
          active: true,
          cursor: { epoch: 1, version: 1 },
          materialized: "ab",
          operations: [expect.objectContaining({
            cursor: { epoch: 1, version: 1 },
            submissionId: "writer:1",
          })],
        }),
      }]);
      expect(transport.watchSetCount).toBe(1);
      expect(watcher.sessionId).toBe(originalSessionId);

      await writer.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:reconnect",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:2",
          base: { epoch: 1, version: 1 },
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 2, insert: "c" }, 2).toJSON(),
            }],
          },
        }],
      });
      const next = await syncs.next();
      expect(next.value.operationFields?.[0].field).toMatchObject({
        cursor: { epoch: 1, version: 2 },
        materialized: "abc",
        operations: [{
          cursor: { epoch: 1, version: 2 },
          submissionId: "writer:2",
        }],
      });
    } finally {
      await writerClient.close();
      await watcherClient.close();
      await server.close();
    }
  });

  it("reinstalls a replaced-session watch from the last delivered cursor", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-reinstall"),
      sessions: new SessionRegistry({ ttlMs: 0 }),
    });
    const transport = new ReconnectableOperationTransport(server);
    const watcherClient = await connect({ transport });
    const writerClient = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-reinstall";
    const watcher = await watcherClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const writer = await writerClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:reinstall",
          value: { value: { body: "a" } },
        }],
      });
      const watched = await watcher.watchSetSync([{
        id: "body-operations",
        kind: "operation",
        query: {
          id: "of:reinstall",
          path: toValuePath(["body"]),
        },
      }]);
      const syncs = watched.view.subscribeSync();
      await writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:reinstall",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:1",
          base: null,
          baselineHash: operationBaselineHash("a"),
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
            }],
          },
        }],
      });
      expect((await syncs.next()).value.operationFields?.[0].field.cursor)
        .toEqual({ epoch: 1, version: 1 });

      transport.disconnect();
      await transport.secondWatchSet;
      expect(transport.lastOperationAfter).toEqual({ epoch: 1, version: 1 });
      const reinstall = await syncs.next();
      expect(reinstall.value.operationFields?.[0].field).toMatchObject({
        cursor: { epoch: 1, version: 1 },
        operations: [],
      });

      await writer.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:reinstall",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:2",
          base: { epoch: 1, version: 1 },
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 2, insert: "c" }, 2).toJSON(),
            }],
          },
        }],
      });
      expect((await syncs.next()).value.operationFields?.[0].field)
        .toMatchObject({
          cursor: { epoch: 1, version: 2 },
          materialized: "abc",
          operations: [{
            cursor: { epoch: 1, version: 2 },
            submissionId: "writer:2",
          }],
        });
    } finally {
      await writerClient.close();
      await watcherClient.close();
      await server.close();
    }
  });

  it("resets a reconnecting watch whose cursor predates retained history", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-retained-reset"),
      operationCheckpointInterval: 2,
    });
    const transport = new ReconnectableOperationTransport(server);
    const watcherClient = await connect({ transport });
    const writerClient = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-retained-reset";
    const watcher = await watcherClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const writer = await writerClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:retained-reset",
          value: { value: { body: "a" } },
        }],
      });
      const watched = await watcher.watchSetSync([{
        id: "body-operations",
        kind: "operation",
        query: {
          id: "of:retained-reset",
          path: toValuePath(["body"]),
        },
      }]);
      const syncs = watched.view.subscribeSync();
      const append = async (version: number, value: string) => {
        await writer.transact({
          localSeq: version + 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained-reset",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: `writer:${version}`,
            base: version === 1 ? null : { epoch: 1, version: version - 1 },
            ...(version === 1
              ? { baselineHash: operationBaselineHash("a") }
              : {}),
            payload: {
              updates: [{
                clientId: "writer",
                changes: ChangeSet.of(
                  { from: version, insert: value },
                  version,
                ).toJSON(),
              }],
            },
          }],
        });
      };

      await append(1, "b");
      expect((await syncs.next()).value.operationFields?.[0].field.cursor)
        .toEqual({ epoch: 1, version: 1 });

      transport.holdReconnect();
      transport.disconnect();
      await append(2, "c");
      await append(3, "d");
      await append(4, "e");
      transport.releaseReconnect();
      await transport.reconnected;

      expect((await syncs.next()).value.operationFields?.[0].field)
        .toMatchObject({
          active: true,
          cursor: { epoch: 1, version: 4 },
          retainedFrom: { epoch: 1, version: 2 },
          reset: true,
          materialized: "abcde",
          operations: [],
        });
      expect(transport.watchSetCount).toBe(1);

      let staleError: unknown;
      try {
        await writer.transact({
          localSeq: 6,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained-reset",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "stale:1",
            base: { epoch: 1, version: 1 },
            payload: {
              updates: [{
                clientId: "stale",
                changes: ChangeSet.of({ from: 2, insert: "!" }, 2).toJSON(),
              }],
            },
          }],
        });
      } catch (error) {
        staleError = error;
      }
      expect(staleError).toMatchObject({
        name: "OpHistoryUnavailableError",
      });
    } finally {
      transport.releaseReconnect();
      await writerClient.close();
      await watcherClient.close();
      await server.close();
    }
  });
});
