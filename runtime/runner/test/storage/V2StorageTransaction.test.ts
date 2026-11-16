import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { codeMirrorTextChangesPayload } from "@commonfabric/memory/v2";

import type { CellScope } from "../../src/builder/types.ts";
import {
  type EmulatedStorageManager,
  StorageManager,
} from "../../src/storage/cache.deno.ts";
import type {
  IMemorySpaceAddress,
  ITransactionSealSink,
  MemorySpace,
  URI,
} from "../../src/storage/interface.ts";
import { pendingWriteElisionRead } from "../../src/storage/reactivity-log.ts";
import { V2StorageTransaction } from "../../src/storage/v2-transaction.ts";
import { captureLogs } from "../support/log-capture.ts";

const signer = await Identity.fromPassphrase("V2StorageTransaction");
const space = signer.did();
const other = (await Identity.fromPassphrase("V2StorageTransaction other"))
  .did();
const third = (await Identity.fromPassphrase("V2StorageTransaction third"))
  .did();
const type = "application/json" as const;

const at = (
  id: URI,
  path: readonly string[],
  target: MemorySpace = space,
  scope?: CellScope,
): IMemorySpaceAddress => ({
  space: target,
  id,
  type,
  path,
  ...(scope === undefined ? {} : { scope }),
});

