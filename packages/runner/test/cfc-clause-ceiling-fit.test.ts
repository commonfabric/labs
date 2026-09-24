import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  atomsOutsideCeiling,
  CFC_LABEL_READ_FAILED_ATOM,
  cfcObservationFitsCeiling,
  meetCfcObservationCeilings,
} from "../src/cfc/observation.ts";
import { normalizeClause } from "../src/cfc/clause.ts";
import { commitCfcFieldValue } from "../src/cfc/label-representation.ts";

// Epic A2 (docs/history/plans/cfc-future-work-implementation.md): the ceiling-fit
// check becomes CNF clause subsumption (spec §8.10.3). The load-bearing case
// is the reader-enumeration quantifier fix — a multi-party label must NOT fit
// an "A or B may observe" ceiling.

const A = { type: "https://commonfabric.org/cfc/atom/User", subject: "A" };
const B = { type: "https://commonfabric.org/cfc/atom/User", subject: "B" };
const C = { type: "https://commonfabric.org/cfc/atom/User", subject: "C" };

// The three spellings of one principal (§15.2), and the container atom that
// carries the same DID without naming a person.
const ALICE = "did:key:zAlice";
const BOB = "did:key:zBob";
const aliceUser = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: ALICE,
};
const alicePersonalSpace = {
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner: ALICE,
};
const aliceSpace = {
  type: "https://commonfabric.org/cfc/atom/Space",
  id: ALICE,
};

