#!/usr/bin/env -S deno run --allow-read --allow-run=git
//
// Fails when an import map declares a dependency that nothing imports.
//
// Each package's Deno config (deno.jsonc or deno.json), and the root's, map
// short aliases to concrete specifiers in an `imports` block. An alias that no
// source file imports is dead weight: it still resolves and downloads on
// install, it can pin a second copy of a package the rest of the tree already
// has, and it survives `deno outdated`, which only reports packages that are
// behind. An unused dependency at its newest release is invisible to that tool,
// so nothing catches it drifting in. This check does.
//
// An alias counts as used when some source file *in that import map's scope*
// imports it. Scope follows Deno's own resolution:
//
//   - The root deno.jsonc import map is inherited by every file in the
//     workspace, so a root alias is used when any source file imports it.
//   - A workspace member's import map governs only the files inside that
//     member, so a member alias is used only when a file under that member
//     imports it. An alias a member declares but only a *different* member
//     imports is dead in the declaring member: the importer resolves it some
//     other way (a root alias, or a workspace package name), not through this
//     declaration.
//
// "Imports it" means the alias appears as a module specifier after `from`,
// `import`, `import(`, `require(`, or a `@ts-types=` companion-type comment (or
// its older `@deno-types=` spelling) — either exactly, or as the head of a
// `<alias>/subpath`. A slash-terminated alias (for example `@/`) is a prefix
// mapping, so any specifier starting with it counts. Text inside comments or
// strings can produce a false "used", which only ever hides a dead entry; it
// never flags a live one, so the check does not misfire on a real dependency.
//
// A type-only companion package (`@types/*`) is never imported by name. It
// reaches its package through a `@ts-types=` comment on that package's import,
// which is why that form is one of the specifier shapes above. Without the
// comment the `@types/*` alias is genuinely unused, and this check says so.
//
// The source files searched are the ones git tracks. Reading the tracked set
// rather than walking the filesystem is what makes the scope exact: it leaves
// out generated output (dist, coverage, the Deno cache) and dependency trees
// with no directory-name skiplist to keep current, and it includes a source
// file that a .gitignore rule matches but git still tracks — the repository has
// such files, and a name-based walk filter would wrongly drop them and report
// their imports' aliases unused. Off a git working tree (a unit-test fixture)
// nothing is tracked, so the scan falls back to walking.
//
// Two import shapes are not recognized, because no source in this workspace
// uses them to reach an import-map alias: a `@jsxImportSource <alias>` pragma
// (the configured jsx source is a workspace package, not an alias) and a
// `/// <reference types="<alias>" />` directive. If either is ever pointed at
// an alias, the check reports that alias unused; wire the alias up through one
// of the recognized shapes, or allowlist it.
//
// The ALLOWLIST holds aliases that are declared without a local import on
// purpose; each entry records why.
//
// Usage: deno run --allow-read --allow-run=git ./tasks/check-unused-deps.ts

import { parse as parseJsonc } from "@std/jsonc";
import { walk } from "@std/fs/walk";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import { isObjectOrArray } from "@commonfabric/utils/types";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

// Aliases that are declared without any in-scope import on purpose. Each key is
// `${configPath}\t${alias}` (configPath repo-relative, forward slashes); the
// value is the reason, surfaced when the allowlist is reported.
export const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  // Declared to pin one version of a package that only reaches the tree
  // transitively (through @arizeai/openinference-vercel). tasks/
  // check-single-copy-deps.ts requires it to resolve to a single copy, because
  // that copy defines the span attribute names the OpenInference processor
  // writes and reads back; the direct declaration is how the version is held to
  // one. No toolshed source imports it by name.
  [
    "packages/toolshed/deno.jsonc\t@arizeai/openinference-semantic-conventions",
    "pinned for check-single-copy-deps; reaches the tree only via " +
    "@arizeai/openinference-vercel",
  ],
]);

// Directories the walk fallback skips. This list is only reached off a git
// working tree, where there are no tracked paths to read; it names the trees
// that are never this workspace's own source. It deliberately does not skip
// output directories by name (dist, build, coverage): the tracked-files path is
// what excludes generated output, and skipping those names here could drop an
// authored file that a repository legitimately keeps under such a name.
const SKIP_DIRS = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  // The vendored loom copy is a separate repository checked in under vendor/.
  /(^|\/)vendor(\/|$)/,
];

// File extensions that can hold a module import.
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A module specifier is preceded by one of these. `from` covers static import
// and export; `import` alone covers a side-effect import and, with an optional
// `(`, a dynamic import; `require(` covers npm-style interop; `@ts-types=`
// covers the companion-type comment that points an import at its `@types/*`
// package. `@deno-types=` is the older spelling of that comment, still accepted
// by Deno, so it is matched too.
const SPECIFIER_LEAD =
  "(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*|@(?:ts|deno)-types\\s*=\\s*)";
