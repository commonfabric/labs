import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  digestsOperations,
  encodeStoredCommit,
  type KeptMembers,
  omitsOperations,
  type StoredClientCommit,
  storedOperationCount,
  storedReadCounts,
  storesCommit,
} from "../v2/stored-commit.ts";
import {
  type ClientCommit,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
  ProtocolError,
  type Reference,
  toDocumentPath,
} from "../v2.ts";

/** The stored form that is the commit as submitted. */
const WHOLE: KeptMembers = { reads: true, operations: true };

/** The stored form that holds a digest in place of the reads. */
const WITHOUT_READS: KeptMembers = { reads: false, operations: true };

/** The stored form that holds a digest in place of the operations. */
const WITHOUT_OPERATIONS: KeptMembers = { reads: true, operations: false };

/** The stored form that holds a digest in place of both. */
const WITHOUT_EITHER: KeptMembers = { reads: false, operations: false };

/** A commit row holding `original`, authored at seq 2 unless told otherwise. */
const row = (original: string, rowClass = "authored", seq = 2) => ({
  original,
  class: rowClass,
  seq,
});

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

/**
 * A commit carrying every member a derived commit may carry, with a value
 * outside ASCII so that its UTF-8 length differs from its length in
 * characters.
 */
const fullCommit = (): ClientCommit => ({
  localSeq: 7,
  reads: {
    confirmed: [{
      id: "of:read",
      path: toDocumentPath(["value", "title"]),
      seq: 3,
    }],
    pending: [],
  },
  operations: [
    { op: "set", id: "of:a", value: { value: { title: "café" } } },
    {
      op: "patch",
      id: "of:b",
      patches: [{ op: "replace", path: "/value/n", value: 2 }],
    },
    { op: "delete", id: "of:c" },
  ],
  preconditions: [{ kind: "entity-absent", id: "of:d" }],
  eventAppends: [{ id: "of:stream", eventId: "evt-1" }],
  branch: "feature",
  codeCID: "bafy-code" as Reference,
});

const withOperations = (
  commit: ClientCommit,
  operations: ClientCommit["operations"],
): ClientCommit => ({ ...commit, operations });

/** `readingCommit` carrying a member the wire passes through untouched. */
const carrying = (digest: unknown): ClientCommit =>
  ({ ...readingCommit, digest }) as unknown as ClientCommit;

/** SHA-256 as unpadded base64url, by WebCrypto rather than the code under
 * test. */
