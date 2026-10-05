import { basename, dirname, join, relative, resolve } from "@std/path";

import {
  PieceController,
  type PiecePatternRef,
  PiecesController,
} from "@commonfabric/piece/ops";
import type { Cell } from "@commonfabric/runner";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  type MountedCallablePath,
  parseMountedCallablePath,
} from "../../fuse/callable-path.ts";
import { executeCallableCommand } from "./callable-command.ts";
import {
  callableCommandSpec,
  type CallableExecutionDeps,
  type CallableResultRef,
  detectCallableKind,
  type InvocationIdentity,
  type InvocationOutcome,
  type InvocationPhase,
} from "./callable.ts";
import type { CellSelection } from "./cell-selection.ts";
import {
  type ExecCommandSpec,
  type ParsedExecArgs,
  renderExecHelp,
  renderExecHelpJson,
  usageCommandPrefix,
} from "./exec-schema.ts";
import {
  canonicalizeMountLookupPath,
  findMountForPath,
  type MountStateEntry,
} from "./fuse.ts";
import { loadPieces, type SpaceConfig } from "./piece.ts";
import { newSessionId } from "./session.ts";

export interface MountedPieceMeta {
  id: string;
  entityId?: string;
  name?: string;
  patternRef?: PiecePatternRef;
}

export interface ResolvedMountedCallableFile {
  absPath: string;
  callablePath: MountedCallablePath;
  callableCell: Cell<any>;
  commandSpec: ExecCommandSpec;
  pieces: PiecesController;
  mount: { entry: MountStateEntry; path: string };
  piece: PieceController;
  pieceId: string;
  pieceMeta: MountedPieceMeta;
}

export interface ExecDependencies {
  stateDir?: string;
  loadPieces?: (config: SpaceConfig) => Promise<PiecesController>;
  loadPiece?: (
    pieces: PiecesController,
    pieceId: string,
  ) => Promise<PieceController>;
  stat?: (path: string) => Promise<Deno.FileInfo>;
  readDir?: (path: string) => AsyncIterable<Deno.DirEntry>;
  delay?: (ms: number) => Promise<void>;
  uuid?: () => string;
  invocationStyle?: "cf" | "direct";
  readJsonInput?: () => Promise<unknown>;
  readTextInput?: () => Promise<string>;
  readTextFile?: (path: string) => Promise<string>;
  isStdinTerminal?: () => boolean;

  /** @internal Seam for tests, the same one `getCellValue` and
   * `CallableExecutionDeps` carry. */
  deriveSelectedValue?: CallableExecutionDeps["deriveSelectedValue"];

  /** @internal Seam for tests, the same one `CallableExecutionDeps` carries. */
  sendEvent?: CallableExecutionDeps["sendEvent"];

  /**
   * Each phase the dispatch below reaches, in order. A caller announcing the
   * invocation identity hangs it here: the identity is what a failed call is
   * retried under, and the phase is what says whether retrying is safe.
   */
  onPhase?: (phase: InvocationPhase) => void;
}

export interface ExecutedMountedCallableFile {
  helpText?: string;
  outputText?: string;

  /** Handler invocation outcome, passed through from ExecutedCallable. */
  invocation?: InvocationOutcome;

  /** Tool result cell address, passed through from ExecutedCallable. */
  resultRef?: CallableResultRef;

  parsed: ParsedExecArgs;
  resolved: ResolvedMountedCallableFile;
}

export interface ResolveMountedCallableOptions {
  jsonOutput?: boolean;
}

/** What the caller asked of the invocation, as opposed to what it is wired
 * with. */
export interface ExecuteMountedCallableOptions {
  /** `--filter`/`--select`/`--schema`: the shape the caller asked the result
   * to arrive in, answered by the same selection step `cf cell get`,
   * `cf piece call` and `cf wish` read through — so one grammar covers every
   * arrival, whichever one a caller reached for. */
  selection?: CellSelection;

  /** @internal Seam for tests. Production mints a fresh pair per call: see
   * {@link executeMountedCallableFile}. */
  invocation?: InvocationIdentity;
}

async function defaultLoadPiece(
  pieces: PiecesController,
  pieceId: string,
): Promise<PieceController> {
  return await pieces.get(pieceId, true);
}

