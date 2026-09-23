import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { exists } from "@std/fs";
import { fromFileUrl, join, relative, toFileUrl } from "@std/path";

import {
  BINARY_SOURCES,
  build,
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
    buildBgPieceService: record("buildBgPieceService"),
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
 * under every fingerprint input, the committed version module, and the
 * toolshed and cli directories for the COMPILED build markers.
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
      config.bgPieceServiceEntryPath(),
      join(root, "packages", "background-piece-service", "src", "main.ts"),
    );
    assertEquals(
      config.bgPieceServiceWorkerPath(),
      join(root, "packages", "background-piece-service", "src", "worker.ts"),
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

/** Whether a repository-relative path lies within `BINARY_SOURCES`. */
function withinBinarySources(at: string): boolean {
  return BINARY_SOURCES.some((source) =>
    source.endsWith("/") ? `${at}/`.startsWith(source) : at === source
  );
}

/**
 * The methods of `BuildConfig` that name a path the build writes. Every other
 * method that names a path under the root names one the build reads.
 */
const OUTPUT_PATH_METHODS = new Set([
  "shellOutPath",
  "toolshedShellFrontendPath",
  "toolshedShellFrontendPathDev",
  "toolshedEnvPath",
  "cliEnvPath",
  "distDir",
  "distPath",
]);

Deno.test("BuildConfig lists every path it reads among its sources", async () => {
  // A method is a path method when what it returns, called with a binary name
  // for any parameter it takes, is a path under the root or a list of them.
  // Every one of those is either an output or among `sourcePaths()`.
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [] });
    const sources = new Set(config.sourcePaths());
    const pathMethods = new Map<string, string[]>();
    for (const name of Object.getOwnPropertyNames(BuildConfig.prototype)) {
      if (name === "constructor" || name === "sourcePaths") continue;
      const method = Reflect.get(config, name) as (arg: string) => unknown;
      const value = method.call(config, "cf");
      const paths = Array.isArray(value) ? value : [value];
      if (
        paths.length > 0 &&
        paths.every((at) => typeof at === "string" && at.startsWith(root))
      ) {
        pathMethods.set(name, paths);
      }
    }
    const unsorted = [...pathMethods]
      .filter(([name, paths]) =>
        !OUTPUT_PATH_METHODS.has(name) && !paths.every((at) => sources.has(at))
      )
      .map(([name]) => name);
    assertEquals(unsorted, []);
    assertEquals(
      [...OUTPUT_PATH_METHODS].filter((name) => !pathMethods.has(name)),
      [],
    );
    assert(pathMethods.has("docsCommonPath"));
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

Deno.test("each binary's modules and assets stay within BINARY_SOURCES", async () => {
  // `deno compile` follows an entry point's imports wherever they lead, so the
  // paths the build names are not the whole of what it reads. This asks Deno
  // for each graph and holds every local module in it to the list. The shell
  // bundle baked into the toolshed binary is built by the `felt` CLI from the
  // entries, public directory and static directories its configuration names.
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
  const entries = [
    buildBinariesScript,
    config.toolshedEntryPath(),
    config.bgPieceServiceEntryPath(),
    config.bgPieceServiceWorkerPath(),
    config.cliEntryPath(),
    config.cliMultiUserTestWorkerPath(),
    join(shell, "..", "felt", "cli.ts"),
    shellConfigPath,
    ...shellConfig.entries.map((entry) => entry.in),
  ];
  for (const entry of entries) {
    const { success, stdout, stderr } = await runDenoCommandWithTemporaryLock({
      root: repo,
      args: (lock) => ["info", "--json", "--lock", lock, "--frozen", entry],
    });
    assert(success, new TextDecoder().decode(stderr));
    const info = JSON.parse(new TextDecoder().decode(stdout)) as {
      modules: { specifier: string }[];
    };
    assert(info.modules.some(({ specifier }) => specifier.startsWith("file:")));
    for (const { specifier } of info.modules) {
      if (!specifier.startsWith("file:")) continue;
      const at = relative(repo, fromFileUrl(specifier));
      if (!withinBinarySources(at)) outside.add(at);
    }
  }
  assertEquals([...outside].sort(), []);
});

Deno.test("requestedBinaries selects all binaries or named subsets", () => {
  assertEquals(requestedBinaries([]), ["toolshed", "bg-piece-service", "cf"]);
  assertEquals(requestedBinaries(["toolshed"]), ["toolshed"]);
  assertEquals(requestedBinaries(["cf", "toolshed"]), ["toolshed", "cf"]);
  assertEquals(requestedBinaries(["cf", "cf"]), ["cf"]);
  assertEquals(requestedBinaries(["--cli-only"]), ["cf"]);
});

Deno.test("requestedBinaries rejects unknown build targets", () => {
  assertThrows(
    () => requestedBinaries(["unknown"]),
    Error,
    'Unknown binary "unknown". Expected one or more of: toolshed, bg-piece-service, cf',
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
    assertEquals(config.builds("bg-piece-service"), false);
    assertEquals(config.builds("cf"), true);

    const duplicateCliConfig = new BuildConfig({
      root,
      toolshedFlags: [],
      binaries: ["cf", "cf"],
    });
    assertEquals(duplicateCliConfig.binaries, ["cf"]);
    assertEquals(duplicateCliConfig.cliOnly, true);

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
        binaries: ["bg-piece-service"] as const,
        expected: [
          "ensureDistDir",
          "prepareWorkspace",
          "buildBgPieceService",
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
      buildBgPieceService,
      buildCli,
    } = defaultBuildDependencies;
    const steps: [(config: BuildConfig) => Promise<void>, string][] = [
      [buildShell, "Failed to build shell app"],
      [buildToolshed, "Failed to build toolshed binary"],
      [buildBgPieceService, "Failed to build background piece service binary"],
      [buildCli, "Failed to build CLI binary"],
    ];
    for (const [step, message] of steps) {
      await assertRejects(() => step(config), Error, message);
    }
    for (const binary of ["toolshed", "bg-piece-service", "cf"]) {
      assert(!(await exists(config.distPath(binary))), binary);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
