import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isBuilderSourceSitesV1 } from "../../src/core/runtime-contract.ts";

describe("runtime-contract", () => {
  describe("isBuilderSourceSitesV1()", () => {
    const site = { line: 1, col: 0 };

    it("returns `true` for a sidecar with no sites", () => {
      expect(isBuilderSourceSitesV1({ formatVersion: 1, sites: {} })).toBe(
        true,
      );
    });

    it("returns `true` for sites with and without a binding name", () => {
      expect(isBuilderSourceSitesV1({
        formatVersion: 1,
        sites: {
          __cfLift_1: { line: 3, col: 12 },
          __cfHandler_1: { line: 1, col: 0, bindingName: "onClick" },
        },
      })).toBe(true);
    });

    it("returns `false` for a value that is not a record", () => {
      expect(isBuilderSourceSitesV1(null)).toBe(false);
      expect(isBuilderSourceSitesV1("sites")).toBe(false);
      expect(isBuilderSourceSitesV1([{ formatVersion: 1, sites: {} }])).toBe(
        false,
      );
    });

    it("returns `false` for a format version other than 1", () => {
      expect(isBuilderSourceSitesV1({ formatVersion: 2, sites: {} })).toBe(
        false,
      );
      expect(isBuilderSourceSitesV1({ sites: {} })).toBe(false);
    });

    it("returns `false` when `sites` is not a record", () => {
      expect(isBuilderSourceSitesV1({ formatVersion: 1 })).toBe(false);
      expect(isBuilderSourceSitesV1({ formatVersion: 1, sites: [site] })).toBe(
        false,
      );
    });

    it("returns `false` for an empty symbol or a site that is not a record", () => {
      expect(isBuilderSourceSitesV1({ formatVersion: 1, sites: { "": site } }))
        .toBe(false);
      expect(isBuilderSourceSitesV1({ formatVersion: 1, sites: { a: 1 } }))
        .toBe(false);
    });

    it("returns `false` for a line below 1 or a column below 0", () => {
      const sitesWith = (bad: unknown) =>
        isBuilderSourceSitesV1({
          formatVersion: 1,
          sites: { a: site, b: bad },
        });

      expect(sitesWith({ line: 0, col: 0 })).toBe(false);
      expect(sitesWith({ line: 1, col: -1 })).toBe(false);
      expect(sitesWith({ line: 1.5, col: 0 })).toBe(false);
      expect(sitesWith({ line: 1, col: 0.5 })).toBe(false);
      expect(sitesWith({ line: "1", col: 0 })).toBe(false);
      expect(sitesWith({ line: 1 })).toBe(false);
    });

    it("returns `false` for a binding name that is empty or not a string", () => {
      const withBinding = (bindingName: unknown) =>
        isBuilderSourceSitesV1({
          formatVersion: 1,
          sites: { a: { ...site, bindingName } },
        });

      expect(withBinding("")).toBe(false);
      expect(withBinding(7)).toBe(false);
      expect(withBinding(null)).toBe(false);
      expect(withBinding("named")).toBe(true);
    });
  });
});
