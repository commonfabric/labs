#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run

/**
 * .claude/scripts/post-edit-ts.ts
 *
 * Claude Code Post-Tool hook for Write|Edit.
 * - Runs `deno check` on a `.ts` file after it is edited and prints whatever
 *   type errors come back.
 * - Exits 0 either way, so an edit that leaves the file mid-change is not
 *   blocked on being finished.
 */

import { guardProjectDir, parseFilePath } from "./common/guard.ts";
guardProjectDir();

const filePath = await parseFilePath();

if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) {
  Deno.exit(0);
}

if (
  filePath.includes("node_modules") ||
  filePath.includes("vendor/")
) {
  Deno.exit(0);
}

// The two fixture corpora `tasks/typecheck.ts` exempts, for the reason it
// gives. They hold data the tests beside them feed to a transformer rather
// than modules this repository builds. The inputs among them name the ambient
// wrappers that transformer supplies instead of importing them, so checking
// one alone reports every such name as missing. Every other `test/fixtures`
// directory in the workspace is type-checked, so none is listed here.
if (
  filePath.includes("base/schema-generator/test/fixtures/") ||
  filePath.includes("base/ts-transformers/test/fixtures/")
) {
  Deno.exit(0);
}

// `--no-lock` stops `deno check` writing to the tree. Without it, `deno check`
// rewrites `deno.lock` whenever a checked file's dependency graph names a
// specifier the lock does not yet hold, which is what adding a dependency
// does. `deno.lock` is tracked and this hook runs on every `.ts` edit, so an
// edit would dirty a file the author never touched. Type errors are still
// reported. The flag only skips verifying the lock, which CI verifies against
// the real one.
//
// `Deno.execPath()` names the Deno running this hook rather than whichever
// `deno` comes first on `PATH`, so the type errors reported are the ones the
// pinned compiler reports.
const check = new Deno.Command(Deno.execPath(), {
  args: ["check", "--no-lock", filePath],
  stdout: "piped",
  stderr: "piped",
});
const checkResult = await check.output();

if (!checkResult.success) {
  const stderr = new TextDecoder().decode(checkResult.stderr);
  console.error(`Type errors in ${filePath}:\n${stderr}`);
}

Deno.exit(0);
