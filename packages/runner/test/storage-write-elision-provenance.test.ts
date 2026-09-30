import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type {
  IMemorySpaceAddress,
  IStorageTransaction,
  ITransactionSealSink,
  SealedCommitVerdict,
  SealedNativeCommit,
} from "../src/storage/interface.ts";
import {
  isInternalVerifierRead,
  isReadIgnoredForScheduling,
  isReadMarkedAsAttemptedWrite,
  markUiInputBlindWriteTx,
  unmarkUiInputBlindWriteTx,
} from "../src/storage/reactivity-log.ts";
import {
  getDirectTransactionReactivityLog,
  getDirectTransactionReadActivities,
} from "../src/storage/transaction-inspection.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("write elision provenance");
const space = signer.did();
const input: IMemorySpaceAddress = {
  space,
  id: "of:elided-output",
  type: "application/json",
  scope: "space",
  path: ["value", "selected"],
};
const output: IMemorySpaceAddress = {
  ...input,
  id: "of:other-output",
  path: ["value"],
};

describe("pending write elision provenance", () => {
  let server: ReturnType<typeof newSharedServer>;
  let storage: EmulatedStorageManager;
  let held: {
    sealed: SealedNativeCommit;
    verdict: PromiseWithResolvers<SealedCommitVerdict>;
  }[];
  let readOnly: IMemorySpaceAddress[];
  let sink: ITransactionSealSink;

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    held = [];
    readOnly = [];
    sink = {
      sealSpaceCommit(target, native, source) {
        const verdict = Promise.withResolvers<SealedCommitVerdict>();
        const sealed = storage.open(target).replica.sealNative!(
          native,
          source,
          verdict.promise,
          { identity: source.scopeKeyIdentity },
        );
        held.push({ sealed, verdict });
        return Promise.resolve({ ok: {} });
      },
      sealSpaceReads(_target, reads) {
        readOnly.push(...reads);
      },
    };
    const seed = storage.edit();
    expect(
      seed.write({ ...input, path: ["value"] }, {
        selected: "before",
        sibling: "kept",
      }).error,
    ).toBeUndefined();
    expect((await seed.commit()).error).toBeUndefined();
  });

  afterEach(async () => {
    for (const entry of held) {
      entry.verdict.resolve({ withdrawn: { message: "test cleanup" } });
    }
    await Promise.all(held.map(({ sealed }) => sealed.settled));
    await storage.close();
    await server.close();
  });

  const seal = async (tx: IStorageTransaction) => {
    expect((await tx.sealInto!(sink)).error).toBeUndefined();
    return held.at(-1)!.sealed;
  };

  for (
    const mode of [
      "single",
      "batch",
      "delete",
      "batch-delete",
      "missing-parent",
    ] as const
  ) {
    it(`retains the pending basis of a ${mode} write elision`, async () => {
      const producer = storage.edit();
      const deleting = mode === "delete" || mode === "batch-delete" ||
        mode === "missing-parent";
      expect(
        producer.write(
          mode === "missing-parent" ? { ...input, path: ["value"] } : input,
          deleting ? undefined : "pending",
          deleting ? { delete: true } : undefined,
        ).error,
      ).toBeUndefined();
      const first = await seal(producer);
      const consumer = storage.edit();
      if (mode === "batch" || mode === "batch-delete") {
        expect(
          consumer.writeBatch!([
            {
              address: input,
              value: deleting ? undefined : "pending",
              delete: deleting,
            },
            {
              address: { ...input, path: ["value", "sibling"] },
              value: "next",
            },
          ]).error,
        ).toBeUndefined();
      } else {
        expect(
          consumer.write(input, deleting ? undefined : "pending", {
            delete: deleting,
          }).error,
        ).toBeUndefined();
      }
      expect(consumer.write(output, "other").error).toBeUndefined();
      const reads = [...getDirectTransactionReadActivities(consumer)!];
      expect(reads).toHaveLength(1);
      expect(reads[0].path).toEqual(input.path);
      expect(isReadIgnoredForScheduling(reads[0].meta)).toBe(true);
      expect(isInternalVerifierRead(reads[0].meta)).toBe(true);
      expect(isReadMarkedAsAttemptedWrite(reads[0].meta)).toBe(false);
      expect(getDirectTransactionReactivityLog(consumer)!.reads).toEqual([]);
      const second = await seal(consumer);
      expect(second.commit.reads.pending).toHaveLength(1);
      expect(second.commit.reads.pending).toEqual([
        expect.objectContaining({ id: input.id, localSeq: first.localSeq }),
      ]);
    });
  }

  it("keeps confirmed-only blind no-ops free of added read dependencies", () => {
    const tx = storage.edit();
    expect(tx.write(input, "before").error).toBeUndefined();
    expect(
      tx.write({ ...input, path: ["value", "absent"] }, undefined, {
        delete: true,
      }).error,
    ).toBeUndefined();
    expect(getDirectTransactionReadActivities(tx)).toEqual([]);
    tx.abort("test cleanup");
  });

  it("does not invent a pending dependency on its own unsealed write", () => {
    const tx = storage.edit();
    expect(tx.write(input, "new").error).toBeUndefined();
    expect(tx.write(input, "new").error).toBeUndefined();
    expect(getDirectTransactionReadActivities(tx)).toEqual([]);
    tx.abort("test cleanup");
  });

  for (const replacement of [true, false]) {
    it(`settles a ${replacement ? "whole replacement" : "sibling change"} after the older pending document is withdrawn`, async () => {
      const producer = storage.edit();
      expect(producer.write(input, "pending").error).toBeUndefined();
      const first = await seal(producer);
      const write = (tx: IStorageTransaction) => {
        if (replacement) {
          const root = { ...input, path: ["value"] };
          const own = { selected: "own", sibling: "own" };
          expect(tx.write(root, own).error).toBeUndefined();
          expect(tx.write(root, own).error).toBeUndefined();
        } else {
          expect(
            tx.write({ ...input, path: ["value", "sibling"] }, "own").error,
          )
            .toBeUndefined();
          expect(tx.write(input, "pending").error).toBeUndefined();
        }
      };
      const consumer = storage.edit();
      write(consumer);
      const second = await seal(consumer);
      // The conservative edge names the older document layer, even when this
      // run replaced its value. It never names this transaction's own writes.
      expect(second.commit.reads.pending).toHaveLength(1);
      expect(second.commit.reads.pending[0].localSeq).toBe(first.localSeq);
      held[0].verdict.resolve({
        withdrawn: { message: "older write refused" },
      });
      expect((await first.settled).error).toBeDefined();
      expect((await second.settled).error).toBeDefined();
      expect(storage.open(space).replica.hasPendingWrite(input.id, input.scope))
        .toBe(false);
      const retry = storage.edit();
      write(retry);
      expect([...getDirectTransactionReadActivities(retry)!]).toEqual([]);
      expect((await retry.commit()).error).toBeUndefined();
      expect(
        Engine.readState(await server.engineForSpace(space), { id: input.id })
          ?.document,
      ).toEqual({
        value: { selected: replacement ? "own" : "pending", sibling: "own" },
      });
    });
  }

  it("preserves the blind UI-input write boundary over pending state", async () => {
    const producer = storage.edit();
    expect(producer.write(input, "pending").error).toBeUndefined();
    await seal(producer);
    const tx = storage.edit();
    markUiInputBlindWriteTx(tx);
    expect(tx.write(input, "pending").error).toBeUndefined();
    unmarkUiInputBlindWriteTx(tx);
    expect(getDirectTransactionReadActivities(tx)).toEqual([]);
    tx.abort("test cleanup");
  });

  it("checks the issuing identity rather than a neighboring user's pending write", async () => {
    const bob = await Identity.fromPassphrase("elision Bob");
    const identity = { principal: bob.did(), sessionId: "bob-session" };
    const scoped = { ...input, scope: "user" as const };
    const seed = storage.edit();
    expect(
      seed.write({ ...scoped, path: ["value"] }, { selected: "alice" }).error,
    )
      .toBeUndefined();
    expect((await seed.commit()).error).toBeUndefined();
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    const replica = storage.open(space).replica;
    const pending = replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: input.id,
          scope: "user",
          type: "application/json",
          value: { value: { selected: "bob" } },
        }],
      },
      undefined,
      verdict.promise,
      { identity },
    );
    held.push({ sealed: pending, verdict });
    const aliceTx = storage.edit();
    expect(aliceTx.write(scoped, "alice").error).toBeUndefined();
    expect([...getDirectTransactionReadActivities(aliceTx)!]).toEqual([]);
    aliceTx.abort("test cleanup");
    const bobTx = storage.edit();
    bobTx.scopeKeyIdentity = identity;
    expect(bobTx.write(scoped, "bob").error).toBeUndefined();
    expect(bobTx.write(output, "other").error).toBeUndefined();
    const sealed = await seal(bobTx);
    expect(sealed.commit.reads.pending).toHaveLength(1);
    expect(sealed.commit.reads.pending[0]).toEqual(expect.objectContaining({
      id: input.id,
      scope: "user",
      localSeq: pending.localSeq,
    }));
  });

  it("hands a foreign elided-output dependency to the wave without subscribing", async () => {
    const producer = storage.edit();
    expect(producer.write(input, "pending").error).toBeUndefined();
    await seal(producer);
    const otherSpace = (await Identity.fromPassphrase("elision home")).did();
    const tx = storage.edit();
    tx.enableMultiSpaceWrites!();
    expect(tx.write(input, "pending").error).toBeUndefined();
    expect(tx.write({ ...output, space: otherSpace }, "home").error)
      .toBeUndefined();
    expect(getDirectTransactionReactivityLog(tx)!.reads).toEqual([]);
    await seal(tx);
    expect(readOnly).toHaveLength(1);
    expect(readOnly).toEqual([{
      space: input.space,
      id: input.id,
      scope: input.scope,
      path: input.path,
    }]);
  });
});
