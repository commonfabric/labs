import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  encodeStoredCommit,
  type StoredClientCommit,
  storedReadCounts,
  storesCommit,
} from "../v2/stored-commit.ts";
import {
  type ClientCommit,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
  ProtocolError,
  toDocumentPath,
} from "../v2.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

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
  describe("encodeStoredCommit()", () => {
    it("returns the commit as submitted when `keepReads` is true", () => {
      expect(encodeStoredCommit(readingCommit, true)).toBe(
        encodeMemoryBoundary(readingCommit),
      );
    });

    it("returns the commit with a digest of the whole submission in place of its reads when `keepReads` is false", async () => {
      const whole = encodeMemoryBoundary(readingCommit);

      const stored = decodeTrustedMemoryBoundary(
        encodeStoredCommit(readingCommit, false),
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

    it("returns the commit as submitted when it carries no reads, whatever `keepReads` is", () => {
      const readless = commit(1, { operations: [setOp("of:doc", { n: 1 })] });

      expect(encodeStoredCommit(readless, false)).toBe(
        encodeMemoryBoundary(readless),
      );
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
          confirmed: [{ ...readingCommit.reads.confirmed[0], seq: 2 }],
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

    it("tells apart commits that differ only in a submitted `digest` member, which the stored form replaces", () => {
      const stored = encodeStoredCommit(carrying("X"), false);

      expect(storesCommit(stored, carrying("X"))).toBe(true);
      expect(storesCommit(stored, carrying("Y"))).toBe(false);
      expect(storesCommit(stored, readingCommit)).toBe(false);
    });

    it("returns false for a resubmission without a read set", () => {
      const { reads: _, ...readless } = readingCommit;

      expect(
        storesCommit(
          encodeStoredCommit(readingCommit, false),
          readless as ClientCommit,
        ),
      ).toBe(false);
    });
  });

  describe("storedReadCounts()", () => {
    it("counts a stored commit's reads, from its read set or from its digest", () => {
      const decode = (keepReads: boolean) =>
        decodeTrustedMemoryBoundary(
          encodeStoredCommit(readingCommit, keepReads),
        );

      expect(storedReadCounts(decode(true))).toEqual({
        confirmed: 2,
        pending: 0,
        kept: true,
      });
      expect(storedReadCounts(decode(false))).toEqual({
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
        encodeStoredCommit(readingCommit, false),
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
          encodeStoredCommit(readingCommit, false),
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
          encodeStoredCommit(readingCommit, false),
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