// One character that is not a quote, for the body of a specifier.
const NON_QUOTE = "[^\"'`]";

/**
 * Reports whether `source` imports `alias` as a module specifier. A bare alias
 * matches itself or the head of an `<alias>/subpath`; a slash-terminated alias
 * matches any specifier that starts with it. Matching is deliberately loose:
 * an occurrence inside a comment or string counts as used, which can only hide
 * a dead alias, never flag a live one.
 */
export function importsAlias(source: string, alias: string): boolean {
  // Every specifier that matches contains the alias verbatim, so this cheap
  // substring test skips the regex for the many files that cannot match.
  if (!source.includes(alias)) return false;
  const escaped = escapeRegExp(alias);
  const body = alias.endsWith("/") ? `${NON_QUOTE}*` : `(?:/${NON_QUOTE}*)?`;
  const pattern = `${SPECIFIER_LEAD}(["'\`])${escaped}${body}\\1`;
  return new RegExp(pattern).test(source);
}

/** Parses the `imports` block of a deno.jsonc, returning alias→specifier. */
export function parseImportMap(configText: string): Record<string, string> {
  const config = parseJsonc(configText) as { imports?: unknown } | null;
  const imports = config?.imports;
  if (!isObjectOrArray(imports)) return {};
  const result: Record<string, string> = {};
  for (const [alias, specifier] of Object.entries(imports)) {
    if (typeof specifier === "string") result[alias] = specifier;
  }
  return result;
}

/**
 * Returns the workspace member that owns `relPath`, or undefined when the path
 * lies under no member. The longest matching member wins, so a file under a
 * member that sits inside another member's tree is attributed to the inner one.
 */
export function owningMember(
  relPath: string,
  members: readonly string[],
): string | undefined {
  let owner: string | undefined;
  for (const member of members) {
    if (relPath === member || relPath.startsWith(`${member}/`)) {
      if (owner === undefined || member.length > owner.length) owner = member;
    }
  }
  return owner;
}

// The workspace member list from the root deno.jsonc, normalized to
// repo-relative paths with no leading `./` or trailing `/`.
export function parseWorkspaceMembers(rootConfigText: string): string[] {
  const config = parseJsonc(rootConfigText) as { workspace?: unknown } | null;
  const workspace = config?.workspace;
  if (!Array.isArray(workspace)) return [];
  return workspace
    .filter((member): member is string => typeof member === "string")
    .map((member) => member.replace(/^\.\//, "").replace(/\/+$/, ""));
}

interface SourceFile {
  /** The owning workspace member, or undefined when under none. */
  owner: string | undefined;

  content: string;
}

// Repo-relative, forward-slash paths of the files git tracks under `root`, or
// null when `root` is not the top of a git working tree (so a caller can fall
// back to walking). `-z` NUL-separates the names, which keeps paths with odd
// characters intact. `gitCommand` names the git binary; it exists so a test can
// point at a missing one and exercise the not-installed path.
export async function gitTrackedFiles(
  root: string,
  gitCommand = "git",
): Promise<string[] | null> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(gitCommand, {
      args: ["-C", root, "ls-files", "-z"],
      stdout: "piped",
      stderr: "null",
    }).output();
  } catch {
    return null; // git is not installed
  }
  if (!output.success) return null; // not a git repository
  const paths = new TextDecoder().decode(output.stdout)
    .split("\0").filter((path) => path !== "");
  // An empty result means the command ran but tracks nothing here — a temp
  // fixture directory, or one nested in an unrelated repository. Walk instead.
  return paths.length > 0 ? paths : null;
}

// Repo-relative, forward-slash paths under `root`, found by walking the
// filesystem. Used only when `root` is not a git working tree.
async function walkFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  const walker = walk(root, { includeDirs: false, skip: SKIP_DIRS });
  for await (const entry of walker) {
    paths.push(relative(root, entry.path).replaceAll("\\", "/"));
  }
  return paths;
}

function isCodeFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && CODE_EXTENSIONS.has(path.slice(dot));
}

// The vendored loom copy is a separate repository checked in under vendor/. Git
// tracks it, so exclude it here; the walk fallback skips it by directory.
function isVendored(path: string): boolean {
  return path === "vendor" || path.startsWith("vendor/");
}

// Reads every source code file under `root`, tagged with its owning member.
async function readSourceFiles(
  root: string,
  members: readonly string[],
): Promise<SourceFile[]> {
  const tracked = await gitTrackedFiles(root);
  const paths = (tracked ?? await walkFiles(root))
    .filter((path) => isCodeFile(path) && !isVendored(path));
  const files: SourceFile[] = [];
  for (const path of paths) {
    let content: string;
    try {
      content = await Deno.readTextFile(join(root, path));
    } catch {
      continue; // tracked but absent from the working tree
    }
    files.push({ owner: owningMember(path, members), content });
  }
  return files;
}

