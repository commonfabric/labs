#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import { exists } from "@std/fs";
import * as path from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import {
  COMPILE_FINGERPRINT_INPUTS,
  computeCompilerVersion,
  renderVersionModule,
} from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";
import { CONNECTOR_PATTERN_SOURCES } from "../packages/connectors/pattern-sources.ts";

export interface BuildConfigInitializer {
  root: string;
  toolshedFlags: string[];
  binaries?: readonly BinaryName[];
  cliOnly?: boolean;
}

export const BINARY_NAMES = ["toolshed", "bg-piece-service", "cf"] as const;
export type BinaryName = (typeof BINARY_NAMES)[number];

/**
 * Everything a built binary is made from, as repository-relative files and
 * directories (a directory ends in `/`): the Deno release `mise.toml` pins,
 * which `deno compile` embeds in every binary; this script; the workspace
 * manifest and lockfile; the port table the servers import; and the trees
 * that the entry points' module graphs and every `--include` reach. A CI lane
 * keys the binaries it caches on the tracked contents of these, so a change
 * to any of them builds the binaries afresh and a change to anything else
 * reuses what was built. `BuildConfig.sourcePaths()` lies within them.
 */
export const BINARY_SOURCES = [
  "mise.toml",
  "tasks/build-binaries.ts",
  "deno.jsonc",
  "deno.lock",
  "ports.json",
  "packages/",
  "docs/common/",
] as const;

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
      "packages",
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
    return this.#path("packages", "shell");
  }

  shellOutPath() {
    return this.#path("packages", "shell", "dist");
  }

  toolshedProjectPath() {
    return this.#path("packages", "toolshed");
  }

  toolshedShellFrontendPath() {
    return this.#path("packages", "toolshed", "shell-frontend");
  }

  toolshedShellFrontendPathDev() {
    return this.#path("packages", "toolshed", "shell-frontend-dev");
  }

  toolshedEntryPath() {
    return this.#path("packages", "toolshed", "index.ts");
  }

  bgPieceServiceEntryPath() {
    return this.#path("packages", "background-piece-service", "src", "main.ts");
  }

  bgPieceServiceWorkerPath() {
    return this.#path(
      "packages",
      "background-piece-service",
      "src",
      "worker.ts",
    );
  }

  toolshedEnvPath() {
    return this.#path("packages", "toolshed", "COMPILED");
  }

  cliEnvPath() {
    return this.#path("packages", "cli", "COMPILED");
  }

  staticAssetsPath() {
    return this.#path("packages", "static", "assets");
  }

  patternPaths() {
    return [
      this.#path("packages", "patterns"),
      ...CONNECTOR_PATTERN_SOURCES.map((source) =>
        this.#path(...source.directory.split("/"))
      ),
    ];
  }

  staticTypesPath() {
    return this.#path("packages", "static", "assets", "types");
  }

  docsCommonPath() {
    return this.#path("docs", "common");
  }

  cliEntryPath() {
    return this.#path("packages", "cli", "mod.ts");
  }

  cliMultiUserTestWorkerPath() {
    return this.#path("packages", "cli", "lib", "multi-user-test-worker.ts");
  }

  fusePackagePath() {
    return this.#path("packages", "fuse");
  }

  /**
   * Every path the build reads, as opposed to writes: those its path methods
   * name, and the compiler inputs whose fingerprint `prepareWorkspace()`
   * writes into the binaries. A binary cached under `BINARY_SOURCES` is only
   * as fresh as this list is complete, so each path method of this class is
   * either named here or recorded as an output in `build-binaries.test.ts`.
   */
  sourcePaths(): string[] {
    return [
      this.workspaceManifestPath(),
      this.workspaceLockPath(),
      this.compileCacheVersionPath(),
      this.shellProjectPath(),
      this.toolshedProjectPath(),
      this.toolshedEntryPath(),
      this.bgPieceServiceEntryPath(),
      this.bgPieceServiceWorkerPath(),
      this.staticAssetsPath(),
      ...this.patternPaths(),
      this.staticTypesPath(),
      this.docsCommonPath(),
      this.cliEntryPath(),
      this.cliMultiUserTestWorkerPath(),
      this.fusePackagePath(),
      ...COMPILE_FINGERPRINT_INPUTS.map((input) =>
        this.#path(...input.split("/"))
      ),
    ];
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
  buildShell(config: BuildConfig): Promise<void>;
  prepareWorkspace(config: BuildConfig): Promise<void>;
  buildToolshed(config: BuildConfig): Promise<void>;
  buildBgPieceService(config: BuildConfig): Promise<void>;
  buildCli(config: BuildConfig): Promise<void>;
  revertWorkspace(config: BuildConfig): Promise<void>;
};

