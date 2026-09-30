import { dirname, join } from "@std/path";
import { parse } from "@std/jsonc";
import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * Infer the root directory for resolving a test pattern's relative imports:
 * the nearest ancestor of the entry file whose effective Deno config declares
 * a package `name`. The effective config of a directory is what Deno itself
 * would read there — `deno.json` when it exists, else `deno.jsonc`; a
 * `deno.jsonc` beside a `deno.json` is ignored, so a name in it must not
 * anchor the walk.
 *
 * The `name` field is the boundary test because a config file without one
 * commonly exists only to wire tasks for a directory — a workspace member
 * stub, a scratch config — and anchoring there would strand imports that
 * reach shared modules elsewhere in the package. A named config is what
 * declares "this directory is a package", which is the widest scope a
 * pattern's relative imports are expected to span.
 *
 * Returns undefined when no ancestor declares a name, leaving the caller its
 * default (the entry file's own directory).
 */
export function inferProgramRoot(entryPath: string): string | undefined {
  let dir = dirname(entryPath);
  while (true) {
    for (const file of ["deno.json", "deno.jsonc"]) {
      let text: string;
      try {
        text = Deno.readTextFileSync(join(dir, file));
      } catch {
        // Any unreadable entry — absent, a directory, permission-denied —
        // falls through to the companion file, matching Deno's own config
        // discovery: a directory named deno.json or a chmod-000 deno.json
        // both leave Deno reading the sibling deno.jsonc.
        continue;
      }
      if (declaresPackageName(text)) return dir;
      // This file is the directory's effective config and declares no name,
      // so the directory is not a package root; the companion file Deno
      // ignores cannot make it one.
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function declaresPackageName(text: string): boolean {
  try {
    const config = parse(text);
    return isObjectNotArray(config) &&
      typeof (config as { name?: unknown }).name === "string";
  } catch {
    // An unparseable config cannot declare a name; the walk moves on rather
    // than failing the run over a file the test never imports.
    return false;
  }
}
