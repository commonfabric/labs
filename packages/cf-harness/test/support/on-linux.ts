/**
 * The cf-harness entrypoints as they run on Linux, for a test whose subject is
 * not the sandbox runtime. Where nothing names a runtime the platform decides
 * it, so a case calling an entrypoint through its source module takes the
 * default of whichever machine runs the suite: Docker on Linux, and on macOS
 * the native runtime from that machine's own cfc-vm store, or a refusal where
 * it has none. Each export here is the entrypoint of the same name with the
 * platform set to `linux` unless the case names another, so a case reads the
 * same wherever it runs. The Loom local host takes no platform default, so
 * its export names Docker instead, unless the case's environment names a
 * runtime. A case about the default, or about a host given no runtime, calls
 * the source module.
 */

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

/** The platform every export here runs as unless a case names another. */
const LINUX = { platform: "linux" } as const;

/**
 * Environment for a case that spawns an entrypoint as a process of its own.
 * Such a child runs on the platform the suite runs on, which nothing here can
 * set, so it names Docker, the runtime the exports here default to.
 */
export const NAMES_DOCKER = { CF_HARNESS_SANDBOX_RUNTIME: "docker" } as const;

/** Like `parseCfHarnessCliArgs()` of `src/cli.ts`, except on Linux. */
export const parseCfHarnessCliArgs: typeof parseCfHarnessCliArgsOnHost = (
  argv,
  deps,
) => parseCfHarnessCliArgsOnHost(argv, { ...LINUX, ...deps });

/** Like `runCfHarnessCli()` of `src/cli.ts`, except on Linux. */
export const runCfHarnessCli: typeof runCfHarnessCliOnHost = (argv, deps) =>
  runCfHarnessCliOnHost(argv, { ...LINUX, ...deps });

/** Like `resolveInteractiveProvisioning()`, except on Linux. */
export const resolveInteractiveProvisioning = (
  parsed: Parameters<typeof resolveInteractiveProvisioningOnHost>[0],
  cwd: string,
  env: Record<string, string | undefined>,
  host: { homeDir?: string } = {},
): ReturnType<typeof resolveInteractiveProvisioningOnHost> =>
  resolveInteractiveProvisioningOnHost(parsed, cwd, env, { ...LINUX, ...host });

/** Like `runHarnessInteractiveChatStdioCli()`, except on Linux. */
export const runHarnessInteractiveChatStdioCli:
  typeof runHarnessInteractiveChatStdioCliOnHost = (args, cwd, run, host) =>
    runHarnessInteractiveChatStdioCliOnHost(args, cwd, run, {
      ...LINUX,
      ...host,
    });

/**
 * Like `createLoomLocalCfHarnessHost()`, except that its environment names
 * Docker where it names no sandbox runtime, as a Loom that runs on Docker
 * does. The environment is the process's own where the case gives none.
 */
export const createLoomLocalCfHarnessHost:
  typeof createLoomLocalCfHarnessHostOnHost = (options) =>
    createLoomLocalCfHarnessHostOnHost({
      ...options,
      env: { ...NAMES_DOCKER, ...(options.env ?? Deno.env.toObject()) },
    });

/** Like `resolveConsoleConfig()` of `console/server.ts`, except on Linux. */
export const resolveConsoleConfig: typeof resolveConsoleConfigOnHost = (
  args,
  env,
  cwd,
  host,
) => resolveConsoleConfigOnHost(args, env, cwd, { ...LINUX, ...host });

/** Like `startConsoleServer()` of `console/server.ts`, except on Linux. */
export const startConsoleServer: typeof startConsoleServerOnHost = (
  args,
  env,
  cwd,
  launchHealth,
  host,
) =>
  startConsoleServerOnHost(args, env, cwd, launchHealth, { ...LINUX, ...host });

/** Like `prepareConsoleLaunch()` of `console/launch.ts`, except on Linux. */
export const prepareConsoleLaunch: typeof prepareConsoleLaunchOnHost = (
  args,
  env,
  io,
  host,
) => prepareConsoleLaunchOnHost(args, env, io, { ...LINUX, ...host });

/** Like `launchConsole()` of `console/launch.ts`, except on Linux. */
export const launchConsole: typeof launchConsoleOnHost = (
  args,
  env,
  serve,
  io,
  host,
) => launchConsoleOnHost(args, env, serve, io, { ...LINUX, ...host });
