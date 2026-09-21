import type { CellScope } from "@commonfabric/api";
import {
  type EntityRef,
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import { homeSchema } from "@commonfabric/home-schemas";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import { isDID } from "@commonfabric/identity/did";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { setLLMUrl } from "@commonfabric/llm";
import type { CfcPosture } from "@commonfabric/runner";
import {
  applyPieceSourceTransition,
  type Cell,
  Console as RuntimeConsole,
  createSpaceRootIfAbsent,
  EntityId,
  entityIdFrom,
  type EntityIdListOptions,
  type EntityIdListResult,
  type EnvReader,
  type ExperimentalOptions,
  experimentalOptionsForDeployedClient,
  getEntityId,
  getMetaLink,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  getPatternSource,
  getPieceSourceSnapshot,
  idStringForEntityAddress,
  isCell,
  isLink,
  isStoredArgumentSchemaRefusal,
  isStream,
  type JSONSchema,
  KeepAsCell,
  type MemorySpace,
  type Module,
  type ModuleByteCache,
  normalizePatternSource,
  parseLink,
  type Pattern,
  type PatternCoverageCollector,
  PatternManager,
  type PatternSetupCommitReceipt,
  PatternSetupPostCommitError,
  type PieceSourceTransition,
  preparePieceSourceTransitionBaseline,
  Runtime,
  runtimePresets,
  RuntimeProgram,
  type Schema,
  setPatternRepository,
  setPatternSource,
  type SpaceCellContents,
} from "@commonfabric/runner";
import type {
  CfcConfClause,
  CfcEnforcementMode,
  CfcFlowLabelsMode,
  CfcReadOnExceed,
  CfcWriteFloorMode,
} from "@commonfabric/runner/cfc";
import {
  entityKindOfIdString,
  hashStringForEntityAddress,
} from "@commonfabric/runner/entity-kind";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import {
  type NameSchema,
  nameSchema,
  pieceListSchema,
  viewPieceSchema,
} from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { ensureNotRenderThread } from "@commonfabric/utils/env";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { prepareSourceClosureVerification } from "../../../runner/src/compilation-cache/cell-cache.ts";
import { getResultCellWithSourceSchema } from "../../../runner/src/piece-helpers.ts";
import { pieceId } from "../piece-id.ts";
// System space-root pattern refs, their derivation, and the source→URL
// resolution live in ../system-pattern-url.ts; re-exported here for existing
// importers.
import {
  DEFAULT_APP_PATTERN_SOURCE,
  deriveSystemPatternSource,
  HOME_PATTERN_SOURCE,
  patternSourceUrl,
} from "../system-pattern-url.ts";
import { isCfcMigrationRejection } from "./cfc-migration-rejection.ts";
import {
  assertSuppliedLinkSchemasCompatible,
  assertWritablePiecePath,
  PieceController,
} from "./piece-controller.ts";
import {
  assertPieceInputPath,
  PieceInputPathError,
} from "./piece-input-path.ts";
import { reconcilePieceSource } from "./piece-origin.ts";
import { compileProgram } from "./utils.ts";
export {
  DEFAULT_APP_PATTERN_SOURCE,
  deriveSystemPatternSource,
  HOME_PATTERN_SOURCE,
};

ensureNotRenderThread();

const PIECE_TRACE_TIMINGS = typeof Deno !== "undefined" &&
  Deno.env.get("CF_CLI_TRACE_TIMINGS") === "1";

/**
 * What opening a piece does beyond resolving its cell.
 *
 * `reconcile` rolls a stored source forward to the origin it follows, keeping
 * a followed root current. `start` runs the pattern, which materializes
 * everything its result reaches.
 *
 * They are separable because they are wanted separately: a caller that
 * RENDERS a piece needs both, while a caller that reads what a piece
 * exported needs the value it reads to be current without paying to run it.
 * A boolean asks for both or neither.
 */
export type PieceOpen = { reconcile: boolean; start: boolean };

const normalizePieceOpen = (open: boolean | PieceOpen): PieceOpen =>
  typeof open === "boolean" ? { reconcile: open, start: open } : open;

// Timing stats record even while the logger is disabled, so every phase is
// visible in the load summaries (browser worker included, where the
// CF_CLI_TRACE_TIMINGS console path cannot run) as `piece/phase/<label>`.
const pieceTimingLogger = getLogger("piece", { enabled: false });
const pieceUpdateLogger = getLogger("piece.update", {
  enabled: true,
  level: "warn",
});

async function timePiecePhase<T>(
  label: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    pieceTimingLogger.time(start, "phase", label);
    if (PIECE_TRACE_TIMINGS) {
      const elapsed = Math.round(performance.now() - start);
      console.error(`[piece-phase] ${elapsed}ms :: ${label}`);
    }
  }
}

/**
 * Filters an array of pieces by removing any that match the target cell
 */
function filterOutCell(
  list: Cell<Cell<unknown>[]>,
  target: Cell<unknown>,
): Cell<unknown>[] {
  const resolvedTarget = target.resolveAsCell();
  return list.get().filter((piece) =>
    !piece.resolveAsCell().equals(resolvedTarget)
  );
}

// This module can load outside Deno (browser-safe storage import above), so
// env reads are guarded like PIECE_TRACE_TIMINGS: absent env ⇒ defaults.
const readEnv: EnvReader = (key) =>
  typeof Deno !== "undefined" ? Deno.env.get(key) : undefined;

export interface PiecesControllerOptions {
  deferSpaceCellSync?: boolean;
}

export interface CreatePieceOptions {
  input?: object;
  repository?: string;
  origin?: string;
  start?: boolean;
}

/**
 * The space-level surface for pieces: the registry, the pieces themselves, and
 * the space's default root pattern. One instance serves one space.
 */
export class PiecesController<T = unknown> {
  #session: Session;

  #space: MemorySpace;

  #spaceCell: Cell<SpaceCellContents>;

  #diagnosticConsole: RuntimeConsole;

  /**
   * Promise resolved when the controller is ready.
   */
  ready: Promise<void>;

