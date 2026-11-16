import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { toUnpaddedBase64url } from "@commonfabric/bytes/base64url";
import { sha256 } from "@commonfabric/content-hash";

import {
  digestedPayloadOf,
  isDigestEligible,
  payloadDigest,
  storedPayloadMatches,
} from "../../v2/commit-payload.ts";
import {
  type ClientCommit,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
  type Reference,
  toDocumentPath,
} from "../../v2.ts";

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

const digestedOf = (commit: ClientCommit): string =>
  digestedPayloadOf(commit, encodeMemoryBoundary(commit));

const withOperations = (
  commit: ClientCommit,
  operations: ClientCommit["operations"],
): ClientCommit => ({ ...commit, operations });

describe("commit-payload", () => {
  describe("isDigestEligible()", () => {
    it("returns `true` for a derived commit of `set`, `patch` and `delete` past seq 1", () => {
      expect(isDigestEligible(fullCommit(), "derived", 2)).toBe(true);
    });

    it("returns `false` at seq 1, which the genesis receipt reads whole", () => {
      expect(isDigestEligible(fullCommit(), "derived", 1)).toBe(false);
    });

    it("returns `false` for an authored or a system commit", () => {
      expect(isDigestEligible(fullCommit(), "authored", 2)).toBe(false);
      expect(isDigestEligible(fullCommit(), "system", 2)).toBe(false);
    });

    it("returns `false` for a commit with no operations", () => {
      expect(isDigestEligible(withOperations(fullCommit(), []), "derived", 2))
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
        expect(isDigestEligible(commit, "derived", 2)).toBe(false);
      }
    });
  });

  describe("digestedPayloadOf()", () => {
    it("keeps every member but `operations`, and digests the whole encoding", () => {
      const commit = fullCommit();
      const encoded = encodeMemoryBoundary(commit);
      const utf8 = new TextEncoder().encode(encoded);
      expect(utf8.length).toBeGreaterThan(encoded.length);

      const stored = decodeTrustedMemoryBoundary(
        digestedPayloadOf(commit, encoded),
      );

      const { operations: _operations, ...kept } = commit;
      expect(stored).toEqual({
        ...kept,
        digest: {
          sha256: toUnpaddedBase64url(sha256(utf8)),
          bytes: utf8.length,
          operations: 3,
        },
      });
    });
  });

  describe("payloadDigest()", () => {
    it("returns the digest of a digested payload that carries `branch` and `codeCID`", () => {
      const commit = fullCommit();
      const stored = digestedOf(commit);
      expect(stored.indexOf('"branch"')).toBeLessThan(
        stored.indexOf('"digest"'),
      );

      const digest = payloadDigest(decodeTrustedMemoryBoundary(stored));

      expect(digest?.operations).toBe(3);
      expect(digest?.bytes).toBe(
        new TextEncoder().encode(encodeMemoryBoundary(commit)).length,
      );
    });

    it("returns `undefined` for a whole commit, even one carrying a `digest` member", () => {
      const commit = fullCommit();
      const digest = payloadDigest(
        decodeTrustedMemoryBoundary(digestedOf(commit)),
      );

      expect(payloadDigest(decodeTrustedMemoryBoundary(
        encodeMemoryBoundary(commit),
      ))).toBeUndefined();
      expect(payloadDigest(
        decodeTrustedMemoryBoundary(
          encodeMemoryBoundary({ ...commit, digest } as never),
        ),
      )).toBeUndefined();
    });

    it("returns `undefined` for a payload that is not an object or has no `digest` object", () => {
      expect(payloadDigest(null)).toBeUndefined();
      expect(payloadDigest([1, 2])).toBeUndefined();
      expect(payloadDigest({ localSeq: 1, digest: "abc" })).toBeUndefined();
    });

    it("throws for a `digest` whose members are not a hash string and two counts", () => {
      expect(() =>
        payloadDigest({ digest: { sha256: "x", bytes: -1, operations: 1 } })
      ).toThrow("non-negative integer");
      expect(() =>
        payloadDigest({ digest: { sha256: 1, bytes: 1, operations: 1 } })
      ).toThrow("`sha256` string");
    });
  });

  describe("storedPayloadMatches()", () => {
    const row = (original: string, rowClass = "derived") => ({
      original,
      class: rowClass,
      seq: 2,
    });
    const matches = (stored: string, commit: ClientCommit, rowClass?: string) =>
      storedPayloadMatches(
        row(stored, rowClass),
        commit,
        encodeMemoryBoundary(commit),
      );

    it("returns `true` for the whole encoding of the commit, on any class", () => {
      const commit = fullCommit();
      const whole = encodeMemoryBoundary(commit);
      expect(matches(whole, commit)).toBe(true);
      expect(matches(whole, commit, "authored")).toBe(true);
    });

    it("returns `true` for the digested payload of the commit on a derived row", () => {
      const commit = fullCommit();
      expect(matches(digestedOf(commit), commit)).toBe(true);
    });

    it("returns `false` for the digested payload of the commit on an authored row", () => {
      const commit = fullCommit();
      expect(matches(digestedOf(commit), commit, "authored")).toBe(false);
    });

    it("returns `false` for the digested payload of the commit at seq 1", () => {
      const commit = fullCommit();
      expect(
        storedPayloadMatches(
          { original: digestedOf(commit), class: "derived", seq: 1 },
          commit,
          encodeMemoryBoundary(commit),
        ),
      ).toBe(false);
    });

    it("returns `false` when one value, one operation's position, the operation count or one read differs", () => {
      const commit = fullCommit();
      const stored = digestedOf(commit);
      const [set, patch, del] = commit.operations;
      const variants: ClientCommit[] = [
        withOperations(commit, [
          { op: "set", id: "of:a", value: { value: { title: "cafe" } } },
          patch,
          del,
        ]),
        withOperations(commit, [patch, set, del]),
        withOperations(commit, [set, patch]),
        {
          ...commit,
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

      expect(variants.map((variant) => matches(stored, variant))).toEqual([
        false,
        false,
        false,
        false,
      ]);
    });
  });
});
