// mod.ts — FUSE filesystem entry point
//
// Usage:
//   deno run --unstable-ffi --allow-ffi --allow-read --allow-write --allow-env --allow-net \
//     runtime/fuse/mod.ts /tmp/cf-fuse [--api-url URL --space NAME --identity PATH]
//
// Supports multiple spaces. --space can be repeated or omitted (defaults to "home").
// Unknown space names are resolved on-demand via lookup.

import { parseArgs } from "@std/cli/parse-args";

import { describeFailure } from "@commonfabric/js-values/describe-failure";

import type { CfcXattrNamespace } from "./annotations.ts";
import { CellBridge, type CellBridgeOptions } from "./cell-bridge.ts";
import {
  type CfcEnforcementMode,
  CfcWritebackStore,
  resolveCfcMode,
  shouldEnableCfcAnnotations,
} from "./cfc-writeback.ts";
import {
  connectReverseInvalidation,
  type InvalidationSource,
} from "./invalidation.ts";
import {
  buildMountFuseArgs,
  type MountCacheOptions,
  resolveMountCacheOptions,
} from "./mount-options.ts";
import {
  createFuseOperations,
  dumpOpRing,
  type FuseBridge,
  isConnectionWriteFailure,
  registerFuseOperations,
} from "./operations.ts";
import {
  type FusePlatform,
  getPlatform,
  type LoadedFuse,
  type MountHandle,
} from "./platform.ts";
import { FsTree } from "./tree.ts";

const encoder = new TextEncoder();

export const DEFAULT_CFC_XATTR_NAMESPACE: CfcXattrNamespace = "both";

export function parseCfcXattrNamespace(
  value: string,
): CfcXattrNamespace | undefined {
  if (value === "trusted" || value === "compat" || value === "both") {
    return value;
  }
  return undefined;
}

type EnvReader = Pick<typeof Deno.env, "get">;

function envValue(env: EnvReader, name: string): string | undefined {
  const value = env.get(name);
  return value && value.trim() !== "" ? value : undefined;
}

export function defaultCfcWritebackStatePath(
  mountpoint: string,
  env: EnvReader = Deno.env,
): string {
  const explicitStateDir = envValue(env, "CF_CFC_WRITEBACK_STATE_DIR");
  const xdgStateHome = envValue(env, "XDG_STATE_HOME");
  const home = envValue(env, "HOME");
  const stateDir = explicitStateDir ??
    (xdgStateHome
      ? `${xdgStateHome}/commonfabric-fuse`
      : `${home ?? "."}/.cache/commonfabric-fuse`);
  const safeMount = encodeURIComponent(mountpoint)
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 120) || "mount";
  return `${stateDir}/cfc-writeback-${safeMount}.json`;
}

type SupervisorStatusState =
  | "starting"
  | "mounted"
  | "failed"
  | "exiting"
  | "exited";

