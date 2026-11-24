import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const signerA = await Identity.fromPassphrase("multi-space-write-a");
const signerB = await Identity.fromPassphrase("multi-space-write-b");
const spaceA = signerA.did();
const spaceB = signerB.did();

const addr = (space: MemorySpace, id: `${string}:${string}`) => ({
  space,
  scope: "space" as const,
  id,
  path: [] as string[],
});

describe("multi-space write transactions", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signerA });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost:8000"),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("rejects a write to a second space by default", () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow(addr(spaceA, "of:default-a"), { v: 1 });
    let thrown: unknown;
    try {
      tx.writeValueOrThrow(addr(spaceB, "of:default-b"), { v: 2 });
    } catch (error) {
      thrown = error;
    }
    // Named, not just any throw: the single-space guarantee is what this error
    // reports, and callers match on the name.
    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "StorageTransactionWriteIsolationError",
    );
  });

  it("writes and commits to multiple spaces when opted in", async () => {
    const tx = runtime.edit();
    tx.enableMultiSpaceWrites?.();
    tx.writeValueOrThrow(addr(spaceA, "of:multi-a"), { v: 1 });
    tx.writeValueOrThrow(addr(spaceB, "of:multi-b"), { v: 2 });

    // read-your-writes works across both spaces within the same transaction
    expect(tx.readValueOrThrow(addr(spaceA, "of:multi-a"))).toEqual({ v: 1 });
    expect(tx.readValueOrThrow(addr(spaceB, "of:multi-b"))).toEqual({ v: 2 });

    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();

    // both spaces are durable in a fresh transaction
    const verify = runtime.edit();
    expect(verify.readValueOrThrow(addr(spaceA, "of:multi-a"))).toEqual({
      v: 1,
    });
    expect(verify.readValueOrThrow(addr(spaceB, "of:multi-b"))).toEqual({
      v: 2,
    });
  });

  it("commits each written space with an explicit order", async () => {
    const tx = runtime.edit();
    tx.enableMultiSpaceWrites?.([spaceB, spaceA]);
    tx.writeValueOrThrow(addr(spaceA, "of:order-a"), { v: 10 });
    tx.writeValueOrThrow(addr(spaceB, "of:order-b"), { v: 20 });

    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();

    const verify = runtime.edit();
    expect(verify.readValueOrThrow(addr(spaceA, "of:order-a"))).toEqual({
      v: 10,
    });
    expect(verify.readValueOrThrow(addr(spaceB, "of:order-b"))).toEqual({
      v: 20,
    });
  });

  it("still single-space commits when opted in but only one space written", async () => {
    const tx = runtime.edit();
    tx.enableMultiSpaceWrites?.();
    tx.writeValueOrThrow(addr(spaceA, "of:single"), { v: 7 });

    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();

    const verify = runtime.edit();
    expect(verify.readValueOrThrow(addr(spaceA, "of:single"))).toEqual({
      v: 7,
    });
  });

  it("settles with an error when a per-space split commit throws", async () => {
    const tx = runtime.edit();
    tx.enableMultiSpaceWrites?.();
    tx.writeValueOrThrow(addr(spaceA, "of:throw-a"), { v: 1 });
    tx.writeValueOrThrow(addr(spaceB, "of:throw-b"), { v: 2 });

    // A replica without commitNative() makes runSplitCommits throw (rather than
    // return an error). The split commit must still settle the transaction with
    // an error result instead of leaving it stuck at "pending".
    const replicaB = storageManager.open(spaceB).replica as unknown as {
      commitNative?: unknown;
    };
    replicaB.commitNative = undefined;

    const result = await tx.commit().settled;
    expect(result.error).toBeDefined();
    expect(tx.status().status).not.toBe("pending");
  });

  it("does not roll back earlier spaces when a later space's commit fails", async () => {
    const tx = runtime.edit();
    // Order so space A commits (for real) before space B fails.
    tx.enableMultiSpaceWrites?.([spaceA, spaceB]);
    tx.writeValueOrThrow(addr(spaceA, "of:partial-a"), { v: 1 });
    tx.writeValueOrThrow(addr(spaceB, "of:partial-b"), { v: 2 });

    // Space B's native commit returns an error after space A is already durable.
    const replicaB = storageManager.open(spaceB).replica as unknown as {
      commitNative: (...args: unknown[]) => Promise<unknown>;
    };
    replicaB.commitNative = () =>
      Promise.resolve({
        error: {
          name: "StorageTransactionRejected",
          message: "space B failed",
        },
      });

    const result = await tx.commit().settled;
    // The first per-space error is surfaced as the overall result.
    expect(result.error).toBeDefined();

    // No rollback: space A's earlier write is durably present (the documented
    // indeterminate-partial-state contract).
    const verify = runtime.edit();
    expect(verify.readValueOrThrow(addr(spaceA, "of:partial-a"))).toEqual({
      v: 1,
    });
  });

  it("stops at the first failure and does not commit later spaces", async () => {
    const tx = runtime.edit();
    // Order so space A commits first; make it fail.
    tx.enableMultiSpaceWrites?.([spaceA, spaceB]);
    tx.writeValueOrThrow(addr(spaceA, "of:stop-a"), { v: 1 });
    tx.writeValueOrThrow(addr(spaceB, "of:stop-b"), { v: 2 });

    const replicaA = storageManager.open(spaceA).replica as unknown as {
      commitNative: (...args: unknown[]) => Promise<unknown>;
    };
    replicaA.commitNative = () =>
      Promise.resolve({
        error: {
          name: "StorageTransactionRejected",
          message: "space A failed",
        },
      });

    const result = await tx.commit().settled;
    expect(result.error).toBeDefined();

    // Space B (ordered after the failed space A) must not have been committed.
    const verify = runtime.edit();
    let bValue: unknown;
    try {
      bValue = verify.readValueOrThrow(addr(spaceB, "of:stop-b"));
    } catch {
      bValue = undefined;
    }
    expect(bValue).not.toEqual({ v: 2 });
  });
});
