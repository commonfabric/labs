import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { exists, walk } from "@std/fs";
import { fromFileUrl, join, relative, SEPARATOR, toFileUrl } from "@std/path";

import {
  BINARY_NAMES,
  BINARY_SOURCES,
  build,
  BUILD_HOST_VARIABLES,
  BuildConfig,
  type BuildDependencies,
  type BuildSignalApi,
  defaultBuildDependencies,
  installBuildSignalCleanup,
  prepareWorkspace,
  requestedBinaries,
  revertWorkspace,
  runBuildBinaries,
  runBuildWithSignalCleanup,
} from "./build-binaries.ts";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { type Config, ResolvedConfig } from "../packages/felt/interface.ts";
import {
  compileFingerprintGlobs,
  computeCompilerVersion,
  renderVersionModule,
  VERSION_NAMESPACE,
} from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";
import { SOURCE_COMPILE_CACHE_RUNTIME_VERSION } from "../packages/runner/src/compilation-cache/compile-cache-version.ts";

const FAKE_MANIFEST = `{
  // Frontend-only types, stripped for the shipped binary and restored on revert.
  "name": "fake",
  "compilerOptions": { "types": ["./x.d.ts"] }
}
`;

const SOURCE_VERSION_MODULE = renderVersionModule(
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION,
);
const buildBinariesScript = fromFileUrl(
  new URL("./build-binaries.ts", import.meta.url),
);

type BuildSignal = Parameters<BuildSignalApi["addSignalListener"]>[0];
type BuildSignalHandler = Parameters<BuildSignalApi["addSignalListener"]>[1];

class FakeExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function makeFakeSignalApi(): {
  api: BuildSignalApi;
  listeners: Map<BuildSignal, BuildSignalHandler>;
  removed: [BuildSignal, BuildSignalHandler][];
  exitCodes: number[];
} {
  const listeners = new Map<BuildSignal, BuildSignalHandler>();
  const removed: [BuildSignal, BuildSignalHandler][] = [];
  const exitCodes: number[] = [];
  return {
    listeners,
    removed,
    exitCodes,
    api: {
      addSignalListener(signal, handler) {
        listeners.set(signal, handler);
      },
      removeSignalListener(signal, handler) {
        removed.push([signal, handler]);
        if (listeners.get(signal) === handler) {
          listeners.delete(signal);
        }
      },
      exit(code) {
        exitCodes.push(code);
        throw new FakeExit(code);
      },
    },
  };
}

function recordingBuildDependencies(
  calls: string[],
  overrides: Partial<BuildDependencies> = {},
): BuildDependencies {
  const record = (name: string) => (_config: BuildConfig) => {
    calls.push(name);
    return Promise.resolve();
  };
  return {
    ensureDistDir: record("ensureDistDir"),
    buildShell: record("buildShell"),
    prepareWorkspace: record("prepareWorkspace"),
    buildToolshed: record("buildToolshed"),
    buildCli: record("buildCli"),
    revertWorkspace: record("revertWorkspace"),
    ...overrides,
  };
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await Deno.mkdir(filePath.slice(0, filePath.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeTextFile(filePath, contents);
}

async function renderComputedVersionModule(root: string): Promise<string> {
  return renderVersionModule(await computeCompilerVersion(root));
}

/**
 * Build a minimal tree holding the files `build-binaries` reads and writes: a
 * manifest with a frontend-only `compilerOptions.types`, a lockfile, a file
 * under every fingerprint input, the committed version module, the toolshed
 * and cli directories for the COMPILED build markers, and the pattern trees
 * the toolshed embeds.
 *
 * The inputs come from `compileFingerprintGlobs()` rather than being listed
 * here, because a fingerprint input this tree lacks fails every test in this
 * file at the `stat` rather than at what the test is about. The manifest, the
 * lockfile, and the version module are written after the loop, so the two of
 * them that are themselves inputs carry the contents these tests need.
 */
async function makeFakeRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "build-binaries-" });
  for (const glob of compileFingerprintGlobs()) {
    const path = glob.endsWith("/**") ? `${glob.slice(0, -2)}mod.ts` : glob;
    await writeFile(`${root}/${path}`, "export const x = 1;\n");
  }
  await writeFile(`${root}/deno.jsonc`, FAKE_MANIFEST);
  await writeFile(`${root}/deno.lock`, '{"version":"4"}\n');
  await writeFile(
    `${root}/packages/runner/src/compilation-cache/compile-cache-version.ts`,
    SOURCE_VERSION_MODULE,
  );
  await Deno.mkdir(`${root}/packages/toolshed`, { recursive: true });
  await Deno.mkdir(`${root}/packages/cli`, { recursive: true });
  for (
    const tree of new BuildConfig({ root, toolshedFlags: [] }).patternPaths()
  ) {
    await Deno.mkdir(tree, { recursive: true });
  }
  return root;
}

