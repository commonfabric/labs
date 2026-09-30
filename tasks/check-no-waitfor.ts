#!/usr/bin/env -S deno run --allow-read
//
// Guards against new use of the polling `waitFor` helper in integration tests.
//
// `waitFor` (defined in packages/integration/utils.ts, exported from
// "@commonfabric/integration") re-runs a predicate every 50 milliseconds — in a
// browser test each tick is a DevTools Protocol round-trip — and throws once a
// timeout elapses. An earlier change moved the browser suites off it and onto
// event-driven waits (`waitForCondition`, `awaitViewSettled`, and the wrappers
// in packages/patterns/integration/cfc-browser-helpers.ts). This check keeps new
// tests from importing the polling helper again.
//
// A file is in scope when it lives under an `integration/` directory somewhere
// beneath `packages/`, excluding the `@commonfabric/integration` package itself,
// which defines and re-exports `waitFor`. An in-scope file fails the check when
// it takes `waitFor` as a value from an import of that package — either through
// the bare specifier or through a relative path to the package's `utils.ts` or
// `index.ts` — and is not on the ALLOWLIST below. Text inside a comment or a
// string is not an import, so commenting the import out clears the check, and a
// type-only import is erased before the test runs, so it polls nothing.
//
// The ALLOWLIST holds the files that are exempt from this check; the reason for
// each is recorded in the "Where the polling `waitFor` stays" section of
// docs/development/waiting-in-tests.md.
//
// Usage: deno run --allow-read ./tasks/check-no-waitfor.ts

import { walk } from "@std/fs/walk";
import { dirname, fromFileUrl, relative, resolve } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

// Files exempt from this check: they keep the polling `waitFor` from
// "@commonfabric/integration". Each entry is a repo-relative path; the reason
// for each is documented under "Where the polling `waitFor` stays" in
// docs/development/waiting-in-tests.md.
export const ALLOWLIST: ReadonlySet<string> = new Set([
  // Headless cell pull: no page to attach an in-page waiter to.
  "packages/generated-patterns/integration/pattern-harness.ts",
  // Off-page piece-result cell reads through the in-process controller.
  "packages/shell/integration/piece.test.ts",
  // Cross-page joint condition: the wait spans two separate browser pages, which
  // a single-page in-page waiter cannot express.
  "packages/patterns/integration/lunch-poll-vote.test.ts",
  // MockDoc rendered-HTML reads and fresh cell.sync() round-trips, with no
  // completion callback the test can hook.
  "packages/runtime-client/integration/client.test.ts",
  // Env-gated profiling scaffolding: one-shot waits that arm a trace or reset a
  // logger baseline, gated behind CF_CAPTURE_* variables that default to off.
  "packages/patterns/integration/default-app.test.ts",
]);

// Matches an import of the `@commonfabric/integration` package and captures the
// named-imports clause between the braces. A leading default import is
// tolerated, and `[^}]*` keeps the capture from bleeding past the end of the
// clause.
//
// `import type { ... }` does not match. A type-only import binds the type of
// `waitFor` and is erased before the test runs, so it polls nothing.
//
// Two spellings reach the package. The bare specifier names it directly; the
// closing quote right after `integration` excludes its subpath exports
// (".../shell-utils", which does not re-export `waitFor`). A relative path
// reaches the same code without naming the package: `utils.ts` defines
// `waitFor` and `index.ts` re-exports it, so a specifier that starts with a `.`
// and ends at either file counts. Under `packages/`, only the package itself
// holds an `integration/utils.ts` or an `integration/index.ts`.
//
// Namespace imports are out of scope: `import * as I from
// "@commonfabric/integration"` with a later `I.waitFor(...)` passes the check.
// Every import of this package in the repository uses the named form.
const PACKAGE_IMPORT =
  /import\s+(?:[\w$]+\s*,\s*)?\{(?<clause>[^}]*)\}\s*from\s*["'](?:@commonfabric\/integration|\.[^"']*\/integration\/(?:utils|index)\.ts)["']/;