  constructor(
    session: Session,
    public runtime: Runtime,
    options: PiecesControllerOptions = {},
  ) {
    this.#session = session;
    this.#diagnosticConsole = new RuntimeConsole(runtime.harness);
    this.#space = this.#session.space;

    // Use the space DID as the cause - it's derived from the space name
    // and consistently available everywhere
    const isHomeSpace = this.#space === this.runtime.userIdentityDID;
    this.#spaceCell = isHomeSpace
      ? this.runtime.getHomeSpaceCell()
      : this.runtime.getSpaceCell(this.#space);

    const syncSpaceCellContents = options.deferSpaceCellSync
      ? Promise.resolve()
      : Promise.resolve(this.#spaceCell.sync());

    // The piece registry is managed by the default pattern, not directly on
    // the space cell. The space cell only contains a link to defaultPattern.
    // Default pattern creation is handled by ensureDefaultPattern(), which is
    // called by CLI/shell entry points. Construction doesn't auto-create it.
    this.ready = syncSpaceCellContents.then(() => {});
  }

  /**
   * Connects a client to one space of a deployed API and returns a controller
   * over it. The server is asked for its health before any of the space is
   * read, so an unreachable API fails here rather than as a stream of absent
   * reads, and a space this identity may not open fails with the server's own
   * authorization error. A connection that does not complete takes its socket
   * and its replica down with it.
   *
   * A pattern that reaches the LLM reaches this deployment's service.
   */
  static async initialize(
    {
      apiUrl,
      identity,
      space,
      deferSpaceCellSync,
      experimental,
      moduleByteCache,
      patternCoverage,
      navigateCallback,
      onPatternInstantiated,
      cfcEnforcementMode,
      cfcFlowLabels,
      cfcPosture,
      cfcWriteFloor,
      cfcReadMaxConfidentiality,
      cfcReadOnExceed,
    }: {
      apiUrl: URL | string;
      identity: Identity;

      /** The space to open, as a `did:key:` DID or as a space name. */
      space: string;

      /**
       * Open the space's session without syncing the space cell's contents. A
       * caller that reaches pieces by id, and never reads the space record,
       * does not need those contents.
       *
       * Defaults to `false` here: `initialize` syncs the space cell before it
       * returns. The CLI's `loadPieces` defaults the same option to `true`,
       * so a caller moving between the two surfaces should pass it
       * explicitly rather than carry one default across to the other.
       */
      deferSpaceCellSync?: boolean;

      /**
       * The experimental posture the controller's runtime runs under. Absent,
       * it is the deployment's own, with this process's explicit
       * `EXPERIMENTAL_*` winning per flag (`experimentalOptionsForDeployedClient`).
       * A caller that had to know the posture before opening the session — a
       * host that decides something on it, a test that states the arm it
       * exercises — passes what it resolved, so the runtime runs the posture
       * the caller checked rather than a second resolution that may differ
       * from it.
       */
      experimental?: ExperimentalOptions;

      // Optional compiled-module-byte cache to share across controllers. Supplied
      // only by test code (see the integration suite's compile-byte-cache helper);
      // unset in production, so no cache is installed.
      moduleByteCache?: ModuleByteCache;
      // Collect statement coverage for the patterns this controller compiles.
      // Test/CI only. Beyond the coverage itself, this decides which cached
      // variant the pieces it creates are stored under, so a browser collecting
      // coverage against the same space warm-loads them instead of recompiling
      // every pattern for itself.
      patternCoverage?: PatternCoverageCollector;
      // Optional navigation enactment surface (the remoteClient preset's
      // existing delta): test code passes one to observe navigateTo
      // enactments — under EXPERIMENTAL_SERVER_EXECUTION the
      // client-effect channel enacts served intents through it
      // (server-execution v2 Phase 4, protocol.md §5).
      navigateCallback?: Parameters<
        typeof runtimePresets.remoteClient
      >[0]["navigateCallback"];
      // Optional instantiation observer, passed to the remoteClient preset: a
      // host that must know which patterns this controller materialized, and
      // under which pointer, supplies one. Observation only — the runtime runs
      // the same either way — and unset means the runtime tells nobody.
      onPatternInstantiated?: Parameters<
        typeof runtimePresets.remoteClient
      >[0]["onPatternInstantiated"];
      // Host-controlled CFC rollout dials, passed through to the remoteClient
      // preset; unset means the preset's first-party posture.
      cfcEnforcementMode?: CfcEnforcementMode;
      cfcFlowLabels?: CfcFlowLabelsMode;
      // Named CFC posture bundle for this controller's runtime (the
      // remoteClient preset's `cfcPosture` opt-in); the dials above and below
      // still apply over it.
      cfcPosture?: CfcPosture;
      cfcWriteFloor?: CfcWriteFloorMode;
      // The runtime-wide read ceiling for this controller's session (the
      // remoteClient preset's host-controlled pair): every `db.query` the
      // session issues reads under it, and a query's own ceiling only
      // tightens it. Under server execution the session declares it to the
      // space server, whose runtime reads under it for the session's runs.
      cfcReadMaxConfidentiality?: readonly CfcConfClause[];
      cfcReadOnExceed?: CfcReadOnExceed;
    },
  ): Promise<PiecesController> {
    const api = new URL(apiUrl);
    setLLMUrl(api.toString());
    const session = await createSession(
      isDID(space)
        ? { identity, spaceDid: space }
        : { identity, spaceName: space },
    );
    const storageManager = StorageManager.open({
      as: session.as,
      memoryHost: api,
      spaceIdentity: session.spaceIdentity,
    });
    // Shared first-party posture for client runtimes against a deployed API
    // (CT-1814); the CFC pin this site previously restated lives in the
    // preset core. Trust provenance stays a visible delta of this controller.
    // Unless the caller states them, the flags come from the deployment
    // itself, this process's explicit EXPERIMENTAL_* still winning per flag —
    // a controller opened by a cf binary or a fuse mount is not built
    // alongside the server it talks to
    // (docs/development/EXPERIMENTAL_OPTIONS.md).
    // Constructed inside the cleanup scope: a runtime the constructor
    // refuses (a malformed read ceiling, say)
    // still leaves the storage manager open, and the enabler state the
    // constructor claimed, unless the same teardown runs for it.
    let runtime: Runtime | undefined;
    try {
      runtime = new Runtime(runtimePresets.remoteClient({
        apiUrl: api,
        storageManager,
        experimental: experimental ??
          await experimentalOptionsForDeployedClient({
            apiUrl: api,
            env: readEnv,
          }),
        moduleByteCache,
        patternCoverage,
        ...(cfcEnforcementMode !== undefined ? { cfcEnforcementMode } : {}),
        ...(cfcFlowLabels !== undefined ? { cfcFlowLabels } : {}),
        ...(cfcPosture !== undefined ? { cfcPosture } : {}),
        ...(cfcWriteFloor !== undefined ? { cfcWriteFloor } : {}),
        ...(cfcReadMaxConfidentiality !== undefined
          ? { cfcReadMaxConfidentiality }
          : {}),
        ...(cfcReadOnExceed !== undefined ? { cfcReadOnExceed } : {}),
        ...(navigateCallback !== undefined ? { navigateCallback } : {}),
        ...(onPatternInstantiated !== undefined
          ? { onPatternInstantiated }
          : {}),
        trustSnapshotProvider: () => ({
          id: `principal:${session.as.did()}`,
          actingPrincipal: session.as.did(),
        }),
      }));
      if (!await runtime.healthCheck()) {
        throw new Error(`Could not connect to "${api.toString()}".`);
      }
      const pieces = new PiecesController(session, runtime, {
        deferSpaceCellSync,
      });
      // Opening the space's session is what turns a permanent denial into an
      // error: the per-space status below is written while the session opens,
      // and `synced()` stays quiet about a denial so that a denied cross-space
      // link can stay a silent absent read.
      await pieces.ensureSpaceSession();
      if (!deferSpaceCellSync) await pieces.synced();
      const denial = storageManager.authorizationError?.(session.space);
      if (denial) throw denial;
      return pieces;
    } catch (error) {
      // Tear the half-built connection down. `closeNow()` drops the replica and
      // its socket without waiting on a server that may be the reason this
      // failed, and `dispose()` takes the rest of the runtime with it. The
      // error that started the teardown is the one that leaves.
      await storageManager.closeNow().catch(() => {});
      await runtime?.dispose().catch(() => {});
      throw error;
    }
  }

  getSpace(): MemorySpace {
    return this.#space;
  }

  getSpaceName(): string | undefined {
    return this.#session.spaceName;
  }

  async synced(): Promise<void> {
    await this.ready;
    return await this.runtime.storageManager.synced();
  }

  async ensureSpaceSession(): Promise<void> {
    await this.ready;
    await this.runtime.storageManager.open(this.#space).ensureSession?.();
  }

  async listEntityIds(): Promise<string[] | undefined> {
    await this.ready;
    return await this.runtime.storageManager.open(this.#space)
      .listEntityIds?.();
  }

  async listEntityIdPage(
    options: EntityIdListOptions = {},
  ): Promise<EntityIdListResult | undefined> {
    await this.ready;
    return await this.runtime.storageManager.open(this.#space)
      .listEntityIdPage?.(
        options,
      );
  }

  /**
   * Whether this space's identifier index holds the entity `id` addresses,
   * without reading what it holds there. `undefined` where the server does not
   * advertise the lookup, which is neither a yes nor a no.
   *
   * The address takes either spelling of an unkinded entity, as
   * {@link PiecesController.getPieceCell} takes one. Both spellings are in
   * circulation here: a registered piece reports its own id as the bare tagged
   * hash, and the index keys on the `of:` id over it, so an address read back
   * off a listing asks about the piece that listing named.
   */
  async entityIdExists(id: string): Promise<boolean | undefined> {
    await this.ready;
    return await this.runtime.storageManager.open(this.#space).entityIdExists?.(
      idStringForEntityAddress(id),
    );
  }

  getSpaceCellContents(): Cell<SpaceCellContents> {
    return this.#spaceCell;
  }

  async dispose() {
    await this.runtime.dispose();
  }

  /**
   * Link the default pattern cell to the space cell.
   * This should be called after the default pattern is created.
   * @param defaultPatternCell - The cell representing the default pattern
   */
  async linkDefaultPattern(
    defaultPatternCell: Cell<any>,
  ): Promise<void> {
    const { error } = await this.runtime.editWithRetry((tx) => {
      const spaceCellWithTx = this.#spaceCell.withTx(tx);
      spaceCellWithTx.key("defaultPattern").set(defaultPatternCell.withTx(tx));
    });
    if (error) {
      throw new Error(
        `Linking the default pattern failed because storage returned ${error.name}: ${error.message}`,
        { cause: error },
      );
    }
    await this.runtime.idle();
  }

  /**
   * Clears the defaultPattern link from the space cell.
   * Used when the default pattern is being deleted.
   */
  async unlinkDefaultPattern(): Promise<void> {
    const { error } = await this.runtime.editWithRetry((tx) => {
      const spaceCellWithTx = this.#spaceCell.withTx(tx);
      spaceCellWithTx.key("defaultPattern").set(undefined);
    });
    if (error) {
      throw new Error(
        `Unlinking the default pattern failed because storage returned ${error.name}: ${error.message}`,
        { cause: error },
      );
    }
    await this.runtime.idle();
  }

  /**
   * Get the default pattern cell from the space cell.
   * @returns The default pattern cell, or undefined if not set
   */
  async getDefaultPattern(
    open: boolean | PieceOpen = true,
  ): Promise<Cell<NameSchema> | undefined> {
    const { reconcile, start } = normalizePieceOpen(open);
    const cell = await timePiecePhase(
      "getDefaultPattern.spaceCell.sync",
      () => this.#spaceCell.key("defaultPattern").sync(),
    );
    const defaultPattern = cell.get();
    if (!defaultPattern) {
      return undefined;
    }

    await timePiecePhase(
      "getDefaultPattern.defaultPattern.sync",
      () => defaultPattern.sync(),
    );
    if (
      defaultPattern.getRaw() === undefined &&
      getPatternIdentityRef(defaultPattern) === undefined
    ) {
      return undefined;
    }
    try {
      return await timePiecePhase(
        `getDefaultPattern.get(reconcile=${reconcile},start=${start})`,
        () =>
          this.getPieceCell(
            defaultPattern,
            { reconcile, start },
            nameSchema,
          ),
      );
    } catch (error) {
      // An unopenable root takes every consumer down with it — piece registry
      // listings, `cf piece ls`, FUSE, the shell's list cells all resolve the
      // root HERE. Opening it already reconciled it against its origin, so a
      // start that still failed is not out of date; the one remaining rescue
      // is for a root that records no origin at all and whose stored pattern
      // this runtime cannot load. Roll that one forward to the space's
      // official system root and retry the start ONCE. Every other failure
      // rethrows untouched.
      if (!start) throw error;
      let healed: Cell<NameSchema>;
      try {
        const root = await this.getPieceCell(defaultPattern, false, nameSchema);
        const pinnedRef = getPatternIdentityRef(root);
        if (pinnedRef === undefined || !this.#rootNeedsRollForward(root)) {
          throw error;
        }
        if (
          await this.runtime.patternManager.loadPatternByIdentity(
            pinnedRef.identity,
            pinnedRef.symbol,
            this.#space,
          ) !== undefined
        ) throw error;
        healed = await this.#healDefaultRootByRollForward(
          root,
          pinnedRef,
          error,
          "unloadable",
        );
      } catch {
        throw error;
      }
      pieceUpdateLogger.warn("default-root-healed-on-load-failure", () => [
        "getDefaultPattern: start failed, the root rolled forward to the",
        `space's official system root; retrying start once (${this.#space})`,
      ]);
      try {
        await this.runtime.idle();
        return await timePiecePhase(
          "getDefaultPattern.get(retry-after-heal)",
          () => this.getPieceCell(healed, { reconcile, start }, nameSchema),
        );
      } catch (retryError) {
        pieceUpdateLogger.warn("default-root-heal-retry-failed", () => [
          "getDefaultPattern: post-heal retry failed; surfacing the",
          `original start failure (${this.#space})`,
          retryError,
        ]);
        throw error;
      }
    }
  }

  /**
   * Whether a root that cannot be started may be replaced with the space's
   * official system root.
   *
   * A root qualifies when it records no origin, and when it already follows
   * that same official source — a root pinned to an export of it that this
   * runtime cannot load reaches the identity the source advertises but not a
   * runnable pattern, and rolling it forward changes no source. A root
   * following anything else has an owner's choice behind it, and replacing its
   * source with the system default would discard that choice rather than
   * repair anything.
   *
   * A by-identity load probe is the evidence this rests on, and with CFC
   * enforcement disabled that probe reports every artifact outside the
   * in-memory index as absent, so it proves nothing there.
   */
  #rootNeedsRollForward(root: Cell<NameSchema>): boolean {
    if (this.runtime.cfcEnforcementMode === "disabled") return false;
    const origin = getPatternSource(root);
    return origin === undefined ||
      origin === deriveSystemPatternSource(this.#space, this.runtime);
  }

  /** The root's `pieceRegistry` export, addressed but not yet synced. */
  #pieceRegistryExport(root: Cell<NameSchema>): Cell<Cell<unknown>[]> {
    const cell = root.asSchema({
      type: "object",
      properties: {
        pieceRegistry: pieceListSchema,
      },
    });
    return cell.key("pieceRegistry") as Cell<Cell<unknown>[]>;
  }

  /**
   * Get the cell containing the registered pieces in this space.
   * This is the discovery root, not a list of every stored piece root. Reads
   * the default pattern's pieceRegistry export.
   *
   * Stored writable registries and server-executed registries can be read
   * without running the root locally. A locally computed registry needs its
   * root active and its derivation demanded before its value is current.
   * When computed IDs are disabled, local readers conservatively activate
   * the root because an untagged export can also be derived.
   *
   * Reconcile before reading so a stale root is healed. Starting is also the
   * fallback when the root has no stored registry or its passive open fails.
   */
  async getPieceRegistry(): Promise<Cell<Cell<unknown>[]>> {
    // Reconcile without starting so stored exports can be inspected without
    // materializing the root's result graph.
    let passiveError: unknown;
    let passiveRoot: Cell<NameSchema> | undefined;
    try {
      passiveRoot = await this.getDefaultPattern({
        reconcile: true,
        start: false,
      });
    } catch (error) {
      passiveError = error;
      pieceUpdateLogger.warn("passive-registry-open-failed", () => [
        "getPieceRegistry: passive default-root open failed; retrying with start",
        error,
      ]);
    }
    if (passiveRoot) {
      // Registry callers keep a live handle across edits. Canonical-address
      // inspection must not pin it to the root lookup's read transaction.
      const exported = this.#pieceRegistryExport(passiveRoot).withTx();
      await this.syncPieces(exported);
      // `pieceListSchema` carries `default: []`, so a root that never
      // exported a registry and a root whose registry is empty read the same
      // way through the schema. Inspect the raw value before choosing whether
      // the root needs to supply or refresh its export.
      const needsLocalDerivation =
        this.runtime.experimental.serverExecution !== true &&
        (this.runtime.experimental.computedCellIds === false ||
          entityKindOfIdString(
              exported.resolveAsCell().getAsNormalizedFullLink().id,
            ) === "computed");
      if (exported.getRaw() !== undefined && !needsLocalDerivation) {
        return exported;
      }
    }

    // The running path supplies missing exports and refreshes local derivations.
    // If both opens fail, retain both causes so the passive failure is not
    // hidden by the fallback.
    let defaultPattern: Cell<NameSchema> | undefined;
    try {
      defaultPattern = await this.getDefaultPattern(true);
    } catch (error) {
      if (passiveError !== undefined) {
        throw new AggregateError(
          [passiveError, error],
          `Could not open the piece registry for space ${this.#space}`,
        );
      }
      throw error;
    }
    if (!defaultPattern) {
      if (passiveError !== undefined) throw passiveError;
      // Return empty array cell if no default pattern. Loud on purpose: any
      // subscription made against this placeholder never fires again, so a
      // cold-cache miss here silently freezes piece listings (e.g. FUSE).
      console.warn(
        `getPieceRegistry: no default pattern found for space ${this.#space}; ` +
          "returning detached empty piece list",
      );
      return this.runtime.getCell(this.#space, "empty-pieces", pieceListSchema);
    }

    const pieceRegistry = this.#pieceRegistryExport(defaultPattern);
    const stop = pieceRegistry.sink(() => {});
    try {
      await this.syncPieces(pieceRegistry);
      await this.synced();
      return pieceRegistry;
    } finally {
      stop();
    }
  }

  /** Return the piece registry, not every stored piece root. */
  async getRegisteredPieces() {
    const piecesCell = await this.getPieceRegistry();
    const pieces = await this.syncPieces(piecesCell);
    return pieces.map((piece) => {
      const target = piece.resolveAsCell();
      const space = target.getAsNormalizedFullLink().space;
      const controller = space === this.#space ? this : new PiecesController(
        { as: this.#session.as, space },
        this.runtime,
        { deferSpaceCellSync: true },
      );
      return new PieceController(controller, target.asSchema(undefined));
    });
  }

  async add(newPieces: Cell<unknown>[]): Promise<void> {
    const defaultPattern = await timePiecePhase(
      "add.getDefaultPattern",
      () => this.getDefaultPattern(true),
    );
    if (!defaultPattern) {
      throw new Error("Cannot add pieces: default pattern not available");
    }

    const cell = defaultPattern.asSchema({
      type: "object",
      properties: {
        addPiece: { asCell: ["stream"] },
      },
    });

    const addPieceHandler = await cell.key("addPiece").pull();
    if (!isStream(addPieceHandler)) {
      throw new Error(
        "Cannot add pieces: addPiece handler not found on default pattern",
      );
    }

    const registry = this.#pieceRegistryExport(defaultPattern);
    // A handler's commit updates composition. Keep the derived registry
    // demanded until its readback and persistence complete as well.
    const stop = this.runtime.experimental.computedCellIds === false ||
        entityKindOfIdString(
            registry.resolveAsCell().getAsNormalizedFullLink().id,
          ) === "computed"
      ? registry.sink(() => {})
      : () => {};
    try {
      // Send each piece and wait for transaction commit.
      // The onCommit callback fires both on success AND when retries are
      // exhausted (scheduler.ts ~line 2089). We check tx.status() to
      // distinguish the two — otherwise pieces are silently dropped.
      // Retries are handled by the scheduler internally.
      for (const piece of newPieces) {
        await timePiecePhase(
          "add.send",
          () =>
            new Promise<void>((resolve, reject) => {
              addPieceHandler.send({ piece }, (tx) => {
                const txStatus = tx.status();
                if (txStatus.status === "error") {
                  console.error(
                    "Piece registration failed: addPiece transaction error:",
                    txStatus.error,
                  );
                  reject(
                    new Error(
                      "Piece registration failed: addPiece transaction aborted after retries",
                    ),
                  );
                } else {
                  resolve();
                }
              });
            }),
        );
      }

      await timePiecePhase("add.runtime.idle", () => this.runtime.idle());
      await timePiecePhase("add.synced", () => this.synced());
      const registered = await this.syncPieces(registry);
      await this.synced();
      for (const piece of newPieces) {
        if (
          !registered.some((member) =>
            member.resolveAsCell().equalLinks(piece.resolveAsCell())
          )
        ) {
          throw new Error(
            "The addPiece handler committed without registering the piece",
          );
        }
      }
    } finally {
      stop();
    }
  }

  /**
   * Syncs the piece list held in `cell`. `pieceListSchema` gives its items no
   * shape — they are `unknown` — so neither the value the caller receives nor
   * the query behind it has anywhere to descend inside a piece, and no field a
   * piece labels is ever selected. `asCell` alone would not be enough for
   * that: it bounds the runtime's own walk, while the memory query walks
   * through it.
   */
  syncPieces(cell: Cell<Cell<unknown>[]>) {
    return cell.asSchema(pieceListSchema).pull();
  }

  /**
   * Resolve a piece to its canonical result cell, optionally starting it.
   * In view-scoped mode, the narrow root watch demands server execution;
   * mounted renderers own local graph registration and deeper replication.
   */
  async getPieceCell<S extends JSONSchema = JSONSchema>(
    id: string | Cell<unknown>,
    open: boolean | PieceOpen,
    asSchema: S,
    scope?: CellScope,
  ): Promise<Cell<Schema<S>>>;
  async getPieceCell<T = unknown>(
    id: string | Cell<unknown>,
    open?: boolean | PieceOpen,
    asSchema?: JSONSchema,
    scope?: CellScope,
  ): Promise<Cell<T>>;
  async getPieceCell<T = unknown>(
    id: string | Cell<unknown>,
    open: boolean | PieceOpen = false,
    asSchema?: JSONSchema,
    scope?: CellScope,
  ): Promise<Cell<T>> {
    const { reconcile, start } = normalizePieceOpen(open);
    // Get the piece cell
    const addressed: Cell<unknown> = isCell(id)
      ? id
      : this.runtime.getCellFromEntityId(
        this.#space,
        entityIdFrom(id),
        [],
        undefined,
        undefined,
        scope,
      );
    const viewScoped = this.runtime.viewScopedReplicationRequested &&
      await this.runtime.viewReplication.enable(addressed.space);

    // Load the addressed cell. Syncing a value-link "slot" address also loads
    // its link target — the piece's canonical result cell — together with that
    // cell's `argument`/`patternIdentity` meta, because the query follows the
    // top-of-doc value link and returns the target's meta docs. So this one sync
    // makes both the slot and the canonical cell (with its metadata) local.
    await timePiecePhase(
      "get.piece.sync",
      () =>
        (viewScoped ? addressed.asSchema(viewPieceSchema) : addressed).sync(),
    );

    // Canonicalize the value-link "slot" to the piece's canonical result cell.
    // A piece created inside a handler and stored into a list/object (e.g. the
    // topics board's `addTopic` doing `topics.push(Topic({...}))`) is addressed
    // by a plain value-link that redirects to the result cell, where setup wrote
    // `patternIdentity` and the `argument` meta-link. start() needs that identity
    // and reads need that metadata, so resolving here makes start / read / stop
    // operate on the real piece rather than the wrapper. The sync above already
    // made the canonical cell local, so this resolves over local links with no
    // further sync. Idempotent for a normal top-level piece.
    let piece = addressed.resolveAsCell();

    if (reconcile && !viewScoped) {
      const outcome = await timePiecePhase(
        "get.reconcileSource",
        () => reconcilePieceSource(this.runtime, piece),
      );
      if (outcome === "updated") {
        // The transition committed through a transaction view, and the caller
        // may have handed us a cell bound to a read transaction older than it.
        // Detach and resync, or a start below loads the identity the origin
        // just replaced — and reads through the returned cell describe it.
        piece = await piece.withTx().sync();
      }
    }
    if (start && !viewScoped) {
      // start() handles pattern loading and running. It's idempotent - no
      // effect if already running.
      await timePiecePhase(
        "get.runtime.start",
        () => this.runtime.start(piece),
      );
    }

    // If caller provided a schema, use it
    if (asSchema) {
      return piece.asSchema<T>(asSchema);
    }

    if (viewScoped) return piece.asSchema<T>(viewPieceSchema);

    // Otherwise, recover the result schema from the cell's metadata if present.
    return getResultCellWithSourceSchema(piece as Cell<T>);
  }

  async get<S extends JSONSchema = JSONSchema>(
    pieceId: string,
    runIt: boolean,
    schema: S,
    scope?: CellScope,
  ): Promise<PieceController<Schema<S>>>;
  async get<T = unknown>(
    pieceId: string,
    runIt?: boolean,
    schema?: JSONSchema,
    scope?: CellScope,
  ): Promise<PieceController<T>>;
  async get(
    pieceId: string,
    runIt: boolean = false,
    schema?: JSONSchema,
    scope?: CellScope,
  ): Promise<PieceController> {
    const cell = await (await this.getPieceCell(pieceId, runIt, schema, scope))
      .sync();
    return new PieceController(this, cell);
  }

  /**
   * Find registered pieces that the given piece reads from via sigil links.
   * Unregistered targets are not returned.
   * @param piece The piece to check
   * @returns Array of registered pieces that are read from
   */
  async getReadingFrom(piece: Cell<unknown>): Promise<Cell<unknown>[]> {
    // Get registered pieces that might be referenced
    const piecesCell = await this.getPieceRegistry();
    const registeredPieces = piecesCell.get();
    const result: Cell<unknown>[] = [];
    const seenEntityIds = new Set<string>(); // Track entities we've already processed
    const maxDepth = 10; // Prevent infinite recursion
    const maxResults = 50; // Prevent too many results from overwhelming the UI
    const resolvedPiece = piece.resolveAsCell();

    if (!piece) return result;

    try {
      // Get the argument data - this is where references to other pieces are stored
      const argumentCell = await this.getArgument(piece);
      if (!argumentCell) return result;

      // Get the raw argument value
      let argumentValue;

      try {
        argumentValue = argumentCell.getRaw();
      } catch (err) {
        this.#diagnosticConsole.debug("Error getting argument value:", err);
        return result;
      }

      // Helper function to add a matching piece to the result
      const addMatchingPiece = (docId: EntityRef) => {
        if (!isEntityRef(docId)) return;

        const entityIdStr = entityRefToString(docId);

        // Skip if we've already processed this entity
        if (seenEntityIds.has(entityIdStr)) return;
        seenEntityIds.add(entityIdStr);

        // Find matching piece by entity ID
        const matchingPiece = registeredPieces.find((c) => {
          const cId = getEntityId(c);
          return isEntityRef(cId) && entityRefToString(cId) === entityIdStr;
        });

        if (matchingPiece) {
          const resolvedMatching = matchingPiece.resolveAsCell();
          const isNotSelf = !resolvedMatching.equals(resolvedPiece);
          const notAlreadyInResult = !result.some((c) =>
            c.resolveAsCell().equals(resolvedMatching)
          );

          if (isNotSelf && notAlreadyInResult && result.length < maxResults) {
            result.push(matchingPiece);
          }
        }
      };

      // Find references in the argument structure
      const processValue = (
        value: unknown,
        parent: Cell<unknown>,
        visited = new Set<unknown>(), // Track objects directly, not string representations
        depth = 0,
      ) => {
        // The argument here is `argumentCell.getRaw()`, a raw `FabricValue`.
        // A `FabricPrimitive` is not decomposed by this walk -- nothing is
        // rebuilt, and a leaf holds no link to find, so the empty `Object.keys`
        // ends the descent with nothing lost.
        //
        // TODO(danfuzz): a link nested in a `FabricInstance`'s codec contents
        // is missed, so a piece referenced only from inside a wrapper does not
        // appear in the result. Unlike the sibling walks in the runner, this
        // one does _not_ refuse such a value: every path out of here is wrapped
        // in a `catch` that reports to `diagnosticConsole` and returns an empty
        // result by design (the outer handler says so in as many words), so a
        // throw would be swallowed rather than surfaced. A tripwire that cannot
        // fire is worse than a marker that says so, because it reads as a guard
        // while being incapable of acting as one. Refusing here needs that
        // error handling changed first.
        if (!isObjectOrArray(value) || depth > maxDepth) return;

        // Prevent cycles in our traversal by tracking object references directly
        if (visited.has(value)) return;
        visited.add(value);

        try {
          // Handle values that are themselves cells, docs, or cell links
          if (isLink(value)) {
            const link = parseLink(value, parent);
            if (link.id) {
              addMatchingPiece(getEntityId(link.id)!);
            }

            const resultCell = followCellToResult(
              this.runtime.getCellFromLink(link),
              this.#diagnosticConsole,
              new Set(),
              0,
            );
            if (resultCell !== undefined) addMatchingPiece(resultCell.entityId);
          } else if (Array.isArray(value)) {
            // Safe recursive processing of arrays
            for (let i = 0; i < value.length; i++) {
              try {
                processValue(
                  value[i],
                  parent,
                  new Set([...visited]),
                  depth + 1,
                );
              } catch (err) {
                this.#diagnosticConsole.debug(
                  `Error processing array item at index ${i}:`,
                  err,
                );
              }
            }
          } else if (typeof value === "object") {
            // Process regular object properties
            const keys = Object.keys(value);
            for (let i = 0; i < keys.length; i++) {
              const key = keys[i];

              try {
                processValue(
                  value[key],
                  parent,
                  new Set([...visited]),
                  depth + 1,
                );
              } catch (err) {
                this.#diagnosticConsole.debug(
                  `Error processing object property '${key}':`,
                  err,
                );
              }
            }
          }
        } catch (err) {
          this.#diagnosticConsole.debug("Error in processValue:", err);
        }
      };

      // Start processing from the argument value
      if (argumentValue && typeof argumentValue === "object") {
        processValue(
          argumentValue,
          argumentCell,
          new Set(),
          0,
        );
      }
    } catch (error) {
      this.#diagnosticConsole.debug(
        "Error finding references in piece arguments:",
        error,
      );
      // Don't throw the error - return an empty result instead
    }

    return result;
  }

  /**
   * Find registered pieces that read from the given piece via sigil links.
   * Unregistered readers are not returned.
   * @param piece The piece to check
   * @returns Array of registered pieces that read from this piece
   */
  async getReadByPieces(piece: Cell<unknown>): Promise<Cell<unknown>[]> {
    // Get registered pieces to check
    const piecesCell = await this.getPieceRegistry();
    const registeredPieces = piecesCell.get();
    const result: Cell<unknown>[] = [];
    const seenEntityIds = new Set<string>(); // Track entities we've already processed
    const maxDepth = 10; // Prevent infinite recursion
    const maxResults = 50; // Prevent too many results from overwhelming the UI

    if (!piece) return result;

    const pieceEntityId = getEntityId(piece);
    if (!pieceEntityId) return result;

    const resolvedPiece = piece.resolveAsCell();

    // Helper function to add a matching piece to the result
    const addReadingPiece = (otherPiece: Cell<unknown>) => {
      const otherPieceId = getEntityId(otherPiece);
      if (!isEntityRef(otherPieceId)) return;

      const entityIdStr = entityRefToString(otherPieceId);

      // Skip if we've already processed this entity
      if (seenEntityIds.has(entityIdStr)) return;
      seenEntityIds.add(entityIdStr);

      const resolvedOther = otherPiece.resolveAsCell();
      const notAlreadyInResult = !result.some((c) =>
        c.resolveAsCell().equals(resolvedOther)
      );

      if (notAlreadyInResult && result.length < maxResults) {
        result.push(otherPiece);
      }
    };

    // Helper to check if a document refers to our target piece
    const checkRefersToTarget = (
      value: unknown,
      parent: Cell<unknown>,
      visited = new Set<unknown>(), // Track objects directly, not string representations
      depth = 0,
    ): boolean => {
      // Same shape as `processValue` above, and the same account applies: a
      // `FabricPrimitive` costs this walk nothing, while a link inside a
      // `FabricInstance` is missed.
      //
      // TODO(danfuzz): refusing one here waits on the same thing -- this walk's
      // `catch` swallows, so a throw would not surface.
      if (!isObjectOrArray(value) || depth > maxDepth) return false;

      // Prevent cycles in our traversal by tracking object references directly
      if (visited.has(value)) return false;
      visited.add(value);

      try {
        if (isLink(value)) {
          try {
            const link = parseLink(value, parent);

            // Check if the cell link's doc is our target
            if (link.id === piece.sourceURI) return true;

            // Check if cell link's source chain leads to our target
            const resultCell = followCellToResult(
              this.runtime.getCellFromLink(link),
              this.#diagnosticConsole,
              new Set(),
              0,
            );
            if (resultCell?.sourceURI === piece.sourceURI) return true;
          } catch (err) {
            this.#diagnosticConsole.debug(
              "Error handling cell link in checkRefersToTarget:",
              err,
            );
          }
          return false; // Don't traverse runtime metadata link contents
        }

        // Safe recursive processing of arrays
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) {
            try {
              if (
                checkRefersToTarget(
                  value[i],
                  parent,
                  new Set([...visited]),
                  depth + 1,
                )
              ) {
                return true;
              }
            } catch (err) {
              this.#diagnosticConsole.debug(
                `Error checking array item at index ${i}:`,
                err,
              );
            }
          }
        } else if (isObjectOrArray(value)) {
          // Process regular object properties
          const keys = Object.keys(value);
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];

