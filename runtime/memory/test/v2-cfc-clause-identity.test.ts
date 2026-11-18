import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  cfcCanonicalClauseDigest,
  compareByCanonicalHash,
  normalizeClause,
  uniqueCfcAtoms,
} from "../v2/cfc-clause-identity.ts";

const user = (subject: string) => ({ type: "User", subject });

describe("cfc-clause-identity", () => {
  describe("uniqueCfcAtoms()", () => {
    it("keeps the first spelling of each atom, in arrival order", () => {
      const first = user("did:a");
      const clone = user("did:a");
      const other = user("did:b");

      const unique = uniqueCfcAtoms([first, other, clone, first, "plain"]);

      expect(unique).toEqual([first, other, "plain"]);
      expect(unique[0]).toBe(first);
    });

    it("treats atoms whose properties arrive in another order as the same atom", () => {
      expect(
        uniqueCfcAtoms([
          { type: "User", subject: "did:a" },
          { subject: "did:a", type: "User" },
        ]),
      ).toHaveLength(1);
    });

    it("dedups past the point where it groups the atoms it has kept", () => {
      // Seventeen distinct atoms take the kept set past the scan limit, so
      // the duplicates that follow are found through the grouping.

      const distinct = Array.from({ length: 17 }, (_, i) => user(`did:${i}`));
      const repeats = distinct.map((atom) => ({ ...atom }));
      const late = user("did:late");

      const unique = uniqueCfcAtoms([...distinct, ...repeats, late, {
        ...late,
      }]);

      expect(unique).toEqual([...distinct, late]);
      expect(unique.slice(0, 17).every((atom, i) => atom === distinct[i]))
        .toBe(true);
    });

    it("keeps atoms that differ only in a nested value apart", () => {
      const left = { type: "Scope", path: ["a", "b"] };
      const right = { type: "Scope", path: ["a", "c"] };

      expect(uniqueCfcAtoms([left, right, { ...left }])).toEqual([left, right]);
    });
  });

  describe("compareByCanonicalHash()", () => {
    it("returns 0 for two spellings of one atom", () => {
      expect(compareByCanonicalHash(user("did:a"), user("did:a"))).toBe(0);
    });

    it("orders two different atoms the same way whichever comes first", () => {
      const a = user("did:a");
      const b = user("did:b");

      const forward = compareByCanonicalHash(a, b);

      expect(forward).not.toBe(0);
      expect(compareByCanonicalHash(b, a)).toBe(-forward);
    });
  });

  describe("normalizeClause()", () => {
    it("returns a bare atom unchanged", () => {
      const atom = user("did:a");

      expect(normalizeClause(atom)).toBe(atom);
    });

    it("returns the same clause whatever order its alternatives arrive in", () => {
      const atoms = ["did:a", "did:b", "did:c"].map(user);

      expect(normalizeClause({ anyOf: atoms })).toEqual(
        normalizeClause({ anyOf: atoms.toReversed() }),
      );
    });

    it("unwraps a clause whose alternatives dedup to one atom", () => {
      expect(normalizeClause({ anyOf: [user("did:a"), user("did:a")] }))
        .toEqual(user("did:a"));
    });

    it("keeps a sole alternative that is itself clause-shaped wrapped", () => {
      const nested = { anyOf: [{ anyOf: [user("did:a"), user("did:b")] }] };

      expect(normalizeClause(nested)).toEqual(nested);
    });
  });

  describe("cfcCanonicalClauseDigest()", () => {
    it("names a clause the same way across alternative order and spelling", () => {
      const a = user("did:a");
      const b = user("did:b");

      expect(cfcCanonicalClauseDigest({ anyOf: [a, b, { ...a }] })).toBe(
        cfcCanonicalClauseDigest({ anyOf: [b, a] }),
      );
      expect(cfcCanonicalClauseDigest({ anyOf: [a] })).toBe(
        cfcCanonicalClauseDigest(a),
      );
    });

    it("names different clauses differently", () => {
      const a = user("did:a");
      const b = user("did:b");

      expect(cfcCanonicalClauseDigest({ anyOf: [a, b] })).not.toBe(
        cfcCanonicalClauseDigest(a),
      );
    });
  });
});
