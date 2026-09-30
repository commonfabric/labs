import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { FabricValue } from "@commonfabric/data-model";
import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type { OperationFieldSnapshot } from "@commonfabric/memory/v2";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { CellHandle } from "@/cell-handle.ts";
import { type CellRef, NotificationType, RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import { acquireCellRef, buildProcessor } from "./backends/build-processor.ts";

const operationRuntime = (
  capability: Record<string, unknown>,
  resolved?: CellRef,
) => ({
  getCellFromLink: (cell: CellRef) => ({
    resolveAsCell: () => ({
      getAsNormalizedFullLink: () => resolved ?? cell,
    }),
  }),
  storageManager: {
    open: () => ({ ...capability, replica: capability }),
  },
});

describe("RuntimeClient operation collaboration", () => {
  it("queries, applies, and subscribes through the worker protocol", async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const requests: unknown[] = [];
    const cellRef: CellRef = {
      space: "did:key:z6Mk-operation-client" as CellRef["space"],
      id: "of:operation-client",
      path: ["content"] as unknown as OperationFieldSnapshot["path"],
      scope: "space",
    };
    const initial: OperationFieldSnapshot = {
      branch: "",
      id: cellRef.id,
      scope: "space",
      scopeKey: "",
      path: cellRef.path as unknown as OperationFieldSnapshot["path"],
      active: false,
      codec: null,
      cursor: null,
      baselineHash: "baseline",
      materialized: "hello",
      operations: [],
    };
    const integrated: OperationFieldSnapshot = {
      ...initial,
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 1 },
      materialized: "hello!",
      operations: [{
        opId: "op:1",
        cursor: { epoch: 1, version: 1 },
        submissionId: "submission-1",
        payload: { updates: [] },
      }],
    };
    const resolution = {
      operationIndex: 0,
      address: {
        branch: "",
        id: cellRef.id,
        scope: "space" as const,
        scopeKey: "",
        path: initial.path,
      },
      codec: "codemirror-changeset@1",
      submissionId: "submission-1",
      from: { epoch: 1, version: 0 },
      to: { epoch: 1, version: 1 },
      operations: integrated.operations,
      duplicate: false,
    };
    const wireField = (field: OperationFieldSnapshot) => ({
      ...field,
      materialized: field.materialized,
      operations: field.operations.map((operation) => ({
        ...operation,
        payload: operation.payload,
      })),
    });
    const wireResolution = {
      ...resolution,
      operations: resolution.operations.map((operation) => ({
        ...operation,
        payload: operation.payload,
      })),
    };
    const conn = {
      signal: new AbortController().signal,
      on: (event: string, handler: (data: unknown) => void) => {
        handlers.set(event, handler);
      },
      request: (request: { type: RequestType }) => {
        requests.push(request);
        switch (request.type) {
          case RequestType.OperationCapabilities:
            return Promise.resolve({ codecs: ["codemirror-changeset@1"] });
          case RequestType.OperationQuery:
            return Promise.resolve({ field: wireField(initial) });
          case RequestType.OperationApply:
            return Promise.resolve({ resolution: wireResolution });
          case RequestType.OperationRelease:
          case RequestType.OperationSubscribe:
          case RequestType.OperationUnsubscribe:
          case RequestType.OperationSessionClose:
            return Promise.resolve({ value: true });
          default:
            throw new Error(`unexpected request: ${request.type}`);
        }
      },
    } as unknown as never;
    const client = new (RuntimeClient as unknown as {
      new (conn: never, options: unknown): RuntimeClient;
    })(conn, {});
    const cell = { ref: () => cellRef } as CellHandle<unknown>;
    const operationSessionId = "operation-session:1";

    expect(await client.operationCodecs(cell, operationSessionId)).toEqual([
      "codemirror-changeset@1",
    ]);
    expect(
      await client.queryOperationField(
        cell,
        undefined,
        operationSessionId,
      ),
    ).toEqual(initial);
    expect(
      await client.applyOperation(cell, {
        codec: "codemirror-changeset@1",
        submissionId: "submission-1",
        base: null,
        baselineHash: "baseline",
        payload: { updates: [] },
      }, operationSessionId),
    ).toEqual(resolution);
    await client.releaseOperationField(
      cell,
      "codemirror-changeset@1",
      { epoch: 1, version: 1 },
      operationSessionId,
    );
    await client.closeOperationSession(operationSessionId);

    const delivered: OperationFieldSnapshot[] = [];
    const unsubscribe = await client.subscribeOperationField(
      cell,
      (field) => delivered.push(field),
      undefined,
      operationSessionId,
    );
    const subscribe = requests.at(-1) as {
      type: RequestType;
      subscriptionId: string;
    };
    handlers.get("operationupdate")!({
      type: NotificationType.OperationUpdate,
      subscriptionId: subscribe.subscriptionId,
      field: wireField(integrated),
    });
    expect(delivered).toEqual([integrated]);

    unsubscribe();
    await Promise.resolve();

    expect(requests.map((request) => (request as { type: RequestType }).type))
      .toEqual([
        RequestType.OperationCapabilities,
        RequestType.OperationQuery,
        RequestType.OperationApply,
        RequestType.OperationRelease,
        RequestType.OperationSessionClose,
        RequestType.OperationSubscribe,
        RequestType.OperationUnsubscribe,
      ]);
    const apply = requests.find((request) =>
      (request as { type: RequestType }).type === RequestType.OperationApply
    ) as { payload: FabricValue };
    expect(apply.payload).toEqual({ updates: [] });
    expect(
      requests.filter((request) =>
        (request as { operationSessionId?: string }).operationSessionId !==
          undefined
      ).every((request) =>
        (request as { operationSessionId?: string }).operationSessionId ===
          operationSessionId
      ),
    ).toBe(true);
  });

  it("compensates when the worker loses a subscribe response", async () => {
    const requests: Array<{ type: RequestType; subscriptionId?: string }> = [];
    const conn = {
      signal: new AbortController().signal,
      on: () => {},
      request: (request: { type: RequestType; subscriptionId?: string }) => {
        requests.push(request);
        if (request.type === RequestType.OperationSubscribe) {
          return Promise.reject(new Error("subscribe response lost"));
        }
        if (request.type === RequestType.OperationUnsubscribe) {
          return Promise.resolve({ value: true });
        }
        throw new Error(`unexpected request: ${request.type}`);
      },
    } as unknown as never;
    const client = new (RuntimeClient as unknown as {
      new (conn: never, options: unknown): RuntimeClient;
    })(conn, {});
    const cell = {
      ref: () => ({
        space: "did:key:z6Mk-operation-client",
        id: "of:operation-client",
        path: ["content"],
      }),
    } as unknown as CellHandle<unknown>;

    await expect(
      client.subscribeOperationField(cell, () => {}),
    ).rejects.toThrow("subscribe response lost");
    expect(requests.map(({ type }) => type)).toEqual([
      RequestType.OperationSubscribe,
      RequestType.OperationUnsubscribe,
    ]);
    expect(requests[1].subscriptionId).toBe(requests[0].subscriptionId);
  });

  it("fails closed on refused subscriptions and releases", async () => {
    const requests: Array<{ type: RequestType }> = [];
    let subscribeAccepted = false;
    let releaseAccepted = false;
    const conn = {
      signal: new AbortController().signal,
      on: () => {},
      dispose: () => Promise.resolve(),
      request: (request: { type: RequestType }) => {
        requests.push(request);
        if (request.type === RequestType.OperationSubscribe) {
          return Promise.resolve({ value: subscribeAccepted });
        }
        if (request.type === RequestType.OperationUnsubscribe) {
          return Promise.reject(new Error("connection closed"));
        }
        if (request.type === RequestType.OperationRelease) {
          return Promise.resolve({ value: releaseAccepted });
        }
        throw new Error(`unexpected request: ${request.type}`);
      },
    } as unknown as never;
    const client = new (RuntimeClient as unknown as {
      new (conn: never, options: unknown): RuntimeClient;
    })(conn, {});
    const cell = {
      ref: () => ({ id: "of:x", path: [] }),
    } as unknown as CellHandle<unknown>;

    await expect(client.subscribeOperationField(cell, () => {})).rejects
      .toThrow("not installed");
    await expect(client.releaseOperationField(
      cell,
      "test@1",
      { epoch: 1, version: 0 },
    )).rejects.toThrow("not released");

    subscribeAccepted = true;
    releaseAccepted = true;
    const unsubscribe = await client.subscribeOperationField(cell, () => {});
    unsubscribe();
    unsubscribe();
    await Promise.resolve();
    await client.releaseOperationField(cell, "test@1", {
      epoch: 1,
      version: 0,
    });
    await client.dispose();
    expect(
      requests.filter(({ type }) => type === RequestType.OperationUnsubscribe),
    ).toHaveLength(2);
  });

  it("encodes Fabric values across the worker operation boundary", async () => {
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    const address = {
      branch: "",
      id: "of:bytes",
      scopeKey: "space",
      path: [] as unknown as OperationFieldSnapshot["path"],
    };
    const field: OperationFieldSnapshot = {
      ...address,
      active: true,
      codec: "synthetic@1",
      cursor: { epoch: 1, version: 1 },
      baselineHash: "baseline",
      materialized: bytes,
      operations: [{
        opId: "op:bytes",
        cursor: { epoch: 1, version: 1 },
        submissionId: "bytes:1",
        payload: bytes,
      }],
    };
    let receivedPayload: unknown;
    const resolution = {
      operationIndex: 0,
      address,
      codec: "synthetic@1",
      submissionId: "bytes:1",
      from: { epoch: 1, version: 0 },
      to: { epoch: 1, version: 1 },
      operations: field.operations,
      duplicate: false,
    };
    const replica = {
      queryOperationField: () => Promise.resolve(field),
      applyOperation: (operation: { payload: unknown }) => {
        receivedPayload = operation.payload;
        return Promise.resolve(resolution);
      },
      operationCodecs: () => Promise.resolve(["synthetic@1"]),
      releaseOperationField: () => Promise.resolve(),
      subscribeOperationField: () => Promise.resolve(() => {}),
    };
    const processor = buildProcessor({
      runtime: operationRuntime(replica),
    });
    const cell = {
      space: "did:key:z6Mk-operation-client",
      id: "of:bytes",
      path: [],
    };

    const queried = await processor.handleOperationQuery(
      { type: RequestType.OperationQuery, cell } as never,
    );
    expect(
      (queried.field.materialized as FabricBytes).slice(),
    ).toEqual(new Uint8Array([1, 2, 3]));
    const applied = await processor.handleOperationApply(
      {
        type: RequestType.OperationApply,
        cell,
        codec: "synthetic@1",
        submissionId: "bytes:1",
        base: { epoch: 1, version: 0 },
        payload: bytes,
      } as never,
    );
    expect((receivedPayload as FabricBytes).slice()).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(
      (applied.resolution.operations[0].payload as FabricBytes).slice(),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("dispatches the worker operation capability lifecycle", async () => {
    let subscribed: ((field: OperationFieldSnapshot) => void) | undefined;
    let cancellations = 0;
    const field: OperationFieldSnapshot = {
      branch: "",
      id: "of:lifecycle",
      scopeKey: "space",
      path: [] as unknown as OperationFieldSnapshot["path"],
      active: false,
      codec: null,
      cursor: null,
      baselineHash: "baseline",
      materialized: "value",
      operations: [],
    };
    const replica = {
      operationCodecs: () => Promise.resolve(["test@1"]),
      queryOperationField: () => Promise.resolve(field),
      applyOperation: () => Promise.resolve({ operations: [] }),
      releaseOperationField: () => Promise.resolve(),
      subscribeOperationField: (
        _query: unknown,
        callback: typeof subscribed,
      ) => {
        subscribed = callback;
        return Promise.resolve(() => cancellations++);
      },
    };
    const processor = buildProcessor({
      runtime: operationRuntime(replica),
    });
    const cell = {
      space: "did:key:z6Mk-runtime",
      id: "of:lifecycle",
      path: [],
    };

    expect(await processor.handleOperationCapabilities({ cell } as never))
      .toEqual({ codecs: ["test@1"] });
    await processor.handleOperationRelease({
      cell,
      codec: "test@1",
      cursor: { epoch: 1, version: 0 },
    } as never);
    expect(
      await processor.handleOperationSubscribe({
        cell,
        subscriptionId: "subscription:1",
      } as never),
    ).toEqual({ value: true });
    const notifications: unknown[] = [];
    const postMessage = (globalThis as { postMessage?: unknown }).postMessage;
    (globalThis as { postMessage?: (message: unknown) => void }).postMessage = (
      message,
    ) => notifications.push(message);
    try {
      subscribed!(field);
      await Promise.resolve();
      // Decoded rather than read raw: what the worker posts is an envelope
      // encoding, and the client refuses anything that is not one. Comparing
      // the decode is what says this notification can actually be received,
      // where comparing the posted value would pass for a message that never
      // crossed.
      expect(
        notifications.map((posted) => fabricFromRealmValue(posted as never)),
      )
        .toEqual([{
          type: NotificationType.OperationUpdate,
          subscriptionId: "subscription:1",
          field: {
            ...field,
            materialized: field.materialized,
          },
        }]);

      // The notification goes through `postToClient()`, which is what puts it
      // under the guard there. It posts from a `queueMicrotask` callback, so
      // there is no caller's `try` around it: a refused post that threw would
      // be an uncaught error rather than anything a caller could handle. Made
      // to throw once, the post is answered with a substitute and nothing
      // escapes -- where a bare `self.postMessage` here would escape. The
      // substitute is encoded like anything else this connection sends, so it
      // is read the same way.
      notifications.length = 0;
      let thrown = false;
      (globalThis as { postMessage: (m: unknown) => void }).postMessage = (
        m,
      ) => {
        if (!thrown) {
          thrown = true;
          throw new Error("post refused");
        }
        notifications.push(m);
      };
      subscribed!(field);
      await Promise.resolve();
      expect(notifications).toHaveLength(1);
      const substitute = fabricFromRealmValue(notifications[0] as never) as {
        type?: unknown;
        message?: string;
      };
      expect(substitute.type).toBe(NotificationType.ErrorReport);
      expect(substitute.message).toContain("Undeliverable message");
    } finally {
      (globalThis as { postMessage?: unknown }).postMessage = postMessage;
    }
    expect(
      await processor.handleOperationSubscribe({
        cell,
        subscriptionId: "subscription:1",
      } as never),
    ).toEqual({ value: false });
    expect(processor.handleOperationUnsubscribe({
      subscriptionId: "missing",
    } as never)).toEqual({ value: false });
    expect(processor.handleOperationUnsubscribe({
      subscriptionId: "subscription:1",
    } as never)).toEqual({ value: true });
    expect(cancellations).toBe(1);
    subscribed!(field);
    await Promise.resolve();
    expect(notifications).toHaveLength(1);

    await processor.handleRequest({
      type: RequestType.OperationCapabilities,
      cell,
    } as never);
    await processor.handleRequest({
      type: RequestType.OperationQuery,
      cell,
    } as never);
    await processor.handleRequest({
      type: RequestType.OperationApply,
      cell,
      codec: "test@1",
      submissionId: "switch:1",
      base: null,
      baselineHash: "baseline",
      payload: "value",
    } as never);
    await processor.handleRequest({
      type: RequestType.OperationRelease,
      cell,
      codec: "test@1",
      cursor: { epoch: 1, version: 0 },
    } as never);
    await processor.handleRequest({
      type: RequestType.OperationSubscribe,
      cell,
      subscriptionId: "subscription:switch",
    } as never);
    await processor.handleRequest({
      type: RequestType.OperationUnsubscribe,
      subscriptionId: "subscription:switch",
    } as never);
    expect(
      await processor.handleRequest({
        type: RequestType.OperationSessionClose,
        operationSessionId: "session:missing",
      } as never),
    ).toEqual({ value: false });
    expect(cancellations).toBe(2);

    processor.accessForTestingOnly.isDisposed = true;
    expect(
      await processor.handleOperationSubscribe({
        cell,
        subscriptionId: "subscription:disposed",
      } as never),
    ).toEqual({ value: false });
    expect(cancellations).toBe(3);

    const unsupported = buildProcessor({ runtime: operationRuntime({}) });
    await expect(unsupported.handleOperationCapabilities({ cell } as never))
      .rejects.toThrow("does not support");
    await expect(processor.handleOperationCapabilities({
      cell,
      operationSessionId: "",
    } as never)).rejects.toThrow("operation session id is malformed");
    expect(subscribed).toBeDefined();
  });

  it("removes a failed worker watch and its operation session", async () => {
    const capability = {
      operationCodecs: () => Promise.resolve(["test@1"]),
      queryOperationField: () => Promise.resolve({}),
      applyOperation: () => Promise.resolve({}),
      releaseOperationField: () => Promise.resolve(),
      subscribeOperationField: () =>
        Promise.reject(new Error("watch installation failed")),
    };
    const processor = buildProcessor({
      runtime: operationRuntime(capability),
    });
    const request = {
      cell: {
        space: "did:key:z6Mk-runtime",
        id: "of:failed-watch",
        path: [],
      },
      operationSessionId: "session:failed-watch",
      subscriptionId: "subscription:failed-watch",
    };

    await expect(processor.handleOperationSubscribe(request as never)).rejects
      .toThrow("watch installation failed");
    expect(processor.accessForTestingOnly.operationSubscriptions.size).toBe(0);
    expect(processor.accessForTestingOnly.operationSessions.size).toBe(0);
  });

  it("cancels operation subscriptions during worker disposal", async () => {
    let cancellations = 0;
    const telemetry = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const runtime = {
      storageManager: { synced: () => Promise.resolve() },
      dispose: () => Promise.resolve(),
    };
    const processor = buildProcessor({
      runtime,
      space: "did:key:z6Mk-dispose",
      telemetry: telemetry as never,
    });
    processor.accessForTestingOnly.operationSubscriptions.set(
      "subscription:dispose",
      { cancelled: false, cancel: () => cancellations++ } as never,
    );

    await processor.dispose();

    expect(cancellations).toBe(1);
  });

  it("cancels a worker watch whose unsubscribe arrives during installation", async () => {
    const installed = Promise.withResolvers<() => void>();
    let cancellations = 0;
    const capability = {
      operationCodecs: () => Promise.resolve(["test@1"]),
      queryOperationField: () => Promise.resolve({}),
      applyOperation: () => Promise.resolve({}),
      releaseOperationField: () => Promise.resolve(),
      subscribeOperationField: () => installed.promise,
    };
    const processor = buildProcessor({
      runtime: operationRuntime(capability),
    });
    const request = {
      cell: {
        space: "did:key:z6Mk-runtime",
        id: "of:pending-watch",
        path: [],
      },
      subscriptionId: "subscription:pending",
    };

    const subscribing = processor.handleOperationSubscribe(request as never);
    expect(processor.handleOperationUnsubscribe(request as never)).toEqual({
      value: true,
    });
    installed.resolve(() => cancellations++);

    await expect(subscribing).resolves.toEqual({ value: false });
    expect(cancellations).toBe(1);
    expect(processor.accessForTestingOnly.operationSubscriptions.size).toBe(0);
  });

  it("pins one resolved target for an operation session", async () => {
    const alias = {
      space: "did:key:z6Mk-runtime" as CellRef["space"],
      id: "of:alias",
      path: ["content"],
      scope: "space" as const,
    };
    const targetA = { ...alias, id: "of:target-a" };
    const targetB = { ...alias, id: "of:target-b" };
    let resolved = targetA;
    const addressed: string[] = [];
    const field: OperationFieldSnapshot = {
      branch: "",
      id: targetA.id,
      scope: "space",
      scopeKey: "space",
      path: targetA.path as unknown as OperationFieldSnapshot["path"],
      active: true,
      codec: "test@1",
      cursor: { epoch: 1, version: 0 },
      baselineHash: "baseline",
      materialized: "value",
      operations: [],
    };
    const capability = {
      operationCodecs: () => Promise.resolve(["test@1"]),
      queryOperationField: (query: { id: string }) => {
        addressed.push(`query:${query.id}`);
        return Promise.resolve(field);
      },
      applyOperation: (operation: { id: string; submissionId: string }) => {
        addressed.push(`apply:${operation.id}`);
        return Promise.resolve({
          operationIndex: 0,
          address: {
            branch: "",
            id: operation.id,
            scope: "space",
            scopeKey: "space",
            path: field.path,
          },
          codec: "test@1",
          submissionId: operation.submissionId,
          from: { epoch: 1, version: 0 },
          to: { epoch: 1, version: 0 },
          operations: [],
          duplicate: false,
        });
      },
      subscribeOperationField: (
        query: { id: string },
        _callback: unknown,
      ) => {
        addressed.push(`subscribe:${query.id}`);
        return Promise.resolve(() => {});
      },
      releaseOperationField: (operation: { id: string }) => {
        addressed.push(`release:${operation.id}`);
        return Promise.resolve();
      },
    };
    const runtime = {
      getCellFromLink: () => ({
        resolveAsCell: () => ({
          getAsNormalizedFullLink: () => resolved,
        }),
      }),
      storageManager: {
        open: () => ({ ...capability, replica: capability }),
      },
    };
    const processor = buildProcessor({
      runtime,
    });

    await processor.handleOperationQuery({
      cell: alias,
      operationSessionId: "session:one",
    } as never);
    await expect(processor.handleOperationQuery({
      cell: { ...alias, id: "of:other-alias" },
      operationSessionId: "session:one",
    } as never)).rejects.toThrow("cannot change its source cell");
    resolved = targetB;
    await processor.handleOperationQuery({
      cell: alias,
      operationSessionId: "session:two",
    } as never);
    await processor.handleOperationSubscribe({
      cell: alias,
      operationSessionId: "session:two",
      subscriptionId: "subscription:two",
    } as never);
    await processor.handleOperationApply({
      cell: alias,
      operationSessionId: "session:one",
      codec: "test@1",
      submissionId: "submission:1",
      base: { epoch: 1, version: 0 },
      payload: "change",
    } as never);
    await processor.handleOperationSubscribe({
      cell: alias,
      operationSessionId: "session:one",
      subscriptionId: "subscription:pin",
    } as never);
    await processor.handleOperationRelease({
      cell: alias,
      operationSessionId: "session:one",
      codec: "test@1",
      cursor: { epoch: 1, version: 0 },
    } as never);

    expect(addressed).toEqual([
      "query:of:target-a",
      "query:of:target-b",
      "subscribe:of:target-b",
      "apply:of:target-a",
      "subscribe:of:target-a",
      "release:of:target-a",
    ]);
    expect(processor.handleOperationUnsubscribe({
      subscriptionId: "subscription:pin",
    } as never)).toEqual({ value: true });
    expect(processor.handleOperationUnsubscribe({
      subscriptionId: "subscription:two",
    } as never)).toEqual({ value: true });

    resolved = targetA;
    await processor.handleOperationQuery({
      cell: alias,
      operationSessionId: "session:abandoned",
    } as never);
    expect(processor.handleOperationSessionClose({
      operationSessionId: "session:abandoned",
    } as never)).toEqual({ value: true });
    resolved = targetB;
    await processor.handleOperationQuery({
      cell: alias,
      operationSessionId: "session:abandoned",
    } as never);
    expect(addressed.slice(-2)).toEqual([
      "query:of:target-a",
      "query:of:target-b",
    ]);
  });

  it("addresses operation fields through a real linked cell target", async () => {
    const identity = await Identity.fromPassphrase("operation linked target");
    const storage = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL("https://toolshed.test"),
      storageManager: storage,
    });
    const space = identity.did();
    try {
      const tx = runtime.edit();
      const target = runtime.getCell<string>(
        space,
        "of:operation-target",
        undefined,
        tx,
      );
      target.set("value");
      const alias = runtime.getCell<string>(
        space,
        "of:operation-alias",
        undefined,
        tx,
      );
      alias.set(target);
      expect((await tx.commit()).error).toBeUndefined();
      const targetId = target.resolveAsCell().getAsNormalizedFullLink().id;

      const processor = buildProcessor({ runtime });
      const field = await processor.handleOperationQuery({
        cell: acquireCellRef(
          processor,
          alias.getAsNormalizedFullLink() as CellRef,
        ),
      } as never);

      expect(field.field.id).toBe(targetId);
      expect(field.field.materialized).toBe("value");
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
});
