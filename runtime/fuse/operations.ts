/**
 * The FUSE low-level operations: what the mount answers when the kernel asks
 * it to look up a name, read a file, write one, and so on.
 *
 * `createFuseOperations()` builds the handlers over a filesystem tree, the
 * bridge that writes edits back to cells, and the reply functions of a loaded
 * libfuse. The handlers take the arguments libfuse passes, so a test can call
 * them directly with replies that record what they were asked to send.
 * `registerFuseOperations()` wraps them as native callbacks and lays them out
 * in the `fuse_lowlevel_ops` table a mount is started with.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type { PatternUpdateReceipt } from "@commonfabric/piece/ops";
import { linkRefFrom } from "@commonfabric/runner/shared";

import {
  type CfcXattrNamespace,
  getCfcXattrValue,
  listCfcXattrNames,
} from "./annotations.ts";
import type {
  HandlerTarget,
  SourceWritePath,
  WritePath,
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
  type CfcWritebackStore,
  isCfcEnforcing,
  metadataFieldsForSetattrFlags,
  normalizeCfcWritebackXattrName,
  safeReconcileCfcWritebacks,
} from "./cfc-writeback.ts";
import {
  type DirectorySnapshotEntry,
  type FuseOperationPreparer,
  replyWithRetainedState,
  visitDirectoryEntries,
} from "./directory-handles.ts";
import {
  discardBuffer,
  handleHasBufferedContent,
  handleHasPendingChanges,
  HandleMap,
  type HandleState,
  validateVirtualFileRange,
} from "./handles.ts";
import {
  closeKernelFileHandle,
  createFuseOperationState,
} from "./operation-wiring.ts";
import { decodeFuseComponent, encodeFusePathSegments } from "./path-codec.ts";
import { finalizeCommittedSourceWrite } from "./source-write-finalize.ts";
import {
  type AnyCallback,
  EACCES,
  EBADF,
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
  type FuseLib,
  type FusePlatform,
  O_RDWR,
  O_WRONLY,
  readCString,
} from "./platform.ts";
import { buildNodeStat, getMountOwnership } from "./stat.ts";
import type { FsTree } from "./tree.ts";

const encoder = new TextEncoder();
// Operation ring buffer — last 50 ops for crash diagnostics
const OP_RING: string[] = [];
const OP_RING_SIZE = 50;
function logOp(name: string, detail: string): void {
  const entry = `${Date.now()} ${name} ${detail}`;
  if (OP_RING.length >= OP_RING_SIZE) OP_RING.shift();
  OP_RING.push(entry);
}
export function dumpOpRing(): void {
  console.error("[fuse:crash] Last operations:");
  for (const e of OP_RING) console.error("  " + e);
}

type HandleWriteTarget =
  | { kind: "handler"; target: HandlerTarget }
  | { kind: "value"; target: WritePath }
  | { kind: "source"; target: SourceWritePath }
  | { kind: "ignored" };

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

export function disconnectedWriteErrno(
  bridge: Pick<FuseBridge, "disconnected"> | null | undefined,
): number | null {
  return bridge?.disconnected ? EROFS : null;
}

export function isConnectionWriteFailure(error: unknown): boolean {
  const msg = describeFailure(error);
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

/**
 * The bridge members the operations call: resolving where a write lands,
 * performing it, and keeping the projection of a space up to date. A
 * `CellBridge` is one; a test hands in a stand-in.
 */
