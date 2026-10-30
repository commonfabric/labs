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
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("served derivation unseen write");
const space = signer.did() as MemorySpace;
const alice = { principal: "did:key:z6Mk-unseen-alice", sessionId: "a-s1" };

// Someone who is neither this space nor its signer, whose personal-space
// clause the space's own residency does not admit.
const OTHER_PRINCIPAL = "did:key:zOtherPerson";

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
      // A writer-fit misfit lands as a diagnostic on the transaction, so a
      // label a run's flow join takes in shows up whether or not the commit
      // goes through.
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
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

  describe("the CFC flow join", () => {
    // Alice's instance of the output, as the store holds it: a payload
    // confidential to someone the space's residency does not admit.
    const labeledInstance = {
      value: { value: 7 },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: {
              confidentiality: [{
                type: "https://commonfabric.org/cfc/atom/PersonalSpace",
                owner: OTHER_PRINCIPAL,
              }],
            },
          }],
        },
      },
    };

    beforeEach(async () => {
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      expect((await seed.commit().settled).error).toBeUndefined();
    });

    /**
     * Runs a served derivation for Alice that writes `output` and a
     * space-scoped `sink`, which declares no store policy, so a confidential
     * label taken into the run's flow join cannot fit it. `beforeCommit`
     * runs between the writes and the commit. Returns the transaction, the
     * writer-fit diagnostics its preparation recorded, and the commit's
     * result.
     */
    const deriveForAlice = async (
      output: ReturnType<typeof scopedCell>,
      sinkCause: string,
      options: {
        readOutput?: boolean;
        beforeCommit?: () => Promise<void>;
      } = {},
    ) => {
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "derive-for-alice",
        kind: "derivation",
        scopeKeyIdentity: alice,
        actionScopeKey: resolveScopeKey("user", alice),
      });
      if (options.readOutput === true) output.withTx(tx).get();
      output.withTx(tx).set({ value: 1 });
      scopedCell(sinkCause, "space").withTx(tx).set({ value: 1 });
      await options.beforeCommit?.();
      tx.prepareCfc();
      const writerFit = tx.getCfcState().diagnostics.filter((diagnostic) =>
        diagnostic.includes("writer-fit")
      );
      return { tx, writerFit, result: await tx.commit().settled };
    };

    it("records no writer-fit misfit for a first write over an unseen labeled instance that arrives before the commit, and refuses the commit as inconsistent", async () => {
      const output = scopedCell("flow-unseen-output");
      const { tx, writerFit, result } = await deriveForAlice(
        output,
        "flow-unseen-sink",
        {
          // The instance lands in the replica after the run wrote over its
          // absence and before the run commits.
          beforeCommit: () => sealAsAlice(output, labeledInstance),
        },
      );

      expect(rootReadsOf(tx, output.getAsNormalizedFullLink().id).shallow)
        .toHaveLength(1);
      expect(writerFit).toEqual([]);
      // The commit-time claim re-reads the instance the run saw as absent,
      // finds it there, and refuses the run as built on a stale view.
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
    });

    it("records no writer-fit misfit and no root read for the re-run's write once the instance has arrived", async () => {
      const output = scopedCell("flow-arrived-output");
      await sealAsAlice(output, labeledInstance);
      const { tx, writerFit } = await deriveForAlice(
        output,
        "flow-arrived-sink",
      );

      expect(rootReadsOf(tx, output.getAsNormalizedFullLink().id)).toEqual({
        deep: [],
        shallow: [],
      });
      expect(writerFit).toEqual([]);
    });

    it("records a writer-fit misfit when the run reads the labeled instance itself", async () => {
      // The control for the two above: the instance's label does reach a
      // flow join that observes it, and the space-scoped sink then cannot
      // hold what the run wrote.

      const output = scopedCell("flow-read-output");
      await sealAsAlice(output, labeledInstance);
      const { writerFit } = await deriveForAlice(output, "flow-read-sink", {
        readOutput: true,
      });

      expect(writerFit.length).toBeGreaterThan(0);
      expect(writerFit[0]).toContain("writer-fit confidentiality misfit");
    });
  });
});
