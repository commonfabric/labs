import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { hashStringOf } from "@commonfabric/data-model";

import {
  canonicalizeCfcMetadata,
  canonicalizeWritePolicyInput,
} from "../src/cfc/canonical.ts";
import type { CfcConfClause } from "../src/cfc/clause.ts";
import {
  clauseAlternatives,
  clausesEqual,
  clauseSubsumes,
  isOrClause,
  normalizeClause,
} from "../src/cfc/clause.ts";
import type {
  CfcAddress,
  CfcMetadata,
  WritePolicyInput,
} from "../src/cfc/types.ts";

// Epic A1 (docs/history/plans/cfc-future-work-implementation.md): the CNF clause
// kernel. Pure helpers — no runtime behavior change; A2 wires subsumption
// into the ceiling checks.

const userA = { type: "https://commonfabric.org/cfc/atom/User", subject: "A" };
const userB = { type: "https://commonfabric.org/cfc/atom/User", subject: "B" };
const userC = { type: "https://commonfabric.org/cfc/atom/User", subject: "C" };

describe("CFC clause kernel", () => {
  describe("isOrClause", () => {
    it("recognizes the exact {anyOf: [...]} wire form only", () => {
      expect(isOrClause({ anyOf: [userA, userB] })).toBe(true);
      expect(isOrClause({ anyOf: [] })).toBe(true);
      // The anyOf key is reserved, but any OTHER shape stays an opaque atom
      // (fail-closed: unsatisfiable against ceilings), never a clause.
      expect(isOrClause({ anyOf: [userA], extra: 1 })).toBe(false);
      expect(isOrClause({ anyOf: "not-an-array" })).toBe(false);
      expect(isOrClause(userA)).toBe(false);
      expect(isOrClause("string-atom")).toBe(false);
      expect(isOrClause([userA, userB])).toBe(false);
      expect(isOrClause(null)).toBe(false);
    });
  });

  describe("clauseAlternatives", () => {
    it("treats a bare atom as its own single alternative", () => {
      expect(clauseAlternatives(userA)).toEqual([userA]);
      expect(clauseAlternatives("string-atom")).toEqual(["string-atom"]);
    });

    it("returns the alternatives of an OR-clause", () => {
      expect(clauseAlternatives({ anyOf: [userA, userB] }))
        .toEqual([userA, userB]);
    });
  });

  describe("normalizeClause", () => {
    it("returns bare atoms unchanged (identity for flat labels)", () => {
      expect(normalizeClause(userA)).toBe(userA);
      expect(normalizeClause("string-atom")).toBe("string-atom");
      // A malformed hybrid is an opaque atom, not a clause — untouched.
      const hybrid = { anyOf: [userA], extra: 1 };
      expect(normalizeClause(hybrid)).toBe(hybrid);
    });

    it("canonicalizes alternative order deterministically", () => {
      const forward = normalizeClause({ anyOf: [userA, userB, userC] });
      const backward = normalizeClause({ anyOf: [userC, userB, userA] });
      expect(forward).toEqual(backward);
      expect(hashStringOf(forward)).toBe(hashStringOf(backward));
    });

    it("dedups alternatives structurally", () => {
      const clone = { ...userA };
      expect(normalizeClause({ anyOf: [userA, clone, userB] }))
        .toEqual(normalizeClause({ anyOf: [userA, userB] }));
    });

    it("unwraps a singleton {anyOf: [a]} to the bare atom", () => {
      expect(normalizeClause({ anyOf: [userA] })).toEqual(userA);
      // ... including after dedup collapses to one.
      expect(normalizeClause({ anyOf: [userA, { ...userA }] })).toEqual(userA);
    });

    it("keeps the empty (unsatisfiable) clause as-is", () => {
      expect(normalizeClause({ anyOf: [] })).toEqual({ anyOf: [] });
    });

    it("never promotes a malformed nested clause via singleton unwrap", () => {
      // {anyOf:[{anyOf:[A,B]}]} is malformed: the reserved key in atom
      // position makes the sole alternative an opaque, unsatisfiable atom.
      // Unwrapping would turn it into an ACTIVE OR-clause — admitting at a
      // ceiling naming A what the raw label never would. It must stay
      // wrapped and opaque.
      const malformed = { anyOf: [{ anyOf: [userA, userB] }] };
      const normalized = normalizeClause(malformed);
      expect(normalized).toEqual(malformed);
      // The soundness assertion: no loosening through normalization.
      expect(clauseSubsumes(userA, normalized)).toBe(false);
      expect(clauseSubsumes(userA, malformed)).toBe(false);
    });

    it("never dedups across a singleton and an OR-clause containing it", () => {
      // [A] and [A ∨ B] are different constraints — normalization is
      // clause-interior only, so both survive side by side in a label.
      const label = [userA, { anyOf: [userA, userB] }].map(normalizeClause);
      expect(label).toHaveLength(2);
      expect(label[0]).toEqual(userA);
      expect(clauseAlternatives(label[1])).toHaveLength(2);
    });
  });

  describe("clausesEqual", () => {
    it("is insensitive to alternative order and spelling", () => {
      expect(clausesEqual({ anyOf: [userA, userB] }, { anyOf: [userB, userA] }))
        .toBe(true);
      expect(clausesEqual({ anyOf: [userA] }, userA)).toBe(true);
      expect(clausesEqual({ anyOf: [userA, userB] }, userA)).toBe(false);
      expect(clausesEqual(userA, userB)).toBe(false);
    });
  });

  describe("clauseSubsumes", () => {
    it("singleton ceiling clause subsumes a label clause containing it", () => {
      // Ceiling audience {A} ⊆ label alternatives {A, B}: anyone the ceiling
      // admits (A) satisfies the label clause.
      expect(clauseSubsumes(userA, { anyOf: [userA, userB] })).toBe(true);
      expect(clauseSubsumes(userA, userA)).toBe(true);
      expect(clauseSubsumes(userA, userB)).toBe(false);
      expect(clauseSubsumes(userC, { anyOf: [userA, userB] })).toBe(false);
    });

    it("reader-enumeration ceiling clause requires EVERY reader in the label clause", () => {
      // The §8.10.3 quantifier fix: ceiling {A ∨ B} = "either A or B may
      // observe the destination", so BOTH must satisfy the label clause.
      expect(
        clauseSubsumes({ anyOf: [userA, userB] }, { anyOf: [userA, userB] }),
      )
        .toBe(true);
      expect(
        clauseSubsumes({ anyOf: [userA, userB] }, {
          anyOf: [userA, userB, userC],
        }),
      ).toBe(true);
      // The multi-party counterexample kernel: a singleton label clause
      // [User(A)] is NOT subsumed by the enumeration {A ∨ B} — showing the
      // destination to B would violate A's clause.
      expect(clauseSubsumes({ anyOf: [userA, userB] }, userA)).toBe(false);
    });

    it("fails closed on empty clauses in either position", () => {
      // Empty CEILING clause: mathematically ∅ ⊆ anything, but an authored
      // empty audience is treated as malformed — it never subsumes.
      expect(clauseSubsumes({ anyOf: [] }, userA)).toBe(false);
      expect(clauseSubsumes({ anyOf: [] }, { anyOf: [] })).toBe(false);
      // Empty LABEL clause: unsatisfiable — no non-empty ceiling clause fits.
      expect(clauseSubsumes(userA, { anyOf: [] })).toBe(false);
    });
  });

  describe("canonicalizeCfcMetadata clause interiors", () => {
    const metadataWith = (confidentiality: CfcConfClause[]): CfcMetadata => ({
      version: 1,
      schemaHash: "hash",
      labelMap: {
        version: 1,
        entries: [{ path: ["field"], label: { confidentiality } }],
      },
    });

    it("digests identically across alternative insertion order", () => {
      const forward = canonicalizeCfcMetadata(
        metadataWith([{ anyOf: [userA, userB] }, userC]),
      );
      const backward = canonicalizeCfcMetadata(
        metadataWith([{ anyOf: [userB, userA] }, userC]),
      );
      expect(hashStringOf(forward)).toBe(hashStringOf(backward));
    });

    it("does not reorder the top-level clause list", () => {
      const canonical = canonicalizeCfcMetadata(
        metadataWith([userC, { anyOf: [userB, userA] }]),
      );
      const entry = canonical.labelMap.entries[0];
      expect(entry.label.confidentiality?.[0]).toEqual(userC);
      expect(isOrClause(entry.label.confidentiality?.[1])).toBe(true);
    });

    it("passes flat labels through by reference (no gratuitous copies)", () => {
      const flat = metadataWith([userA, userB]);
      const canonical = canonicalizeCfcMetadata(flat);
      expect(canonical.labelMap.entries[0].label).toBe(
        flat.labelMap.entries[0].label,
      );
    });
  });

  describe("canonicalizeWritePolicyInput carried label views", () => {
    const address = (id: string): CfcAddress =>
      ({
        space: "did:key:space" as CfcAddress["space"],
        id,
        scope: "space",
        path: [],
      }) as CfcAddress;

    const linkWriteWith = (
      confidentiality: CfcConfClause[],
    ): WritePolicyInput => ({
      kind: "link-write",
      target: address("of:target"),
      source: address("of:source"),
      cfcLabelView: {
        version: 1,
        entries: [{ path: ["field"], label: { confidentiality } }],
      },
    });

    it("digests link-write label views identically across alternative order", () => {
      const forward = canonicalizeWritePolicyInput(
        linkWriteWith([{ anyOf: [userA, userB] }, userC]),
      );
      const backward = canonicalizeWritePolicyInput(
        linkWriteWith([{ anyOf: [userB, userA] }, userC]),
      );
      expect(hashStringOf(forward)).toBe(hashStringOf(backward));
    });
  });
});
