/**
 * The repository type check, run per package. Each owning scope's paths are
 * checked as their own `deno check` invocation, timed and recorded as that
 * scope's `typecheck`-kind test, the way cfcheck records each pattern it
 * checks; the invocations run concurrently and any failure fails the whole
 * task. tasks/check.sh owns the Deno version gate and delegates
 * here.
 *
 * Every `deno test` runs under `--no-check`, so the paths listed here are
 * the only type check a test file, and anything it loads, gets; the lanes
 * run this task as the `typecheck` suite. `UNCHECKED_TREES` records what
 * the list leaves out, and why. Removing a path removes the checking this
 * task gives it.
 */

import { expandGlob, walkSync } from "@std/fs";
import { parse as parseJsonc } from "@std/jsonc";
import * as path from "@std/path";
import { FragmentWriter } from "@commonfabric/test-support/records";
import { readWorkspaceMembers } from "./workspace-tests.ts";

// Directory paths (no glob expansion needed).
const DIRS = [
  ".claude/scripts",
  "docs",
  "packages/agent-runner",
  "packages/api",
  "packages/cf-harness",
  "packages/cli",
  "packages/connectors/agents/connector",
  "packages/connectors/agents/debug-view",
  "packages/connectors/agents/host",
  "packages/connectors/github/activity-view",
  "packages/connectors/github/connector",
  "packages/connectors/github/host",
  "packages/content-hash",
  "packages/dashboard",
  "packages/data-model",
  "packages/data-model-schema",
  "packages/deno-web-test",
  "packages/felt",
  "packages/fuse",
  "packages/generated-patterns",
  "packages/home-schemas",
  "packages/html",
  "packages/identity",
  "packages/iframe-sandbox",
  "packages/integration",
  "packages/js-compiler",
  "packages/leb128",
  "packages/lib-shell",
  "packages/llm",
  "packages/memory",
  "packages/navigation",
  "packages/patterns/battleship",
  "packages/patterns/budget-tracker",
  "packages/patterns/contacts",
  "packages/patterns/examples",
  "packages/patterns/gideon-tests",
  "packages/patterns/integration",
  "packages/patterns/notes",
  "packages/patterns/scrabble",
  "packages/patterns/system",
  "packages/patterns/test",
  "packages/patterns/tools",
  "packages/patterns/weekly-calendar",
  "packages/piece",
  "packages/pure-json",
  "packages/runner",
  "packages/runtime-client",
  "packages/schema-generator/src",
  "packages/shell",
  "packages/spec-model",
  "packages/state-inspector",
  "packages/static/scripts",
  "packages/static/test",
  "packages/test-support",
  "packages/toolshed",
  "packages/ts-transformers/lint-plugins",
  "packages/ts-transformers/src",
  "packages/ts-transformers/test/diagnostics",
  "packages/ts-transformers/test/reactive",
  "packages/ui",
  "packages/utils",
  "skills",
  "tasks",
  "tools",
];

// Paths reached by pattern rather than named outright.
const GLOBS = [
  "packages/connectors/*.ts",
  "scripts/*.ts",
  "packages/static/*.ts",
  "packages/patterns/*.ts",
  "packages/patterns/*.tsx",
  // Iframe guests and the contracts they are written against compile as
  // ordinary browser modules, and `isPatternSource()` excludes them for
  // exactly that reason, so this task is what checks them. Their generated
  // pattern wrappers remain under the classic JSX environment owned by
  // `deno task cfcheck`. The depth is open because a guest sits wherever the
  // pattern that hosts it puts it; the `iframe-` prefix is not, because that
  // is the condition under which the exclusion applies. A file of the same
  // name elsewhere is a pattern source cfcheck compiles, and checking it here
  // as well would put one file through two incompatible JSX environments.
  "packages/patterns/iframe-*/**/guest.ts",
  "packages/patterns/iframe-*/**/guest.tsx",
  "packages/patterns/iframe-*/**/contract.ts",
  // The tests of the pattern tree's plain modules. A `.test.ts` runs under
  // `deno test --no-check`, and a `.browser.test.ts` reaches its browser
  // through `deno bundle`, which transpiles rather than type-checks, so this
  // task is the only thing that opens either.
  "packages/patterns/**/*.test.ts",
  // `deno check` takes no exclusion, so a tree holding a `test/fixtures`
  // subtree it must not open is reached by glob rather than as one directory
  // entry: per tree, a pattern for the test files at any depth and another
  // for the helper modules beside them at the top level. A subtree holding no
  // fixtures needs none of that and is named in `DIRS` above, which is where
  // the transformer's `test/diagnostics` and `test/reactive` sit;
  // `UNCHECKED_TREES` records the fixtures these patterns leave behind.
  "packages/ts-transformers/test/*.ts",
  "packages/ts-transformers/test/**/*.test.ts",
  "packages/schema-generator/test/*.ts",
  "packages/schema-generator/test/**/*.test.ts",
];

