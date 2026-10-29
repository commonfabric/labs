import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ContextualFlowControl } from "../src/cfc.ts";
import {
  isPromptInjectionMaterialRiskAtom,
  schemaWithInjectionSafeAnnotations,
} from "../src/cfc/schema-sanitization.ts";
import { isOrClause } from "../src/cfc/clause.ts";
import type { JSONSchema } from "../src/builder/types.ts";

// Epic A5 (docs/history/plans/cfc-future-work-implementation.md): the flat-assumption
// consumer sweep. Every remaining site that iterates `.confidentiality` as a
// bare atom list must treat an OR-clause CORRECTLY — opaque where that is
// fail-safe (over-restrict), and clause-aware where opacity would under-
// restrict. These tests pin the posture per consumer so a future edit that
// mishandles a clause is caught.

const A = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "did",
  subject: "did:key:alice",
};
const B = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "did",
  subject: "did:key:bob",
};

const PROMPT_RISK = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind:
    "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
};

// An instruction-inert schema: an enum of primitives. Sanitizing it strips
// material-risk caveats from the observed confidentiality it carries.
const inertSchema = { enum: ["x", "y"] } as const satisfies JSONSchema;

const sanitizedConfidentiality = (observed: unknown[]): unknown[] => {
  const annotated = schemaWithInjectionSafeAnnotations(
    inertSchema,
    observed as never,
  );
  const ifc = (annotated as { ifc?: { confidentiality?: unknown[] } }).ifc;
  return ifc?.confidentiality ?? [];
};

describe("A5 flat-assumption consumer sweep", () => {
  describe("schema-sanitization material-risk scan descends into OR-clauses", () => {
    it("the single-atom predicate does not classify a clause object", () => {
      // isPromptInjectionMaterialRiskAtom is an atom predicate — a clause is
      // not a single atom, so it returns false. The SCAN (below) is what
      // handles clauses; the predicate alone must not be relied on for them.
      expect(isPromptInjectionMaterialRiskAtom({ anyOf: [A, PROMPT_RISK] }))
        .toBe(false);
      expect(isPromptInjectionMaterialRiskAtom(PROMPT_RISK)).toBe(true);
    });

    it("strips a material-risk caveat hidden as an OR-clause alternative", () => {
      // {anyOf:[risk, A]} is NOT more-restrictive when preserved (a ceiling
      // naming A subsumes the clause), so the scan must descend and remove the
      // risk alternative — leaving the sibling (unwrapped).
      const out = sanitizedConfidentiality([{ anyOf: [PROMPT_RISK, A] }]);
      expect(out).toContainEqual(A);
      expect(out.some((c) => isOrClause(c))).toBe(false);
      expect(JSON.stringify(out)).not.toContain("prompt-injection-risk");
    });

    it("drops an OR-clause whose only alternative is material-risk", () => {
      const out = sanitizedConfidentiality([{ anyOf: [PROMPT_RISK] }, A]);
      expect(out).toEqual([A]);
    });

    it("preserves a benign OR-clause and still strips a top-level caveat", () => {
      const out = sanitizedConfidentiality([{ anyOf: [A, B] }, PROMPT_RISK]);
      expect(out.some((c) => isOrClause(c))).toBe(true);
      expect(JSON.stringify(out)).not.toContain("prompt-injection-risk");
    });
  });

  describe("legacy classification walker (cfc.ts lubSchema)", () => {
    it("carries an OR-clause through the coarse join opaquely (no crash, no drop)", () => {
      const schema = {
        type: "string",
        ifc: { confidentiality: [{ anyOf: [A, B] }] },
      } as const satisfies JSONSchema;
      const atoms = ContextualFlowControl.lubSchema(schema);
      expect(atoms).toBeDefined();
      // The clause survives as one opaque member — not flattened into its
      // alternatives (which would under-represent the AND-of-the-clause).
      expect(atoms!.some(isOrClause)).toBe(true);
      expect(atoms!.some((a) => a === A || a === B)).toBe(false);
    });

    it("unions a clause with sibling flat atoms without merging them", () => {
      const schema = {
        type: "object",
        ifc: { confidentiality: [A] },
        properties: {
          child: {
            type: "string",
            ifc: { confidentiality: [{ anyOf: [A, B] }] },
          },
        },
      } as const satisfies JSONSchema;
      const atoms = ContextualFlowControl.lubSchema(schema) ?? [];
      // Both the flat A and the {A∨B} clause are present as distinct members.
      expect(atoms).toContainEqual(A);
      expect(atoms.some(isOrClause)).toBe(true);
    });
  });
});