export const defaultBuildDependencies: BuildDependencies = {
  ensureDistDir,
  buildShell,
  prepareWorkspace,
  buildToolshed,
  buildBgPieceService,
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

    if (config.builds("toolshed")) await dependencies.buildShell(config);
    await dependencies.prepareWorkspace(config);
    if (config.builds("toolshed")) await dependencies.buildToolshed(config);
    if (config.builds("bg-piece-service")) {
      await dependencies.buildBgPieceService(config);
    }
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

async function buildShell(config: BuildConfig): Promise<void> {
  for (const mode of ["development", "production"]) {
    console.log(`Building shell app in ${mode}...`);
    const task = mode === "production" ? "production" : "build";
    const toolshedShellFrontend = mode === "production"
      ? config.toolshedShellFrontendPath()
      : config.toolshedShellFrontendPathDev();
    const { success } = await new Deno.Command(Deno.execPath(), {
      args: [
        "task",
        task,
      ],
      cwd: config.shellProjectPath(),
      stdout: "inherit",
      stderr: "inherit",
      env: {
        // `clearEnv` remains false, so this child inherits the caller's
        // EXPERIMENTAL_SERVER_EXECUTION value and bakes the same posture as
        // the parent binary build. This is load-bearing for the opposite
        // CI lane's cache-miss path.
        COMMIT_SHA: Deno.env.get("COMMIT_SHA") || mode,
      },
    }).output();
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

async function buildToolshed(config: BuildConfig): Promise<void> {
  console.log("Building toolshed binary...");
  const { success } = await new Deno.Command(Deno.execPath(), {
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
      "--include",
      config.toolshedShellFrontendPath(),
      "--include",
      config.toolshedShellFrontendPathDev(),
      "--include",
      config.toolshedEnvPath(),
      "--include",
      config.staticAssetsPath(),
      ...config.patternPaths().flatMap((patternPath) => [
        "--include",
        patternPath,
      ]),
      ...config.toolshedFlags,
      config.toolshedEntryPath(),
    ],
    cwd: config.toolshedProjectPath(),
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) {
    throw new Error("Failed to build toolshed binary");
  }
  console.log("Toolshed binary built successfully");
}

async function buildBgPieceService(config: BuildConfig): Promise<void> {
  console.log("Building background piece service binary...");
  const { success } = await new Deno.Command(Deno.execPath(), {
    args: [
      ...lockedCompileArgs(config),
      // Run `--no-check` here, as the `--include`'d
      // `es2023.d.ts` file will attempt to be checked
      // as a non-static asset. Checking should be done
      // prior to building.
      "--no-check",
      "--output",
      config.distPath("bg-piece-service"),
      "--include",
      config.bgPieceServiceWorkerPath(),
      "--include",
      config.staticAssetsPath(),
      "-A", // All permissions
      "--unstable-worker-options", // Required by bg-piece-service
      config.bgPieceServiceEntryPath(),
    ],
    cwd: config.root,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) {
    throw new Error("Failed to build background piece service binary");
  }
  console.log("Background piece service binary built successfully");
}

async function buildCli(config: BuildConfig): Promise<void> {
  console.log("Building CLI binary...");
  // Figure out the full list requested by typescript and
  // friends
  // Globs don't work for compile(?)
  const _envs = [
    "API_URL",
    "TSC_WATCHFILE",
    "TSC_NONPOLLING_WATCHER",
    "TSC_WATCHDIRECTORY",
    "TSC_WATCH_POLLINGINTERVAL_LOW",
    "TSC_WATCH_POLLINGINTERVAL_MEDIUM",
    "TSC_WATCH_POLLINGINTERVAL_HIGH",
    "TSC_WATCH_POLLINGCHUNKSIZE_LOW",
    "TSC_WATCH_POLLINGCHUNKSIZE_MEDIUM",
    "TSC_WATCH_POLLINGCHUNKSIZE_HIGH",
    "TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_LOW",
    "TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_MEDIUM",
    "TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_HIGH",
    "NODE_INSPECTOR_IPC",
    "VSCODE_INSPECTOR_OPTIONS",
    "NODE_ENV",
    // sqlite3 library requires these
    "DENO_SQLITE_PATH",
    "DENO_SQLITE_LOCAL",
    "DENO_DIR",
    "HOME",
    "XDG_CACHE_HOME",
  ];
  const { success } = await new Deno.Command(Deno.execPath(), {
    args: [
      ...lockedCompileArgs(config),
      "--output",
      config.distPath("cf"),
      // Run `--no-check` here, as the `--include`'d
      // `es2023.d.ts` file will attempt to be checked
      // as a non-static asset. Checking should be done
      // prior to building.
      "--no-check",
      "--allow-write",
      "--allow-read",
      "--allow-env",
      "--allow-run",
      "--allow-ffi", // for @db/sqlite
      "--allow-net", // for @db/sqlite lazy download
      "--include",
      config.staticTypesPath(),
      "--include",
      config.docsCommonPath(),
      "--include",
      config.fusePackagePath(),
      // Worker module spawned by cf test's multi-user mode — workers are not
      // followed by compile's static analysis, so include it explicitly.
      "--include",
      config.cliMultiUserTestWorkerPath(),
      // Build metadata marker read by packages/cli/lib/build-info.ts.
      "--include",
      config.cliEnvPath(),
      config.cliEntryPath(),
    ],
    cwd: config.root,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) {
    throw new Error("Failed to build CLI binary");
  }
  console.log("CLI binary built successfully");
}

function lockedCompileArgs(config: BuildConfig): string[] {
  // Keep compiled binaries on the same resolved dependency graph as normal
  // install/test flows, even when compile runs from a package cwd.
  return [
    "compile",
    "--lock",
    config.workspaceLockPath(),
    "--frozen=true",
  ];
}

// Some frontend types in the workspace manifest
// must be removed from the compiler options
// that do not work with toolshed.
export async function prepareWorkspace(
  config: BuildConfig,
): Promise<void> {
  const denoJsonPath = config.workspaceManifestPath();

  if (!(await exists(config.workspaceLockPath()))) {
    throw new Error(
      `Cannot build binaries without ${config.workspaceLockPath()}`,
    );
  }

  // Write the current compile-cache version before compiling binaries. The value
  // is computed before `deno.jsonc` changes so it reflects the committed
  // compiler options.
  const compileCacheVersion = await computeCompilerVersion(config.root);
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
  // packages/toolshed/lib/build-info.ts and packages/cli/lib/build-info.ts).
  const buildInfo = {
    commitSha: Deno.env.get("COMMIT_SHA") ?? "",
    builtAt: new Date().toISOString(),
    // The server-execution v2 posture the browser shell BAKES (an esbuild
    // define read from this same environment in packages/shell/felt.config.ts
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
    ],
    binaries: requestedBinaries(args),
  });

  await (options.runBuild ?? runBuildWithSignalCleanup)(config);
}

// Only run the build when invoked directly (`deno task build-binaries`), not
// when imported by tests, which exercise BuildConfig / prepareWorkspace /
// revertWorkspace against a temporary tree.
if (import.meta.main) {
  await runBuildBinaries(Deno.args);
}