/** Whether a repository-relative path is a test rather than a source file. */
export function isTestModule(file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(file);
}

/** A tree of modules the checked paths leave out, and why. */
export interface UncheckedTree {
  /** Repository-relative directory no checked path names. */
  readonly tree: string;

  /** Why this task does not type-check it. */
  readonly because: string;

  /**
   * Which of the tree's modules this entry accounts for; all of them when
   * omitted. Two entries dividing one tree each carry one, so that no file
   * is excused by an entry whose reason is untrue of it — the reasons differ
   * where what happens to the files differs.
   */
  readonly matches?: (file: string) => boolean;
}

/**
 * Every tree the checked paths deliberately leave out.
 *
 * A list of what is checked cannot on its own distinguish a tree somebody
 * decided to leave out from one the list forgot: both are simply absent, and
 * the task reports a clean run over either. Recording the decision is what
 * tells them apart, and `typecheck.test.ts` holds the pair to being
 * exhaustive — a file anywhere in the repository that is neither checked nor
 * named by an entry here fails that test, naming the file.
 */
export const UNCHECKED_TREES: readonly UncheckedTree[] = [
  {
    tree: "packages/patterns",
    matches: (file) => !isTestModule(file),
    because:
      "authored patterns compile under the classic-`h` JSX runtime rather " +
      "than the automatic-JSX environment this task uses, and the two " +
      "disagree on some pattern types, so `deno task cfcheck` type-checks " +
      "them instead. `typecheck.test.ts` holds this entry to excusing only " +
      "files the collector in `tasks/pattern-files.ts` hands that gate, so " +
      "a claim that coverage lives elsewhere cannot drift from where it is.",
  },
  {
    tree: "packages/patterns",
    matches: (file) => file.endsWith(".test.tsx"),
    because: "a pattern test: a pattern driven through `action(...)` that " +
      "`cf test` compiles through the runtime harness, as a pattern is " +
      "compiled when it runs, and which fails as a test on a type error. " +
      "That compile is the behavior the test exercises rather than a check " +
      "done on the way to running it. `isPatternSource()` in " +
      "`tasks/pattern-files.ts` turns a file away on the test suffix alone, " +
      "so `deno task cfcheck` walks none of them.",
  },
  {
    tree: "packages/schema-generator/test/fixtures",
    because:
      "the generator's fixture corpus: inputs the tests feed it, and the " +
      "outputs they compare against. These are data for the tests beside " +
      "them rather than modules the repository builds, and the corpus does " +
      "not compile as a unit, because inputs among them name the ambient " +
      "wrappers (Cell, Stream, Writable) the generator supplies rather than " +
      "importing them. Individual files here may well compile alone; what " +
      "earns the exemption is being corpus, not being uncompilable.",
  },
  {
    tree: "packages/ts-transformers/test/fixtures",
    because: "the transformer's fixture corpus, exempt for the reason the " +
      "generator's is: inputs and expected outputs that are data for the " +
      "tests beside them, not modules the repository builds.",
  },
  {
    tree: "packages/static/assets/types",
    because:
      "the declaration bundles handed to the in-memory pattern compiler. " +
      "The set is the ambient environment a pattern compiles against rather " +
      "than modules this repository builds, and it does not compile beside " +
      "the tree it describes, since it redeclares what `packages/html` " +
      "declares.",
  },
];

