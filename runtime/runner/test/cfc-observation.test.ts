import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cfcConfidentialityForObservationNode,
  cfcObservationFitsCeiling,
  cfcOpaqueLinkForPath,
  joinCfcObservedConfidentiality,
  uniqueCfcAtoms,
} from "../src/cfc/mod.ts";

describe("CFC observation helpers", () => {
  it("deduplicates observed confidentiality atoms by value", () => {
    const atom = { type: "secret", source: "a" };

    expect(uniqueCfcAtoms([atom, { type: "secret", source: "a" }, "public"]))
      .toEqual([atom, "public"]);
    expect(joinCfcObservedConfidentiality([[atom], [atom], ["public"]]))
      .toEqual([atom, "public"]);
  });

  it("deduplicates the same atoms whether or not the kept set is grouped", () => {
    // `uniqueCfcAtoms` compares a candidate against everything kept while the
    // kept set is short, and against one group of it past a limit. A list long
    // enough to cross that limit has to produce the same result as the same
    // atoms in a list that does not, or a label's atoms would depend on how
    // many other atoms happened to arrive with them.

    const atom = (index: number) => ({
      type: "cf:link-reference",
      source: { id: "of:document", path: ["field", String(index)] },
    });
    const distinct = Array.from({ length: 40 }, (_, index) => atom(index));
    // Each atom a second time, sharing no object with the first, so that
    // nothing in the comparison that drops the repeat reduces to `Object.is`.
    const repeated = Array.from({ length: 40 }, (_, index) => atom(index));

    expect(uniqueCfcAtoms([...distinct, ...repeated])).toEqual(distinct);
    for (const size of [1, 8, 17, 40]) {
      const prefix = distinct.slice(0, size);
      expect(uniqueCfcAtoms([...prefix, ...prefix])).toEqual(prefix);
    }
  });

  it("preserves first structural spellings and distinct signed zeros with repeated references", () => {
    const first = { kind: "source", fields: [1, 2] };
    const equivalent = { fields: [1, 2], kind: "source" };
    const actual = uniqueCfcAtoms([
      first,
      equivalent,
      first,
      -0,
      0,
      -0,
      equivalent,
    ]);
    expect(actual).toHaveLength(3);
    expect(actual[0]).toBe(first);
    expect(Object.is(actual[1], -0)).toBe(true);
    expect(Object.is(actual[2], 0)).toBe(true);
  });

  it("checks whether observed confidentiality fits an observation ceiling", () => {
    const secret = { type: "secret" };

    expect(cfcObservationFitsCeiling([], ["internal"])).toBe(true);
    expect(cfcObservationFitsCeiling(["internal"], ["internal", secret]))
      .toBe(true);
    expect(cfcObservationFitsCeiling([secret], [{ type: "secret" }]))
      .toBe(true);
    expect(cfcObservationFitsCeiling(["secret"], ["internal"])).toBe(false);
  });

  it("combines schema and label-view confidentiality for an observation node", () => {
    const result = cfcConfidentialityForObservationNode({
      schema: {
        type: "string",
        ifc: { confidentiality: ["schema-secret"] },
      },
      labelView: {
        version: 1,
        entries: [
          { path: ["body"], label: { confidentiality: ["body-secret"] } },
          { path: ["other"], label: { confidentiality: ["other-secret"] } },
        ],
      },
      logicalPath: ["body", "summary"],
    });

    expect(result).toEqual(["schema-secret", "body-secret"]);
  });

  it("builds opaque links with JSON Pointer escaping", () => {
    expect(cfcOpaqueLinkForPath("run/id", ["a/b", "~c", 2])).toEqual({
      "@link": "opaque:run%2Fid#/a~1b/~0c/2",
    });
  });
});
