import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";

import { ValidationError } from "@cliffy/command";
import type { CellScope, JSONSchema } from "@commonfabric/api";
import {
  FabricPrimitive,
  hashStringOf,
  isFabricSpecialObject,
} from "@commonfabric/data-model";
import {
  codecOf,
  NULL_LIVE_ENVIRONMENT,
} from "@commonfabric/data-model/codec-common";
import { createSession, type Identity, Session } from "@commonfabric/identity";
import { isDID } from "@commonfabric/identity/did";
import { collectDataFileNames } from "@commonfabric/js-compiler";
import { TARGET } from "@commonfabric/js-compiler/typescript";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { setLLMUrl } from "@commonfabric/llm";
import {
  assignSlug,
  listSlugs,
  pieceId,
  type PieceReference,
  resolvePieceReference as resolveStoredPieceReference,
  resolveSlugTarget,
  resolveSlugTargetCell,
  setSlugLink,
  SlugAssignedError,
  SlugResolutionError,
} from "@commonfabric/piece";
import {
  assertPieceInputPath,
  type PatternCompatibilityReport,
  type PatternUpdateReceipt,
  PieceController,
  PieceInputPathError,
  type PiecePatternRef,
  PiecesController,
  type PieceSourceActionResult,
} from "@commonfabric/piece/ops";
import {
  Cell,
  type ConsoleHandler,
  decomposeSchema,
  deepEqual,
  encodeJsonPointer,
  entityIdFrom,
  experimentalOptionsForDeployedClient,
  formatFabricRef,
  getCellOrThrow,
  getMetaLink,
  getPatternIdentityRef,
  isCell,
  isCellResult,
  isReadableCell,
  isSlugAddress,
  lookupSchemaDocument,
  mapSubschemas,
  type MemorySpace,
  NAME,
  type NormalizedFullLink,
  parseExternalSchemaRef,
  recomposeSchema,
  resolveLink,
  resolveLinkTracingDereferences,
  Runtime,
  runtimePresets,
  RuntimeProgram,
  UI,
  VNode,
} from "@commonfabric/runner";
import {
  type CfcLabelView,
  cfcLabelViewForResolvedCellWithStatus,
  cfcLabelViewFromSchema,
  cfcSchemaResolvedRoot,
  cfcSchemaWithInheritedDefs,
  getCarriedCfcLabelView,
  type IFCLabel,
  mergeCfcLabelViews,
  pruneCfcSchemaDefinitions,
  redactCaveatSourcesForDisplay,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
  validateSchemaValue,
} from "@commonfabric/runner/cfc";
import { entityKindOfIdString } from "@commonfabric/runner/entity-kind";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import {
  isObjectNotArray,
  isObjectOrArray,
  isPlainObject,
} from "@commonfabric/utils/types";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { caseFold } from "unicode-case-folding";

import {
  isHandlerCell,
  isPatternToolSchema,
  isPatternToolValue,
} from "../../fuse/callables.ts";
import { executeCallableCommand } from "./callable-command.ts";
import {
  buildPieceDescription,
  type PieceDescription,
} from "./piece-describe.ts";
import {
  callableCommandSpec,
  type CallableExecutionDeps,
  type CallableResolution,
  type CallableResultRef,
  canonicalAddress,
  CF_RUNTIME_ERROR_LOG,
  type CliRuntimeErrorRecord,
  cloneWithoutBoundToolKeys,
  detectCallableKind,
  executeResolvedCallable,
  type InvocationOutcome,
  runtimeErrorLog,
  VerbInputValidationError,
} from "./callable.ts";
import {
  type CellSelection,
  CellSelectionError,
  deriveSelectedValue,
} from "./cell-selection.ts";
import { cliCommand } from "./cli-name.ts";
import {
  type ExecCommandSpec,
  type ParsedExecArgs,
  renderExecHelpJson,
  renderPieceCallHelp,
} from "./exec-schema.ts";
import { pinProgramFabricImports, renderPinRewrite } from "./fabric-deps.ts";
import { loadIdentity } from "./identity.ts";
import { stderrConsoleHandler } from "./json-output.ts";
import { validateEmbeddedSpaces } from "./llm-friendly-ref.ts";
import {
  instantiatePieceOnServer,
  setPieceSourceOnServer,
} from "./pattern-lifecycle.ts";
import { claimProcessDeployment } from "./process-deployment.ts";
import {
  deriveDiskHandleId,
  diskHandleSeed,
  type DiskHandleValue,
} from "./sqlite-source.ts";
import { timeCliPhase } from "./trace-timing.ts";
import { throwOnSpaceAuthorizationError } from "./utils.ts";
import { startVersionCheck } from "./version-check.ts";
import { noteWroteTo } from "./write-receipt.ts";

export interface EntryConfig {
  mainPath: string;
  mainExport?: string;
  repository?: string;
  rootPath?: string;

  /** Test entry paths whose resolved source closures travel with the piece. */
  testPaths?: string[];

  /** Data file paths stored with the piece and never compiled. */
  dataFilePaths?: string[];
}

export interface SpaceConfig {
  apiUrl: string;
  space: string;
  identity: string;
  jsonOutput?: boolean;

  /**
   * Whether opening the connection defers reading the space cell until an
   * operation addresses it. Defaults to `true`; pass `false` when the caller
   * requires the complete space record before `loadPieces()` returns.
   */
  deferSpaceCellSync?: boolean;

  /**
   * Space DIDs embedded in LLM-friendly references given to this command,
   * carried here when `space` is a name rather than a DID. A name only
   * resolves to a DID once the session opens, so `loadPieces` checks each
   * of these against the session's resolved space DID.
   */
  embeddedSpaces?: string[];
}

/** Metadata returned for a piece whose stored data matches a search query. */
export interface PieceSearchResult {
  id: string;
  reference: string;
  name?: string;
  patternRef?: PiecePatternRef;
}

export interface PieceConfig extends SpaceConfig {
  piece: string;
  pieceScope?: CellScope;

  /**
   * Path segments embedded in an LLM-friendly `--cell` reference. A command
   * that reads or writes at a path prepends these to its positional path
   * argument; a command whose intake is id-only rejects a reference that
   * carries them.
   */
  piecePath?: (string | number)[];

  /**
   * True when the target carried the `#argument` suffix: the caller selected
   * the piece's arguments cell. A command that takes `--input` honors it as
   * that flag; every other command rejects a target that carries it.
   */
  pieceInput?: boolean;
}

export interface SetPiecePatternOptions {
  dangerouslyAllowIncompatibleSchema?: boolean;
}

export interface GetCellValueOptions {
  input?: boolean;
  step?: boolean;
  selection?: CellSelection;
}

/** A declared CFC label update accepted by `cf cell set-label`. */
export type CellCfcLabelUpdate = IFCLabel & {
  observes?: LabelObservationClass;
};

type LabelObservationClass = NonNullable<
  CfcLabelView["entries"][number]["observes"]
>;

const CFC_LABEL_OBSERVATION_CLASSES = new Set<LabelObservationClass>([
  "value",
  "shape",
  "enumerate",
  "followRef",
]);

/**
 * Validate the JSON object accepted by `cf cell set-label`.
 *
 * The command exposes the two stored label families and their observation
 * class. Policy claims such as `requiredIntegrity` remain pattern-schema
 * authoring concerns rather than label metadata.
 */
export function parseCellCfcLabelUpdate(
  input: unknown,
): CellCfcLabelUpdate {
  if (!isPlainObject(input)) {
    throw new Error("CFC label input must be a JSON object.");
  }

  const supported = new Set(["confidentiality", "integrity", "observes"]);
  const unsupported = Object.keys(input).filter((key) => !supported.has(key));
  if (unsupported.length > 0) {
    throw new Error(
      `Unknown CFC label field${unsupported.length === 1 ? "" : "s"}: ` +
        unsupported.join(", ") +
        ". Expected confidentiality, integrity, or observes.",
    );
  }

  const confidentiality = input.confidentiality;
  const integrity = input.integrity;
  if (confidentiality === undefined && integrity === undefined) {
    throw new Error(
      "CFC label input must include confidentiality or integrity.",
    );
  }
  if (confidentiality !== undefined && !Array.isArray(confidentiality)) {
    throw new Error("CFC label confidentiality must be a JSON array.");
  }
  if (integrity !== undefined && !Array.isArray(integrity)) {
    throw new Error("CFC label integrity must be a JSON array.");
  }

  const observes = input.observes;
  if (
    observes !== undefined &&
    !CFC_LABEL_OBSERVATION_CLASSES.has(
      observes as LabelObservationClass,
    )
  ) {
    throw new Error(
      "CFC label observes must be value, shape, enumerate, or followRef.",
    );
  }

  return {
    ...(confidentiality !== undefined
      ? { confidentiality: [...confidentiality] }
      : {}),
    ...(integrity !== undefined ? { integrity: [...integrity] } : {}),
    ...(observes !== undefined
      ? { observes: observes as LabelObservationClass }
      : {}),
  } as CellCfcLabelUpdate;
}

/**
 * The label view both label commands answer from, read through the RESOLVED
 * reader — the doc the selected path lands in once its links are followed.
 *
 * Each command needs that doc for its own reason. An INSPECTION read must not
 * answer "none" for a value carrying a label behind a link the path crosses
 * part way through. A read that feeds a WRITE needs it because the write
 * resolves too: `applyCfcSchemaToExistingValue` follows the same links, so the
 * doc this view describes is the doc the update lands in.
 */
function cfcLabelViewForCommand(
  cell: unknown,
  path: readonly (string | number)[],
): CfcLabelView | null {
  const { view, readFailed } = cfcLabelViewForResolvedCellWithStatus(cell);
  if (readFailed) {
    const location = path.length === 0 ? "<root>" : path.join("/");
    throw new Error(`Could not read CFC labels at "${location}".`);
  }
  const schema = isObjectOrArray(cell)
    ? cell.schema as JSONSchema | undefined
    : undefined;
  const effectiveView = mergeCfcLabelViews([
    view,
    cfcLabelViewFromSchema(schema),
  ]);
  return effectiveView === undefined
    ? null
    : redactCaveatSourcesForDisplay(effectiveView);
}

/** A `cf cell get` path that lands ON a verb. Reading a verb returns the
 * stream's serialization — never what the caller wanted — so the read refuses
 * and redirects instead, mirroring the llm-dialog read tool's "Path resolves
 * to a handler; use invoke() instead." (verb contract WS-F, read-path guard).
 * `callable` is whether `cf piece call <verb>` actually resolves the verb —
 * the dispatcher resolves root-level names only — so the refusal never
 * suggests a command that would fail: a nested verb points at reading the
 * parent object or the root-level verbs listing instead. */
export class PieceVerbReadError extends Error {
  constructor(verb: string, piece: string, callable: boolean) {
    super(
      callable
        ? `Path resolves to a verb; use 'cf piece call --cell ${piece} ${verb}' instead.`
        : `Path resolves to a verb that is not directly callable: verbs are ` +
          `invoked at the piece's root surface. Read the parent object ` +
          `instead, or list the callable verbs with ` +
          `'cf piece verbs --cell ${piece}'.`,
    );
    this.name = "PieceVerbReadError";
  }
}

export class PieceResultProjectionError extends Error {
  constructor(path: readonly (string | number)[], stepped: boolean) {
    const location = path.length === 0 ? "<root>" : path.join("/");
    const stepHint = stepped
      ? " The piece was stepped, but the required value still did not " +
        "materialize."
      : " Use --step to start the piece and materialize session-scoped " +
        "computed values before reading.";
    super(
      `Cannot read piece result at "${location}": stored data is present, ` +
        `but its schema could not resolve all required values.${stepHint}`,
    );
    this.name = "PieceResultProjectionError";
  }
}

async function resultProjectionFailedAtPath(
  piece: {
    result: { getCell(): Promise<Cell<unknown>> };
  },
  path: readonly (string | number)[],
): Promise<boolean> {
  const rootCell = await piece.result.getCell();
  let targetCell = rootCell;
  for (const segment of path) {
    targetCell = targetCell.key(segment as keyof unknown) as Cell<unknown>;
  }
  const schema = targetCell.schema;
  if (targetCell.getRaw() === undefined || schema === undefined) {
    return false;
  }
  return validateSchemaValue(
    schema,
    undefined,
    rootCell.schema ?? schema,
  ) !== undefined;
}

/**
 * A resolved piece callable: the shared resolution plus the command spec its
 * flags and help page are built from.
 *
 * `declaredResult` (on {@link CallableResolution}) is attached here for a
 * handler exposed on the piece's result cell, which is the only place a
 * declared result can be matched from; a tool's result schema already rides
 * its callable cell and reaches `commandSpec` directly.
 */
export interface ResolvedPieceCallable extends CallableResolution {
  commandSpec: ExecCommandSpec;

  /**
   * This verb's documentation, resolved on demand — a thunk for the same
   * reason `declaredResult` is one, and attached under the same condition:
   * the pattern declaring the verb is the only document that carries it, and
   * reaching it costs a load no dispatch should pay.
   *
   * Only the help page pulls it. A dispatch needs nothing an author wrote.
   */
  declaredProse?: () => Promise<DeclaredVerbProse | undefined>;

  /**
   * The canonical address of the piece called, present when the target named
   * a path and the piece was reached through the link stored there. The
   * address the caller wrote names the holder of that link, so this is the
   * one that names what ran.
   */
  linkedPiece?: string;
}

export interface PieceCallableDependencies extends CallableExecutionDeps {
  helpCommandPrefix?: string;

  loadPieces?: (config: SpaceConfig) => Promise<any>;
  loadPiece?: (
    pieces: any,
    pieceId: string,
    scope?: PieceConfig["pieceScope"],
  ) => Promise<any>;
  readJsonInput?: () => Promise<unknown>;
  readTextInput?: () => Promise<string>;
  readTextFile?: (path: string) => Promise<string>;
  isStdinTerminal?: () => boolean;
}

export interface ExecutedPieceCallable {
  helpText?: string;
  outputText?: string;

  /** Handler invocation outcome, passed through from ExecutedCallable. */
  invocation?: InvocationOutcome;

  /** Tool result cell address, passed through from ExecutedCallable. */
  resultRef?: CallableResultRef;

  parsed: ParsedExecArgs;
  resolved: ResolvedPieceCallable;
}

export interface PieceResolutionDeps {
  loadPieces?: typeof loadPieces;

  /**
   * Resolves an address to a piece id. Injected, it stands in for
   * `resolvePieceReference` as well: the address names the piece, and the
   * path a command addresses stays a cell path inside it.
   */
  resolvePieceAddress?: (
    pieces: PiecesController,
    token: string,
  ) => Promise<string>;

  /**
   * Resolves an address and the path after it to a piece and the path left
   * inside it — the step a slug that names a collection resolves through.
   */
  resolvePieceReference?: (
    pieces: PiecesController,
    token: string,
    path: readonly (string | number)[],
  ) => Promise<PieceReference>;
}

interface PieceOperationDependencies extends PieceResolutionDeps {
  loadPieceForRead?: typeof loadPieceForRead;
  loadIdentity?: typeof loadIdentity;
  getProgramFromFile?: typeof getProgramFromFile;
  getPinnedProgramFromFile?: typeof getPinnedProgramFromFile;
  instantiatePieceOnServer?: typeof instantiatePieceOnServer;
  setPieceSourceOnServer?: typeof setPieceSourceOnServer;
  reportSearchError?: (
    pieceId: string,
    source: "input data" | "result data" | "metadata",
    error: unknown,
  ) => void;
  deriveSelectedValue?: typeof deriveSelectedValue;
}

interface DisposableRuntime {
  dispose(): Promise<unknown>;
  storageManager?: unknown;
}

function storageManagerCloseNow(
  storageManager: unknown,
): (() => Promise<unknown>) | undefined {
  if (
    isObjectOrArray(storageManager) &&
    "closeNow" in storageManager
  ) {
    const closeNow = Reflect.get(storageManager, "closeNow");
    if (typeof closeNow === "function") {
      return () => Promise.resolve(closeNow.call(storageManager));
    }
  }
  return undefined;
}

/**
 * Runs `run` over `runtime`, disposing the runtime where it failed and
 * returning what it returned otherwise.
 *
 * Both warnings go to `report`, which is `console.warn` where a caller names
 * none. A caller drawing its own screen supplies one: a line written behind
 * the frame corrupts the drawing, and these two are written from inside a
 * connect that such a caller is holding open.
 */
export async function withRuntimeCleanupOnFailure<T>(
  runtime: DisposableRuntime,
  run: () => Promise<T>,
  report: (message: string) => void = (message) => console.warn(message),
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const closeNow = storageManagerCloseNow(runtime.storageManager);
    if (closeNow) {
      await closeNow().catch((disposeError) => {
        report(
          `loadPieces storage cleanup failed: ${
            disposeError instanceof Error
              ? disposeError.message
              : String(disposeError)
          }`,
        );
      });
    }
    await runtime.dispose().catch(
      (disposeError) => {
        report(
          `loadPieces cleanup failed: ${
            disposeError instanceof Error
              ? disposeError.message
              : String(disposeError)
          }`,
        );
      },
    );
    throw error;
  }
}

async function makeSession(config: SpaceConfig): Promise<Session> {
  const identity = await loadIdentity(config.identity);
  if (isDID(config.space)) {
    return createSession({ identity, spaceDid: config.space });
  } else {
    return createSession({ identity, spaceName: config.space });
  }
}

/**
 * Where a connection sends what it writes while it is open, for a caller that
 * owns the screen it would otherwise be written on.
 *
 * A one-shot command owns its terminal for one invocation and is served by
 * the process's own streams, which is what both fields default to. A caller
 * drawing a frame — a shell holding a prompt, a full-screen view — is
 * corrupted by any line written behind it, so it takes these instead and
 * places what arrives.
 */
export interface ConnectionOutput {
  /**
   * Takes each line the connection writes for itself: the navigate callback's
   * three, and the two warnings a failed connect's own cleanup writes.
   */
  readonly report?: (message: string) => void;

  /**
   * Takes what a pattern running on this connection writes to its console.
   * Where a caller names none, the machine surface is protected under
   * `jsonOutput` and the process's console serves everything else.
   */
  readonly consoleHandler?: ConsoleHandler;
}

/**
 * Opens a connection to the deployment at `config.apiUrl` and returns the
 * controller over it: a space session, a runtime carrying that deployment's
 * experimental options, and a server proven live before it returns.
 *
 * By default the connection authenticates the space session but leaves the
 * space cell unread until an operation addresses it. Piece IDs, slug documents,
 * and content-addressed pattern artifacts can all be reached without that
 * record; registry and default-pattern operations sync the space cell on
 * demand. `deferSpaceCellSync: false` keeps the eager sync for a caller that
 * needs the complete space record before this returns.
 *
 * Throws when this process is already connected to a different deployment.
 * The settings a connection writes — the LLM endpoint below among them — are
 * the process's rather than the connection's, so a process serves one
 * deployment; `process-deployment.ts` carries what that costs.
 */
