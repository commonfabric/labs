import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { txToReactivityLog } from "../src/scheduler/reactivity.ts";

const signer = await Identity.fromPassphrase("served derivation unseen write");
const space = signer.did() as MemorySpace;
const alice = { principal: "did:key:z6Mk-unseen-alice", sessionId: "a-s1" };

describe("served derivation write to an unseen instance", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    runtime.clearSealDestination();
    await runtime.dispose();
    await storageManager.close();
  });

  const scopedCell = (cause: string, scope: "user" | "space" = "user") =>
    runtime.getCell<{ value: number }>(
      space,
      cause,
      undefined,
      undefined,
      scope,
    );

  /** The reads `tx` logs at the root of `id`, as the scheduler sees them. */
  const rootReadsOf = (tx: IExtendedStorageTransaction, id: string) => {
    const log = txToReactivityLog(tx);
    const atRoot = (reads: typeof log.reads) =>
      reads.filter((read) => read.id === id && read.path.length === 0);
    return { deep: atRoot(log.reads), shallow: atRoot(log.shallowReads ?? []) };
  };

  /**
   * Lands `document` as Alice's instance of `cell` through the replica's
   * own seal, the seam a wave uses, and confirms it.
   */
  const sealAsAlice = async (
    cell: ReturnType<typeof scopedCell>,
    document: Record<string, unknown>,
  ) => {
    const replica = storageManager.open(space).replica;
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "seal-as-alice",
      kind: "event-handler",
      scopeKeyIdentity: alice,
      actionScopeKey: resolveScopeKey("user", alice),
    });
    const { promise, resolve } = Promise.withResolvers<
      { committed: { seq: number } }
    >();
    const sealed = replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: cell.getAsNormalizedFullLink().id,
          type: "application/json",
          scope: "user",
          value: document as never,
        }],
        preconditions: [],
      } as never,
      tx.tx,
      promise,
      { identity: alice },
    );
    resolve({ committed: { seq: 999 } } as never);
    await sealed.settled;
    tx.abort();
  };

  describe("the transaction's reactivity log", () => {
    it("holds a non-recursive read at the root of the instance a served derivation writes without reading", () => {
      const cell = scopedCell("unseen-derived");
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "derive-unseen",
        kind: "derivation",
        scopeKeyIdentity: alice,
        actionScopeKey: resolveScopeKey("user", alice),
      });
      cell.withTx(tx).set({ value: 1 });

      const reads = rootReadsOf(tx, cell.getAsNormalizedFullLink().id);
      expect(reads.deep).toEqual([]);
      expect(reads.shallow).toHaveLength(1);
      expect(reads.shallow[0].scopeKey).toBe(resolveScopeKey("user", alice));
      tx.abort();
    });

    it("holds no such read for an event handler's write", () => {
      const cell = scopedCell("unseen-handled");
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "handle-unseen",
        kind: "event-handler",
        scopeKeyIdentity: alice,
        actionScopeKey: resolveScopeKey("user", alice),
      });
      cell.withTx(tx).set({ value: 1 });

      expect(rootReadsOf(tx, cell.getAsNormalizedFullLink().id)).toEqual({
        deep: [],
        shallow: [],
      });
      tx.abort();
    });

    it("holds no such read for a transaction no serving loop stamped", () => {
      const cell = scopedCell("unseen-unstamped");
      const tx = runtime.edit();
      cell.withTx(tx).set({ value: 1 });

      expect(rootReadsOf(tx, cell.getAsNormalizedFullLink().id)).toEqual({
        deep: [],
        shallow: [],
      });
      tx.abort();
    });

    it("holds no such read for a write to a space-scoped document", () => {
      const cell = scopedCell("unseen-space", "space");
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "derive-space",
        kind: "derivation",
        scopeKeyIdentity: alice,
        actionScopeKey: resolveScopeKey("user", alice),
      });
      cell.withTx(tx).set({ value: 1 });

      expect(rootReadsOf(tx, cell.getAsNormalizedFullLink().id)).toEqual({
        deep: [],
        shallow: [],
      });
      tx.abort();
    });

    it("holds no such read for an instance the replica already holds", async () => {
      const cell = scopedCell("seen-derived");
      await sealAsAlice(cell, { value: { value: 0 } });

      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "derive-seen",
        kind: "derivation",
        scopeKeyIdentity: alice,
        actionScopeKey: resolveScopeKey("user", alice),
      });
      cell.withTx(tx).set({ value: 1 });

      expect(rootReadsOf(tx, cell.getAsNormalizedFullLink().id)).toEqual({
        deep: [],
        shallow: [],
      });
      tx.abort();
    });
  });
});