export interface SupervisorStatusWriterOptions {
  statusPath: string;
  pid: number;
  mountpoint: string;
  startedAt: string;
  now?: () => string;
  writeTextFile?: (path: string, data: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
}

export type SupervisorStatusWriter = (
  state: SupervisorStatusState,
  extra?: Record<string, unknown>,
) => Promise<void>;

/**
 * Build the function that writes the daemon's supervisor state to its status
 * file, the record `cf fuse status` reads.
 *
 * The states form a lifecycle, and the calls announcing them come from places
 * that do not coordinate: the startup path, the readiness report, the heartbeat
 * and the signal handler. Two properties keep a concurrent reader from ever
 * seeing a wrong file. Each write replaces the file by writing a scratch file
 * and renaming it over the target, so a reader woken mid-write sees a complete
 * document rather than a truncated one. And the writes are serialized through a
 * queue, so the file ends on the state of the most recent call: renames issued
 * concurrently could otherwise complete in either order and let a heartbeat
 * still in flight replace a terminal state, leaving the file claiming a mount
 * that has already gone.
 */
export function createSupervisorStatusWriter(
  options: SupervisorStatusWriterOptions,
): SupervisorStatusWriter {
  const writeTextFile = options.writeTextFile ?? Deno.writeTextFile;
  const rename = options.rename ?? Deno.rename;
  const remove = options.remove ?? Deno.remove;
  const now = options.now ?? (() => new Date().toISOString());
  let queue: Promise<void> = Promise.resolve();
  let writes = 0;

  const publish = async (document: string): Promise<void> => {
    // The scratch name carries the PID and a counter, so a daemon left over
    // from an earlier mount at this path cannot share it.
    const pendingPath = `${options.statusPath}.${options.pid}.${writes++}.tmp`;
    try {
      await writeTextFile(pendingPath, document);
      await rename(pendingPath, options.statusPath);
    } catch (error) {
      await remove(pendingPath).catch(() => undefined);
      throw error;
    }
  };

  return (state, extra = {}) => {
    // Built at call time, so `updatedAt` records when the state was reached
    // rather than when its turn in the queue came up.
    const document = JSON.stringify(
      {
        state,
        pid: options.pid,
        mountpoint: options.mountpoint,
        startedAt: options.startedAt,
        updatedAt: now(),
        ...extra,
      },
      null,
      2,
    );
    const write = queue.then(() => publish(document));
    // A failed write must neither stop later states from being published nor
    // surface through the queue as an unhandled rejection. The caller still
    // sees the failure through the promise returned here.
    queue = write.catch(() => undefined);
    return write;
  };
}

/**
 * Report a supervisor state to both sinks. `write` records it in the status file
 * that `cf fuse status` reads; `publish` announces it on the readiness channel a
 * background mount's parent blocks on. The announcement goes out in a `finally`,
 * so a failed status write cannot strand a parent waiting on the channel, and
 * the write's error still reaches the caller.
 */
export async function announceSupervisorState(
  write: SupervisorStatusWriter,
  publish: SupervisorStatusWriter,
  state: SupervisorStatusState,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await write(state, extra);
  } finally {
    await publish(state, extra);
  }
}

export async function writeFailedSupervisorStartupStatus(
  error: unknown,
  writeSupervisorStatus: (
    state: "failed",
    extra?: Record<string, unknown>,
  ) => Promise<void>,
): Promise<void> {
  console.error(String(error));
  await writeSupervisorStatus("failed", { error: String(error) }).catch(() => {
    // Best effort; startup failure is already being reported by process exit.
  });
}

/** The bridge members the daemon uses: those its operations call, and setup. */
export type MountBridge =
  & FuseBridge
  & InvalidationSource
  & Pick<CellBridge, "init" | "setDebug" | "initStatus">;

/** What `main()` takes from the process it runs in. */
export interface MainHost {
  /** Loads the FUSE bindings for the operating system. */
  getPlatform(): Promise<FusePlatform>;

  /** Makes the bridge that projects spaces into `tree`. */
  createBridge(
    tree: FsTree,
    execCli: string,
    options: CellBridgeOptions,
  ): MountBridge;

  /** Ends the process with `code`. */
  exit(code: number): never;
}

const PROCESS_HOST: MainHost = {
  getPlatform: () => getPlatform(),
  createBridge: (tree, execCli, options) =>
    new CellBridge(tree, execCli, options),
  exit: (code) => Deno.exit(code),
};

/**
 * Logs errors that escape the daemon instead of letting them end it, until
 * the returned value is disposed. Pattern recomputation and cell operations
 * can throw from setTimeout callbacks (e.g. "Cannot create cell link - space
 * required"), and those errors should be logged, not fatal.
 */