export async function loadPieces(
  config: SpaceConfig,
  output: ConnectionOutput = {},
): Promise<PiecesController> {
  claimProcessDeployment(config.apiUrl);
  setLLMUrl(config.apiUrl);
  // The navigate callback's designed line and its two failure reports both
  // go to the caller's sink where there is one, and keep the streams they
  // have where there is not: the designed line is prose except under
  // `jsonOutput`, which reserves stdout for the machine surface, and a
  // failure to write it is not prose at all.
  const navigateLine = output.report ??
    ((message: string) => {
      (config.jsonOutput ? console.error : console.log)(message);
    });
  const navigateFailure = output.report ??
    ((message: string) => console.error(message));
  const consoleHandler = output.consoleHandler ??
    (config.jsonOutput ? stderrConsoleHandler : undefined);
  // The deployment's own flag posture, with this process's explicit
  // EXPERIMENTAL_* still winning per flag: a cf binary is installed
  // independently of the server it talks to, so left to the environment alone
  // it drifts (docs/development/EXPERIMENTAL_OPTIONS.md). Fetched alongside
  // the session rather than before it — neither needs the other.
  const [session, experimental] = await Promise.all([
    timeCliPhase("loadPieces.makeSession", () => makeSession(config)),
    timeCliPhase(
      "loadPieces.serverExperimental",
      () =>
        experimentalOptionsForDeployedClient({
          apiUrl: new URL(config.apiUrl),
          env: Deno.env.get,
        }),
    ),
  ]);
  // A `--space` given as a name has only now resolved to a DID; this is the
  // deferred half of the embedded-space check `normalizeLLMFriendlyRef`
  // performs at parse time when the two spaces are written the same way. A
  // reference naming its space by name is held to the same derivation the
  // target space went through, so the two are compared as the one thing they
  // both stand for.
  await validateEmbeddedSpaces(config.embeddedSpaces, session);
  const runtimeErrors: CliRuntimeErrorRecord[] = [];
  const runtime = await timeCliPhase(
    "loadPieces.runtime",
    () =>
      // Shared first-party posture for client runtimes against a deployed
      // API (CT-1814); collectors and the navigate hook are this CLI's
      // declared deltas.
      new Runtime({
        ...runtimePresets.remoteClient({
          apiUrl: new URL(config.apiUrl),
          storageManager: StorageManager.open({
            as: session.as,
            memoryHost: new URL(config.apiUrl),
            spaceIdentity: session.spaceIdentity,
          }),
          experimental,
          errorHandlers: [
            (error) => {
              runtimeErrors.push({
                message: error.message,
                pieceId: error.pieceId,
                patternId: error.patternId,
                spellId: error.spellId,
                space: error.space,
                stackTrace: error.stack,
              });
            },
          ],
          navigateCallback: (target) => {
            try {
              const id = pieceId(target);
              if (!id) {
                navigateFailure("navigateTo: target missing piece id");
                return;
              }
              // Emit greppable line immediately so scripts can capture without waiting
              navigateLine(`navigateTo new piece id ${id}`);
            } catch (e) {
              navigateFailure(
                `navigateTo callback error: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            }
          },
        }),
        ...(consoleHandler === undefined ? {} : { consoleHandler }),
      }),
  );
  (runtime as Runtime & { [CF_RUNTIME_ERROR_LOG]?: CliRuntimeErrorRecord[] })[
    CF_RUNTIME_ERROR_LOG
  ] = runtimeErrors;

  return await withRuntimeCleanupOnFailure(runtime, async () => {
    // The server's commit rides the health response the check below already
    // fetches; only cf's own local resolution (baked metadata or git) runs
    // concurrently here, and finish() settles it on both paths so no
    // subprocess op outlives a thrown error.
    const versionCheck = startVersionCheck();
    const healthy = await timeCliPhase(
      "loadPieces.healthCheck",
      () => runtime.healthCheck(),
    );
    await versionCheck.finish(runtime.serverGitSha, config.apiUrl);
    if (!healthy) {
      throw new Error(`Could not connect to "${config.apiUrl.toString()}".`);
    }

    const deferSpaceCellSync = config.deferSpaceCellSync !== false;
    const pieces = await timeCliPhase(
      "loadPieces.controller",
      () =>
        new PiecesController(session, runtime, {
          deferSpaceCellSync,
        }),
    );
    if (deferSpaceCellSync) {
      await timeCliPhase(
        "loadPieces.ensureSpaceSession",
        () => pieces.ensureSpaceSession(),
      );
    } else {
      // `synced()` settles even when this space is permanently denied: the
      // memory client terminates a denied session rather than retrying its
      // reopen. It settles quietly, though — a denied cross-space link stays a
      // silent absent read — so surface a denial on THIS space deliberately,
      // with the server's real AuthorizationError.
      await timeCliPhase(
        "loadPieces.synced",
        () => pieces.synced(),
      );
    }
    throwOnSpaceAuthorizationError(runtime.storageManager, session.space);
    return pieces;
  }, output.report);
}

export function getProgramFromFile(
  pieces: PiecesController,
  entry: EntryConfig,
): Promise<RuntimeProgram> {
  return resolveLocalProgram(
    (resolver) => pieces.runtime.harness.resolve(resolver),
    {
      main: entry.mainPath,
      ...(entry.rootPath === undefined ? {} : { root: entry.rootPath }),
      ...(entry.testPaths === undefined ? {} : { testPaths: entry.testPaths }),
      ...(entry.dataFilePaths === undefined
        ? {}
        : { dataFilePaths: entry.dataFilePaths }),
      ...(entry.mainExport === undefined
        ? {}
        : { mainExport: entry.mainExport }),
    },
  );
}

async function getPinnedProgramFromFile(
  pieces: PiecesController,
  entry: EntryConfig,
): Promise<RuntimeProgram> {
  const program = await getProgramFromFile(pieces, entry);
  const result = await pinProgramFabricImports(
    pieces.runtime,
    pieces.getSpace(),
    program,
  );
  for (const rewrite of result.rewrites) {
    console.error(renderPinRewrite(rewrite));
  }
  return result.program;
}

// Returns an array of metadata about pieces to display.
export async function listPieces(
  config: SpaceConfig,
  deps: PieceOperationDependencies = {},
): Promise<
  (PieceSearchResult & { error?: string })[]
> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const registeredPieces = await pieces.getRegisteredPieces();
  return Promise.all(
    registeredPieces.map(async (piece) => {
      const reference = createLLMFriendlyLink(
        piece.getCell().getAsNormalizedFullLink(),
      );
      try {
        const owner = piece.pieces();
        const cell = await owner.getPieceCell(piece.getCell(), true);
        const livePiece = new PieceController(owner, cell);
        const name = (await (
          livePiece.getCell().key(NAME) as Cell<unknown>
        ).pull()) as string | undefined;
        const patternRef = await livePiece.getPatternRef();
        return {
          id: piece.id,
          reference,
          name,
          patternRef,
        };
      } catch (err) {
        return {
          id: piece.id,
          reference,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/** One `cf piece slugs` row: a name the space's slug index records, and
 * where it points — a piece, or with `path` a cell inside one, which is how a
 * collection's name is listed. A row carries `error` instead of `piece` when
 * the name points into no piece — a slug pointing at a plain document, or at
 * one that no longer loads, is still a name the space has, and a listing that
 * dropped it would misreport the namespace. */
export interface SlugSummary {
  slug: string;
  piece?: string;

  /**
   * The path inside `piece` the slug points at; absent when the slug names
   * the piece itself.
   */
  path?: string[];

  error?: string;
}

/** Every slug the space's index records, each resolved to the piece it points
 * into and the path inside it. The index bounds the listing: it names slugs
 * assigned since it existed, so an older slug still resolves but is not
 * listed — nothing can enumerate what it was never told the name of. */
export async function listSpaceSlugs(
  config: SpaceConfig,
  deps: PieceOperationDependencies = {},
): Promise<SlugSummary[]> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const slugs = await listSlugs(pieces);
  return Promise.all(
    slugs.map(async (slug) => {
      try {
        const { piece, pathInside } = await resolveSlugTarget(pieces, slug);
        return {
          slug,
          piece,
          ...(pathInside.length > 0 && { path: pathInside }),
        };
      } catch (err) {
        return {
          slug,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

const PIECE_SEARCH_CONCURRENCY = 4;
const NO_IGNORED_ROOT_KEYS = new Set<string>();
const RESULT_IGNORED_ROOT_KEYS = new Set([NAME]);
const SEARCH_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function foldSearchText(value: string): string {
  return caseFold(value.normalize("NFD")).normalize("NFD");
}

function foldedSearchTextContains(value: string, query: string): boolean {
  const foldedSegments: string[] = [];
  const boundaries = new Set<number>([0]);
  let foldedLength = 0;

  for (
    const { segment } of SEARCH_GRAPHEME_SEGMENTER.segment(
      value.normalize("NFC"),
    )
  ) {
    const foldedSegment = foldSearchText(segment);
    const segmentStart = foldedLength;
    foldedSegments.push(foldedSegment);
    foldedLength += foldedSegment.length;
    boundaries.add(foldedLength);

    const foldedCodePoints = Array.from(segment, foldSearchText);
    if (foldedCodePoints.join("") === foldedSegment) {
      let codePointBoundary = segmentStart;
      for (let index = 0; index < foldedCodePoints.length - 1; index++) {
        codePointBoundary += foldedCodePoints[index].length;
        boundaries.add(codePointBoundary);
      }
    }
  }

  const foldedValue = foldedSegments.join("");
  for (
    let match = foldedValue.indexOf(query);
    match !== -1;
    match = foldedValue.indexOf(query, match + 1)
  ) {
    if (boundaries.has(match) && boundaries.has(match + query.length)) {
      return true;
    }
  }
  return false;
}

function cellTraversalKey(cell: Cell<unknown>): string {
  const link = cell.getAsNormalizedFullLink();
  return hashStringOf({
    link,
    cfcLabelView: getCarriedCfcLabelView(cell),
  });
}

function cellDocumentTraversalKey(cell: Cell<unknown>): string {
  const { space, id, scope } = cell.getAsNormalizedFullLink();
  return hashStringOf({
    link: { space, id, scope, path: [] },
    cfcLabelView: getCarriedCfcLabelView(cell),
  });
}

function cellValueTraversalKey(cell: Cell<unknown>): string {
  const { space, id, scope, path } = cell.getAsNormalizedFullLink();
  return hashStringOf({
    link: { space, id, scope, path },
    cfcLabelView: getCarriedCfcLabelView(cell),
  });
}

/** Identify a piece's document independently of its selected fields or view labels. */
function pieceDocumentIdentity(cell: Cell<unknown>): string {
  const { space, id, scope } = cell.getAsNormalizedFullLink();
  return hashStringOf({ space, id, scope });
}

interface PieceOwnerCache {
  cells: Map<string, Promise<string | undefined>>;
  documents: Map<string, string | null>;
}

async function resolveRegisteredDocumentOwner(
  cell: Cell<unknown>,
  registeredPieceDocuments: ReadonlySet<string>,
  ownerCache: PieceOwnerCache,
): Promise<string | undefined> {
  let current = cell;
  const visited = new Set<string>();
  const traversed: string[] = [];

  const finish = (owner: string | undefined): string | undefined => {
    for (const key of traversed) {
      ownerCache.documents.set(key, owner ?? null);
    }
    return owner;
  };

  while (true) {
    const key = cellDocumentTraversalKey(current);
    if (visited.has(key)) {
      throw new Error(
        `Cycle found while resolving piece ownership for ${
          pieceId(cell) ?? "an unknown Cell"
        }`,
      );
    }
    if (ownerCache.documents.has(key)) {
      return finish(ownerCache.documents.get(key) ?? undefined);
    }
    visited.add(key);
    traversed.push(key);

    const currentId = pieceId(current);
    // Nested piece results can point to a parent result. Stop at the nearest
    // registered result before following its parent metadata.
    const currentDocument = pieceDocumentIdentity(current);
    if (registeredPieceDocuments.has(currentDocument)) {
      return finish(currentDocument);
    }

    await current.sync();
    const argumentLink = getMetaLink(current, "argument");
    if (
      currentId !== undefined &&
      (getPatternIdentityRef(current) !== undefined ||
        argumentLink !== undefined)
    ) {
      return finish(currentDocument);
    }
    const resultLink = getMetaLink(current, "result");
    if (resultLink === undefined) return finish(undefined);

    current = current.runtime.getCellFromLink(
      { ...resultLink, path: [], schema: undefined },
      undefined,
      current.tx,
      getCarriedCfcLabelView(current),
    );
  }
}

function registeredDocumentOwner(
  cell: Cell<unknown>,
  registeredPieceDocuments: ReadonlySet<string>,
  ownerCache: PieceOwnerCache,
): Promise<string | undefined> {
  const key = cellDocumentTraversalKey(cell);
  if (ownerCache.documents.has(key)) {
    return Promise.resolve(ownerCache.documents.get(key) ?? undefined);
  }
  return resolveRegisteredDocumentOwner(
    cell,
    registeredPieceDocuments,
    ownerCache,
  );
}

async function resolveRegisteredPieceOwner(
  cell: Cell<unknown>,
  registeredPieceDocuments: ReadonlySet<string>,
  ownerCache: PieceOwnerCache,
  cellIsMaterialized: boolean,
): Promise<string | undefined> {
  if (!cellIsMaterialized) await cell.sync();
  return registeredDocumentOwner(
    cell.resolveAsCell(),
    registeredPieceDocuments,
    ownerCache,
  );
}

function registeredPieceOwner(
  cell: Cell<unknown>,
  registeredPieceDocuments: ReadonlySet<string>,
  ownerCache: PieceOwnerCache,
  cellIsMaterialized: boolean,
): Promise<string | undefined> {
  const key = cellTraversalKey(cell);
  let owner = ownerCache.cells.get(key);
  if (owner === undefined) {
    owner = resolveRegisteredPieceOwner(
      cell,
      registeredPieceDocuments,
      ownerCache,
      cellIsMaterialized,
    );
    ownerCache.cells.set(key, owner);
  }
  return owner;
}

interface SearchOwnership {
  pieceDocument: string;
  registeredPieceDocuments: ReadonlySet<string>;
  ownerCache: PieceOwnerCache;
}

type SearchEntry =
  | { key: string }
  | {
    value: unknown;
    ownershipEstablished?: boolean;
    sourceCell?: Cell<unknown>;
    isRoot?: boolean;
  };

function* singleSearchEntry(
  value: unknown,
  ownershipEstablished = false,
  sourceCell?: Cell<unknown>,
  isRoot = false,
): IterableIterator<SearchEntry> {
  yield { value, ownershipEstablished, sourceCell, isRoot };
}

function* arraySearchEntries(
  value: unknown[],
  ignoredKeys: ReadonlySet<string>,
  sourceCell?: Cell<unknown>,
  reportReadError?: (error: unknown) => void,
): IterableIterator<SearchEntry> {
  for (const key in value) {
    try {
      if (!Object.hasOwn(value, key) || ignoredKeys.has(key)) continue;
      if (isArrayIndexPropertyName(key)) {
        const index = Number(key);
        const nested = value[index];
        yield { value: nested, sourceCell: sourceCell?.key(index) };
      } else {
        yield { key };
        const nested = (value as unknown as Record<string, unknown>)[key];
        yield { value: nested, sourceCell: sourceCell?.key(key) };
      }
    } catch (error) {
      reportReadError?.(error);
    }
  }
}

function* objectSearchEntries(
  value: object,
  ignoredKeys: ReadonlySet<string>,
  sourceCell?: Cell<unknown>,
  reportReadError?: (error: unknown) => void,
): IterableIterator<SearchEntry> {
  const record = value as Record<string, unknown>;
  for (const key in value) {
    try {
      if (!Object.hasOwn(value, key) || ignoredKeys.has(key)) continue;
      yield { key };
      const nested = record[key];
      yield { value: nested, sourceCell: sourceCell?.key(key) };
    } catch (error) {
      reportReadError?.(error);
    }
  }
}

async function searchTextMatches(
  rootCell: Cell<unknown>,
  query: string,
  ownership: SearchOwnership,
  ignoredRootKeys: ReadonlySet<string> = NO_IGNORED_ROOT_KEYS,
  reportReadError?: (error: unknown) => void,
): Promise<boolean> {
  if (isCell(rootCell)) {
    const owner = await registeredPieceOwner(
      rootCell,
      ownership.registeredPieceDocuments,
      ownership.ownerCache,
      false,
    );
    if (owner !== undefined && owner !== ownership.pieceDocument) return false;
  }

  const value = await rootCell.pull();
  const pending: Iterator<SearchEntry>[] = [
    singleSearchEntry(
      value,
      true,
      isCell(rootCell) ? rootCell : undefined,
      true,
    ),
  ];
  const seen = new WeakSet<object>();
  const seenCells = new Set<string>();

  while (pending.length > 0) {
    let next: IteratorResult<SearchEntry>;
    try {
      next = pending[pending.length - 1].next();
    } catch (error) {
      pending.pop();
      reportReadError?.(error);
      continue;
    }
    if (next.done) {
      pending.pop();
      continue;
    }

    if ("key" in next.value) {
      if (foldedSearchTextContains(next.value.key, query)) return true;
      continue;
    }
    const current = next.value.value;

    if (isObjectOrArray(current) && isCell(current)) {
      if (!isReadableCell(current)) continue;

      try {
        const cellKey = cellTraversalKey(current);
        if (seenCells.has(cellKey)) continue;
        seenCells.add(cellKey);

        if (!next.value.ownershipEstablished) {
          const owner = await registeredPieceOwner(
            current,
            ownership.registeredPieceDocuments,
            ownership.ownerCache,
            false,
          );
          if (owner !== undefined && owner !== ownership.pieceDocument) {
            continue;
          }
        }

        const nested = await current.pull();
        if (nested !== current) {
          pending.push(singleSearchEntry(nested, true, current));
        }
      } catch (error) {
        reportReadError?.(error);
      }
      continue;
    }

    let sourceCell = next.value.sourceCell;
    let ownershipEstablished = next.value.ownershipEstablished ?? false;
    if (sourceCell !== undefined && !ownershipEstablished) {
      try {
        const owner = await registeredPieceOwner(
          sourceCell,
          ownership.registeredPieceDocuments,
          ownership.ownerCache,
          true,
        );
        if (owner !== undefined && owner !== ownership.pieceDocument) continue;
        ownershipEstablished = true;
      } catch (error) {
        reportReadError?.(error);
        continue;
      }
    }

    if (!isObjectOrArray(current)) {
      if (
        typeof current !== "function" &&
        foldedSearchTextContains(String(current), query)
      ) {
        return true;
      }
      continue;
    }

    if (isCellResult(current)) {
      try {
        const backingCell = getCellOrThrow(current);
        const valueWasPulledFromBackingCell = sourceCell !== undefined &&
          cellValueTraversalKey(sourceCell) ===
            cellValueTraversalKey(backingCell);
        sourceCell = backingCell;
        if (!ownershipEstablished) {
          const owner = await registeredPieceOwner(
            sourceCell,
            ownership.registeredPieceDocuments,
            ownership.ownerCache,
            true,
          );
          if (owner !== undefined && owner !== ownership.pieceDocument) {
            continue;
          }
          ownershipEstablished = true;
        }

        if (!valueWasPulledFromBackingCell) {
          const cellKey = cellTraversalKey(sourceCell);
          if (seenCells.has(cellKey)) continue;
          seenCells.add(cellKey);

          const materializedCell = sourceCell.asSchema(true);
          const nested = await materializedCell.pull();
          pending.push(singleSearchEntry(
            nested,
            true,
            materializedCell,
            next.value.isRoot,
          ));
          continue;
        }
      } catch (error) {
        reportReadError?.(error);
        continue;
      }
    }

    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      pending.push(arraySearchEntries(
        current,
        next.value.isRoot ? ignoredRootKeys : NO_IGNORED_ROOT_KEYS,
        sourceCell,
        reportReadError,
      ));
      continue;
    }

    if (isFabricSpecialObject(current)) {
      // These representations exist to be searched as TEXT, and what a codec
      // produces is largely not that: a `FabricEpochNsec` encodes to a
      // base64url string, which matches nothing anyone would type. Nor are a
      // `FabricInstance`'s contents reached -- this stops at the object rather
      // than descending it, so a searchable value nested inside one is
      // invisible. `String(current)` is the only part here doing honest work.
      //
      // TODO(danfuzz): vet this branch for correctness once `data-model`
      // supports walking a `FabricInstance`, at which point its contents can
      // be searched as the values they are rather than as an encoded blob.
      const representations: SearchEntry[] = [];
      if (current.toString !== Object.prototype.toString) {
        try {
          representations.push({ value: String(current) });
        } catch (error) {
          reportReadError?.(error);
        }
      }
      try {
        // A `FabricPrimitive` binds no `[CODEC]`, and its per-format codec
        // would only yield the unsearchable text described above, so it
        // contributes nothing here. For anything else, a missing codec is a
        // real fault and `codecOf()` throws, which the `catch` reports.
        if (!(current instanceof FabricPrimitive)) {
          representations.push({
            value: codecOf(current).encode(current, NULL_LIVE_ENVIRONMENT),
          });
        }
      } catch (error) {
        reportReadError?.(error);
      }
      if (representations.length > 0) {
        pending.push(representations[Symbol.iterator]());
      }
      continue;
    }

    if (!isPlainObject(current)) continue;
    pending.push(objectSearchEntries(
      current,
      next.value.isRoot ? ignoredRootKeys : NO_IGNORED_ROOT_KEYS,
      sourceCell,
      reportReadError,
    ));
  }

  return false;
}

/**
 * Find pieces with a full Unicode case-insensitive substring in their input or
 * result data. Matches begin and end at canonically normalized code-point
 * boundaries. Object keys and scalar values are searched recursively. Piece
 * metadata is returned for matching pieces but does not participate in
 * matching.
 */
export async function searchPieces(
  config: SpaceConfig,
  query: string,
  deps: PieceOperationDependencies = {},
): Promise<PieceSearchResult[]> {
  if (query.length === 0) {
    throw new Error("Search query must not be empty.");
  }

  const normalizedQuery = foldSearchText(query);
  // TODO(@ianh): Add an API for clients to initiate server-side searches
  // against a server-hosted index.
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const registeredPieces = await pieces.getRegisteredPieces();
  const registeredPieceDocuments = new Set(
    registeredPieces.map((piece) => pieceDocumentIdentity(piece.getCell())),
  );
  const ownerCache: PieceOwnerCache = {
    cells: new Map(),
    documents: new Map(),
  };
  const matches: Array<PieceSearchResult | undefined> = new Array(
    registeredPieces.length,
  );
  const reportSearchError = deps.reportSearchError ??
    ((
      pieceId: string,
      source: "input data" | "result data" | "metadata",
      error: unknown,
    ) => {
      console.warn(
        `Warning: Could not read ${source} for piece ${pieceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  let nextPieceIndex = 0;

  const searchNextPiece = async (): Promise<void> => {
    while (nextPieceIndex < registeredPieces.length) {
      const index = nextPieceIndex++;
      const piece = registeredPieces[index];

      let inputMatches = false;
      try {
        const inputCell = await piece.input.getCell();
        inputMatches = await searchTextMatches(
          inputCell,
          normalizedQuery,
          {
            pieceDocument: pieceDocumentIdentity(piece.getCell()),
            registeredPieceDocuments,
            ownerCache,
          },
          NO_IGNORED_ROOT_KEYS,
          (error) => reportSearchError(piece.id, "input data", error),
        );
      } catch (error) {
        reportSearchError(piece.id, "input data", error);
      }

      let resultMatches = false;
      if (!inputMatches) {
        try {
          const resultCell = await piece.result.getCell();
          resultMatches = await searchTextMatches(
            resultCell,
            normalizedQuery,
            {
              pieceDocument: pieceDocumentIdentity(piece.getCell()),
              registeredPieceDocuments,
              ownerCache,
            },
            RESULT_IGNORED_ROOT_KEYS,
            (error) => reportSearchError(piece.id, "result data", error),
          );
        } catch (error) {
          reportSearchError(piece.id, "result data", error);
        }
      }

      if (inputMatches || resultMatches) {
        let name: string | undefined;
        try {
          name = piece.name();
        } catch (error) {
          reportSearchError(piece.id, "metadata", error);
        }
        let patternRef: PiecePatternRef | undefined;
        try {
          patternRef = await piece.getPatternRef();
        } catch (error) {
          reportSearchError(piece.id, "metadata", error);
        }
        matches[index] = {
          id: piece.id,
          reference: createLLMFriendlyLink(
            piece.getCell().getAsNormalizedFullLink(),
          ),
          name,
          patternRef,
        };
      }
    }
  };

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          PIECE_SEARCH_CONCURRENCY,
          registeredPieces.length,
        ),
      },
      searchNextPiece,
    ),
  );

  return matches.filter((piece): piece is PieceSearchResult =>
    piece !== undefined
  );
}

/**
 * The reference resolver a command's deps select: an injected
 * `resolvePieceReference` as it is; an injected `resolvePieceAddress` lifted
 * to one, so that it names the piece and the path stays a cell path inside
 * it; and the stored resolution otherwise.
 */
function pieceReferenceResolver(
  deps: PieceResolutionDeps,
): NonNullable<PieceResolutionDeps["resolvePieceReference"]> {
  if (deps.resolvePieceReference) return deps.resolvePieceReference;
  const resolveAddress = deps.resolvePieceAddress;
  if (resolveAddress) {
    return async (pieces, token, path) => ({
      piece: await resolveAddress(pieces, token),
      pathAfter: [...path],
    });
  }
  return resolveStoredPieceReference;
}

/**
 * A command's target once its address has resolved: the piece, and the cell
 * path inside it that the command addresses.
 */
interface ResolvedPieceTarget {
  /** The config, naming the piece by id and carrying no embedded path. */
  config: PieceConfig;

  /** The cell path inside the piece. */
  path: (string | number)[];
}

/**
 * Resolves the piece a config addresses and the cell path inside it, from
 * the address and `path` — the whole path the command addresses, the
 * reference's embedded segments followed by its positional ones. A slug that
 * names a collection spends the leading segments reaching the member, which
 * is why the path resolves with the address rather than after it. The config
 * returned carries no `piecePath`: the path returned is the whole of what is
 * left to address.
 */
async function resolvePieceTargetWithPieces(
  config: PieceConfig,
  path: readonly (string | number)[],
  pieces: PiecesController,
  deps: PieceResolutionDeps = {},
): Promise<ResolvedPieceTarget> {
  const resolved = await pieceReferenceResolver(deps)(
    pieces,
    config.piece,
    path,
  );
  const { piecePath: _embedded, ...rest } = config;
  return {
    config: {
      ...rest,
      piece: resolved.piece,
      // The stored link is the authority on which instance of an id a member
      // is, so a scope the walk reached it through stands over the one the
      // command was addressing under.
      ...(resolved.scope !== undefined && { pieceScope: resolved.scope }),
    },
    path: resolved.pathAfter,
  };
}

/**
 * Like {@link resolvePieceTargetWithPieces}, for a command whose intake is a
 * piece and nothing inside it: the reference's embedded path is what
 * resolves, and a segment left after the piece is refused.
 */
async function resolvePieceConfigWithPieces(
  config: PieceConfig,
  pieces: PiecesController,
  deps: PieceResolutionDeps = {},
): Promise<PieceConfig> {
  const target = await resolvePieceTargetWithPieces(
    config,
    config.piecePath ?? [],
    pieces,
    deps,
  );
  if (target.path.length > 0) {
    throw new ValidationError(pieceIdOnlyPathRefusal(target.path), {
      exitCode: 1,
    });
  }
  return target.config;
}

/**
 * The refusal for a path on a command that takes a piece and nothing inside
 * it. Raised at parse time for a handle, whose path can only be a cell path,
 * and after resolution for a slug, whose path a collection may have spent.
 */
export function pieceIdOnlyPathRefusal(
  path: readonly (string | number)[],
): string {
  return `The piece reference embeds a path ("${
    path.join("/")
  }") but this command takes a piece id only.`;
}

/**
 * The refusal a write meets when it names no path inside the piece it
 * reaches: a bare address must not replace a whole cell, and a caller that
 * means the root says so with an explicit empty path.
 */
export function pathRequiredRefusal(): string {
  return `A path is required: embed it in the address (/of:.../title) or ` +
    `pass it as an argument ("" writes the root).`;
}

export async function resolvePieceConfig(
  config: PieceConfig,
  deps: PieceResolutionDeps = {},
): Promise<PieceConfig> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  return await resolvePieceConfigWithPieces(config, pieces, deps);
}

/**
 * The config a command whose intake is a piece and nothing inside it should
 * act on: the piece the address reached, and the scope it was reached
 * through.
 *
 * Every such command resolves through here, because the refusal it owes a
 * caller cannot be raised at the parse: a slug's embedded path may be spent
 * selecting a member, and only the walk can tell that from a cell path the
 * command has no use for. A command that resolved the address on its own
 * would take the piece and drop the rest of what the walk reached.
 */
export async function resolveAddressedPieceConfig(
  pieces: PiecesController,
  config: PieceConfig,
  deps: PieceResolutionDeps = {},
): Promise<PieceConfig> {
  return await resolvePieceConfigWithPieces(config, pieces, deps);
}

/**
 * Resolves a link endpoint's address together with the path written after it,
 * as every address resolves: a slug naming a collection spends the first
 * segment on the member, and what is left is a cell path inside the piece the
 * endpoint reached.
 *
 * `options.allowMissingSlugFallback` keeps an id-shaped token that names no
 * slug document, so an endpoint may be a piece the space has not seen.
 */
export async function resolveLinkEndpointAddress(
  pieces: PiecesController,
  token: string,
  path: readonly (string | number)[],
  deps: PieceResolutionDeps = {},
  options?: { allowMissingSlugFallback?: boolean },
): Promise<PieceReference> {
  try {
    return await pieceReferenceResolver(deps)(pieces, token, path);
  } catch (error) {
    if (
      options?.allowMissingSlugFallback &&
      error instanceof SlugResolutionError &&
      error.code === "missing" &&
      // Only fall back for an id-shaped token (one with a scheme/colon, e.g.
      // `fid1:…`). A bare slug-shaped token that didn't resolve is genuinely
      // missing — surface the clean SlugResolutionError rather than letting a
      // non-hash string reach `entityIdFrom`.
      !isSlugAddress(token)
    ) {
      return { piece: token, pathAfter: [...path] };
    }
    throw error;
  }
}

/**
 * Whether the deployment this connection speaks to runs the serving loop,
 * in which case creating a piece is its to execute: the connection carries
 * the deployment's own flag posture
 * (docs/features/server-pattern-lifecycle.md).
 */
function servesLifecycleVerbs(pieces: PiecesController): boolean {
  return (pieces.runtime as Runtime | undefined)?.experimental
    .serverExecution === true;
}

async function lifecycleClient(
  config: SpaceConfig,
  deps: PieceOperationDependencies,
): Promise<{ apiUrl: URL; identity: Identity }> {
  return {
    apiUrl: new URL(config.apiUrl),
    identity: await (deps.loadIdentity ?? loadIdentity)(config.identity),
  };
}

/**
 * The served half of `newPiece`: the serving runtime compiles the program
 * and materializes the piece with its name and creation receipt in one
 * transaction, then awaits the default pattern's registration action.
 * This connection then starts
 * it the way it starts any piece it opens, running the graph as
 * speculation while the server derives on demand. The request is awaited
 * without a wall-clock bound: a creation the server is still committing
 * is not one to walk away from, since it lands whether or not this
 * process waits. `boundStart` is the bound the local start runs under.
 */
async function createOnServer(
  config: SpaceConfig,
  pieces: PiecesController,
  program: RuntimeProgram,
  entry: EntryConfig,
  options: {
    start?: boolean;
    slug?: string;
    force?: boolean;
    requestKey?: string;
  } | undefined,
  deps: PieceOperationDependencies,
  boundStart: <T>(start: Promise<T>) => Promise<T>,
): Promise<{ id: string; getCell: () => Cell<unknown> }> {
  const requestKey = options?.requestKey ?? crypto.randomUUID();
  const receipt = await (async () => {
    try {
      return await (deps.instantiatePieceOnServer ??
        instantiatePieceOnServer)(await lifecycleClient(config, deps), {
          space: pieces.getSpace(),
          requestKey,
          program,
          ...(entry.repository === undefined
            ? {}
            : { repository: entry.repository }),
          ...(options?.slug === undefined ? {} : { slug: options.slug }),
          ...(options?.force === undefined ? {} : { force: options.force }),
          register: true,
          ...(options?.start === false ? { start: false } : {}),
        });
    } catch (error) {
      throw new Error(
        `Piece creation outcome may be incomplete. Retry the same command ` +
          `with --request-key ${requestKey}. ` +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
  })();
  if (receipt.registration?.status !== "handled") {
    throw new Error(
      `Piece ${receipt.pieceId} was created but registration is ` +
        `${receipt.registration?.status ?? "unconfirmed"}. ` +
        `Retry the same command with --request-key ${requestKey}. ` +
        (receipt.registration?.error ?? ""),
    );
  }
  const cell = await pieces.getPieceCell(receipt.pieceId, false);
  if (options?.start !== false) await boundStart(pieces.startPiece(cell));
  return { id: receipt.pieceId, getCell: () => cell };
}

/**
 * Creates a new piece from source code and optional input.
 *
 * A `slug` that already points somewhere is refused the way `set-slug`
 * refuses one, and `force` takes it. Against a serving deployment the name
 * rides the creation transaction, so the refusal leaves nothing behind.
 * Otherwise the refusal arrives after the piece exists, so it names the
 * piece as well as the flag: an operator who meant to repoint has an id to
 * name, and one who did not has a piece to find.
 */
export async function newPiece(
  config: SpaceConfig,
  entry: EntryConfig,
  options?: {
    start?: boolean;
    slug?: string;
    force?: boolean;
    requestKey?: string;
  },
  deps: PieceOperationDependencies = {},
): Promise<string> {
  const pieces = await timeCliPhase(
    "newPiece.loadPieces",
    () => (deps.loadPieces ?? loadPieces)(config),
  );

  // Against a serving deployment the space root is the serving loop's to
  // ensure — it does so on activation, ahead of the verb this command sends
  // — and a served creation that finds no root refuses with `no-space-root`.
  // Otherwise registration through `pieces.add()` requires an existing
  // default pattern and fails before sending if none exists. Ensuring it
  // creates an absent root and reconciles and repairs an existing one; fail
  // here with the cause if initialization fails.
  const served = servesLifecycleVerbs(pieces);
  try {
    if (!served) {
      await timeCliPhase(
        "newPiece.ensureDefaultPattern",
        () => pieces.ensureDefaultPattern(),
      );
    }
  } catch (error) {
    throw new Error(
      `Could not initialize the space's default pattern: ${
        error instanceof Error ? error.message : String(error)
      }\n` +
        `The new piece cannot be registered in the space's piece list ` +
        `without it.\n` +
        `If this space's root pattern predates a runtime format change, ` +
        `repair it with: ${cliCommand(["space", "recreate-root"])}`,
      { cause: error },
    );
  }

  const program = await timeCliPhase(
    "newPiece.getProgramFromFile",
    () =>
      (deps.getPinnedProgramFromFile ?? getPinnedProgramFromFile)(
        pieces,
        entry,
      ),
  );
  // A piece whose pattern never settles leaves `pieces.create` awaiting a
  // scheduler `idle()` that never resolves, and the runtime surfaces no
  // event that a start has definitively failed (a thrown pattern reports its
  // error and still resolves; a stuck async load reports nothing). This
  // wall-clock bound is the only thing that turns that hang into a message.
  // When it fires, report the actual runtime error the pattern recorded while
  // starting rather than only pointing at the server logs.
  const PIECE_START_TIMEOUT_MS = 60_000;
  const runtimeErrors = runtimeErrorLog(pieces.runtime);
  const errorCountBefore = runtimeErrors.length;
  const boundStart = <T>(starting: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const recorded = runtimeErrors.slice(errorCountBefore).at(-1)?.message;
        const detail = recorded !== undefined
          ? `A runtime error was reported while it started: ${recorded}`
          : `Check toolshed logs for runtime errors.`;
        reject(
          new Error(
            `Piece created but failed to start within ${
              PIECE_START_TIMEOUT_MS / 1000
            }s. ${detail}`,
          ),
        );
      }, PIECE_START_TIMEOUT_MS);
    });
    return Promise.race([starting, timeout]).finally(() => clearTimeout(timer));
  };
  const piece = await timeCliPhase(
    "newPiece.create",
    () =>
      served
        ? createOnServer(
          config,
          pieces,
          program,
          entry,
          options,
          deps,
          boundStart,
        )
        : boundStart(pieces.create(program, {
          repository: entry.repository,
          start: options?.start,
        })),
  );
  // Here rather than after the registry add below: the piece now exists in
  // the space, and a slug or registry step that throws afterwards leaves a
  // partial write that the operator is owed the location of.
  noteWroteTo(config.space);
  // Served creation returns after both setup and registration commit.
  if (served) return piece.id;

  if (options?.slug) {
    try {
      await timeCliPhase(
        "newPiece.assignSlug",
        () =>
          assignSlug(pieces, piece.getCell(), options.slug!, {
            force: options.force,
          }),
      );
    } catch (error) {
      if (error instanceof SlugAssignedError) {
        throw new SlugAssignedError(
          error.slug,
          error.target,
          `Pass \`--force\` to take it anyway. The piece was created as ` +
            `${piece.id} and carries no name.`,
        );
      }
      throw error;
    }
  }

  // Explicitly add the piece to the space's registry.
  await timeCliPhase(
    "newPiece.addToDefaultPattern",
    () => pieces.add([piece.getCell()]),
  );

  return piece.id;
}

/**
 * Points `slug` at the cell an address and the path after it name.
 *
 * A name already pointing somewhere is refused, naming what it points at, so
 * that a slug someone opens is never taken by accident; `force` takes it. The
 * refusal names the flag, because the remedy is the CLI's rather than the
 * library's.
 */
export async function setPieceSlug(
  config: SpaceConfig,
  slug: string,
  sourcePieceId: string,
  sourcePath: (string | number)[],
  options?: {
    sourceScope?: PieceConfig["pieceScope"];
    resolveBeforeLinking?: boolean;
    force?: boolean;
  },
  deps: PieceResolutionDeps = {},
): Promise<void> {
  const pieces = await timeCliPhase(
    "setPieceSlug.loadPieces",
    () => (deps.loadPieces ?? loadPieces)(config),
  );
  const source = await resolveSlugSourceCell(
    pieces,
    sourcePieceId,
    sourcePath,
    options?.sourceScope,
    deps,
  );
  await timeCliPhase("setPieceSlug.source.sync", () => source.sync());
  try {
    await timeCliPhase(
      "setPieceSlug.setSlugLink",
      () =>
        setSlugLink(pieces, slug, source, {
          resolveBeforeLinking: options?.resolveBeforeLinking,
          writeTargetMetadata:
            source.getAsNormalizedFullLink().path.length === 0,
          force: options?.force,
        }),
    );
  } catch (error) {
    // Rethrown rather than wrapped: the name being taken is a fact about the
    // space rather than a mistake in the line, and the same class carries it
    // to the top level, where it prints its message and no usage page.
    if (error instanceof SlugAssignedError) {
      throw new SlugAssignedError(
        error.slug,
        error.target,
        `Pass \`--force\` to take it anyway; that target is what to point ` +
          `it back at afterwards.`,
      );
    }
    throw error;
  }
  noteWroteTo(config.space);
}

/**
 * Helper for `setPieceSlug()`, which reads the cell a slug's source names.
 *
 * A handle names a piece, and the path after it a cell inside that piece. A
 * slug with a path after it resolves the way every address does, so `/top/2`
 * is the member piece and `/top/2/title` a cell inside it. A bare slug is the
 * cell it points at, piece or not: naming one slug's target by another is an
 * alias, and an alias of a collection's name needs no piece behind it. That
 * one target is the slug's own redirect, which names its own scope, so a
 * scope written beside a bare slug is refused rather than dropped.
 */
async function resolveSlugSourceCell(
  pieces: PiecesController,
  sourcePieceId: string,
  sourcePath: (string | number)[],
  sourceScope: PieceConfig["pieceScope"],
  deps: PieceResolutionDeps,
): Promise<Cell<unknown>> {
  if (isSlugAddress(sourcePieceId) && sourcePath.length === 0) {
    if (sourceScope !== undefined) {
      throw new ValidationError(
        `Slug "${sourcePieceId}" points at a cell whose own redirect names ` +
          `its scope, so \`@${sourceScope}\` has nothing to apply to. Name ` +
          `the cell itself to scope it.`,
        { exitCode: 1 },
      );
    }
    return await timeCliPhase(
      "setPieceSlug.resolveSource",
      () => resolveSlugTargetCell(pieces, sourcePieceId),
    );
  }
  const { piece, pathAfter: path, scope } = await timeCliPhase(
    "setPieceSlug.resolveSource",
    () => pieceReferenceResolver(deps)(pieces, sourcePieceId, sourcePath),
  );
  // A member reached through a narrowed link is that instance, so the cell
  // the slug is pointed at is read at the scope the walk reached, not the one
  // the command was addressing under.
  const resolvedScope = scope ?? sourceScope;
  if (path.length === 0) {
    return pieces.runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(piece),
      [],
      undefined,
      undefined,
      resolvedScope,
    );
  }
  const holder = await timeCliPhase(
    "setPieceSlug.getSourcePiece",
    () => pieces.get(piece, false, undefined, resolvedScope),
  );
  return holder.getCell().key(...path);
}

/**
 * The served half of `setPiecePattern`: the serving runtime replaces the
 * source and commits the update, and this connection then refreshes the
 * piece it holds the way a client-side update does after its own commit —
 * starting it, which under the flag runs the graph as speculation while
 * the serving loop serves the derived values — and reports that outcome in
 * the receipt's `refresh`, since the commit is durable whatever the refresh
 * did.
 */
async function updateOnServer(
  config: PieceConfig,
  pieces: PiecesController,
  pieceId: string,
  program: RuntimeProgram,
  entry: EntryConfig,
  options: SetPiecePatternOptions,
  deps: PieceOperationDependencies,
): Promise<PatternUpdateReceipt> {
  const receipt = await (deps.setPieceSourceOnServer ??
    setPieceSourceOnServer)(await lifecycleClient(config, deps), {
      space: pieces.getSpace(),
      piece: pieceId,
      program,
      ...(entry.repository === undefined
        ? {}
        : { repository: entry.repository }),
      ...(options.dangerouslyAllowIncompatibleSchema
        ? { dangerouslyAllowIncompatibleSchema: true }
        : {}),
    });
  noteWroteTo(config.space);
  let refresh: PatternUpdateReceipt["refresh"];
  try {
    const cell = await pieces.getPieceCell(receipt.pieceId, false);
    await pieces.startPiece(cell);
    refresh = { status: "completed" };
  } catch (error) {
    refresh = {
      status: "failed",
      warning: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    status: "committed",
    ref: receipt.pattern,
    space: pieces.getSpace(),
    seq: receipt.seq,
    revisionId: receipt.revisionId,
    detachedOrigin: receipt.detachedOrigin,
    refresh,
  };
}

/**
 * Points a piece at `origin` and adopts what that origin currently serves,
 * in one source transition (`repoint`). From then on the piece follows the
 * origin: opening it adopts each later release the origin ships.
 *
 * This is how a piece created detached — a profile made before the runtime
 * claimed origins for children of system pieces, say — is put on the
 * lifecycle a release reaches. Unlike `setsrc`, which detaches, the origin
 * is recorded with the revision. The transition carries the same writer
 * delegation a `setsrc` does, since it is the owner's explicit act.
 *
 * @throws Error when the deployment serves piece lifecycle verbs (the served
 * update takes no origin), when the piece cannot be resolved, or when the
 * origin cannot be read or does not compile.
 */
export async function followPieceSource(
  config: PieceConfig,
  origin: string,
  deps: PieceOperationDependencies = {},
): Promise<PieceSourceActionResult> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  // Against a serving deployment a source transition is the serving
  // runtime's to commit, and the served update verb carries no origin yet;
  // a client-side repoint there would commit outside the served lifecycle.
  if (servesLifecycleVerbs(pieces)) {
    throw new Error(
      "This deployment serves piece lifecycle verbs, and `follow` is not " +
        "served yet; the served update takes no origin.",
    );
  }
  const resolvedConfig = await resolvePieceConfigWithPieces(
    config,
    pieces,
    deps,
  );
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  const result = await piece.changeSource({ kind: "repoint", url: origin });
  if (result.status === "applied") noteWroteTo(config.space);
  return result;
}

/**
 * Replaces the piece's source and returns its setup transaction receipt.
 * Against a serving deployment the update is the serving runtime's to
 * commit; a piece addressed at a scope keeps the client-side path, since
 * the served verb takes the piece's id alone.
 */
export async function setPiecePattern(
  config: PieceConfig,
  entry: EntryConfig,
  options: SetPiecePatternOptions = {},
  deps: PieceOperationDependencies = {},
): Promise<PatternUpdateReceipt> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(
    config,
    pieces,
    deps,
  );
  const program = await (deps.getPinnedProgramFromFile ??
    getPinnedProgramFromFile)(pieces, entry);
  if (
    servesLifecycleVerbs(pieces) && resolvedConfig.pieceScope === undefined
  ) {
    return await updateOnServer(
      config,
      pieces,
      resolvedConfig.piece,
      program,
      entry,
      options,
      deps,
    );
  }
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  const receipt = await piece.setPattern(program, {
    repository: entry.repository,
    ...(options.dangerouslyAllowIncompatibleSchema
      ? { dangerouslyAllowIncompatibleSchema: true }
      : {}),
  });
  noteWroteTo(config.space);
  return receipt;
}

