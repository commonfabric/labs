#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run=git

/**
 * Fails when a `FileSystemProgramResolver` is constructed outside the one
 * operation that builds a program from local files.
 *
 * A program assembled by hand -- `resolve(new FileSystemProgramResolver(...))`
 * -- is complete in every way a compiler or a type checker can see. What it
 * silently lacks is any data file the caller meant to attach, and that absence
 * surfaces nowhere until a pattern calls `dataFile()` and is told the file is
 * not there. Three separate rounds of exactly that produced this check: the
 * warm load path, the multi-user test worker, and every pattern integration
 * harness. Each time the code was correct on its own terms and wrong only in
 * what it had no reason to remember.
 *
 * `resolveLocalProgram` composes resolution and attachment into one call, so a
 * new call site cannot take one without the other. This check is what keeps
 * that the only route: reaching for the resolver directly is the mistake, and
 * it is caught here rather than in a pattern that reads a file months later.
 *
 * Detection is on the resolver's name anywhere in code, not on a `new`
 * expression. Constructing it through an alias or a namespace import spells the
 * construction differently but still names it to import it, so the name is the
 * one spelling every route shares.
 *
 * Usage: deno run --allow-read --allow-env --allow-run=git \
 *        ./tasks/check-local-program.ts
 */

import { dirname, fromFileUrl } from "@std/path";
import ts from "typescript";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** The name every route to the resolver has to spell out. */
const RESOLVER = "FileSystemProgramResolver";

/**
 * Files permitted to name the resolver in code, each for a reason that does not
 * end in a compiled program.
 */
export const ALLOWLIST = new Map<string, string>([
  [
    "runtime/runner/src/harness/local-program.deno.ts",
    "the operation itself",
  ],
  [
    "base/js-compiler/program.ts",
    "declares the resolver",
  ],
  [
    "base/js-compiler/mod.ts",
    "re-exports the resolver its own package declares",
  ],
  [
    "base/js-compiler/test/program.test.ts",
    "tests the resolver's own containment rules",
  ],
  [
    "runtime/cli/commands/deps.ts",
    "walks imports to rewrite pins; compiles nothing, so has no data files",
  ],
]);

/**
 * Returns whether `source` names the resolver in code rather than in prose.
 *
 * The answer comes from parsing the file and looking for an identifier, so the
 * distinction is the language's own. A comment and a string literal are not
 * identifiers, which is what lets a document, a doc comment, or a diagnostic
 * message name the resolver while explaining why not to reach for it. An
 * import, a type reference, a property access, and a `new` expression all bind
 * the name as an identifier, so all of them count.
 */
export function namesResolverInCode(source: string, path: string): boolean {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === RESOLVER) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Returns the tracked TypeScript files under `root`, repo-relative. */
async function trackedSources(root: string): Promise<string[]> {
  const listed = await new Deno.Command("git", {
    // The whole repository, not just `packages`: the pattern-compatibility
    // and vintage tasks compile authored source too, and a scope that stopped
    // at `packages` would leave exactly the sites a check like this exists to
    // reach.
    args: ["ls-files", "-z"],
    cwd: root,
  }).output();
  return new TextDecoder().decode(listed.stdout)
    .split("\0")
    .filter((path) => /\.tsx?$/.test(path));
}

/** Returns the files under `root` that name the resolver without an exemption. */
export async function scan(root: string = REPO_ROOT): Promise<string[]> {
  const offenders: string[] = [];
  for (const path of await trackedSources(root)) {
    if (ALLOWLIST.has(path)) continue;
    // A file git still tracks may already be gone from the working tree, which
    // is what a deletion looks like before it is staged. Nothing to scan.
    let source: string;
    try {
      source = await Deno.readTextFile(`${root}/${path}`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    // Parsing is exact but not free, and the name is absent from all but a
    // handful of files. Reading the text for it first settles the rest.
    if (!source.includes(RESOLVER)) continue;
    if (!namesResolverInCode(source, path)) continue;
    offenders.push(path);
  }
  return offenders;
}

/** Runs the check over `root`, reports, and returns a process code. */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const offenders = await scan(root);
  if (offenders.length > 0) {
    console.error(
      "These files build a program from local files by hand, so any data file\n" +
        "the caller attaches is silently dropped:\n",
    );
    for (const path of offenders) console.error(`  ${path}`);
    console.error(
      "\nUse `resolveLocalProgram` from " +
        "`@commonfabric/runner/local-program.deno`,\nwhich resolves the entry, " +
        "its attached test entries, and its data files as one\noperation. If a " +
        "site genuinely never compiles the program it builds, add it to\n" +
        "ALLOWLIST in tasks/check-local-program.ts with the reason.",
    );
    return 1;
  }
  console.log(
    `Local programs are built through one operation ` +
      `(${ALLOWLIST.size} allowlisted exception(s)).`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main());
