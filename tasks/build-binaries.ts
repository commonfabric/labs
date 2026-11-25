#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run --allow-ffi --allow-net=127.0.0.1
import { exists, existsSync, walkSync } from "@std/fs";
import * as path from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import {
  COMPILE_FINGERPRINT_INPUTS,
  compileCacheVersionSourceOf,
  computeCompilerVersion,
  renderVersionModule,
} from "../runtime/runner/src/compilation-cache/compiler-fingerprint.deno.ts";
import { CONNECTOR_PATTERN_SOURCES } from "../connectors/pattern-sources.ts";
import { CF_PERMISSION_FLAGS } from "../runtime/cli/lib/cf-permissions.ts";
import type { TreeSitterGrammar } from "../runtime/cli/lib/view/languages/treesitter/adapter.ts";
import { treeSitterGrammars } from "../runtime/cli/lib/view/languages/treesitter/grammars.ts";
import { BASELINES_DIR, isIframeGuestSource } from "./pattern-files.ts";
import { PACKAGE_ROOTS } from "./package-layout.ts";

export interface BuildConfigInitializer {
  root: string;
  toolshedFlags: string[];
  binaries?: readonly BinaryName[];
  cliOnly?: boolean;

  /** Whether builds use only dependencies already in Deno's cache. */
  cachedOnly?: boolean;

  /**
   * The compile-cache version to bake, computed for the repository root. The
   * default is the compiler-input fingerprint, which costs nothing;
   * `runBuildBinaries` hands a shipped build the output-based version
   * instead (`compile-cache-output-version.deno.ts`), which compiles the
   * corpus.
   */
  compileCacheVersion?: (root: string) => Promise<string>;
}

export const BINARY_NAMES = ["toolshed", "cf"] as const;
export type BinaryName = (typeof BINARY_NAMES)[number];

/**
 * Everything a built binary is made from, as repository-relative files and
 * directories (a directory ends in `/`): the Deno release `mise.toml` pins,
 * which `deno compile` embeds in every binary; this script, the package
 * layout, and the pattern file classification it imports; the workspace
 * manifest and lockfile; the port table the servers import; and the trees
 * that the entry points' module graphs and every `--include` reach. A CI lane
 * keys the binaries it caches on the tracked contents of these, so a change
 * to any of them builds the binaries afresh and a change to anything else
 * reuses what was built. `BuildConfig.sourcePaths()` lies within them.
 */
export const BINARY_SOURCES = [
  "mise.toml",
  "tasks/build-binaries.ts",
  "tasks/package-layout.ts",
  "tasks/pattern-files.ts",
  "deno.jsonc",
  "deno.lock",
  "ports.json",
  ...PACKAGE_ROOTS.map((root) => `${root}/`),
  "docs/common/",
];

/**
 * The environment variables a build needs from the machine it runs on: where
 * to find programs, the home and temporary directories, where Deno keeps its
 * cache, how it reaches the network to fetch dependencies, and whether an
 * earlier dependency installation makes compilation cache-only. None of them
 * reaches a binary, which
 * `build-binaries.test.ts` holds the shell bundle's configuration to. A CI
 * lane building a binary it caches passes these through from its own
 * environment, and nothing else, so every other variable the build reads is
 * one the lane either sets or leaves unset.
 */
export const BUILD_HOST_VARIABLES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "DENO_DIR",
  "XDG_CACHE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "DENO_CERT",
  "DENO_TLS_CA_STORE",
  "DENO_AUTH_TOKENS",
  "NPM_CONFIG_REGISTRY",
  "CF_DENO_DEPENDENCIES_INSTALLED",
] as const;

/**
 * The compile-cache version a shipped build bakes: a hash of what the
 * compiler emits for the corpus (`compile-cache-output-version.deno.ts`).
 * Loaded when a build asks for it: the corpus compile brings the whole
 * runtime with it, and this module is imported by the test topology and by a
 * build that takes the compiler-input fingerprint, neither of which loads a
 * runtime.
 */
export async function computeShippedCompileCacheVersion(
  root: string,
): Promise<string> {
  // deno-lint-ignore cf-imports/no-inline-module-import -- the corpus compile brings the whole runtime with it, which the test topology and an inputs-only build never load
  const { computeCompilerOutputVersion } = await import(
    "../runtime/runner/src/compilation-cache/compile-cache-output-version.deno.ts"
  );
  return await computeCompilerOutputVersion(root);
}

