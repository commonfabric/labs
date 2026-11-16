import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import {
  applyPieceSourceTransition,
  getPatternSource,
  getPieceSourceDelegations,
  getPieceSourceRecord,
  getPieceSourceRevisions,
  getPieceSourceSnapshot,
  PIECE_SOURCE_MOVED,
  preparePieceSourceTransitionBaseline,
  setPatternSource,
} from "../src/runner.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

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
    const url = "/api/patterns/system/default-app/default-app.tsx";
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

  describe("getPieceSourceDelegations()", () => {
    const pattern = "recorded-pattern";
    const valid = [{ identity: "recorded-module", predecessors: ["earlier"] }];

    /**
     * A piece whose `pieceSourceDelegations` member is `member`, and whose
     * history holds `revisions` revisions.
     */
    const pieceWith = async (
      name: string,
      member: unknown,
      revisions = 0,
    ): Promise<ReturnType<typeof runtime.getCell>> => {
      const cell = runtime.getCell(signer.did(), name);
      const seed = runtime.edit();
      cell.withTx(seed).setMetaRaw(
        "pieceSourceDelegations",
        member as never,
        rawMetaWriteAuthorization,
      );
      if (revisions > 0) {
        const source = runtime.getCell(
          signer.did(),
          `pattern:${pattern}`,
          undefined,
          seed,
        ).getAsLink();
        cell.withTx(seed).setMetaRaw(
          "pieceSourceHistory",
          Array.from({ length: revisions }, (_, index) => ({
            revisionId: `${name}-${index}`,
            timestamp: 42 + index,
            pattern: { identity: pattern, symbol: "default" },
            source,
            operation: index === 0 ? "create" : "edit",
          })) as never,
          rawMetaWriteAuthorization,
        );
      }
      expect((await seed.commit().settled).error).toBeUndefined();
      return cell;
    };

    it("returns the delegations a member records for the pattern it names", async () => {
      const cell = await pieceWith("recorded-delegations", {
        identity: pattern,
        delegations: valid,
      });

      expect(getPieceSourceDelegations(cell, pattern)).toStrictEqual(
        new Map([["recorded-module", new Set(["earlier"])]]),
      );
    });

    it("returns none for a member that names another pattern, or for no member", async () => {
      const cell = await pieceWith("recorded-delegations-elsewhere", {
        identity: "another-pattern",
        delegations: valid,
      });

      expect(getPieceSourceDelegations(cell, pattern)).toStrictEqual(new Map());
      expect(
        getPieceSourceDelegations(
          runtime.getCell(signer.did(), "no-recorded-delegations"),
          pattern,
        ),
      ).toStrictEqual(new Map());
    });

    it("reads every field for a recording transition at one past the history's length, and no field where any is malformed", async () => {
      const edges = [{
        identity: "recorded-module",
        predecessors: [{ identity: "older", at: [0, 2], terminal: [3] }],
      }];
      const cell = await pieceWith("recorded-record", {
        identity: pattern,
        delegations: valid,
        edges,
      }, 3);
      expect(getPieceSourceRecord(cell, pattern)).toStrictEqual({
        delegations: new Map([["recorded-module", new Set(["earlier"])]]),
        edges: new Map([[
          "recorded-module",
          new Map([["older", { at: [0, 2], terminal: [3] }]]),
        ]]),
        position: 4,
      });

      // One predecessor, with `fields` over a well-formed default.
      const edge = (fields: Record<string, unknown>) => [{
        identity: "m",
        predecessors: [{ identity: "a", at: [1], terminal: [], ...fields }],
      }];
      for (
        const [name, malformed] of [
          ["absent", undefined],
          ["unstamped", [{ identity: "m", predecessors: ["a"] }]],
          ["self-edge", edge({ identity: "m" })],
          ["duplicate-module", [...edge({}), ...edge({ identity: "b" })]],
          ["duplicate-predecessor", [{
            identity: "m",
            predecessors: [
              { identity: "a", at: [1], terminal: [] },
              { identity: "a", at: [2], terminal: [] },
            ],
          }]],
          ["empty-predecessors", [{ identity: "m", predecessors: [] }]],
          ["no-stamp", edge({ at: [], terminal: [] })],
          ["no-terminal-list", edge({ terminal: undefined })],
          ["non-numeric-stamp", edge({ at: ["1"] })],
          ["non-numeric-terminal-stamp", edge({ terminal: ["1"] })],
          ["fractional-stamp", edge({ at: [1.5] })],
          ["negative-stamp", edge({ at: [-1] })],
          ["decreasing-stamps", edge({ at: [2, 1] })],
          ["decreasing-terminal-stamps", edge({ terminal: [3, 2] })],
          ["repeated-stamp", edge({ at: [1, 1] })],
          ["stamp-past-the-history", edge({ at: [4] })],
          ["terminal-stamp-past-the-history", edge({ terminal: [4] })],
        ] as const
      ) {
        const bad = await pieceWith(`recorded-record-${name}`, {
          identity: pattern,
          delegations: valid,
          ...(malformed === undefined ? {} : { edges: malformed }),
        }, 3);
        expect(getPieceSourceRecord(bad, pattern), name).toStrictEqual({
          delegations: new Map(),
          edges: new Map(),
          position: 4,
        });
        // A start reads the delegations alone, which are well-formed.
        expect(getPieceSourceDelegations(bad, pattern).size, name).toBe(1);
      }
    });

    it("returns none for a malformed member", async () => {
      const malformed: unknown[] = [
        "not an object",
        [{ identity: pattern, delegations: valid }],
        { identity: pattern },
        { identity: pattern, delegations: "not an array" },
        { identity: pattern, delegations: [42] },
        { identity: pattern, delegations: [["recorded-module", ["earlier"]]] },
        {
          identity: pattern,
          delegations: [{ identity: "", predecessors: ["earlier"] }],
        },
        {
          identity: pattern,
          delegations: [{ identity: "recorded-module", predecessors: [] }],
        },
        {
          identity: pattern,
          delegations: [{ identity: "recorded-module", predecessors: [""] }],
        },
        {
          identity: pattern,
          delegations: [{
            identity: "recorded-module",
            predecessors: ["recorded-module"],
          }],
        },
        {
          identity: pattern,
          delegations: [...valid, {
            identity: "recorded-module",
            predecessors: ["other"],
          }],
        },
      ];

      for (const [index, member] of malformed.entries()) {
        const cell = await pieceWith(
          `malformed-recorded-delegations-${index}`,
          member,
        );
        expect(getPieceSourceDelegations(cell, pattern), String(index))
          .toStrictEqual(new Map());
      }
    });
  });

  describe("the `pieceSourceDelegations` member across a transition", () => {
    /** `entries` as stamped edges, each recorded at 0. */
    const stampedAt0 = (
      entries: readonly { identity: string; predecessors: string[] }[],
    ) =>
      entries.map(({ identity, predecessors }) => ({
        identity,
        predecessors: predecessors.map((predecessor) => ({
          identity: predecessor,
          at: [0],
          terminal: [],
        })),
      }));

    const compile = async (marker: string) =>
      runtime.patternManager.getArtifactEntryRef(
        await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents:
              `import { pattern } from 'commonfabric'; export default pattern(() => ({ marker: ${
                JSON.stringify(marker)
              } }));`,
          }],
        }, { space: signer.did() }),
      )!;

    /**
     * A piece running `pattern`, whose history ends at it and whose member
     * records `recorded` for it, as its delegations and, unless `edges` says
     * otherwise, as its edges.
     */
    const pieceRunning = async (
      id: string,
      pattern: { identity: string; symbol: string },
      recorded: { identity: string; predecessors: string[] }[],
      edges = recorded,
    ) => {
      // The piece's history is one revision long, so the only stamp an edge
      // can carry is 0.
      const seed = runtime.edit();
      const seeded = runtime.getCell(signer.did(), id, undefined, seed);
      seeded.setMetaRaw("patternIdentity", pattern, rawMetaWriteAuthorization);
      seeded.setMetaRaw("pieceSourceHistory", [{
        revisionId: "updated",
        timestamp: 42,
        pattern,
        source: runtime.getCell(
          signer.did(),
          `pattern:${pattern.identity}`,
          undefined,
          seed,
        ).getAsLink(),
        operation: "edit",
      }], rawMetaWriteAuthorization);
      seeded.setMetaRaw("pieceSourceDelegations", {
        identity: pattern.identity,
        delegations: recorded,
        edges: stampedAt0(edges),
      }, rawMetaWriteAuthorization);
      expect((await seed.commit().settled).error).toBeUndefined();
      return runtime.getCell(signer.did(), id);
    };

    const transition = async (
      cell: ReturnType<typeof runtime.getCell>,
      next: { identity: string; symbol: string },
      operation: "detach" | "edit",
    ) => {
      const tx = runtime.edit();
      applyPieceSourceTransition(runtime, cell, tx, next, {
        revisionId: `to-${next.identity}-${operation}`,
        baseline: { kind: "retain", revisionId: `baseline-${operation}` },
        timestamp: 43,
        operation,
        origin: null,
        expected: getPieceSourceSnapshot(cell)!,
      });
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    it("keeps what it records on a transition that leaves the pattern in place", async () => {
      const pattern = await compile("kept");
      const recorded = [{
        identity: pattern.identity,
        predecessors: ["earlier-pattern"],
      }];
      const cell = await pieceRunning("delegations-kept", pattern, recorded);

      await transition(cell, pattern, "detach");

      expect(cell.getMetaRaw("pieceSourceDelegations")).toEqual({
        identity: pattern.identity,
        delegations: recorded,
        edges: stampedAt0(recorded),
      });
    });

    it("keeps what it records on a transition that changes only the symbol", async () => {
      const pattern = await compile("symbol");
      const recorded = [{
        identity: pattern.identity,
        predecessors: ["earlier-pattern"],
      }];
      const cell = await pieceRunning("delegations-symbol", pattern, recorded);

      await transition(cell, { ...pattern, symbol: "other" }, "edit");

      expect(cell.getMetaRaw("pieceSourceDelegations")).toEqual({
        identity: pattern.identity,
        delegations: recorded,
        edges: stampedAt0(recorded),
      });
    });

    it("refuses, as a source that moved, an update prepared over a member that has changed since", async () => {
      const pattern = await compile("prepared-from");
      const next = await compile("prepared-to");
      const space = signer.did();
      const updateOver = async (
        id: string,
        moveMember: "none" | "both" | "delegations",
      ) => {
        const cell = await pieceRunning(id, pattern, [{
          identity: pattern.identity,
          predecessors: ["earlier-pattern"],
        }]);
        const prepared = await runtime.patternManager.prepareSourceUpdate(
          space,
          pattern.identity,
          next.identity,
          getPieceSourceRecord(cell, pattern.identity),
        );
        if (moveMember !== "none") {
          const write = runtime.edit();
          const since = [{
            identity: pattern.identity,
            predecessors: ["recorded-since"],
          }];
          cell.withTx(write).setMetaRaw("pieceSourceDelegations", {
            identity: pattern.identity,
            delegations: since,
            edges: stampedAt0(
              moveMember === "both" ? since : [{
                identity: pattern.identity,
                predecessors: ["earlier-pattern"],
              }],
            ),
          }, rawMetaWriteAuthorization);
          expect((await write.commit().settled).error).toBeUndefined();
        }
        const tx = runtime.edit();
        try {
          applyPieceSourceTransition(runtime, cell, tx, next, {
            revisionId: `update-${id}`,
            baseline: { kind: "retain", revisionId: `baseline-${id}` },
            timestamp: 43,
            operation: "edit",
            origin: null,
            expected: getPieceSourceSnapshot(cell)!,
          }, { sourceUpdate: prepared });
        } finally {
          tx.abort();
        }
      };

      // On an honest path the history's guard refuses first: every
      // transition appends a revision. The member's own check is for a
      // member written without one, either field of it.
      await updateOver("prepared-over-the-same-member", "none");
      await expect(updateOver("prepared-over-a-moved-member", "both"))
        .rejects.toThrow(PIECE_SOURCE_MOVED);
      await expect(
        updateOver("prepared-over-moved-delegations", "delegations"),
      ).rejects.toThrow(PIECE_SOURCE_MOVED);
    });

    it("carries its edges to the next pattern on a transition that is no source update, closing only that pattern's modules", async () => {
      const pattern = await compile("before");
      const next = await compile("after");
      const recorded = [{
        identity: "kept-module",
        predecessors: ["earlier-module"],
      }];
      const cell = await pieceRunning("delegations-carried", pattern, recorded);

      await transition(cell, next, "edit");

      expect(getPieceSourceRevisions(cell).at(-1)?.pattern).toEqual(next);
      expect(cell.getMetaRaw("pieceSourceDelegations")).toEqual({
        identity: next.identity,
        delegations: [],
        edges: stampedAt0(recorded),
      });
    });

    it("closes a module over edges for modules outside the closure only through a path from that module", async () => {
      // `pattern` reaches "middle", and through it "farthest"; "stray" is
      // outside the closure and reached from nothing in it.
      const pattern = await compile("reach");
      const edges = [
        { identity: "middle", predecessors: ["farthest"] },
        { identity: pattern.identity, predecessors: ["middle"] },
        { identity: "stray", predecessors: ["elsewhere"] },
      ];
      const cell = await pieceRunning("delegations-reach", pattern, [], edges);

      await transition(cell, pattern, "detach");

      expect(getPieceSourceDelegations(cell, pattern.identity)).toStrictEqual(
        new Map([[pattern.identity, new Set(["farthest", "middle"])]]),
      );
    });

    it("closes a module over edges that form a cycle, and ends", async () => {
      const pattern = await compile("cycle");
      const edges = [
        { identity: "one", predecessors: ["two"] },
        { identity: pattern.identity, predecessors: ["one"] },
        { identity: "two", predecessors: ["one", pattern.identity] },
      ];
      const cell = await pieceRunning("delegations-cycle", pattern, [], edges);

      await transition(cell, pattern, "detach");

      expect(getPieceSourceDelegations(cell, pattern.identity)).toStrictEqual(
        new Map([[pattern.identity, new Set(["one", "two"])]]),
      );
    });
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

  describe("a transition committed by a runtime that has not loaded the running source", () => {
    // A writer stores a piece running a pattern of two modules, the entry
    // and a module it imports. A reader that has loaded none of that
    // pattern's source documents is in the state a release pass leaves
    // once it has dropped them, which it may do between preparing a
    // transition and committing it: the preparation keeps nothing it read.

    it("verifies the running source closure inside `editWithRetry()` and commits the transition", async () => {
      const server = newSharedServer();
      const writerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const writer = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerStorage,
      });
      let readerStorage: EmulatedStorageManager | undefined;
      let reader: Runtime | undefined;
      try {
        const compiled = await writer.patternManager.compilePattern({
          main: "/main.tsx",
          files: [
            {
              name: "/main.tsx",
              contents: "import { pattern } from 'commonfabric';\n" +
                "import { label } from './label.ts';\n" +
                "export default pattern(() => ({ label }));",
            },
            {
              name: "/label.ts",
              contents: "export const label = 'running';",
            },
          ],
        }, { space: signer.did() });
        const pattern = writer.patternManager.getArtifactEntryRef(compiled)!;
        const seed = writer.edit();
        writer.getCell(signer.did(), "transition-cold-reader", undefined, seed)
          .setMetaRaw("patternIdentity", pattern, rawMetaWriteAuthorization);
        await seed.commit().settled;
        await writer.patternManager.flushCompileCacheWrites();
        await writerStorage.synced();
        await server.flushSessions();

        readerStorage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        reader = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: readerStorage,
        });
        const piece = reader.getCell(signer.did(), "transition-cold-reader");
        await piece.sync();
        const expected = getPieceSourceSnapshot(piece)!;
        const result = await reader.editWithRetry((tx) =>
          applyPieceSourceTransition(reader!, piece, tx, pattern, {
            revisionId: "detach-from-cold-reader",
            baseline: { kind: "retain", revisionId: "cold-reader-baseline" },
            timestamp: 42,
            operation: "detach",
            origin: null,
            expected,
          })
        );

        expect(result.error).toBeUndefined();
        expect(
          getPieceSourceRevisions(piece).map(({ revisionId }) => revisionId),
        ).toEqual(["cold-reader-baseline", "detach-from-cold-reader"]);
      } finally {
        await reader?.dispose();
        await writer.dispose();
        await readerStorage?.close();
        await writerStorage.close();
        await server.close();
      }
    });
  });
});
