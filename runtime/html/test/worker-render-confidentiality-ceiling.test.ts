import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";

import { normalizeRenderConfidentialityCeiling } from "../src/worker/types.ts";

describe("normalizeRenderConfidentialityCeiling()", () => {
  const atom = cfcAtom.resource("medical");

  it("returns undefined for an absent ceiling", () => {
    expect(normalizeRenderConfidentialityCeiling(undefined)).toBeUndefined();
  });

  it("keeps the atoms and caveat kinds of a well-formed ceiling", () => {
    expect(
      normalizeRenderConfidentialityCeiling({
        atoms: [atom],
        caveatKinds: ["prompt-influence"],
      }),
    ).toEqual({ atoms: [atom], caveatKinds: ["prompt-influence"] });
  });

  it("reads a ceiling carrying neither field as the empty ceiling", () => {
    expect(normalizeRenderConfidentialityCeiling({})).toEqual({
      atoms: [],
      caveatKinds: [],
    });
  });

  describe("a value that is not an object at all", () => {
    // This is the case the normalization exists for: the ceiling crosses a
    // postMessage seam unvalidated, so a malformed one becomes an empty
    // ceiling, which renders public content only. Returning `undefined` would
    // restore the no-ceiling default and render everything.

    for (
      const [name, value] of [
        ["a string", "medical"],
        ["a number", 1],
        ["null", null],
        ["a boolean", true],
      ] as const
    ) {
      it(`reads ${name} as an empty ceiling rather than as no ceiling`, () => {
        const ceiling = normalizeRenderConfidentialityCeiling(value);
        expect(ceiling).toEqual({});
        expect(ceiling?.atoms ?? []).toEqual([]);
        expect(ceiling?.caveatKinds ?? []).toEqual([]);
      });
    }
  });

  it("reads an array as the empty ceiling", () => {
    expect(normalizeRenderConfidentialityCeiling([atom])).toEqual({
      atoms: [],
      caveatKinds: [],
    });
  });

  it("drops a malformed atoms field without dropping the caveat kinds", () => {
    expect(
      normalizeRenderConfidentialityCeiling({
        atoms: "medical",
        caveatKinds: ["prompt-influence"],
      }),
    ).toEqual({ atoms: [], caveatKinds: ["prompt-influence"] });
  });

  it("drops a malformed caveatKinds field without dropping the atoms", () => {
    expect(
      normalizeRenderConfidentialityCeiling({
        atoms: [atom],
        caveatKinds: 7,
      }),
    ).toEqual({ atoms: [atom], caveatKinds: [] });
  });

  it("keeps only the string entries of a caveatKinds array", () => {
    expect(
      normalizeRenderConfidentialityCeiling({
        caveatKinds: ["prompt-influence", 7, null, "authorship"],
      }),
    ).toEqual({ atoms: [], caveatKinds: ["prompt-influence", "authorship"] });
  });
});
