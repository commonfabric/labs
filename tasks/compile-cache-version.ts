#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi --allow-net=127.0.0.1

/**
 * Prints the compile-cache version this tree's compiler earns, or bakes it
 * into the tree's version module.
 *
 * The version is a hash of what the compiler emits for the corpus under every
 * persisted cache variant (`compile-cache-output-version.deno.ts`), so it is
 * the value a build bakes into the artifact it ships: `build-binaries` and
 * the shell's production bundle compute it themselves. `--bake` is for a tree
 * that runs from source but ships as it stands, which is how loom runs its
 * vendored copy of this repository: it writes the version into
 * `compile-cache-version.ts`, which every Deno source run from that tree
 * reads. A bundle takes its version from its build's
 * `__cfCompileCacheRuntimeVersion` define instead, so a bundle build that
 * defines it from the baked module gives the daemon's runtimes and the worker
 * one version. Compiling the corpus takes a minute or two.
 *
 * Usage: deno task compile-cache-version [--bake]
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { computeCompilerOutputVersion } from "../packages/runner/src/compilation-cache/compile-cache-output-version.deno.ts";
import { renderVersionModule } from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** Where a tree's version module lives, repository-relative. */
export const VERSION_MODULE_PATH =
  "packages/runner/src/compilation-cache/compile-cache-version.ts";

/**
 * Write `version` into the version module of the tree at `repoRoot`, as a
 * binary build writes the version it bakes.
 */
export async function bakeVersionModule(
  repoRoot: string,
  version: string,
): Promise<void> {
  await Deno.writeTextFile(
    join(repoRoot, VERSION_MODULE_PATH),
    renderVersionModule(version),
  );
}

export async function main(args: readonly string[]): Promise<number> {
  const version = await computeCompilerOutputVersion(REPO_ROOT);
  if (args.includes("--bake")) {
    await bakeVersionModule(REPO_ROOT, version);
    console.log(`${VERSION_MODULE_PATH}: baked ${version}.`);
  } else {
    console.log(version);
  }
  return 0;
}

// deno-coverage-ignore-start -- the entrypoint guard is false under every test
// that imports this module, which is what it is for
if (import.meta.main) Deno.exit(await main(Deno.args));
// deno-coverage-ignore-stop
