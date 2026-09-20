/**
 * Projection of Common Fabric spaces into the filesystem tree the FUSE mount
 * serves. `CellBridge` does the projecting. Around it sit the shapes it
 * exchanges with the mount — the per-space state it keeps, the write paths
 * and handler targets it resolves an inode to, and the callbacks through
 * which it has the mount drop kernel caches — and the helpers that turn a
 * piece's name into a directory name, a callable's schema into the type its
 * shim displays, and an `index.md` back into frontmatter and body.
 */

import type { JSONSchema } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  type PatternUpdateReceipt,
  type PieceController,
  type PiecePatternRef,
  PiecesController,
} from "@commonfabric/piece/ops";
import type { Cell } from "@commonfabric/runner";
import {
  lookupSchemaDocument,
  parseExternalSchemaRef,
  recomposeSchema,
  schemaToTypeString,
} from "@commonfabric/runner";
import { cfcLabelViewForCell } from "@commonfabric/runner/cfc";
import { nameSchema } from "@commonfabric/runner/schemas";
import { linkRefPayload } from "@commonfabric/runner/shared";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import {
  type CfcLabel,
  type CfcLabelView,
  CfcProjectionAnnotator,
  type CfcProjectionKind,
  deriveCfcProjectionGeneration,
  joinLabels,
} from "./annotations.ts";
import { parseMountedCallablePath } from "./callable-path.ts";
import {
  buildCallableScript,
  type CallableKind,
  classifyCallableEntry,
  isHandlerCell,
} from "./callables.ts";
import {
  collectVirtualDirectorySnapshot,
  type DirectorySnapshotEntry,
} from "./directory-handles.ts";
import {
  decodeFuseComponent,
  decodeFusePathSegments,
  encodeFuseComponent,
  encodeFusePathSegments,
} from "./path-codec.ts";
import { sourceRefreshWarning } from "./source-write-finalize.ts";
import {
  buildFsProjection,
  buildJsonTree,
  buildJsonTreeAsync,
  buildPendingJsonTreeAsync,
  type FsValue,
  isSigilLink,
  isVNode,
  stringifyEntryValue,
} from "./tree-builder.ts";
import { FsTree, type TransplantChanges } from "./tree.ts";

/**
 * Expands a schema stored as a content-addressed reference into the schema it
 * names, keeping any sibling keys, for the shim this mount bakes it into:
 * `cf exec` runs later with no registry to resolve against, so the expansion
 * has to happen here, where the mount's session holds the documents. A schema
 * that is not such a reference, or one that cannot be resolved, is returned as
 * it is.
 */
function expandSchemaReference(
  schema: JSONSchema | undefined,
): JSONSchema | undefined {
  if (!isObjectNotArray(schema)) {
    return schema;
  }
  const ref = schema.$ref;
  if (typeof ref !== "string" || parseExternalSchemaRef(ref) === undefined) {
    return schema;
  }
  try {
    const recomposed = recomposeSchema(ref, lookupSchemaDocument);
    const { $ref: _expanded, ...siblings } = schema as Record<string, unknown>;
    return isObjectOrArray(recomposed)
      ? { ...recomposed, ...siblings } as JSONSchema
      : recomposed;
  } catch {
    return schema;
  }
}

/**
 * Strips the `asCell` marker from `schema`, after expanding a reference, for
 * display as a callable's input schema. Returns `undefined` for a schema that
 * is not an object, or one with nothing left once the marker is gone.
 */
function getInputSchema(
  schema: JSONSchema | undefined,
): JSONSchema | undefined {
  schema = expandSchemaReference(schema);
  if (!isObjectNotArray(schema)) {
    return undefined;
  }
  const { asCell: _c, ...rest } = schema as Record<
    string,
    unknown
  >;
  return Object.keys(rest).length > 0 ? rest as JSONSchema : undefined;
}

/**
 * Returns the type a callable's shim displays for its input: `void` when there
 * is no schema, noting for a handler that it is invoked with no arguments, and
 * otherwise the schema rendered as a type string to a depth of three.
 */
function displayCallableInputType(
  callableKind: CallableKind,
  schema: JSONSchema | undefined,
): string {
  if (callableKind === "handler" && schema === undefined) {
    return "void (invoke with no args)";
  }

  if (schema === undefined) {
    return "void";
  }

  const defs = isObjectNotArray(schema)
    ? (schema as Record<string, unknown>).$defs as
      | Record<string, JSONSchema>
      | undefined
    : undefined;
  return schemaToTypeString(schema, { defs, maxDepth: 3 });
}

/**
 * Parses the frontmatter of a Markdown document: `key: value` lines between an
 * opening `---` line and the next one. A value that parses as a JSON string,
 * number, boolean, or `null` is taken as such, and any other is kept as text.
 * Returns the fields and the body after the closing line, with one blank
 * separator line dropped; text with no frontmatter is all body.
 */
function parseFrontmatter(
  text: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const fm: Record<string, unknown> = {};
  if (!text.startsWith("---\n")) return { frontmatter: fm, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: fm, body: text };
  const fmText = text.slice(4, end);
  let body = text.slice(end + 5); // skip "\n---\n"
  if (body.startsWith("\n")) body = body.slice(1); // strip blank separator line
  for (const line of fmText.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    if (val.length === 0) {
      fm[key] = "";
      continue;
    }
    try {
      const parsed = JSON.parse(val);
      fm[key] = (
          typeof parsed === "string" ||
          typeof parsed === "number" ||
          typeof parsed === "boolean" ||
          parsed === null
        )
        ? parsed
        : val;
    } catch {
      fm[key] = val;
    }
  }
  return { frontmatter: fm, body };
}

/**
 * Normalizes a piece name into a directory name: strips accents and emoji,
 * replaces every other run of characters outside ASCII letters and digits
 * with one hyphen, and trims hyphens from both ends. Yields `piece` when
 * nothing remains.
 */
function normalizeProjectedPieceName(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/gu, " ")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  return normalized || "piece";
}

/**
 * Returns the directory name for a piece named `rawName`: its normalization,
 * unless that comes out as `piece` — which is what an empty name normalizes
 * to — in which case the normalization of `pieceId`.
 */
function resolveProjectedPieceName(
  rawName: string | undefined,
  pieceId: string,
): string {
  const primary = normalizeProjectedPieceName(rawName?.trim() || "");
  if (primary !== "piece") return primary;

  const fallback = normalizeProjectedPieceName(pieceId);
  return fallback || "piece";
}

/** Encodes a space name as the name of its directory under the mount root. */
function encodeSpaceDirectoryName(spaceName: string): string {
  return encodeFuseComponent(spaceName);
}

/** Decodes a space's directory name back into the space name. */
function decodeSpaceDirectoryName(spaceName: string): string {
  return decodeFuseComponent(spaceName);
}

/** Cancels a subscription. */
type Cancel = () => void;

/**
 * Resolves a value found `depth` levels below a piece's `input` or `result`
 * directory to the relative symlink target it projects as, or `null` when it
 * does not project as a symlink.
 */
type ResolveLink = (value: unknown, depth: number) => string | null;

/** Opens a space's pieces controller. */
type PiecesLoader = (config: {
  /** API URL to open the space against. */
  apiUrl: string;

  /** Name of the space. */
  space: string;

  /**
   * Identity to open it as; the default loader reads this as the path of a
   * PKCS#8 key file.
   */
  identity: string;

  /** Whether the controller defers syncing the space cell. */
  deferSpaceCellSync?: boolean;
}) => Promise<PiecesController>;

/**
 * Opens one space against the API the mount was started with, authenticating
 * with the PKCS#8 identity file it was given. Used whenever the caller
 * injected no loader of its own.
 */
const openSpacePieces: PiecesLoader = async (config) =>
  await PiecesController.initialize({
    apiUrl: config.apiUrl,
    space: config.space,
    identity: await Identity.fromPkcs8(await Deno.readFile(config.identity)),
    deferSpaceCellSync: config.deferSpaceCellSync,
  });

/** Options for constructing a `CellBridge`. */
export interface CellBridgeOptions {
  /** Whether nodes get CFC annotations; off by default. */
  cfcAnnotations?: boolean;

  /**
   * How many entity projections to keep before evicting;
   * `DEFAULT_MAX_ENTITY_PROJECTIONS` by default.
   */
  maxEntityProjections?: number;

  /**
   * Generation to stamp every CFC annotation with, instead of deriving one per
   * projection.
   */
  projectionGeneration?: string;

  /** Extra fields for `.status` to report. */
  statusProvider?: () => Record<string, unknown>;

  /**
   * Called after each rebuild of a piece prop and each build of a source
   * tree; not after a manifest or index file is rewritten.
   */
  onCfcProjectionRebuilt?: () => void;

  /** Loader reconnection probes open spaces with; `loadPieces` by default. */
  reconnectPiecesLoader?: PiecesLoader;

  /**
   * Loader spaces are opened with; by default, one that authenticates with
   * the PKCS#8 identity file `init()` was given.
   */
  loadPieces?: PiecesLoader;
}

/**
 * The cell path a write to an inode lands on; see
 * `CellBridge.resolveWritePath()`.
 */
export interface WritePath {
  /** Name of the space. */
  spaceName: string;

  /** Projected name of the piece. */
  pieceName: string;

  /** Which cell of the piece. */
  cell: "input" | "result";

  /**
   * Path within the cell's value, with array indexes as numbers; empty for
   * the whole cell.
   */
  jsonPath: (string | number)[];

  /**
   * Whether the inode is a `.json` file, rather than a directory or a leaf
   * value file.
   */
  isJsonFile: boolean;

  /** Controller of the piece. */
  piece: PieceController;

  /** Set when the file is an [FS] projection index file. */
  fsProjection?: "markdown" | "json";
}

/**
 * The handler cell a callable file stands for; see
 * `CellBridge.resolveHandlerTarget()`.
 */
export interface HandlerTarget {
  /** Controller of the piece. */
  piece: PieceController;

  /** Which cell of the piece holds the handler. */
  cellProp: "input" | "result";

  /** Key of the handler within that cell. */
  cellKey: string;
}

/**
 * The source file a write to an inode lands on; see
 * `CellBridge.resolveSourceWritePath()`.
 */
export interface SourceWritePath {
  /** Name of the space. */
  spaceName: string;

  /** Projected name of the piece. */
  pieceName: string;

  /** Path within `.src/`, such as `main.tsx` or `utils/helper.tsx`. */
  relPath: string;

  /** Controller of the piece. */
  piece: PieceController;

  /**
   * Inode of the `.src/` directory, from which the mount walks `relPath` to
   * reach the written file's inode.
   */
  srcIno: bigint;
}

/**
 * Callback that drops the kernel's cached entries for `names` under the
 * directory `parentIno`.
 */
export type InvalidateCallback = (parentIno: bigint, names: string[]) => void;

/**
 * Callback that drops the kernel's cached attributes and data for an inode:
 * a file's content, or a directory's listing.
 */
export type InvalidateInodeCallback = (ino: bigint) => void;

/** State of one connected space. */
export interface SpaceState {
  /** Controller of the space's pieces. */
  pieces: PiecesController;

  /** Inode of the space's directory. */
  spaceIno: bigint;

  /** Inode of its `pieces/` directory. */
  piecesIno: bigint;

  /** Inode of its `entities/` directory. */
  entitiesIno: bigint;

  /** Entity id of each piece, by projected name. */
  pieceMap: Map<string, string>;

  /** Root inode of each piece, by projected name. */
  pieceInos: Map<string, bigint>;

  /** Controller of each piece, by projected name. */
  pieceControllers: Map<string, PieceController>;

  /** Controller of each entity projected under `entities/`, by entity id. */
  entityControllers: Map<string, PieceController>;

  /** Ids of every registered piece, as of the last piece-list sync. */
  allPieceIds: Set<string>;

  /** Entity ids with a projection under `entities/`. */
  entityIds: Set<string>;

  /** Whether `pieces/` has been materialized. */
  piecesHydrated: boolean;

  /** Whether `pieces/` is being materialized. */
  piecesMaterializing: boolean;

  /** Whether the piece registry is subscribed to. */
  pieceListSubscribed: boolean;

  /**
   * Summary and pattern reference of each piece, by entity id, which
   * `pieces.json` lists.
   */
  pieceManifest: Map<
    string,
    { summary: string; patternRef?: PiecePatternRef }
  >;

  /** Cancel functions of each piece's subscriptions, by projected name. */
  pieceSubs: Map<string, Cancel[]>;

  /** DID of the space. */
  did: string;

  /** Cancel functions of the space-level subscriptions. */
  unsubscribes: Cancel[];

  /** Projected names in use, for collision resolution. */
  usedNames: Set<string>;

  /** Inode of each piece's `.src/` directory, by projected name. */
  srcInos: Map<string, bigint>;

  /**
   * Inode of the synthetic `error.log` file in each piece's `.src/`, by
   * projected name.
   */
  srcErrorLogInos: Map<string, bigint>;
}

/** What a piece root directory projects. */
interface PieceRootInfo {
  /** Name of the space. */
  spaceName: string;

  /** Whether the root sits under `pieces/` or `entities/`. */
  rootKind: "pieces" | "entities";

  /**
   * Directory name of the root: the projected piece name, or the encoded
   * entity id.
   */
  rootName: string;

  /** Entity id of the piece. */
  pieceId: string;

  /** Controller of the piece. */
  piece: PieceController;
}

/** Which piece prop an `input` or `result` directory projects. */
interface PiecePropRootInfo {
  /** Inode of the piece root. */
  pieceIno: bigint;

  /** Which prop. */
  propName: "input" | "result";
}

/** What the bridge knows about an entity root it has not yet hydrated. */
export interface UnhydratedEntityRootInfo {
  /** The space the entity lives in. */
  state: SpaceState;

  /** Name of that space, as its directory is named. */
  spaceName: string;

  /** Id of the entity. */
  entityId: string;
}

/** The root an entity-projection lookup pin belongs to, and its pin count. */
export interface EntityProjectionLookupOwner {
  /** Inode of the projection root the pin holds. */
  rootIno: bigint;

  /** How many pins the root holds through this owner. */
  count: bigint;
}

/**
 * The root an entity-projection open handle belongs to, and its handle count.
 */
interface EntityProjectionOpenOwner {
  /** Inode of the projection root the handle holds. */
  rootIno: bigint;

  /** How many handles the root holds through this owner. */
  count: number;
}

/** How many entity ids one page of the server's listing asks for. */
const ENTITY_ID_PAGE_SIZE = 1_000;

/**
 * How many entity projections a bridge keeps before evicting, absent a
 * `maxEntityProjections` option.
 */
export const DEFAULT_MAX_ENTITY_PROJECTIONS = 128;

/** A prop rebuild scheduled but not yet started. */
interface ScheduledPropRebuild {
  /** The cell being projected. */
  cell: Cell<unknown>;

  /**
   * The value the rebuild will project, replaced by any change arriving
   * before it starts.
   */
  latestValue: unknown;

  /** Entity id of the piece. */
  pieceId: string;

  /** Inode of the piece root. */
  pieceIno: bigint;

  /** Projected name of the piece. */
  pieceName: string;

  /** Which prop. */
  propName: "input" | "result";

  /** Link resolver for the piece's space. */
  resolveLink: ResolveLink;

  /** Name of the space. */
  spaceName: string;

  /** The timer that starts the rebuild. */
  timer: ReturnType<typeof setTimeout>;
}

/** One prop rebuild, as queued. */
interface PropRebuildJob {
  /** The cell being projected. */
  cell: Cell<unknown>;

  /** The value to project. */
  newValue: unknown;

  /** Entity id of the piece. */
  pieceId: string;

  /** Inode of the piece root. */
  pieceIno: bigint;

  /** Projected name of the piece. */
  pieceName: string;

  /** Which prop. */
  propName: "input" | "result";

  /** Link resolver for the piece's space. */
  resolveLink: ResolveLink;

  /** Name of the space. */
  spaceName: string;
}

/**
 * Bridge from Common Fabric spaces to an `FsTree`. A space is connected the
 * first time it is asked for, and gets a directory holding `pieces/`, keyed by
 * projected piece name, and `entities/`, keyed by entity id. Under both, a
 * piece's `input` and `result` are hydrated on demand: each is created as a
 * stub and filled when a lookup or listing reaches it. The bridge subscribes
 * to the cells of every piece it has loaded, and a change rebuilds the
 * affected subtree in place, one rebuild at a time per prop, reusing inodes
 * where a path survives, and then names exactly the kernel caches the rebuild
 * made stale through `onInvalidate` and `onInvalidateInode`. Entity
 * projections are bounded by a least-recently-used cache that evicts only
 * roots the kernel holds no lookup or open reference on. A write that fails
 * with a transport error marks the bridge disconnected, which the mount reads
 * as read-only, and reconnection is probed with an increasing backoff.
 */
export class CellBridge {
  /** The tree this bridge projects into. */
  #tree: FsTree;

  /** Connected spaces by name. */
  #spaces: Map<string, SpaceState> = new Map();

  /**
   * DID of every space that has connected, by name; the contents of
   * `.spaces.json`.
   */
  #knownSpaces: Map<string, string> = new Map();

  /**
   * Callback for dropping a directory's cached entries by name, or `null` when
   * the mount has not set one.
   */
  #onInvalidate: InvalidateCallback | null = null;

  /**
   * Callback for dropping an inode's cached attributes and data, or `null` when
   * the mount has not set one.
   */
  #onInvalidateInode: InvalidateInodeCallback | null = null;

  /**
   * Identity handed to the pieces loader, which for the default loader is the
   * path of a PKCS#8 key file; empty until `init()`.
   */
  #identity: string = "";

  /** API URL spaces are opened against; empty until `init()`. */
  #apiUrl: string = "";

  /**
   * In-flight connections by space name, so concurrent `connectSpace()` calls
   * share one attempt.
   */
  #connecting = new Map<string, Promise<SpaceState>>();

  /** In-flight piece-list synchronization, by space name. */
  #pieceSyncs = new Map<string, Promise<void>>();

  /**
   * Spaces whose piece-list sync must run once more after the pass in flight
   * completes.
   */
  #syncAgain: Set<string> = new Set();

  /**
   * In-flight materialization of a space's `pieces/` directory, by space name.
   */
  #pendingPieceHydrations = new Map<string, Promise<void>>();

  /**
   * Rebuilds scheduled but not yet started, by the key `#propRebuildKey()`
   * gives; a change arriving meanwhile replaces the value the rebuild will use.
   */
  #pendingPropRebuilds = new Map<
    string,
    ScheduledPropRebuild
  >();

  /** Keys of the rebuilds `#schedulePropRebuild()` has running. */
  #activePropRebuilds = new Set<string>();

  /**
   * The one rebuild held back per key while a scheduled rebuild for that key
   * runs, scheduled in turn when it finishes.
   */
  #deferredPropRebuilds = new Map<string, PropRebuildJob>();

  /** Whether `#debugLog()` writes to the console. */
  #debug = false;

