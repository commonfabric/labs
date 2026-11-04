import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  cfcAtom,
} from "@commonfabric/api/cfc";

import { atomEntails, matchAtomPattern } from "../src/cfc/atom-pattern.ts";
import { clauseSubsumes } from "../src/cfc/clause.ts";
import { evaluateExchangeRules } from "../src/cfc/exchange-eval.ts";
import {
  commitCfcFieldValue,
  transformCfcLabelForCrossSpacePersist,
} from "../src/cfc/label-representation.ts";
import {
  atomsOutsideCeiling,
  cfcIntegritySatisfiesFloorCoherently,
} from "../src/cfc/observation.ts";
import { buildCfcPolicySnapshot } from "../src/cfc/policy.ts";
import { createRenderConfidentialityResolver } from "../src/cfc/render-ceiling.ts";
import {
  dischargeMaterialRiskAtoms,
  schemaWithInjectionSafeAnnotations,
} from "../src/cfc/schema-sanitization.ts";
import { STANDARD_PROMPT_CAVEAT_POLICY } from "../src/cfc/standard-profile.ts";

describe("CFC commitment-form matching (inv-12 Stage 1)", () => {
  // Inv-12 Stage 1 same-form matching (SC-25; design §2; spec §4.6.4.1):
  // enforcement keeps working on commitment forms, fail-closed where it cannot.
  // Read gating digests the candidate and compares; a CONCRETE exchange-rule
  // pattern value digest-matches a committed field; a VARIABLE over a committed
  // field does not bind (the rule does not fire — the fail-closed direction: an
  // unevaluable release does not happen).

  const reader = "did:key:reader";
  const stranger = "did:key:stranger";
  const committedUser = {
    type: CFC_ATOM_TYPE.User,
    subject: commitCfcFieldValue(reader),
  };

  describe("read gating / clause satisfaction", () => {
    it("satisfies a committed User clause by digesting the acting reader", () => {
      const plainReader = { type: CFC_ATOM_TYPE.User, subject: reader };
      expect(atomEntails(plainReader, committedUser)).toBe(true);
      expect(clauseSubsumes(plainReader, committedUser)).toBe(true);
      expect(
        atomsOutsideCeiling([committedUser], [plainReader]),
      ).toEqual([]);
    });

    it("rejects a non-matching reader against a committed clause", () => {
      const wrongReader = { type: CFC_ATOM_TYPE.User, subject: stranger };
      expect(atomEntails(wrongReader, committedUser)).toBe(false);
      expect(clauseSubsumes(wrongReader, committedUser)).toBe(false);
      expect(
        atomsOutsideCeiling([committedUser], [wrongReader]),
      ).toEqual([committedUser]);
    });

    it("matches committed forms inside OR-clause alternatives", () => {
      const clause = {
        anyOf: [
          committedUser,
          { type: CFC_ATOM_TYPE.Space, id: "did:key:spaceA" },
        ],
      };
      // A ceiling admitting the (plaintext) reader subsumes the clause via
      // the committed alternative.
      expect(
        atomsOutsideCeiling(
          [clause],
          [{ type: CFC_ATOM_TYPE.User, subject: reader }],
        ),
      ).toEqual([]);
    });
  });

  describe("exchange-rule matching (matchAtomPattern)", () => {
    it("matches a module-policy reference across a committed subject", () => {
      const plain = cfcAtom.modulePolicyRef(
        "sha256:module",
        "releaseRules",
        "sha256:manifest",
        reader,
      );
      expect(matchAtomPattern(plain, {
        // Spreading a discriminated union leaves `?: never` fields behind,
        // which no `CfcAtom` admits; the runtime value is a policy-ref atom.
        ...plain,
        subject: commitCfcFieldValue(reader),
      } as unknown as CfcAtom)).not.toBeNull();
      expect(matchAtomPattern(plain, {
        ...plain,
        subject: commitCfcFieldValue(stranger),
      } as unknown as CfcAtom)).toBeNull();
    });

    it("digest-matches a CONCRETE pattern value against a committed field", () => {
      const bindings = matchAtomPattern(
        { type: CFC_ATOM_TYPE.User, subject: reader },
        committedUser,
      );
      expect(bindings).not.toBeNull();
      // And rejects a concrete mismatch.
      expect(
        matchAtomPattern(
          { type: CFC_ATOM_TYPE.User, subject: stranger },
          committedUser,
        ),
      ).toBeNull();
    });

    it("does NOT bind a variable over a committed field (rule does not fire)", () => {
      expect(
        matchAtomPattern(
          { type: CFC_ATOM_TYPE.User, subject: { var: "$u" } },
          committedUser,
        ),
      ).toBeNull();
    });

    it("does not let a record pattern containing variables see inside a marker", () => {
      const committedCaveat = {
        type: CFC_ATOM_TYPE.Caveat,
        kind: "derived-from",
        source: commitCfcFieldValue({ space: "did:key:a", id: "of:doc" }),
      };
      expect(
        matchAtomPattern(
          {
            type: CFC_ATOM_TYPE.Caveat,
            source: { space: { var: "$sp" }, id: "of:doc" },
          },
          committedCaveat,
        ),
      ).toBeNull();
      // An absence requirement (explicit-undefined field) is a shape
      // constraint, not a value — the pattern is not concrete and cannot
      // digest-match the marker either (fail closed).
      expect(
        matchAtomPattern(
          {
            type: CFC_ATOM_TYPE.Caveat,
            source: { space: "did:key:a", id: "of:doc", extra: undefined },
          },
          committedCaveat,
        ),
      ).toBeNull();
    });

    it("digest-matches a concrete ARRAY pattern value against a committed field", () => {
      // TransformedBy.identity.bindingPath commits an ARRAY field value —
      // the concrete-pattern check must recurse through array patterns
      // (and refuse arrays that carry variables).
      const bindingPath = ["handlers", "onSave"];
      const committed = {
        type: CFC_ATOM_TYPE.TransformedBy,
        identity: { bindingPath: commitCfcFieldValue(bindingPath) },
      };
      expect(
        matchAtomPattern(
          {
            type: CFC_ATOM_TYPE.TransformedBy,
            identity: { bindingPath },
          },
          committed,
        ),
      ).not.toBeNull();
      expect(
        matchAtomPattern(
          {
            type: CFC_ATOM_TYPE.TransformedBy,
            identity: { bindingPath: ["handlers", { var: "$x" }] },
          },
          committed,
        ),
      ).toBeNull();
    });

    it("unifies an already-bound variable against a committed field by digest", () => {
      // The variable binds PLAINTEXT from the first atom, then unifies with
      // the second atom's committed field via digest comparison — the
      // binding comparison of evidence correlation, extended across forms.
      const bound = matchAtomPattern(
        { type: CFC_ATOM_TYPE.User, subject: { var: "$u" } },
        { type: CFC_ATOM_TYPE.User, subject: reader },
      );
      expect(bound).not.toBeNull();
      expect(
        matchAtomPattern(
          { type: CFC_ATOM_TYPE.HasRole, principal: { var: "$u" } },
          {
            type: CFC_ATOM_TYPE.HasRole,
            principal: commitCfcFieldValue(reader),
            space: "did:key:spaceA",
            role: "reader",
          },
          bound!,
        ),
      ).not.toBeNull();
      // A digest of a DIFFERENT principal does not unify.
      expect(
        matchAtomPattern(
          { type: CFC_ATOM_TYPE.HasRole, principal: { var: "$u" } },
          {
            type: CFC_ATOM_TYPE.HasRole,
            principal: commitCfcFieldValue(stranger),
            space: "did:key:spaceA",
            role: "reader",
          },
          bound!,
        ),
      ).toBeNull();
    });
  });

  describe("evidence binding (prompt-caveat profile / sanitizer)", () => {
    const snapshot = buildCfcPolicySnapshot(STANDARD_PROMPT_CAVEAT_POLICY)!;
    const source = { space: "did:key:a", id: "of:remote", path: ["body"] };

    it("discharges an influence caveat whose EVIDENCE carries the committed source", () => {
      // The caveat (label side) is plaintext; the disclosure evidence arrived
      // in committed form (cross-space carried integrity). The correlation
      // variable binds plaintext from the caveat and digest-compares against
      // the committed evidence field.
      const label = {
        confidentiality: [
          cfcAtom.caveat(CFC_CONCEPT_KIND.PromptInfluence, source as never),
        ],
      };
      const result = evaluateExchangeRules(label, snapshot, {
        integrity: [{
          type: CFC_ATOM_TYPE.DisclosureRendered,
          kind: CFC_CONCEPT_KIND.PromptInfluence,
          source: commitCfcFieldValue(source),
          sink: "chat",
          renderRef: { seq: 1, rootRef: "of:render" },
          snapshotDigest: "digest",
        }],
        boundary: [
          cfcAtom.boundaryContext("sinkClass", "display"),
          cfcAtom.boundaryContext("sink", "chat"),
        ],
      });
      expect(result.exhausted).toBe(false);
      expect(result.label.confidentiality).toEqual([]);
      expect(result.firings.length).toBe(1);
    });

    it("does not discharge when the committed evidence source mismatches", () => {
      const label = {
        confidentiality: [
          cfcAtom.caveat(CFC_CONCEPT_KIND.PromptInfluence, source as never),
        ],
      };
      const result = evaluateExchangeRules(label, snapshot, {
        integrity: [{
          type: CFC_ATOM_TYPE.DisclosureRendered,
          kind: CFC_CONCEPT_KIND.PromptInfluence,
          source: commitCfcFieldValue({ ...source, id: "of:other" }),
          sink: "chat",
          renderRef: { seq: 1, rootRef: "of:render" },
          snapshotDigest: "digest",
        }],
        boundary: [
          cfcAtom.boundaryContext("sinkClass", "display"),
          cfcAtom.boundaryContext("sink", "chat"),
        ],
      });
      expect(result.firings.length).toBe(0);
      expect(result.label.confidentiality?.length).toBe(1);
    });

    it("does NOT fire a variable-binding rule on a COMMITTED caveat source (fail closed)", () => {
      // The label side is committed: the profile's `source: {var:"$s"}`
      // appliesTo cannot bind the marker — the release simply does not
      // happen at the destination (design §2's fail-closed direction).
      const label = {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Caveat,
          kind: CFC_CONCEPT_KIND.PromptInfluence,
          source: commitCfcFieldValue(source),
        }],
      };
      const result = evaluateExchangeRules(label, snapshot, {
        integrity: [{
          type: CFC_ATOM_TYPE.DisclosureRendered,
          kind: CFC_CONCEPT_KIND.PromptInfluence,
          source,
          sink: "chat",
          renderRef: { seq: 1, rootRef: "of:render" },
          snapshotDigest: "digest",
        }],
        boundary: [
          cfcAtom.boundaryContext("sinkClass", "display"),
          cfcAtom.boundaryContext("sink", "chat"),
        ],
      });
      expect(result.firings.length).toBe(0);
      expect(result.label.confidentiality?.length).toBe(1);
    });

    it("sanitizer still discharges material-risk caveats with committed sources", () => {
      // The material-risk discharge rules are source-agnostic ({type, kind}
      // subset patterns), so the commitment form must not break them: the
      // sanitizer's InjectionSafe discharge reaches a committed-source caveat
      // exactly as it reached the plaintext form.
      const committed = {
        type: CFC_ATOM_TYPE.Caveat,
        kind: "prompt-injection-risk-unscreened",
        source: commitCfcFieldValue(source),
      };
      expect(dischargeMaterialRiskAtoms([committed])).toEqual([]);
    });

    it("sanitizer annotation preserves committed atoms intact (B6 composition)", () => {
      // The B6 sanitizer merges observed confidentiality into schema ifc on
      // NEW values. A sanitized copy whose ORIGIN labels were cross-space
      // (already committed at rest) must stay committed end-to-end: the
      // merge neither unwraps nor drops the marker, so the declared entry
      // minted from this schema re-persists the committed form verbatim.
      const committedUserAtom = {
        type: CFC_ATOM_TYPE.User,
        subject: commitCfcFieldValue(reader),
      };
      const annotated = schemaWithInjectionSafeAnnotations(
        { type: "string" },
        [committedUserAtom],
      ) as { ifc?: { confidentiality?: unknown[] } };
      expect(annotated.ifc?.confidentiality).toContainEqual(committedUserAtom);
    });
  });

  describe("coherent integrity witnesses across representation forms", () => {
    // §8.10.3 coherent floors demand ONE shared witness atom across every
    // consumed leaf. During the documented mixed migration period the same
    // logical evidence can be consumed in plaintext form from one leaf and
    // committed form from another; the witness KEY must normalize across
    // forms or a genuinely shared witness is rejected (codex/cubic P2 on
    // this PR).
    const plainRole = {
      type: CFC_ATOM_TYPE.HasRole,
      principal: reader,
      space: "did:key:spaceA",
      role: "reader",
    };
    const committedRole = transformCfcLabelForCrossSpacePersist({
      integrity: [plainRole],
    }).integrity![0];
    const requirement = [{ type: CFC_ATOM_TYPE.HasRole, role: "reader" }];

    it("coheres one witness consumed in plaintext and committed forms", () => {
      expect(
        cfcIntegritySatisfiesFloorCoherently(
          [[plainRole], [committedRole]],
          requirement,
        ),
      ).toBe(true);
    });

    it("still rejects genuinely different witnesses across forms", () => {
      const otherRole = { ...plainRole, principal: stranger };
      const committedOther = transformCfcLabelForCrossSpacePersist({
        integrity: [otherRole],
      }).integrity![0];
      expect(
        cfcIntegritySatisfiesFloorCoherently(
          [[plainRole], [committedOther]],
          requirement,
        ),
      ).toBe(false);
    });
  });

  describe("ungrantable read-failed marker", () => {
    it("keeps a committed spelling of the marker ungrantable", () => {
      // The Stage 1 transform never commits the marker (a bare string atom,
      // not a classified field), so a {digestOf} spelling is crafted — and
      // it must stay outside every declared ceiling, exactly like the
      // string form (audit item 22).
      const committedMarker = commitCfcFieldValue("cfc:label-read-failed");
      expect(
        atomsOutsideCeiling([committedMarker], [committedMarker]),
      ).toEqual([committedMarker]);
      expect(
        atomsOutsideCeiling(
          [{
            anyOf: [committedMarker, {
              type: CFC_ATOM_TYPE.User,
              subject: reader,
            }],
          }],
          ["cfc:label-read-failed"],
        ).length,
      ).toBe(1);
    });
  });

  describe("Space.id stays public — §4.9.3 membership release regression", () => {
    it("releases a cross-space label via plaintext Space.id + membership while the committed User clause matches the digested reader", () => {
      // A cross-space transformed label: Space.id PLAINTEXT (the table's
      // recorded exception — the ACL point query must dereference it),
      // User.subject committed.
      const spaceId = "did:key:shared-space";
      const label = {
        confidentiality: [
          { type: CFC_ATOM_TYPE.Space, id: spaceId },
          committedUser,
        ],
      };
      const resolve = createRenderConfidentialityResolver({
        actingPrincipal: reader,
        membershipProvider: {
          readerRole: (id: string) => id === spaceId ? "reader" : null,
          subscribe: () => () => {},
        },
      });
      const resolved = resolve(label);
      // The membership rule fired: the Space clause gained the acting
      // reader as an alternative (only possible because Space.id stayed
      // dereferenceable plaintext).
      const ceiling = [{ type: CFC_ATOM_TYPE.User, subject: reader }];
      expect(atomsOutsideCeiling(resolved, ceiling)).toEqual([]);
    });

    it("fails closed when a committed Space.id blocks the membership variable", () => {
      // Defensive pin for the fail-closed direction the table exception
      // avoids: were Space.id committed, the SpaceReaderAccess variable
      // could not bind and membership-based release would not fire.
      const spaceId = "did:key:shared-space";
      const label = {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Space,
          id: commitCfcFieldValue(spaceId),
        }],
      };
      const resolve = createRenderConfidentialityResolver({
        actingPrincipal: reader,
        membershipProvider: {
          readerRole: () => "reader",
          subscribe: () => () => {},
        },
      });
      const resolved = resolve(label);
      expect(
        atomsOutsideCeiling(resolved, [{
          type: CFC_ATOM_TYPE.User,
          subject: reader,
        }]).length,
      ).toBe(1);
    });
  });
});
