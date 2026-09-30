import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { hashOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { streamData as rawStreamData } from "../src/builtins/stream-data.ts";
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
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

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
    pattern = commonfabric.pattern;
    byRef = commonfabric.byRef;

    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    fetchCalls = [];
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

      fetchCalls.push({ url, init });

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

      const commitPromise = tx.commit();

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
      const commitPromise = tx.commit();
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
    const setupResult = await setupTx.commit();
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
    const rejectedResult = await rejectedTx.commit();
    expect(isCfcEnforcementRejection(rejectedResult.error)).toBe(true);
    await runtime.settled();
    expect(fetchCalls).toEqual([]);

    const retryTx = runtime.edit();
    action(retryTx);
    const retryResult = await retryTx.commit();
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
    const setupResult = await setupTx.commit();
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
    const firstResult = await firstTx.commit();
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
    const linkResult = await linkTx.commit();
    expect(linkResult.ok).toBeDefined();

    const secondTx = runtime.edit();
    action(secondTx);
    const secondResult = await secondTx.commit();
    expect(secondResult.ok).toBeDefined();
    await runtime.settled();

    expect(fetchCalls.length).toBe(2);
  });
});