/**
 * Would `setPiecePattern` be accepted for this piece? Applies nothing.
 *
 * Same shape as `setPiecePattern` up to the point of the swap, so the verdict
 * is about the source the user would actually apply — including its resolved
 * imports and pinned program — rather than an approximation of it.
 */
export async function checkPiecePattern(
  config: PieceConfig,
  entry: EntryConfig,
  deps: PieceOperationDependencies = {},
): Promise<PatternCompatibilityReport> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(
    config,
    pieces,
    deps,
  );
  const program = await (deps.getPinnedProgramFromFile ??
    getPinnedProgramFromFile)(pieces, entry);
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  return await piece.checkPattern(program);
}

export async function savePiecePattern(
  config: PieceConfig,
  outPath: string,
): Promise<void> {
  await ensureDir(outPath);
  const pieces = await loadPieces(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(config, pieces);
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  const program = await piece.getPatternSourceProgram();
  if (!program) {
    throw new Error(
      `Piece "${resolvedConfig.piece}" does not contain a pattern source.`,
    );
  }
  await writeSourcePackage(program, outPath);
  const warning = undeclaredDataFileWarning(program);
  if (warning !== undefined) console.log(warning);
}

/**
 * Write a recovered source package under `outPath`, laid out by the names the
 * package stores its files under.
 *
 * Those names are grounded — rooted at the program root rather than at any
 * directory on this machine — so the layout a piece was built from is the
 * layout it comes back to, and a `setsrc` from here resolves the same imports
 * and the same data files. A name that is not grounded belongs to no layout
 * and is refused rather than written somewhere arbitrary.
 */
export async function writeSourcePackage(
  program: RuntimeProgram,
  outPath: string,
): Promise<void> {
  for (const { name, contents } of program.files) {
    if (name[0] !== "/") {
      throw new Error("Ungrounded file in pattern.");
    }
    const outFilePath = join(outPath, name.substring(1));
    await Deno.mkdir(dirname(outFilePath), { recursive: true });
    await Deno.writeTextFile(outFilePath, contents);
  }
}

/**
 * The data files a later `setsrc` would have to be told about.
 *
 * A file the recovered source reads by name is declared, so rebuilding the
 * package from this directory attaches it again on its own. A file the source
 * cannot name — one read by a computed path, or one that ships with a pattern
 * that does not read it — is on disk with nothing recording that it was data,
 * and would come back as an ordinary file nobody stores. Naming those is what
 * keeps the round trip whole.
 */
export function undeclaredDataFiles(program: RuntimeProgram): string[] {
  // A data file is never parsed. One already attached sits in `files` like any
  // other entry, and its bytes may happen to read as a `dataFile()` call.
  const attached = new Set(program.dataFiles ?? []);
  const declared = new Set(
    program.files.filter((file) => !attached.has(file.name))
      .flatMap((file) => collectDataFileNames(file, TARGET)),
  );
  return [...attached].filter((name) => !declared.has(name));
}

/**
 * What `getsrc` says about the data files it just wrote, or undefined when it
 * has nothing to say. The flags are spelled out so that reproducing the
 * revision is a matter of copying the line rather than working out which of
 * the written files were data.
 */
export function undeclaredDataFileWarning(
  program: RuntimeProgram,
): string | undefined {
  const undeclared = undeclaredDataFiles(program);
  if (undeclared.length === 0) return undefined;
  return `\nThis pattern carries ${undeclared.length} data file(s) its ` +
    `source does not name.\nPass them on the next setsrc, or they are ` +
    `dropped from that revision:\n` +
    undeclared.map((name) => `  --datafile .${name}`).join("\n");
}

export async function applyPieceInput(config: PieceConfig, input: object) {
  const pieces = await loadPieces(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(config, pieces);
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  await piece.setInput(input);
  noteWroteTo(config.space);
}

async function tryResolvePieceCallableAt(
  piece: any,
  pieces: any,
  space: MemorySpace,
  callableName: string,
  cellProp: "input" | "result",
): Promise<ResolvedPieceCallable | null> {
  const rootCell = await piece[cellProp].getCell();
  const callableCell = rootCell.key(callableName).asSchemaFromLinks();
  // Classified from the name's own cell. `detectCallableKind` reads that cell
  // for the stored signal itself, so it needs no value alongside it: the only
  // way to supply one is to project the whole root and pluck one property out
  // of it, which costs a full materialization to learn what the cell already
  // answers.
  const callableKind = detectCallableKind(undefined, callableCell);
  if (!callableKind) {
    return null;
  }

  return {
    callableCell,
    callableKind,
    cellKey: callableName,
    commandSpec: callableCommandSpec(callableCell, callableKind),
    pieces,
    space,
  };
}

/**
 * Helper for `tryResolvePieceHandler()`, which casts `name` to a stream when
 * its stored schema has lost the stream marker. Returns the cast cell, or
 * `null` when the cell cannot be cast. The cast establishes no evidence of a
 * handler: `resolvePieceCallable()` checks the pattern's vocabulary first
 * when that metadata is available.
 */
function probeForcedStreamCell(cell: any, name: string): any | null {
  if (
    !isObjectOrArray(cell) ||
    typeof cell.asSchema !== "function"
  ) {
    return null;
  }
  // For inline values, the cast's stream schema survives link resolution,
  // so isStream() can answer true solely from the caller's assertion.
  const streamRoot = cell.asSchema({
    type: "object",
    properties: {
      [name]: { asCell: ["stream"] },
    },
    required: [name],
  });
  const streamCell = streamRoot.key(name);
  return isHandlerCell(streamCell) ? streamCell : null;
}

async function tryResolvePieceHandler(
  piece: any,
  pieces: any,
  space: MemorySpace,
  callableName: string,
): Promise<ResolvedPieceCallable | null> {
  const pieceCell = piece.getCell?.();
  if (!pieceCell) {
    return null;
  }

  const streamCell = probeForcedStreamCell(pieceCell, callableName);
  if (!streamCell) {
    return null;
  }

  // Dispatch through the cell whose stream-ness this path just proved, not a
  // second cell built by reading the schema back from links. Both address the
  // same target — `getResult` is the identity on the piece cell — so they
  // differ only in schema, and a link-derived schema is exactly what defeated
  // the ordinary detection paths above. Sending on that cell takes `.set()`'s
  // non-stream branch (`packages/runner/src/cell.ts:1316`) and fails with
  // "Transaction required for .set()" instead of queueing the event, so a verb
  // this path lists is a verb that could not be called.
  const rootCell = await piece.result.getCell();
  const linkDerivedCell = rootCell.key(callableName).asSchemaFromLinks();
  return {
    callableCell: streamCell,
    callableKind: "handler",
    cellKey: callableName,
    // The link-derived cell still carries whatever payload schema the piece
    // does publish, which the forced stream cast does not: the command spec
    // reads it for `--help`, and `inputSchema` hands it to the pre-dispatch
    // gate — the cast's own schema admits any payload, so gating on it would
    // dispatch a malformed payload and spend the invocation id.
    commandSpec: callableCommandSpec(linkDerivedCell, "handler"),
    inputSchema: linkDerivedCell.schema,
    pieces,
    space,
  };
}

async function tryResolveLivePieceToolCallable(
  piece: any,
  pieces: any,
  space: MemorySpace,
  callableName: string,
  pieceScope?: PieceConfig["pieceScope"],
): Promise<any | null> {
  if (
    typeof piece.getPattern !== "function" ||
    typeof piece.input?.get !== "function"
  ) {
    return null;
  }

  const pattern = await piece.getPattern();
  const input = await piece.input.get();
  const tx = pieces.runtime.edit();
  const liveResult = pieces.runtime.getCell(
    space,
    crypto.randomUUID(),
    pattern?.resultSchema,
    tx,
    pieceScope,
  );
  pieces.runtime.run(tx, pattern, input, liveResult);
  pieces.runtime.prepareTxForCommit?.(tx);
  await tx.commit();
  await pieces.runtime.idle();

  const callableCell = liveResult.key(callableName).asSchemaFromLinks();
  const callableKind = detectCallableKind(undefined, callableCell);
  return callableKind === "tool" ? callableCell : null;
}

/**
 * Helper for callable resolution and discovery, which loads the target piece
 * and its pieces controller.
 *
 * Dispatch starts only the addressed piece before resolving the requested
 * callable. A verb sending into an existing root's `addPiece` stream has the
 * scheduler start that root at delivery through `ensurePieceRunningVerdict()`
 * in `packages/runner/src/ensure-piece-running.ts`.
 *
 * Dispatch performs no separate space-root initialization. Root-dependent
 * verbs require an initialized root: lazy start neither creates an absent root
 * nor reconciles its source or repairs its setup. A client-side event addressed
 * to a root with no pattern metadata is dropped with a scheduler warning.
 *
 * `newPiece()` ensures the root because `pieces.add()` requires an existing
 * default pattern and fails before sending if none exists. That ensure creates
 * an absent root and also supplies source reconciliation and cold-start setup
 * repair for an existing one.
 *
 * Discovery (`verbs`, `describe`) only reads the addressed piece's stored
 * callable surface and pattern metadata. It neither starts the piece nor asks
 * `PiecesController.get()` to project the piece's full result schema: the
 * document sync in `getPieceCell()` supplies the canonical result cell and its
 * metadata, which are the bounded inputs discovery needs.
 *
 * `cf piece call <verb> --help` takes the dispatch path: `executePieceCallable`
 * resolves the verb before it parses the arguments, so it cannot know it is
 * only rendering a page, and pays for the piece start the two discovery reads
 * skip. That makes per-verb help the most expensive of the three reads, not
 * the cheapest; letting help skip the start means reordering resolution and
 * parsing there.
 */
async function loadPieceForCallables(
  config: PieceConfig,
  deps: PieceCallableDependencies,
  { prepareDispatch, followPathToPiece = false }: {
    prepareDispatch: boolean;

    /**
     * Whether a path left after the piece is followed, through the link
     * stored there, to the piece it names. Off, such a path is refused.
     */
    followPathToPiece?: boolean;
  },
): Promise<{
  pieces: any;
  piece: any;
  space: MemorySpace;
  resolvedConfig: PieceConfig;

  /** Whether the piece was reached through a link stored at a path. */
  followedLink: boolean;
}> {
  const load = deps.loadPieces ?? loadPieces;
  let pieces = await load(config);
  let resolvedConfig: PieceConfig;
  let followedLink = false;
  if (followPathToPiece) {
    const target = await resolvePieceTargetWithPieces(
      config,
      config.piecePath ?? [],
      pieces,
    );
    if (target.path.length === 0) {
      resolvedConfig = target.config;
    } else {
      const linked = await resolveLinkedPiece(pieces, target, deps);
      followedLink = true;
      // The embedded space named the space the position sits in, which the
      // connection above already checked; the linked piece's space comes
      // from the stored link, so nothing embedded is left to agree with.
      const { embeddedSpaces: _checked, ...rest } = target.config;
      resolvedConfig = {
        ...rest,
        space: linked.space,
        piece: linked.piece,
        pieceScope: linked.scope,
      };
      if (linked.space !== (pieces.getSpace?.() ?? config.space)) {
        // A controller serves one space, so a piece in another one is
        // reached over a connection of its own, opened as the same
        // identity. Whether that identity may call the piece is the target
        // space's ACL to decide, as for a call addressed there directly.
        await pieces.dispose?.();
        pieces = await load(resolvedConfig);
      }
    }
  } else {
    resolvedConfig = await resolvePieceConfigWithPieces(config, pieces);
  }

  const piece = await (deps.loadPiece
    ? deps.loadPiece(
      pieces,
      resolvedConfig.piece,
      resolvedConfig.pieceScope,
    )
    : prepareDispatch
    ? pieces.get(
      resolvedConfig.piece,
      true,
      undefined,
      resolvedConfig.pieceScope,
    )
    : new PieceController(
      pieces,
      await pieces.getPieceCell(
        resolvedConfig.piece,
        { reconcile: true, start: false },
        undefined,
        resolvedConfig.pieceScope,
      ),
    ));
  const space = pieces.getSpace?.() ?? resolvedConfig.space;
  return { pieces, piece, space, resolvedConfig, followedLink };
}

/**
 * The phrase every refusal of {@link resolveLinkedPiece} carries when the
 * addressed position holds no pointer to a piece. A caller tells "no pointer
 * here" from every other failure by it.
 */
export const NAMES_NO_PIECE = "names no piece";

/**
 * A `cf piece call` target whose path does not lead to a piece: the position
 * holds no link, or the link it holds names a cell inside a piece.
 */
export class LinkedPieceRefusal extends Error {}

/** Helper for {@link resolveLinkedPiece}, which compares two cell addresses. */
function sameCellAddress(a: NormalizedFullLink, b: NormalizedFullLink) {
  return a.space === b.space && a.id === b.id &&
    (a.scope ?? "space") === (b.scope ?? "space") &&
    a.path.length === b.path.length &&
    a.path.every((segment, index) => segment === b.path[index]);
}

/**
 * Helper for {@link resolveLinkedPiece}, which follows every stored link at
 * `cell` with the runtime's own link resolution. Resolution reads the local
 * replica and stops at a document that has not arrived, so each round loads
 * the document reached and resolves again, until a round moves nowhere.
 */
async function resolveThroughStoredLinks(
  cell: Cell<unknown>,
): Promise<Cell<unknown>> {
  let current = cell;
  // A round that moves ends on a document the rounds so far had not loaded,
  // and a chain of stored links crosses finitely many; once all of a cycle's
  // documents are local, the resolution itself throws on it.
  while (true) {
    await current.sync();
    const next = current.resolveAsCell();
    if (
      sameCellAddress(
        next.getAsNormalizedFullLink(),
        current.getAsNormalizedFullLink(),
      )
    ) return next;
    current = next;
  }
}

/**
 * Helper for {@link resolveLinkedPiece}, which says whether the document
 * `cell` sits in is `result` or a document `result`'s piece owns. Setup writes
 * a `result` back-link onto each document a piece owns, and that is what is
 * read here.
 */
async function isDocumentOf(
  cell: Cell<unknown>,
  result: Cell<unknown>,
): Promise<boolean> {
  const owner = { ...result.resolveAsCell().getAsNormalizedFullLink() };
  const sameDocument = (link: NormalizedFullLink) =>
    sameCellAddress({ ...link, path: [] }, { ...owner, path: [] });
  const link = cell.getAsNormalizedFullLink();
  const document = cell.runtime.getCellFromLink(
    { ...link, path: [], schema: undefined },
    undefined,
    cell.tx,
  );
  await document.sync();
  const backLink = getMetaLink(document, "result");
  return sameDocument(link) ||
    (backLink !== undefined && sameDocument(backLink));
}

/**
 * Resolves the piece that the position `target.path` inside `target.config`'s
 * piece links to, in whichever space the stored link names.
 *
 * @throws LinkedPieceRefusal when the position holds no link to another
 * document or links to a document that is no piece, carrying
 * {@link NAMES_NO_PIECE}, or when the link it holds names a cell inside a
 * piece.
 */
async function resolveLinkedPiece(
  pieces: PiecesController,
  target: ResolvedPieceTarget,
  deps: PieceCallableDependencies,
): Promise<{ space: string; piece: string; scope?: CellScope }> {
  const { config, path } = target;
  const spelled = `"${path.join("/")}" on piece ${config.piece}`;
  const holder = deps.loadPiece
    ? await deps.loadPiece(pieces, config.piece, config.pieceScope)
    : new PieceController(
      pieces,
      await pieces.getPieceCell(
        config.piece,
        false,
        undefined,
        config.pieceScope,
      ),
    );
  const result: Cell<unknown> = await holder.result.getCell();
  // The parent resolves first, so that what is compared below is the last
  // segment alone: links on the way to the position are the holder's own
  // plumbing, and only one AT the position is a pointer.
  const parent = await resolveThroughStoredLinks(
    path.length > 1 ? result.key(...path.slice(0, -1)) : result,
  );
  const position = parent.key(path[path.length - 1]);
  const resolved = await resolveThroughStoredLinks(position);
  const link = resolved.getAsNormalizedFullLink();
  // A piece is the document its pattern identity is written on.
  const piece = pieceId(resolved);
  if (
    link.path.length > 0 || piece === undefined ||
    getPatternIdentityRef(resolved) === undefined
  ) {
    const ending = `\`cf piece call\` takes a piece, or a path that links ` +
      `to one.`;
    // A link that stays within the holder is its own plumbing — a result
    // field reading an argument or an internal cell — and what sits at the
    // end of it is the holder's value, so it points nowhere either.
    if (
      sameCellAddress(link, position.getAsNormalizedFullLink()) ||
      await isDocumentOf(resolved, result)
    ) {
      throw new LinkedPieceRefusal(
        `The path ${spelled} ${NAMES_NO_PIECE}: no link is stored there. ` +
          ending,
      );
    }
    // A document a piece owns, reached at its root, is one of that piece's
    // cells as much as a path into its result is.
    if (
      link.path.length > 0 || getMetaLink(resolved, "result") !== undefined
    ) {
      throw new LinkedPieceRefusal(
        `The path ${spelled} links to a cell inside a piece ` +
          `(${[link.id, ...link.path].join("/")} in ${link.space}), not ` +
          `to a piece. ${ending}`,
      );
    }
    throw new LinkedPieceRefusal(
      `The path ${spelled} ${NAMES_NO_PIECE}: the document it links to is ` +
        `not a piece. ${ending}`,
    );
  }
  const scope = link.scope;
  return {
    space: link.space,
    piece,
    ...(scope !== undefined && scope !== "space" && { scope }),
  };
}

/**
 * A requested verb absent from the piece's available pattern catalog and
 * stored callable surface. Carries the public vocabulary and read commands
 * so callers can recover without treating a verb listing as a data listing.
 */
export class UnknownPieceVerbError extends Error {
  /** Constructs an instance with discovery commands for the resolved target. */
  constructor(
    callableName: string,
    config: PieceConfig,
    verbs: readonly PieceCallableListing[],
  ) {
    const address = canonicalAddress({
      id: config.piece,
      space: config.space,
      scope: config.pieceScope ?? "space",
    });
    const names = verbs.map((verb) => {
      const marks = [
        ...(verb.tier === "wrapper" ? ["wrapper"] : []),
        ...(verb.deprecated ? ["deprecated"] : []),
      ];
      return `\`${verb.name}\`${marks.length ? ` (${marks.join(", ")})` : ""}`;
    }).join(", ");
    super(
      `Unknown verb \`${callableName}\` on piece \`${config.piece}\`.\n` +
        `Available verbs (including wrappers and deprecated verbs): ${
          names || "none"
        }.\n` +
        "Verbs are callable operations; readable data is discovered separately.\n" +
        `Discover fields: ${
          cliCommand(["piece", "describe", "--cell", address])
        }\n` +
        `Read a field: ${
          cliCommand(["cell", "get", "--cell", address, "<field>"])
        }`,
    );
  }

  /** Error category used by CLI failure reports. */
  override get name(): string {
    return "UnknownPieceVerbError";
  }
}

/** Resolves a stored callable, consulting the catalog before a stream cast. */
async function resolvePieceCallable(
  config: PieceConfig,
  callableName: string,
  deps: PieceCallableDependencies = {},
): Promise<ResolvedPieceCallable> {
  const { pieces, piece, space, resolvedConfig, followedLink } =
    await loadPieceForCallables(
      config,
      deps,
      { prepareDispatch: true, followPathToPiece: true },
    );
  const resolution = await resolveCallableOnPiece(
    { pieces, piece, space, resolvedConfig },
    callableName,
  );
  if (!followedLink) return resolution;
  return {
    ...resolution,
    linkedPiece: canonicalAddress({
      id: resolvedConfig.piece,
      space,
      scope: resolvedConfig.pieceScope ?? "space",
    }),
  };
}

/**
 * Helper for {@link resolvePieceCallable}, which resolves `callableName` on a
 * piece already loaded for dispatch.
 */
async function resolveCallableOnPiece(
  { pieces, piece, space, resolvedConfig }: {
    pieces: any;
    piece: any;
    space: MemorySpace;
    resolvedConfig: PieceConfig;
  },
  callableName: string,
): Promise<ResolvedPieceCallable> {
  const onResultCell = await tryResolvePieceCallableAt(
    piece,
    pieces,
    space,
    callableName,
    "result",
  );
  // Held apart from the walk only to record WHERE the callable was found: a
  // declared result is keyed by the PATTERN's result properties, so a
  // same-named verb reached on the input cell is a different stream that
  // merely shares its name. The listing draws the same line.
  const onInputCell = onResultCell ? null : await tryResolvePieceCallableAt(
    piece,
    pieces,
    space,
    callableName,
    "input",
  );
  let discovery:
    | Awaited<ReturnType<typeof listCallablesForLoadedPiece>>
    | undefined;
  if (!onResultCell && !onInputCell) {
    discovery = await listCallablesForLoadedPiece(piece);
    if (
      !discovery.listing.incomplete &&
      !discovery.listing.verbs.some((verb) => verb.name === callableName)
    ) {
      throw new UnknownPieceVerbError(
        callableName,
        { ...resolvedConfig, space },
        discovery.listing.verbs,
      );
    }
  }
  const resolved = onResultCell ?? onInputCell ??
    (await tryResolvePieceHandler(piece, pieces, space, callableName));
  if (!resolved) {
    throw new Error(
      `Callable "${callableName}" not found on piece ${resolvedConfig.piece}`,
    );
  }

  if (
    resolved.callableKind === "handler" && resolved !== onInputCell &&
    typeof piece?.getPattern === "function"
  ) {
    // The forced-stream fallback dispatches on the result cell too, so it
    // claims a declared result on the same terms the ordinary result-cell path
    // does. A piece surface with no pattern to consult carries no thunk at all,
    // which is the honest statement — the absence says this resolution cannot
    // describe a result, rather than promising an answer that is always none.
    //
    // The thunks share the catalog's compiled pattern when fallback resolution
    // read it. A stored callable defers that load until documentation or
    // reference validation needs it.
    let patternOnce: Promise<any> | undefined = discovery === undefined
      ? undefined
      : Promise.resolve(discovery.compiled);
    const loadPattern = () => (patternOnce ??= piece.getPattern());
    return {
      ...resolved,
      declaredResult: () => declaredVerbResult(loadPattern, callableName),
      declaredEvent: () => declaredVerbEventFor(loadPattern, callableName),
      declaredProse: () => declaredVerbProseFor(loadPattern, callableName),
    };
  }

  if (resolved.callableKind === "tool") {
    const liveCallableCell = await tryResolveLivePieceToolCallable(
      piece,
      pieces,
      space,
      callableName,
      resolvedConfig.pieceScope,
    );
    if (liveCallableCell) {
      return {
        ...resolved,
        callableCell: liveCallableCell,
        commandSpec: callableCommandSpec(liveCallableCell, "tool"),
      };
    }
  }

  return resolved;
}

/** `cf piece verbs` output: the deployed pattern's source identity plus one
 * row per callable that pattern exposes. The identity is the skew detector — a
 * client or skill
 * comparing it against the contract it was written for can tell it targets a
 * newer pattern than the live piece, instead of discovering the mismatch
 * through a silently dropped field (design: Verb discovery). */
export interface PieceCallablesListing {
  /** The deployed pattern's source identity; null when the piece exposes
   * none (e.g. harness doubles). */
  pattern: PiecePatternRef | null;

  /**
   * Present when the compiled pattern could not be consulted, which
   * leaves the listing with no source of names at all: `verbs` is then
   * empty, and that emptiness says nothing about what the piece can be asked
   * to do. Stored callables and the stream fallback remain reachable when
   * the catalog is unavailable.
   */
  incomplete?: "pattern-unavailable";

  verbs: PieceCallableListing[];
}

/** One row of `cf piece verbs`: a callable the piece exposes. */
export interface PieceCallableListing {
  name: string;
  kind: "handler" | "tool";

  /** Which cell the callable lives on: `result` for a verb the pattern's
   * result declares or wires, `input` for a stream its argument type
   * declares. `result` shadows `input` on a name collision, matching
   * `cf piece call`'s resolution order. */
  on: "result" | "input";

  /** The verb's input schema: a handler's declared event type, or a tool's
   * argument schema less the parameters the tool binds. `true` means
   * unconstrained. */
  inputSchema: JSONSchema | true;

  /** What the verb hands back: a tool's pattern result schema, a handler's
   * declared result. Absent when the verb declares none — the value-less
   * shape, which is the common one. */
  outputSchema?: JSONSchema;

  /**
   * What the verb is FOR, in the author's own words: the doc comment on the
   * pattern property declaring it, the same prose `call <verb> --help` prints
   * as its summary line.
   *
   * Absent where the author documented nothing, and absent where the pattern
   * could not be read (`incomplete`). Never derived from the name — a listing
   * that restates `addItem` as "add item" reports the schema back to the
   * caller who wrote it and calls it documentation.
   */
  description?: string;

  /** Listing mark: a UI affordance outside the headless contract (inferred
   * from session-scoped handler bindings at compile time). Hidden from the
   * default listing; always callable. */
  tier?: "wrapper";

  /** Listing mark: `@deprecated` JSDoc on the verb, lowered to the standard
   * schema annotation. Hidden from the default listing; always callable. */
  deprecated?: boolean;
}

/** The default listing's partition: what shows, and what each mark hid.
 * Marked rows keep their marks either way, so `--all` output is
 * self-describing. */
export function partitionVerbListing(
  verbs: readonly PieceCallableListing[],
): { shown: PieceCallableListing[]; wrapper: number; deprecated: number } {
  const shown: PieceCallableListing[] = [];
  let wrapper = 0;
  let deprecated = 0;
  for (const verb of verbs) {
    if (verb.tier === "wrapper") wrapper++;
    else if (verb.deprecated === true) deprecated++;
    else shown.push(verb);
  }
  return { shown, wrapper, deprecated };
}

/**
 * A declared object schema's properties, beside the root a property's own
 * references resolve against.
 *
 * The ROOT may itself be a reference. A pattern whose result or argument is
 * a named type compiles to a root of `{$ref: "#/$defs/T"}` beside its
 * `$defs`, and the properties then live in the definition rather than on the
 * root.
 * That is every piece a verb CREATES, because a created piece's result is the
 * named type its author declared, while a root piece's is written inline. The
 * `$defs` sit on the root, so the root is what the reference resolves against.
 *
 * The returned root is the document a property's own references resolve in:
 * the schema itself, or the document the resolved view is when resolution
 * minted one of its own (`cfcSchemaResolvedRoot`).
 *
 * Returns `undefined` for a schema that declares no object at all.
 */
function declaredProperties(
  schema: unknown,
): { properties: Record<string, unknown>; root: JSONSchema } | undefined {
  if (!isObjectOrArray(schema)) return undefined;
  const declared = typeof schema.$ref === "string"
    ? resolveCfcSchemaRefs(schema, schema as JSONSchema)
    : schema;
  if (!isObjectOrArray(declared) || !isObjectOrArray(declared.properties)) {
    return undefined;
  }
  return {
    properties: declared.properties as Record<string, unknown>,
    root: typeof schema.$ref === "string"
      ? cfcSchemaResolvedRoot(declared as JSONSchema, schema as JSONSchema)
      : schema as JSONSchema,
  };
}

/**
 * Whether a declared property is a stream — the marker that makes a result
 * or argument property a verb. Read off the outermost `asCell` entry, which
 * is the one that says what the property itself is; an inner entry describes
 * what a cell there would hold.
 */
function declaresStream(property: Record<string, unknown>): boolean {
  const entries = property.asCell;
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const outermost: unknown = entries[0];
  return outermost === "stream" ||
    (isObjectOrArray(outermost) && outermost.kind === "stream");
}

/**
 * The keys of a declared verb property that describe the verb rather than
 * its event: the stream marker that makes it a verb at all, and the prose and
 * listing marks a row publishes as fields of its own.
 */
const VERB_PROPERTY_KEYS: readonly string[] = [
  "asCell",
  "description",
  "tier",
  "deprecated",
];

/**
 * The input schema a declared verb serves: the property's event type, made
 * self-contained. A property written as a reference resolves to its
 * definition, with the property's own keys merged over it; the keys that
 * describe the verb rather than its event are then dropped. The definitions of
 * the event's document are attached in place of any `$defs` the property
 * carries of its own, and cut to the ones the event reaches; under a document
 * declaring none, the event serves none. A `Stream<void>` verb serves an
 * empty object schema rather than a stream marker with the verb's prose hung
 * on it, and a referenced event serves its definition alone. A reference that
 * does not resolve serves `true`: the surface cannot invent structure.
 */
function declaredVerbInput(
  property: Record<string, unknown>,
  root: JSONSchema,
): JSONSchema | true {
  const resolved = typeof property.$ref === "string"
    ? resolveCfcSchemaRefs(property, root)
    : property;
  if (!isObjectOrArray(resolved)) return true;
  const { $defs: _own, ...event } = Object.fromEntries(
    Object.entries(resolved).filter(([key]) =>
      !VERB_PROPERTY_KEYS.includes(key)
    ),
  ) as JSONSchema & object;
  // A referenced event serves the definitions of the document its reference
  // chain ends in, which `resolveCfcSchemaRefs` carries on the resolved view;
  // an inline event serves the root's.
  const eventRoot = resolved !== property
    ? cfcSchemaResolvedRoot(resolved as JSONSchema, root)
    : root;
  return pruneCfcSchemaDefinitions({
    ...event,
    ...(isObjectOrArray(eventRoot) && isObjectOrArray(eventRoot.$defs)
      ? { $defs: eventRoot.$defs }
      : {}),
  });
}

/** The listing marks and prose a declared property carries. */
function declaredVerbAnnotations(
  property: Record<string, unknown>,
): Pick<PieceCallableListing, "description" | "tier" | "deprecated"> {
  return {
    ...(typeof property.description === "string"
      ? { description: property.description }
      : {}),
    ...(property.tier === "wrapper" ? { tier: "wrapper" as const } : {}),
    ...(property.deprecated === true ? { deprecated: true } : {}),
  };
}

/** Whether two links written in a compiled pattern's own terms address the
 * same cell. An alias's identity is its cause, path and scope; the schema it
 * carries is fidelity for whoever reads through it, and one cell reached from
 * two positions can carry a different one at each. Anything that is not a pair
 * of aliases falls back to whole-link equality, which can only miss — and a
 * miss costs a row its `outputSchema`, never gives it the wrong one. */
function samePatternLink(left: unknown, right: unknown): boolean {
  if (!isObjectOrArray(left) || !isObjectOrArray(right)) return false;
  const leftAlias = left.$alias;
  const rightAlias = right.$alias;
  if (!isObjectOrArray(leftAlias) || !isObjectOrArray(rightAlias)) {
    return deepEqual(left, right);
  }
  return deepEqual(leftAlias.partialCause, rightAlias.partialCause) &&
    deepEqual(leftAlias.path ?? [], rightAlias.path ?? []) &&
    leftAlias.scope === rightAlias.scope;
}

/** The declared result of each verb a compiled pattern drives from a result
 * property, keyed by that property — or `undefined` where nothing names one.
 *
 * Metadata about candidates, never the list of them: a name absent here is a
 * name with no declared result to report, which is the common case and says
 * nothing about whether the property is callable.
 *
 * A handler node's `$event` input and the result property exposing that
 * handler's stream are one cell written twice in the pattern's own terms, so
 * the property matching a node's `$event` names the verb that node implements
 * — a structural comparison inside one compiled object, with no live cell to
 * resolve. The declared result rides on that node's module, which is where
 * `Stream<E, R>`'s `R` is lowered (verb contract WS-C). A stream two handler
 * nodes share is still a verb and still keyed here, but it names no single
 * result, so it maps to `undefined` rather than to one node's arbitrarily.
 *
 * A tool is absent by construction: it is not driven by a node, and its result
 * schema rides its own callable cell, where `callableCommandSpec` reads it. */
function handlerVerbResults(
  pattern: { result?: unknown; nodes?: unknown } | null | undefined,
): Map<string, JSONSchema | undefined> {
  const verbs = new Map<string, JSONSchema | undefined>();
  const result = pattern?.result;
  if (!isObjectOrArray(result)) return verbs;
  const nodes = Array.isArray(pattern?.nodes) ? pattern.nodes : [];
  for (const [name, link] of Object.entries(result)) {
    let resultSchema: JSONSchema | undefined;
    let matched = 0;
    for (const node of nodes) {
      if (!isObjectOrArray(node) || !isObjectOrArray(node.inputs)) continue;
      if (!samePatternLink(link, node.inputs.$event)) continue;
      matched++;
      const module = node.module;
      if (isObjectOrArray(module) && module.resultSchema !== undefined) {
        resultSchema = module.resultSchema as JSONSchema;
      }
    }
    if (matched === 0) continue;
    verbs.set(name, matched === 1 ? resultSchema : undefined);
  }
  return verbs;
}

/** The declared event contract of each verb a compiled pattern drives from a
 * result property, keyed by that property — matched to its handler node by
 * the same `$event`-input comparison `handlerVerbResults` makes, so the two
 * can never attribute one stream to different verbs.
 *
 * This reads the handler MODULE's argument schema, not the pattern's result
 * schema, because the module is the only serialized surface that keeps
 * reference markers: the builder sanitizes `Pattern.resultSchema` to stream
 * markers only (`sanitizeSchemaForLinks`, `KeepAsCell.OnlyStream`,
 * builder/pattern.ts), while a module's schemas ride through
 * `moduleToEncodableForm` verbatim. The `$event` property inside it is the
 * authored event as the transformer emitted it — the input contract of
 * docs/history/plans/verb-input-contract.md, `asCell` markers intact.
 *
 * The returned schema is self-contained: a `$ref` event is resolved against
 * the module schema's own root, and an inline one carries that root's
 * `$defs` along, so a consumer can follow interior references without the
 * pattern in hand. A stream two handler nodes share names no single
 * contract and maps to `undefined`, exactly as its result does.
 *
 * Exported for the direct tests in `test/verb-emitted-address.test.ts`: a
 * shared stream, a module with no schema, and an inline event are all
 * reachable by construction and awkward to reach by compiling a pattern. */
export function handlerVerbEvents(
  pattern: { result?: unknown; nodes?: unknown } | null | undefined,
): Map<string, JSONSchema | undefined> {
  const verbs = new Map<string, JSONSchema | undefined>();
  const result = pattern?.result;
  if (!isObjectOrArray(result)) return verbs;
  const nodes = Array.isArray(pattern?.nodes) ? pattern.nodes : [];
  for (const [name, link] of Object.entries(result)) {
    let eventSchema: JSONSchema | undefined;
    let matched = 0;
    for (const node of nodes) {
      if (!isObjectOrArray(node) || !isObjectOrArray(node.inputs)) continue;
      if (!samePatternLink(link, node.inputs.$event)) continue;
      matched++;
      const argumentSchema = isObjectOrArray(node.module)
        ? node.module.argumentSchema
        : undefined;
      if (!isObjectOrArray(argumentSchema)) continue;
      const event = isObjectOrArray(argumentSchema.properties)
        ? argumentSchema.properties.$event
        : undefined;
      if (!isObjectOrArray(event)) continue;
      // An inline event is a fragment of the argument document: it carries
      // that document's definitions — none, under a root declaring none — in
      // place of any `$defs` of its own.
      eventSchema = typeof event.$ref === "string"
        ? resolveCfcSchemaRefs(event, argumentSchema as JSONSchema)
        : pruneCfcSchemaDefinitions(cfcSchemaWithInheritedDefs(
          event as JSONSchema,
          isObjectNotArray(argumentSchema.$defs)
            ? argumentSchema.$defs as Record<string, JSONSchema>
            : {},
        ));
    }
    if (matched === 0) continue;
    verbs.set(name, matched === 1 ? eventSchema : undefined);
  }
  return verbs;
}

/**
 * What a pattern's own result schema says a verb is for, and what its event
 * fields mean — the author's doc comments, as the compiler lowered them.
 */
export interface DeclaredVerbProse {
  /**
   * The doc comment on the property declaring the verb: what the verb DOES.
   * A sibling of the property's `$ref`, and never a statement about the event
   * object, which is why it is held apart from `eventSchema` below rather than
   * merged into it.
   */
  description?: string;

  /**
   * The verb's declared event schema with its `$ref` followed against the
   * result schema's own root, so the field descriptions inside the `$defs`
   * target are reachable. Read for annotations ONLY — never to decide a shape;
   * see `withDeclaredFieldProse`. (Reference markers are absent here too —
   * the builder sanitizes the result schema — so the dispatch gate reads the
   * handler module instead: `handlerVerbEvents`.)
   */
  eventSchema?: JSONSchema;
}

/**
 * Every verb's prose, keyed by the result property declaring it.
 *
 * A pattern's `resultSchema` is the only place both descriptions survive
 * compilation. Neither reaches the callable cell a verb dispatches through:
 * that cell adopts the schema embedded in its resolved link chain
 * (`Cell.asSchemaFromLinks`), which for a verb is the handler node's `$event`
 * input — the handler's READ of the event, narrowed to the fields its
 * implementation touches, rather than a rendering of the declared event type.
 * A query carries no author's words, so a caller's schema is not the declared
 * one stripped of prose; reading the declared one here is what recovers it.
 *
 * A name absent here is a name the pattern's declared result type does not
 * mention — the same condition that hides a verb from the result-cell walk —
 * and says nothing about whether the verb is callable.
 *
 * The `$defs` live at the result schema's ROOT while the `$ref` sits on the
 * property, so the root is passed explicitly. Resolving the property alone
 * would consult a document that carries no definitions at all.
 *
 * Exported for the direct tests in `test/verb-prose-overlay.test.ts`, alongside
 * `withDeclaredFieldProse`: the two are the pure halves of this feature, and a
 * result schema holding a boolean property or an unresolvable reference is
 * reachable by construction and not by compiling a pattern.
 */
export function declaredVerbProse(
  pattern: { resultSchema?: unknown } | null | undefined,
): Map<string, DeclaredVerbProse> {
  const prose = new Map<string, DeclaredVerbProse>();
  const declared = declaredProperties(pattern?.resultSchema);
  if (declared === undefined) return prose;
  const declaredRoot = declared.root;
  for (const [name, property] of Object.entries(declared.properties)) {
    if (!isObjectOrArray(property)) continue;
    const description = typeof property.description === "string"
      ? property.description
      : undefined;
    // An inline property is a fragment of the result document: it carries
    // that document's definitions — none, under a root declaring none — in
    // place of any `$defs` of its own.
    const eventSchema = typeof property.$ref === "string"
      ? resolveCfcSchemaRefs(property, declaredRoot)
      : pruneCfcSchemaDefinitions(cfcSchemaWithInheritedDefs(
        property as JSONSchema,
        isObjectOrArray(declaredRoot) && isObjectNotArray(declaredRoot.$defs)
          ? declaredRoot.$defs as Record<string, JSONSchema>
          : {},
      ));
    if (description === undefined && eventSchema === undefined) continue;
    prose.set(name, {
      ...(description !== undefined && { description }),
      ...(eventSchema !== undefined && { eventSchema }),
    });
  }
  return prose;
}

/**
 * One `description` to write into the served schema, addressed by its path
 * within that document.
 *
 * Addressed rather than applied in place because a served position may live
 * inside a shared `$defs` entry, which several positions reach and no
 * single-pass rebuild of the tree can reach twice. Collecting first and
 * applying second lets one definition receive edits found from anywhere in the
 * walk without the walk having to know where it sits.
 */
interface DescriptionEdit {
  /** Keys from the served document's root down to the `description` slot. */
  readonly path: readonly string[];

  readonly description: string;
}

/**
 * `served` with `description` annotations filled in from `declared` wherever it
 * has none.
 *
 * THE POSITIONS IT WALKS, enumerated rather than summarized, because the
 * summary is the part a reader would otherwise have to take on trust:
 *
 * - `properties`, by key.
 * - `items` in its single-schema form, and in its positional array form.
 * - `prefixItems`, by index.
 * - the members of `allOf`, `anyOf` and `oneOf`.
 *
 * It follows a `$ref` on either side to reach any of those. Everything else a
 * JSON Schema can hold is NOT walked and keeps whatever prose it arrived with:
 * `additionalProperties`, `patternProperties`, `propertyNames`, `contains`,
 * `not`, `if`/`then`/`else`, `dependentSchemas`, and `unevaluated*`.
 *
 * Three rules govern which declared account answers for a position, and each is
 * a place a shorter implementation silently loses prose:
 *
 * - **Every** account is consulted, not the first one that mentions the
 *   position. An arm declaring a field without documenting it must not shadow a
 *   later arm that documents it.
 * - The first account that actually SAYS something wins, in declaration order.
 *   Two arms documenting one field differently describe two different values,
 *   so their sentences are not merged — merging would produce prose no author
 *   wrote.
 * - A reference resolves in the scope that declares it. A definition may carry
 *   `$defs` of its own, and its nested references name those; resolving them at
 *   the event root finds nothing, or a same-named definition belonging to
 *   someone else.
 *
 * ANNOTATIONS ONLY, and that bound is the point rather than a simplification.
 * The two schemas disagree about shape by construction, not by accident:
 * `served` is the handler's read of the event, narrowed to what its body
 * touches, while `declared` is the event TYPE the pattern's result publishes.
 * A field declared and never read appears in one and not the other; a union the
 * declared side spells as `anyOf` can arrive flattened into one object. Copying
 * a `description` cannot change which payloads pass, so this can never make the
 * served schema disagree with the dispatch it governs. Copying anything else
 * could, which is why nothing else is copied and no position is ADDED: a key
 * absent from `served` stays absent, a `$ref` is never inlined, a combinator is
 * never flattened, and a page never offers a flag the handler does not read.
 *
 * The root description is never taken. It belongs to the verb, not to the
 * event object, and it travels as the spec's own `description`.
 *
 * Two more bounds worth stating. A served `$ref` naming a definition the served
 * root does not carry stops the descent there, as does a declared `$ref` that
 * does not resolve. And where the served side spells a combinator the declared
 * side does not, the branches are offered the declared node as a whole and no
 * branch takes its description — a disjunction's arms are alternatives, and one
 * sentence written across all of them would describe each of them wrongly.
 *
 * Exported for the direct tests in `test/verb-prose-overlay.test.ts`, which
 * reach the degenerate schema shapes a compiled pattern does not produce.
 */
export function withDeclaredFieldProse(
  served: JSONSchema | true,
  declared: JSONSchema | undefined,
): JSONSchema | true {
  if (served === true || !isObjectOrArray(served)) {
    return served;
  }
  // A caller-facing surface serves the expanded form: a schema stored as a
  // content-addressed reference recomposes here, with `$defs` names
  // recovered from the declared document — the stored form knows a
  // definition only by its hash.
  served = expandServedSchemaReference(served, declared);
  if (declared === undefined || !isObjectOrArray(served)) {
    return served;
  }
  const edits: DescriptionEdit[] = [];
  collectDescriptionEdits(
    {
      served,
      servedRoot: served,
      declared: [{ schema: declared, root: declared, direct: true }],
    },
    [],
    false,
    { edits, written: new Set<string>(), openDefinitions: [], openRefs: [] },
  );
  return applyDescriptionEdits(served, edits);
}

/**
 * Recomposes a served schema stored as a content-addressed reference into
 * its expanded form, keeping the reference's siblings (a `description`
 * beside a `$ref` stays beside the expansion). An unresolvable reference is
 * served as it is — the surface cannot invent structure.
 */
function expandServedSchemaReference(
  served: JSONSchema & object,
  declared: JSONSchema | undefined,
): JSONSchema {
  const ref = served.$ref;
  if (typeof ref !== "string" || parseExternalSchemaRef(ref) === undefined) {
    return served;
  }
  const nameByHash = declaredDefNamesByHash(declared);
  let recomposed: JSONSchema;
  try {
    recomposed = recomposeSchema(ref, lookupSchemaDocument, {
      nameFor: (hash) => nameByHash.get(hash),
    });
  } catch {
    return served;
  }
  const { $ref: _expanded, ...siblings } = served as Record<string, unknown>;
  return isObjectOrArray(recomposed)
    ? { ...recomposed, ...siblings } as JSONSchema
    : recomposed;
}

/**
 * The declared document's `$defs` names, keyed by the content hash each
 * definition decomposes to — the same hashes the served document's
 * references carry, so a recomposition can put the author's names back.
 *
 * Each definition maps under TWO hashes: as declared, and with every
 * `description` stripped. Descriptions participate in schema hashing, and
 * the served structural document may carry a definition without the prose
 * the author declared — hashing only the prose-bearing form would miss it,
 * and the name would fall back to a hash-derived one exactly for the
 * definitions an author documented best.
 */
function declaredDefNamesByHash(
  declared: JSONSchema | undefined,
): Map<string, string> {
  const names = new Map<string, string>();
  if (!isObjectOrArray(declared) || !isObjectOrArray(declared.$defs)) {
    return names;
  }
  const strippedDefs = Object.fromEntries(
    Object.entries(declared.$defs).map((
      [name, def],
    ) => [name, withoutSchemaProse(def as JSONSchema)]),
  );
  const defGroups = [declared.$defs, strippedDefs as typeof declared.$defs];
  for (const name of Object.keys(declared.$defs)) {
    for (const defs of defGroups) {
      try {
        const { rootRef } = decomposeSchema(
          {
            $ref: encodeJsonPointer(["#", "$defs", name]),
            $defs: defs,
          } as Parameters<typeof decomposeSchema>[0],
        );
        const parsed = parseExternalSchemaRef(rootRef);
        if (parsed !== undefined && !names.has(parsed.taggedHash)) {
          names.set(parsed.taggedHash, name);
        }
      } catch {
        // An undecomposable definition keeps its hash-derived name.
      }
    }
  }
  return names;
}

/**
 * `schema` with every SCHEMA-NODE `description` removed — the one keyword
 * `withDeclaredFieldProse` folds, so the stripped form is the structural
 * shape a prose-free served document hashes to. The walk is schema-aware:
 * data-bearing keyword values (`default`, `const`, `enum`, `examples`) are
 * opaque, so a data member that happens to be NAMED `description` rides
 * through untouched.
 */
function withoutSchemaProse(schema: JSONSchema): JSONSchema {
  if (!isObjectOrArray(schema)) return schema;
  const { description: _prose, ...rest } = schema as Record<string, unknown>;
  return mapSubschemas(
    rest as Parameters<typeof mapSubschemas>[0],
    (child) => withoutSchemaProse(child),
    { includeUnused: true, includeDefs: true },
  );
}

/**
 * One declared node that may describe a position, with the document root
 * its own references resolve against.
 *
 * The root travels WITH the node because a reference chain can end in
 * another document — an embedded or external target — whose definitions its
 * nested references then name. Carrying one root for the whole walk resolves
 * such a reference in the wrong document, which finds either nothing or —
 * worse — a same-named definition belonging to someone else.
 *
 * `direct` separates an account OF the position from an account of one
 * ALTERNATIVE at it. Both are read when looking a child up; only a direct one
 * may give the position its own description.
 */
interface DeclaredCandidate {
  readonly schema: JSONSchema;
  readonly root: JSONSchema;
  readonly direct: boolean;
}

/** The served node at one position, with the declared accounts of it. */
interface ProseWalk {
  readonly served: JSONSchema;
  readonly servedRoot: JSONSchema;
  readonly declared: readonly DeclaredCandidate[];
}

/**
 * State threaded through the whole walk: what has been recorded, and what is
 * currently open on the path.
 *
 * Both open lists are STACKS rather than sets of everything ever seen. A set
 * answers "have I been here before", and a legitimate second visit — two arms
 * of a union naming one definition, two fields of the same type — is
 * indistinguishable from a cycle under that question, so the second visit is
 * dropped along with the prose it would have found. A stack answers "am I
 * inside this right now", which is the question termination actually asks.
 */
interface ProseWalkState {
  readonly edits: DescriptionEdit[];

  /** Paths already recorded, so the first account of a position wins. Two
   * positions sharing one `$defs` target can each reach it now that the guard
   * is path-scoped, and without this the later one would silently overwrite
   * the earlier. */
  readonly written: Set<string>;

  /** Served `$defs` names open on the current descent. */
  readonly openDefinitions: string[];

  /** Declared references open on the current expansion, each with the scope it
   * was followed in — the same reference in two different scopes is two
   * different targets. */
  readonly openRefs: { ref: string; root: JSONSchema }[];
}

/**
 * The `$defs` name a served node references, or `undefined` when it references
 * nothing the served root defines.
 *
 * Matched by ENCODING each definition name with the runner's own encoder and
 * comparing, rather than by decoding the `$ref`. The encoder is the function
 * that wrote these strings, so round-tripping through it cannot disagree with
 * them, and no pointer-decoding helper has to be re-exported to get here.
 */
function servedDefinitionName(
  node: JSONSchema,
  servedRoot: JSONSchema,
): string | undefined {
  if (!isObjectOrArray(node) || typeof node.$ref !== "string") return undefined;
  if (!isObjectOrArray(servedRoot) || !isObjectOrArray(servedRoot.$defs)) {
    return undefined;
  }
  for (const name of Object.keys(servedRoot.$defs)) {
    if (encodeJsonPointer(["#", "$defs", name]) === node.$ref) return name;
  }
  return undefined;
}

/**
 * Every declared node that can describe one position: each entry with its
 * references followed, plus — transitively — the members of any combinator it
 * carries. Entries and their ref-chains are `direct`; combinator members are
 * not.
 *
 * Flattening the combinator is what lets a served side that spells a union as
 * one merged object still find each field's prose, which lives in whichever arm
 * declares it. Nothing here is written back: these are read to look a position
 * up, and the served document keeps its own shape.
 *
 * The document is threaded rather than assumed: `resolveCfcSchemaRefRoot`
 * reports the one a ref chain ends in, so a definition's nested references
 * resolve in the document that declares them.
 *
 * Termination is by the open-reference stack, keyed on the pair of reference
 * and scope, pushed on the way in and popped on the way out. Object identity
 * is deliberately not used as a backstop: `resolveCfcSchemaRefs` hands back a
 * fresh object whenever it merges ref-site siblings over a target, so identity
 * is not stable across resolution and a guard built on it would never fire.
 */
function expandDeclared(
  entries: readonly DeclaredCandidate[],
  openRefs: { ref: string; root: JSONSchema }[],
): DeclaredCandidate[] {
  const candidates: DeclaredCandidate[] = [];
  const visit = (
    node: JSONSchema | undefined,
    root: JSONSchema,
    direct: boolean,
  ): void => {
    if (!isObjectOrArray(node)) return;
    const scope = root;
    const ref = node.$ref;
    let resolved: JSONSchema | undefined = node;
    let childRoot = scope;
    if (typeof ref === "string") {
      if (openRefs.some((open) => open.ref === ref && open.root === scope)) {
        return;
      }
      openRefs.push({ ref, root: scope });
      resolved = resolveCfcSchemaRefs(node, scope);
      childRoot = isObjectOrArray(resolved)
        ? cfcSchemaResolvedRoot(resolved, resolveCfcSchemaRefRoot(node, scope))
        : scope;
    }
    try {
      if (!isObjectOrArray(resolved)) return;
      candidates.push({ schema: resolved, root: childRoot, direct });
      for (const keyword of COMBINATOR_KEYWORDS) {
        const members = resolved[keyword];
        if (!Array.isArray(members)) continue;
        for (const member of members) {
          visit(member as JSONSchema, childRoot, false);
        }
      }
    } finally {
      if (typeof ref === "string") openRefs.pop();
    }
  };
  for (const entry of entries) visit(entry.schema, entry.root, entry.direct);
  return candidates;
}

/**
 * Walk both documents in lockstep, recording every `description` the served
 * side lacks and the declared side supplies.
 *
 * `path` addresses `served` within the served document. `fillOwnDescription` is
 * false only at the root, whose description belongs to the verb rather than to
 * the event object.
 *
 * WHICH ACCOUNT WINS, where several describe one position: the first direct
 * candidate that actually carries a description, in the order the declared
 * document lists them. Not the first candidate that merely mentions the
 * position — an arm declaring a field without documenting it must not shadow a
 * later arm that documents it. Not a merge of every arm's sentence either: two
 * arms documenting one field differently are describing two different values,
 * and concatenating them would produce prose no author wrote. First that says
 * something, deterministically.
 *
 * TERMINATION, which `$ref`-following makes a real question. Descent is over
 * the SERVED structure, whose inline part is a finite tree, so the only way to
 * recur forever is through a served `$ref` — and every one of those resolves to
 * a `$defs` entry. `openDefinitions` holds the ones open on the current path,
 * pushed on descent and popped after, so a definition that reaches itself stops
 * while two siblings naming one definition are each still walked. A
 * self-referential type is the case that needs the first half: an item whose
 * `children` are items reaches its own definition on the second hop. Two fields
 * of one type are the case that needs the second.
 *
 * `schemaAtPath` would look like the shorter road here and is not: it resolves
 * refs eagerly and without a cycle guard, so it overflows the stack on exactly
 * the self-referential type above, before any guard written here could run.
 */
function collectDescriptionEdits(
  walk: ProseWalk,
  path: readonly string[],
  fillOwnDescription: boolean,
  state: ProseWalkState,
): void {
  const { served, servedRoot } = walk;
  if (!isObjectOrArray(served)) return;
  const candidates = expandDeclared(walk.declared, state.openRefs);
  if (candidates.length === 0) return;

  if (fillOwnDescription && served.description === undefined) {
    const described = candidates.find((candidate) =>
      candidate.direct && isObjectOrArray(candidate.schema) &&
      typeof candidate.schema.description === "string"
    );
    if (described !== undefined) {
      recordDescription(
        state,
        [...path, "description"],
        (described.schema as Record<string, unknown>).description as string,
      );
    }
  }

  // Where the served node's CHILDREN live. For a `$ref` that is the definition
  // it names, which is left in place: a caller's tooling reads the served
  // shape, and inlining the target to annotate it would rewrite what it reads.
  // Definitions are observed to arrive with their own prose intact, so this
  // descent commonly finds nothing to fill and exists to keep the walk honest
  // where it does.
  let target = served;
  let targetPath = path;
  let openedDefinition: string | undefined;
  const definitionName = servedDefinitionName(served, servedRoot);
  if (definitionName !== undefined) {
    if (state.openDefinitions.includes(definitionName)) return;
    const definitions = isObjectOrArray(servedRoot)
      ? servedRoot.$defs as Record<string, JSONSchema>
      : {};
    const definition = definitions[definitionName];
    if (!isObjectOrArray(definition)) return;
    state.openDefinitions.push(definitionName);
    openedDefinition = definitionName;
    target = definition;
    targetPath = ["$defs", definitionName];
  } else if (typeof served.$ref === "string") {
    // A reference the served root does not define. Nothing here can annotate
    // what it cannot address, so the subtree is left exactly as served.
    return;
  }

  try {
    descendInto(target, targetPath, candidates, walk, state);
  } finally {
    if (openedDefinition !== undefined) state.openDefinitions.pop();
  }
}

/** Record one description unless this position already has an account. */
function recordDescription(
  state: ProseWalkState,
  path: readonly string[],
  description: string,
): void {
  // Keyed as JSON rather than by joining on a separator: a path segment is a
  // property name and may contain any character, so no separator is safe.
  const key = JSON.stringify(path);
  if (state.written.has(key)) return;
  state.written.add(key);
  state.edits.push({ path, description });
}

/** The child positions of one served node, each paired with every declared
 * account of it. Split out so the definition bookkeeping above reads as the one
 * thing it is. */
function descendInto(
  target: Record<string, unknown>,
  targetPath: readonly string[],
  candidates: readonly DeclaredCandidate[],
  walk: ProseWalk,
  state: ProseWalkState,
): void {
  // `target` is either the served node this was reached with or a `$defs`
  // entry, and the caller has already established that each is a record.
  const { servedRoot } = walk;
  const descend = (
    servedChild: JSONSchema,
    declared: DeclaredCandidate[],
    childPath: readonly string[],
    fillChildDescription: boolean,
  ): void => {
    if (declared.length === 0) return;
    collectDescriptionEdits(
      { served: servedChild, servedRoot, declared },
      childPath,
      fillChildDescription,
      state,
    );
  };

  /** Every candidate's account of one child position, in declaration order. */
  const accounts = (
    pick: (candidate: Record<string, unknown>) => JSONSchema | undefined,
  ): DeclaredCandidate[] =>
    candidates.flatMap((candidate) => {
      const found = isObjectOrArray(candidate.schema)
        ? pick(candidate.schema)
        : undefined;
      return found === undefined
        ? []
        : [{ schema: found, root: candidate.root, direct: true }];
    });

  if (isObjectOrArray(target.properties)) {
    for (
      const [key, child] of Object.entries(
        target.properties as Record<string, JSONSchema>,
      )
    ) {
      descend(
        child,
        accounts((candidate) =>
          isObjectOrArray(candidate.properties)
            ? (candidate.properties as Record<string, JSONSchema>)[key]
            : undefined
        ),
        [...targetPath, "properties", key],
        true,
      );
    }
  }

  // `items` in its single-schema form: one element schema for the whole array,
  // so a documented field inside a list of objects keeps its prose.
  if (target.items !== undefined && !Array.isArray(target.items)) {
    descend(
      target.items as JSONSchema,
      accounts((candidate) =>
        candidate.items !== undefined && !Array.isArray(candidate.items)
          ? candidate.items as JSONSchema
          : undefined
      ),
      [...targetPath, "items"],
      true,
    );
  }

  // Positional element schemas: `prefixItems`, and the array form of `items`
  // that predates it. Paired by index against the same keyword, which is the
  // only correspondence a tuple has — position IS its identity.
  for (const keyword of ["prefixItems", "items"] as const) {
    const servedList = target[keyword];
    if (!Array.isArray(servedList)) continue;
    for (let index = 0; index < servedList.length; index++) {
      descend(
        servedList[index] as JSONSchema,
        accounts((candidate) => {
          const list = candidate[keyword];
          return Array.isArray(list) && index < list.length
            ? list[index] as JSONSchema
            : undefined;
        }),
        [...targetPath, keyword, String(index)],
        true,
      );
    }
  }

  // Combinator members. `allOf` is included deliberately, and the refusal to
  // prove a container through a conjunction elsewhere in the tree does not
  // carry here: that refusal is about PROOF, which needs the members combined
  // the way the specification says, and this is annotation. A value satisfies
  // every conjunct, so a description on any conjunct describes the value.
  //
  // Members pair by index against a candidate spelling the same keyword with
  // the same arity. Otherwise each served member is offered every candidate
  // whole, and takes no description of its own from them — a disjunction's arms
  // are alternatives, and one sentence copied onto all of them describes each
  // wrongly, while a field nested inside an arm is still worth reaching.
  for (const keyword of COMBINATOR_KEYWORDS) {
    const servedMembers = target[keyword];
    if (!Array.isArray(servedMembers)) continue;
    const paired = candidates.filter((candidate) =>
      isObjectOrArray(candidate.schema) &&
      Array.isArray((candidate.schema as Record<string, unknown>)[keyword]) &&
      ((candidate.schema as Record<string, unknown>)[keyword] as unknown[])
          .length === servedMembers.length
    );
    for (let index = 0; index < servedMembers.length; index++) {
      const declared = paired.length > 0
        ? paired.map((candidate) => ({
          schema: (candidate.schema as Record<string, unknown>)[
            keyword
          ] as JSONSchema[],
          root: candidate.root,
          direct: true,
        })).map((entry) => ({
          schema: (entry.schema as unknown as JSONSchema[])[index],
          root: entry.root,
          direct: true,
        }))
        : candidates.map((candidate) => ({ ...candidate, direct: false }));
      descend(
        servedMembers[index] as JSONSchema,
        declared,
        [...targetPath, keyword, String(index)],
        paired.length > 0,
      );
    }
  }
}

/** The combinator keywords the walk descends, in a fixed order. */
const COMBINATOR_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;

/**
 * `root` with every collected description written in, sharing every subtree no
 * edit touches. Returns `root` itself when there is nothing to write.
 */
function applyDescriptionEdits(
  root: JSONSchema,
  edits: readonly DescriptionEdit[],
): JSONSchema {
  let next = root;
  for (const edit of edits) {
    next = writeDescriptionAt(next, edit.path, edit.description);
  }
  return next;
}

/**
 * `node` with `description` set at `path`, copying only the nodes along it.
 *
 * Every path ends at a `description` slot the walk found empty, so this only
 * ever fills a hole — it cannot overwrite an author's own words, and a path
 * whose interior has since been rewritten by an earlier edit still lands, since
 * each edit reads the document the previous one produced.
 *
 * An array along the way is copied as an array. A combinator member and a tuple
 * position are addressed by index, and object-spreading a list to replace one
 * would hand back `{"0": …, "1": …}` — a served `anyOf` silently turned into
 * something no reader of it expects.
 *
 * It carries no guard against a path that addresses nothing, because there is
 * no such path to guard against: `collectDescriptionEdits` builds every one by
 * walking this document, and an edit only ever ADDS a `description` key, which
 * leaves every other path it recorded still addressing what it addressed. That
 * invariant is the precondition — a caller assembling a path any other way owes
 * its own check.
 */
function writeDescriptionAt(
  node: JSONSchema,
  path: readonly string[],
  description: string,
): JSONSchema {
  const [head, ...rest] = path;
  const value: unknown = rest.length === 0 ? description : writeDescriptionAt(
    (node as Record<string, JSONSchema>)[head],
    rest,
    description,
  );
  if (Array.isArray(node)) {
    const copy = [...node] as unknown[];
    copy[Number(head)] = value;
    return copy as unknown as JSONSchema;
  }
  return { ...(node as object), [head]: value } as JSONSchema;
}

/** One verb's declared result, matched through the piece's compiled pattern.
 *
 * The same lookup a listing makes for every row, made for a single name — one
 * matcher, so the help page and `cf piece verbs` can never describe the same
 * verb differently. It runs on the help path alone, reached through the thunk
 * on `ResolvedPieceCallable`, which is why loading the pattern is affordable
 * here.
 *
 * The pattern is advisory exactly as it is in the listing: a piece whose
 * pattern will not resolve still calls its verbs, it just cannot say what one
 * hands back. `getPattern` throwing is the whole of that condition here —
 * whether a piece HAS one is settled before the thunk is attached.
 */
async function declaredVerbResult(
  loadPattern: () => Promise<any>,
  callableName: string,
): Promise<JSONSchema | undefined> {
  try {
    return handlerVerbResults(await loadPattern()).get(callableName);
  } catch {
    return undefined;
  }
}

/**
 * One verb's prose, read through the piece's compiled pattern.
 *
 * The listing's `declaredVerbProse` narrowed to a single name, on the same
 * terms `declaredVerbResult` above states: one reader, so a help page and
 * `cf piece verbs` cannot describe the same verb differently, and a pattern
 * that will not load costs the page its prose rather than the whole page.
 */
async function declaredVerbProseFor(
  loadPattern: () => Promise<any>,
  callableName: string,
): Promise<DeclaredVerbProse | undefined> {
  try {
    return declaredVerbProse(await loadPattern()).get(callableName);
  } catch {
    return undefined;
  }
}

/**
 * One verb's declared event contract, read through the piece's compiled
 * pattern — `handlerVerbEvents` narrowed to a single name, on the same terms
 * `declaredVerbResult` states: one matcher, so nothing can attribute the
 * stream differently here than in a listing.
 *
 * This is the surface that keeps reference markers: the schema a dispatch
 * cell carries went through link sanitization, which strips every `asCell`
 * entry but `stream` — see `CallableResolution.declaredEvent` for the full
 * statement. A pattern that will not load costs the call its address
 * conversion, not the call.
 */
async function declaredVerbEventFor(
  loadPattern: () => Promise<any>,
  callableName: string,
): Promise<JSONSchema | undefined> {
  try {
    return handlerVerbEvents(await loadPattern()).get(callableName);
  } catch {
    return undefined;
  }
}

/**
 * Enumerate every callable a piece exposes (verb contract: Verb discovery,
 * docs/plans/pattern-verb-contract.md). Nothing listed is hidden from a
 * caller — hiding is a display default driven by the listing marks
 * (`tier: "wrapper"`, `deprecated: true`), never a capability boundary: the
 * rows carry the marks, `partitionVerbListing` decides the default view, and
 * `--all` shows the full surface.
 *
 * The listing is read from the compiled pattern the piece is pinned to and
 * from nothing else — `verbsFromCompiledPattern` states the rules — so it
 * is a statement about that pattern: what it declares and what it wires. No
 * cell of the piece is read, and the cost of a listing does not depend on
 * what the piece holds.
 *
 * The listing degrades rather than fails, and reports the degradation on
 * `incomplete` rather than absorbing it: without the pattern there is no
 * source of names at all, and an empty list presented as the whole surface
 * is the failure this command exists to avoid.
 */
export async function listPieceCallables(
  config: PieceConfig,
  deps: PieceCallableDependencies = {},
): Promise<PieceCallablesListing> {
  const { piece } = await timeCliPhase(
    "listPieceCallables.loadPiece",
    () =>
      loadPieceForCallables(config, deps, {
        prepareDispatch: false,
      }),
  );
  return (await timeCliPhase(
    "listPieceCallables.list",
    () => listCallablesForLoadedPiece(piece),
  )).listing;
}

/**
 * Every verb a compiled pattern exposes, read from the pattern alone: its
 * declared result type, its result graph, and its declared argument type. No
 * cell is read, so a listing costs what loading the pattern costs, whatever
 * the piece holds.
 *
 * A result-side name is a verb on one of three grounds, each a statement the
 * pattern makes about itself:
 *
 * - the declared result type marks the property a stream, or a tool;
 * - the result graph wires a handler node's `$event` to the property, which
 *   is the same stream written twice in the pattern's own terms
 *   (`handlerVerbEvents`) — the only source of a handler the declared result
 *   type omits;
 * - the result graph holds a tool at the property, inline as `patternTool`
 *   builds one — the only source of a tool the declared type omits.
 *
 * A name meeting none of these is data, whatever else the pattern hangs at
 * it. An argument-side name is a verb when the declared argument type marks
 * it a stream; a result-side row shadows an argument-side one of the same
 * name, as `cf piece call` resolves the result cell first.
 *
 * A declared row serves the declared event type as its input schema and the
 * property's own prose and marks. A row the declared type omits serves the
 * handler module's event contract (`handlerVerbEvents`), or a tool's argument
 * schema less the parameters it binds, and carries no prose — nothing
 * declared it. A handler's declared result rides its node
 * (`handlerVerbResults`); a tool's rides the tool itself.
 *
 * Rows sort by byte order, not locale collation: this is a machine-readable
 * surface and must sort identically on every host.
 */
export function verbsFromCompiledPattern(
  pattern: {
    argumentSchema?: unknown;
    resultSchema?: unknown;
    result?: unknown;
    nodes?: unknown;
  },
): PieceCallableListing[] {
  const listings = new Map<string, PieceCallableListing>();
  const declaredResult = declaredProperties(pattern.resultSchema);
  const graph = isObjectOrArray(pattern.result)
    ? pattern.result as Record<string, unknown>
    : {};
  const handlerEvents = handlerVerbEvents(pattern);
  const handlerResults = handlerVerbResults(pattern);

  const resultNames = new Set([
    ...Object.keys(declaredResult?.properties ?? {}),
    ...Object.keys(graph),
  ]);
  for (const name of resultNames) {
    const property = declaredResult?.properties[name];
    const declared = isObjectOrArray(property)
      ? property as Record<string, unknown>
      : undefined;
    // The stream marker sits on the property itself, beside its `$ref`; the
    // tool shape may sit behind the reference, so that one is asked of the
    // resolved definition.
    const resolved = declared !== undefined && declaredResult !== undefined &&
        typeof declared.$ref === "string"
      ? resolveCfcSchemaRefs(declared, declaredResult.root)
      : declared;
    const wired = graph[name];
    if (
      isPatternToolSchema(resolved as JSONSchema) || isPatternToolValue(wired)
    ) {
      const tool = isPatternToolValue(wired)
        ? wired as {
          pattern: { argumentSchema?: JSONSchema; resultSchema?: JSONSchema };
          extraParams: unknown;
        }
        : undefined;
      const outputSchema = tool?.pattern.resultSchema;
      listings.set(name, {
        name,
        kind: "tool",
        on: "result",
        inputSchema: tool === undefined ? true : cloneWithoutBoundToolKeys(
          tool.pattern.argumentSchema ?? true,
          isObjectNotArray(tool.extraParams) ? tool.extraParams : {},
        ),
        ...(outputSchema !== undefined ? { outputSchema } : {}),
        ...(declared !== undefined ? declaredVerbAnnotations(declared) : {}),
      });
      continue;
    }
    const declaredStream = declared !== undefined && declaresStream(declared);
    if (!declaredStream && !handlerEvents.has(name)) continue;
    const outputSchema = handlerResults.get(name);
    listings.set(name, {
      name,
      kind: "handler",
      on: "result",
      inputSchema: declaredStream && declaredResult !== undefined
        ? declaredVerbInput(declared, declaredResult.root)
        : handlerEvents.get(name) ?? true,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(declared !== undefined ? declaredVerbAnnotations(declared) : {}),
    });
  }

  const declaredArgument = declaredProperties(pattern.argumentSchema);
  if (declaredArgument !== undefined) {
    for (
      const [name, property] of Object.entries(declaredArgument.properties)
    ) {
      if (listings.has(name)) continue;
      if (!isObjectOrArray(property)) continue;
      const declared = property as Record<string, unknown>;
      if (!declaresStream(declared)) continue;
      listings.set(name, {
        name,
        kind: "handler",
        on: "input",
        inputSchema: declaredVerbInput(declared, declaredArgument.root),
        ...declaredVerbAnnotations(declared),
      });
    }
  }

  return [...listings.values()].sort((a, b) => utf8Compare(a.name, b.name));
}

/**
 * The listing of an already-loaded piece, returning the compiled pattern it
 * consulted beside the listing itself. Held apart from `listPieceCallables`
 * so `describePiece` can share one piece load — and one pattern read — with
 * the verbs listing instead of performing both twice. `compiled` is null
 * exactly when the listing is `incomplete`: the two degrade together, off
 * the same failed read.
 */
async function listCallablesForLoadedPiece(piece: any): Promise<{
  listing: PieceCallablesListing;
  compiled: { argumentSchema?: unknown; resultSchema?: unknown } | null;
}> {
  // The authored source reference and the compiled pattern are independent
  // storage closures. Start both reads together: on a cold CLI process either
  // can dominate, and serializing them adds their latencies for no benefit.
  const patternRef = typeof piece.getPatternRef === "function"
    ? timeCliPhase(
      "listPieceCallables.patternRef",
      () => piece.getPatternRef(),
    ).then((value) => value ?? null).catch(() => null)
    : Promise.resolve(null);

  // The compiled pattern is the listing's one source. Unlike the identity
  // above, it is not advisory, and the listing says so when it is missing.
  // `getPattern` throws on a piece carrying no pattern identity and on one
  // whose pattern source will not load in this space — both states in which
  // stored callables and the stream fallback remain reachable. So the listing
  // must not fail: it would refuse to describe a
  // piece it can still drive, to tab-completion and to an agent that could
  // have acted on the answer. What it must not do either is present an empty
  // list as the surface, which is what `incomplete` prevents.
  const compiledRead = typeof piece.getPattern === "function"
    ? timeCliPhase(
      "listPieceCallables.pattern",
      // Discovery wants the pattern alone; the default projection would
      // load every document the result schema reaches (a board's index).
      () => piece.getPattern({ projectResult: false }),
    ).then((value) => value ?? null).catch(() => null)
    : Promise.resolve(null);
  const [pattern, compiledPattern] = await Promise.all([
    patternRef,
    compiledRead,
  ]);
  return {
    listing: {
      pattern,
      ...(compiledPattern === null
        ? { incomplete: "pattern-unavailable" as const }
        : {}),
      verbs: compiledPattern === null
        ? []
        : verbsFromCompiledPattern(compiledPattern),
    },
    compiled: compiledPattern,
  };
}

/**
 * `cf piece describe` on one piece load: the NAME cell, the callable listing,
 * and the compiled pattern's two schemas, assembled by
 * `buildPieceDescription` into the piece's documentation.
 *
 * The display name is advisory the way the pattern identity is: a piece with
 * no NAME cell, or one whose read fails, is still described — the header
 * degrades, never the command.
 */
export async function describePiece(
  config: PieceConfig,
  deps: PieceCallableDependencies = {},
): Promise<PieceDescription> {
  const { piece } = await loadPieceForCallables(config, deps, {
    prepareDispatch: false,
  });
  const { listing, compiled } = await listCallablesForLoadedPiece(piece);
  let name: string | undefined;
  try {
    // A real PieceController was built from getPieceCell(), whose document
    // sync already brought the NAME field local. Pulling that field opens a
    // second storage watch and repeats work just to read one advisory string.
    // Keep the cell fallback for injected adapters that predate name().
    const value = await timeCliPhase(
      "describePiece.name",
      () => {
        if (typeof piece.name === "function") return piece.name();
        const pieceCell = typeof piece.getCell === "function"
          ? piece.getCell()
          : undefined;
        const nameCell = pieceCell?.key?.(NAME);
        return typeof nameCell?.pull === "function"
          ? nameCell.pull()
          : nameCell?.get?.();
      },
    );
    if (typeof value === "string" && value !== "") name = value;
  } catch {
    // Unnamed is a state, not a failure.
  }
  return buildPieceDescription({ name, listing, compiled });
}

/**
 * The command spec a help page is rendered from: the resolved one, plus what
 * only the declaring pattern can say — the verb's declared result, its own
 * prose, and the prose on the event fields the page renders as flags.
 *
 * Only a handler's resolution carries the thunks, so a tool's spec passes
 * through untouched and `callableCommandSpec` keeps deciding what a tool
 * publishes — its result schema rides its callable cell and is already on the
 * spec.
 *
 * The served `inputSchema` stays the authority on shape. It is the document a
 * payload is validated against, and only its `description` annotations are
 * filled in here, so a page can never describe a flag the dispatch would
 * refuse.
 */
async function withDeclaredPatternDocs(
  spec: ExecCommandSpec,
  resolved: ResolvedPieceCallable,
): Promise<ExecCommandSpec> {
  const [declared, prose] = await Promise.all([
    resolved.declaredResult?.(),
    resolved.declaredProse?.(),
  ]);
  const inputSchema = withDeclaredFieldProse(
    spec.inputSchema,
    prose?.eventSchema,
  );
  return {
    ...spec,
    ...(declared !== undefined && { outputSchemaSummary: declared }),
    ...(prose?.description !== undefined && { description: prose.description }),
    ...(inputSchema !== spec.inputSchema &&
      { inputSchema: inputSchema as JSONSchema }),
  };
}

export async function executePieceCallable(
  config: PieceConfig,
  callableName: string,
  rawArgs: string[],
  deps: PieceCallableDependencies = {},
): Promise<ExecutedPieceCallable> {
  const resolved = await resolvePieceCallable(
    config,
    callableName,
    deps,
  );
  // The mount that was invoked, named once: the verb's help page and a
  // refusal about the verb's own section both reprint the command a caller
  // typed, and printing two spellings of it would be two answers to the same
  // question.
  const commandPrefix = deps.helpCommandPrefix ??
    cliCommand(["piece", "call", "...", callableName]);
  return await executeResolvedPieceCallable(
    resolved,
    rawArgs,
    deps,
    commandPrefix,
  ).catch((error) => {
    // The address the caller wrote names the holder of the link, so a
    // refusal that sends them to the verb listing carries the piece whose
    // verb it was.
    if (
      error instanceof VerbInputValidationError &&
      resolved.linkedPiece !== undefined
    ) error.linkedPiece = resolved.linkedPiece;
    throw error;
  });
}

/**
 * Helper for {@link executePieceCallable}, which parses the verb's section
 * and dispatches on the callable already resolved.
 */
async function executeResolvedPieceCallable(
  resolved: ResolvedPieceCallable,
  rawArgs: string[],
  deps: PieceCallableDependencies,
  commandPrefix: string,
): Promise<ExecutedPieceCallable> {
  return await executeCallableCommand({
    resolved,
    execution: resolved,
    commandSpec: resolved.commandSpec,
    rawArgs,
    deps,
    sectionPrefix: commandPrefix,
    renderHelp: async (commandSpec, parsed) => {
      // Help pulls the declared documentation through the resolver's shared
      // pattern load. `--help --json` serves the declared result as
      // `outputSchema` and the prose as `description`; the text page lists
      // the result's fields and prints the prose as its summary line.
      const spec = await withDeclaredPatternDocs(commandSpec, resolved);
      return parsed.showHelpJson
        ? renderExecHelpJson(spec)
        // Each mount passes its own spelling, so the page names the command
        // that was typed; `commandPrefix` above holds the fallback for a page
        // minted with no mount to name.
        : renderPieceCallHelp(commandPrefix, spec);
    },
  });
}

/**
 * Points the target piece's `targetPath` at the value `sourcePath` names on
 * the source piece, so the target reads the source rather than holding a copy
 * of what it said.
 *
 * Both endpoints must have a pattern and their paths must have values unless
 * `options.allowNonExisting` is set. A target piece's current input schema must
 * select the target path regardless of that flag.
 */
export async function linkPieces(
  config: SpaceConfig,
  sourcePieceId: string,
  sourcePath: (string | number)[],
  targetPieceId: string,
  targetPath: (string | number)[],
  options?: {
    start?: boolean;
    allowNonExisting?: boolean;
    sourceScope?: PieceConfig["pieceScope"];
    targetScope?: PieceConfig["pieceScope"];
  },
  deps: PieceResolutionDeps = {},
): Promise<void> {
  const pieces = await timeCliPhase(
    "linkPieces.loadPieces",
    () => (deps.loadPieces ?? loadPieces)(config),
  );
  const source = await timeCliPhase(
    "linkPieces.resolveSource",
    () =>
      resolveLinkEndpointAddress(
        pieces,
        sourcePieceId,
        sourcePath,
        deps,
        { allowMissingSlugFallback: true },
      ),
  );
  const target = await timeCliPhase(
    "linkPieces.resolveTarget",
    () => resolveLinkEndpointAddress(pieces, targetPieceId, targetPath, deps),
  );
  // Both halves name the piece the walk reached rather than the token that
  // reached it: an address naming a collection's member checks its path on
  // the member, and a message pairing that path with the collection's name
  // would describe a read nobody made. The scope travels with each half for
  // the same reason — it says which instance of that id the link named.
  const resolvedSourcePieceId = source.piece;
  const resolvedSourcePath = source.pathAfter;
  const resolvedSourceScope = source.scope ?? options?.sourceScope;
  const resolvedTargetPieceId = target.piece;
  const resolvedTargetPath = target.pathAfter;
  const resolvedTargetScope = target.scope ?? options?.targetScope;

  // Validate that source and target pieces/paths exist by reading them
  if (!options?.allowNonExisting) {
    const errors: string[] = [];

    // Check source piece exists by verifying it has a pattern cell
    // (i.e., was created via cf piece new, not just written to with cf cell set)
    const sourcePiece = await timeCliPhase(
      "linkPieces.getSourcePiece",
      () =>
        pieces.get(
          resolvedSourcePieceId,
          false,
          undefined,
          resolvedSourceScope,
        ),
    );
    const sourceHasPattern =
      getPatternIdentityRef(sourcePiece.getCell()) !== undefined;
    if (!sourceHasPattern) {
      errors.push(
        `Source piece ${resolvedSourcePieceId} does not have pattern`,
      );
    } else if (resolvedSourcePath.length > 0) {
      const sourceData = await timeCliPhase(
        "linkPieces.readSourceResult",
        () => sourcePiece.result.get(),
      );
      // Check source path resolves
      let current: any = sourceData;
      for (const segment of resolvedSourcePath) {
        if (!isObjectOrArray(current)) {
          errors.push(
            `Source path "${
              resolvedSourcePath.join("/")
            }" does not exist on piece ${resolvedSourcePieceId}`,
          );
          break;
        }
        current = current[segment];
      }
      if (current === undefined) {
        errors.push(
          `Source path "${
            resolvedSourcePath.join("/")
          }" does not exist on piece ${resolvedSourcePieceId}`,
        );
      }
    }

    // Check target piece exists by verifying it has a pattern cell
    const targetPiece = await timeCliPhase(
      "linkPieces.getTargetPiece",
      () =>
        pieces.get(
          resolvedTargetPieceId,
          false,
          undefined,
          resolvedTargetScope,
        ),
    );
    const targetHasPattern =
      getPatternIdentityRef(targetPiece.getCell()) !== undefined;
    if (!targetHasPattern) {
      errors.push(
        `Target piece ${resolvedTargetPieceId} does not have pattern`,
      );
    } else if (resolvedTargetPath.length > 0) {
      // Schema refusal takes precedence over the overridable absence check.
      // The write repeats this check against metadata in its own transaction.
      try {
        assertPieceInputPath(
          await targetPiece.input.getCell(),
          resolvedTargetPath,
        );
      } catch (error) {
        if (error instanceof PieceInputPathError) {
          throw new LinkValidationError(error.message);
        }
        throw error;
      }
      const targetData = await timeCliPhase(
        "linkPieces.readTargetInput",
        () => targetPiece.input.get(),
      );
      let current: unknown = targetData;
      for (const segment of resolvedTargetPath) {
        if (!isObjectOrArray(current)) {
          current = undefined;
          break;
        }
        current = (current as Record<string | number, unknown>)[segment];
      }
      if (current === undefined) {
        errors.push(
          `Target path "${
            resolvedTargetPath.join("/")
          }" does not exist on piece ${resolvedTargetPieceId}`,
        );
      }
    }

    if (errors.length > 0) {
      throw new LinkValidationError(
        errors.join("\n") + "\n\nUse --allow-non-existing to link anyway.",
      );
    }
  }

  try {
    await timeCliPhase(
      "linkPieces.link",
      () =>
        pieces.link(
          resolvedSourcePieceId,
          resolvedSourcePath,
          resolvedTargetPieceId,
          resolvedTargetPath,
          {
            ...options,
            ...(resolvedSourceScope === undefined
              ? {}
              : { sourceScope: resolvedSourceScope }),
            ...(resolvedTargetScope === undefined
              ? {}
              : { targetScope: resolvedTargetScope }),
          },
        ),
    );
  } catch (error) {
    if (error instanceof PieceInputPathError) {
      throw new LinkValidationError(error.message);
    }
    throw error;
  }
  noteWroteTo(config.space);
}

/**
 * Phase 7: link a pattern field to an injected on-disk SQLite source
 * (`cf piece link sqlite:<absPath> <piece>/<field>`, read-only v1). Derives a
 * stable handle id from (space, absPath), settles the handle cell at that id,
 * registers the on-disk source with the server (so reads attach the file
 * read-only for that id), then links the handle into the target field.
 *
 * What the handle cell ends up holding is `diskHandleSeed`'s decision, made
 * against whatever is already there. A first link seeds the empty contract
 * `{ id, tables: {}, rev: 0 }`. A RE-link — the same path, so the same handle
 * id (same cell, same registration) — leaves a handle whose `id` is already
 * the derived one exactly as it stands, contract included, and says on stderr
 * how many tables it kept. A handle whose stored `id` is missing, empty, or
 * names a different source is unusable and gets REPAIRED: the id is rewritten,
 * a declared contract is carried onto it rather than dropped (labels may only
 * strengthen), and the repair is reported on stderr when it carried one. v1 is
 * read-only — `db.exec` against an injected source is rejected by the server
 * (Q13/Q14).
 */
export async function linkSqliteDiskSource(
  config: SpaceConfig,
  absPath: string,
  targetPieceId: string,
  targetPath: (string | number)[],
  options?: { start?: boolean; targetScope?: CellScope },
  deps: PieceOperationDependencies = {},
): Promise<void> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const space = pieces.getSpace();
  const id = deriveDiskHandleId(space, absPath);

  // 1. Seed the handle cell AT the deterministic id. Its entity id == its
  //    value.id == the server registry key, so a pattern read of the linked
  //    handle resolves to the id the server holds a disk descriptor for.
  //    `diskHandleSeed` decides whether to write at all: a first link seeds an
  //    empty contract, and a RE-link leaves a committed handle alone rather
  //    than lowering labels someone has since declared on it. The sync is what
  //    makes that decision see a handle this process has not loaded.
  const handle = pieces.runtime.getCellFromEntityId(
    space,
    entityIdFrom(id),
    [],
    undefined,
  );
  await handle.sync();
  let kept: DiskHandleValue | undefined;
  let repaired: DiskHandleValue | undefined;
  const writeRes = await pieces.runtime.editWithRetry((tx) => {
    const target = handle.withTx(tx);
    const prior = target.get() as DiskHandleValue | undefined;
    const seed = diskHandleSeed(id, prior);
    if (seed !== undefined) target.set(seed);
    kept = seed === undefined ? prior : undefined;
    // A first link seeds an empty contract, so a written seed that carries
    // tables can only be a contract this repair brought across from a handle
    // whose own `id` was unusable.
    repaired = seed !== undefined && Object.keys(seed.tables ?? {}).length > 0
      ? seed
      : undefined;
  });
  if (writeRes.error) throw writeRes.error;
  if (repaired !== undefined) {
    // The same reporting obligation as the kept-contract warning below, for
    // the same reason: the contract now sitting on this handle was declared
    // against a handle that named something else, so its per-column labels may
    // describe a different database. Keeping it is the monotone-safe direction
    // and still worth saying out loud.
    const tables = Object.keys(repaired.tables ?? {}).length;
    console.warn(
      `cf piece link: repaired an unusable handle id, keeping the existing ` +
        `contract, ${tables} ${tables === 1 ? "table" : "tables"}`,
    );
  }
  if (kept !== undefined) {
    // Say so. Keeping the contract is right — its per-column `ifc` may only
    // strengthen — but the file on disk can have moved on since someone
    // declared it, and a schema kept silently is the same unreported state the
    // clobber this replaced used to produce, pointing the other way.
    const tables = Object.keys(kept.tables ?? {}).length;
    console.warn(
      `cf piece link: kept the existing contract, ${tables} ` +
        `${tables === 1 ? "table" : "tables"} (re-linking does not reset it)`,
    );
  }
  // The handle is committed, so the space has been written to whether or not
  // the registration and link below succeed.
  noteWroteTo(config.space);

  // 2. Register the on-disk source with the server (read-only attach for `id`).
  const provider = pieces.runtime.storageManager.open(space);
  if (!provider.registerSqliteDiskSource) {
    throw new Error(
      "storage provider does not support injected sqlite disk sources",
    );
  }
  await provider.registerSqliteDiskSource(id, absPath);

  // 3. Link the handle (addressed by entity id) into the target field.
  const resolvedTarget = await resolveLinkEndpointAddress(
    pieces,
    targetPieceId,
    targetPath,
    deps,
  );
  await pieces.link(id, [], resolvedTarget.piece, resolvedTarget.pathAfter, {
    start: options?.start,
    targetScope: resolvedTarget.scope ?? options?.targetScope,
  });
  await pieces.synced();
}

export class LinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkValidationError";
  }
}

