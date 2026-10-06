import { CF_PERMISSION_FLAGS } from "./lib/cf-permissions.ts";

export interface CfLauncherOptions {
  denoPath: string;
  labsRoot: string;
  configPath: string;
  cliEntrypoint: string;
  cwd: string;
  cfArgs: readonly string[];
}

export interface CfLauncherCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ParseCfLauncherArgsOptions {
  argv: readonly string[];
  cwd: string;
  initCwd?: string;
  denoPath: string;
  modulePath: string;
}

const optionNamesWithValues = new Set([
  "--deno",
  "--labs-root",
  "--config",
  "--cli-entrypoint",
  "--cwd",
]);

const normalizeSeparators = (path: string): string =>
  path.replaceAll("\\", "/");

const isAbsolutePath = (path: string): boolean => {
  const normalized = normalizeSeparators(path);
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
};

const normalizePath = (path: string): string => {
  const normalized = normalizeSeparators(path);
  const drivePrefix = normalized.match(/^[A-Za-z]:/)?.[0] ?? "";
  const hasUncPrefix = drivePrefix === "" && normalized.startsWith("//") &&
    !normalized.startsWith("///");
  const withoutPrefix = drivePrefix !== ""
    ? normalized.slice(drivePrefix.length)
    : hasUncPrefix
    ? normalized.slice(2)
    : normalized;
  const isAbsolute = hasUncPrefix || withoutPrefix.startsWith("/");
  const parts: string[] = [];
  const minPartCount = hasUncPrefix ? 2 : 0;

  for (const part of withoutPrefix.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (
        parts.length > minPartCount && parts[parts.length - 1] !== ".."
      ) {
        parts.pop();
      } else if (!isAbsolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  const prefix = drivePrefix !== ""
    ? `${drivePrefix}${isAbsolute ? "/" : ""}`
    : hasUncPrefix
    ? "//"
    : isAbsolute
    ? "/"
    : "";
  const suffix = parts.join("/");
  if (suffix === "") {
    return prefix === "" ? "." : prefix;
  }
  return `${prefix}${suffix}`;
};

const dirnamePath = (path: string): string => {
  const normalized = normalizePath(path);
  const trimmed = normalized.length > 1
    ? normalized.replace(/\/+$/g, "")
    : normalized;
  if (trimmed.startsWith("//")) {
    const withoutUncPrefix = trimmed.slice(2);
    const uncIndex = withoutUncPrefix.lastIndexOf("/");
    const shareIndex = withoutUncPrefix.indexOf("/");
    return uncIndex <= shareIndex
      ? trimmed
      : `//${withoutUncPrefix.slice(0, uncIndex)}`;
  }
  const index = trimmed.lastIndexOf("/");
  if (index < 0) {
    return ".";
  }
  if (index === 0) {
    return "/";
  }
  if (index === 2 && /^[A-Za-z]:/.test(trimmed)) {
    return trimmed.slice(0, 3);
  }
  return trimmed.slice(0, index);
};

const resolvePathSegments = (...paths: readonly string[]): string => {
  let resolved = "";
  for (const path of paths) {
    if (path === "") {
      continue;
    }
    const normalized = normalizeSeparators(path);
    if (resolved === "" || isAbsolutePath(normalized)) {
      resolved = normalized;
      continue;
    }
    resolved = `${resolved.replace(/\/+$/g, "")}/${normalized}`;
  }
  return normalizePath(resolved);
};

const resolvePath = (base: string, path: string): string =>
  isAbsolutePath(path) ? normalizePath(path) : resolvePathSegments(base, path);

export const defaultLabsRootFromModulePath = (modulePath: string): string =>
  resolvePathSegments(dirnamePath(modulePath), "..", "..");

export const fileUrlToPath = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") {
    throw new Error(`expected file URL, received ${url}`);
  }
  const path = decodeURIComponent(parsed.pathname);
  if (parsed.hostname !== "" && parsed.hostname !== "localhost") {
    return normalizePath(`//${decodeURIComponent(parsed.hostname)}${path}`);
  }
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
};

