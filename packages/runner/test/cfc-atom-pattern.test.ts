import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  atomEntails,
  atomPatternBindingsEqual,
  EMPTY_ATOM_PATTERN_BINDINGS,
  instantiateAtomPattern,
  isAtomVarPlaceholder,
  matchAtomPattern,
  matchAtomPatternAgainstAtoms,
  matchAtomPatternConjunction,
} from "../src/cfc/atom-pattern.ts";
import { atomPropagationClass } from "../src/cfc/atom-classes.ts";
import { clauseSubsumes } from "../src/cfc/clause.ts";

// Epic B1 (docs/history/plans/cfc-future-work-implementation.md §3): the atom
// pattern-matching kernel of the exchange-rule calculus (spec §4.3.3/§4.3.4)
// plus the per-family entailment hook and the new atom families' registry
// entries. Pure helpers — B4 wires them into the fueled evaluator.

const userA = cfcAtom.user("did:key:alice");
const userB = cfcAtom.user("did:key:bob");
const spaceX = cfcAtom.space("space:x");
const spaceY = cfcAtom.space("space:y");
const roleAliceX = cfcAtom.hasRole("did:key:alice", "space:x", "reader");
const roleAliceY = cfcAtom.hasRole("did:key:alice", "space:y", "reader");
const roleBobX = cfcAtom.hasRole("did:key:bob", "space:x", "writer");

