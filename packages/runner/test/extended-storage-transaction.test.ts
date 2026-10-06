// The transaction's side of a materialized read's instant.
//
// A read resolving against an earlier epoch describes a different moment than
// the transaction's caches do, so those caches stand aside for it. And a
// wrapper answers for the instant exactly as the transaction it wraps does,
// which is what keeps a read taken through `Cell.sample()` describing the same
// moment as one taken directly.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  createNonReactiveTransaction,
  type ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import type {
  IExtendedStorageTransaction,
  TransactionWriteDetail,
} from "../src/storage/interface.ts";
import { RuntimeOwnedStores } from "../src/cfc/runtime-owned-stores.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
  CFC_STRUCTURAL_PROVENANCE_UNDECLARABLE_STORE,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("extended-storage-transaction");
const space = signer.did();

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
} as const satisfies JSONSchema;

describe("extended-storage-transaction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const seeded = async (cause: string) => {
    const write = runtime.edit();
    runtime.getCell(space, cause, undefined, write).set({ title: "before" });
    await write.commit().settled;
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    return { tx, cell: runtime.getCell(space, cause, SCHEMA, tx) };
  };

  describe("content-addressed document staging", () => {
    const code = "export const staged = 1;";
    const codeId = `cid:${taggedHashStringOf(code)}`;
    const stagedIds = (tx: IExtendedStorageTransaction): string[] =>
      [...(tx.getWriteDetails?.(space) ?? [])].map((write) => write.address.id);

    it("stages a document once however often a transaction asks", () => {
      const tx = runtime.edit();
      expect(tx.stageContentAddressedDocument(space, code)).toBe(codeId);
      expect(tx.stageContentAddressedDocument(space, code)).toBe(codeId);
      expect(stagedIds(tx).filter((id) => id === codeId)).toHaveLength(1);
      tx.abort?.();
    });

    it("names a document by the general content hash of any value", () => {
      const value = { kind: "blob", bytes: [1, 2, 3] };
      const tx = runtime.edit();
      expect(tx.stageContentAddressedDocument(space, value)).toBe(
        `cid:${taggedHashStringOf(value)}`,
      );
      tx.abort?.();
    });

    it("elides a document the server already holds, whatever its value", async () => {
      // A string, an array, and a number: the elision re-hashes the confirmed
      // value, so it must recognize every kind of value the seam stages.
      const values = [code, [1, "two", { three: 3 }], 42];
      const ids = values.map((value) => `cid:${taggedHashStringOf(value)}`);
      const install = runtime.edit();
      for (const value of values) {
        install.stageContentAddressedDocument(space, value);
      }
      expect((await install.commit().settled).error).toBeUndefined();
      await storageManager.synced();

      const tx = runtime.edit();
      values.forEach((value, index) => {
        expect(tx.stageContentAddressedDocument(space, value)).toBe(
          ids[index],
        );
      });
      for (const id of ids) expect(stagedIds(tx)).not.toContain(id);
      tx.abort?.();
    });

    it("stages through a wrapping transaction into the one it wraps", () => {
      const tx = runtime.edit();
      const wrapped = createNonReactiveTransaction(tx);
      expect(wrapped.stageContentAddressedDocument(space, code)).toBe(codeId);
      expect(stagedIds(tx)).toContain(codeId);
      tx.abort?.();
    });
  });

  describe("the read-result cache across a batch write", () => {
    it("keeps its entries across a batch holding no writes", () => {
      const tx = runtime.edit();
      tx.setCachedReadResult!("key", "variant", 1);

      tx.writeValuesOrThrow!([]);

      expect(tx.getCachedReadResult!("key", "variant")).toEqual({ value: 1 });
      tx.abort("done");
    });

    it("drops its entries once a batch writes", async () => {
      const { tx, cell } = await seeded("batch-write-drops-cache");
      tx.setCachedReadResult!("key", "variant", 1);

      tx.writeValuesOrThrow!([{
        address: cell.getAsNormalizedFullLink(),
        value: { value: 1 },
      }]);

      expect(tx.getCachedReadResult!("key", "variant")).toBeUndefined();
      tx.abort("done");
    });
  });

  describe("the read-result cache under an epoch", () => {
    it("serves nothing while a read resolves against an earlier epoch", () => {
      const tx = runtime.edit();
      // Optional on the interface, and the behavior under test is what it
      // does, so a transaction without it has nothing to say.
      expect(typeof tx.getCachedReadResult).toBe("function");
      tx.setCachedReadResult!("key", "variant", 1);
      expect(tx.getCachedReadResult!("key", "variant")).toEqual({ value: 1 });

      const previous = tx.enterReadEpoch(0);
      expect(tx.getCachedReadResult!("key", "variant")).toBeUndefined();
      tx.exitReadEpoch(previous);

      expect(tx.getCachedReadResult!("key", "variant")).toEqual({ value: 1 });
      tx.abort("done");
    });

    it("keeps nothing taken while a read resolves against an earlier epoch", () => {
      const tx = runtime.edit();

      const previous = tx.enterReadEpoch(0);
      tx.setCachedReadResult!("key", "variant", 2);
      tx.exitReadEpoch(previous);

      // Had it been kept, this would answer with the value taken under the
      // epoch — a materialized read's value served to a current one.
      expect(tx.getCachedReadResult!("key", "variant")).toBeUndefined();
      tx.abort("done");
    });
  });

  describe("commit on a transaction that is no longer open", () => {
    // A second commit reports the transaction's terminal state as its result.
    // It runs none of the commit-path work: the CFC relevance probes read
    // stored metadata through the transaction, which admits no reads once its
    // commit is in flight, settled, or aborted. The underlying transaction
    // holds a single commit verdict, which stays with the commit that is
    // running.

    it("returns the completion error while the first commit is in flight", async () => {
      const tx = runtime.edit();
      runtime.getCell(space, "double-commit", undefined, tx).set({
        title: "once",
      });
      const flushed: string[] = [];
      const verdicts: string[] = [];
      const settlements: string[] = [];
      tx.enqueuePostCommitEffect({
        id: "double-commit-effect",
        kind: "test",
        flush: () => {
          flushed.push("flushed");
        },
      });
      tx.addVerdictCallback((_tx, result) => {
        verdicts.push(result.error ? result.error.name : "ok");
      });
      tx.addCommitCallback((_tx, result) => {
        settlements.push(result.error ? result.error.name : "ok");
      });

      const first = tx.commit().settled;
      expect(tx.status().status).toBe("pending");
      const second = await tx.commit().settled;
      expect(second.error?.name).toBe("StorageTransactionCompleteError");

      expect((await first).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      expect(verdicts).toEqual(["ok"]);
      expect(settlements).toEqual(["ok"]);
      expect(flushed).toEqual(["flushed"]);
    });

    it("returns the completion error after the first commit settled", async () => {
      const tx = runtime.edit();
      runtime.getCell(space, "double-commit-settled", undefined, tx).set({
        title: "once",
      });
      expect((await tx.commit().settled).error).toBeUndefined();
      const second = await tx.commit().settled;
      expect(second.error?.name).toBe("StorageTransactionCompleteError");
    });

    it("returns the abort reason after the transaction was aborted", async () => {
      const tx = runtime.edit();
      runtime.getCell(space, "commit-after-abort", undefined, tx).set({
        title: "once",
      });
      tx.abort("done with this one");
      const result = await tx.commit().settled;
      expect(result.error?.name).toBe("StorageTransactionAborted");
    });

    describe("with flow labels persisted", () => {
      // The flow-labels probe is what reads stored metadata, and it runs only
      // with the dial on, which the shared runtime leaves off. An aborted
      // transaction keeps its read and write activity so the scheduler can
      // rebuild the action's dependencies, so the probe has work to walk
      // there; a settled one does not.
      beforeEach(async () => {
        await runtime.dispose();
        await storageManager.close();
        storageManager = StorageManager.emulate({ as: signer });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
          cfcFlowLabels: "persist",
        });
      });

      it("returns the completion error while the first commit is in flight", async () => {
        const tx = runtime.edit();
        runtime.getCell(space, "labeled-double-commit", undefined, tx).set({
          title: "once",
        });
        const first = tx.commit().settled;
        const second = await tx.commit().settled;
        expect(second.error?.name).toBe("StorageTransactionCompleteError");
        expect((await first).error).toBeUndefined();
      });

      it("returns the abort reason after the transaction was aborted", async () => {
        const tx = runtime.edit();
        runtime.getCell(space, "labeled-commit-after-abort", undefined, tx)
          .set({ title: "once" });
        tx.abort("done with this one");
        const result = await tx.commit().settled;
        expect(result.error?.name).toBe("StorageTransactionAborted");
      });
    });
  });

  describe("a wrapped transaction", () => {
    it("preserves document-narrowed write lookup and its compatibility fallback", () => {
      const target = {
        space,
        id: "of:fid1:wrapped-write-target" as URI,
        path: [] as const,
      };
      const details = [{
        address: { ...target, path: ["value"] },
        value: { title: "bounded" },
      }] as unknown as TransactionWriteDetail[];

      const narrowed = new TransactionWrapper({
        getWriteDetailsForTarget: (requested: typeof target) => {
          expect(requested).toEqual(target);
          return details;
        },
        getWriteDetails: () => {
          throw new Error("must preserve the narrowed lookup");
        },
      } as unknown as IExtendedStorageTransaction);
      expect([...narrowed.getWriteDetailsForTarget(target)]).toEqual(details);

      const compatible = new TransactionWrapper({
        getWriteDetails: (requestedSpace: MemorySpace) => {
          expect(requestedSpace).toBe(space);
          return details;
        },
      } as unknown as IExtendedStorageTransaction);
      expect([...compatible.getWriteDetailsForTarget(target)]).toEqual(details);
    });

    it("answers for the instant as the transaction it wraps does", async () => {
      const { tx, cell } = await seeded("wrapped-instant");
      const wrapper = createNonReactiveTransaction(tx);
      try {
        expect(wrapper.hasWrites()).toBe(false);

        const view = cell.withTx(wrapper).get() as { title: string };
        cell.withTx(tx).key("title").set("after");

        expect(wrapper.hasWrites()).toBe(true);
        // The wrapper carried the epoch down, so the view it handed back keeps
        // describing the moment it was taken.
        expect(view.title).toBe("before");
        expect((cell.withTx(wrapper).get() as { title: string }).title).toBe(
          "after",
        );
      } finally {
        await tx.commit().settled;
      }
    });

    it("records a refusal detail on the transaction it wraps", async () => {
      const { tx } = await seeded("wrapped-refusal-detail");
      const wrapper = createNonReactiveTransaction(tx);
      try {
        wrapper.recordCfcRefusalDetail({
          gate: "sink-ceiling",
          sink: "fetchText",
          offendingAtoms: ['"medical"'],
          inputs: [],
          attribution: "none",
          reason: "sink-request confidentiality exceeds ceiling for " +
            'fetchText: "medical"',
        });

        // The wrapper shares the inner transaction's CFC state, so a gate
        // that refuses while running under a wrapper describes itself to the
        // transaction that will be asked for the refusal.
        expect(tx.getCfcState().refusalDetails).toEqual([{
          gate: "sink-ceiling",
          sink: "fetchText",
          offendingAtoms: ['"medical"'],
          inputs: [],
          attribution: "none",
          reason: "sink-request confidentiality exceeds ceiling for " +
            'fetchText: "medical"',
        }]);
      } finally {
        await tx.commit().settled;
      }
    });
  });

  describe("document schema-policy inputs", () => {
    it("includes later inputs across scopes while excluding other documents", async () => {
      const otherSpace = (await Identity.fromPassphrase("policy-input-other"))
        .did();
      const tx = runtime.edit();
      const wrapped = createNonReactiveTransaction(tx);
      const target = {
        space,
        id: "of:policy",
        scope: "space",
        path: [],
      } as const;
      expect(wrapped.getCfcSchemaPolicyInputs(space, target.id)).toEqual([]);
      const first = { kind: "schema", target, schema: SCHEMA } as const;
      tx.recordCfcWritePolicyInput(first);
      tx.recordCfcWritePolicyInput({
        kind: "schema",
        target: { ...target, id: "of:other" },
        schema: SCHEMA,
      });
      tx.recordCfcWritePolicyInput({
        kind: "schema",
        target: { ...target, space: otherSpace },
        schema: SCHEMA,
      });
      tx.recordCfcWritePolicyInput({
        kind: "custom",
        target,
        name: "other-kind",
        value: null,
      });
      const second = {
        kind: "schema",
        target: { ...target, scope: "user", path: ["title"] },
        schema: { type: "string" },
      } as const;
      wrapped.recordCfcWritePolicyInput(second);
      expect(tx.getCfcSchemaPolicyInputs(space, target.id)).toEqual([
        first,
        second,
      ]);
      expect(wrapped.getCfcSchemaPolicyInputs(space, target.id)).toEqual([
        first,
        second,
      ]);
      expect(tx.getCfcState().writePolicyInputs).toHaveLength(5);
      tx.abort();
      const fresh = runtime.edit();
      expect(fresh.getCfcSchemaPolicyInputs(space, target.id)).toEqual([]);
      fresh.abort();
    });

    it("protects the indexed inputs and their nested schema from mutation", () => {
      const tx = runtime.edit();
      const target = {
        space,
        id: "of:immutable-policy",
        scope: "space",
        path: [],
      } as const;
      tx.recordCfcWritePolicyInput({ kind: "schema", target, schema: SCHEMA });
      const inputs = tx.getCfcSchemaPolicyInputs(space, target.id);
      expect(() => Reflect.set(inputs, "length", 0)).toThrow("read-only");
      expect(Reflect.set(inputs[0].target, "id", "of:corrupted")).toBe(false);
      expect(Reflect.set(SCHEMA.properties.title, "type", "number")).toBe(
        false,
      );
      expect(tx.getCfcSchemaPolicyInputs(space, target.id)).toHaveLength(1);
      expect(tx.getCfcState().writePolicyInputs).toHaveLength(1);
      tx.abort();
    });
  });

  describe("a write-policy input's recorder", () => {
    // A gate that ACTS on a write-policy input asks who recorded it, because
    // this method is on the public interface and pattern-authored code
    // reaches the transaction its cells are bound to. The authorization
    // travels as an argument of the one call that carries it, so the answer
    // has to be per input rather than per transaction.

    const input = (id: string) =>
      ({
        kind: "structural-provenance",
        target: { space, id, scope: "space", path: [] },
        claim: CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
        sources: [],
      }) as const;

    it("returns `true` for an input recorded with the authorization", async () => {
      const tx = runtime.edit();
      try {
        tx.recordCfcWritePolicyInput(
          input("of:authorized"),
          runtimeWritePolicyAuthorization,
        );
        const [recorded] = tx.getCfcState().writePolicyInputs;
        expect(tx.isRuntimeWritePolicyInput(recorded)).toBe(true);
      } finally {
        await tx.commit().settled;
      }
    });

    it("returns `false` for an input recorded without it", async () => {
      const tx = runtime.edit();
      try {
        tx.recordCfcWritePolicyInput(input("of:unauthorized"));
        const [recorded] = tx.getCfcState().writePolicyInputs;
        expect(tx.isRuntimeWritePolicyInput(recorded)).toBe(false);
      } finally {
        await tx.commit().settled;
      }
    });

    it("answers per input rather than per transaction", async () => {
      // The mark reaches the one input its call carried, so recording an
      // authorized input does not lend the mark to an unauthorized one
      // beside it — in either order.
      const tx = runtime.edit();
      try {
        tx.recordCfcWritePolicyInput(
          input("of:first-authorized"),
          runtimeWritePolicyAuthorization,
        );
        tx.recordCfcWritePolicyInput(input("of:then-plain"));
        tx.recordCfcWritePolicyInput(
          input("of:then-authorized"),
          runtimeWritePolicyAuthorization,
        );
        expect(
          tx.getCfcState().writePolicyInputs.map((recorded) =>
            tx.isRuntimeWritePolicyInput(recorded)
          ),
        ).toEqual([true, false, true]);
      } finally {
        await tx.commit().settled;
      }
    });

    it("returns `false` for an input this transaction never recorded", async () => {
      // The mark is held by reference to the frozen record the transaction
      // owns, so a look-alike built outside it answers `false` however
      // exactly its fields match.
      const tx = runtime.edit();
      try {
        tx.recordCfcWritePolicyInput(
          input("of:owned"),
          runtimeWritePolicyAuthorization,
        );
        expect(tx.isRuntimeWritePolicyInput(input("of:owned"))).toBe(false);
      } finally {
        await tx.commit().settled;
      }
    });
  });
  describe("the enrollment of a store the runtime owns", () => {
    // The enrollment answers for the whole runtime rather than for one
    // transaction, which is what carries it to the reactive updates and
    // settled requests that fill such a store. Every id in it is derivable
    // from a piece's cause, so the answer takes the runtime's mark: without
    // it, pattern-authored code reaching `cell.tx` could ask whether a given
    // piece is running here.

    const address = (id: string) =>
      ({ space, id, scope: "space", path: [] }) as const;

    it("answers for a store a previous transaction enrolled", async () => {
      const first = runtime.edit();
      first.enrollRuntimeOwnedStore(
        address("of:enrolled"),
        "owner-key",
        runtimeWritePolicyAuthorization,
      );
      await first.commit().settled;

      const later = runtime.edit();
      try {
        expect(
          later.isRuntimeOwnedStore(
            space,
            "of:enrolled",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
      } finally {
        await later.commit().settled;
      }
    });

    it("answers `false` to a caller without the runtime's mark", async () => {
      const tx = runtime.edit();
      try {
        tx.enrollRuntimeOwnedStore(
          address("of:unmarked-reader"),
          "owner-key",
          runtimeWritePolicyAuthorization,
        );
        expect(tx.isRuntimeOwnedStore(space, "of:unmarked-reader")).toBe(false);
        expect(
          tx.isRuntimeOwnedStore(
            space,
            "of:unmarked-reader",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
      } finally {
        await tx.commit().settled;
      }
    });

    it("is answered through a wrapper as through what it wraps", async () => {
      const tx = runtime.edit();
      const wrapper = createNonReactiveTransaction(tx);
      try {
        tx.enrollRuntimeOwnedStore(
          address("of:through-a-wrapper"),
          "owner-key",
          runtimeWritePolicyAuthorization,
        );
        expect(
          wrapper.isRuntimeOwnedStore(
            space,
            "of:through-a-wrapper",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
        expect(
          wrapper.isRuntimeOwnedStore(space, "of:through-a-wrapper"),
        ).toBe(false);
      } finally {
        await tx.commit().settled;
      }
    });

    it("enrolls through a wrapper into what it wraps", async () => {
      const tx = runtime.edit();
      const wrapper = createNonReactiveTransaction(tx);
      try {
        wrapper.enrollRuntimeOwnedStore(
          address("of:enrolled-through-a-wrapper"),
          "owner-key",
          runtimeWritePolicyAuthorization,
        );
        expect(
          tx.isRuntimeOwnedStore(
            space,
            "of:enrolled-through-a-wrapper",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
      } finally {
        await tx.commit().settled;
      }
    });

    it("answers for a store enrolled at a different scope instance", async () => {
      // The store key omits scope deliberately: the scope instances of one
      // causal cell are instances of the same store, materialized for the
      // same piece, so an enrollment made while the store was addressed at
      // one scope has to answer the write that arrives at another. Keying on
      // scope would enroll whichever instance the runtime minted first and
      // refuse the rest.
      const tx = runtime.edit();
      try {
        tx.enrollRuntimeOwnedStore(
          { space, id: "of:scoped-instance", scope: "session", path: [] },
          "owner-key",
          runtimeWritePolicyAuthorization,
        );
        expect(
          tx.isRuntimeOwnedStore(
            space,
            "of:scoped-instance",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
      } finally {
        await tx.commit().settled;
      }
    });

    it("takes one handover of the runtime's set, not two", async () => {
      // `Runtime.edit` hands its set to every transaction it makes, so a
      // second handover would swap the set a transaction already answers
      // from.
      const tx = runtime.edit() as ExtendedStorageTransaction;
      try {
        expect(() => tx.configureRuntimeOwnedStores(new RuntimeOwnedStores()))
          .toThrow("already configured");
      } finally {
        await tx.commit().settled;
      }
    });
  });

  describe("the marking of a store no schema declares a policy on", () => {
    // The §8.12.4 writer-fit measurement quantifies over the paths a schema
    // could have declared a policy at. Two id classes it reads off the id;
    // this is the answer for a document whose id says nothing, which the
    // runtime names as it writes it. The marker lasts for the transaction
    // that recorded it, with no enrollment beside it, because the
    // measurement only ever runs over documents that transaction wrote.

    const mark = (
      tx: ReturnType<Runtime["edit"]>,
      id: string,
      { authorized = true, path = [] as readonly string[] } = {},
    ) =>
      tx.recordCfcWritePolicyInput({
        kind: "structural-provenance",
        target: { space, id, scope: "space", path: [...path] },
        claim: CFC_STRUCTURAL_PROVENANCE_UNDECLARABLE_STORE,
        sources: [],
      }, authorized ? runtimeWritePolicyAuthorization : undefined);

    it("answers for a document this transaction marked", async () => {
      const tx = runtime.edit();
      try {
        expect(
          tx.isUndeclarablePolicyStore(
            space,
            "of:marked",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(false);
        mark(tx, "of:marked");
        expect(
          tx.isUndeclarablePolicyStore(
            space,
            "of:marked",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
        // The marker names a document, not the transaction.
        expect(
          tx.isUndeclarablePolicyStore(
            space,
            "of:not-marked",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(false);
      } finally {
        await tx.commit().settled;
      }
    });

    it("answers `false` to a caller without the runtime's mark", async () => {
      const tx = runtime.edit();
      try {
        mark(tx, "of:unmarked-reader");
        expect(tx.isUndeclarablePolicyStore(space, "of:unmarked-reader"))
          .toBe(false);
        expect(
          tx.isUndeclarablePolicyStore(
            space,
            "of:unmarked-reader",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
      } finally {
        await tx.commit().settled;
      }
    });

    it("counts a marker recorded without the runtime's mark for nothing", async () => {
      // The gate ACTS on this claim, and the recording method is public, so
      // an input's own fields say only what its recorder wrote.
      const tx = runtime.edit();
      try {
        mark(tx, "of:forged", { authorized: false });
        expect(
          tx.isUndeclarablePolicyStore(
            space,
            "of:forged",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(false);
      } finally {
        await tx.commit().settled;
      }
    });

    it("counts a marker naming a path inside the document for nothing", async () => {
      // Whether a schema could have declared a policy is a question about the
      // document, so the marker answers for the whole of one.
      const tx = runtime.edit();
      try {
        mark(tx, "of:partly-marked", { path: ["delegatedModuleIdentities"] });
        expect(
          tx.isUndeclarablePolicyStore(
            space,
            "of:partly-marked",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(false);
      } finally {
        await tx.commit().settled;
      }
    });

    it("is answered through a wrapper as through what it wraps", async () => {
      const tx = runtime.edit();
      const wrapper = createNonReactiveTransaction(tx);
      try {
        mark(tx, "of:marked-through-a-wrapper");
        expect(
          wrapper.isUndeclarablePolicyStore(
            space,
            "of:marked-through-a-wrapper",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
        expect(
          wrapper.isUndeclarablePolicyStore(
            space,
            "of:marked-through-a-wrapper",
          ),
        ).toBe(false);
      } finally {
        await tx.commit().settled;
      }
    });

    it("does not answer for a store a previous transaction marked", async () => {
      // The other half of "no enrollment beside it": a marker dies with its
      // transaction, and nothing carries it forward.
      const first = runtime.edit();
      mark(first, "of:marked-earlier");
      await first.commit().settled;

      const later = runtime.edit();
      try {
        expect(
          later.isUndeclarablePolicyStore(
            space,
            "of:marked-earlier",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(false);
      } finally {
        await later.commit().settled;
      }
    });
  });

  it("reports a committed seq through the sample wrapper", async () => {
    // `Cell.sample()` and `Cell.sink()` hand out this wrapper, and the
    // accessor is optional on the interface, so a wrapper that dropped it
    // would compile and answer undefined for a commit the wrapped
    // transaction knows the seq of.

    const tx = runtime.edit();
    runtime.getCell(space, "wrapped committed seq", undefined, tx).set({
      title: "after",
    });
    const wrapper = createNonReactiveTransaction(tx);
    expect(wrapper.committedSeq?.(space)).toBeUndefined();

    await tx.commit().settled;

    const seq = tx.committedSeq?.(space);
    expect(seq).toBeGreaterThan(0);
    expect(wrapper.committedSeq?.(space)).toBe(seq);
  });
});
