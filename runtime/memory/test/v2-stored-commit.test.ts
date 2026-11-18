import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  encodeStoredCommit,
  readsDigestOf,
  type StoredClientCommit,
  storesCommit,
} from "../v2/stored-commit.ts";
import {
  type ClientCommit,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
  ProtocolError,
  toDocumentPath,
} from "../v2.ts";

const setOp = (id: string, value: unknown) =>
  ({ op: "set", id, value: { value } }) as never;

const patchOp = (id: string, patches: unknown[]) =>
  ({ op: "patch", id, patches }) as never;

const commit = (
  localSeq: number,
  extra: Partial<ClientCommit> = {},
): ClientCommit => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: [],
  ...extra,
});

const readingCommit = commit(2, {
  reads: {
    confirmed: [
      { id: "of:doc", path: toDocumentPath(["value"]), seq: 1 },
      {
        id: "of:doc",
        path: toDocumentPath(["value", "n"]),
        seq: 1,
        nonRecursive: true,
      },
    ],
    pending: [],
  },
  operations: [setOp("of:other", { m: 1 })],
});

describe("stored-commit", () => {
  describe("encodeStoredCommit()", () => {
    it("returns the commit as submitted when `keepReads` is true", () => {
      expect(encodeStoredCommit(readingCommit, true)).toBe(
        encodeMemoryBoundary(readingCommit),
      );
    });

    it("returns the commit with a `readsDigest` in place of its reads when `keepReads` is false", () => {
      const stored = decodeTrustedMemoryBoundary(
        encodeStoredCommit(readingCommit, false),
      ) as StoredClientCommit;

      expect(stored).toEqual({
        localSeq: 2,
        operations: readingCommit.operations,
        readsDigest: readsDigestOf(readingCommit.reads),
      });
      expect(stored.readsDigest).toMatchObject({ confirmed: 2, pending: 0 });
    });

    it("returns the commit as submitted when it carries no reads, whatever `keepReads` is", () => {
      const readless = commit(1, { operations: [setOp("of:doc", { n: 1 })] });

      expect(encodeStoredCommit(readless, false)).toBe(
        encodeMemoryBoundary(readless),
      );
    });
  });

  describe("readsDigestOf()", () => {
    it("returns different hashes for read sets that differ only in a read's `seq`", () => {
      const moved = {
        ...readingCommit.reads,
        confirmed: [{ ...readingCommit.reads.confirmed[0], seq: 2 }],
      };
      const original = {
        ...readingCommit.reads,
        confirmed: [readingCommit.reads.confirmed[0]],
      };

      expect(readsDigestOf(moved).hash).not.toBe(readsDigestOf(original).hash);
    });
  });

  describe("storesCommit()", () => {
    it("returns true for the commit in either stored form", () => {
      expect(
        storesCommit(encodeStoredCommit(readingCommit, true), readingCommit),
      )
        .toBe(true);
      expect(
        storesCommit(encodeStoredCommit(readingCommit, false), readingCommit),
      ).toBe(true);
    });

    it("returns false for a commit whose reads differ from those the digest stands for", () => {
      const stored = encodeStoredCommit(readingCommit, false);
      const otherReads = {
        ...readingCommit,
        reads: {
          ...readingCommit.reads,
          confirmed: readingCommit.reads.confirmed.slice(1),
        },
      };

      expect(storesCommit(stored, otherReads)).toBe(false);
    });

    it("returns false for a commit whose operations differ", () => {
      const stored = encodeStoredCommit(readingCommit, false);
      const otherOperations = {
        ...readingCommit,
        operations: [setOp("of:other", { m: 2 })],
      };

      expect(storesCommit(stored, otherOperations)).toBe(false);
    });
  });

  describe("applyCommit()", () => {
    let path: string;
    let engine: Engine;

    beforeEach(async () => {
      path = await Deno.makeTempFile({ suffix: ".sqlite" });
      engine = await open({ url: toFileUrl(path) });
    });
    afterEach(async () => {
      close(engine);
      await Deno.remove(path);
    });

    const storedAt = (seq: number): StoredClientCommit =>
      decodeTrustedMemoryBoundary(
        engine.database.prepare(`SELECT original FROM "commit" WHERE seq = ?`)
          .get<{ original: string }>(seq)!.original,
      ) as StoredClientCommit;

    // Session a writes the document at seq 1, then reads it in its next
    // commit, which lands at seq 2.
    function installThenRead(): number {
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, { operations: [setOp("of:doc", { n: 1 })] }),
      });
      return applyCommit(engine, { sessionId: "s:a", commit: readingCommit })
        .seq;
    }

    it("stores a commit's reads as a digest", () => {
      const seq = installThenRead();

      expect(storedAt(seq)).toEqual({
        localSeq: 2,
        operations: readingCommit.operations,
        readsDigest: readsDigestOf(readingCommit.reads),
      });
    });

    it("stores the genesis receipt with its reads", () => {
      const genesis = commit(1, {
        reads: {
          confirmed: [{ id: "of:doc", path: toDocumentPath([]), seq: 0 }],
          pending: [],
        },
        operations: [setOp("of:doc", { n: 1 })],
      });

      const { seq } = applyCommit(engine, {
        sessionId: "s:a",
        commit: genesis,
      });

      expect(seq).toBe(1);
      expect(storedAt(seq).reads).toEqual(genesis.reads);
    });

    it("returns the stored result for a resubmission of a commit stored with a digest", () => {
      const seq = installThenRead();

      const replay = applyCommit(engine, {
        sessionId: "s:a",
        commit: readingCommit,
      });

      expect(replay).toMatchObject({ seq, replayed: true });
    });

    it("throws `ProtocolError` for a resubmission whose reads differ from those the digest stands for", () => {
      installThenRead();

      expect(() =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: {
            ...readingCommit,
            reads: {
              confirmed: [readingCommit.reads.confirmed[0]],
              pending: [],
            },
          },
        })
      ).toThrow(ProtocolError);
    });

    it("stores the reads of a commit whose `patch` it accepts as an identity", () => {
      // Session a appends `x` from a view that missed session b's identical
      // append, so the store elides the splice as an identity.
      const install = applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, { operations: [setOp("of:list", ["a"])] }),
      });
      const splice = patchOp("of:list", [
        { op: "splice", path: "/value", index: 1, remove: 0, add: ["x"] },
      ]);
      applyCommit(engine, {
        sessionId: "s:b",
        commit: commit(1, { operations: [splice] }),
      });
      const stale = commit(2, {
        reads: {
          confirmed: [{
            id: "of:list",
            path: toDocumentPath([]),
            seq: install.seq,
          }],
          pending: [],
        },
        operations: [splice],
      });

      const elided = applyCommit(engine, {
        sessionId: "s:a",
        elidedVerdicts: true,
        commit: stale,
      });

      expect(elided.elidedOpIndexes).toEqual([0]);
      expect(storedAt(elided.seq).reads).toEqual(stale.reads);
    });

    it("accepts a pending read through an own `set` it accepted as an identity and stored with a digest", () => {
      // Session a installs the document, session b rewrites it, and session a
      // rewrites it to b's value from its stale view: an identity, stored with
      // a digest. Session a's next commit reads the document through it.
      const install = applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, { operations: [setOp("of:doc", { n: 1 })] }),
      });
      applyCommit(engine, {
        sessionId: "s:b",
        commit: commit(1, { operations: [setOp("of:doc", { n: 2 })] }),
      });
      const identity = applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{
              id: "of:doc",
              path: toDocumentPath([]),
              seq: install.seq,
            }],
            pending: [],
          },
          operations: [setOp("of:doc", { n: 2 })],
        }),
      });
      expect(storedAt(identity.seq).readsDigest).toMatchObject({
        confirmed: 1,
      });

      const verdict = applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          reads: {
            confirmed: [],
            pending: [{
              id: "of:doc",
              path: toDocumentPath(["value", "n"]),
              localSeq: [2],
              basisSeq: 0,
            }],
          },
          operations: [setOp("of:other", { m: 1 })],
        }),
      });

      expect(verdict.revisions.map((revision) => revision.id)).toEqual([
        "of:other",
      ]);
    });
  });
});
