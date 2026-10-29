import { basename } from "@std/path";
import {
  buildFuseChildDenoArgs,
  fuseMod,
  type MountStateEntry,
  writeMountStateFile,
} from "./fuse.ts";
import {
  type FuseSupervisorFlags,
  mountFlagArgs,
  parseSupervisorArgs,
  supervisorHelp,
} from "./fuse-mount-flags.ts";

/** The mount flags the supervisor runs with, plus its injectable surroundings. */
export interface FuseSupervisorOptions extends FuseSupervisorFlags {
  importMetaUrl?: string;
  command?: FuseCommandConstructor;
  execPath?: string;
  childShutdownTimeoutMs?: number;
  writeMountStateFile?: (
    path: string,
    entry: MountStateEntry,
  ) => Promise<void>;
  exit?: (code: number) => never | void;
  addSignalListener?: (signal: Deno.Signal, handler: () => void) => void;
  removeSignalListener?: (signal: Deno.Signal, handler: () => void) => void;
  supervisorPid?: number;
}

export interface FuseCommandConstructor {
  new (command: string | URL, options: Deno.CommandOptions): {
    spawn(): {
      pid: number;
      status: Promise<Deno.CommandStatus>;
      kill(signal: Deno.Signal): void;
    };
  };
}

export interface SupervisedFuseChild {
  killed?: boolean;
  kill: (signal: Deno.Signal) => void;
  status?: Promise<Deno.CommandStatus>;
}

const DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

export function buildFuseChildCommand(
  options: FuseSupervisorOptions,
): { command: string; args: string[] } {
  const execPath = options.execPath ?? Deno.execPath();
  const execBase = basename(execPath);
  const isCompiledBinary = execBase !== "deno" && execBase !== "deno.exe";

  // The child is the daemon, so it receives the daemon's flags only: the mount
  // state file stays with this process.
  if (isCompiledBinary) {
    return {
      command: execPath,
      args: ["fuse-daemon", options.mountpoint, ...mountFlagArgs(options)],
    };
  }

  return {
    command: execPath,
    args: buildFuseChildDenoArgs({
      ...options,
      modPath: fuseMod(options.importMetaUrl ?? import.meta.url),
    }),
  };
}

export async function runFuseSupervisor(
  options: FuseSupervisorOptions,
): Promise<void> {
  const childCommand = buildFuseChildCommand(options);
  const CommandCtor = options.command ?? Deno.Command;
  const exit = options.exit ?? Deno.exit;
  // The child inherits this process's stdout. For a background mount that is the
  // pipe `cf fuse mount` blocks on, so the child's readiness line reaches the
  // command directly.
  const child = new CommandCtor(childCommand.command, {
    args: childCommand.args,
    stdin: "null",
    stdout: "inherit",
    stderr: "null",
  }).spawn();

  let childExited = false;
  const supervisedChild: SupervisedFuseChild = {
    get killed(): boolean {
      return childExited;
    },
    kill: (signal: Deno.Signal) => child.kill(signal),
    status: child.status,
  };

  let terminating = false;
  const forwardTermination = (signal: Deno.Signal): void => {
    if (terminating) return;
    terminating = true;
    cleanupFuseChild(supervisedChild, {
      signal,
      timeoutMs: options.childShutdownTimeoutMs,
    }).then(() => {
      exit(signal === "SIGINT" ? 130 : 143);
    }).catch(() => {
      exit(1);
    });
  };
  const onSigterm = () => forwardTermination("SIGTERM");
  const onSigint = () => forwardTermination("SIGINT");

  addSupervisorSignalListener("SIGTERM", onSigterm, options.addSignalListener);
  addSupervisorSignalListener("SIGINT", onSigint, options.addSignalListener);

  try {
    if (options.statePath) {
      await recordFuseMountState(options, child.pid);
    }
    const status = await child.status;
    childExited = true;
    exit(status.code);
  } finally {
    removeSupervisorSignalListener(
      "SIGTERM",
      onSigterm,
      options.removeSignalListener,
    );
    removeSupervisorSignalListener(
      "SIGINT",
      onSigint,
      options.removeSignalListener,
    );
    await cleanupFuseChild(supervisedChild, {
      timeoutMs: options.childShutdownTimeoutMs,
    });
  }
}

export async function cleanupFuseChild(
  child: SupervisedFuseChild,
  options: {
    signal?: Deno.Signal;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  if (child.killed) return;

  const signal = options.signal ?? "SIGTERM";
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS;

  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the status check and kill attempt.
    return;
  }

  if (!child.status) return;

  const timedOut = Symbol("timedOut");
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race<Deno.CommandStatus | typeof timedOut>([
    child.status,
    new Promise<typeof timedOut>((resolve) => {
      timeoutId = setTimeout(() => resolve(timedOut), timeoutMs);
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });

  if (result !== timedOut) return;

  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited during the timeout window.
  }

  await child.status.catch(() => undefined);
}

/**
 * Writes the mount state file. This process spawned the FUSE child, so it is the
 * only one that knows both PIDs, and it writes the file once and completely.
 * `cf fuse mount` prepares the containing directory and the path, then leaves the
 * contents to this process.
 */
export async function recordFuseMountState(
  options: FuseSupervisorOptions,
  childPid: number,
): Promise<void> {
  const statePath = options.statePath;
  if (!statePath) return;
  const write = options.writeMountStateFile ?? writeMountStateFile;
  const entry: MountStateEntry = {
    pid: options.supervisorPid ?? Deno.pid,
    childPid,
    mountpoint: options.mountpoint,
    apiUrl: options.apiUrl,
    identity: options.identity,
    startedAt: new Date().toISOString(),
    childStatusPath: options.supervisorStatusPath,
    logFile: options.logFile || undefined,
  };
  try {
    await write(statePath, entry);
  } catch (error) {
    throw new Error(`Unable to record FUSE mount state: ${error}`);
  }
}

if (import.meta.main) {
  try {
    const { options, help } = parseSupervisorArgs(Deno.args);
    if (help) {
      console.log(supervisorHelp());
      Deno.exit(0);
    }
    await runFuseSupervisor(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}

function addSupervisorSignalListener(
  signal: Deno.Signal,
  handler: () => void,
  addSignalListener: (signal: Deno.Signal, handler: () => void) => void = Deno
    .addSignalListener,
): void {
  try {
    addSignalListener(signal, handler);
  } catch {
    // Some platforms do not support all signal listeners.
  }
}

function removeSupervisorSignalListener(
  signal: Deno.Signal,
  handler: () => void,
  removeSignalListener: (signal: Deno.Signal, handler: () => void) => void =
    Deno
      .removeSignalListener,
): void {
  try {
    removeSignalListener(signal, handler);
  } catch {
    // Ignore unsupported or already-removed listeners.
  }
}
