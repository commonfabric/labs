import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  ExtendedStorageTransaction,
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../../src/storage/extended-storage-transaction.ts";
import { Runtime } from "../../src/runtime.ts";

const signer = await Identity.fromPassphrase("prepared-digest-test");
const address = (id: string) => ({
  space: signer.did(),
  scope: "space" as const,
  id: `of:${id}` as const,
  path: [],
});

describe("prepared digest transaction binding", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
    });
  });
  afterEach(async () => {
    await runtime.dispose();
  });

  it("does not report a write when the storage operation rejects it", () => {
    const operations = [
      (tx: ExtendedStorageTransaction) =>
        tx.write(address("rejected"), 1).error,
      (tx: ExtendedStorageTransaction) =>
        tx.writeValueOrThrow(address("rejected"), 1),
      (tx: ExtendedStorageTransaction) =>
        tx.writeValuesOrThrow([{ address: address("rejected"), value: 1 }]),
      (tx: ExtendedStorageTransaction) =>
        tx.recordSqliteWrite(signer.did(), {
          op: "sqlite",
          db: { id: "of:test", tables: {} },
          sql: "CREATE TABLE notes (body TEXT)",
          params: [],
        }),
      (tx: ExtendedStorageTransaction) =>
        tx.recordMergeableOp(address("rejected"), { op: "increment", by: 1 }),
    ];
    for (const operation of operations) {
      const outcomes: string[] = [];
      const underlying = runtime.edit() as ExtendedStorageTransaction;
      const tx = new ExtendedStorageTransaction(underlying.tx, {
        onPreparedDigest: (outcome) => outcomes.push(outcome),
      });
      tx.abort();
      tx.accessForTestingOnly.preparedDigest();
      let error: unknown;
      try {
        error = operation(tx);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(tx.hasWrites()).toBe(false);
      tx.accessForTestingOnly.preparedDigest();
      expect(outcomes).toEqual(["computed", "computed"]);
    }
  });

  it("reports successful writes but leaves an empty batch read-only", () => {
    const tx = runtime.edit() as ExtendedStorageTransaction;
    try {
      tx.writeValuesOrThrow([]);
      expect(tx.hasWrites()).toBe(false);
      tx.writeValuesOrThrow([{ address: address("output"), value: 1 }]);
      expect(tx.hasWrites()).toBe(true);
    } finally {
      tx.abort();
    }
  });

  it("reuses the prepared digest at commit with no intervening activity", async () => {
    const outcomes: string[] = [];
    const underlying = runtime.edit() as ExtendedStorageTransaction;
    const tx = new ExtendedStorageTransaction(underlying.tx, {
      onPreparedDigest: (outcome) => outcomes.push(outcome),
    });
    tx.writeValueOrThrow(address("output"), 1);
    expect(tx.prepareCfc()).not.toBe("");
    expect(outcomes).toEqual(["computed"]);
    expect((await tx.commit()).error).toBeUndefined();
    expect(outcomes).toEqual(["computed", "memo"]);
  });

  it("recomputes after a repeated trace while preserving the prepared token", async () => {
    const outcomes: string[] = [];
    const underlying = runtime.edit() as ExtendedStorageTransaction;
    const tx = new ExtendedStorageTransaction(underlying.tx, {
      onPreparedDigest: (outcome) => outcomes.push(outcome),
    });
    const trace = {
      source: address("a"),
      target: address("b"),
      kind: "value" as const,
    };
    tx.recordCfcDereferenceTrace(trace);
    expect(tx.prepareCfc()).not.toBe("");
    tx.recordCfcDereferenceTrace({ ...trace });
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    expect((await tx.commit()).error).toBeUndefined();
    expect(outcomes).toEqual(["computed", "computed"]);
  });

  it("binds the same activity independently of policy and trace insertion order", () => {
    const digest = (reverse: boolean, value = "same") => {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      try {
        tx.writeValueOrThrow(address("output"), value);
        tx.readValueOrThrow(address("output"));
        const ids = reverse ? ["b", "a"] : ["a", "b"];
        for (const id of ids) {
          tx.recordCfcWritePolicyInput({
            kind: "custom",
            target: address(id),
            name: "p",
            value,
          });
          tx.recordCfcDereferenceTrace({
            source: address(id),
            target: address("c"),
            kind: "value",
          });
        }
        return tx.accessForTestingOnly.preparedDigest();
      } finally {
        tx.abort();
      }
    };
    expect(digest(false)).toBe(digest(true));
    expect(digest(false)).not.toBe(digest(true, "different"));
  });

  it("retires the memo for writes and policy records before preparation", () => {
    const tx = runtime.edit() as ExtendedStorageTransaction;
    try {
      const access = tx.accessForTestingOnly;
      const empty = access.preparedDigest();
      tx.writeValueOrThrow(address("output"), "one");
      const written = access.preparedDigest();
      expect(written).not.toBe(empty);
      tx.recordCfcWritePolicyInput({ kind: "custom", name: "p", value: "two" });
      expect(access.preparedDigest()).not.toBe(written);
    } finally {
      tx.abort();
    }
  });

  it("rejects a prepared transaction after a batched write", async () => {
    const tx = runtime.edit() as ExtendedStorageTransaction;
    tx.writeValueOrThrow(address("output"), "one");
    tx.markCfcRelevant("test");
    expect(tx.prepareCfc()).not.toBe("");
    tx.writeValuesOrThrow([{ address: address("output"), value: "two" }]);
    expect((await tx.commit()).error).toBeDefined();
  });

  it("holds trust and implementation snapshots immutable", () => {
    const tx = runtime.edit() as ExtendedStorageTransaction;
    try {
      const trust = { id: "trust", revision: "1" };
      const identity = { kind: "verified" as const, bindingPath: ["one"] };
      setCfcTrustSnapshot(tx, trust);
      setCfcImplementationIdentity(tx, identity);
      const digest = tx.accessForTestingOnly.preparedDigest();
      expect(() => {
        trust.revision = "2";
      }).toThrow(TypeError);
      expect(() => {
        identity.bindingPath.push("two");
      }).toThrow(TypeError);
      expect(tx.accessForTestingOnly.preparedDigest()).toBe(digest);
      setCfcTrustSnapshot(tx, { id: "trust", revision: "2" });
      expect(tx.accessForTestingOnly.preparedDigest()).not.toBe(digest);
    } finally {
      tx.abort();
    }
  });
});