const readInitCwd = (): string | undefined => {
  try {
    const value = Deno.env.get("INIT_CWD");
    return value !== undefined && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
};

const usage =
  `Usage: deno run --allow-run --allow-env --allow-read packages/cli/launcher.ts [options] [--] [cf args...]

Options:
  --deno <path>              Deno executable to use for the child CLI process
  --labs-root <path>         Labs checkout root (defaults to this script's repo)
  --config <path>            Child Deno config/import-map path (defaults to <labs-root>/deno.jsonc)
  --cli-entrypoint <path>    CF CLI entrypoint (defaults to <labs-root>/packages/cli/mod.ts)
  --cwd <path>               Working directory for the CF CLI child process (defaults to INIT_CWD or current cwd)
  --launcher-help            Show this help text
`;

export const formatCfLauncherUsage = (): string => usage;

export const formatCfLauncherError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const missingOption = message.match(/^(--[A-Za-z0-9-]+) requires a value$/);
  const hint = missingOption === null
    ? ""
    : `; use -- to pass ${missingOption[1]} to cf`;
  return `cf launcher: ${message}${hint}`;
};

export const parseCfLauncherArgs = (
  options: ParseCfLauncherArgsOptions,
): CfLauncherOptions | { help: true } => {
  const defaultLabsRoot = defaultLabsRootFromModulePath(options.modulePath);
  let denoPath = options.denoPath;
  let labsRoot = defaultLabsRoot;
  let configPath: string | undefined;
  let cliEntrypoint: string | undefined;
  let cwd = options.initCwd ?? options.cwd;
  const cfArgs: string[] = [];

  for (let index = 0; index < options.argv.length; index += 1) {
    const arg = options.argv[index]!;
    if (arg === "--") {
      for (const cfArg of options.argv.slice(index + 1)) cfArgs.push(cfArg);
      break;
    }
    if (arg === "--launcher-help") {
      return { help: true };
    }
    if (optionNamesWithValues.has(arg)) {
      const value = options.argv[index + 1];
      if (value === undefined || value === "") {
        throw new Error(`${arg} requires a value`);
      }
      switch (arg) {
        case "--deno":
          denoPath = value;
          break;
        case "--labs-root":
          labsRoot = resolvePath(options.cwd, value);
          break;
        case "--config":
          configPath = resolvePath(options.cwd, value);
          break;
        case "--cli-entrypoint":
          cliEntrypoint = resolvePath(options.cwd, value);
          break;
        case "--cwd":
          cwd = resolvePath(options.cwd, value);
          break;
      }
      index += 1;
      continue;
    }
    for (const cfArg of options.argv.slice(index)) cfArgs.push(cfArg);
    break;
  }

  const resolvedLabsRoot = resolvePath(options.cwd, labsRoot);
  return {
    denoPath,
    labsRoot: resolvedLabsRoot,
    configPath: configPath ??
      resolvePathSegments(resolvedLabsRoot, "deno.jsonc"),
    cliEntrypoint: cliEntrypoint ??
      resolvePathSegments(resolvedLabsRoot, "packages", "cli", "mod.ts"),
    cwd,
    cfArgs,
  };
};

export const buildCfLauncherCommand = (
  options: CfLauncherOptions,
): CfLauncherCommand => ({
  command: options.denoPath,
  args: [
    "run",
    // Suppress Deno's own diagnostics (npm "Ignored build scripts" banner,
    // download progress) — they print ANSI to stderr on every invocation and
    // are noise for CLI consumers. CLI/runtime output is unaffected.
    "--quiet",
    "--config",
    options.configPath,
    ...CF_PERMISSION_FLAGS,
    options.cliEntrypoint,
    ...options.cfArgs,
  ],
  cwd: options.cwd,
  env: {
    CF_CLI_NAME: "cf",
  },
});

const run = async (): Promise<number> => {
  const modulePath = fileUrlToPath(import.meta.url);
  const parsed = parseCfLauncherArgs({
    argv: Deno.args,
    cwd: Deno.cwd(),
    initCwd: readInitCwd(),
    denoPath: Deno.execPath(),
    modulePath,
  });
  if ("help" in parsed) {
    console.log(formatCfLauncherUsage());
    return 0;
  }
  const command = buildCfLauncherCommand(parsed);
  const child = new Deno.Command(command.command, {
    args: command.args,
    cwd: command.cwd,
    env: command.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.spawn().status;
  return status.code;
};

if (import.meta.main) {
  try {
    Deno.exit(await run());
  } catch (error) {
    console.error(formatCfLauncherError(error));
    Deno.exit(1);
  }
}