export function logEscapedErrors(): Disposable {
  const logUnhandledRejection = (e: PromiseRejectionEvent) => {
    dumpOpRing();
    console.error("[FUSE] Unhandled promise rejection:", e.reason);
    e.preventDefault();
  };
  const logUncaughtError = (e: ErrorEvent) => {
    dumpOpRing();
    console.error("[FUSE] Uncaught error:", e.error ?? e.message);
    e.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", logUnhandledRejection);
  globalThis.addEventListener("error", logUncaughtError);
  return {
    [Symbol.dispose]() {
      globalThis.removeEventListener(
        "unhandledrejection",
        logUnhandledRejection,
      );
      globalThis.removeEventListener("error", logUncaughtError);
    },
  };
}

/**
 * Runs the FUSE daemon: mounts the filesystem at the mountpoint `argv` names
 * and serves it until the session ends. Whatever it installs in the process,
 * such as listeners and a console redirected to a log file, it removes before
 * it returns.
 */
export async function main(
  argv: string[] = Deno.args,
  host: MainHost = PROCESS_HOST,
) {
  using cleanup = new DisposableStack();

  const args = parseArgs(argv, {
    string: [
      "api-url",
      "space",
      "identity",
      "exec-cli",
      "log-file",
      "supervisor-status",
      "cfc-xattr-namespace",
      "cfc-mode",
      "cfc-writeback-state",
      "attrcache-timeout",
    ],
    boolean: [
      "debug",
      "cfc-annotations",
      "cfc-writeback-xattrs",
      "allow-other",
      "noattrcache",
      "dangerously-allow-incompatible-schema",
    ],
    collect: ["space"],
    default: {
      "api-url": Deno.env.get("CF_API_URL") ?? "",
      space: [] as string[],
      identity: Deno.env.get("CF_IDENTITY") ?? "",
      "exec-cli": "",
      "log-file": "",
      "supervisor-status": "",
      "cfc-xattr-namespace": DEFAULT_CFC_XATTR_NAMESPACE,
      "cfc-mode": "",
      "cfc-writeback-state": "",
      "attrcache-timeout": "",
      debug: false,
      "cfc-annotations": false,
      "cfc-writeback-xattrs": false,
      "allow-other": false,
      noattrcache: false,
      "dangerously-allow-incompatible-schema": false,
    },
  });

  // Redirect (or tee) console output to a log file.
  // Background mounts: replace console entirely (no TTY).
  // Foreground mounts: tee to both log file and original stderr (TTY present).
  const logFilePath = args["log-file"] as string;
  if (logFilePath) {
    const logFile = cleanup.use(
      await Deno.open(logFilePath, { create: true, append: true }),
    );
    const enc = new TextEncoder();
    const writeLog = (msg: string) => {
      try {
        logFile.writeSync(enc.encode(msg + "\n"));
      } catch {
        // Ignore write errors (disk full, etc.)
      }
    };
    const isTTY = Deno.stderr.isTerminal();
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    cleanup.defer(() => {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
    });
    console.log = (...a: unknown[]) => {
      const msg = a.map(String).join(" ");
      writeLog(msg);
      if (isTTY) origLog.call(console, ...a);
    };
    console.error = (...a: unknown[]) => {
      const msg = a.map(String).join(" ");
      writeLog(msg);
      if (isTTY) origError.call(console, ...a);
    };
    console.warn = (...a: unknown[]) => {
      const msg = a.map(String).join(" ");
      writeLog(msg);
      if (isTTY) origWarn.call(console, ...a);
    };
  }

  const mountpoint = args._[0] as string;
  if (!mountpoint) {
    console.error(
      "Usage: mod.ts <mountpoint> [--api-url URL] [--space NAME ...] [--identity PATH]",
    );
    host.exit(1);
  }
  const supervisorStatusPath = String(args["supervisor-status"] ?? "");
  const supervisorStatusStartedAt = new Date().toISOString();
  // The status file is the record `cf fuse status` reads later. The heartbeat
  // refreshes it; readers take a snapshot whenever they ask. The writer keeps
  // those snapshots whole and in order — see createSupervisorStatusWriter.
  const writeSupervisorStatus: SupervisorStatusWriter = supervisorStatusPath
    ? createSupervisorStatusWriter({
      statusPath: supervisorStatusPath,
      pid: Deno.pid,
      mountpoint,
      startedAt: supervisorStatusStartedAt,
    })
    : () => Promise.resolve();
  // A background mount's parent holds the read end of this process's stdout and
  // blocks on it, so one line here wakes it on the transition itself. Only the
  // states a starting mount can settle on are published; the heartbeat stays out
  // of the channel. A parent that has already exited leaves no reader, which
  // makes the write fail rather than the mount.
  async function publishSupervisorState(
    state: SupervisorStatusState,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (!supervisorStatusPath) return;
    const line = `${
      JSON.stringify({
        state,
        pid: Deno.pid,
        mountpoint,
        startedAt: supervisorStatusStartedAt,
        updatedAt: new Date().toISOString(),
        ...extra,
      })
    }\n`;
    const bytes = new TextEncoder().encode(line);
    try {
      for (let written = 0; written < bytes.length;) {
        written += await Deno.stdout.write(bytes.subarray(written));
      }
    } catch {
      // No reader: the mount continues unobserved.
    }
  }
  // Record the state in the status file, then announce it on the pipe. See
  // announceSupervisorState for why the announcement runs even when the record
  // fails.
  const reportSupervisorState = (
    state: SupervisorStatusState,
    extra: Record<string, unknown> = {},
  ): Promise<void> =>
    announceSupervisorState(
      writeSupervisorStatus,
      publishSupervisorState,
      state,
      extra,
    );

  /**
   * Report a startup failure and stop.
   *
   * The message goes to stderr and to the supervisor status channel. A
   * background mount's stderr goes nowhere its parent reads, and the channel
   * is what `cf fuse mount` blocks on.
   */
  const failStartup = async (message: string): Promise<never> => {
    await writeFailedSupervisorStartupStatus(
      `[FUSE] ${message}`,
      reportSupervisorState,
    );
    return host.exit(1);
  };

  // CF_FUSE_DEBUG=1 enables debug logging even when --debug isn't passed.
  // --debug is forwarded through every spawn layer (mount -> supervisor ->
  // daemon child), and env vars are inherited too, so either switch works.
  const debug = args.debug || Deno.env.get("CF_FUSE_DEBUG") === "1";
  const dangerouslyAllowIncompatibleSchema = Boolean(
    args["dangerously-allow-incompatible-schema"],
  );
  let cfcMode: CfcEnforcementMode;
  try {
    cfcMode = resolveCfcMode({
      cliMode: String(args["cfc-mode"] ?? ""),
      envMode: Deno.env.get("CF_CFC_MODE") ?? undefined,
    });
  } catch (e) {
    return await failStartup(describeFailure(e));
  }
  const cfcAnnotationsEnabled = shouldEnableCfcAnnotations({
    annotationsRequested: Boolean(args["cfc-annotations"]),
    mode: cfcMode,
  });
  const cfcWritebackXattrs = Boolean(args["cfc-writeback-xattrs"]);
  const cfcXattrNamespace = parseCfcXattrNamespace(
    String(args["cfc-xattr-namespace"] ?? DEFAULT_CFC_XATTR_NAMESPACE),
  );
  if (!cfcXattrNamespace) {
    return await failStartup(
      `Unknown --cfc-xattr-namespace=${
        args["cfc-xattr-namespace"]
      }; expected trusted, compat, or both`,
    );
  }

  let cacheOptions: MountCacheOptions;
  try {
    cacheOptions = resolveMountCacheOptions({
      noattrcache: Boolean(args.noattrcache),
      attrcacheTimeout: String(args["attrcache-timeout"] ?? ""),
      attrcacheTimeoutGiven: argv.some((arg) =>
        arg === "--attrcache-timeout" || arg.startsWith("--attrcache-timeout=")
      ),
    });
  } catch (e) {
    return await failStartup(describeFailure(e));
  }

  try {
    await writeSupervisorStatus("starting");
  } catch (error) {
    console.error(`[FUSE] Unable to write supervisor status: ${error}`);
    host.exit(1);
  }
  const requestedCfcWritebackState = String(args["cfc-writeback-state"] ?? "");
  const cfcWritebackStatePath = requestedCfcWritebackState ||
    (cfcWritebackXattrs || cfcMode !== "disabled"
      ? defaultCfcWritebackStatePath(mountpoint)
      : undefined);
  let cfcWritebacks: CfcWritebackStore;
  try {
    cfcWritebacks = new CfcWritebackStore({
      storagePath: cfcWritebackStatePath,
    });
  } catch (e) {
    return await failStartup(describeFailure(e));
  }

  let platform: FusePlatform;
  let fuse: LoadedFuse;
  try {
    // Ensure mountpoint exists
    try {
      Deno.statSync(mountpoint);
    } catch {
      Deno.mkdirSync(mountpoint, { recursive: true });
    }

    // Open libfuse via platform abstraction
    platform = await host.getPlatform();
    fuse = platform.openFuse();
  } catch (e) {
    return await failStartup(describeFailure(e));
  }
  const tree = new FsTree();
  const apiUrl = args["api-url"];
  const bridge = apiUrl
    ? host.createBridge(tree, args["exec-cli"] || "", {
      cfcAnnotations: cfcAnnotationsEnabled,
      statusProvider: () => {
        const { writes, cfc } = operations.status();
        return { writes, logFile: logFilePath || null, cfc };
      },
      onCfcProjectionRebuilt: () => operations.reconcileCfcWritebacks(),
    })
    : null;
  const operations = createFuseOperations({
    tree,
    bridge,
    fuse,
    platform,
    cfcMode,
    cfcAnnotationsEnabled,
    cfcWritebackXattrs,
    cfcXattrNamespace,
    cfcWritebacks,
    dangerouslyAllowIncompatibleSchema,
  });

  // A lost connection that escapes a write is counted as a failed write,
  // which also marks the mount disconnected.
  const recordRejectedWrite = (event: PromiseRejectionEvent) => {
    if (!isConnectionWriteFailure(event.reason)) return;
    operations.recordAsyncWriteFailure(
      "unhandled async write failure",
      event.reason,
    );
    event.preventDefault();
  };
  const recordFailedWrite = (event: ErrorEvent) => {
    const error = event.error ?? event.message;
    if (!isConnectionWriteFailure(error)) return;
    operations.recordAsyncWriteFailure("uncaught async write failure", error);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", recordRejectedWrite);
  globalThis.addEventListener("error", recordFailedWrite);
  cleanup.defer(() => {
    globalThis.removeEventListener("unhandledrejection", recordRejectedWrite);
    globalThis.removeEventListener("error", recordFailedWrite);
  });

  // Populate tree
  try {
    if (bridge) {
      bridge.init({
        apiUrl,
        identity: args.identity || "",
      });
      bridge.setDebug(debug);
      bridge.initStatus();

      // Connect initial spaces (default: "home")
      const spaces = (args.space as string[]).length > 0
        ? (args.space as string[])
        : ["home"];
      for (const spaceName of spaces) {
        await bridge.connectSpace(spaceName);
        operations.reconcileCfcWritebacks();
        console.log(`Connected space: ${spaceName}`);
      }
    } else {
      tree.addFile(tree.rootIno, "hello.txt", "Hello from FUSE!\n", "string");
      console.log("Static mode: hello.txt");
    }
  } catch (e) {
    return await failStartup(describeFailure(e));
  }

  // Mount
  const fuseArgs = buildMountFuseArgs({
    os: Deno.build.os,
    provider: fuse.provider,
    allowOther: Boolean(args["allow-other"]),
    cfcWritebackXattrs,
    ...cacheOptions,
  });
  const { argsBuf, argv: _argv, encodedArgs: _ea } = platform.createFuseArgs(
    fuseArgs,
  );

  const mountpointBuf = encoder.encode(mountpoint + "\0");

  const registered = registerFuseOperations(
    platform,
    operations.handlers,
    cfcWritebackXattrs,
  );

  let handle: MountHandle;
  try {
    handle = fuse.mount(
      mountpointBuf,
      argsBuf,
      registered.table,
      BigInt(platform.OPS_SIZE),
    );
  } catch (e) {
    return await failStartup(describeFailure(e));
  }

  let unmounting = false;

  // Kernel cache invalidation for subscriptions, when a bridge is present.
  const invalidation = bridge
    ? connectReverseInvalidation(bridge, {
      invalidateEntry: (parentIno, nameBuf, nameLen) =>
        fuse.symbols.fuse_lowlevel_notify_inval_entry(
          handle.notifyTarget,
          parentIno,
          nameBuf,
          nameLen,
        ),
      // off=0, len=-1 invalidates all cached data for the inode.
      invalidateInode: (ino) =>
        fuse.symbols.fuse_lowlevel_notify_inval_inode(
          handle.notifyTarget,
          ino,
          0n,
          -1n,
        ),
      isUnmounting: () => unmounting,
      debug,
      pendingReplyCount: () => operations.pendingReplyCount(),
    })
    : undefined;
  operations.onPendingRepliesDrained = invalidation?.repliesDrained;

  // Cleanup on signal
  function unmount() {
    if (unmounting) return;
    unmounting = true;
    console.log("\nUnmounting...");
    writeSupervisorStatus("exiting").catch(() => undefined);
    fuse.unmount(handle, mountpointBuf);
  }

  Deno.addSignalListener("SIGINT", unmount);
  Deno.addSignalListener("SIGTERM", unmount);
  cleanup.defer(() => {
    Deno.removeSignalListener("SIGINT", unmount);
    Deno.removeSignalListener("SIGTERM", unmount);
  });

  // Run FUSE event loop (nonblocking: true → returns Promise)
  const sessionLoop = fuse.symbols.fuse_session_loop(handle.session);

  // Readiness is reported here rather than earlier: the session loop is
  // dispatched and the signal handlers are installed, so a caller that has seen
  // `mounted` has a kernel mount that serves requests and unmounts cleanly on
  // SIGTERM. Because the announcement carries that, the caller needs no timed
  // confirmation after it. The guard skips the announcement when a signal has
  // already begun tearing the mount down; a signal that lands during the
  // announcement itself still publishes it, but that mount then unmounts
  // through the handler installed above.
  if (!unmounting) {
    await reportSupervisorState("mounted").catch((error) => {
      console.warn(
        `[FUSE] Unable to write mounted supervisor status: ${error}`,
      );
    });
  }
  const supervisorHeartbeat = supervisorStatusPath
    ? setInterval(() => {
      if (unmounting) return;
      writeSupervisorStatus("mounted").catch(() => undefined);
    }, 1_000)
    : undefined;

  console.log(`Mounted at ${mountpoint}`);
  console.log("Press Ctrl+C to unmount");

  const result = await sessionLoop;
  console.log(`FUSE loop exited (code ${result})`);
  if (supervisorHeartbeat !== undefined) clearInterval(supervisorHeartbeat);
  await writeSupervisorStatus("exited", { exitCode: result }).catch(() => {
    // Best effort during shutdown.
  });

  // Stop the reverse-invalidation queue before the session is destroyed. The
  // session loop can exit without a signal — an external unmount or a kernel
  // abort — leaving `unmounting` false, so the queue is closed here rather than
  // relying on the signal handler, and no notify call runs against the session
  // after it is destroyed.
  await invalidation?.close();

  // Final cleanup
  fuse.cleanup(handle, mountpointBuf, unmounting);
  registered.close();
  console.log("Cleaned up.");
}

if (import.meta.main) {
  // For the life of the process, including whatever settles after `main()`
  // returns.
  logEscapedErrors();
  await main();
}
