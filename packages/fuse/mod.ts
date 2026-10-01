// mod.ts — FUSE filesystem entry point
//
// Usage:
//   deno run --unstable-ffi --allow-ffi --allow-read --allow-write --allow-env --allow-net \
//     packages/fuse/mod.ts /tmp/cf-fuse [--api-url URL --space NAME --identity PATH]
//
// Supports multiple spaces. --space can be repeated or omitted (defaults to "home").
// Unknown space names are resolved on-demand via lookup.

import { parseArgs } from "@std/cli/parse-args";

import type { PatternUpdateReceipt } from "@commonfabric/piece/ops";
import { linkRefFrom } from "@commonfabric/runner/shared";

import {
  type CfcXattrNamespace,
  getCfcXattrValue,
  listCfcXattrNames,
} from "./annotations.ts";
import {
  CellBridge,
  type HandlerTarget,
  type SourceWritePath,
  type WritePath,
} from "./cell-bridge.ts";
import {
  applyPreparedCreate,
  applyPreparedExistingWrite,
  applyPreparedMetadataMutation,
  applyPreparedParent,
  applyPreparedSymlink,
  authorizeCreateWriteback,
  authorizeExistingWriteback,
  authorizeMetadataWriteback,
  authorizeNamespaceMutationWriteback,
  authorizeSymlinkWriteback,
  CFC_WRITEBACK_FINALIZE_XATTR,
  CFC_WRITEBACK_PREPARE_XATTR,
  type CfcEnforcementMode,
  type CfcExistingWritebackOperation,
  type CfcMetadataLabelKey,
  type CfcNamespaceMutationWritebackOperation,
  type CfcPreparedWriteback,
  CfcWritebackStore,
  isCfcEnforcing,
  metadataFieldsForSetattrFlags,
  normalizeCfcWritebackXattrName,
  resolveCfcMode,
  safeReconcileCfcWritebacks,
  shouldEnableCfcAnnotations,
} from "./cfc-writeback.ts";
import {
  type DirectorySnapshotEntry,
  replyWithRetainedState,
  visitDirectoryEntries,
} from "./directory-handles.ts";
import {
  handleHasBufferedContent,
  handleHasPendingChanges,
  HandleMap,
  type HandleState,
  validateVirtualFileRange,
} from "./handles.ts";
import { ReverseInvalidationQueue } from "./invalidation.ts";
import {
  buildMountFuseArgs,
  type MountCacheOptions,
  resolveMountCacheOptions,
} from "./mount-options.ts";
import {
  closeKernelFileHandle,
  createFuseOperationState,
} from "./operation-wiring.ts";
import { decodeFuseComponent, encodeFusePathSegments } from "./path-codec.ts";
import { finalizeCommittedSourceWrite } from "./source-write-finalize.ts";
import {
  EACCES,
  EFBIG,
  EINVAL,
  EIO,
  EISDIR,
  ENOENT,
  ENOTDIR,
  ERANGE,
  EROFS,
  EXDEV,
  FILE_MODE_RW,
  FUSE_SET_ATTR_SIZE,
  getPlatform,
  O_RDWR,
  O_WRONLY,
  readCString,
} from "./platform.ts";
import { buildNodeStat, getMountOwnership } from "./stat.ts";
import { FsTree } from "./tree.ts";

const encoder = new TextEncoder();
// Operation ring buffer — last 50 ops for crash diagnostics
const OP_RING: string[] = [];
const OP_RING_SIZE = 50;
function logOp(name: string, detail: string): void {
  const entry = `${Date.now()} ${name} ${detail}`;
  if (OP_RING.length >= OP_RING_SIZE) OP_RING.shift();
  OP_RING.push(entry);
}
function dumpOpRing(): void {
  console.error("[fuse:crash] Last operations:");
  for (const e of OP_RING) console.error("  " + e);
}

// Prevent uncaught errors from crashing the FUSE daemon.
// Pattern recomputation and cell operations can throw from setTimeout
// callbacks (e.g. "Cannot create cell link - space required"). These
// errors should be logged, not fatal.
globalThis.addEventListener("unhandledrejection", (e) => {
  dumpOpRing();
  console.error("[FUSE] Unhandled promise rejection:", e.reason);
  e.preventDefault();
});

globalThis.addEventListener("error", (e) => {
  dumpOpRing();
  console.error("[FUSE] Uncaught error:", e.error ?? e.message);
  e.preventDefault();
});

type FusePromiseRejectionEvent = Event & {
  readonly reason?: unknown;
  preventDefault(): void;
};

type FuseErrorEvent = Event & {
  readonly error?: unknown;
  readonly message?: string;
  preventDefault(): void;
};

type HandleWriteTarget =
  | { kind: "handler"; target: HandlerTarget }
  | { kind: "value"; target: WritePath }
  | { kind: "source"; target: SourceWritePath }
  | { kind: "ignored" };

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

export function decodeFuseNamespaceName(name: string): string {
  return decodeFuseComponent(name);
}

export function appendDecodedJsonPath(
  basePath: readonly (string | number)[],
  name: string,
): (string | number)[] {
  return [...basePath, decodeFuseNamespaceName(name)];
}

export function sourceRelPathToTreeSegments(relPath: string): string[] {
  return encodeFusePathSegments(relPath.split("/"));
}

/**
 * Decode a write bound for a pattern's source package, or `undefined` when the
 * bytes are not valid UTF-8 text.
 *
 * A source package holds text, so a write that is not text has no faithful
 * representation in it. Decoding strictly reports that instead of substituting
 * replacement characters, which would store something other than what was
 * written. A byte order mark is content and is kept, since an attached data
 * file is stored byte-for-byte.
 */
export function decodeSourceWriteText(
  buffer: Uint8Array,
): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(buffer);
  } catch {
    return undefined;
  }
}

export function bufferForNoHandleTruncate(
  content: Uint8Array,
  newSize: number,
): Uint8Array {
  if (newSize <= 0) return new Uint8Array(0);
  return content.slice(0, Math.min(newSize, content.length));
}

export function writeUnavailableErrno(
  bridge: Pick<CellBridge, "disconnected"> | null | undefined,
): number {
  return bridge?.disconnected ? EROFS : EACCES;
}

export function disconnectedWriteErrno(
  bridge: Pick<CellBridge, "disconnected"> | null | undefined,
): number | null {
  return bridge?.disconnected ? EROFS : null;
}

export function isConnectionWriteFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("transport closed") ||
    msg.includes("ConnectionError") ||
    msg.includes("connection refused") ||
    msg.includes("failed to connect to WebSocket");
}

export function cfcWritebackXattrResultErrno(
  result: { ok: true } | { ok: false; reason: string },
  errnos: { enotsup: number },
): number {
  if (result.ok) return 0;
  return result.reason === "unsupported writeback xattr"
    ? errnos.enotsup
    : EINVAL;
}

export function rootSpaceLookupNames(name: string): {
  spaceName: string;
  directoryName: string;
} {
  const spaceName = decodeFuseNamespaceName(name);
  return {
    spaceName,
    directoryName: encodeFusePathSegments([spaceName])[0],
  };
}

