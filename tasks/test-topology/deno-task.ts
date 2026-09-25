/**
 * Reading a workspace member's `test` task well enough to run part of it.
 *
 * Selection needs the file to be the thing a lane can be pointed at, and
 * a member's task cannot be handed a subset: almost every one of them
 * lists its own paths, so appending more would add to what runs rather
 * than restrict it. What the task does carry is everything else the run
 * needs — the permissions, `--no-check`, a fake-clock preload, an `ENV`
 * assignment in front — so the task is read for those and its paths are
 * replaced with the chosen ones.
 *
 * Only the simple shape is read: leading `NAME=value` assignments, then
 * `deno test`, then flags and paths. A task carrying a shell
 * metacharacter or naming its own import map is not this shape, and the
 * member it belongs to is one unit that runs whole. The sharded runner, the one
 * wrapper the workspace puts around `deno test`, is read as the `deno test` it
 * runs. Each member behind it therefore becomes one unit per test file. The
 * runner can also name files that need flags of their own, and
 * {@link testBatches} is how both it and a lane split files by those flags.
 */

import * as path from "@std/path";
import { expandGlob } from "@std/fs/expand-glob";
import { parse as parseJsonc } from "@std/jsonc";

/** A member's test task, taken apart. */
export interface ParsedTestTask {
  /** Environment the task sets in front of the command. */
  env: Record<string, string>;

  /** Flags between `deno test` and the paths, in their own order. */
  flags: string[];

  /** The paths and globs the task runs, as the member directory sees them. */
  paths: string[];

  /** Globs the task refuses, from every `--ignore`. */
  ignores: string[];

  /**
   * Globs naming the files that cannot run beside another test file in one
   * process, from every `--serial` the sharded runner takes. Empty for a
   * plain `deno test`.
   */
  serial: string[];

  /**
   * Globs naming the files that need every permission, from every
   * `--all-access` the sharded runner takes. Empty for a plain
   * `deno test`.
   */
  allAccess: string[];
}