/**
 * The owning scope of a checked path: the workspace member's name, or the
 * top-level directory of a path no member owns.
 */
export function scopeOfPath(checkPath: string): string {
  const parts = checkPath.split("/");
  if (parts[0] === "packages") {
    // A connector's members sit two levels under `packages/connectors`. A
    // module directly under it belongs to no member, and all such modules
    // share the `connectors` scope.
    if (parts[1] === "connectors" && parts.length >= 4) {
      return parts.slice(1, 4).join("/");
    }
    return parts[1] ?? "repo";
  }
  return parts[0] ?? "repo";
}

/** Every checked path, repository-relative, grouped by owning scope. */
export async function collectPathsByScope(
  root: string = Deno.cwd(),
): Promise<Map<string, string[]>> {
  const paths: string[] = [...DIRS];
  for (const pattern of GLOBS) {
    for await (
      const entry of expandGlob(pattern, { root, includeDirs: false })
    ) {
      const file = path.relative(path.resolve(root), entry.path);
      // A file a directory entry already names is checked through it.
      if (!DIRS.some((dir) => file.startsWith(`${dir}/`))) paths.push(file);
    }
  }
  const byScope = new Map<string, string[]>();
  for (const checkPath of paths.sort()) {
    const scope = scopeOfPath(checkPath);
    const group = byScope.get(scope);
    if (group === undefined) {
      byScope.set(scope, [checkPath]);
    } else {
      group.push(checkPath);
    }
  }
  return byScope;
}

/**
 * The extensions a checked path can put in front of the type checker.
 *
 * JavaScript earns its place here: `deno check` opens a `.js` or `.jsx` file
 * a checked path names, and type-checks the ones carrying `// @ts-check`,
 * which is a diagnostic this repository would want and would otherwise lose
 * in silence. A coverage claim stated over a narrower population than the
 * gate actually reads is the defect `typecheck.test.ts` exists to catch, so
 * the population is every module extension the checker accepts rather than
 * the ones the tree happens to hold today.
 */
export const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** What this task reads from a manifest. */
interface Manifest {
  exclude?: string[];
  compilerOptions?: { types?: string[] };
}

/**
 * The manifest in `directory` under `root`, or nothing where it holds none.
 * `deno.json` wins where both exist, and Deno ignores the other whole.
 */
async function readManifest(
  root: string,
  directory: string,
): Promise<{ file: string; manifest: Manifest } | undefined> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const file = path.join(directory, name);
    const text = await Deno.readTextFile(path.join(root, file))
      .catch(() => undefined);
    if (text === undefined) continue;
    return { file, manifest: parseJsonc(text) as Manifest };
  }
  return undefined;
}

/**
 * The paths a manifest's `exclude` keeps `deno check` from opening.
 *
 * A checked path names a directory, which covers the tree beneath it only as
 * far as the files the checker itself would reach. Deno drops these before it walks, so a module under one is opened by
 * nothing however a path above it reads. Every manifest is consulted rather
 * than the root alone, because a member declares its own and the checker
 * honors it.
 *
 * These are matched against a repository-relative path, so they filter the
 * walk's results rather than steering it: `walk()` takes a `skip`, but it
 * tests the absolute path an entry carries, which an anchored pattern from
 * `globToRegExp` never matches, and the exclusion would quietly stop firing.
 *
 * Only the top-level `exclude` counts. A `fmt`, `lint` or `test` block
 * carries one for its own subcommand, and reading such a block as though it
 * reached the type check would drop files the checker does open — the same
 * defect pointed the other way, and the worse direction, since it shrinks
 * what the gate is held to rather than widening it.
 */
