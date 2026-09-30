import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  getPieceSourceRevisions,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { watchMetaReads } from "../../runner/test/support/watch-meta-reads.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("setsrc commit receipt");

/** Returns a program whose result identifies its authored version. */
function markedProgram(marker: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "interface Args { label?: string }",
        "export default pattern<Args, { marker: string }>(",
        "  () => ({",
        "    [NAME]: 'Commit receipt',",
        `    marker: ${JSON.stringify(marker)},`,
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

describe("setsrc commit receipt", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("returns the accepted setup transaction's pattern and source revision", async () => {
    const piece = await pieces.create(markedProgram("v1"), { input: {} });
    await runtime.idle();
    const before = getPatternIdentityRef(piece.getCell());

    const receipt = await piece.setPattern(markedProgram("v2"));
    await runtime.idle();

    const durable = getPatternIdentityRef(piece.getCell());
    const revision = getPieceSourceRevisions(piece.getCell()).at(-1);
    const { seq, ...named } = receipt;
    expect(named).toEqual({
      status: "committed",
      ref: durable,
      revisionId: revision?.revisionId,
      detachedOrigin: null,
      space: pieces.getSpace(),
      refresh: { status: "completed" },
    });
    expect(Number.isInteger(seq)).toBe(true);
    expect(seq).toBeGreaterThan(0);
    expect(receipt.ref.identity).not.toBe(before?.identity);
    expect(revision?.pattern).toEqual(receipt.ref);
    expect(
      (piece.getCell().getAsQueryResult() as { marker?: string }).marker,
    ).toBe("v2");
  });

  it("orders two updates by the seq their space accepted them at", async () => {
    // The seq is the receipt's own position in the space's commit log, so
    // two receipts for one piece order each other without reading the piece.

    const piece = await pieces.create(markedProgram("v1"), { input: {} });
    await runtime.idle();

    const first = await piece.setPattern(markedProgram("v2"));
    const second = await piece.setPattern(markedProgram("v3"));

    expect(second.space).toBe(first.space);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(getPatternIdentityRef(piece.getCell())).toEqual(second.ref);
  });

  it("performs no additional cell synchronization after the update operation returns its receipt", async () => {
    // What the receipt replaces: confirming the write by synchronizing the
    // piece and re-reading its pattern pointer. Such a read answers a
    // different question — what the piece points at now, which a concurrent
    // update may have moved — and `syncCell` resolves normally over a
    // provider error, so a cache hit reads as durable truth. Adding one back
    // after the receipt is the regression this case fails on.
    //
    // The counter is validated before it is trusted: synchronizations during
    // the update must be non-zero, or a zero afterwards would be measuring a
    // broken instrument rather than the absence of a read-back.
    const piece = await pieces.create(markedProgram("v1"), { input: {} });
    await runtime.idle();
    const originalRun = pieces.runPatternUpdate.bind(pieces);
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let receiptIssued = false;
    let synchronizationsDuringUpdate = 0;
    let synchronizationsAfterReceipt = 0;

    pieces.runPatternUpdate = (async (...args) => {
      const result = await originalRun(...args);
      receiptIssued = true;
      return result;
    }) as typeof pieces.runPatternUpdate;
    storageManager.syncCell = ((cell, options) => {
      if (receiptIssued) synchronizationsAfterReceipt++;
      else synchronizationsDuringUpdate++;
      return originalSyncCell(cell, options);
    }) as typeof storageManager.syncCell;

    try {
      const receipt = await piece.setPattern(markedProgram("v2"));

      expect(receipt.status).toBe("committed");
      expect(receipt.refresh).toEqual({ status: "completed" });
      expect(synchronizationsDuringUpdate).toBeGreaterThan(0);
      expect(synchronizationsAfterReceipt).toBe(0);
    } finally {
      pieces.runPatternUpdate = originalRun;
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("returns a refresh warning without changing the committed outcome", async () => {
    const piece = await pieces.create(markedProgram("v1"), { input: {} });
    await runtime.idle();
    const originalSyncPattern = pieces.syncPattern.bind(pieces);
    const originalRunSyncedWithCommit = runtime.runSyncedWithCommit.bind(
      runtime,
    );
    const originalWarn = console.warn;
    let commitReceiptIssued = false;
    let sourceHistoryReadsAfterReceipt = 0;
    console.warn = () => {};
    pieces.syncPattern = () => {
      if (!commitReceiptIssued) {
        throw new Error("post-commit refresh started before the receipt");
      }
      throw new Error("injected post-commit refresh failure");
    };
    runtime.runSyncedWithCommit = (async (...args) => {
      const result = await originalRunSyncedWithCommit(...args);
      commitReceiptIssued = true;
      return result;
    }) as typeof runtime.runSyncedWithCommit;
    const unwatch = watchMetaReads("pieceSourceHistory", () => {
      if (commitReceiptIssued) {
        sourceHistoryReadsAfterReceipt++;
        throw new Error(
          "the commit receipt must not be verified by rereading source history",
        );
      }
    });

    try {
      const receipt = await piece.setPattern(markedProgram("v2"));

      expect(commitReceiptIssued).toBe(true);
      expect(sourceHistoryReadsAfterReceipt).toBe(0);
      expect(receipt.status).toBe("committed");
      expect(receipt.refresh).toEqual({
        status: "failed",
        warning: "injected post-commit refresh failure",
      });
      // The assertions below deliberately inspect history after the guard has
      // proved setPattern itself did not. Restore ordinary reads first.
      commitReceiptIssued = false;
      expect(getPatternIdentityRef(piece.getCell())).toEqual(receipt.ref);
      expect(getPieceSourceRevisions(piece.getCell()).at(-1)?.revisionId)
        .toBe(receipt.revisionId);
    } finally {
      pieces.syncPattern = originalSyncPattern;
      runtime.runSyncedWithCommit = originalRunSyncedWithCommit;
      unwatch();
      console.warn = originalWarn;
    }
  });

  it("refuses a commit receipt for writes staged in a caller-owned transaction", async () => {
    const piece = await pieces.create(markedProgram("v1"), { input: {} });
    await runtime.idle();
    const ref = getPatternIdentityRef(piece.getCell());
    if (ref === undefined) {
      throw new Error("the fixture piece has no pattern identity");
    }
    const pattern = await piece.getPattern();
    const tx = runtime.edit();

    try {
      await expect(runtime.runSyncedWithCommit(
        piece.getCell().withTx(tx),
        pattern,
        undefined,
        {
          expectedPatternIdentity: ref,
          // Ownership is refused before source setup. Supplying an unreachable
          // transition keeps this test about that ordering while satisfying
          // the receipt API's required novelty contract.
          pieceSourceTransition: {
            revisionId: crypto.randomUUID(),
            baseline: { kind: "unavailable" },
            timestamp: Date.now(),
            operation: "edit",
            origin: null,
            expected: { pattern: ref, origin: null, revisionId: null },
          },
        },
      )).rejects.toThrow(
        "a committed pattern setup receipt requires an unbound result cell",
      );
    } finally {
      tx.abort();
    }
  });

  it("preserves the post-commit failure reported by legacy runSynced callers", async () => {
    const piece = await pieces.create(markedProgram("v1"), {
      input: {},
      start: false,
    });
    const previous = getPatternIdentityRef(piece.getCell());
    if (previous === undefined) {
      throw new Error("the fixture piece has no pattern identity");
    }
    const candidate = await runtime.patternManager.compilePattern(
      markedProgram("v2"),
      { space: pieces.getSpace() },
    );
    const candidateRef = runtime.patternManager.getArtifactEntryRef(candidate);
    let syncCount = 0;
    runtime.runner.accessForTestingOnly.dependencySyncer = async (
      resultCell,
      pattern,
      inputs,
      sync,
    ) => {
      syncCount++;
      if (syncCount === 2) {
        throw new Error("injected runner post-commit failure");
      }
      return await sync(resultCell, pattern, inputs);
    };

    try {
      await expect(runtime.runSynced(
        piece.getCell(),
        candidate,
        undefined,
        { expectedPatternIdentity: previous },
      )).rejects.toThrow("injected runner post-commit failure");
      expect(getPatternIdentityRef(piece.getCell())).toEqual(candidateRef);
    } finally {
      runtime.runner.accessForTestingOnly.dependencySyncer = undefined;
    }
  });

  it("throws when the compiled candidate has no pattern identity", async () => {
    const piece = await pieces.create(markedProgram("v1"), { input: {} });
    await runtime.idle();
    const manager = runtime.patternManager;
    const originalGetRef = manager.getArtifactEntryRef.bind(manager);
    manager.getArtifactEntryRef = () => undefined;

    try {
      await expect(piece.setPattern(markedProgram("v2"))).rejects.toThrow(
        "the candidate source has no pattern identity",
      );
    } finally {
      manager.getArtifactEntryRef = originalGetRef;
    }
  });

  it("rejects a refused setup commit with an `Error` carrying the refusal", async () => {
    // Storage reports a refusal as a `Result` error, a plain object rather
    // than an `Error`. One thrown as it stands reaches `cf piece setsrc` as
    // `[non-error-thrown] [object Object]`, its reason discarded. The refusal
    // below has the shape the CFC boundary produces when not every reason is
    // a verdict: the message says what refused, and `reason` is only a
    // classification marker.

    const piece = await pieces.create(markedProgram("v1"), { input: {} });
    await runtime.idle();
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const refusal = {
      name: "StorageTransactionAborted" as const,
      message: "CFC enforcement rejected commit: relevant transaction was " +
        "not prepared: a policy check refused the write",
      reason: new Error("cfc-refusal-not-a-verdict"),
    };
    let refused = false;
    // The setup transaction is the one carrying source-update authority.
    // Every other transaction the update opens, persisting the compiled
    // candidate among them, runs for real.
    runtime.editWithRetry = ((fn, maxRetries, options) => {
      if (options?.sourceUpdate === undefined) {
        return originalEditWithRetry(fn, maxRetries, options);
      }
      refused = true;
      return Promise.resolve({ error: refusal });
    }) as typeof runtime.editWithRetry;

    try {
      const thrown = await piece.setPattern(markedProgram("v2")).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBe(true);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(refusal.message);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });
});