export function requestedBinaries(args: readonly string[]): BinaryName[] {
  if (args.length === 0) return [...BINARY_NAMES];
  if (args.length === 1 && args[0] === "--cli-only") return ["cf"];

  const requested = new Set<BinaryName>();
  for (const arg of args) {
    if (!BINARY_NAMES.includes(arg as BinaryName)) {
      throw new Error(
        `Unknown binary "${arg}". Expected one or more of: ${
          BINARY_NAMES.join(", ")
        }`,
      );
    }
    requested.add(arg as BinaryName);
  }
  return BINARY_NAMES.filter((binary) => requested.has(binary));
}

export class BuildConfig {
  readonly root: string;
  readonly toolshedFlags: string[];
  readonly binaries: readonly BinaryName[];
  readonly cliOnly: boolean;

  /** Whether builds use only dependencies already in Deno's cache. */
  readonly cachedOnly: boolean;

  /** See {@link BuildConfigInitializer.compileCacheVersion}. */
  readonly compileCacheVersion: (root: string) => Promise<string>;

  #manifestOriginal: string;
  #compileCacheVersionOriginal: string;

  constructor(options: BuildConfigInitializer) {
    this.root = options.root;
    this.toolshedFlags = options.toolshedFlags;
    if (options.cliOnly && options.binaries) {
      throw new Error("cliOnly and binaries cannot be combined");
    }
    if (options.binaries?.length === 0) {
      throw new Error("At least one binary must be selected");
    }
    this.binaries = options.cliOnly
      ? ["cf"]
      : requestedBinaries(options.binaries ?? []);
    this.cliOnly = this.binaries.length === 1 && this.binaries[0] === "cf";
    this.cachedOnly = options.cachedOnly ?? false;
    this.compileCacheVersion = options.compileCacheVersion ??
      computeCompilerVersion;
    this.#manifestOriginal = Deno.readTextFileSync(
      this.workspaceManifestPath(),
    );
    this.#compileCacheVersionOriginal = Deno.readTextFileSync(
      this.compileCacheVersionPath(),
    );
  }

  #path(...args: string[]): string {
    return path.join(this.root, ...args);
  }

  /**
   * Returns a fresh, mutable copy of the workspace manifest, parsed from its
   * original bytes. The build mutates this copy; the original bytes stay
   * untouched so the revert can restore the file exactly.
   */
  manifest(): Record<string, any> {
    return parseJsonc(this.#manifestOriginal) as Record<string, any>;
  }

  manifestOriginal() {
    return this.#manifestOriginal;
  }

  compileCacheVersionOriginal() {
    return this.#compileCacheVersionOriginal;
  }

  workspaceManifestPath() {
    return this.#path("deno.jsonc");
  }

  compileCacheVersionPath() {
    return this.#path(
      "runtime",
      "runner",
      "src",
      "compilation-cache",
      "compile-cache-version.ts",
    );
  }

  workspaceLockPath() {
    return this.#path("deno.lock");
  }

  shellProjectPath() {
    return this.#path("runtime", "shell");
  }

  shellOutPath() {
    return this.#path("runtime", "shell", "dist");
  }

  toolshedProjectPath() {
    return this.#path("runtime", "toolshed");
  }

  toolshedShellFrontendPath() {
    return this.#path("runtime", "toolshed", "shell-frontend");
  }

  toolshedShellFrontendPathDev() {
    return this.#path("runtime", "toolshed", "shell-frontend-dev");
  }

  toolshedEntryPath() {
    return this.#path("runtime", "toolshed", "index.ts");
  }

  toolshedServingWorkerPath() {
    return this.#path("runtime", "toolshed", "lib", "serving-worker.ts");
  }

  compileWorkerPath() {
    return this.#path(
      "runtime",
      "runner",
      "src",
      "harness",
      "compile-worker.ts",
    );
  }

  toolshedEnvPath() {
    return this.#path("runtime", "toolshed", "COMPILED");
  }

  cliEnvPath() {
    return this.#path("runtime", "cli", "COMPILED");
  }

  staticAssetsPath() {
    return this.#path("base", "static", "assets");
  }

  patternPaths() {
    return [
      this.#path("patterns"),
      ...CONNECTOR_PATTERN_SOURCES.map((source) =>
        this.#path(...source.directory.split("/"))
      ),
    ];
  }

  staticTypesPath() {
    return this.#path("base", "static", "assets", "types");
  }

  docsCommonPath() {
    return this.#path("docs", "common");
  }

  cliEntryPath() {
    return this.#path("runtime", "cli", "mod.ts");
  }

  cliMultiUserTestWorkerPath() {
    return this.#path("runtime", "cli", "lib", "multi-user-test-worker.ts");
  }

  cliParseWorkerPath() {
    return this.#path("runtime", "cli", "lib", "view", "parseworker.ts");
  }

  cliProgramWorkerPath() {
    return this.#path(
      "runtime",
      "cli",
      "lib",
      "view",
      "languages",
      "typescript",
      "programworker.ts",
    );
  }

  fusePackagePath() {
    return this.#path("runtime", "fuse");
  }

  /**
   * Every path the build reads, as opposed to writes: those its path methods
   * name, and the compiler inputs whose fingerprint a lane's build writes
   * into the binaries. A binary cached under `BINARY_SOURCES` is only
   * as fresh as this list is complete, so every path a path method of this
   * class names is either named here or named by a method that
   * `build-binaries.test.ts` records as naming paths the build does not read.
   */
  sourcePaths(): string[] {
    return [
      this.workspaceManifestPath(),
      this.workspaceLockPath(),
      this.compileCacheVersionPath(),
      this.shellProjectPath(),
      this.toolshedProjectPath(),
      this.toolshedEntryPath(),
      this.toolshedServingWorkerPath(),
      this.compileWorkerPath(),
      this.staticAssetsPath(),
      ...this.patternPaths(),
      this.staticTypesPath(),
      this.docsCommonPath(),
      this.cliEntryPath(),
      this.cliMultiUserTestWorkerPath(),
      this.cliParseWorkerPath(),
      this.cliProgramWorkerPath(),
      this.fusePackagePath(),
      ...COMPILE_FINGERPRINT_INPUTS.map((input) =>
        this.#path(...input.split("/"))
      ),
    ];
  }

  /**
   * Returns the files and directories `deno compile` embeds in `binary`
   * besides its entry point's module graph. The compile also follows the imports of every
   * JavaScript and TypeScript module among them, declaration files aside, so
   * those imports are embedded too.
   */
  includePaths(binary: BinaryName): string[] {
    switch (binary) {
      case "toolshed":
        return [
          this.toolshedShellFrontendPath(),
          this.toolshedShellFrontendPathDev(),
          // The serving loop's worker entry. The compile does not follow a
          // worker's module, so it is named here.
          this.toolshedServingWorkerPath(),
          // The compile worker the serving runtimes compile in, which the
          // compile does not follow either.
          this.compileWorkerPath(),
          this.toolshedEnvPath(),
          this.staticAssetsPath(),
          ...this.patternPaths(),
        ];
      case "cf":
        return [
          this.staticTypesPath(),
          this.docsCommonPath(),
          this.fusePackagePath(),
          // The worker `cf test` spawns in multi-user mode. The compile does
          // not follow a worker's module, so it is named here.
          this.cliMultiUserTestWorkerPath(),
          // The worker `cf view` parses a diff's large files in, which the
          // compile does not follow either.
          this.cliParseWorkerPath(),
          // The worker `cf view` builds its TypeScript program in, which the
          // compile does not follow either.
          this.cliProgramWorkerPath(),
          // The build metadata `runtime/cli/lib/build-info.ts` reads.
          this.cliEnvPath(),
        ];
    }
  }

  /**
   * Returns the paths within `includePaths()` that `deno compile` does not
   * embed in `binary` on their own account. A module among them is still
   * embedded when an embedded module imports it. The toolshed leaves out the
   * files in the pattern trees that it never serves to a runtime: the
   * integration tests with their helpers and fixtures, the recorded
   * compatibility baselines, the Topics board's command-line client, the
   * test support modules, Deno unit tests, and iframe guest sources.
   * Authored `.test.tsx` pattern tests are served because a program can attach
   * them as source roots. Excluding development-only files also keeps their npm
   * dependencies out of the binary.
   */
  excludePaths(binary: BinaryName): string[] {
    if (binary !== "toolshed") return [];
    const directories = [
      this.#path("patterns", "integration"),
      this.#path("patterns", "apps", "topics", "tools"),
      this.#path("patterns", "tools", "test-support"),
      this.#path(...BASELINES_DIR.split("/")),
    ];
    const files = this.patternPaths().flatMap((tree) =>
      Array.from(
        walkSync(tree, { includeDirs: false }),
        (entry) => entry.path,
      ).filter((file) =>
        (/\.test\.ts$/.test(file) || isIframeGuestSource(file, tree)) &&
        !directories.some((directory) =>
          file.startsWith(`${directory}${path.SEPARATOR}`)
        )
      )
    );
    return [...directories, ...files.sort()];
  }

  distDir() {
    return this.#path("dist");
  }

  distPath(binary: string) {
    return this.#path("dist", binary);
  }

  builds(binary: BinaryName): boolean {
    return this.binaries.includes(binary);
  }
}

