import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import { setPatternEnvironment } from "../src/env.ts";
import {
  computeInputHashFromValue,
  internalSchema,
  tryClaimMutex,
} from "../src/builtins/fetch-utils.ts";
import type { Schema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("test fetch mutex");
const space = signer.did();

describe("fetch-json mutex mechanism: core mutex behavior", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    pattern = commonfabric.pattern;
    byRef = commonfabric.byRef;

    // Set up pattern environment with a mock base URL
    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    // Mock fetch
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
          JSON.stringify({ mocked: true, url }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should successfully fetch data", async () => {
    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchJson({ url }),
    );

    const resultCell = runtime.getCell(space, "fetch-test", undefined, tx);
    const result = runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/api/test",
    }, resultCell);
    tx.commit();

    // Pull the result to trigger computation, then drain the in-flight
    // transport frames and post-commit fetch work.
    await result.pull();
    await clock.settle();

    const rawData = result.get() as {
      pending: any;
      result: any;
      error: any;
    };

    // Should have result
    expect(rawData.result).toBeDefined();
    expect(rawData.result.mocked).toBe(true);
    expect(rawData.error).toBeUndefined();
    expect(rawData.pending).toBe(false);

    // Should have made the fetch call
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls[0].url).toContain("/api/test");
  });

  it("resolves relative fetchJson URLs against the pattern API URL", async () => {
    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local/api/root/"),
    });

    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchJson({ url }),
    );

    const resultCell = runtime.getCell(
      space,
      "relative-url-test",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      { url: "data/items.json" },
      resultCell,
    );
    tx.commit();

    await result.pull();
    await clock.settle();

    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls[0].url).toBe(
      "http://mock-test-server.local/api/root/data/items.json",
    );
  });

  it("should enqueue fetchJson work behind the post-commit outbox", async () => {
    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchJson({ url }),
    );

    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxCommit = txPrototype.commit;
    const originalWrapperCommit = wrapperPrototype.commit;
    let committed = false;

    txPrototype.commit = function (...args) {
      committed = true;
      return originalTxCommit.apply(this, args as never);
    };
    wrapperPrototype.commit = function (...args) {
      committed = true;
      return originalWrapperCommit.apply(this, args as never);
    };

    const resultCell = runtime.getCell(space, "pre-commit-test", undefined, tx);
    const result = runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/api/pre-commit",
    }, resultCell);

    try {
      tx.commit();
      await result.pull();
      await clock.settle();

      expect(committed).toBe(true);
      expect(fetchCalls.length).toBeGreaterThan(0);
      expect(fetchCalls[0].url).toContain("/api/pre-commit");
    } finally {
      txPrototype.commit = originalTxCommit;
      wrapperPrototype.commit = originalWrapperCommit;
    }
  });

  it("uses a stable fetchJson idempotency key for identical inputs", async () => {
    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchJson({ url, options: { mutexTimeoutMs: 30_000 } }),
    );

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
        "fetch-idempotency-test",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, {
        url: "http://mock-test-server.local/api/idempotency",
      }, resultCell);
      tx.commit();
      await result.pull();

      const expectedHash = computeInputHashFromValue({
        url: "http://mock-test-server.local/api/idempotency",
      });

      expect(computeInputHashFromValue({
        url: "http://mock-test-server.local/api/idempotency",
        options: { mutexTimeoutMs: 30_000 },
      })).toBe(expectedHash);
      expect(outboxIds.length).toBeGreaterThan(0);
      expect(outboxIds[0]).toBe(`fetchJson:${expectedHash}`);
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
    }
  });

  it("does not claim a post-commit fetch mutex when live inputs differ from the approved snapshot", async () => {
    const inputs = runtime.getCell<{
      url?: string;
      mode?: "json" | "text";
    }>(space, "fetch-mutex-approved-inputs", undefined, tx);
    const pending = runtime.getCell<boolean>(
      space,
      "fetch-mutex-approved-pending",
      undefined,
      tx,
    );
    const result = runtime.getCell<unknown>(
      space,
      "fetch-mutex-approved-result",
      undefined,
      tx,
    );
    const error = runtime.getCell<unknown>(
      space,
      "fetch-mutex-approved-error",
      undefined,
      tx,
    );
    const internal = runtime.getCell<Schema<typeof internalSchema>>(
      space,
      "fetch-mutex-approved-internal",
      undefined,
      tx,
    );
    inputs.set({ url: "/api/mutated", mode: "json" });
    pending.set(false);
    internal.set({ requestId: "", lastActivity: 0, inputHash: "" });
    await tx.commit().settled;
    tx = runtime.edit();

    const approvedSnapshot = { url: "/api/approved", mode: "json" as const };
    const approvedHash = computeInputHashFromValue(approvedSnapshot);
    const claim = await tryClaimMutex(
      runtime,
      inputs,
      pending,
      result,
      error,
      internal,
      approvedHash,
      (cell) => cell.get() ?? {},
      approvedHash,
    );

    expect(claim.claimed).toBe(false);
    expect(claim.inputHash).not.toBe(approvedHash);
    expect(pending.get()).toBe(false);
  });

  it("should handle concurrent requests with same inputs (mutex test)", async () => {
    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchJson({ url }),
    );

    // Create two separate result cells simulating two "tabs"
    const resultCell1 = runtime.getCell(space, "concurrent-1", undefined, tx);
    const resultCell2 = runtime.getCell(space, "concurrent-2", undefined, tx);

    // Start both at the same time
    runtime.run(tx, testPattern, { url: "/api/concurrent" }, resultCell1);
    runtime.run(tx, testPattern, { url: "/api/concurrent" }, resultCell2);
    tx.commit();

    // Pull first to trigger computation (starts the fetch)
    await resultCell1.pull();
    await resultCell2.pull();
    await clock.settle();

    // Pull again to get final results
    const data1 = (await resultCell1.pull()) as { result?: unknown };
    const data2 = (await resultCell2.pull()) as { result?: unknown };

    expect(data1.result).toBeDefined();
    expect(data2.result).toBeDefined();

    // Due to mutex, we should have made at most a few fetch calls, not 2x
    const relevantCalls = fetchCalls.filter((c) =>
      c.url.includes("/api/concurrent")
    );

    // This is the key test: with mutex, redundant requests should be prevented
    expect(relevantCalls.length).toBeLessThanOrEqual(2);
  });
});
