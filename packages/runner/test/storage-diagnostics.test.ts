import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { STORAGE_DIAGNOSTICS_LIMIT } from "../src/storage/diagnostics.ts";

const signer = await Identity.fromPassphrase("storage diagnostics");

describe("pending storage diagnostics", () => {
  it("attributes an event disposition to every space its handler writes", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const otherSpace = (await Identity.fromPassphrase("diagnostic destination"))
      .did();
    const stream = runtime.getCell(signer.did(), "diagnostic-event");
    const local = runtime.getCell(signer.did(), "diagnostic-local");
    const remote = runtime.getCell(otherSpace, "diagnostic-remote");
    const release = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    const replica = storage.open(otherSpace).replica;
    const commitNative = replica.commitNative;
    if (!commitNative) throw new Error("fixture needs native commits");
    try {
      replica.commitNative = async (...args) => {
        const result = await commitNative.apply(replica, args);
        accepted.resolve();
        await release.promise;
        return result;
      };
      runtime.scheduler.addEventHandler((tx) => {
        tx.tx.enableMultiSpaceWrites!();
        local.withTx(tx).set(1);
        remote.withTx(tx).set(2);
      }, stream.getAsNormalizedFullLink());
      runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), {});
      await accepted.promise;

      const disposition = storage.getDiagnostics().pendingCommits.find(
        (entry) => entry.kind === "event-disposition",
      );
      expect(disposition).toBeDefined();
      expect(new Set(disposition?.spaces)).toEqual(
        new Set([signer.did(), otherSpace]),
      );
      release.resolve();
      await runtime.scheduler.idleWithPendingCommits();
      expect(storage.getDiagnostics().pendingCommitCount).toBe(0);
    } finally {
      release.resolve();
      await runtime.scheduler.idleWithPendingCommits();
      replica.commitNative = commitNative;
      await runtime.dispose();
      await storage.close();
    }
  });

  it("correlates a pending transaction with its space and server commit without exporting values", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const release = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    const replica = storage.open(signer.did()).replica;
    const commitNative = replica.commitNative;
    if (!commitNative) throw new Error("fixture needs native commits");
    let commit:
      | ReturnType<ReturnType<typeof runtime.edit>["commit"]>
      | undefined;
    try {
      replica.commitNative = async (...args) => {
        const result = await commitNative.apply(replica, args);
        accepted.resolve();
        await release.promise;
        return result;
      };
      const tx = runtime.edit();
      runtime.getCell(signer.did(), "diagnostic-value", undefined, tx).set(
        "private payload",
      );
      commit = tx.commit();
      await accepted.promise;
      const snapshot = storage.getDiagnostics();
      expect(snapshot.pendingCommits).toHaveLength(1);
      expect(snapshot.pendingCommits[0]).toMatchObject({
        kind: "transaction",
        transactionStatus: "pending",
        spaces: [signer.did()],
        commits: [{ space: signer.did(), localSeq: 1 }],
      });
      expect(snapshot.pendingCommits[0].commits?.[0].seq).toBeGreaterThan(0);
      expect(snapshot.spaces[0].sessionId).toBeTruthy();
      expect(JSON.stringify(snapshot)).not.toContain("private payload");
      release.resolve();
      expect((await commit).error).toBeUndefined();
      await storage.pendingCommitsSettled();
      expect(storage.getDiagnostics().pendingCommitCount).toBe(0);
    } finally {
      release.resolve();
      await commit;
      replica.commitNative = commitNative;
      await runtime.dispose();
      await storage.close();
    }
  });

  it("reports bounded current work and drops resolved and rejected registrations", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const success = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<void>();
    let contextRead = false;
    try {
      storage.trackPendingCommit(success.promise, () => {
        contextRead = true;
        return { kind: "event-intent", spaces: [signer.did()] };
      });
      for (let i = 0; i < STORAGE_DIAGNOSTICS_LIMIT; i++) {
        storage.trackPendingCommit(failure.promise);
      }
      expect(contextRead).toBe(false);
      const diagnostic = storage.getDiagnostics();
      expect(diagnostic.pendingCommitCount).toBe(STORAGE_DIAGNOSTICS_LIMIT + 1);
      expect(diagnostic.pendingCommits).toHaveLength(STORAGE_DIAGNOSTICS_LIMIT);
      expect(diagnostic.pendingCommitsOmitted).toBe(1);
      expect(diagnostic.pendingCommits[0]).toMatchObject({
        kind: "event-intent",
        spaces: [signer.did()],
      });
      expect(diagnostic.pendingCommits[0].ageMs).toBeGreaterThanOrEqual(0);
      expect(new Set(diagnostic.pendingCommits.map((entry) => entry.id)).size)
        .toBe(STORAGE_DIAGNOSTICS_LIMIT);
      expect(diagnostic.spaces).toEqual([]);
      expect(storage.getDiagnostics().pendingCommits[0].id)
        .toBe(diagnostic.pendingCommits[0].id);
      expect(storage.hasPendingCommits()).toBe(true);

      success.resolve();
      failure.reject(new Error("terminal test failure"));
      await storage.pendingCommitsSettled();
      expect(storage.getDiagnostics()).toMatchObject({
        pendingCommitCount: 0,
        pendingCommits: [],
        pendingCommitsOmitted: 0,
      });
      expect(storage.hasPendingCommits()).toBe(false);
    } finally {
      success.resolve();
      failure.resolve();
      await storage.pendingCommitsSettled();
      await storage.close();
    }
  });
});
