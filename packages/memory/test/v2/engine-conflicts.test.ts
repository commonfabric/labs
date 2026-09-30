import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import {
  type ConfirmedRead,
  DEFAULT_BRANCH,
  type DocumentPath,
  encodeMemoryBoundary,
  type Operation,
  type PatchOp,
  type PendingRead,
  toDocumentPath,
} from "../../v2.ts";
import {
  applyCommit,
  close,
  type ConfirmedReadConflict,
  ConflictError,
  createBranch,
  type Engine,
  open,
  patchOverlapsNonRecursiveRead,
  patchOverlapsRead,
  ProtocolError,
  read,
} from "../../v2/engine.ts";
import { encodePointer } from "../../v2/path.ts";

/** Returns a path with a hole in it, which the wire decodes as encoded. */
const holeyPath = (): DocumentPath => {
  const path = ["value"];
  path.length = 2;
  return path as unknown as DocumentPath;
};

/** Each shape of read path the engine refuses, and a path of that shape. */
const malformedPaths: [shape: string, path: DocumentPath][] = [
  ["has a hole", holeyPath()],
  ["holds a segment that is not a string", [
    "value",
    0,
  ] as unknown as DocumentPath],
  ["is not an array", "value" as unknown as DocumentPath],
];

/**
 * Kinds of value the engine refuses as a position in the log, each with a value
 * of that kind.
 */
const malformedSeqs: [kind: string, seq: unknown][] = [
  ["`NaN`", NaN],
  ["`Infinity`", Infinity],
  ["negative", -1],
  ["`-0`", -0],
  ["not an integer", 0.5],
  ["past `Number.MAX_SAFE_INTEGER`", Number.MAX_SAFE_INTEGER + 1],
  ["`null`", null],
  ["a string", "abc"],
  ["a `bigint`", 1n],
];

