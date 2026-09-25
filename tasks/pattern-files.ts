/**
 * The set of authored pattern entry files in the repository, and the baselines
 * recorded for them.
 *
 * Shared by `cfcheck.ts` (type-checks them) and `pattern-compat.ts` (proves
 * each one can still be applied over its deployed predecessors). The two must
 * agree on the set: a file cfcheck compiles but pattern-compat skips is a
 * pattern that can ship without an updatability proof.
 */

import { CONNECTOR_PATTERN_SOURCES } from "../packages/connectors/pattern-sources.ts";

export const PATTERNS_DIR = "packages/patterns";

/** The recorded contracts of every pattern, one directory per pattern key. */
export const BASELINES_DIR = `${PATTERNS_DIR}/baselines`;

/** A source tree whose authored modules are checked as patterns. */
export interface PatternTree {
  /** Repository-relative directory containing the source modules. */
  readonly directory: string;

  /** Baseline-key prefix when the source tree is outside `PATTERNS_DIR`. */
  readonly keyPrefix?: string;

  /** Program root allowed to resolve the tree's local imports. */
  readonly programRoot?: string;
}

/** Every source tree covered by the pattern type and compatibility checks. */
export const PATTERN_TREES: readonly PatternTree[] = [
  { directory: PATTERNS_DIR },
  ...CONNECTOR_PATTERN_SOURCES.map((source) => ({
    ...source,
    programRoot: ".",
  })),
];

/**
 * Exclusions are expressed relative to the patterns root, not to the repo
 * root, so they hold whatever directory the walk is rooted at — an absolute
 * path, or a relative one from a different working directory. Anchoring them
 * to `packages/patterns/...` instead would silently stop excluding anything
 * the moment a caller passed an absolute directory.
 */
const NON_PATTERN_FILES = new Set([
  "mod.ts",
]);

const NON_PATTERN_BASENAMES = new Set([
  "contract.ts",
  "guest.ts",
  "guest.tsx",
]);

const NON_PATTERN_PREFIXES = [
  "integration/",
  "tools/",
];

/** Use repository separators for keys shared across operating systems. */
export function normalizePatternPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * A pattern's identity in the baseline tree: its path relative to the patterns
 * root, e.g. `system/home.tsx`. This is also the suffix of the toolshed route
 * that serves it (`/api/patterns/system/home.tsx`), which is what the updater
 * resolves against — so a baseline directory is named by the same string the
 * update mechanism keys on.
 */
export function patternKey(path: string, patternsDir?: string): string {
  const normalizedPath = normalizePatternPath(path);
  if (patternsDir !== undefined) {
    const prefix = `${normalizePatternPath(patternsDir)}/`;
    return normalizedPath.startsWith(prefix)
      ? normalizedPath.slice(prefix.length)
      : normalizedPath;
  }
  for (const tree of PATTERN_TREES) {
    const prefix = `${tree.directory}/`;
    if (!normalizedPath.startsWith(prefix)) continue;
    const relative = normalizedPath.slice(prefix.length);
    return tree.keyPrefix === undefined
      ? relative
      : `${tree.keyPrefix}/${relative}`;
  }
  return normalizedPath;
}

/** Whether a pattern path or its deployed key contains a filter. */
export function matchesPatternFilter(path: string, filter: string): boolean {
  const normalizedPath = normalizePatternPath(path);
  const normalizedFilter = normalizePatternPath(filter);
  return normalizedPath.includes(normalizedFilter) ||
    patternKey(normalizedPath).includes(normalizedFilter);
}

/** Repository-relative source path for a compatibility-baseline key. */
export function patternPath(key: string): string {
  for (const tree of PATTERN_TREES) {
    if (tree.keyPrefix === undefined) continue;
    const prefix = `${tree.keyPrefix}/`;
    if (key.startsWith(prefix)) {
      return `${tree.directory}/${key.slice(prefix.length)}`;
    }
  }
  return `${PATTERNS_DIR}/${key}`;
}

/** Source root containing a repository-relative pattern path. */
export function patternRoot(path: string): string {
  const normalizedPath = normalizePatternPath(path);
  return PATTERN_TREES.find((tree) =>
    normalizedPath === tree.directory ||
    normalizedPath.startsWith(`${tree.directory}/`)
  )?.programRoot ?? PATTERNS_DIR;
}

/** Whether a path under the patterns root is an authored pattern entry. */
export function isPatternSource(
  path: string,
  patternsDir = PATTERNS_DIR,
): boolean {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return false;
  const key = patternKey(path, patternsDir);
  if (NON_PATTERN_FILES.has(key)) return false;
  const segments = key.split("/");
  if (
    segments[0].startsWith("iframe-") &&
    NON_PATTERN_BASENAMES.has(segments.at(-1)!)
  ) return false;
  return !NON_PATTERN_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export async function collectPatternFiles(
  dir: string = PATTERNS_DIR,
): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string) {
    for await (const entry of Deno.readDir(current)) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      if (!entry.isFile) continue;
      if (!isPatternSource(path, dir)) continue;
      files.push(path);
    }
  }

  await walk(dir);
  return files.sort();
}

/** Every authored pattern source across all registered source trees. */
export async function collectAllPatternFiles(): Promise<string[]> {
  const files = await Promise.all(
    PATTERN_TREES.map((tree) => collectPatternFiles(tree.directory)),
  );
  return files.flat().sort();
}

/**
 * Every pattern key that has a baseline directory, including retired ones.
 *
 * A pattern's own directory is named for its file (`home.tsx`), so a name
 * ending in `.ts`/`.tsx` terminates the walk and anything else is an
 * intermediate path segment (`system/`). That is the only thing distinguishing
 * the two — baselines live at `<dir>/<pattern path>/<file>.json`, and a pattern
 * path is exactly the route suffix the updater keys on.
 */
export async function collectBaselineKeys(
  baselinesDir: string,
): Promise<string[]> {
  const keys: string[] = [];
  async function walk(current: string, prefix: string) {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(current)];
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        keys.push(key);
      } else {
        await walk(`${current}/${entry.name}`, key);
      }
    }
  }
  await walk(baselinesDir, "");
  return keys.sort();
}

/**
 * Every pattern the update compatibility gate judges, as repository-relative
 * paths: each of `files`, then the path of each pattern whose file is gone but
 * which still has baselines under `baselinesDir` or is one of the
 * `acceptedBreakPatterns`, the keys the accepted contract breaks name.
 *
 * A gone pattern is judged like any other, by whichever run is given its path,
 * so no run has to ask about the tree as a whole. The gate and the lanes that
 * divide it both build their lists here, so the two agree.
 */
export async function collectCompatibilityPaths(
  files: readonly string[],
  baselinesDir: string,
  acceptedBreakPatterns: readonly string[],
): Promise<string[]> {
  const present = new Set(files.map((file) => patternKey(file)));
  const recorded = new Set([
    ...await collectBaselineKeys(baselinesDir),
    ...acceptedBreakPatterns,
  ]);
  const gone = [...recorded].filter((key) => !present.has(key));
  return [...files, ...gone.map((key) => patternPath(key))];
}