const webCryptoSha256 = async (text: string): Promise<string> => {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  let binary = "";
  for (const byte of hash) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

describe("stored-commit", () => {
  describe("digestsOperations()", () => {
    it("returns `true` for a derived commit of `set`, `patch` and `delete` past seq 1", () => {
      expect(digestsOperations(fullCommit(), "derived", 2)).toBe(true);
    });

    it("returns `false` at seq 1, which the genesis receipt reads whole", () => {
      expect(digestsOperations(fullCommit(), "derived", 1)).toBe(false);
    });

    it("returns `false` for an authored or a system commit", () => {
      expect(digestsOperations(fullCommit(), "authored", 2)).toBe(false);
      expect(digestsOperations(fullCommit(), "system", 2)).toBe(false);
    });

    it("returns `false` for a commit with no operations", () => {
      expect(digestsOperations(withOperations(fullCommit(), []), "derived", 2))
        .toBe(false);
    });

    it("returns `false` for a commit carrying a `sqlite`, `apply-op` or `release-op-field` operation", () => {
      const base = fullCommit();
      for (
        const extra of [
          { op: "sqlite", db: { id: "of:db" }, sql: "SELECT 1" },
          { op: "apply-op", id: "of:a", path: ["value", "text"] },
          { op: "release-op-field", id: "of:a", path: ["value", "text"] },
        ]
      ) {
        const commit = withOperations(base, [
          ...base.operations,
          extra as never,
        ]);
        expect(digestsOperations(commit, "derived", 2)).toBe(false);
      }
    });
  });

  describe("encodeStoredCommit()", () => {
    it("returns the commit as submitted when `keeps` names both members", () => {
      expect(encodeStoredCommit(readingCommit, WHOLE)).toBe(
        encodeMemoryBoundary(readingCommit),
      );
    });

    it("returns the commit with a digest of the whole submission in place of its reads when `keeps.reads` is false", async () => {
      const whole = encodeMemoryBoundary(readingCommit);

      const stored = decodeTrustedMemoryBoundary(
        encodeStoredCommit(readingCommit, WITHOUT_READS),
      );

      expect(stored).toEqual({
        localSeq: 2,
        operations: readingCommit.operations,
        digest: {
          sha256: await webCryptoSha256(whole),
          bytes: new TextEncoder().encode(whole).length,
          confirmed: 2,
          pending: 0,
        },
      });
    });

    it("returns the commit as submitted when it carries no reads, whatever `keeps.reads` is", () => {
      const readless = commit(1, { operations: [setOp("of:doc", { n: 1 })] });

      expect(encodeStoredCommit(readless, WITHOUT_READS)).toBe(
        encodeMemoryBoundary(readless),
      );
    });

    it("returns the commit with a digest of the whole submission in place of its operations when `keeps.operations` is false", async () => {
      const full = fullCommit();
      const whole = encodeMemoryBoundary(full);
      const bytes = new TextEncoder().encode(whole).length;
      expect(bytes).toBeGreaterThan(whole.length);

      const stored = decodeTrustedMemoryBoundary(
        encodeStoredCommit(full, WITHOUT_OPERATIONS),
      );

      const { operations: _operations, ...kept } = full;
      expect(stored).toEqual({
        ...kept,
        digest: { sha256: await webCryptoSha256(whole), bytes, operations: 3 },
      });
    });

    it("returns the commit with one digest in place of its reads and its operations when `keeps` names neither", async () => {
      const full = fullCommit();
      const whole = encodeMemoryBoundary(full);

      const stored = decodeTrustedMemoryBoundary(
        encodeStoredCommit(full, WITHOUT_EITHER),
      );

      const { operations: _operations, reads: _reads, ...kept } = full;
      expect(stored).toEqual({
        ...kept,
        digest: {
          sha256: await webCryptoSha256(whole),
          bytes: new TextEncoder().encode(whole).length,
          confirmed: 1,
          pending: 0,
          operations: 3,
        },
      });
    });

    it("keeps the empty read set of a commit it stores without its operations", () => {
      const readless = commit(3, { operations: [setOp("of:doc", { n: 1 })] });

      const stored = decodeTrustedMemoryBoundary(
        encodeStoredCommit(readless, WITHOUT_EITHER),
      ) as StoredClientCommit;

      expect(stored.reads).toEqual({ confirmed: [], pending: [] });
      expect(stored.digest).toMatchObject({ operations: 1 });
      expect(stored.digest).not.toHaveProperty("confirmed");
      expect(stored.digest).not.toHaveProperty("pending");
    });
  });

  describe("storesCommit()", () => {
    it("returns true for the commit in either stored form", () => {
      expect(
        storesCommit(
          row(encodeStoredCommit(readingCommit, WHOLE)),
          readingCommit,
        ),
      ).toBe(true);
      expect(
        storesCommit(
          row(encodeStoredCommit(readingCommit, WITHOUT_READS)),
          readingCommit,
        ),
      ).toBe(true);
    });

    it("returns false for a commit whose reads differ from those the digest stands for", () => {
      const stored = row(encodeStoredCommit(readingCommit, WITHOUT_READS));
      const otherReads = {
        ...readingCommit,
        reads: {
          ...readingCommit.reads,
          confirmed: [{ ...readingCommit.reads.confirmed[0], seq: 2 }],
        },
      };

      expect(storesCommit(stored, otherReads)).toBe(false);
    });

    it("returns false for a commit whose operations differ", () => {
      const stored = row(encodeStoredCommit(readingCommit, WITHOUT_READS));
      const otherOperations = {
        ...readingCommit,
        operations: [setOp("of:other", { m: 2 })],
      };

      expect(storesCommit(stored, otherOperations)).toBe(false);
    });

    it("tells apart commits that differ only in a submitted `digest` member, which the stored form replaces", () => {
      const stored = row(encodeStoredCommit(carrying("X"), WITHOUT_READS));

      expect(storesCommit(stored, carrying("X"))).toBe(true);
      expect(storesCommit(stored, carrying("Y"))).toBe(false);
      expect(storesCommit(stored, readingCommit)).toBe(false);
    });

    it("returns false for a resubmission without a read set", () => {
      const { reads: _, ...readless } = readingCommit;

      expect(
        storesCommit(
          row(encodeStoredCommit(readingCommit, WITHOUT_READS)),
          readless as ClientCommit,
        ),
      ).toBe(false);
    });

    it("returns `true` on a derived row for the commit stored without its operations, with its reads or without them", () => {
      const full = fullCommit();

      expect(
        [WITHOUT_OPERATIONS, WITHOUT_EITHER].map((keeps) =>
          storesCommit(row(encodeStoredCommit(full, keeps), "derived"), full)
        ),
      ).toEqual([true, true]);
    });

    it("returns `false` on an authored row for the commit stored without its operations", () => {
      const full = fullCommit();

      expect(
        [WITHOUT_OPERATIONS, WITHOUT_EITHER].map((keeps) =>
          storesCommit(row(encodeStoredCommit(full, keeps), "authored"), full)
        ),
      ).toEqual([false, false]);
    });

    it("returns `false` at seq 1 for the commit stored without its operations", () => {
      const full = fullCommit();
      const stored = encodeStoredCommit(full, WITHOUT_OPERATIONS);

      expect(storesCommit(row(stored, "derived", 1), full)).toBe(false);
    });

    it("returns `false` for a commit that differs from the one stored without its operations in one value, one operation's position, the operation count or one read", () => {
      const full = fullCommit();
      const stored = row(
        encodeStoredCommit(full, WITHOUT_OPERATIONS),
        "derived",
      );
      const [set, patch, del] = full.operations;
      const variants: ClientCommit[] = [
        withOperations(full, [
          { op: "set", id: "of:a", value: { value: { title: "cafe" } } },
          patch,
          del,
        ]),
        withOperations(full, [patch, set, del]),
        withOperations(full, [set, patch]),
        {
          ...full,
          reads: {
            confirmed: [{
              id: "of:read",
              path: toDocumentPath(["value", "title"]),
              seq: 4,
            }],
            pending: [],
          },
        },
      ];

      expect(variants.map((variant) => storesCommit(stored, variant)))
        .toEqual([false, false, false, false]);
    });
  });

  describe("storedReadCounts()", () => {
    it("counts a stored commit's reads, from its read set or from its digest", () => {
      const decode = (keeps: KeptMembers) =>
        decodeTrustedMemoryBoundary(encodeStoredCommit(readingCommit, keeps));

      expect(storedReadCounts(decode(WHOLE))).toEqual({
        confirmed: 2,
        pending: 0,
        kept: true,
      });
      expect(storedReadCounts(decode(WITHOUT_READS))).toEqual({
        confirmed: 2,
        pending: 0,
        kept: false,
      });
    });

    it("returns `undefined` for a payload that is neither form", () => {
      expect(storedReadCounts({ hollowed: { bytes: 10 } })).toBeUndefined();
      expect(storedReadCounts("text")).toBeUndefined();
    });

    it("returns `undefined` for a digest of a shape the engine does not write", () => {
      const digest = (decodeTrustedMemoryBoundary(
        encodeStoredCommit(readingCommit, WITHOUT_READS),
      ) as { digest: Record<string, unknown> }).digest;
      for (
        const malformed of [
          { ...digest, confirmed: 0, pending: 0 },
          { ...digest, confirmed: -1 },
          { ...digest, pending: 1.5 },
          { ...digest, confirmed: "2" },
          { ...digest, bytes: 0 },
          { ...digest, bytes: undefined },
          { ...digest, sha256: "x" },
        ]
      ) {
        expect(storedReadCounts({ digest: malformed })).toBeUndefined();
      }
      expect(storedReadCounts({ digest })).toEqual({
        confirmed: 2,
        pending: 0,
        kept: false,
      });
    });
  });

  describe("omitsOperations()", () => {
    const decode = (commit: ClientCommit, keeps: KeptMembers) =>
      decodeTrustedMemoryBoundary(
        encodeStoredCommit(commit, keeps),
      ) as StoredClientCommit;

    it("returns `true` for a commit stored without its operations, with its reads or without them", () => {
      const full = fullCommit();

      expect(omitsOperations(decode(full, WITHOUT_OPERATIONS))).toBe(true);
      expect(omitsOperations(decode(full, WITHOUT_EITHER))).toBe(true);
    });

    it("returns `false` for a commit stored with its operations, even one carrying a `digest` member", () => {
      const full = fullCommit();
      const { digest } = decode(full, WITHOUT_OPERATIONS);

      expect(omitsOperations(decode(full, WHOLE))).toBe(false);
      expect(omitsOperations(decode(full, WITHOUT_READS))).toBe(false);
      expect(
        omitsOperations(decode({ ...full, digest } as ClientCommit, WHOLE)),
      ).toBe(false);
    });
  });

  describe("storedOperationCount()", () => {
    it("counts a stored commit's operations, from the operations or from its digest", () => {
      const full = fullCommit();
      const decode = (keeps: KeptMembers) =>
        decodeTrustedMemoryBoundary(encodeStoredCommit(full, keeps));

      expect(storedOperationCount(decode(WHOLE))).toEqual({
        operations: 3,
        kept: true,
      });
      expect(storedOperationCount(decode(WITHOUT_OPERATIONS))).toEqual({
        operations: 3,
        kept: false,
      });
      expect(storedOperationCount(decode(WITHOUT_EITHER))).toEqual({
        operations: 3,
        kept: false,
      });
    });

    it("returns `undefined` for a payload that holds neither operations nor a digest of them", () => {
      expect(storedOperationCount({ hollowed: { bytes: 10 } }))
        .toBeUndefined();
      expect(storedOperationCount("text")).toBeUndefined();
      expect(storedOperationCount(null)).toBeUndefined();
      expect(storedOperationCount([1, 2])).toBeUndefined();
      expect(storedOperationCount({ localSeq: 1, digest: "abc" }))
        .toBeUndefined();
      expect(
        storedOperationCount(decodeTrustedMemoryBoundary(
          encodeStoredCommit(readingCommit, WITHOUT_READS),
        )),
      ).toEqual({ operations: 1, kept: true });
    });

    it("returns `undefined` for a digest of a shape the engine does not write", () => {
      const digest = (decodeTrustedMemoryBoundary(
        encodeStoredCommit(fullCommit(), WITHOUT_OPERATIONS),
      ) as { digest: Record<string, unknown> }).digest;
      for (
        const malformed of [
          { ...digest, operations: 0 },
          { ...digest, operations: -1 },
          { ...digest, operations: 1.5 },
          { ...digest, operations: "3" },
          { ...digest, operations: undefined },
          { ...digest, bytes: 0 },
          { ...digest, sha256: "x" },
          { ...digest, sha256: 1 },
        ]
      ) {
        expect(storedOperationCount({ digest: malformed })).toBeUndefined();
      }
      expect(storedOperationCount({ digest })).toEqual({
        operations: 3,
        kept: false,
      });
    });
  });

  describe("applyCommit()", () => {
    let path: string;
    let engine: Engine;

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
    function installThenRead(next: ClientCommit = readingCommit): number {
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, { operations: [setOp("of:doc", { n: 1 })] }),
      });
      return applyCommit(engine, { sessionId: "s:a", commit: next }).seq;
    }

    describe("on an engine opened without `storeReadsDigest`", () => {
      beforeEach(async () => {
        path = await Deno.makeTempFile({ suffix: ".sqlite" });
        engine = await open({ url: toFileUrl(path) });
      });

      it("stores a commit's reads as a digest, the default", () => {
        const seq = installThenRead();

        expect(storedAt(seq).reads).toBeUndefined();
        expect(encodeMemoryBoundary(storedAt(seq))).toBe(
          encodeStoredCommit(readingCommit, WITHOUT_READS),
        );
      });
    });

    describe("on an engine opened with `storeReadsDigest: false`", () => {
      beforeEach(async () => {
        path = await Deno.makeTempFile({ suffix: ".sqlite" });
        engine = await open({ url: toFileUrl(path), storeReadsDigest: false });
      });

      it("stores a commit's reads as submitted", () => {
        const seq = installThenRead();

        expect(storedAt(seq).reads).toEqual(readingCommit.reads);
      });

      it("returns the stored result for a resubmission of a commit an engine storing digests wrote", async () => {
        close(engine);
        engine = await open({ url: toFileUrl(path), storeReadsDigest: true });
        const seq = installThenRead();
        expect(storedAt(seq).reads).toBeUndefined();
        close(engine);
        engine = await open({ url: toFileUrl(path), storeReadsDigest: false });

        const replay = applyCommit(engine, {
          sessionId: "s:a",
          commit: readingCommit,
        });

        expect(replay).toMatchObject({ seq, replayed: true });
      });
    });

    describe("on an engine opened with `storeReadsDigest`", () => {
      beforeEach(async () => {
        path = await Deno.makeTempFile({ suffix: ".sqlite" });
        engine = await open({ url: toFileUrl(path), storeReadsDigest: true });
      });

      it("stores a commit's reads as a digest of the whole submission", () => {
        const seq = installThenRead();

        expect(encodeMemoryBoundary(storedAt(seq))).toBe(
          encodeStoredCommit(readingCommit, WITHOUT_READS),
        );
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

      it("throws `ProtocolError` for a resubmission that differs only in a submitted `digest` member", () => {
        const seq = installThenRead(carrying("X"));

        expect(
          applyCommit(engine, { sessionId: "s:a", commit: carrying("X") }),
        ).toMatchObject({ seq, replayed: true });
        expect(() =>
          applyCommit(engine, { sessionId: "s:a", commit: carrying("Y") })
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
        // Session a installs the document, session b rewrites it, and session
        // a rewrites it to b's value from its stale view: an identity, stored
        // with a digest. Session a's next commit reads the document through
        // it.
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
        expect(storedAt(identity.seq).digest).toMatchObject({ confirmed: 1 });

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
});
