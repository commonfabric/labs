/**
 * The plan phase of a repository sync: finding a repository's pattern entries
 * and compiling each one into the pattern the index is sent. `repo-sync.ts`
 * says why a sync runs in two phases; this one evaluates the repository's
 * code and runs where there is no credential to take.
 */

import { globToRegExp, join, relative, resolve, SEPARATOR } from "@std/path";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  type CompiledPattern,
  normalizeHashtags,
  patternDocMetadata,
  publishRequestFor,
} from "./publish.ts";
import { type PlannedEntry, reasonOf, type RepoSyncPlan } from "./repo-sync.ts";

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
   * The paths the push being synced deleted, relative to the repository
   * root; empty for a run no push started.
   */
  deletedPaths: readonly string[];
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
 * The repository-relative entry files `options` names: tracked TypeScript
 * modules that `include` matches and `exclude` does not, that are not tests,
 * and that have a default export. Sorted, so reports read the same each run.
 */
export const findEntries = async (
  options: Pick<RepoEntryOptions, "repoRoot" | "include" | "exclude">,
  deps: Pick<PlanDeps, "trackedFiles" | "readTextFile">,
): Promise<string[]> => {
  const selects = selector(options);
  const entries: string[] = [];
  for (const path of await deps.trackedFiles()) {
    if (!selects(path)) continue;
    const source = await deps.readTextFile(join(options.repoRoot, path));
    if (DEFAULT_EXPORT.test(source)) entries.push(path);
  }
  return entries.sort();
};

/** Resolves and compiles one entry. */
const planEntry = async (
  path: string,
  root: string,
  options: RepoEntryOptions,
  deps: PlanDeps,
): Promise<PlannedEntry> => {
  const entry = join(options.repoRoot, path);
  const program = await deps.resolveProgram(entry, root);
  // An entry with no description is still compiled, so a broken one fails
  // the sync whether or not it would have been published.
  const compiled = await deps.compileProgram(program);
  if (compiled.patternId === undefined) {
    throw new Error("the compile produced no durable pattern id");
  }
  const doc = patternDocMetadata(await deps.readTextFile(entry));
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
  });
  const schemas = {
    ...(request.argumentSchema === undefined
      ? {}
      : { argumentSchema: request.argumentSchema }),
    ...(request.resultSchema === undefined
      ? {}
      : { resultSchema: request.resultSchema }),
  };
  return {
    path,
    status: "compiled",
    pattern: {
      path,
      patternId: request.patternId,
      program: request.program,
      meta: {
        description: request.description,
        hashtags: request.hashtags,
        ...(request.keywords === undefined
          ? {}
          : { keywords: request.keywords }),
      },
      ...(Object.keys(schemas).length === 0 ? {} : { schemas }),
      ...(request.dependencies === undefined
        ? {}
        : { dependencies: request.dependencies }),
    },
  };
};

/**
 * The plan phase: compiles every entry, and names the deleted paths that
 * could have been entries. An entry that fails to resolve or compile is
 * recorded and the rest still run.
 *
 * A deleted file can no longer say whether it had a default export, so every
 * deleted path the globs select is named; the index withdraws only those
 * that are lineages. A path deleted and added again in one push is not
 * named, since it is still tracked.
 *
 * @throws Error when the program root lies outside the repository.
 */
export const planRepo = async (
  options: RepoEntryOptions,
  deps: PlanDeps,
): Promise<RepoSyncPlan> => {
  const root = programRootOf(options);
  const entries: PlannedEntry[] = [];
  for (const path of await findEntries(options, deps)) {
    try {
      entries.push(await planEntry(path, root, options, deps));
    } catch (error) {
      entries.push({ path, status: "failed", reason: reasonOf(error) });
    }
  }
  const tracked = new Set(await deps.trackedFiles());
  const selects = selector(options);
  const removed = [...new Set(deps.deletedPaths)]
    .filter((path) => selects(path) && !tracked.has(path))
    .sort();
  return { entries, removed };
};