/** A metacharacter puts the flags and paths somewhere other than the test. */
const METACHARACTER = /[&;|<>`$()]/;

/**
 * The command substitution several members use to name the Deno they are
 * running under in an `--allow-run` list. It is resolved here rather
 * than treated as a metacharacter, because the alternative is those
 * members losing file granularity over a path this process already
 * knows. The seed substitution below is the other one the workspace
 * writes, and is taken out for the same reason.
 */
const EXEC_PATH_SUBSTITUTION =
  /\$\(deno eval ["']console\.log\(Deno\.execPath\(\)\)["']\)/g;

/**
 * What stands in for that substitution while the task is split into
 * words. The path goes in afterwards, because a path holding a space
 * would otherwise be split into two words that are neither of them it.
 */
const EXEC_PATH_PLACEHOLDER = "@DENO_EXEC_PATH@";

/**
 * The seed substitution every test task writes, which this takes out
 * rather than resolving: a suite builds its own `--shuffle` from the
 * seed the run settled on, which is the one to use where an override
 * names a seed other than the commit's.
 */
const SHUFFLE_SUBSTITUTION = /\s*--shuffle=\$\(deno task -q test-seed\)/g;

/** `NAME=value` in front of the command. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** The wrapper a member runs when its files are split across shards. */
const SHARDED_RUNNER = "run-sharded-test-files.ts";

/**
 * Strips shell quoting from a task's argument.
 *
 * A quote may wrap the whole word or sit inside it: several members
 * write `--allow-env=API_URL,"TSC_*",NODE_ENV`, where the quotes are the
 * shell's and the permission the flag names is `TSC_*` without them.
 * Passing the word through as written would give `deno test` a
 * permission with literal quote characters in it, which matches no
 * variable at all.
 */
export function unquote(word: string): string {
  let out = "";
  let quote: string | undefined;
  for (const character of word) {
    if (quote === undefined && (character === "'" || character === '"')) {
      quote = character;
      continue;
    }
    if (character === quote) {
      quote = undefined;
      continue;
    }
    out += character;
  }
  return out;
}

/** The globs a comma-separated option names, less any empty entry. */
function globList(value: string): string[] {
  return value.split(",").filter((glob) => glob.length > 0);
}

/** The arguments the sharded runner takes, apart. */
export interface ShardedRunnerArguments {
  /** The environment variable naming the shard this job runs. */
  shardVariable: string;

  /** The name of the weighting profile the runner shards by. */
  profile: string;

  /**
   * What the runner runs over, as a task naming it would: the directory
   * or glob it walks, the files it leaves out, the files that need flags
   * of their own, and the flags for `deno test`. The environment is
   * empty, because the runner's arguments set none.
   */
  test: ParsedTestTask;
}

/**
 * The sharded runner's arguments, apart, or undefined where they are not
 * the runner's shape.
 *
 * The runner takes the variable naming this job's shard, a weighting
 * profile, the directory or glob to walk, any number of `--serial=GLOBS`
 * and `--all-access=GLOBS` options, a `--` separator, and then the flags
 * for the `deno test` it runs. Each option takes a comma-separated list.
 * An `--ignore=GLOBS` among the flags is taken out of them and applied
 * to the walk, as it is for a task that runs `deno test` itself.
 */
export function readShardedRunnerArguments(
  args: readonly string[],
): ShardedRunnerArguments | undefined {
  const [shardVariable, profile, root, ...rest] = args;
  const separator = rest.indexOf("--");
  // A second `--` would make every word after it, the files the runner
  // appends included, an argument to the test modules rather than to
  // `deno test`.
  if (
    shardVariable === undefined || profile === undefined ||
    root === undefined || separator < 0 ||
    rest.indexOf("--", separator + 1) >= 0
  ) {
    return undefined;
  }
  const test: ParsedTestTask = {
    env: {},
    flags: [],
    paths: [root],
    ignores: [],
    serial: [],
    allAccess: [],
  };
  for (const option of rest.slice(0, separator)) {
    if (option.startsWith("--serial=")) {
      test.serial.push(...globList(option.slice("--serial=".length)));
    } else if (option.startsWith("--all-access=")) {
      test.allAccess.push(...globList(option.slice("--all-access=".length)));
    } else {
      return undefined;
    }
  }
  for (const flag of rest.slice(separator + 1)) {
    if (flag.startsWith("--ignore=")) {
      test.ignores.push(...globList(flag.slice("--ignore=".length)));
    } else {
      test.flags.push(flag);
    }
  }
  return { shardVariable, profile, test };
}

/**
 * A `deno run` of the sharded runner, as the `deno test` it runs, or undefined
 * for any other `deno run`.
 *
 * A lane is pointed at files rather than at a shard, so it needs only what
 * {@link readShardedRunnerArguments} reads apart from the shard and the
 * profile. The words before the runner are the runner's own permissions, and
 * the tests do not run under them.
 *
 * A word after the separator that is not a flag makes this return undefined.
 * The runner appends its chosen files after those words, so a path there would
 * run alongside whatever a lane asked for.
 */
function parseShardedRunner(
  env: Record<string, string>,
  words: readonly string[],
): ParsedTestTask | undefined {
  const runner = words.findIndex((word) => !word.startsWith("-"));
  if (runner < 0) return undefined;
  if (path.basename(words[runner]!) !== SHARDED_RUNNER) return undefined;
  const args = readShardedRunnerArguments(
    words.slice(runner + 1).map(unquote),
  );
  if (args === undefined) return undefined;
  if (args.test.flags.some((flag) => !flag.startsWith("-"))) return undefined;
  return { ...args.test, env };
}

/** One `deno test` over part of a member's test files. */
export interface TestBatch {
  /** The flags the batch runs under. */
  flags: string[];

  /** The batch's files, in the order they were given. */
  files: string[];
}

/** A flag granting a permission, which `--allow-all` stands in for. */
const PERMISSION_FLAG =
  /^(-A|-[RWNES](=.*)?|--allow-(read|write|net|env|run|ffi|sys|import)(=.*)?)$/;

/**
 * Splits a member's test files into the `deno test` runs they need. A file
 * one of the task's `serial` globs names runs without `--parallel`, so that
 * no other test file runs beside it in its process. A file one of its
 * `allAccess` globs names runs under `--allow-all` in place of every flag
 * granting a permission. Files that need the same flags share a batch.
 *
 * The batches come in a fixed order, whatever order the files do: the
 * files neither kind of glob names first, the serial files last. A batch
 * that would hold no file is left out, so a plain `deno test` task gives
 * one batch under its own flags.
 */
export function testBatches(
  task: Pick<ParsedTestTask, "flags" | "serial" | "allAccess">,
  files: readonly string[],
): TestBatch[] {
  const allAccessFlags = [
    ...task.flags.filter((flag) => !PERMISSION_FLAG.test(flag)),
    "--allow-all",
  ];
  const withoutParallel = (flags: readonly string[]) =>
    flags.filter((flag) => flag !== "--parallel");
  // Indexed by whether a file is all-access, plus two when it is serial.
  const batches: TestBatch[] = [
    { flags: task.flags, files: [] },
    { flags: allAccessFlags, files: [] },
    { flags: withoutParallel(task.flags), files: [] },
    { flags: withoutParallel(allAccessFlags), files: [] },
  ];
  for (const file of files) {
    const allAccess = matchesAny(file, task.allAccess) ? 1 : 0;
    const serial = matchesAny(file, task.serial) ? 2 : 0;
    batches[allAccess + serial]!.files.push(file);
  }
  return batches.filter((batch) => batch.files.length > 0);
}

/**
 * A member's test task as the pieces a subset run needs, or undefined for
 * a task this cannot read. That is a task that is neither a single `deno test`
 * nor a `deno run` of the sharded runner, a task carrying a shell
 * metacharacter, or a task naming its own import map. A task's import map
 * applies to every module of the invocation, including the preload, so a
 * specifier the preload needs has to be in it.
 */
export function parseTestTask(
  task: string,
  execPath: string = Deno.execPath(),
): ParsedTestTask | undefined {
  const resolved = task
    .replace(EXEC_PATH_SUBSTITUTION, EXEC_PATH_PLACEHOLDER)
    .replace(SHUFFLE_SUBSTITUTION, "");
  if (METACHARACTER.test(resolved)) return undefined;
  if (/--import-map[= ]/.test(resolved)) return undefined;
  const words = resolved.trim().split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.replaceAll(EXEC_PATH_PLACEHOLDER, execPath));
  const env: Record<string, string> = {};
  let index = 0;
  for (; index < words.length; index++) {
    const assignment = ASSIGNMENT.exec(words[index]!);
    if (assignment === null) break;
    env[assignment[1]!] = unquote(assignment[2]!);
  }
  if (words[index] === "deno" && words[index + 1] === "run") {
    return parseShardedRunner(env, words.slice(index + 2));
  }
  if (words[index] !== "deno" || words[index + 1] !== "test") return undefined;
  index += 2;
  const flags: string[] = [];
  const paths: string[] = [];
  const ignores: string[] = [];
  for (; index < words.length; index++) {
    const word = words[index]!;
    if (word.startsWith("--ignore=")) {
      ignores.push(...globList(unquote(word.slice("--ignore=".length))));
      continue;
    }
    if (word.startsWith("-")) {
      flags.push(unquote(word));
      continue;
    }
    paths.push(unquote(word));
  }
  return { env, flags, paths, ignores, serial: [], allAccess: [] };
}

/** What Deno takes for a test file when it walks a directory. */
export const DENO_TEST_FILE =
  /(^|[/\\])(test\.(ts|tsx|mts|js|mjs|jsx)|.*[._]test\.(ts|tsx|mts|js|mjs|jsx))$/;

/** Directories no walk descends into. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "coverage",
  "dist",
]);

async function walkTestFiles(
  directory: string,
  found: string[],
): Promise<void> {
  // The entries are read before any of them is followed, so that only
  // this directory's own absence is passed over. Catching around the
  // recursion as well would let one directory that vanished mid-walk end
  // the walk at every level above it, silently shortening the list of
  // tests — the failure the topology exists to make impossible.
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(directory));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walkTestFiles(path.join(directory, entry.name), found);
      continue;
    }
    if (entry.isFile && DENO_TEST_FILE.test(entry.name)) {
      found.push(path.join(directory, entry.name));
    }
  }
}

/** The `exclude` lists a member's manifest carries, for tests and overall. */
async function memberExcludes(memberDir: string): Promise<string[]> {
  for (const manifest of ["deno.json", "deno.jsonc"]) {
    let text: string;
    try {
      text = await Deno.readTextFile(path.join(memberDir, manifest));
    } catch {
      continue;
    }
    const config = parseJsonc(text) as {
      exclude?: string[];
      test?: { exclude?: string[] };
    };
    return [...config?.exclude ?? [], ...config?.test?.exclude ?? []];
  }
  return [];
}

/** Whether a member-relative path is covered by one of these globs. */
function matchesAny(
  candidate: string,
  globs: readonly string[],
): boolean {
  return globs.some((glob) => {
    const pattern = path.globToRegExp(glob, { globstar: true });
    if (pattern.test(candidate)) return true;
    // A directory named as an exclusion covers everything under it, which
    // is how `--ignore=integration` and `"exclude": ["dist"]` are meant.
    return candidate.startsWith(`${glob.replace(/\/$/, "")}/`);
  });
}

/**
 * Every test file a member's task runs, member-relative and sorted. The
 * task's own paths are expanded — a directory the way Deno walks one, a
 * glob the way Deno expands one — and then its `--ignore` globs and the
 * member's `exclude` are applied. An explicit path reaches `deno test`
 * without passing through either, which is why they are applied here
 * rather than left to the command line.
 */
export async function memberTestFiles(
  memberDir: string,
  parsed: Pick<ParsedTestTask, "paths" | "ignores">,
): Promise<string[]> {
  const found: string[] = [];
  // No path at all means the member's own directory, which is what
  // `deno test` with only flags walks.
  const targets = parsed.paths.length > 0 ? parsed.paths : ["."];
  for (const target of targets) {
    const absolute = path.resolve(memberDir, target);
    let directory = false;
    let named = false;
    try {
      const stat = await Deno.stat(absolute);
      directory = stat.isDirectory;
      named = stat.isFile;
    } catch {
      // Not a path in the tree, so it is a glob to expand.
    }
    if (directory) {
      await walkTestFiles(absolute, found);
      continue;
    }
    // A path the task names outright is a file the task runs, whatever
    // it is called. The naming rule is how Deno decides what to run when
    // it discovers files for itself, so it belongs to the walk above and
    // to a glob's matches, not to a file somebody wrote down.
    if (named) {
      found.push(absolute);
      continue;
    }
    for await (
      const entry of expandGlob(target, { root: memberDir, includeDirs: false })
    ) {
      found.push(entry.path);
    }
  }
  const excludes = [...parsed.ignores, ...await memberExcludes(memberDir)];
  const relative = found
    .map((file) => path.relative(memberDir, file))
    .filter((file) => !matchesAny(file, excludes));
  return [...new Set(relative)].sort();
}

/** What a member's manifest says about running its tests. */
export interface MemberTasks {
  /**
   * The Deno-only half a lane can be pointed at, taken apart. Undefined
   * where the member's task is not a shape this can read, in which case
   * the member is one unit that runs whole.
   */
  denoTest?: ParsedTestTask;

  /** The name of the task the Deno-only half comes from. */
  denoTestTask?: string;

  /** Whether the member names a browser half, which runs as one unit. */
  browserTest: boolean;

  /**
   * The paths and globs the browser half's task hands its runner, as the
   * member directory sees them. Empty where the member has no browser half.
   */
  browserPaths: string[];

  /** Whether the member defines any test task at all. */
  present: boolean;

  /**
   * Whether the member has a Deno-only half at all. A member with only a
   * browser half has nothing for a `deno task test` to run, so it is one
   * browser unit and no more.
   */
  denoHalf: boolean;
}

/**
 * The paths a `deno run` of a test runner names after its script, or none
 * for a task of another shape. The browser half's runner takes the files it
 * runs as its arguments, which is what tells its files from those another
 * suite runs.
 */
export function runnerPaths(task: string): string[] {
  if (METACHARACTER.test(task)) return [];
  const words = task.trim().split(/\s+/).map(unquote);
  const command = words.findIndex((word) => !ASSIGNMENT.test(word));
  if (words[command] !== "deno" || words[command + 1] !== "run") return [];
  const script = words.findIndex((word, index) =>
    index > command + 1 && !word.startsWith("-")
  );
  if (script < 0) return [];
  return words.slice(script + 1).filter((word) => !word.startsWith("-"));
}

/** A manifest's tasks, whichever of the two file names carries them. */
async function readTasks(
  memberDir: string,
): Promise<
  Record<string, string | { command?: string; dependencies?: string[] }>
> {
  for (const manifest of ["deno.json", "deno.jsonc"]) {
    let text: string;
    try {
      text = await Deno.readTextFile(path.join(memberDir, manifest));
    } catch {
      continue;
    }
    const config = parseJsonc(text) as {
      tasks?: Record<
        string,
        string | { command?: string; dependencies?: string[] }
      >;
    };
    if (config?.tasks !== undefined) return config.tasks;
  }
  return {};
}

/**
 * The environment a named task sets, from the assignments standing
 * before its command. A task the manifest does not define, and a task
 * setting nothing, both give an empty environment.
 *
 * This reads only the assignments, so it answers for a task whose
 * command {@link parseTestTask} declines — every `integration` task in
 * the workspace names a shell variable in its flags, which is a
 * metacharacter that parser stops at.
 */
export async function taskEnvironment(
  memberDir: string,
  name: string,
): Promise<Record<string, string>> {
  const tasks = await readTasks(memberDir);
  const task = tasks[name];
  const command = typeof task === "string" ? task : task?.command;
  if (command === undefined) return {};
  const env: Record<string, string> = {};
  for (const word of command.trim().split(/\s+/)) {
    const assignment = ASSIGNMENT.exec(word);
    if (assignment === null) break;
    env[assignment[1]!] = unquote(assignment[2]!);
  }
  return env;
}

/**
 * A member's test tasks as the topology needs them.
 *
 * The Deno-only half is `deno-test` where a member names one and `test`
 * otherwise, which is the same rule the per-package coverage gate
 * measures by, and the same task `tasks/run-member-tests.ts` hands a
 * member's appended flags to. A member running several commands names
 * that half, so this and the workspace runner read one task rather than
 * one each. A task written as a dependency list resolves to whichever of
 * its dependencies is a readable `deno test`, which is what a member
 * still writing one keeps its file granularity by.
 */
export async function memberTasks(
  memberDir: string,
  execPath: string = Deno.execPath(),
): Promise<MemberTasks> {
  const tasks = await readTasks(memberDir);
  const commandOf = (name: string): string | undefined => {
    const task = tasks[name];
    if (task === undefined) return undefined;
    return typeof task === "string" ? task : task.command;
  };
  const dependenciesOf = (name: string): string[] => {
    const task = tasks[name];
    return typeof task === "string" ? [] : task?.dependencies ?? [];
  };
  const browserTest = tasks["browser-test"] !== undefined;
  const browserPaths = runnerPaths(commandOf("browser-test") ?? "");
  const half = tasks["deno-test"] !== undefined ? "deno-test" : "test";
  if (tasks[half] === undefined) {
    // A member with only a browser half is still a test surface: it runs
    // whole, as one unit, and its records come from the browser harness.
    return { browserTest, browserPaths, present: browserTest, denoHalf: false };
  }
  const candidates = [half, ...dependenciesOf(half)];
  for (const name of candidates) {
    const command = commandOf(name);
    if (command === undefined) continue;
    const parsed = parseTestTask(command, execPath);
    if (parsed !== undefined) {
      return {
        denoTest: parsed,
        denoTestTask: name,
        browserTest,
        browserPaths,
        present: true,
        denoHalf: true,
      };
    }
  }
  return {
    browserTest,
    browserPaths,
    denoHalf: true,
    present: true,
    // A member whose only test task echoes that it has none is not a
    // test surface, and saying so here keeps it out of the enumeration.
    ...(candidates.some((name) => /deno (test|run)/.test(commandOf(name) ?? ""))
      ? {}
      : { present: false }),
  };
}

/**
 * The globs among `globs` that name none of the test files `paths` reaches
 * in the member at `memberDir`. The member's `exclude` lists apply, and no
 * `--ignore` does, so that a glob naming a file the task leaves out still
 * finds it. A glob that names nothing is a file renamed or removed from
 * under the task that names it.
 */
export async function unmatchedGlobs(
  memberDir: string,
  paths: readonly string[],
  globs: readonly string[],
): Promise<string[]> {
  if (globs.length === 0) return [];
  const files = await memberTestFiles(memberDir, {
    paths: [...paths],
    ignores: [],
  });
  return globs.filter((glob) =>
    !files.some((file) => matchesAny(file, [glob]))
  );
}
