import { basename, resolve } from "@std/path";

import { Command } from "@cliffy/command";
import ports from "@commonfabric/ports" with { type: "json" };

import { parseAttrcacheTimeoutSeconds } from "../../fuse/mount-options.ts";
import { cliText } from "../lib/cli-name.ts";
import {
  buildBackgroundSupervisorDenoArgs,
  buildFuseBinaryArgs,
  buildFuseChildDenoArgs,
  defaultStateDir,
  ensureExecShim,
  fuseMod,
  fuseSupervisorMod,
  isAlive,
  isMountpointInTable,
  isMountStateAlive,
  type MountStateEntry,
  type MountTableState,
  prepareMountStatePath,
  readAllMountStates,
  removeMountStateFile,
  writeMountState,
} from "../lib/fuse.ts";

export function isFuseProcessCommand(command: string): boolean {
  return command.includes("runtime/fuse/mod.ts") ||
    command.includes("runtime/cli/lib/fuse-supervisor.ts") ||
    command.includes("fuse-supervisor") ||
    command.includes("fuse-daemon");
}

type FuseChildSupervisorState =
  | "starting"
  | "mounted"
  | "failed"
  | "exiting"
  | "exited";

interface FuseChildSupervisorStatus {
  state: FuseChildSupervisorState;
  pid?: number;
  mountpoint?: string;
  updatedAt?: string;
  error?: string;
  exitCode?: number;
}

export function childStatusPathForStatePath(statePath: string): string {
  return `${statePath}.child-status`;
}

export const mountStatusHeader =
  "MOUNTPOINT\tSUPERVISOR_PID\tCHILD_PID\tSTATUS\tSTARTED\tLOG";