export interface FuseBridge extends FuseOperationPreparer {
  readonly disconnected: boolean;
  markDisconnected(reason: string): void;
  connectSpace(spaceName: string): Promise<unknown>;
  shouldSynchronizeLookup(parentIno: bigint): boolean;
  resolveWritePath(ino: bigint): WritePath | null;
  resolveSourceWritePath(ino: bigint): SourceWritePath | null;
  resolveHandlerTarget(ino: bigint): HandlerTarget | null;
  sendToHandlerTarget(target: HandlerTarget, value: unknown): Promise<void>;
  writeValue(writePath: WritePath, value: unknown): Promise<void>;
  writeFsFile(writePath: WritePath, text: string): Promise<boolean>;
  invalidateWritePath(writePath: WritePath): void;
  finalizeWritePath(writePath: WritePath): Promise<void>;
  finalizeSourceWritePath(
    writePath: SourceWritePath,
    receipt?: PatternUpdateReceipt,
  ): Promise<void>;
  writeSourceErrorLog(writePath: SourceWritePath, text: string): void;
  parseSymlinkTarget(
    parentIno: bigint,
    target: string,
  ): { id?: string; path?: string[]; space?: string } | null;
  retainEntityProjectionLookup(ino: bigint, count?: bigint): void;
  releaseEntityProjectionLookup(ino: bigint, count?: bigint): void;
  retainEntityProjectionOpen(ino: bigint): void;
  releaseEntityProjectionOpen(ino: bigint): void;
}

/** The libfuse functions the operations reply through. */
export type FuseReplySymbols = Pick<
  FuseLib["symbols"],
  | "fuse_reply_err"
  | "fuse_reply_entry"
  | "fuse_reply_attr"
  | "fuse_reply_buf"
  | "fuse_reply_open"
  | "fuse_reply_readlink"
  | "fuse_reply_write"
  | "fuse_reply_create"
  | "fuse_reply_xattr"
  | "fuse_reply_none"
  | "fuse_add_direntry"
>;

/** The struct layouts and platform constants the operations use. */
export type FuseOperationsPlatform = Pick<
  FusePlatform,
  | "STAT_SIZE"
  | "ENTRY_PARAM_SIZE"
  | "STAT_ST_SIZE_OFFSET"
  | "writeStat"
  | "writeEntryParam"
  | "readFileInfo"
  | "writeFileInfo"
  | "O_TRUNC"
  | "ENODATA"
  | "ENOTSUP"
>;

export interface FuseOperationsOptions {
  /** The filesystem the mount serves. */
  tree: FsTree;

  /** Where writes go, or `null` for a mount that serves a static tree. */
  bridge: FuseBridge | null;

  /** The loaded libfuse, through which every reply is sent. */
  fuse: { symbols: FuseReplySymbols };

  /** The struct layouts of the platform the mount runs on. */
  platform: FuseOperationsPlatform;

  /** How Contextual Flow Control labels govern writes. */
  cfcMode: CfcEnforcementMode;

  /** Whether CFC labels are exposed as extended attributes. */
  cfcAnnotationsEnabled: boolean;

  /** Whether the CFC writeback extended attributes may be set. */
  cfcWritebackXattrs: boolean;

  /** Which extended attribute names carry the CFC labels. */
  cfcXattrNamespace: CfcXattrNamespace;

  /** The record of prepared and pending CFC writebacks. */
  cfcWritebacks: CfcWritebackStore;

  /** Whether a source write may change the schema incompatibly. */
  dangerouslyAllowIncompatibleSchema: boolean;
}

/** The parameters of each operation, as libfuse calls it. */
const OPERATION_DEFINITIONS = {
  lookup: { parameters: ["pointer", "u64", "pointer"], result: "void" },
  forget: { parameters: ["pointer", "u64", "u64"], result: "void" },
  getattr: { parameters: ["pointer", "u64", "pointer"], result: "void" },
  setattr: {
    parameters: ["pointer", "u64", "pointer", "i32", "pointer"],
    result: "void",
  },
  readlink: { parameters: ["pointer", "u64"], result: "void" },
  symlink: {
    parameters: ["pointer", "pointer", "u64", "pointer"],
    result: "void",
  },
  mkdir: { parameters: ["pointer", "u64", "pointer", "u32"], result: "void" },
  unlink: { parameters: ["pointer", "u64", "pointer"], result: "void" },
  rmdir: { parameters: ["pointer", "u64", "pointer"], result: "void" },
  open: { parameters: ["pointer", "u64", "pointer"], result: "void" },
  read: {
    parameters: ["pointer", "u64", "usize", "i64", "pointer"],
    result: "void",
  },
  write: {
    parameters: ["pointer", "u64", "pointer", "usize", "i64", "pointer"],
    result: "void",
  },
  flush: { parameters: ["pointer", "u64", "pointer"], result: "void" },
  release: { parameters: ["pointer", "u64", "pointer"], result: "void" },
  opendir: { parameters: ["pointer", "u64", "pointer"], result: "void" },
  readdir: {
    parameters: ["pointer", "u64", "usize", "i64", "pointer"],
    result: "void",
  },
  releasedir: { parameters: ["pointer", "u64", "pointer"], result: "void" },
  listxattr: { parameters: ["pointer", "u64", "usize"], result: "void" },
  removexattr: { parameters: ["pointer", "u64", "pointer"], result: "void" },
  create: {
    parameters: ["pointer", "u64", "pointer", "u32", "pointer"],
    result: "void",
  },
} as const satisfies Record<string, Deno.UnsafeCallbackDefinition>;