describe("engine-conflicts", () => {
  let engine: Engine;
  let path: string;
  const sessionId = "session:conflict-diagnostics";
  const ids = Array.from({ length: 6 }, (_, index) => `of:stale-${index}`);

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    applyCommit(engine, {
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: ids.map((id) => ({
          op: "set",
          id,
          value: { value: { a: 1, b: 2 } },
        })),
      },
    });
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  const commitReads = (confirmed: ConfirmedRead[]) =>
    applyCommit(engine, {
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed, pending: [] },
        operations: [{
          op: "set",
          id: "of:output",
          value: { value: "updated" },
        }],
      },
    });

  for (
    const [count, remainder] of [[4, "1 more conflict"], [
      6,
      "3 more conflicts",
    ]] as const
  ) {
    it(`scans each of ${count} stale instances once and bounds its diagnostic`, () => {
      const staleIds = ids.slice(0, count);
      const reads = staleIds.flatMap((id) =>
        ["a", "b"].map((key, index) => ({
          id,
          scope: index === 0 ? undefined : "space" as const,
          path: toDocumentPath(["value", key]),
          seq: 0,
        }))
      );
      using scans = spy(engine.statements.selectSetDeleteConflict, "get");
      let caught: unknown;
      try {
        commitReads(reads);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      const error = caught as ConflictError;
      expect(error.conflicts).toEqual(staleIds.map((id) => ({
        of: id,
        scope: "space",
        seq: 0,
        conflictSeq: 1,
      })));
      expect(scans.calls).toHaveLength(count);
      expect(error.message).toBe(
        staleIds.slice(0, 3).map((id) =>
          `stale confirmed read: ${id} at seq 0 conflicted with seq 1`
        ).join("; ") + `; ${remainder}`,
      );
    });
  }

  it("continues scanning an instance until a stale read is found", () => {
    const read = { id: ids[0], path: toDocumentPath(["value"]), seq: 1 };
    expect(() => commitReads([read, { ...read, seq: 0 }])).toThrow(
      ConflictError,
    );
  });

  it("keeps addresses containing delimiter characters distinct", () => {
    const addresses = [
      { branch: "feature", id: "left\u0000space\u0000right" },
      { branch: "feature\u0000space\u0000left", id: "right" },
    ];
    for (const { branch } of addresses) createBranch(engine, branch);
    for (const [index, { branch, id }] of addresses.entries()) {
      applyCommit(engine, {
        sessionId: "session:delimiter-updates",
        commit: {
          localSeq: index + 1,
          branch,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id, value: { value: 1 } }],
        },
      });
    }
    let caught: unknown;
    try {
      commitReads(addresses.map((address) => ({
        ...address,
        path: toDocumentPath(["value"]),
        seq: 1,
      })));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).conflicts).toEqual(
      addresses.map(({ branch, id }, index) => ({
        of: id,
        scope: "space",
        branch,
        seq: 1,
        conflictSeq: index + 2,
      })),
    );
  });

  it("retains distinct branches while deduplicating repeated reads on each branch", () => {
    createBranch(engine, "feature");
    for (const [index, branch] of [DEFAULT_BRANCH, "feature"].entries()) {
      applyCommit(engine, {
        sessionId: "session:branch-updates",
        commit: {
          localSeq: index + 1,
          branch,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: ids[0],
            value: { value: { a: 10, b: 20 } },
          }],
        },
      });
    }
    using scans = spy(engine.statements.selectSetDeleteConflict, "get");
    let caught: unknown;
    try {
      commitReads(
        ["feature", DEFAULT_BRANCH].flatMap((branch) =>
          ["a", "b"].map((key) => ({
            id: ids[0],
            branch,
            path: toDocumentPath(["value", key]),
            seq: 1,
          }))
        ),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    const error = caught as ConflictError;
    expect(error.conflicts).toEqual([{
      of: ids[0],
      scope: "space",
      branch: "feature",
      seq: 1,
      conflictSeq: 3,
    }, {
      of: ids[0],
      scope: "space",
      seq: 1,
      conflictSeq: 2,
    }]);
    expect(error.branch).toBe("feature");
    expect(scans.calls).toHaveLength(2);
    expect(error.message).toBe(
      `stale confirmed read: ${ids[0]} at seq 1 conflicted with seq 3`,
    );
  });

  it("keeps the first stale path's sequences and skips later patch scans", () => {
    for (const [index, key] of ["a", "b"].entries()) {
      applyCommit(engine, {
        sessionId: "session:updates",
        commit: {
          localSeq: index + 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: ids[0],
            patches: [{ op: "replace", path: `/value/${key}`, value: 10 }],
          }],
        },
      });
    }
    using scans = spy(engine.statements.selectSetDeleteConflict, "get");
    using patches = spy(engine.statements.selectPatchConflicts, "iter");
    let caught: unknown;
    try {
      commitReads(["b", "a"].map((key) => ({
        id: ids[0],
        path: toDocumentPath(["value", key]),
        seq: 1,
      })));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).conflicts).toEqual([{
      of: ids[0],
      scope: "space",
      seq: 1,
      conflictSeq: 3,
    }]);
    expect(scans.calls).toHaveLength(1);
    expect(patches.calls).toHaveLength(1);
  });

  for (const kind of ["confirmed", "pending"] as const) {
    for (const malformed of [false, true]) {
      const failure = malformed
        ? "failing to decode patches for a"
        : "rejecting a stale";
      it(`accepts a commit after ${failure} ${kind} read and another connection writes`, async () => {
        const other = await open({ url: toFileUrl(path) });
        try {
          for (const localSeq of [1, 2]) {
            applyCommit(engine, {
              sessionId: "session:updates",
              commit: {
                localSeq,
                reads: { confirmed: [], pending: [] },
                operations: [{
                  op: "patch",
                  id: ids[0],
                  patches: [{
                    op: "replace",
                    path: "/value/a",
                    value: localSeq + 10,
                  }],
                }],
              },
            });
          }
          if (malformed) {
            engine.database.exec(
              "UPDATE revision SET data = NULL WHERE id = ? AND op = 'patch'",
              ids[0],
            );
          }
          const stale = { id: ids[0], path: toDocumentPath(["value", "a"]) };
          expect(() =>
            applyCommit(engine, {
              sessionId,
              commit: {
                localSeq: 2,
                reads: {
                  confirmed: kind === "confirmed" ? [{ ...stale, seq: 1 }] : [],
                  pending: kind === "pending"
                    ? [{ ...stale, basisSeq: 1, localSeq: [1] }]
                    : [],
                },
                operations: [{
                  op: "set",
                  id: "of:output",
                  value: { value: "rejected" },
                }],
              },
            })
          ).toThrow(
            malformed
              ? "memory v2 stored patches must carry a payload"
              : ConflictError,
          );
          expect(engine.database.inTransaction).toBe(false);

          // Advancing the WAL from another connection makes any read snapshot
          // retained by the rejected commit too old to upgrade to a writer.
          const intervening = applyCommit(other, {
            sessionId: "session:other-connection",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: "of:other-output",
                value: { value: "intervening" },
              }],
            },
          });
          expect(commitReads([]).seq).toBe(intervening.seq + 1);
          expect(read(other, { id: "of:output" })).toEqual({
            value: "updated",
          });
        } finally {
          close(other);
        }
      });
    }
  }

  for (const invalidFirst of [false, true]) {
    it(`rejects an unknown branch ${invalidFirst ? "before" : "after"} a stale read without reporting a retryable conflict`, () => {
      const stale = { id: ids[0], path: toDocumentPath(["value"]), seq: 0 };
      const invalid = { ...stale, branch: "missing" };
      const reads = invalidFirst ? [invalid, stale] : [stale, invalid];
      let caught: unknown;
      try {
        commitReads(reads);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(ConflictError);
      expect(caught).toHaveProperty("message", "unknown branch: missing");
    });

    for (const scope of ["user", "session"] as const) {
      it(`rejects unresolvable ${scope} scope ${invalidFirst ? "before" : "after"} a stale read`, () => {
        const stale = { id: ids[0], path: toDocumentPath(["value"]), seq: 0 };
        const invalid = { ...stale, scope };
        const reads = invalidFirst ? [invalid, stale] : [stale, invalid];
        expect(() => commitReads(reads)).toThrow(ProtocolError);
      });
    }

    for (const [shape, path] of malformedPaths) {
      it(`throws \`ProtocolError\` for a read whose path ${shape} ${invalidFirst ? "before" : "after"} a stale read`, () => {
        const stale = { id: ids[0], path: toDocumentPath(["value"]), seq: 0 };
        const invalid = { ...stale, path };
        const reads = invalidFirst ? [invalid, stale] : [stale, invalid];
        expect(() => commitReads(reads)).toThrow(ProtocolError);
      });
    }
  }

  it("applies a commit whose confirmed read names `Number.MAX_SAFE_INTEGER`, past the head", () => {
    const read = { id: ids[0], path: toDocumentPath(["value"]) };
    expect(commitReads([{ ...read, seq: Number.MAX_SAFE_INTEGER }]).seq)
      .toBe(2);
  });

  for (const [kind, seq] of [...malformedSeqs, ["`undefined`", undefined]]) {
    it(`throws \`ProtocolError\` for a read whose \`seq\` is ${kind} after a stale read`, () => {
      const stale = { id: ids[0], path: toDocumentPath(["value"]), seq: 0 };
      expect(() => commitReads([stale, { ...stale, seq: seq as number }]))
        .toThrow(ProtocolError);
    });
  }

  it("throws `ProtocolError` for a pending read whose path holds a segment that is not a string", () => {
    const sessionId = "session:malformed-pending";
    applyCommit(engine, {
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: ids[0],
          patches: [{ op: "replace", path: "/value/a", value: 10 }],
        }],
      },
    });
    expect(() =>
      applyCommit(engine, {
        sessionId,
        commit: {
          localSeq: 2,
          reads: {
            confirmed: [],
            pending: [{
              id: ids[0],
              path: ["value", 0] as unknown as DocumentPath,
              localSeq: [1],
              basisSeq: 1,
            }],
          },
          operations: [{ op: "set", id: "of:output", value: { value: 1 } }],
        },
      })
    ).toThrow(ProtocolError);
  });

  it("throws `ProtocolError` for a pending read whose path is not an array behind a stale confirmed read", () => {
    const stale = { id: ids[0], path: toDocumentPath(["value"]), seq: 0 };
    expect(() =>
      applyCommit(engine, {
        sessionId,
        commit: {
          localSeq: 2,
          reads: {
            confirmed: [stale],
            pending: [{
              id: ids[1],
              path: "value" as unknown as DocumentPath,
              localSeq: 1,
            }],
          },
          operations: [{ op: "set", id: "of:output", value: { value: 1 } }],
        },
      })
    ).toThrow(ProtocolError);
  });

  it("accepts a shallow read of a container whose key a writer with an older base re-created", () => {
    // INV-2 in `docs/specs/memory-v2/09-invariants.md` lists this accept as a
    // known deviation, and `08-conflict-granularity.md` §2 says why: whether a
    // patch changes a key set is its writer's call, made from the writer's
    // base, and a base still holding a key removed since reports the key's
    // re-creation as a plain `replace`, which injects no parent. The case
    // pins the accept, so that recording key creation where it happens turns
    // it into the conflict it should be.

    const id = ids[0];
    const removal = applyCommit(engine, {
      sessionId: "session:remover",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{ op: "remove", path: "/value/b" }],
        }],
      },
    }).seq;
    applyCommit(engine, {
      sessionId: "session:older-base",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{ op: "replace", path: "/value/b", value: 3 }],
        }],
      },
    });
    expect(read(engine, { id })).toEqual({ value: { a: 1, b: 3 } });
    expect(() =>
      commitReads([{
        id,
        path: toDocumentPath(["value"]),
        seq: removal,
        nonRecursive: true,
      }])
    ).not.toThrow();
  });

  describe("a pending read's `basisSeq` and `localSeq`", () => {
    // Each read names this session's first commit as its one layer, unless
    // the case overrides `localSeq`. A case run behind a stale confirmed read
    // shows the pending read is refused before any read's staleness is
    // decided, since the stale read alone reports a conflict.

    /**
     * Commits a pending read of `ids[0]` with `fields` over its defaults,
     * beside `confirmed`.
     */
    const commitPendingRead = (
      fields: Partial<PendingRead>,
      confirmed: ConfirmedRead[] = [],
    ) =>
      applyCommit(engine, {
        sessionId,
        commit: {
          localSeq: 2,
          reads: {
            confirmed,
            pending: [{
              id: ids[0],
              path: toDocumentPath(["value"]),
              localSeq: 1,
              ...fields,
            }],
          },
          operations: [{ op: "set", id: "of:output", value: { value: 1 } }],
        },
      });

    const stale = { id: ids[1], path: toDocumentPath(["value"]), seq: 0 };

    it("applies a commit whose pending read has a `basisSeq` of `0`", () => {
      expect(commitPendingRead({ basisSeq: 0 }).seq).toBe(2);
    });

    it("throws `ProtocolError` for a pending read whose `basisSeq` is `-0`", () => {
      expect(() => commitPendingRead({ basisSeq: -0 })).toThrow(ProtocolError);
    });

    it("throws `ProtocolError` for a pending read whose `basisSeq` is `NaN` behind a stale confirmed read", () => {
      expect(() => commitPendingRead({ basisSeq: NaN }, [stale]))
        .toThrow(ProtocolError);
    });

    it("throws `ProtocolError` for a pending read whose `localSeq` is `-0`", () => {
      expect(() => commitPendingRead({ localSeq: -0 })).toThrow(ProtocolError);
    });

    it("throws `ProtocolError` for a pending read whose `localSeq` holds `-0` after a layer that resolves", () => {
      expect(() => commitPendingRead({ localSeq: [1, -0] }))
        .toThrow(ProtocolError);
    });

    it("throws `ProtocolError` for a pending read whose `localSeq` is `-0` behind a stale confirmed read", () => {
      expect(() => commitPendingRead({ localSeq: -0 }, [stale]))
        .toThrow(ProtocolError);
    });
  });

  describe("reads sharing a conflict scan", () => {
    // A commit's reads of one document at one basis and exclusion share one
    // scan of the revisions after that basis. Each case pins something the
    // sharing could get wrong: work that must not grow with the number of
    // reads, a read decided from revisions another read indexed, and reads
    // whose basis or exclusion differs, which must not share at all.

    const id = ids[0];

    // A read that none of the writes below touches, or injects a parent
    // above: a conflict the commit reports is never this read's. The report
    // names the document and not the read, so that is what lets a case
    // holding it attribute a conflict to its other read.
    const untouched = { id, path: toDocumentPath(["untouched"]) };

    /** Commits `operation` as write `localSeq` of another session. */
    const write = (localSeq: number, operation: Operation): number =>
      applyCommit(engine, {
        sessionId: "session:writer",
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [operation],
        },
      }).seq;

    /** Like `write()`, for a patch of `id` holding `patch` alone. */
    const writePatch = (localSeq: number, patch: PatchOp): number =>
      write(localSeq, { op: "patch", id, patches: [patch] });

    /** Returns the conflicts a commit of `reads` reports, or `[]`. */
    const conflictsOf = (
      reads: ConfirmedRead[],
    ): readonly ConfirmedReadConflict[] => {
      try {
        commitReads(reads);
      } catch (error) {
        if (error instanceof ConflictError) return error.conflicts ?? [];
        throw error;
      }
      return [];
    };

    /** Returns the conflict a read of `id` at seq `1` reports at `seq`. */
    const conflictAt = (seq: number): ConfirmedReadConflict[] => [
      { of: id, scope: "space", seq: 1, conflictSeq: seq },
    ];

    /**
     * Commits `readCount` confirmed reads, each of a key of its own, over
     * `revised` other keys of the same map replaced in one revision after
     * their basis, and returns what validating the commit parsed. `documents`
     * counts `JSON.parse()` calls, which a revision's payload takes one of
     * each time it is decoded, and `pointers` counts `String.prototype.split()`
     * calls, which a touched path takes one of each time it is parsed from a
     * JSON Pointer.
     */
    const raceDisjointKeys = (
      readCount: number,
      revised: number,
    ): { documents: number; pointers: number } => {
      const map = `of:race-${readCount}-${revised}`;
      const keys = Array.from(
        { length: revised + readCount },
        (_, index) => `k${index}`,
      );
      const sessionId = `session:race-${readCount}-${revised}`;
      const basis = applyCommit(engine, {
        sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: map,
            value: { value: Object.fromEntries(keys.map((key) => [key, 0])) },
          }],
        },
      }).seq;
      if (revised > 0) {
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: map,
              patches: keys.slice(0, revised).map((key) => ({
                op: "replace",
                path: `/value/${key}`,
                value: 1,
              })),
            }],
          },
        });
      }
      using documents = spy(JSON, "parse");
      using pointers = spy(String.prototype, "split");
      applyCommit(engine, {
        sessionId: `${sessionId}-reader`,
        commit: {
          localSeq: 1,
          reads: {
            confirmed: keys.slice(revised).map((key) => ({
              id: map,
              path: toDocumentPath(["value", key]),
              seq: basis,
            })),
            pending: [],
          },
          operations: [{ op: "set", id: map + "-output", value: { value: 1 } }],
        },
      });
      return {
        documents: documents.calls.length,
        pointers: pointers.calls.length,
      };
    };

    /**
     * Returns what a revision of 100 ops costs a commit of `readCount` reads
     * to validate: the counts `raceDisjointKeys()` returns with the revision,
     * less those without it.
     */
    const revisionWork = (
      readCount: number,
    ): { documents: number; pointers: number } => {
      const withRevision = raceDisjointKeys(readCount, 100);
      const without = raceDisjointKeys(readCount, 0);
      return {
        documents: withRevision.documents - without.documents,
        pointers: withRevision.pointers - without.pointers,
      };
    };

    it("parses the intervening revision the same number of times for 100 reads as for 10", () => {
      const short = revisionWork(10);
      const long = revisionWork(100);

      // Whatever else the commit path parses, per read or not, it parses with
      // the revision and without it alike, so the difference is the
      // revision's alone. The revision is the same size in both runs, so a
      // count that grew with the reads differs between them. The floors show
      // the reads reached the revision at all: every one of its 100 pointers
      // was parsed.
      expect(long.documents).toBe(short.documents);
      expect(short.documents).toBeGreaterThan(0);
      expect(long.pointers).toBe(short.pointers);
      expect(short.pointers).toBeGreaterThanOrEqual(100);
    });

    it("runs each conflict statement once for many reads of one document at one basis", () => {
      writePatch(1, { op: "replace", path: "/value/a", value: 10 });
      using setOrDelete = spy(engine.statements.selectSetDeleteConflict, "get");
      using patches = spy(engine.statements.selectPatchConflicts, "iter");
      const reads = ["b", "c", "d", "e"].map((key) => ({
        id,
        path: toDocumentPath(["value", key]),
        seq: 1,
      }));
      expect(conflictsOf(reads)).toEqual([]);
      expect(setOrDelete.calls).toHaveLength(1);
      expect(patches.calls).toHaveLength(1);
    });

    it("runs no patch statement when a `set` follows the basis", () => {
      const set = write(1, { op: "set", id, value: { value: { a: 5 } } });
      using patches = spy(engine.statements.selectPatchConflicts, "iter");
      expect(conflictsOf([untouched].map((read) => ({ ...read, seq: 1 }))))
        .toEqual(conflictAt(set));
      expect(patches.calls).toHaveLength(0);
    });

    it("runs one patch statement for reads at several bases when the earliest comes first", () => {
      const seqs = [1, 2, 3, 4].map((localSeq) =>
        writePatch(localSeq, {
          op: "replace",
          path: "/value/a",
          value: localSeq,
        })
      );
      using patches = spy(engine.statements.selectPatchConflicts, "iter");
      expect(
        conflictsOf([
          { ...untouched, seq: 1 },
          ...seqs.slice(0, 3).map((seq) => ({ ...untouched, seq })),
          { id, path: toDocumentPath(["value", "a"]), seq: seqs[1] },
        ]),
      ).toEqual([{
        of: id,
        scope: "space",
        seq: seqs[1],
        conflictSeq: seqs[3],
      }]);
      expect(patches.calls).toHaveLength(1);
    });

    it("scans again for a read at an earlier basis, and decides reads at later bases from that scan", () => {
      const seqs = [1, 2, 3].map((localSeq) =>
        writePatch(localSeq, {
          op: "replace",
          path: "/value/a",
          value: localSeq,
        })
      );
      using patches = spy(engine.statements.selectPatchConflicts, "iter");
      expect(
        conflictsOf([
          { ...untouched, seq: seqs[1] },
          { ...untouched, seq: 1 },
          { ...untouched, seq: seqs[0] },
          { ...untouched, seq: seqs[2] },
        ]),
      ).toEqual([]);
      expect(patches.calls).toHaveLength(2);
    });

    it("runs one patch statement for pending reads naming the same layers in another order", () => {
      const sessionId = "session:layer-order";
      for (
        const [localSeq, path] of [[1, "/value/a"], [2, "/value/b"]] as const
      ) {
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id,
              patches: [{ op: "replace", path, value: localSeq }],
            }],
          },
        });
      }
      using patches = spy(
        engine.statements.selectPatchConflictsExcludingSession,
        "iter",
      );
      applyCommit(engine, {
        sessionId,
        commit: {
          localSeq: 3,
          reads: {
            confirmed: [],
            pending: [[1, 2], [2, 1], [2, 1, 2]].map((localSeq) => ({
              id,
              path: toDocumentPath(["value", "b"]),
              localSeq,
              basisSeq: 1,
            })),
          },
          operations: [{ op: "set", id: "of:output", value: { value: 1 } }],
        },
      });
      expect(patches.calls).toHaveLength(1);
    });

    it("reports a conflict with the newest `set` after the basis where a newer patch also conflicts with the read", () => {
      const set = write(1, { op: "set", id, value: { value: { a: 5 } } });
      writePatch(2, { op: "replace", path: "/value/a", value: 10 });
      expect(
        conflictsOf([{ id, path: toDocumentPath(["value", "a"]), seq: 1 }]),
      )
        .toEqual(conflictAt(set));
    });

    it("reports a conflict with an older revision after another read indexed a newer one", () => {
      const older = writePatch(1, {
        op: "replace",
        path: "/value/a",
        value: 10,
      });
      writePatch(2, { op: "replace", path: "/value/b", value: 20 });
      expect(
        conflictsOf([
          { ...untouched, seq: 1 },
          { id, path: toDocumentPath(["value", "a"]), seq: 1 },
        ]),
      ).toEqual(conflictAt(older));
    });

    it("decodes no revision older than the newest one a read conflicts with", () => {
      const older = writePatch(1, {
        op: "replace",
        path: "/value/a",
        value: 10,
      });
      const newer = writePatch(2, {
        op: "replace",
        path: "/value/b",
        value: 20,
      });
      engine.database.exec(
        "UPDATE revision SET data = NULL WHERE id = ? AND seq = ?",
        id,
        older,
      );
      expect(
        conflictsOf([{ id, path: toDocumentPath(["value", "b"]), seq: 1 }]),
      )
        .toEqual(conflictAt(newer));

      // A read the newer revision does not conflict with reaches the older
      // one, which is what shows that one fails to decode.
      expect(() => commitReads([{ ...untouched, seq: 1 }])).toThrow(
        "memory v2 stored patches must carry a payload",
      );
    });

    it("computes the paths of no op of a revision after the op a read conflicts with", () => {
      const revision = writePatch(1, {
        op: "replace",
        path: "/value/a",
        value: 10,
      });
      engine.database.exec(
        "UPDATE revision SET data = ? WHERE id = ? AND seq = ?",
        encodeMemoryBoundary([
          { op: "replace", path: "/value/a", value: 10 },
          { op: "retired", path: "/value/b" },
        ]),
        id,
        revision,
      );
      expect(
        conflictsOf([{ id, path: toDocumentPath(["value", "a"]), seq: 1 }]),
      )
        .toEqual(conflictAt(revision));

      // A read the first op does not conflict with reaches the second, which
      // is what shows that one has no paths to compute.
      expect(() => commitReads([{ ...untouched, seq: 1 }])).toThrow(TypeError);
    });

    it("reports a conflict for a read whose earlier basis reaches a revision a later basis does not", () => {
      const first = writePatch(1, {
        op: "replace",
        path: "/value/a",
        value: 10,
      });
      writePatch(2, { op: "replace", path: "/value/b", value: 20 });
      const read = { id, path: toDocumentPath(["value", "a"]) };
      expect(conflictsOf([{ ...read, seq: first }, { ...read, seq: 1 }]))
        .toEqual(conflictAt(first));
    });

    it("reports no conflict for a read whose later basis is past a revision an earlier basis reaches", () => {
      const first = writePatch(1, {
        op: "replace",
        path: "/value/a",
        value: 10,
      });
      writePatch(2, { op: "replace", path: "/value/b", value: 20 });
      expect(
        conflictsOf([
          { ...untouched, seq: 1 },
          { id, path: toDocumentPath(["value", "a"]), seq: first },
        ]),
      ).toEqual([]);
    });

    it("reports a conflict for a pending read that names fewer of its session's layers than an earlier read of the document", () => {
      const sessionId = "session:layers";
      const layer = (localSeq: number, patch: PatchOp): number =>
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "patch", id, patches: [patch] }],
          },
        }).seq;
      layer(1, { op: "replace", path: "/value/a", value: 10 });
      const second = layer(2, { op: "replace", path: "/value/b", value: 20 });

      // Naming both layers excludes both writes, so the first read conflicts
      // with nothing. The second names only the first layer, so the write of
      // the second conflicts with it as another session's would.
      const read = (localSeq: number[]) => ({
        id,
        path: toDocumentPath(["value", "b"]),
        localSeq,
        basisSeq: 1,
      });
      let caught: unknown;
      try {
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [read([1, 2]), read([1])] },
            operations: [{
              op: "set",
              id: "of:output",
              value: { value: "updated" },
            }],
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).conflicts).toEqual(conflictAt(second));
    });

    describe("read kinds", () => {
      // Each case is decided once with the read ahead of a read that
      // conflicts with nothing, so that it indexes the revision itself, and
      // once behind it, so that it is decided from what the other indexed.

      const replaceA: PatchOp = { op: "replace", path: "/value/a", value: 10 };
      const addC: PatchOp = { op: "add", path: "/value/c", value: 3 };
      const cases: {
        patch: PatchOp;
        path: string[];
        nonRecursive: boolean;
        conflicts: boolean;
      }[] = [
        {
          patch: replaceA,
          path: ["value", "a"],
          nonRecursive: false,
          conflicts: true,
        },
        {
          patch: replaceA,
          path: ["value"],
          nonRecursive: false,
          conflicts: true,
        },
        {
          patch: replaceA,
          path: ["value", "a", "x"],
          nonRecursive: false,
          conflicts: true,
        },
        {
          patch: replaceA,
          path: ["value", "b"],
          nonRecursive: false,
          conflicts: false,
        },
        {
          patch: addC,
          path: ["value", "b"],
          nonRecursive: false,
          conflicts: false,
        },
        { patch: addC, path: ["value"], nonRecursive: true, conflicts: true },
        {
          patch: replaceA,
          path: ["value"],
          nonRecursive: true,
          conflicts: false,
        },
        {
          patch: replaceA,
          path: ["value", "a"],
          nonRecursive: true,
          conflicts: true,
        },
        {
          patch: replaceA,
          path: ["value", "a", "x"],
          nonRecursive: true,
          conflicts: true,
        },
      ];

      for (const { patch, path, nonRecursive, conflicts } of cases) {
        for (const behind of [false, true]) {
          it(
            `reports ${conflicts ? "a" : "no"} conflict for a ${
              nonRecursive ? "shallow" : "recursive"
            } read of \`${
              encodePointer(path)
            }\` after \`${patch.op}\` at \`${patch.path}\`, ${
              behind ? "behind" : "ahead of"
            } a read that conflicts with nothing`,
            () => {
              const seq = writePatch(1, patch);
              const read = {
                id,
                path: toDocumentPath(path),
                seq: 1,
                ...(nonRecursive ? { nonRecursive } : {}),
              };
              const other = { ...untouched, seq: 1 };
              expect(conflictsOf(behind ? [other, read] : [read, other]))
                .toEqual(conflicts ? conflictAt(seq) : []);
            },
          );
        }
      }
    });
  });

  describe("`patchOverlapsRead()` and `patchOverlapsNonRecursiveRead()`", () => {
    // The engine decides a read from an index of touched paths rather than by
    // calling these, which stay the definition of a patch conflict: the state
    // inspector replays them over a stored history. This holds the engine to
    // them for every read path to depth three over the keys below, against
    // revisions of every op kind — the table is checked against the op
    // union, so a kind added to it fails to compile here until it has a
    // revision — including a `move` between subtrees, a `splice` inside an
    // array, the ops that can create their key, and a revision of two ops.

    const base = { a: { x: 1 }, b: [1, 2], c: 3 };
    const revisionsByKind = {
      replace: [
        [{ op: "replace", path: "/value/a/x", value: 2 }],
        [{ op: "replace", path: "/value/a", value: { z: 1 } }],
        [{ op: "replace", path: "/value", value: { q: 1 } }],
      ],
      add: [
        [{ op: "add", path: "/value/d", value: 4 }],
        [{ op: "add", path: "/value/a/y", value: 1 }],
      ],
      remove: [[{ op: "remove", path: "/value/c" }]],
      move: [
        [{ op: "move", from: "/value/a", path: "/value/e" }],
        [{ op: "move", from: "/value/b/0", path: "/value/a/w" }],
      ],
      splice: [
        [{ op: "splice", path: "/value/b", index: 0, remove: 1, add: [] }],
        [{ op: "splice", path: "/value/b", index: 1, remove: 0, add: [7] }],
      ],
      append: [
        [{ op: "append", path: "/value/b", values: [3] }],
        [{ op: "append", path: "/value/f", values: [1], createsKey: true }],
      ],
      "add-unique": [
        [{ op: "add-unique", path: "/value/b", values: [9] }],
        [{ op: "add-unique", path: "/value/h", values: [1], createsKey: true }],
      ],
      "remove-by-value": [
        [{ op: "remove-by-value", path: "/value/b", value: 1 }],
      ],
      increment: [
        [{ op: "increment", path: "/value/c", by: 1 }],
        [{ op: "increment", path: "/value/g", by: 1, createsKey: true }],
      ],
    } satisfies Record<PatchOp["op"], PatchOp[][]>;
    const revisions: PatchOp[][] = [
      ...Object.values(revisionsByKind).flat(),
      [
        { op: "replace", path: "/value/a/x", value: 2 },
        { op: "add", path: "/value/d", value: 4 },
      ],
    ];
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const paths = [
      [],
      ["value"],
      ...keys.map((key) => ["value", key]),
      ...keys.flatMap((key) =>
        ["x", "w", "0", "1"].map((below) => ["value", key, below])
      ),
    ];

    it("reports a conflict for exactly the reads each predicate matches, for every read path against every revision", () => {
      const sessionId = "session:corpus";
      const basis = applyCommit(engine, {
        sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: revisions.map((_, index) => ({
            op: "set",
            id: `of:corpus-${index}`,
            value: { value: base },
          })),
        },
      }).seq;
      const seqs = revisions.map((patches, index) =>
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq: index + 2,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "patch", id: `of:corpus-${index}`, patches }],
          },
        }).seq
      );

      const expected = [];
      const actual = [];
      let localSeq = 0;
      for (const [index, patches] of revisions.entries()) {
        const id = `of:corpus-${index}`;
        for (const path of paths) {
          for (const nonRecursive of [false, true]) {
            const matches = nonRecursive
              ? patchOverlapsNonRecursiveRead(patches, path)
              : patchOverlapsRead(patches, path);
            expected.push({
              id,
              path,
              nonRecursive,
              conflictSeq: matches ? seqs[index] : undefined,
            });
            let conflictSeq: number | undefined;
            try {
              localSeq++;
              applyCommit(engine, {
                sessionId: "session:corpus-reader",
                commit: {
                  localSeq,
                  reads: {
                    confirmed: [{
                      id,
                      path: toDocumentPath(path),
                      seq: basis,
                      ...(nonRecursive ? { nonRecursive } : {}),
                    }],
                    pending: [],
                  },
                  operations: [{
                    op: "set",
                    id: "of:corpus-output",
                    value: { value: localSeq },
                  }],
                },
              });
            } catch (error) {
              if (!(error instanceof ConflictError)) throw error;
              conflictSeq = error.conflictSeq;
            }
            actual.push({ id, path, nonRecursive, conflictSeq });
          }
        }
      }
      expect(actual).toEqual(expected);

      // Each predicate matches some reads and not others, so the equality
      // turns on which, and not on an outcome every read shares.
      for (const nonRecursive of [false, true]) {
        const outcomes = expected.filter((entry) =>
          entry.nonRecursive === nonRecursive
        );
        expect(outcomes.some((entry) => entry.conflictSeq === undefined))
          .toBe(true);
        expect(outcomes.some((entry) => entry.conflictSeq !== undefined))
          .toBe(true);
      }
    });
  });
});
