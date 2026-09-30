#!/usr/bin/env -S deno run --allow-read
/**
 * Prints the compiler-input fingerprint, for CI to key a pattern compile byte
 * cache on.
 *
 * The runtime's version axis is `cf/esm-compile/` followed by this same
 * fingerprint, so a cache entry named by it holds bytes this compiler produced.
 * `.github/actions/compile-cache-key` runs this and hands the value to the
 * cache steps as a step output.
 */
import { fromFileUrl } from "@std/path";

import { computeCompilerFingerprint } from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";

/**
 * The compiler-input fingerprint of the repository this module sits in. The
 * value is base64url, so every character of it is safe in a GitHub Actions
 * cache key.
 */
export function currentCompilerFingerprint(): Promise<string> {
  return computeCompilerFingerprint(
    fromFileUrl(new URL("../", import.meta.url)),
  );
}

// deno-coverage-ignore-start -- the entrypoint guard is false under every test
// that imports this module, which is what it is for
if (import.meta.main) console.log(await currentCompilerFingerprint());
// deno-coverage-ignore-stop