Deno.test("BuildConfig resolves workspace paths against the root", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });

    assertEquals(config.root, root);
    assertEquals(config.binaries, ["cf"]);
    assertEquals(config.cliOnly, true);
    assertEquals(config.workspaceManifestPath(), join(root, "deno.jsonc"));
    assertEquals(config.workspaceLockPath(), join(root, "deno.lock"));
    assertEquals(config.shellProjectPath(), join(root, "packages", "shell"));
    assertEquals(
      config.shellOutPath(),
      join(root, "packages", "shell", "dist"),
    );
    assertEquals(
      config.toolshedProjectPath(),
      join(root, "packages", "toolshed"),
    );
    assertEquals(
      config.toolshedShellFrontendPath(),
      join(root, "packages", "toolshed", "shell-frontend"),
    );
    assertEquals(
      config.toolshedShellFrontendPathDev(),
      join(root, "packages", "toolshed", "shell-frontend-dev"),
    );
    assertEquals(
      config.toolshedEntryPath(),
      join(root, "packages", "toolshed", "index.ts"),
    );
    assertEquals(
      config.toolshedEnvPath(),
      join(root, "packages", "toolshed", "COMPILED"),
    );
    assertEquals(
      config.cliEnvPath(),
      join(root, "packages", "cli", "COMPILED"),
    );
    assertEquals(
      config.staticAssetsPath(),
      join(root, "packages", "static", "assets"),
    );
    assertEquals(config.patternPaths(), [
      join(root, "packages", "patterns"),
      join(root, "packages", "connectors", "agents", "debug-view"),
      join(root, "packages", "connectors", "github", "activity-view"),
    ]);
    assertEquals(
      config.staticTypesPath(),
      join(root, "packages", "static", "assets", "types"),
    );
    assertEquals(config.docsCommonPath(), join(root, "docs", "common"));
    assertEquals(
      config.cliEntryPath(),
      join(root, "packages", "cli", "mod.ts"),
    );
    assertEquals(
      config.cliMultiUserTestWorkerPath(),
      join(root, "packages", "cli", "lib", "multi-user-test-worker.ts"),
    );
    assertEquals(config.fusePackagePath(), join(root, "packages", "fuse"));
    assertEquals(config.distDir(), join(root, "dist"));
    assertEquals(config.distPath("cf"), join(root, "dist", "cf"));
    assertEquals(
      config.compileCacheVersionPath(),
      join(
        root,
        "packages",
        "runner",
        "src",
        "compilation-cache",
        "compile-cache-version.ts",
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the toolshed leaves out the pattern files it never serves", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [] });
    const [patterns, connector] = config.patternPaths();
    const served = [
      join(patterns, "counter", "counter.tsx"),
      join(patterns, "iframe-game", "main.tsx"),
      join(patterns, "iframe-game", "contract.ts"),
      join(patterns, "notebook", "guest.ts"),
      join(connector, "main.tsx"),
    ];
    const unserved = [
      join(patterns, "counter", "counter.test.ts"),
      join(patterns, "counter", "counter.test.tsx"),
      join(patterns, "iframe-game", "guest.ts"),
      join(patterns, "iframe-game", "editor", "guest.tsx"),
      join(patterns, "iframe-game", "interaction.browser.test.ts"),
      join(patterns, "integration", "helpers.ts"),
      join(patterns, "baselines", "counter", "counter.tsx", "a.json"),
      join(connector, "logic.test.ts"),
    ];
    for (const file of [...served, ...unserved]) {
      await writeFile(file, "export {};\n");
    }
    const excluded = config.excludePaths("toolshed");
    const isExcluded = (file: string) =>
      excluded.some((at) => isWithin(at, file));

    assertEquals(unserved.filter((file) => !isExcluded(file)), []);
    assertEquals(served.filter(isExcluded), []);
    assertEquals(config.excludePaths("cf"), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** Whether `at` is `parent` or lies beneath it. */
function isWithin(parent: string, at: string): boolean {
  const path = relative(parent, at);
  return path !== ".." && !path.startsWith(`..${SEPARATOR}`);
}

/** Whether a repository-relative path lies within `BINARY_SOURCES`. */
function withinBinarySources(at: string): boolean {
  return BINARY_SOURCES.some((source) =>
    source.endsWith("/") ? `${at}/`.startsWith(source) : at === source
  );
}

/**
 * The methods of `BuildConfig` that name a path the build does not read: one
 * it writes, or one it tells the compile to leave out. Every other method that
 * names a path under the root names one the build reads.
 */
const UNREAD_PATH_METHODS = new Set([
  "shellOutPath",
  "toolshedShellFrontendPath",
  "toolshedShellFrontendPathDev",
  "toolshedEnvPath",
  "cliEnvPath",
  "distDir",
  "distPath",
  "excludePaths",
]);

/**
 * Returns the paths the method `name` of `config` names when called with each
 * binary name for any parameter it takes, or `undefined` when what it returns
 * is not a path under the root or a list of them.
 */
function pathsNamedBy(
  config: BuildConfig,
  name: string,
): string[] | undefined {
  const method = Reflect.get(config, name) as (arg: string) => unknown;
  const paths = BINARY_NAMES.flatMap((binary) => {
    const value = method.call(config, binary);
    return Array.isArray(value) ? value : [value];
  });
  return paths.length > 0 &&
      paths.every((at) => typeof at === "string" && at.startsWith(config.root))
    ? paths
    : undefined;
}

/** Returns every path that the `UNREAD_PATH_METHODS` of `config` name. */
function unreadPaths(config: BuildConfig): Set<string> {
  return new Set(
    [...UNREAD_PATH_METHODS].flatMap((name) =>
      pathsNamedBy(config, name) ?? []
    ),
  );
}

Deno.test("BuildConfig lists every path it reads among its sources", async () => {
  // A path method is one `pathsNamedBy()` returns paths for. Every path one
  // names is either unread or among `sourcePaths()`.
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [] });
    const accounted = new Set([
      ...config.sourcePaths(),
      ...unreadPaths(config),
    ]);
    const pathMethods = new Map<string, string[]>();
    for (const name of Object.getOwnPropertyNames(BuildConfig.prototype)) {
      if (name === "constructor" || name === "sourcePaths") continue;
      const paths = pathsNamedBy(config, name);
      if (paths) pathMethods.set(name, paths);
    }
    const unsorted = [...pathMethods]
      .filter(([name, paths]) =>
        !UNREAD_PATH_METHODS.has(name) &&
        !paths.every((at) => accounted.has(at))
      )
      .map(([name]) => name);
    assertEquals(unsorted, []);
    assertEquals(
      [...UNREAD_PATH_METHODS].filter((name) => !pathMethods.has(name)),
      [],
    );
    assert(pathMethods.has("docsCommonPath"));
    assert(pathMethods.has("includePaths"));
    assert(!pathMethods.has("manifestOriginal"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("BuildConfig reads nothing outside BINARY_SOURCES", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [] });
    const outside = config.sourcePaths()
      .map((at) => relative(root, at))
      .filter((at) => !withinBinarySources(at));
    assertEquals(outside, []);
    assert(!withinBinarySources("tasks/other.ts"));
    assert(!withinBinarySources("packagesque/mod.ts"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** What `deno info` reports about the module graph reached from its roots. */
interface ModuleGraph {
  /** The module importing each of the roots, which `deno info` starts at. */
  rootModule: string;
  modules: { specifier: string; error?: string }[];
}

/**
 * Returns the npm packages, as `name@version`, whose modules `graph` imports.
 * `deno info` names such a module `npm:/<name>@<version>`, followed by the
 * path of the module within the package when the import names one.
 */
function importedNpmPackages(graph: ModuleGraph): Set<string> {
  return new Set(
    graph.modules.flatMap(({ specifier }) =>
      specifier.match(/^npm:\/((?:@[^/]+\/)?[^/@]+@[^/]+)/)?.[1] ?? []
    ),
  );
}

/**
 * Returns the module graph reached from `roots`, resolved against the
 * lockfile of `repo`, and fails when any module in it does not resolve.
 */
async function moduleGraph(
  repo: string,
  roots: readonly string[],
): Promise<ModuleGraph> {
  const rootModule = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(
      rootModule,
      roots.map((at) => `import ${JSON.stringify(toFileUrl(at).href)};\n`)
        .join(""),
    );
    const { success, stdout, stderr } = await runDenoCommandWithTemporaryLock({
      root: repo,
      args: (lock) => [
        "info",
        "--json",
        "--lock",
        lock,
        "--frozen",
        rootModule,
      ],
    });
    assert(success, new TextDecoder().decode(stderr));
    const info = JSON.parse(new TextDecoder().decode(stdout)) as Omit<
      ModuleGraph,
      "rootModule"
    >;
    assertEquals(info.modules.filter(({ error }) => error !== undefined), []);
    return { ...info, rootModule };
  } finally {
    await Deno.remove(rootModule);
  }
}

/**
 * Script modules, as opposed to declaration files: the modules among a path
 * it embeds whose imports `deno compile` follows.
 */
const FOLLOWED_MODULE = /(?<!\.d)\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Returns the modules `deno compile` follows the imports of when it embeds
 * `at`, leaving out those under any of `excluded`.
 */
async function followedModules(
  at: string,
  excluded: readonly string[],
): Promise<string[]> {
  const found = (await Deno.stat(at)).isDirectory
    ? await Array.fromAsync(
      walk(at, { includeDirs: false }),
      ({ path }) => path,
    )
    : [at];
  return found.filter((module) =>
    FOLLOWED_MODULE.test(module) &&
    !excluded.some((skip) => isWithin(skip, module))
  );
}

Deno.test("each binary's modules and assets stay within BINARY_SOURCES", async () => {
  // `deno compile` follows the imports of each entry point, and of each module
  // in a path the build embeds, wherever they lead, so the paths the build
  // names are not the whole of what it reads. This asks Deno for the graph
  // reached from all of them at once and holds every local module in it to
  // the list. The paths the build writes before it compiles are left out. The
  // shell bundle baked into the toolshed binary is built by the `felt` CLI
  // from the entries, public directory and static directories its
  // configuration names.
  const repo = fromFileUrl(new URL("../", import.meta.url));
  const config = new BuildConfig({ root: repo, toolshedFlags: [] });
  const shell = config.shellProjectPath();
  const shellConfigPath = join(shell, "felt.config.ts");
  const { default: shellConfigInit }: { default: Config } = await import(
    toFileUrl(shellConfigPath).href
  );
  const shellConfig = new ResolvedConfig(shellConfigInit, shell);
  assert(shellConfig.entries.length > 0);
  const outside = new Set<string>();
  for (
    const at of [
      shellConfig.publicDir,
      ...shellConfig.staticDirs.map(({ from }) => from),
    ]
  ) {
    const within = relative(repo, at);
    if (!withinBinarySources(within)) outside.add(within);
  }
  const unread = unreadPaths(config);
  const roots = [
    buildBinariesScript,
    config.toolshedEntryPath(),
    config.cliEntryPath(),
    join(shell, "..", "felt", "cli.ts"),
    shellConfigPath,
    ...shellConfig.entries.map((entry) => entry.in),
  ];
  for (const binary of BINARY_NAMES) {
    for (const at of config.includePaths(binary)) {
      if (unread.has(at)) continue;
      roots.push(...await followedModules(at, config.excludePaths(binary)));
    }
  }
  const { modules, rootModule } = await moduleGraph(repo, roots);
  const reached = new Set(modules.map(({ specifier }) => specifier));
  assertEquals(
    roots.filter((at) => !reached.has(toFileUrl(at).href)),
    [],
  );
  for (const specifier of reached) {
    if (!specifier.startsWith("file:")) continue;
    const at = fromFileUrl(specifier);
    if (at === rootModule) continue;
    const within = relative(repo, at);
    if (!withinBinarySources(within)) outside.add(within);
  }
  assertEquals([...outside].sort(), []);
  assert(
    roots.includes(join(config.patternPaths()[0], "counter", "counter.tsx")),
  );
});

Deno.test("the toolshed's pattern trees reach no npm package of their own", async () => {
  // Every module in a pattern tree the toolshed embeds is a root of its
  // module graph, and `deno compile` embeds each npm package that graph
  // imports, with that package's dependencies. So a pattern-tree module that
  // imports an npm package the rest of the toolshed does not import adds that
  // whole package to the binary.
  const repo = fromFileUrl(new URL("../", import.meta.url));
  const config = new BuildConfig({ root: repo, toolshedFlags: [] });
  const trees = config.patternPaths();
  const unread = unreadPaths(config);
  const server = [config.toolshedEntryPath()];
  const patterns: string[] = [];
  for (const at of config.includePaths("toolshed")) {
    if (unread.has(at)) continue;
    const modules = await followedModules(at, config.excludePaths("toolshed"));
    (trees.includes(at) ? patterns : server).push(...modules);
  }
  assert(patterns.length > 0);
  const serverPackages = importedNpmPackages(await moduleGraph(repo, server));
  assert(serverPackages.size > 0);
  const added = [
    ...importedNpmPackages(await moduleGraph(repo, [...server, ...patterns])),
  ].filter((name) => !serverPackages.has(name));
  assertEquals(added.sort(), []);
});

/**
 * Loads the shell bundle's configuration in a process refused `denied` from
 * the environment, and returns whether it loaded and what it wrote to
 * standard error.
 */
async function loadShellConfig(
  denied: readonly string[],
): Promise<{ success: boolean; stderr: string }> {
  const { success, stderr } = await runDenoCommandWithTemporaryLock({
    root: fromFileUrl(new URL("../", import.meta.url)),
    args: (lock) => [
      "run",
      `--lock=${lock}`,
      "--allow-read",
      "--allow-env",
      `--deny-env=${denied.join(",")}`,
      join("packages", "shell", "felt.config.ts"),
    ],
    env: { NO_COLOR: "1" },
  });
  return { success, stderr: new TextDecoder().decode(stderr) };
}

Deno.test("the shell configuration reads no host variable", async () => {
  // A lane passes the host variables through to a build it caches, and the
  // cache key does not cover them, so one baked into the shell would reach a
  // binary the key does not describe. Deno refuses a read of a denied
  // variable and names it. This sees what the configuration reads while it
  // loads, which is when it computes its defines, and not a read in a
  // function it hands the bundler.
  const loaded = await loadShellConfig(BUILD_HOST_VARIABLES);
  assert(loaded.success, loaded.stderr);
  const denied = await loadShellConfig(["EXPERIMENTAL_SERVER_EXECUTION"]);
  assert(!denied.success);
  assertStringIncludes(
    denied.stderr,
    'Requires env access to "EXPERIMENTAL_SERVER_EXECUTION"',
  );
});

Deno.test("requestedBinaries selects all binaries or named subsets", () => {
  assertEquals(requestedBinaries([]), ["toolshed", "cf"]);
  assertEquals(requestedBinaries(["toolshed"]), ["toolshed"]);
  assertEquals(requestedBinaries(["cf", "toolshed"]), ["toolshed", "cf"]);
  assertEquals(requestedBinaries(["cf", "cf"]), ["cf"]);
  assertEquals(requestedBinaries(["--cli-only"]), ["cf"]);
});

Deno.test("requestedBinaries rejects unknown build targets", () => {
  assertThrows(
    () => requestedBinaries(["unknown"]),
    Error,
    'Unknown binary "unknown". Expected one or more of: toolshed, cf',
  );
  assertThrows(
    () => requestedBinaries(["--cli-only", "toolshed"]),
    Error,
    'Unknown binary "--cli-only"',
  );
});

Deno.test("runBuildBinaries preserves the legacy CLI-only entry point", async () => {
  const root = await makeFakeRepo();
  try {
    const configs: BuildConfig[] = [];
    await runBuildBinaries(["--cli-only"], {
      root,
      runBuild: (config) => {
        configs.push(config);
        return Promise.resolve();
      },
    });

    assertEquals(configs.length, 1);
    assertEquals(configs[0].root, root);
    assertEquals(configs[0].binaries, ["cf"]);
    assertEquals(configs[0].cliOnly, true);
    assertEquals(configs[0].toolshedFlags, [
      "--allow-env",
      "--allow-sys",
      "--allow-read",
      "--allow-ffi",
      "--allow-net",
      "--allow-write",
      "--allow-run",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("BuildConfig selects named binaries and rejects conflicting options", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({
      root,
      toolshedFlags: [],
      binaries: ["toolshed", "cf"],
    });

    assertEquals(config.binaries, ["toolshed", "cf"]);
    assertEquals(config.cliOnly, false);
    assertEquals(config.builds("toolshed"), true);
    assertEquals(config.builds("cf"), true);

    const duplicateCliConfig = new BuildConfig({
      root,
      toolshedFlags: [],
      binaries: ["cf", "cf"],
    });
    assertEquals(duplicateCliConfig.binaries, ["cf"]);
    assertEquals(duplicateCliConfig.cliOnly, true);
    assertEquals(duplicateCliConfig.builds("toolshed"), false);

    assertThrows(
      () => new BuildConfig({ root, toolshedFlags: [], binaries: [] }),
      Error,
      "At least one binary must be selected",
    );
    assertThrows(
      () =>
        new BuildConfig({
          root,
          toolshedFlags: [],
          binaries: ["cf"],
          cliOnly: true,
        }),
      Error,
      "cliOnly and binaries cannot be combined",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("build runs only the steps required by each binary", async () => {
  const root = await makeFakeRepo();
  try {
    const cases = [
      {
        binaries: ["toolshed"] as const,
        expected: [
          "ensureDistDir",
          "buildShell",
          "prepareWorkspace",
          "buildToolshed",
          "revertWorkspace",
        ],
      },
      {
        binaries: ["cf"] as const,
        expected: [
          "ensureDistDir",
          "prepareWorkspace",
          "buildCli",
          "revertWorkspace",
        ],
      },
    ];

    for (const { binaries, expected } of cases) {
      const calls: string[] = [];
      const config = new BuildConfig({ root, toolshedFlags: [], binaries });
      await build(config, recordingBuildDependencies(calls));
      assertEquals(calls, expected);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("build reverts the workspace after a build step fails", async () => {
  const root = await makeFakeRepo();
  try {
    const calls: string[] = [];
    const config = new BuildConfig({
      root,
      toolshedFlags: [],
      binaries: ["toolshed"],
    });
    const dependencies = recordingBuildDependencies(calls, {
      buildShell: () => {
        calls.push("buildShell");
        return Promise.reject(new Error("shell build failed"));
      },
    });

    await assertRejects(
      () => build(config, dependencies),
      Error,
      "shell build failed",
    );
    assertEquals(calls, ["ensureDistDir", "buildShell", "revertWorkspace"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("manifest() returns an independent parsed copy each call", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });

    const a = config.manifest();
    assertEquals(a.name, "fake");
    assertEquals(a.compilerOptions.types, ["./x.d.ts"]);

    // Mutating one copy must not affect the next: each call reparses the
    // original bytes.
    delete a.compilerOptions.types;
    const b = config.manifest();
    assertEquals(b.compilerOptions.types, ["./x.d.ts"]);

    // The original bytes are kept verbatim, comment included.
    assertEquals(config.manifestOriginal(), FAKE_MANIFEST);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("BuildConfig captures the checked-in version module and its path", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    assertEquals(config.compileCacheVersionOriginal(), SOURCE_VERSION_MODULE);
    assertEquals(
      config.compileCacheVersionPath(),
      join(
        root,
        "packages",
        "runner",
        "src",
        "compilation-cache",
        "compile-cache-version.ts",
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("prepareWorkspace writes the fingerprint; revertWorkspace restores the source version", async () => {
  const root = await makeFakeRepo();
  const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
  const versionPath = config.compileCacheVersionPath();
  const compiledPath = join(root, "packages", "toolshed", "COMPILED");
  const cliCompiledPath = join(root, "packages", "cli", "COMPILED");
  const sourceModule = await Deno.readTextFile(versionPath);
  const computedModule = await renderComputedVersionModule(root);
  try {
    await prepareWorkspace(config);

    // The version module holds the compiler-input fingerprint baked into binaries.
    const stamped = await Deno.readTextFile(versionPath);
    assertEquals(stamped, computedModule);
    assertNotEquals(stamped, sourceModule);
    assertStringIncludes(stamped, `${VERSION_NAMESPACE}/`);

    // The frontend-only compiler option is stripped; the build marker is written.
    const prepared = JSON.parse(await Deno.readTextFile(`${root}/deno.jsonc`));
    assertEquals(prepared.compilerOptions.types, undefined);
    assert(await exists(compiledPath), "COMPILED marker should be written");
    assert(
      await exists(cliCompiledPath),
      "cli COMPILED marker should be written",
    );
    assertEquals(
      await Deno.readTextFile(cliCompiledPath),
      await Deno.readTextFile(compiledPath),
    );
    // The marker records the server-execution posture the shell bakes
    // from this environment (unset here → null: the shell follows the
    // first-party default); toolshed surfaces it on /api/meta.
    const marker = JSON.parse(await Deno.readTextFile(compiledPath));
    assertEquals(
      marker.shellServerExecutionDefine,
      Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") ?? null,
    );

    await revertWorkspace(config);

    // The version module, manifest bytes, and build markers are restored.
    assertEquals(await Deno.readTextFile(versionPath), sourceModule);
    assertEquals(await Deno.readTextFile(`${root}/deno.jsonc`), FAKE_MANIFEST);
    assert(!(await exists(compiledPath)), "COMPILED marker should be removed");
    assert(
      !(await exists(cliCompiledPath)),
      "cli COMPILED marker should be removed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("prepareWorkspace refuses to build without a lockfile", async () => {
  const root = await makeFakeRepo();
  try {
    await Deno.remove(`${root}/deno.lock`);
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    await assertRejects(() => prepareWorkspace(config), Error, "deno.lock");
    // The error path leaves the source version module untouched.
    assertEquals(
      await Deno.readTextFile(config.compileCacheVersionPath()),
      config.compileCacheVersionOriginal(),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("signal cleanup restores workspace and exits once", async () => {
  const root = await makeFakeRepo();
  const fakeSignals = makeFakeSignalApi();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    const versionPath = config.compileCacheVersionPath();
    const compiledPath = join(root, "packages", "toolshed", "COMPILED");
    await prepareWorkspace(config);
    assertNotEquals(
      await Deno.readTextFile(versionPath),
      SOURCE_VERSION_MODULE,
    );
    assert(await exists(compiledPath), "COMPILED marker should exist");

    const cleanup = installBuildSignalCleanup(config, fakeSignals.api);
    assert(fakeSignals.listeners.has("SIGINT"));
    assert(fakeSignals.listeners.has("SIGTERM"));

    let thrown: unknown;
    try {
      await fakeSignals.listeners.get("SIGTERM")!();
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof FakeExit);
    assertEquals(thrown.code, 143);
    assertEquals(fakeSignals.exitCodes, [143]);
    assertEquals(await Deno.readTextFile(versionPath), SOURCE_VERSION_MODULE);
    assertEquals(await Deno.readTextFile(`${root}/deno.jsonc`), FAKE_MANIFEST);
    assert(!(await exists(compiledPath)), "COMPILED marker should be removed");

    await fakeSignals.listeners.get("SIGTERM")!();
    assertEquals(fakeSignals.exitCodes, [143]);

    cleanup();
    assertEquals(fakeSignals.listeners.size, 0);
    assertEquals(
      fakeSignals.removed.map(([signal]) => signal).sort(),
      ["SIGINT", "SIGTERM"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runBuildWithSignalCleanup removes listeners after build", async () => {
  const root = await makeFakeRepo();
  const fakeSignals = makeFakeSignalApi();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    const seenConfigs: BuildConfig[] = [];
    await runBuildWithSignalCleanup(config, {
      signalApi: fakeSignals.api,
      build: (received) => {
        seenConfigs.push(received);
        return Promise.resolve();
      },
    });

    assertEquals(seenConfigs, [config]);
    assertEquals(fakeSignals.listeners.size, 0);
    assertEquals(
      fakeSignals.removed.map(([signal]) => signal).sort(),
      ["SIGINT", "SIGTERM"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main build path reverts workspace when command spawn fails", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--deny-run",
        buildBinariesScript,
        "--cli-only",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.success, false);
    assertEquals(
      await Deno.readTextFile(config.compileCacheVersionPath()),
      SOURCE_VERSION_MODULE,
    );
    assertEquals(await Deno.readTextFile(`${root}/deno.jsonc`), FAKE_MANIFEST);
    assert(
      !(await exists(config.toolshedEnvPath())),
      "COMPILED marker should be removed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("each build step throws naming its output when its command fails", async () => {
  // The fake tree holds none of the entry points and no shell task, so every
  // command the steps run fails, and none of them may pass that over.
  const root = await makeFakeRepo();
  try {
    await Deno.mkdir(`${root}/packages/shell`, { recursive: true });
    const config = new BuildConfig({ root, toolshedFlags: [] });
    const {
      buildShell,
      buildToolshed,
      buildCli,
    } = defaultBuildDependencies;
    const steps: [(config: BuildConfig) => Promise<void>, string][] = [
      [buildShell, "Failed to build shell app"],
      [buildToolshed, "Failed to build toolshed binary"],
      [buildCli, "Failed to build CLI binary"],
    ];
    for (const [step, message] of steps) {
      await assertRejects(() => step(config), Error, message);
    }
    for (const binary of ["toolshed", "cf"]) {
      assert(!(await exists(config.distPath(binary))), binary);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