export type BuildDependencies = {
  ensureDistDir(config: BuildConfig): Promise<void>;
  buildShell(config: BuildConfig, compileCacheVersion: string): Promise<void>;
  prepareWorkspace(
    config: BuildConfig,
    compileCacheVersion: string,
  ): Promise<void>;
  buildToolshed(config: BuildConfig): Promise<void>;
  buildCli(config: BuildConfig): Promise<void>;
  revertWorkspace(config: BuildConfig): Promise<void>;
};

export const defaultBuildDependencies: BuildDependencies = {
  ensureDistDir,
  buildShell,
  prepareWorkspace,
  buildToolshed,
  buildCli,
  revertWorkspace,
};

export async function build(
  config: BuildConfig,
  dependencies: BuildDependencies = defaultBuildDependencies,
): Promise<void> {
  let buildError: Error | void;
  try {
    // Ensure dist directory exists
    await dependencies.ensureDistDir(config);

    // The compile-cache version the binary and its shell both bake, computed
    // once: before the shell build, and before `prepareWorkspace()` rewrites
    // `deno.jsonc`, which is a compiler input.
    const compileCacheVersion = await config.compileCacheVersion(config.root);
    if (config.builds("toolshed")) {
      await dependencies.buildShell(config, compileCacheVersion);
    }
    await dependencies.prepareWorkspace(config, compileCacheVersion);
    if (config.builds("toolshed")) await dependencies.buildToolshed(config);
    if (config.builds("cf")) await dependencies.buildCli(config);
  } catch (e: unknown) {
    buildError = e as Error;
  }
  await dependencies.revertWorkspace(config);
  // @ts-ignore This is used after being assigned.
  if (buildError) {
    throw buildError;
  }
}

