#!/usr/bin/env -S deno run --allow-read --allow-run=git

/**
 * Fails when a tracked file contains an unresolved merge-conflict marker.
 *
 * A conflict resolved by hand can leave its markers behind, and nothing else
 * here notices. `deno fmt` does not treat them as an error in Markdown, and
 * `deno.jsonc` excludes `docs/` from `deno fmt` entirely, so a document under
 * `docs/` has no other mechanical gate at all. In source they usually break the
 * type check, but only because they usually happen to be syntactically invalid
 * -- that is luck, not a guarantee.
 *
 * The case this exists for is the one no per-commit diff shows: an EVIL MERGE,
 * where the resolution introduces content present in the merge result and in
 * neither parent. `git log -S` finds nothing, because no commit added the line;
 * the merge did. Reviewing every commit of a branch can miss it entirely.
 *
 * Usage: deno run --allow-read --allow-run=git ./tasks/check-conflict-markers.ts [root]
 *
 * `root` is the repository to scan, and defaults to the one holding this file.
 */

import { dirname, fromFileUrl } from "@std/path";
import { runOnRoot } from "./root-argument.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/**
 * The markers git writes: the opener, the `diff3` common-ancestor separator,
 * and the closer.
 *
 * Written out rather than built. Detection is anchored at column 0, so these
 * are inert where they sit -- and this file being tracked and scanned by its
 * own check is a standing demonstration of exactly that. The one rule is that
 * no line here may BEGIN with one, which the check itself enforces.
 *
 * The `=======` separator is deliberately absent: seven equals signs are also
 * how Markdown underlines a setext heading, and a check that fails on those is
 * one people learn to route around. A real conflict brings an opener and a
 * closer anyway.
 */
const MARKERS: readonly string[] = ["<<<<<<<", "|||||||", ">>>>>>>"];

/**
 * Returns the conflict marker a line begins with, or `undefined`.
 *
 * A marker sits at the start of the line and is followed by a space (git writes
 * a label after it) or by nothing. Requiring that boundary is what keeps a
 * longer run -- a rule of dashes, an ASCII box -- from matching.
 */
export function conflictMarkerAt(line: string): string | undefined {
  for (const marker of MARKERS) {
    if (!line.startsWith(marker)) continue;
    const next = line.charAt(marker.length);
    if (next === "" || next === " ") return marker;
  }
  return undefined;
}

export interface MarkerViolation {
  file: string;
  line: number;
  marker: string;
}

/** Lists the repo-relative paths of every tracked file. */
async function trackedFiles(root: string): Promise<string[]> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args: ["ls-files", "-z"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!success) {
    throw new Error(
      `git ls-files failed: ${new TextDecoder().decode(stderr).trim()}`,
    );
  }

  return new TextDecoder().decode(stdout).split("\0").filter((p) => p !== "");
}

/** Scans every tracked file, reporting each marker found. */
export async function scan(root: string): Promise<MarkerViolation[]> {
  const violations: MarkerViolation[] = [];

  for (const file of await trackedFiles(root)) {
    let contents: string;
    try {
      contents = await Deno.readTextFile(`${root}/${file}`);
    } catch (error) {
      // A binary file is not text to scan, and a tracked path can be absent
      // from the working tree (a sparse checkout, a submodule). Neither is
      // this check's business; anything else is.
      if (
        error instanceof TypeError || error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.IsADirectory
      ) {
        continue;
      }
      throw error;
    }

    const lines = contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const marker = conflictMarkerAt(lines[i]);
      if (marker !== undefined) {
        violations.push({ file, line: i + 1, marker });
      }
    }
  }

  return violations;
}

function reportViolations(violations: readonly MarkerViolation[]): void {
  const lines = [
    "",
    "Unresolved merge-conflict marker(s) in tracked files:",
    "",
    ...violations.map((v) => `  ${v.file}:${v.line}: ${v.marker}`),
    "",
    "Finish the resolution and delete the markers. If a merge produced these,",
    "note that the content exists in the merge result and in NEITHER parent, so",
    "no per-commit diff shows it -- re-read the merged file itself.",
    "",
  ];
  console.error(lines.join("\n"));
}

/** Runs the check over `root`, reports, and returns a process code. */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const violations = await scan(root);
  if (violations.length > 0) {
    reportViolations(violations);
    return 1;
  }
  console.log("No unresolved merge-conflict markers in tracked files.");
  return 0;
}

/** What the command line may hold. */
const USAGE = "check-conflict-markers.ts [root]";

if (import.meta.main) Deno.exit(await runOnRoot(Deno.args, USAGE, main));