// The comment and literal forms that can hold import-shaped text. A `'` or `"`
// opens a string only when its closing quote lands on the same line; a template
// literal may span lines, and its `${...}` is swallowed as part of the literal,
// which holds here because an import statement cannot sit inside one.
//
// Regular-expression literals are not modeled. A `/\//` reads as a line
// comment and a quote inside a regex reads as a string opening, so both blind
// the scan to the rest of that line. Imports sit at the top of a file, above any
// regex literal.
const LINE_COMMENT = /\/\/[^\n]*/;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//;
const TEMPLATE = /`(?:[^`\\]|\\[\s\S])*`/;
const STRING = /"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/;

// One match per comment, literal, or package import, whichever starts first.
// Each match consumes its own text, so a comment or a literal that opens before
// an import carries the import-shaped text inside it away with it and
// `PACKAGE_IMPORT` never matches there. Only a `PACKAGE_IMPORT` match sets the
// `clause` group.
const TOKEN_RE = new RegExp(
  [LINE_COMMENT, BLOCK_COMMENT, TEMPLATE, STRING, PACKAGE_IMPORT]
    .map((part) => part.source)
    .join("|"),
  "g",
);

// Removes `//` and `/* */` comments from a named-imports clause. A
// `PACKAGE_IMPORT` match consumes its own braces, so a comment between them
// arrives intact. Such a clause holds only identifiers, `as`, `type`, and
// commas, so a `waitFor` inside a comment is a commented-out member rather than
// a real import.
function stripComments(clause: string): string {
  return clause
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/**
 * Returns the members of a named-imports clause that a `type` modifier does not
 * erase. A member is dropped whole rather than having its `type` deleted in
 * place, so the local name an erased member binds — the `waitFor` in
 * `{ type Poll as waitFor }` — goes with it.
 */
function valueMembers(clause: string): string[] {
  return clause.split(",").filter((member) => !/^\s*type\s/.test(member));
}

/**
 * Returns true when `source` imports the polling `waitFor` as a named value
 * import of the `@commonfabric/integration` package. `waitForCondition`,
 * `waitForText`, and other `waitFor`-prefixed names do not count; neither does a
 * `waitFor` on a subpath specifier, a `harness.waitFor(...)` member call, a
 * type-only import, or an import that is commented out or quoted inside a
 * string.
 */
export function importsPollingWaitFor(source: string): boolean {
  for (const match of source.matchAll(TOKEN_RE)) {
    const clause = match.groups?.clause;
    if (clause === undefined) continue;
    const members = valueMembers(stripComments(clause));
    if (members.some((member) => /\bwaitFor\b/.test(member))) return true;
  }
  return false;
}

/**
 * Returns true when `relPath` (a repo-relative, forward-slash path) is an
 * integration test in scope for this check: under `packages/`, inside an
 * `integration/` directory, a `.ts` file, and not part of the
 * `@commonfabric/integration` package that defines `waitFor`.
 */
export function isIntegrationTestFile(relPath: string): boolean {
  const path = relPath.replaceAll("\\", "/");
  if (!path.startsWith("packages/")) return false;
  // The package that defines and re-exports `waitFor`.
  if (path.startsWith("packages/integration/")) return false;
  if (!path.includes("/integration/")) return false;
  return path.endsWith(".ts");
}

export interface ScanResult {
  /** In-scope files importing the polling `waitFor` that are not allowlisted. */
  violations: string[];

  /** In-scope files importing the polling `waitFor` that are allowlisted. */
  allowlisted: string[];
}

/** Scans integration tests under `root`/packages for polling-`waitFor` use. */
export async function scan(root: string = REPO_ROOT): Promise<ScanResult> {
  const violations: string[] = [];
  const allowlisted: string[] = [];
  const packagesDir = resolve(root, "packages");
  const walker = walk(packagesDir, {
    includeDirs: false,
    skip: [/\/node_modules\//, /\/dist\//, /\/\.cache\//, /\/coverage\//],
  });
  for await (const entry of walker) {
    const rel = relative(root, entry.path).replaceAll("\\", "/");
    if (!isIntegrationTestFile(rel)) continue;
    const source = await Deno.readTextFile(entry.path);
    if (!importsPollingWaitFor(source)) continue;
    (ALLOWLIST.has(rel) ? allowlisted : violations).push(rel);
  }
  violations.sort();
  allowlisted.sort();
  return { violations, allowlisted };
}

function reportViolations(violations: string[]): void {
  const lines = [
    "",
    'New use of the polling `waitFor` from "@commonfabric/integration" in ' +
    "integration test(s):",
    "",
    ...violations.map((path) => `  ${path}`),
    "",
    "The polling `waitFor` re-runs a predicate every 50ms, and in a browser test",
    "each tick is a DevTools round-trip, which makes tests slow and flaky. In a",
    "browser test, use an event-driven wait instead:",
    "",
    "  - waitForCondition(page, predicate, opts) — resolves the instant the DOM",
    "    reflects the new state.",
    "  - awaitViewSettled(page) — resolves once the view is interactive.",
    "  - waitForText / clickCfButton / clickCfButtonAndWaitForText / … in",
    "    packages/patterns/integration/cfc-browser-helpers.ts.",
    "",
    "In a test with no page, resolve a defer() from a callback the test already",
    "registers (a cell sink, a subscription's next, a scheduler onError) instead",
    "of polling.",
    "",
    "See docs/development/waiting-in-tests.md for the rationale and the full",
    "toolkit.",
    "",
    "If an event-driven wait genuinely cannot express this (for example a",
    "cross-page condition or a headless cell read), add the file to ALLOWLIST in",
    "tasks/check-no-waitfor.ts with a one-line reason and record it under",
    '"Where the polling `waitFor` stays" in docs/development/waiting-in-tests.md.',
    "",
  ];
  console.error(lines.join("\n"));
}

/** Runs the check over `root`/packages, reports, and returns a process code. */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const { violations } = await scan(root);
  if (violations.length > 0) {
    reportViolations(violations);
    return 1;
  }
  console.log(
    `No new polling waitFor in integration tests ` +
      `(${ALLOWLIST.size} allowlisted exception(s)).`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main());