function parseChildSupervisorStatus(
  text: string,
): FuseChildSupervisorStatus | null {
  try {
    const parsed = JSON.parse(text) as Partial<FuseChildSupervisorStatus>;
    switch (parsed.state) {
      case "starting":
      case "mounted":
      case "failed":
      case "exiting":
      case "exited":
        return parsed as FuseChildSupervisorStatus;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const fuseDescription = cliText(
  `Mount Common Fabric spaces as a FUSE filesystem.

Spaces appear as directories at the mount root. Any space name you \`cd\`
into is connected on demand — no need to specify spaces up front.

FILESYSTEM LAYOUT:
  <mountpoint>/
    <space>/                    # one per connected space
      pieces/
        <piece-name>/           # each piece gets a directory
          result/               # exploded JSON tree (dirs, files, symlinks)
          result/*.handler      # executable callables; writing still invokes handlers
          result/*.tool         # executable tools surfaced as mounted callables
          result.json           # full JSON blob
          input/
          input/*.handler
          input/*.tool
          input.json
          meta.json             # piece ID, entity, running pattern ref
        .index.json             # name-to-entity-ID mapping
        pieces.json             # discovery manifest with pattern refs
      entities/                 # access cells by entity ID
      space.json                # { did, name }
    .spaces.json                # known space-name -> DID mapping

  READING:
  ls <space>/pieces/                     # list pieces
  cat <piece>/result.json                # full cell value as JSON
  cat <piece>/result/title               # single scalar field
  cat <piece>/result/items/0/name        # nested access
  head -n1 <piece>/result/search.tool    # callable shebang for cf exec

  WRITING:
  echo '"new title"' > result/title      # write scalar (auto-detects type)
  echo '{"a":1}' > result.json           # replace entire cell
  echo '{"msg":"hi"}' > result/chat.handler  # invoke a stream handler
  touch result/newkey                    # create key (empty string)
  rm result/oldkey                       # delete key
  ln -s ../../other-piece/input/foo result/ref  # sigil link

Requires FUSE-T (preferred) or macFUSE on macOS.`,
);

export async function awaitForegroundMountExit(
  child: { status: Promise<Deno.CommandStatus> },
  statePath: string,
  exit: (code: number) => never | void = Deno.exit,
): Promise<void> {
  const status = await child.status;
  await removeMountStateFile(statePath);
  exit(status.code);
}

async function removeMountStateAndChildStatus(
  statePath: string,
  childStatusPath: string | undefined,
  removeStateFile: (path: string) => Promise<void>,
): Promise<void> {
  await removeStateFile(statePath);
  if (childStatusPath) {
    await removeStateFile(childStatusPath).catch(() => undefined);
  }
}

/**
 * Reads readiness lines until the child settles on a state, and returns null
 * once no report can arrive any more.
 *
 * Two things end the read besides a report. End of stream means every process
 * holding the write end has exited. The supervisor exiting means the same thing
 * for a child that cannot report on its own: the FUSE child inherits the write
 * end, so an orphaned child holds the stream open and end of stream never comes.
 */
async function readSettledChildStatus(
  readiness: ReadableStream<Uint8Array>,
  supervisorExit: Promise<unknown>,
): Promise<FuseChildSupervisorStatus | null> {
  const reader = readiness.getReader();
  const decoder = new TextDecoder();
  const supervisorGone = Symbol("supervisorGone");
  let buffered = "";
  try {
    while (true) {
      const next = await Promise.race<
        ReadableStreamReadResult<Uint8Array> | typeof supervisorGone
      >([
        reader.read(),
        supervisorExit.then(() => supervisorGone),
      ]);
      if (next === supervisorGone) return null;
      const { value, done } = next;
      if (done) return null;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const status = parseChildSupervisorStatus(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (status && status.state !== "starting") return status;
        newline = buffered.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Waits for a background mount to report that it is up.
 *
 * The supervisor and its FUSE child write readiness to `deps.readiness`, a pipe
 * this command holds the read end of, so the read wakes on the child's own
 * announcement rather than on a clock. The channel is private to this mount, so
 * a line arriving on it came from this child and needs no correlation against
 * the mount state.
 *
 * Returns only once the child has reported `mounted` and both the supervisor and
 * the child are alive. There is no deadline: a child that never reports leaves
 * the command waiting, which is interruptible and honest, rather than turning a
 * slow startup into a reported failure. Every other outcome removes the mount
 * state and throws.
 */
export async function awaitBackgroundMountStartup(
  pid: number,
  statePath: string,
  deps: {
    readiness: ReadableStream<Uint8Array>;
    supervisorExit: Promise<unknown>;
    isAlive?: (pid: number) => boolean;
    removeStateFile?: (path: string) => Promise<void>;
    childStatusPath?: string;
  },
): Promise<void> {
  const isAliveFn = deps.isAlive ?? isAlive;
  const removeStateFileFn = deps.removeStateFile ?? removeMountStateFile;
  const exitedDuringStartup =
    "Background FUSE process exited during startup. Re-run without --background to inspect startup errors.";
  const fail = async (message: string): Promise<never> => {
    await removeMountStateAndChildStatus(
      statePath,
      deps.childStatusPath,
      removeStateFileFn,
    );
    throw new Error(message);
  };

  const status = await readSettledChildStatus(
    deps.readiness,
    deps.supervisorExit,
  );

  if (!status) return await fail(exitedDuringStartup);
  if (status.state !== "mounted") {
    return await fail(
      `Background FUSE mount failed during startup: ${
        status.error ?? `child reported ${status.state}`
      }`,
    );
  }

  // The child announces `mounted` only after its FUSE session loop is dispatched
  // and its signal handlers are installed, so the report means the kernel mount
  // exists and a signal will unmount it cleanly. A point-in-time probe rejects a
  // child or supervisor that has already exited by the time the report is read.
  // It does not wait to see whether one exits shortly after: that wait was a
  // fixed grace period paid on every successful mount, and while it ran a slow
  // but healthy mount was indistinguishable from a stuck one.
  if (typeof status.pid !== "number" || !isAliveFn(status.pid)) {
    return await fail(
      "Background FUSE mount failed during startup: child exited after reporting mounted.",
    );
  }
  if (!isAliveFn(pid)) return await fail(exitedDuringStartup);
}

export const fuse = new Command()
  .name("fuse")
  .description(fuseDescription)
  .default("help")
  .globalEnv("CF_API_URL=<url:string>", "URL of the fabric server instance.", {
    prefix: "CF_",
  })
  .globalOption(
    "-a,--api-url <url:string>",
    "URL of the fabric server instance.",
  )
  .globalEnv("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
  /* mount */
  .command(
    "mount <mountpoint:string>",
    "Mount a FUSE filesystem at the given directory.",
  )
  .option("--background", "Run in the background (detached).")
  .option("--debug", "Enable FUSE debug output.")
  .option(
    "--allow-other",
    "Linux only: export the mount to other users such as Docker daemon. Requires user_allow_other in /etc/fuse.conf.",
  )
  .option(
    "--noattrcache",
    "macOS/FUSE-T only: mount with FUSE-T's noattrcache option (the NFS nonegnamecache flag on current FUSE-T). Negative name lookups are never cached; positive attribute caching keeps the NFS client's 5-60 second defaults.",
    { conflicts: ["attrcache-timeout"] },
  )
  .option(
    "--attrcache-timeout <seconds:integer>",
    "macOS/FUSE-T only: bound every NFS client attribute-cache window to the given whole seconds (0-86400). FUSE-T mounts default to 1; 0 keeps the NFS client's age-based 5-60 second default caching.",
  )
  .option(
    "--cfc-mode <mode:string>",
    "Enable FUSE-side CFC mode: disabled, observe, enforce-explicit, or enforce-strict.",
  )
  .option(
    "--cfc-annotations",
    "Publish CFC annotation xattrs even when CFC mode is disabled.",
  )
  .option(
    "--cfc-xattr-namespace <namespace:string>",
    "CFC xattr namespace to expose: trusted, compat, or both.",
  )
  .option(
    "--cfc-writeback-xattrs",
    "Enable temporary CFC writeback prepare/finalize xattrs for integration testing.",
  )
  .option(
    "--cfc-writeback-state <path:string>",
    "Path for persisted CFC writeback recovery state.",
  )
  .option(
    "--dangerously-allow-incompatible-schema",
    "Allow source-file writes that replace a piece with an incompatible schema.",
  )
  .option(
    "-s, --space <name:string>",
    "Space(s) to connect (repeatable, default: home).",
    { collect: true },
  )
  .example(
    cliText("cf fuse mount /tmp/cf-fuse"),
    "Mount with settings from CF_API_URL / CF_IDENTITY env vars.",
  )
  .example(
    cliText(
      `cf fuse mount /tmp/cf-fuse --api-url http://localhost:${ports.toolshed}`,
    ),
    "Mount with explicit API URL.",
  )
  .example(
    cliText("cf fuse mount /tmp/cf-fuse --background"),
    cliText("Mount in background; use 'cf fuse status' to check."),
  )
  .example(
    cliText("cf fuse mount /tmp/cf-fuse --allow-other"),
    cliText(
      "Linux only: export the mount to Docker or other users.",
    ),
  )
  .action(async (options, mountpoint) => {
    // globalEnv merges CF_API_URL / CF_IDENTITY into options automatically
    const apiUrl = options.apiUrl ?? "";
    const identity = options.identity ? resolve(options.identity) : "";
    const absMountpoint = resolve(mountpoint);

    // cliffy's integer type accepts any whole number; enforce the daemon's
    // range here so the error surfaces at the command line rather than in
    // the (possibly backgrounded) FUSE child.
    const attrcacheTimeout = options.attrcacheTimeout !== undefined
      ? String(options.attrcacheTimeout)
      : undefined;
    if (attrcacheTimeout !== undefined) {
      parseAttrcacheTimeoutSeconds(attrcacheTimeout);
    }

    if (identity) {
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(identity);
      } catch {
        throw new Error(`Identity file not found: ${identity}`);
      }
      if (!stat.isFile) {
        throw new Error(`Identity file not found: ${identity}`);
      }
    }

    // Ensure mountpoint exists
    try {
      await Deno.stat(absMountpoint);
    } catch {
      await Deno.mkdir(absMountpoint, { recursive: true });
    }

    const stateDir = defaultStateDir();
    const execCli = await ensureExecShim(stateDir, import.meta.url);
    const execPath = Deno.execPath();
    const execBase = basename(execPath);
    const isCompiledBinary = execBase !== "deno" && execBase !== "deno.exe";

    // The mount flags every spawn path forwards, whichever entrypoint runs.
    const mountFlags = {
      mountpoint: absMountpoint,
      apiUrl,
      identity,
      execCli,
      spaces: options.space ?? [],
      debug: options.debug,
      allowOther: options.allowOther,
      noattrcache: options.noattrcache,
      attrcacheTimeout,
      cfcMode: options.cfcMode,
      cfcAnnotations: options.cfcAnnotations,
      cfcXattrNamespace: options.cfcXattrNamespace,
      cfcWritebackXattrs: options.cfcWritebackXattrs,
      cfcWritebackState: options.cfcWritebackState,
      dangerouslyAllowIncompatibleSchema:
        options.dangerouslyAllowIncompatibleSchema,
    };

    let spawnCmd: string;
    let spawnArgs: string[];
    if (isCompiledBinary) {
      spawnCmd = execPath;
      spawnArgs = buildFuseBinaryArgs({
        subcommand: "fuse-daemon",
        ...mountFlags,
      });
    } else {
      spawnCmd = "deno";
      spawnArgs = buildFuseChildDenoArgs({
        modPath: fuseMod(import.meta.url),
        ...mountFlags,
      });
    }

    if (options.background) {
      // Derive log file path: /tmp/cf-fuse-<mountname>.log
      const logFile = `/tmp/cf-fuse-${basename(absMountpoint)}.log`;

      // The supervisor writes the mount state, because it is the process that
      // spawns the FUSE child and so the only one that knows both PIDs. It holds
      // write access to that one file, so the directory is prepared here.
      const statePath = await prepareMountStatePath(stateDir, absMountpoint);
      const childStatusPath = childStatusPathForStatePath(statePath);
      try {
        await Deno.remove(childStatusPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }

      const supervisorFlags = {
        ...mountFlags,
        logFile,
        statePath,
        supervisorStatusPath: childStatusPath,
      };
      spawnCmd = execPath;
      spawnArgs = isCompiledBinary
        ? buildFuseBinaryArgs({
          subcommand: "fuse-supervisor",
          ...supervisorFlags,
        })
        : buildBackgroundSupervisorDenoArgs({
          cliModPath: fuseSupervisorMod(import.meta.url),
          ...supervisorFlags,
        });

      // Detached background process. Its stdout is a pipe the supervisor passes
      // down to the FUSE child, which writes its readiness into it.
      const cmd = new Deno.Command(spawnCmd, {
        args: spawnArgs,
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      });
      const child = cmd.spawn();

      const pid = child.pid;
      try {
        await awaitBackgroundMountStartup(pid, statePath, {
          readiness: child.stdout,
          supervisorExit: child.status,
          childStatusPath,
        });
        // The mount is up and outlives this command, so stop holding the process
        // open for it. Unreferencing any earlier would also stop the readiness
        // read from holding it, and the command would exit mid-handshake.
        child.unref();
      } catch (error) {
        try {
          Deno.kill(pid, "SIGTERM");
        } catch {
          // Process may have already exited.
        }
        throw error;
      }

      console.log(`FUSE mounted in background (PID ${pid})`);
      console.log(`  mountpoint: ${absMountpoint}`);
      console.log(`  log:        ${logFile}`);
      console.log(
        cliText(
          `Use 'cf fuse status' to check, 'cf fuse unmount ${mountpoint}' to stop.`,
        ),
      );
    } else {
      // Foreground — inherit stdio, propagate exit code
      const logFile = `/tmp/cf-fuse-${basename(absMountpoint)}.log`;
      spawnArgs.push("--log-file", logFile);
      console.error(`FUSE log: ${logFile}`);

      const cmd = new Deno.Command(spawnCmd, {
        args: spawnArgs,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const child = cmd.spawn();
      let statePath: string;
      try {
        statePath = await writeMountState(stateDir, {
          pid: child.pid,
          mountpoint: absMountpoint,
          apiUrl,
          identity,
          startedAt: new Date().toISOString(),
          logFile,
        });
      } catch (error) {
        try {
          Deno.kill(child.pid, "SIGTERM");
        } catch {
          // Process may have already exited.
        }
        throw error;
      }

      await awaitForegroundMountExit(child, statePath);
    }
  })
  .reset()
  /* unmount */
  .command(
    "unmount <mountpoint:string>",
    "Unmount a FUSE filesystem.",
  )
  .action(async (_options, mountpoint) => {
    const { ok, message } = await runUnmount(mountpoint);
    console.log(message);
    if (!ok) Deno.exit(1);
  })
  .reset()
  /* status */
  .command("status", "Show active FUSE mounts.")
  .action(async () => {
    const stateDir = defaultStateDir();
    const entries = await readAllMountStates(stateDir);

    console.log(formatMountStatusTable(await buildMountStatusRows(entries)));
  });

export async function buildMountStatusRows(
  entries: Array<{ entry: MountStateEntry; path: string }>,
  deps: {
    isMountStateAlive?: (entry: MountStateEntry) => boolean;
    removeMountStateFile?: (path: string) => Promise<void>;
    readChildMountStatus?: (entry: MountStateEntry) => Promise<string>;
    isMountpointInTable?: (mountpoint: string) => Promise<MountTableState>;
  } = {},
): Promise<string[][]> {
  const isMountStateAliveFn = deps.isMountStateAlive ?? isMountStateAlive;
  const removeMountStateFileFn = deps.removeMountStateFile ??
    removeMountStateFile;
  const readChildMountStatusFn = deps.readChildMountStatus ??
    readChildMountStatus;
  const isMountpointInTableFn = deps.isMountpointInTable ?? isMountpointInTable;
  const rows: string[][] = [];

  for (const { entry, path } of entries) {
    // Query the mount table FIRST, before any PID reasoning. A dead daemon does
    // NOT imply the mount is gone: a severed mount outliving its daemon is the
    // exact case this row exists to surface. Only "absent + dead PID" is truly
    // stale and safe to sweep. PID liveness is a real filesystem-free check.
    const tableState = await isMountpointInTableFn(entry.mountpoint);
    const alive = isMountStateAliveFn(entry);

    if (tableState === "absent" && !alive) {
      // Mount gone AND no process serving it: nothing to show, sweep the file.
      await removeMountStateFileFn(path);
      continue;
    }

    let status: string;
    if (tableState === "present") {
      // Kernel mount exists. If a process still serves it, report its live
      // state; if the daemon is dead, the mount outlived it — surface "dead"
      // so the user knows there is a stale mount to clean up. Never sweep.
      status = alive
        ? (entry.childStatusPath
          ? await readChildMountStatusFn(entry)
          : "running")
        : "dead";
    } else if (tableState === "absent") {
      // Mount gone but the process lingers (alive). Surface it as dead; keep
      // the state file so the lingering process stays visible.
      status = "dead";
    } else {
      // Probe could not tell (unknown). Never destroy evidence on an unreadable
      // table: emit the row as "unknown" and keep the state file.
      status = "unknown";
    }
    rows.push([
      entry.mountpoint,
      String(entry.pid),
      entry.childPid === undefined ? "-" : String(entry.childPid),
      status,
      entry.startedAt,
      entry.logFile ?? "-",
    ]);
  }

  return rows;
}

export function formatMountStatusTable(rows: string[][]): string {
  if (rows.length === 0) return "No active FUSE mounts.";
  return [mountStatusHeader, ...rows.map((row) => row.join("\t"))].join("\n");
}

async function readChildMountStatus(entry: { childStatusPath?: string }) {
  if (!entry.childStatusPath) return "running";
  try {
    const status = parseChildSupervisorStatus(
      await Deno.readTextFile(entry.childStatusPath),
    );
    return status?.state ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Verify a PID belongs to a deno/fuse process before we SIGTERM it. */
async function verifyIsFuseProcess(pid: number): Promise<boolean> {
  try {
    const ps = new Deno.Command("ps", {
      args: ["-p", String(pid), "-o", "command="],
      stdout: "piped",
    });
    const out = await ps.output();
    const cmd = new TextDecoder().decode(out.stdout).trim();
    return isFuseProcessCommand(cmd);
  } catch {
    // ps failed — proceed cautiously and treat as unverified (skip kill).
    return false;
  }
}

const SYSTEM_UNMOUNT_TIMEOUT_MS = 5_000;

/**
 * Run the OS unmount for a mountpoint. `umount`/`fusermount3` tear down the
 * kernel mount entry; a non-zero exit (e.g. "Resource busy") is reported back
 * through `code`/`stderr` rather than swallowed.
 *
 * `umount` on a wedged mount can itself block indefinitely, so the child is
 * raced against a deadline. On timeout we return a non-zero result and abandon
 * the child (harmless — it holds no lock we need): the point is that runUnmount
 * always returns, so the "sudo umount -f" hint reliably prints instead of the
 * command hanging forever.
 */
export async function defaultSystemUnmount(
  mountpoint: string,
  opts: { command?: Deno.Command; timeoutMs?: number } = {},
): Promise<{ code: number; stderr: string }> {
  const cmd = opts.command ??
    (Deno.build.os === "darwin"
      ? new Deno.Command("umount", {
        args: [mountpoint],
        stdout: "null",
        stderr: "piped",
      })
      : new Deno.Command("fusermount3", {
        args: ["-u", mountpoint],
        stdout: "null",
        stderr: "piped",
      }));
  const timeoutMs = opts.timeoutMs ?? SYSTEM_UNMOUNT_TIMEOUT_MS;
  const timedOut = Symbol("timedOut");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let child: Deno.ChildProcess | undefined;
  try {
    child = cmd.spawn();
    const done = child.output().then((out) => ({
      code: out.code,
      stderr: new TextDecoder().decode(out.stderr),
    }));
    // If the deadline wins we abandon this promise; guard so its eventual
    // settlement is never an unhandled rejection.
    done.catch(() => {});
    const deadline = new Promise<typeof timedOut>((r) => {
      timer = setTimeout(() => r(timedOut), timeoutMs);
    });
    const result = await Promise.race([done, deadline]);
    if (result === timedOut) {
      // A wedged `umount` blocks in the kernel and won't die on SIGKILL until
      // its I/O returns, but unref() lets THIS process exit immediately rather
      // than hang waiting on the child — the whole point of the deadline.
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      child.unref();
      return { code: 1, stderr: "system unmount timed out" };
    }
    return result;
  } catch (error) {
    child?.unref();
    return {
      code: 1,
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Unmount a FUSE filesystem and report whether the mount is actually gone.
 *
 * The old flow reported success unconditionally: it only ran the system
 * unmount when the daemon PID was still alive, ignored the unmount exit code,
 * and printed "Unmounted" without re-checking. A severed mount whose daemon
 * had already died was declared unmounted while the kernel entry survived.
 *
 * This gates success on the OS mount table (`isMountpointInTable`) — the only
 * ground truth — and runs the system unmount whenever the table is not already
 * "absent", regardless of PID liveness.
 */
export async function runUnmount(
  mountpoint: string,
  deps: {
    readMountState?: (
      stateDir: string,
      mountpoint: string,
    ) => Promise<{ entry: MountStateEntry; path: string } | null>;
    isAlive?: (pid: number) => boolean;
    kill?: (pid: number, signal: Deno.Signal) => void;
    isMountpointInTable?: (mountpoint: string) => Promise<MountTableState>;
    systemUnmount?: (
      mountpoint: string,
    ) => Promise<{ code: number; stderr: string }>;
    removeMountStateFile?: (path: string) => Promise<void>;
    verifyIsFuseProcess?: (pid: number) => Promise<boolean>;
    stateDir?: string;
    log?: (message: string) => void;
  } = {},
): Promise<{ ok: boolean; message: string }> {
  const absMountpoint = resolve(mountpoint);
  // Default lookup enumerates state files and matches lexically. It must NOT
  // fall back to readMountState(), whose hashing path realPaths the mountpoint
  // leaf — a filesystem op that hangs on the very stale mount we are here to
  // tear down. readAllMountStates() reads entries without any realPath, and
  // every entry is written with resolve(mountpoint), so a resolve() compare
  // finds it. The dep stays injectable for tests.
  const readMountStateFn = deps.readMountState ??
    (async (dir: string, mp: string) => {
      const all = await readAllMountStates(dir);
      return all.find((s) => s.entry.mountpoint === resolve(mp)) ?? null;
    });
  const isAliveFn = deps.isAlive ?? isAlive;
  const killFn = deps.kill ??
    ((pid: number, signal: Deno.Signal) => Deno.kill(pid, signal));
  const isMountpointInTableFn = deps.isMountpointInTable ?? isMountpointInTable;
  const systemUnmountFn = deps.systemUnmount ?? defaultSystemUnmount;
  const removeMountStateFileFn = deps.removeMountStateFile ??
    removeMountStateFile;
  const verifyIsFuseProcessFn = deps.verifyIsFuseProcess ?? verifyIsFuseProcess;
  const stateDir = deps.stateDir ?? defaultStateDir();
  const log = deps.log ?? ((message: string) => console.log(message));

  const pidFile = await readMountStateFn(stateDir, absMountpoint);

  const targetPid = pidFile && isAliveFn(pidFile.entry.pid)
    ? pidFile.entry.pid
    : pidFile?.entry.childPid;

  // 1. Graceful SIGTERM + poll, guarded by a ps check that the PID is a FUSE
  //    process so we never signal an unrelated PID a stale state file points at.
  if (pidFile && targetPid !== undefined && isAliveFn(targetPid)) {
    if (await verifyIsFuseProcessFn(targetPid)) {
      log(`Sending SIGTERM to PID ${targetPid}...`);
      try {
        killFn(targetPid, "SIGTERM");
        // Wait briefly for the supervisor to terminate after child cleanup.
        for (let i = 0; i < 20 && isAliveFn(targetPid); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
      } catch {
        // Process may have already exited.
      }
    } else if (isAliveFn(targetPid)) {
      log(
        `PID ${targetPid} does not appear to be a FUSE process; skipping kill.`,
      );
    }
  }

  // 2. Consult the mount table. If the mount is still listed ("present") — or
  //    the probe could not tell ("unknown") — run the system unmount even if no
  //    daemon PID is alive: a severed mount whose daemon already died still
  //    needs its kernel entry torn down.
  const before = await isMountpointInTableFn(absMountpoint);
  if (before !== "absent") {
    log("Mount still present in table, running system unmount...");
    const result = await systemUnmountFn(absMountpoint);
    if (result.code !== 0) {
      const detail = result.stderr.trim();
      log(`System unmount exited ${result.code}${detail ? `: ${detail}` : ""}`);
    }
  }

  // 3. Ground truth: success iff the mount is now absent from the table.
  const after = await isMountpointInTableFn(absMountpoint);
  if (after === "absent") {
    if (pidFile) await removeMountStateFileFn(pidFile.path);
    return { ok: true, message: `Unmounted ${absMountpoint}` };
  }

  // Still mounted (or still unknown): do NOT remove the state file — the mount
  // is real and the user needs the row to find and force-clean it.
  return {
    ok: false,
    message:
      `${absMountpoint} is still mounted. Try: sudo umount -f ${absMountpoint}`,
  };
}