type OperationDefinitions = typeof OPERATION_DEFINITIONS;

/**
 * Each operation's handler. The operations whose signatures differ between
 * platforms take the arguments `FusePlatform`'s callback factories pass on.
 */
export type FuseOperationHandlers =
  & {
    [K in keyof OperationDefinitions]: Deno.UnsafeCallbackFunction<
      OperationDefinitions[K]["parameters"],
      OperationDefinitions[K]["result"]
    >;
  }
  & {
    getxattr: Parameters<FusePlatform["createGetxattrCallback"]>[0];
    setxattr: Parameters<FusePlatform["createSetxattrCallback"]>[0];
    rename: Parameters<FusePlatform["createRenameCallback"]>[0];
  };

/** What a mount reads off its operations besides the handlers. */
export interface FuseOperations {
  readonly handlers: FuseOperationHandlers;

  /** The write counters and CFC state the `.status` file reports. */
  status(): { writes: FuseWriteStats; cfc: Record<string, unknown> };

  /**
   * Applies prepared CFC writebacks that the tree now makes possible, recording
   * any diagnostics; returns whether that succeeded.
   */
  reconcileCfcWritebacks(context?: string): boolean;

  /** Counts a write that failed after its reply, logging it under `context`. */
  recordAsyncWriteFailure(context: string, error: unknown): void;

  /**
   * How many requests are waiting on bridge work before they are answered.
   * The kernel may still be waiting on such a request, so a reverse
   * invalidation sent meanwhile can deadlock against it.
   */
  pendingReplyCount(): number;

  /**
   * Called when the last reply the operations were holding back has been
   * sent; see `pendingReplyCount()`.
   */
  onPendingRepliesDrained?: () => void;
}

