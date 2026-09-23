#!/usr/bin/env -S deno run --allow-read --allow-run=git
/**
 * Prints what the binaries a CI lane builds are keyed on in the Actions cache.
 *
 * The key is a digest of the git object id of every tracked file under
 * `BINARY_SOURCES`, so it names exactly the contents the binaries are built
 * from. A lane uses a binary it restores without asking what it was built
 * from, so a key that missed an input would hand a lane a binary built from
 * something else.
 */
import { encodeHex } from "@std/encoding/hex";
import { fromFileUrl } from "@std/path";

import { BINARY_SOURCES } from "./build-binaries.ts";

/**
 * The digest of the tracked files under `BINARY_SOURCES` in the checkout at
 * `root`, as lowercase hex. Throws where git cannot list them or lists none,
 * so that a checkout it cannot read never yields the key of an empty tree.
 */
export async function binaryCacheKey(root: string): Promise<string> {
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
  return encodeHex(await crypto.subtle.digest("SHA-256", stdout));
}

// deno-coverage-ignore-start -- the entrypoint guard is false under every test
// that imports this module, which is what it is for
if (import.meta.main) {
  console.log(
    await binaryCacheKey(fromFileUrl(new URL("../", import.meta.url))),
  );
}
// deno-coverage-ignore-stop
