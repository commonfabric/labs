import * as path from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import ts from "typescript";
import { Manifest } from "./manifest.ts";
import { Summary, TestFileResults } from "./interface.ts";

export const tsToJs = (path: string): string => path.replace(/\.ts$/, ".js");

const BUNDLE_RETRY_ATTEMPTS = 5;
export const BUNDLE_RETRYABLE_ESBUILD_COPY = "failed to copy esbuild binary";
export const BUNDLE_RETRYABLE_ETXTBSY = "Text file busy (os error 26)";

// Given a `Manifest`, moves harness code and bundled
// tests to the manifest's `serverDir`.
export const buildTestDir = async (manifest: Manifest) => {
  // Bundle all tests and move to server root.
  for (const testPath of manifest.tests) {
    const input = path.join(manifest.projectDir, testPath);
    const output = path.join(
      manifest.serverDir,
      "dist",
      tsToJs(testPath),
    );
    await bundleModule(manifest, testPath, input, output);
  }

  // Bundle all extra modules and move to server root.
  for (
    const [filepath, outpath] of Object.entries(manifest.config.bundle ?? {})
  ) {
    const input = path.join(manifest.projectDir, filepath);
    const output = path.join(
      manifest.serverDir,
      outpath,
    );
    await bundleModule(manifest, filepath, input, output);
  }

  // Copy all extra includes to server root.
  for (
    const [filepath, outpath] of Object.entries(manifest.config.include ?? {})
  ) {
    const input = path.join(manifest.projectDir, filepath);
    const output = path.join(
      manifest.serverDir,
      outpath,
    );
    await copy(input, output);
  }

  // Deploy harness files to server root.
  if (!import.meta.dirname) {
    throw new Error("Cannot resolve local dirname");
  }
  const harnessDir = path.join(import.meta.dirname, "harness");
  for await (const { name } of Deno.readDir(harnessDir)) {
    await Deno.copyFile(
      path.join(harnessDir, name),
      path.join(manifest.serverDir, name),
    );
  }
};

export function summarize(results: TestFileResults[]): Summary {
  let passed = 0;
  let duration = 0;
  const failed = [];
  for (const fileResults of results) {
    for (const result of fileResults.tests) {
      duration += result.duration;
      if (result.error) {
        failed.push(result);
      } else {
        passed++;
      }
    }
  }
  return { passed, duration, failed };
}

async function bundleModule(
  manifest: Manifest,
  sourcePath: string,
  input: string,
  output: string,
): Promise<void> {
  const args = [
    "bundle",
    "--quiet",
    "--unstable-raw-imports",
    "--platform=browser",
    "--output",
    output,
  ];

  const configPath = await resolveBundleConfigPath(manifest);
  if (configPath) {
    args.push("--config", configPath);
  }

  for (const specifier of manifest.config.esbuildConfig?.external ?? []) {
    args.push("--external", specifier);
  }

  args.push(input);

  await runBundleWithRetry(
    () =>
      new Deno.Command(Deno.execPath(), {
        args,
        cwd: manifest.projectDir,
        stdout: "piped",
        stderr: "piped",
      }).output(),
    () => downlevelBundleIfNeeded(output, manifest),
    sourcePath,
  );
}

// Runs `runBundle` until it succeeds, retrying on the transient esbuild
// helper-copy / ETXTBSY races that Deno hits while bundling in CI. On success
// `onSuccess` runs once; a non-retryable failure or the last attempt throws.
export async function runBundleWithRetry(
  runBundle: () => Promise<{ success: boolean; stderr: Uint8Array }>,
  onSuccess: () => Promise<void>,
  describeTarget: string,
): Promise<void> {
  const decoder = new TextDecoder();
  for (let attempt = 1; attempt <= BUNDLE_RETRY_ATTEMPTS; attempt++) {
    const result = await runBundle();
    if (result.success) {
      await onSuccess();
      return;
    }

    const stderr = decoder.decode(result.stderr);
    if (
      attempt === BUNDLE_RETRY_ATTEMPTS || !isRetryableBundleFailure(stderr)
    ) {
      throw new Error(`Failed to bundle ${describeTarget}: ${stderr}`);
    }

    // Deno can race while copying the esbuild helper binary in CI.
    await sleepForRetry(attempt);
  }
}

async function resolveBundleConfigPath(
  manifest: Manifest,
): Promise<string | undefined> {
  const packageConfigPath = await findDenoConfigPath(manifest.projectDir);
  const workspaceConfigPath = await findWorkspaceConfigPath(
    manifest.projectDir,
  );
  const packageConfig = await readConfigIfExists(packageConfigPath);
  const workspaceConfig = workspaceConfigPath
    ? await readConfigIfExists(workspaceConfigPath)
    : undefined;
  const workspacePackageImports = workspaceConfigPath && workspaceConfig
    ? await resolveWorkspacePackageImports(workspaceConfigPath, workspaceConfig)
    : {};

  const tsconfigRaw = manifest.config.esbuildConfig?.tsconfigRaw;
  const compilerOptions = typeof tsconfigRaw === "string"
    ? undefined
    : tsconfigRaw?.compilerOptions;
  const imports = {
    ...toStringRecord(workspaceConfig?.imports),
    ...workspacePackageImports,
    ...toStringRecord(packageConfig?.imports),
  };

  const bundleConfigPath = path.join(
    manifest.serverDir,
    "deno-web-test.bundle.json",
  );
  await Deno.writeTextFile(
    bundleConfigPath,
    JSON.stringify({
      imports: Object.keys(imports).length === 0 ? undefined : imports,
      compilerOptions: {
        ...toUnknownRecord(workspaceConfig?.compilerOptions),
        ...toUnknownRecord(packageConfig?.compilerOptions),
        ...toUnknownRecord(compilerOptions),
      },
    }),
  );
  return bundleConfigPath;
}

