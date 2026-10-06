import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  applyPieceSourceTransition,
  getPatternSource,
  getPieceSourceRevisions,
  getPieceSourceSnapshot,
  PIECE_SOURCE_MOVED,
  preparePieceSourceTransitionBaseline,
  setPatternSource,
} from "../src/runner.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("test operator");

// A hand-built (keyless) pattern; `marker` differentiates the structure so
// two versions mint DIFFERENT session identities (the mint content-hashes
// the pattern object).
const handBuiltPattern = (marker: string) => ({
  argumentSchema: {},
  resultSchema: {
    type: "object",
    properties: { marker: { type: "string" } },
  },
  result: { marker },
  nodes: [],
});

describe("patternSource meta accessors", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("round-trips a source string", async () => {
    const url = "/api/patterns/system/default-app.tsx";
    const { error } = await runtime.editWithRetry((tx) => {
      const cell = runtime.getCell(
        signer.did(),
        "pattern-source-roundtrip",
        undefined,
        tx,
      );
      setPatternSource(cell, tx, url);
      expect(getPatternSource(cell.withTx(tx))).toBe(url);
    });
    expect(error).toBeUndefined();
  });

  it("returns undefined when unset", async () => {
    const { error } = await runtime.editWithRetry((tx) => {
      const cell = runtime.getCell(
        signer.did(),
        "pattern-source-absent",
        undefined,
        tx,
      );
      expect(getPatternSource(cell.withTx(tx))).toBeUndefined();
    });
    expect(error).toBeUndefined();
  });

  it("has no source snapshot without a pattern identity", () => {
    const cell = runtime.getCell(signer.did(), "source-snapshot-absent");
    expect(getPieceSourceSnapshot(cell)).toBeUndefined();
  });

  it("records a legacy current state before atomically detaching it", async () => {
    const id = "pattern-source-detach";
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents:
          "import { pattern } from 'commonfabric'; export default pattern(() => ({}));",
      }],
    }, { space: signer.did() });
    const pattern = runtime.patternManager.getArtifactEntryRef(compiled)!;
    const origin = "https://example.test/pattern.tsx";
    const seed = runtime.edit();
    const seededCell = runtime.getCell(signer.did(), id, undefined, seed);
    seededCell.setMetaRaw(
      "patternIdentity",
      pattern,
      rawMetaWriteAuthorization,
    );
    setPatternSource(seededCell, seed, origin);
    await seed.commit().settled;

    const cell = runtime.getCell(signer.did(), id);
    const expected = getPieceSourceSnapshot(cell);
    expect(expected).toEqual({
      pattern,
      origin,
      revisionId: null,
    });

    const tx = runtime.edit();
    applyPieceSourceTransition(
      runtime,
      cell,
      tx,
      pattern,
      {
        revisionId: "detach-revision",
        baseline: { kind: "retain", revisionId: "baseline-revision" },
        timestamp: 42,
        operation: "detach",
        origin: null,
        expected: expected!,
      },
    );
    await tx.commit().settled;

    expect(getPatternSource(cell)).toBeUndefined();
    expect(getPieceSourceSnapshot(cell)).toEqual({
      pattern,
      origin: null,
      revisionId: "detach-revision",
    });
    const revisions = getPieceSourceRevisions(cell);
    expect(revisions.map((revision) => ({
      revisionId: revision.revisionId,
      pattern: revision.pattern,
      origin: revision.origin,
      operation: revision.operation,
    }))).toEqual([
      {
        revisionId: "baseline-revision",
        pattern,
        origin,
        operation: "baseline",
      },
      {
        revisionId: "detach-revision",
        pattern,
        origin: undefined,
        operation: "detach",
      },
    ]);
    expect(revisions[0].source).toEqual(revisions[1].source);
  });

  it("rejects a transition prepared against stale source state", async () => {
    const id = "pattern-source-stale";
    const pattern = { identity: "current-pattern", symbol: "default" };
    const seed = runtime.edit();
    const seededCell = runtime.getCell(signer.did(), id, undefined, seed);
    seededCell.setMetaRaw(
      "patternIdentity",
      pattern,
      rawMetaWriteAuthorization,
    );
    setPatternSource(seededCell, seed, "https://example.test/first.tsx");
    await seed.commit().settled;

    const cell = runtime.getCell(signer.did(), id);
    const stale = getPieceSourceSnapshot(cell)!;
    const concurrent = runtime.edit();
    setPatternSource(
      cell,
      concurrent,
      "https://example.test/concurrent.tsx",
    );
    await concurrent.commit().settled;

    const transition = runtime.edit();
    expect(() =>
      applyPieceSourceTransition(
        runtime,
        cell,
        transition,
        pattern,
        {
          revisionId: "stale-revision",
          baseline: { kind: "retain", revisionId: "stale-baseline" },
          timestamp: 42,
          operation: "detach",
          origin: null,
          expected: stale,
        },
      )
    ).toThrow(
      "piece source changed while the source transition was being prepared",
    );
    transition.abort();

    expect(getPatternSource(cell)).toBe(
      "https://example.test/concurrent.tsx",
    );
    expect(getPieceSourceRevisions(cell)).toEqual([]);
  });

  it("fails closed instead of rewriting malformed source history", async () => {
    const id = "pattern-source-malformed-history";
    const pattern = { identity: "current-pattern", symbol: "default" };
    const seed = runtime.edit();
    const seededCell = runtime.getCell(signer.did(), id, undefined, seed);
    seededCell.setMetaRaw(
      "patternIdentity",
      pattern,
      rawMetaWriteAuthorization,
    );
    seededCell.setMetaRaw("pieceSourceHistory", [{
      revisionId: "broken",
      timestamp: 42,
    }], rawMetaWriteAuthorization);
    await seed.commit().settled;

    const cell = runtime.getCell(signer.did(), id);
    expect(() => getPieceSourceRevisions(cell)).toThrow(
      "piece source history is invalid",
    );
    const transition = runtime.edit();
    expect(() =>
      applyPieceSourceTransition(
        runtime,
        cell,
        transition,
        pattern,
        {
          revisionId: "replacement",
          baseline: {
            kind: "retain",
            revisionId: "replacement-baseline",
          },
          timestamp: 43,
          operation: "detach",
          origin: null,
          expected: {
            pattern,
            origin: null,
            revisionId: null,
          },
        },
      )
    ).toThrow("piece source history is invalid");
    transition.abort();
  });

  it("rejects malformed source-history containers and entries", async () => {
    const invalidHistories: unknown[] = [
      "not an array",
      [42],
      [{
        revisionId: "bad-link",
        timestamp: 42,
        pattern: { identity: "pattern", symbol: "default" },
        source: { "/": { "link@1": { path: "not an array" } } },
        operation: "create",
      }],
    ];

    for (const [index, history] of invalidHistories.entries()) {
      const cell = runtime.getCell(
        signer.did(),
        `malformed-source-history-${index}`,
      );
      const seed = runtime.edit();
      cell.withTx(seed).setMetaRaw(
        "pieceSourceHistory",
        history as never,
        rawMetaWriteAuthorization,
      );
      await seed.commit().settled;

      expect(() => getPieceSourceRevisions(cell)).toThrow(
        "piece source history is invalid",
      );
    }
  });

  it("rejects a history link that does not retain its recorded pattern", async () => {
    const id = "pattern-source-wrong-retention-link";
    const pattern = { identity: "expected-pattern", symbol: "default" };
    const seed = runtime.edit();
    const seededCell = runtime.getCell(signer.did(), id, undefined, seed);
    seededCell.setMetaRaw(
      "patternIdentity",
      pattern,
      rawMetaWriteAuthorization,
    );
    seededCell.setMetaRaw("pieceSourceHistory", [{
      revisionId: "wrong-source",
      timestamp: 42,
      pattern,
      source: runtime.getCell(
        signer.did(),
        "pattern:different-pattern",
        undefined,
        seed,
      ).getAsLink(),
      operation: "create",
    }], rawMetaWriteAuthorization);
    await seed.commit().settled;

    expect(() => getPieceSourceRevisions(runtime.getCell(signer.did(), id)))
      .toThrow("piece source history is invalid");
  });

  it("keeps source verification in the lifecycle commit", async () => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents:
          "import { pattern } from 'commonfabric'; export default pattern(() => ({}));",
      }],
    }, { space: signer.did() });
    const pattern = runtime.patternManager.getArtifactEntryRef(compiled)!;
    const piece = runtime.getCell(signer.did(), "source-verification-race");
    const seed = runtime.edit();
    piece.withTx(seed).setMetaRaw(
      "patternIdentity",
      pattern,
      rawMetaWriteAuthorization,
    );
    await seed.commit().settled;
    const expected = getPieceSourceSnapshot(piece)!;
    const baseline = await preparePieceSourceTransitionBaseline(
      runtime,
      piece,
      expected,
    );

    const corrupt = runtime.edit();
    runtime.getCell(
      signer.did(),
      `pattern:${pattern.identity}`,
      undefined,
      corrupt,
    ).set({ corrupt: true });
    await corrupt.commit().settled;

    const transition = runtime.edit();
    expect(() =>
      applyPieceSourceTransition(
        runtime,
        piece,
        transition,
        pattern,
        {
          revisionId: "detach-after-corruption",
          baseline,
          timestamp: 42,
          operation: "detach",
          origin: null,
          expected,
        },
      )
    ).toThrow(`source for pattern ${pattern.identity} is not available`);
    transition.abort();
    expect(getPieceSourceRevisions(piece)).toEqual([]);
  });

  it("does not expose an unavailable legacy source as restorable history", async () => {
    const id = "pattern-source-unavailable-baseline";
    const missing = { identity: "missing-source", symbol: "default" };
    const seed = runtime.edit();
    const seededCell = runtime.getCell(signer.did(), id, undefined, seed);
    seededCell.setMetaRaw(
      "patternIdentity",
      missing,
      rawMetaWriteAuthorization,
    );
    await seed.commit().settled;

    const cell = runtime.getCell(signer.did(), id);
    const expected = getPieceSourceSnapshot(cell)!;
    await expect(
      preparePieceSourceTransitionBaseline(runtime, cell, expected),
    ).rejects.toThrow("the piece's current source is not available");
    const baseline = await preparePieceSourceTransitionBaseline(
      runtime,
      cell,
      expected,
      { allowUnavailable: true },
    );
    expect(baseline).toEqual({ kind: "unavailable" });

    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents:
          "import { pattern } from 'commonfabric'; export default pattern(() => ({ healed: true }));",
      }],
    }, { space: signer.did() });
    const replacement = runtime.patternManager.getArtifactEntryRef(compiled)!;
    const transition = runtime.edit();
    applyPieceSourceTransition(
      runtime,
      cell,
      transition,
      replacement,
      {
        revisionId: "replacement-revision",
        baseline,
        timestamp: 42,
        operation: "origin-update",
        origin: "https://example.test/replacement.tsx",
        expected,
      },
    );
    cell.withTx(transition).setMetaRaw(
      "patternIdentity",
      replacement,
      rawMetaWriteAuthorization,
    );
    await transition.commit().settled;

    expect(
      getPieceSourceRevisions(cell).map((revision) => ({
        revisionId: revision.revisionId,
        pattern: revision.pattern,
      })),
    ).toEqual([{
      revisionId: "replacement-revision",
      pattern: replacement,
    }]);
  });

  it("rejects a baseline prepared after the source state changed", async () => {
    const pattern = { identity: "current-pattern", symbol: "default" };
    const cell = runtime.getCell(signer.did(), "stale-source-baseline");
    const seed = runtime.edit();
    cell.withTx(seed).setMetaRaw(
      "patternIdentity",
      pattern,
      rawMetaWriteAuthorization,
    );
    setPatternSource(cell, seed, "https://example.test/first.tsx");
    await seed.commit().settled;
    const stale = getPieceSourceSnapshot(cell)!;

    const concurrent = runtime.edit();
    setPatternSource(
      cell,
      concurrent,
      "https://example.test/concurrent.tsx",
    );
    await concurrent.commit().settled;

    await expect(
      preparePieceSourceTransitionBaseline(runtime, cell, stale),
    ).rejects.toThrow(
      "piece source changed while the source transition was being prepared",
    );
  });

  // A KEYLESS piece stamps no durable pointer (L3(a), RULED 2026-08-27), so
  // a concurrent keyless re-setup moves NEITHER the durable meta NOR the
  // source revisions — the only supersession signal is the runner's live
  // session pointer. The moved-guard must read that pointer: falling back to
  // the transition's own expected pattern compares expected against itself,
  // and the prepared transition applies over the NEWER setup (pre-guard, the
  // durable stamp aborted exactly this with PIECE_SOURCE_MOVED).
  const stageSupersededKeylessPiece = async (id: string) => {
    const cell = runtime.getCell<Record<string, unknown>>(
      signer.did(),
      id,
    );
    const tx = runtime.edit();
    const running = runtime.run(
      tx,
      // deno-lint-ignore no-explicit-any
      handBuiltPattern("first") as any,
      {},
      cell,
    );
    await tx.commit().settled;
    await running.pull();
    const stale = getPieceSourceSnapshot(
      cell,
      runtime.runner.sessionPatternPointerFor(cell),
    )!;
    expect(stale.pattern.identity).toMatch(/^keyless:/);

    // The concurrent keyless re-setup: the session pointer moves, durable
    // pattern meta and source revisions stay untouched.
    runtime.runner.stop(cell);
    const tx2 = runtime.edit();
    const rerun = runtime.run(
      tx2,
      // deno-lint-ignore no-explicit-any
      handBuiltPattern("second") as any,
      {},
      cell,
    );
    await tx2.commit().settled;
    await rerun.pull();
    const moved = runtime.runner.sessionPatternPointerFor(cell);
    expect(moved).toBeDefined();
    expect(moved!.identity).toMatch(/^keyless:/);
    expect(moved!.identity).not.toBe(stale.pattern.identity);
    return { cell, stale };
  };

  it("rejects a keyless transition superseded by a newer keyless setup", async () => {
    const { cell, stale } = await stageSupersededKeylessPiece(
      "keyless-transition-superseded",
    );
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents:
          "import { pattern } from 'commonfabric'; export default pattern(() => ({}));",
      }],
    }, { space: signer.did() });
    const nextPattern = runtime.patternManager.getArtifactEntryRef(compiled)!;

    const transition = runtime.edit();
    expect(() =>
      applyPieceSourceTransition(
        runtime,
        cell,
        transition,
        nextPattern,
        {
          revisionId: "superseded-revision",
          baseline: { kind: "unavailable" },
          timestamp: 42,
          operation: "repoint",
          origin: null,
          expected: stale,
        },
      )
    ).toThrow(PIECE_SOURCE_MOVED);
    transition.abort();

    // Nothing of the superseded transition landed.
    expect(getPieceSourceRevisions(cell)).toEqual([]);
  });

  it("rejects a keyless baseline prepared against a superseded setup", async () => {
    const { cell, stale } = await stageSupersededKeylessPiece(
      "keyless-baseline-superseded",
    );
    await expect(
      preparePieceSourceTransitionBaseline(runtime, cell, stale, {
        allowUnavailable: true,
      }),
    ).rejects.toThrow(PIECE_SOURCE_MOVED);
  });
});