async function readMountedPieceMeta(
  absFilePath: string,
  callablePath: MountedCallablePath,
): Promise<MountedPieceMeta> {
  const metaPath = join(
    callablePath.rootLevel
      ? dirname(absFilePath)
      : dirname(dirname(absFilePath)),
    "meta.json",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(metaPath));
  } catch {
    throw new Error(`Mounted piece metadata not found for ${absFilePath}`);
  }

  if (!isObjectNotArray(parsed)) {
    throw new Error(`Mounted piece metadata is invalid for ${absFilePath}`);
  }

  const meta = parsed as Record<string, unknown>;
  if (typeof meta.id !== "string" || meta.id.length === 0) {
    throw new Error(`Mounted piece metadata missing id for ${absFilePath}`);
  }

  const rawPatternRef = meta.patternRef;
  const rawPatternSource = isObjectNotArray(rawPatternRef)
    ? (rawPatternRef as Record<string, unknown>).source
    : undefined;
  const patternSource = isObjectNotArray(rawPatternSource) &&
      typeof (rawPatternSource as Record<string, unknown>).ref === "string"
    ? {
      ref: (rawPatternSource as Record<string, unknown>).ref as string,
      ...(typeof (rawPatternSource as Record<string, unknown>).repository ===
          "string"
        ? {
          repository: (rawPatternSource as Record<string, unknown>)
            .repository as string,
        }
        : {}),
      ...(typeof (rawPatternSource as Record<string, unknown>).entry ===
          "string"
        ? {
          entry: (rawPatternSource as Record<string, unknown>).entry as string,
        }
        : {}),
      ...(typeof (rawPatternSource as Record<string, unknown>).origin ===
          "string"
        ? {
          origin: (rawPatternSource as Record<string, unknown>)
            .origin as string,
        }
        : {}),
    }
    : undefined;
  const patternRef = isObjectNotArray(rawPatternRef) &&
      typeof (rawPatternRef as Record<string, unknown>).identity === "string" &&
      typeof (rawPatternRef as Record<string, unknown>).symbol === "string" &&
      patternSource !== undefined
    ? {
      identity: (rawPatternRef as Record<string, unknown>).identity as string,
      symbol: (rawPatternRef as Record<string, unknown>).symbol as string,
      source: patternSource,
    }
    : undefined;

  return {
    id: meta.id,
    entityId: typeof meta.entityId === "string" ? meta.entityId : undefined,
    name: typeof meta.name === "string" ? meta.name : undefined,
    patternRef,
  };
}

// FUSE-T serves mounts through the macOS NFS client and ignores the entry
// and attribute cache timeouts the filesystem implementation returns, so
// the fuse bridge cannot shorten or disable the client's caching from its
// side. The NFS client answers a negative name lookup from its cache for
// tens of seconds, and serves a cached parent directory listing without a
// daemon round-trip for up to about three seconds after the directory was
// last listed. A listing miss is therefore only authoritative once that
// validity window has passed since the miss was first observed, so this
// wait must exceed the window; it includes margin over the observed three
// seconds.
const DIR_LISTING_RECHECK_DELAY_MS = 3500;