            try {
              if (
                checkRefersToTarget(
                  value[key],
                  parent,
                  new Set([...visited]),
                  depth + 1,
                )
              ) {
                return true;
              }
            } catch (err) {
              this.#diagnosticConsole.debug(
                `Error checking object property '${key}':`,
                err,
              );
            }
          }
        }
      } catch (err) {
        this.#diagnosticConsole.debug("Error in checkRefersToTarget:", err);
      }

      return false;
    };

    // Check each piece to see if it references this piece
    for (const otherPiece of registeredPieces) {
      if (otherPiece.resolveAsCell().equals(resolvedPiece)) continue; // Skip self

      if (checkRefersToTarget(otherPiece, otherPiece, new Set(), 0)) {
        addReadingPiece(otherPiece);
        continue; // Skip additional checks for this piece
      }

      // Also specifically check the argument data where references are commonly found
      try {
        const argumentCell = await this.getArgument(otherPiece);
        if (argumentCell) {
          const argumentValue = argumentCell.getRaw();

          // Check if the argument references our target
          if (argumentValue && typeof argumentValue === "object") {
            if (
              checkRefersToTarget(
                argumentValue,
                argumentCell,
                new Set(),
                0,
              )
            ) {
              addReadingPiece(otherPiece);
            }
          }
        }
      } catch (_) {
        // Error checking argument references for piece
      }
    }

    return result;
  }

  async getCellById<T>(
    id: EntityId | string,
    path: string[] = [],
    schema?: JSONSchema,
    scope?: CellScope,
  ): Promise<Cell<T>> {
    const cell = this.runtime.getCellFromEntityId<T>(
      this.#space,
      id,
      path,
      schema,
      undefined,
      scope,
    );
    await cell.sync();
    return cell;
  }

  /**
   * Returns the `Cell` with argument content, loading the pattern if needed.
   */
  getArgument<T = unknown>(
    piece: Cell<unknown | T>,
  ): Cell<T> {
    // The piece is a result cell; read its argument metadata link directly.
    // With this approach, we aren't using the argumentSchema from the pattern
    // but that should have been written into the Result Cell's argument link.
    const argumentLink = getMetaLink(piece, "argument", {});
    if (argumentLink === undefined) {
      throw new Error("piece missing argument cell");
    }
    return this.runtime.getCellFromLink(argumentLink);
  }

  getResult<T = unknown>(
    piece: Cell<T>,
  ): Cell<T> {
    return piece;
  }

  /**
   * Remove a piece from this space's registry. Does not clean up the piece's
   * cells. Returns whether this call removed the piece — `false` means the
   * piece was not registered, and nothing was written. A writable registry
   * removes the default pattern and clears its link in one transaction.
   * Computed or action-backed registries require a `removePiece` action for
   * members and refuse removal of their default root; unlinking that root is a
   * separate operation. A removal that cannot commit throws instead, so `false`
   * never stands in for a storage failure.
   *
   * `scope` completes an id into a document address and defaults to the
   * space, as it does for {@link getPieceCell}. A `Cell` argument already
   * carries one, and is taken as it stands.
   */
  async remove(
    pieceOrId: string | Cell<unknown>,
    scope?: CellScope,
  ): Promise<boolean> {
    const piece = typeof pieceOrId === "string"
      ? this.runtime.getCellFromEntityId(
        this.#space,
        entityIdFrom(pieceOrId),
        [],
        undefined,
        undefined,
        scope,
      )
      : pieceOrId;
    const piecesCell = await this.getPieceRegistry();
    await this.syncPieces(piecesCell);

    const registryAddress = piecesCell.resolveAsCell()
      .getAsNormalizedFullLink();
    const root = await this.getDefaultPattern(true);
    const declaredRemove = root === undefined
      ? undefined
      : await root.asSchema({
        type: "object",
        properties: { removePiece: { type: "unknown" } },
      }).key("removePiece").pull();
    if (
      entityKindOfIdString(registryAddress.id) === "computed" ||
      isStream(declaredRemove)
    ) {
      if (!root || root.resolveAsCell().equals(piece.resolveAsCell())) {
        throw new Error(
          "A computed default-pattern registry requires its composition actions; unlinking the root is a separate operation",
        );
      }
      if (!piecesCell.get().some((member) => member.equals(piece))) {
        return false;
      }
      const remove = declaredRemove;
      if (!isStream(remove)) {
        throw new Error(
          "The computed registry has no removePiece action; use the default pattern's composition actions",
        );
      }
      await new Promise<void>((resolve, reject) =>
        remove.send({ piece }, (tx) => {
          const status = tx.status();
          if (status.status === "error") {
            reject(new Error(status.error.message));
          } else resolve();
        })
      );
      await this.runtime.idle();
      await this.synced();
      const remaining = await this.syncPieces(piecesCell);
      if (remaining.some((member) => member.equals(piece))) {
        throw new Error(
          "The removePiece action committed without unregistering the piece",
        );
      }
      return true;
    }

    const { ok, error } = await this.runtime.editWithRetry((tx) => {
      const pieces = piecesCell.withTx(tx);

      // Remove from main list
      const newPieces = filterOutCell(pieces, piece);
      if (newPieces.length === pieces.get().length) {
        return false;
      }
      pieces.set(newPieces);

      // Clear the default-pattern link when it points at the removed piece,
      // in the same commit as the registry write. Read the link inside the
      // transaction: a conflict retry reruns this callback against fresh
      // state, and a link concurrently repointed at another piece must be
      // left in place (the same precondition-guard shape as the roll-forward
      // swap in startEnsuredDefaultPattern).
      const defaultPatternCell = this.#spaceCell.withTx(tx)
        .key("defaultPattern");
      const linked = defaultPatternCell.get();
      if (linked && piece.resolveAsCell().equals(linked.resolveAsCell())) {
        defaultPatternCell.set(undefined);
      }
      return true;
    });
    if (error) {
      throw new Error(
        `Removing the piece failed because storage returned ${error.name}: ${error.message}`,
        { cause: error },
      );
    }

    // Ensure full synchronization
    if (ok) {
      await this.runtime.idle();
      await this.synced();
    }

    return !!ok;
  }

  /** Compile a program and register the piece it creates in this space. */
  async create<U = T>(
    program: RuntimeProgram | string,
    options: CreatePieceOptions = {},
    cause: string | undefined = undefined,
  ): Promise<PieceController<U>> {
    const start = options.start ?? true;
    const pattern = await compileProgram(this, program);
    const piece = await this.runPersistent<U>(
      pattern,
      options.input,
      cause,
      { repository: options.repository, origin: options.origin, start },
    );
    if (!start) {
      await this.runtime.idle();
      await this.synced();
    }
    return new PieceController<U>(this, piece);
  }

  async runPersistent<T = unknown>(
    pattern: Pattern | Module,
    inputs?: unknown,
    cause?: unknown,
    options?: { start?: boolean; repository?: string; origin?: string },
  ): Promise<Cell<T>> {
    const start = options?.start ?? true;
    const piece = await this.setupPersistent<T>(
      pattern,
      inputs,
      cause,
      { repository: options?.repository, origin: options?.origin },
    );
    if (start) {
      await this.startPiece(piece);
    }
    return piece;
  }

  /**
   * Consistently returns the `Cell<Piece>` of the piece with id `pieceId`,
   * applying the provided `pattern` (which may be its current pattern — useful
   * when we are only updating inputs), and optionally applying `inputs` if
   * provided.
   *
   * Reports a failure as itself, whether it happened before or after the setup
   * transaction committed. `runPatternUpdate()` below runs the same post-commit
   * work and differs precisely here: it issues a receipt, so it reports a
   * post-commit failure as a `PatternSetupPostCommitError` carrying that
   * receipt. Callers classifying failures by message want this one.
   */
  async runWithPattern(
    pattern: Pattern | Module,
    pieceId: string,
    inputs?: object,
    options?: {
      start?: boolean;
      expectedPatternIdentity?: { identity: string; symbol: string };
      validateCurrentArgument?: (
        argumentCell: Cell<unknown>,
      ) => void;
      validateArgumentLinks?: (
        argumentCell: Cell<unknown>,
        argumentSchema: JSONSchema,
      ) => void;
      repository?: string;
      sourceTransition?: PieceSourceTransition;
    },
  ): Promise<Cell<unknown>> {
    const piece = this.runtime.getCellFromEntityId(
      this.#space,
      entityIdFrom(pieceId),
    );
    await piece.sync();
    const start = options?.start ?? true;
    let currentPiece = piece;
    // The pattern `syncPattern` may be told about, which is only the one this
    // call is certain the piece ended up running. `runSynced` carries no such
    // certainty: a concurrent source update can supersede this caller between
    // its setup commit and here, and `runSynced` then hands back a piece
    // running the winner rather than this candidate.
    let installedPattern: Pattern | Module | undefined;
    if (start) {
      currentPiece = await this.runtime.runSynced(piece, pattern, inputs, {
        expectedPatternIdentity: options?.expectedPatternIdentity,
        patternRepository: options?.repository,
        pieceSourceTransition: options?.sourceTransition,
        validateCurrentArgument: options?.validateCurrentArgument,
        validateArgumentLinks: options?.validateArgumentLinks,
      });
    } else {
      if (options?.expectedPatternIdentity) {
        throw new Error("atomic pattern updates require starting the piece");
      }
      await this.runtime.setup(undefined, pattern, inputs ?? {}, piece, {
        patternRepository: options?.repository,
      });
      installedPattern = pattern;
    }
    await this.syncPattern(currentPiece, installedPattern);
    if (start) {
      await this.getResult(currentPiece).pull();
    }

    return currentPiece;
  }

  /**
   * Applies a pattern through an owned transaction and returns its receipt.
   *
   * A later failure to synchronize dependencies, start the piece, load its
   * schema, or pull its result throws `PatternSetupPostCommitError`, whose
   * `.commit` remains the accepted transaction's result.
   */
  async runPatternUpdate(
    pattern: Pattern | Module,
    pieceId: string,
    inputs: object | undefined,
    options: {
      expectedPatternIdentity: { identity: string; symbol: string };
      /** Invariant over the argument stored before setup changes it. */
      validateCurrentArgument?: (argumentCell: Cell<unknown>) => void;
      /** Invariant over links retained by the candidate argument schema. */
      validateArgumentLinks?: (
        argumentCell: Cell<unknown>,
        argumentSchema: JSONSchema,
      ) => void;
      /** Repository locator written atomically with pattern setup. */
      repository?: string;
      /** Fresh source lifecycle revision written atomically with setup. */
      sourceTransition: PieceSourceTransition;
      /**
       * The update as a serving runtime performs it on `actingUser`'s
       * behalf: the transaction carries that principal's trust snapshot
       * and commits directly to the store rather than sealing into the
       * wave, the piece is not started, and the post-commit refresh is
       * left to the serving loop, so the returned cell view is the one the
       * commit itself reconciled.
       */
      served?: { actingUser: string };
    },
  ): Promise<{
    /** Cell view reconciled to the pattern current after post-commit work. */
    cell: Cell<unknown>;
    /** Receipt issued from the accepted setup transaction. */
    commit: PatternSetupCommitReceipt;
  }> {
    const piece = this.runtime.getCellFromEntityId(
      this.#space,
      entityIdFrom(pieceId),
    );
    const result = await this.runtime.runSyncedWithCommit(
      piece,
      pattern,
      inputs,
      {
        expectedPatternIdentity: options.expectedPatternIdentity,
        patternRepository: options.repository,
        pieceSourceTransition: options.sourceTransition,
        validateCurrentArgument: options.validateCurrentArgument,
        validateArgumentLinks: options.validateArgumentLinks,
        ...(options.served === undefined ? {} : {
          directCommit: true,
          start: false,
          cfcTrustSnapshot: this.runtime.trustSnapshotForPrincipal(
            options.served.actingUser,
          ),
        }),
      },
    );
    if (options.served !== undefined) return result;
    try {
      await this.syncPattern(result.cell);
      await this.getResult(result.cell).pull();
      return result;
    } catch (error) {
      throw new PatternSetupPostCommitError(result.commit, error);
    }
  }

  /**
   * Prepare a new piece by setting up its process/result cells and pattern
   * metadata without scheduling the pattern's nodes.
   */
  async setupPersistent<T = unknown>(
    pattern: Pattern | Module,
    inputs?: unknown,
    cause?: unknown,
    options?: { repository?: string; origin?: string },
  ): Promise<Cell<T>> {
    await timePiecePhase(
      "setupPersistent.runtime.idle",
      () => this.runtime.idle(),
    );
    const piece = this.runtime.getCell<T>(
      this.#space,
      cause ?? { space: this.#space, random: crypto.randomUUID() },
      pattern.resultSchema,
    );
    // Setup verifies the source closure of a pattern that carries a
    // content-addressed entry ref, and verifies it synchronously. Load the
    // parser it needs first, since setup cannot await one.
    const knownEntryRef = this.runtime.patternManager.getArtifactEntryRef(
      pattern,
    );
    if (knownEntryRef !== undefined) {
      await timePiecePhase(
        "setupPersistent.prepareSourceClosureVerification",
        () => prepareSourceClosureVerification(),
      );
    }
    await timePiecePhase(
      "setupPersistent.runtime.setup",
      () =>
        this.runtime.setup(undefined, pattern, inputs ?? {}, piece, {
          patternRepository: options?.repository,
          initializePieceSourceHistory: true,
          initialPieceSourceOrigin: options?.origin,
        }),
    );
    await timePiecePhase(
      "setupPersistent.syncPattern",
      () => this.syncPattern(piece, pattern),
    );

    return piece;
  }

  /**
   * Open a piece: bring its source up to date with the origin it follows, then
   * start it.
   *
   * Reconciling before the start is what keeps a piece from running source its
   * own origin has already replaced. A piece that records no origin, or whose
   * origin cannot be reached, starts on the source it has. A piece compiled
   * moments ago from the source it was created with is started directly
   * through {@link startPiece} instead: following that origin again would only
   * fetch what it was just built from.
   */
  async openPiece<T = unknown>(pieceOrId: string | Cell<T>): Promise<void> {
    const piece = typeof pieceOrId === "string"
      ? await timePiecePhase(
        "openPiece.get",
        () => this.getPieceCell<T>(pieceOrId),
      )
      : pieceOrId;
    if (!piece) throw new Error("Piece not found");
    const outcome = await timePiecePhase(
      "openPiece.reconcileSource",
      () => reconcilePieceSource(this.runtime, piece),
    );
    // The transition committed through a transaction view, and the caller may
    // have handed us a cell bound to a read transaction older than it. Detach
    // and resync, or the start below loads the identity the origin just
    // replaced.
    await this.startPiece(
      outcome === "updated" ? await piece.withTx().sync() : piece,
    );
  }

  /**
   * Start scheduling and running a prepared piece. `scope` completes an id
   * into a document address and defaults to the space, as it does for
   * {@link getPieceCell}; a `Cell` argument already carries one.
   * In view-scoped mode this synchronizes the name and opaque UI tip; the
   * retained root watch demands server execution, while mounted renderers
   * own local graph registration.
   */
  async startPiece<T = unknown>(
    pieceOrId: string | Cell<T>,
    scope?: CellScope,
  ): Promise<void> {
    const piece = typeof pieceOrId === "string"
      ? await timePiecePhase(
        "startPiece.get",
        () => this.getPieceCell<T>(pieceOrId, false, undefined, scope),
      )
      : pieceOrId;
    if (!piece) throw new Error("Piece not found");
    if (
      this.runtime.viewScopedReplicationRequested &&
      await this.runtime.viewReplication.enable(piece.space)
    ) {
      await piece.asSchema(viewPieceSchema).sync();
      return;
    }
    await timePiecePhase(
      "startPiece.runtime.start",
      () => this.runtime.start(piece),
    );
    await timePiecePhase(
      "startPiece.result.pull",
      () => this.getResult(piece).pull(),
    );
    await timePiecePhase("startPiece.synced", () => this.synced());
  }

  /**
   * Stop a running piece (no-op if not running). `scope` completes an id into
   * a document address and defaults to the space, as it does for
   * {@link getPieceCell}; a `Cell` argument already carries one.
   */
  async stopPiece<T = unknown>(
    pieceOrId: string | Cell<T>,
    scope?: CellScope,
  ): Promise<void> {
    const piece = typeof pieceOrId === "string"
      ? await this.getPieceCell<T>(pieceOrId, false, undefined, scope)
      : pieceOrId;
    if (!piece) throw new Error("Piece not found");
    this.runtime.runner.stop(piece);
    await this.runtime.idle();
  }

  /**
   * Load the pattern a piece runs, so a later cold runtime can resolve it from
   * the space by identity.
   *
   * Pass `pattern` only when the caller drove `setup` itself and so knows
   * which pattern the piece ended up running. Setup stamps an entry ref onto
   * every pattern it installs, keyed by content for a compiled one, so the
   * identity is then a lookup in memory and the piece is never read. A caller
   * that went through `runSynced` has no such knowledge and must pass nothing.
   *
   * Without a pattern the identity comes from the `patternIdentity` metadata
   * on the piece, which names whichever pattern the piece actually runs. That
   * metadata becomes readable once the write carrying it commits, so this
   * settles the pending writes and then reads. The settle costs a wait on the
   * storage manager's whole queue, which is the price of reading an answer
   * that does not depend on when the read happened to land.
   */
  async syncPattern(piece: Cell<unknown>, pattern?: Pattern | Module) {
    const ref =
      (pattern !== undefined
        ? this.runtime.patternManager.getArtifactEntryRef(pattern)
        : undefined) ?? await this.#readPatternIdentity(piece);

    return await timePiecePhase(
      "syncPattern.loadPattern",
      () => this.syncPatternByIdentity(ref),
    );
  }

  async #readPatternIdentity(piece: Cell<unknown>) {
    await timePiecePhase("syncPattern.synced", () => this.synced());
    await timePiecePhase("syncPattern.piece.sync", () => piece.sync());

    // When we subscribe to a doc, our subscription includes the doc's pattern
    // pointer (`patternIdentity`), so read that. A KEYLESS piece carries no
    // durable pointer (the never-durable contract; L3(a), RULED 2026-08-27)
    // — in the session that set it up, the runner's session-side pointer
    // answers instead, and `loadPatternByIdentity` serves the minted
    // identity from the in-memory index. A durable `keyless:` pointer is a
    // LEGACY orphan (pre-guard leak, or one delivered by a lagging remote
    // sync after this session's setup cleared it) — unloadable everywhere
    // except the session that minted it, never this one — so it must not
    // shadow the live session pointer; it stays the last resort so a fresh
    // session's orphan keeps its designed no-pattern outcome.
    const durable = getPatternIdentityRef(piece);
    const ref = (durable !== undefined &&
        !PatternManager.isKeylessPatternIdentity(durable.identity))
      ? durable
      : this.runtime.runner.sessionPatternPointerFor(piece) ?? durable;
    if (!ref) throw new Error("piece missing pattern identity");
    return ref;
  }

  async syncPatternByIdentity(ref: { identity: string; symbol: string }) {
    if (!ref) throw new Error("pattern identity is required");
    const pattern = await this.runtime.patternManager.loadPatternByIdentity(
      ref.identity,
      ref.symbol,
      this.#space,
    );
    return pattern;
  }

  async sync(entity: Cell<unknown>, _waitForStorage: boolean = false) {
    await entity.sync();
  }

  /**
   * Returns the piece from our active piece list if it is present, or
   * `undefined` if it is not.
   */
  async getActivePiece(pieceCell: Cell<unknown>) {
    const piecesCell = await this.getPieceRegistry();
    const resolved = pieceCell.resolveAsCell();
    return piecesCell.get().find((piece) =>
      piece.resolveAsCell().equals(resolved)
    );
  }

  /**
   * Links the source result at `linkPath` into the target argument at
   * `targetPath`. A target piece must declare the path in its current input
   * schema; raw cell targets accept paths without a piece-schema check.
   *
   * Piece inputs validate the binding against durable producer metadata in
   * the write transaction. Sources without that metadata remain dynamic
   * bindings without a static producer-contract proof. Binding a Stream
   * stores its handle; it does not send an event.
   *
   * @throws {PieceInputPathError} If the target piece's input schema does not
   * expose the path. Update its source with `cf piece setsrc` to declare the
   * input before linking it.
   */
  async link(
    linkPieceId: string,
    linkPath: (string | number)[],
    targetPieceId: string,
    targetPath: (string | number)[],
    options?: {
      start?: boolean;
      sourceScope?: CellScope;
      targetScope?: CellScope;
    },
  ): Promise<void> {
    const start = options?.start ?? true;
    const linkCell = this.runtime.getCellFromEntityId(
      this.#space,
      entityIdFrom(linkPieceId),
      [],
      undefined,
      undefined,
      options?.sourceScope,
    );
    await linkCell.sync();
    // Keep Piece result links anchored at the public result projection. Its
    // durable, monotonically narrowing result schema is the producer contract;
    // resolving through an alias here would discard that contract and point at
    // an untyped internal cell instead.

    // Get target cell (piece or arbitrary cell)
    const { cell: targetCell, isPiece: targetIsPiece } =
      await getCellByIdOrPiece(
        this,
        targetPieceId,
        "Target",
        { ...options, start: false },
      );

    const result = await this.runtime.editWithRetry((tx) => {
      // Recover the producer view in the transaction that commits the binding,
      // so a concurrent contract change invalidates the transaction's reads.
      const source = linkCell.withTx(tx).asSchemaFromLinks().key(...linkPath);
      let targetInputCell = targetCell.withTx(tx);
      if (targetIsPiece) {
        // For pieces, target fields are in the result cell's argument
        const resultCell = followCellToResult(
          targetInputCell,
          this.#diagnosticConsole,
        );
        if (!resultCell) {
          throw new Error("Target piece has no result cell");
        }
        const targetArgumentLink = getMetaLink(resultCell, "argument");
        if (targetArgumentLink === undefined) {
          throw new Error("Target piece has no argument cell");
        }
        targetInputCell = resultCell.runtime.getCellFromLink(
          targetArgumentLink,
          undefined,
          tx,
        );
        assertPieceInputPath(targetInputCell, targetPath);
        const targetSchema = targetArgumentLink.schema ?? true;
        assertWritablePiecePath(
          targetSchema,
          targetPath,
          true,
          false,
          targetInputCell,
        );
        assertSuppliedLinkSchemasCompatible(
          [{ path: targetPath, value: source }],
          targetSchema,
          targetInputCell,
          this,
          { allowUnprovenSource: true },
        );
      }

      targetInputCell.key(...targetPath).setRawUntyped(
        source.getAsLink({
          base: targetInputCell,
          includeSchema: true,
          keepAsCell: KeepAsCell.OnlyStream,
        }),
      );
    });
    if (result.error) {
      if (
        result.error.name === "StorageTransactionAborted" &&
        result.error.reason instanceof PieceInputPathError
      ) {
        throw result.error.reason;
      }
      throw new Error(
        `Cannot link ${linkPieceId}/${linkPath.join("/")} to ${targetPieceId}/${
          targetPath.join("/")
        }: ${result.error.message}`,
        { cause: result.error },
      );
    }

    if (targetIsPiece && start) {
      await this.runtime.start(targetCell);
      await this.getResult(targetCell).pull();
    }
    await this.synced();
  }

  /**
   * Read the configured default app source from the home space.
   *
   * The value is authored as a URL and canonicalized to the ref that names the
   * same file, so a root is born with the provenance it will keep rather than
   * with a spelling that has to be migrated before anything follows it.
   *
   * A rooted path that names no file under the patterns route is refused
   * outright. Resolving one against the host reaches whatever the site serves
   * for an unrouted path, and a piece cannot record an origin nothing can
   * follow. An absolute URL is kept as authored: it names its own host.
   *
   * Returns empty string if not configured, if the configured value cannot be
   * an origin, or if the home space is not accessible.
   */
  async #getDefaultAppUrlFromHome(): Promise<string> {
    try {
      const homeSpaceCell = this.runtime.getHomeSpaceCell();
      await timePiecePhase(
        "getDefaultAppUrlFromHome.homeSpaceCell.sync",
        () => homeSpaceCell.sync(),
      );

      const url = await timePiecePhase(
        "getDefaultAppUrlFromHome.defaultAppUrl.get",
        () =>
          homeSpaceCell.key("defaultPattern")
            .asSchema(homeSchema).key("defaultAppUrl").get(),
      );
      if (typeof url !== "string") return "";
      const source = normalizePatternSource(url.trim(), this.runtime.apiUrl);
      if (!source.startsWith("/")) return source;
      console.warn(
        `Ignoring the configured defaultAppUrl ${source}: a rooted path ` +
          "names no pattern this deployment serves, so nothing could follow " +
          "it. Configure a system pattern or an absolute URL.",
      );
      return "";
    } catch (error) {
      console.warn("Failed to read defaultAppUrl from home space:", error);
      return "";
    }
  }

  /**
   * Recreates the default pattern from scratch.
   * Stops and unlinks the existing default pattern, then creates a new one.
   * This is useful for resetting the space's default pattern state.
   *
   * @param options.customProgram - A pre-compiled program to use instead of the default URL-based pattern
   * @returns The newly created default pattern piece
   */
  async recreateDefaultPattern(
    options?: { customProgram?: RuntimeProgram; repository?: string },
  ): Promise<PieceController<NameSchema>> {
    if (
      options?.repository !== undefined && options.customProgram === undefined
    ) {
      throw new Error(
        "A repository locator can only be supplied with a custom program",
      );
    }

    // Stop and unlink the existing default pattern first (before any operations that might fail)
    // We need to stop it to prevent resource leaks or duplicate behavior from the old pattern
    // Access the space cell directly to get the pattern reference without running it
    const spaceCellContents = this.getSpaceCellContents();
    await spaceCellContents.sync();
    const defaultPatternRef = spaceCellContents.key("defaultPattern").get();
    if (defaultPatternRef) {
      // Stop the existing pattern (no-op if not running)
      this.runtime.runner.stop(defaultPatternRef);
    }
    await this.unlinkDefaultPattern();

    // Determine which pattern to use based on space type
    const isHomeSpace = this.getSpace() === this.runtime.userIdentityDID;

    let patternConfig: { name: string; source: string; cause: string };
    let pattern;

    if (options?.customProgram) {
      patternConfig = {
        name: isHomeSpace ? "Home" : "DefaultPieceList",
        source: "custom",
        cause: isHomeSpace
          ? `home-pattern-${Date.now()}`
          : `space-root-${Date.now()}`,
      };
      pattern = await this.runtime.patternManager.compilePattern(
        options.customProgram,
        { space: this.getSpace() },
      );
    } else {
      if (isHomeSpace) {
        patternConfig = {
          name: "Home",
          source: HOME_PATTERN_SOURCE,
          cause: `home-pattern-${Date.now()}`,
        };
      } else {
        const customUrl = await this.#getDefaultAppUrlFromHome();
        patternConfig = {
          name: "DefaultPieceList",
          source: customUrl || DEFAULT_APP_PATTERN_SOURCE,
          cause: `space-root-${Date.now()}`,
        };
      }

      const patternUrl = patternSourceUrl(
        patternConfig.source,
        this.runtime.apiUrl,
      );

      // Load and compile the pattern (cache in the target space — CT-1623).
      const program = await this.runtime.harness.resolve(
        new HttpProgramResolver(patternUrl.href),
      );
      pattern = await this.runtime.patternManager.compilePattern(
        program,
        { space: this.getSpace() },
      );
    }

    // Create new piece cell
    let pieceCell: Cell<NameSchema>;

    const { error } = await this.runtime.editWithRetry((tx) => {
      // Create piece cell within this transaction
      pieceCell = this.runtime.getCell<NameSchema>(
        this.getSpace(),
        patternConfig.cause,
        nameSchema,
        tx,
      );

      // Run pattern setup within same transaction
      this.runtime.run(tx, pattern, {}, pieceCell);

      // Stamp the provenance the piece tracks for updates, mirroring
      // ensureDefaultPattern (CT-1890). Without this, every recreated root is
      // born detached, and nothing supplies it code again. A custom program
      // has no URL to re-fetch (stamping the "custom" placeholder would poison
      // URL resolution — it would resolve relative to the host); its locator,
      // when supplied, is recorded via setPatternRepository below, so a custom
      // root without a repository intentionally stays unstamped.
      if (options?.customProgram === undefined) {
        setPatternSource(pieceCell, tx, patternConfig.source);
      }

      if (options?.repository !== undefined) {
        setPatternRepository(pieceCell, tx, options.repository);
      }

      // Link as default pattern within same transaction
      const spaceCellWithTx = spaceCellContents.withTx(tx);
      const defaultPatternCell = spaceCellWithTx.key("defaultPattern");
      defaultPatternCell.set(pieceCell.withTx(tx));
    });
    if (error) {
      throw new Error(
        `Updating the default pattern failed because storage returned ${error.name}: ${error.message}`,
        { cause: error },
      );
    }

    // Fetch the final result
    const finalPattern = await this.getDefaultPattern(false);
    if (!finalPattern) {
      throw new Error("Failed to create default pattern");
    }

    // Start the piece
    await this.startPiece(finalPattern);
    await this.runtime.idle();
    await this.synced();

    return new PieceController<NameSchema>(this, finalPattern);
  }

  /**
   * Ensures a default pattern exists for this space, creating it if necessary.
   * For home spaces, uses home.tsx; for other spaces, uses default-app.tsx.
   * This makes CLI-created spaces work the same as Shell-created spaces.
   *
   * Uses the transaction system's optimistic concurrency control to handle
   * race conditions - if multiple processes try to create the pattern
   * simultaneously, the first successful commit wins and others gracefully
   * discover the existing pattern on retry.
   *
   * @returns The default pattern piece, either existing or newly created
   */
  async ensureDefaultPattern(): Promise<PieceController<NameSchema>> {
    // Fast path: resolve the existing root WITHOUT starting it, so opening it
    // can follow its origin before bootstrap tries to load an identity that
    // origin has already replaced.
    const existingPattern = await this.getDefaultPattern(false);
    if (existingPattern) {
      return await this.#startEnsuredDefaultPattern(existingPattern, true);
    }

    // Determine which pattern to use based on space type
    const isHomeSpace = this.getSpace() === this.runtime.userIdentityDID;

    let patternConfig: { name: string; source: string; cause: string };

    if (isHomeSpace) {
      patternConfig = {
        name: "Home",
        source: HOME_PATTERN_SOURCE,
        cause: "home-pattern",
      };
    } else {
      const customUrl = await timePiecePhase(
        "ensureDefaultPattern.getDefaultAppUrlFromHome",
        () => this.#getDefaultAppUrlFromHome(),
      );
      patternConfig = {
        name: "DefaultPieceList",
        source: customUrl || DEFAULT_APP_PATTERN_SOURCE,
        cause: "space-root",
      };
    }

    // The creation half is the SHARED core (the runner's
    // ensure-space-root.ts, OW45 arm-B stage 1): resolve + compile the
    // source (into the space's compile cache, CT-1623), then the
    // creation editWithRetry — the OCC re-check, the piece cell under
    // the identity-bearing cause, run setup, stamp provenance, link
    // defaultPattern. The SpaceServer's activation ensure runs the SAME
    // function, so OFF stays one code path instead of a fork; this
    // client call passes no stamp hook and no fetch, which keeps the
    // transaction and the resolver byte-identical to the pre-extraction
    // controller. A commit error is swallowed exactly as before: the
    // resolution below fails if nothing won the race.
    const { createdByThisCall } = await createSpaceRootIfAbsent(
      this.runtime,
      this.getSpace(),
      patternConfig,
      { timePhase: timePiecePhase, spaceCell: this.getSpaceCellContents() },
    );

    // After transaction commits, fetch the final result
    // (either we created it, or another process did)
    const finalPattern = await timePiecePhase(
      "ensureDefaultPattern.getDefaultPattern(false)",
      () => this.getDefaultPattern(false),
    );
    if (!finalPattern) {
      throw new Error("Failed to create or find default pattern");
    }

    // A root created by this successful attempt was compiled from the current
    // source immediately above. If another writer won the race, treat the
    // discovered root like every other persisted root and reconcile it before
    // start.
    return await this.#startEnsuredDefaultPattern(
      finalPattern,
      !createdByThisCall,
    );
  }

  /**
   * `reconcileBeforeStart` is false only for a root this call just created
   * from its source: following that origin again would fetch the route to
   * learn what was compiled from it moments ago.
   */
  async #startEnsuredDefaultPattern(
    root: Cell<NameSchema>,
    reconcileBeforeStart: boolean,
  ): Promise<PieceController<NameSchema>> {
    let rootToStart = root;
    if (reconcileBeforeStart) {
      const outcome = await timePiecePhase(
        "ensureDefaultPattern.reconcileSource",
        () => reconcilePieceSource(this.runtime, root),
      );
      // The swap committed through a transaction view. Resolve the root again
      // so start() observes the committed patternIdentity rather than the
      // pre-transaction snapshot held by the caller's cell.
      rootToStart = await this.getDefaultPattern(false) ?? root;
      // Only when the origin CONFIRMED the pinned pattern. Then a disagreeing
      // setup marker says the document is staged by another version while the
      // right one is pinned, which is a stale document rather than a stale
      // pattern. A root the origin did not confirm may be pinned to a pattern
      // that is simply wrong for it, and re-staging that one buys nothing the
      // repair below cannot do with the failure in hand.
      if (outcome === "current" || outcome === "migrated") {
        rootToStart = await this.#restageRootSetupIfStale(rootToStart);
      }
    }

    try {
      // A root whose stored setup was staged by another version starts
      // without error and then reads wrong — its internal cells and result
      // projection are that other version's — so it is refused here and
      // handed to the repair below as the failure it is, rather than started.
      // A root already running keeps its graph: a start returns on the fast
      // path without reading the stored doc, and the re-stage above is what
      // tends to that doc.
      const staleSetup = this.runtime.runner.isRunning(rootToStart)
        ? undefined
        : this.#staleStoredSetupOf(rootToStart);
      if (staleSetup !== undefined) throw new Error(staleSetup);
      await timePiecePhase(
        "ensureDefaultPattern.startPiece",
        () => this.startPiece(rootToStart),
      );
    } catch (startError) {
      // Cold-start setup repair. Two paths move patternIdentity WITHOUT
      // running the setup phase: this method's own roll-forward heal when
      // the materialize after its identity swap fails, and the runner's
      // pattern watcher rolling an unloadable pointer back to the running
      // pattern or its producer. Runner.start() of a not-running piece
      // instantiates the stored identity directly — also without setup. A
      // root whose identity moved while it was not running therefore holds
      // a doc staged by another version, which the refusal above turns into
      // the failure handled here. This also covers docs ALREADY left in that
      // state by an earlier session: their identity compares current, so no
      // further swap will ever fire.
      //
      // run() (setup + start) is the sanctioned repair. With an unchanged
      // pattern pointer the setup phase is near-idempotent: it materializes
      // missing internal cells and supplies no argument. It is not a complete
      // no-op on the doc this repair exists for, and deliberately so — a root
      // whose identity moved without setup also carries a stale
      // `patternSetupIdentity`, so setup re-points the stored argument at the
      // pattern's argument schema and validates it (`storedSetupMarker` in
      // the runner), which is the staging the skipped update never did. That
      // makes a stored argument the pinned pattern cannot read a REPAIR
      // failure, classified and escalated below rather than left to surface as
      // an unreadable value at every later read. Fail closed: if the repair
      // cannot proceed or fails for its own reasons, surface the ORIGINAL start
      // error; nothing is torn down or overwritten.
      const runtime = this.runtime;
      // Keyless pieces resolve through the session pointer (never stamped
      // durably); a fresh session correctly finds nothing and surfaces the
      // original start error.
      const ref = getPatternIdentityRef(rootToStart) ??
        runtime.runner.sessionPatternPointerFor(rootToStart);
      if (ref === undefined) throw startError;
      let pattern;
      try {
        pattern = await runtime.patternManager.loadPatternByIdentity(
          ref.identity,
          ref.symbol,
          this.getSpace(),
        );
      } catch {
        // A THROWN load may be transient, and a transient failure is not
        // evidence that the pinned pattern is wrong.
        throw startError;
      }
      if (pattern === undefined) {
        // The pattern is not merely unrunnable, it is unreachable through every
        // supported recovery path, so re-running its setup cannot help. A root
        // that records no origin has nothing else to fall back on and its space
        // would stop opening, so it rolls forward to the official system root
        // for its kind. One that follows an origin keeps what its owner chose:
        // opening it already tried that origin, and replacing its source with
        // the system default would discard the choice rather than repair it.
        if (!this.#rootNeedsRollForward(rootToStart)) throw startError;
        return new PieceController<NameSchema>(
          this,
          await this.#healDefaultRootByRollForward(
            rootToStart,
            ref,
            startError,
            "unloadable",
          ),
        );
      }
      pieceUpdateLogger.warn(
        "cold-start-setup-repair",
        () => [
          "startEnsuredDefaultPattern: start failed; re-running setup for",
          `${ref.identity}#${ref.symbol}`,
          startError,
        ],
      );
      const repairPattern = pattern;
      // Detach any transaction view the resolved root carries: getDefault-
      // Pattern hands back a cell bound to a read-only tx, and runSynced
      // would otherwise adopt it for the setup writes.
      const writableRoot = rootToStart.withTx();
      // expectedPatternIdentity is the repair precondition, not a formality:
      // it atomically rejects a repair superseded by a concurrent source
      // update (the identity is re-asserted inside every setup retry), and it
      // makes runSynced THROW on a setup-commit failure instead of logging
      // and continuing — without it this catch never sees commit-level
      // failures and a dead root would be reported as a successful start.
      try {
        await timePiecePhase(
          "ensureDefaultPattern.coldStartSetupRepair",
          () =>
            runtime.runSynced(writableRoot, repairPattern, undefined, {
              expectedPatternIdentity: ref,
            }),
        );
      } catch (repairError) {
        // Escalate to the RUNNABILITY backstop on TWO signals, and only those.
        // The first: the pinned pattern LOADS but its setup-commit was REJECTED
        // BY THE CFC MIGRATION — the estuary case, where an old root's required
        // field predates its `Default<>` or a handler stream predates its
        // exemption. "Loadable" is not "runnable"; re-running the same identity
        // can only fail identically, so roll the root forward to the space's
        // CURRENT official pattern (which migrates the reused doc cleanly).
        // Neither signal fires for a root that already runs — current official,
        // or a custom root that migrates cleanly — so custom-root protection is
        // preserved for free.
        //
        // A refused STORED ARGUMENT is the same class of evidence and escalates
        // the same way. Setup re-points the argument at the pinned pattern's
        // schema when the doc was staged by another version, and a refusal says
        // that pattern cannot read its own root — re-running it refuses
        // identically, so without this the root would be pinned to a version
        // whose setup can never complete and the space would stop opening.
        //
        // Both classifiers read the error, not the document it came from, so a
        // refusal raised while instantiating a NESTED piece under this root
        // reads the same as one raised for the root itself. That is a property
        // of classifying by message rather than by origin, and it is shared
        // with the CFC trigger; narrowing it means carrying the failing
        // document through the setup boundary.
        //
        // Any OTHER repair failure (transient storage/commit error, backend
        // unavailable, …) is NOT evidence the pinned pattern is wrong. It stays
        // FAIL-CLOSED: surface the ORIGINAL start error, change nothing, let
        // the next boot retry. This gate is what keeps a transient blip from
        // swapping a healthy root's identity out from under it.
        const migrationRejected = isCfcMigrationRejection(repairError);
        if (!migrationRejected && !isStoredArgumentSchemaRefusal(repairError)) {
          // Log before discarding it. The thrown error is the ORIGINAL start
          // failure, so a repair that failed for its own reason would otherwise
          // leave the operator reading a stack about the symptom that triggered
          // the repair rather than the reason the repair did not work.
          pieceUpdateLogger.warn(
            "cold-start-setup-repair-error",
            () => [
              "startEnsuredDefaultPattern: setup repair failed for an " +
              "unrelated reason; surfacing the original start error",
              `${ref.identity}#${ref.symbol}`,
              repairError,
            ],
          );
          throw startError;
        }
        pieceUpdateLogger.warn(
          "cold-start-setup-repair-failed",
          () => [
            `startEnsuredDefaultPattern: setup repair rejected by ${
              migrationRejected ? "CFC migration" : "argument validation"
            }; rolling forward`,
            `${ref.identity}#${ref.symbol}`,
            repairError,
          ],
        );
        rootToStart = await this.#healDefaultRootByRollForward(
          rootToStart,
          ref,
          repairError,
        );
      }
    }
    await timePiecePhase(
      "ensureDefaultPattern.runtime.idle",
      () => this.runtime.idle(),
    );
    await timePiecePhase(
      "ensureDefaultPattern.synced",
      () => this.synced(),
    );

    return new PieceController<NameSchema>(this, rootToStart);
  }

  /**
   * Why `root` cannot be started as it is stored, or `undefined` when it
   * can: its setup-completion marker names a pattern other than the one it
   * is pinned to, so the document's internal cells and result projection are
   * another version's. A root with no marker at all is not refused; absence
   * is no evidence about which version staged it.
   */
  #staleStoredSetupOf(root: Cell<NameSchema>): string | undefined {
    const ref = getPatternIdentityRef(root);
    const setupRef = getPatternSetupIdentityRef(root);
    if (
      ref === undefined || setupRef === undefined ||
      (setupRef.identity === ref.identity && setupRef.symbol === ref.symbol)
    ) {
      return undefined;
    }
    return `Root \`${root.sourceURI}\` is pinned to pattern \`${ref.identity}#${ref.symbol}\` but its stored setup was staged by \`${setupRef.identity}#${setupRef.symbol}\``;
  }

  /**
   * Re-stage a root whose document was last set up by a different pattern
   * version than the one it is pinned to.
   *
   * Such a root starts without error and then reads wrong: its result
   * projection and `schema` meta still describe the version that staged the
   * document, so fields the pinned version added read as absent. The
   * cold-start repair below catches the same state only once it has made the
   * start fail outright. Best-effort — a failed re-stage leaves the root as it
   * was, and the start reports whatever it reports.
   */
  async #restageRootSetupIfStale(
    root: Cell<NameSchema>,
  ): Promise<Cell<NameSchema>> {
    // Nothing to re-stage: a root with no pattern to stage from, or one whose
    // stored setup already names the pattern it is pinned to.
    const ref = getPatternIdentityRef(root);
    const setupRef = getPatternSetupIdentityRef(root);
    if (
      ref === undefined ||
      (setupRef?.identity === ref.identity && setupRef.symbol === ref.symbol)
    ) return root;
    try {
      const pattern = await this.runtime.patternManager.loadPatternByIdentity(
        ref.identity,
        ref.symbol,
        this.getSpace(),
      );
      if (pattern === undefined) return root;
      // The re-stage writes over the stored setup's cells, which are named
      // before the transaction that writes them opens.
      await this.runtime.runner.syncStoredPieceCells(root, pattern);
      const result = await timePiecePhase(
        "ensureDefaultPattern.restageRootSetup",
        () =>
          this.runtime.editWithRetry((tx) => {
            const candidate = root.withTx(tx);
            const currentRef = getPatternIdentityRef(candidate);
            if (
              currentRef?.identity !== ref.identity ||
              currentRef.symbol !== ref.symbol
            ) return false;
            void this.runtime.setup(tx, pattern, undefined, candidate, {
              prepareForResume: true,
              reapplyStoredSetup: true,
            });
            return true;
          }),
      );
      if (result.error !== undefined || !result.ok) return root;
      await this.runtime.idle();
      return await this.getDefaultPattern(false) ?? root;
    } catch (error) {
      pieceUpdateLogger.warn("root-setup-restage-failed", () => [
        "startEnsuredDefaultPattern: could not re-stage a root whose setup",
        `marker disagrees with its pinned pattern (${this.#space})`,
        error,
      ]);
      return root;
    }
  }

  /**
   * Runnability backstop for `#startEnsuredDefaultPattern`'s cold-start
   * repair. Reached only when the pinned pattern's OWN setup repair failed in a
   * way that re-running it cannot fix — a root that loads but cannot run.
   * Exactly two signals qualify: the CFC migration rejected the commit (gated
   * by {@link isCfcMigrationRejection} — the estuary `favorites`/handler-stream
   * case), or setup refused the root's stored argument (gated by
   * {@link isStoredArgumentSchemaRefusal} — the pinned version's schema cannot
   * read its own document). Rolls the root forward to the space's CURRENT
   * official pattern and materializes THAT over the reused doc.
   *
   * Outcome is one of exactly two, each legible — no operator left
   * reverse-engineering scattered `needs a default` messages:
   *
   *   1. Healed: identity now points at the official pattern, its setup
   *      committed, the reused doc materialized against it.
   *   2. A single CLEAR error naming WHY — the pinned pattern's migration
   *      failure and where the roll-forward stopped (compile, identity, swap,
   *      or the official pattern's own materialize).
   *
   * On atomicity: the identity swap and the materialize are two commits, not
   * one (runSynced owns its own setup transaction and asserts the identity is
   * already pinned, so the swap must precede it). If the swap commits but the
   * materialize then fails, the root is left pinned to the official identity
   * but un-setup — the SAME "already moved" state the same-identity repair
   * heals on the next boot (see the cold-start "already moved" test), never a
   * worse state than the pinned-and-unmigratable root we started from. The
   * error still surfaces, so the failed boot is not silent.
   *
   * Returns the healed root cell so the caller starts/returns the swapped-in
   * pattern rather than the stale pinned view.
   */
  async #healDefaultRootByRollForward(
    rootToStart: Cell<NameSchema>,
    pinnedRef: { identity: string; symbol: string },
    migrationError: unknown,
    reason: "unloadable" | "unrunnable" = "unrunnable",
  ): Promise<Cell<NameSchema>> {
    const runtime = this.runtime;
    const space = this.getSpace();
    // Reuse the canonical official-URL derivation (home.tsx for the home DID,
    // default-app.tsx otherwise) — never hard-code home here.
    const officialUrlPath = deriveSystemPatternSource(space, runtime);
    const msg = (error: unknown) =>
      error instanceof Error ? error.message : String(error);
    // Name the check that actually refused. Two signals escalate to this heal —
    // a CFC migration rejection and a refused stored argument — and reporting
    // the second as a migration failure sends the reader to the wrong guard.
    const pinnedFailure = reason === "unloadable"
      ? "could not be loaded"
      : isStoredArgumentSchemaRefusal(migrationError)
      ? "could not read its stored argument"
      : "failed CFC migration";
    const clearError = (reason: string, cause: unknown) =>
      new Error(
        `default-root heal failed for ${space}: pinned pattern ` +
          `${pinnedRef.identity}#${pinnedRef.symbol} ${pinnedFailure} ` +
          `(${msg(migrationError)}) and roll-forward to official ` +
          `${officialUrlPath} ${reason}`,
        { cause },
      );

    // Fetch + compile the official source.
    // Force ETag revalidation (`cache: "no-cache"`): the roll-forward exists to
    // ESCAPE a stale pinned pattern, so compiling a stale HTTP-cached source
    // would defeat the heal — it could "roll forward" to the same aged bytes.
    // A 304 still reuses unchanged bytes; we just never trust the cache blind.
    const revalidatingFetch: typeof globalThis.fetch = (input, init) =>
      runtime.fetch(input, { ...init, cache: "no-cache" });
    // Resolve against the host that actually SERVES this space, not the global
    // apiUrl. A mapped space is served by its own host (`mappedHostFor`); the
    // system pattern must be fetched and compiled from there, or a mapped space
    // could roll forward onto the WRONG host's system pattern.
    const officialUrl = patternSourceUrl(
      officialUrlPath,
      runtime.hostForSpace(space),
    );
    let officialPattern;
    let officialRef;
    try {
      const resolved = await runtime.harness.resolve(
        new HttpProgramResolver(officialUrl.href, revalidatingFetch),
      );
      officialPattern = await runtime.patternManager.compilePattern(
        // Default-root routes select the official `default` export.
        { ...resolved, mainExport: "default" },
        { space },
      );
      officialRef = runtime.patternManager.getArtifactEntryRef(officialPattern);
    } catch (compileError) {
      // Chain the ACTUAL compile failure as `cause` (not the migration error):
      // the migration reason is already named in the message, and the compile
      // stack is the new information here.
      throw clearError(
        `could not be compiled (${msg(compileError)})`,
        compileError,
      );
    }
    if (officialRef === undefined) {
      throw clearError("did not yield an entry identity", migrationError);
    }
    // Already current: the pinned pattern IS the official entry (same identity
    // AND symbol) but failed for some other reason. Re-materializing the exact
    // same entry would fail identically, so do not loop — surface the clear
    // error now. Compare BOTH identity and symbol: a root pinned to the current
    // artifact under an obsolete/other symbol (e.g. a persisted export that is
    // no longer `default`) is NOT already-official — rolling it forward to the
    // official `default` entry is exactly the recovery, so it must not
    // short-circuit here.
    const alreadyOfficial = officialRef.identity === pinnedRef.identity &&
      officialRef.symbol === pinnedRef.symbol;
    if (alreadyOfficial && reason === "unrunnable") {
      // The pinned pattern LOADED and its setup was refused. Materializing the
      // same entry again refuses identically, so do not loop — surface the
      // clear error now. A root that could not be loaded is a different case:
      // compiling the official source has just made its artifact available, so
      // the materialize below is the repair.
      throw clearError(
        `is already the pinned entry ${officialRef.identity}#` +
          `${officialRef.symbol}, so this cannot be repaired by rolling ` +
          `forward`,
        migrationError,
      );
    }

    // Atomic swap: record the displaced pinned ref for recovery, move
    // patternIdentity to the official entry, stamp official provenance. One
    // tx — it commits together or aborts, leaving the root untouched.
    //
    // Precondition guard (fail-closed): re-read the root's identity INSIDE the
    // transaction and proceed only if it still equals the pinned ref we
    // diagnosed. `editWithRetry` reruns this callback against fresh state on
    // conflict, so without the guard a concurrent repoint (another boot's
    // heal, a source transition) that already moved the root would be blindly
    // clobbered by our stale `officialRef`. Returning `false` before anything
    // is staged commits a transaction with no writes; `result.ok === false`
    // (no error) then means "superseded".
    if (alreadyOfficial) {
      // Nothing to swap: the root already names the entry the official source
      // compiles to, and that source has just been compiled into this space.
      // Materializing it over the document is the whole repair.
      return await this.#materializeHealedRoot(
        rootToStart,
        officialPattern,
        officialRef,
        clearError,
      );
    }

    const sourceSnapshot = getPieceSourceSnapshot(rootToStart);
    if (sourceSnapshot === undefined) {
      throw clearError("has no source state to update", migrationError);
    }
    const baseline = await preparePieceSourceTransitionBaseline(
      runtime,
      rootToStart,
      sourceSnapshot,
      { allowUnavailable: true },
    );
    const sourceTransition: PieceSourceTransition = {
      revisionId: crypto.randomUUID(),
      baseline,
      timestamp: Date.now(),
      operation: "origin-update",
      origin: officialUrlPath,
      expected: sourceSnapshot,
    };
    const swapResult = await runtime.editWithRetry((tx) => {
      const rootTx = rootToStart.withTx(tx);
      const currentRef = getPatternIdentityRef(rootTx);
      if (
        currentRef?.identity !== pinnedRef.identity ||
        currentRef?.symbol !== pinnedRef.symbol
      ) {
        return false;
      }
      applyPieceSourceTransition(
        runtime,
        rootToStart,
        tx,
        officialRef,
        sourceTransition,
      );
      // A keyless displaced identity must never land durably (L3(a)):
      // `displacedPattern` exists for recovery, recovery to a
      // session-synthetic identity is impossible by construction, and the
      // absent record is the honest one — the same gate
      // `applyPieceSourceTransition`'s unavailable arm applies to ITS stamp
      // four lines up. Reachable with a keyless `pinnedRef` when a legacy
      // orphan pointer coincides with a start failure on a default root.
      if (!PatternManager.isKeylessPatternIdentity(pinnedRef.identity)) {
        rootTx.setMetaRaw("displacedPattern", {
          identity: pinnedRef.identity,
          symbol: pinnedRef.symbol,
          displacedAt: sourceTransition.timestamp,
        }, rawMetaWriteAuthorization);
      }
      rootTx.setMetaRaw(
        "patternIdentity",
        officialRef,
        rawMetaWriteAuthorization,
      );
      return true;
    });
    if (swapResult.error) {
      // Chain the actual commit failure as `cause` (the migration reason is
      // already in the message).
      throw clearError(
        `identity swap could not commit (${msg(swapResult.error)})`,
        swapResult.error,
      );
    }
    if (!swapResult.ok) {
      // The root was repointed by a concurrent heal between the failed repair
      // and this swap. We must NOT overwrite the newer identity (the whole
      // point of the precondition) — but we also must NOT return it as a
      // success: this is the cold-start path, so the caller does not start or
      // materialize what we hand back, and the concurrent heal may still be
      // mid-flight (the repoint commits BEFORE its own materialize). Claiming
      // success here would surface an unstarted, un-setup root. Fail closed
      // with a clear, accurate error; nothing was overwritten, and the next
      // boot observes the settled root and starts/repairs it through the
      // ordinary path.
      pieceUpdateLogger.warn(
        "default-root-roll-forward-superseded",
        () => [
          "startEnsuredDefaultPattern: root identity changed before roll-forward;",
          `leaving concurrent heal in place for ${space}`,
        ],
      );
      throw clearError(
        "was superseded by a concurrent heal (the root identity changed " +
          "before the swap); left in place for the next boot to start",
        migrationError,
      );
    }

    // Re-resolve so the materialize observes the committed patternIdentity
    // (the caller's cell is a pre-swap transaction view), then materialize the
    // OFFICIAL pattern.
    const swappedRoot = await this.#materializeHealedRoot(
      await this.getDefaultPattern(false) ?? rootToStart,
      officialPattern,
      officialRef,
      clearError,
    );

    pieceUpdateLogger.warn(
      "default-root-rolled-forward",
      () => [
        "startEnsuredDefaultPattern: healed by roll-forward to official",
        `${pinnedRef.identity}#${pinnedRef.symbol} ->`,
        `${officialRef.identity}#${officialRef.symbol}`,
      ],
    );
    return swappedRoot;
  }

  /**
   * Stage the healed pattern over the root's existing document.
   *
   * `expectedPatternIdentity` asserts the identity the root must already carry
   * and makes `runSynced` THROW on a setup-commit failure rather than log and
   * continue — so an official pattern that also cannot migrate the document
   * surfaces as one clear error rather than a silently dead root.
   */
  async #materializeHealedRoot(
    root: Cell<NameSchema>,
    pattern: Pattern,
    ref: { identity: string; symbol: string },
    clearError: (reason: string, cause: unknown) => Error,
  ): Promise<Cell<NameSchema>> {
    try {
      await timePiecePhase(
        "ensureDefaultPattern.rollForwardMaterialize",
        () =>
          this.runtime.runSynced(root.withTx(), pattern, undefined, {
            expectedPatternIdentity: ref,
          }),
      );
    } catch (materializeError) {
      // Name which check refused rather than always saying "CFC migration": an
      // argument refusal reaches here too, and reporting that as a migration
      // failure sends the reader to the wrong guard.
      throw clearError(
        `also failed ${
          isCfcMigrationRejection(materializeError)
            ? "CFC migration"
            : "to materialize"
        } (${
          materializeError instanceof Error
            ? materializeError.message
            : String(materializeError)
        })`,
        materializeError,
      );
    }
    return root;
  }
}

