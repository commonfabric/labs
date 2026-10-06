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
import { computeInputHashFromValue } from "../src/builtins/fetch-utils.ts";

const signer = await Identity.fromPassphrase("test fetch-program outbox");
const space = signer.did();

describe("fetch-program outbox mechanism", () => {
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
        new Response("export const value = 1;\n", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should enqueue fetchProgram work behind the post-commit outbox", async () => {
    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchProgram({ url }),
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

    const resultCell = runtime.getCell(
      space,
      "program-pre-commit-test",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/program.ts",
    }, resultCell);
    tx.commit();

    try {
      await result.pull();
      await runtime.settled();

      expect(committed).toBe(true);
      expect(fetchCalls.length).toBeGreaterThan(0);
      expect(fetchCalls[0].url).toContain("/program.ts");
      await runtime.settled();
    } finally {
      txPrototype.commit = originalTxCommit;
      wrapperPrototype.commit = originalWrapperCommit;
    }
  });

  it("uses a stable fetchProgram idempotency key for identical inputs", async () => {
    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchProgram({ url }),
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
        "program-idempotency-test",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, {
        url: "http://mock-test-server.local/program-idempotency.ts",
      }, resultCell);
      tx.commit();
      await result.pull();

      const expectedHash = computeInputHashFromValue({
        url: "http://mock-test-server.local/program-idempotency.ts",
      });

      expect(outboxIds.length).toBeGreaterThan(0);
      expect(outboxIds[0]).toBe(`fetchProgram:${expectedHash}`);
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
    }
  });
});
