/**
 * The cf-harness entrypoints as they run on Linux, as root, for a test whose
 * subject is not the sandbox runtime. Where nothing names a runtime the
 * platform decides it, so a case calling an entrypoint through its source
 * module takes the default of whichever machine runs the suite and of
 * whoever runs it. Each export here is the entrypoint of the same name with
 * the platform set to `linux` and the process to root unless the case names
 * otherwise, and with the Linux store under `LINUX_HOME` unless the
 * environment a case hands it names a home of its own, so a case reads the
 * same wherever it runs and never reads the store of the machine it runs on.
 * The Linux default is then the native runtime from that store. The Loom
 * local host takes no platform default, and neither does a console launched
 * for a Loom instance, so their exports name `runsc` over that store instead,
 * unless the case's environment names a runtime. A case about the default, or
 * about a host given no runtime, calls the source module.
 */

import { join } from "@std/path";

import {
  launchConsole as launchConsoleOnHost,
  prepareConsoleLaunch as prepareConsoleLaunchOnHost,
} from "../../console/launch.ts";
import {
  resolveConsoleConfig as resolveConsoleConfigOnHost,
  startConsoleServer as startConsoleServerOnHost,
} from "../../console/server.ts";
import {
  parseCfHarnessCliArgs as parseCfHarnessCliArgsOnHost,
  runCfHarnessCli as runCfHarnessCliOnHost,
} from "../../src/cli.ts";
import { resolveInteractiveProvisioning as resolveInteractiveProvisioningOnHost } from "../../src/host-mounts.ts";
import { runHarnessInteractiveChatStdioCli as runHarnessInteractiveChatStdioCliOnHost } from "../../src/interactive-chat-stdio.ts";
import { createLoomLocalCfHarnessHost as createLoomLocalCfHarnessHostOnHost } from "../../src/loom-local-host.ts";

/**
 * A home whose store holds everything the Linux default takes from it: a
 * `runsc` that runs nothing, an empty rootfs and an empty CFC policy, and a
 * `pasta`, an `unshare` and a `setpriv` beside it that run nothing, which the
 * exports find for the default's network. Made
 * once per process outside every tree a case mounts, and removed as the
 * process ends.
 */
