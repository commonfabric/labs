#!/usr/bin/env -S deno run --allow-read --allow-run=git
//
// Deterministic "tripwire" for the text an agent receives without asking for
// it: the repo-local skills under skills/, the agent guides named AGENTS.md,
// the path-scoped rules under .claude/rules/, and the Claude Code hook scripts
// under .claude/scripts/, whose messages reach an agent the same way. It is a
// cheap, instant, zero-token CI gate that fails when a fact one of them cites
// stops resolving against the tree.
//
// These documents are summaries: they name a path or a symbol instead of
// restating what is there, which is what keeps them short enough to be worth
// loading. That only works while the names are right, and nothing about
// renaming a file tells you that a summary somewhere named it.
//
// It checks two kinds of citation, and deliberately hardcodes no fact list
// (that would just re-introduce the rot it guards — the facts are derived from
// the document text itself):
//
//   1. Every `@commonfabric/...` import specifier resolves. A bare package
//      reference needs a root (".") export; a subpath needs that subpath in the
//      package's `exports`.
//   2. Every repo path cited in backticks exists. `citedPath` and `isRooted`
//      below define what counts as a path citation.
//
// Semantic drift — a canonical home that moved or was renamed, advice that is
// now wrong, something missing — is the job of the LLM audit
// (docs/development/skill-audit.md), the appreciating half of the pair.
// Together they implement "make load-bearing facts testable" from
// docs/development/skill-authoring.md.
//
// Usage: deno task check-skill-facts
//    or: deno run --allow-read --allow-run=git ./tasks/check-skill-facts.ts

import { parse as parseJsonc } from "@std/jsonc";
import { dirname, fromFileUrl } from "@std/path";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { gitLsFiles, repositoryFiles } from "./repository-files.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/**
 * The set of paths that make up the repository, as directories and files.
 *
 * Membership comes from git rather than from stat() so that the check asks "is
 * this path part of the repo" rather than "does this path exist on this
 * machine". Ignored build output (a local `dist/`, `node_modules/`, coverage
 * trees) is not part of the repo, so a skill citing such a path fails the same
 * way everywhere instead of passing only on machines that happen to have built.
 */
export class Tree {
  readonly #files: Set<string> = new Set();
  readonly #dirs: Set<string> = new Set();
  readonly #symlinks: Set<string>;

  /**
   * Builds a tree from repo-relative, forward-slash file paths. `symlinks` names
   * those entries git records as symlinks, which must also appear in `files`.
   */
  constructor(files: Iterable<string>, symlinks: Iterable<string> = []) {
    for (const path of files) {
      this.#files.add(path);
      for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
        this.#dirs.add(path.slice(0, i));
      }
    }
    this.#symlinks = new Set(symlinks);
  }

  /** Is `path` a file or a directory in the tree? */
  has(path: string): boolean {
    if (this.#files.has(path) || this.#dirs.has(path)) return true;
    return this.#underSymlink(path);
  }

  /**
   * Is `path` below a symlink? A symlinked directory is a single entry, so
   * nothing beneath it appears in the tree — the repo carries 40-odd of them,
   * since `.claude/skills/<name>` and `.agents/skills/<name>` are symlinks into
   * `skills/`. What lies below one cannot be answered from git, so such a path
   * counts as resolving rather than being reported as missing when it reads fine.
   *
   * Only symlinks get this exception. An ordinary file is opaque to nothing: a
   * path below one is stale — a directory the citation predates has since become
   * a file — and reporting it is the point.
   */
  #underSymlink(path: string): boolean {
    for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
      if (this.#symlinks.has(path.slice(0, i))) return true;
    }
    return false;
  }

  /** Is `path` a directory in the tree? */
  isDir(path: string): boolean {
    return this.#dirs.has(path);
  }

  /** Every file in the tree whose path matches `re`, sorted. */
  filesMatching(re: RegExp): string[] {
    return [...this.#files].filter((p) => re.test(p)).sort();
  }
}

/** The mode git gives a symlink entry in `ls-files -s` output. */
const SYMLINK_MODE = "120000";

/**
 * The paths of tracked symlinks. `ls-files -s` prefixes each entry with
 * "<mode> <object> <stage>\t", so the mode distinguishes a symlink from an
 * ordinary file, which the plain listing cannot.
 */
async function gitSymlinks(root: string): Promise<string[]> {
  const entries = await gitLsFiles(root, ["--cached", "-s"]);
  const paths: string[] = [];
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab !== -1 && entry.startsWith(`${SYMLINK_MODE} `)) {
      paths.push(entry.slice(tab + 1));
    }
  }
  return paths;
}

/**
 * Reads the repo as git sees it: tracked files, plus untracked files .gitignore
 * does not cover, minus files the index still holds but the working tree no
 * longer has.
 *
 * Untracked-but-not-ignored files count so a skill may cite a doc added in the
 * same change before it is staged. Ignored files never count, which is what
 * keeps build output from making a citation resolve. Subtracting deleted files
 * means a citation breaks the moment its target is moved away, rather than
 * lingering until the deletion is staged.
 */
