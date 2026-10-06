import {
  isUnavailable,
  UNAVAILABLE_PENDING,
  unavailableError,
} from "@commonfabric/data-model/availability";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "@commonfabric/api";
import { hashOf } from "@commonfabric/data-model";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer, type Deferred } from "@commonfabric/utils/defer";

import { createBuilder } from "../src/builder/factory.ts";
import {
  streamData as rawStreamData,
  streamDataResult as rawStreamDataResult,
} from "../src/builtins/stream-data.ts";
import { createCell } from "../src/cell.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { Runtime } from "../src/runtime.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { refuseAtCommitBoundary } from "./refused-commit.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test stream-data outbox");
const space = signer.did();

describe("stream-data outbox mechanism", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let streamData: ReturnType<
    typeof createBuilder
  >["commonfabric"]["streamData"];
  let partialResultOf: ReturnType<
    typeof createBuilder
  >["commonfabric"]["partialResultOf"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let fetchChanged: Deferred<void>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // The retry cases below need a commit the gate REFUSES: their subject is
    // what the outbox does after one. Only an enforcing rung produces that
    // refusal, so the suite names one rather than inheriting whichever rung
    // the fleet is set to.
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, byRef, streamData, partialResultOf } = commonfabric);

    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    fetchCalls = [];
    fetchChanged = defer<void>();
    originalFetch = globalThis.fetch;
    globalThis.fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      recordFetch(url, init);

      return Promise.resolve(
        new Response(
          'id:1\nevent:message\ndata:{"value":true}\n\n',
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        ),
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function makeAvailabilityAction(
    inputs: {
      url?: any;
      schema?: JSONSchema;
      options?: {
        body?: any;
        method?: string;
        headers?: Record<string, string>;
      };
    },
    name: string,
  ) {
    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      `${name}-parent`,
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<typeof inputs>(
      space,
      `${name}-inputs`,
      undefined,
      setupTx,
    );
    inputsCell.set(inputs);
    await setupTx.commit().settled;

    let state:
      | { pending: any; result: any; partial: any; error: any }
      | undefined;
    let cancel: (() => void) | undefined;
    const action = rawStreamDataResult(
      inputsCell,
      (_tx, value) => state = value,
      (value) => cancel = value,
      [],
      parentCell,
      runtime,
    );
    return {
      action,
      inputsCell,
      get state() {
        if (!state) {
          throw new Error("streamDataResult state was not initialized");
        }
        return state;
      },
      cancel() {
        if (!cancel) {
          throw new Error("streamDataResult cancel was not registered");
        }
        cancel();
      },
    };
  }

  async function invokeAvailabilityAction(
    action: ReturnType<typeof rawStreamDataResult>,
  ): Promise<void> {
    const tx = runtime.edit();
    action(tx);
    await tx.commit().settled;
  }

  function recordFetch(url: string, init?: RequestInit): void {
    fetchCalls.push({ url, init });
    fetchChanged.resolve();
    fetchChanged = defer<void>();
  }

  async function waitForFetchCount(count: number): Promise<void> {
    while (fetchCalls.length < count) {
      const next = fetchChanged.promise;
      if (fetchCalls.length >= count) return;
      await next;
    }
  }

  async function waitForRawResult(
    cell: any,
    predicate: (value: unknown) => boolean,
  ): Promise<void> {
    await waitForCellValue<unknown>(runtime, cell, predicate);
  }

  it("publishes live partial events and the last event on clean close", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      recordFetch(url, init);
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(value) {
              controller = value;
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        ),
      );
    };

    const eventSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        event: { type: "string" },
        data: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      },
      required: ["id", "event", "data"],
    } as const satisfies JSONSchema;
    type Event = { id: string; event: string; data: { value: number } };
    const outputSchema = {
      type: "object",
      properties: { final: {}, partial: {} },
      required: ["final", "partial"],
    } as const satisfies JSONSchema;
    const testPattern = pattern(
      () => {
        const request = streamData<Event>({
          url: "http://mock-test-server.local/live",
          schema: eventSchema,
        });
        return { final: request, partial: partialResultOf(request) };
      },
      false,
      outputSchema,
    );
    const tx = runtime.edit();
    const result = runtime.run(
      tx,
      testPattern,
      {},
      runtime.getCell(space, "stream-direct-lifecycle", outputSchema, tx),
    );
    await tx.commit().settled;
    await result.pull();
    await waitForFetchCount(1);

    expect(rawResult(result.key("final"))).toBe(UNAVAILABLE_PENDING);
    expect(rawResult(result.key("partial"))).toBe(UNAVAILABLE_PENDING);

    const encoder = new TextEncoder();
    controller.enqueue(
      encoder.encode('id:1\nevent:message\ndata:{"value":1}\n\n'),
    );
    await waitForRawResult(
      result.key("partial"),
      (value) => (value as Event | undefined)?.data?.value === 1,
    );
    expect(rawResult(result.key("final"))).toBe(UNAVAILABLE_PENDING);

    controller.enqueue(
      encoder.encode('id:2\nevent:message\ndata:{"value":2}'),
    );
    controller.close();

    await waitForRawResult(
      result.key("final"),
      (value) => (value as Event | undefined)?.data?.value === 2,
    );
    expect(rawResult(result.key("partial"))).toEqual({
      id: "2",
      event: "message",
      data: { value: 2 },
    });
  });

  it("publishes terminal request errors without reconnecting", async () => {
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      recordFetch(url, init);
      return Promise.resolve(
        new Response("unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        }),
      );
    };

    const fixture = await makeAvailabilityAction({
      url: "http://mock-test-server.local/fails",
      schema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
    }, "stream-direct-request-error");
    await invokeAvailabilityAction(fixture.action);

    await waitForRawResult(
      fixture.state.result,
      (value) => unavailableReason(value) === "error",
    );
    expect(unavailableReason(rawResult(fixture.state.partial))).toBe("error");
    const unavailable = rawResult(fixture.state.result);
    if (isUnavailable(unavailable) && unavailable.reason === "error") {
      expect(unavailable.errorMessage).toContain("503 Service Unavailable");
    }

    await runtime.settled();
    expect(fetchCalls).toHaveLength(1);
  });

  it("publishes schema mismatch on both final and partial results", async () => {
    const eventSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        event: { type: "string" },
        data: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      },
      required: ["id", "event", "data"],
    } as const satisfies JSONSchema;
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      recordFetch(url, init);
      return Promise.resolve(
        new Response(
          'id:1\nevent:message\ndata:{"value":"wrong"}\n\n',
          { status: 200 },
        ),
      );
    };
    const fixture = await makeAvailabilityAction({
      url: "http://mock-test-server.local/schemaMismatch",
      schema: eventSchema,
    }, "stream-direct-schemaMismatch");
    await invokeAvailabilityAction(fixture.action);

    await waitForRawResult(
      fixture.state.result,
      (value) => isUnavailable(value) && value.errorKind === "schemaMismatch",
    );
    expect(rawResult(fixture.state.result)).toMatchObject({
      reason: "error",
      errorKind: "schemaMismatch",
    });
    expect(rawResult(fixture.state.partial)).toMatchObject({
      reason: "error",
      errorKind: "schemaMismatch",
    });
  });

  it("propagates unavailable request inputs to final and partial results", async () => {
    const pendingFixture = await makeAvailabilityAction({
      url: UNAVAILABLE_PENDING,
    }, "stream-direct-pending-input");
    await invokeAvailabilityAction(pendingFixture.action);

    expect(unavailableReason(rawResult(pendingFixture.state.result))).toBe(
      "pending",
    );
    expect(unavailableReason(rawResult(pendingFixture.state.partial))).toBe(
      "pending",
    );
    expect(rawResult(pendingFixture.state.pending)).toBe(true);
    expect(rawResult(pendingFixture.state.error)).toBeUndefined();

    const upstreamError = new Error("upstream URL failed");
    const errorFixture = await makeAvailabilityAction({
      url: unavailableError(upstreamError),
    }, "stream-direct-error-input");
    await invokeAvailabilityAction(errorFixture.action);

    expect(unavailableReason(rawResult(errorFixture.state.result))).toBe(
      "error",
    );
    expect(unavailableReason(rawResult(errorFixture.state.partial))).toBe(
      "error",
    );
    const errorResult = rawResult(errorFixture.state.result);
    expect(
      isUnavailable(errorResult) && errorResult.reason === "error"
        ? errorResult.errorMessage
        : undefined,
    ).toBe("upstream URL failed");
    expect(rawResult(errorFixture.state.pending)).toBe(false);
    expect(rawResult(errorFixture.state.error)).toBe("upstream URL failed");
    expect(fetchCalls).toHaveLength(0);
  });

  it("uses runner precedence across unavailable stream inputs", async () => {
    const fixture = await makeAvailabilityAction({
      url: UNAVAILABLE_PENDING,
      options: {
        body: unavailableError(new Error("body failed")),
      },
    }, "stream-direct-input-precedence");
    await invokeAvailabilityAction(fixture.action);

    const final = rawResult(fixture.state.result);
    expect(unavailableReason(final)).toBe("error");
    expect(unavailableReason(rawResult(fixture.state.partial))).toBe("error");
    expect(
      isUnavailable(final) && final.reason === "error"
        ? final.errorMessage
        : undefined,
    ).toBe("body failed");
    expect(fetchCalls).toHaveLength(0);
  });

  it("aborts an active stream when an input becomes unavailable", async () => {
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      recordFetch(url, init);
      return Promise.resolve(
        new Response(new ReadableStream({ start() {} }), { status: 200 }),
      );
    };

    const fixture = await makeAvailabilityAction({
      url: "http://mock-test-server.local/becomes-unavailable",
      schema: {},
    }, "stream-direct-becomes-unavailable");
    await invokeAvailabilityAction(fixture.action);
    await waitForFetchCount(1);

    const signal = fetchCalls[0].init?.signal;
    expect(signal?.aborted).toBe(false);

    const unavailableTx = runtime.edit();
    fixture.inputsCell.withTx(unavailableTx).set({
      url: UNAVAILABLE_PENDING,
    });
    fixture.action(unavailableTx);
    await unavailableTx.commit().settled;

    expect(signal?.aborted).toBe(true);
    expect(unavailableReason(rawResult(fixture.state.result))).toBe("pending");
    expect(unavailableReason(rawResult(fixture.state.partial))).toBe("pending");
    expect(fetchCalls).toHaveLength(1);
  });

  it("publishes an error when a stream closes without an event", async () => {
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      recordFetch(url, init);
      return Promise.resolve(new Response("", { status: 200 }));
    };
    const fixture = await makeAvailabilityAction({
      url: "http://mock-test-server.local/empty",
      schema: {},
    }, "stream-direct-empty");
    await invokeAvailabilityAction(fixture.action);

    await waitForRawResult(
      fixture.state.result,
      (value) => unavailableReason(value) === "error",
    );
    expect(unavailableReason(rawResult(fixture.state.partial))).toBe("error");
  });

  it("ignores a replaced stream and publishes only the current request", async () => {
    const controllers = new Map<
      string,
      ReadableStreamDefaultController<Uint8Array>
    >();
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      recordFetch(url, init);
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controllers.set(url, controller);
            },
          }),
          { status: 200 },
        ),
      );
    };

    const eventSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        event: { type: "string" },
        data: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      },
      required: ["id", "event", "data"],
    } as const satisfies JSONSchema;
    const fixture = await makeAvailabilityAction({
      url: "http://mock-test-server.local/old",
      schema: eventSchema,
    }, "stream-direct-replacement");
    await invokeAvailabilityAction(fixture.action);
    await waitForFetchCount(1);

    const replaceTx = runtime.edit();
    fixture.inputsCell.withTx(replaceTx).set({
      url: "http://mock-test-server.local/new",
      schema: eventSchema,
    });
    fixture.action(replaceTx);
    await replaceTx.commit().settled;
    await waitForFetchCount(2);
    expect(rawResult(fixture.state.result)).toBe(UNAVAILABLE_PENDING);
    expect(rawResult(fixture.state.partial)).toBe(UNAVAILABLE_PENDING);

    const encoder = new TextEncoder();
    controllers.get("http://mock-test-server.local/old")!.enqueue(
      encoder.encode('id:old\nevent:message\ndata:{"value":1}\n\n'),
    );
    controllers.get("http://mock-test-server.local/old")!.close();
    await runtime.idle();
    expect(rawResult(fixture.state.result)).toBe(UNAVAILABLE_PENDING);
    expect(rawResult(fixture.state.partial)).toBe(UNAVAILABLE_PENDING);

    controllers.get("http://mock-test-server.local/new")!.enqueue(
      encoder.encode('id:new\nevent:message\ndata:{"value":2}\n\n'),
    );
    controllers.get("http://mock-test-server.local/new")!.close();
    await waitForRawResult(
      fixture.state.result,
      (value) =>
        (value as { data?: { value?: number } } | undefined)?.data?.value === 2,
    );
  });

  it("restarts when only the event schema changes", async () => {
    const fixture = await makeAvailabilityAction({
      url: "http://mock-test-server.local/schema-change",
      schema: {
        type: "object",
        properties: { data: { type: "object" } },
        required: ["data"],
      },
    }, "stream-direct-schema-change");
    await invokeAvailabilityAction(fixture.action);
    await waitForFetchCount(1);

    const replaceTx = runtime.edit();
    fixture.inputsCell.withTx(replaceTx).set({
      url: "http://mock-test-server.local/schema-change",
      schema: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: { value: { type: "boolean" } },
            required: ["value"],
          },
        },
        required: ["data"],
      },
    });
    fixture.action(replaceTx);
    await replaceTx.commit().settled;

    await waitForFetchCount(2);
  });

  it("aborts the active request when its graph stops", async () => {
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      recordFetch(url, init);
      return Promise.resolve(
        new Response(new ReadableStream({ start() {} }), { status: 200 }),
      );
    };
    const fixture = await makeAvailabilityAction({
      url: "http://mock-test-server.local/cancel",
      schema: {},
    }, "stream-direct-cancel");
    await invokeAvailabilityAction(fixture.action);
    await waitForFetchCount(1);

    const signal = fetchCalls[0].init?.signal;
    expect(signal?.aborted).toBe(false);
    fixture.cancel();
    expect(signal?.aborted).toBe(true);
  });

  it("starts streamData only after the transaction commits", async () => {
    const streamData = byRef("streamData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => streamData({ url }),
    );

    const tx = runtime.edit();
    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxEnqueue = txPrototype.enqueuePostCommitEffect;
    const originalWrapperEnqueue = wrapperPrototype.enqueuePostCommitEffect;
    const outboxEffects: Array<{ id: string; kind: string }> = [];

    txPrototype.enqueuePostCommitEffect = function (...args) {
      outboxEffects.push(args[0] as { id: string; kind: string });
      return originalTxEnqueue.apply(this, args as never);
    };
    wrapperPrototype.enqueuePostCommitEffect = function (...args) {
      outboxEffects.push(args[0] as { id: string; kind: string });
      return originalWrapperEnqueue.apply(this, args as never);
    };

    const resultCell = runtime.getCell(
      space,
      "stream-pre-commit-test",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/stream",
    }, resultCell);
    // The stream is a computation: a reader has to demand it, and the
    // runtime's disposal ends the subscription.
    result.sink(() => {});

    try {
      expect(fetchCalls).toEqual([]);

      const commitPromise = tx.commit().settled;

      expect(fetchCalls).toEqual([]);

      await commitPromise;
      await runtime.settled();

      expect(outboxEffects.length).toBeGreaterThan(0);
      expect(outboxEffects[0].kind).toBe("streamData-start");
      expect(fetchCalls.length).toBeGreaterThan(0);
      expect(fetchCalls[0].url).toContain("/stream");
      await result.pull();
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
    }
  });

  it("uses a stable streamData idempotency key for identical inputs", async () => {
    const streamData = byRef("streamData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => streamData({ url }),
    );

    const tx = runtime.edit();
    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxEnqueue = txPrototype.enqueuePostCommitEffect;
    const originalWrapperEnqueue = wrapperPrototype.enqueuePostCommitEffect;
    const outboxIds: string[] = [];

    txPrototype.enqueuePostCommitEffect = function (...args) {
      outboxIds.push((args[0] as { id: string }).id);
      return originalTxEnqueue.apply(this, args as never);
    };
    wrapperPrototype.enqueuePostCommitEffect = function (...args) {
      outboxIds.push((args[0] as { id: string }).id);
      return originalWrapperEnqueue.apply(this, args as never);
    };

    try {
      const resultCell = runtime.getCell(
        space,
        "stream-idempotency-test",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, {
        url: "http://mock-test-server.local/stream-idempotency",
      }, resultCell);
      result.sink(() => {});
      const commitPromise = tx.commit().settled;
      await commitPromise;
      await runtime.settled();

      const expectedHash = hashOf(
        createFrozenRequestSnapshot({
          url: "http://mock-test-server.local/stream-idempotency",
        }),
      ).toString();

      expect(outboxIds.length).toBeGreaterThan(0);
      expect(outboxIds[0]).toBe(`streamData:${expectedHash}`);
      await result.pull();
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
    }
  });

  it("retries streamData start after a rejected post-commit transaction", async () => {
    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      "stream-retry-parent",
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<{
      url: string;
      options?: {
        body?: any;
        method?: string;
        headers?: Record<string, string>;
      };
      result?: any;
    }>(
      space,
      "stream-retry-inputs",
      undefined,
      setupTx,
    );
    inputsCell.set({
      url: "http://mock-test-server.local/stream-retry",
    });
    const setupResult = await setupTx.commit().settled;
    expect(setupResult.ok).toBeDefined();

    const action = rawStreamData(
      inputsCell,
      () => {},
      () => {},
      [],
      parentCell,
      runtime,
    );

    const rejectedTx = runtime.edit();
    refuseAtCommitBoundary(
      rejectedTx,
      space,
      "streamData retry regression",
    );
    action(rejectedTx);
    const rejectedResult = await rejectedTx.commit().settled;
    expect(isCfcEnforcementRejection(rejectedResult.error)).toBe(true);
    await runtime.settled();
    expect(fetchCalls).toEqual([]);

    const retryTx = runtime.edit();
    action(retryTx);
    const retryResult = await retryTx.commit().settled;
    expect(retryResult.ok).toBeDefined();
    await runtime.settled();

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/stream-retry");
  });

  it("restarts streamData when identical inputs move to a narrower scope", async () => {
    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      "stream-scope-change-parent",
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<{
      url: string;
      options?: {
        body?: any;
        method?: string;
        headers?: Record<string, string>;
      };
      result?: any;
    }>(
      space,
      "stream-scope-change-inputs",
      undefined,
      setupTx,
    );
    inputsCell.set({
      url: "http://mock-test-server.local/stream-scope-change",
    });
    const setupResult = await setupTx.commit().settled;
    expect(setupResult.ok).toBeDefined();

    const action = rawStreamData(
      inputsCell,
      () => {},
      () => {},
      [],
      parentCell,
      runtime,
    );

    const firstTx = runtime.edit();
    action(firstTx);
    const firstResult = await firstTx.commit().settled;
    expect(firstResult.ok).toBeDefined();
    await runtime.settled();
    expect(fetchCalls.length).toBe(1);

    const linkTx = runtime.edit();
    const userUrlBase = runtime.getCell<string>(
      space,
      "stream-scope-change-user-url",
      undefined,
      linkTx,
    );
    const userUrl = createCell<string>(
      runtime,
      { ...userUrlBase.getAsNormalizedFullLink(), scope: "user" },
      linkTx,
    );
    userUrl.set("http://mock-test-server.local/stream-scope-change");
    inputsCell.withTx(linkTx).key("url").set(userUrl);
    const linkResult = await linkTx.commit().settled;
    expect(linkResult.ok).toBeDefined();

    const secondTx = runtime.edit();
    action(secondTx);
    const secondResult = await secondTx.commit().settled;
    expect(secondResult.ok).toBeDefined();
    await runtime.settled();

    expect(fetchCalls.length).toBe(2);
  });
});

function rawResult(cell: any): unknown {
  return cell.resolveAsCell().getRaw();
}

function unavailableReason(value: unknown): string | undefined {
  return isUnavailable(value) ? value.reason : undefined;
}
