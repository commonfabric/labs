import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cacheVariantName,
  INSTANCE_NAMES_CACHE_VARIANT,
  isPatternCoverageCacheRuntimeVersion,
  moduleByteCacheRuntimeVersion,
  PATTERN_COVERAGE_CACHE_VARIANT,
  PERSISTED_CACHE_VARIANTS,
} from "../src/compilation-cache/cache-variants.ts";

describe("cache-variants", () => {
  const plain = { patternCoverage: false, instanceNames: false };
  const both = { patternCoverage: true, instanceNames: true };

  describe("moduleByteCacheRuntimeVersion()", () => {
    it("returns the runtime version itself for plain mode", () => {
      expect(moduleByteCacheRuntimeVersion("v", plain)).toBe("v");
    });

    it("suffixes the instance-names variant ahead of the coverage variant", () => {
      expect(moduleByteCacheRuntimeVersion("v", both)).toBe(
        `v/${INSTANCE_NAMES_CACHE_VARIANT}/${PATTERN_COVERAGE_CACHE_VARIANT}`,
      );
      expect(
        moduleByteCacheRuntimeVersion("v", { ...plain, patternCoverage: true }),
      ).toBe(`v/${PATTERN_COVERAGE_CACHE_VARIANT}`);
      expect(
        moduleByteCacheRuntimeVersion("v", { ...plain, instanceNames: true }),
      ).toBe(`v/${INSTANCE_NAMES_CACHE_VARIANT}`);
    });

    it("returns `undefined` for an undefined runtime version", () => {
      expect(moduleByteCacheRuntimeVersion(undefined, both)).toBeUndefined();
    });
  });

  describe("isPatternCoverageCacheRuntimeVersion()", () => {
    it("recognizes the coverage suffix wherever the instance-names one sits", () => {
      expect(
        isPatternCoverageCacheRuntimeVersion(
          moduleByteCacheRuntimeVersion("v", both)!,
        ),
      ).toBe(true);
      expect(
        isPatternCoverageCacheRuntimeVersion(
          moduleByteCacheRuntimeVersion("v", {
            ...plain,
            instanceNames: true,
          })!,
        ),
      ).toBe(false);
    });
  });

  describe("PERSISTED_CACHE_VARIANTS", () => {
    it("names every combination of the modes once, plain mode first", () => {
      const names = PERSISTED_CACHE_VARIANTS.map(cacheVariantName);
      expect(names[0]).toBe("");
      expect(new Set(names).size).toBe(names.length);
      expect(names.length).toBe(2 ** Object.keys(plain).length);
    });

    it("gives each variant the suffix its cache key carries", () => {
      for (const variant of PERSISTED_CACHE_VARIANTS) {
        const key = moduleByteCacheRuntimeVersion("v", variant)!;
        const name = cacheVariantName(variant);
        expect(key).toBe(name === "" ? "v" : `v/${name}`);
      }
    });
  });
});
