#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi --allow-net=127.0.0.1

/**
 * Prints the compile-cache version this tree's compiler earns, or records it
 * as the tree's memo.
 *
 * The version is a hash of what the compiler emits for the corpus under every
 * persisted cache variant (`compile-cache-output-version.deno.ts`): the value
 * a build bakes into the artifact it ships, which `build-binaries` and the
 * shell's production bundle compute for themselves. `--memo` is for a
 * checkout that runs from source as it stands, which is how loom runs its
 * vendored copy of this repository. It records the version beside a
 * fingerprint of the tree (`compile-cache-output-memo.deno.ts`), and the
 * tree's source runs take that version for as long as the fingerprint
 * matches. A tree that already records a memo for itself is left as it is and
 * nothing is compiled; otherwise compiling the corpus takes a minute or two.
 *
 * Usage: deno task compile-cache-version [--memo]
 */

import { dirname, fromFileUrl } from "@std/path";
import {
  type MemoizedOutputVersion,
  memoizeOutputVersion,
  OUTPUT_VERSION_MEMO_PATH,
} from "../packages/runner/src/compilation-cache/compile-cache-output-memo.deno.ts";
import { computeCompilerOutputVersion } from "../packages/runner/src/compilation-cache/compile-cache-output-version.deno.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

const USAGE = "Usage: deno task compile-cache-version [--memo]";

/** What `main()` runs for each form; a test passes its own. */
export interface CompileCacheVersionCommands {
  /** Compute the version of this tree. */
  print(): Promise<string>;

  /** Record the version of this tree as its memo. */
  memoize(): Promise<MemoizedOutputVersion>;
}

const COMMANDS: CompileCacheVersionCommands = {
  print: () => computeCompilerOutputVersion(REPO_ROOT),
  memoize: () => memoizeOutputVersion(REPO_ROOT, computeCompilerOutputVersion),
};

export async function main(
  args: readonly string[],
  commands: CompileCacheVersionCommands = COMMANDS,
): Promise<number> {
  const unknown = args.find((arg) => arg !== "--memo");
  if (unknown !== undefined) {
    console.error(`Unknown argument ${JSON.stringify(unknown)}. ${USAGE}`);
    return 2;
  }
  if (args.includes("--memo")) {
    const { version, recorded } = await commands.memoize();
    console.log(
      recorded
        ? `${OUTPUT_VERSION_MEMO_PATH}: recorded ${version}.`
        : `${OUTPUT_VERSION_MEMO_PATH}: already records ${version} for this tree.`,
    );
  } else {
    console.log(await commands.print());
  }
  return 0;
}

// deno-coverage-ignore-start -- the entrypoint guard is false under every test
// that imports this module, which is what it is for
if (import.meta.main) Deno.exit(await main(Deno.args));
// deno-coverage-ignore-stop