describe("CFC clause-aware ceiling fit", () => {
  describe("flat labels/ceilings behave exactly as before (golden)", () => {
    it("undefined ceiling admits everything", () => {
      expect(cfcObservationFitsCeiling([A, B], undefined)).toBe(true);
    });

    it("public data fits any ceiling incl. the empty one", () => {
      expect(cfcObservationFitsCeiling([], [])).toBe(true);
      expect(cfcObservationFitsCeiling([], [A])).toBe(true);
    });

    it("empty ceiling rejects any confidential atom", () => {
      expect(cfcObservationFitsCeiling([A], [])).toBe(false);
    });

    it("flat subset membership", () => {
      expect(cfcObservationFitsCeiling([A], [A, B])).toBe(true);
      expect(cfcObservationFitsCeiling([A, B], [A, B])).toBe(true);
      expect(cfcObservationFitsCeiling([A, C], [A, B])).toBe(false);
      expect(atomsOutsideCeiling([A, C], [A, B])).toEqual([C]);
    });

    it("read-failed marker is ungrantable even if the ceiling names it", () => {
      expect(
        cfcObservationFitsCeiling([CFC_LABEL_READ_FAILED_ATOM], [
          CFC_LABEL_READ_FAILED_ATOM,
        ]),
      ).toBe(false);
      expect(
        atomsOutsideCeiling([CFC_LABEL_READ_FAILED_ATOM], [
          CFC_LABEL_READ_FAILED_ATOM,
        ]),
      ).toEqual([CFC_LABEL_READ_FAILED_ATOM]);
    });

    it("a marker WRAPPED in an OR-clause stays ungrantable (no subsumption bypass)", () => {
      // Defense in depth: a clause carrying the marker as an alternative must
      // never fit, even when the ceiling names the marker — otherwise
      // subsumption would admit the wrapping clause and reopen the bypass.
      const wrapped = { anyOf: [CFC_LABEL_READ_FAILED_ATOM, A] };
      const markerCeiling = [{ anyOf: [CFC_LABEL_READ_FAILED_ATOM, A] }];
      expect(cfcObservationFitsCeiling([wrapped], markerCeiling)).toBe(false);
      expect(atomsOutsideCeiling([wrapped], markerCeiling)).toEqual([wrapped]);
      // Also the singleton-wrapped form against a marker-naming flat ceiling.
      expect(
        cfcObservationFitsCeiling([{ anyOf: [CFC_LABEL_READ_FAILED_ATOM] }], [
          CFC_LABEL_READ_FAILED_ATOM,
        ]),
      ).toBe(false);
    });
  });

  describe("reader-enumeration ceiling (the §8.10.3 soundness fix)", () => {
    it("a multi-party label does NOT fit an 'A or B' ceiling", () => {
      // Label [User(A), User(B)] = two conjunctive clauses: BOTH must be
      // satisfied, so nobody alone may read. Ceiling [{A ∨ B}] = "either A or
      // B observes the destination". Showing it to A alone violates B's
      // clause — must fail closed. (Flat pre-A2 code wrongly passed this.)
      const label = [A, B];
      const ceiling = [{ anyOf: [A, B] }];
      expect(cfcObservationFitsCeiling(label, ceiling)).toBe(false);
      // Both singleton clauses are outside: neither is subsumed by {A∨B}
      // (alts {A,B} ⊄ {A}, ⊄ {B}).
      expect(atomsOutsideCeiling(label, ceiling)).toEqual([A, B]);
    });

    it("a single-party label fits the enumeration naming that party", () => {
      // Label [User(A)] fits ceiling [{A ∨ B}]? alts({A,B}) ⊆ {A}? No — the
      // enumeration would also admit B, who is not entitled. Fail closed.
      expect(cfcObservationFitsCeiling([A], [{ anyOf: [A, B] }])).toBe(false);
    });

    it("an enumeration label fits a narrower single-reader ceiling", () => {
      // Label [{A ∨ B}] = readable by A OR B. Ceiling [A] = only A observes.
      // alts(A)={A} ⊆ alts({A,B})={A,B} → subsumed → fits. A is entitled to
      // data anyone-of-{A,B} may read.
      expect(cfcObservationFitsCeiling([{ anyOf: [A, B] }], [A])).toBe(true);
      // Ceiling naming a non-member does not fit.
      expect(cfcObservationFitsCeiling([{ anyOf: [A, B] }], [C])).toBe(false);
    });

    it("enumeration ceiling subsumes an equal-or-wider label clause", () => {
      // ceiling {A∨B} subsumes label {A∨B∨C} (alts {A,B} ⊆ {A,B,C}).
      expect(
        cfcObservationFitsCeiling([{ anyOf: [A, B, C] }], [{ anyOf: [A, B] }]),
      ).toBe(true);
      // ...but NOT label {A∨C} (alts {A,B} ⊄ {A,C}).
      expect(
        cfcObservationFitsCeiling([{ anyOf: [A, C] }], [{ anyOf: [A, B] }]),
      ).toBe(false);
    });
  });

  describe("a personal space's owner is one of its readers", () => {
    // §3.6.4: the owner owns the space, so the owner is always among its
    // readers. A ceiling whose audience is that owner is therefore inside a
    // `PersonalSpace(owner)` label's audience however wide the space's
    // membership has grown. The reverse containment does not hold: §3.6.5
    // gives a newly added member access to all data in the space with no
    // label rewriting, so the atom's audience is not the owner alone.

    it("a personal-space LABEL fits a ceiling naming its owner", () => {
      expect(cfcObservationFitsCeiling([alicePersonalSpace], [aliceUser]))
        .toBe(true);
    });

    it("a personal-space CEILING does not admit its owner's label", () => {
      expect(cfcObservationFitsCeiling([aliceUser], [alicePersonalSpace]))
        .toBe(false);
    });

    it("names one person: another owner's space stays outside", () => {
      const bobPersonalSpace = {
        type: "https://commonfabric.org/cfc/atom/PersonalSpace",
        owner: BOB,
      };
      expect(cfcObservationFitsCeiling([bobPersonalSpace], [aliceUser]))
        .toBe(false);
    });

    it("a Space atom carrying the same DID is not covered", () => {
      // §15.2: a `Space(id)` reader is derived through verified `HasRole`
      // exchange, which the kernel cannot run. Writer-fit also joins the
      // target's own `Space(...)` onto every ceiling as the residency
      // clause, so covering it here would admit that data space-wide.
      expect(cfcObservationFitsCeiling([aliceSpace], [aliceUser])).toBe(false);
      expect(cfcObservationFitsCeiling([aliceUser], [aliceSpace])).toBe(false);
      expect(cfcObservationFitsCeiling([aliceSpace], [alicePersonalSpace]))
        .toBe(false);
    });

    it("the bare DID string is not an atom and gets no reading", () => {
      // §4.1.1: an atom is a structured value, not a simple string. The
      // legacy bare form stays opaque in both positions.
      expect(cfcObservationFitsCeiling([ALICE], [aliceUser])).toBe(false);
      expect(cfcObservationFitsCeiling([aliceUser], [ALICE])).toBe(false);
      expect(cfcObservationFitsCeiling([alicePersonalSpace], [ALICE]))
        .toBe(false);
    });

    it("only a canonical two-field personal space with a DID owner", () => {
      const scoped = { ...alicePersonalSpace, scope: "drafts" };
      expect(cfcObservationFitsCeiling([scoped], [aliceUser])).toBe(false);
      const numeric = {
        type: "https://commonfabric.org/cfc/atom/PersonalSpace",
        owner: 42,
      };
      expect(cfcObservationFitsCeiling([numeric], [{
        type: "https://commonfabric.org/cfc/atom/User",
        subject: 42,
      }])).toBe(false);
      // §15.2 types the field as a DID; a string that is not one is a
      // malformed atom and gets no reading, so two degenerate atoms do not
      // meet each other through it. A truncated or method-only string names
      // no principal to restate, so it gets no reading either — over-refusal,
      // the safe way for this gate to be wrong.
      for (const owner of ["", "alice", "did:", "did:key"]) {
        expect(cfcObservationFitsCeiling([{
          type: "https://commonfabric.org/cfc/atom/PersonalSpace",
          owner,
        }], [{
          type: "https://commonfabric.org/cfc/atom/User",
          subject: owner,
        }])).toBe(false);
      }
      // A method-specific identifier may hold colons of its own, as a
      // `did:web` with a port does, so such an owner is read.
      expect(cfcObservationFitsCeiling([{
        type: "https://commonfabric.org/cfc/atom/PersonalSpace",
        owner: "did:web:example.com:8080",
      }], [{
        type: "https://commonfabric.org/cfc/atom/User",
        subject: "did:web:example.com:8080",
      }])).toBe(true);
    });

    it("reaches into an OR-clause on the label side", () => {
      expect(
        cfcObservationFitsCeiling([{ anyOf: [alicePersonalSpace, C] }], [
          aliceUser,
        ]),
      ).toBe(true);
      // A ceiling enumeration still demands every alternative it names.
      expect(
        cfcObservationFitsCeiling([alicePersonalSpace], [{
          anyOf: [aliceUser, C],
        }]),
      ).toBe(false);
    });

    it("meets a committed owner field against its plaintext twin", () => {
      // `label-field-classification.ts` commits `PersonalSpace.owner` and
      // `User.subject` alike, and the digest is of the field value, so a
      // label persisted at a cross-space seam still meets a ceiling naming
      // the same owner in plaintext.
      const committedOwner = {
        type: "https://commonfabric.org/cfc/atom/PersonalSpace",
        owner: commitCfcFieldValue(ALICE),
      };
      expect(cfcObservationFitsCeiling([committedOwner], [aliceUser]))
        .toBe(true);
      expect(
        cfcObservationFitsCeiling([{
          type: "https://commonfabric.org/cfc/atom/PersonalSpace",
          owner: commitCfcFieldValue(BOB),
        }], [aliceUser]),
      ).toBe(false);
    });

    it("throws on an atom that is not a `FabricValue`", () => {
      // An atom whose `type`/`owner` come from its prototype is not data, and
      // the equality check refuses it before the rewrite can read it.
      const inherited = Object.create(alicePersonalSpace);
      inherited.a = 1;
      inherited.b = 2;
      expect(() => cfcObservationFitsCeiling([inherited], [aliceUser]))
        .toThrow(/Cannot compare value/);
    });

    it("a committed owner is admitted where its plaintext twin is refused", () => {
      // A commitment is a digest of whatever the field held, so the
      // well-formedness test cannot reach it: a malformed owner digests
      // exactly as a DID does. Pinned so the asymmetry is explicit rather
      // than a surprise — and pinned with what bounds it, that reaching the
      // committed form takes a ceiling naming the same malformed subject.
      const malformed = "alice";
      expect(
        cfcObservationFitsCeiling([{
          type: "https://commonfabric.org/cfc/atom/PersonalSpace",
          owner: malformed,
        }], [{
          type: "https://commonfabric.org/cfc/atom/User",
          subject: malformed,
        }]),
      ).toBe(false);
      expect(
        cfcObservationFitsCeiling([{
          type: "https://commonfabric.org/cfc/atom/PersonalSpace",
          owner: commitCfcFieldValue(malformed),
        }], [{
          type: "https://commonfabric.org/cfc/atom/User",
          subject: malformed,
        }]),
      ).toBe(true);
      // A well-formed ceiling is unreachable from the malformed committed
      // label, which is the bound that makes the gap tolerable.
      expect(
        cfcObservationFitsCeiling([{
          type: "https://commonfabric.org/cfc/atom/PersonalSpace",
          owner: commitCfcFieldValue(malformed),
        }], [aliceUser]),
      ).toBe(false);
    });

    it("does not admit a label the ceiling omits entirely", () => {
      expect(cfcObservationFitsCeiling([alicePersonalSpace], [])).toBe(false);
      expect(atomsOutsideCeiling([alicePersonalSpace], [C]))
        .toEqual([alicePersonalSpace]);
    });
  });

  describe("meet is the pairwise alternative-set union (decision 6)", () => {
    // Full coverage (incl. the both-direction property test) lives in
    // cfc-clause-meet.test.ts; these pin the fit-facing behavior.

    it("flat meet keeps flat-label decisions of the old atom intersection", () => {
      const met = meetCfcObservationCeilings([A, B], [B, C]);
      expect(cfcObservationFitsCeiling([B], met)).toBe(true);
      expect(cfcObservationFitsCeiling([A], met)).toBe(false);
      expect(cfcObservationFitsCeiling([C], met)).toBe(false);
      expect(meetCfcObservationCeilings(undefined, [A])).toEqual([A]);
      expect(meetCfcObservationCeilings([A], undefined)).toEqual([A]);
    });

    it("an OR-clause met with itself or a member atom yields the OR-clause", () => {
      const clause = { anyOf: [A, B] };
      expect(meetCfcObservationCeilings([clause], [clause]))
        .toEqual([normalizeClause(clause)]);
      // {A,B} ⊆ alts(l) ∧ A ∈ alts(l) ⟺ {A,B} ⊆ alts(l).
      expect(meetCfcObservationCeilings([clause], [A]))
        .toEqual([normalizeClause(clause)]);
    });
  });
});