export async function excludedByManifest(
  root: string,
  members: readonly string[],
): Promise<RegExp[]> {
  const patterns: RegExp[] = [];
  for (const directory of ["", ...members]) {
    const read = await readManifest(root, directory);
    for (const pattern of read?.manifest.exclude ?? []) {
      // Deno un-excludes on a bare leading `!` and on nothing else: measured
      // against 2.9.4, `!build/keep.ts` restores that file to the check while
      // `./!build/keep.ts` restores nothing and matches nothing, so the prefix
      // is not stripped before the negation is looked for. `globToRegExp`
      // reads `!` as a literal either way, which for the spelling Deno
      // negates lands on the shrinking side: the entry matches nothing, the
      // broader exclusion goes on firing, and a file the checker opens is
      // counted as excused. Refusing it fails this file instead. Read on the
      // pattern as written, which is what Deno reads.
      if (pattern.startsWith("!")) {
        throw new Error(
          `${
            path.join(directory, "deno.json(c)")
          } un-excludes ${pattern}, which ` +
            `this check cannot read; teach it the negation or the census is ` +
            `short by whatever the entry restores.`,
        );
      }
      const stripped = pattern.replace(/^\.\//, "");
      const scoped = directory === "" ? stripped : `${directory}/${stripped}`;
      patterns.push(
        path.globToRegExp(scoped.endsWith("/") ? `${scoped}**` : scoped, {
          globstar: true,
        }),
      );
    }
  }
  return patterns;
}

/** One module of the graph `deno info --json` prints. */
interface GraphModule {
  specifier: string;
  dependencies?: {
    code?: { specifier?: string };
    type?: { specifier?: string };
  }[];
  typesDependency?: { dependency?: { specifier?: string } };
}

/**
 * The local modules importing each local module, directly, as Deno resolves
 * the imports of `files` and of everything they reach: repository-relative
 * paths on both sides. Remote and `npm:` modules are left unresolved, so the
 * graph is read from the working tree alone, and a module Deno cannot parse
 * contributes no imports of its own.
 */
function localImporters(
  root: string,
  files: readonly string[],
): Map<string, string[]> {
  const base = path.toFileUrl(`${root}/`).href;
  // The graph is read from one module importing every file. It sits outside
  // the tree, so the tree is left as it was, and it names each file by URL,
  // so it resolves nothing itself.
  const entry = Deno.makeTempFileSync({ suffix: ".ts" });
  try {
    Deno.writeTextFileSync(
      entry,
      files.map((file) => `import "${new URL(file, base).href}";\n`).join(""),
    );
    const { success, stdout, stderr } = new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", "--no-remote", "--no-npm", "--no-lock", entry],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (!success) {
      throw new Error(
        `deno info could not read the checked modules' imports:\n` +
          new TextDecoder().decode(stderr),
      );
    }
    const graph: { modules: GraphModule[] } = JSON.parse(
      new TextDecoder().decode(stdout),
    );
    // A query or a fragment names the same file to the type checker.
    const local = (specifier: string | undefined) =>
      specifier?.startsWith(base)
        ? specifier.slice(base.length).replace(/[?#].*$/, "")
        : undefined;
    const importers = new Map<string, string[]>();
    for (const module of graph.modules) {
      const importer = local(module.specifier);
      if (importer === undefined) continue;
      const imported = new Set([
        ...(module.dependencies ?? []).flatMap((dependency) => [
          local(dependency.code?.specifier),
          local(dependency.type?.specifier),
        ]),
        local(module.typesDependency?.dependency?.specifier),
      ]);
      for (const file of imported) {
        if (file === undefined) continue;
        const known = importers.get(file);
        if (known === undefined) importers.set(file, [importer]);
        else known.push(importer);
      }
    }
    return importers;
  } finally {
    Deno.removeSync(entry);
  }
}

/**
 * How a change maps onto the scopes whose check it can alter, for the paths
 * `byScope` holds in the tree at `root`.
 *
 * A scope's check opens the files its paths name and every local module
 * those import, so a change reaches the scope when it touches one of them:
 * the file itself, or any module it imports, directly or through other
 * modules, whatever package that module sits in. A changed path the scope
 * owns reaches it too, module or not, since a manifest the check reads or a
 * module that was deleted alters it as surely as an edit does.
 *
 * A manifest decides how the modules under it resolve, what they export,
 * and which declaration files every check of them loads, so a change to a
 * member's manifest, or to a declaration file it names in
 * `compilerOptions.types`, reaches whatever imports the member's modules as
 * well. The root manifest and the lock file decide that for every module,
 * and reach every scope.
 *
 * The returned function answers from the imports as they stand in the
 * tree; the graph is read, once, the first time it is asked.
 */
export async function scopesReached(
  root: string,
  byScope: ReadonlyMap<string, readonly string[]>,
): Promise<(changed: ReadonlySet<string>) => string[]> {
  const members = (await readWorkspaceMembers(path.join(root, "deno.jsonc")))
    .map((member) => member.replace(/^\.\//, ""));
  const excluded = await excludedByManifest(root, members);
  // Each declaration file a manifest names, against that manifest.
  const ambient = new Map<string, string>();
  for (const directory of ["", ...members]) {
    const read = await readManifest(root, directory);
    for (const types of read?.manifest.compilerOptions?.types ?? []) {
      ambient.set(path.join(directory, types), read!.file);
    }
  }
  const everyScope = [...byScope.keys()].sort();

  let read:
    | { scopeOf: Map<string, string>; importers: Map<string, string[]> }
    | undefined;
  const graph = () => {
    if (read !== undefined) return read;
    const scopeOf = new Map<string, string>();
    for (const [scope, paths] of byScope) {
      for (const checkPath of paths) {
        const absolute = path.join(root, checkPath);
        if (Deno.statSync(absolute).isFile) {
          scopeOf.set(checkPath, scope);
          continue;
        }
        for (
          const entry of walkSync(absolute, {
            includeDirs: false,
            exts: MODULE_EXTENSIONS,
          })
        ) {
          const file = path.relative(root, entry.path);
          if (excluded.some((pattern) => pattern.test(file))) continue;
          scopeOf.set(file, scope);
        }
      }
    }
    read = {
      scopeOf,
      importers: localImporters(root, [...scopeOf.keys(), ...ambient.keys()]),
    };
    return read;
  };

  return (changed) => {
    if (changed.size === 0) return [];
    const { scopeOf, importers } = graph();
    const reached = new Set<string>();
    const seen = new Set<string>();
    const pending = [...changed];
    while (pending.length > 0) {
      const at = pending.pop()!;
      if (seen.has(at)) continue;
      seen.add(at);
      if (["deno.json", "deno.jsonc", "deno.lock"].includes(at)) {
        return everyScope;
      }
      const manifest = /(^|\/)deno\.jsonc?$/.test(at);
      const scope = scopeOf.get(at) ??
        (changed.has(at) || manifest ? scopeOfPath(at) : undefined);
      if (scope !== undefined && byScope.has(scope)) {
        reached.add(scope);
        if (manifest) {
          for (const [file, owner] of scopeOf) {
            if (owner === scope) pending.push(file);
          }
        }
      }
      const naming = ambient.get(at);
      if (naming !== undefined) pending.push(naming);
      for (const importer of importers.get(at) ?? []) pending.push(importer);
    }
    return [...reached].sort();
  };
}

interface GroupResult {
  scope: string;
  durationMs: number;
  success: boolean;
  output: string;
}

/** Runs one scope's `deno check`; a spawn failure is that group's failure. */
export async function checkGroup(
  scope: string,
  paths: string[],
  reload: boolean,
  execPath: string = Deno.execPath(),
  cwd: string = Deno.cwd(),
): Promise<GroupResult> {
  const startedAt = performance.now();
  const args = ["check", ...(reload ? ["--reload"] : []), ...paths];
  let success = false;
  let output = "";
  try {
    // The paths are collected relative to the tree they were found in,
    // so the check runs there. Without this a caller pointing at another
    // tree would collect that tree's paths and check this one's.
    const result = await new Deno.Command(execPath, {
      args,
      cwd,
      env: { DENO_V8_FLAGS: "--max-old-space-size=8192" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    success = result.success;
    output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
  } catch (error) {
    output = String(error);
  }
  return {
    scope,
    durationMs: performance.now() - startedAt,
    success,
    output,
  };
}

export interface TypecheckOptions {
  list?: boolean;
  reload?: boolean;
  check?: typeof checkGroup;

  /** The tree the paths were collected from, and so the tree to check. */
  root?: string;

  /**
   * Spool one typecheck record per scope.
   *
   * The task's entry point sets this: the scopes it collected are the
   * repository's packages. A caller inside another test leaves it unset,
   * because the scopes it hands over are that test's fixtures, and a
   * fixture is data rather than a check of this repository.
   */
  recordResults?: boolean;
}

/**
 * Checks every group over a bounded worker pool, recording each scope's
 * verdict, and returns whether all of them passed.
 */
export async function runTypecheck(
  byScope: ReadonlyMap<string, string[]>,
  options: TypecheckOptions = {},
): Promise<boolean> {
  if (options.list === true) {
    // Prints every checked path with its scope, for auditing what the
    // groups cover.
    for (const [scope, paths] of byScope) {
      for (const checkPath of paths) {
        console.log(`${scope}\t${checkPath}`);
      }
    }
    return true;
  }
  const check = options.check ?? checkGroup;
  const reload = options.reload === true;
  const total = [...byScope.values()].reduce(
    (sum, group) => sum + group.length,
    0,
  );
  if (total === 0) {
    console.error("No files to check?! (Project is in an odd state.)");
    return false;
  }
  if (reload) {
    console.log("Reloading Deno dependencies before checking...");
  }
  console.log(
    `Type checking ${total} paths in ${byScope.size} package groups...`,
  );

  const recordsFragment = options.recordResults === true
    ? FragmentWriter.openForRun()
    : undefined;
  const scopes = [...byScope.keys()];
  const results: GroupResult[] = [];
  let next = 0;
  // Capped: each worker is a deno check with an 8 GB heap ceiling, and a
  // many-core workstation does not want eight of those at once.
  const workerCount = Math.min(
    4,
    Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)),
    scopes.length,
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < scopes.length) {
      const scope = scopes[next++]!;
      const result = await check(
        scope,
        byScope.get(scope)!,
        reload,
        Deno.execPath(),
        options.root ?? Deno.cwd(),
      );
      results.push(result);
      recordsFragment?.append({
        line: "record",
        test: { k: "typecheck", s: scope, n: "deno-check" },
        outcome: result.success ? "pass" : "fail",
        durationMs: Math.round(result.durationMs),
      });
      console.log(
        `${result.success ? "ok" : "FAILED"}  ${scope} ` +
          `(${(result.durationMs / 1000).toFixed(1)}s)`,
      );
    }
  });
  await Promise.all(workers);
  recordsFragment?.close();

  const failed = results.filter((result) => !result.success);
  for (const result of failed) {
    console.error(`\nType errors in ${result.scope}:`);
    console.error(result.output.trimEnd());
  }
  if (failed.length > 0) {
    console.error(
      `\nType check failed in ${failed.length} of ${results.length} groups.`,
    );
    return false;
  }
  console.log("Type check complete.");
  return true;
}

/**
 * The scopes named on the command line, or every scope when none are.
 * A continuous-integration lane is given part of the repository to check
 * and names the groups it was given; a person running the task names
 * none and checks the whole tree.
 */
export function selectScopes(
  byScope: ReadonlyMap<string, string[]>,
  args: readonly string[],
): Map<string, string[]> {
  const named = args
    .filter((arg) => arg.startsWith("--scope="))
    .map((arg) => arg.slice("--scope=".length));
  if (named.length === 0) return new Map(byScope);
  const selected = new Map<string, string[]>();
  for (const scope of named) {
    const paths = byScope.get(scope);
    if (paths === undefined) {
      throw new Error(`no such type-check scope: ${scope}`);
    }
    selected.set(scope, paths);
  }
  return selected;
}

/**
 * Runs the check the way the command line runs it, and answers with the
 * status it would exit with rather than exiting from inside itself.
 */
export async function main(
  args: readonly string[] = Deno.args,
  root: string = Deno.cwd(),
  options: TypecheckOptions = {},
): Promise<number> {
  const passed = await runTypecheck(
    selectScopes(await collectPathsByScope(root), args),
    {
      list: args.includes("--list"),
      reload: (Deno.env.get("DENO_CHECK_RELOAD") ?? "") !== "",
      recordResults: true,
      root,
      ...options,
    },
  );
  return passed ? 0 : 1;
}

// `Deno.exitCode` rather than `Deno.exit`, which would end the process
// before the unload handlers run — and one of those is what writes a
// test run's name map into its spool.
if (import.meta.main) Deno.exitCode = await main();
