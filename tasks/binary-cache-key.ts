#!/usr/bin/env -S deno run --allow-read --allow-run=git
/**
 * Prints what the binaries a CI lane builds are keyed on in the Actions cache.
 *
 * The key is a digest of the git object id of every tracked file under
 * `BINARY_SOURCES`, and of `cachedBinaries()`, which says what each cached
 * binary's build is asked for and which build variables it sets. Together
 * those name exactly what the binaries are built from. A lane uses a binary it
 * restores without asking what it was built from, so a key that missed an
 * input would hand a lane a binary built from something else.
 */
import { encodeHex } from "@std/encoding/hex";
import { fromFileUrl } from "@std/path";

import { BINARY_SOURCES } from "./build-binaries.ts";
import { cachedBinaries, type CachedBinary } from "./ci-capabilities.ts";

/**
 * The digest of the tracked files under `BINARY_SOURCES` in the checkout at
 * `root`, and of `builds`, as lowercase hex. Throws where git cannot list the
 * files or lists none, so that a checkout it cannot read never yields the key
 * of an empty tree.
 */
export async function binaryCacheKey(
  root: string,
  builds: Record<string, CachedBinary> = cachedBinaries(),
): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args: ["ls-files", "--stage", "-z", "--", ...BINARY_SOURCES],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) {
    throw new Error(
      `git ls-files failed in ${root}: ${new TextDecoder().decode(stderr)}`,
    );
  }
  if (stdout.length === 0) {
    throw new Error(`git ls-files listed no binary source in ${root}`);
  }
  // Every entry of the listing ends in a NUL, which JSON never holds, so no
  // part of the table can be read as part of the listing.
  const table = new TextEncoder().encode(JSON.stringify(builds));
  const input = new Uint8Array(stdout.length + table.length);
  input.set(stdout);
  input.set(table, stdout.length);
  return encodeHex(await crypto.subtle.digest("SHA-256", input));
}

// deno-coverage-ignore-start -- the entrypoint guard is false under every test
// that imports this module, which is what it is for
if (import.meta.main) {
  console.log(
    await binaryCacheKey(fromFileUrl(new URL("../", import.meta.url))),
  );
}
// deno-coverage-ignore-stop