/** Counters of the writes the mount has handled. */
export interface FuseWriteStats {
  opened: number;
  written: number;
  flushed: number;
  flushErrors: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** How many of the most recent CFC diagnostics the `.status` file reports. */
const CFC_DIAGNOSTICS_KEPT = 50;

/** Builds the operations a mount answers the kernel with. */
export function createFuseOperations(
  options: FuseOperationsOptions,
): FuseOperations {
  const {
    tree,
    bridge,
    fuse,
    cfcMode,
    cfcAnnotationsEnabled,
    cfcWritebackXattrs,
    cfcXattrNamespace,
    cfcWritebacks,
    dangerouslyAllowIncompatibleSchema,
  } = options;
  const {
    STAT_SIZE,
    ENTRY_PARAM_SIZE,
    STAT_ST_SIZE_OFFSET,
    writeStat,
    writeEntryParam,
    readFileInfo,
    writeFileInfo,
    O_TRUNC,
    ENODATA,
    ENOTSUP,
  } = options.platform;
  const mountOwnership = getMountOwnership();
  const cfcDiagnostics: string[] = [];

  const scheduledFlushes = new WeakMap<
    HandleState<HandleWriteTarget>,
    ReturnType<typeof setTimeout>
  >();

  const writeStats: FuseWriteStats = {
    opened: 0,
    written: 0,
    flushed: 0,
    flushErrors: 0,
    lastError: null,
    lastErrorAt: null,
  };

  function noteWriteFailure(e: unknown): string {
    const msg = describeFailure(e);
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

  // Number of FUSE requests whose reply is intentionally delayed while async
  // bridge work runs. Reverse invalidations are unsafe while these requests are
  // outstanding because the kernel may still be waiting in request_wait_answer.
  let pendingFuseReplies = 0;

  /** Counts a reply as pending until `reply`, which sends it, settles. */
  function holdReplyUntil(reply: Promise<unknown>): void {
    pendingFuseReplies++;
    reply.finally(() => {
      pendingFuseReplies--;
      if (pendingFuseReplies === 0) {
        operations.onPendingRepliesDrained?.();
      }
    });
  }

  // File handle tracking for write support
  const handles = new HandleMap<HandleWriteTarget>();
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
      cfcDiagnostics.push(message);
      if (cfcDiagnostics.length > CFC_DIAGNOSTICS_KEPT) cfcDiagnostics.shift();
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

  function finalizeMetadataCfcMutation(ino: bigint): void {
    if (!bridge) return;
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
    replyEntry(req, ino, tree.getNode(ino));
    return true;
  }

  // lookup(req, parent_ino, name_ptr)
  // This callback supports async space connection: if a name at root isn't found,
  // we attempt connectSpace() before replying.
  function lookup(
    req: Deno.PointerValue,
    parentIno: number | bigint,
    namePtr: Deno.PointerValue,
  ): void {
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
      holdReplyUntil(
        bridge.connectSpace(lookup.spaceName).then(() => {
          if (!replyLookupFromTree(req, parent, lookup.directoryName)) {
            fuse.symbols.fuse_reply_err(req, ENOENT);
          }
        }).catch(() => {
          fuse.symbols.fuse_reply_err(req, ENOENT);
        }),
      );
      return;
    }

    if (bridge && bridge.shouldPrepareLookup(parent, name)) {
      const mustSynchronize = bridge.shouldSynchronizeLookup(parent);
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
      holdReplyUntil(
        fuseOperations.prepareLookup(parent, name).then((ino) => {
          if (ino === undefined) {
            fuse.symbols.fuse_reply_err(req, ENOENT);
          } else {
            replyEntry(req, ino, tree.getNode(ino), true);
          }
        }).catch(() => {
          fuse.symbols.fuse_reply_err(req, ENOENT);
        }),
      );
      return;
    }

    if (replyLookupFromTree(req, parent, name)) {
      return;
    }

    fuse.symbols.fuse_reply_err(req, ENOENT);
  }

  // forget(req, ino, nlookup) — required to avoid kernel complaints
  function forget(
    req: Deno.PointerValue,
    ino: number | bigint,
    nlookup: number | bigint,
  ): void {
    logOp("forget", ino.toString());
    fuseOperations.forget(BigInt(ino), BigInt(nlookup));
    fuse.symbols.fuse_reply_none(req);
  }

  // getattr(req, ino, fi_ptr)
  function getattr(
    req: Deno.PointerValue,
    ino: number | bigint,
    fi: Deno.PointerValue,
  ): void {
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
  }

  // readlink(req, ino)
  function readlink(req: Deno.PointerValue, ino: number | bigint): void {
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
  }

  // open(req, ino, fi_ptr) — write-aware
  function open(
    req: Deno.PointerValue,
    ino: number | bigint,
    fi: Deno.PointerValue,
  ): void {
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
      // POSIX leaves `O_TRUNC` without write access unspecified; it is ignored.
      const truncate = isWriting && (flags & O_TRUNC) !== 0;
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
        handles.truncate(fh, 0);
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
    // POSIX leaves `O_TRUNC` without write access unspecified; it is ignored.
    const truncate = isWriting && (flags & O_TRUNC) !== 0;
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
    if (truncate) handles.truncateByIno(inode, 0, fh);
    bridge?.retainEntityProjectionOpen(inode);
    writeFileInfo(fi, fh);
    replyWithRetainedState(
      () => fuse.symbols.fuse_reply_open(req, fi),
      () => closeKernelFileHandle(handles, bridge, fh),
    );
  }

  // read(req, ino, size, offset, fi_ptr)
  function read(
    req: Deno.PointerValue,
    ino: number | bigint,
    size: number | bigint,
    offset: number | bigint,
    fi: Deno.PointerValue,
  ): void {
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
  }

  // opendir(req, ino, fi_ptr)
  function opendir(
    req: Deno.PointerValue,
    ino: number | bigint,
    fi: Deno.PointerValue,
  ): void {
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
  }

  // readdir(req, ino, size, offset, fi_ptr)
  function readdir(
    req: Deno.PointerValue,
    ino: number | bigint,
    size: number | bigint,
    offset: number | bigint,
    fi: Deno.PointerValue,
  ): void {
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
      holdReplyUntil(
        preparation.then((entries) => {
          sendDirectoryReply(entries);
        }).catch(() => {
          fuse.symbols.fuse_reply_err(req, ENOENT);
        }),
      );
      return;
    }

    sendDirectoryReply();
  }