  /** Counters about prop rebuilds, which `.status` reports. */
  #rebuildStats = {
    scheduled: 0,
    coalesced: 0,
    completed: 0,
    errors: 0,
    maxPending: 0,
    lastDurationMs: 0,
  };

  /** Command the shim in a callable file invokes. */
  #execCli: string;

  /**
   * What each piece root directory projects, by inode: every root under
   * `pieces/`, and every hydrated root under `entities/`.
   */
  #pieceRoots = new Map<bigint, PieceRootInfo>();

  /**
   * Entity roots that exist as directories but hold no piece tree yet, by
   * inode.
   */
  #unhydratedEntityRoots = new Map<
    bigint,
    UnhydratedEntityRootInfo
  >();

  /**
   * In-flight entity-root hydrations by inode, each resolving to whether the
   * root is hydrated.
   */
  #pendingEntityHydrations = new Map<bigint, Promise<boolean>>();

  /**
   * In-flight `entities/` listings by space, so concurrent readers share one
   * walk of the server's pages.
   */
  #pendingEntityDirectorySnapshots = new Map<
    SpaceState,
    Promise<readonly DirectorySnapshotEntry[]>
  >();

  /** Every live entity projection by root inode, least recently used first. */
  #entityProjectionLru = new Map<bigint, UnhydratedEntityRootInfo>();

  /**
   * The subset of `#entityProjectionLru` that may be evicted: roots with no
   * hydration in flight and no kernel reference held on them.
   */
  #entityProjectionEvictionCandidates = new Map<
    bigint,
    UnhydratedEntityRootInfo
  >();

  /**
   * Sequence number of each entity projection's latest use, which eviction
   * compares to find the oldest candidate.
   */
  #entityProjectionUseOrder = new Map<bigint, number>();

  /** Sequence number most recently issued to an entity-projection use. */
  #nextEntityProjectionUseOrder = 0;

  /**
   * Kernel lookup references held on each entity projection, by root inode,
   * summed over the inodes under it.
   */
  #entityProjectionLookupRefs = new Map<bigint, bigint>();

  /**
   * For each inode under an entity projection holding lookup references, the
   * root it belongs to and how many it holds.
   */
  #entityProjectionLookupOwners = new Map<
    bigint,
    EntityProjectionLookupOwner
  >();

  /**
   * Inodes holding lookup references, by the projection root they belong to;
   * the inverse of `#entityProjectionLookupOwners`.
   */
  #entityProjectionLookupOwnerInodes = new Map<bigint, Set<bigint>>();

  /**
   * Open handles held on each entity projection, by root inode, summed over the
   * inodes under it.
   */
  #entityProjectionOpenRefs = new Map<bigint, number>();

  /**
   * For each inode under an entity projection holding open handles, the root it
   * belongs to and how many it holds.
   */
  #entityProjectionOpenOwners = new Map<
    bigint,
    EntityProjectionOpenOwner
  >();

  /**
   * Inodes holding open handles, by the projection root they belong to; the
   * inverse of `#entityProjectionOpenOwners`.
   */
  #entityProjectionOpenOwnerInodes = new Map<bigint, Set<bigint>>();

  /**
   * Entity projections detached from `entities/` whose subtree waits for the
   * kernel to release its references before it is cleared, by root inode.
   */
  #pendingEntityRemovals = new Map<bigint, UnhydratedEntityRootInfo>();

  /**
   * Cancel functions of each hydrated entity root's cell subscriptions, by
   * inode.
   */
  #entitySubscriptions = new Map<bigint, Cancel[]>();

  /**
   * Which piece and prop each `input` or `result` directory belongs to, by the
   * directory's inode.
   */
  #piecePropRoots = new Map<bigint, PiecePropRootInfo>();

  /** The props of each piece root whose subtree is hydrated. */
  #hydratedPieceProps = new Map<bigint, Set<"input" | "result">>();

  /**
   * In-flight prop hydrations, keyed by piece inode and prop name as
   * `${pieceIno}-${propName}`.
   */
  #pendingHydrations = new Map<string, Promise<boolean>>();

  /**
   * Tail of the rebuild queue for each piece prop, which the next rebuild of
   * that prop chains after.
   */
  #pendingPropRebuildQueues = new Map<string, Promise<void>>();

  /**
   * Invalidation epoch per hydration key, advanced whenever the prop's value is
   * superseded so that a hydration in flight re-reads.
   */
  #hydrationEpochs = new Map<string, number>();

  /**
   * Names an [FS] projection put at each piece root, by piece inode, so they
   * can be removed when the result stops projecting one.
   */
  #fsProjectionEntries: Map<bigint, Set<string>> = new Map();

  /** Whether nodes get CFC annotations. */
  #cfcAnnotationsEnabled = false;

  /**
   * Generation to stamp every CFC annotation with, when the options supplied
   * one; otherwise one is derived per projection.
   */
  #explicitCfcProjectionGeneration: string | undefined;

  /** Extra fields `.status` reports, when the options supplied a provider. */
  #statusProvider: (() => Record<string, unknown>) | undefined;

  /**
   * Called after each rebuild of a piece prop and each build of a source
   * tree, when the options supplied a callback.
   */
  #onCfcProjectionRebuilt: (() => void) | undefined;

  /**
   * Loader reconnection probes open spaces with; falls back to `#piecesLoader`.
   */
  #reconnectPiecesLoader: CellBridgeOptions["reconnectPiecesLoader"];

  /**
   * Loader spaces are opened with; `openSpacePieces()` when none was supplied.
   */
  #piecesLoader: CellBridgeOptions["loadPieces"];

  /** How many entity projections the cache keeps before evicting. */
  #maxEntityProjections: number;

  /**
   * When this bridge was constructed, as the ISO 8601 timestamp `.status`
   * reports.
   */
  #startedAt = new Date().toISOString();

  /**
   * Whether a write failed with a transport error and no reconnection probe has
   * succeeded since. While set, the mount presents every file read-only, so a
   * writer learns of the loss at once instead of losing data silently;
   * `#attemptReconnect()` clears it.
   */
  #disconnected = false;

  /**
   * How many disconnections and failed reconnection probes have occurred since
   * the last successful probe; the exponent of the reconnection backoff.
   */
  #disconnectCount = 0;

  /**
   * Reason the most recent `markDisconnected()` gave, or `null` if none has
   * happened.
   */
  #lastDisconnectReason: string | null = null;

  /** The scheduled reconnection attempt, or `null` when none is pending. */
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Constructs an instance projecting spaces into `tree`, whose callable files
   * run `execCli`.
   *
   * @throws If `options.maxEntityProjections` is not a positive integer.
   */
  constructor(tree: FsTree, execCli = "", options: CellBridgeOptions = {}) {
    this.#tree = tree;
    this.#execCli = execCli;
    this.#cfcAnnotationsEnabled = options.cfcAnnotations ?? false;
    this.#explicitCfcProjectionGeneration = options.projectionGeneration;
    this.#statusProvider = options.statusProvider;
    this.#onCfcProjectionRebuilt = options.onCfcProjectionRebuilt;
    this.#reconnectPiecesLoader = options.reconnectPiecesLoader;
    this.#piecesLoader = options.loadPieces;
    this.#maxEntityProjections = options.maxEntityProjections ??
      DEFAULT_MAX_ENTITY_PROJECTIONS;
    if (
      !Number.isSafeInteger(this.#maxEntityProjections) ||
      this.#maxEntityProjections < 1
    ) {
      throw new RangeError("maxEntityProjections must be a positive integer");
    }
  }

  //
  // Instance members
  //

  /**
   * What this bridge keeps to itself and a test drives directly. The tables:
   * `pieceSyncs`, `syncAgain`, and `pendingPieceHydrations` for piece-list
   * work; `unhydratedEntityRoots`, `pendingEntityHydrations`,
   * `entityProjectionLru`, `entityProjectionEvictionCandidates`,
   * `entityProjectionUseOrder`, `entityProjectionLookupRefs`,
   * `entityProjectionLookupOwners`, `pendingEntityRemovals`, and
   * `entitySubscriptions` for entity projections; and the `disconnected` flag
   * with its `reconnectTimer`. The steps: `attemptReconnect`,
   * `removeFailedSpaceTree`, and `buildSpaceTree` for a space's connection;
   * `enqueuePiecePropRebuild`, `rebuildPieceProp`, and `hydratePieceProp` for
   * a prop's rebuild; `addPieceToSpace`, `syncPieceListOnce`,
   * `updatePiecesJson`, `updateIndexJson`, `subscribePiece`,
   * `makeLinkResolver`, `loadPieceTree`, `refreshPiecePatternMetadata`, and
   * `buildSourceTree` for a piece's projection.
   */
  get accessForTestingOnly(): {
    readonly pieceSyncs: Map<string, Promise<void>>;
    readonly syncAgain: Set<string>;
    readonly pendingPieceHydrations: Map<string, Promise<void>>;
    readonly unhydratedEntityRoots: Map<bigint, UnhydratedEntityRootInfo>;
    readonly pendingEntityHydrations: Map<bigint, Promise<boolean>>;
    entityProjectionLru: Map<bigint, UnhydratedEntityRootInfo>;
    entityProjectionEvictionCandidates: Map<bigint, UnhydratedEntityRootInfo>;
    readonly entityProjectionUseOrder: Map<bigint, number>;
    readonly entityProjectionLookupRefs: Map<bigint, bigint>;
    entityProjectionLookupOwners: Map<bigint, EntityProjectionLookupOwner>;
    readonly pendingEntityRemovals: Map<bigint, UnhydratedEntityRootInfo>;
    readonly entitySubscriptions: Map<bigint, Cancel[]>;
    disconnected: boolean;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    attemptReconnect(): Promise<void>;
    removeFailedSpaceTree(spaceName: string, state: SpaceState): void;
    enqueuePiecePropRebuild(args: PropRebuildJob): Promise<void>;
    hydratePieceProp(
      pieceIno: bigint,
      propName: "input" | "result",
      retries?: number,
    ): Promise<boolean>;
    buildSpaceTree(spaceName: string, pieces: PiecesController): SpaceState;
    addPieceToSpace(
      state: SpaceState,
      piece: PieceController,
      spaceName: string,
    ): Promise<string>;
    syncPieceListOnce(state: SpaceState, spaceName: string): Promise<void>;
    updatePiecesJson(state: SpaceState): void;
    subscribePiece(
      piece: PieceController,
      pieceIno: bigint,
      pieceName: string,
      spaceName: string,
      state: SpaceState,
    ): Promise<Cancel[]>;
    makeLinkResolver(spaceName: string): ResolveLink;
    loadPieceTree(
      piece: PieceController,
      parentIno: bigint,
      name: string,
      spaceName: string,
      existingIno?: bigint,
      rootKind?: "pieces" | "entities",
    ): Promise<bigint>;
    refreshPiecePatternMetadata(
      state: SpaceState,
      piece: PieceController,
      pieceIno: bigint,
    ): Promise<void>;
    rebuildPieceProp(args: PropRebuildJob): Promise<void>;
    updateIndexJson(state: SpaceState): void;
    buildSourceTree(
      pieceIno: bigint,
      piece: PieceController,
      state: SpaceState,
      pieceName: string,
    ): Promise<void>;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      pieceSyncs: this.#pieceSyncs,
      syncAgain: this.#syncAgain,
      pendingPieceHydrations: this.#pendingPieceHydrations,
      unhydratedEntityRoots: this.#unhydratedEntityRoots,
      pendingEntityHydrations: this.#pendingEntityHydrations,
      get entityProjectionLru() {
        return outerThis.#entityProjectionLru;
      },
      set entityProjectionLru(value) {
        outerThis.#entityProjectionLru = value;
      },
      get entityProjectionEvictionCandidates() {
        return outerThis.#entityProjectionEvictionCandidates;
      },
      set entityProjectionEvictionCandidates(value) {
        outerThis.#entityProjectionEvictionCandidates = value;
      },
      entityProjectionUseOrder: this.#entityProjectionUseOrder,
      entityProjectionLookupRefs: this.#entityProjectionLookupRefs,
      get entityProjectionLookupOwners() {
        return outerThis.#entityProjectionLookupOwners;
      },
      set entityProjectionLookupOwners(value) {
        outerThis.#entityProjectionLookupOwners = value;
      },
      pendingEntityRemovals: this.#pendingEntityRemovals,
      entitySubscriptions: this.#entitySubscriptions,
      get disconnected() {
        return outerThis.#disconnected;
      },
      set disconnected(value) {
        outerThis.#disconnected = value;
      },
      get reconnectTimer() {
        return outerThis.#reconnectTimer;
      },
      set reconnectTimer(value) {
        outerThis.#reconnectTimer = value;
      },
      attemptReconnect: () => this.#attemptReconnect(),
      removeFailedSpaceTree: (spaceName, state) =>
        this.#removeFailedSpaceTree(spaceName, state),
      enqueuePiecePropRebuild: (args) => this.#enqueuePiecePropRebuild(args),
      hydratePieceProp: (pieceIno, propName, retries) =>
        this.#hydratePieceProp(pieceIno, propName, retries),
      buildSpaceTree: (spaceName, pieces) =>
        this.#buildSpaceTree(spaceName, pieces),
      addPieceToSpace: (state, piece, spaceName) =>
        this.#addPieceToSpace(state, piece, spaceName),
      syncPieceListOnce: (state, spaceName) =>
        this.#syncPieceListOnce(state, spaceName),
      updatePiecesJson: (state) => this.#updatePiecesJson(state),
      subscribePiece: (piece, pieceIno, pieceName, spaceName, state) =>
        this.#subscribePiece(piece, pieceIno, pieceName, spaceName, state),
      makeLinkResolver: (spaceName) => this.#makeLinkResolver(spaceName),
      loadPieceTree: (
        piece,
        parentIno,
        name,
        spaceName,
        existingIno,
        rootKind,
      ) =>
        this.#loadPieceTree(
          piece,
          parentIno,
          name,
          spaceName,
          existingIno,
          rootKind,
        ),
      refreshPiecePatternMetadata: (state, piece, pieceIno) =>
        this.#refreshPiecePatternMetadata(state, piece, pieceIno),
      rebuildPieceProp: (args) => this.#rebuildPieceProp(args),
      updateIndexJson: (state) => this.#updateIndexJson(state),
      buildSourceTree: (pieceIno, piece, state, pieceName) =>
        this.#buildSourceTree(pieceIno, piece, state, pieceName),
    };
  }

  /** The filesystem tree this bridge projects into. */
  get tree(): FsTree {
    return this.#tree;
  }

  /** Connected spaces by name. */
  get spaces(): Map<string, SpaceState> {
    return this.#spaces;
  }

  /** Known space name to DID mapping, which `.spaces.json` lists. */
  get knownSpaces(): Map<string, string> {
    return this.#knownSpaces;
  }

  /**
   * Callback for dropping a directory's cached entries by name, which the mount
   * sets; `null` until then.
   */
  get onInvalidate(): InvalidateCallback | null {
    return this.#onInvalidate;
  }

  set onInvalidate(value: InvalidateCallback | null) {
    this.#onInvalidate = value;
  }

  /**
   * Callback for dropping an inode's cached attributes and data, which the
   * mount sets; `null` until then.
   */
  get onInvalidateInode(): InvalidateInodeCallback | null {
    return this.#onInvalidateInode;
  }

  set onInvalidateInode(value: InvalidateInodeCallback | null) {
    this.#onInvalidateInode = value;
  }

  /**
   * Whether the backend connection is lost, which the mount reads as read-only;
   * see `markDisconnected()`.
   */
  get disconnected(): boolean {
    return this.#disconnected;
  }

  /**
   * Marks the bridge disconnected for `reason`, logs it, and schedules the
   * first reconnection attempt. Does nothing when already disconnected.
   */
  markDisconnected(reason: string): void {
    if (this.#disconnected) return;
    this.#disconnected = true;
    this.#disconnectCount++;
    this.#lastDisconnectReason = reason;
    console.error(
      `[FUSE] Backend connection lost (${reason}) — mount is READ-ONLY. ` +
        `Will attempt reconnection in ${this.#reconnectDelayMs()}ms.`,
    );
    this.#scheduleReconnect();
  }

  /** Sets the API URL and identity that spaces are opened with. */
  init(config: {
    apiUrl: string;
    identity: string;
  }): void {
    this.#apiUrl = config.apiUrl;
    this.#identity = config.identity;
  }

  /** Turns debug logging on or off. */
  setDebug(debug: boolean): void {
    this.#debug = debug;
  }

  /**
   * Creates the `.status` file at the mount root.
   *
   * The file is generated: `#getStatusJson()` runs when a reader asks the tree
   * for the file's size, and no caller has to announce that a counter moved.
   */
  initStatus(): void {
    this.#tree.addGeneratedFile(
      this.#tree.rootIno,
      ".status",
      () => this.#getStatusJson(),
      "object",
    );
  }

  /**
   * Connects to `spaceName` and builds its directory tree, or returns the state
   * of a space already connected. Concurrent calls for one space share a single
   * attempt.
   *
   * @throws If the space cannot be opened or its connection cannot be verified;
   *   whatever was built for it is removed first.
   */
  async connectSpace(spaceName: string): Promise<SpaceState> {
    const existing = this.#spaces.get(spaceName);
    if (existing) return existing;

    const existingConnection = this.#connecting.get(spaceName);
    if (existingConnection) return await existingConnection;

    const connection = this.#connectSpaceOnce(spaceName).finally(() => {
      if (this.#connecting.get(spaceName) === connection) {
        this.#connecting.delete(spaceName);
      }
    });
    this.#connecting.set(spaceName, connection);
    return await connection;
  }

  /** Returns whether a connection to `spaceName` is in flight. */
  isConnecting(spaceName: string): boolean {
    return this.#connecting.has(spaceName);
  }

  /**
   * Records `count` kernel lookup references on `ino` for the entity projection
   * it sits under, which keeps that projection from being evicted. Does nothing
   * for an inode outside every entity projection, or for a non-positive
   * `count`.
   */
  retainEntityProjectionLookup(ino: bigint, count = 1n): void {
    if (count <= 0n) return;
    const owner = this.#entityProjectionLookupOwners.get(ino);
    const rootIno = owner?.rootIno ?? this.#entityProjectionRootForInode(ino);
    if (rootIno === undefined) return;
    if (owner === undefined) {
      this.#indexEntityProjectionOwner(
        this.#entityProjectionLookupOwnerInodes,
        rootIno,
        ino,
      );
    }
    this.#entityProjectionLookupOwners.set(ino, {
      rootIno,
      count: (owner?.count ?? 0n) + count,
    });
    this.#entityProjectionLookupRefs.set(
      rootIno,
      (this.#entityProjectionLookupRefs.get(rootIno) ?? 0n) + count,
    );
    this.#entityProjectionEvictionCandidates.delete(rootIno);
  }

  /**
   * Releases `count` of the lookup references `ino` holds, never more than it
   * holds, then trims the cache, which may evict other candidates. When the
   * projection's last reference goes, this also finishes a removal waiting on
   * it or makes it an eviction candidate. Does nothing for an inode holding
   * none, or for a non-positive `count`.
   */
  releaseEntityProjectionLookup(ino: bigint, count = 1n): void {
    if (count <= 0n) return;
    const owner = this.#entityProjectionLookupOwners.get(ino);
    if (owner === undefined) return;
    const released = count > owner.count ? owner.count : count;
    const ownerRemaining = owner.count - released;
    if (ownerRemaining > 0n) {
      this.#entityProjectionLookupOwners.set(ino, {
        rootIno: owner.rootIno,
        count: ownerRemaining,
      });
    } else {
      this.#entityProjectionLookupOwners.delete(ino);
      this.#unindexEntityProjectionOwner(
        this.#entityProjectionLookupOwnerInodes,
        owner.rootIno,
        ino,
      );
    }
    const remaining =
      (this.#entityProjectionLookupRefs.get(owner.rootIno) ?? 0n) - released;
    if (remaining > 0n) {
      this.#entityProjectionLookupRefs.set(owner.rootIno, remaining);
    } else {
      this.#entityProjectionLookupRefs.delete(owner.rootIno);
    }
    this.#finishPendingEntityRemoval(owner.rootIno);
    this.#refreshEntityProjectionEvictionCandidate(owner.rootIno);
    this.#trimEntityProjectionCache();
  }

  /**
   * Records one open handle on `ino` for the entity projection it sits under,
   * which keeps that projection from being evicted. Does nothing for an inode
   * outside every entity projection.
   */
  retainEntityProjectionOpen(ino: bigint): void {
    const owner = this.#entityProjectionOpenOwners.get(ino);
    const rootIno = owner?.rootIno ?? this.#entityProjectionRootForInode(ino);
    if (rootIno === undefined) return;
    if (owner === undefined) {
      this.#indexEntityProjectionOwner(
        this.#entityProjectionOpenOwnerInodes,
        rootIno,
        ino,
      );
    }
    this.#entityProjectionOpenOwners.set(ino, {
      rootIno,
      count: (owner?.count ?? 0) + 1,
    });
    this.#entityProjectionOpenRefs.set(
      rootIno,
      (this.#entityProjectionOpenRefs.get(rootIno) ?? 0) + 1,
    );
    this.#entityProjectionEvictionCandidates.delete(rootIno);
  }

  /**
   * Releases one of the open handles `ino` holds, then trims the cache, which
   * may evict other candidates. When the projection's last reference goes,
   * this also finishes a removal waiting on it or makes it an eviction
   * candidate. Does nothing for an inode holding none.
   */
  releaseEntityProjectionOpen(ino: bigint): void {
    const owner = this.#entityProjectionOpenOwners.get(ino);
    if (owner === undefined) return;
    if (owner.count > 1) {
      this.#entityProjectionOpenOwners.set(ino, {
        rootIno: owner.rootIno,
        count: owner.count - 1,
      });
    } else {
      this.#entityProjectionOpenOwners.delete(ino);
      this.#unindexEntityProjectionOwner(
        this.#entityProjectionOpenOwnerInodes,
        owner.rootIno,
        ino,
      );
    }
    const remaining = (this.#entityProjectionOpenRefs.get(owner.rootIno) ?? 0) -
      1;
    if (remaining > 0) {
      this.#entityProjectionOpenRefs.set(owner.rootIno, remaining);
    } else {
      this.#entityProjectionOpenRefs.delete(owner.rootIno);
    }
    this.#finishPendingEntityRemoval(owner.rootIno);
    this.#refreshEntityProjectionEvictionCandidate(owner.rootIno);
    this.#trimEntityProjectionCache();
  }

  /**
   * Returns whether a lookup of `name` under `parentIno` may need this bridge
   * to hydrate something first: the parent is a `pieces/` directory, an
   * `entities/` directory, an unhydrated entity root, a piece root, or a prop
   * directory. Except under `pieces/`, a dot-prefixed name other than
   * `.handlers` needs nothing.
   */
  shouldPrepareLookup(parentIno: bigint, name: string): boolean {
    if (this.#stateForPiecesDir(parentIno)) return true;
    if (name.startsWith(".") && name !== ".handlers") return false;
    if (this.isEntitiesDir(parentIno)) return true;
    if (this.#unhydratedEntityRoots.has(parentIno)) return true;
    if (this.#pieceRoots.has(parentIno)) return true;
    if (this.#piecePropRoots.has(parentIno)) return true;
    return false;
  }

  /**
   * Returns whether listing `ino` may need this bridge to hydrate something
   * first: it is a `pieces/` or `entities/` directory, an unhydrated entity
   * root, a piece root, or a prop directory.
   */
  shouldPrepareDirectory(ino: bigint): boolean {
    return this.#stateForPiecesDir(ino) !== undefined ||
      this.isEntitiesDir(ino) || this.#unhydratedEntityRoots.has(ino) ||
      this.#pieceRoots.has(ino) || this.#piecePropRoots.has(ino);
  }

  /**
   * Returns whether a lookup under `parentIno` must wait for `prepareLookup()`
   * before it replies, rather than replying from the tree and hydrating in the
   * background: true under `pieces/`, `entities/`, any directory of an entity
   * projection, and any prop directory.
   */
  shouldSynchronizeLookup(parentIno: bigint): boolean {
    return this.#stateForPiecesDir(parentIno) !== undefined ||
      this.isEntitiesDir(parentIno) ||
      this.#isEntityProjectionDirectory(parentIno) ||
      this.#piecePropRoots.has(parentIno);
  }

  /**
   * Hydrates whatever a lookup of `name` under `parentIno` needs — the
   * space's piece list, the entity's projection, or the piece prop the name
   * belongs to — and returns whether the name should resolve. Under a piece
   * root, `input`, `result`, their `.json` files, `index.md`, `index.json`,
   * and `.handlers` resolve true once their prop's hydration has been
   * attempted, whether or not it succeeded, and any other name resolves if
   * the tree holds it. Returns false for a parent this bridge does not
   * prepare, and for an entity root whose hydration fails.
   */
  async prepareLookup(parentIno: bigint, name: string): Promise<boolean> {
    const pieces = this.#stateForPiecesDir(parentIno);
    if (pieces) {
      await this.#materializePieces(pieces.state, pieces.spaceName);
      return this.#tree.lookup(parentIno, name) !== undefined;
    }

    if (this.isEntitiesDir(parentIno)) {
      return await this.resolveEntity(parentIno, name);
    }

    if (this.#unhydratedEntityRoots.has(parentIno)) {
      if (!await this.#hydrateEntityRoot(parentIno)) return false;
    }

    const pieceInfo = this.#getPieceInfo(parentIno);
    if (pieceInfo) {
      if (name === "input" || name === "input.json") {
        await this.#hydratePieceProp(parentIno, "input");
        return true;
      }
      if (
        name === "result" || name === "result.json" ||
        name === "index.md" || name === "index.json" || name === ".handlers"
      ) {
        await this.#hydratePieceProp(parentIno, "result");
        return true;
      }
      return this.#tree.lookup(parentIno, name) !== undefined;
    }

    const propInfo = this.#piecePropRoots.get(parentIno);
    if (propInfo) {
      await this.#hydratePieceProp(propInfo.pieceIno, propInfo.propName);
      return true;
    }

    return false;
  }

  /**
   * Prepares a lookup of `name` under `parentIno` as `prepareLookup()` does,
   * and returns the inode the reply names with one lookup reference retained on
   * it, or `undefined` when the name does not resolve.
   */
  async prepareLookupForReply(
    parentIno: bigint,
    name: string,
  ): Promise<bigint | undefined> {
    let ino: bigint | undefined;
    if (this.isEntitiesDir(parentIno)) {
      return await this.#resolveEntityInode(parentIno, name, true);
    } else {
      if (!await this.prepareLookup(parentIno, name)) return undefined;
      ino = this.#tree.lookup(parentIno, name);
    }
    if (ino === undefined || this.#tree.getNode(ino) === undefined) {
      return undefined;
    }
    this.retainEntityProjectionLookup(ino);
    return ino;
  }

  /**
   * Hydrates whatever listing `ino` needs — the space's piece list, both
   * props of a piece root, or the one prop of a prop directory — and returns
   * whether `ino` is a directory this bridge prepares. An `entities/`
   * directory and any directory of an entity projection need no work here and
   * return true.
   */
  async prepareDirectory(ino: bigint): Promise<boolean> {
    const pieces = this.#stateForPiecesDir(ino);
    if (pieces) {
      await this.#materializePieces(pieces.state, pieces.spaceName);
      return true;
    }

    const entities = this.#stateForEntitiesDir(ino);
    if (entities) {
      return true;
    }

    if (this.#isEntityProjectionDirectory(ino)) {
      return true;
    }

    const pieceInfo = this.#getPieceInfo(ino);
    if (pieceInfo) {
      await this.#hydratePieceProp(ino, "input");
      await this.#hydratePieceProp(ino, "result");
      return true;
    }

    const propInfo = this.#piecePropRoots.get(ino);
    if (propInfo) {
      await this.#hydratePieceProp(propInfo.pieceIno, propInfo.propName);
      return true;
    }

    return false;
  }

  /**
   * Returns the entries a listing of `ino` shows when this bridge decides them
   * rather than the tree: for an `entities/` directory, the live entity ids
   * fetched from the server, after pruning the projections of ids not among
   * them; for a directory of an entity projection, `.` and `..` alone, so its
   * entries are reached by name. For any other directory, prepares it as
   * `prepareDirectory()` does and returns `undefined`, so the caller lists the
   * tree.
   */
  async prepareDirectorySnapshot(
    ino: bigint,
  ): Promise<readonly DirectorySnapshotEntry[] | undefined> {
    const entities = this.#stateForEntitiesDir(ino);
    if (entities) {
      return await this.#entityDirectorySnapshot(entities.state);
    }

    if (this.#isEntityProjectionDirectory(ino)) {
      return collectVirtualDirectorySnapshot(this.#tree, ino, []);
    }

    await this.prepareDirectory(ino);
    return undefined;
  }

  /**
   * Resolves `ino` to the cell path a write to it lands on: the space, piece,
   * and cell it sits under, and the path within the cell's value, with a
   * non-negative integer segment as an array index. `index.md` and `index.json`
   * resolve to the result cell as an [FS] projection write, and a `.json` file
   * to the value at its path. Returns `null` for an inode outside
   * `/<space>/pieces/<piece>/`, for `meta.json` and `.handlers`, for a space
   * not connected or a piece not tracked, and for any other name at the cell
   * level, `.src` among them.
   */
  resolveWritePath(ino: bigint): WritePath | null {
    // Walk up to root collecting segments
    const segments: string[] = [];
    let current = ino;
    while (current !== this.#tree.rootIno) {
      const name = this.#tree.getNameForIno(current);
      if (name === undefined) return null;
      segments.unshift(name);
      const parentIno = this.#tree.parents.get(current);
      if (parentIno === undefined) return null;
      current = parentIno;
    }

    // segments: [spaceName, "pieces", pieceName, cell, ...jsonPath]
    // Minimum: spaceName/pieces/pieceName/cell = 4 segments
    if (segments.length < 4) return null;

    const spaceName = decodeSpaceDirectoryName(segments[0]);
    if (segments[1] !== "pieces") return null;
    const pieceName = segments[2];

    // Read-only files
    const cellSegment = segments[3];
    if (cellSegment === "meta.json") return null;
    if (cellSegment === ".handlers") return null;

    // Find the space and piece controller
    const space = this.#spaces.get(spaceName);
    if (!space) return null;
    const piece = space.pieceControllers.get(pieceName);
    if (!piece) return null;

    // Handle [FS] projection index files
    if (cellSegment === "index.md") {
      return {
        spaceName,
        pieceName,
        cell: "result",
        jsonPath: [],
        isJsonFile: false,
        piece,
        fsProjection: "markdown",
      };
    }
    if (cellSegment === "index.json") {
      return {
        spaceName,
        pieceName,
        cell: "result",
        jsonPath: [],
        isJsonFile: false,
        piece,
        fsProjection: "json",
      };
    }

    // Handle .json sibling files: result.json, input.json, result/items.json
    let cell: "input" | "result";
    let jsonPath: (string | number)[];
    let isJsonFile = false;

    if (cellSegment === "input.json" || cellSegment === "result.json") {
      // Top-level .json file: replaces entire cell
      cell = cellSegment.replace(".json", "") as "input" | "result";
      jsonPath = [];
      isJsonFile = true;
    } else if (cellSegment === "input" || cellSegment === "result") {
      cell = cellSegment;
      // Remaining segments form the JSON path
      const remaining = segments.slice(4);

      // Check for .json suffix on the last segment
      if (remaining.length > 0) {
        const last = remaining[remaining.length - 1];
        if (last.endsWith(".json")) {
          remaining[remaining.length - 1] = last.slice(0, -5);
          isJsonFile = true;
        }
      }

      // Convert numeric segments to numbers for array indexing
      jsonPath = remaining.map((s) => {
        const decoded = decodeFuseComponent(s);
        const n = Number(decoded);
        return Number.isInteger(n) && n >= 0 && String(n) === decoded
          ? n
          : decoded;
      });
    } else {
      // Not a recognized cell segment
      return null;
    }

    return { spaceName, pieceName, cell, jsonPath, isJsonFile, piece };
  }

  /**
   * Resolves `ino` to the source file a write to it lands on, under a piece's
   * `.src/` directory. Returns `null` for an inode outside
   * `/<space>/pieces/<piece>/.src/`, for a space not connected or a piece not
   * tracked, for a piece with no source tree, and for the synthetic
   * `error.log`, which is told apart by inode so that an authored file of that
   * name stays writable.
   */
  resolveSourceWritePath(ino: bigint): SourceWritePath | null {
    // Walk up to root collecting segments
    const segments: string[] = [];
    let current = ino;
    while (current !== this.#tree.rootIno) {
      const name = this.#tree.getNameForIno(current);
      if (name === undefined) return null;
      segments.unshift(name);
      const parentIno = this.#tree.parents.get(current);
      if (parentIno === undefined) return null;
      current = parentIno;
    }

    // segments: [spaceName, "pieces", pieceName, ".src", ...relSegments]
    if (segments.length < 5) return null;
    if (segments[1] !== "pieces") return null;
    if (segments[3] !== ".src") return null;

    const spaceName = decodeSpaceDirectoryName(segments[0]);
    const pieceName = segments[2];
    const relPath = decodeFusePathSegments(segments.slice(4)).join("/");

    const space = this.#spaces.get(spaceName);
    if (!space) return null;
    const piece = space.pieceControllers.get(pieceName);
    if (!piece) return null;
    const srcIno = space.srcInos.get(pieceName);
    if (srcIno === undefined) return null;

    // Block writes to the synthetic error.log (identified by inode, not name,
    // so a real source file named error.log remains writable).
    const errorLogIno = space.srcErrorLogInos.get(pieceName);
    if (errorLogIno !== undefined && ino === errorLogIno) return null;

    return { spaceName, pieceName, relPath, piece, srcIno };
  }

  /**
   * Sends `value` to the handler cell the callable file `ino` stands for, and
   * returns once the runtime is idle and the space is synced.
   *
   * @throws If `ino` does not resolve to a handler.
   */
  async sendToHandler(ino: bigint, value: unknown): Promise<void> {
    const target = this.resolveHandlerTarget(ino);
    if (!target) {
      throw new Error("Not a handler node");
    }
    await this.sendToHandlerTarget(target, value);
  }

  /**
   * Resolves the callable file `ino` to the handler cell it stands for, or
   * `null` when `ino` is not a handler file, its path does not parse as one, or
   * its space or piece is not tracked.
   */
  resolveHandlerTarget(ino: bigint): HandlerTarget | null {
    const node = this.#tree.getNode(ino);
    if (
      !node || node.kind !== "callable" || node.callableKind !== "handler"
    ) {
      return null;
    }

    const parsed = parseMountedCallablePath(this.#tree.getPath(ino));
    if (!parsed || parsed.callableKind !== "handler") {
      return null;
    }

    const space = this.#spaces.get(parsed.spaceName);
    if (!space) return null;

    const piece = this.#resolvePieceController(space, parsed);
    if (!piece) return null;

    return {
      piece,
      cellProp: node.cellProp,
      cellKey: node.cellKey,
    };
  }

  /**
   * Sends `value` to `target`'s handler cell, and returns once the runtime is
   * idle and the space is synced.
   */
  async sendToHandlerTarget(
    target: HandlerTarget,
    value: unknown,
  ): Promise<void> {
    const rootCell = await target.piece[target.cellProp].getCell();
    const handlerCell = rootCell.key(target.cellKey as keyof unknown) as Cell<
      unknown
    >;
    handlerCell.send(value);
    await target.piece.pieces().runtime.idle();
    await target.piece.pieces().synced();
  }

  /**
   * Drops the hydrated `input` or `result` `writePath` names, in every root
   * projecting its piece under `pieces/` and `entities/` across the connected
   * spaces, back to a stub, and invalidates the kernel caches that covered it,
   * so the next lookup or listing re-reads the cell.
   */
  invalidateWritePath(writePath: WritePath): void {
    this.#invalidatePieceIdPropCache(writePath.piece.id, writePath.cell);
  }

  /**
   * Rebuilds the prop `writePath` wrote to from the cell's current value,
   * queued after any rebuild in flight for it. A piece absent from its space's
   * tree gets `invalidateWritePath()` instead.
   */
  async finalizeWritePath(writePath: WritePath): Promise<void> {
    const state = this.#spaces.get(writePath.spaceName);
    const pieceIno = state?.pieceInos.get(writePath.pieceName);
    if (pieceIno === undefined) {
      this.invalidateWritePath(writePath);
      return;
    }
    const cell = await writePath.piece[writePath.cell].getCell();
    const newValue = await writePath.piece[writePath.cell].get();
    await this.#enqueuePiecePropRebuild({
      cell,
      newValue,
      pieceId: writePath.piece.id,
      pieceIno,
      pieceName: writePath.pieceName,
      propName: writePath.cell,
      resolveLink: this.#makeLinkResolver(writePath.spaceName),
      spaceName: writePath.spaceName,
    });
  }

  /**
   * Rebuilds a piece's source tree and pattern metadata after a write.
   *
   * `receipt` is the source update the write committed, when it made one. Its
   * refresh outcome is reported here rather than by the caller because the
   * rebuild below replaces `.src` and the synthetic `error.log` inside it: a
   * report written before this call is discarded along with the inode it went
   * to, so the only place a report survives is after the rebuild, which is
   * inside this method.
   */
  async finalizeSourceWritePath(
    writePath: SourceWritePath,
    receipt?: PatternUpdateReceipt,
  ): Promise<void> {
    try {
      const state = this.#spaces.get(writePath.spaceName);
      const pieceIno = state?.pieceInos.get(writePath.pieceName);
      if (state && pieceIno !== undefined) {
        await this.#buildSourceTree(
          pieceIno,
          writePath.piece,
          state,
          writePath.pieceName,
        );
        await this.#refreshPiecePatternMetadata(
          state,
          writePath.piece,
          pieceIno,
        );
      }
    } finally {
      // Reported whether or not the rebuild survived: "the source saved and
      // the piece is not running it" is exactly the message a projection
      // failure must not eat, and it is the receipt's, not the rebuild's.
      // On a failed rebuild the console line still fires and the file half
      // lands wherever a synthetic log is standing. The caller then retains
      // it when the rebuild's own warning becomes the complete persistent
      // diagnostic.
      this.reportSourceRefreshWarning(
        writePath,
        sourceRefreshWarning(receipt),
      );
    }
  }

  /**
   * Reports that a source write committed and then failed to refresh the
   * running piece, into `.src/error.log` as that directory stands now.
   * `undefined` is the refresh having succeeded, and reports nothing.
   *
   * The directory a caller was handed is not the one to write into after a
   * finalize: `#buildSourceTree()` replaces `.src` wholesale and mints a fresh
   * empty `error.log` inside it, so both the text written before that and the
   * inode it was written to are gone. Resolving the directory here, from the
   * state the rebuild updated, is what lets a report outlive the rebuild that a
   * successful write performs.
   *
   * A piece with no synthetic `error.log` has nowhere to keep the report: a
   * system piece or one the rebuild skipped has no source tree at all, and a
   * piece whose own source contains a file called `error.log` keeps that file
   * instead — the synthetic one is only minted when the name is free. The
   * console line stands in for the file in both cases, which is why the inode
   * is read from `srcErrorLogInos` rather than looked up by name: resolving by
   * name would find the authored file and overwrite committed source with this
   * report.
   */
  reportSourceRefreshWarning(
    writePath: SourceWritePath,
    warning: string | undefined,
  ): void {
    if (warning === undefined) return;
    console.error(`[source] ${warning}`);
    this.writeSourceErrorLog(writePath, warning);
  }

  /**
   * Writes the synthetic `.src/error.log`, and only ever that file.
   *
   * Every mutation of the log goes through here — the clear a clean write
   * performs, the diagnostic a failed one leaves, and the refresh warning
   * above — because the file is identified by the inode `#buildSourceTree()`
   * recorded when it minted it, never by name. A pattern is free to author a
   * source file called `error.log`, and resolving by name would find that file
   * and overwrite the mounted copy of committed source with a diagnostic,
   * which the mount would then be able to save back.
   *
   * A piece with no synthetic log gets no file write and no error: the console
   * lines its callers already emit are the report such a piece gets.
   */
  writeSourceErrorLog(writePath: SourceWritePath, text: string): void {
    const state = this.#spaces.get(writePath.spaceName);
    const errorLogIno = state?.srcErrorLogInos.get(writePath.pieceName);
    if (errorLogIno === undefined) return;
    // The map is dropped whenever `.src` is rebuilt, so a tracked inode names
    // a live file. Checked anyway: a write through a stale one throws, which
    // would turn a committed source update into a failed one at the mount.
    const node = this.#tree.getNode(errorLogIno);
    if (node?.kind !== "file") return;
    this.#tree.updateFile(errorLogIno, text);
  }

  /**
   * Drops the hydrated prop holding `target`'s handler cell, in every root
   * projecting its piece, the way `invalidateWritePath()` does.
   */
  invalidateHandlerTarget(target: HandlerTarget): void {
    this.#invalidatePieceIdPropCache(target.piece.id, target.cellProp);
  }

  /**
   * Parses a symlink target path, relative to `parentIno`, into the sigil-link
   * components it stands for. A target under some space's `entities/` yields
   * the entity's `id`, its `path` when there is one, and its `space` when that
   * is not the parent's own — as the space's DID when known, else its name. A
   * target under the same piece with no `entities/` segment yields only `path`.
   * Returns `null` if the target escapes the mount root or matches neither
   * shape.
   */
  parseSymlinkTarget(
    parentIno: bigint,
    target: string,
  ): { id?: string; path?: string[]; space?: string } | null {
    // Get parent's absolute path segments from mount root
    const parentSegments: string[] = [];
    let current = parentIno;
    while (current !== this.#tree.rootIno) {
      const name = this.#tree.getNameForIno(current);
      if (name === undefined) return null;
      parentSegments.unshift(name);
      const parent = this.#tree.parents.get(current);
      if (parent === undefined) return null;
      current = parent;
    }

    // Resolve target relative to parent path
    const resolved = [...parentSegments];
    for (const part of target.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (resolved.length === 0) return null; // escapes mount root
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    // Determine current space from parent's path
    const currentSpace = parentSegments.length > 0
      ? decodeSpaceDirectoryName(parentSegments[0])
      : undefined;

    // Match: /<space>/entities/<hash>[/<path...>]
    if (resolved.length >= 3 && resolved[1] === "entities") {
      const targetSpace = resolved[0];
      const decodedTargetSpace = decodeFuseComponent(targetSpace);
      const hash = decodeFuseComponent(resolved[2]);
      const pathParts = decodeFusePathSegments(resolved.slice(3));

      const result: { id?: string; path?: string[]; space?: string } = {
        id: hash,
      };

      if (pathParts.length > 0) {
        result.path = pathParts;
      }

      // Omit space if same as current
      if (decodedTargetSpace !== currentSpace) {
        const did = this.#knownSpaces.get(decodedTargetSpace);
        result.space = did || decodedTargetSpace;
      }

      return result;
    }

    // Self-reference: target within same piece, no entities/ segment
    // Resolved path: [space, "pieces", pieceName, cell, ...subpath]
    if (resolved.length >= 4 && resolved[1] === "pieces") {
      const subpath = decodeFusePathSegments(resolved.slice(4));
      if (subpath.length > 0) {
        return { path: subpath };
      }
    }

    return null;
  }

  /**
   * Writes `value` through the piece controller to `writePath`'s cell, at its
   * path within the value when it has one.
   */
  async writeValue(writePath: WritePath, value: unknown): Promise<void> {
    await writePath.piece[writePath.cell].set(
      value,
      writePath.jsonPath.length > 0 ? writePath.jsonPath : undefined,
    );
  }

  /**
   * Writes `text` back through the [FS] projection index file `writePath`
   * names. For `index.md`, each frontmatter key becomes a field under
   * `$FS.frontmatter`, keys absent from the new frontmatter are cleared, and
   * the body becomes `$FS.content`. For `index.json`, each key becomes a field
   * under `$FS.content` — or directly under `$FS` when the result uses the
   * plain-object shorthand — and absent keys are cleared. `entityId` is never
   * written. Returns whether the write happened: false for a `writePath` with
   * no projection, or JSON that does not parse to an object.
   */
  async writeFsFile(writePath: WritePath, text: string): Promise<boolean> {
    if (writePath.fsProjection === "markdown") {
      const { frontmatter, body } = parseFrontmatter(text);
      let existingFrontmatter: Record<string, unknown> | null = null;
      try {
        const current = await writePath.piece.result.get([
          "$FS",
          "frontmatter",
        ]);
        if (isObjectNotArray(current)) {
          existingFrontmatter = current as Record<string, unknown>;
        }
      } catch {
        // Missing frontmatter is fine.
      }
      for (const [key, val] of Object.entries(frontmatter)) {
        if (key === "entityId") continue;
        await writePath.piece.result.set(val, ["$FS", "frontmatter", key]);
      }
      if (existingFrontmatter) {
        for (const key of Object.keys(existingFrontmatter)) {
          if (key === "entityId" || key in frontmatter) continue;
          await writePath.piece.result.set(undefined, [
            "$FS",
            "frontmatter",
            key,
          ]);
        }
      }
      await writePath.piece.result.set(body, ["$FS", "content"]);
      return true;
    } else if (writePath.fsProjection === "json") {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(text);
      } catch {
        return false;
      }
      if (!isObjectNotArray(obj)) {
        return false;
      }
      // Plain-object shorthand stores keys directly under $FS instead of
      // nesting them under $FS.content.
      let isPlainObjectShorthand = false;
      let existingContent: Record<string, unknown> | null = null;
      try {
        const fsRaw = await writePath.piece.result.get(["$FS"]);
        isPlainObjectShorthand = isObjectOrArray(fsRaw) &&
          !("type" in (fsRaw as Record<string, unknown>));
        const contentRaw = isPlainObjectShorthand
          ? fsRaw
          : await writePath.piece.result.get(["$FS", "content"]);
        if (
          contentRaw && typeof contentRaw === "object" &&
          !Array.isArray(contentRaw)
        ) {
          existingContent = contentRaw as Record<string, unknown>;
        }
      } catch {
        // If we can't read current state, default to the explicit content form.
      }
      const basePath = isPlainObjectShorthand ? ["$FS"] : ["$FS", "content"];

      const existingKeys = new Set<string>(
        existingContent ? Object.keys(existingContent) : [],
      );
      for (const [key, val] of Object.entries(obj)) {
        if (key === "entityId") continue;
        await writePath.piece.result.set(val, [...basePath, key]);
        existingKeys.delete(key);
      }
      for (const key of existingKeys) {
        if (key === "entityId") continue;
        await writePath.piece.result.set(undefined, [...basePath, key]);
      }
      return true;
    }
    return false;
  }

  /**
   * Resolves `entityId`, as its directory is named, under the `entities/`
   * directory `entitiesIno`, creating or refreshing its projection, and returns
   * whether it resolved. Liveness is asked of the server by point lookup when
   * it supports one, without loading the entity's value; otherwise an existing
   * projection, or a piece known under that id, resolves.
   */
  async resolveEntity(
    entitiesIno: bigint,
    entityId: string,
  ): Promise<boolean> {
    return await this.#resolveEntityInode(entitiesIno, entityId) !== undefined;
  }

  /**
   * Returns whether `ino` is the `entities/` directory of a connected space.
   */
  isEntitiesDir(ino: bigint): boolean {
    return this.#stateForEntitiesDir(ino) !== undefined;
  }

  /**
   * Helper for reconnection scheduling, which returns the delay before the next
   * attempt: `#RECONNECT_BASE_DELAY_MS`, doubling with each failure, capped at
   * `#RECONNECT_MAX_DELAY_MS`.
   */
  #reconnectDelayMs(): number {
    return Math.min(
      CellBridge.#RECONNECT_BASE_DELAY_MS *
        Math.pow(2, this.#disconnectCount - 1),
      CellBridge.#RECONNECT_MAX_DELAY_MS,
    );
  }

  /**
   * Schedules `#attemptReconnect()` after the current backoff delay, replacing
   * any attempt already scheduled. The timer does not keep the process alive.
   */
  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    const timerId = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#attemptReconnect();
    }, this.#reconnectDelayMs());
    // Don't prevent Deno process from exiting while waiting to reconnect
    Deno.unrefTimer(timerId);
    this.#reconnectTimer = timerId;
  }

  /**
   * Probes every connected space's backend, and clears the disconnected
   * state when there is at least one and all of them answer; otherwise
   * schedules the next attempt.
   */
  async #attemptReconnect(): Promise<void> {
    const spaces = [...this.#spaces];
    let allSpacesRestored = spaces.length > 0;
    for (const [spaceName, state] of spaces) {
      try {
        const loadPieces = this.#reconnectPiecesLoader ??
          this.#piecesLoader ?? openSpacePieces;
        const probe = await loadPieces({
          apiUrl: this.#apiUrl,
          space: spaceName,
          identity: this.#identity,
          deferSpaceCellSync: true,
        });
        try {
          await this.#verifyPiecesConnection(probe);
          if (state.piecesHydrated) {
            await state.pieces.getRegisteredPieces();
          }
          // The session probe and existing pieces view verify this space.
          // probe.synced() alone can succeed from local state while the
          // backend is still unavailable.
        } finally {
          await probe.runtime.dispose().catch((e) => {
            console.warn(
              `[FUSE] Reconnect probe cleanup failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          });
        }
      } catch (e) {
        console.error(
          `[FUSE] Reconnect probe to ${spaceName} failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        allSpacesRestored = false;
      }
    }
    if (allSpacesRestored) {
      this.#disconnected = false;
      this.#disconnectCount = 0;
      console.error(
        `[FUSE] Backend connection restored — write access resumed.`,
      );
      return;
    }

    // At least one probe failed — retry with increasing backoff
    this.#disconnectCount++;
    console.error(
      `[FUSE] Reconnect failed, retrying in ${this.#reconnectDelayMs()}ms`,
    );
    this.#scheduleReconnect();
  }

  /**
   * Verifies that `pieces` reaches its backend: establishes the space session
   * and waits for it to sync.
   *
   * @throws If the storage manager holds an authorization error for the space.
   */
  async #verifyPiecesConnection(
    pieces: PiecesController,
  ): Promise<void> {
    await pieces.ensureSpaceSession?.();
    await pieces.synced?.();
    if (typeof pieces.getSpace !== "function") return;
    const authorizationError = pieces.runtime?.storageManager
      ?.authorizationError?.(pieces.getSpace());
    if (authorizationError) throw authorizationError;
  }

  /**
   * Opens `spaceName` through the configured loader, with space-cell sync
   * deferred.
   */
  async #createSpacePieces(
    spaceName: string,
  ): Promise<PiecesController> {
    const loadPieces = this.#piecesLoader ?? openSpacePieces;
    return await loadPieces({
      apiUrl: this.#apiUrl,
      space: spaceName,
      identity: this.#identity,
      deferSpaceCellSync: true,
    });
  }

  /** Writes `message` to the console when debug logging is on. */
  #debugLog(message: string): void {
    if (this.#debug) {
      console.log(message);
    }
  }

  /**
   * Returns the DID to label `spaceName`'s CFC annotations with: the connected
   * space's, else the one recorded for the name, else the name itself.
   */
  #cfcSpaceDid(spaceName: string): string {
    return this.#spaces.get(spaceName)?.did ??
      this.#knownSpaces.get(spaceName) ??
      spaceName;
  }

  /**
   * Returns the name `state`'s space is connected under, or the name recorded
   * for its DID, or `undefined` for a state this bridge does not know.
   */
  #spaceNameForState(state: SpaceState): string | undefined {
    for (const [name, candidate] of this.#spaces) {
      if (candidate === state) return name;
    }
    for (const [name, did] of this.#knownSpaces) {
      if (did === state.did) return name;
    }
    return undefined;
  }

  /**
   * Returns the CFC label view of `cell`, or `undefined` when annotations are
   * off or the view cannot be read.
   */
  #cfcLabelViewForCell(cell: Cell<unknown>): CfcLabelView | undefined {
    if (!this.#cfcAnnotationsEnabled) return undefined;
    try {
      return cfcLabelViewForCell(cell) as CfcLabelView | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Returns an annotator for the projection `options` describes, or `undefined`
   * when annotations are off. The generation it stamps on annotations is the
   * configured one, else one derived from the projection's identity, value, and
   * label view.
   */
  #makeCfcAnnotator(options: {
    spaceName: string;
    spaceDid?: string;
    pieceId?: string;
    rootKind?: "pieces" | "entities";
    cell?: "input" | "result";
    labelView?: CfcLabelView;
    value?: unknown;
  }): CfcProjectionAnnotator | undefined {
    if (!this.#cfcAnnotationsEnabled) return undefined;
    const space = options.spaceDid ?? this.#cfcSpaceDid(options.spaceName);
    const generation = this.#explicitCfcProjectionGeneration ??
      deriveCfcProjectionGeneration({
        space,
        entity: options.pieceId,
        rootKind: options.rootKind,
        cell: options.cell,
        value: options.value,
        labelView: options.labelView,
      });
    return new CfcProjectionAnnotator(this.#tree, {
      space,
      entity: options.pieceId,
      rootKind: options.rootKind,
      cell: options.cell,
      generation,
      labelView: options.labelView,
    });
  }

  /**
   * Annotates the synthetic node `ino` as a `projection` at `path`, and its
   * entry under `parent` when given. Does nothing without an `annotator`.
   */
  #annotateSyntheticNode(
    annotator: CfcProjectionAnnotator | undefined,
    ino: bigint,
    projection: CfcProjectionKind,
    path: readonly (string | number)[],
    parent?: { ino: bigint; name: string },
    contentLabel?: CfcLabel,
  ): void {
    if (!annotator) return;
    annotator.annotateSynthetic(ino, { projection, path, contentLabel });
    if (parent) {
      annotator.annotateEntry(parent.ino, parent.name, ino, {
        labelPath: path,
      });
    }
  }

  /**
   * Helper for `initStatus()`, which renders the current status as JSON: the
   * API URL, the debug flag, the rebuild counters, the start time, the
   * connected spaces, the connection state, and whatever the status provider
   * adds.
   */
  #getStatusJson(): string {
    const spaces: Record<
      string,
      { did: string; pieces: number; piecesLoaded: boolean }
    > = {};
    for (const [name, state] of this.#spaces) {
      spaces[name] = {
        did: state.did,
        pieces: state.pieceMap.size,
        piecesLoaded: state.piecesHydrated,
      };
    }
    const extra = this.#statusProvider?.() ?? {};
    return JSON.stringify(
      {
        apiUrl: this.#apiUrl,
        debug: this.#debug,
        rebuilds: {
          pending: this.#pendingPropRebuilds.size +
            this.#activePropRebuilds.size +
            this.#deferredPropRebuilds.size,
          scheduled: this.#rebuildStats.scheduled,
          coalesced: this.#rebuildStats.coalesced,
          completed: this.#rebuildStats.completed,
          errors: this.#rebuildStats.errors,
          maxPending: this.#rebuildStats.maxPending,
          lastDurationMs: this.#rebuildStats.lastDurationMs,
        },
        startedAt: this.#startedAt,
        spaces,
        connection: {
          disconnected: this.#disconnected,
          disconnectCount: this.#disconnectCount,
          lastDisconnectReason: this.#lastDisconnectReason,
        },
        ...extra,
      },
      null,
      2,
    );
  }

  /**
   * Runs the projection-rebuilt callback, if any, logging rather than
   * propagating what it throws.
   */
  #noteCfcProjectionRebuilt(): void {
    try {
      this.#onCfcProjectionRebuilt?.();
    } catch (e) {
      console.warn(`[fuse] CFC writeback reconciliation error: ${e}`);
    }
  }

  /**
   * Returns the `summary` of `value` when `value` is an object carrying a
   * string one, else the empty string.
   */
  #extractSummary(value: unknown): string {
    if (!isObjectNotArray(value)) {
      return "";
    }
    return typeof (value as Record<string, unknown>).summary === "string"
      ? (value as Record<string, unknown>).summary as string
      : "";
  }

  /**
   * Refreshes `piece`'s manifest entry in `state` from its current result and
   * pattern reference. A summary that cannot be read becomes empty; a pattern
   * reference that cannot be read leaves the recorded one as it is.
   */
  async #refreshPieceManifest(
    state: SpaceState,
    piece: PieceController,
  ): Promise<void> {
    let summary = "";
    let patternRef: PiecePatternRef | undefined;

    try {
      const result = await piece.result.get();
      summary = this.#extractSummary(result);
    } catch {
      // Summary is best-effort only.
    }

    try {
      patternRef = await piece.getPatternRef();
    } catch {
      // Pattern source is best-effort; identity-less pieces remain listable.
    }

    this.#updatePieceManifest(state, piece.id, { summary, patternRef });
  }

  /**
   * Refreshes the pattern reference in `piece`'s `meta.json` — at `pieceIno`
   * and under `entities/` when projected there — and in `pieces.json` when it
   * changed, invalidating the kernel entry of each file rewritten. A reference
   * that cannot be read, or is absent, leaves everything as it is.
   */
  async #refreshPiecePatternMetadata(
    state: SpaceState,
    piece: PieceController,
    pieceIno: bigint,
  ): Promise<void> {
    let patternRef: PiecePatternRef | undefined;
    try {
      patternRef = await piece.getPatternRef();
    } catch {
      return;
    }
    if (patternRef === undefined) return;

    const manifestChanged = this.#updatePieceManifest(state, piece.id, {
      patternRef,
    });
    this.#updatePieceMetaPatternRef(pieceIno, patternRef);

    const entityIno = this.#tree.lookup(
      state.entitiesIno,
      encodeFuseComponent(piece.id),
    );
    if (entityIno !== undefined) {
      this.#updatePieceMetaPatternRef(entityIno, patternRef);
    }

    if (manifestChanged) {
      this.#updatePiecesJson(state);
    }
    if (this.#onInvalidate) {
      this.#onInvalidate(pieceIno, ["meta.json"]);
      if (entityIno !== undefined) {
        this.#onInvalidate(entityIno, ["meta.json"]);
      }
      if (manifestChanged) {
        this.#onInvalidate(state.piecesIno, ["pieces.json"]);
      }
    }
  }

  /**
   * Merges `updates` into `pieceId`'s manifest entry in `state`, and returns
   * whether the summary or any part of the pattern reference changed.
   */
  #updatePieceManifest(
    state: SpaceState,
    pieceId: string,
    updates: Partial<{ summary: string; patternRef: PiecePatternRef }>,
  ): boolean {
    const current = state.pieceManifest.get(pieceId) ?? { summary: "" };
    const next = {
      summary: updates.summary ?? current.summary,
      patternRef: updates.patternRef ?? current.patternRef,
    };
    const changed = next.summary !== current.summary ||
      next.patternRef?.identity !== current.patternRef?.identity ||
      next.patternRef?.symbol !== current.patternRef?.symbol ||
      next.patternRef?.source.ref !== current.patternRef?.source.ref ||
      next.patternRef?.source.repository !==
        current.patternRef?.source.repository ||
      next.patternRef?.source.entry !== current.patternRef?.source.entry ||
      next.patternRef?.source.origin !== current.patternRef?.source.origin;
    state.pieceManifest.set(pieceId, next);
    return changed;
  }

  /**
   * Helper for `#updatePiecesJson()`, which lists each piece of `state` by name
   * with its id, summary, `entities/` path, and pattern reference when known.
   */
  #buildPiecesManifestEntries(state: SpaceState): Array<{
    id: string;
    name: string;
    summary: string;
    entityPath: string;
    patternRef?: PiecePatternRef;
  }> {
    const entries: Array<{
      id: string;
      name: string;
      summary: string;
      entityPath: string;
      patternRef?: PiecePatternRef;
    }> = [];

    for (const [name, id] of state.pieceMap) {
      const manifest = state.pieceManifest.get(id) ?? { summary: "" };
      entries.push({
        id,
        name,
        summary: manifest.summary,
        entityPath: `entities/${encodeFuseComponent(id)}`,
        ...(manifest.patternRef === undefined
          ? {}
          : { patternRef: manifest.patternRef }),
      });
    }

    return entries;
  }

  /**
   * Helper for `connectSpace()`, which opens the space, verifies the
   * connection, builds its tree with its index files, and registers it. On
   * failure it removes what it built, forgets the space, disposes the runtime
   * it opened, and rethrows.
   */
  async #connectSpaceOnce(spaceName: string): Promise<SpaceState> {
    let pieces: PiecesController | undefined;
    let state: SpaceState | undefined;
    try {
      pieces = await this.#createSpacePieces(spaceName);
      await this.#verifyPiecesConnection(pieces);
      state = this.#buildSpaceTree(spaceName, pieces);

      this.#updateIndexJson(state);
      this.#updatePiecesJson(state);
      this.#spaces.set(spaceName, state);
      this.#knownSpaces.set(spaceName, state.did);
      this.#updateSpacesJson();
      return state;
    } catch (error) {
      if (state) {
        this.#removeFailedSpaceTree(spaceName, state);
      } else {
        this.#tree.removeChild(
          this.#tree.rootIno,
          encodeSpaceDirectoryName(spaceName),
        );
      }
      this.#spaces.delete(spaceName);
      this.#knownSpaces.delete(spaceName);
      if (pieces) {
        await pieces.runtime.dispose().catch((disposeError) => {
          console.warn(
            `[FUSE] Failed space cleanup for ${spaceName}: ${
              disposeError instanceof Error
                ? disposeError.message
                : String(disposeError)
            }`,
          );
        });
      }
      throw error;
    }
  }

  /**
   * Tears down `state`'s tree and bookkeeping after a failed connection:
   * cancels its subscriptions, unregisters its piece and entity roots, drops
   * its in-flight work, and removes its directory.
   */
  #removeFailedSpaceTree(spaceName: string, state: SpaceState): void {
    for (const cancel of state.unsubscribes) cancel();
    for (const subscriptions of state.pieceSubs.values()) {
      for (const cancel of subscriptions) cancel();
    }
    for (const [, ino] of this.#tree.getChildren(state.piecesIno)) {
      this.#unregisterPieceRoot(ino);
    }
    for (const [, ino] of this.#tree.getChildren(state.entitiesIno)) {
      this.#cancelEntitySubscriptions(ino);
      this.#unhydratedEntityRoots.delete(ino);
      this.#pendingEntityHydrations.delete(ino);
      this.#entityProjectionLru.delete(ino);
      this.#entityProjectionEvictionCandidates.delete(ino);
      this.#entityProjectionUseOrder.delete(ino);
      this.#clearEntityProjectionReferences(ino);
      this.#pendingEntityRemovals.delete(ino);
      this.#unregisterPieceRoot(ino);
    }
    this.#pendingPieceHydrations.delete(spaceName);
    this.#pendingEntityDirectorySnapshots.delete(state);
    this.#pieceSyncs.delete(spaceName);
    this.#syncAgain.delete(spaceName);
    this.#tree.removeChild(
      this.#tree.rootIno,
      encodeSpaceDirectoryName(spaceName),
    );
  }

  /**
   * Records `pieceIno` as the root projecting `info`, with no props hydrated
   * unless some already are.
   */
  #registerPieceRoot(
    pieceIno: bigint,
    info: PieceRootInfo,
  ): void {
    this.#pieceRoots.set(pieceIno, info);
    if (!this.#hydratedPieceProps.has(pieceIno)) {
      this.#hydratedPieceProps.set(pieceIno, new Set());
    }
  }

  /**
   * Ensures piece root `pieceIno` has a `propName` directory and a
   * `propName.json` file holding `{}`, so that a lookup of either replies from
   * the tree while hydration runs, and registers the directory as a prop root.
   * Returns the directory's inode, or `undefined` when `pieceIno` is not a
   * directory.
   */
  #ensurePiecePropStub(
    pieceIno: bigint,
    propName: "input" | "result",
    annotator?: CfcProjectionAnnotator,
  ): bigint | undefined {
    if (this.#tree.getNode(pieceIno)?.kind !== "dir") return undefined;
    let propIno = this.#tree.lookup(pieceIno, propName);
    if (propIno === undefined) {
      propIno = this.#tree.addDir(pieceIno, propName);
    }
    annotator?.annotateJsonDirectory(propIno, [], {});
    annotator?.annotateEntry(pieceIno, propName, propIno);
    this.#piecePropRoots.set(propIno, { pieceIno, propName });
    // Also ensure a stub JSON file so lookups for result.json / input.json
    // can reply immediately from tree while hydration runs in the background.
    const jsonName = `${propName}.json`;
    if (this.#tree.lookup(pieceIno, jsonName) === undefined) {
      const jsonIno = this.#tree.addFile(pieceIno, jsonName, "{}", "object");
      annotator?.annotateJsonAggregate(jsonIno, [], {});
      annotator?.annotateEntry(pieceIno, jsonName, jsonIno);
    }
    return propIno;
  }

  /**
   * Forgets `pieceIno` as a piece root, along with its prop roots, hydration
   * state, and epochs.
   */
  #unregisterPieceRoot(pieceIno: bigint): void {
    for (const propName of ["input", "result"] as const) {
      const propIno = this.#tree.lookup(pieceIno, propName);
      if (propIno !== undefined) this.#piecePropRoots.delete(propIno);
      const key = `${pieceIno}-${propName}`;
      this.#pendingHydrations.delete(key);
      this.#hydrationEpochs.delete(key);
    }
    this.#hydratedPieceProps.delete(pieceIno);
    this.#pieceRoots.delete(pieceIno);
  }

  /**
   * Records `propName` of `pieceIno` as hydrated, registering its directory as
   * a prop root.
   */
  #markPiecePropHydrated(
    pieceIno: bigint,
    propName: "input" | "result",
  ): void {
    let hydrated = this.#hydratedPieceProps.get(pieceIno);
    if (!hydrated) {
      hydrated = new Set();
      this.#hydratedPieceProps.set(pieceIno, hydrated);
    }
    hydrated.add(propName);

    const propIno = this.#tree.lookup(pieceIno, propName);
    if (propIno !== undefined) {
      this.#piecePropRoots.set(propIno, { pieceIno, propName });
    }
  }

  /**
   * Records `propName` of `pieceIno` as not hydrated, unregistering its
   * directory as a prop root.
   */
  #markPiecePropCleared(
    pieceIno: bigint,
    propName: "input" | "result",
  ): void {
    const propIno = this.#tree.lookup(pieceIno, propName);
    if (propIno !== undefined) {
      this.#piecePropRoots.delete(propIno);
    }
    this.#hydratedPieceProps.get(pieceIno)?.delete(propName);
  }

  /**
   * Returns what `pieceIno` projects along with its space's state, or `null`
   * for an inode that is not a piece root.
   */
  #getPieceInfo(
    pieceIno: bigint,
  ): (PieceRootInfo & { state?: SpaceState }) | null {
    const info = this.#pieceRoots.get(pieceIno);
    if (!info) return null;
    return { ...info, state: this.#spaces.get(info.spaceName) };
  }

  /**
   * Returns whether `ino` is the root of an entity projection: unhydrated,
   * awaiting removal, or hydrated under `entities/`.
   */
  #isEntityProjectionRoot(ino: bigint): boolean {
    return this.#unhydratedEntityRoots.has(ino) ||
      this.#pendingEntityRemovals.has(ino) ||
      this.#pieceRoots.get(ino)?.rootKind === "entities";
  }

  /**
   * Returns the entity projection root `ino` sits under, itself included, or
   * `undefined` when it sits under none.
   */
  #entityProjectionRootForInode(ino: bigint): bigint | undefined {
    let current: bigint | undefined = ino;
    while (current !== undefined) {
      if (this.#isEntityProjectionRoot(current)) return current;
      current = this.#tree.parents.get(current);
    }
    return undefined;
  }

  /**
   * Helper for the retain methods, which adds `ino` to the set `index` keeps
   * for `rootIno`.
   */
  #indexEntityProjectionOwner(
    index: Map<bigint, Set<bigint>>,
    rootIno: bigint,
    ino: bigint,
  ): void {
    let inodes = index.get(rootIno);
    if (inodes === undefined) {
      inodes = new Set();
      index.set(rootIno, inodes);
    }
    inodes.add(ino);
  }

  /**
   * Helper for the release methods, which removes `ino` from the set `index`
   * keeps for `rootIno`, dropping the set when it empties.
   */
  #unindexEntityProjectionOwner(
    index: Map<bigint, Set<bigint>>,
    rootIno: bigint,
    ino: bigint,
  ): void {
    const inodes = index.get(rootIno);
    if (inodes === undefined) return;
    inodes.delete(ino);
    if (inodes.size === 0) index.delete(rootIno);
  }

  /**
   * Forgets every lookup and open reference held on the entity projection
   * `rootIno`, and the inodes holding them.
   */
  #clearEntityProjectionReferences(rootIno: bigint): void {
    this.#entityProjectionLookupRefs.delete(rootIno);
    this.#entityProjectionOpenRefs.delete(rootIno);
    for (
      const ino of this.#entityProjectionLookupOwnerInodes.get(rootIno) ??
        []
    ) {
      this.#entityProjectionLookupOwners.delete(ino);
    }
    this.#entityProjectionLookupOwnerInodes.delete(rootIno);
    for (
      const ino of this.#entityProjectionOpenOwnerInodes.get(rootIno) ?? []
    ) {
      this.#entityProjectionOpenOwners.delete(ino);
    }
    this.#entityProjectionOpenOwnerInodes.delete(rootIno);
  }

  /**
   * Returns whether `ino` is an entity projection root or a prop directory of
   * one.
   */
  #isEntityProjectionDirectory(ino: bigint): boolean {
    if (this.#isEntityProjectionRoot(ino)) return true;
    const prop = this.#piecePropRoots.get(ino);
    return prop !== undefined && this.#isEntityProjectionRoot(prop.pieceIno);
  }

  /**
   * Returns the controller for the piece `parsed` names: by name under
   * `pieces/`, or under `entities/` by entity id, with or without the `of:`
   * prefix, from the entity controllers or else from the pieces list.
   */
  #resolvePieceController(
    space: SpaceState,
    parsed: ReturnType<typeof parseMountedCallablePath>,
  ): PieceController | undefined {
    if (!parsed) return undefined;

    if (parsed.rootKind === "pieces") {
      return space.pieceControllers.get(parsed.rootName);
    }

    const targetEntity = parsed.rootName.startsWith("of:")
      ? parsed.rootName
      : `of:${parsed.rootName}`;
    const entityController = space.entityControllers.get(parsed.rootName) ??
      space.entityControllers.get(targetEntity);
    if (entityController) return entityController;

    for (const piece of space.pieceControllers.values()) {
      if (piece.id === parsed.rootName || piece.id === targetEntity) {
        return piece;
      }
    }

    return undefined;
  }

  /** Returns the key the rebuild tables use for `propName` of `pieceIno`. */
  #propRebuildKey(
    pieceIno: bigint,
    propName: "input" | "result",
  ): string {
    return `${pieceIno}:${propName}`;
  }

  /**
   * Schedules a rebuild of one piece prop from `args.newValue` on the next
   * tick. A rebuild already scheduled for the prop takes the new value instead;
   * while one it started is running, this one is held back and scheduled when
   * it finishes. The counters in `.status` record the coalescing.
   */
  #schedulePropRebuild(args: PropRebuildJob): void {
    const key = this.#propRebuildKey(args.pieceIno, args.propName);
    const pending = this.#pendingPropRebuilds.get(key);
    if (pending) {
      pending.latestValue = args.newValue;
      pending.pieceName = args.pieceName;
      this.#rebuildStats.coalesced++;
      return;
    }

    if (this.#activePropRebuilds.has(key)) {
      this.#deferredPropRebuilds.set(key, {
        cell: args.cell,
        newValue: args.newValue,
        pieceId: args.pieceId,
        pieceIno: args.pieceIno,
        pieceName: args.pieceName,
        propName: args.propName,
        resolveLink: args.resolveLink,
        spaceName: args.spaceName,
      });
      this.#rebuildStats.coalesced++;
      this.#rebuildStats.maxPending = Math.max(
        this.#rebuildStats.maxPending,
        this.#pendingPropRebuilds.size +
          this.#activePropRebuilds.size +
          this.#deferredPropRebuilds.size,
      );
      return;
    }

    this.#rebuildStats.scheduled++;
    const entry = {
      cell: args.cell,
      latestValue: args.newValue,
      pieceId: args.pieceId,
      pieceIno: args.pieceIno,
      pieceName: args.pieceName,
      propName: args.propName,
      resolveLink: args.resolveLink,
      spaceName: args.spaceName,
      timer: setTimeout(() => {
        this.#pendingPropRebuilds.delete(key);
        this.#activePropRebuilds.add(key);
        void this.#enqueuePiecePropRebuild({
          cell: entry.cell,
          newValue: entry.latestValue,
          pieceId: entry.pieceId,
          pieceIno: entry.pieceIno,
          pieceName: entry.pieceName,
          propName: entry.propName,
          resolveLink: entry.resolveLink,
          spaceName: entry.spaceName,
        }).catch((e) => {
          this.#rebuildStats.errors++;
          console.error(
            `[${entry.spaceName}] Error rebuilding ${entry.pieceName}/${entry.propName}: ${e}`,
          );
        }).finally(() => {
          this.#activePropRebuilds.delete(key);
          const deferred = this.#deferredPropRebuilds.get(key);
          this.#deferredPropRebuilds.delete(key);
          if (deferred) {
            this.#schedulePropRebuild(deferred);
          }
        });
      }, 0),
    };
    this.#pendingPropRebuilds.set(key, entry);
    this.#rebuildStats.maxPending = Math.max(
      this.#rebuildStats.maxPending,
      this.#pendingPropRebuilds.size +
        this.#activePropRebuilds.size +
        this.#deferredPropRebuilds.size,
    );
  }

  /**
   * Swaps a freshly built staging node into its live position.
   *
   * When the live node and the staging node share a kind, their subtrees are
   * reconciled in place so the live inode survives (see {@link
   * FsTree.transplantSubtree}); the inodes whose content changed are appended
   * to `changedInodes` so the caller can drop their kernel data cache. When the
   * kinds differ, or when there is no live node, the staging node takes the
   * live name with its freshly allocated inode. When the replacement produced
   * no staging node, the live node is removed.
   *
   * This runs synchronously, so no filesystem request observes a half-swapped
   * tree.
   */
  #swapPending(
    parentIno: bigint,
    liveName: string,
    pendingName: string,
    oldIno: bigint | undefined,
    changes: TransplantChanges,
    annotator?: CfcProjectionAnnotator,
  ): void {
    const pendingIno = this.#tree.lookup(parentIno, pendingName);
    if (pendingIno === undefined) {
      if (oldIno !== undefined) {
        this.#tree.clear(oldIno);
        FsTree.recordEntryChange(changes, parentIno, liveName);
      }
      return;
    }
    const pendingNode = this.#tree.getNode(pendingIno);
    const oldNode = oldIno !== undefined
      ? this.#tree.getNode(oldIno)
      : undefined;
    if (
      oldIno !== undefined && oldNode && pendingNode &&
      oldNode.kind === pendingNode.kind
    ) {
      // Same path, same kind: the live inode survives, so its entry under the
      // parent is unchanged and is left cached.
      this.#mergeTransplantChanges(
        changes,
        this.#tree.transplantSubtree(oldIno, pendingIno),
      );
      annotator?.annotateEntry(parentIno, liveName, oldIno);
    } else {
      if (oldIno !== undefined) {
        this.#tree.clear(oldIno);
      }
      this.#tree.rename(parentIno, pendingName, parentIno, liveName);
      const movedIno = this.#tree.lookup(parentIno, liveName);
      if (movedIno !== undefined) {
        annotator?.annotateEntry(parentIno, liveName, movedIno);
      }
      FsTree.recordEntryChange(changes, parentIno, liveName);
    }
  }

  /** Merges the changes in `from` into `into`. */
  #mergeTransplantChanges(
    into: TransplantChanges,
    from: TransplantChanges,
  ): void {
    for (const ino of from.changedInodes) {
      into.changedInodes.add(ino);
    }
    for (const [parentIno, names] of from.entryChanges) {
      for (const name of names) {
        FsTree.recordEntryChange(into, parentIno, name);
      }
    }
  }

  /**
   * Drops exactly the kernel caches a rebuild made stale: the changed inodes'
   * data, and the changed directory entries. Entries and inodes the rebuild
   * left untouched stay cached, so a client that walked into the piece does not
   * have its cached dentries invalidated by an unrelated rebuild.
   */
  #emitInvalidations(changes: TransplantChanges): void {
    if (this.#onInvalidateInode) {
      for (const ino of changes.changedInodes) {
        this.#onInvalidateInode(ino);
      }
    }
    if (this.#onInvalidate) {
      for (const [parentIno, names] of changes.entryChanges) {
        this.#onInvalidate(parentIno, [...names]);
      }
    }
  }

  /**
   * Advances the piece directory's mtime if its top-level entry set changed
   * since `namesBefore`. Compares names, not inodes, so a rebuilt `.handlers`
   * (same name, new inode) does not count while a prop appearing or an
   * `index.md` replacing the result tree does.
   */
  #touchPieceDirIfEntriesChanged(
    pieceIno: bigint,
    namesBefore: Set<string>,
  ): void {
    const namesAfter = this.#tree.getChildren(pieceIno).map(([name]) => name);
    if (
      namesAfter.length !== namesBefore.size ||
      namesAfter.some((name) => !namesBefore.has(name))
    ) {
      this.#tree.touch(pieceIno);
    }
  }

  /**
   * Advances the hydration epoch for a prop so an in-flight hydration that read
   * a now-superseded value re-reads and rebuilds. Used when a cell change
   * arrives: the mounted tree is rebuilt in place rather than torn down, so
   * this is all the reactive path needs to stay consistent.
   */
  #bumpHydrationEpoch(
    rootIno: bigint,
    propName: "input" | "result",
  ): void {
    const key = `${rootIno}-${propName}`;
    this.#hydrationEpochs.set(key, (this.#hydrationEpochs.get(key) ?? 0) + 1);
  }

  /**
   * Rebuilds the mounted subtree of one piece prop from a new cell value, in
   * place.
   */
  async #rebuildPieceProp(args: PropRebuildJob): Promise<void> {
    const startedAt = Date.now();
    if (this.#tree.getNode(args.pieceIno)?.kind !== "dir") {
      return;
    }

    const {
      cell,
      newValue,
      pieceId,
      pieceIno,
      pieceName,
      propName,
      resolveLink,
      spaceName,
    } = args;

    const existingIno = this.#tree.lookup(pieceIno, propName);
    const jsonIno = this.#tree.lookup(pieceIno, `${propName}.json`);
    const pendingPropName = `.${propName}.pending`;
    const pendingJsonName = `${pendingPropName}.json`;
    const rootInfo = this.#pieceRoots.get(pieceIno);
    const labelView = this.#cfcLabelViewForCell(cell);
    const pendingIno = this.#tree.lookup(pieceIno, pendingPropName);
    if (pendingIno !== undefined) {
      this.#tree.clear(pendingIno);
    }
    const pendingJsonIno = this.#tree.lookup(pieceIno, pendingJsonName);
    if (pendingJsonIno !== undefined) {
      this.#tree.clear(pendingJsonIno);
    }

    const treeValue = this.#materializeTreeValue(cell, newValue);
    const cfcAnnotator = this.#makeCfcAnnotator({
      spaceName,
      pieceId,
      rootKind: rootInfo?.rootKind ?? "pieces",
      cell: propName,
      value: treeValue,
      labelView,
    });
    let callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    > = [];
    // The kernel caches that this rebuild made stale: inodes whose content
    // changed and, per directory, the child names whose entry changed. Only
    // these are invalidated, so a client keeps every cache entry the rebuild
    // left untouched.
    const changes: TransplantChanges = {
      changedInodes: new Set(),
      entryChanges: new Map(),
    };
    // The piece directory's top-level entries (input, result, index.md,
    // .handlers, …) can appear or disappear across this rebuild — a prop
    // hydrating, or a result switching between the normal tree and an [FS]
    // projection. Its mtime is advanced only if that name set changes; a
    // content-only rebuild leaves it untouched. Staging containers are
    // transient within a rebuild, so they are absent from both the before and
    // after names.
    const pieceNamesBefore = new Set(
      this.#tree.getChildren(pieceIno).map(([name]) => name),
    );
    if (treeValue !== undefined && treeValue !== null) {
      const {
        callables: discoveredCallables,
        classifyEntry,
        skipEntry,
      } = this.#discoverCallableEntries(cell, treeValue);
      callables = discoveredCallables;

      if (propName === "result") {
        const fsValue = this.#readFsValue(cell, treeValue);
        if (fsValue !== null) {
          this.#markPiecePropCleared(pieceIno, propName);

          // The projection entries currently at the piece root; a rebuild
          // adopts the ones that survive with the same kind and removes the
          // rest.
          const oldFsNames = new Set<string>(
            this.#fsProjectionEntries.get(pieceIno) ?? [],
          );
          oldFsNames.add("index.md");
          oldFsNames.add("index.json");

          // Switching from a normal result/ tree to an [FS] projection replaces
          // the result directory and its .json sibling.
          if (existingIno !== undefined) {
            this.#tree.clear(existingIno);
            FsTree.recordEntryChange(changes, pieceIno, propName);
          }
          if (jsonIno !== undefined) {
            this.#tree.clear(jsonIno);
            FsTree.recordEntryChange(changes, pieceIno, `${propName}.json`);
          }

          // Build the projection under a staging container, then reconcile it
          // onto the piece directory so a surviving entry keeps its inode.
          const staleStage = this.#tree.lookup(pieceIno, ".fs.pending");
          if (staleStage !== undefined) {
            this.#tree.clear(staleStage);
          }
          const stageIno = this.#tree.addDir(pieceIno, ".fs.pending");
          this.#buildFsProjectionTree(
            stageIno,
            pieceId,
            fsValue,
            treeValue,
            callables,
            resolveLink,
            skipEntry,
            classifyEntry,
            cfcAnnotator,
          );
          const newFsNames = this.#swapFsProjection(
            pieceIno,
            stageIno,
            oldFsNames,
            changes,
            cfcAnnotator,
          );
          this.#fsProjectionEntries.set(pieceIno, newFsNames);

          this.#buildHandlersFile(pieceIno, callables, cfcAnnotator);
          FsTree.recordEntryChange(changes, pieceIno, ".handlers");

          const state = this.#spaces.get(spaceName);
          if (state) {
            const summaryChanged = this.#updatePieceManifest(state, pieceId, {
              summary: this.#extractSummary(treeValue),
            });
            if (summaryChanged) {
              this.#updatePiecesJson(state);
              if (this.#onInvalidate) {
                this.#onInvalidate(state.piecesIno, ["pieces.json"]);
              }
            }
          }
          this.#touchPieceDirIfEntriesChanged(pieceIno, pieceNamesBefore);
          this.#emitInvalidations(changes);
          this.#markPiecePropHydrated(pieceIno, "result");
          this.#rebuildStats.completed++;
          this.#rebuildStats.lastDurationMs = Date.now() - startedAt;
          this.#noteCfcProjectionRebuilt();
          return;
        }
      }

      const buildRootName = existingIno !== undefined || jsonIno !== undefined
        ? pendingPropName
        : propName;
      const propIno = buildRootName === pendingPropName
        ? await buildPendingJsonTreeAsync(
          this.#tree,
          pieceIno,
          propName,
          treeValue,
          resolveLink,
          0,
          skipEntry,
          classifyEntry,
          cfcAnnotator?.jsonContext([]),
        )
        : await buildJsonTreeAsync(
          this.#tree,
          pieceIno,
          propName,
          treeValue,
          resolveLink,
          0,
          skipEntry,
          classifyEntry,
          cfcAnnotator?.jsonContext([]),
        );
      this.#addCallableFiles(propIno, callables, propName, cfcAnnotator);
      if (propName === "result") {
        this.#addVNodeJsonFiles(propIno, treeValue, cfcAnnotator);
      }
      if (buildRootName === pendingPropName) {
        this.#markPiecePropCleared(pieceIno, propName);
        if (propName === "result") {
          this.#clearFsProjectionEntries(pieceIno, changes);
        }
        // Reconcile the freshly built staging subtree onto the existing one,
        // reusing the existing inodes rather than swapping in fresh ones, so a
        // path that still exists keeps its inode across the rebuild.
        this.#swapPending(
          pieceIno,
          propName,
          pendingPropName,
          existingIno,
          changes,
          cfcAnnotator,
        );
        this.#swapPending(
          pieceIno,
          `${propName}.json`,
          pendingJsonName,
          jsonIno,
          changes,
          cfcAnnotator,
        );
      } else {
        if (propName === "result") {
          this.#clearFsProjectionEntries(pieceIno, changes);
        }
        // First hydration: the prop directory and its `.json` sibling are new
        // to any cache, so their entries under the piece are invalidated.
        FsTree.recordEntryChange(changes, pieceIno, propName);
        if (this.#tree.lookup(pieceIno, `${propName}.json`) !== undefined) {
          FsTree.recordEntryChange(changes, pieceIno, `${propName}.json`);
        }
      }
      this.#markPiecePropHydrated(pieceIno, propName);
    } else {
      this.#markPiecePropCleared(pieceIno, propName);
      if (existingIno !== undefined) {
        this.#tree.clear(existingIno);
        FsTree.recordEntryChange(changes, pieceIno, propName);
      }
      if (jsonIno !== undefined) {
        this.#tree.clear(jsonIno);
        FsTree.recordEntryChange(changes, pieceIno, `${propName}.json`);
      }
      if (propName === "result") {
        this.#clearFsProjectionEntries(pieceIno, changes);
      }
    }
    if (propName === "result") {
      // `.handlers` is rebuilt on the piece directory, outside the prop
      // subtree the transplant reconciled, so its entry is invalidated here.
      this.#buildHandlersFile(pieceIno, callables, cfcAnnotator);
      FsTree.recordEntryChange(changes, pieceIno, ".handlers");
    }

    this.#touchPieceDirIfEntriesChanged(pieceIno, pieceNamesBefore);
    this.#emitInvalidations(changes);

    if (propName === "result") {
      const state = this.#spaces.get(spaceName);
      if (state) {
        const summaryChanged = this.#updatePieceManifest(state, pieceId, {
          summary: this.#extractSummary(treeValue),
        });
        if (summaryChanged) {
          this.#updatePiecesJson(state);
          if (this.#onInvalidate) {
            this.#onInvalidate(state.piecesIno, ["pieces.json"]);
          }
        }
      }
    }

    this.#rebuildStats.completed++;
    this.#rebuildStats.lastDurationMs = Date.now() - startedAt;
    this.#noteCfcProjectionRebuilt();
    this.#debugLog(`[${spaceName}] Updated ${pieceName}/${propName}`);
  }

  /**
   * Runs a prop rebuild after any rebuild already queued for the same piece
   * prop, so rebuilds of one subtree never overlap.
   */
  async #enqueuePiecePropRebuild(args: PropRebuildJob): Promise<void> {
    const key = this.#propRebuildKey(args.pieceIno, args.propName);
    const previous = this.#pendingPropRebuildQueues.get(key) ??
      Promise.resolve();
    const current = previous.catch(() => {}).then(() =>
      this.#rebuildPieceProp(args)
    );
    this.#pendingPropRebuildQueues.set(key, current);
    try {
      await current;
    } finally {
      if (this.#pendingPropRebuildQueues.get(key) === current) {
        this.#pendingPropRebuildQueues.delete(key);
      }
    }
  }

  /**
   * Materializes a piece's `input` or `result` subtree on demand, once per
   * prop, sharing an in-flight hydration with concurrent callers. A hydration
   * whose epoch moved or whose prop was cleared mid-flight is retried up to
   * `#MAX_HYDRATION_RETRIES` times. Resolves to whether the prop is hydrated.
   */
  #hydratePieceProp(
    pieceIno: bigint,
    propName: "input" | "result",
    retries = 0,
  ): Promise<boolean> {
    const info = this.#getPieceInfo(pieceIno);
    if (!info) return Promise.resolve(false);
    if (this.#hydratedPieceProps.get(pieceIno)?.has(propName)) {
      return Promise.resolve(true);
    }

    const key = `${pieceIno}-${propName}`;
    const existing = this.#pendingHydrations.get(key);
    if (existing) return existing;
    const startedEpoch = this.#hydrationEpochs.get(key) ?? 0;

    const cleanup = () => {
      if (this.#pendingHydrations.get(key) === handle.promise) {
        this.#pendingHydrations.delete(key);
      }
    };
    const handle: { promise: Promise<boolean> } = {
      promise: (async (): Promise<boolean> => {
        try {
          const cell = await info.piece[propName].getCell();
          const newValue = await info.piece[propName].get();
          await this.#enqueuePiecePropRebuild({
            cell,
            newValue,
            pieceId: info.piece.id,
            pieceIno,
            pieceName: info.rootName,
            propName,
            resolveLink: this.#makeLinkResolver(info.spaceName),
            spaceName: info.spaceName,
          });
          const currentEpoch = this.#hydrationEpochs.get(key) ?? 0;
          const stillHydrated =
            this.#hydratedPieceProps.get(pieceIno)?.has(propName) ?? false;
          if (currentEpoch !== startedEpoch || !stillHydrated) {
            cleanup();
            if (retries >= CellBridge.#MAX_HYDRATION_RETRIES) {
              return false;
            }
            return await this.#hydratePieceProp(
              pieceIno,
              propName,
              retries + 1,
            );
          }
          return true;
        } finally {
          cleanup();
        }
      })(),
    };

    this.#pendingHydrations.set(key, handle.promise);
    return handle.promise;
  }

  /** Collects every inode in the subtree at `ino`, itself included. */
  #collectDescendantInos(ino: bigint): bigint[] {
    const result: bigint[] = [ino];
    const node = this.#tree.getNode(ino);
    if (node?.kind === "dir") {
      for (const [, childIno] of this.#tree.getChildren(ino)) {
        result.push(...this.#collectDescendantInos(childIno));
      }
    }
    return result;
  }

  /**
   * Drops `propName` of the root `rootIno` back to a stub: advances its
   * hydration epoch, clears its directory and `.json` file — and, for
   * `result`, the [FS] projection entries and `.handlers` too — then
   * invalidates the kernel entries and every inode that held. Returns false,
   * doing nothing, when `rootIno` is not a directory.
   */
  #invalidateRootPropCache(
    rootIno: bigint,
    propName: "input" | "result",
  ): boolean {
    if (this.#tree.getNode(rootIno)?.kind !== "dir") return false;

    const invalidatedNames = new Set<string>([propName, `${propName}.json`]);
    const key = `${rootIno}-${propName}`;
    this.#hydrationEpochs.set(key, (this.#hydrationEpochs.get(key) ?? 0) + 1);
    this.#markPiecePropCleared(rootIno, propName);

    // Collect all descendant inodes BEFORE clearing (tree.clear removes
    // them), so the invalidation below can name every inode whose cached
    // data is about to go stale, not just the entries under this prop.
    const staleInos: bigint[] = [];
    const propIno = this.#tree.lookup(rootIno, propName);
    if (propIno !== undefined) {
      staleInos.push(...this.#collectDescendantInos(propIno));
      this.#tree.clear(propIno);
    }
    const jsonIno = this.#tree.lookup(rootIno, `${propName}.json`);
    if (jsonIno !== undefined) {
      staleInos.push(jsonIno);
      this.#tree.clear(jsonIno);
    }
    this.#ensurePiecePropStub(rootIno, propName);

    if (propName === "result") {
      const fsEntries = this.#fsProjectionEntries.get(rootIno);
      if (fsEntries) {
        for (const name of fsEntries) {
          invalidatedNames.add(name);
          const fsIno = this.#tree.lookup(rootIno, name);
          if (fsIno !== undefined) {
            staleInos.push(...this.#collectDescendantInos(fsIno));
          }
        }
      }
      this.#clearFsProjectionEntries(rootIno);

      const handlersIno = this.#tree.lookup(rootIno, ".handlers");
      if (handlersIno !== undefined) {
        staleInos.push(handlersIno);
        this.#tree.clear(handlersIno);
      }
      invalidatedNames.add(".handlers");
    }

    if (this.#onInvalidate) {
      this.#onInvalidate(rootIno, [...invalidatedNames]);
    }
    if (this.#onInvalidateInode) {
      this.#onInvalidateInode(rootIno);
      for (const staleIno of staleInos) {
        this.#onInvalidateInode(staleIno);
      }
    }
    return true;
  }

  /**
   * Drops `propName` of every root projecting `pieceId` — under `pieces/` and
   * `entities/` in every connected space — as `#invalidateRootPropCache()`
   * does.
   */
  #invalidatePieceIdPropCache(
    pieceId: string,
    propName: "input" | "result",
  ): void {
    for (const state of this.#spaces.values()) {
      for (const [name, id] of state.pieceMap) {
        if (id !== pieceId) continue;
        const pieceIno = state.pieceInos.get(name);
        if (pieceIno !== undefined) {
          this.#invalidateRootPropCache(pieceIno, propName);
        }
      }

      const entityIno = this.#tree.lookup(
        state.entitiesIno,
        encodeFuseComponent(pieceId),
      );
      if (entityIno !== undefined) {
        this.#invalidateRootPropCache(entityIno, propName);
      }
    }
  }

  /**
   * Rewrites the root `.spaces.json` from the known spaces, annotated as space
   * metadata.
   */
  #updateSpacesJson(): void {
    const obj: Record<string, string> = {};
    for (const [name, did] of this.#knownSpaces) {
      obj[name] = did;
    }

    // Remove existing .spaces.json if present, then recreate
    const existingIno = this.#tree.lookup(this.#tree.rootIno, ".spaces.json");
    if (existingIno !== undefined) {
      this.#tree.clear(existingIno);
    }
    const spacesIno = this.#tree.addFile(
      this.#tree.rootIno,
      ".spaces.json",
      JSON.stringify(obj, null, 2),
      "object",
    );
    const annotator = this.#makeCfcAnnotator({
      spaceName: "common-fabric:mount",
      spaceDid: "common-fabric:mount",
      value: obj,
    });
    this.#annotateSyntheticNode(
      annotator,
      spacesIno,
      "space-meta",
      [".spaces.json"],
    );
  }

  /**
   * Creates `spaceName`'s directory with `pieces/`, `entities/`, and
   * `space.json`, annotated when annotations are on, and returns the state that
   * tracks it, with nothing hydrated.
   */
  #buildSpaceTree(
    spaceName: string,
    pieces: PiecesController,
  ): SpaceState {
    // Create space directory structure
    const spaceIno = this.#tree.addDir(
      this.#tree.rootIno,
      encodeSpaceDirectoryName(spaceName),
    );
    const piecesIno = this.#tree.addDir(spaceIno, "pieces");
    const entitiesIno = this.#tree.addDir(spaceIno, "entities");

    // space.json: DID + name
    const spaceDid = pieces.getSpace();
    const spaceMeta = { did: spaceDid, name: spaceName };
    const spaceAnnotator = this.#makeCfcAnnotator({
      spaceName,
      spaceDid,
      value: spaceMeta,
    });
    const piecesAnnotator = this.#makeCfcAnnotator({
      spaceName,
      spaceDid,
      rootKind: "pieces",
      value: { rootKind: "pieces" },
    });
    const entitiesAnnotator = this.#makeCfcAnnotator({
      spaceName,
      spaceDid,
      rootKind: "entities",
      value: { rootKind: "entities" },
    });
    spaceAnnotator?.annotateJsonDirectory(spaceIno, [], {});
    piecesAnnotator?.annotateJsonDirectory(piecesIno, [], {});
    entitiesAnnotator?.annotateJsonDirectory(entitiesIno, [], {});
    spaceAnnotator?.annotateEntry(spaceIno, "pieces", piecesIno);
    spaceAnnotator?.annotateEntry(spaceIno, "entities", entitiesIno);

    const spaceJsonIno = this.#tree.addFile(
      spaceIno,
      "space.json",
      JSON.stringify(spaceMeta, null, 2),
      "object",
    );
    this.#annotateSyntheticNode(
      spaceAnnotator,
      spaceJsonIno,
      "space-meta",
      ["space.json"],
      { ino: spaceIno, name: "space.json" },
    );

    const state: SpaceState = {
      pieces,
      spaceIno,
      piecesIno,
      entitiesIno,
      pieceMap: new Map(),
      pieceInos: new Map(),
      pieceControllers: new Map(),
      entityControllers: new Map(),
      allPieceIds: new Set(),
      entityIds: new Set(),
      piecesHydrated: false,
      piecesMaterializing: false,
      pieceListSubscribed: false,
      pieceManifest: new Map(),
      pieceSubs: new Map(),
      did: spaceDid,
      unsubscribes: [],
      usedNames: new Set(),
      srcInos: new Map(),
      srcErrorLogInos: new Map(),
    };

    return state;
  }

  /**
   * Returns the connected space whose `entities/` directory is `ino`, with its
   * name, or `undefined`.
   */
  #stateForEntitiesDir(
    ino: bigint,
  ): { state: SpaceState; spaceName: string } | undefined {
    for (const [spaceName, state] of this.#spaces) {
      if (state.entitiesIno === ino) return { state, spaceName };
    }
    return undefined;
  }

  /**
   * Returns the connected space whose `pieces/` directory is `ino`, with its
   * name, or `undefined`.
   */
  #stateForPiecesDir(
    ino: bigint,
  ): { state: SpaceState; spaceName: string } | undefined {
    for (const [spaceName, state] of this.#spaces) {
      if (state.piecesIno === ino) return { state, spaceName };
    }
    return undefined;
  }

  /**
   * Fills a space's `pieces/` directory: subscribes to the piece list and syncs
   * it once, sharing the work with concurrent callers. Resolves at once for a
   * space already materialized.
   */
  #materializePieces(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    const existing = this.#pendingPieceHydrations.get(spaceName);
    if (existing) return existing;
    if (state.piecesHydrated) return Promise.resolve();

    const pending = (async () => {
      state.piecesMaterializing = true;
      try {
        await this.#subscribePieceList(state, spaceName);
        await this.#syncPieceList(state, spaceName);
        state.piecesHydrated = true;
      } finally {
        state.piecesMaterializing = false;
      }
    })().finally(() => {
      if (this.#pendingPieceHydrations.get(spaceName) === pending) {
        this.#pendingPieceHydrations.delete(spaceName);
      }
    });
    this.#pendingPieceHydrations.set(spaceName, pending);
    return pending;
  }

  /**
   * Subscribes to `state`'s piece registry so that a change re-syncs the piece
   * list on the next tick. Does nothing when already subscribed.
   */
  async #subscribePieceList(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    if (state.pieceListSubscribed) return;

    const piecesCell = await state.pieces.getPieceRegistry();
    const piecesListCancel = piecesCell.sink(() => {
      setTimeout(() => {
        this.#syncPieceList(state, spaceName).catch((e) => {
          console.error(`[${spaceName}] Piece list sync error: ${e}`);
        });
      }, CellBridge.#NEXT_MACROTASK_DELAY_MS);
    });
    state.unsubscribes.push(piecesListCancel);
    state.pieceListSubscribed = true;
  }

  /**
   * Ensures `entityId` has a directory under `state`'s `entities/`, registering
   * it as an unhydrated root unless it is already a hydrated piece root, marks
   * it used, and returns its inode.
   */
  #ensureEntityProjection(
    state: SpaceState,
    spaceName: string,
    entityId: string,
  ): bigint {
    const entityName = encodeFuseComponent(entityId);
    const info = { state, spaceName, entityId };
    const existingIno = this.#tree.lookup(state.entitiesIno, entityName);
    if (existingIno !== undefined) {
      if (!this.#pieceRoots.has(existingIno)) {
        this.#unhydratedEntityRoots.set(existingIno, info);
      }
      state.entityIds.add(entityId);
      this.#touchEntityProjection(existingIno, info);
      return existingIno;
    }

    const entityIno = this.#tree.addDir(state.entitiesIno, entityName);
    const annotator = this.#makeCfcAnnotator({
      spaceName,
      spaceDid: state.did,
      pieceId: entityId,
      rootKind: "entities",
      value: { entityId },
    });
    annotator?.annotateJsonDirectory(entityIno, [], {});
    annotator?.annotateEntry(state.entitiesIno, entityName, entityIno);
    this.#unhydratedEntityRoots.set(entityIno, info);
    state.entityIds.add(entityId);
    this.#touchEntityProjection(entityIno, info);
    return entityIno;
  }

  /**
   * Marks the entity projection `ino` most recently used, refreshes whether it
   * may be evicted, and trims the cache with `ino` protected.
   */
  #touchEntityProjection(
    ino: bigint,
    info: UnhydratedEntityRootInfo,
  ): void {
    this.#entityProjectionLru.delete(ino);
    this.#entityProjectionLru.set(ino, info);
    this.#entityProjectionUseOrder.set(
      ino,
      ++this.#nextEntityProjectionUseOrder,
    );
    this.#refreshEntityProjectionEvictionCandidate(ino);
    this.#trimEntityProjectionCache(ino);
  }

  /**
   * Recomputes whether the entity projection `ino` may be evicted: it is in the
   * cache, no hydration of it is in flight, and no kernel reference is held on
   * it.
   */
  #refreshEntityProjectionEvictionCandidate(ino: bigint): void {
    this.#entityProjectionEvictionCandidates.delete(ino);
    const info = this.#entityProjectionLru.get(ino);
    if (
      info === undefined || this.#pendingEntityHydrations.has(ino) ||
      this.#entityProjectionHasReferences(ino)
    ) {
      return;
    }
    this.#entityProjectionEvictionCandidates.set(ino, info);
  }

  /**
   * Evicts the least recently used eviction candidates, other than
   * `protectedIno`, until the cache is within its bound or no candidate
   * remains.
   */
  #trimEntityProjectionCache(protectedIno?: bigint): void {
    while (this.#entityProjectionLru.size > this.#maxEntityProjections) {
      let oldestIno: bigint | undefined;
      let oldestInfo: UnhydratedEntityRootInfo | undefined;
      let oldestUseOrder = Number.POSITIVE_INFINITY;
      for (const [ino, info] of this.#entityProjectionEvictionCandidates) {
        if (ino === protectedIno) continue;
        const useOrder = this.#entityProjectionUseOrder.get(ino);
        if (useOrder !== undefined && useOrder < oldestUseOrder) {
          oldestIno = ino;
          oldestInfo = info;
          oldestUseOrder = useOrder;
        }
      }
      if (oldestIno === undefined || oldestInfo === undefined) return;
      this.#removeEntityProjection(oldestInfo.state, oldestInfo.entityId);
    }
  }

  /**
   * Returns whether the kernel holds any lookup or open reference on the entity
   * projection `ino`.
   */
  #entityProjectionHasReferences(ino: bigint): boolean {
    return (this.#entityProjectionLookupRefs.get(ino) ?? 0n) > 0n ||
      (this.#entityProjectionOpenRefs.get(ino) ?? 0) > 0;
  }

  /**
   * Cancels and forgets the cell subscriptions of the hydrated entity root
   * `ino`.
   */
  #cancelEntitySubscriptions(ino: bigint): void {
    const subscriptions = this.#entitySubscriptions.get(ino);
    if (!subscriptions) return;
    this.#entitySubscriptions.delete(ino);
    for (const cancel of subscriptions) cancel();
  }

  /**
   * Completes the removal of the detached entity projection `ino` once no
   * hydration of it is in flight and no kernel reference remains: forgets it
   * everywhere, clears its subtree, and drops its entity controller unless a
   * new projection has taken its name. Does nothing otherwise.
   */
  #finishPendingEntityRemoval(ino: bigint): void {
    const info = this.#pendingEntityRemovals.get(ino);
    if (
      !info || this.#pendingEntityHydrations.has(ino) ||
      this.#entityProjectionHasReferences(ino)
    ) {
      return;
    }

    this.#pendingEntityRemovals.delete(ino);
    this.#entityProjectionLru.delete(ino);
    this.#entityProjectionEvictionCandidates.delete(ino);
    this.#entityProjectionUseOrder.delete(ino);
    this.#unhydratedEntityRoots.delete(ino);
    this.#cancelEntitySubscriptions(ino);
    this.#unregisterPieceRoot(ino);
    this.#fsProjectionEntries.delete(ino);
    this.#clearEntityProjectionReferences(ino);
    this.#tree.clear(ino);

    const currentIno = this.#tree.lookup(
      info.state.entitiesIno,
      encodeFuseComponent(info.entityId),
    );
    if (currentIno === undefined) {
      info.state.entityControllers.delete(info.entityId);
    }
  }

  /**
   * Detaches `entityId`'s projection from `state`'s `entities/`, cancels its
   * subscriptions, and queues its subtree for removal once the kernel releases
   * it; with `invalidate`, also touches the directory and invalidates its
   * kernel entry. Returns the directory name detached, or `undefined` when the
   * entity had no directory.
   */
  #removeEntityProjection(
    state: SpaceState,
    entityId: string,
    invalidate = true,
  ): string | undefined {
    const entityName = encodeFuseComponent(entityId);
    const entityIno = this.#tree.lookup(state.entitiesIno, entityName);
    if (entityIno === undefined) {
      state.entityIds.delete(entityId);
      return undefined;
    }

    const info = this.#entityProjectionLru.get(entityIno) ??
      this.#unhydratedEntityRoots.get(entityIno) ?? {
      state,
      spaceName: this.#pieceRoots.get(entityIno)?.spaceName ?? "",
      entityId,
    };
    this.#entityProjectionLru.delete(entityIno);
    this.#entityProjectionEvictionCandidates.delete(entityIno);
    this.#entityProjectionUseOrder.delete(entityIno);
    this.#unhydratedEntityRoots.delete(entityIno);
    this.#cancelEntitySubscriptions(entityIno);
    this.#pendingEntityRemovals.set(entityIno, info);
    this.#tree.detachChild(state.entitiesIno, entityName);
    state.entityIds.delete(entityId);
    if (invalidate) {
      this.#tree.touch(state.entitiesIno);
      this.#onInvalidate?.(state.entitiesIno, [entityName]);
      this.#onInvalidateInode?.(state.entitiesIno);
    }
    this.#finishPendingEntityRemoval(entityIno);
    return entityName;
  }

  /**
   * Removes every projection of `state` whose entity id is absent from
   * `sortedLiveIds`, then invalidates the `entities/` listing if any was
   * removed.
   */
  #pruneEntityProjections(
    state: SpaceState,
    sortedLiveIds: readonly string[],
  ): void {
    const removed: string[] = [];
    for (const entityId of [...state.entityIds]) {
      if (this.#sortedEntityIdsInclude(sortedLiveIds, entityId)) continue;
      const name = this.#removeEntityProjection(state, entityId, false);
      if (name !== undefined) removed.push(name);
    }
    if (removed.length > 0) {
      this.#tree.touch(state.entitiesIno);
      this.#onInvalidate?.(state.entitiesIno, removed);
      this.#onInvalidateInode?.(state.entitiesIno);
    }
  }

  /**
   * Helper for `#pruneEntityProjections()`, which returns whether `target` is
   * in the sorted `sortedIds`, by binary search.
   */
  #sortedEntityIdsInclude(
    sortedIds: readonly string[],
    target: string,
  ): boolean {
    let low = 0;
    let high = sortedIds.length - 1;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const candidate = sortedIds[middle];
      if (candidate === target) return true;
      if (candidate < target) low = middle + 1;
      else high = middle - 1;
    }
    return false;
  }

  /**
   * Returns the entries `state`'s `entities/` lists, sharing one walk of the
   * server's pages among concurrent callers.
   */
  #entityDirectorySnapshot(
    state: SpaceState,
  ): Promise<readonly DirectorySnapshotEntry[]> {
    const existing = this.#pendingEntityDirectorySnapshots.get(state);
    if (existing) return existing;
    const pending = this.#loadEntityDirectorySnapshot(state).finally(() => {
      if (this.#pendingEntityDirectorySnapshots.get(state) === pending) {
        this.#pendingEntityDirectorySnapshots.delete(state);
      }
    });
    this.#pendingEntityDirectorySnapshots.set(state, pending);
    return pending;
  }

  /**
   * Helper for `#entityDirectorySnapshot()`, which lists the live entity ids,
   * prunes the projections of ids not among them, and returns the listing.
   */
  async #loadEntityDirectorySnapshot(
    state: SpaceState,
  ): Promise<readonly DirectorySnapshotEntry[]> {
    const ids = await this.#listEntityIdsForSnapshot(state);
    this.#pruneEntityProjections(state, ids);
    return collectVirtualDirectorySnapshot(
      this.#tree,
      state.entitiesIno,
      ids.map((id) => encodeFuseComponent(id)),
    );
  }

  /**
   * Helper for `#loadEntityDirectorySnapshot()`, which walks the server's
   * entity-id pages into one sorted list.
   *
   * @throws If the server does not page entity ids, or the pages come from
   *   different server sequences, are not strictly sorted, or fail to advance.
   */
  async #listEntityIdsForSnapshot(state: SpaceState): Promise<string[]> {
    if (typeof state.pieces.listEntityIdPage !== "function") {
      throw new Error(
        "memory server does not support paginated entity identifier listing",
      );
    }

    const ids: string[] = [];
    let after: string | undefined;
    let expectedServerSeq: number | undefined;
    let previousId: string | undefined;
    for (;;) {
      const page = await state.pieces.listEntityIdPage({
        ...(after === undefined ? {} : { after }),
        limit: ENTITY_ID_PAGE_SIZE,
        ...(expectedServerSeq === undefined ? {} : { expectedServerSeq }),
      });
      if (page === undefined) {
        throw new Error(
          "memory server does not support paginated entity identifier listing",
        );
      }
      if (expectedServerSeq === undefined) {
        expectedServerSeq = page.serverSeq;
      } else if (page.serverSeq !== expectedServerSeq) {
        throw new Error(
          `entity identifier snapshot changed from server sequence ${expectedServerSeq} to ${page.serverSeq}`,
        );
      }
      for (const id of page.ids) {
        if (previousId !== undefined && id <= previousId) {
          throw new Error("entity identifier pages are not strictly sorted");
        }
        ids.push(id);
        previousId = id;
      }
      if (page.nextAfter === undefined) return ids;
      if (
        page.ids.length === 0 || page.nextAfter === after ||
        page.ids.at(-1) !== page.nextAfter
      ) {
        throw new Error("entity identifier page did not advance");
      }
      after = page.nextAfter;
    }
  }

  /**
   * Hydrates the unhydrated entity root `entityIno`: loads its piece, builds
   * its tree in place, and subscribes to it, sharing the work with concurrent
   * callers. Resolves to whether the root is hydrated: false when it is not an
   * entity root or was removed meanwhile, and true at once for a root already
   * hydrated, which is marked used.
   */
  #hydrateEntityRoot(entityIno: bigint): Promise<boolean> {
    if (this.#pieceRoots.has(entityIno)) {
      const info = this.#entityProjectionLru.get(entityIno);
      if (info) this.#touchEntityProjection(entityIno, info);
      return Promise.resolve(true);
    }
    const existing = this.#pendingEntityHydrations.get(entityIno);
    if (existing) return existing;
    const info = this.#unhydratedEntityRoots.get(entityIno);
    if (!info) return Promise.resolve(false);
    this.#touchEntityProjection(entityIno, info);

    const pending = (async () => {
      const piece = info.state.entityControllers.get(info.entityId) ??
        await info.state.pieces.get(info.entityId, false);
      if (this.#unhydratedEntityRoots.get(entityIno) !== info) return false;
      info.state.entityControllers.set(info.entityId, piece);
      await this.#loadPieceTree(
        piece,
        info.state.entitiesIno,
        encodeFuseComponent(info.entityId),
        info.spaceName,
        entityIno,
        "entities",
      );
      if (this.#unhydratedEntityRoots.get(entityIno) !== info) return false;
      const subscriptions = await this.#subscribePiece(
        piece,
        entityIno,
        encodeFuseComponent(info.entityId),
        info.spaceName,
        info.state,
      );
      if (this.#unhydratedEntityRoots.get(entityIno) !== info) {
        for (const cancel of subscriptions) cancel();
        return false;
      }
      this.#entitySubscriptions.set(entityIno, subscriptions);
      this.#unhydratedEntityRoots.delete(entityIno);
      return true;
    })().finally(() => {
      if (this.#pendingEntityHydrations.get(entityIno) === pending) {
        this.#pendingEntityHydrations.delete(entityIno);
      }
      this.#finishPendingEntityRemoval(entityIno);
      this.#refreshEntityProjectionEvictionCandidate(entityIno);
      this.#trimEntityProjectionCache();
    });
    this.#pendingEntityHydrations.set(entityIno, pending);
    this.#entityProjectionEvictionCandidates.delete(entityIno);
    return pending;
  }

  /**
   * Helper for `resolveEntity()` and `prepareLookupForReply()`, which resolves
   * `entityId` under `entitiesIno` to its projection's inode, retaining one
   * lookup reference on it when `retainForReply`. Returns `undefined` for a
   * name that is not a canonically encoded id, a directory that is not an
   * `entities/`, an entity the server says does not exist — whose projection
   * is removed — or one nothing here knows.
   */
  async #resolveEntityInode(
    entitiesIno: bigint,
    entityId: string,
    retainForReply = false,
  ): Promise<bigint | undefined> {
    const decodedEntityId = decodeFuseComponent(entityId);
    if (encodeFuseComponent(decodedEntityId) !== entityId) {
      return undefined;
    }

    const entities = this.#stateForEntitiesDir(entitiesIno);
    if (!entities) return undefined;
    const existingIno = this.#tree.lookup(entitiesIno, entityId);
    const exists = typeof entities.state.pieces.entityIdExists === "function"
      ? await entities.state.pieces.entityIdExists(decodedEntityId)
      : undefined;
    if (exists === false) {
      if (
        existingIno !== undefined &&
        this.#pendingEntityHydrations.has(existingIno)
      ) {
        await this.#pendingEntityHydrations.get(existingIno)?.catch(() =>
          false
        );
      }
      this.#removeEntityProjection(entities.state, decodedEntityId);
      return undefined;
    }
    if (exists === true) {
      const ino = this.#ensureEntityProjection(
        entities.state,
        entities.spaceName,
        decodedEntityId,
      );
      if (retainForReply) this.retainEntityProjectionLookup(ino);
      return ino;
    }

    if (existingIno !== undefined) {
      this.#touchEntityProjection(existingIno, {
        state: entities.state,
        spaceName: entities.spaceName,
        entityId: decodedEntityId,
      });
      if (retainForReply) this.retainEntityProjectionLookup(existingIno);
      return existingIno;
    }

    const piece = [...entities.state.pieceControllers.values()].find(
      (candidate) => candidate.id === decodedEntityId,
    );
    if (!piece || encodeFuseComponent(piece.id) !== entityId) return undefined;
    const ino = this.#ensureEntityProjection(
      entities.state,
      entities.spaceName,
      piece.id,
    );
    entities.state.entityControllers.set(piece.id, piece);
    if (retainForReply) this.retainEntityProjectionLookup(ino);
    return ino;
  }

  /**
   * Loads a piece's NAME doc, best-effort, through the same schema path that
   * `piece.name()` reads synchronously. The piece list deliberately doesn't
   * load linked piece docs (its items are `asCell`), so on a cold runtime
   * `piece.name()` races the doc load and would fall back to the opaque
   * id-derived directory name — permanently, if no later change event fires.
   */
  async #syncPieceName(piece: PieceController): Promise<void> {
    if (typeof piece.getCell !== "function") return;
    try {
      await (piece.getCell() as Cell<unknown>).asSchema(nameSchema).sync();
    } catch {
      // Name stays unavailable; `#addPieceToSpace()` falls back to the piece
      // id.
    }
  }

  /**
   * Adds a single piece to a space's tree — its directory, source tree,
   * manifest entry, and subscriptions — and returns the assigned display
   * name.
   */
  async #addPieceToSpace(
    state: SpaceState,
    piece: PieceController,
    spaceName: string,
  ): Promise<string> {
    // The piece list deliberately doesn't load the linked piece docs
    // (pieceListSchema items are `asCell`), so on a cold runtime the
    // synchronous `piece.name()` read races the doc load and the directory
    // would be created under the opaque id-derived fallback name — and never
    // renamed if no further change event arrives. Await the NAME through the
    // same schema path `name()` reads before choosing the directory name.
    await this.#syncPieceName(piece);
    const rawName = piece.name();
    let name = resolveProjectedPieceName(rawName, piece.id);
    this.#debugLog(
      `[${spaceName}] addPieceToSpace: id=${piece.id} rawName=${
        JSON.stringify(rawName)
      } resolved=${name}`,
    );
    if (state.usedNames.has(name)) {
      let suffix = 2;
      while (state.usedNames.has(`${name}-${suffix}`)) suffix++;
      name = `${name}-${suffix}`;
    }
    state.usedNames.add(name);

    state.pieceMap.set(name, piece.id);
    state.pieceControllers.set(name, piece);

    const pieceIno = await this.#loadPieceTree(
      piece,
      state.piecesIno,
      name,
      spaceName,
      undefined,
      "pieces",
    );
    state.pieceInos.set(name, pieceIno);
    await this.#buildSourceTree(pieceIno, piece, state, name);
    await this.#refreshPieceManifest(state, piece);

    const subs = await this.#subscribePiece(
      piece,
      pieceIno,
      name,
      spaceName,
      state,
    );
    state.pieceSubs.set(name, subs);

    // The pieces directory gained an entry.
    this.#tree.touch(state.piecesIno);

    return name;
  }

  /**
   * Removes `name`'s piece from `state`'s tree and bookkeeping, canceling its
   * subscriptions.
   */
  #removePieceFromSpace(state: SpaceState, name: string): void {
    const pieceId = state.pieceMap.get(name);
    const pieceIno = this.#tree.lookup(state.piecesIno, name);
    if (pieceIno !== undefined) {
      this.#unregisterPieceRoot(pieceIno);
      this.#fsProjectionEntries.delete(pieceIno);
    }

    // Cancel piece-level subscriptions
    const subs = state.pieceSubs.get(name);
    if (subs) {
      for (const cancel of subs) cancel();
      state.pieceSubs.delete(name);
    }

    // Remove tree nodes
    if (this.#tree.removeChild(state.piecesIno, name) !== undefined) {
      this.#tree.touch(state.piecesIno);
    }

    state.pieceMap.delete(name);
    state.pieceInos.delete(name);
    state.pieceControllers.delete(name);
    if (pieceId) {
      state.pieceManifest.delete(pieceId);
    }
    state.srcInos.delete(name);
    state.srcErrorLogInos.delete(name);
    state.usedNames.delete(name);
  }

  /**
   * Synchronizes the piece list: diffs the current tree against the live pieces
   * cell, adding new pieces and removing deleted ones.
   *
   * Guarded per-space: if a sync is already running, we flag a re-run so the
   * in-flight sync will loop once more after completing (coalescing rapid sink
   * events). This prevents concurrent async interleaving from producing
   * duplicate tree entries or double-removal errors.
   */
  #syncPieceList(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    const existing = this.#pieceSyncs.get(spaceName);
    if (existing) {
      this.#syncAgain.add(spaceName);
      return existing;
    }

    const pending = this.#runPieceListSync(state, spaceName).finally(() => {
      if (this.#pieceSyncs.get(spaceName) === pending) {
        this.#pieceSyncs.delete(spaceName);
      }
    });
    this.#pieceSyncs.set(spaceName, pending);
    return pending;
  }

  /**
   * Helper for `#syncPieceList()`, which runs passes until no re-run is
   * flagged.
   */
  async #runPieceListSync(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    do {
      this.#syncAgain.delete(spaceName);
      await this.#syncPieceListOnce(state, spaceName);
    } while (this.#syncAgain.has(spaceName));
  }

  /**
   * Runs one pass of piece-list sync; `#syncPieceList()` guards the calls.
   * Until `pieces/` is materialized or materializing, a pass only records the
   * registered ids.
   */
  async #syncPieceListOnce(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    const registeredPieces = await state.pieces.getRegisteredPieces();
    state.allPieceIds = new Set(registeredPieces.map((piece) => piece.id));
    this.#debugLog(
      `[${spaceName}] syncPieceListOnce: live=${registeredPieces.length} tracked=${state.pieceMap.size}`,
    );

    if (!state.piecesHydrated && !state.piecesMaterializing) return;

    // Build set of current entity IDs
    const liveIds = new Set(registeredPieces.map((p) => p.id));

    // Find pieces to remove (in our tree but no longer in the live list)
    const toRemove: string[] = [];
    for (const [name, id] of state.pieceMap) {
      if (!liveIds.has(id)) toRemove.push(name);
    }

    // Find pieces to add (in the live list but not in our tree)
    const knownIds = new Set(state.pieceMap.values());
    const toAdd = registeredPieces.filter((p) => !knownIds.has(p.id));

    if (toRemove.length === 0 && toAdd.length === 0) return;

    for (const name of toRemove) {
      this.#removePieceFromSpace(state, name);
      this.#debugLog(`[${spaceName}] Removed piece: ${name}`);
    }

    for (const piece of toAdd) {
      const name = await this.#addPieceToSpace(state, piece, spaceName);
      this.#debugLog(`[${spaceName}] Added piece: ${name}`);
    }

    // Update index and invalidate
    this.#updateIndexJson(state);
    this.#updatePiecesJson(state);
    if (this.#onInvalidate) {
      // Invalidate child entries under pieces/
      const invalidNames = [
        ...toRemove,
        ...toAdd.map((p) => {
          for (const [n, id] of state.pieceMap) {
            if (id === p.id) return n;
          }
          return "";
        }),
        ".index.json",
        "pieces.json",
      ];
      this.#onInvalidate(state.piecesIno, invalidNames);
      // Also invalidate "pieces" entry on the space dir so readdir refreshes
      this.#onInvalidate(state.spaceIno, ["pieces"]);
    }
    // Invalidate cached inode data for pieces dir (forces readdir refresh)
    if (this.#onInvalidateInode) {
      this.#onInvalidateInode(state.piecesIno);
    }
  }

  /** Rewrites the `pieces/pieces.json` manifest for a space. */
  #updatePiecesJson(state: SpaceState): void {
    const entries = this.#buildPiecesManifestEntries(state);
    const existingIno = this.#tree.lookup(state.piecesIno, "pieces.json");
    if (existingIno !== undefined) {
      this.#tree.clear(existingIno);
    }
    const piecesJsonIno = this.#tree.addFile(
      state.piecesIno,
      "pieces.json",
      JSON.stringify(entries, null, 2),
      "object",
    );
    const annotator = this.#makeCfcAnnotator({
      spaceName: this.#spaceNameForState(state) ?? state.did,
      spaceDid: state.did,
      rootKind: "pieces",
      value: entries,
    });
    this.#annotateSyntheticNode(
      annotator,
      piecesJsonIno,
      "pieces-manifest",
      ["pieces.json"],
      { ino: state.piecesIno, name: "pieces.json" },
    );
  }

  /** Rewrites the `pieces/.index.json` file for a space. */
  #updateIndexJson(state: SpaceState): void {
    const existingIno = this.#tree.lookup(state.piecesIno, ".index.json");
    if (existingIno !== undefined) {
      this.#tree.clear(existingIno);
    }
    const indexObj: Record<string, string> = {};
    for (const [name, id] of state.pieceMap) {
      indexObj[name] = id;
    }
    const indexIno = this.#tree.addFile(
      state.piecesIno,
      ".index.json",
      JSON.stringify(indexObj, null, 2),
      "object",
    );
    const annotator = this.#makeCfcAnnotator({
      spaceName: this.#spaceNameForState(state) ?? state.did,
      spaceDid: state.did,
      rootKind: "pieces",
      value: indexObj,
    });
    this.#annotateSyntheticNode(
      annotator,
      indexIno,
      "pieces-manifest",
      [".index.json"],
      { ino: state.piecesIno, name: ".index.json" },
    );
  }

  /** Sets the `name` field of the `meta.json` under `parentIno`. */
  #updatePieceMetaName(parentIno: bigint, name: string): void {
    this.#updatePieceMeta(parentIno, { name });
  }

  /** Sets the `patternRef` field of the `meta.json` under `parentIno`. */
  #updatePieceMetaPatternRef(
    parentIno: bigint,
    patternRef: PiecePatternRef,
  ): void {
    this.#updatePieceMeta(parentIno, { patternRef });
  }

  /**
   * Merges `updates` into the `meta.json` under `parentIno`, leaving a missing
   * or malformed file as it is.
   */
  #updatePieceMeta(
    parentIno: bigint,
    updates: Record<string, unknown>,
  ): void {
    const metaIno = this.#tree.lookup(parentIno, "meta.json");
    if (metaIno === undefined) return;

    const metaNode = this.#tree.getNode(metaIno);
    if (!metaNode || metaNode.kind !== "file") return;

    try {
      const parsed = JSON.parse(new TextDecoder().decode(metaNode.content));
      if (!isObjectNotArray(parsed)) {
        return;
      }
      this.#tree.updateFile(
        metaIno,
        JSON.stringify({ ...parsed, ...updates }, null, 2),
        "object",
      );
    } catch {
      // Ignore malformed synthetic metadata.
    }
  }

  /**
   * Removes a piece's [FS] projection entries from the tree. When `changes` is
   * supplied, each removed entry is recorded so its cached directory entry is
   * invalidated: a projection leaving the piece root (the result becomes null
   * or switches back to the normal result tree) must drop the client's cached
   * `index.md` and sibling dentries, or they resolve to freed inodes. The
   * `.fs.pending` staging container is internal and never has a cached entry,
   * so it is cleared but not recorded.
   */
  #clearFsProjectionEntries(
    pieceIno: bigint,
    changes?: TransplantChanges,
  ): void {
    const entries = this.#fsProjectionEntries.get(pieceIno);
    this.#fsProjectionEntries.delete(pieceIno);

    for (const name of ["index.md", "index.json", ".fs.pending"]) {
      const ino = this.#tree.lookup(pieceIno, name);
      if (ino !== undefined) {
        this.#tree.clear(ino);
        if (changes && name !== ".fs.pending") {
          FsTree.recordEntryChange(changes, pieceIno, name);
        }
      }
    }

    if (!entries) return;
    for (const name of entries) {
      const ino = this.#tree.lookup(pieceIno, name);
      if (ino !== undefined) {
        this.#tree.clear(ino);
        if (changes) FsTree.recordEntryChange(changes, pieceIno, name);
      }
    }
  }

  /**
   * Builds a piece's [FS] projection under `parentIno`, which is a staging
   * container so the finished projection can be reconciled onto the piece
   * directory without churning inodes. Returns the index file name and the set
   * of entry names produced, so the caller can swap them into place and record
   * which piece-root names the projection now owns.
   */
  #buildFsProjectionTree(
    parentIno: bigint,
    pieceId: string,
    fsValue: FsValue,
    treeValue: unknown,
    callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    >,
    resolveLink: ResolveLink,
    skipEntry: (value: unknown) => boolean,
    classifyEntry: (key: string, value: unknown) => CallableKind | null,
    annotator?: CfcProjectionAnnotator,
  ): { indexName: "index.md" | "index.json"; entries: Set<string> } {
    const entries = new Set<string>();
    const indexName = fsValue.type === "text/markdown"
      ? "index.md"
      : "index.json";
    entries.add(indexName);

    const indexIno = buildFsProjection(
      this.#tree,
      parentIno,
      fsValue,
      pieceId,
      (siblingParentIno, name, value) => {
        if (siblingParentIno === parentIno) {
          entries.add(encodeFuseComponent(name, { reserveJsonSuffix: true }));
        }
        this.#makeFsSubtreeBuilder(
          resolveLink,
          skipEntry,
          classifyEntry,
          annotator,
        )(siblingParentIno, name, value);
      },
    );
    const projectionLabel = annotator?.subtreeLabel(treeValue, []);
    this.#annotateSyntheticNode(
      annotator,
      indexIno,
      "fs-projection",
      [indexName],
      { ino: parentIno, name: indexName },
      projectionLabel,
    );

    this.#addVNodeJsonFiles(parentIno, treeValue, annotator);
    if (isObjectNotArray(treeValue)) {
      for (const [key, value] of Object.entries(treeValue)) {
        if (isVNode(value)) entries.add(`${encodeFuseComponent(key)}.json`);
      }
    }

    this.#addCallableFiles(parentIno, callables, "result", annotator);
    for (const { key, callableKind } of callables) {
      entries.add(`${encodeFuseComponent(key)}.${callableKind}`);
    }

    return { indexName, entries };
  }

  /**
   * Reconciles a staging container's children onto the piece directory,
   * adopting an existing inode whenever a name survives with the same node
   * kind so [FS] projection entries keep their inode across a rebuild. Old
   * projection entries absent from the rebuild are removed. Returns the entry
   * names now present.
   */
  #swapFsProjection(
    pieceIno: bigint,
    stageIno: bigint,
    oldNames: Iterable<string>,
    changes: TransplantChanges,
    annotator?: CfcProjectionAnnotator,
  ): Set<string> {
    const newNames = new Set<string>();
    for (const [name, stagedIno] of this.#tree.getChildren(stageIno)) {
      newNames.add(name);
      const oldIno = this.#tree.lookup(pieceIno, name);
      const oldNode = oldIno !== undefined
        ? this.#tree.getNode(oldIno)
        : undefined;
      const stagedNode = this.#tree.getNode(stagedIno);
      if (
        oldIno !== undefined && oldNode && stagedNode &&
        oldNode.kind === stagedNode.kind
      ) {
        this.#mergeTransplantChanges(
          changes,
          this.#tree.transplantSubtree(oldIno, stagedIno),
        );
        annotator?.annotateEntry(pieceIno, name, oldIno);
      } else {
        if (oldIno !== undefined) {
          this.#tree.clear(oldIno);
        }
        this.#tree.rename(stageIno, name, pieceIno, name);
        const movedIno = this.#tree.lookup(pieceIno, name);
        if (movedIno !== undefined) {
          annotator?.annotateEntry(pieceIno, name, movedIno);
        }
        FsTree.recordEntryChange(changes, pieceIno, name);
      }
    }
    for (const name of oldNames) {
      if (newNames.has(name)) continue;
      const oldIno = this.#tree.lookup(pieceIno, name);
      if (oldIno !== undefined) {
        this.#tree.clear(oldIno);
        FsTree.recordEntryChange(changes, pieceIno, name);
      }
    }
    this.#tree.clear(stageIno);
    return newNames;
  }

  /**
   * Finds the callable entries of a cell — handlers and tools, told by value
   * or by schema, and pattern-shaped children carrying `extraParams` — and
   * returns them with their input schemas, along with the predicates the tree
   * builder takes: one that skips a callable's or a VNode's value, and one
   * that classifies an entry by key.
   */
  #discoverCallableEntries(
    rootCell: Cell<unknown>,
    value: unknown,
  ): {
    callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    >;
    skipEntry: (value: unknown) => boolean;
    classifyEntry: (key: string, value: unknown) => CallableKind | null;
  } {
    const schema = rootCell.asSchemaFromLinks().schema as
      | Record<string, unknown>
      | undefined;
    const schemaProperties = schema?.properties as
      | Record<string, unknown>
      | undefined;
    const valueObject = isObjectNotArray(value)
      ? value as Record<string, unknown>
      : null;
    const candidateKeys = new Set<string>([
      ...Object.keys(valueObject ?? {}),
      ...Object.keys(
        schemaProperties &&
          typeof schemaProperties === "object" &&
          !Array.isArray(schemaProperties)
          ? schemaProperties
          : {},
      ),
    ]);
    if (candidateKeys.size === 0) {
      return {
        callables: [],
        skipEntry: () => false,
        classifyEntry: () => null,
      };
    }

    const callableValues = new WeakSet<object>();
    const callableKinds = new Map<string, CallableKind>();
    const callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    > = [];
    for (const key of candidateKeys) {
      const candidate = valueObject?.[key];
      const childCell = rootCell.key(key).asSchemaFromLinks();
      let resolvedCandidate = candidate;
      try {
        resolvedCandidate = childCell.getRaw?.() ?? childCell.get?.() ??
          candidate;
      } catch {
        resolvedCandidate = candidate;
      }

      // The cell itself is the last thing asked, the way the CLI's detector
      // asks it: a stream's document holds no value for either candidate to
      // carry, and the link-derived cell answers from its stored links. It is
      // asked only of a position that resolved to nothing or to a link, since
      // a stream holds no value of its own and the question costs a read of
      // the cell; a position holding a value is not one.
      const childSchema = expandSchemaReference(childCell.schema);
      let callableKind = classifyCallableEntry(candidate, childSchema) ??
        classifyCallableEntry(resolvedCandidate, childSchema) ??
        (resolvedCandidate === undefined || isSigilLink(resolvedCandidate)
          ? classifyCallableEntry(childCell, childSchema)
          : null);

      if (!callableKind) {
        try {
          const pattern = childCell.key("pattern").getRaw?.() ??
            childCell.key("pattern").get?.();
          const extraParams = childCell.key("extraParams").get?.();
          if (pattern !== undefined && extraParams !== undefined) {
            callableKind = "tool";
          }
        } catch {
          // Not a pattern tool-shaped child cell.
        }
      }

      if (!callableKind) continue;

      callables.push({
        key,
        callableKind,
        schema: getInputSchema(childSchema),
      });
      callableKinds.set(key, callableKind);
      if (isObjectOrArray(candidate)) {
        callableValues.add(candidate);
      }
    }

    return {
      callables,
      skipEntry: (candidate: unknown) =>
        (isObjectOrArray(candidate) &&
          callableValues.has(candidate)) ||
        isVNode(candidate),
      classifyEntry: (key: string) => callableKinds.get(key) ?? null,
    };
  }

  /**
   * Returns the value to project for `rootCell`: `value` itself when it is a
   * non-null primitive or an array, or when the cell's schema names no
   * properties; otherwise `value` widened with every schema property the cell
   * resolves — a sigil link kept raw so it projects as a symlink, and a
   * callable kept even without a value — or `value` itself when that yields
   * nothing. A `null` or `undefined` value takes that same path, and so
   * becomes an object of the properties the cell resolves, or stays as it is
   * when none do.
   */
  #materializeTreeValue(
    rootCell: Cell<unknown>,
    value: unknown,
  ): unknown {
    if (
      value !== undefined && value !== null &&
      (typeof value !== "object" || Array.isArray(value))
    ) {
      return value;
    }

    const schema = rootCell.asSchemaFromLinks().schema as
      | Record<
        string,
        unknown
      >
      | undefined;
    const properties = schema?.properties as
      | Record<string, unknown>
      | undefined;
    if (!properties || Array.isArray(properties)) {
      return value;
    }

    const materialized: Record<string, unknown> = isObjectNotArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
    for (const key of Object.keys(properties)) {
      const childCell = rootCell.key(key).asSchemaFromLinks();
      let childValue: unknown;
      try {
        childValue = childCell.get?.();
        // Override with the raw link reference only for sigil links, which
        // is what enables FUSE symlinks.
        const rawValue = childCell.getRaw?.();
        if (isSigilLink(rawValue)) {
          childValue = rawValue;
        }
      } catch {
        childValue = undefined;
      }

      const callableKind =
        classifyCallableEntry(childValue, childCell.schema) ??
          classifyCallableEntry(childCell, childCell.schema);

      if (callableKind) {
        if (!(key in materialized)) {
          materialized[key] = childValue ?? childCell;
        }
        continue;
      }

      if (childValue !== undefined && !(key in materialized)) {
        materialized[key] = childValue;
      }
    }

    return Object.keys(materialized).length > 0 ? materialized : value;
  }

  /**
   * Adds a callable file under `propIno` for each of `callables`, holding the
   * shim script for its kind and input type, annotated when an `annotator` is
   * given.
   */
  #addCallableFiles(
    propIno: bigint,
    callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    >,
    cellProp: "input" | "result",
    annotator?: CfcProjectionAnnotator,
  ): void {
    for (const { key, callableKind, schema } of callables) {
      const typeStr = displayCallableInputType(callableKind, schema);
      const script = buildCallableScript(this.#execCli, schema, typeStr);
      const fileName = `${encodeFuseComponent(key)}.${callableKind}`;
      const callableIno = this.#tree.addCallable(
        propIno,
        fileName,
        callableKind,
        key,
        cellProp,
        script,
      );
      const schemaLabel = schema === undefined
        ? undefined
        : annotator?.subtreeLabel(schema, [key]);
      annotator?.annotateCallable(callableIno, [key], {
        callableKind,
        cellKey: key,
        cellProp,
        schemaLabel,
      });
      annotator?.annotateEntry(propIno, fileName, callableIno, {
        labelPath: [key],
      });
    }
  }

  /**
   * Adds a `<key>.json` file under `parentIno` for each VNode-typed property of
   * `value`, in place of the directory tree the JSON builder would otherwise
   * produce for a UI tree, and removes the `$`-prefixed `.json` files of VNode
   * properties absent from `value`.
   */
  #addVNodeJsonFiles(
    parentIno: bigint,
    value: unknown,
    annotator?: CfcProjectionAnnotator,
  ): void {
    const currentVNodeKeys = new Set<string>();

    if (isObjectNotArray(value)) {
      for (
        const [key, val] of Object.entries(value as Record<string, unknown>)
      ) {
        if (isVNode(val)) {
          const encodedKey = encodeFuseComponent(key);
          const fileName = `${encodedKey}.json`;
          currentVNodeKeys.add(encodedKey);
          const existing = this.#tree.lookup(parentIno, fileName);
          if (existing !== undefined) this.#tree.clear(existing);
          const vnodeIno = this.#tree.addFile(
            parentIno,
            fileName,
            stringifyEntryValue(this.#tree, parentIno, fileName, val),
            "object",
          );
          const contentLabel = annotator?.subtreeLabel(val, [key]);
          this.#annotateSyntheticNode(
            annotator,
            vnodeIno,
            "aggregate-json",
            [key],
            { ino: parentIno, name: fileName },
            contentLabel,
          );
        }
      }
    }

    // Remove stale VNode `.json` files from previous renders.
    // We identify them by looking for `<key>.json` children whose key starts
    // with "$" (VNode keys are always system-prefixed symbols like $UI).
    for (const [name, ino] of this.#tree.getChildren(parentIno)) {
      if (
        name.endsWith(".json") && name.startsWith("$") &&
        !currentVNodeKeys.has(name.slice(0, -5))
      ) {
        // Check if this was a VNode file by seeing if the child was a file
        // (not a directory — directories are never VNode projections).
        const node = this.#tree.getNode(ino);
        if (node && node.kind === "file") {
          this.#tree.clear(ino);
        }
      }
    }
  }

  /**
   * Generates the `.handlers` summary file at the piece root, one line per
   * callable: `<name>.<handler|tool>  <input-type>`. Dot-prefixed so it is
   * hidden from a plain `ls` but readable with `cat`. A piece with no callables
   * gets no file, and any existing one is removed.
   */
  #buildHandlersFile(
    pieceIno: bigint,
    callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    >,
    annotator?: CfcProjectionAnnotator,
  ): void {
    const existingIno = this.#tree.lookup(pieceIno, ".handlers");
    if (existingIno !== undefined) this.#tree.clear(existingIno);
    if (callables.length === 0) return;
    const lines = callables.map(({ key, callableKind, schema }) => {
      const typeStr = displayCallableInputType(callableKind, schema);
      return `${key}.${callableKind}  ${typeStr}`;
    });
    const handlersIno = this.#tree.addFile(
      pieceIno,
      ".handlers",
      lines.join("\n") + "\n",
      "string",
    );
    const schemaLabels = callables.map(({ key, schema }) =>
      schema === undefined ? undefined : annotator?.subtreeLabel(schema, [key])
    );
    this.#annotateSyntheticNode(
      annotator,
      handlersIno,
      "piece-meta",
      [".handlers"],
      { ino: pieceIno, name: ".handlers" },
      joinLabels(...schemaLabels),
    );
  }

  /**
   * Builds a subtree callback for `buildFsProjection()`. Complex frontmatter
   * fields (arrays of entities, nested objects) are rendered as sibling
   * directories using the standard `buildJsonTree()` path.
   */
  #makeFsSubtreeBuilder(
    resolveLink: ResolveLink,
    skipEntry: (v: unknown) => boolean,
    classifyEntry: (k: string, v: unknown) => CallableKind | null,
    annotator?: CfcProjectionAnnotator,
  ): (parentIno: bigint, name: string, value: unknown) => void {
    return (parentIno, name, value) => {
      const classifyFsEntry = (key: string, candidate: unknown) =>
        skipEntry(candidate) ? classifyEntry(key, candidate) : null;
      buildJsonTree(
        this.#tree,
        parentIno,
        name,
        value,
        resolveLink,
        0,
        skipEntry,
        classifyFsEntry,
        annotator?.jsonContext([name]),
      );
    };
  }

  /**
   * Reads the [FS] projection value from a result cell: Markdown with its
   * frontmatter, or JSON content, with a `$FS` object carrying no `type` taken
   * whole as JSON content. Returns `null` if the result does not declare `$FS`,
   * declares an unknown type, or cannot be read.
   */
  #readFsValue(
    resultCell: Cell<unknown>,
    result: unknown,
  ): FsValue | null {
    if (
      !isObjectOrArray(result) ||
      !("$FS" in (result as Record<string, unknown>))
    ) {
      return null;
    }

    try {
      const fsCell = resultCell.key("$FS");
      const fsRaw = fsCell.get();

      // Plain-object shorthand: no `type` field, so the entire value is JSON
      // content.
      if (
        isObjectOrArray(fsRaw) &&
        !("type" in (fsRaw as Record<string, unknown>))
      ) {
        return {
          type: "application/json",
          content: fsRaw as Record<string, unknown>,
        };
      }

      const type = String(fsCell.key("type").get() ?? "text/markdown") as
        | "text/markdown"
        | "application/json";
      const content = fsCell.key("content").get();

      if (type === "text/markdown") {
        const contentStr = String(content ?? "");
        const fmCell = fsCell.key("frontmatter");
        const fmRaw = fmCell.get();
        const frontmatter: Record<string, unknown> = {};
        if (fmRaw && typeof fmRaw === "object" && !Array.isArray(fmRaw)) {
          for (const key of Object.keys(fmRaw as Record<string, unknown>)) {
            frontmatter[key] = fmCell.key(key).get() ?? null;
          }
        }
        return { type, content: contentStr, frontmatter };
      }

      if (type === "application/json") {
        const contentObj = content && typeof content === "object" &&
            !Array.isArray(content)
          ? content as Record<string, unknown>
          : {};
        return { type, content: contentObj };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Subscribes to `piece`'s input and result cells, so that a change rebuilds
   * the prop after a debounce; to its pattern identity and repository, so that
   * a hot swap refreshes the pattern metadata; and to its result's `$NAME`, so
   * that a rename moves the piece's directory. Returns the cancel functions.
   */
  async #subscribePiece(
    piece: PieceController,
    pieceIno: bigint,
    pieceName: string,
    spaceName: string,
    state: SpaceState,
  ): Promise<Cancel[]> {
    const cancels: Cancel[] = [];

    // Subscribe to input/result cell changes so the hydration cache is
    // invalidated when external mutations arrive (background recomputes,
    // remote writes, etc.). The invalidation is debounced: the reactive
    // graph may fire multiple intermediate updates before settling.
    const resolveLink = this.#makeLinkResolver(spaceName);
    for (const propName of ["input", "result"] as const) {
      try {
        const cell = await piece[propName].getCell();
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        const cancel = cell.sink((newValue: unknown) => {
          if (debounceTimer !== undefined) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            void (async () => {
              let rebuildValue = newValue;
              if (rebuildValue === undefined) {
                if (typeof cell.pull === "function") {
                  await cell.pull().catch(() => undefined);
                }
                rebuildValue = await piece[propName].get().catch(() =>
                  undefined
                );
              }
              if (rebuildValue === undefined) {
                return;
              }
              // Eagerly rebuild using the sink payload when available. Under
              // pull mode the sink can briefly report undefined before an
              // explicit pull materializes the latest result, so fall back to
              // the piece getter in that case. If the value is still
              // undefined, keep the current mounted tree intact until a
              // concrete replacement arrives.
              //
              // The rebuild reconciles onto the mounted tree in place, so the
              // tree is not torn down first; advancing the hydration epoch is
              // enough to make an in-flight hydration re-read the new value.
              this.#bumpHydrationEpoch(pieceIno, propName);
              await this.#enqueuePiecePropRebuild({
                cell,
                newValue: rebuildValue,
                pieceId: piece.id,
                pieceIno,
                pieceName: piece.name() || pieceName,
                propName,
                resolveLink,
                spaceName,
              });
            })().catch((e) => {
              console.error(
                `[${spaceName}] Error rebuilding ${pieceName}/${propName}: ${e}`,
              );
            });
          }, CellBridge.#PROP_REBUILD_DEBOUNCE_MS);
        });
        cancels.push(() => {
          cancel();
          if (debounceTimer !== undefined) {
            clearTimeout(debounceTimer);
            debounceTimer = undefined;
          }
        });
      } catch (e) {
        console.error(
          `[${spaceName}] Could not subscribe to ${pieceName}.${propName}: ${e}`,
        );
      }
    }

    // Pattern hot-swaps (system roll-forward, CLI setsrc, or FUSE source
    // edits) and repository annotation changes retain the same piece entity.
    // Keep the synthetic reference in meta.json and pieces.json aligned with
    // the currently running artifact and its source locator.
    const getRootCell = (piece as unknown as {
      getCell?: () => Cell<unknown>;
    }).getCell;
    if (typeof getRootCell === "function") {
      try {
        const rootCell = getRootCell.call(piece) as Cell<unknown> & {
          sinkMeta?: Cell<unknown>["sinkMeta"];
        };
        if (typeof rootCell.sinkMeta === "function") {
          for (
            const key of ["patternIdentity", "patternRepository"] as const
          ) {
            const cancelPatternRef = rootCell.sinkMeta(
              key,
              () => {
                void this.#refreshPiecePatternMetadata(
                  state,
                  piece,
                  pieceIno,
                ).catch((e) => {
                  console.error(
                    `[${spaceName}] Could not refresh ${pieceName} pattern reference: ${e}`,
                  );
                });
              },
            );
            cancels.push(cancelPatternRef);
          }
        }
      } catch (e) {
        console.error(
          `[${spaceName}] Could not subscribe to ${pieceName} pattern reference: ${e}`,
        );
      }
    }

    // Subscribe to the result cell to detect [NAME] changes and rename the
    // piece directory in the FUSE tree accordingly.
    // We use the result cell (not the root entity cell) because [NAME] is part
    // of the pattern's result output, and the scheduler tracks result cell
    // reads when setting up reactive subscriptions.
    try {
      const nameTrackingCell = await piece.result.getCell();
      const cancelRootSub = nameTrackingCell.sink((newValue: unknown) => {
        setTimeout(() => {
          try {
            // Use the state captured at subscription time, NOT
            // this.#spaces.get(): during the initial `#buildSpaceTree()` the
            // space isn't registered in this.#spaces yet, so a lookup would
            // silently drop every name event that fires while the tree is
            // being built (and a static piece may never fire again). Only bail
            // if the space has since been disconnected or replaced.
            const registered = this.#spaces.get(spaceName);
            if (registered !== undefined && registered !== state) return;

            // Find the piece's current FUSE name by searching pieceMap.
            let currentName: string | undefined;
            for (const [name, id] of state.pieceMap) {
              if (id === piece.id) {
                currentName = name;
                break;
              }
            }
            if (currentName === undefined) return;

            // Read $NAME from the sink value directly — piece.name() may
            // return a stale cached value that hasn't updated yet.
            const sinkName = isObjectOrArray(newValue)
              ? (newValue as Record<string, unknown>)["$NAME"]
              : undefined;
            const rawName = typeof sinkName === "string"
              ? sinkName
              : (piece.name() ?? piece.id);
            const normalizedRawName = resolveProjectedPieceName(
              rawName,
              piece.id,
            );

            this.#debugLog(
              `[${spaceName}] Rename check: current=${currentName} raw=${rawName} normalized=${normalizedRawName}`,
            );

            // Skip if the name hasn't changed.
            if (
              rawName === currentName ||
              normalizedRawName === currentName
            ) return;

            // Collision-resolve the new name. We need to exclude currentName
            // from the used-name check (the piece is vacating it), but we
            // must NOT mutate usedNames until after tree.rename() succeeds —
            // a thrown rename would otherwise leave tracking inconsistent.
            let newName = normalizedRawName;
            if (state.usedNames.has(newName) && newName !== currentName) {
              let suffix = 2;
              while (
                state.usedNames.has(`${newName}-${suffix}`) &&
                `${newName}-${suffix}` !== currentName
              ) suffix++;
              newName = `${newName}-${suffix}`;
            }

            // Skip if the resolved name is unchanged.
            if (newName === currentName) return;

            // Look up the controller and subs before mutating maps.
            const controller = state.pieceControllers.get(currentName);
            const subs = state.pieceSubs.get(currentName);

            // Rename the directory in the tree — do this before any map
            // mutations so a thrown error leaves state fully consistent.
            this.#tree.rename(
              state.piecesIno,
              currentName,
              state.piecesIno,
              newName,
            );

            // The tree rename succeeded; now update all four state maps
            // atomically.
            state.usedNames.delete(currentName);
            state.usedNames.add(newName);
            state.pieceMap.delete(currentName);
            state.pieceMap.set(newName, piece.id);
            const trackedPieceIno = state.pieceInos.get(currentName);
            state.pieceInos.delete(currentName);
            if (trackedPieceIno !== undefined) {
              state.pieceInos.set(newName, trackedPieceIno);
              const rootInfo = this.#pieceRoots.get(trackedPieceIno);
              if (rootInfo) {
                rootInfo.rootName = newName;
              }
            }
            state.pieceControllers.delete(currentName);
            if (controller !== undefined) {
              state.pieceControllers.set(newName, controller);
            }
            state.pieceSubs.delete(currentName);
            if (subs !== undefined) {
              state.pieceSubs.set(newName, subs);
            }
            const srcIno = state.srcInos.get(currentName);
            state.srcInos.delete(currentName);
            if (srcIno !== undefined) state.srcInos.set(newName, srcIno);
            const errorLogIno = state.srcErrorLogInos.get(currentName);
            state.srcErrorLogInos.delete(currentName);
            if (errorLogIno !== undefined) {
              state.srcErrorLogInos.set(newName, errorLogIno);
            }

            const renamedPieceIno = this.#tree.lookup(state.piecesIno, newName);
            if (renamedPieceIno !== undefined) {
              this.#updatePieceMetaName(renamedPieceIno, newName);
            }
            const entityIno = this.#tree.lookup(
              state.entitiesIno,
              encodeFuseComponent(piece.id),
            );
            if (entityIno !== undefined) {
              this.#updatePieceMetaName(entityIno, newName);
            }

            // Rebuild .index.json and pieces.json.
            this.#updateIndexJson(state);
            this.#updatePiecesJson(state);

            // Invalidate kernel cache.
            if (this.#onInvalidate) {
              this.#onInvalidate(state.piecesIno, [
                currentName,
                newName,
                ".index.json",
                "pieces.json",
              ]);
              this.#onInvalidate(state.spaceIno, ["pieces"]);
            }
            if (this.#onInvalidateInode) {
              this.#onInvalidateInode(state.piecesIno);
              if (renamedPieceIno !== undefined) {
                this.#onInvalidateInode(renamedPieceIno);
              }
            }

            this.#debugLog(
              `[${spaceName}] Renamed piece: ${currentName} → ${newName}`,
            );
          } catch (e) {
            console.error(
              `[${spaceName}] Error renaming piece in FUSE tree: ${e}`,
            );
          }
        }, CellBridge.#NEXT_MACROTASK_DELAY_MS);
      });
      cancels.push(cancelRootSub);
    } catch (e) {
      console.error(
        `[${spaceName}] Could not subscribe to root cell for ${pieceName}: ${e}`,
      );
    }

    return cancels;
  }

  /**
   * Creates a link resolver closure for a piece.
   *
   * Given a sigil link value and the current depth from the piece root, returns
   * a relative symlink target path:
   *
   * - Same-space with id: `"../".repeat(depth + 2)` then
   *   `entities/<hash>[/<path>]`.
   * - Cross-space: `"../".repeat(depth + 3)` then
   *   `<spaceName>/entities/<hash>[/<path>]`.
   * - Self-reference with no id: a relative path within the same piece.
   *
   * A value that is not a sigil link, or is a handler cell, yields `null`.
   */
  #makeLinkResolver(spaceName: string): ResolveLink {
    return (value: unknown, depth: number): string | null => {
      if (!isSigilLink(value)) return null;

      // Stream cells are rendered as .handler files, not symlinks.
      if (isHandlerCell(value)) return null;

      const rawLinkData: unknown = linkRefPayload(value);
      if (!isObjectNotArray(rawLinkData)) {
        return null;
      }
      const linkData = rawLinkData as {
        id?: unknown;
        path?: unknown;
        space?: unknown;
      };
      if (linkData.id !== undefined && typeof linkData.id !== "string") {
        return null;
      }
      if (
        linkData.space !== undefined && typeof linkData.space !== "string"
      ) {
        return null;
      }
      if (
        linkData.path !== undefined &&
        (!Array.isArray(linkData.path) ||
          !linkData.path.every((part) => typeof part === "string"))
      ) {
        return null;
      }

      const encodedPath = Array.isArray(linkData.path)
        ? encodeFusePathSegments(linkData.path as string[])
        : undefined;
      const pathSuffix = encodedPath?.length ? "/" + encodedPath.join("/") : "";

      if (!linkData.id) {
        // Self-reference: just the path relative to piece root
        return encodedPath?.length ? encodedPath.join("/") : null;
      }

      const entityHash = encodeFuseComponent(linkData.id);
      // depth is relative to the piece dir (input/ or result/ adds 1)
      // Up to the space dir: up from the current depth, past the piece name,
      // and past `pieces`.
      const upToSpace = "../".repeat(depth + 2);

      if (linkData.space && linkData.space !== spaceName) {
        // Cross-space: go up to mount root, then into other space
        return upToSpace + "../" + encodeFuseComponent(linkData.space) +
          "/entities/" + entityHash + pathSuffix;
      }

      // Same-space: go up to space dir, then into entities/
      return upToSpace + "entities/" + entityHash + pathSuffix;
    };
  }

  /**
   * Creates a piece's directory under `parentIno`, or fills in `existingIno` as
   * that directory, with its metadata file and unhydrated `input` and `result`
   * stubs, and returns its inode.
   */
  async #loadPieceTree(
    piece: PieceController,
    parentIno: bigint,
    name: string,
    spaceName: string,
    existingIno?: bigint,
    rootKind: "pieces" | "entities" = "pieces",
  ): Promise<bigint> {
    const pieceIno = existingIno ?? this.#tree.addDir(parentIno, name);

    // Create meta.json first so it's always present
    let patternRef: PiecePatternRef | undefined;
    try {
      patternRef = await piece.getPatternRef();
    } catch {
      // Pattern metadata is best-effort; keep the piece mount available.
    }
    const metaObject = {
      id: piece.id,
      entityId: piece.id,
      name: piece.name() || "",
      ...(patternRef === undefined ? {} : { patternRef }),
    };
    const pieceAnnotator = this.#makeCfcAnnotator({
      spaceName,
      pieceId: piece.id,
      rootKind,
      value: metaObject,
    });
    pieceAnnotator?.annotateJsonDirectory(pieceIno, [], {});
    pieceAnnotator?.annotateEntry(parentIno, name, pieceIno);

    // Clear existing meta.json if reusing a stub dir (avoids orphaned inode)
    const existingMetaIno = this.#tree.lookup(pieceIno, "meta.json");
    if (existingMetaIno !== undefined) this.#tree.clear(existingMetaIno);

    const metaIno = this.#tree.addFile(
      pieceIno,
      "meta.json",
      JSON.stringify(metaObject, null, 2),
      "object",
    );
    this.#annotateSyntheticNode(
      pieceAnnotator,
      metaIno,
      "piece-meta",
      ["meta.json"],
      { ino: pieceIno, name: "meta.json" },
    );
    this.#registerPieceRoot(pieceIno, {
      spaceName,
      rootKind,
      rootName: name,
      pieceId: piece.id,
      piece,
    });
    this.#ensurePiecePropStub(
      pieceIno,
      "input",
      this.#makeCfcAnnotator({
        spaceName,
        pieceId: piece.id,
        rootKind,
        cell: "input",
        value: {},
      }),
    );
    this.#ensurePiecePropStub(
      pieceIno,
      "result",
      this.#makeCfcAnnotator({
        spaceName,
        pieceId: piece.id,
        rootKind,
        cell: "result",
        value: {},
      }),
    );

    return pieceIno;
  }

  /**
   * Builds the `.src/` subtree for a piece, containing all of the pattern's
   * authored source files (recovered from the content-addressed
   * `pattern:<identity>` source-doc closure), plus a synthetic `error.log` when
   * no authored file claims that name. Skips system pieces that have no
   * recoverable source.
   */
  async #buildSourceTree(
    pieceIno: bigint,
    piece: PieceController,
    state: SpaceState,
    pieceName: string,
  ): Promise<void> {
    let sourceFiles: { name: string; contents: string }[] | undefined;
    try {
      sourceFiles = (await piece.getPatternSourceProgram())?.files;
    } catch {
      // Pattern source not always available
    }

    if (!sourceFiles?.length) {
      // System piece or no source — skip .src/
      return;
    }
    const files = sourceFiles;

    const annotator = this.#makeCfcAnnotator({
      spaceName: this.#spaceNameForState(state) ?? state.did,
      spaceDid: state.did,
      pieceId: piece.id,
      rootKind: "pieces",
      value: { files },
    });

    // Create or reuse .src/ dir. The synthetic error.log is minted below only
    // when no authored file claims that name, so the tracked inode is dropped
    // here rather than overwritten: a rebuild whose new source DOES claim the
    // name would otherwise leave the deleted synthetic inode in the map, and
    // a later write through it fails on an inode that is no longer a file.
    state.srcErrorLogInos.delete(pieceName);
    let srcIno = this.#tree.lookup(pieceIno, ".src");
    if (srcIno !== undefined) {
      this.#tree.clear(srcIno);
    }
    srcIno = this.#tree.addDir(pieceIno, ".src");
    annotator?.annotateJsonDirectory(srcIno, [".src"], {});
    annotator?.annotateEntry(pieceIno, ".src", srcIno, { labelPath: [".src"] });
    state.srcInos.set(pieceName, srcIno);

    // Add each source file at its relative path
    const enc = new TextEncoder();
    for (const file of files) {
      const relPath = file.name.startsWith("/")
        ? file.name.slice(1)
        : file.name;
      const parts = relPath.split("/");
      const encodedParts = encodeFusePathSegments(parts);
      let parentIno = srcIno;
      // Create intermediate directories
      for (let i = 0; i < parts.length - 1; i++) {
        const encodedPart = encodedParts[i];
        const existing = this.#tree.lookup(parentIno, encodedPart);
        if (existing !== undefined) {
          parentIno = existing;
        } else {
          const dirIno = this.#tree.addDir(parentIno, encodedPart);
          const dirPath = [".src", ...parts.slice(0, i + 1)];
          annotator?.annotateJsonDirectory(dirIno, dirPath, {});
          annotator?.annotateEntry(parentIno, encodedPart, dirIno, {
            labelPath: dirPath,
          });
          parentIno = dirIno;
        }
      }
      const fileName = encodedParts[encodedParts.length - 1];
      const sourceIno = this.#tree.addFile(
        parentIno,
        fileName,
        enc.encode(file.contents),
        "string",
      );
      const sourcePath = [".src", ...parts];
      this.#annotateSyntheticNode(
        annotator,
        sourceIno,
        "source",
        sourcePath,
        { ino: parentIno, name: fileName },
      );
    }

    // Add synthetic error.log only if no source file already claimed that name.
    // Track its inode so we can block writes to the synthetic file specifically
    // (a real source file named error.log must remain writable).
    if (this.#tree.lookup(srcIno, "error.log") === undefined) {
      const errorLogIno = this.#tree.addFile(srcIno, "error.log", "", "string");
      this.#annotateSyntheticNode(
        annotator,
        errorLogIno,
        "source",
        [".src", "error.log"],
        { ino: srcIno, name: "error.log" },
      );
      state.srcErrorLogInos.set(pieceName, errorLogIno);
    }
    this.#noteCfcProjectionRebuilt();
  }

  //
  // Static members
  //

  /**
   * How many times `#hydratePieceProp()` retries a hydration superseded
   * mid-flight.
   */
  static readonly #MAX_HYDRATION_RETRIES = 3;

  /**
   * Delay, in milliseconds, of a timer set only to yield: its callback runs in
   * a later macrotask, after the cell sink notification that set it has
   * returned.
   */
  static readonly #NEXT_MACROTASK_DELAY_MS = 0;

  /**
   * How long, in milliseconds, a piece's `input` or `result` cell must go
   * without a further change before the prop is rebuilt. The reactive graph may
   * report several intermediate values before it settles, and each one restarts
   * the wait.
   */
  static readonly #PROP_REBUILD_DEBOUNCE_MS = 150;

  /**
   * Delay, in milliseconds, before the first reconnect attempt after a
   * disconnect. Each failed attempt doubles it, up to
   * `#RECONNECT_MAX_DELAY_MS`.
   */
  static readonly #RECONNECT_BASE_DELAY_MS = 2000;

  /** Longest delay, in milliseconds, between two reconnect attempts. */
  static readonly #RECONNECT_MAX_DELAY_MS = 30_000;
}