async function ensureDistDir(config: BuildConfig): Promise<void> {
  const distDir = config.distDir();
  if (!(await exists(distDir))) {
    await Deno.mkdir(distDir, { recursive: true });
  }
}

/** Runs a command to its end, and returns whether it succeeded. */
export type RunCommand = (
  command: string,
  options: Deno.CommandOptions,
) => Promise<{ success: boolean }>;

/** The {@link RunCommand} that runs the command in a process of its own. */
const runCommand: RunCommand = (command, options) =>
  new Deno.Command(command, options).output();

export async function buildShell(
  config: BuildConfig,
  compileCacheVersion: string,
  run: RunCommand = runCommand,
): Promise<void> {
  for (const mode of ["development", "production"]) {
    console.log(`Building shell app in ${mode}...`);
    const task = mode === "production" ? "production" : "build";
    const toolshedShellFrontend = mode === "production"
      ? config.toolshedShellFrontendPath()
      : config.toolshedShellFrontendPathDev();
    const { success } = await run(Deno.execPath(), {
      args: [
        "task",
        task,
      ],
      cwd: config.shellProjectPath(),
      // The shell's configuration reads what it bakes in from the
      // environment this build inherited: the same `COMMIT_SHA` and
      // `EXPERIMENTAL_SERVER_EXECUTION` that `prepareWorkspace()` writes into
      // the markers, each unset where the caller left it unset. The
      // compile-cache version is the one exception: the binary and its shell
      // name one compiler, so the shell takes the version this build bakes.
      env: { CF_COMPILE_CACHE_RUNTIME_VERSION: compileCacheVersion },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (!success) {
      throw new Error("Failed to build shell app");
    }

    // Shell now serves at root path
    console.log(`Shell app ${mode} built for root path`);

    const shellOut = config.shellOutPath();
    if ((await exists(toolshedShellFrontend))) {
      await Deno.remove(toolshedShellFrontend, { recursive: true });
    }
    await Deno.rename(shellOut, toolshedShellFrontend);
  }
  console.log("Shell app built successfully");
}

export async function buildToolshed(
  config: BuildConfig,
  run: RunCommand = runCommand,
): Promise<void> {
  console.log("Building toolshed binary...");
  const { success } = await run(Deno.execPath(), {
    env: {
      OTEL_DENO: "true",
    },
    args: [
      ...lockedCompileArgs(config),
      // Run `--no-check` here, as the `--include`'d
      // `es2023.d.ts` file will attempt to be checked
      // as a non-static asset. Checking should be done
      // prior to building.
      "--no-check",
      "--unstable-otel",
      "--output",
      config.distPath("toolshed"),
      ...embedArgs(config, "toolshed"),
      ...config.toolshedFlags,
      config.toolshedEntryPath(),
    ],
    cwd: config.toolshedProjectPath(),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!success) {
    throw new Error("Failed to build toolshed binary");
  }
  console.log("Toolshed binary built successfully");
}

export async function buildCli(
  config: BuildConfig,
  run: RunCommand = runCommand,
): Promise<void> {
  console.log("Building CLI binary...");
  const { success } = await run(Deno.execPath(), {
    args: [
      ...lockedCompileArgs(config),
      "--output",
      config.distPath("cf"),
      // Run `--no-check` here, as the `--include`'d
      // `es2023.d.ts` file will attempt to be checked
      // as a non-static asset. Checking should be done
      // prior to building.
      "--no-check",
      ...CF_PERMISSION_FLAGS,
      // The main thread's heap limit, 16 GiB, the same as the toolshed's:
      // under V8's default of about 4 GB, `cf piece survey` and
      // `cf piece retarget` over Estuary's Topics board of about 3,600
      // topics ran out of heap within a minute, and the move peaked at about
      // 10.4 GB (2026-11-24). A compiled binary reads no V8 flags when it
      // starts, `DENO_V8_FLAGS` included, so this is the limit every
      // installed `cf` runs with.
      "--v8-flags=--max-old-space-size=16384",
      ...embedArgs(config, "cf"),
      config.cliEntryPath(),
    ],
    cwd: config.root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!success) {
    throw new Error("Failed to build CLI binary");
  }
  console.log("CLI binary built successfully");
}

/**
 * Helper for the compile steps, which turns what `binary` embeds besides its
 * entry point's module graph into `deno compile` flags.
 */
export function embedArgs(config: BuildConfig, binary: BinaryName): string[] {
  return [
    ...config.includePaths(binary).flatMap((at) => ["--include", at]),
    ...[
      ...config.excludePaths(binary),
      ...(binary === "cf" ? unusedGrammarDirectories() : []),
    ].flatMap((at) => ["--exclude", at]),
  ];
}

/**
 * Returns the directories in each Tree-sitter grammar package that the pager
 * never reads, which the `cf` binary leaves out: every directory in the
 * package but the one holding its compiled parser, such as generated C source
 * and native builds. The packages are in Deno's npm cache rather than in the
 * repository. `grammars` are the grammars the pager loads. Each directory is
 * listed once, though grammars may share a package.
 */
export function unusedGrammarDirectories(
  grammars: readonly Pick<TreeSitterGrammar, "id" | "wasmUrl">[] =
    treeSitterGrammars,
): string[] {
  return [
    ...new Set(grammars.flatMap((grammar) => {
      const parser = path.fromFileUrl(grammar.wasmUrl());
      let root = path.dirname(parser);
      while (!existsSync(path.join(root, "package.json"))) {
        if (path.dirname(root) === root) {
          throw new Error(
            `No package holds the ${grammar.id} grammar ${parser}`,
          );
        }
        root = path.dirname(root);
      }
      const kept = path.relative(root, parser).split(path.SEPARATOR)[0];
      return Array.from(Deno.readDirSync(root))
        .filter((entry) => entry.isDirectory && entry.name !== kept)
        .map((entry) => path.join(root, entry.name))
        .sort();
    })),
  ];
}

/** Returns the dependency-resolution arguments shared by every binary build. */
export function lockedCompileArgs(config: BuildConfig): string[] {
  // Keep compiled binaries on the same resolved dependency graph as normal
  // install/test flows, even when compile runs from a package cwd.
  return [
    "compile",
    "--lock",
    config.workspaceLockPath(),
    "--frozen=true",
    ...(config.cachedOnly ? ["--cached-only"] : []),
    // Embed only the npm packages the binary's module graph reaches, rather
    // than every npm package in the lockfile. A package that a binary loads
    // only through a specifier the compile cannot read statically must be
    // named with `--include npm:<package>`.
    "--exclude-unused-npm",
  ];
}

// Some frontend types in the workspace manifest
// must be removed from the compiler options
// that do not work with toolshed.
export async function prepareWorkspace(
  config: BuildConfig,
  compileCacheVersion: string,
): Promise<void> {
  const denoJsonPath = config.workspaceManifestPath();

  if (!(await exists(config.workspaceLockPath()))) {
    throw new Error(
      `Cannot build binaries without ${config.workspaceLockPath()}`,
    );
  }

  // Write the compile-cache version before compiling binaries: the one the
  // build computed before `deno.jsonc` changed, and the shell build baked.
  await Deno.writeTextFile(
    config.compileCacheVersionPath(),
    renderVersionModule(compileCacheVersion),
  );

  // Remove `compilerOptions.types`
  const manifest = config.manifest();
  delete manifest.compilerOptions.types;
  await Deno.writeTextFile(
    denoJsonPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  // Write build metadata into the COMPILED files. Included via `--include`
  // when the toolshed and cf binaries are compiled, so the values travel with
  // each artifact and can be read at runtime (see
  // runtime/toolshed/lib/build-info.ts and runtime/cli/lib/build-info.ts).
  const buildInfo = {
    commitSha: Deno.env.get("COMMIT_SHA") ?? "",
    builtAt: new Date().toISOString(),
    // The server-execution v2 posture the browser shell BAKES (an esbuild
    // define read from this same environment in runtime/shell/felt.config.ts
    // when buildShell runs below): the raw `EXPERIMENTAL_SERVER_EXECUTION`
    // value, or null when unset — the shell then follows the first-party
    // default. Surfaced on toolshed's /api/meta as
    // `shellServerExecutionDefine` so CI's posture probes can verify the
    // binary they run: the opposite lanes require an explicitly built shell,
    // and the default lanes require the define unset
    // (docs/specs/server-side-execution/testing.md §2; the shell define is
    // baked, so a lane on the wrong binary would silently be a mixed
    // posture). Written to both markers because
    // they are one file written twice; only the toolshed embeds the shell.
    shellServerExecutionDefine: Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") ??
      null,
  };
  const serialized = JSON.stringify(buildInfo, null, 2) + "\n";
  await Deno.writeTextFile(config.toolshedEnvPath(), serialized);
  await Deno.writeTextFile(config.cliEnvPath(), serialized);
}

export async function revertWorkspace(config: BuildConfig): Promise<void> {
  const denoJsonPath = config.workspaceManifestPath();
  const toolshedEnvPath = config.toolshedEnvPath();

  // Restore the workspace manifest from its original bytes, keeping any
  // comments and formatting intact.
  await Deno.writeTextFile(denoJsonPath, config.manifestOriginal());

  // Restore the checked-in compile-cache version module.
  await Deno.writeTextFile(
    config.compileCacheVersionPath(),
    config.compileCacheVersionOriginal(),
  );

  // Remove the COMPILED env files
  for (const path of [toolshedEnvPath, config.cliEnvPath()]) {
    if ((await exists(path))) {
      await Deno.remove(path);
    }
  }
}

export interface BuildSignalApi {
  addSignalListener(
    signal: "SIGINT" | "SIGTERM",
    handler: () => void,
  ): void;
  removeSignalListener(
    signal: "SIGINT" | "SIGTERM",
    handler: () => void,
  ): void;
  exit(code: number): void;
}

export function installBuildSignalCleanup(
  config: BuildConfig,
  signalApi: BuildSignalApi = Deno,
): () => void {
  let exiting = false;
  const onSignal = (exitCode: number) => async () => {
    if (exiting) return;
    exiting = true;
    try {
      await revertWorkspace(config);
    } finally {
      signalApi.exit(exitCode);
    }
  };
  const onSigint = onSignal(130);
  const onSigterm = onSignal(143);
  signalApi.addSignalListener("SIGINT", onSigint);
  signalApi.addSignalListener("SIGTERM", onSigterm);
  return () => {
    signalApi.removeSignalListener("SIGINT", onSigint);
    signalApi.removeSignalListener("SIGTERM", onSigterm);
  };
}

export async function runBuildWithSignalCleanup(
  config: BuildConfig,
  options: {
    build?: (config: BuildConfig) => Promise<void>;
    signalApi?: BuildSignalApi;
  } = {},
): Promise<void> {
  const cleanup = installBuildSignalCleanup(config, options.signalApi);
  try {
    await (options.build ?? build)(config);
  } finally {
    cleanup();
  }
}

export interface RunBuildBinariesOptions {
  root?: string;
  runBuild?: (config: BuildConfig) => Promise<void>;
}

export async function runBuildBinaries(
  args: readonly string[],
  options: RunBuildBinariesOptions = {},
): Promise<void> {
  const config = new BuildConfig({
    root: options.root ?? Deno.cwd(),
    toolshedFlags: [
      "--allow-env",
      "--allow-sys",
      "--allow-read",
      "--allow-ffi",
      "--allow-net",
      "--allow-write",
      // --background re-runs this binary as a detached server child, so the
      // compiled binary needs permission to spawn itself.
      "--allow-run",
      // The main thread's heap limit, 16 GiB, the same as the toolshed's
      // `dev` and `production` tasks and `start-local-dev.sh` give it: under
      // V8's default of about 4 GB, a toolshed's memory server outgrew it on
      // Estuary (2026-11-16, toolshed 8020). V8 takes the flag over the limit
      // each serving worker is started with, so the pool holds each worker to
      // `SERVER_EXECUTION_WORKER_HEAP_LIMIT_MB` from its heartbeats instead.
      // A compiled binary reads no V8 flags when it starts, so this is the
      // limit every deployment runs with.
      //
      // The other two let `perf` on the host name the JavaScript a thread
      // runs, serving workers' threads included: V8 writes the name and
      // address of each compiled function to `/tmp/perf-<pid>.map`, and
      // gives interpreted frames a native frame of their own. A stalled
      // worker answers nothing, so sampling it from outside is the only way
      // to see what it runs (2026-11-14, toolshed 8020 on Estuary). The map
      // grows with each function compiled and is never trimmed; these come
      // off once that investigation is done.
      //
      // `--perf-basic-prof-only-functions` also switches on V8's event log,
      // which V8 otherwise writes to an `isolate-<address>-<pid>-v8.log` file
      // in the working directory for each isolate. `--no-logfile-per-isolate`
      // and `--logfile=+` give each isolate's log an unnamed temporary file
      // instead, which the system frees when that isolate ends.
      "--v8-flags=--max-old-space-size=16384,--perf-basic-prof-only-functions,--interpreted-frames-native-stack,--no-logfile-per-isolate,--logfile=+",
    ],
    binaries: requestedBinaries(args),
    cachedOnly: Deno.env.get("CF_DENO_DEPENDENCIES_INSTALLED") === "1",
    // A build from here ships, so it names its compiler by what it emits.
    // `CF_COMPILE_CACHE_VERSION=inputs` takes the compiler-input fingerprint
    // instead, for a binary that is a test fixture rather than a release.
    compileCacheVersion: compileCacheVersionSourceOf(
        Deno.env.get("CF_COMPILE_CACHE_VERSION"),
        "output",
      ) === "inputs"
      ? computeCompilerVersion
      : computeShippedCompileCacheVersion,
  });

  await (options.runBuild ?? runBuildWithSignalCleanup)(config);
}

// Only run the build when invoked directly (`deno task build-binaries`), not
// when imported by tests, which exercise BuildConfig / prepareWorkspace /
// revertWorkspace against a temporary tree.
if (import.meta.main) {
  await runBuildBinaries(Deno.args);
}