// Constants for piece mapping
const SHORT_ID_LENGTH = 8;

// Types for piece mapping
export interface PieceConnection {
  name: string;
  readingFrom: string[];
  readBy: string[];
}

export type PieceConnectionMap = Map<string, PieceConnection>;

// Helper functions for piece mapping
function createShortId(id: string): string {
  if (id.length <= SHORT_ID_LENGTH * 2 + 3) {
    return id; // Don't truncate if it's already short enough
  }
  const start = id.slice(0, SHORT_ID_LENGTH);
  const end = id.slice(-SHORT_ID_LENGTH);
  return `${start}...${end}`;
}

function createPieceConnection(
  piece: { id: string; name?: string },
  details?: {
    name?: string;
    readingFrom: Array<{ id: string }>;
    readBy: Array<{ id: string }>;
  },
): PieceConnection {
  return {
    name: details?.name || piece.name || createShortId(piece.id),
    readingFrom: details?.readingFrom.map((c) => c.id) || [],
    readBy: details?.readBy.map((c) => c.id) || [],
  };
}

async function buildConnectionMap(
  config: SpaceConfig,
): Promise<PieceConnectionMap> {
  const pieces = await listPieces(config);
  const connections: PieceConnectionMap = new Map();

  for (const piece of pieces) {
    const pieceConfig: PieceConfig = { ...config, piece: piece.id };
    try {
      const details = await inspectPiece(pieceConfig);
      connections.set(piece.id, createPieceConnection(piece, details));
    } catch (error) {
      // Skip pieces that can't be inspected, but include them with no connections
      console.error(
        `Warning: Could not inspect piece ${piece.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      connections.set(piece.id, createPieceConnection(piece));
    }
  }

  return connections;
}

function generateAsciiMap(connections: PieceConnectionMap): string {
  if (connections.size === 0) {
    return "No pieces found in space.";
  }

  let output = "=== Piece Space Map ===\n\n";

  // Sort pieces by connection count for better visualization
  const sortedPieces = Array.from(connections.entries()).sort(
    ([, a], [, b]) =>
      b.readingFrom.length +
      b.readBy.length -
      (a.readingFrom.length + a.readBy.length),
  );

  for (const [id, info] of sortedPieces) {
    const shortId = createShortId(id);
    output += `📦 ${info.name} [${shortId}]\n`;

    if (info.readingFrom.length > 0) {
      output += "  ← reads from:\n";
      for (const sourceId of info.readingFrom) {
        const sourceName = connections.get(sourceId)?.name ||
          createShortId(sourceId);
        output += `    • ${sourceName}\n`;
      }
    }

    if (info.readBy.length > 0) {
      output += "  → read by:\n";
      for (const targetId of info.readBy) {
        const targetName = connections.get(targetId)?.name ||
          createShortId(targetId);
        output += `    • ${targetName}\n`;
      }
    }

    if (info.readingFrom.length === 0 && info.readBy.length === 0) {
      output += "  (no connections)\n";
    }

    output += "\n";
  }

  return output;
}

function generateDotMap(connections: PieceConnectionMap): string {
  let dot = "digraph PieceSpace {\n";
  dot += "  rankdir=LR;\n";
  dot += "  node [shape=box];\n\n";

  // Add nodes
  for (const [id, info] of connections) {
    const shortId = createShortId(id);
    dot += `  "${id}" [label="${info.name}\\n${shortId}"];\n`;
  }
  dot += "\n";

  // Add edges
  for (const [id, info] of connections) {
    for (const targetId of info.readingFrom) {
      dot += `  "${targetId}" -> "${id}";\n`;
    }
  }

  dot += "}";
  return dot;
}

export enum MapFormat {
  ASCII = "ascii",
  DOT = "dot",
}

export function formatSpaceMap(
  connections: PieceConnectionMap,
  format: MapFormat,
): string {
  switch (format) {
    case MapFormat.ASCII:
      return generateAsciiMap(connections);
    case MapFormat.DOT:
      return generateDotMap(connections);
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

export async function generateSpaceMap(
  config: SpaceConfig,
  format: MapFormat = MapFormat.ASCII,
): Promise<string> {
  const connections = await buildConnectionMap(config);
  return formatSpaceMap(connections, format);
}

/**
 * A result field whose resolution crosses computed state. Each computed cell
 * holds what its last committed derivation produced, and reading the field
 * does not re-derive it, so either a terminal value or a cached choice of link
 * can describe an earlier instant than the current argument.
 */
export interface CachedResultField {
  /** The field's name on the piece's result. */
  name: string;

  /** The computed documents crossed while resolving the field's value. */
  cells: CachedResultCell[];
}

/** One computed document crossed while resolving a result field. */
export interface CachedResultCell {
  /** The computed entity's id. */
  id: string;

  /** The space whose commit sequence contains `derivedAtCommit`. */
  space: MemorySpace;

  /** The computed entity's memory scope. */
  scope: CellScope;

  /**
   * The commit the entity's document last stood at. Absent when the local
   * replica holds no confirmed version of that document.
   */
  derivedAtCommit?: number;
}

/**
 * The commit `link`'s document last stood at, read from the space's local
 * replica. Commit sequences are assigned per space, so two documents read from
 * one replica can be ordered against each other.
 */
function commitOfDocument(
  runtime: Runtime,
  link: { id: string; space: MemorySpace; scope: CellScope },
): number | undefined {
  const provider = runtime.storageManager.open(link.space);
  return provider.replica.get({
    id: link.id as NormalizedFullLink["id"],
    scope: link.scope,
  })?.since;
}

/**
 * Which fields of `result` resolve through a computed cell when read from
 * `resultCell`.
 *
 * The runtime's own link resolution supplies every dereference. A computed
 * document counts even when its cached value is another link and the terminal
 * entity is live: choosing that link was itself a derivation which can be
 * stale. Every id that is not a computed one counts as live, unknown URI
 * schemes included, which is the strict reading `entityKindOfIdString`
 * requires of its callers.
 */
export function cachedResultFields(
  resultCell: Cell<unknown>,
  result: Readonly<unknown>,
): CachedResultField[] {
  if (!isObjectNotArray(result)) return [];
  const runtime = resultCell.runtime;
  const tx = runtime.readTx();
  const cached: CachedResultField[] = [];
  for (const name of Object.keys(result)) {
    const start = resultCell.key(name).getAsNormalizedFullLink();
    const { link: resolved, traces } = resolveLinkTracingDereferences(
      runtime,
      tx,
      start,
    );
    const documents = [start, ...traces.map(({ target }) => target), resolved];
    const cells = new Map<string, CachedResultCell>();
    for (const document of documents) {
      if (entityKindOfIdString(document.id) !== "computed") continue;
      const key =
        `${document.space}\u0000${document.scope}\u0000${document.id}`;
      if (cells.has(key)) continue;
      const derivedAtCommit = commitOfDocument(runtime, document);
      cells.set(key, {
        id: document.id,
        space: document.space,
        scope: document.scope,
        ...(derivedAtCommit !== undefined && { derivedAtCommit }),
      });
    }
    if (cells.size > 0) {
      cached.push({ name, cells: [...cells.values()] });
    }
  }
  return cached;
}

/** What {@link inspectPiece} reports about one piece. */
export interface PieceInspection {
  id: string;
  name?: string;
  patternRef?: PiecePatternRef;
  source?: Readonly<unknown>;
  result: Readonly<unknown> | null | undefined;

  /**
   * The commit the argument document behind `source` last stood at. It can be
   * ordered against a {@link CachedResultCell} commit only when both have the
   * same `space`.
   */
  sourceCommit?: number;

  /** The space whose commit sequence contains `sourceCommit`. */
  sourceSpace?: MemorySpace;

  /** The fields of `result` whose resolution crosses a computed-cell cache. */
  cachedResultFields: CachedResultField[];

  readingFrom: Array<{ id: string; name?: string }>;
  readBy: Array<{ id: string; name?: string }>;
}

export async function inspectPiece(
  config: PieceConfig,
  deps: PieceOperationDependencies = {},
): Promise<PieceInspection> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  let resolvedConfig: PieceConfig;
  try {
    resolvedConfig = await resolvePieceConfigWithPieces(
      config,
      pieces,
      deps,
    );
  } catch (error) {
    if (
      error instanceof SlugResolutionError &&
      error.code === "not-piece" &&
      // The fallback reports the cell the slug itself points at, which is an
      // answer only where the address named the slug and nothing after it.
      // With a path, `not-piece` says the member that path selected is no
      // piece, and reporting the slug's own target would answer about
      // something the caller did not ask for.
      !config.piecePath?.length
    ) {
      return await inspectSlugTargetCell(pieces, config.piece);
    }
    throw error;
  }
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );

  const id = piece.id;
  const name = piece.name();
  const patternRef = await piece.getPatternRef();
  const source = (await piece.input.get()) as Readonly<unknown>;
  const result = (await piece.result.get()) as Readonly<unknown>;
  const readingFrom = (await piece.readingFrom()).map((piece) => ({
    id: piece.id,
    name: piece.name(),
  }));
  const readBy = (await piece.readBy()).map((piece) => ({
    id: piece.id,
    name: piece.name(),
  }));
  const resultCell = await piece.result.getCell();
  const inputCell = await piece.input.getCell();
  const runtime = resultCell.runtime;
  const sourceLink = resolveLink(
    runtime,
    runtime.readTx(),
    inputCell.getAsNormalizedFullLink(),
  );
  const sourceCommit = commitOfDocument(runtime, sourceLink);
  const cached = cachedResultFields(resultCell, result);

  return {
    id,
    name,
    patternRef,
    source,
    ...(sourceCommit !== undefined && { sourceCommit }),
    sourceSpace: sourceLink.space,
    result,
    cachedResultFields: cached,
    readingFrom,
    readBy,
  };
}

async function inspectSlugTargetCell(
  pieces: PiecesController,
  slug: string,
): Promise<PieceInspection> {
  const target = await resolveSlugTargetCell(pieces, slug);
  await target.pull();
  const result = target.get() as Readonly<unknown>;
  const name = isObjectOrArray(result) && typeof result[NAME] === "string"
    ? result[NAME]
    : undefined;
  const identityRef = getPatternIdentityRef(target);
  const patternRef: PiecePatternRef | undefined = identityRef === undefined
    ? undefined
    : {
      ...identityRef,
      source: {
        ref: formatFabricRef({
          ref: {
            kind: "uri",
            scheme: "pattern",
            hash: identityRef.identity,
          },
        }),
      },
    };

  return {
    id: slug,
    name,
    patternRef,
    result,
    cachedResultFields: cachedResultFields(target, result),
    readingFrom: [],
    readBy: [],
  };
}

/**
 * Returns the view a piece publishes — the `[UI]` node on its result cell —
 * or `undefined` where the piece publishes none.
 */
export async function getPieceView(
  config: PieceConfig,
  deps: PieceResolutionDeps = {},
): Promise<unknown> {
  const data = (await inspectPiece(config, deps)) as any;
  return data.result?.[UI] as VNode;
}

export function formatViewTree(view: unknown): string {
  const format = (node: unknown, prefix: string, last: boolean): string => {
    const branch = last ? "└─ " : "├─ ";
    if (!isVNodeLike(node)) {
      return `${prefix}${branch}${String(node)}`;
    }

    const children = Array.isArray(node.children) ? node.children : [];
    let output = `${prefix}${branch}${node.name}`;
    const nextPrefix = prefix + (last ? "   " : "│  ");
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      output += "\n" + format(child, nextPrefix, isLast);
    }
    return output;
  };

  return format(view, "", true);
}

/** A read path's last segment classified as a verb: the name, and whether
 * `cf piece call <name>` actually resolves it (root-level names only). */
interface ReadPathVerb {
  verb: string;
  callable: boolean;
}

/**
 * Classify a `cf cell get` path whose last segment CERTAINLY lands on a
 * verb. The guard refuses on two definite stored signals, both read off the
 * child by `detectCallableKind`: the link-derived schema declaring a stream
 * (`isHandlerCell` on the `asSchemaFromLinks` cell — that schema comes from
 * the stored links, never from a caller-supplied cast), and the stored value
 * being the retired `{ $stream: true }` sentinel, which `detectCallableKind`
 * reads through `getRaw()` until no stored document holds one. A stream's
 * document written since holds no value, so for it the schema is the whole
 * of what can say what it is. It
 * NEVER refuses on the forced-stream probe: the probe is deliberately
 * permissive for the dispatcher and the listing — over-inclusion there is an
 * extra listing row or a call the caller asked for — but the cast's stream
 * schema survives link resolution for inline values and schema-less links
 * (`resolveLink` keeps the caller's schema and `Cell.isStream`'s schema
 * branch answers from it), so a read guard built on it would refuse plain
 * data outputs. Reads fail open: a classification failure, an uncertain
 * shape, or a tool binding (readable data, exactly as the llm-dialog read
 * tool treats it) all read normally.
 *
 * `callable` is true only for root-level names — the dispatcher's resolution
 * paths all start at a root — so the refusal message can redirect honestly.
 */
async function classifyReadPathVerb(
  piece: any,
  prop: "input" | "result",
  path: readonly (string | number)[],
): Promise<ReadPathVerb | null> {
  const name = path.at(-1);
  // Verbs are named properties; a path-less read is the parent-object read,
  // which stays readable even when the object carries verbs.
  if (typeof name !== "string") return null;
  try {
    const rootCell = await piece[prop].getCell();
    const parentCell = path.length > 1
      ? rootCell.key(...path.slice(0, -1))
      : rootCell;
    const child = parentCell.key(name);
    const derived = child.asSchemaFromLinks?.() ?? child;
    // Both definite signals come off the child, which is where they live, and
    // `detectCallableKind` is where reading them for a link-derived cell is
    // already written down. What this guard adds is that only a handler
    // refuses: a tool binding is readable data and reads normally, so a
    // "tool" verdict falls through exactly as a null one does.
    //
    // The parent is never read, so this guard costs the same on a piece
    // holding a thousand rows as on an empty one. A projected parent could
    // not answer the question in any case: a verb reaches its parent as a
    // LINK, so a pluck out of one is a link payload and never the sentinel.
    if (detectCallableKind(undefined, derived) === "handler") {
      return { verb: name, callable: path.length === 1 };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Which of `keys`, directly under `addressedPath` on a piece's cell, stand at
 * a verb's dispatch surface. Each is decided the way {@link classifyReadPathVerb}
 * decides a read: from the child's link-derived schema, with nothing read at
 * the position, since a stream's document holds no value to read.
 *
 * This fails open the way the guard does: a key the classification fails on,
 * or a piece it cannot reach, yields no callables, and the listing shows each
 * key by what it holds. It runs beside a value read of the same cell that
 * has already succeeded, so what a failure here costs is an annotation and
 * never the listing.
 */
export async function listCallableKeys(
  config: PieceConfig,
  addressedPath: (string | number)[],
  keys: readonly string[],
  options: { input?: boolean } = {},
  deps: PieceOperationDependencies = {},
): Promise<ReadonlySet<string>> {
  const callables = new Set<string>();
  if (keys.length === 0) return callables;
  try {
    const pieces = await (deps.loadPieces ?? loadPieces)(config);
    const { config: resolvedConfig, path } = await resolvePieceTargetWithPieces(
      config,
      addressedPath,
      pieces,
      deps,
    );
    const piece = await (deps.loadPieceForRead ?? loadPieceForRead)(
      pieces,
      resolvedConfig.piece,
      false,
      resolvedConfig.pieceScope,
    );
    const rootCell = await piece[options.input ? "input" : "result"]
      .getCell();
    const parentCell = path.length > 0 ? rootCell.key(...path) : rootCell;
    for (const key of keys) {
      try {
        const child = parentCell.key(key);
        const derived = child.asSchemaFromLinks?.() ?? child;
        if (detectCallableKind(undefined, derived) === "handler") {
          callables.add(key);
        }
      } catch {
        // Not certainly a verb: the listing shows the key by what it holds.
      }
    }
  } catch {
    // The cell could not be reached for this read; see above.
  }
  return callables;
}

/**
 * The read-path guard's refusal, preferred over a result-projection failure.
 *
 * A verb is not a materializable result, so a read that lands on one fails the
 * projection check as a matter of course — and that error tells the caller to
 * retry with `--step`, which sends them to re-run a read that cannot succeed
 * at any number of steps. Classify before surrendering to the projection
 * error so the refusal naming `cf piece call` wins. Returns null when the path
 * is not certainly a verb, leaving the projection error exactly as it was.
 */
async function verbReadRefusalOrNull(
  piece: any,
  prop: "input" | "result",
  path: readonly (string | number)[],
  pieceId: string,
): Promise<PieceVerbReadError | null> {
  const verb = await classifyReadPathVerb(piece, prop, path);
  return verb
    ? new PieceVerbReadError(verb.verb, pieceId, verb.callable)
    : null;
}

/**
 * Return the effective CFC label view at one piece data path.
 *
 * Paths in the returned view are relative to the selected cell. The view
 * includes stored declared, derived, and link-carried labels and uses the same
 * display redaction as the runtime-client boundary.
 *
 * The path is followed through the links it crosses, so the answer describes
 * the doc that holds the value rather than the doc the path started in.
 */
export async function getCellCfcLabel(
  config: PieceConfig,
  addressedPath: (string | number)[],
  options: { input?: boolean } = {},
  deps: PieceOperationDependencies = {},
): Promise<CfcLabelView | null> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const { config: resolvedConfig, path } = await resolvePieceTargetWithPieces(
    config,
    addressedPath,
    pieces,
    deps,
  );
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  const rootCell =
    await (options.input ? piece.input.getCell() : piece.result.getCell());
  const targetCell = rootCell.key(...path);
  await targetCell.pull();
  return cfcLabelViewForCommand(targetCell, path);
}

/**
 * Update the declared CFC label at one piece data path.
 *
 * This updates the label through the same checked write path used by ordinary
 * runtime operations. The stored schema merge and CFC preparation rules
 * therefore reject changes that weaken confidentiality or strengthen
 * integrity. Raw label-map metadata is never written by the CLI.
 */
export async function setCellCfcLabel(
  config: PieceConfig,
  addressedPath: (string | number)[],
  input: unknown,
  options: { input?: boolean } = {},
  deps: PieceOperationDependencies = {},
): Promise<CfcLabelView | null> {
  const update = parseCellCfcLabelUpdate(input);
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const { config: resolvedConfig, path } = await resolvePieceTargetWithPieces(
    config,
    addressedPath,
    pieces,
    deps,
  );
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  const rootCell =
    await (options.input ? piece.input.getCell() : piece.result.getCell());
  const targetCell = rootCell.key(...path);
  await targetCell.pull();
  // The guard's "what classes already exist here" question is asked of the doc
  // the write lands in. Asked of the unresolved doc it was asked about a doc
  // the write never touches: the row doc's `observes` was invisible to it, so
  // the update silently REPLACED a value-class entry with a class-less one,
  // and the command returned null while having written a label.
  const currentView = cfcLabelViewForCommand(targetCell, path);
  const value = targetCell.getRaw();
  if (value === undefined) {
    const location = path.length === 0 ? "<root>" : path.join("/");
    throw new Error(`Cannot set a CFC label on absent path "${location}".`);
  }

  const { observes: requestedObserves, ...label } = update;
  const schemaIfc = isObjectOrArray(targetCell.schema) &&
      isObjectOrArray(targetCell.schema.ifc)
    ? targetCell.schema.ifc
    : undefined;
  const existingObservationClasses = new Set<
    LabelObservationClass | undefined
  >(
    currentView?.entries
      .filter((entry) => entry.path.length === 0)
      .map((entry) => entry.observes) ?? [],
  );
  if (schemaIfc !== undefined) {
    existingObservationClasses.add(
      CFC_LABEL_OBSERVATION_CLASSES.has(
          schemaIfc.observes as LabelObservationClass,
        )
        ? schemaIfc.observes as LabelObservationClass
        : undefined,
    );
  }
  if (
    requestedObserves === undefined && existingObservationClasses.size > 1
  ) {
    const location = path.length === 0 ? "<root>" : path.join("/");
    throw new Error(
      `Cannot preserve observes at "${location}": ` +
        "the effective label uses multiple observation classes.",
    );
  }
  const observes = requestedObserves ??
    (existingObservationClasses.size === 1
      ? existingObservationClasses.values().next().value
      : undefined);
  if (
    observes !== undefined &&
    (
      (schemaIfc !== undefined && schemaIfc.observes !== observes) ||
      currentView?.entries.some((entry) =>
        entry.path.length === 0 && entry.observes !== observes
      )
    )
  ) {
    const location = path.length === 0 ? "<root>" : path.join("/");
    throw new Error(
      `Cannot set observes to "${observes}" at "${location}": ` +
        "the effective label already uses a different observation class.",
    );
  }
  const tx = pieces.runtime.edit();
  targetCell.withTx(tx).asSchema({
    ifc: {
      ...label,
      ...(observes !== undefined ? { observes } : {}),
    },
  }).applyCfcSchemaToExistingValue();
  pieces.runtime.prepareTxForCommit(tx);
  const committed = await tx.commit();
  if (committed.error !== undefined) {
    throw new Error(
      `Could not set the CFC label at ${
        path.length === 0 ? "<root>" : path.join("/")
      }: ${committed.error.message}`,
    );
  }
  await pieces.synced();

  noteWroteTo(config.space);
  return cfcLabelViewForCommand(targetCell, path);
}

/** Resolve the canonical piece before the read selects its demand boundary. */
async function loadPieceForRead(
  pieces: PiecesController,
  id: string,
  step: boolean,
  scope: PieceConfig["pieceScope"],
): Promise<PieceController> {
  return new PieceController(
    pieces,
    await pieces.getPieceCell(id, step, undefined, scope),
  );
}

export async function getCellValue(
  config: PieceConfig,
  addressedPath: (string | number)[],
  options: GetCellValueOptions = {},
  deps: PieceOperationDependencies = {},
): Promise<unknown> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const { config: resolvedConfig, path } = await resolvePieceTargetWithPieces(
    config,
    addressedPath,
    pieces,
    deps,
  );
  const shouldStep = options.step === true;
  const piece = await timeCliPhase(
    "getCellValue.piece",
    () =>
      (deps.loadPieceForRead ?? loadPieceForRead)(
        pieces,
        resolvedConfig.piece,
        shouldStep,
        resolvedConfig.pieceScope,
      ),
  );

  try {
    if (shouldStep) {
      // A nested target pull is itself the demand and storage boundary for
      // the requested cell. Pulling the canonical piece first widens that
      // read to every result sibling, which defeats a path-scoped get. Keep
      // the whole-piece pull only for a path-less whole-result read.
      if (path.length === 0) {
        await timeCliPhase(
          "getCellValue.step.piece.pull",
          () => piece.getCell().pull(),
        );
      }
      const targetCell = options.input
        ? await piece.input.getCell(path)
        : (await piece.result.getCell()).key(...path);
      await timeCliPhase(
        "getCellValue.step.target.pull",
        () => targetCell.pull(),
      );
      await timeCliPhase(
        "getCellValue.step.synced.beforeIdle",
        () => pieces.synced(),
      );
      await timeCliPhase(
        "getCellValue.step.runtime.idle",
        () => pieces.runtime.idle(),
      );
      await timeCliPhase(
        "getCellValue.step.synced.afterIdle",
        () => pieces.synced(),
      );
    }

    const prop = options.input ? "input" : "result";
    if (options.selection !== undefined) {
      const selection = options.selection;
      const targetCell = options.input
        ? await piece.input.getCell(path)
        : (await piece.result.getCell()).key(...path);
      let selected: unknown;
      try {
        selected = await timeCliPhase(
          "getCellValue.selection",
          () =>
            (deps.deriveSelectedValue ?? deriveSelectedValue)(
              pieces.runtime,
              pieces.getSpace(),
              targetCell,
              selection,
            ),
        );
      } catch (error) {
        // The verb refusal wins over every selection error, not only the
        // "Cannot access path" family: a real `--filter` against a handler
        // fails inside the selector with a shape error that sends the caller
        // to their schema, when the answer is `cf piece call`. Classification
        // fails open, so an uncertain path keeps its original error.
        const verbRefusal = await verbReadRefusalOrNull(
          piece,
          prop,
          path,
          resolvedConfig.piece,
        );
        if (verbRefusal) throw verbRefusal;
        if (
          !options.input && error instanceof Error &&
          error.message.startsWith("Cannot access path") &&
          await resultProjectionFailedAtPath(piece, path)
        ) {
          throw new PieceResultProjectionError(path, shouldStep);
        }
        throw error;
      }
      // Read-path guard (verb contract WS-F): the selection path returns
      // early, so it needs the same verb refusal the plain read applies
      // below — a verb read through a selection is the same mistake.
      const selectionPathVerb = await classifyReadPathVerb(piece, prop, path);
      if (selectionPathVerb) {
        throw new PieceVerbReadError(
          selectionPathVerb.verb,
          resolvedConfig.piece,
          selectionPathVerb.callable,
        );
      }
      const sourceWasAbsent = typeof targetCell.getRaw === "function" &&
        targetCell.getRaw() === undefined;
      if (
        !options.input && selected === undefined &&
        await resultProjectionFailedAtPath(piece, path)
      ) {
        throw await verbReadRefusalOrNull(
          piece,
          prop,
          path,
          resolvedConfig.piece,
        ) ?? new PieceResultProjectionError(path, shouldStep);
      }
      if (selected === undefined && !sourceWasAbsent) {
        throw new CellSelectionError(
          "Cannot read selected value: the filter/schema expression did " +
            "not materialize a JSON-renderable value. This is not JSON " +
            "null. Retry with --step for a computed result, or inspect the " +
            "selected source data and schema.",
        );
      }
      return selected;
    }

    let value: unknown;
    try {
      value = await timeCliPhase(
        `getCellValue.${prop}.get`,
        () => piece[prop].get(path),
      );
    } catch (error) {
      if (
        !options.input && error instanceof Error &&
        error.message.startsWith("Cannot access path") &&
        await resultProjectionFailedAtPath(piece, path)
      ) {
        throw await verbReadRefusalOrNull(
          piece,
          prop,
          path,
          resolvedConfig.piece,
        ) ?? new PieceResultProjectionError(path, shouldStep);
      }
      throw error;
    }

    if (
      !options.input && value === undefined &&
      await resultProjectionFailedAtPath(piece, path)
    ) {
      throw await verbReadRefusalOrNull(
        piece,
        prop,
        path,
        resolvedConfig.piece,
      ) ?? new PieceResultProjectionError(path, shouldStep);
    }

    // Read-path guard (verb contract WS-F): a path that lands ON a verb would
    // return the stream's serialization — never what a caller wants — so it
    // refuses and redirects. Classified after the read so the piece's links
    // and schema are materialized locally.
    const verb = await classifyReadPathVerb(piece, prop, path);
    if (verb) {
      throw new PieceVerbReadError(
        verb.verb,
        resolvedConfig.piece,
        verb.callable,
      );
    }

    return value;
  } finally {
    if (shouldStep) {
      await pieces.stopPiece(resolvedConfig.piece);
    }
  }
}

/**
 * Where a {@link setCellValue} write landed: the piece it reached, and the
 * path inside that piece it was written at.
 */
export interface CellWriteTarget {
  /** The id of the piece written to. */
  piece: string;

  /** The path inside that piece, empty for a write at its root. */
  path: (string | number)[];
}

/**
 * Writes `value` at the path `addressedPath` resolves to on a piece's result
 * cell, or on its arguments cell under `options.input`, receipts the space
 * the write landed in, and reports where it landed.
 *
 * `options.refuseRootWrite` refuses a write whose resolved path is empty.
 * Only resolution can decide that: a slug naming a collection spends the
 * leading segments reaching the member, so an address carrying a path can
 * still reach a piece's root.
 */
export async function setCellValue(
  config: PieceConfig,
  addressedPath: (string | number)[],
  value: unknown,
  options?: { input?: boolean; refuseRootWrite?: boolean },
  deps: PieceResolutionDeps = {},
): Promise<CellWriteTarget> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const { config: resolvedConfig, path } = await resolvePieceTargetWithPieces(
    config,
    addressedPath,
    pieces,
    deps,
  );
  if (options?.refuseRootWrite && path.length === 0) {
    throw new ValidationError(pathRequiredRefusal(), { exitCode: 1 });
  }
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  if (options?.input) {
    await piece.input.set(value, path);
  } else {
    await piece.result.set(value, path);
  }
  noteWroteTo(config.space);
  return { piece: resolvedConfig.piece, path };
}

/**
 * What a {@link callPieceHandler} call supplies: the connection its
 * resolution runs over, and the three execution deps a handling can observe
 * through a call that returns nothing.
 *
 * Narrower than {@link PieceCallableDependencies} by the fields this path
 * cannot keep. The input readers and the help prefix have no bearing on it —
 * the payload arrives decoded as an argument, and nothing here renders a
 * page. The result-shaping deps are excluded for a sharper reason: a
 * selection makes the dispatch derive a value that this signature then
 * discards, so admitting one would spend a settle and a sync on an answer
 * nobody receives, and could raise where the handling itself committed
 * cleanly. A call that wants a result wants
 * {@link executePieceCallable}, which returns one.
 */
export type PieceHandlerCallDeps =
  & Pick<CallableExecutionDeps, "invocation" | "onPhase" | "skipReadback">
  & Pick<PieceCallableDependencies, "loadPieces" | "loadPiece">;

/**
 * Calls a named handler within a piece with a decoded JSON payload.
 *
 * A `deps.invocation` names the id and session the handling files its receipt
 * under; without one the dispatch takes a runtime-minted event id, and there
 * is no receipt to come back for.
 */
export async function callPieceHandler<T = any>(
  config: PieceConfig,
  handlerName: string,
  args: T,
  deps: PieceHandlerCallDeps = {},
): Promise<void> {
  const resolved = await timeCliPhase(
    "callPieceHandler.resolve",
    () => resolvePieceCallable(config, handlerName, deps),
  );
  if (resolved.callableKind !== "handler") {
    throw new Error(`Callable "${handlerName}" is not a handler`);
  }
  await timeCliPhase(
    "callPieceHandler.execute",
    () => executeResolvedCallable(resolved, args, deps),
  );
}

/**
 * Starts the piece `config` names and leaves it running, so that a later read
 * of a computed value is served by a pattern running in this process.
 *
 * It is what a long-lived caller reaches for where a one-shot command reaches
 * for {@link stepPiece}. The two differ in what they are for and so in what
 * they do around the start: a step exists to commit what recomputation
 * produced, so it pulls, settles, receipts the space and stops the piece
 * again; this one leaves the pattern running, writes nothing, and receipts
 * nothing, because starting a piece is not a write.
 *
 * `addressedPath` is the path the caller was aiming at, and what it decides is
 * which piece runs: a walk that reaches a collection's member spends the
 * leading segments getting there, so the member is what starts rather than the
 * holder it was addressed through. Whatever the walk did not spend is a path
 * inside the piece it reached, and warming a piece is not a read of a path, so
 * the remainder is left alone.
 *
 * The start is idempotent — `PiecesController.getPieceCell` says so of the
 * `runtime.start` it performs — so warming a piece already running costs the
 * resolution and the sync in front of it and nothing else. A caller that
 * remembers what it warmed skips even that, through
 * {@link WarmPieceDeps.alreadyRunning}, which is asked with the piece the
 * resolution reached rather than the path it was handed.
 *
 * @returns The piece the resolution reached, which is what a caller keys a
 * memo of warmed pieces on.
 *
 * @throws Error if the piece cannot be resolved, or if the pattern behind it
 * will not load in this space.
 */
export async function warmPiece(
  config: PieceConfig,
  addressedPath: (string | number)[] = [],
  deps: WarmPieceDeps = {},
): Promise<WarmedPiece> {
  const pieces = await timeCliPhase(
    "warmPiece.loadPieces",
    () => (deps.loadPieces ?? loadPieces)(config),
  );
  const { config: resolvedConfig } = await resolvePieceTargetWithPieces(
    config,
    addressedPath,
    pieces,
    deps,
  );
  // Asked after the resolution and not before it, because which piece runs is
  // the resolution's answer: a walk into a collection holder reaches a member,
  // and the caller's memo is over pieces rather than over the paths that
  // reach them.
  if (deps.alreadyRunning?.(resolvedConfig.piece) !== true) {
    await timeCliPhase(
      "warmPiece.getPiece",
      () =>
        pieces.get(
          resolvedConfig.piece,
          true,
          undefined,
          resolvedConfig.pieceScope,
        ),
    );
  }
  return { piece: resolvedConfig.piece };
}

/** What {@link warmPiece} started, or found already running. */
export interface WarmedPiece {
  /**
   * The piece, by the handle the resolution reached. It is what a caller
   * remembers a warm under: two paths into one collection holder reach two
   * members and two pieces, and two paths inside one piece reach one.
   */
  readonly piece: string;
}

/** What {@link warmPiece} reaches the world through. */
export interface WarmPieceDeps extends PieceResolutionDeps {
  /**
   * Whether the caller already started the piece the resolution reached, so
   * that the start is skipped.
   *
   * It is asked rather than told because the answer is only knowable here: the
   * caller has a path and this has the piece that path resolves to, and those
   * are different things wherever a collection is walked into. The start it
   * skips is idempotent either way — `PiecesController.getPieceCell` says so
   * of the `runtime.start` it performs — so what a wrong answer costs is a
   * repeat rather than a fault.
   */
  readonly alreadyRunning?: (piece: string) => boolean;
}

/** What {@link sinkCellValue} reads at each settled change. */
export interface CellSinkOptions {
  /**
   * Read the piece's arguments cell rather than its result, which is the
   * selection `getCellValue` makes on the same pair.
   */
  readonly input?: boolean;
}

/**
 * Subscribes to the cell `addressedPath` resolves to and calls `onSettled`
 * with its value once per quiet runtime, returning the function that cancels
 * the subscription.
 *
 * One logical change fires the underlying sink several times before the
 * reactive graph quiets, so what a caller would see without this is a value
 * part-way through a computation. The discipline is a reentrancy guard plus
 * `runtime.idle()`, which is `renderVDomToHtml`'s
 * (`lib/piece-render.ts`): a fire while a settle is outstanding is folded
 * into that settle, and the value is read after the runtime is quiet rather
 * than taken from the callback. Nothing here waits on a clock, so a runtime
 * that is slow is a runtime that is still computing.
 *
 * The bound on "once per quiet runtime" is what the guard can promise: two
 * changes that quiet separately are two calls, and two that arrive inside one
 * settle are one — so a caller is told what the cell holds at each quiet
 * point and not how many commits reached it. A settle that fails costs the
 * one report it was folding rather than every report after it, the guard
 * being cleared on that path too.
 *
 * The piece is not started. Starting it is the caller's decision and its own
 * act ({@link warmPiece}), because a caller that watches several cells of one
 * piece starts it once.
 *
 * @returns The cancel, which is idempotent and stops delivery at once: a
 * settle already outstanding when it runs reports nothing.
 *
 * @throws Error if the piece cannot be resolved, or if the pattern behind it
 * will not load in this space.
 */
export async function sinkCellValue(
  config: PieceConfig,
  addressedPath: (string | number)[],
  onSettled: (value: unknown) => void,
  options: CellSinkOptions = {},
  deps: PieceResolutionDeps = {},
): Promise<() => void> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const { config: resolvedConfig, path } = await resolvePieceTargetWithPieces(
    config,
    addressedPath,
    pieces,
    deps,
  );
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  // The path goes to `getCell`, which is not the same cell as keying into the
  // root. For a piece's arguments cell the path form asserts the path is
  // admitted by the input projection, reads its schema selection, and resolves
  // a conditional branch through the root (`PiecePropIo.getCell`,
  // `packages/piece`); the root keyed into reaches none of that. So a watch
  // and a read of one path would otherwise be about two different cells.
  const io = options.input ? piece.input : piece.result;
  const cell = await io.getCell(path) as Cell<unknown>;
  // Before the subscription, so the baseline is the value a read of this path
  // would serve. The first settle writes no line and is what every later
  // change is measured against, and `runtime.idle()` says the runtime is quiet
  // rather than that the document has arrived — so a baseline taken ahead of
  // the pull would be measured against whatever had loaded by then, and the
  // arrival would report as a change nobody made. `PiecePropIo.get` pulls the
  // selected cell before its own read (`packages/piece`), which is what makes
  // the two agree.
  await cell.pull();
  return settledSink(
    await readThrough(cell),
    () => pieces.runtime.idle(),
    onSettled,
  );
}

/**
 * Helper for {@link sinkCellValue}, which is the cell a read of the same path
 * reads its value through: the one behind an `asCell` handle where the slot
 * holds one, and the slot's own cell everywhere else.
 *
 * A path crossing an `asCell` field selects a cell whose value *is* a handle,
 * and what a read serves is what stands behind it (`PiecePropIo.get`,
 * `packages/piece`). A subscription on the outer cell fires when the handle
 * stored at the slot is replaced and at no other time, so a change to the
 * value behind it would settle nothing the caller could see — the watch and
 * the read would be about two different cells, which is the one thing they may
 * not be.
 *
 * The stored slot decides rather than the projection, and in that order: an
 * `asCell` projection materializes even an absent or explicitly undefined slot
 * as a `Cell`, so asking the projection first would follow a handle standing
 * for nothing. That is the order the read takes for the same reason.
 */
async function readThrough(cell: Cell<unknown>): Promise<Cell<unknown>> {
  if (cell.getRaw() === undefined) return cell;
  const held = cell.get();
  if (!isCell(held)) return cell;
  await held.pull();
  return held as Cell<unknown>;
}

/**
 * Helper for {@link sinkCellValue}, which is the settling half of it: the
 * sink on `cell`, the guard that folds a fire arriving during a settle into
 * that settle, and the read `idle` gates.
 *
 * It is separate from the resolution above it because the two are driven by
 * different things — the resolution by a connection, this by the reactive
 * graph — and only this one has an ordering worth exhibiting on its own.
 *
 * The guard is cleared in the same synchronous stretch as the read, so no
 * fire lands unreported between the two.
 */
function settledSink(
  cell: Cell<unknown>,
  idle: () => Promise<void>,
  onSettled: (value: unknown) => void,
): () => void {
  let settling = false;
  let cancelled = false;
  const cancelSink = cell.sink(() => {
    if (settling || cancelled) return;
    settling = true;
    idle().then(() => {
      settling = false;
      // Read after the settle rather than taking the value the sink was
      // handed: a cell passes through states that exist only until the
      // scheduler drains, and the callback's value can be one of them.
      if (!cancelled) onSettled(cell.get());
    }, () => {
      settling = false;
    });
  });
  return () => {
    if (cancelled) return;
    cancelled = true;
    cancelSink();
  };
}

export async function stepPiece(
  config: PieceConfig,
  deps: PieceResolutionDeps = {},
): Promise<void> {
  const pieces = await timeCliPhase(
    "stepPiece.loadPieces",
    () => (deps.loadPieces ?? loadPieces)(config),
  );
  const resolvedConfig = await resolvePieceConfigWithPieces(
    config,
    pieces,
    deps,
  );
  const piece = await timeCliPhase(
    "stepPiece.getPiece",
    () =>
      pieces.get(
        resolvedConfig.piece,
        true,
        undefined,
        resolvedConfig.pieceScope,
      ),
  );
  await timeCliPhase("stepPiece.pull", () => piece.getCell().pull());
  await timeCliPhase("stepPiece.synced", () => pieces.synced());
  // A step exists to run the pattern and commit what recomputation
  // produced, so the synced state above is the write the receipt follows.
  noteWroteTo(config.space);
  await timeCliPhase(
    "stepPiece.stop",
    () => pieces.stopPiece(resolvedConfig.piece),
  );
}

/**
 * Removes a piece from the space.
 */
export async function removePiece(
  config: PieceConfig,
  deps: PieceResolutionDeps = {},
): Promise<void> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(
    config,
    pieces,
    deps,
  );
  const removed = await pieces.remove(resolvedConfig.piece);

  if (!removed) {
    throw new Error(`Piece "${config.piece}" not found`);
  }
  noteWroteTo(config.space);
}

interface RootPatternDeps {
  loadPieces?: typeof loadPieces;
}

/**
 * Recreate the default/root pattern for an explicitly targeted space.
 */
export async function recreateSpaceRootPattern(
  config: SpaceConfig,
  deps: RootPatternDeps = {},
): Promise<string> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const piece = await pieces.recreateDefaultPattern();
  noteWroteTo(config.space);
  return piece.id;
}

function isVNodeLike(value: unknown): value is VNode {
  const visited = new Set<object>();
  while (isObjectOrArray(value) && UI in value) {
    if (visited.has(value)) return false; // Cycle detected
    visited.add(value);
    value = value[UI];
  }
  return (value as VNode)?.type === "vnode";
}

/**
 * Deploy a custom home pattern from a local file.
 * Automatically targets the home space (user's identity DID).
 */
export async function setHomePattern(
  config: Omit<SpaceConfig, "space">,
  entry: EntryConfig,
  deps: PieceOperationDependencies = {},
): Promise<void> {
  const identity = await (deps.loadIdentity ?? loadIdentity)(config.identity);
  const homeConfig: SpaceConfig = { ...config, space: identity.did() };
  const pieces = await (deps.loadPieces ?? loadPieces)(homeConfig);
  const program = await (deps.getProgramFromFile ?? getProgramFromFile)(
    pieces,
    entry,
  );
  await pieces.recreateDefaultPattern({
    customProgram: program,
    repository: entry.repository,
  });
  noteWroteTo(homeConfig.space);
}

/**
 * Reset the home pattern to the system default.
 */
export async function resetHomePattern(
  config: Omit<SpaceConfig, "space">,
): Promise<void> {
  const identity = await loadIdentity(config.identity);
  const homeConfig: SpaceConfig = { ...config, space: identity.did() };
  const pieces = await loadPieces(homeConfig);
  await pieces.recreateDefaultPattern();
  noteWroteTo(homeConfig.space);
}
