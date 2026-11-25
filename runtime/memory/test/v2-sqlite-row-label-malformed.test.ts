import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { describe, it } from "@commonfabric/test-support/test";
import { table } from "../v2/sqlite/schema.ts";
import {
  authoredBy,
  endorsedBy,
  evaluateRowLabel,
  match,
  principal,
  rowLabelSpecOf,
  validateRowLabelSpec,
  whenMatches,
} from "../v2/sqlite/row-label.ts";

// A well-formed match node over the one declared column, `a`, for the cases
// below to vary one field of.
const M = { field: "a", source: "x", flags: "g" };
const principalOf = (match: FabricValue) => ({
  principal: { protocol: "mailto", of: { match } },
});
const dbOwnerTerm = { dbOwner: true };
const conf = (confidentiality: FabricValue) => ({
  version: 1 as const,
  confidentiality,
});
const integ = (integrity: FabricValue) => ({ version: 1, integrity });

describe("row-label", () => {
  describe("builders", () => {
    it("throws from `principal()` given a protocol that is not a DID method name", () => {
      expect(() => principal("Mailto", match({ field: "a" }, /x/))).toThrow(
        'principal(): invalid DID protocol "Mailto"',
      );
    });

    it("throws from `principal()` given a term other than `match()`", () => {
      // @ts-expect-error: the check is for callers the types do not reach.
      expect(() => principal("mailto", { constant: "x" })).toThrow(
        "principal() takes a match(...) term",
      );
    });

    it("throws from `match()` and `whenMatches()` given something other than a field handle", () => {
      // A handle carries only its field name.
      const notHandle = { field: "a", extra: 1 };
      expect(() => match(notHandle, /x/)).toThrow(
        "match() takes a field handle (f.<column>)",
      );
      expect(() => whenMatches(notHandle, /x/, null)).toThrow(
        "whenMatches() takes a field handle (f.<column>)",
      );
    });

    it("throws from `match()` given a pattern that is not a `RegExp`", () => {
      // @ts-expect-error: the check is for callers the types do not reach.
      expect(() => match({ field: "a" }, "x")).toThrow(
        "match() takes a RegExp",
      );
    });

    it("throws from `authoredBy()` and `endorsedBy()` given a term other than `principal()`", () => {
      // @ts-expect-error: the check is for callers the types do not reach.
      expect(() => authoredBy({ dbOwner: true })).toThrow(
        "authoredBy() takes a principal(...) term",
      );
      // @ts-expect-error: the check is for callers the types do not reach.
      expect(() => endorsedBy({ dbOwner: true })).toThrow(
        "endorsedBy() takes a principal(...) term",
      );
    });
  });

  describe("table()", () => {
    it("throws for a rule that returns something other than an object", () => {
      // @ts-expect-error: the check is for callers the types do not reach.
      expect(() => table({ a: "text" }, () => null)).toThrow(
        "table(): a rowLabel rule must return { confidentiality?, integrity? }",
      );
    });
  });

  describe("validateRowLabelSpec()", () => {
    // Each case is a wire-supplied spec, which reaches the validator without
    // passing through the builders.

    const cases: [string, unknown, string][] = [
      ["a spec that is not an object", "x", "rowLabel spec must be an object"],
      [
        "a spec declaring neither half",
        { version: 1 },
        "rowLabel rule must declare confidentiality and/or integrity",
      ],
      [
        "an `any()` alternative gated on an unknown column",
        conf({
          anyOf: [{ when: { match: { ...M, field: "b" } }, then: dbOwnerTerm }],
        }),
        'rule references unknown column "b"',
      ],
      [
        "a match node that is not an object",
        conf(principalOf("x")),
        "principal: malformed match node",
      ],
      [
        "a match node without a field",
        conf(principalOf({ source: "x", flags: "g" })),
        "principal: match without a field",
      ],
      [
        "a match node without a source",
        conf(principalOf({ field: "a", flags: "g" })),
        "principal: match without a source",
      ],
      [
        "a regex longer than the lint allows",
        conf(principalOf({ ...M, source: "x".repeat(513) })),
        "regex too long (513 > 512)",
      ],
      [
        "regex flags JavaScript does not define",
        conf(principalOf({ ...M, flags: "gz" })),
        "principal: invalid regex flags",
      ],
      [
        "a regex source that does not compile",
        conf(principalOf({ ...M, source: "(" })),
        'principal: invalid regex "("',
      ],
      [
        "a negative capture group",
        conf(principalOf({ ...M, group: -1 })),
        "principal: invalid capture group",
      ],
      [
        "a fractional `min`",
        conf(principalOf({ ...M, min: 1.5 })),
        "principal: invalid min",
      ],
      [
        "a principal node that is not an object",
        conf({ principal: "x" }),
        "malformed principal node",
      ],
      [
        "a principal protocol that is not a DID method name",
        conf({ principal: { protocol: "Mailto", of: { match: M } } }),
        'invalid DID protocol "Mailto"',
      ],
      [
        "a principal over a term other than `match()`",
        conf({ principal: { protocol: "mailto", of: {} } }),
        "principal() takes a match(...) term",
      ],
      [
        "an `all()` term that is not an object",
        conf({ allOf: ["x"] }),
        "malformed confidentiality term",
      ],
      [
        "an `all()` term carrying two ops",
        conf({ allOf: [{ dbOwner: true, constant: "c" }] }),
        "ambiguous rowLabel node in confidentiality position: " +
        "{dbOwner, constant} — exactly one op per node (fail closed)",
      ],
      [
        "an `all()` term gated on an unknown column",
        conf({
          allOf: [{ when: { match: { ...M, field: "b" } }, then: dbOwnerTerm }],
        }),
        'rule references unknown column "b"',
      ],
      [
        "an empty `all()`",
        conf({ allOf: [] }),
        "all() needs at least one term",
      ],
      [
        "an integrity term that is not an object",
        integ("x"),
        "malformed integrity term",
      ],
      [
        "an integrity `any()`",
        integ({ anyOf: [{ constant: "c" }] }),
        "disjunctive integrity does not exist (CFC spec §3.1.8): " +
        "integrity is a conjunction combined by meet",
      ],
      [
        "an `authoredBy()` over a term other than `principal()`",
        integ({ authoredBy: "x" }),
        "authoredBy()/endorsedBy() take a principal(...) term",
      ],
      [
        "an empty integrity `intersect()`",
        integ({ intersect: [] }),
        "intersect()/all() need at least one term",
      ],
      [
        "an unknown op inside an integrity `all()`",
        integ({ allOf: [{ currentUser: true }] }),
        "unknown rowLabel op in integrity position: {currentUser}",
      ],
    ];
    for (const [what, spec, reason] of cases) {
      it(`returns a reason for ${what}`, () => {
        expect(validateRowLabelSpec(spec, ["a"])).toBe(reason);
      });
    }

    it("returns `undefined` for an integrity `intersect()` of well-formed terms", () => {
      expect(
        validateRowLabelSpec(
          integ({
            intersect: [
              { constant: "c" },
              { allOf: [{ constant: "c" }, { constant: "d" }] },
            ],
          }),
          ["a"],
        ),
      ).toBeUndefined();
    });
  });

  describe("evaluateRowLabel()", () => {
    // Each spec here skipped validation, so the evaluator's own checks are
    // the only ones between it and a label.

    const ctx = { dbOwner: "did:key:owner" };
    const cases: [
      string,
      FabricValue | undefined,
      FabricValue | undefined,
      string,
    ][] = [
      [
        "a principal whose field is absent from the row",
        principalOf(M),
        undefined,
        'rule input field "a" is absent from the row',
      ],
      [
        "a `when` gate that is not a match",
        { when: "x", then: dbOwnerTerm },
        undefined,
        "malformed when gate (use whenMatches())",
      ],
      [
        "an `any()` alternative that is not an object",
        { anyOf: ["x"] },
        undefined,
        "malformed confidentiality term",
      ],
      [
        "an `any()` that is not a list",
        { anyOf: "x" },
        undefined,
        "malformed any()",
      ],
      [
        "a confidentiality `all()` that is not a list",
        { allOf: "x" },
        undefined,
        "malformed all()",
      ],
      [
        "an integrity term that is not an object",
        undefined,
        "x",
        "malformed integrity term",
      ],
      [
        "an integrity `any()`",
        undefined,
        { anyOf: [] },
        "disjunctive integrity does not exist",
      ],
      [
        "an empty integrity `intersect()`",
        undefined,
        { intersect: [] },
        "malformed intersect()",
      ],
      [
        "an integrity `all()` that is not a list",
        undefined,
        { allOf: "x" },
        "malformed all()",
      ],
      [
        "an unknown integrity op",
        undefined,
        { currentUser: true },
        "unknown rowLabel op in integrity position: {currentUser}",
      ],
    ];
    for (const [what, confidentiality, integrity, error] of cases) {
      it(`returns an error for ${what}`, () => {
        expect(
          evaluateRowLabel({ version: 1, confidentiality, integrity }, {}, ctx),
        ).toEqual({ error });
      });
    }

    it("returns the label for well-formed confidentiality and integrity `all()`s", () => {
      expect(
        evaluateRowLabel(
          {
            version: 1,
            confidentiality: { allOf: [dbOwnerTerm] },
            integrity: { allOf: [{ constant: "c" }] },
          },
          {},
          ctx,
        ),
      ).toEqual({
        confidentiality: [{
          type: "https://commonfabric.org/cfc/atom/User",
          subject: "did:key:owner",
        }],
        integrity: ["c"],
      });
    });

    it("throws the regex engine's error for a source that does not compile", () => {
      // An error that is not a rule failure leaves as itself rather than as
      // an `{ error }` result.
      expect(() =>
        evaluateRowLabel(
          conf(principalOf({ ...M, source: "(" })),
          { a: "x" },
          ctx,
        )
      ).toThrow(SyntaxError);
    });
  });

  describe("rowLabelSpecOf()", () => {
    it("returns the schema's `rowLabel` object", () => {
      const spec = conf(dbOwnerTerm);
      expect(rowLabelSpecOf({ type: "object", rowLabel: spec })).toBe(spec);
    });

    it("returns `undefined` for a schema that is not an object or has no `rowLabel` object", () => {
      expect(rowLabelSpecOf(null)).toBeUndefined();
      expect(rowLabelSpecOf("x")).toBeUndefined();
      expect(rowLabelSpecOf({ type: "object", rowLabel: "x" })).toBeUndefined();
      expect(rowLabelSpecOf({ type: "object" })).toBeUndefined();
    });
  });
});
