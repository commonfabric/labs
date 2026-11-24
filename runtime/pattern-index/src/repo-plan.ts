/**
 * The plan phase of a repository sync: finding a repository's pattern entries
 * and compiling each one into the publish request the index is sent. `repo-sync.ts`
 * says why a sync runs in two phases; this one evaluates the repository's
 * code and runs where there is no credential to take.
 */

import {
  basename,
  globToRegExp,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  type CompiledPattern,
  normalizeHashtags,
  patternDocMetadata,
  publishRequestFor,
} from "./publish.ts";
import {
  type PlannedEntry,
  programSourceHash,
  reasonOf,
  type RepoSyncPlan,
} from "./repo-sync.ts";

/** Which files are a repository's pattern entries, and how to read them. */
export interface RepoEntryOptions {
  /** The working tree's root, absolute. */
  repoRoot: string;

  /**
   * The directory, relative to `repoRoot`, that program file names are
   * written against. Every file an entry imports must lie inside it, and it
   * must lie inside the repository.
   */
  programRoot: string;

  /** Globs, relative to `repoRoot`, naming the files that may be entries. */
  include: readonly string[];

  /** Globs, relative to `repoRoot`, removing files `include` named. */
  exclude: readonly string[];
}

/** What the plan phase reaches the world through. */
export interface PlanDeps {
  /** The repository's tracked files, relative to its root. */
  trackedFiles: () => Promise<readonly string[]>;

  readTextFile: (path: string) => Promise<string>;

  /** Assembles the program an entry and its imports make, without compiling. */
  resolveProgram: (entry: string, root: string) => Promise<RuntimeProgram>;

  /** Compiles an assembled program. */
  compileProgram: (program: RuntimeProgram) => Promise<CompiledPattern>;

  /**
   * The experimental flags the compile runs under. Part of the hash, since a
   * flag such as `contentAddressedSchemas` changes the id the same source
   * compiles to.
   */
  experimental: object;
}

/** Whether a path names a TypeScript module that may be an entry. */
const isModuleCandidate = (path: string): boolean =>
  /\.tsx?$/.test(path) && !/(?:\.test|_test)\.tsx?$/.test(path);

/**
 * A top-level default export, written either way: what makes a module a
 * pattern entry rather than a helper it imports. In this repository's own
 * `patterns/` it picks the files `tasks/pattern-files.ts` gives a recorded
 * baseline; that module has its own rules, which happen to agree.
 */
const DEFAULT_EXPORT =
  /^export\s+default\b|^export\s*\{[^}]*\bas\s+default\b[^}]*\}/m;

/** Whether `options`' globs select `path`. */
const selector = (
  options: Pick<RepoEntryOptions, "include" | "exclude">,
): (path: string) => boolean => {
  const matcher = (globs: readonly string[]) => {
    const patterns = globs.map((glob) =>
      globToRegExp(glob, { extended: true, globstar: true })
    );
    return (path: string) => patterns.some((pattern) => pattern.test(path));
  };
  const included = matcher(options.include);
  const excluded = matcher(options.exclude);
  return (path) => isModuleCandidate(path) && included(path) && !excluded(path);
};

/**
 * The program root, absolute.
 *
 * @throws Error when it lies outside the repository, where an import could
 *   read files the repository does not hold.
 */
const programRootOf = (options: RepoEntryOptions): string => {
  const root = resolve(options.repoRoot, options.programRoot);
  const fromRepo = relative(resolve(options.repoRoot), root);
  if (fromRepo === ".." || fromRepo.startsWith(`..${SEPARATOR}`)) {
    throw new Error(
      `The program root ${options.programRoot} lies outside the repository`,
    );
  }
  return root;
};

/**
 * The tracked TypeScript modules `options` selects: those `include` matches
 * and `exclude` does not, that are not tests. Sorted, so reports read the
 * same each run.
 */
const selectedPaths = async (
  options: Pick<RepoEntryOptions, "include" | "exclude">,
  deps: Pick<PlanDeps, "trackedFiles">,
): Promise<string[]> =>
  (await deps.trackedFiles()).filter(selector(options)).sort();

/** Whether a module's source makes it a pattern entry. */
const isEntrySource = (source: string): boolean => DEFAULT_EXPORT.test(source);

/**
 * The repository-relative entry files `options` names: the selected modules
 * that have a default export.
 */
export const findEntries = async (
  options: Pick<RepoEntryOptions, "repoRoot" | "include" | "exclude">,
  deps: Pick<PlanDeps, "trackedFiles" | "readTextFile">,
): Promise<string[]> => {
  const entries: string[] = [];
  for (const path of await selectedPaths(options, deps)) {
    const source = await deps.readTextFile(join(options.repoRoot, path));
    if (isEntrySource(source)) entries.push(path);
  }
  return entries;
};

/**
 * Whether a repository says this entry stands alone: in a repository a
 * pattern's folder is its name, `<name>/main.tsx` is the entry offered to a
 * person choosing what to place, and every other file is a part. Sent
 * either way, so the repository's answer is stated rather than left to the
 * index's default for a first version.
 */
export const isStandaloneEntry = (path: string): boolean =>
  basename(path) === "main.tsx";

/**
 * Resolves and compiles one entry, given the source already read from it.
 */
const planEntry = async (
  path: string,
  source: string,
  root: string,
  options: RepoEntryOptions,
  deps: PlanDeps,
): Promise<PlannedEntry> => {
  const entry = join(options.repoRoot, path);
  const program = await deps.resolveProgram(entry, root);
  const sourceHash = await programSourceHash(program, deps.experimental);
  // An entry with no description is still compiled, so a broken one fails
  // the sync whether or not it would have been published.
  const compiled = await deps.compileProgram(program);
  if (compiled.patternId === undefined) {
    throw new Error("the compile produced no durable pattern id");
  }
  const doc = patternDocMetadata(source);
  // The index finds patterns by what their description says, so one with
  // none would be found by nothing; the report asks for the doc comment.
  if (doc.description === undefined) return { path, status: "undescribed" };
  // The same request `cf pattern publish` sends, so the two agree on the
  // program, the schemas and the dependencies.
  const request = publishRequestFor({
    patternId: compiled.patternId,
    program: compiled.program,
    description: doc.description,
    hashtags: normalizeHashtags(doc.hashtags),
    keywords: doc.keywords,
    argumentSchema: compiled.argumentSchema,
    resultSchema: compiled.resultSchema,
    standalone: isStandaloneEntry(path),
  });
  return { path, status: "compiled", sourceHash, request };
};

/**
 * The plan phase: compiles every entry, and lists every path the globs
 * select, so the publish phase can tell a lineage whose file is gone from
 * one that is still here. A selected file that cannot be read, and an entry
 * that fails to resolve or compile, is recorded as failed and the rest still
 * run.
 *
 * @throws Error when the program root lies outside the repository.
 */
export const planRepo = async (
  options: RepoEntryOptions,
  deps: PlanDeps,
): Promise<RepoSyncPlan> => {
  const root = programRootOf(options);
  const selected = await selectedPaths(options, deps);
  const entries: PlannedEntry[] = [];
  for (const path of selected) {
    try {
      const source = await deps.readTextFile(join(options.repoRoot, path));
      if (!isEntrySource(source)) continue;
      entries.push(await planEntry(path, source, root, options, deps));
    } catch (error) {
      entries.push({ path, status: "failed", reason: reasonOf(error) });
    }
  }
  return { entries, selected };
};
