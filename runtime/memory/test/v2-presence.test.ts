import { expect } from "@std/expect";

import type { PresenceFacets } from "../v2.ts";
import {
  MAX_PRESENCE_FACETS,
  parsePresenceFacets,
  PresenceError,
  validatePresencePublication,
} from "../v2/presence.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** Facets named `f0`, `f1`, ..., `count` of them. */
const facetsOf = (count: number): PresenceFacets =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`f${index}`, { index }]),
  );

describe("presence", () => {
  describe("parsePresenceFacets()", () => {
    it("returns a map of plain objects under acceptable names as given", () => {
      expect(parsePresenceFacets({ cursor: { line: 3 }, "sel-1": {} }))
        .toEqual({ cursor: { line: 3 }, "sel-1": {} });
    });

    it("returns `null` for a value that is not a plain object", () => {
      for (const value of [null, "cursor", 3, [{ line: 3 }]]) {
        expect(parsePresenceFacets(value)).toBeNull();
      }
    });

    it("returns `null` for a facet that is not a plain object", () => {
      for (const facet of [null, "here", 3, [1, 2]]) {
        expect(parsePresenceFacets({ cursor: { line: 3 }, other: facet }))
          .toBeNull();
      }
    });

    it("returns `null` for a facet under an unacceptable name", () => {
      expect(parsePresenceFacets({ Cursor: { line: 3 } })).toBeNull();
    });
  });

  describe("validatePresencePublication()", () => {
    it("returns a publication holding as many facets as a record may", () => {
      const publication = {
        name: "Ada",
        facets: facetsOf(MAX_PRESENCE_FACETS),
      };
      expect(validatePresencePublication(publication)).toBe(publication);
    });

    it("throws `PresenceError` for a publication holding one facet more", () => {
      const publication = {
        name: "Ada",
        facets: facetsOf(MAX_PRESENCE_FACETS + 1),
      };
      expect(() => validatePresencePublication(publication)).toThrow(
        PresenceError,
      );
      expect(() => validatePresencePublication(publication)).toThrow(
        `Presence record holds more than ${MAX_PRESENCE_FACETS} facets`,
      );
    });
  });
});
