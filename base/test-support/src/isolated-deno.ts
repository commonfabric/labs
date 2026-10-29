import { join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";

export interface DenoCommandWithTemporaryLockOptions {
  root: string;
  cwd?: string;
  args: (lockPath: string) => string[];
  env?: Record<string, string>;

  /**
   * Where the child's stderr goes. `"piped"`, the default, collects it into
   * the returned output. `"inherit"` writes it to this process's stderr as the
   * child writes it, for a child whose progress belongs in the caller's log
   * while it runs; the returned output then holds no stderr to read.
   */
  stderr?: "piped" | "inherit";
}

export interface DenoCheckWithTemporaryConfigOptions {
  root: string;

  /**
   * A copy of the root config with the same workspace dependency graph.
   * Compiler options may differ for the check.
   */
  config: unknown;

  files: string[];
  tempConfigPrefix: string;
}

export interface FrozenDriftCheckOptions {
  /** Import map the baseline lockfile is generated from. */
  baselineImports: Record<string, string>;

  /**
   * Import map the frozen check runs against. It must differ from
   * `baselineImports`, and the entry module must only import specifiers that it
   * still maps.
   */
  driftedImports: Record<string, string>;

  /** Source of the entry module the checks type-check. */
  entrySource: string;
}

export interface FrozenDriftCheckResult {
  /** Output of generating the baseline lockfile from `baselineImports`. */
  generate: Deno.CommandOutput;

  /** Output of the frozen check run against `driftedImports`. */
  check: Deno.CommandOutput;
}

// Read and parse a Deno config file (`deno.json` / `deno.jsonc`) with the JSONC
// parser, so a config that carries comments is read correctly.
export async function readDenoConfig(
  path: string,
): Promise<Record<string, any>> {
  return parseJsonc(await Deno.readTextFile(path)) as Record<string, any>;
}

async function removeIfPresent(path: string, options?: Deno.RemoveOptions) {
  try {
    await Deno.remove(path, options);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}

// Both helpers below spawn `Deno.execPath()`, the Deno running the test, rather
// than the program name `deno`, which resolves through `PATH`. A test that
// spawned the `PATH` copy would exercise a different toolchain than the one
// under test whenever the two differ, and the two share one cache directory: a
// coverage profile written by one version cannot be reported by the other,
// because each version reads transpiled sources only from its own part of the
// cache.

export async function runDenoCommandWithTemporaryLock(
  options: DenoCommandWithTemporaryLockOptions,
): Promise<Deno.CommandOutput> {
  const tempDir = await Deno.makeTempDir({
    prefix: "commonfabric-deno-lock-",
  });
  const tempLock = join(tempDir, "deno.lock");

  try {
    await Deno.copyFile(join(options.root, "deno.lock"), tempLock);
    const commandOptions: Deno.CommandOptions = {
      cwd: options.cwd ?? options.root,
      args: options.args(tempLock),
      stdout: "piped",
      stderr: options.stderr ?? "piped",
    };
    if (options.env) {
      commandOptions.env = options.env;
    }
    return await new Deno.Command(Deno.execPath(), commandOptions).output();
  } finally {
    await removeIfPresent(tempDir, { recursive: true });
  }
}

export async function runDenoCheckWithTemporaryConfig(
  options: DenoCheckWithTemporaryConfigOptions,
): Promise<Deno.CommandOutput> {
  const safePrefix = options.tempConfigPrefix.replaceAll(
    /[^a-zA-Z0-9._-]/g,
    "-",
  );
  const tempConfig = join(
    options.root,
    `.${safePrefix}.${Deno.pid}.${crypto.randomUUID()}.json`,
  );

  try {
    await Deno.writeTextFile(
      tempConfig,
      JSON.stringify(options.config, null, 2),
    );

    return await runDenoCommandWithTemporaryLock({
      root: options.root,
      cwd: options.root,
      args: (tempLock) => [
        "check",
        "--config",
        tempConfig,
        "--lock",
        tempLock,
        // Verification uses the dependency graph pinned by the checked-in lock.
        "--frozen=true",
        ...options.files,
      ],
    });
  } finally {
    await removeIfPresent(tempConfig);
  }
}

// Build a self-contained Deno workspace in a temporary directory, generate a
// lockfile for `baselineImports`, then run a frozen check against
// `driftedImports`. Everything lives under the temporary directory, so the
// repository config and lockfile are untouched.
//
// The check needs no network when the metadata for the imports it resolves is
// already cached. A frozen check recomputes the whole graph only when the
// config differs from the lockfile, so the generate step is what pins the
// baseline offline, and the frozen check resolves `driftedImports` against that
// baseline. Choose imports the repository already depends on so their metadata
// is present in any cache that can build the repository.
export async function runFrozenDriftCheck(
  options: FrozenDriftCheckOptions,
): Promise<FrozenDriftCheckResult> {
  const tempDir = await Deno.makeTempDir({
    prefix: "commonfabric-frozen-drift-",
  });
  const configPath = join(tempDir, "deno.json");
  const lockPath = join(tempDir, "deno.lock");
  const entryPath = join(tempDir, "entry.ts");

  const runCheck = async (imports: Record<string, string>, frozen: boolean) => {
    await Deno.writeTextFile(configPath, JSON.stringify({ imports }, null, 2));
    return await new Deno.Command(Deno.execPath(), {
      cwd: tempDir,
      args: [
        "check",
        "--config",
        configPath,
        "--lock",
        lockPath,
        ...(frozen ? ["--frozen=true"] : []),
        entryPath,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
  };

  try {
    await Deno.writeTextFile(entryPath, options.entrySource);
    const generate = await runCheck(options.baselineImports, false);
    const check = await runCheck(options.driftedImports, true);
    return { generate, check };
  } finally {
    await removeIfPresent(tempDir, { recursive: true });
  }
}