// One import-map entry located in the tree.
interface Entry {
  /** Repo-relative path of the declaring deno.jsonc. */
  config: string;

  /** The declaring member, or undefined for the root config. */
  member: string | undefined;

  alias: string;
  specifier: string;
}

/** An import-map entry flagged unused, with its allowlist reason if any. */
export interface UnusedEntry extends Entry {
  reason?: string;
}

export interface ScanResult {
  /** Unused entries that are not allowlisted. */
  unused: UnusedEntry[];

  /** Unused entries that are allowlisted, with their reasons. */
  allowlisted: UnusedEntry[];
}

// The config file names Deno recognizes for a directory, in the order it
// prefers them: when a directory holds both, Deno reads deno.json and ignores
// deno.jsonc, so this reads the same file Deno would.
const CONFIG_NAMES = ["deno.json", "deno.jsonc"];

// Finds the Deno config for the directory `dir` (the empty string for the
// workspace root) under `root`, trying each recognized name. Returns its
// repo-relative path and text, or null when the directory has neither. A member
// that keeps its config in deno.json rather than deno.jsonc is read the same
// way, so its import map is checked too.
async function readConfig(
  root: string,
  dir: string,
): Promise<{ path: string; text: string } | null> {
  for (const name of CONFIG_NAMES) {
    const path = dir === "" ? name : `${dir}/${name}`;
    try {
      return { path, text: await Deno.readTextFile(join(root, path)) };
    } catch {
      // Try the next recognized name.
    }
  }
  return null;
}

// Collects every import-map entry from the root config and each member config.
async function collectEntries(
  root: string,
  members: readonly string[],
): Promise<Entry[]> {
  const entries: Entry[] = [];
  const dirs: Array<{ dir: string; member: string | undefined }> = [
    { dir: "", member: undefined },
    ...members.map((member) => ({ dir: member, member })),
  ];
  for (const { dir, member } of dirs) {
    const config = await readConfig(root, dir);
    if (config === null) continue; // the directory has no Deno config
    for (
      const [alias, specifier] of Object.entries(parseImportMap(config.text))
    ) {
      entries.push({ config: config.path, member, alias, specifier });
    }
  }
  return entries;
}

/**
 * Scans the tree under `root` and returns the import-map entries that no
 * in-scope source file imports, split by whether the allowlist excuses them.
 */
export async function scan(root: string = REPO_ROOT): Promise<ScanResult> {
  const rootConfig = await readConfig(root, "");
  const members = rootConfig === null
    ? []
    : parseWorkspaceMembers(rootConfig.text);
  const [entries, files] = await Promise.all([
    collectEntries(root, members),
    readSourceFiles(root, members),
  ]);

  const unused: UnusedEntry[] = [];
  const allowlisted: UnusedEntry[] = [];
  for (const entry of entries) {
    // Root entries (member undefined) are inherited by every file; a member's
    // entries are in scope only for files the member owns.
    const scoped = entry.member === undefined
      ? files
      : files.filter((file) => file.owner === entry.member);
    if (scoped.some((file) => importsAlias(file.content, entry.alias))) {
      continue;
    }
    const reason = ALLOWLIST.get(`${entry.config}\t${entry.alias}`);
    (reason === undefined ? unused : allowlisted).push({ ...entry, reason });
  }
  const byLocation = (a: Entry, b: Entry) =>
    a.config.localeCompare(b.config) || a.alias.localeCompare(b.alias);
  unused.sort(byLocation);
  allowlisted.sort(byLocation);
  return { unused, allowlisted };
}

function reportUnused(unused: UnusedEntry[]): void {
  const lines = [
    "",
    "Import map entries that no in-scope source file imports:",
    "",
    ...unused.map((entry) => `  ${entry.config}: ${entry.alias}`),
    "",
    "Each of these is declared in an import map but imported nowhere the map",
    "governs (a member's map covers only that member's files; the root map",
    "covers the whole workspace). Remove the alias from its `imports` block, then",
    "run `deno install` to drop it from deno.lock.",
    "",
    "If a `@types/*` alias is listed, its package is meant to type an npm import.",
    'Point that import at it with a `// @ts-types="<alias>"` comment rather',
    "than deleting the alias — the bare specifier resolves through the import map.",
    "",
    "If an entry is declared without a local import on purpose, add it to",
    "ALLOWLIST in tasks/check-unused-deps.ts with a one-line reason.",
    "",
  ];
  console.error(lines.join("\n"));
}

/** Runs the check over `root`, reports, and returns a process code. */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const { unused, allowlisted } = await scan(root);
  if (unused.length > 0) {
    reportUnused(unused);
    return 1;
  }
  console.log(
    `No unused import map entries ` +
      `(${allowlisted.length} allowlisted exception(s)).`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main());