/** What `run` throws, or `undefined` where it returns. */
const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("V2StorageTransaction", () => {
  let storage: EmulatedStorageManager;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await storage.close();
  });

  const edit = () => new V2StorageTransaction(storage);

  /** Commits `value` as the value of the document `id` in `target`. */
  const seed = async (
    id: URI,
    value: FabricValue,
    target: MemorySpace = space,
  ) => {
    const tx = edit();
    expect(tx.write(at(id, [], target), { value }).error).toBeUndefined();
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /** Starts a commit of `value` to `id` and leaves it pending. */
  const pendingWrite = (id: URI, value: FabricValue) => {
    const tx = edit();
    expect(tx.write(at(id, []), { value }).error).toBeUndefined();
    const settled = tx.commit().settled;
    expect(storage.open(space).replica.hasPendingWrite(id, "space")).toBe(
      true,
    );
    return settled;
  };

  describe("instance members", () => {
    describe("scopeKeyIdentity", () => {
      const identity = { principal: other, sessionId: "session" };

      it("keeps the identity it holds when set to `undefined`", () => {
        const tx = edit();
        tx.scopeKeyIdentity = identity;
        tx.scopeKeyIdentity = undefined;

        expect(tx.scopeKeyIdentity).toBe(identity);
      });

      it("throws when set after the transaction loaded a document", () => {
        const before = edit();
        before.scopeKeyIdentity = identity;
        expect(before.scopeKeyIdentity).toBe(identity);

        const after = edit();
        after.read(at("of:loaded", ["value"]));
        expect(() => after.scopeKeyIdentity = identity).toThrow(
          "storage transaction already loaded documents under the storage " +
            "manager's own identity",
        );
        expect(after.scopeKeyIdentity).toBeUndefined();
      });
    });

    describe("read()", () => {
      it("settles a failed instance load without reporting it as rejected tracked work", async () => {
        // The failure has its own report on the load's side, so the work the
        // transaction tracks until settled settles quietly.

        const loads: { id: URI; principal?: string }[] = [];
        storage.syncInstance = (address, identity) => {
          loads.push({ id: address.id, principal: identity.principal });
          return Promise.reject(new Error("instance load refused"));
        };
        using logs = captureLogs("storage.v2");
        const tx = edit();
        tx.scopeKeyIdentity = { principal: other, sessionId: "session" };

        const read = tx.read(at("of:unseen", ["value"], space, "user"));
        await storage.synced();

        expect(read.ok?.value).toBeUndefined();
        expect(loads).toEqual([{ id: "of:unseen", principal: other }]);
        expect(logs.lines("tracked-work-rejected")).toEqual([]);
      });
    });

    describe("addCommitPrecondition()", () => {
      const precondition = { kind: "entity-absent", id: "of:pinned" } as const;

      it("throws the error that closed the transaction", () => {
        const tx = edit();
        tx.abort("closed");

        expect(thrownBy(() => tx.addCommitPrecondition(space, precondition)))
          .toMatchObject({ name: "StorageTransactionAborted" });
        expect(tx.getCommitPreconditions(space)).toBeUndefined();
      });

      it("throws for a second space without multi-space writes", () => {
        const tx = edit();
        tx.addCommitPrecondition(space, precondition);

        expect(thrownBy(() => tx.addCommitPrecondition(other, precondition)))
          .toMatchObject({ name: "StorageTransactionWriteIsolationError" });
        expect(tx.getCommitPreconditions(space)).toEqual([precondition]);
        expect(tx.getCommitPreconditions(other)).toBeUndefined();
      });
    });

    describe("markCreateOnly()", () => {
      it("throws the error that closed the transaction", () => {
        const open = edit();
        open.markCreateOnly({ space, id: "of:created" });
        expect(open.getNativeCommit(space)?.preconditions).toEqual([
          { kind: "entity-absent", id: "of:created", scope: "space" },
        ]);

        const closed = edit();
        closed.abort("closed");
        expect(thrownBy(() => closed.markCreateOnly({ space, id: "of:x" })))
          .toMatchObject({ name: "StorageTransactionAborted" });
      });
    });

    describe("recordMergeableOp()", () => {
      it("throws for a document the transaction has not written", () => {
        const tx = edit();
        const list = at("of:list", ["value", "items"]);

        expect(() => tx.recordMergeableOp(list, { op: "append", count: 1 }))
          .toThrow("append target is not writable");

        expect(tx.write(list, ["entry"]).error).toBeUndefined();
        tx.recordMergeableOp(list, { op: "append", count: 1 });
        expect([...tx.getMergeableOpAddresses()]).toEqual([
          { space, id: "of:list", scope: "space", path: ["value", "items"] },
        ]);
      });
    });

    describe("recordSqliteWrite()", () => {
      it("throws for a second space without multi-space writes", () => {
        const tx = edit();
        const op = {
          op: "sqlite",
          db: { id: "of:db", tables: {} },
          sql: "CREATE TABLE notes (body TEXT)",
          params: [],
        } as const;
        tx.recordSqliteWrite(space, op);

        expect(thrownBy(() => tx.recordSqliteWrite(other, op)))
          .toMatchObject({ name: "StorageTransactionWriteIsolationError" });
        expect(tx.getNativeCommit(space)?.sqliteOps).toEqual([op]);
        expect(tx.getNativeCommit(other)).toBeUndefined();
      });
    });

    describe("recordTextChanges()", () => {
      const field = at("of:note", ["value", "text"]);

      beforeEach(async () => {
        await seed("of:note", { text: "abc", count: 1 });
      });

      it("throws the error that closed the transaction", () => {
        const tx = edit();
        tx.abort("closed");

        expect(thrownBy(() => tx.recordTextChanges(field, [{ from: 0 }])))
          .toMatchObject({ name: "StorageTransactionAborted" });
      });

      it("throws for a second space without multi-space writes", () => {
        const tx = edit();
        expect(tx.recordTextChanges(field, [{ from: 3, insert: "d" }]))
          .toBe("abcd");

        expect(
          thrownBy(() =>
            tx.recordTextChanges(at("of:note", ["value", "text"], other), [{
              from: 0,
            }])
          ),
        ).toMatchObject({ name: "StorageTransactionWriteIsolationError" });
      });

      it("throws for a path outside `value`", () => {
        const tx = edit();

        expect(() =>
          tx.recordTextChanges(at("of:note", ["text"]), [{ from: 0 }])
        )
          .toThrow("text changes need a path under `value`");
      });

      it("throws a `TypeError` for a field that does not hold a string", () => {
        const tx = edit();

        const thrown = thrownBy(() =>
          tx.recordTextChanges(at("of:note", ["value", "count"]), [{ from: 0 }])
        );
        expect(thrown).toBeInstanceOf(TypeError);
        expect(thrown).toMatchObject({
          message: expect.stringContaining("text changes need a string"),
        });
      });

      it("returns the text unchanged and leaves no trace for changes that keep it as it was", () => {
        const tx = edit();
        expect(tx.recordTextChanges(field, [{ from: 1, insert: "" }]))
          .toBe("abc");
        expect(tx.recordTextChanges(field, [{ from: 3, insert: "d" }]))
          .toBe("abcd");
        expect(tx.write(field, "abcd").error).toBeUndefined();

        const [edit_, ...rest] = tx.getNativeCommit(space)?.applyOps ?? [];
        expect(rest).toEqual([]);
        expect(edit_.payload).toEqual(
          codeMirrorTextChangesPayload(
            "abc",
            [[{ from: 3, to: 3, insert: "d" }]],
            edit_.submissionId,
          ),
        );
      });
    });

    describe("getNativeCommit()", () => {
      it("returns `undefined` for a space the transaction never touched", () => {
        const tx = edit();
        expect(tx.write(at("of:touched", ["value"]), 1).error)
          .toBeUndefined();

        expect(tx.getNativeCommit(space)?.operations).toHaveLength(1);
        expect(tx.getNativeCommit(other)).toBeUndefined();
      });

      describe("with text changes", () => {
        const field = at("of:note", ["value", "text"]);

        beforeEach(async () => {
          await seed("of:note", { text: "abc" });
        });

        it("throws for a document the transaction also wrote at its root", () => {
          const tx = edit();
          tx.recordTextChanges(field, [{ from: 3, insert: "d" }]);
          expect(tx.write(at("of:note", []), { value: { text: "abcd" } }).error)
            .toBeUndefined();

          expect(() => tx.getNativeCommit(space)).toThrow(
            "text changes cannot ride a whole-document write",
          );
        });

        it("throws for a field written after its text changes", () => {
          const tx = edit();
          tx.recordTextChanges(field, [{ from: 3, insert: "d" }]);
          expect(tx.write(field, "abcd").error).toBeUndefined();
          expect(tx.getNativeCommit(space)?.applyOps).toHaveLength(1);

          expect(tx.write(field, "replaced").error).toBeUndefined();
          expect(() => tx.getNativeCommit(space)).toThrow(
            "was written after its text changes",
          );
        });
      });
    });

    describe("getReadDetails()", () => {
      it("yields nothing for a space the transaction never opened", async () => {
        await seed("of:read", { a: { b: 1 } });
        const tx = edit();
        expect(tx.read(at("of:read", ["value"])).ok?.value).toEqual({
          a: { b: 1 },
        });

        expect([...tx.getReadDetails(space)].length).toBeGreaterThan(0);
        expect([...tx.getReadDetails(other)]).toEqual([]);
      });
    });

    describe("writeBatch()", () => {
      it("stops at a run that fails, leaving the documents after it unwritten", async () => {
        await seed("of:number", { n: 1 });
        const tx = edit();

        const result = tx.writeBatch([
          { address: at("of:number", ["value", "n", "deep"]), value: 2 },
          { address: at("of:later", ["value"]), value: 3 },
        ]);

        expect(result.error).toMatchObject({ name: "TypeMismatchError" });
        expect(tx.read(at("of:later", ["value"])).ok?.value).toBeUndefined();
      });

      it("goes on past a write that leaves the document as it was, retaining the pending basis", async () => {
        // Writing `Infinity` as an array's length is a change the plan cannot
        // see past and the write leaves the array as it was.

        const committed = pendingWrite("of:list", {
          list: [1, 2, 3],
          other: 1,
        });
        const tx = edit();

        expect(
          tx.writeBatch([
            {
              address: at("of:list", ["value", "list", "length"]),
              value: Infinity,
            },
            { address: at("of:list", ["value", "other"]), value: 2 },
          ]).error,
        ).toBeUndefined();

        expect(tx.read(at("of:list", ["value"])).ok?.value).toEqual({
          list: [1, 2, 3],
          other: 2,
        });
        expect(
          [...tx.getWriteDetails(space)].map(({ address }) => address.path),
        )
          .toEqual([["value", "other"]]);
        expect(
          tx.getReadActivities().filter(({ meta }) =>
            meta === pendingWriteElisionRead
          ).map(({ path }) => path),
        ).toEqual([["value", "list", "length"]]);
        expect((await committed).error).toBeUndefined();
      });
    });

    describe("retainPendingWriteElision()", () => {
      it("throws the error that closed the transaction over a pending write", async () => {
        const committed = pendingWrite("of:pending", { a: 1 });
        const open = edit();
        open.retainPendingWriteElision(at("of:pending", ["value", "a"]));
        expect(
          open.getReadActivities().map(({ meta }) =>
            meta === pendingWriteElisionRead
          ),
        ).toEqual([true]);

        const closed = edit();
        closed.abort("closed");
        expect(
          thrownBy(() =>
            closed.retainPendingWriteElision(at("of:pending", ["value", "a"]))
          ),
        ).toMatchObject({ name: "StorageTransactionAborted" });
        expect((await committed).error).toBeUndefined();
      });
    });

    describe("getWriteTargetSpaces()", () => {
      it("returns the explicit order's spaces first, then the rest in first-write order", () => {
        const tx = edit();
        tx.enableMultiSpaceWrites([other]);
        expect(tx.write(at("of:a", ["value"], space), 1).error)
          .toBeUndefined();
        expect(tx.write(at("of:b", ["value"], third), 2).error)
          .toBeUndefined();
        expect(tx.write(at("of:c", ["value"], other), 3).error)
          .toBeUndefined();

        expect(tx.getWriteTargetSpaces()).toEqual([other, space, third]);
        tx.abort("done");
      });
    });

    describe("commit()", () => {
      it("rejects when the space's replica cannot take a native commit", async () => {
        const replica = storage.open(space).replica;
        const commitNative = replica.commitNative;
        replica.commitNative = undefined;
        try {
          const tx = edit();
          expect(tx.write(at("of:doc", ["value"]), 1).error).toBeUndefined();

          await expect(tx.commit().settled).rejects.toThrow(
            "memory v2 replica does not support commitNative()",
          );
        } finally {
          replica.commitNative = commitNative;
        }
      });

      describe("across spaces", () => {
        it("returns a failed validation without committing, keeping the reads", async () => {
          await seed("of:read", { n: 1 });
          const tx = edit();
          tx.enableMultiSpaceWrites();
          expect(tx.read(at("of:read", ["value", "n"])).ok?.value).toBe(1);
          await seed("of:read", { n: 2 });
          expect(tx.write(at("of:a", ["value"]), 1).error).toBeUndefined();
          expect(tx.write(at("of:b", ["value"], other), 2).error)
            .toBeUndefined();

          const result = await tx.commit().settled;

          expect(result.error).toMatchObject({
            name: "StorageTransactionInconsistent",
          });
          expect(tx.getReadActivities().map(({ id }) => id)).toContain(
            "of:read",
          );
          const verify = edit();
          expect(verify.read(at("of:b", ["value"], other)).ok?.value)
            .toBeUndefined();
        });

        it("returns a `StoreError` and logs when a later space's commit throws", async () => {
          storage.open(other).replica.commitNative = () =>
            Promise.reject(new Error("store went away"));
          using logs = captureLogs("storage.v2.multi-space-commit");
          const tx = edit();
          tx.enableMultiSpaceWrites([space, other]);
          expect(tx.write(at("of:a", ["value"]), 1).error).toBeUndefined();
          expect(tx.write(at("of:b", ["value"], other), 2).error)
            .toBeUndefined();

          const result = await tx.commit().settled;

          expect(result.error).toMatchObject({
            name: "StoreError",
            message: expect.stringContaining("store went away"),
          });
          expect(logs.lines("multi-space-commit-rejected")).toHaveLength(1);
          expect(edit().read(at("of:a", ["value"])).ok?.value).toBe(1);
        });
      });
    });

    describe("sealInto()", () => {
      it("returns a `StoreError` and logs when a space's handoff throws", async () => {
        using logs = captureLogs("storage.v2.multi-space-commit");
        const sink: ITransactionSealSink = {
          sealSpaceCommit: () => Promise.reject(new Error("wave closed")),
        };
        const tx = edit();
        expect(tx.write(at("of:a", ["value"]), 1).error).toBeUndefined();

        const result = await tx.sealInto(sink);

        expect(result.error).toMatchObject({
          name: "StoreError",
          message: expect.stringContaining("wave closed"),
        });
        expect(logs.lines("seal-space-commit-rejected")).toHaveLength(1);
        expect(tx.status().status).toBe("error");
      });

      it("returns a `StoreError` when checking a later space again throws", async () => {
        // A replica with a store read-through reads the store as it checks a
        // claim, and that read can fail.

        await seed("of:b", { n: 1 }, other);
        const replica = storage.open(other).replica;
        const getDocument = replica.getDocument;
        const sealed: MemorySpace[] = [];
        const sink: ITransactionSealSink = {
          sealSpaceCommit: (target) => {
            sealed.push(target);
            replica.getDocument = () => {
              throw new Error("store read failed");
            };
            return Promise.resolve({ ok: {} });
          },
        };
        try {
          const tx = edit();
          tx.enableMultiSpaceWrites([space, other]);
          expect(tx.read(at("of:b", ["value", "n"], other)).ok?.value).toBe(1);
          expect(tx.write(at("of:a", ["value"]), 1).error).toBeUndefined();
          expect(tx.write(at("of:b", ["value", "n"], other), 2).error)
            .toBeUndefined();

          const result = await tx.sealInto(sink);

          expect(result.error).toMatchObject({
            name: "StoreError",
            message: expect.stringContaining("store read failed"),
          });
          expect(sealed).toEqual([space]);
        } finally {
          replica.getDocument = getDocument;
        }
      });
    });
  });
});