async function parentListingHasFile(
  absPath: string,
  readDir: (path: string) => AsyncIterable<Deno.DirEntry>,
): Promise<boolean> {
  const name = basename(absPath);
  try {
    for await (const entry of readDir(dirname(absPath))) {
      if (entry.name === name && !entry.isDirectory) {
        return true;
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return false;
}

async function assertMountedCallableFileExists(
  absPath: string,
  deps: ExecDependencies = {},
): Promise<void> {
  const stat = deps.stat ?? Deno.stat;
  const readDir = deps.readDir ?? Deno.readDir;
  const delay = deps.delay ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    if ((await stat(absPath)).isFile) {
      return;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
    // While the fuse bridge rebuilds a piece prop it clears the subtree and
    // re-hydrates it on demand, and FUSE-T cannot push cache invalidations
    // to the kernel, so a stat during that window reports NotFound for a
    // callable file that exists: the NFS client's negative name cache keeps
    // answering NotFound long after the bridge has the file again. A parent
    // directory listing that reaches the bridge is answered after hydration
    // and names every callable file that exists. The listing entry's type
    // flags come from the same cached attributes as the stat, so a name
    // match counts as existence unless the entry is a directory.
    if (await parentListingHasFile(absPath, readDir)) {
      return;
    }
    // The listing can itself be served from a client cache that predates
    // the file. Wait out the cache validity window and consult the listing
    // once more; a second miss means the file does not exist.
    await delay(DIR_LISTING_RECHECK_DELAY_MS);
    if (await parentListingHasFile(absPath, readDir)) {
      return;
    }
  }
  throw new Error(`Mounted callable file not found: ${absPath}`);
}

export async function resolveMountedCallableFile(
  filePath: string,
  deps: ExecDependencies = {},
  options: ResolveMountedCallableOptions = {},
): Promise<ResolvedMountedCallableFile> {
  const absPath = resolve(filePath);
  const mount = await findMountForPath(absPath, deps.stateDir);
  if (!mount) {
    throw new Error(
      `Path is not within a mounted cf fuse filesystem: ${absPath}`,
    );
  }

  const canonicalMountpoint = await canonicalizeMountLookupPath(
    mount.entry.mountpoint,
  );
  const canonicalAbsPath = await canonicalizeMountLookupPath(absPath);
  const relativePath = relative(
    canonicalMountpoint,
    canonicalAbsPath,
  );
  const callablePath = parseMountedCallablePath(relativePath);
  if (!callablePath) {
    throw new Error(`Path is not a mounted callable file: ${absPath}`);
  }

  await assertMountedCallableFileExists(canonicalAbsPath, deps);
  const pieceMeta = await readMountedPieceMeta(canonicalAbsPath, callablePath);
  const pieces = await (deps.loadPieces ?? loadPieces)({
    apiUrl: mount.entry.apiUrl,
    identity: mount.entry.identity,
    space: callablePath.spaceName,
    ...(options.jsonOutput ? { jsonOutput: true } : {}),
  });
  const piece = await (deps.loadPiece ?? defaultLoadPiece)(
    pieces,
    pieceMeta.id,
  );
  const rootCell: Cell<any> = await piece[callablePath.cellProp].getCell();
  const callableCell = rootCell.key(callablePath.cellKey)
    .asSchemaFromLinks<any>();
  const actualKind = detectCallableKind(undefined, callableCell);
  if (actualKind !== callablePath.callableKind) {
    throw new Error(
      `Mounted callable path "${absPath}" does not resolve to a ${callablePath.callableKind}`,
    );
  }

  return {
    absPath,
    callablePath,
    callableCell,
    commandSpec: callableCommandSpec(callableCell, callablePath.callableKind),
    pieces,
    mount,
    piece,
    pieceId: pieceMeta.id,
    pieceMeta,
  };
}

/**
 * Run the callable a mounted file names, and answer with what it produced.
 *
 * A handler is dispatched under an invocation identity, one pair per call.
 * That is what gives this arrival an outcome at all: a handler's result is
 * read back off the receipt its handling files, and a dispatch naming no id
 * files under none. Minting both halves is the same default
 * `resolveInvocationIdentity` applies to a `cf piece call` that names neither
 * — the id is random, so it names an outcome nothing else will ask for.
 * Without it a `--select` over a handler could only ever answer nothing, which
 * is the silence the read options exist to remove.
 *
 * `options.invocation` is how a caller supplies the pair instead, and the
 * command does: the identity a failure is retried under is no use to anyone
 * who cannot read it, so `cf exec` mints it where it can also announce it and
 * name it again if the call fails. The fallback minted here keeps a direct
 * caller — a test, an embedder — from having to care.
 */
export async function executeMountedCallableFile(
  filePath: string,
  rawArgs: string[],
  deps: ExecDependencies = {},
  options: ExecuteMountedCallableOptions = {},
): Promise<ExecutedMountedCallableFile> {
  const resolved = await resolveMountedCallableFile(filePath, deps, {
    jsonOutput: true,
  });
  const invocationStyle = deps.invocationStyle ??
    (Deno.env.get("CF_EXEC_SHEBANG") === "1" ? "direct" : "cf");
  const invocation = options.invocation ??
    { id: crypto.randomUUID(), session: newSessionId() };
  const result = await executeCallableCommand({
    resolved,
    execution: {
      callableCell: resolved.callableCell,
      callableKind: resolved.callablePath.callableKind,
      cellKey: resolved.callablePath.cellKey,
      pieces: resolved.pieces,
      space: resolved.pieces.getSpace(),
    },
    commandSpec: resolved.commandSpec,
    rawArgs,
    sectionPrefix: usageCommandPrefix(filePath, invocationStyle),
    deps: {
      ...deps,
      invocation,
      ...(options.selection === undefined
        ? {}
        : { selection: options.selection }),
    },
    renderHelp: (commandSpec, parsed) =>
      parsed.showHelpJson
        ? renderExecHelpJson(commandSpec)
        : renderExecHelp(filePath, commandSpec, {
          invocationStyle,
        }),
  });

  // Auto-step: trigger reactive recomputation after handler execution.
  // Skip if --help was shown — no mutation occurred.
  if (!result.helpText) {
    try {
      await resolved.piece.getCell().pull();
      await resolved.pieces.synced();
    } catch {
      // Auto-step is best-effort; the handler already executed successfully.
    }
  }

  return result;
}