export async function readTree(root: string): Promise<Tree> {
  const [present, symlinks] = await Promise.all([
    repositoryFiles(root),
    gitSymlinks(root),
  ]);
  const held = new Set(present);
  return new Tree(present, symlinks.filter((path) => held.has(path)));
}

/**
 * Marks a backticked token as something other than a repo path: a glob, or a
 * stand-in for a name the reader supplies. Authors citing an illustrative path
 * use one of these forms — `packages/<pkg>/mod.ts`, `cf-{name}/cf-{name}.ts`,
 * `packages/**` — which is the inline opt-out from this check.
 */
const PLACEHOLDER = /[<>{}*]|\.\.\.|path\/to/;

/**
 * Normalizes a backticked token to the path it cites, or returns null when the
 * token is not a path citation. Rejects tokens with whitespace, which are
 * command lines rather than paths, and tokens with no directory separator, which
 * carry nothing to root them against the tree. Strips a leading `./` or `/`, a
 * trailing `#fragment`, and trailing slashes.
 *
 * This only decides the token's *shape*. Whether it names a real root is
 * `isRooted`'s job.
 */
export function citedPath(token: string): string | null {
  const raw = token.trim();
  if (/\s/.test(raw)) return null;
  if (PLACEHOLDER.test(raw)) return null;
  if (!raw.includes("/")) return null;
  const path = raw
    .replace(/^\.?\/+/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");
  return path === "" ? null : path;
}

/** The part of `path` before the first slash. */
function firstSegment(path: string): string {
  const i = path.indexOf("/");
  return i === -1 ? path : path.slice(0, i);
}

/**
 * Is `path` rooted at a directory that exists, either at the repo root or inside
 * `skillDir`? This is the conservative half of the heuristic: skills use
 * backticks for shell fragments (`-s/--space`), prose (`async/await`), module
 * specifiers (`lit/directives/class-map.js`) and paths inside a mounted
 * filesystem (`input/contacts.json`), none of which start with a real directory.
 * Requiring a real first segment leaves those alone.
 */
export function isRooted(path: string, skillDir: string, tree: Tree): boolean {
  const head = firstSegment(path);
  return tree.isDir(head) || tree.isDir(`${skillDir}/${head}`);
}

/**
 * Does `path`, cited by a doc in `skillDir`, resolve?
 *
 * Skills cite paths two ways and both are in use: relative to the repo root
 * (skills/cf names `scripts/check-local-dev.sh`) and relative to the skill's own
 * directory (skills/agent-browser names `scripts/form-automation.sh`, which
 * lives in skills/agent-browser/scripts/; skills/lit-component names
 * `references/theme-system.md`). A citation resolving under either base is a
 * citation that leads the reader somewhere real.
 */
export function resolvesInTree(
  path: string,
  skillDir: string,
  tree: Tree,
): boolean {
  return tree.has(`${skillDir}/${path}`) || tree.has(path);
}

/** Does `key` ("." or "./sub") resolve against a deno.jsonc `exports` value? */
function resolvesExport(exports: unknown, key: string): boolean {
  if (typeof exports === "string") return key === "."; // string = root export only
  if (isObjectOrArray(exports)) {
    return key in (exports as Record<string, unknown>);
  }
  return false;
}

/** A markdown file under skills/ and its contents. */
export interface SkillDoc {
  /** Repo-relative path, e.g. "skills/cf-review/SKILL.md". */
  path: string;

  text: string;
}

/** A citation that no longer resolves. */
export interface Drift {
  /** Repo-relative path of the doc making the citation. */
  file: string;

  /** 1-based line within that doc. */
  line: number;

  message: string;
}

/** The 1-based line number containing `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (
    let i = text.indexOf("\n");
    i !== -1 && i < index;
    i = text.indexOf("\n", i + 1)
  ) {
    line++;
  }
  return line;
}

/**
 * The directory of the skill a doc belongs to: "skills/<name>" for a doc inside
 * a skill, and "skills" for a doc directly under it (skills/README.md).
 */
export function skillDirOf(docPath: string): string {
  const parts = docPath.split("/");
  return parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * A `@commonfabric/...` specifier, capturing the package name and the subpath
 * after it, which is empty for a bare reference. Subpath segments allow
 * PascalCase and dots (e.g. data-model/SchemaAndHash).
 */
const SPECIFIER_RE = /(@commonfabric\/[a-z0-9-]+)((?:\/[\w.-]+)*)/g;

const BACKTICKED_RE = /`([^`\n]+)`/g;

/**
 * Every citation in `docs` that no longer resolves against `tree` and
 * `exportsByName`. Pure: all I/O happens in `main`.
 */
export function collectDrift(
  docs: SkillDoc[],
  tree: Tree,
  exportsByName: Map<string, unknown>,
): Drift[] {
  const drift: Drift[] = [];
  for (const doc of docs) {
    const skillDir = skillDirOf(doc.path);

    for (const match of doc.text.matchAll(SPECIFIER_RE)) {
      const [spec, base, subpath] = match;
      const sub = subpath.slice(1); // drop the leading "/"; empty when bare
      const line = lineAt(doc.text, match.index);
      if (!exportsByName.has(base)) {
        drift.push({
          file: doc.path,
          line,
          message: `package not in workspace: ${base}`,
        });
        continue;
      }
      const key = sub ? `./${sub}` : ".";
      if (!resolvesExport(exportsByName.get(base), key)) {
        drift.push({
          file: doc.path,
          line,
          message: sub
            ? `${base} has no export "${key}" — specifier "${spec}" won't resolve`
            : `${base} has no root export — bare "${spec}" won't resolve; cite a subpath`,
        });
      }
    }

    for (const match of doc.text.matchAll(BACKTICKED_RE)) {
      const path = citedPath(match[1]);
      if (path === null) continue;
      if (!isRooted(path, skillDir, tree)) continue;
      if (resolvesInTree(path, skillDir, tree)) continue;
      drift.push({
        file: doc.path,
        line: lineAt(doc.text, match.index),
        message: `path does not exist: ${path}`,
      });
    }
  }
  return drift;
}