function readBuffer(ptr: Deno.PointerValue, size: bigint): Uint8Array {
  const length = Number(size);
  const data = new Uint8Array(length);
  if (!ptr || length === 0) return data;
  new Deno.UnsafePointerView(ptr).copyInto(data);
  return data;
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

export async function main(argv: string[] = Deno.args) {
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
    const logFile = await Deno.open(logFilePath, {
      create: true,
      append: true,
    });
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
    Deno.exit(1);
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
    return Deno.exit(1);
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
    return await failStartup(e instanceof Error ? e.message : String(e));
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
    return await failStartup(e instanceof Error ? e.message : String(e));
  }

  try {
    await writeSupervisorStatus("starting");
  } catch (error) {
    console.error(`[FUSE] Unable to write supervisor status: ${error}`);
    Deno.exit(1);
  }
  const requestedCfcWritebackState = String(args["cfc-writeback-state"] ?? "");
  const cfcWritebackStatePath = requestedCfcWritebackState ||
    (cfcWritebackXattrs || cfcMode !== "disabled"
      ? defaultCfcWritebackStatePath(mountpoint)
      : undefined);
  let bridge: CellBridge | null = null;
  const cfcWritebacks = new CfcWritebackStore({
    storagePath: cfcWritebackStatePath,
  });
  const cfcDiagnostics: string[] = [];

  let platform: Awaited<ReturnType<typeof getPlatform>>;
  let fuse: ReturnType<Awaited<ReturnType<typeof getPlatform>>["openFuse"]>;
  try {
    // Ensure mountpoint exists
    try {
      Deno.statSync(mountpoint);
    } catch {
      Deno.mkdirSync(mountpoint, { recursive: true });
    }

    // Open libfuse via platform abstraction
    platform = await getPlatform();
    fuse = platform.openFuse();
  } catch (e) {
    await writeFailedSupervisorStartupStatus(e, reportSupervisorState);
    Deno.exit(1);
  }
  const {
    STAT_SIZE,
    ENTRY_PARAM_SIZE,
    OPS_SIZE,
    OPS_OFFSETS,
    STAT_ST_SIZE_OFFSET,
    writeStat,
    writeEntryParam,
    readFileInfo,
    writeFileInfo,
    O_TRUNC,
    ENODATA,
    ENOTSUP,
  } = platform;

  // Create filesystem tree
  const tree = new FsTree();
  const mountOwnership = getMountOwnership();

  const scheduledFlushes = new WeakMap<
    HandleState,
    ReturnType<typeof setTimeout>
  >();

  const writeStats = {
    opened: 0,
    written: 0,
    flushed: 0,
    flushErrors: 0,
    lastError: null as string | null,
    lastErrorAt: null as string | null,
  };

  function noteWriteFailure(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    writeStats.flushErrors++;
    writeStats.lastError = msg;
    writeStats.lastErrorAt = new Date().toISOString();
    if (bridge && !bridge.disconnected && isConnectionWriteFailure(e)) {
      bridge.markDisconnected(msg);
    }
    return msg;
  }

  function recordAsyncWriteFailure(context: string, e: unknown): void {
    const msg = noteWriteFailure(e);
    console.error(`[fuse] ${context}: ${msg}`);
  }

  function failIfDisconnectedWrite(req: Deno.PointerValue): boolean {
    const errno = disconnectedWriteErrno(bridge);
    if (errno === null) return false;
    fuse.symbols.fuse_reply_err(req, errno);
    return true;
  }

  globalThis.addEventListener("unhandledrejection", (event: Event) => {
    const rejection = event as FusePromiseRejectionEvent;
    if (!isConnectionWriteFailure(rejection.reason)) return;
    recordAsyncWriteFailure("unhandled async write failure", rejection.reason);
    rejection.preventDefault();
  });

  globalThis.addEventListener("error", (event: Event) => {
    const errorEvent = event as FuseErrorEvent;
    const error = errorEvent.error ?? errorEvent.message;
    if (!isConnectionWriteFailure(error)) return;
    recordAsyncWriteFailure("uncaught async write failure", error);
    errorEvent.preventDefault();
  });

  // Number of FUSE requests whose reply is intentionally delayed while async
  // bridge work runs. Reverse invalidations are unsafe while these requests are
  // outstanding because the kernel may still be waiting in request_wait_answer.
  let pendingFuseReplies = 0;
  let onPendingFuseRepliesDrained: (() => void) | undefined;

  function trackPendingFuseReply(): () => void {
    pendingFuseReplies++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      pendingFuseReplies--;
      if (pendingFuseReplies === 0) {
        onPendingFuseRepliesDrained?.();
      }
    };
  }

  // Populate tree
  try {
    const apiUrl = args["api-url"];
    if (apiUrl) {
      bridge = new CellBridge(tree, args["exec-cli"] || "", {
        cfcAnnotations: cfcAnnotationsEnabled,
        statusProvider: () => ({
          writes: { ...writeStats },
          logFile: logFilePath || null,
          cfc: {
            mode: cfcMode,
            annotations: cfcAnnotationsEnabled,
            writebackXattrs: cfcWritebackXattrs,
            writeback: cfcWritebacks.status(),
            diagnostics: cfcDiagnostics.slice(-50),
          },
        }),
        onCfcProjectionRebuilt: reconcileCfcWritebacks,
      });
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
        reconcileCfcWritebacks();
        console.log(`Connected space: ${spaceName}`);
      }
    } else {
      tree.addFile(tree.rootIno, "hello.txt", "Hello from FUSE!\n", "string");
      console.log("Static mode: hello.txt");
    }
  } catch (e) {
    await writeFailedSupervisorStartupStatus(e, reportSupervisorState);
    Deno.exit(1);
  }

  // Callbacks: Keep references so GC doesn't collect them.
  // deno-lint-ignore no-explicit-any
  const callbacks: Deno.UnsafeCallback<any>[] = [];

  // File handle tracking for write support
  const handles = new HandleMap();
  const fuseOperations = createFuseOperationState(tree, bridge);

  function virtualFileRangeErrno(
    offset: number,
    length: number,
  ): number | null {
    const validation = validateVirtualFileRange(offset, length);
    if (validation.ok) return null;
    return validation.reason === "too-large" ? EFBIG : EINVAL;
  }

  function buildStat(
    node: NonNullable<ReturnType<typeof tree.getNode>>,
    ino: bigint,
  ) {
    return buildNodeStat(node, ino, {
      // When the backend transport is dead, report all files as read-only,
      // and refuse any write that still reaches us with EROFS, instead of
      // silently succeeding.
      isWritable: !bridge?.disconnected && Boolean(
        cfcWritebackXattrs ||
          bridge?.resolveWritePath(ino) || bridge?.resolveSourceWritePath(ino),
      ),
      ownership: mountOwnership,
    });
  }

  /**
   * The bytes an already-open descriptor serves for the generated file `ino`,
   * and when they were published, when `fi` names such a descriptor. The kernel
   * passes the descriptor on a getattr it issues to size a read, and omits it
   * on a bare `stat`. Reporting both the snapshot's length and its publish time
   * keeps the size and the modification time describing the same render.
   */
  function openGeneratedSnapshot(
    fi: Deno.PointerValue,
    ino: bigint,
  ): { buffer: Uint8Array; mtime: number | undefined } | undefined {
    if (!fi || !tree.isGenerated(ino)) return undefined;
    const handle = handles.get(readFileInfo(fi).fh);
    if (!handle || handle.ino !== ino || !handle.bufferValid) return undefined;
    return { buffer: handle.buffer, mtime: handle.readSnapshotMtime };
  }

  /**
   * Whether `ino` carries content the kernel must not cache: a piece inode the
   * bridge hydrates on demand, or a generated file, which republishes its bytes
   * whenever a reader asks for its size.
   */
  function isDynamicIno(ino: bigint): boolean {
    if (tree.isGenerated(ino)) return true;
    return Boolean(
      bridge?.shouldPrepareDirectory(ino) ||
        bridge?.shouldPrepareLookup(
          tree.parents.get(ino) ?? 0n,
          tree.getPath(ino).split("/").pop() ?? "",
        ),
    );
  }

  function recordCfcDiagnostics(messages: string[]): void {
    for (const message of messages) {
      if (cfcDiagnostics.length >= 200) {
        cfcDiagnostics.splice(0, cfcDiagnostics.length - 100);
      }
      cfcDiagnostics.push(message);
      console.warn(`[FUSE:CFC] ${message}`);
    }
  }

  function reconcileCfcWritebacks(context = "CFC writeback"): boolean {
    return safeReconcileCfcWritebacks({
      context,
      reconcile: () => cfcWritebacks.reconcileTree(tree),
      recordDiagnostics: recordCfcDiagnostics,
    });
  }

  function authorizeExistingCfcWrite(
    ino: bigint,
    operation: CfcExistingWritebackOperation,
  ): boolean {
    const node = tree.getNode(ino);
    const diagnostics: string[] = [];
    const authorization = authorizeExistingWriteback({
      mode: cfcMode,
      operation,
      annotation: node?.cfc,
      prepared: cfcWritebacks.getPrepared(ino, operation),
      diagnostics,
    });
    recordCfcDiagnostics(diagnostics);
    if (!authorization.allowed) {
      console.warn(`[FUSE:CFC] denied ${operation}: ${authorization.reason}`);
      return false;
    }
    if (authorization.prepared) {
      applyPreparedExistingWrite(tree, ino, authorization.prepared);
      cfcWritebacks.markMutationApplied(ino, operation);
    }
    return true;
  }

  function authorizeHandleCfcWrite(
    fh: bigint,
    handle: NonNullable<ReturnType<typeof handles.get>>,
    operation: CfcExistingWritebackOperation,
  ): boolean {
    if (handles.hasCfcAuthorization(fh, operation)) return true;
    const node = tree.getNode(handle.ino);
    const diagnostics: string[] = [];
    const authorization = authorizeExistingWriteback({
      mode: cfcMode,
      operation,
      annotation: handle.cfcAuthorizationAnnotation ?? node?.cfc,
      prepared: cfcWritebacks.getPrepared(handle.ino, operation),
      diagnostics,
    });
    recordCfcDiagnostics(diagnostics);
    if (!authorization.allowed) {
      console.warn(`[FUSE:CFC] denied ${operation}: ${authorization.reason}`);
      return false;
    }
    if (authorization.prepared) {
      applyPreparedExistingWrite(tree, handle.ino, authorization.prepared);
      cfcWritebacks.markMutationApplied(handle.ino, operation);
    }
    handles.authorizeCfcOperation(fh, operation);
    return true;
  }

  function getExistingCfcWriteAuthorization(
    ino: bigint,
    operation: CfcExistingWritebackOperation,
  ): ReturnType<typeof authorizeExistingWriteback> {
    const node = tree.getNode(ino);
    const diagnostics: string[] = [];
    const authorization = authorizeExistingWriteback({
      mode: cfcMode,
      operation,
      annotation: node?.cfc,
      prepared: cfcWritebacks.getPrepared(ino, operation),
      diagnostics,
    });
    recordCfcDiagnostics(diagnostics);
    if (!authorization.allowed) {
      console.warn(`[FUSE:CFC] denied ${operation}: ${authorization.reason}`);
    }
    return authorization;
  }

  function authorizeMetadataCfcWrite(
    ino: bigint,
    requestedFields: CfcMetadataLabelKey[],
  ): ReturnType<typeof authorizeMetadataWriteback> {
    const node = tree.getNode(ino);
    const diagnostics: string[] = [];
    const authorization = authorizeMetadataWriteback({
      mode: cfcMode,
      annotation: node?.cfc,
      prepared: cfcWritebacks.getPrepared(ino, "setattr-metadata"),
      requestedFields,
      diagnostics,
    });
    recordCfcDiagnostics(diagnostics);
    if (!authorization.allowed) {
      console.warn(
        `[FUSE:CFC] denied setattr-metadata: ${authorization.reason}`,
      );
    }
    return authorization;
  }

  function finalizeMetadataCfcMutation(
    ino: bigint,
    prepared: CfcPreparedWriteback | undefined,
  ): void {
    if (!prepared || !bridge) return;
    const writePath = bridge.resolveWritePath(ino);
    if (writePath) {
      cfcWritebacks.markReadyForExactRecomputation(ino, "setattr-metadata");
      bridge.finalizeWritePath(writePath).then(() => {
        cfcWritebacks.markFinalizedPendingCleanup(ino, "setattr-metadata");
        cfcWritebacks.deletePrepared(ino, "setattr-metadata");
      }).catch((e) => {
        cfcWritebacks.markRunnerCommitFailed(
          ino,
          "setattr-metadata",
          String(e),
        );
        console.error(`[fuse] metadata finalize error: ${e}`);
      });
      return;
    }
    const sourceWritePath = bridge.resolveSourceWritePath(ino);
    if (sourceWritePath) {
      cfcWritebacks.markReadyForExactRecomputation(ino, "setattr-metadata");
      bridge.finalizeSourceWritePath(sourceWritePath).then(() => {
        cfcWritebacks.markFinalizedPendingCleanup(ino, "setattr-metadata");
        cfcWritebacks.deletePrepared(ino, "setattr-metadata");
      }).catch((e) => {
        cfcWritebacks.markRunnerCommitFailed(
          ino,
          "setattr-metadata",
          String(e),
        );
        console.error(`[fuse] metadata source finalize error: ${e}`);
      });
    }
  }

  function authorizeCreateCfcWrite(
    parentIno: bigint,
    operation: "create" | "mkdir",
    name: string,
  ): boolean {
    const parent = tree.getNode(parentIno);
    const diagnostics: string[] = [];
    const authorization = authorizeCreateWriteback({
      mode: cfcMode,
      operation,
      parentAnnotation: parent?.cfc,
      prepared: cfcWritebacks.getPrepared(parentIno, operation, name),
      name,
      diagnostics,
    });
    recordCfcDiagnostics(diagnostics);
    if (!authorization.allowed) {
      console.warn(
        `[FUSE:CFC] denied ${operation} ${name}: ${authorization.reason}`,
      );
      return false;
    }
    if (authorization.prepared) {
      applyPreparedParent(tree, parentIno, authorization.prepared);
    }
    return true;
  }

  function authorizeNamespaceCfcWrite(
    parentIno: bigint,
    operation: CfcNamespaceMutationWritebackOperation,
    name: string,
    options: {
      prepared?: CfcPreparedWriteback;
      pairedName?: string;
      allowPairedRenamePrepare?: boolean;
    } = {},
  ): ReturnType<typeof authorizeNamespaceMutationWriteback> {
    const parent = tree.getNode(parentIno);
    const diagnostics: string[] = [];
    const authorization = authorizeNamespaceMutationWriteback({
      mode: cfcMode,
      operation,
      parentAnnotation: parent?.cfc,
      prepared: options.prepared ??
        cfcWritebacks.getPrepared(parentIno, operation, name),
      name,
      pairedName: options.pairedName,
      allowPairedRenamePrepare: options.allowPairedRenamePrepare,
      diagnostics,
    });
    recordCfcDiagnostics(diagnostics);
    if (!authorization.allowed) {
      console.warn(
        `[FUSE:CFC] denied ${operation} ${name}: ${authorization.reason}`,
      );
    }
    return authorization;
  }

  function applyNamespacePreparation(
    parentIno: bigint,
    authorization: ReturnType<typeof authorizeNamespaceMutationWriteback>,
  ): void {
    if (authorization.allowed && authorization.prepared) {
      applyPreparedParent(tree, parentIno, authorization.prepared);
    }
  }

  function authorizeRenameCfcWrite(
    oldParent: bigint,
    oldName: string,
    newParent: bigint,
    newName: string,
  ):
    | {
      allowed: true;
      source: Extract<
        ReturnType<typeof authorizeNamespaceMutationWriteback>,
        { allowed: true }
      >;
      destination: Extract<
        ReturnType<typeof authorizeNamespaceMutationWriteback>,
        { allowed: true }
      >;
    }
    | { allowed: false } {
    const sameParent = oldParent === newParent;
    const directSource = cfcWritebacks.getPrepared(
      oldParent,
      "rename-source",
      oldName,
    );
    const directDestination = cfcWritebacks.getPrepared(
      newParent,
      "rename-destination",
      newName,
    );
    const sourcePrepared = directSource ??
      (sameParent ? directDestination : undefined);
    const destinationPrepared = directDestination ??
      (sameParent ? directSource : undefined);

    const source = authorizeNamespaceCfcWrite(
      oldParent,
      "rename-source",
      oldName,
      {
        prepared: sourcePrepared,
        pairedName: newName,
        allowPairedRenamePrepare: sameParent,
      },
    );
    const destination = authorizeNamespaceCfcWrite(
      newParent,
      "rename-destination",
      newName,
      {
        prepared: destinationPrepared,
        pairedName: oldName,
        allowPairedRenamePrepare: sameParent,
      },
    );
    if (!source.allowed || !destination.allowed) {
      return { allowed: false };
    }
    return { allowed: true, source, destination };
  }

  function authorizeSymlinkCfcWrite(
    parentIno: bigint,
    name: string,
    targetText: string,
    options: {
      targetIdentity?: unknown;
      allowDeferredTargetIdentity?: boolean;
    } = {},
  ): ReturnType<typeof authorizeSymlinkWriteback> {
    const parent = tree.getNode(parentIno);
    const diagnostics: string[] = [];
    const authorization = authorizeSymlinkWriteback({
      mode: cfcMode,
      parentAnnotation: parent?.cfc,
      prepared: cfcWritebacks.getPrepared(parentIno, "symlink", name),
      name,
      targetText,
      targetIdentity: options.targetIdentity,
      allowDeferredTargetIdentity: options.allowDeferredTargetIdentity,
      diagnostics,
    });
    recordCfcDiagnostics(diagnostics);
    if (!authorization.allowed) {
      console.warn(
        `[FUSE:CFC] denied symlink ${name}: ${authorization.reason}`,
      );
    }
    return authorization;
  }

  function replyEntry(
    req: Deno.PointerValue,
    ino: bigint,
    node: ReturnType<typeof tree.getNode>,
    lookupRetained = false,
  ) {
    if (!lookupRetained) fuseOperations.retainLookup(ino);
    if (!node) {
      fuseOperations.forget(ino, 1n);
      fuse.symbols.fuse_reply_err(req, ENOENT);
      return;
    }
    // These timeouts govern the Linux kernel's entry and attribute caches.
    // Piece content inodes (under pieces/ and entities/) and generated files
    // (.status) use 0 so every read hits our callbacks. Static inodes (root,
    // space.json) use 1s.
    // FUSE-T (macOS NFS translation) ignores the timeouts a reply carries,
    // along with notify_inval_entry and notify_inval_inode. A macOS mount
    // bounds staleness with an NFS attribute-cache mount option instead; see
    // mount-options.ts.
    const timeout = isDynamicIno(ino) ? 0 : 1.0;
    // This reply carries the file's size, so publish the render it sizes.
    tree.refreshGenerated(ino);
    const entryBuf = new ArrayBuffer(ENTRY_PARAM_SIZE);
    writeEntryParam(entryBuf, {
      ino,
      attr: buildStat(node!, ino),
      attrTimeout: timeout,
      entryTimeout: timeout,
    });
    replyWithRetainedState(
      () =>
        fuse.symbols.fuse_reply_entry(
          req,
          Deno.UnsafePointer.of(new Uint8Array(entryBuf)),
        ),
      () => fuseOperations.forget(ino, 1n),
    );
  }

  function replyLookupFromTree(
    req: Deno.PointerValue,
    parent: bigint,
    name: string,
  ): boolean {
    const ino = fuseOperations.lookup(parent, name);
    if (ino === undefined) return false;
    const node = tree.getNode(ino);
    if (!node) return false;
    replyEntry(req, ino, node);
    return true;
  }

  // lookup(req, parent_ino, name_ptr)
  // This callback supports async space connection: if a name at root isn't found,
  // we attempt connectSpace() before replying.
  const lookupCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
    ) => {
      logOp("lookup", parentIno.toString());
      const name = readCString(namePtr);
      const parent = BigInt(parentIno);

      // If at root and bridge is available, try async space connection.
      // Reply from tree synchronously if space is already connected.
      if (parent === tree.rootIno && bridge && !name.startsWith(".")) {
        const lookup = rootSpaceLookupNames(name);
        if (replyLookupFromTree(req, parent, lookup.directoryName)) {
          return;
        }
        const finishPendingReply = trackPendingFuseReply();
        bridge.connectSpace(lookup.spaceName).then(() => {
          if (!replyLookupFromTree(req, parent, lookup.directoryName)) {
            fuse.symbols.fuse_reply_err(req, ENOENT);
          }
          finishPendingReply();
        }).catch(() => {
          fuse.symbols.fuse_reply_err(req, ENOENT);
          finishPendingReply();
        });
        return;
      }

      if (bridge && bridge.shouldPrepareLookup(parent, name)) {
        const mustSynchronize = bridge.shouldSynchronizeLookup?.(parent) ??
          false;
        // Fast path: if entry is already in the tree (stubs, meta.json,
        // previously hydrated data), reply immediately and trigger
        // hydration in the background for not-yet-populated entries.
        if (!mustSynchronize && replyLookupFromTree(req, parent, name)) {
          setTimeout(() => {
            bridge.prepareLookup(parent, name).catch(() => {});
          }, 0);
          return;
        }
        // Slow path: entry not in tree, must hydrate before replying.
        const finishPendingReply = trackPendingFuseReply();
        fuseOperations.prepareLookup(parent, name).then((ino) => {
          if (ino === undefined) {
            fuse.symbols.fuse_reply_err(req, ENOENT);
          } else {
            replyEntry(req, ino, tree.getNode(ino), true);
          }
          finishPendingReply();
        }).catch(() => {
          fuse.symbols.fuse_reply_err(req, ENOENT);
          finishPendingReply();
        });
        return;
      }

      if (replyLookupFromTree(req, parent, name)) {
        return;
      }

      fuse.symbols.fuse_reply_err(req, ENOENT);
    },
  );
  callbacks.push(lookupCb);

  // forget(req, ino, nlookup) — required to avoid kernel complaints
  const forgetCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "u64"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      nlookup: number | bigint,
    ) => {
      logOp("forget", ino.toString());
      fuseOperations.forget(BigInt(ino), BigInt(nlookup));
      fuse.symbols.fuse_reply_none(req);
    },
  );
  callbacks.push(forgetCb);

  // getattr(req, ino, fi_ptr)
  const getattrCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (req: Deno.PointerValue, ino: number | bigint, fi: Deno.PointerValue) => {
      logOp("getattr", ino.toString());
      const inode = BigInt(ino);
      const node = tree.getNode(inode);

      if (!node) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      // The kernel stops a descriptor's reads at the size this reply gives, and
      // a descriptor serves the bytes it snapshotted at open for its whole
      // life, so a getattr carrying one reports that snapshot's length. A
      // getattr without one — a bare stat, and every getattr FUSE-T makes — is
      // a reader learning the size before reading the node, so that one
      // publishes.
      const snapshot = openGeneratedSnapshot(fi, inode);
      if (!snapshot) tree.refreshGenerated(inode);
      const attr = buildStat(node, inode);
      if (snapshot) {
        // Report the snapshot's size and publish time together, so both
        // describe the render this descriptor serves rather than the current
        // one. A real snapshot always carries a time; a descriptor left empty
        // by a truncate carries none, and reports the epoch, which matches its
        // empty size.
        attr.size = snapshot.buffer.length;
        attr.mtime = snapshot.mtime;
      }
      const statBuf = new ArrayBuffer(STAT_SIZE);
      writeStat(statBuf, attr);

      fuse.symbols.fuse_reply_attr(
        req,
        Deno.UnsafePointer.of(new Uint8Array(statBuf)),
        isDynamicIno(inode) ? 0 : 1.0,
      );
    },
  );
  callbacks.push(getattrCb);

  // readlink(req, ino)
  const readlinkCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64"], result: "void" } as const,
    (req: Deno.PointerValue, ino: number | bigint) => {
      logOp("readlink", ino.toString());
      const node = tree.getNode(BigInt(ino));
      if (!node || node.kind !== "symlink") {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }
      fuse.symbols.fuse_reply_readlink(
        req,
        encoder.encode(node.target + "\0"),
      );
    },
  );
  callbacks.push(readlinkCb);

  // open(req, ino, fi_ptr) — write-aware
  const openCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      fi: Deno.PointerValue,
    ) => {
      logOp("open", ino.toString());
      const inode = BigInt(ino);
      const node = tree.getNode(inode);
      if (!node) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }
      if (node.kind === "dir") {
        fuse.symbols.fuse_reply_err(req, EISDIR);
        return;
      }

      const { flags } = readFileInfo(fi);
      const isWriting = (flags & O_WRONLY) !== 0 || (flags & O_RDWR) !== 0;

      if (node.kind === "callable") {
        if (node.callableKind === "tool" && isWriting) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }

        let writeTarget: HandleWriteTarget | undefined;
        if (node.callableKind === "handler" && isWriting) {
          if (failIfDisconnectedWrite(req)) return;
          if (isCfcEnforcing(cfcMode)) {
            fuse.symbols.fuse_reply_err(req, EACCES);
            return;
          }
          const handlerTarget = bridge?.resolveHandlerTarget(inode);
          if (!handlerTarget) {
            fuse.symbols.fuse_reply_err(req, EACCES);
            return;
          }
          writeTarget = { kind: "handler", target: handlerTarget };
        }
        const truncate = (flags & O_TRUNC) !== 0;
        const initialBuffer = node.callableKind === "handler" && isWriting
          ? new Uint8Array(0)
          : truncate
          ? new Uint8Array(0)
          : node.script;
        const fh = handles.open(
          inode,
          flags,
          initialBuffer,
          { writeTarget },
        );
        if (isWriting) {
          writeStats.opened++;
          console.log(
            `[write-trace] open ino=${inode} fh=${fh} target=${
              writeTarget?.kind ?? "none"
            }`,
          );
        }
        if (truncate) {
          handles.markTruncated(fh);
        }
        bridge?.retainEntityProjectionOpen(inode);
        writeFileInfo(fi, fh);
        replyWithRetainedState(
          () => fuse.symbols.fuse_reply_open(req, fi),
          () => closeKernelFileHandle(handles, bridge, fh),
        );
        return;
      }

      let writeTarget: HandleWriteTarget | undefined;
      const cfcAuthorizedOperations: CfcExistingWritebackOperation[] = [];
      const cfcAuthorizationAnnotation = node.cfc;
      if (isWriting && bridge) {
        const nodeName = tree.getNameForIno(inode) ?? "";
        const sourceWritePath = bridge.resolveSourceWritePath(inode);
        if (nodeName.startsWith("._")) {
          writeTarget = { kind: "ignored" };
        } else if (sourceWritePath) {
          writeTarget = { kind: "source", target: sourceWritePath };
        } else {
          const writePath = bridge.resolveWritePath(inode);
          if (!writePath) {
            fuse.symbols.fuse_reply_err(req, EACCES);
            return;
          }
          writeTarget = { kind: "value", target: writePath };
        }
      }

      if (isWriting && writeTarget?.kind !== "ignored") {
        if (failIfDisconnectedWrite(req)) return;
      }

      // Get current content for the handle buffer
      const content = node.kind === "file" ? node.content : new Uint8Array(0);
      const truncate = (flags & O_TRUNC) !== 0;
      // Fix a generated file's bytes for the life of the descriptor, taking
      // what the last getattr published so the descriptor serves the bytes
      // whose size its reader was already given. A reader that has read to the
      // end issues one more read to see EOF, which this answers too. Record
      // when those bytes were published so the descriptor's later getattr
      // carries a size and a modification time from the one render.
      const snapshotGenerated = tree.isGenerated(inode) && !truncate;
      const readSnapshot = snapshotGenerated ? content : undefined;
      const readSnapshotMtime = snapshotGenerated ? node.mtime : undefined;
      if (isWriting && writeTarget?.kind !== "ignored") {
        const operation: CfcExistingWritebackOperation = truncate
          ? "truncate"
          : "write";
        if (!authorizeExistingCfcWrite(inode, operation)) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
        cfcAuthorizedOperations.push(operation);
      }
      const fh = handles.open(
        inode,
        flags,
        truncate ? new Uint8Array(0) : content,
        {
          writeTarget,
          cfcAuthorizedOperations,
          cfcAuthorizationAnnotation,
          readSnapshot,
          readSnapshotMtime,
        },
      );
      if (isWriting) {
        writeStats.opened++;
        console.log(
          `[write-trace] open ino=${inode} fh=${fh} target=${
            writeTarget?.kind ?? "none"
          }`,
        );
      }
      if (truncate) {
        if (!handles.truncateByIno(inode, 0, { pendingFh: fh })) {
          handles.close(fh);
          fuse.symbols.fuse_reply_err(req, EIO);
          return;
        }
      }
      bridge?.retainEntityProjectionOpen(inode);
      writeFileInfo(fi, fh);
      replyWithRetainedState(
        () => fuse.symbols.fuse_reply_open(req, fi),
        () => closeKernelFileHandle(handles, bridge, fh),
      );
    },
  );
  callbacks.push(openCb);

  // read(req, ino, size, offset, fi_ptr)
  const readFileCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "usize", "i64", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      size: number | bigint,
      offset: number | bigint,
      fi: Deno.PointerValue,
    ) => {
      logOp("read", ino.toString());
      const inode = BigInt(ino);

      // If we have an open handle with a buffer, read from it
      const { fh } = readFileInfo(fi);
      const handle = handles.get(fh);
      if (handleHasBufferedContent(handle)) {
        const off = Number(offset);
        const sz = Number(size);
        const data = handle!.buffer;
        if (off >= data.length) {
          fuse.symbols.fuse_reply_buf(req, null, 0n);
          return;
        }
        const end = Math.min(off + sz, data.length);
        const slice = new Uint8Array(end - off);
        slice.set(data.subarray(off, end));
        fuse.symbols.fuse_reply_buf(
          req,
          Deno.UnsafePointer.of(slice),
          BigInt(slice.length),
        );
        return;
      }

      const node = tree.getNode(inode);
      if (!node || (node.kind !== "file" && node.kind !== "callable")) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const off = Number(offset);
      const sz = Number(size);
      const data = node.kind === "file" ? node.content : node.script;

      if (off >= data.length) {
        // EOF — empty reply
        fuse.symbols.fuse_reply_buf(req, null, 0n);
        return;
      }

      const end = Math.min(off + sz, data.length);
      const slice = new Uint8Array(end - off);
      slice.set(data.subarray(off, end));
      fuse.symbols.fuse_reply_buf(
        req,
        Deno.UnsafePointer.of(slice),
        BigInt(slice.length),
      );
    },
  );
  callbacks.push(readFileCb);

  // opendir(req, ino, fi_ptr)
  const opendirCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      fi: Deno.PointerValue,
    ) => {
      logOp("opendir", ino.toString());
      const inode = BigInt(ino);
      const fh = fuseOperations.openDirectory(inode);
      if (fh === undefined) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }
      writeFileInfo(fi, fh);
      replyWithRetainedState(
        () => fuse.symbols.fuse_reply_open(req, fi),
        () => fuseOperations.closeDirectory(fh, inode),
      );
    },
  );
  callbacks.push(opendirCb);

  // readdir(req, ino, size, offset, fi_ptr)
  const readdirCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "usize", "i64", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      size: number | bigint,
      offset: number | bigint,
      fi: Deno.PointerValue,
    ) => {
      logOp("readdir", ino.toString());
      const inode = BigInt(ino);
      const fh = fi ? readFileInfo(fi).fh : 0n;
      const sendDirectoryReply = (
        preparedEntries?: readonly DirectorySnapshotEntry[],
      ) => {
        const node = tree.getNode(inode);
        if (!node || node.kind !== "dir") {
          fuse.symbols.fuse_reply_err(req, ENOENT);
          return;
        }

        const bufSize = Number(size);
        const startOffset = Number(offset);

        const entries = fuseOperations.directorySnapshot(
          fh,
          inode,
          preparedEntries,
        );

        const buf = new Uint8Array(bufSize);
        let pos = 0;

        visitDirectoryEntries(entries, startOffset, (entry, nextOffset) => {
          const nameBuf = encoder.encode(entry.name + "\0");
          const statBuf = new ArrayBuffer(STAT_SIZE);
          writeStat(statBuf, {
            ino: entry.ino,
            mode: entry.mode,
            nlink: 1,
            size: 0,
            uid: mountOwnership.uid,
            gid: mountOwnership.gid,
          });

          const remaining = bufSize - pos;
          const entrySize = fuse.symbols.fuse_add_direntry(
            req,
            Deno.UnsafePointer.of(buf.subarray(pos)),
            BigInt(remaining),
            nameBuf,
            Deno.UnsafePointer.of(new Uint8Array(statBuf)),
            BigInt(nextOffset),
          );

          if (Number(entrySize) > remaining) return false;
          pos += Number(entrySize);
          return true;
        });

        fuse.symbols.fuse_reply_buf(
          req,
          Deno.UnsafePointer.of(buf),
          BigInt(pos),
        );
      };

      const preparation = fuseOperations.prepareDirectory(fh, inode);
      if (preparation) {
        const finishPendingReply = trackPendingFuseReply();
        preparation.then((entries) => {
          sendDirectoryReply(entries);
          finishPendingReply();
        }).catch(() => {
          fuse.symbols.fuse_reply_err(req, ENOENT);
          finishPendingReply();
        });
        return;
      }

      sendDirectoryReply();
    },
  );
  callbacks.push(readdirCb);

  /**
   * Process a dirty handle buffer: decode, parse, and write to cell.
   * Returns 0 on success, errno on failure.
   */
  async function flushHandle(
    handle: ReturnType<typeof handles.get>,
  ): Promise<number> {
    if (
      !handle || !handleHasPendingChanges(handle) || !bridge || handle.flushing
    ) {
      return 0;
    }
    handle.flushing = true;
    const flushVersion = handle.version;
    const buffer = handle.buffer.slice();
    const writeTarget = handle.writeTarget as HandleWriteTarget | undefined;
    const existingWriteOperation: CfcExistingWritebackOperation =
      handle.truncatePending ? "truncate" : "write";

    const callableNode = tree.getNode(handle.ino);
    const cfcExistingWriteOperations = new Set<CfcExistingWritebackOperation>([
      existingWriteOperation,
    ]);
    if (
      existingWriteOperation === "write" &&
      handle.cfcAuthorizedOperations.has("truncate")
    ) {
      cfcExistingWriteOperations.add("truncate");
    }
    const markExistingReady = () => {
      for (const operation of cfcExistingWriteOperations) {
        cfcWritebacks.markReadyForExactRecomputation(handle.ino, operation);
      }
    };
    const markExistingFinalized = () => {
      for (const operation of cfcExistingWriteOperations) {
        cfcWritebacks.markFinalizedPendingCleanup(handle.ino, operation);
        cfcWritebacks.deletePrepared(handle.ino, operation);
      }
    };
    const markExistingFailed = (reason: string) => {
      for (const operation of cfcExistingWriteOperations) {
        cfcWritebacks.markRunnerCommitFailed(handle.ino, operation, reason);
      }
    };
    const completeWrite = (kind: string): 0 => {
      writeStats.flushed++;
      console.log(`[write-trace] flush-ok ino=${handle.ino} kind=${kind}`);
      return 0;
    };
    try {
      if (writeTarget?.kind === "ignored") {
        if (handle.version === flushVersion) {
          handle.dirty = false;
          handle.truncatePending = false;
          handle.buffer = new Uint8Array(0);
          handle.bufferValid = false;
        }
        return 0;
      }

      const disconnectedErrno = disconnectedWriteErrno(bridge);
      if (disconnectedErrno !== null) {
        markExistingFailed("backend disconnected");
        return disconnectedErrno;
      }

      if (writeTarget?.kind === "handler") {
        const text = new TextDecoder().decode(buffer);
        const trimmed = text.trim();
        let value: unknown;
        try {
          value = JSON.parse(trimmed);
        } catch {
          // Bare string — treat as string value so callers don't need
          // to double-quote (e.g. `echo book > addItem.handler`).
          value = trimmed;
        }
        await bridge.sendToHandlerTarget(writeTarget.target, value);
        // Don't invalidate here — sendToHandlerTarget waits for
        // runtime.idle() + synced(), but the downstream reactive graph
        // may not have settled yet. The cell.sink subscription in
        // subscribePiece fires when the result cell actually updates,
        // which triggers invalidateRootPropCache at the right time.
        if (handle.version === flushVersion) {
          handle.dirty = false;
          handle.truncatePending = false;
          handle.buffer = new Uint8Array(0); // fire-and-forget
          handle.bufferValid = false;
        }
        return completeWrite("handler");
      }

      if (writeTarget?.kind === "source") {
        const { piece, relPath, srcIno } = writeTarget.target;
        const text = decodeSourceWriteText(buffer);
        if (text === undefined) {
          console.error(`[source] Write to ${relPath} is not valid UTF-8 text`);
          markExistingFailed("write is not valid UTF-8 text");
          return EINVAL;
        }

        // Optimistically update the file content in the tree
        let fileIno: bigint | undefined = srcIno;
        for (const part of sourceRelPathToTreeSegments(relPath)) {
          fileIno = fileIno !== undefined
            ? tree.lookup(fileIno, part)
            : undefined;
        }
        if (fileIno !== undefined) {
          try {
            tree.updateFile(fileIno, text);
          } catch {
            // Ignore stale inode
          }
        }

        // Recover the current source program (from the pattern's source-doc
        // closure) to rebuild it with the edited file.
        let program:
          | Awaited<ReturnType<typeof piece.getPatternSourceProgram>>
          | undefined;
        try {
          program = await piece.getPatternSourceProgram();
        } catch (e) {
          console.error(`[source] Failed to get pattern source: ${e}`);
          const errorMsg = isConnectionWriteFailure(e)
            ? noteWriteFailure(e)
            : String(e);
          markExistingFailed(errorMsg);
          return isConnectionWriteFailure(e) ? EROFS : EACCES;
        }

        let baseMain: string;
        let baseMainExport: string | undefined;
        let baseFiles: { name: string; contents: string }[];
        if (program?.files?.length) {
          baseMain = program.main;
          baseMainExport = program.mainExport;
          baseFiles = program.files;
        } else {
          console.error(
            `[source] No recoverable source program for ${relPath}`,
          );
          markExistingFailed("no source program metadata");
          return EACCES;
        }

        // Replace the written file's content in the files array
        let matched = false;
        const updatedFiles = baseFiles.map((f) => {
          const fRelPath = f.name.startsWith("/") ? f.name.slice(1) : f.name;
          if (fRelPath === relPath) {
            matched = true;
            return { ...f, contents: text };
          }
          return f;
        });

        if (!matched) {
          console.error(
            `[source] File "${relPath}" not found in pattern files: [${
              baseFiles.map((f) => f.name).join(", ")
            }]`,
          );
          markExistingFailed(`source file not found: ${relPath}`);
          return EACCES;
        }

        let receipt: PatternUpdateReceipt;
        try {
          receipt = await piece.setPattern({
            main: baseMain,
            mainExport: baseMainExport,
            files: updatedFiles,
            sourceRoots: program.sourceRoots,
            dataFiles: program.dataFiles,
          }, { dangerouslyAllowIncompatibleSchema });
        } catch (e) {
          // No receipt means no source transaction committed. Report the
          // write as failed; every operation after this catch is local
          // projection work and cannot negate the durable outcome.
          const errorMsg = e instanceof Error ? e.message : String(e);
          if (isConnectionWriteFailure(e)) {
            noteWriteFailure(e);
            markExistingFailed(errorMsg);
            return EROFS;
          }
          bridge.writeSourceErrorLog(writeTarget.target, errorMsg);
          console.error(`[source] Compile error in ${relPath}: ${errorMsg}`);
          markExistingFailed(errorMsg);
          return EACCES;
        }

        bridge.writeSourceErrorLog(writeTarget.target, "");
        markExistingReady();
        const finalize = () =>
          bridge.finalizeSourceWritePath(writeTarget.target, receipt);
        const finalized = await finalizeCommittedSourceWrite(receipt, finalize);
        if (finalized.status === "failed") {
          const error = finalized.error;
          // The source is already durable, but the mount should still enter
          // degraded mode when its projection refresh discovers an outage.
          if (isConnectionWriteFailure(error)) noteWriteFailure(error);
          console.error(`[source] ${finalized.warning}`);
          bridge.writeSourceErrorLog(writeTarget.target, finalized.logWarning);
        }
        reconcileCfcWritebacks("source flush post-finalize");
        markExistingFinalized();
        if (handle.version === flushVersion) {
          handle.dirty = handle.truncatePending = false;
        }
        return completeWrite("source");
      }

      if (
        callableNode?.kind === "callable" &&
        callableNode.callableKind === "tool"
      ) {
        return EACCES;
      }

      const writePath = writeTarget?.kind === "value"
        ? writeTarget.target
        : bridge.resolveWritePath(handle.ino);
      if (!writePath) return EACCES;

      const text = new TextDecoder().decode(buffer);

      // [FS] projection index file: parse and write back to cells
      if (writePath.fsProjection) {
        const ok = await bridge.writeFsFile(writePath, text);
        if (!ok) return EINVAL;
        markExistingReady();
        await bridge.finalizeWritePath(writePath);
        reconcileCfcWritebacks("fs projection flush post-finalize");
        markExistingFinalized();
        if (handle.version === flushVersion) {
          handle.dirty = false;
          handle.truncatePending = false;
        }
        try {
          const node = tree.getNode(handle.ino);
          if (node && node.kind === "file") {
            tree.updateFile(handle.ino, text);
          }
        } catch {
          // Stale inode after subscription rebuild — ignore.
        }
        return completeWrite("fsProjection");
      }

      let value: unknown;

      if (writePath.isJsonFile) {
        // .json file: parse as JSON
        try {
          value = JSON.parse(text);
        } catch {
          return EINVAL;
        }
      } else {
        // Scalar file: try JSON parse first, then treat as string
        const trimmed = text.replace(/\n$/, "");
        try {
          const parsed = JSON.parse(trimmed);
          // Only accept JSON primitives (number, boolean, null, string)
          if (
            typeof parsed === "number" ||
            typeof parsed === "boolean" ||
            parsed === null ||
            typeof parsed === "string"
          ) {
            value = parsed;
          } else {
            // It's an object/array — treat as string for scalar files
            value = trimmed;
          }
        } catch {
          // Not valid JSON — use as string
          value = trimmed;
        }
      }

      await bridge.writeValue(writePath, value);
      markExistingReady();
      await bridge.finalizeWritePath(writePath);
      reconcileCfcWritebacks("value flush post-finalize");
      markExistingFinalized();
      if (handle.version === flushVersion) {
        handle.dirty = false;
        handle.truncatePending = false;
      }

      // Optimistic tree update: update the file node content immediately.
      // The inode may have been invalidated by the subscription rebuild
      // triggered during writeValue — ignore stale references.
      try {
        const node = tree.getNode(handle.ino);
        if (node && node.kind === "file") {
          tree.updateFile(handle.ino, text);
        }
      } catch {
        // Stale inode after subscription rebuild — subscription already
        // rebuilt the tree with the correct data.
      }

      return completeWrite("value");
    } catch (e) {
      const logPrefix = writeTarget?.kind === "handler" ||
          (callableNode?.kind === "callable" &&
            callableNode.callableKind === "handler")
        ? "[fuse] handler flush error"
        : "[fuse] flush error";
      console.error(`${logPrefix}: ${e}`);

      const isConnectionFailure = isConnectionWriteFailure(e);
      const msg = isConnectionFailure
        ? noteWriteFailure(e)
        : e instanceof Error
        ? e.message
        : String(e);
      if (!isConnectionFailure) {
        writeStats.flushErrors++;
        writeStats.lastError = msg;
        writeStats.lastErrorAt = new Date().toISOString();
      }
      console.error(
        `[write-trace] flush-err ino=${handle.ino} err=${
          e instanceof Error ? e.stack ?? e.message : String(e)
        }`,
      );

      markExistingFailed(msg);
      return isConnectionFailure ? EROFS : EIO;
    } finally {
      handle.flushing = false;
      if (handleHasPendingChanges(handle) && handle.version !== flushVersion) {
        queueMicrotask(() => {
          flushHandle(handle).catch((e) => {
            recordAsyncWriteFailure("flush retry error", e);
          });
        });
      }
    }
  }

  function clearScheduledFlush(
    handle: NonNullable<ReturnType<typeof handles.get>>,
  ): void {
    const timer = scheduledFlushes.get(handle);
    if (timer !== undefined) {
      clearTimeout(timer);
      scheduledFlushes.delete(handle);
    }
  }

  function scheduleFlush(
    handle: NonNullable<ReturnType<typeof handles.get>>,
    delayMs: number,
  ): void {
    clearScheduledFlush(handle);
    const timer = setTimeout(() => {
      scheduledFlushes.delete(handle);
      if (handle.flushing) {
        // A flush is already in flight; retry shortly so we commit the latest
        // stable buffer rather than an intermediate chunk from a multi-write save.
        scheduleFlush(handle, 10);
        return;
      }
      flushHandle(handle).catch((e) => {
        recordAsyncWriteFailure("scheduled flush error", e);
      });
    }, delayMs);
    scheduledFlushes.set(handle, timer);
  }

  // write(req, ino, buf_ptr, size, offset, fi_ptr)
  const writeCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "pointer", "usize", "i64", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      _ino: number | bigint,
      bufPtr: Deno.PointerValue,
      size: number | bigint,
      offset: number | bigint,
      fi: Deno.PointerValue,
    ) => {
      logOp("write", _ino.toString());
      const { fh } = readFileInfo(fi);
      const handle = handles.get(fh);
      if (!handle) {
        fuse.symbols.fuse_reply_err(req, EIO);
        return;
      }

      const sz = Number(size);
      const off = Number(offset);
      const rangeErrno = virtualFileRangeErrno(off, sz);
      if (rangeErrno !== null) {
        fuse.symbols.fuse_reply_err(req, rangeErrno);
        return;
      }

      // Read data from the FUSE-provided buffer
      const data = new Uint8Array(sz);
      if (bufPtr) {
        const view = new Deno.UnsafePointerView(bufPtr);
        view.copyInto(data);
      }

      const writeTarget = handle.writeTarget as HandleWriteTarget | undefined;
      if (writeTarget?.kind !== "ignored") {
        const errno = disconnectedWriteErrno(bridge);
        if (errno !== null) {
          fuse.symbols.fuse_reply_err(req, errno);
          return;
        }
      }
      if (
        writeTarget?.kind !== "ignored" &&
        !authorizeHandleCfcWrite(fh, handle, "write")
      ) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      if (!handles.write(fh, data, off)) {
        fuse.symbols.fuse_reply_err(req, EIO);
        return;
      }
      writeStats.written++;
      console.log(`[write-trace] write fh=${fh} size=${sz} offset=${off}`);
      fuse.symbols.fuse_reply_write(req, BigInt(sz));

      // Safety-net: schedule a deferred flush in case flush()/release() never
      // arrive. Docker Desktop's VirtioFS on macOS doesn't forward these
      // through FUSE-T/NFS mounts, leaving writes buffered forever. The timer
      // is reset on each write, so rapid multi-write sequences coalesce
      // naturally and only flush after the writes settle.
      scheduleFlush(handle, 500);
    },
  );
  callbacks.push(writeCb);

  // flush(req, ino, fi_ptr) — async: processes dirty buffer
  const flushCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      _ino: number | bigint,
      fi: Deno.PointerValue,
    ) => {
      logOp("flush", _ino.toString());
      const { fh } = readFileInfo(fi);
      const handle = handles.get(fh);

      if (!handle || !handleHasPendingChanges(handle) || handle.flushing) {
        fuse.symbols.fuse_reply_err(req, 0);
        return;
      }

      const writeTarget = handle.writeTarget as HandleWriteTarget | undefined;
      if (writeTarget?.kind !== "ignored") {
        const errno = disconnectedWriteErrno(bridge);
        if (errno !== null) {
          fuse.symbols.fuse_reply_err(req, errno);
          return;
        }
      }

      // Reply immediately — the subscription rebuild triggered by writeValue
      // must not run while a FUSE reply is still pending (it invalidates
      // inodes via notify_inval_entry which crashes FUSE-T mid-callback).
      fuse.symbols.fuse_reply_err(req, 0);
      console.log(`[write-trace] flush-fire fh=${fh}`);

      // Fire-and-forget the actual write to the cell
      const shouldDelay = handle.truncatePending ||
        (writeTarget?.kind === "value" &&
          writeTarget.target.fsProjection === "markdown");
      if (shouldDelay) {
        // Markdown saves often arrive as several small writes plus flushes.
        // Empty O_TRUNC opens can also flush before the writer sends content.
        // Delay slightly so we commit settled data instead of an intermediate
        // empty/truncated buffer.
        scheduleFlush(handle, 25);
      } else {
        clearScheduledFlush(handle);
        flushHandle(handle).catch((e) => {
          recordAsyncWriteFailure("flush write error", e);
        });
      }
    },
  );
  callbacks.push(flushCb);

  // setattr(req, ino, attr_ptr, to_set, fi_ptr)
  const setattrCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "pointer", "i32", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      _attrPtr: Deno.PointerValue,
      toSet: number,
      fi: Deno.PointerValue,
    ) => {
      logOp("setattr", ino.toString());
      const inode = BigInt(ino);
      const node = tree.getNode(inode);
      if (!node) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }
      if ((tree.getNameForIno(inode) ?? "").startsWith("._")) {
        const statBuf = new ArrayBuffer(STAT_SIZE);
        writeStat(statBuf, buildStat(node, inode));
        fuse.symbols.fuse_reply_attr(
          req,
          Deno.UnsafePointer.of(new Uint8Array(statBuf)),
          0,
        );
        return;
      }
      const sizeChange = (toSet & FUSE_SET_ATTR_SIZE) !== 0;
      const metadataFlags = toSet & ~FUSE_SET_ATTR_SIZE;
      const metadataChange = metadataFlags !== 0;
      const metadataFields = metadataChange
        ? metadataFieldsForSetattrFlags(metadataFlags)
        : [];
      if ((sizeChange || metadataChange) && failIfDisconnectedWrite(req)) {
        return;
      }
      let newSize = 0;
      if (sizeChange) {
        const attrView = new Deno.UnsafePointerView(_attrPtr!);
        newSize = Number(attrView.getBigInt64(STAT_ST_SIZE_OFFSET));
        const rangeErrno = virtualFileRangeErrno(0, newSize);
        if (rangeErrno !== null) {
          fuse.symbols.fuse_reply_err(req, rangeErrno);
          return;
        }
      }

      let truncateAuthorization = undefined as
        | ReturnType<typeof authorizeExistingWriteback>
        | undefined;
      let metadataAuthorization = undefined as
        | ReturnType<typeof authorizeMetadataWriteback>
        | undefined;

      if (sizeChange) {
        truncateAuthorization = getExistingCfcWriteAuthorization(
          inode,
          "truncate",
        );
        if (!truncateAuthorization.allowed) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
      }
      if (metadataChange) {
        metadataAuthorization = authorizeMetadataCfcWrite(
          inode,
          metadataFields,
        );
        if (!metadataAuthorization.allowed) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
      }

      if (truncateAuthorization?.allowed && truncateAuthorization.prepared) {
        applyPreparedExistingWrite(tree, inode, truncateAuthorization.prepared);
        cfcWritebacks.markMutationApplied(inode, "truncate");
      }
      if (metadataAuthorization?.allowed && metadataAuthorization.prepared) {
        applyPreparedMetadataMutation(
          tree,
          inode,
          metadataAuthorization.prepared,
          metadataFields,
        );
        cfcWritebacks.markMutationApplied(
          inode,
          "setattr-metadata",
          undefined,
          { requestedFields: metadataFields },
        );
      }

      // Handle truncate / size change
      if (sizeChange) {
        const { fh } = readFileInfo(fi);
        const handle = handles.get(fh);
        if (handle) {
          const truncated = node.kind === "file"
            ? handles.truncateByIno(inode, newSize, { pendingFh: fh })
            : handles.truncate(fh, newSize);
          if (!truncated) {
            fuse.symbols.fuse_reply_err(req, EIO);
            return;
          }
        } else {
          if (node.kind === "callable" && node.callableKind === "handler") {
            // FUSE-T may issue O_TRUNC as a separate setattr without a file
            // handle. Handler contents are delivered through write/flush, so
            // this size-only setattr is just the shell clearing the send buffer.
          } else if (!bridge || node.kind !== "file") {
            fuse.symbols.fuse_reply_err(req, EACCES);
            return;
          } else {
            const sourceWritePath = bridge.resolveSourceWritePath(inode);
            const valueWritePath = sourceWritePath === null
              ? bridge.resolveWritePath(inode)
              : null;
            const writeTarget: HandleWriteTarget | undefined = sourceWritePath
              ? { kind: "source", target: sourceWritePath }
              : valueWritePath
              ? { kind: "value", target: valueWritePath }
              : undefined;
            if (!writeTarget) {
              fuse.symbols.fuse_reply_err(req, EACCES);
              return;
            }

            const truncateFh = handles.open(
              inode,
              O_WRONLY,
              bufferForNoHandleTruncate(node.content, newSize),
              {
                writeTarget,
                cfcAuthorizedOperations: ["truncate"],
                cfcAuthorizationAnnotation: node.cfc,
              },
            );
            if (
              !handles.truncateByIno(inode, newSize, {
                pendingFh: truncateFh,
              })
            ) {
              handles.close(truncateFh);
              fuse.symbols.fuse_reply_err(req, EIO);
              return;
            }
            const truncateHandle = handles.get(truncateFh);
            if (!truncateHandle) {
              fuse.symbols.fuse_reply_err(req, EIO);
              return;
            }
            tree.updateFile(inode, truncateHandle.buffer, node.jsonType);
            flushHandle(truncateHandle).catch((e) => {
              recordAsyncWriteFailure("truncate write error", e);
            }).finally(() => {
              handles.close(truncateFh);
            });
          }
        }
      }

      // Reply with current attrs (silently accept chmod/chown/times)
      const statBuf = new ArrayBuffer(STAT_SIZE);
      writeStat(statBuf, buildStat(node, inode));
      fuse.symbols.fuse_reply_attr(
        req,
        Deno.UnsafePointer.of(new Uint8Array(statBuf)),
        isDynamicIno(inode) ? 0 : 1.0,
      );
      if (
        metadataAuthorization?.allowed &&
        metadataAuthorization.prepared
      ) {
        finalizeMetadataCfcMutation(inode, metadataAuthorization.prepared);
      }
    },
  );
  callbacks.push(setattrCb);

  // release(req, ino, fi_ptr) — flush dirty handles before closing
  const releaseCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (req: Deno.PointerValue, _ino: number | bigint, fi: Deno.PointerValue) => {
      logOp("release", _ino.toString());
      const { fh } = readFileInfo(fi);
      const handle = handles.get(fh);
      if (handle) {
        console.log(
          `[write-trace] release fh=${fh} dirty=${handle.dirty} flushing=${handle.flushing} pending=${
            handleHasPendingChanges(handle)
          }`,
        );
      }

      // Reply immediately. Fire-and-forget the write if dirty.
      // Defer handles.close() until after the flush settles so
      // flushHandle can still read handle state (writeTarget, buffer).
      if (handle && handleHasPendingChanges(handle) && bridge) {
        const writeTarget = handle.writeTarget as HandleWriteTarget | undefined;
        if (writeTarget?.kind !== "ignored") {
          const errno = disconnectedWriteErrno(bridge);
          if (errno !== null) {
            closeKernelFileHandle(handles, bridge, fh);
            fuse.symbols.fuse_reply_err(req, errno);
            return;
          }
        }

        fuse.symbols.fuse_reply_err(req, 0);
        let flushPromise: Promise<unknown> | undefined;
        if (
          handle.truncatePending && !handle.dirty && !handle.flushing
        ) {
          flushPromise = flushHandle(handle).catch((e) => {
            recordAsyncWriteFailure("release flush error", e);
          });
        } else if (
          writeTarget?.kind === "value" &&
          writeTarget.target.fsProjection === "markdown"
        ) {
          scheduleFlush(handle, 0);
        } else if (!handle.flushing) {
          flushPromise = flushHandle(handle).catch((e) => {
            recordAsyncWriteFailure("release flush error", e);
          });
        }
        if (flushPromise) {
          flushPromise.finally(() =>
            closeKernelFileHandle(handles, bridge, fh)
          );
        } else {
          // scheduleFlush path — close after the scheduled timer fires.
          // The handle stays alive until then; scheduleFlush already
          // captures the handle reference.
          queueMicrotask(() => closeKernelFileHandle(handles, bridge, fh));
        }
      } else {
        fuse.symbols.fuse_reply_err(req, 0);
        closeKernelFileHandle(handles, bridge, fh);
      }
    },
  );
  callbacks.push(releaseCb);

  // releasedir(req, ino, fi_ptr)
  const releasedirCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (req: Deno.PointerValue, ino: number | bigint, fi: Deno.PointerValue) => {
      logOp("releasedir", ino.toString());
      if (fi) {
        fuseOperations.closeDirectory(readFileInfo(fi).fh, BigInt(ino));
      }
      fuse.symbols.fuse_reply_err(req, 0); // success
    },
  );
  callbacks.push(releasedirCb);

  // getxattr — platform factory handles macOS extra `position` param vs Linux 4-param signature
  const getxattrCb = platform.createGetxattrCallback(
    (
      req: Deno.PointerValue,
      ino: bigint,
      namePtr: Deno.PointerValue,
      size: bigint,
    ) => {
      logOp("getxattr", ino.toString());
      const attrName = readCString(namePtr);
      const node = tree.getNode(ino);

      // Determine the xattr value (if any)
      let attrValue: Uint8Array | null = null;
      if (attrName === "user.json.type" && node) {
        const jsonType = node.kind === "file"
          ? node.jsonType
          : node.kind === "dir"
          ? node.jsonType
          : undefined;
        if (jsonType) {
          attrValue = encoder.encode(jsonType);
        }
      }
      if (!attrValue) {
        reconcileCfcWritebacks("getxattr");
        attrValue = getCfcXattrValue(tree, ino, attrName, {
          enabled: cfcAnnotationsEnabled,
          namespace: cfcXattrNamespace,
        });
      }

      if (!attrValue) {
        fuse.symbols.fuse_reply_err(req, ENODATA);
        return;
      }

      const sz = Number(size);
      if (sz === 0) {
        // Size query: return the value length
        fuse.symbols.fuse_reply_xattr(req, BigInt(attrValue.length));
      } else if (sz >= attrValue.length) {
        // Return the value
        const valBuf = new Uint8Array(attrValue.length);
        valBuf.set(attrValue);
        fuse.symbols.fuse_reply_buf(
          req,
          Deno.UnsafePointer.of(valBuf),
          BigInt(valBuf.length),
        );
      } else {
        // Buffer too small
        fuse.symbols.fuse_reply_err(req, ERANGE);
      }
    },
  );
  callbacks.push(getxattrCb);

  // listxattr(req, ino, size)
  const listxattrCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "usize"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      size: number | bigint,
    ) => {
      const inode = BigInt(ino);
      const node = tree.getNode(inode);
      const xattrNames: string[] = [];

      const jsonType = node?.kind === "file"
        ? node.jsonType
        : node?.kind === "dir"
        ? node.jsonType
        : undefined;
      if (jsonType) {
        xattrNames.push("user.json.type");
      }

      if (cfcAnnotationsEnabled) {
        reconcileCfcWritebacks("listxattr");
      }
      const cfcXattrNames = listCfcXattrNames(tree, inode, {
        enabled: cfcAnnotationsEnabled,
        namespace: cfcXattrNamespace,
      });
      for (const xattrName of cfcXattrNames) xattrNames.push(xattrName);

      if (xattrNames.length === 0) {
        // No xattrs — empty list
        const sz = Number(size);
        if (sz === 0) {
          fuse.symbols.fuse_reply_xattr(req, 0n);
        } else {
          fuse.symbols.fuse_reply_buf(req, null, 0n);
        }
        return;
      }

      const listBuf = encoder.encode(`${xattrNames.join("\0")}\0`);
      const sz = Number(size);

      if (sz === 0) {
        fuse.symbols.fuse_reply_xattr(req, BigInt(listBuf.length));
      } else if (sz >= listBuf.length) {
        fuse.symbols.fuse_reply_buf(
          req,
          Deno.UnsafePointer.of(listBuf),
          BigInt(listBuf.length),
        );
      } else {
        fuse.symbols.fuse_reply_err(req, ERANGE);
      }
    },
  );
  callbacks.push(listxattrCb);

  const setxattrCb = platform.createSetxattrCallback(
    (
      req: Deno.PointerValue,
      ino: bigint,
      namePtr: Deno.PointerValue,
      valuePtr: Deno.PointerValue,
      size: bigint,
      _flags: number,
    ) => {
      logOp("setxattr", ino.toString());
      if (!cfcWritebackXattrs) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
      if (failIfDisconnectedWrite(req)) return;
      const name = readCString(namePtr);
      const normalizedName = normalizeCfcWritebackXattrName(name);
      const value = new TextDecoder().decode(readBuffer(valuePtr, size));
      let result:
        | ReturnType<CfcWritebackStore["setPreparedXattr"]>
        | ReturnType<CfcWritebackStore["setFinalizeXattr"]>;
      if (normalizedName === CFC_WRITEBACK_PREPARE_XATTR) {
        result = cfcWritebacks.setPreparedXattr(ino, name, value);
      } else if (normalizedName === CFC_WRITEBACK_FINALIZE_XATTR) {
        result = cfcWritebacks.setFinalizeXattr(ino, name, value);
      } else {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
      if (!result.ok) {
        console.warn(`[FUSE:CFC] rejected ${name}: ${result.reason}`);
        fuse.symbols.fuse_reply_err(
          req,
          cfcWritebackXattrResultErrno(result, { enotsup: ENOTSUP }),
        );
        return;
      }
      fuse.symbols.fuse_reply_err(req, 0);
    },
  );
  callbacks.push(setxattrCb);

  const removexattrCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      namePtr: Deno.PointerValue,
    ) => {
      logOp("removexattr", ino.toString());
      if (!cfcWritebackXattrs) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
      if (failIfDisconnectedWrite(req)) return;
      const name = readCString(namePtr);
      const normalizedName = normalizeCfcWritebackXattrName(name);
      if (
        normalizedName !== CFC_WRITEBACK_PREPARE_XATTR &&
        normalizedName !== CFC_WRITEBACK_FINALIZE_XATTR
      ) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
      cfcWritebacks.deleteAllForIno(BigInt(ino));
      fuse.symbols.fuse_reply_err(req, 0);
    },
  );
  callbacks.push(removexattrCb);

  // create(req, parent_ino, name_ptr, mode, fi_ptr)
  const createCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "pointer", "u32", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
      _mode: number,
      fi: Deno.PointerValue,
    ) => {
      logOp("create", parentIno.toString());
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const parent = BigInt(parentIno);
      const name = readCString(namePtr);

      if (name.startsWith("._")) {
        // FUSE-T/macOS may create AppleDouble sidecars before opening the real
        // file. Keep them local so they don't block writes or persist into cells.
        const existingIno = tree.lookup(parent, name);
        const ino = existingIno ?? tree.addFile(parent, name, "", "string");
        const fh = handles.open(ino, O_RDWR, new Uint8Array(0), {
          writeTarget: { kind: "ignored" } satisfies HandleWriteTarget,
        });
        bridge.retainEntityProjectionLookup(ino);
        bridge.retainEntityProjectionOpen(ino);
        writeFileInfo(fi, fh);

        const node = tree.getNode(ino);
        const entryBuf = new ArrayBuffer(ENTRY_PARAM_SIZE);
        writeEntryParam(entryBuf, {
          ino,
          attr: buildStat(node!, ino),
          attrTimeout: 0,
          entryTimeout: 0,
        });
        replyWithRetainedState(
          () =>
            fuse.symbols.fuse_reply_create(
              req,
              Deno.UnsafePointer.of(new Uint8Array(entryBuf)),
              fi,
            ),
          () => {
            bridge.releaseEntityProjectionLookup(ino);
            closeKernelFileHandle(handles, bridge, fh);
          },
        );
        return;
      }

      const parentPath = bridge.resolveWritePath(parent);

      if (!parentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
      if (failIfDisconnectedWrite(req)) return;
      if (!authorizeCreateCfcWrite(parent, "create", name)) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const prepared = cfcWritebacks.getPrepared(parent, "create", name);
      const ino = prepared
        ? applyPreparedCreate(tree, parent, name, "file", prepared)
        : tree.addFile(parent, name, "", "string");
      if (prepared) {
        cfcWritebacks.markMutationApplied(parent, "create", name);
      }
      const fh = handles.open(
        ino,
        O_RDWR,
        new Uint8Array(0),
        {
          writeTarget: {
            kind: "value",
            target: {
              ...parentPath,
              jsonPath: appendDecodedJsonPath(parentPath.jsonPath, name),
            },
          } satisfies HandleWriteTarget,
        },
      );
      bridge.retainEntityProjectionLookup(ino);
      bridge.retainEntityProjectionOpen(ino);
      writeFileInfo(fi, fh);

      const entryBuf = new ArrayBuffer(ENTRY_PARAM_SIZE);
      writeEntryParam(entryBuf, {
        ino,
        attr: {
          ino,
          mode: FILE_MODE_RW,
          nlink: 1,
          size: 0,
          uid: mountOwnership.uid,
          gid: mountOwnership.gid,
        },
        attrTimeout: 1.0,
        entryTimeout: 1.0,
      });

      replyWithRetainedState(
        () =>
          fuse.symbols.fuse_reply_create(
            req,
            Deno.UnsafePointer.of(new Uint8Array(entryBuf)),
            fi,
          ),
        () => {
          bridge.releaseEntityProjectionLookup(ino);
          closeKernelFileHandle(handles, bridge, fh);
        },
      );

      // Fire-and-forget write to cell
      const newPath = appendDecodedJsonPath(parentPath.jsonPath, name);
      bridge.writeValue(
        { ...parentPath, jsonPath: newPath },
        "",
      ).then(async () => {
        cfcWritebacks.markReadyForExactRecomputation(parent, "create", name);
        await bridge.finalizeWritePath(parentPath);
        cfcWritebacks.markFinalizedPendingCleanup(parent, "create", name);
        cfcWritebacks.deletePrepared(parent, "create", name);
      }).catch((e) => {
        cfcWritebacks.markRunnerCommitFailed(parent, "create", String(e), name);
        recordAsyncWriteFailure("create write error", e);
      });
    },
  );
  callbacks.push(createCb);

  // mkdir(req, parent_ino, name_ptr, mode)
  const mkdirCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "pointer", "u32"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
      _mode: number,
    ) => {
      logOp("mkdir", parentIno.toString());
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const parent = BigInt(parentIno);
      const name = readCString(namePtr);
      const parentPath = bridge.resolveWritePath(parent);

      if (!parentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
      if (failIfDisconnectedWrite(req)) return;
      if (!authorizeCreateCfcWrite(parent, "mkdir", name)) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const prepared = cfcWritebacks.getPrepared(parent, "mkdir", name);
      const ino = prepared
        ? applyPreparedCreate(tree, parent, name, "dir", prepared)
        : tree.addDir(parent, name, "object");
      if (prepared) {
        cfcWritebacks.markMutationApplied(parent, "mkdir", name);
      }
      const node = tree.getNode(ino);
      replyEntry(req, ino, node);

      // Fire-and-forget write to cell
      const newPath = appendDecodedJsonPath(parentPath.jsonPath, name);
      bridge.writeValue(
        { ...parentPath, jsonPath: newPath },
        {},
      ).then(async () => {
        cfcWritebacks.markReadyForExactRecomputation(parent, "mkdir", name);
        await bridge.finalizeWritePath(parentPath);
        cfcWritebacks.markFinalizedPendingCleanup(parent, "mkdir", name);
        cfcWritebacks.deletePrepared(parent, "mkdir", name);
      }).catch((e) => {
        cfcWritebacks.markRunnerCommitFailed(parent, "mkdir", String(e), name);
        recordAsyncWriteFailure("mkdir write error", e);
      });
    },
  );
  callbacks.push(mkdirCb);

  // unlink(req, parent_ino, name_ptr)
  const unlinkCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
    ) => {
      logOp("unlink", parentIno.toString());
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const parent = BigInt(parentIno);
      const name = readCString(namePtr);
      if (name.startsWith("._")) {
        tree.removeChild(parent, name);
        fuse.symbols.fuse_reply_err(req, 0);
        return;
      }

      let parentPath = null as ReturnType<CellBridge["resolveWritePath"]>;
      let authorization = undefined as
        | ReturnType<typeof authorizeNamespaceMutationWriteback>
        | undefined;
      if (isCfcEnforcing(cfcMode)) {
        parentPath = bridge.resolveWritePath(parent);
        if (!parentPath) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
        authorization = authorizeNamespaceCfcWrite(parent, "unlink", name);
        if (!authorization.allowed) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
      }

      const childIno = tree.lookup(parent, name);
      if (childIno === undefined) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const writePath = bridge.resolveWritePath(childIno);
      if (!writePath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      parentPath ??= bridge.resolveWritePath(parent);
      if (!parentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
      if (failIfDisconnectedWrite(req)) return;
      authorization ??= authorizeNamespaceCfcWrite(parent, "unlink", name);
      if (!authorization.allowed) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      // For array parents: read parent array, splice, write back
      const parentNode = tree.getNode(parent);
      const isArrayParent = parentNode?.kind === "dir" &&
        parentNode.jsonType === "array";

      applyNamespacePreparation(parent, authorization);
      if (authorization.prepared) {
        cfcWritebacks.markMutationApplied(parent, "unlink", name);
      }

      // Optimistic: remove from tree and reply immediately
      tree.removeChild(parent, name);
      if (name.endsWith(".json")) {
        const dirName = name.slice(0, -5);
        const dirIno = tree.lookup(parent, dirName);
        if (dirIno !== undefined) tree.removeChild(parent, dirName);
      } else {
        const jsonIno = tree.lookup(parent, `${name}.json`);
        if (jsonIno !== undefined) tree.removeChild(parent, `${name}.json`);
      }
      fuse.symbols.fuse_reply_err(req, 0);

      // Fire-and-forget the cell write (skip the tree updates in doUnlink
      // since we already did them above)
      (async () => {
        if (isArrayParent) {
          const currentValue = await writePath.piece[writePath.cell].get(
            parentPath.jsonPath.length > 0 ? parentPath.jsonPath : undefined,
          );
          if (Array.isArray(currentValue)) {
            const idx = Number(decodeFuseNamespaceName(name));
            if (!isNaN(idx) && idx >= 0 && idx < currentValue.length) {
              currentValue.splice(idx, 1);
              await bridge!.writeValue(parentPath, currentValue);
              cfcWritebacks.markReadyForExactRecomputation(
                parent,
                "unlink",
                name,
              );
              await bridge!.finalizeWritePath(parentPath);
              cfcWritebacks.markFinalizedPendingCleanup(
                parent,
                "unlink",
                name,
              );
              cfcWritebacks.deletePrepared(parent, "unlink", name);
            }
          }
        } else {
          const currentValue = await writePath.piece[writePath.cell].get(
            parentPath.jsonPath.length > 0 ? parentPath.jsonPath : undefined,
          );
          if (
            currentValue && typeof currentValue === "object" &&
            !Array.isArray(currentValue)
          ) {
            const obj = { ...(currentValue as Record<string, unknown>) };
            delete obj[decodeFuseNamespaceName(name)];
            await bridge!.writeValue(parentPath, obj);
            cfcWritebacks.markReadyForExactRecomputation(
              parent,
              "unlink",
              name,
            );
            await bridge!.finalizeWritePath(parentPath);
            cfcWritebacks.markFinalizedPendingCleanup(
              parent,
              "unlink",
              name,
            );
            cfcWritebacks.deletePrepared(parent, "unlink", name);
          }
        }
      })().catch((e) => {
        cfcWritebacks.markRunnerCommitFailed(parent, "unlink", String(e), name);
        recordAsyncWriteFailure("unlink write error", e);
      });
    },
  );
  callbacks.push(unlinkCb);

  // rmdir(req, parent_ino, name_ptr)
  const rmdirCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
    ) => {
      logOp("rmdir", parentIno.toString());
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const parent = BigInt(parentIno);
      const name = readCString(namePtr);

      let parentPath = null as ReturnType<CellBridge["resolveWritePath"]>;
      let authorization = undefined as
        | ReturnType<typeof authorizeNamespaceMutationWriteback>
        | undefined;
      if (isCfcEnforcing(cfcMode)) {
        parentPath = bridge.resolveWritePath(parent);
        if (!parentPath) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
        authorization = authorizeNamespaceCfcWrite(parent, "rmdir", name);
        if (!authorization.allowed) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
      }

      const childIno = tree.lookup(parent, name);
      if (childIno === undefined) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const childNode = tree.getNode(childIno);
      if (!childNode || childNode.kind !== "dir") {
        fuse.symbols.fuse_reply_err(req, ENOTDIR);
        return;
      }

      const writePath = bridge.resolveWritePath(childIno);
      if (!writePath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      parentPath ??= bridge.resolveWritePath(parent);
      if (!parentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
      if (failIfDisconnectedWrite(req)) return;
      authorization ??= authorizeNamespaceCfcWrite(parent, "rmdir", name);
      if (!authorization.allowed) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      // Same removal logic as unlink but for a directory
      const parentNode = tree.getNode(parent);
      const isArrayParent = parentNode?.kind === "dir" &&
        parentNode.jsonType === "array";

      applyNamespacePreparation(parent, authorization);
      if (authorization.prepared) {
        cfcWritebacks.markMutationApplied(parent, "rmdir", name);
      }

      // Optimistic: remove from tree and reply immediately
      tree.removeChild(parent, name);
      const jsonIno = tree.lookup(parent, `${name}.json`);
      if (jsonIno !== undefined) tree.removeChild(parent, `${name}.json`);
      fuse.symbols.fuse_reply_err(req, 0);

      // Fire-and-forget the cell write
      (async () => {
        if (isArrayParent) {
          const currentValue = await writePath.piece[writePath.cell].get(
            parentPath.jsonPath.length > 0 ? parentPath.jsonPath : undefined,
          );
          if (Array.isArray(currentValue)) {
            const idx = Number(decodeFuseNamespaceName(name));
            if (!isNaN(idx) && idx >= 0 && idx < currentValue.length) {
              currentValue.splice(idx, 1);
              await bridge!.writeValue(parentPath, currentValue);
              cfcWritebacks.markReadyForExactRecomputation(
                parent,
                "rmdir",
                name,
              );
              await bridge!.finalizeWritePath(parentPath);
              cfcWritebacks.markFinalizedPendingCleanup(
                parent,
                "rmdir",
                name,
              );
              cfcWritebacks.deletePrepared(parent, "rmdir", name);
            }
          }
        } else {
          const currentValue = await writePath.piece[writePath.cell].get(
            parentPath.jsonPath.length > 0 ? parentPath.jsonPath : undefined,
          );
          if (
            currentValue && typeof currentValue === "object" &&
            !Array.isArray(currentValue)
          ) {
            const obj = { ...(currentValue as Record<string, unknown>) };
            delete obj[decodeFuseNamespaceName(name)];
            await bridge!.writeValue(parentPath, obj);
            cfcWritebacks.markReadyForExactRecomputation(
              parent,
              "rmdir",
              name,
            );
            await bridge!.finalizeWritePath(parentPath);
            cfcWritebacks.markFinalizedPendingCleanup(
              parent,
              "rmdir",
              name,
            );
            cfcWritebacks.deletePrepared(parent, "rmdir", name);
          }
        }
      })().catch((e) => {
        cfcWritebacks.markRunnerCommitFailed(parent, "rmdir", String(e), name);
        recordAsyncWriteFailure("rmdir write error", e);
      });
    },
  );
  callbacks.push(rmdirCb);

  // rename — platform factory handles Linux v3 extra `flags` param
  const renameCb = platform.createRenameCallback(
    (
      req: Deno.PointerValue,
      parentIno: bigint,
      namePtr: Deno.PointerValue,
      newParentIno: bigint,
      newNamePtr: Deno.PointerValue,
    ) => {
      logOp("rename", parentIno.toString());
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const oldParent = parentIno;
      const oldName = readCString(namePtr);
      const newParent = newParentIno;
      const newName = readCString(newNamePtr);

      let oldParentWritePath = null as ReturnType<
        CellBridge["resolveWritePath"]
      >;
      let newParentPath = null as ReturnType<CellBridge["resolveWritePath"]>;
      let renameAuthorization = undefined as
        | ReturnType<typeof authorizeRenameCfcWrite>
        | undefined;
      if (isCfcEnforcing(cfcMode)) {
        oldParentWritePath = bridge.resolveWritePath(oldParent);
        if (!oldParentWritePath) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
        newParentPath = bridge.resolveWritePath(newParent);
        if (!newParentPath) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
        renameAuthorization = authorizeRenameCfcWrite(
          oldParent,
          oldName,
          newParent,
          newName,
        );
        if (!renameAuthorization.allowed) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
      }

      const childIno = tree.lookup(oldParent, oldName);
      if (childIno === undefined) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const oldWritePath = bridge.resolveWritePath(childIno);
      if (!oldWritePath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      newParentPath ??= bridge.resolveWritePath(newParent);
      if (!newParentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      if (
        oldWritePath.spaceName !== newParentPath.spaceName ||
        oldWritePath.pieceName !== newParentPath.pieceName ||
        oldWritePath.cell !== newParentPath.cell
      ) {
        fuse.symbols.fuse_reply_err(req, EXDEV);
        return;
      }

      oldParentWritePath ??= bridge.resolveWritePath(oldParent);
      if (!oldParentWritePath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
      if (failIfDisconnectedWrite(req)) return;
      renameAuthorization ??= authorizeRenameCfcWrite(
        oldParent,
        oldName,
        newParent,
        newName,
      );
      if (!renameAuthorization.allowed) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const doRename = async () => {
        // Read value at old path
        const value = await oldWritePath.piece[oldWritePath.cell].get(
          oldWritePath.jsonPath.length > 0 ? oldWritePath.jsonPath : undefined,
        );

        // Write at new path
        const destPath = appendDecodedJsonPath(
          newParentPath.jsonPath,
          newName,
        );
        await bridge!.writeValue(
          { ...newParentPath, jsonPath: destPath },
          value,
        );

        // Delete old path: read parent, delete key, write back
        const parentValue = await oldWritePath.piece[oldWritePath.cell].get(
          oldParentWritePath.jsonPath.length > 0
            ? oldParentWritePath.jsonPath
            : undefined,
        );
        if (
          parentValue && typeof parentValue === "object" &&
          !Array.isArray(parentValue)
        ) {
          const obj = { ...(parentValue as Record<string, unknown>) };
          delete obj[decodeFuseNamespaceName(oldName)];
          await bridge!.writeValue(oldParentWritePath, obj);
        } else if (Array.isArray(parentValue)) {
          const idx = Number(decodeFuseNamespaceName(oldName));
          if (!isNaN(idx)) {
            parentValue.splice(idx, 1);
            await bridge!.writeValue(oldParentWritePath, parentValue);
          }
        }

        if (oldParent === newParent) {
          cfcWritebacks.markReadyForExactRecomputation(
            oldParent,
            "rename-source",
            oldName,
          );
          cfcWritebacks.markReadyForExactRecomputation(
            newParent,
            "rename-destination",
            newName,
          );
          await bridge!.finalizeWritePath(oldParentWritePath);
        } else {
          cfcWritebacks.markReadyForExactRecomputation(
            oldParent,
            "rename-source",
            oldName,
          );
          cfcWritebacks.markReadyForExactRecomputation(
            newParent,
            "rename-destination",
            newName,
          );
          await bridge!.finalizeWritePath(newParentPath);
          await bridge!.finalizeWritePath(oldParentWritePath);
        }
        cfcWritebacks.markFinalizedPendingCleanup(
          oldParent,
          "rename-source",
          oldName,
        );
        cfcWritebacks.markFinalizedPendingCleanup(
          newParent,
          "rename-destination",
          newName,
        );
        cfcWritebacks.deletePrepared(oldParent, "rename-source", oldName);
        cfcWritebacks.deletePrepared(
          newParent,
          "rename-destination",
          newName,
        );
      };

      applyNamespacePreparation(oldParent, renameAuthorization.source);
      if (renameAuthorization.source.prepared) {
        cfcWritebacks.markMutationApplied(
          oldParent,
          "rename-source",
          oldName,
        );
      }
      if (newParent !== oldParent) {
        applyNamespacePreparation(newParent, renameAuthorization.destination);
        if (renameAuthorization.destination.prepared) {
          cfcWritebacks.markMutationApplied(
            newParent,
            "rename-destination",
            newName,
          );
        }
      } else if (
        renameAuthorization.destination.prepared !==
          renameAuthorization.source.prepared
      ) {
        applyNamespacePreparation(newParent, renameAuthorization.destination);
        if (renameAuthorization.destination.prepared) {
          cfcWritebacks.markMutationApplied(
            newParent,
            "rename-destination",
            newName,
          );
        }
      }

      // Optimistic: rename in tree and reply immediately
      tree.rename(oldParent, oldName, newParent, newName);
      fuse.symbols.fuse_reply_err(req, 0);

      // Fire-and-forget the cell writes
      doRename().catch((e) => {
        cfcWritebacks.markRunnerCommitFailed(
          oldParent,
          "rename-source",
          String(e),
          oldName,
        );
        cfcWritebacks.markRunnerCommitFailed(
          newParent,
          "rename-destination",
          String(e),
          newName,
        );
        recordAsyncWriteFailure("rename write error", e);
      });
    },
  );
  callbacks.push(renameCb);

  // symlink(req, target_ptr, parent_ino, name_ptr)
  const symlinkCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "pointer", "u64", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      targetPtr: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
    ) => {
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const target = readCString(targetPtr);
      const name = readCString(namePtr);
      const parent = BigInt(parentIno);
      // Check parent is writable
      const parentPath = bridge.resolveWritePath(parent);
      if (!parentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
      if (failIfDisconnectedWrite(req)) return;

      let authorization = undefined as
        | ReturnType<typeof authorizeSymlinkWriteback>
        | undefined;
      if (cfcMode !== "disabled") {
        authorization = authorizeSymlinkCfcWrite(parent, name, target, {
          allowDeferredTargetIdentity: true,
        });
        if (!authorization.allowed) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
      }

      // Parse target into sigil link components
      const sigil = bridge.parseSymlinkTarget(parent, target);
      if (!sigil) {
        fuse.symbols.fuse_reply_err(req, EINVAL);
        return;
      }

      const needsTargetIdentityValidation = authorization?.allowed &&
        authorization.prepared?.target.targetText === undefined &&
        authorization.prepared?.target.targetIdentity !== undefined;
      if (needsTargetIdentityValidation) {
        authorization = authorizeSymlinkCfcWrite(parent, name, target, {
          targetIdentity: sigil,
        });
        if (!authorization.allowed) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
      }

      // Construct sigil link value and write to cell
      const sigilValue = linkRefFrom(sigil);
      const writePath = {
        ...parentPath,
        jsonPath: appendDecodedJsonPath(parentPath.jsonPath, name),
      };

      // Optimistic: add to tree and reply immediately, then write to cell.
      // The subscription rebuild will eventually replace this node.
      const prepared = authorization?.allowed
        ? authorization.prepared
        : undefined;
      const ino = prepared
        ? applyPreparedSymlink(tree, parent, name, target, prepared)
        : tree.addSymlink(parent, name, target);
      if (prepared) {
        cfcWritebacks.markMutationApplied(parent, "symlink", name);
      }
      const node = tree.getNode(ino);
      replyEntry(req, ino, node);

      // Fire-and-forget write to cell
      bridge.writeValue(writePath, sigilValue).then(async () => {
        if (prepared) {
          cfcWritebacks.markReadyForExactRecomputation(
            parent,
            "symlink",
            name,
          );
        }
        if (cfcAnnotationsEnabled) {
          await bridge.finalizeWritePath(parentPath);
        } else {
          bridge.invalidateWritePath(parentPath);
        }
        if (prepared) {
          cfcWritebacks.markFinalizedPendingCleanup(parent, "symlink", name);
          cfcWritebacks.deletePrepared(parent, "symlink", name);
        }
      }).catch((e) => {
        cfcWritebacks.markRunnerCommitFailed(
          parent,
          "symlink",
          String(e),
          name,
        );
        recordAsyncWriteFailure("symlink write error", e);
      });
    },
  );
  callbacks.push(symlinkCb);

  // Build ops struct
  const opsBuf = new ArrayBuffer(OPS_SIZE);
  const opsView = new DataView(opsBuf);

  // deno-lint-ignore no-explicit-any
  function setOp(offset: number, cb: Deno.UnsafeCallback<any>) {
    opsView.setBigUint64(
      offset,
      BigInt(Deno.UnsafePointer.value(cb.pointer)),
      true,
    );
  }

  setOp(OPS_OFFSETS.lookup, lookupCb);
  setOp(OPS_OFFSETS.forget, forgetCb);
  setOp(OPS_OFFSETS.getattr, getattrCb);
  setOp(OPS_OFFSETS.setattr, setattrCb);
  setOp(OPS_OFFSETS.readlink, readlinkCb);
  setOp(OPS_OFFSETS.symlink, symlinkCb);
  setOp(OPS_OFFSETS.mkdir, mkdirCb);
  setOp(OPS_OFFSETS.unlink, unlinkCb);
  setOp(OPS_OFFSETS.rmdir, rmdirCb);
  setOp(OPS_OFFSETS.rename, renameCb);
  setOp(OPS_OFFSETS.open, openCb);
  setOp(OPS_OFFSETS.read, readFileCb);
  setOp(OPS_OFFSETS.write, writeCb);
  setOp(OPS_OFFSETS.flush, flushCb);
  setOp(OPS_OFFSETS.release, releaseCb);
  setOp(OPS_OFFSETS.opendir, opendirCb);
  setOp(OPS_OFFSETS.readdir, readdirCb);
  setOp(OPS_OFFSETS.releasedir, releasedirCb);
  if (cfcWritebackXattrs) {
    setOp(OPS_OFFSETS.setxattr, setxattrCb);
  }
  setOp(OPS_OFFSETS.getxattr, getxattrCb);
  setOp(OPS_OFFSETS.listxattr, listxattrCb);
  if (cfcWritebackXattrs) {
    setOp(OPS_OFFSETS.removexattr, removexattrCb);
  }
  setOp(OPS_OFFSETS.create, createCb);

  // Mount
  const fuseArgs = buildMountFuseArgs({
    os: Deno.build.os,
    provider: platform.provider(),
    allowOther: Boolean(args["allow-other"]),
    cfcWritebackXattrs,
    ...cacheOptions,
  });
  const { argsBuf, argv: _argv, encodedArgs: _ea } = platform.createFuseArgs(
    fuseArgs,
  );

  const mountpointBuf = encoder.encode(mountpoint + "\0");

  let handle: ReturnType<typeof platform.mount>;
  try {
    handle = platform.mount(
      fuse,
      mountpointBuf,
      argsBuf,
      opsBuf,
      BigInt(OPS_SIZE),
    );
  } catch (e) {
    console.error(String(e));
    await reportSupervisorState("failed", { error: String(e) }).catch(() => {
      // Best effort; mount failure is already being reported by process exit.
    });
    Deno.exit(1);
  }
  // handle is guaranteed assigned — Deno.exit(1) never returns

  let unmounting = false;

  // The reverse-invalidation queue, when a bridge is present. It is closed and
  // its active flush awaited before the session is destroyed, so no notify call
  // is still running on an FFI thread when the session memory it dereferences is
  // freed. `cancelInvalidationFlush` drops a pending flush timer during that
  // shutdown.
  let invalidationQueue: ReverseInvalidationQueue | undefined;
  let cancelInvalidationFlush: (() => void) | undefined;

  // Wire up kernel cache invalidation for subscriptions.
  //
  // libfuse reverse invalidation can block while the kernel answers the notify
  // request. Some bridge paths run while a FUSE request is still awaiting its
  // reply (for example, lookup -> connectSpace -> syncPieceList). notify takes
  // the parent directory's inode lock for write, which a concurrent lookup
  // holds for read until the daemon answers it; the daemon answers on the
  // isolate thread, so a notify on that thread would block behind a lookup only
  // that thread can complete. The queue coalesces notifications, and a timer
  // gated on tracked async replies drains it off the isolate thread (the notify
  // FFI symbols are nonblocking) so the request path stays free.
  if (bridge) {
    let invalidationTimer: ReturnType<typeof setTimeout> | undefined;
    const queue = new ReverseInvalidationQueue({
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
    });
    invalidationQueue = queue;

    const scheduleInvalidationFlush = () => {
      if (invalidationTimer !== undefined) return;
      invalidationTimer = setTimeout(() => {
        invalidationTimer = undefined;
        if (pendingFuseReplies > 0) return;
        queue.flush();
      }, 0);
    };
    onPendingFuseRepliesDrained = scheduleInvalidationFlush;
    cancelInvalidationFlush = () => {
      if (invalidationTimer !== undefined) {
        clearTimeout(invalidationTimer);
        invalidationTimer = undefined;
      }
    };

    bridge.onInvalidate = (parentIno: bigint, names: string[]) => {
      if (queue.addEntry(parentIno, names)) scheduleInvalidationFlush();
    };
    bridge.onInvalidateInode = (ino: bigint) => {
      if (queue.addInode(ino)) scheduleInvalidationFlush();
    };
  }

  // Cleanup on signal
  function unmount() {
    if (unmounting) return;
    unmounting = true;
    console.log("\nUnmounting...");
    writeSupervisorStatus("exiting").catch(() => undefined);
    platform.unmount(fuse, handle, mountpointBuf);
  }

  Deno.addSignalListener("SIGINT", () => {
    unmount();
  });
  Deno.addSignalListener("SIGTERM", () => {
    unmount();
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
  // relying on the signal handler. Closing refuses further additions and halts
  // an in-flight flush; dropping the reschedule hook and any pending timer stops
  // a new flush from starting; the await lets a flush already on an FFI thread
  // finish. Together these ensure no notify call runs against the session after
  // it is destroyed.
  invalidationQueue?.close();
  onPendingFuseRepliesDrained = undefined;
  cancelInvalidationFlush?.();
  await invalidationQueue?.active().catch(() => {});

  // Final cleanup
  platform.cleanup(fuse, handle, mountpointBuf, unmounting);
  for (const cb of callbacks) cb.close();
  console.log("Cleaned up.");
}

if (import.meta.main) {
  await main();
}