  /**
   * Process a dirty handle buffer: decode, parse, and write to cell.
   * Returns 0 on success, errno on failure.
   */
  async function flushHandle(
    handle: ReturnType<typeof handles.get>,
  ): Promise<number> {
    // A descriptor opened read-only has no write target, and nothing to send.
    const writeTarget = handle?.writeTarget;
    if (
      !handle || !writeTarget || !handleHasPendingChanges(handle) || !bridge ||
      handle.flushing
    ) {
      return 0;
    }
    handle.flushing = true;
    const flushVersion = handle.version;
    const buffer = handle.buffer.slice();
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
        if (handle.version === flushVersion) discardBuffer(handle);
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
        if (handle.version === flushVersion) discardBuffer(handle);
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
        if (fileIno !== undefined) updateFileIfPresent(fileIno, text);

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
          const errorMsg = describeFailure(e);
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

      const writePath = writeTarget.target;

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
        updateFileIfPresent(handle.ino, text);
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
      // triggered during writeValue.
      updateFileIfPresent(handle.ino, text);

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
        : describeFailure(e);
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
        queueMicrotask(() => flushInBackground(handle, "flush retry error"));
      }
    }
  }

  /**
   * Flushes `handle` without waiting on it. A flush reports its own failures;
   * this counts one that escapes it, logged under `context`.
   */
  function flushInBackground(
    handle: HandleState<HandleWriteTarget>,
    context: string,
  ): Promise<void> {
    return flushHandle(handle).then(
      () => undefined,
      (e) => recordAsyncWriteFailure(context, e),
    );
  }

  /** Replaces the content of `ino` when it is still a file in the tree. */
  function updateFileIfPresent(ino: bigint, text: string): void {
    if (tree.getNode(ino)?.kind === "file") tree.updateFile(ino, text);
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
      flushInBackground(handle, "scheduled flush error");
    }, delayMs);
    scheduledFlushes.set(handle, timer);
  }

  // write(req, ino, buf_ptr, size, offset, fi_ptr)
  function write(
    req: Deno.PointerValue,
    _ino: number | bigint,
    bufPtr: Deno.PointerValue,
    size: number | bigint,
    offset: number | bigint,
    fi: Deno.PointerValue,
  ): void {
    logOp("write", _ino.toString());
    const { fh } = readFileInfo(fi);
    const handle = handles.get(fh);
    if (!handle) {
      fuse.symbols.fuse_reply_err(req, EIO);
      return;
    }
    if ((handle.flags & (O_WRONLY | O_RDWR)) === 0) {
      fuse.symbols.fuse_reply_err(req, EBADF);
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

    const writeTarget = handle.writeTarget;
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

    handles.write(fh, data, off);
    writeStats.written++;
    console.log(`[write-trace] write fh=${fh} size=${sz} offset=${off}`);
    fuse.symbols.fuse_reply_write(req, BigInt(sz));

    // Safety-net: schedule a deferred flush in case flush()/release() never
    // arrive. Docker Desktop's VirtioFS on macOS doesn't forward these
    // through FUSE-T/NFS mounts, leaving writes buffered forever. The timer
    // is reset on each write, so rapid multi-write sequences coalesce
    // naturally and only flush after the writes settle.
    scheduleFlush(handle, 500);
  }

  // flush(req, ino, fi_ptr) — async: processes dirty buffer
  function flush(
    req: Deno.PointerValue,
    _ino: number | bigint,
    fi: Deno.PointerValue,
  ): void {
    logOp("flush", _ino.toString());
    const { fh } = readFileInfo(fi);
    const handle = handles.get(fh);

    if (!handle || !handleHasPendingChanges(handle) || handle.flushing) {
      fuse.symbols.fuse_reply_err(req, 0);
      return;
    }

    const writeTarget = handle.writeTarget;
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
      flushInBackground(handle, "flush write error");
    }
  }

  // setattr(req, ino, attr_ptr, to_set, fi_ptr)
  function setattr(
    req: Deno.PointerValue,
    ino: number | bigint,
    _attrPtr: Deno.PointerValue,
    toSet: number,
    fi: Deno.PointerValue,
  ): void {
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
    // The descriptor a truncate came through, if it named one.
    const { fh } = readFileInfo(fi);
    const sizeHandle = sizeChange ? handles.get(fh) : undefined;
    if (sizeChange) {
      const attrView = new Deno.UnsafePointerView(_attrPtr!);
      newSize = Number(attrView.getBigInt64(STAT_ST_SIZE_OFFSET));
      const rangeErrno = virtualFileRangeErrno(0, newSize);
      if (rangeErrno !== null) {
        fuse.symbols.fuse_reply_err(req, rangeErrno);
        return;
      }
      // As `ftruncate()` does, refuse a truncate through a descriptor that
      // was not opened for writing.
      if (sizeHandle && (sizeHandle.flags & (O_WRONLY | O_RDWR)) === 0) {
        fuse.symbols.fuse_reply_err(req, EINVAL);
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
      if (sizeHandle) {
        if (node.kind === "file") {
          handles.truncateByIno(inode, newSize, fh);
        } else {
          handles.truncate(fh, newSize);
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
          handles.truncateByIno(inode, newSize, truncateFh);
          const truncateHandle = handles.get(truncateFh)!;
          tree.updateFile(inode, truncateHandle.buffer, node.jsonType);
          flushInBackground(truncateHandle, "truncate write error").finally(
            () => handles.close(truncateFh),
          );
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
      finalizeMetadataCfcMutation(inode);
    }
  }

  // release(req, ino, fi_ptr) — flush dirty handles before closing
  function release(
    req: Deno.PointerValue,
    _ino: number | bigint,
    fi: Deno.PointerValue,
  ): void {
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
      const writeTarget = handle.writeTarget;
      if (writeTarget?.kind !== "ignored") {
        const errno = disconnectedWriteErrno(bridge);
        if (errno !== null) {
          closeKernelFileHandle(handles, bridge, fh);
          fuse.symbols.fuse_reply_err(req, errno);
          return;
        }
      }

      fuse.symbols.fuse_reply_err(req, 0);
      let flushPromise: Promise<void> | undefined;
      if (
        handle.truncatePending && !handle.dirty && !handle.flushing
      ) {
        flushPromise = flushInBackground(handle, "release flush error");
      } else if (
        writeTarget?.kind === "value" &&
        writeTarget.target.fsProjection === "markdown"
      ) {
        scheduleFlush(handle, 0);
      } else if (!handle.flushing) {
        flushPromise = flushInBackground(handle, "release flush error");
      }
      if (flushPromise) {
        flushPromise.finally(() => closeKernelFileHandle(handles, bridge, fh));
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
  }

  // releasedir(req, ino, fi_ptr)
  function releasedir(
    req: Deno.PointerValue,
    ino: number | bigint,
    fi: Deno.PointerValue,
  ): void {
    logOp("releasedir", ino.toString());
    if (fi) {
      fuseOperations.closeDirectory(readFileInfo(fi).fh, BigInt(ino));
    }
    fuse.symbols.fuse_reply_err(req, 0); // success
  }

  // getxattr — platform factory handles macOS extra `position` param vs Linux 4-param signature
  function getxattr(
    req: Deno.PointerValue,
    ino: bigint,
    namePtr: Deno.PointerValue,
    size: bigint,
  ): void {
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
  }

  // listxattr(req, ino, size)
  function listxattr(
    req: Deno.PointerValue,
    ino: number | bigint,
    size: number | bigint,
  ): void {
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
  }

  function setxattr(
    req: Deno.PointerValue,
    ino: bigint,
    namePtr: Deno.PointerValue,
    valuePtr: Deno.PointerValue,
    size: bigint,
    _flags: number,
  ): void {
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
  }

  function removexattr(
    req: Deno.PointerValue,
    ino: number | bigint,
    namePtr: Deno.PointerValue,
  ): void {
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
  }

  // create(req, parent_ino, name_ptr, mode, fi_ptr)
  function create(
    req: Deno.PointerValue,
    parentIno: number | bigint,
    namePtr: Deno.PointerValue,
    _mode: number,
    fi: Deno.PointerValue,
  ): void {
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
  }

  // mkdir(req, parent_ino, name_ptr, mode)
  function mkdir(
    req: Deno.PointerValue,
    parentIno: number | bigint,
    namePtr: Deno.PointerValue,
    _mode: number,
  ): void {
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
  }

  // unlink(req, parent_ino, name_ptr)
  function unlink(
    req: Deno.PointerValue,
    parentIno: number | bigint,
    namePtr: Deno.PointerValue,
  ): void {
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

    // An enforcing mount refuses an unwritable parent before saying whether
    // the name exists. Only an enforcing mount refuses an authorization.
    let parentPath = null as ReturnType<FuseBridge["resolveWritePath"]>;
    if (isCfcEnforcing(cfcMode)) {
      parentPath = bridge.resolveWritePath(parent);
      if (!parentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
    }
    const authorization = authorizeNamespaceCfcWrite(parent, "unlink", name);
    if (!authorization.allowed) {
      fuse.symbols.fuse_reply_err(req, EACCES);
      return;
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
  }

  // rmdir(req, parent_ino, name_ptr)
  function rmdir(
    req: Deno.PointerValue,
    parentIno: number | bigint,
    namePtr: Deno.PointerValue,
  ): void {
    logOp("rmdir", parentIno.toString());
    if (!bridge) {
      fuse.symbols.fuse_reply_err(req, EACCES);
      return;
    }

    const parent = BigInt(parentIno);
    const name = readCString(namePtr);

    // An enforcing mount refuses an unwritable parent before saying whether
    // the name exists. Only an enforcing mount refuses an authorization.
    let parentPath = null as ReturnType<FuseBridge["resolveWritePath"]>;
    if (isCfcEnforcing(cfcMode)) {
      parentPath = bridge.resolveWritePath(parent);
      if (!parentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }
    }
    const authorization = authorizeNamespaceCfcWrite(parent, "rmdir", name);
    if (!authorization.allowed) {
      fuse.symbols.fuse_reply_err(req, EACCES);
      return;
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
  }

  // rename — platform factory handles Linux v3 extra `flags` param
  function rename(
    req: Deno.PointerValue,
    parentIno: bigint,
    namePtr: Deno.PointerValue,
    newParentIno: bigint,
    newNamePtr: Deno.PointerValue,
  ): void {
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
      FuseBridge["resolveWritePath"]
    >;
    let newParentPath = null as ReturnType<FuseBridge["resolveWritePath"]>;
    // An enforcing mount refuses an unwritable directory before saying
    // whether the name exists. Only an enforcing mount refuses an
    // authorization.
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
    }
    const renameAuthorization = authorizeRenameCfcWrite(
      oldParent,
      oldName,
      newParent,
      newName,
    );
    if (!renameAuthorization.allowed) {
      fuse.symbols.fuse_reply_err(req, EACCES);
      return;
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
  }

  // symlink(req, target_ptr, parent_ino, name_ptr)
  function symlink(
    req: Deno.PointerValue,
    targetPtr: Deno.PointerValue,
    parentIno: number | bigint,
    namePtr: Deno.PointerValue,
  ): void {
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
  }

  const operations: FuseOperations = {
    handlers: {
      lookup,
      forget,
      getattr,
      setattr,
      readlink,
      symlink,
      mkdir,
      unlink,
      rmdir,
      rename,
      open,
      read,
      write,
      flush,
      release,
      opendir,
      readdir,
      releasedir,
      getxattr,
      setxattr,
      listxattr,
      removexattr,
      create,
    },
    status: () => ({
      writes: { ...writeStats },
      cfc: {
        mode: cfcMode,
        annotations: cfcAnnotationsEnabled,
        writebackXattrs: cfcWritebackXattrs,
        writeback: cfcWritebacks.status(),
        diagnostics: [...cfcDiagnostics],
      },
    }),
    reconcileCfcWritebacks,
    recordAsyncWriteFailure,
    pendingReplyCount: () => pendingFuseReplies,
  };
  return operations;
}

/** The native callbacks of a mount's operations, and the table holding them. */
export interface RegisteredFuseOperations {
  /** The `fuse_lowlevel_ops` table, holding a pointer to each callback. */
  readonly table: ArrayBuffer;

  /** Releases the callbacks; the table must no longer be in use. */
  close(): void;
}

/**
 * Wraps `handlers` as native callbacks and lays them out in `platform`'s
 * `fuse_lowlevel_ops` table. The extended attribute writes are left out of
 * the table unless `cfcWritebackXattrs` is set, so the kernel answers them
 * itself.
 */
export function registerFuseOperations(
  platform: Pick<
    FusePlatform,
    | "OPS_SIZE"
    | "OPS_OFFSETS"
    | "createGetxattrCallback"
    | "createSetxattrCallback"
    | "createRenameCallback"
  >,
  handlers: FuseOperationHandlers,
  cfcWritebackXattrs: boolean,
): RegisteredFuseOperations {
  const callbacks: AnyCallback[] = [];
  const table = new ArrayBuffer(platform.OPS_SIZE);
  const view = new DataView(table);
  const set = (name: string, callback: AnyCallback) => {
    callbacks.push(callback);
    view.setBigUint64(
      platform.OPS_OFFSETS[name],
      BigInt(Deno.UnsafePointer.value(callback.pointer)),
      true,
    );
  };
  const D = OPERATION_DEFINITIONS;
  set("lookup", new Deno.UnsafeCallback(D.lookup, handlers.lookup));
  set("forget", new Deno.UnsafeCallback(D.forget, handlers.forget));
  set("getattr", new Deno.UnsafeCallback(D.getattr, handlers.getattr));
  set("setattr", new Deno.UnsafeCallback(D.setattr, handlers.setattr));
  set("readlink", new Deno.UnsafeCallback(D.readlink, handlers.readlink));
  set("symlink", new Deno.UnsafeCallback(D.symlink, handlers.symlink));
  set("mkdir", new Deno.UnsafeCallback(D.mkdir, handlers.mkdir));
  set("unlink", new Deno.UnsafeCallback(D.unlink, handlers.unlink));
  set("rmdir", new Deno.UnsafeCallback(D.rmdir, handlers.rmdir));
  set("rename", platform.createRenameCallback(handlers.rename));
  set("open", new Deno.UnsafeCallback(D.open, handlers.open));
  set("read", new Deno.UnsafeCallback(D.read, handlers.read));
  set("write", new Deno.UnsafeCallback(D.write, handlers.write));
  set("flush", new Deno.UnsafeCallback(D.flush, handlers.flush));
  set("release", new Deno.UnsafeCallback(D.release, handlers.release));
  set("opendir", new Deno.UnsafeCallback(D.opendir, handlers.opendir));
  set("readdir", new Deno.UnsafeCallback(D.readdir, handlers.readdir));
  set(
    "releasedir",
    new Deno.UnsafeCallback(D.releasedir, handlers.releasedir),
  );
  set("getxattr", platform.createGetxattrCallback(handlers.getxattr));
  set("listxattr", new Deno.UnsafeCallback(D.listxattr, handlers.listxattr));
  if (cfcWritebackXattrs) {
    set("setxattr", platform.createSetxattrCallback(handlers.setxattr));
    set(
      "removexattr",
      new Deno.UnsafeCallback(D.removexattr, handlers.removexattr),
    );
  }
  set("create", new Deno.UnsafeCallback(D.create, handlers.create));
  return {
    table,
    close() {
      for (const callback of callbacks) callback.close();
    },
  };
}
