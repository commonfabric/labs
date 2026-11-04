import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type CfcConfClause,
  clauseAlternatives,
  clausesEqual,
  normalizeClause,
} from "../src/cfc/clause.ts";
import {
  CFC_LABEL_READ_FAILED_ATOM,
  cfcObservationFitsCeiling,
  type CfcObservationMaxConfidentiality,
  meetCfcObservationCeilings,
} from "../src/cfc/observation.ts";

// Decision 6 of docs/history/plans/cfc-future-work-implementation.md (corrected
// 2026-07-02, #4482): the general clause meet is the pairwise
// alternative-set UNION. This file carries the targeted algebra cases and
// the both-direction property test the plan requires before clause ceilings
// reach the meet seam (B5 BoundaryContext/sink ceilings, H3b render
// ceiling).

const A = { type: "https://commonfabric.org/cfc/atom/User", subject: "A" };
const B = { type: "https://commonfabric.org/cfc/atom/User", subject: "B" };
const C = { type: "https://commonfabric.org/cfc/atom/User", subject: "C" };

// A personal space and its owner, which the fit kernel relates on the label
// side (the owner is one of the space's readers). The property below has to
// hold across them: a ceiling naming the owner and one naming something else
// meet to a ceiling admitting exactly what both admit.
const DID = "did:key:zD";
const D = { type: "https://commonfabric.org/cfc/atom/User", subject: DID };
const DPersonalSpace = {
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner: DID,
};

const clauseSetsEqual = (
  left: readonly unknown[],
  right: readonly unknown[],
): boolean =>
  left.length === right.length &&
  left.every((clause) =>
    right.some((other) =>
      clausesEqual(clause as CfcConfClause, other as CfcConfClause)
    )
  );