describe("CFC atom patterns", () => {
  describe("isAtomVarPlaceholder", () => {
    it("recognizes the exact sole-key {var: string} shape only", () => {
      expect(isAtomVarPlaceholder({ var: "$x" })).toBe(true);
      expect(isAtomVarPlaceholder({ var: "" })).toBe(false);
      expect(isAtomVarPlaceholder({ var: "$x", type: "t" })).toBe(false);
      expect(isAtomVarPlaceholder({ var: 5 })).toBe(false);
      expect(isAtomVarPlaceholder("$x")).toBe(false);
      expect(isAtomVarPlaceholder(null)).toBe(false);
    });
  });

  describe("matchAtomPattern", () => {
    it("matches concrete scalars and records by structural equality", () => {
      expect(matchAtomPattern("public", "public")).toEqual({});
      expect(matchAtomPattern("public", "secret")).toBeNull();
      expect(matchAtomPattern(userA, { ...userA })).toEqual({});
      expect(matchAtomPattern(userA, userB)).toBeNull();
    });

    it("binds the whole atom to a bare variable", () => {
      expect(matchAtomPattern({ var: "$a" }, userA)).toEqual({ "$a": userA });
      expect(matchAtomPattern({ var: "$a" }, "string-atom"))
        .toEqual({ "$a": "string-atom" });
    });

    it("unifies a bare variable against an existing binding", () => {
      expect(matchAtomPattern({ var: "$a" }, userA, { "$a": { ...userA } }))
        .toEqual({ "$a": userA });
      expect(matchAtomPattern({ var: "$a" }, userA, { "$a": userB }))
        .toBeNull();
    });

    it("record patterns constrain named fields only (subset semantics)", () => {
      // The pattern names type+space; principal/role are unconstrained.
      const pattern = { type: CFC_ATOM_TYPE.HasRole, space: "space:x" };
      expect(matchAtomPattern(pattern, roleAliceX)).toEqual({});
      expect(matchAtomPattern(pattern, roleBobX)).toEqual({});
      expect(matchAtomPattern(pattern, roleAliceY)).toBeNull();
      // A named field missing from the atom fails.
      expect(matchAtomPattern({ type: CFC_ATOM_TYPE.User, missing: 1 }, userA))
        .toBeNull();
      // A record pattern never matches a non-record.
      expect(matchAtomPattern({ type: CFC_ATOM_TYPE.User }, "string-atom"))
        .toBeNull();
      expect(matchAtomPattern({ type: CFC_ATOM_TYPE.User }, [userA]))
        .toBeNull();
    });

    it("binds field placeholders inside typed patterns", () => {
      const pattern = {
        type: CFC_ATOM_TYPE.HasRole,
        principal: { var: "$p" },
        space: { var: "$s" },
        role: "reader",
      };
      expect(matchAtomPattern(pattern, roleAliceX))
        .toEqual({ "$p": "did:key:alice", "$s": "space:x" });
      // role mismatch: writer !== reader.
      expect(matchAtomPattern(pattern, roleBobX)).toBeNull();
    });

    it("enforces same-variable equality WITHIN one pattern", () => {
      const pattern = { type: "pair", a: { var: "$v" }, b: { var: "$v" } };
      expect(matchAtomPattern(pattern, { type: "pair", a: 1, b: 1 }))
        .toEqual({ "$v": 1 });
      expect(matchAtomPattern(pattern, { type: "pair", a: 1, b: 2 }))
        .toBeNull();
    });

    it("walks nested record fields with subset semantics", () => {
      const atom = {
        type: CFC_ATOM_TYPE.DisclosureRendered,
        renderRef: { seq: 3, rootRef: { "/": "root" } },
        kind: "warning",
      };
      expect(
        matchAtomPattern(
          { type: CFC_ATOM_TYPE.DisclosureRendered, renderRef: { seq: 3 } },
          atom,
        ),
      ).toEqual({});
      expect(
        matchAtomPattern({
          type: CFC_ATOM_TYPE.DisclosureRendered,
          renderRef: { seq: { var: "$seq" } },
        }, atom),
      ).toEqual({ "$seq": 3 });
    });

    it("matches arrays elementwise at equal length", () => {
      const pattern = { type: "list", items: [1, { var: "$x" }] };
      expect(matchAtomPattern(pattern, { type: "list", items: [1, 2] }))
        .toEqual({ "$x": 2 });
      expect(matchAtomPattern(pattern, { type: "list", items: [1, 2, 3] }))
        .toBeNull();
    });

    it("treats an explicitly-undefined pattern field as an absence check", () => {
      const pattern = { type: CFC_ATOM_TYPE.User, extra: undefined };
      expect(matchAtomPattern(pattern, userA)).toEqual({});
      expect(matchAtomPattern(pattern, { ...userA, extra: 1 })).toBeNull();
    });

    it("fails closed on malformed var-bearing records, both directions", () => {
      // A record with a `var` key that is not the exact placeholder shape is
      // a malformed pattern: it matches nothing — including atom data that
      // is literally the same record.
      const malformed = { var: "$x", type: "t" };
      expect(matchAtomPattern(malformed, { var: "$x", type: "t" })).toBeNull();
      expect(matchAtomPattern(malformed, roleAliceX)).toBeNull();
      expect(matchAtomPattern({ var: 5 }, { var: 5 })).toBeNull();
      // Nested occurrences are equally malformed.
      expect(
        matchAtomPattern(
          { type: "t", field: { var: "$x", extra: 1 } },
          { type: "t", field: { var: "$x", extra: 1 } },
        ),
      ).toBeNull();
    });

    it("rejects a malformed var-bearing VALUE before binding (either direction)", () => {
      // A crafted atom carrying a `var` key in a non-placeholder arrangement
      // must not bind to a catch-all placeholder — the value-side half of the
      // reserved-key discipline (codex/cubic P2 on #4547).
      const craftedAtom = { var: "$x", type: "https://example.com/atoms/Evil" };
      expect(matchAtomPattern({ var: "$v" }, craftedAtom)).toBeNull();
      expect(matchAtomPattern({ var: "$v" }, { var: 5 })).toBeNull();
      // …nor satisfy a subset record pattern, even one whose named fields it
      // otherwise carries.
      expect(
        matchAtomPattern(
          { type: "https://example.com/atoms/Evil" },
          craftedAtom,
        ),
      ).toBeNull();
      // …nor as a nested field value.
      expect(
        matchAtomPattern(
          { type: "t", field: { var: "$v" } },
          { type: "t", field: craftedAtom },
        ),
      ).toBeNull();
      // A well-formed placeholder-shaped value is a specific literal, not a
      // wildcard, so it still binds (only MALFORMED var records are rejected).
      expect(matchAtomPattern({ var: "$v" }, { var: "$x" }))
        .toEqual({ "$v": { var: "$x" } });
    });

    it("returns `null` for a `FabricSpecialObject` pattern against a record", () => {
      // A special object has no own fields, so as a record pattern it would
      // name nothing and match every record. It is a leaf instead.
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(matchAtomPattern(bytes, userA)).toBeNull();
    });
  });

  describe("matchAtomPatternAgainstAtoms (multi-binding disjunction)", () => {
    it("yields one environment per matching atom (§4.3.4)", () => {
      const pattern = { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } };
      expect(matchAtomPatternAgainstAtoms(pattern, [spaceX, spaceY, userA]))
        .toEqual([{ "$s": "space:x" }, { "$s": "space:y" }]);
    });

    it("dedups environments from structurally equal atoms", () => {
      const pattern = { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } };
      expect(matchAtomPatternAgainstAtoms(pattern, [spaceX, { ...spaceX }]))
        .toEqual([{ "$s": "space:x" }]);
    });

    it("returns the base environment once for a var-free pattern", () => {
      expect(matchAtomPatternAgainstAtoms(userA, [userA, { ...userA }, userB]))
        .toEqual([{}]);
    });

    it("returns no environments when nothing matches", () => {
      expect(matchAtomPatternAgainstAtoms(userA, [userB, spaceX])).toEqual([]);
    });
  });

  describe("matchAtomPatternConjunction (constraint correlation)", () => {
    it("correlates shared variables across patterns (§4.3.3 example)", () => {
      // Space($s) ∧ HasRole(principal=$p, space=$s, role=reader): only the
      // role fact for the SAME space satisfies the conjunction.
      const environments = matchAtomPatternConjunction(
        [
          { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
          {
            type: CFC_ATOM_TYPE.HasRole,
            principal: { var: "$p" },
            space: { var: "$s" },
            role: "reader",
          },
        ],
        [spaceX, roleAliceX, roleBobX],
      );
      expect(environments).toEqual([
        { "$s": "space:x", "$p": "did:key:alice" },
      ]);
    });

    it("enumerates the full disjunction of consistent environments", () => {
      // Two spaces, Alice a reader in both (§4.3.4 multiple-spaces example):
      // both bindings are valid and BOTH come back.
      const environments = matchAtomPatternConjunction(
        [
          { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
          {
            type: CFC_ATOM_TYPE.HasRole,
            principal: "did:key:alice",
            space: { var: "$s" },
            role: "reader",
          },
        ],
        [spaceX, spaceY, roleAliceX, roleAliceY],
      );
      expect(environments).toEqual([
        { "$s": "space:x" },
        { "$s": "space:y" },
      ]);
    });

    it("returns [] when any pattern of the conjunction has no match", () => {
      expect(
        matchAtomPatternConjunction(
          [
            { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
            {
              type: CFC_ATOM_TYPE.HasRole,
              space: { var: "$s" },
              role: "owner",
            },
          ],
          [spaceX, roleAliceX],
        ),
      ).toEqual([]);
    });

    it("is vacuously satisfied by an empty pattern list", () => {
      expect(matchAtomPatternConjunction([], [userA]))
        .toEqual([EMPTY_ATOM_PATTERN_BINDINGS]);
    });
  });

  describe("atomPatternBindingsEqual", () => {
    it("compares environments by variable set and structural value", () => {
      expect(atomPatternBindingsEqual({ "$a": userA }, { "$a": { ...userA } }))
        .toBe(true);
      expect(atomPatternBindingsEqual({ "$a": userA }, { "$a": userB }))
        .toBe(false);
      // Different variable sets — including a strict subset — are unequal.
      expect(
        atomPatternBindingsEqual({ "$a": userA }, {
          "$a": userA,
          "$b": userB,
        }),
      ).toBe(false);
      expect(atomPatternBindingsEqual({ "$a": userA }, { "$b": userA }))
        .toBe(false);
      expect(atomPatternBindingsEqual({}, {})).toBe(true);
    });
  });

  describe("instantiateAtomPattern", () => {
    it("substitutes bound placeholders recursively (§4.4.5)", () => {
      expect(
        instantiateAtomPattern(
          { type: CFC_ATOM_TYPE.User, subject: { var: "$p" } },
          { "$p": "did:key:alice" },
        ),
      ).toEqual({ value: userA });
      expect(instantiateAtomPattern({ var: "$a" }, { "$a": userA }))
        .toEqual({ value: userA });
    });

    it("fails closed on unbound or malformed placeholders", () => {
      expect(
        instantiateAtomPattern(
          { type: CFC_ATOM_TYPE.User, subject: { var: "$missing" } },
          {},
        ),
      ).toBeNull();
      expect(instantiateAtomPattern({ var: "$x", extra: 1 }, { "$x": 1 }))
        .toBeNull();
    });

    it("keeps a legitimately-null bound value distinguishable from failure", () => {
      expect(instantiateAtomPattern({ var: "$n" }, { "$n": null }))
        .toEqual({ value: null });
    });

    it("omits explicit-undefined (absence-check) fields from the result", () => {
      expect(
        instantiateAtomPattern(
          { type: "t", absent: undefined, kept: 1 },
          {},
        ),
      ).toEqual({ value: { type: "t", kept: 1 } });
    });

    it("instantiates array-bearing patterns elementwise", () => {
      expect(
        instantiateAtomPattern(
          { type: "t", items: [{ var: "$a" }, 2] },
          { "$a": 1 },
        ),
      ).toEqual({ value: { type: "t", items: [1, 2] } });
      // An unbound placeholder inside an array fails the whole instantiation.
      expect(
        instantiateAtomPattern(
          { type: "t", items: [{ var: "$missing" }] },
          {},
        ),
      ).toBeNull();
    });
  });

  describe("atomEntails", () => {
    it("defaults to structural equality", () => {
      expect(atomEntails(userA, { ...userA })).toBe(true);
      expect(atomEntails(userA, userB)).toBe(false);
      expect(atomEntails("s", "s")).toBe(true);
    });

    it("orders Expires by timestamp: earlier deadline entails later", () => {
      const soon = cfcAtom.expires(1_000);
      const later = cfcAtom.expires(2_000);
      expect(atomEntails(soon, later)).toBe(true);
      expect(atomEntails(later, soon)).toBe(false);
      expect(atomEntails(soon, cfcAtom.expires(1_000))).toBe(true);
    });

    it("fails closed on malformed Expires and unknown families", () => {
      const malformed = { type: CFC_ATOM_TYPE.Expires, timestamp: "tomorrow" };
      expect(atomEntails(malformed, cfcAtom.expires(9))).toBe(false);
      expect(atomEntails(cfcAtom.expires(9), malformed)).toBe(false);
      expect(atomEntails(malformed, { ...malformed })).toBe(true);
      const nan = { type: CFC_ATOM_TYPE.Expires, timestamp: NaN };
      expect(atomEntails(nan, cfcAtom.expires(9))).toBe(false);
      // A NON-CANONICAL Expires (extra fields) must NOT participate in
      // timestamp ordering — else a ceiling Expires(1000) would admit it even
      // though deepEqual rejects it (codex/cubic P1 on #4547). It only entails
      // its structural equal.
      const extraField = {
        type: CFC_ATOM_TYPE.Expires,
        timestamp: 2000,
        scope: "x",
      };
      expect(atomEntails(cfcAtom.expires(1000), extraField)).toBe(false);
      expect(atomEntails(extraField, cfcAtom.expires(3000))).toBe(false);
      expect(atomEntails(extraField, { ...extraField })).toBe(true);
      // …and it is outside a canonical Expires ceiling.
      expect(clauseSubsumes(cfcAtom.expires(1000), extraField)).toBe(false);
      // No cross-family or structural-similarity order.
      expect(atomEntails(userA, spaceX)).toBe(false);
      expect(
        atomEntails(
          { type: "https://example.com/atoms/Custom", level: 1 },
          { type: "https://example.com/atoms/Custom", level: 2 },
        ),
      ).toBe(false);
    });

    it("reaches clause subsumption: an Expires ceiling admits later-expiring labels only", () => {
      // Ceiling Expires(t_c) admits contexts up to t_c; the label must allow
      // every such context, so it needs t_c <= t_l.
      expect(clauseSubsumes(cfcAtom.expires(1_000), cfcAtom.expires(2_000)))
        .toBe(true);
      expect(clauseSubsumes(cfcAtom.expires(2_000), cfcAtom.expires(1_000)))
        .toBe(false);
    });

    it("tells apart two special objects of one class by their content", () => {
      const bytes = (...content: number[]) =>
        new FabricBytes(new Uint8Array(content));
      expect(atomEntails(bytes(1, 2), bytes(1, 2))).toBe(true);
      expect(atomEntails(bytes(1, 2), bytes(3, 4))).toBe(false);
    });
  });

  describe("new atom families (registry §15)", () => {
    it("mint helpers omit absent optional fields entirely", () => {
      expect(cfcAtom.boundaryContext("sink", "fetchData")).toEqual({
        type: CFC_ATOM_TYPE.BoundaryContext,
        key: "sink",
        value: "fetchData",
      });
      expect(Object.hasOwn(cfcAtom.boundaryContext("sinkClass"), "value"))
        .toBe(false);
      expect(
        cfcAtom.boundaryContext("intent", undefined, { "/": "intent" }).ref,
      ).toEqual({ "/": "intent" });
      const screened = cfcAtom.caveatScreened({
        kind: "k",
        source: { "/": "doc" },
        stage: "ingress",
        detector: cfcAtom.builtin("detector"),
        verdict: "pass",
        valueRef: undefined,
      });
      expect(Object.hasOwn(screened, "valueRef")).toBe(false);
      expect(screened.type).toBe(CFC_ATOM_TYPE.CaveatScreened);
    });

    it("mints the disclosure/disclaimer/assessment evidence shapes", () => {
      const source = { "/": "doc" };
      const renderRef = { seq: 1, rootRef: { "/": "root" } };
      const rendered = cfcAtom.disclosureRendered({
        kind: "warning",
        source,
        sink: "display",
        renderRef,
        snapshotDigest: "sha256:snap",
      });
      expect(rendered.type).toBe(CFC_ATOM_TYPE.DisclosureRendered);
      expect(Object.hasOwn(rendered, "user")).toBe(false);
      const acknowledged = cfcAtom.disclosureAcknowledged({
        user: "did:key:alice",
        kind: "warning",
        source,
        renderRef,
        snapshotDigest: "sha256:snap",
        sink: "display",
      });
      expect(acknowledged.type).toBe(CFC_ATOM_TYPE.DisclosureAcknowledged);
      expect(acknowledged.sink).toBe("display");
      const attached = cfcAtom.disclaimerAttached({
        sink: "sendMail",
        kind: "external-content",
        source,
        disclaimerDigest: "sha256:d",
      });
      expect(attached.type).toBe(CFC_ATOM_TYPE.DisclaimerAttached);
      const assessment = cfcAtom.caveatAssessment({
        kind: "warning",
        source,
        assessor: cfcAtom.builtin("assessor"),
        evidenceDigest: "sha256:e",
        result: "supported",
      });
      expect(assessment.type).toBe(CFC_ATOM_TYPE.CaveatAssessment);
      expect(Object.hasOwn(assessment, "sink")).toBe(false);
    });

    it("declares §15 propagation classes for the new integrity families", () => {
      // Value-bound: exact-current-value claims via valueRef binding.
      expect(atomPropagationClass({ type: CFC_ATOM_TYPE.CaveatScreened }))
        .toBe("value-bound");
      // Provenance: evidence about a specific event/boundary/role, never a
      // claim about derived content.
      for (
        const type of [
          CFC_ATOM_TYPE.BoundaryContext,
          CFC_ATOM_TYPE.CaveatAssessment,
          CFC_ATOM_TYPE.DisclaimerAttached,
          CFC_ATOM_TYPE.DisclosureAcknowledged,
          CFC_ATOM_TYPE.DisclosureRendered,
          CFC_ATOM_TYPE.HasRole,
        ]
      ) {
        expect(atomPropagationClass({ type })).toBe("provenance");
      }
      // String atoms and kind-shaped records have no registered class —
      // fail-safe value-bound.
      expect(atomPropagationClass("string-atom")).toBe("value-bound");
      expect(atomPropagationClass({ kind: "authored-by" }))
        .toBe("value-bound");
    });
  });
});
