import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";

import { matchesOnlyValueBoundClaims } from "../../src/cfc/atom-classes.ts";

const ATOM_URI = "https://commonfabric.org/cfc/atom/";

describe("atom-classes", () => {
  describe("matchesOnlyValueBoundClaims()", () => {
    it("returns `true` for a registered value-bound family and an unregistered one", () => {
      expect(matchesOnlyValueBoundClaims({ type: CFC_ATOM_TYPE.InjectionSafe }))
        .toBe(true);
      expect(
        matchesOnlyValueBoundClaims({ type: "https://example.com/Extension" }),
      ).toBe(true);
    });

    it("returns `false` for hereditary and provenance families", () => {
      expect(
        matchesOnlyValueBoundClaims({ type: CFC_ATOM_TYPE.PolicyCertified }),
      ).toBe(false);
      expect(matchesOnlyValueBoundClaims({ type: CFC_ATOM_TYPE.HasRole }))
        .toBe(false);
    });

    it("returns `false` for a provenance family the class table does not list", () => {
      expect(matchesOnlyValueBoundClaims({ type: `${ATOM_URI}UIRuntime` }))
        .toBe(false);
      expect(
        matchesOnlyValueBoundClaims({ type: `${ATOM_URI}GestureProvenance` }),
      ).toBe(false);
    });

    it("returns `true` for an `IntegritySummary` only on a surviving-content basis", () => {
      const type = `${ATOM_URI}IntegritySummary`;
      expect(matchesOnlyValueBoundClaims({ type, basis: "surviving-content" }))
        .toBe(true);
      expect(matchesOnlyValueBoundClaims({ type, basis: "consumed-inputs" }))
        .toBe(false);
      expect(matchesOnlyValueBoundClaims({ type })).toBe(false);
    });

    it("returns `false` for a pattern that names no concrete family", () => {
      expect(matchesOnlyValueBoundClaims("did:key:alice")).toBe(false);
      expect(matchesOnlyValueBoundClaims([{ type: CFC_ATOM_TYPE.Caveat }]))
        .toBe(false);
      expect(matchesOnlyValueBoundClaims({ type: { $var: "t" } })).toBe(false);
      expect(matchesOnlyValueBoundClaims({ subject: "did:key:alice" }))
        .toBe(false);
    });
  });
});