export const LINUX_HOME: string = (() => {
  const home = Deno.realPathSync(
    Deno.makeTempDirSync({ prefix: "cf-harness-linux-home-" }),
  );
  const store = join(home, ".local", "share", "runsc-cfc");
  Deno.mkdirSync(join(store, "bin"), { recursive: true });
  Deno.writeTextFileSync(join(store, "bin", "runsc"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  Deno.mkdirSync(join(store, "images", "kitchensink"), { recursive: true });
  Deno.writeTextFileSync(join(store, "cfc-policy.json"), "{}\n");
  Deno.mkdirSync(join(home, "bin"));
  for (const helper of ["pasta", "unshare", "setpriv"]) {
    Deno.writeTextFileSync(join(home, "bin", helper), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  }
  globalThis.addEventListener("unload", () => {
    Deno.removeSync(home, { recursive: true });
  });
  return home;
})();

/**
 * The platform every export here runs as unless a case names another, and
 * the process the Linux default is for: root.
 */
const LINUX = {
  platform: "linux",
  uid: () => 0,
  which: (name: string) =>
    name === "pasta" || name === "unshare" || name === "setpriv"
      ? join(LINUX_HOME, "bin", name)
      : undefined,
} as const;

/**
 * The home an export looks for the Linux store under, given the environment
 * a case hands it: the home that environment names, and otherwise, the
 * process's own included, `LINUX_HOME`.
 */
const homeOf = (
  env: Record<string, string | undefined> | undefined,
): { homeDir?: string } =>
  env?.HOME !== undefined && env.HOME !== "" ? {} : { homeDir: LINUX_HOME };

/** The same, for the batch CLI, which takes the home under its own name. */
const cliHome = (
  env: Record<string, string | undefined> | undefined,
): { sandboxHomeDir?: string } => {
  const { homeDir } = homeOf(env);
  return homeDir === undefined ? {} : { sandboxHomeDir: homeDir };
};

/**
 * Environment that names `runsc`, with the binary, rootfs and CFC policy of
 * the store under `LINUX_HOME`, so a selection made from it looks at nothing
 * else: for a case that spawns an entrypoint as a process of its own, which
 * runs on the platform the suite runs on and that nothing here can set, and
 * for a host that takes no platform default.
 */
export const NAMES_RUNSC = {
  CF_HARNESS_SANDBOX_RUNTIME: "runsc",
  CF_HARNESS_RUNSC_BINARY: join(
    LINUX_HOME,
    ".local",
    "share",
    "runsc-cfc",
    "bin",
    "runsc",
  ),
  CF_HARNESS_SANDBOX_ROOTFS: join(
    LINUX_HOME,
    ".local",
    "share",
    "runsc-cfc",
    "images",
    "kitchensink",
  ),
  CF_HARNESS_RUNSC_CFC_POLICY: join(
    LINUX_HOME,
    ".local",
    "share",
    "runsc-cfc",
    "cfc-policy.json",
  ),
} as const;

/**
 * Returns `env` naming `runsc` over the store under `LINUX_HOME` where it
 * names no sandbox runtime, each setting it names of its own kept, and as it
 * is where it names one: a case that names a runtime is given nothing of
 * that store's.
 */
const namingRunsc = (
  env: Record<string, string | undefined>,
): Record<string, string | undefined> =>
  (env.CF_HARNESS_SANDBOX_RUNTIME ?? "").trim() === ""
    ? { ...NAMES_RUNSC, ...env, CF_HARNESS_SANDBOX_RUNTIME: "runsc" }
    : env;

/** Like `parseCfHarnessCliArgs()` of `src/cli.ts`, except on Linux. */
export const parseCfHarnessCliArgs: typeof parseCfHarnessCliArgsOnHost = (
  argv,
  deps,
) =>
  parseCfHarnessCliArgsOnHost(argv, {
    ...LINUX,
    ...cliHome(deps?.env),
    ...deps,
  });

/** Like `runCfHarnessCli()` of `src/cli.ts`, except on Linux. */
export const runCfHarnessCli: typeof runCfHarnessCliOnHost = (argv, deps) =>
  runCfHarnessCliOnHost(argv, {
    ...LINUX,
    ...cliHome(deps?.env),
    ...deps,
  });

/** Like `resolveInteractiveProvisioning()`, except on Linux. */
export const resolveInteractiveProvisioning = (
  parsed: Parameters<typeof resolveInteractiveProvisioningOnHost>[0],
  cwd: string,
  env: Record<string, string | undefined>,
  host: { homeDir?: string } = {},
): ReturnType<typeof resolveInteractiveProvisioningOnHost> =>
  resolveInteractiveProvisioningOnHost(parsed, cwd, env, {
    ...LINUX,
    ...homeOf(env),
    ...host,
  });

/** Like `runHarnessInteractiveChatStdioCli()`, except on Linux. */
export const runHarnessInteractiveChatStdioCli:
  typeof runHarnessInteractiveChatStdioCliOnHost = (args, cwd, run, host) =>
    runHarnessInteractiveChatStdioCliOnHost(args, cwd, run, {
      ...LINUX,
      ...homeOf(host?.env),
      ...host,
    });

/**
 * Like `createLoomLocalCfHarnessHost()`, except that its environment names
 * `runsc` over the store under `LINUX_HOME` where it names no sandbox
 * runtime, as Loom names its runtime. The environment is the process's own
 * where the case gives none.
 */
export const createLoomLocalCfHarnessHost:
  typeof createLoomLocalCfHarnessHostOnHost = (options) =>
    createLoomLocalCfHarnessHostOnHost({
      ...options,
      env: namingRunsc(options.env ?? Deno.env.toObject()),
    });

/** Like `resolveConsoleConfig()` of `console/server.ts`, except on Linux. */
export const resolveConsoleConfig: typeof resolveConsoleConfigOnHost = (
  args,
  env,
  cwd,
  host,
) =>
  resolveConsoleConfigOnHost(args, env, cwd, {
    ...LINUX,
    ...homeOf(env),
    ...host,
  });

/** Like `startConsoleServer()` of `console/server.ts`, except on Linux. */
export const startConsoleServer: typeof startConsoleServerOnHost = (
  args,
  env,
  cwd,
  launchHealth,
  host,
) =>
  startConsoleServerOnHost(args, env, cwd, launchHealth, {
    ...LINUX,
    ...homeOf(env),
    ...host,
  });

/**
 * Returns `env` for a launch with `args`: naming `runsc` where the launch is
 * for a Loom instance and `env` names no runtime, as Loom launches one, and
 * as it is otherwise.
 */
const launchEnvironment = (
  args: readonly string[],
  env: Record<string, string | undefined>,
): Record<string, string | undefined> =>
  args.some((arg) => arg === "--instance" || arg.startsWith("--instance="))
    ? namingRunsc(env)
    : env;

/**
 * Like `prepareConsoleLaunch()` of `console/launch.ts`, except on Linux, and
 * with `runsc` named for a launch for a Loom instance.
 */
export const prepareConsoleLaunch: typeof prepareConsoleLaunchOnHost = (
  args,
  env,
  io,
  host,
) =>
  prepareConsoleLaunchOnHost(args, launchEnvironment(args, env), io, {
    ...LINUX,
    ...homeOf(env),
    ...host,
  });

/**
 * Like `launchConsole()` of `console/launch.ts`, except on Linux, and with
 * `runsc` named for a launch for a Loom instance. The environment is the
 * process's own where the case gives none.
 */
export const launchConsole: typeof launchConsoleOnHost = (
  args = Deno.args,
  env,
  serve,
  io,
  host,
) =>
  launchConsoleOnHost(
    args,
    launchEnvironment(args, env ?? Deno.env.toObject()),
    serve,
    io,
    { ...LINUX, ...homeOf(env), ...host },
  );
