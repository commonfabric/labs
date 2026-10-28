import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { hashOf, isDeepFrozen } from "@commonfabric/data-model";
import { getFrozenObjectHashCacheHitsForTestingOnly } from "@commonfabric/data-model/for-testing-only";
import { Identity } from "@commonfabric/identity";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { getTimingStatsBreakdown } from "@commonfabric/utils/logger";

import { preparedDigestFor } from "../../src/cfc/canonical.ts";
import {
  addCfcDenialListener,
  type CfcDenialCode,
} from "../../src/cfc/denial-report.ts";
import {
  isVerdictReason,
  verdictReason,
} from "../../src/cfc/verdict-reason.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { SEED_ENVELOPE_SCHEMA_HASH } from "../cfc-seed-envelope.ts";
import {
  ExtendedStorageTransaction,
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../../src/storage/extended-storage-transaction.ts";
import {
  ignoreReadForScheduling,
  markReadAsAttemptedWrite,
} from "../../src/storage/reactivity-log.ts";
import { Runtime } from "../../src/runtime.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import { runtimeWritePolicyAuthorization } from "../../src/cfc/types.ts";

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

  /** A relevant transaction that wrote `value` and prepared successfully. */
  const prepared = (value: number) => {
    const tx = runtime.edit() as ExtendedStorageTransaction;
    tx.writeValueOrThrow(address("output"), value);
    tx.markCfcRelevant("test");
    expect(tx.prepareCfc()).not.toBe("");
    return tx;
  };

  /** Runs `run`, and returns the code of each CFC denial reported meanwhile. */
  const denialsDuring = async (
    run: () => unknown,
  ): Promise<CfcDenialCode[]> => {
    const codes: CfcDenialCode[] = [];
    const stop = addCfcDenialListener((denial) => codes.push(denial.code));
    try {
      await run();
    } finally {
      stop();
    }
    return codes;
  };

  /** Writes a label map to `of:output` from outside the runtime's own code. */
  const writeLabelMapUnprivileged = (tx: ExtendedStorageTransaction) =>
    tx.writeOrThrow({
      space: signer.did(),
      id: "of:output",
      type: "application/json",
      path: ["cfc"],
    }, {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries: [] },
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
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(outcomes).toEqual(["computed", "memo"]);
  });

  describe("hashing on demand", () => {
    // A relevant transaction under an enforcing mode, over a bare storage
    // transaction, with the hook that reports "computed" for each digest
    // hashed and "memo" for a recheck that hashed none.
    const relevantTx = () => {
      const outcomes: string[] = [];
      const underlying = runtime.edit() as ExtendedStorageTransaction;
      const tx = new ExtendedStorageTransaction(underlying.tx, {
        onPreparedDigest: (outcome) => outcomes.push(outcome),
      });
      tx.setCfcEnforcementMode("enforce-strict");
      tx.writeValueOrThrow(address("output"), "one");
      tx.markCfcRelevant("test");
      return { tx, outcomes };
    };

    it("hashes nothing when the commit carries the activity it prepared over", async () => {
      const { tx, outcomes } = relevantTx();
      tx.prepareForCommit();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      expect(outcomes).toEqual([]);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(outcomes).toEqual(["memo"]);
    });

    it("hashes nothing when commit() is what prepares", async () => {
      const { tx, outcomes } = relevantTx();
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(outcomes).toEqual(["memo"]);
    });

    it("hashes nothing when the preparation was cooperative", async () => {
      const { tx, outcomes } = relevantTx();
      await tx.prepareForCommitCooperatively(new AbortController().signal);
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      expect(outcomes).toEqual([]);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(outcomes).toEqual(["memo"]);
    });

    it("hashes both snapshots and accepts when a repeated dereference moved the epoch", async () => {
      const { tx, outcomes } = relevantTx();
      const trace = {
        source: address("a"),
        target: address("b"),
        kind: "value" as const,
      };
      tx.recordCfcDereferenceTrace(trace);
      tx.prepareForCommit();
      // The digest binds the set of dereferences, so performing one again
      // advances the activity and leaves the digest where it was.
      tx.recordCfcDereferenceTrace({ ...trace });
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      expect(outcomes).toEqual([]);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(outcomes).toEqual(["computed", "computed"]);
    });

    it("hashes no digest for a labeled write committed through the runtime", async () => {
      // The count of `preparedDigestFor()` calls is the logger's, which the
      // transaction does not report itself. The preparation stages the
      // field's label map, so the sealed snapshot holds a write to the
      // document's `cfc` member.
      const digestsHashed = () =>
        getTimingStatsBreakdown()["cfc"]?.["preparedDigestFor"]?.count ?? 0;
      const schema = {
        type: "object",
        properties: {
          secret: { type: "string", ifc: { confidentiality: ["secret"] } },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      runtime.getCell(signer.did(), "labeled", schema, tx).set({
        secret: "s",
      });
      const before = digestsHashed();
      runtime.prepareTxForCommit(tx);
      const prepare = tx.getCfcState().prepare;
      if (prepare.status !== "prepared") throw new Error("not prepared");
      expect(
        prepare.input.writes.some((write) => write.metaPath?.[0] === "cfc"),
      ).toBe(true);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(digestsHashed() - before).toBe(0);
      expect(prepare.digest).toBe(preparedDigestFor(prepare.input));
      // One for the read of `digest`, one for the line above.
      expect(digestsHashed() - before).toBe(2);
    });

    it("hashes both snapshots and rejects when the activity moved after preparing", async () => {
      const { tx, outcomes } = relevantTx();
      tx.prepareForCommit();
      // Setting the module delegations advances the activity without
      // invalidating the preparation, and the digest binds them, so the
      // commit's recheck is what refuses it. A `Runtime` sets them when it
      // creates a transaction; this one is built over a bare storage
      // transaction, so the setting after the preparation is its first.
      tx.setCfcModuleDelegations(
        new Map([[signer.did(), new Map([["module-a", ["module-b"]]])]]),
      );
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      expect(outcomes).toEqual([]);
      const { error } = await tx.commit().settled;
      expect(error?.name).toBe("StorageTransactionAborted");
      expect((error as { reason?: Error }).reason?.message).toBe(
        "cfc-prepared-digest-mismatch",
      );
      expect(outcomes).toEqual(["computed", "computed"]);
    });

    it("reads back the digest of the snapshot it sealed, hashing once", () => {
      const { tx, outcomes } = relevantTx();
      try {
        tx.prepareForCommit();
        const prepare = tx.getCfcState().prepare;
        if (prepare.status !== "prepared") throw new Error("not prepared");
        const expected = preparedDigestFor(prepare.input);
        expect(prepare.digest).toBe(expected);
        expect(prepare.digest).toBe(expected);
        expect(tx.accessForTestingOnly.preparedDigest()).toBe(expected);
        expect(outcomes).toEqual(["computed", "memo"]);
      } finally {
        tx.abort();
      }
    });

    it("returns the digest from prepareCfc(), hashing once", async () => {
      const { tx, outcomes } = relevantTx();
      const digest = tx.prepareCfc();
      const prepare = tx.getCfcState().prepare;
      if (prepare.status !== "prepared") throw new Error("not prepared");
      expect(digest).toBe(preparedDigestFor(prepare.input));
      expect(prepare.digest).toBe(digest);
      expect(outcomes).toEqual(["computed"]);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(outcomes).toEqual(["computed", "memo"]);
    });

    it("keeps the sealed snapshot's digest on an invalidated preparation", () => {
      const { tx, outcomes } = relevantTx();
      try {
        tx.prepareForCommit();
        const prepared = tx.getCfcState().prepare;
        if (prepared.status !== "prepared") throw new Error("not prepared");
        const expected = preparedDigestFor(prepared.input);
        tx.writeValueOrThrow(address("output"), "two");
        const invalidated = tx.getCfcState().prepare;
        expect(invalidated.status).toBe("invalidated");
        // Invalidating reads no digest.
        expect(outcomes).toEqual([]);
        // The digest is of the activity that was prepared, which the write
        // after it is no part of.
        expect((invalidated as { digest?: string }).digest).toBe(expected);
        expect(tx.accessForTestingOnly.preparedDigest()).not.toBe(expected);
      } finally {
        tx.abort();
      }
    });

    it("has no digest on an invalidation of a preparation that never ran", () => {
      const { tx } = relevantTx();
      try {
        tx.invalidateCfc("never prepared");
        const state = tx.getCfcState().prepare;
        expect(state.status).toBe("invalidated");
        expect((state as { digest?: string }).digest).toBeUndefined();
      } finally {
        tx.abort();
      }
    });

    it("drops an earlier preparation's digest once a later one is refused", () => {
      const underlying = runtime.edit() as ExtendedStorageTransaction;
      const tx = new ExtendedStorageTransaction(underlying.tx);
      try {
        tx.writeValueOrThrow(address("output"), "one");
        expect(tx.prepareCfc()).not.toBe("");
        // A write to a document's label map from outside the runtime's own
        // persistence invalidates the preparation, and the gate refuses it
        // once enforcement is on.
        writeLabelMapUnprivileged(tx);
        const invalidated = tx.getCfcState().prepare;
        expect(invalidated.status).toBe("invalidated");
        expect((invalidated as { digest?: string }).digest).toBeDefined();
        tx.setCfcEnforcementMode("enforce-explicit");
        expect(tx.prepareCfc()).toBe("");
        const refused = tx.getCfcState().prepare;
        if (refused.status !== "invalidated") throw new Error("not refused");
        expect(refused.reasons.join("\n")).toContain(
          "unprivileged write to protected runtime surface",
        );
        expect(refused.digest).toBeUndefined();
        tx.invalidateCfc("after the refusal");
        const later = tx.getCfcState().prepare;
        expect(later.status).toBe("invalidated");
        expect((later as { digest?: string }).digest).toBeUndefined();
      } finally {
        tx.abort();
      }
    });

    it("throws from the preparation for a read whose meta cannot be hashed", async () => {
      // No digest is read here, so nothing but the snapshot itself stands
      // between a value hashing refuses and a commit that never compares one.
      const { tx, outcomes } = relevantTx();
      tx.readValueOrThrow(address("input"), {
        meta: { at: new Date(0) } as never,
      });
      expect(() => tx.prepareForCommit()).toThrow("Cannot hash value");
      expect(tx.getCfcState().prepare.status).not.toBe("prepared");
      expect(outcomes).toEqual([]);
      await expect(tx.commit().settled).rejects.toThrow("Cannot hash value");
    });

    it("holds the sealed snapshot immutable", () => {
      // The digest is hashed from the snapshot after the preparation, so
      // nothing reachable from it may change in between: neither a record
      // nor what a record shares with the journal, a read's `meta` here.
      const { tx } = relevantTx();
      try {
        const meta = { note: { nested: ["a"] } };
        tx.readValueOrThrow(address("input"), { meta });
        tx.readValueOrThrow(address("attempted"), {
          meta: markReadAsAttemptedWrite,
        });
        tx.recordCfcDereferenceTrace({
          source: address("input"),
          target: address("output"),
          kind: "value",
        });
        tx.recordCfcWritePolicyInput({ kind: "custom", name: "p", value: 1 });
        tx.setCfcModuleDelegations(
          new Map([[signer.did(), new Map([["module:a", ["module:b"]]])]]),
        );
        tx.prepareForCommit();
        const prepare = tx.getCfcState().prepare;
        if (prepare.status !== "prepared") throw new Error("not prepared");
        const { input } = prepare;
        expect(input.consumedReads.length).toBeGreaterThan(0);
        expect(input.writes.length).toBeGreaterThan(0);
        expect(input.attemptedWrites.length).toBeGreaterThan(0);
        expect(input.writeAttemptLog.length).toBeGreaterThan(0);
        expect(input.moduleDelegations?.length).toBe(1);
        expect(isDeepFrozen(input)).toBe(true);
        expect(Object.isFrozen(meta.note.nested)).toBe(true);
      } finally {
        tx.abort();
      }
    });

    it("freezes a read's marker-only `meta` without hashing it, and hashes one with a string key", () => {
      // The hash reads no symbol-keyed property, so a `meta` of read markers
      // alone hashes as the empty record and has nothing for the hash to
      // refuse. Hashing a `meta` caches its hash by identity, so hashing it
      // again afterwards is served from that cache only when the snapshot
      // hashed it.
      const { tx } = relevantTx();
      try {
        const markers = { ...ignoreReadForScheduling };
        const keyed = { note: "keyed" };
        tx.readValueOrThrow(address("markers"), { meta: markers });
        tx.readValueOrThrow(address("keyed"), { meta: keyed });
        tx.prepareForCommit();
        expect(tx.getCfcState().prepare.status).toBe("prepared");
        expect(Object.isFrozen(markers)).toBe(true);
        const servedBeforeMarkers =
          getFrozenObjectHashCacheHitsForTestingOnly();
        hashOf(markers);
        expect(getFrozenObjectHashCacheHitsForTestingOnly()).toBe(
          servedBeforeMarkers,
        );
        const servedBeforeKeyed = getFrozenObjectHashCacheHitsForTestingOnly();
        hashOf(keyed);
        expect(getFrozenObjectHashCacheHitsForTestingOnly()).toBe(
          servedBeforeKeyed + 1,
        );
      } finally {
        tx.abort();
      }
    });
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
    expect((await tx.commit().settled).error).toBeUndefined();
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

  it("binds each whole-value root and the identity that recorded it", () => {
    // A recorded root decides where prepare stamps the writer's flow label
    // (`assertedValueRootPaths`), so two transactions that differ only in
    // their roots must not share a digest, nor one whose root was recorded
    // under a different identity.
    const writer = (symbol: string) => ({
      kind: "verified" as const,
      moduleIdentity: "module:digest",
      symbol,
      bindingPath: [symbol],
    });
    const digest = (roots: readonly { path: string[]; by: string }[]) => {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      try {
        tx.writeValueOrThrow({ ...address("output"), path: ["a", "b"] }, 1);
        for (const root of roots) {
          setCfcImplementationIdentity(tx, writer(root.by));
          tx.recordCfcAssertedValueRoot(
            { ...address("output"), path: root.path },
            runtimeWritePolicyAuthorization,
          );
        }
        setCfcImplementationIdentity(tx, writer("commit"));
        return tx.accessForTestingOnly.preparedDigest();
      } finally {
        tx.abort();
      }
    };
    const none = digest([]);
    const atA = digest([{ path: ["a"], by: "commit" }]);
    expect(atA).not.toBe(none);
    expect(digest([{ path: [], by: "commit" }])).not.toBe(atA);
    expect(digest([{ path: ["a"], by: "other" }])).not.toBe(atA);
    expect(digest([{ path: ["a"], by: "commit" }])).toBe(atA);
    // The roots are a set: recording order is not digest content.
    const two = digest([
      { path: ["a"], by: "commit" },
      { path: [], by: "commit" },
    ]);
    expect(
      digest([{ path: [], by: "commit" }, { path: ["a"], by: "commit" }]),
    ).toBe(two);
    expect(two).not.toBe(atA);
    // Paths that differ only in a leading `value` are distinct roots.
    const shallow = digest([{ path: ["value", "a"], by: "commit" }]);
    const deep = digest([{ path: ["value", "value", "a"], by: "commit" }]);
    const both = digest([
      { path: ["value", "a"], by: "commit" },
      { path: ["value", "value", "a"], by: "commit" },
    ]);
    expect(both).not.toBe(shallow);
    expect(both).not.toBe(deep);
    // Recorded twice, a root stamps once, and the digest says the same.
    expect(
      digest([{ path: ["a"], by: "commit" }, { path: ["a"], by: "commit" }]),
    ).toBe(atA);
  });

  it("retires the memo when a whole-value root or structure container is recorded", () => {
    // Both decide where preparation stamps the flow label, so recording one
    // after a digest was taken must not leave the memoized digest standing.
    const recorders = [
      (tx: ExtendedStorageTransaction) =>
        tx.recordCfcAssertedValueRoot(
          { ...address("output"), path: ["a"] },
          runtimeWritePolicyAuthorization,
        ),
      (tx: ExtendedStorageTransaction) =>
        tx.recordCfcStructureContainer({ ...address("output"), path: ["a"] }),
    ];
    for (const record of recorders) {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      try {
        tx.writeValueOrThrow({ ...address("output"), path: ["a", "b"] }, 1);
        const before = tx.accessForTestingOnly.preparedDigest();
        record(tx);
        expect(tx.accessForTestingOnly.preparedDigest()).not.toBe(before);
      } finally {
        tx.abort();
      }
    }
  });

  it("binds structure containers whose paths differ only in a leading value", () => {
    // `["value", "x"]` and `["value", "value", "x"]` are distinct paths once
    // canonicalized (`["x"]` and `["value", "x"]`), so both containers are
    // digest content, and the pair differs from either alone.
    const digest = (paths: string[][]) => {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      try {
        tx.writeValueOrThrow({ ...address("output"), path: ["x"] }, 1);
        for (const path of paths) {
          tx.recordCfcStructureContainer({ ...address("output"), path });
        }
        return tx.accessForTestingOnly.preparedDigest();
      } finally {
        tx.abort();
      }
    };
    const shallow = digest([["value", "x"]]);
    const deep = digest([["value", "value", "x"]]);
    const both = digest([["value", "x"], ["value", "value", "x"]]);
    expect(deep).not.toBe(shallow);
    expect(both).not.toBe(shallow);
    expect(both).not.toBe(deep);
    expect(digest([["value", "value", "x"], ["value", "x"]])).toBe(both);
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
    expect((await tx.commit().settled).error).toBeDefined();
  });

  describe("a write after a preparation", () => {
    // Each case but the first writes once more after the preparation,
    // through a path that leaves nothing in the prepared digest's input: the
    // storage layer elides a write of the value already there and a delete
    // that finds nothing, and holds a SQLite write and a mergeable op outside
    // the journal. Comparing digests at commit cannot refuse any of them, so
    // each has to invalidate the preparation where it happens.

    const expectInvalidated = async (
      tx: ExtendedStorageTransaction,
      reason: string,
    ) => {
      const state = tx.getCfcState().prepare;
      expect(state.status).toBe("invalidated");
      expect(state.status === "invalidated" && state.reasons).toEqual([reason]);
      let error: Error | undefined;
      const denials = await denialsDuring(async () => {
        ({ error } = await tx.commit().settled);
      });
      expect(error?.name).toBe("StorageTransactionAborted");
      // The reason the invalidation refuses under, where a commit refused by
      // the digest recheck carries `cfc-prepared-digest-mismatch`.
      expect((error as { reason?: Error }).reason?.message).toBe(
        "cfc-refusal-not-a-verdict",
      );
      // No policy check refused the commit; the preparation was sound when
      // it was made.
      expect(denials).toEqual(["write-prepare-invalidated"]);
    };

    it("leaves the transaction prepared, and commits it, after an empty batch", async () => {
      const tx = prepared(1);
      tx.writeValuesOrThrow([]);
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      expect((await tx.commit().settled).error).toBeUndefined();
    });

    it("invalidates the preparation and fails the commit after a batched write of the value already written", async () => {
      const tx = prepared(1);
      tx.writeValuesOrThrow([{ address: address("output"), value: 1 }]);
      await expectInvalidated(tx, "write-after-prepare");
    });

    it("invalidates the preparation and fails the commit after a batched delete of an absent document", async () => {
      const tx = prepared(1);
      tx.writeValuesOrThrow([
        { address: address("absent"), value: undefined, delete: true },
      ]);
      await expectInvalidated(tx, "write-after-prepare");
    });

    it("invalidates the preparation and fails the commit after a single write of the value already written", async () => {
      const tx = prepared(1);
      tx.writeValueOrThrow(address("output"), 1);
      await expectInvalidated(tx, "write-after-prepare");
    });

    it("invalidates the preparation and fails the commit after a recorded SQLite write, and stores no row", async () => {
      const db: SqliteDbRef = {
        id: `of:prepared-digest-${crypto.randomUUID()}`,
        tables: { notes: table({ id: "integer primary key", body: "text" }) },
      };
      const tx = prepared(1);
      tx.recordSqliteWrite(signer.did(), {
        op: "sqlite",
        db,
        sql: "INSERT INTO notes (body) VALUES (?)",
        params: ["after"],
      });
      await expectInvalidated(tx, "sqlite-write-after-prepare");
      const stored = await storage.open(signer.did()).sqliteQuery!(
        db,
        "SELECT body FROM notes",
      );
      expect(stored.rows).toEqual([]);
    });

    it("invalidates the preparation and fails the commit after a recorded mergeable op, and stores no value", async () => {
      const tx = prepared(5);
      tx.recordMergeableOp(address("output"), { op: "increment", by: 2 });
      await expectInvalidated(tx, "mergeable-op-after-prepare");
      const after = runtime.edit() as ExtendedStorageTransaction;
      try {
        expect(after.readValueOrThrow(address("output"))).toBeUndefined();
      } finally {
        after.abort();
      }
    });
  });

  describe("the denial a refused commit reports", () => {
    it("reports `write-prepare-invalidated` for a read after a successful preparation", async () => {
      const tx = prepared(1);
      tx.readValueOrThrow(address("input"));
      const denials = await denialsDuring(() => tx.commit().settled);
      expect(denials).toEqual(["write-prepare-invalidated"]);
    });

    it("reports `write-policy-gate` once, from the preparation, for a verdict the preparation records", async () => {
      const underlying = runtime.edit() as ExtendedStorageTransaction;
      const tx = new ExtendedStorageTransaction(underlying.tx);
      tx.writeValueOrThrow(address("output"), "one");
      writeLabelMapUnprivileged(tx);
      tx.setCfcEnforcementMode("enforce-explicit");
      const atPreparation = await denialsDuring(() => {
        expect(tx.prepareCfc()).toBe("");
      });
      expect(atPreparation).toEqual(["write-policy-gate"]);
      let error: Error | undefined;
      const atCommit = await denialsDuring(async () => {
        ({ error } = await tx.commit().settled);
      });
      expect(error?.name).toBe("CfcCommitRefusalError");
      expect(atCommit).toEqual([]);
    });

    it("reports `write-policy-gate` at commit for a refused preparation that a later invalidation adds a reason to", async () => {
      // Under `observe` the refused preparation reports nothing, so the
      // commit, once enforcement is raised, is the first to report it, with
      // the preparation's verdict and the invalidation's reason both on it.

      const underlying = runtime.edit() as ExtendedStorageTransaction;
      const tx = new ExtendedStorageTransaction(underlying.tx);
      tx.writeValueOrThrow(address("output"), "one");
      writeLabelMapUnprivileged(tx);
      tx.setCfcEnforcementMode("observe");
      const atPreparation = await denialsDuring(() => {
        expect(tx.prepareCfc()).toBe("");
      });
      expect(atPreparation).toEqual([]);
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.invalidateCfc("after the refusal");
      const state = tx.getCfcState().prepare;
      expect(state.status === "invalidated" && state.reasons.length).toBe(2);
      let error: Error | undefined;
      const atCommit = await denialsDuring(async () => {
        ({ error } = await tx.commit().settled);
      });
      expect(error?.name).toBe("StorageTransactionAborted");
      expect(atCommit).toEqual(["write-policy-gate"]);
    });

    it("reports `write-policy-gate` at commit for a refused preparation none of whose reasons is a verdict", async () => {
      // The seeded document carries a stored label, so a write to it with no
      // schema leaves the preparation without the write-policy input it
      // needs, which it records untagged.

      const schema = {
        type: "object",
        properties: {
          secret: { type: "string", ifc: { confidentiality: ["secret"] } },
        },
      } as const satisfies JSONSchema;
      const seed = runtime.edit();
      const cell = runtime.getCell(signer.did(), "labeled", schema, seed);
      cell.set({ secret: "s" });
      runtime.prepareTxForCommit(seed);
      expect((await seed.commit().settled).error).toBeUndefined();
      const underlying = runtime.edit() as ExtendedStorageTransaction;
      const tx = new ExtendedStorageTransaction(underlying.tx);
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: cell.getAsNormalizedFullLink().id,
        path: ["secret"],
      }, "t");
      tx.setCfcEnforcementMode("observe");
      expect(tx.prepareCfc()).toBe("");
      const state = tx.getCfcState().prepare;
      expect(state.status === "invalidated" && state.reasons).toEqual([
        expect.stringContaining("missing schema write-policy input"),
      ]);
      tx.setCfcEnforcementMode("enforce-explicit");
      const denials = await denialsDuring(() => tx.commit().settled);
      expect(denials).toEqual(["write-policy-gate"]);
    });

    it("reports `write-prepare-invalidated` for an invalidation reason tagged as a verdict after a successful preparation", async () => {
      // `invalidateCfc()` removes a caller's tag where it records the reason,
      // so the tag cannot make the denial a policy refusal.

      const tx = prepared(1);
      tx.invalidateCfc(verdictReason("a verdict recorded after preparing"));
      const denials = await denialsDuring(() => tx.commit().settled);
      expect(denials).toEqual(["write-prepare-invalidated"]);
    });

    it("reports `write-unprepared` for a commit whose only reasons a caller recorded before any preparation", async () => {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      tx.writeValueOrThrow(address("output"), 1);
      tx.markCfcRelevant("test");
      tx.invalidateCfc("never prepared");
      let error: Error | undefined;
      const denials = await denialsDuring(async () => {
        ({ error } = await tx.commit().settled);
      });
      expect(error?.message).toContain("never prepared");
      expect(denials).toEqual(["write-unprepared"]);
    });
  });

  describe("invalidateCfc()", () => {
    it("records a caller's reason without its verdict tags", () => {
      const tx = prepared(1);
      try {
        tx.invalidateCfc(verdictReason(verdictReason("forged")));
        const state = tx.getCfcState().prepare;
        expect(state.status === "invalidated" && state.reasons).toEqual([
          "forged",
        ]);
      } finally {
        tx.abort();
      }
    });

    it("leaves the refused commit of a passed preparation retryable for a reason tagged as a verdict", async () => {
      const tx = prepared(1);
      tx.invalidateCfc(verdictReason("forged"));
      const { error } = await tx.commit().settled;
      expect(error?.name).toBe("StorageTransactionAborted");
      expect((error as { reason?: Error }).reason?.message).toBe(
        "cfc-refusal-not-a-verdict",
      );
    });

    it("keeps the verdict tags of the reasons a refused preparation recorded", () => {
      const underlying = runtime.edit() as ExtendedStorageTransaction;
      const tx = new ExtendedStorageTransaction(underlying.tx);
      try {
        tx.writeValueOrThrow(address("output"), "one");
        writeLabelMapUnprivileged(tx);
        tx.setCfcEnforcementMode("enforce-explicit");
        expect(tx.prepareCfc()).toBe("");
        tx.invalidateCfc(verdictReason("after the refusal"));
        const state = tx.getCfcState().prepare;
        expect(state.status === "invalidated" && state.reasons.length).toBe(2);
        expect(
          state.status === "invalidated" && state.reasons.map(isVerdictReason),
        ).toEqual([true, false]);
      } finally {
        tx.abort();
      }
    });
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