/** Maps each workspace package name to its `exports` value. */
export async function readWorkspaceExports(
  root: string,
): Promise<Map<string, unknown>> {
  const read = (p: string) => Deno.readTextFile(`${root}/${p}`);
  const config = parseJsonc(await read("deno.jsonc")) as {
    workspace?: string[];
  };
  const exportsByName = new Map<string, unknown>();
  for (const member of config.workspace ?? []) {
    const path = `${member.replace(/^\.\//, "")}/deno.jsonc`;
    let raw: string;
    try {
      raw = await read(path);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue; // member has no deno.jsonc
      throw e; // real I/O failure — surface it, don't hide config breakage
    }
    let pkg: { name?: string; exports?: unknown };
    try {
      pkg = parseJsonc(raw) as { name?: string; exports?: unknown };
    } catch (e) {
      throw new Error(`invalid JSONC in ${path}: ${(e as Error).message}`);
    }
    if (pkg.name) exportsByName.set(pkg.name, pkg.exports);
  }
  return exportsByName;
}

/**
 * The documents this check covers: everything under skills/, every AGENTS.md
 * at any depth, the path-scoped rules under .claude/rules/, and the hook
 * scripts under .claude/scripts/. CLAUDE.md files are excluded because each is
 * a single `@AGENTS.md` import, and an import is not written in backticks so
 * there would be nothing here to check.
 *
 * The hook scripts are TypeScript rather than Markdown. They are covered for
 * the property they share with the rest: an agent reads their messages without
 * having asked for them, and cannot tell whether a path in one still exists. A
 * test file beside a hook is not read that way, so it is excluded.
 *
 * TypeScript does contain backticks, in template literals. The shape rules
 * below are what keep those from being reported, rather than any absence of
 * backticks. A template literal's body contains whitespace and an
 * interpolation contains `${`, and neither counts as a path citation. A short
 * backticked token that does look like a path is checked, which is intended.
 */
const COVERED_RE =
  /^(?:skills\/.*\.md|(?:.*\/)?AGENTS\.md|\.claude\/(?:rules\/.*\.md|scripts\/(?!.*\.test\.ts$).*\.ts))$/;

/** Reads every covered file that is part of the tree. */
export async function readSkillDocs(
  root: string,
  tree: Tree,
): Promise<SkillDoc[]> {
  const paths = tree.filesMatching(COVERED_RE);
  return await Promise.all(paths.map(async (path) => ({
    path,
    text: await Deno.readTextFile(`${root}/${path}`),
  })));
}

function reportDrift(drift: Drift[]): void {
  console.error("\nAgent-facing facts that no longer resolve:\n");
  for (const { file, line, message } of drift) {
    console.error(`  ${file}:${line}  ${message}`);
  }
  console.error(
    [
      "",
      "Skills, AGENTS.md guides, the rules under .claude/rules/ and the hook",
      "scripts under .claude/scripts/ are live documentation. A citation that",
      "stops resolving sends a reader to a path that does not exist. Fix it to",
      "name the current path or specifier.",
      "",
      "A path cited as an illustration rather than a real location should say so",
      "with a placeholder — `packages/<pkg>/mod.ts`, `cf-{name}/cf-{name}.ts`,",
      "`packages/**` — which this check skips by design.",
      "",
      "See docs/development/skill-audit.md.",
      "",
    ].join("\n"),
  );
}

/** Runs the check over `root`, reports, and returns a process exit code. */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const tree = await readTree(root);
  const docs = await readSkillDocs(root, tree);
  const drift = collectDrift(docs, tree, await readWorkspaceExports(root));
  if (drift.length > 0) {
    reportDrift(drift);
    return 1;
  }
  console.log(`Agent-facing facts OK (${docs.length} documents).`);
  return 0;
}

if (import.meta.main) Deno.exit(await main());