async function downlevelBundleIfNeeded(
  outputPath: string,
  manifest: Manifest,
): Promise<void> {
  const supported = manifest.config.esbuildConfig?.supported;
  if (!supported || supported.using !== false) {
    return;
  }

  const bundledSource = await Deno.readTextFile(outputPath);
  const transformed = ts.transpileModule(bundledSource, {
    compilerOptions: {
      allowJs: true,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  await Deno.writeTextFile(outputPath, transformed.outputText);
}

export async function resolveWorkspacePackageImports(
  workspaceConfigPath: string,
  workspaceConfig: Record<string, unknown>,
): Promise<Record<string, string>> {
  const workspaceEntries = Array.isArray(workspaceConfig.workspace)
    ? workspaceConfig.workspace
    : [];
  const workspaceRoot = path.dirname(workspaceConfigPath);
  const imports: Record<string, string> = {};

  for (const entry of workspaceEntries) {
    if (typeof entry !== "string") {
      continue;
    }

    const packageDir = path.resolve(workspaceRoot, entry);
    const packageConfig = await readConfigIfExists(
      await findDenoConfigPath(packageDir),
    );
    if (!packageConfig) {
      continue;
    }

    const packageName = typeof packageConfig.name === "string"
      ? packageConfig.name
      : undefined;
    Object.assign(imports, toStringRecord(packageConfig.imports));

    if (!packageName) {
      continue;
    }

    const exports = packageConfig.exports;
    if (typeof exports === "string") {
      imports[packageName] = path.toFileUrl(path.join(packageDir, exports))
        .toString();
      continue;
    }

    if (!exports || typeof exports !== "object") {
      continue;
    }

    for (const [specifier, target] of Object.entries(exports)) {
      if (typeof target !== "string") {
        continue;
      }
      const importKey = specifier === "."
        ? packageName
        : `${packageName}${specifier.slice(1)}`;
      imports[importKey] = path.toFileUrl(path.join(packageDir, target))
        .toString();
    }
  }

  return imports;
}

export async function sleepForRetry(attempt: number): Promise<void> {
  const delayMs = 250 * 2 ** (attempt - 1);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function isRetryableBundleFailure(stderr: string): boolean {
  return stderr.includes(BUNDLE_RETRYABLE_ETXTBSY) ||
    stderr.includes(BUNDLE_RETRYABLE_ESBUILD_COPY);
}

async function findWorkspaceConfigPath(
  startDir: string,
): Promise<string | undefined> {
  let currentDir = startDir;
  let lastConfigPath: string | undefined;

  while (true) {
    const configPath = await findDenoConfigPath(currentDir);
    const config = await readConfigIfExists(configPath);
    if (configPath && config) {
      lastConfigPath = configPath;
      if ("workspace" in config) {
        return configPath;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return lastConfigPath;
    }
    currentDir = parentDir;
  }
}

// Deno resolves a directory's config from `deno.json` first, then `deno.jsonc`.
// Mirror that order so a project with both files is bundled against the same
// config Deno itself reads.
export async function findDenoConfigPath(
  dir: string,
): Promise<string | undefined> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const candidate = path.join(dir, name);
    try {
      await Deno.stat(candidate);
      return candidate;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      throw error;
    }
  }
  return undefined;
}

export async function readConfigIfExists(
  configPath: string | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (configPath === undefined) {
    return undefined;
  }
  try {
    return parseJsonc(await Deno.readTextFile(configPath)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
}

function toStringRecord(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}

function toUnknownRecord(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

// Use this instead of `@std/fs#copy`, because we want to copy resolved
// symlinks, not the symlinks themselves.
async function copy(src: string, dest: string): Promise<void> {
  const stat = await Deno.lstat(src);

  if (stat.isSymlink) {
    const realPath = await Deno.realPath(src);
    const realStat = await Deno.stat(realPath);
    if (realStat.isDirectory) {
      await copyDir(realPath, dest);
    } else {
      await Deno.copyFile(realPath, dest);
    }
  } else if (stat.isDirectory) {
    await copyDir(src, dest);
  } else {
    await Deno.mkdir(path.dirname(dest), { recursive: true });
    await Deno.copyFile(src, dest);
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });

  for await (const entry of Deno.readDir(src)) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    await copy(srcPath, destPath);
  }
}