async function getCellByIdOrPiece(
  pieces: PiecesController,
  cellId: string,
  label: string,
  options?: { start?: boolean; targetScope?: CellScope },
): Promise<{ cell: Cell<unknown>; isPiece: boolean }> {
  const start = options?.start ?? true;
  // The registry check below compares id STRINGS, and a registered piece
  // reports its own id as the bare tagged hash, so an `of:`-schemed address
  // has to be reduced to that one spelling before it can match. Reducing it
  // out here also keeps a kinded address's refusal out of the catch below,
  // which would otherwise report it as a missing cell. Messages keep `cellId`,
  // so they echo the address the caller actually gave.
  const hashString = hashStringForEntityAddress(cellId);
  try {
    // Try to get as a piece first
    const piece = await pieces.getPieceCell(
      hashString,
      start,
      undefined,
      options?.targetScope,
    );
    if (!piece) {
      throw new Error(`Piece ${cellId} not found`);
    }
    if (
      getMetaLink(piece, "result") === undefined &&
      getPatternIdentityRef(piece) === undefined &&
      // A KEYLESS piece carries no durable pointer (the never-durable
      // contract; L3(a), RULED 2026-08-27); in the session that set it up
      // the runner's session pointer vouches for it.
      pieces.runtime.runner.sessionPatternPointerFor(piece) === undefined
    ) {
      throw new Error(
        `Piece ${cellId} has neither a parent result nor a pattern`,
      );
    }
    return { cell: piece, isPiece: true };
  } catch (_) {
    // If getPieceCell() fails (e.g., "patternId is required"), try as arbitrary
    // cell ID
    try {
      const cell = await pieces.getCellById(
        entityIdFrom(hashString),
        [],
        undefined,
        options?.targetScope,
      );

      // Check whether this cell is registered as a piece.
      const piecesCell = await pieces.getPieceRegistry();
      const registered = piecesCell.get();
      const isRegisteredPiece = registered.some((piece: Cell<unknown>) => {
        const id = pieceId(piece);
        // An entry without a piece ID cannot establish registration.
        if (!id) return false;
        return id === hashString;
      });
      return { cell, isPiece: isRegisteredPiece };
    } catch (_) {
      throw new Error(`${label} "${cellId}" not found as piece or cell`);
    }
  }
}

// Helper function to follow alias chain to its source
const MAX_DEPTH = 10;
function followCellToResult(
  cell: Cell<unknown>,
  diagnosticConsole: RuntimeConsole,
  visited = new Set<string>(),
  depth = 0,
): Cell<unknown> | undefined {
  if (depth > MAX_DEPTH) return undefined; // Prevent infinite recursion

  try {
    const docId = cell.entityId;
    if (!isEntityRef(docId)) return undefined;

    const docIdStr = entityRefToString(docId);

    // Prevent cycles
    if (visited.has(docIdStr)) return undefined;
    visited.add(docIdStr);

    try {
      // If document has result metadata, follow it to the owning result cell.
      const resultLink = getMetaLink(cell, "result");
      if (resultLink !== undefined) {
        const resultCell = cell.runtime.getCellFromLink(resultLink);
        return followCellToResult(
          resultCell,
          diagnosticConsole,
          visited,
          depth + 1,
        );
      }
    } catch (err) {
      // Ignore errors getting doc value
      diagnosticConsole.debug("Error getting doc value:", err);
    }

    return cell; // Return the current document's ID if no further references
  } catch (err) {
    diagnosticConsole.debug("Error in followCellToResult:", err);
    return undefined;
  }
}
