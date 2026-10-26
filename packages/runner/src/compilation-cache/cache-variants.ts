/**
 * The variants of the compiled-code cache: one key suffix per compile mode
 * that emits different bytes for the same source, so that modes never share
 * compiled bytes. A built artifact's compile-cache version is computed from
 * the compiler's output under every one of them
 * (`compile-cache-output-version.deno.ts`), which is why the set is enumerated
 * here rather than implied by the suffixes.
 *
 * Boot-safe: no compiler or runtime imports.
 */

/** The variant of a compile instrumented for pattern coverage. */
export const PATTERN_COVERAGE_CACHE_VARIANT = "pattern-coverage";

/**
 * The variant of a compile that names `const`-bound sub-pattern instances
 * (`namesInstances()`).
 */
export const INSTANCE_NAMES_CACHE_VARIANT = "instance-names";

/** The compile modes that select a cache variant. */
export interface CacheVariantOptions {
  readonly patternCoverage: boolean;
  readonly instanceNames: boolean;
}

/**
 * Every variant a runtime can compile under, plain mode included. A mode
 * added to {@link CacheVariantOptions} is added here with its combinations,
 * so that the version covers the bytes it emits.
 */
export const PERSISTED_CACHE_VARIANTS: readonly CacheVariantOptions[] = [
  { patternCoverage: false, instanceNames: false },
  { patternCoverage: false, instanceNames: true },
  { patternCoverage: true, instanceNames: false },
  { patternCoverage: true, instanceNames: true },
];

/**
 * The suffix path a variant adds to the runtime version: empty for plain
 * mode, else the variant names in the order {@link moduleByteCacheRuntimeVersion}
 * joins them.
 */
export function cacheVariantName(options: CacheVariantOptions): string {
  const parts: string[] = [];
  if (options.instanceNames) parts.push(INSTANCE_NAMES_CACHE_VARIANT);
  if (options.patternCoverage) parts.push(PATTERN_COVERAGE_CACHE_VARIANT);
  return parts.join("/");
}

/**
 * The compiled-code cache key's version for a compile in `options`' modes:
 * the runtime version, followed by the variant's suffix path. The instance
 * naming suffix goes ahead of the coverage suffix, which
 * {@link isPatternCoverageCacheRuntimeVersion} reads at the end.
 */
export function moduleByteCacheRuntimeVersion(
  runtimeVersion: string | undefined,
  options: CacheVariantOptions,
): string | undefined {
  if (runtimeVersion === undefined) return undefined;
  const suffix = cacheVariantName(options);
  return suffix === "" ? runtimeVersion : `${runtimeVersion}/${suffix}`;
}

/** Whether a cache key's version names a coverage-instrumented compile. */
export function isPatternCoverageCacheRuntimeVersion(
  runtimeVersion: string,
): boolean {
  return runtimeVersion.endsWith(`/${PATTERN_COVERAGE_CACHE_VARIANT}`);
}
