/**
 * The compile-cache runtime version a test seeds or reads compiled closures
 * under, taken from the runtime whose compiles it stands beside, so that the
 * test holds under either instance naming mode.
 */

import type { Runtime } from "../../src/runtime.ts";

/**
 * Returns the version `runtime` caches a compile under, with coverage as
 * `options` gives it, or without by default. Throws when the build has no
 * compile-cache runtime version, which a Deno test run always has.
 */
export async function compileCacheVersionOf(
  runtime: Runtime,
  options: { patternCoverage: boolean } = { patternCoverage: false },
): Promise<string> {
  const version = await runtime.patternManager.compileCacheRuntimeVersion(
    options,
  );
  if (version === undefined) {
    throw new Error("compile-cache runtime version unavailable in Deno test");
  }
  return version;
}