describe("CFC ceiling meet (pairwise alternative-set union)", () => {
  it("matches a linear deduplication oracle across repeated clause pairs", () => {
    const clauses: CfcConfClause[] = [
      { anyOf: [] },
      A,
      { anyOf: [B, A] },
      ...Array.from({ length: 20 }, (_, index) => ({
        anyOf: [A, `secret-${index % 10}`],
      })),
    ];
    const expected: CfcConfClause[] = [];
    for (const left of clauses) {
      for (const right of [...clauses].reverse()) {
        const a = clauseAlternatives(left);
        const b = clauseAlternatives(right);
        if (a.length === 0 || b.length === 0) continue;
        const union = normalizeClause({ anyOf: [...a, ...b] });
        if (!expected.some((kept) => clausesEqual(kept, union))) {
          expected.push(union);
        }
      }
    }
    expect(meetCfcObservationCeilings(clauses, [...clauses].reverse()))
      .toEqual(expected);
  });

  describe("edge cases", () => {
    it("undefined (no ceiling) is the identity", () => {
      expect(meetCfcObservationCeilings(undefined, [A])).toEqual([A]);
      expect(meetCfcObservationCeilings([A], undefined)).toEqual([A]);
      expect(meetCfcObservationCeilings(undefined, undefined)).toBe(undefined);
    });

    it("a declared empty ceiling (public-only) wins", () => {
      expect(meetCfcObservationCeilings([], [A])).toEqual([]);
      expect(meetCfcObservationCeilings([A], [])).toEqual([]);
      expect(meetCfcObservationCeilings([], [])).toEqual([]);
    });

    it("a malformed empty OR-clause contributes nothing", () => {
      // {anyOf:[]} never subsumes (clauseSubsumes fails closed), so a
      // ceiling containing it admits only what its other clauses admit.
      // Pairing it would emit the partner clause verbatim and LOOSEN the
      // meet past the empty-clause parent — it must be skipped instead.
      expect(meetCfcObservationCeilings([{ anyOf: [] }], [A])).toEqual([]);
      expect(meetCfcObservationCeilings([{ anyOf: [] }, A], [A])).toEqual([A]);
    });
  });

  describe("flat/flat ceilings", () => {
    it("equal-atom pairs collapse to the bare atom", () => {
      expect(meetCfcObservationCeilings([A], [A])).toEqual([A]);
    });

    it("distinct-atom cross pairs form an OR-clause, more precise than intersection", () => {
      const met = meetCfcObservationCeilings([A], [B]);
      expect(met).toEqual([normalizeClause({ anyOf: [A, B] })]);
      // Decision-equivalent to the old atom intersection ([]) for FLAT
      // labels: no bare atom fits...
      expect(cfcObservationFitsCeiling([A], met)).toBe(false);
      expect(cfcObservationFitsCeiling([B], met)).toBe(false);
      expect(cfcObservationFitsCeiling([], met)).toBe(true);
      // ...but an OR-label that fits BOTH parents also fits the meet, which
      // the intersection ([]) wrongly rejected.
      const orLabel = [{ anyOf: [A, B] }];
      expect(cfcObservationFitsCeiling(orLabel, [A])).toBe(true);
      expect(cfcObservationFitsCeiling(orLabel, [B])).toBe(true);
      expect(cfcObservationFitsCeiling(orLabel, met)).toBe(true);
    });

    it("multi-atom ceilings: shared atom survives, cross pairs are ORs", () => {
      const met = meetCfcObservationCeilings([A, B], [B, C]);
      expect(met).not.toBe(undefined);
      expect(clauseSetsEqual(met!, [
        normalizeClause({ anyOf: [A, B] }),
        normalizeClause({ anyOf: [A, C] }),
        B,
        normalizeClause({ anyOf: [B, C] }),
      ])).toBe(true);
      // Flat-label decisions match the old atom intersection [B]:
      expect(cfcObservationFitsCeiling([B], met)).toBe(true);
      expect(cfcObservationFitsCeiling([A], met)).toBe(false);
      expect(cfcObservationFitsCeiling([C], met)).toBe(false);
    });
  });

  describe("clause ceilings", () => {
    it("unions alternative sets — never intersects (intersection loosens)", () => {
      const c1 = [{ anyOf: [A, B] }];
      const c2 = [{ anyOf: [B, C] }];
      const met = meetCfcObservationCeilings(c1, c2);
      expect(met).toEqual([normalizeClause({ anyOf: [A, B, C] })]);
      // The unsound intersection meet would be [B], admitting label [B] —
      // which ceiling c1 alone rejects ({A,B} ⊄ {B}):
      expect(cfcObservationFitsCeiling([B], c1)).toBe(false);
      expect(cfcObservationFitsCeiling([B], met)).toBe(false);
      // A label clause wide enough for both parents fits the meet:
      const wide = [{ anyOf: [A, B, C] }];
      expect(cfcObservationFitsCeiling(wide, c1)).toBe(true);
      expect(cfcObservationFitsCeiling(wide, c2)).toBe(true);
      expect(cfcObservationFitsCeiling(wide, met)).toBe(true);
    });

    it("an OR-clause met with a member atom yields the OR-clause", () => {
      // {A,B} ⊆ alts(l) ∧ A ∈ alts(l) ⟺ {A,B} ⊆ alts(l).
      expect(meetCfcObservationCeilings([{ anyOf: [A, B] }], [A]))
        .toEqual([normalizeClause({ anyOf: [A, B] })]);
    });

    it("order-differing equivalent union clauses coalesce via clausesEqual", () => {
      // Both pairs union to {A,B}; a deepEqual-only dedup would keep two
      // order-differing copies.
      const met = meetCfcObservationCeilings(
        [A, { anyOf: [B, A] }],
        [{ anyOf: [A, B] }],
      );
      expect(met).toEqual([normalizeClause({ anyOf: [A, B] })]);
    });
  });

  describe("the personal-space containment across a meet", () => {
    // The property test below cannot see this rule: both its sides call the
    // same `clauseSubsumes`, so the equivalence holds whether or not the
    // containment is wired in. These pin the containment directly, at the
    // seam where a meet puts the two spellings in one clause.

    it("a meet of the two spellings still admits the personal-space label", () => {
      // The meet unions the alternatives (no collapse — `clausesEqual` tells
      // the atoms apart), so every ceiling alternative must answer the label.
      // `PersonalSpace(P)` answers itself, and `User(P)` answers it only
      // through the containment.
      const met = meetCfcObservationCeilings([D], [DPersonalSpace]);
      expect(met).toHaveLength(1);
      expect(cfcObservationFitsCeiling([DPersonalSpace], met)).toBe(true);
    });

    it("that meet does not admit the owner label — the one-sidedness", () => {
      // `PersonalSpace(P)` sitting in the ceiling gets no reading, so the
      // meet refuses a `User(P)` label even though one parent admits it.
      const met = meetCfcObservationCeilings([D], [DPersonalSpace]);
      expect(cfcObservationFitsCeiling([D], [D])).toBe(true);
      expect(cfcObservationFitsCeiling([D], met)).toBe(false);
    });
  });

  describe("both-direction property: fits(L, meet(C1,C2)) ⟺ fits(L,C1) ∧ fits(L,C2)", () => {
    // Exhaustive enumeration over a small clause universe, including flat
    // atoms, OR-clauses (with an order-differing spelling), the malformed
    // empty clause, and the ungrantable read-failed marker (bare and
    // wrapped).
    const ceilingClausePool: readonly CfcConfClause[] = [
      A,
      B,
      C,
      { anyOf: [A, B] },
      { anyOf: [B, A] },
      { anyOf: [B, C] },
      { anyOf: [A, B, C] },
      { anyOf: [] },
      CFC_LABEL_READ_FAILED_ATOM,
      D,
      DPersonalSpace,
    ];
    const labelClausePool: readonly CfcConfClause[] = [
      A,
      B,
      C,
      { anyOf: [A, B] },
      { anyOf: [A, C] },
      { anyOf: [A, B, C] },
      { anyOf: [] },
      CFC_LABEL_READ_FAILED_ATOM,
      { anyOf: [CFC_LABEL_READ_FAILED_ATOM, A] },
      D,
      DPersonalSpace,
      { anyOf: [DPersonalSpace, C] },
    ];

    const subsetsUpToSize2 = (
      pool: readonly CfcConfClause[],
    ): readonly (readonly CfcConfClause[])[] => {
      const subsets: (readonly CfcConfClause[])[] = [[]];
      for (let i = 0; i < pool.length; i++) {
        subsets.push([pool[i]]);
        for (let j = i + 1; j < pool.length; j++) {
          subsets.push([pool[i], pool[j]]);
        }
      }
      return subsets;
    };

    it("holds over every (C1, C2, L) triple in the universe", () => {
      const ceilings: readonly CfcObservationMaxConfidentiality[] = [
        undefined,
        ...subsetsUpToSize2(ceilingClausePool),
      ];
      const labels = subsetsUpToSize2(labelClausePool);
      let checked = 0;
      for (const c1 of ceilings) {
        for (const c2 of ceilings) {
          const met = meetCfcObservationCeilings(c1, c2);
          for (const label of labels) {
            const fitsMet = cfcObservationFitsCeiling(label, met);
            const fitsBoth = cfcObservationFitsCeiling(label, c1) &&
              cfcObservationFitsCeiling(label, c2);
            if (fitsMet !== fitsBoth) {
              throw new Error(
                `meet property violated: ${
                  JSON.stringify({ c1, c2, met, label, fitsMet, fitsBoth })
                }`,
              );
            }
            checked++;
          }
        }
      }
      expect(checked).toBe(ceilings.length ** 2 * labels.length);
    });
  });
});
