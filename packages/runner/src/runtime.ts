import {
  cloneIfNecessary,
  fabricFromConvertibleJsValue,
  type FabricValue,
} from "@commonfabric/data-model";
import {
  getModernCellRepConfig,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { dataUriFromValue } from "@commonfabric/data-model/codec-data-uri";
import { internSchema } from "@commonfabric/data-model-schema";
import { createSession, Identity } from "@commonfabric/identity";
import { isDID } from "@commonfabric/identity/did";
import { sameAcl } from "@commonfabric/memory/acl";
import {
  acquireServerExecutionEnabler,
  type CellScope,
  commitPreconditionValueHash,
  getCommitPreconditionsConfig,
  getServerExecutionConfig,
  resetCommitPreconditionsConfig,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  serverExecutionEnablerCount,
  setCommitPreconditionsConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import { StaticCache } from "@commonfabric/static";
import {
  type AsyncLocalStore,
  FallbackAsyncLocalStore,
} from "@commonfabric/utils/async-local-store";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isDeno } from "@commonfabric/utils/env";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { PatternEnvironment, setPatternEnvironment } from "./builder/env.ts";
import { popFrame, pushFrame } from "./builder/pattern.ts";
import type {
  AnyCell,
  Frame,
  JSONSchema,
  Module,
  NodeFactory,
  Pattern,
  Schema,
} from "./builder/types.ts";
import { registerBuiltins } from "./builtins/index.ts";
import {
  type Cell,
  createCell,
  internCellLinkSchema,
  isCell,
  schemaCellScope,
} from "./cell.ts";
import {
  buildCfcPolicySnapshot,
  buildCfcReadCeiling,
  buildCfcTrustConfig,
  type CfcConfClause,
  type CfcContentAddressedLabels,
  type CfcDeclaredMonotonicityMode,
  type CfcDecomposedEnvelopes,
  type CfcEnforcementMode,
  type CfcFlowLabelsMode,
  type CfcLabelMetadataProtectionMode,
  type CfcLabelView,
  type CfcPolicyEvaluationMode,
  type CfcPolicyRecordInput,
  type CfcPrefixProvenanceSummary,
  type CfcReadOnExceed,
  type CfcTriggerReadGating,
  type CfcTrustConfig,
  type CfcTrustConfigInput,
  type CfcTxState,
  type CfcWriteFloorMode,
  DEFAULT_SINK_MAX_CONFIDENTIALITY,
  linkCfcLabelView,
  type PolicySnapshot,
  resolveCfcDials,
  type SinkMaxConfidentiality,
  type TrustSnapshot,
} from "./cfc/mod.ts";
import {
  cfcPolicyManifestDocId,
  type PolicyArtifactManifestV1,
  validateCfcPolicyArtifactManifest,
} from "./cfc/policy.ts";
import {
  runtimeOwnedStoreOwnerKey,
  RuntimeOwnedStores,
} from "./cfc/runtime-owned-stores.ts";
import {
  type CfcExternalContentObservation,
  type RuntimeWritePolicyAuthorization,
  runtimeWritePolicyAuthorization,
  runtimeWritePolicyAuthorized,
} from "./cfc/types.ts";
import { collectConsumedLabel, deriveFlowJoin } from "./cfc/prepare.ts";
import { createRef, EntityId } from "./create-ref.ts";
import { waveRunContextOf } from "./executor/wave.ts";
import type { ConsoleMethod } from "./harness/console.ts";
import { Engine } from "./harness/index.ts";
import type { CompiledModuleArtifact } from "./harness/types.ts";
import type { ConsoleMessage } from "./interface.ts";
import { addressKey } from "./link-types.ts";
import {
  CellLink,
  inlineExternalSchemaRefsInValue,
  isCellLink,
  isNormalizedFullLink,
  isSigilLink,
  type NormalizedFullLink,
  NormalizedLink,
  parseLink,
} from "./link-utils.ts";
import { ModuleRegistry } from "./module.ts";
import type { PatternCoverageCollector } from "./pattern-coverage.ts";
import {
  PatternManager,
  type PreparedSourceUpdate,
} from "./pattern-manager.ts";
import { snapshotQueryResult } from "./query-result-proxy.ts";
import { AsyncSemaphoreQueue, type QueueConfig } from "./queue.ts";
import {
  getReaderSchemaPrecedenceConfig,
  setReaderSchemaPrecedenceConfig,
} from "./reader-schema-precedence-config.ts";
import {
  type PieceSourceTransition,
  Runner,
  type RunSyncedCommitResult,
  type RunSyncedOptions,
  type RunSyncedWithCommitOptions,
} from "./runner.ts";
import { Action, Scheduler } from "./scheduler.ts";
import {
  type CommitBackpressurePolicy,
  resolveCommitBackpressure,
} from "./scheduler/backpressure.ts";
import { entityKey, entityNameKey } from "./scheduler/keys.ts";
import {
  getContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "./schema-doc-config.ts";
import { isCellScope, normalizeCellScope, scopeRank } from "./scope.ts";
import { SourceReconciler } from "./source-reconciler.ts";
import { normalizeSpaceHost, SpaceHostValidationError } from "./space-host.ts";
import { EffectsChannel } from "./speculation/effects-channel.ts";
import {
  type EventIntentOutcome,
  SpeculationOverlayDestination,
  stampSpeculationRunContext,
} from "./speculation/overlay-destination.ts";
import { flattenBuilderArtifacts } from "./storage-preflight.ts";
import { ExtendedStorageTransaction } from "./storage/extended-storage-transaction.ts";
import type {
  ACL,
  ChangeGroup,
  CommitError,
  DID,
  IExtendedStorageTransaction,
  IStorageManager,
  IStorageProvider,
  MemorySpace,
  TransactionSealDestination,
  UnexaminedAbsence,
  URI,
} from "./storage/interface.ts";
import {
  markRendererInputTx,
  markUiInputBlindWriteTx,
  setBlindStructuralTarget,
  unmarkUiInputBlindWriteTx,
} from "./storage/reactivity-log.ts";
import { isRetryableCommitRejection } from "./storage/rejection.ts";
import { getDirectTransactionReadActivities } from "./storage/transaction-inspection.ts";
import {
  getWriteStackTrace,
  setWriteStackTraceMatchers,
  type WriteStackTraceEntry,
  type WriteStackTraceMatcher,
} from "./storage/write-stack-trace.ts";
import { type NonIdempotentReport, RuntimeTelemetry } from "./telemetry.ts";
import {
  createUnsafeHostTrustToken,
  type UnsafeHostTrust,
  type UnsafeHostTrustOptions,
} from "./unsafe-host-trust.ts";
import { toURI } from "./uri-utils.ts";
import { ViewReplicationClient } from "./view-replication-client.ts";
const isFullNormalizedLinkShape = (
  value: unknown,
): value is NormalizedLink & {
  id: string;
  space: MemorySpace;
  path: string[];
} => {
  if (!isObjectOrArray(value)) return false;
  const link = value as NormalizedLink;
  if (link.scope === "inherit") {
    throw new Error(
      "NormalizedFullLink.scope cannot be 'inherit'; resolve scope before creating a full link",
    );
  }
  return typeof link.id === "string" &&
    typeof link.space === "string" &&
    Array.isArray(link.path) &&
    (link.scope === undefined || isCellScope(link.scope));
};

// Deno/Node `AsyncLocalStorage` when available, the promise-aware fallback
// otherwise. The `await import` stays here (not in the shared utils module): a
// top-level await in widely-imported utils stalls Deno module evaluation.
const WriteDebugContextStorage = (isDeno()
  // deno-lint-ignore cf-imports/no-inline-module-import
  ? (await import("node:async_hooks")).AsyncLocalStorage
  : FallbackAsyncLocalStore) as new <T>() => AsyncLocalStore<T>;

// @ts-ignore - This is temporary to debug integration test
Error.stackTraceLimit = 500;

export const DEFAULT_MAX_RETRIES = 5;

// Loud, counted channel for UI writes that are finally lost — see
// `Runtime.commitUiCellWrite`. Error level so a dropped user input is
// visible in any console, and counted regardless of level so a run's
// census (`getLoggerCounts`) can see it even where consoles are off.
const uiCellWriteLogger = getLogger("runtime.ui-cell-write", {
  enabled: true,
  level: "error",
});

export type { IExtendedStorageTransaction, MemorySpace };

export interface ConsoleHandlerOutput {
  method: ConsoleMethod;
  args: any[];
  target?: Console;
}

export type ConsoleHandler = (
  message: ConsoleMessage,
) => any[] | ConsoleHandlerOutput;

export type ErrorWithContext = Error & {
  action: Action;
  pieceId: string;
  space: MemorySpace;
  patternId: string;
  spellId: string | undefined;
};

export type ErrorHandler = (error: ErrorWithContext) => void;
export type NavigateCallback = (target: Cell<any>) => void | Promise<void>;
export type PieceCreatedCallback = (piece: Cell<any>) => void;

/**
 * Feature flags for the space-model data-layer changes. Each flag gates an
 * independent piece of the new `FabricValue` pipeline so that the features
 * can be enabled incrementally. Passed via `RuntimeOptions.experimental`;
 * lower-layer flags are propagated to their ambient control points, while
 * runtime-owned flags remain scoped to the Runtime instance.
 *
 * See the formal spec at `docs/specs/space-model-formal-spec/`.
 *
 * Every experimental flag in the repository — these options, the CFC
 * enforcement dials below, and the storage, memory-protocol, and shell flags —
 * is catalogued in `docs/development/EXPERIMENTAL_OPTIONS.md`. Update that
 * registry when adding, changing, or removing a flag.
 */
export interface ExperimentalOptions {
  /** Enable the modern "cell representation" classes. */
  modernCellRep?: boolean | undefined;

  /**
   * Schema writers replace inline schemas with references to
   * content-addressed schema documents
   * (`docs/specs/content-addressed-schemas.md`, Phases 1 and 2): link
   * writers and `$alias` bindings stamp references, a result document's
   * `schema` metadata takes the same reference form, and selectors
   * externalize opportunistically when their closure is already persisted
   * in the target space. Gates emission only; readers and the server
   * accept both forms unconditionally. Defaults to on.
   */
  contentAddressedSchemas?: boolean | undefined;

  /** Enforce scheduler-v2 lineage and event-receipt commit preconditions (default on). */
  commitPreconditions?: boolean | undefined;

  /**
   * Project a handler's plain JSON return into its per-event receipt cell
   * instead of the empty `{}` witness, so a caller — or a same-id retry that
   * collides on the receipt — can read the verb's result back by receipt
   * address. Reactive-bearing returns already project via the result-pattern
   * path; this covers plain values, which are otherwise discarded. Defaults
   * to on since the invocation-protocol integration proof (#5244's
   * three-topic fixture; verb contract,
   * docs/history/plans/pattern-verb-contract-implementation.md WS-C/WS-D).
   * Pass `false` (or `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false`) as a
   * temporary rollback override while the flag exists.
   */
  plainResultReceipts?: boolean | undefined;

  /**
   * Mint computed-scheme entity ids (`computed:fid1:<hash>`) for derived
   * internal cells classified as replayable by the builder. Gates minting
   * only; readers accept both forms unconditionally. Defaults to on; pass
   * `false` as a temporary rollback override. See
   * `docs/specs/computed-cell-identity.md`.
   */
  computedCellIds?: boolean | undefined;

  /**
   * Materialize a lift's argument lazily: the body reads the paths it touches
   * and nothing else, instead of the whole of what its schema selects. A
   * reader that touches data the schema no longer describes refuses, and the
   * run is disposed of as an argument that did not resolve. On by default; pass
   * `false` as a temporary rollback override. See
   * `docs/plans/lazy-cell-materialization.md`.
   */
  lazyMaterialization?: boolean | undefined;

  /**
   * Resolve the schema at a link crossing by reader precedence
   * (`combineSchemaForLink`): the reader's schema stands as-is, and the
   * link's schema is adopted only where the reader is agnostic (true or
   * empty; a false reader stays false). Server-authoritative for deployed
   * CLIs (`EXPERIMENTAL_FLAG_AUTHORITY`); the browser shell bakes it at
   * build time. On by default; an explicit `false` is a temporary rollback
   * override, ambient with last-construction-wins semantics. Dispose does
   * NOT reset it: serving runtimes are per-space and idle-disposed, so a
   * teardown reset would lift a live rollback from under the survivors.
   */
  readerSchemaPrecedence?: boolean | undefined;

  /**
   * Server-execution v2 (docs/specs/server-side-execution/): one flag, two
   * states. OFF is today's behavior byte-for-byte. ON is the v2 posture as
   * its stages land — in it, per-class commit admission is enforced by the
   * memory server (protocol.md §2) and the deferred `stream-data` built-in
   * is disabled with a runtime error (builtins.md §5). Deliberately named
   * unlike v1's SERVER_PRIMARY_EXECUTION so archived docs never alias it.
   */
  serverExecution?: boolean | undefined;

  /**
   * The `agent` builtin (`docs/common/capabilities/agent.md`): a pattern's
   * request for an agent run, staged as a sink request and handed to a
   * runner through an `AgentRun` record. Off, the builtin settles every
   * request with an error naming this flag and stages nothing. Defaults to
   * off.
   */
  agentBuiltin?: boolean | undefined;

  /** Global default for server-selected view replication. Defaults to off. */
  viewScopedReplication?: boolean | undefined;

  /** Web client override; an explicit value takes precedence over the default. */
  webViewScopedReplication?: boolean | undefined;
}

/**
 * Content-addressed cache of compiled MODULE BYTES, injected via
 * `RuntimeOptions.moduleByteCache`. The ESM cell-cache compile path consults it
 * before the per-space storage read — a full hit skips both the storage read and
 * the whole transform-and-emit step (`compileToModules`) — and populates it after
 * a compile, so a module compiled in one runtime or space serves another
 * compiling the same module.
 *
 * Entries are keyed by a module's content identity scoped by the compiled-set
 * `runtimeVersion`; the emitted bytes are a deterministic function of that pair
 * (the emitter strips the whole-program path prefix, so a module's bytes are the
 * same in every program that contains it), so a hit always returns the bytes the
 * identity addresses.
 *
 * The runtime defines only this interface. The implementation, and its
 * persistence, live in test code, so the cache is instantiated only from tests
 * and never in production.
 */
export interface ModuleByteCache {
  /**
   * The cached bodies for `identities` iff EVERY identity is present, else
   * `undefined`. The transform-and-emit step is whole-program, so only a full
   * set lets a compile skip it.
   */
  getCompleteSet(
    runtimeVersion: string,
    identities: readonly string[],
  ): Map<string, CompiledModuleArtifact> | undefined;

  /**
   * Store a freshly compiled (or reused) module set, keyed by content identity
   * scoped by `runtimeVersion`. Idempotent and content-addressed.
   */
  putAll(
    runtimeVersion: string,
    modules: readonly ({ identity: string } & CompiledModuleArtifact)[],
  ): void;
}

export type RuntimeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit & { client?: Deno.HttpClient },
) => Promise<Response>;

/**
 * One pattern materialization: the content-addressed pointer, where it landed,
 * and the entry file it came from.
 *
 * `main` is the program's entry filename (repo-root-relative, e.g.
 * `/packages/patterns/system/home.tsx`). It is what lets a later run map a
 * RECORDED identity back to a source file and compile today's version of it —
 * without it the record says a pattern was here but not which pattern.
 */
export interface PatternInstantiation {
  identity: string;
  symbol: string;
  main?: string;

  /** The result cell the pattern was materialized onto. */
  cell: NormalizedFullLink;
}

export type PatternInstantiationObserver = (
  instantiation: PatternInstantiation,
) => void;

/**
 * What the scheduler knows about a run when it mints the run's
 * transaction (server-execution v2 stage F): the durable action identity
 * (restart-stable — `implementationHash:instanceKey`, the basis index's
 * `action` column) and the run's kind. The serving loop's stamper
 * enriches this with per-run identity (M1) and attaches the wave run
 * context (serving-loop.md §3d).
 */
export type ServerRunInfo = {
  actionId: string;

  /** `bookkeeping` is the sanctioned internal stamp kind
   * (serving-loop.md §3d, RULED 2026-08-05) for runtime-internal commit
   * paths that are neither derivations nor handler runs — the
   * pattern-swap setup write today; the loop's own watermark write uses
   * it directly. */
  kind: "derivation" | "event-handler" | "bookkeeping";

  /**
   * The transaction commits to the store on its own, ahead of the wave the
   * serving loop would otherwise seal it into, so its `commit()` result is
   * the store's verdict and nothing the wave later decides can withdraw it
   * (docs/features/server-pattern-lifecycle.md). Only a `bookkeeping` run
   * asks for this; off the serving posture the stamp is inert and the
   * transaction commits as it would anyway.
   */
  directCommit?: boolean;

  /** The dispatched event's durable id (event-handler runs). */
  eventId?: string;

  /** The emitting run's durable event id for a same-wave cascade
   * (C8d; review 2026-08-11 M2): threaded from the emission's
   * dispatch carriage (ServedEventDispatch.parentEventId) through
   * the SpaceServer's stamper into the wave run context, where the
   * requeue closure folds a cascade child into its requeued
   * parent's rollback. */
  parentEventId?: string;

  /**
   * The run's PER-RUN DEMANDED identity (M1, scopes.md §5: a derivation
   * runs per demanded instance and the DEMAND supplies the identity).
   * Phase 2 completes the SEAM: the SpaceServer's stamper passes it
   * through to the wave run context, the run's scoped reads resolve
   * against it (the tx-carried identity at the traversal sites), its
   * result cells key by it, and its seal/basis/carriage carry it. The
   * SUPPLY — the scheduler running a scoped action once per demanded
   * instance and filling this field per run — is the owed
   * scheduler-instance-dimension follow-up; absent, a run resolves via
   * the wave-level identity (Phase 1's cardinality-1 fallback).
   */
  scopeKeyIdentity?: ScopeKeyIdentity;

  /** The instance key the demanded run serves (resolved from
   * `scopeKeyIdentity` over the demanded root's scope), for basis-row
   * keying (serving-loop.md §3b's `action_scope_key`). */
  actionScopeKey?: ScopeKey;

  /** The ACTING identity of an event-handler run (Phase 3, LD1;
   * events.md §2, protocol.md §2): the server-stamped `firedAt` actor
   * the drain resolved from the stream entry — handlers keep the
   * event's actor (scopes.md §5). Carried into the wave run context's
   * attribution annotations. `session` is absent for a sessionless
   * chain (`firedAt.session = "server"`). */
  acting?: { user: string; session?: string };

  /** The durable stream entry a drained event-handler run consequences
   * (Phase 3; events.md §4): the serving stamper writes the entry's
   * `consequenced` mark INTO the run's own transaction, so the mark and
   * the handler's consequences commit — and roll back — together (the
   * same-transaction atomicity events.md §4 requires; a requeued
   * contribution takes its mark with it). */
  streamEntry?: { sidecarId: string; index: number; seq: number };

  /** The LT1 same-space in-process copy's emitter transaction
   * (ServedEventDispatch.lt1; stage C build W3, (α)): the SpaceServer's
   * stamper resolves it to the copy's APPENDING wave (the wave the
   * emitter sealed into) and refuses the copy's own seal into any
   * other wave (events.md §4). Absent on the drain's
   * `streamEntry`-bearing copies and on every client-side event. */
  lt1?: { emitterTx: IExtendedStorageTransaction };

  /** An EXPLICIT §2b delegated carriage for a `bookkeeping`-kind
   * internal write sanctioned to cross a space boundary (OW31 seat S-A;
   * protocol.md §2b): the compile-cache / program-materialization
   * writeback into a piece's OWN space, riding the carriage of the
   * provisioning or demanding run that triggered it — the served mirror
   * of the client committing the program under the user's own session.
   * The wave's conflict machinery still treats the contribution as
   * bookkeeping (rebase-or-drop; the writeback's own retry re-issues);
   * only the accept gate and the foreign batch's delegated admission
   * read this. Never set on a HOME-space writeback (those stay plain
   * bookkeeping, protocol.md §1's "The SpaceServer's own writes") and
   * never derived by the stamper — the caller attributes the trigger,
   * or the foreign write stays refused (fail-closed). */
  delegated?: {
    acting: { user: string; session?: string };
    capabilityRef: string;
  };
};

/**
 * The per-(action × instance) run SUPPLY's demander resolver
 * (server-execution v2 stage P2-F, reshaped by fan-out stage B): given an
 * action's DEMAND ROOTS, the (principal, session) pairs whose watches
 * reach them — at ANY address, a space-scoped root watch included
 * (scopes.md §2's mechanism sentence: a principal's demand at a broad
 * address is demand for that principal's instance of every node that
 * narrows beneath it). The scheduler derives the INSTANCE set from these
 * demanders and the node's known-scope ratchet (scheduler/fan-out.ts) —
 * the resolver no longer decides an instance from the demand's own
 * scope (P2-F's over-keying, F10). Instances live in keys/basis/stamps
 * and the node's fan-out record, never as extra dependency-graph nodes
 * (the spec-model's C11b).
 */
export type ServerRunDemanderResolver = (
  pieceRootIds: readonly string[],
) => readonly ScopeKeyIdentity[];

export interface RuntimeOptions {
  apiUrl: URL;

  /**
   * Optional map from space DIDs to HTTP or HTTPS origins. Space-bound work
   * (LLM calls, fetches, blob uploads) for a mapped space targets
   * that host; absent map or entry ⇒ `apiUrl`. Mirrors the storage
   * layer's map (StorageManager Options.spaceHostMap) — pass the same
   * one. Fixed for the runtime's lifetime.
   */
  spaceHostMap?: Record<string, string>;

  storageManager: IStorageManager;
  consoleHandler?: ConsoleHandler;
  errorHandlers?: ErrorHandler[];
  patternEnvironment?: PatternEnvironment;
  navigateCallback?: NavigateCallback;
  pieceCreatedCallback?: PieceCreatedCallback;
  debug?: boolean;
  telemetry?: RuntimeTelemetry;

  /** Optional feature flags for experimental space-model data-layer changes. */
  experimental?: ExperimentalOptions;

  /** Client class opting into view replication; only web is supported. */
  clientClass?: "web";

  /**
   * Server-execution v2 (serving-loop.md §3): mark THIS runtime as the
   * SERVING posture — the SpaceServer's own runtime, whose seal
   * destination is the wave machinery installed at activation. A serving
   * runtime NEVER defaults to the Phase-2 client speculation overlay:
   * its pre-activation structure loads and factory-time runs must commit
   * through the loopback plane (the wave destination takes over at
   * activation, and stage F's unstamped-seal refusal guards the gap).
   * Every OTHER runtime under the flag — clients, and non-serving
   * server-side utilities — defaults to the speculation overlay and
   * thereby loses the derivation-commit path by construction
   * (speculation.md; the Phase 2 posture). Ignored in the OFF arm.
   */
  servingPosture?: boolean;

  /** Rollout mode for commit-boundary CFC enforcement. Defaults to `enforce-strict`. */
  cfcEnforcementMode?: CfcEnforcementMode;

  /**
   * Called once for every pattern this runtime materializes onto a result
   * cell, with the content-addressed pointer and where it landed.
   *
   * Exists for the pattern-update state-continuity capture
   * (`tasks/pattern-vintage-run.ts`), which needs the list of update targets a
   * run produced. The store durably labels every root with its
   * `patternIdentity`, but there is no way to ENUMERATE those labels: the `_`
   * wildcard selector is unimplemented, and `sqliteQuery` reaches a
   * cell-derived db rather than the space store. Observing instantiation is
   * how the list is obtained at all — not a second copy of something already
   * readable.
   *
   * Capture-time only. Leave unset in production; a throwing callback is the
   * caller's bug and is not caught here.
   */
  onPatternInstantiated?: PatternInstantiationObserver;

  /**
   * Flow-label propagation dial (S16 default transition). Defaults to
   * `persist`. Propagation requires enforcement mode ≥ `observe` to run at
   * the commit boundary; it derives and persists labels but never rejects by
   * itself.
   */
  cfcFlowLabels?: CfcFlowLabelsMode;

  /**
   * Write-side `requiredIntegrity` floor dial (§8.12.4.1 / SC-18, Epic D3).
   * Defaults to `enforce`. `observe` evaluates the floor and emits
   * diagnostics; `enforce` records a prepare reason on a floor miss
   * (rejecting the commit under the enforcing enforcement modes). The floor
   * tests the written value's integrity, never the consumed-read set.
   */
  cfcWriteFloor?: CfcWriteFloorMode;

  /**
   * Trigger-read gating on the enforcement side (§8.9.2 / SC-3, Epic H5).
   * Defaults to `true`. When true, the addresses whose invalidating writes
   * scheduled a reactive rerun join the consumed set the sink-request egress
   * ceiling and input-requirement gates quantify over (fail-closed; extra
   * metadata resolution per prepare).
   */
  cfcTriggerReadGating?: CfcTriggerReadGating;

  /**
   * Defaults to `false`. When true, the envelope persist path stores the
   * decomposed spelling: the metadata's `schemaHash` names a root document
   * whose `$defs` members are separate content-addressed documents, shared
   * with the link-schema family. Off preserves the merged schema's
   * interned spelling, which may itself carry references. Reading
   * resolves references whenever the stored root carries them, in either
   * setting.
   */
  cfcDecomposedEnvelopes?: CfcDecomposedEnvelopes;

  /**
   * Defaults to `false`. When true, the envelope persist path stores
   * version-2 envelopes: each label above the inline limit is a reference
   * to a content-addressed label document shared by every envelope that
   * carries the label (`docs/specs/content-addressed-cfc-labels.md`). Off
   * stores version 1 with every label inline. Reading resolves either
   * version.
   */
  cfcContentAddressedLabels?: CfcContentAddressedLabels;

  /**
   * Exchange-rule policy evaluation dial (Epic B5, spec §4.4.5). Defaults to
   * `enforce`. `off` decides gates on raw labels, byte-identical to before
   * the dial existed; `observe` evaluates gated labels to fixpoint and emits
   * diagnostics while still deciding on the un-rewritten label; `enforce`
   * decides on the rewritten label and fails closed on fuel exhaustion.
   */
  cfcPolicyEvaluation?: CfcPolicyEvaluationMode;

  /**
   * Cross-space label-metadata representation dial (inv-12 Stage 1 / SC-25,
   * spec §4.6.4.1; docs/specs/cfc-label-metadata-confidentiality.md §2/§5).
   * Defaults to `enforce`. `off` persists label bytes identical to before
   * the dial existed; `observe` computes the classification-governed
   * transformed form for cross-space entries and emits a structured
   * divergence diagnostic while persisting verbatim; `enforce` persists the
   * transformed form (commitment fields as `{digestOf: <hash>}` markers).
   * Representation only — never rejects a commit by itself.
   */
  cfcLabelMetadataProtection?: CfcLabelMetadataProtectionMode;

  /**
   * Declared-component monotonicity gate dial (WP5, spec §8.12.1/§8.12.8;
   * docs/specs/cfc-persisted-declassification.md §4 item 3). Defaults to
   * `observe`. `off` persists the declared re-mint unchecked; `observe`
   * compares each re-minted declared labelMap entry against the stored
   * declared entry at the same path and emits a structured diagnostic on a
   * non-monotone re-mint while persisting those bytes; `enforce` records a
   * fail-closed prepare reason (rejecting the commit under the enforcing
   * enforcement modes). Governs ONLY the `declared` component —
   * derived/link/structure components keep their §8.12.8 disciplines. The
   * default settles at `enforce` once per-principal `addIntegrity` mints —
   * non-monotone declared updates by construction — migrate to the
   * `derived` component.
   */
  cfcDeclaredMonotonicity?: CfcDeclaredMonotonicityMode;

  /**
   * Per-prepare D4 write-prefix precision counters (value-level provenance
   * Stage 0 — docs/specs/cfc-value-level-provenance.md §6, SC-24). Defaults
   * to `false`: the prepare gate then skips all measurement, paying a single
   * presence check. When `true`, each prepared transaction with at least one
   * protected write aggregates prefix-vs-transaction-global gated-read
   * counts, bound-source classifications and S7-exemption fires into
   * `getCfcStats()`. Measurement only — enforcement decisions are
   * byte-identical either way.
   */
  cfcPrefixProvenanceStats?: boolean;

  /** Per-sink confidentiality ceilings for the sink-request egress gate. A sink
   *  absent from the map is ungated; a declared ceiling rejects (or, in observe
   *  mode, flags) a request carrying confidentiality outside it. Defaults to
   *  none declared (`DEFAULT_SINK_MAX_CONFIDENTIALITY`). */
  cfcSinkMaxConfidentiality?: SinkMaxConfidentiality;

  /**
   * Runtime-wide read ceiling: the confidentiality every `db.query` this
   * runtime issues reads under. A query declaring no ceiling of its own reads
   * under this one; a query declaring one (the `maxConfidentiality` option or
   * the Row schema's `MaxConfidentiality`) reads under the meet of the two,
   * so a query tightens this ceiling and never widens it. Placeholder atoms
   * (`{ __ctDbOwner: true }`, `{ __ctCurrentPrincipal: true }`) resolve per
   * query, as they do in a query's own ceiling. Defaults to none: the owner
   * view, every row returned.
   *
   * Per runtime rather than per pattern because the only carrier a pattern
   * can read is a cell in the space, shared by every runtime on it; a lens
   * that differs per device or per run has to ride the runtime. For the same
   * reason the ceiling applies only to a query whose result is
   * session-scoped by the pattern's own declaration (`PerSession<>`,
   * `.asScope("session")`, or a session-scoped db): a space- or user-shared
   * result is one cell every runtime on the space resolves, and a runtime
   * cannot narrow it for itself. A query with a broader result is refused
   * through the runtime's error handlers, and nothing shared is written.
   *
   * The refusal bounds what THIS runtime queries; it does not reach a
   * shared cell another runtime already filled. A pattern whose output is
   * space-scoped and that an unbounded runtime ran first leaves its result
   * in a cell this runtime resolves like any other shared value, refusal or
   * not — so a bounded runtime must run its patterns with session-scoped
   * outputs, and what protects a shared cell is the cell's own label under
   * the commit-boundary gates, not this option. Carrying the ceiling into
   * the cell read path (a labeled cell that does not fit reads as withheld)
   * is the follow-up that closes that seam.
   *
   * Governs the runtime that performs the query — a client runtime executing
   * its own patterns, or a serving runtime for every run it serves — and the
   * sqlite read surface only: every `db.query`, aggregates included. Cell
   * reads are governed by the commit-boundary gates, and a host's direct
   * sqlite bridge refuses labeled tables outright. Validated and deep-frozen
   * at construction; an empty list, which admits nothing, is refused (omit
   * the option for no ceiling).
   *
   * A client under server execution executes no query of its own: the
   * space server's runtime serves them. Its ceiling travels with its
   * sessions instead — declared through the storage manager
   * (`setSessionReadCeiling`) into every signed `session.open` descriptor
   * before a session opens — and the serving loop stamps it onto every run
   * it serves as one of those sessions, whose queries then read under the
   * serving runtime's option met with it. Such a client refuses a storage
   * manager that cannot carry the ceiling, and a server that does not
   * record one (`sessionReadCeiling` absent from its protocol flags).
   */
  cfcReadMaxConfidentiality?: readonly CfcConfClause[];

  /**
   * What a read under the runtime's ceiling does with a row the ceiling does
   * not admit when the query declares no `onExceed` of its own: `fail`
   * refuses the whole query, `skip` drops the row (a declared existence
   * release). On an aggregate/expression projection, where a query's own
   * `skip` is refused because a withheld row already contributed, this
   * default falls back to `fail` rather than refusing a query that declared
   * nothing. A query's own `onExceed` stands over this. Defaults to `fail`.
   * Qualifies
   * `cfcReadMaxConfidentiality` and is refused without it.
   */
  cfcReadOnExceed?: CfcReadOnExceed;

  /**
   * Deployment policy records for the exchange-rule evaluator (Epic B2a,
   * spec §4.3). Validated, digested, and deep-frozen into a `PolicySnapshot`
   * at construction — malformed records throw at boot (fail-closed config,
   * mirroring the sink ceilings' freeze discipline). Defaults to none
   * configured (evaluation is a no-op).
   */
  cfcPolicyRecords?: readonly CfcPolicyRecordInput[];

  /**
   * Deployment trust config for concept-guard satisfaction (Epic B3, spec
   * §4.8): trust statements, verifier delegations, concept edges. Validated,
   * digested, and deep-frozen at construction; malformed config throws at
   * boot. The config digest folds into the DEFAULT trust-snapshot provider's
   * `revision`, so a config change invalidates prepared digests; hosts
   * supplying a custom `trustSnapshotProvider` must fold their own trust
   * versioning into `revision`. Defaults to none configured (every concept
   * guard fails closed).
   */
  cfcTrustConfig?: CfcTrustConfigInput;

  /** Deterministic provider for the trust snapshot attached to each new tx. */
  trustSnapshotProvider?: () => TrustSnapshot | undefined;

  /** Replace runner-owned frames with `<CF_INTERNAL>` in surfaced stacks. */
  hideInternalStackFrames?: boolean;

  /**
   * Tuning for committed-write backpressure under contention. Unset fields fall
   * back to DEFAULT_COMMIT_BACKPRESSURE; tests use this to shrink the backoff
   * and retry window. See scheduler/backpressure.ts.
   */
  commitBackpressure?: Partial<CommitBackpressurePolicy>;

  /**
   * Process-level, content-addressed cache of compiled MODULE BYTES, shared
   * across runtimes. When set, the ESM cell-cache compile path consults it before
   * the per-space storage read and populates it after a compile, so a module
   * compiled in one runtime or space serves another runtime or space compiling
   * the same module. When unset, the byte cache is off and only the per-space
   * cache applies. Holds emitted JS only, never live pattern instances. See
   * {@link ModuleByteCache}.
   */
  moduleByteCache?: ModuleByteCache;

  /**
   * Statement-coverage collector for authored patterns. When set, every compile
   * this runtime performs is instrumented — the transformer injects a hit call
   * in front of each authored statement — and the collector receives the hits.
   * The compiled-byte caches (the process byte cache and the per-space durable
   * cell cache) key the instrumented variant separately from the ordinary one,
   * so an instrumented and an uninstrumented compile of the same source never
   * collide, and a runtime with coverage on never serves or stores uninstrumented
   * bytes. A per-compile `patternCoverage` option still overrides this default.
   * Test-and-CI only; production runtimes leave it unset. See
   * packages/runner/src/pattern-coverage.ts and docs/development/COVERAGE.md.
   */
  patternCoverage?: PatternCoverageCollector;

  /**
   * Override for the outbound `fetch` used by network builtins (`fetchJson` et al).
   * Defaults to the host `globalThis.fetch`. Scoped to this runtime instance, so
   * a test harness can inject a deterministic mock without mutating process
   * globals. (LLM calls mock separately, at the `LLMClient` layer.)
   */
  fetch?: RuntimeFetch;
}

export interface CfcRuntimeStats {
  cfcRelevantTx: number;

  /** Stage C tuning T1: flow-label relevance probes actually EVALUATED
   * (`flowLabelWorkExists`) vs answered from the transaction's memoized
   * negative verdict. Measurement only. */
  flowLabelProbesComputed: number;

  flowLabelProbeMemoHits: number;

  /** Dereference traces recorded, and the largest set any one transaction
   * held. `probeBelongsToDereference` scans a document's traces once per read
   * activity, so the maximum is what decides that scan's cost. Measurement
   * only. */
  dereferenceTracesRecorded: number;

  dereferenceTracesMax: number;

  /** Structured refusal details recorded across transaction prepares. */
  refusalDetailsRecorded: number;

  /** Full consumed-label collections, including sink and host release checks. */
  consumedLabelWalks: number;

  /** Overlap queries containing a wildcard segment. */
  overlapWildcardQueries: number;

  /** Overlap queries containing only concrete segments. */
  overlapConcreteQueries: number;

  /** Authoritative cover lookups for carried link-view entries. */
  authoritativeCoverCalls: number;

  /** Child templates minted by flow persistence. */
  flowTemplateEntriesMinted: number;

  /** Containers receiving child templates from flow persistence. */
  flowTemplateContainers: number;

  cfcPreparedTx: number;
  cfcPrepareRejects: number;
  cfcDigestInvalidations: number;
  cfcOutboxFlushes: number;
  sinkDedupHits: number;
  sinkReleaseRejects: number;
  // Stage-0 D4 write-prefix precision counters
  // (docs/specs/cfc-value-level-provenance.md §6, SC-24). All zero unless
  // `cfcPrefixProvenanceStats` is enabled. Aggregated over the per-prepare
  // summaries; the per-write detail lists are not retained here.

  /** Prepares that measured at least one protected write. */
  prefixProvenanceSummaries: number;

  /** Protected writes measured (requiredIntegrity / maxConfidentiality). */
  prefixProtectedWrites: number;

  /** Gated reads under the shipped D4 per-write prefix. */
  prefixGatedReads: number;

  /** What the pre-D4 transaction-global gate would have counted. */
  prefixTxGlobalGatedReads: number;

  /** Writes bounded by a logged overlapping attempt (prefix engaged). */
  prefixBoundReal: number;

  /** Writes on the +Infinity fallback (no logged overlapping attempt). */
  prefixBoundInfinityFallback: number;

  /** Writes with no ordered write-attempt evidence at all (clock-less). */
  prefixBoundClockLess: number;

  /** S7 provenance-only exemption fires within prefixes. */
  prefixS7ExemptionFires: number;

  /** Read activities without a clock position (treated at -Infinity). */
  prefixClockLessReads: number;
}

const initialCfcRuntimeStats = (): CfcRuntimeStats => ({
  cfcRelevantTx: 0,
  flowLabelProbesComputed: 0,
  flowLabelProbeMemoHits: 0,
  dereferenceTracesRecorded: 0,
  dereferenceTracesMax: 0,
  refusalDetailsRecorded: 0,
  consumedLabelWalks: 0,
  overlapWildcardQueries: 0,
  overlapConcreteQueries: 0,
  authoritativeCoverCalls: 0,
  flowTemplateEntriesMinted: 0,
  flowTemplateContainers: 0,
  cfcPreparedTx: 0,
  cfcPrepareRejects: 0,
  cfcDigestInvalidations: 0,
  cfcOutboxFlushes: 0,
  sinkDedupHits: 0,
  sinkReleaseRejects: 0,
  prefixProvenanceSummaries: 0,
  prefixProtectedWrites: 0,
  prefixGatedReads: 0,
  prefixTxGlobalGatedReads: 0,
  prefixBoundReal: 0,
  prefixBoundInfinityFallback: 0,
  prefixBoundClockLess: 0,
  prefixS7ExemptionFires: 0,
  prefixClockLessReads: 0,
});

/**
 * For these schema, we use type object with empty properties, so that we
 * will fetch the objects and consider them valid, but will not walk into
 * their properties on the server traversal, so we don't need to return every
 * reachable object from these pieces.
 * @see SchemaObjectTraverser.#traverseObjectWithSchema for more detail.
 */
export const spaceCellSchema = internSchema(
  {
    type: "object",
    properties: {
      defaultPattern: {
        type: "object",
        properties: {
          spaces: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, did: { type: "string" } },
            },
          },
          defaultAppUrl: { type: "string" },
          suggestionHistory: {
            type: "array",
            items: {
              type: "object",
              properties: {
                result: { type: "object", asCell: ["cell"] },
                messages: { type: "array" },
                timestamp: { type: "string" },
              },
            },
          },
          recordSuggestion: { asCell: ["stream"] },
        },
        asCell: ["cell"],
      },
    },
  },
);

const CFC_POLICY_MANIFEST_DOC_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const satisfies JSONSchema;

export interface SpaceCellContents {
  defaultPattern: Cell<unknown>;
}

type RuntimeSetupOptions = {
  patternRepository?: string;
  pieceSourceTransition?: PieceSourceTransition;
  initializePieceSourceHistory?: boolean;
  initialPieceSourceOrigin?: string;
  reapplyStoredSetup?: boolean;
  prepareForResume?: boolean;
};

/**
 * Helper for `Runtime.getImmutableCell()`, which tells the storage preflight
 * what a `Cell` stands for -- the sigil link naming it -- and leaves everything
 * else to the walk. A cell has no fabric representation of its own, so one
 * reached anywhere inside a value bound for the data model has to become its
 * link first.
 */
function cellAsLink(value: object | ((...args: never[]) => unknown)): unknown {
  return isCell(value) ? value.toSigilLinkOrNull() : value;
}

type ExternalObservationReceiptPayload = {
  runtime: object;
  sourceTx: IExtendedStorageTransaction;
  targetTx: IExtendedStorageTransaction;
  space: MemorySpace;
  producer: string;
  trustSnapshot: TrustSnapshot | undefined;
  trustConfig: CfcTxState["trustConfig"];
  policySnapshot: { readonly digest: string } | undefined;
  moduleDelegations: CfcTxState["moduleDelegations"];
  posture: readonly unknown[];
  observation: CfcExternalContentObservation;
  consumed: boolean;
};

const externalObservationReceipts = new WeakMap<
  object,
  ExternalObservationReceiptPayload
>();

const externalObservationPosture = (
  state: Readonly<CfcTxState>,
): readonly unknown[] => [
  state.enforcementMode,
  state.flowLabelsMode,
  state.writeFloorMode,
  state.triggerReadGating,
  state.decomposedEnvelopes,
  state.contentAddressedLabels,
  state.policyEvaluationMode,
  state.labelMetadataProtectionMode,
  state.declaredMonotonicityMode,
];

const moduleDelegationsEqual = (
  left: CfcTxState["moduleDelegations"],
  right: CfcTxState["moduleDelegations"],
): boolean => {
  if (left.size !== right.size) {
    return false;
  }
  for (const [space, leftModules] of left) {
    const rightModules = right.get(space);
    if (rightModules === undefined || leftModules.size !== rightModules.size) {
      return false;
    }
    for (const [moduleIdentity, delegated] of leftModules) {
      if (!deepEqual(delegated, rightModules.get(moduleIdentity))) {
        return false;
      }
    }
  }
  return true;
};

const copyModuleDelegations = (
  source: CfcTxState["moduleDelegations"],
): CfcTxState["moduleDelegations"] => {
  const copy = new Map<
    MemorySpace,
    ReadonlyMap<string, readonly string[]>
  >();
  for (const [space, modules] of source) {
    copy.set(
      space,
      new Map(
        [...modules].map(([identity, predecessors]) => [
          identity,
          [...predecessors],
        ]),
      ),
    );
  }
  return copy;
};

const externalObservationRefusal = (
  message: string,
  state?: Readonly<CfcTxState>,
): Error =>
  Object.assign(new Error(message), {
    name: "CfcCommitRefusalError",
    refusals: [...(state?.refusalDetails ?? [])],
  });

/** Maximum load waves an external observation traversal may discover. */
const EXTERNAL_OBSERVATION_LOAD_ROUNDS = 100;

/**
 * Main Runtime class that orchestrates all services in the runner package.
 *
 * This class eliminates the singleton pattern by providing a single entry point
 * for creating and managing all runner services with proper dependency injection.
 *
 * Usage:
 * ```typescript
 * const runtime = new Runtime({
 *   apiUrl: 'https://storage.example.com',
 *   consoleHandler: customConsoleHandler,
 *   errorHandlers: [customErrorHandler]
 * });
 *
 * // Access services through the runtime instance
 * await runtime.storage.loadCell(cellLink);
 * await runtime.scheduler.idle();
 * const pattern = await runtime.patternManager.compilePattern(source);
 * ```
 */
export class Runtime {
  #tearingDownWrites = false;
  readonly #writeTeardown = new AbortController();
  readonly #transactions = new WeakSet<IExtendedStorageTransaction>();

  readonly id: string;
  readonly scheduler: Scheduler;
  readonly patternManager: PatternManager;
  readonly sourceReconciler: SourceReconciler;
  readonly moduleRegistry: ModuleRegistry;
  readonly harness: Engine;
  readonly runner: Runner;
  readonly navigateCallback?: NavigateCallback;
  readonly pieceCreatedCallback?: PieceCreatedCallback;
  readonly cfcEnforcementMode: CfcEnforcementMode;

  /** See `RuntimeOptions.onPatternInstantiated`. */
  readonly onPatternInstantiated?: PatternInstantiationObserver;

  readonly cfcFlowLabels: CfcFlowLabelsMode;
  readonly cfcWriteFloor: CfcWriteFloorMode;
  readonly cfcTriggerReadGating: CfcTriggerReadGating;
  readonly cfcDecomposedEnvelopes: CfcDecomposedEnvelopes;
  readonly cfcContentAddressedLabels: CfcContentAddressedLabels;
  readonly cfcPolicyEvaluation: CfcPolicyEvaluationMode;
  readonly cfcLabelMetadataProtection: CfcLabelMetadataProtectionMode;
  readonly cfcDeclaredMonotonicity: CfcDeclaredMonotonicityMode;
  readonly cfcPrefixProvenanceStats: boolean;
  readonly cfcSinkMaxConfidentiality: SinkMaxConfidentiality;

  /** See `RuntimeOptions.cfcReadMaxConfidentiality`; frozen, or `undefined`. */
  readonly cfcReadMaxConfidentiality: readonly CfcConfClause[] | undefined;

  /** See `RuntimeOptions.cfcReadOnExceed`; `undefined` leaves `fail` in force. */
  readonly cfcReadOnExceed: CfcReadOnExceed | undefined;

  /** Frozen deployment policy snapshot; undefined = no policies configured. */
  readonly cfcPolicySnapshot: PolicySnapshot | undefined;

  /** Frozen deployment trust config; undefined = no trust configured. */
  readonly cfcTrustConfig: CfcTrustConfig | undefined;

  readonly staticCache: StaticCache;
  readonly storageManager: IStorageManager;

  /** Optional process-level compiled-module-byte cache; see RuntimeOptions. */
  readonly moduleByteCache?: ModuleByteCache;

  /** Optional pattern statement-coverage collector; see RuntimeOptions. */
  readonly patternCoverage?: PatternCoverageCollector;

  readonly trustSnapshotProvider: () => TrustSnapshot | undefined;

  /**
   * The runtime's trust revision — `<runtime id>` with the trust-config digest
   * folded in when one is configured. The _one_ composition site for every
   * snapshot this runtime mints (the default provider and
   * `trustSnapshotForPrincipal()`), so a trust-config change invalidates
   * per-run served snapshots exactly as it does ambient client ones.
   */
  readonly #trustRevision: string;

  readonly telemetry: RuntimeTelemetry;

  /** Resolved experimental flags (all properties present with built-in defaults). */
  readonly experimental: ExperimentalOptions;

  /** Resolved committed-write backpressure policy (all fields present). */
  readonly commitBackpressure: CommitBackpressurePolicy;

  readonly apiUrl: URL;
  readonly spaceHostMap?: Record<string, string>;

  /**
   * Outbound `fetch` used by network builtins (e.g. `fetchJson`). Defaults to
   * the host `globalThis.fetch`; a test harness can inject a mock via
   * `RuntimeOptions.fetch`.
   */
  readonly fetch: RuntimeFetch;

  /** Runtime-learned host hints (site table); see registerSpaceHost. */
  #dynamicHosts = new Map<string, string>();

  /**
   * The transaction seal destination (`serving-loop.md` §3d): installed only on
   * a serving runtime under `EXPERIMENTAL_SERVER_EXECUTION`, by the wave
   * machinery around each wave. While installed, every transaction `edit()`
   * creates closes by sealing into it instead of committing to the store. Never
   * installed on a client or in the OFF arm — `installSealDestination()` throws
   * off the flag.
   */
  #transactionSealDestination: TransactionSealDestination | undefined;

  /**
   * The stores this runtime owns: the documents it materializes to hold a
   * piece's machinery. Every transaction `edit()` creates gets the same object,
   * which is what lets a write outside the transaction that minted a store
   * still find it. See `cfc/runtime-owned-stores.ts`.
   */
  readonly #runtimeOwnedStores = new RuntimeOwnedStores();

  /**
   * The serving loop's run stamper (installed _with_ the destination): the
   * scheduler hands it each run's durable action id and kind, and it attaches
   * the wave run context before the tx seals.
   */
  #serverRunStamper:
    | ((tx: IExtendedStorageTransaction, info: ServerRunInfo) => void)
    | undefined;

  /**
   * The per-(action × instance) run-supply resolver (installed _with_ the
   * destination): an action's demand roots (its piece root plus the ancestor
   * roots that instantiated it) → the demanded instances the `SpaceServer`'s
   * registry holds for any of them.
   */
  #serverRunDemanderResolver:
    | ServerRunDemanderResolver
    | undefined;

  /**
   * The client speculation overlay (`speculation.md`): the _default_ seal
   * destination of every runtime under the flag that has no wave destination
   * installed. Created lazily on the first `edit()`; derivation-kind runs
   * redirect their writes into the replica's pending overlay through it — the
   * structural removal of the client derivation-commit path. Never created in
   * the OFF arm.
   */
  #speculationOverlay: SpeculationOverlayDestination | undefined;

  /** The client-effect channel (server-execution v2 Phase 4,
   * protocol.md §5) — constructed for flag-ON non-serving runtimes. */
  #effectsChannel: EffectsChannel | undefined;

  /** The exact spaceOpenObserver closure THIS runtime installed on the
   * (possibly shared) storage manager — dispose clears the manager
   * hook only on identity match, so a later runtime's own hook
   * survives an earlier runtime's teardown (independent review
   * NOTE-a: R1.dispose after R2's construction must not drop R2's
   * subscriptions). */
  #installedSpaceOpenObserver: ((space: MemorySpace) => void) | undefined;

  /**
   * Whether _this_ runtime explicitly set the `serverExecution` flag at
   * construction (the only case its dispose participates in the process-global
   * ambient lifecycle — see the constructor's propagation note).
   */
  #explicitServerExecution: boolean | undefined;

  /** Client class whose replication override applies to this runtime. */
  #clientClass: RuntimeOptions["clientClass"];

  #viewReplication?: ViewReplicationClient;

  /**
   * The enabler release for an explicitly-_enabled_ runtime. The count itself
   * lives with the flag (`memory/v2.ts`, shared with the `ExecutorHost`):
   * dispose releases and the flag resets only when the _last_ live enabler goes
   * — a parked space's dispose must not un-claim `derived` for every other
   * owner's in-flight wave commit (the admission plane reads the ambient
   * value).
   */
  #serverExecutionRelease: (() => void) | undefined;

  /** Serving posture (RuntimeOptions.servingPosture): true only for the
   * SpaceServer's own runtime. Gates the Phase-2 speculation-overlay
   * default (a serving runtime never speculates). */
  readonly servingPosture: boolean;

  readonly userIdentityDID: DID;

  /**
   * The identity this runtime's in-memory instance keys resolve scoped
   * addresses against (key-vocabulary.md §2): its own authenticated
   * session, read through from the storage manager. In the OFF arm every
   * run acts as this one identity — scoped cardinality is 1 per runtime —
   * which is the structural neutrality argument for the stage-E
   * re-keying. Server-side per-run identities (the demand's, the stamped
   * `firedAt`'s) arrive with stage F's run contexts, not from here.
   */
  get scopeKeyIdentity(): ScopeKeyIdentity {
    return this.storageManager.scopeKeyIdentity();
  }

  /**
   * Fires once this runtime stops minting write work, at the point in
   * `dispose()` where retries would otherwise re-run against a storage that
   * is closing. A commit retry that waits on
   * {@link awaitCommitRetryReadiness} passes it so the wait returns at
   * teardown, and reads it afterwards to decide against re-running; the
   * barrier `editWithRetry` observes.
   */
  get writeTeardownSignal(): AbortSignal {
    return this.#writeTeardown.signal;
  }

  /** Cache of resolved PatternFactory.inSpace("name") space DIDs. */
  readonly #spaceNameToDid = new Map<string, MemorySpace>();
  /** The genesisAcl each name was first resolved with, so an identical
   * re-resolution is a retry and a different one is refused. */
  readonly #spaceNameGenesisAcls = new Map<string, ACL>();
  /** Resolutions in flight, by name: a second caller joins the first
   * rather than racing it to registration, so two documents for one name
   * cannot both register before either is cached. */
  readonly #spaceNameResolutions = new Map<string, Promise<MemorySpace>>();

  #defaultFrame?: Frame;
  #queues = new Map<string, AsyncSemaphoreQueue>();
  #writeDebugContext = new WriteDebugContextStorage<string>();
  #cfcStats: CfcRuntimeStats = initialCfcRuntimeStats();
  readonly #policyManifests = new Map<string, PolicyArtifactManifestV1>();
  readonly #policyManifestSpaces = new Map<string, Set<MemorySpace>>();

  /**
   * Attesting space → successor module identity → direct predecessor identities
   * whose writer authority it inherits. Entries come only from verified source
   * closures or integrity-valid compiled closures in that same space.
   * Transactions receive a transitive, immutable snapshot at creation so an
   * in-flight authorization decision cannot change when another module loads,
   * and authorization in one space can never borrow another space's delegation
   * metadata.
   */
  readonly #moduleDelegations = new Map<
    MemorySpace,
    Map<string, Set<string>>
  >();

  registerModuleDelegations(
    space: MemorySpace,
    delegations: ReadonlyMap<string, ReadonlySet<string>>,
  ): void {
    if (typeof space !== "string" || space.length === 0) return;
    const spaceDelegations = this.#moduleDelegations.get(space) ?? new Map();
    for (const [identity, predecessors] of delegations) {
      if (typeof identity !== "string" || identity.length === 0) continue;
      const merged = spaceDelegations.get(identity) ?? new Set<string>();
      for (const predecessor of predecessors) {
        if (
          typeof predecessor === "string" && predecessor.length > 0 &&
          predecessor !== identity
        ) {
          merged.add(predecessor);
        }
      }
      if (merged.size > 0) spaceDelegations.set(identity, merged);
    }
    if (spaceDelegations.size > 0) {
      this.#moduleDelegations.set(space, spaceDelegations);
    }
  }

  /**
   * Whether the delegations registered for `space` let module `identity`
   * exercise the writer authority of `predecessor`, directly or through a
   * chain of predecessors — the relation a transaction's snapshot carries.
   */
  grantsModuleDelegation(
    space: MemorySpace,
    identity: string,
    predecessor: string,
  ): boolean {
    const spaceDelegations = this.#moduleDelegations.get(space);
    if (spaceDelegations === undefined) return false;
    const visited = new Set<string>();
    const pending = [...(spaceDelegations.get(identity) ?? [])];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (next === predecessor) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(...(spaceDelegations.get(next) ?? []));
    }
    return false;
  }

  #moduleDelegationSnapshot(sourceUpdate?: PreparedSourceUpdate): Map<
    MemorySpace,
    ReadonlyMap<string, readonly string[]>
  > {
    const snapshot = new Map<
      MemorySpace,
      ReadonlyMap<string, readonly string[]>
    >();
    const delegations = new Map(this.#moduleDelegations);
    if (sourceUpdate !== undefined) {
      const proposal = this.patternManager.sourceUpdateDelegations(
        sourceUpdate,
      );
      const combined = new Map(delegations.get(proposal.space));
      for (const [identity, predecessors] of proposal.delegations) {
        combined.set(
          identity,
          new Set([
            ...(combined.get(identity) ?? []),
            ...predecessors,
          ]),
        );
      }
      delegations.set(proposal.space, combined);
    }
    for (const [space, spaceDelegations] of delegations) {
      const spaceSnapshot = new Map<string, readonly string[]>();
      for (const identity of spaceDelegations.keys()) {
        const inherited = new Set<string>();
        const pending = [...(spaceDelegations.get(identity) ?? [])];
        while (pending.length > 0) {
          const predecessor = pending.pop()!;
          if (predecessor === identity || inherited.has(predecessor)) continue;
          inherited.add(predecessor);
          pending.push(...(spaceDelegations.get(predecessor) ?? []));
        }
        if (inherited.size > 0) {
          spaceSnapshot.set(identity, [...inherited].sort());
        }
      }
      if (spaceSnapshot.size > 0) {
        snapshot.set(space, spaceSnapshot);
      }
    }
    return snapshot;
  }

  registerCfcPolicyManifests(
    space: MemorySpace | undefined,
    inputs: readonly unknown[],
  ): void {
    for (const input of inputs) {
      const artifact = validateCfcPolicyArtifactManifest(input);
      const existing = this.#policyManifests.get(artifact.policyDigest);
      // Reaching this branch requires a collision in the canonical SHA-256
      // digest: validation recomputes the digest for both artifacts.
      if (existing !== undefined && !deepEqual(existing, artifact)) {
        throw new Error(
          `cfcPolicyManifest: immutable digest collision for ${artifact.policyDigest}`,
        );
      }
      this.#policyManifests.set(artifact.policyDigest, artifact);
      let spaces = this.#policyManifestSpaces.get(artifact.policyDigest);
      if (spaces === undefined) {
        spaces = new Set();
        this.#policyManifestSpaces.set(artifact.policyDigest, spaces);
      }
      if (space !== undefined) spaces.add(space);
    }
  }

  resolveCfcPolicyManifest(
    reference: unknown,
    tx?: IExtendedStorageTransaction,
    destinationSpace?: MemorySpace,
    bindCommit = true,
  ): PolicyArtifactManifestV1 | undefined {
    if (tx === undefined) return this.#registeredCfcPolicyManifest(reference);
    if (destinationSpace !== undefined) {
      return this.#readCfcPolicyManifest(
        destinationSpace,
        reference,
        tx,
        bindCommit,
      );
    }
    let artifact: PolicyArtifactManifestV1 | undefined;
    const spaces = new Set<MemorySpace>();
    const log = tx.getReactivityLog?.();
    for (const address of [...(log?.writes ?? []), ...(log?.reads ?? [])]) {
      spaces.add(address.space);
    }
    for (const space of spaces) {
      artifact = this.#readCfcPolicyManifest(space, reference, tx);
      if (artifact !== undefined) {
        if (bindCommit) {
          artifact = this.#readCfcPolicyManifest(space, reference, tx, true);
        }
        break;
      }
    }
    return artifact;
  }

  #registeredCfcPolicyManifest(
    reference: unknown,
  ): PolicyArtifactManifestV1 | undefined {
    if (
      !reference || typeof reference !== "object" || Array.isArray(reference)
    ) {
      return undefined;
    }
    const candidate = reference as Record<string, unknown>;
    if (typeof candidate.policyDigest !== "string") return undefined;
    const artifact = this.#policyManifests.get(candidate.policyDigest);
    return artifact !== undefined &&
        artifact.manifest.moduleIdentity === candidate.moduleIdentity &&
        artifact.manifest.symbol === candidate.symbol
      ? artifact
      : undefined;
  }

  hasCfcPolicyManifest(
    space: MemorySpace,
    reference: unknown,
    tx?: IExtendedStorageTransaction,
  ): boolean {
    const artifact = tx === undefined
      ? this.#registeredCfcPolicyManifest(reference)
      : this.#readCfcPolicyManifest(space, reference, tx);
    return artifact !== undefined &&
      this.#policyManifestSpaces.get(artifact.policyDigest)?.has(space) ===
        true;
  }

  installCfcPolicyManifest(
    space: MemorySpace,
    reference: unknown,
    tx?: IExtendedStorageTransaction,
  ): boolean {
    const artifact = this.#registeredCfcPolicyManifest(reference) ??
      (tx === undefined
        ? undefined
        : this.#readCfcPolicyManifest(space, reference, tx));
    if (artifact === undefined) return false;
    if (tx !== undefined) {
      const cell = this.getCellFromEntityId(
        space,
        cfcPolicyManifestDocId(artifact.policyDigest),
        [],
        CFC_POLICY_MANIFEST_DOC_SCHEMA,
        tx,
      );
      const existing = snapshotQueryResult(cell.get());
      if (existing === undefined) {
        cell.set(artifact);
        tx.markCreateOnly?.(cell.getAsNormalizedFullLink());
      } else {
        let verified: PolicyArtifactManifestV1;
        try {
          verified = validateCfcPolicyArtifactManifest(existing);
        } catch (error) {
          throw new Error(
            `cfcPolicyManifest: invalid destination artifact for ${artifact.policyDigest}`,
            { cause: error },
          );
        }
        if (!deepEqual(verified, artifact)) {
          throw new Error(
            `cfcPolicyManifest: immutable destination collision for ${artifact.policyDigest}`,
          );
        }
      }
    }
    // Both registered and durable-loaded artifacts pass through
    // registerCfcPolicyManifests(), which creates this companion set.
    const spaces = this.#policyManifestSpaces.get(artifact.policyDigest)!;
    spaces.add(space);
    return true;
  }

  #readCfcPolicyManifest(
    space: MemorySpace,
    reference: unknown,
    tx: IExtendedStorageTransaction,
    bindCommit = false,
  ): PolicyArtifactManifestV1 | undefined {
    if (
      !reference || typeof reference !== "object" || Array.isArray(reference)
    ) return undefined;
    const candidate = reference as Record<string, unknown>;
    if (typeof candidate.policyDigest !== "string") return undefined;
    const cell = this.getCellFromEntityId(
      space,
      cfcPolicyManifestDocId(candidate.policyDigest),
      [],
      CFC_POLICY_MANIFEST_DOC_SCHEMA,
      tx,
    );
    const stored = snapshotQueryResult(cell.get());
    if (bindCommit) {
      const link = cell.getAsNormalizedFullLink();
      const rawStored = tx.readOrThrow({
        space: link.space,
        id: link.id,
        scope: link.scope,
        type: "application/json",
        path: ["value"],
      });
      const alreadyWritten = tx.getReactivityLog?.().writes.some((address) =>
        address.space === link.space && address.id === link.id &&
        address.scope === link.scope
      ) ?? false;
      if (!alreadyWritten) {
        if (!tx.addCommitPrecondition) {
          throw new Error(
            "cfcPolicyManifest: storage cannot bind manifest consultation",
          );
        }
        tx.addCommitPrecondition(space, {
          kind: "entity-value-hash",
          id: link.id,
          scope: link.scope,
          valueHash: rawStored === undefined
            ? null
            : commitPreconditionValueHash(rawStored),
        });
      }
    }
    if (stored === undefined) return undefined;
    let artifact: PolicyArtifactManifestV1;
    try {
      artifact = validateCfcPolicyArtifactManifest(stored);
    } catch {
      return undefined;
    }
    if (
      artifact.policyDigest !== candidate.policyDigest ||
      artifact.manifest.moduleIdentity !== candidate.moduleIdentity ||
      artifact.manifest.symbol !== candidate.symbol
    ) return undefined;
    this.registerCfcPolicyManifests(space, [artifact]);
    return artifact;
  }

  constructor(options: RuntimeOptions) {
    // Validate-then-apply: option combinations are refused BEFORE any
    // process-global write (the ambient experimental-flag propagation
    // below, the server-execution enabler), so a refused construction
    // leaves no trace in the process — the try/catch further down rolls
    // back only the enabler, and everything above it must not need
    // rolling back. A serving runtime uses the DEFAULT trust-snapshot
    // provider — the run stamper attaches per-run snapshots via
    // trustSnapshotForPrincipal (serving-loop.md §3c), whose revision is
    // the runtime's own; a custom provider would be silently bypassed
    // for every acting run and would compose a revision the stamper
    // does not know. Fail loud instead.
    if (
      options.servingPosture === true &&
      options.trustSnapshotProvider !== undefined
    ) {
      throw new Error(
        "A serving runtime cannot take a custom trustSnapshotProvider: " +
          "the run stamper attaches per-run trust snapshots composed on " +
          "the runtime's own trust revision (serving-loop.md §3c), which " +
          "would silently bypass the custom provider for acting runs.",
      );
    }
    this.#clientClass = options.clientClass;
    this.experimental = {
      modernCellRep: undefined,
      commitPreconditions: undefined,
      plainResultReceipts: undefined,
      computedCellIds: undefined,
      lazyMaterialization: undefined,
      serverExecution: undefined,
      ...options.experimental,
    };

    // Log any overridden experimental flags. Never on stdout: the cf CLI's
    // machine-readable output (`cf piece ls` etc.) is consumed by scripts, and
    // this banner made every command's stdout non-empty under a flag override.
    // Not console.error/warn either: the cf test console enforcement fails
    // tests on those. Direct process stderr in Deno; plain console in browser
    // realms (no stdout contract there).
    const overrideFlags = Object.entries(this.experimental)
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`);
    if (overrideFlags.length > 0) {
      const banner = `Experimental flag overrides: ${overrideFlags.join(", ")}`;
      if (typeof Deno !== "undefined" && Deno.stderr) {
        Deno.stderr.writeSync(new TextEncoder().encode(banner + "\n"));
      } else {
        console.log(banner);
      }
    }

    // Unlike ambient flags, computedCellIds and plainResultReceipts are
    // consumed from this Runtime instance (the builder frame and the runner's
    // receipt-only branch respectively). Normalize their local defaults after
    // override logging so an omitted option does not appear as an explicit
    // `true` override.
    this.experimental.computedCellIds ??= true;
    this.experimental.plainResultReceipts ??= true;
    this.experimental.lazyMaterialization ??= true;

    // Propagate experimental flags to their ambient control points, then read
    // back the effective state so `experimental.*` reflects what is actually in
    // effect (matters when the caller didn't pass an explicit value and the
    // default happens to be `true`; without this, consumers would see
    // `undefined` and probably get very confused).
    setModernCellRepConfig(this.experimental.modernCellRep);
    this.experimental.modernCellRep = getModernCellRepConfig();
    setContentAddressedSchemasConfig(
      this.experimental.contentAddressedSchemas,
    );
    this.experimental.contentAddressedSchemas =
      getContentAddressedSchemasConfig();
    setReaderSchemaPrecedenceConfig(
      this.experimental.readerSchemaPrecedence,
    );
    this.experimental.readerSchemaPrecedence =
      getReaderSchemaPrecedenceConfig();
    // The sync schema table stays negotiated under this flag: the two
    // mechanisms dedupe the same link-schema positions and compose (the
    // table encoder skips reference-only positions), and stored links
    // minted before the flag still carry inline schemas that only the
    // table compresses in flight — delivering that stock uncompressed
    // pushes a large space's sync past Deno's 64 MiB inbound websocket
    // frame cap (#6319). The table retires by ceasing to match once
    // reference-bearing links dominate (content-addressed-schemas.md,
    // Phase 3), not by a construction-time switch.
    setCommitPreconditionsConfig(this.experimental.commitPreconditions);
    this.experimental.commitPreconditions = getCommitPreconditionsConfig();
    // Propagate only when EXPLICITLY set (stage F): a co-hosted serving
    // process (toolshed under the ON arm) constructs runtimes for many
    // purposes, and an unconditional `undefined -> false` write from any
    // flag-less construction would stomp the process-global ambient flag
    // the memory server's derived admission reads — silently un-claiming
    // `derived` mid-serve. In a process where nothing enables the flag
    // the ambient default is already false, so the OFF arm is unchanged.
    if (this.experimental.serverExecution !== undefined) {
      this.#explicitServerExecution = this.experimental.serverExecution;
      if (this.experimental.serverExecution === true) {
        this.#serverExecutionRelease = acquireServerExecutionEnabler();
      } else if (serverExecutionEnablerCount() === 0) {
        // Explicit false writes the ambient flag ONLY while no enabler
        // is live: a co-hosted non-serving runtime must not un-claim
        // `derived` for a live serving runtime's in-flight wave commits.
        // (With no enabler the ambient default is already false; the
        // write keeps the direct-set test seam overridable.)
        setServerExecutionConfig(false);
      }
    }
    // The runtime's OWN posture: its explicit value verbatim; only a
    // flag-less construction reads the ambient state through.
    this.experimental.serverExecution = this.#explicitServerExecution ??
      getServerExecutionConfig();
    this.servingPosture = options.servingPosture === true;
    // Everything below can throw (URL parsing, host validation, engine
    // construction). The enabler claimed above is process-global state,
    // so a THROWING construction must roll it back — a leaked enabler
    // would pin the ambient flag for the process lifetime.
    try {
      this.commitBackpressure = resolveCommitBackpressure(
        options.commitBackpressure,
      );

      this.id = options.storageManager.id;
      this.apiUrl = new URL(options.apiUrl);
      // Validate eagerly, mirroring the storage layer's resolver: a
      // malformed host should fail at configuration time naming the
      // space, not mid-builtin as a bare Invalid URL.
      const normalizedSpaceHostMap: Record<string, string> = {};
      for (const [space, host] of Object.entries(options.spaceHostMap ?? {})) {
        let route: URL;
        try {
          route = normalizeSpaceHost(host);
        } catch (cause) {
          if (!(cause instanceof SpaceHostValidationError)) throw cause;
          throw new Error(
            `Invalid spaceHostMap entry for ${space}`,
            { cause },
          );
        }
        normalizedSpaceHostMap[space] = route.toString();
      }
      // Snapshot + freeze: the map is fixed for the runtime's lifetime
      // (the per-space provider cache and routing decisions assume
      // space → host never changes), so a caller mutating their object
      // after construction must not change routing.
      this.spaceHostMap = options.spaceHostMap
        ? Object.freeze(normalizedSpaceHostMap)
        : undefined;
      // Default is a late-bound wrapper that reads `globalThis.fetch` at call time,
      // preserving the existing behavior where a test overrides the global AFTER
      // constructing the runtime (e.g. fetch-mutex-core.test.ts). An injected
      // mock is used as-is.
      this.fetch = options.fetch ??
        ((input, init) => globalThis.fetch(input, init));
      this.staticCache = isDeno()
        ? StaticCache.fromFileSystem()
        : new StaticCache(new URL("/static", this.apiUrl));

      this.telemetry = options.telemetry ?? new RuntimeTelemetry();

      // Create harness first (no dependencies on other services)
      this.harness = new Engine(this, {
        hideInternalStackFrames: options.hideInternalStackFrames,
      });

      this.storageManager = options.storageManager;
      // Hand the storage layer the telemetry bus so it can emit the
      // storage.push/pull markers (duck-typed: only the v2 StorageManager
      // implements it; emulated/test managers simply don't have the method).
      (this.storageManager as {
        setTelemetry?: (telemetry: RuntimeTelemetry) => void;
      }).setTelemetry?.(this.telemetry);
      this.moduleByteCache = options.moduleByteCache;
      this.patternCoverage = options.patternCoverage;
      // Validated + digested + frozen before the trust-snapshot provider
      // default below, whose `revision` covers the config digest (a trust
      // config change must invalidate prepared digests like any other
      // trust-snapshot change — see RuntimeOptions.cfcTrustConfig).
      this.cfcTrustConfig = buildCfcTrustConfig(options.cfcTrustConfig);
      const actingPrincipal = options.storageManager.as.did() as DID;
      this.#trustRevision = this.cfcTrustConfig === undefined
        ? this.id
        : `${this.id}/trust:${this.cfcTrustConfig.digest}`;
      this.trustSnapshotProvider = options.trustSnapshotProvider ??
        (() => this.trustSnapshotForPrincipal(actingPrincipal));
      this.userIdentityDID = options.storageManager.as.did() as DID;
      this.moduleRegistry = new ModuleRegistry(this);
      this.patternManager = new PatternManager(this);
      this.sourceReconciler = new SourceReconciler(this);
      this.runner = new Runner(this);
      this.onPatternInstantiated = options.onPatternInstantiated;
      // Resolved through the shared dial table (`cfc/posture-report.ts`), so
      // a host that publishes the posture of a runtime it has not built yet
      // reads the same defaults these fields do.
      const dials = resolveCfcDials(options);
      this.cfcEnforcementMode = dials.cfcEnforcementMode;
      this.cfcFlowLabels = dials.cfcFlowLabels;
      this.cfcWriteFloor = dials.cfcWriteFloor;
      this.cfcTriggerReadGating = dials.cfcTriggerReadGating;
      this.cfcDecomposedEnvelopes = dials.cfcDecomposedEnvelopes;
      this.cfcContentAddressedLabels = dials.cfcContentAddressedLabels;
      this.cfcPolicyEvaluation = dials.cfcPolicyEvaluation;
      this.cfcLabelMetadataProtection = dials.cfcLabelMetadataProtection;
      this.cfcDeclaredMonotonicity = dials.cfcDeclaredMonotonicity;
      this.cfcPrefixProvenanceStats = options.cfcPrefixProvenanceStats ?? false;
      // Deep-freeze: the ceiling is CFC enforcement config, so a caller must not
      // be able to mutate it (per-sink array or the map) after construction to
      // change what egresses are allowed (review on #3993).
      this.cfcSinkMaxConfidentiality = Object.freeze(
        Object.fromEntries(
          Object.entries(
            options.cfcSinkMaxConfidentiality ??
              DEFAULT_SINK_MAX_CONFIDENTIALITY,
          ).map(([sink, atoms]) => [sink, Object.freeze([...atoms])]),
        ),
      );
      // Same posture as the sink ceilings: validated and frozen here, so a
      // malformed or empty read ceiling refuses to boot rather than admitting
      // nothing at every query.
      const readCeiling = buildCfcReadCeiling(options);
      // A client under server execution executes no query of its own — the
      // space server's runtime serves them — so its ceiling travels with
      // its sessions (`SessionDescriptor.readCeiling`, declared through the
      // storage manager before any session opens) and the serving loop
      // stamps it onto every run it serves as one of them. A manager that
      // cannot carry it is refused here: a ceiling accepted over one would
      // read as a bounded session whose reads nothing bounds.
      if (
        readCeiling.maxConfidentiality !== undefined &&
        this.experimental.serverExecution === true && !this.servingPosture
      ) {
        if (this.storageManager.setSessionReadCeiling === undefined) {
          throw new Error(
            "cfcReadMaxConfidentiality does not bound a client under server " +
              "execution over this storage manager: its queries are served " +
              "by the space server's runtime, and the manager cannot carry " +
              "the ceiling to it (`setSessionReadCeiling`)",
          );
        }
        this.storageManager.setSessionReadCeiling({
          maxConfidentiality: readCeiling.maxConfidentiality,
          ...(readCeiling.onExceed !== undefined
            ? { onExceed: readCeiling.onExceed }
            : {}),
        });
      }
      this.cfcReadMaxConfidentiality = readCeiling.maxConfidentiality;
      this.cfcReadOnExceed = readCeiling.onExceed;
      // Validates + digests + deep-freezes; throws on malformed records so a
      // config error surfaces at boot, not as a silently inert rule (same
      // eager-validation posture as the spaceHostMap URLs above).
      this.cfcPolicySnapshot = buildCfcPolicySnapshot(options.cfcPolicyRecords);

      // Create core services with dependencies injected
      this.scheduler = new Scheduler(
        this,
        options.consoleHandler,
        options.errorHandlers,
      );

      // Register built-in modules with runtime injection
      registerBuiltins(this);

      // Set this runtime as the current runtime for global cell compatibility
      // Removed setCurrentRuntime call - no longer using singleton pattern

      // Set the navigate callback
      this.navigateCallback = options.navigateCallback;
      this.pieceCreatedCallback = options.pieceCreatedCallback;

      // The client-effect channel (server-execution v2 Phase 4,
      // protocol.md §5): every flag-ON NON-serving runtime subscribes to
      // its session's effects-doc instance per space — the enact/ack duty
      // the Phase-4 posture adds. The serving runtime never enacts (the
      // SpaceServer computes intents; clients enact), and the OFF arm
      // pays nothing here.
      if (
        this.experimental.serverExecution === true && !this.servingPosture
      ) {
        const channel = new EffectsChannel(this);
        this.#effectsChannel = channel;
        const manager = this.storageManager;
        const observer = (space: MemorySpace) =>
          channel.ensureSubscribed(space);
        this.#installedSpaceOpenObserver = observer;
        manager.spaceOpenObserver = observer;
        for (const space of manager.openedSpaces?.() ?? []) {
          channel.ensureSubscribed(space);
        }
      }

      // Handle pattern environment configuration. Only set the (process-global)
      // pattern environment when a host explicitly provides one — setting it
      // unconditionally from every Runtime would let the last-constructed runtime
      // clobber the apiUrl other runtimes' patterns see. Hosts that run patterns
      // server-side (the toolshed) pass `patternEnvironment` so handler `fetch`es
      // reach the right toolshed rather than the hardcoded `localhost:<port>`
      // fallback in builder/env.ts. This is still a singleton. TODO(seefeld).
      if (options.patternEnvironment) {
        setPatternEnvironment(options.patternEnvironment);
      }

      if (options.debug) {
        console.log("Runtime initialized with services:", {
          scheduler: !!this.scheduler,
          storageManager: !!this.storageManager,
          patternManager: !!this.patternManager,
          moduleRegistry: !!this.moduleRegistry,
          harness: !!this.harness,
          runner: !!this.runner,
          telemetry: !!this.telemetry,
        });
      }

      // Push a default frame with this runtime so builder functions can access it
      this.#defaultFrame = pushFrame({ runtime: this });
    } catch (error) {
      this.#releaseServerExecutionEnabler();
      throw error;
    }
  }

  /**
   * Wait for reactive quiescence: no scheduler pass running, no queued events,
   * no background scheduler work. Does NOT wait for issued commits to be
   * confirmed by the server (`scheduler.idleWithPendingCommits()`), for async
   * builtin I/O (`settled()`), or for storage sync (`storageManager.synced()`).
   */
  idle(): Promise<void> {
    return this.scheduler.idle();
  }

  /**
   * In-flight async builtin operations — the work async builtins (`fetchJson`,
   * `fetchProgram`, `llm`/`llmDialog`, reactive sqlite queries, and navigation)
   * perform _after_ their handler returns, from a post-commit outbox flush: a
   * network, LLM, or navigation call or a sqlite RPC, plus any result
   * writeback. `idle()` deliberately does _not_ wait for these; `settled()`
   * does.
   *
   * Each entry carries the pattern run it belongs to, as the address key of the
   * run's result cell — the `parentCell` every raw builtin is handed. Entries
   * with no owner belong to no single run: the scheduler's commit promises,
   * which are the barrier that a fire-and-forget builtin's outbox flush has
   * registered its own work. `settledFor()` waits for those as well as the
   * run's own, because that handoff is how the run's work first becomes
   * visible.
   */
  #pendingAsyncWork = new Map<Promise<unknown>, string | undefined>();

  /**
   * Serving-loop observer of async builtin work (server-execution v2
   * stage G): the SpaceServer's outbox installs one on the serving
   * runtime so effect work registered during a flush's synchronous
   * prefix counts toward the §7 outbox counters. Undefined everywhere
   * else — the OFF arm and client runtimes pay one undefined check.
   */
  asyncWorkObserver: ((work: Promise<unknown>) => void) | undefined;

  /**
   * Observer of memo hits and completions whose request has been superseded.
   * The serving loop uses these events for its memo and outbox counters.
   */
  effectMemoObserver:
    | ((event: { kind: "hit" | "superseded"; id: string }) => void)
    | undefined;

  /**
   * The served `navigateTo` connectivity probe (server-execution v2
   * Phase 4; builtins.md §4's LT3 ruling): whether (principal,
   * sessionId) holds a live session on the serving space — the intent
   * write requires the acting session CONNECTED to the COMPUTING space,
   * else there is no channel to deliver the intent on. Installed by the
   * SpaceServer at activation on the serving runtime; undefined
   * everywhere else (the served half then skips the check — unit
   * fixtures without a memory server co-host).
   */
  connectedSessionProbe:
    | ((principal: string, sessionId: string) => boolean)
    | undefined;

  /**
   * Count a served navigate-intent seal failure (server-execution v2
   * Phase 4; serving-loop.md §7's `servedIntentSealFailures`): the
   * builtin's intent tx resolved `{ error }` (or rejected) at its seal.
   * Installed by the SpaceServer at activation on the serving runtime —
   * the counter's home is the serving loop's stats block — and
   * undefined everywhere else (the failure is still logged loudly by
   * the builtin either way).
   */
  notifyServedIntentSealFailure: (() => void) | undefined;

  /**
   * Server-execution v2 stage P2-F (the F1 fold-in, RULED 2026-08-13):
   * a PIECE-START setup/instantiation commit that fails — refused at
   * the wave seal, withdrawn, or rejected — surfaces here. The start
   * path is deliberately fire-and-forget (start() resolves before its
   * commit settles), so without this seam the refusal Result was
   * SWALLOWED and the piece silently ran against stale setup. The
   * SpaceServer installs the observer at activation and counts the
   * failure into §7's `structureLoadFailures` (a demanded-structure
   * load that failed, asynchronously); the runner's loud error log
   * rides the same reporting call in every arm.
   */
  pieceStartCommitFailureObserver:
    | ((failure: { actionId: string; error: unknown }) => void)
    | undefined;

  /**
   * Server-execution v2 stage C tuning (T3; serving-loop.md §2/§3): the
   * serving scheduler's mid-wave hook. A SERVING runtime's scheduler
   * yields one macrotask between runs whenever its slice of continuous
   * work is spent (scheduler/cooperative-yield.ts — that is what makes the
   * wave's flush deadline honest and lets the lease-renew and push-flush
   * timers fire mid-settle), and calls this observer synchronously at
   * every such yield. The SpaceServer installs it at activation to renew
   * the lease mid-wave once the wave has run longer than TTL/3 — a renew
   * that never depends on the timer queue being serviced. Undefined
   * everywhere else (the OFF arm and clients construct no yielder at all).
   */
  servingYieldObserver: (() => void) | undefined;

  /**
   * Register an in-flight async builtin operation so `settled()` waits for it
   * instead of racing the post-commit flush. The scheduler registers an
   * effect-bearing commit's promise here (a race-free barrier — the flush runs
   * inside that commit), and the fire-and-forget builtins register their
   * network/LLM promise. Normalized to always resolve (failures are settled, not
   * thrown) and auto-removed once it settles, so a rejecting promise is safe and
   * never leaks.
   *
   * `owner` is the pattern run the work belongs to — the `parentCell` a raw
   * builtin is given, which is the result cell of the run that instantiated it.
   * Passing it is what lets `settledFor` wait for one run rather than the whole
   * runtime. Omit it only for work that belongs to no single run.
   */
  trackAsyncWork(promise: Promise<unknown>, owner?: Cell<any>): void {
    this.asyncWorkObserver?.(promise);
    const tracked = promise.then(() => {}, () => {});
    const ownerKey = owner === undefined
      ? undefined
      : addressKey(owner.getAsNormalizedFullLink());
    this.#pendingAsyncWork.set(tracked, ownerKey);
    tracked.finally(() => this.#pendingAsyncWork.delete(tracked));
  }

  /**
   * Wait until the runtime is fully settled: the scheduler is idle, storage is
   * synced, AND every in-flight async builtin operation (`trackAsyncWork`) has
   * completed — including the reactive cascade its result writeback triggers.
   * This is the "wait for everything, including async builtin I/O" companion to
   * `idle()` (which intentionally returns before that I/O so handlers don't
   * block on the network). Bounded: a builtin whose result re-triggers more
   * async work converges in a few rounds.
   */
  async settled(maxRounds = 50): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      // Use the commit-aware scheduler barrier. A successful handler commit can
      // synchronously schedule a deferred result pattern (notably navigateTo)
      // from its commit callback; plain idle() can resolve in the gap before
      // that callback queues the next scheduler turn. The joint barrier
      // rechecks scheduler work whenever pending commits drain.
      await this.scheduler.idleWithPendingCommits();
      await this.storageManager.synced();
      if (this.#pendingAsyncWork.size === 0) return;
      await Promise.allSettled([...this.#pendingAsyncWork.keys()]);
    }
  }

  /**
   * Wait until one pattern run has quiesced: the scheduler is idle including
   * in-flight commits, storage is synced, and no tracked async work belongs
   * either to `owner` or to nobody. Re-checked until all of those hold at once,
   * because each can restart the others.
   *
   * This is `settled()` narrowed to a single run. The narrowing matters where
   * `settled()` cannot be used at all: a caller that is itself running inside
   * tracked work — an LLM tool call, which runs inside its turn's promise —
   * would wait on the promise it is inside.
   *
   * The answer it gives is "this run is doing nothing further", which is what
   * distinguishes a run that finished having written nothing from one still
   * working. It is not "the run wrote a result": the caller reads the result
   * cell afterwards and finds whatever landed, including nothing.
   *
   * `idleWithPendingCommits()` rather than plain `idle()`, because a run's
   * result writeback travels through a commit and a plain idle can resolve
   * while that commit is still going to the server.
   *
   * Unlike `settled()` this carries no round cap. A cap would put a ceiling on
   * how much work a run may do before the barrier reports it finished anyway,
   * and a barrier that returns while the run is still working answers the
   * caller's question wrongly and silently. Each round awaits real promises, so
   * a run that keeps working keeps the barrier open rather than spinning.
   *
   * `signal` stops the loop for a caller that no longer needs the answer —
   * typically because it raced this against something that resolved first, and
   * without it an unbounded loop would outlive the caller.
   */
  async settledFor(
    owner: Cell<any>,
    signal?: AbortSignal,
  ): Promise<void> {
    const ownerKey = addressKey(owner.getAsNormalizedFullLink());
    while (!signal?.aborted) {
      await this.scheduler.idleWithPendingCommits();
      await this.storageManager.synced();
      const relevant = [...this.#pendingAsyncWork]
        .filter(([, key]) => key === undefined || key === ownerKey)
        .map(([promise]) => promise);
      if (relevant.length === 0) return;
      await Promise.allSettled(relevant);
    }
  }

  /**
   * Proactively checks all computations for idempotency by force-dirtying
   * and re-executing them, then comparing write snapshots.
   */
  runIdempotencyCheck() {
    return this.scheduler.runIdempotencyCheck();
  }

  /**
   * Enables inline idempotency checking: every computation that runs through
   * the scheduler's run() will automatically get a second synchronous run
   * for comparison.
   */
  enableIdempotencyCheck(): void {
    this.scheduler.enableIdempotencyCheck();
  }

  /**
   * Returns violations collected while inline idempotency check mode is enabled.
   */
  getIdempotencyViolations(): NonIdempotentReport[] {
    return this.scheduler.getIdempotencyViolations();
  }

  /**
   * Get or create a named async queue for throttling concurrent operations.
   * Queues are shared across all builtins that reference the same name.
   */
  getOrCreateQueue(
    name: string,
    config?: QueueConfig,
  ): AsyncSemaphoreQueue {
    let q = this.#queues.get(name);
    if (!q) {
      q = new AsyncSemaphoreQueue(config ?? { maxConcurrency: 2 });
      this.#queues.set(name, q);
    }
    return q;
  }

  /**
   * Configure a named queue's concurrency. Creates the queue if it doesn't exist.
   */
  configureQueue(name: string, config: QueueConfig): void {
    const q = this.getOrCreateQueue(name, config);
    q.setMaxConcurrency(config.maxConcurrency);
  }

  /**
   * Clean up resources and cancel all operations.
   *
   * NOTE: This does not wait for in-flight transactions to settle.
   * Any unawaited tx.commit() calls will be canceled when
   * storageManager.close() tears down storage sessions. Callers
   * should await all pending commits before calling dispose().
   *
   * `closeStorage: false` leaves the storage manager OPEN for a caller that
   * OWNS it and is still using it — a second runtime sharing the same store, or
   * one that reads the store after this runtime is done writing to it. Every
   * other step still runs, which is the point: quiescing the WRITER is what
   * makes a subsequent read of the store a statement about a state this runtime
   * actually reached. `idle()` and `synced()` cannot substitute, because they
   * say nothing about the background work that only teardown stops —
   * `sourceReconciler`'s source checks and the runner's pointer-commit
   * roll-forwards both live outside the scheduler and can still commit. That
   * path also drains in-flight async builtin work first; see below.
   *
   * It is about OWNERSHIP, not survivability. `close()` destroys the manager's
   * providers and rotates its session id rather than latching it shut, so what
   * a later write does is a matter of circumstance rather than contract — all
   * measured: over a caller-held server, a write to a doc the replica never saw
   * lands, a retrying writer (`editWithRetry`) recovers, and a bare `commit()`
   * to a doc the replica already knew fails its stale-read precondition and
   * LOSES the write; over `StorageManager.emulate`, which owns its server,
   * closing strands everything. A callee cannot see which of those its caller
   * is in, so it hands the decision back rather than betting on the recovery.
   *
   * Passing `false` makes closing the CALLER's job — nothing else will. Note
   * `await using` / `[Symbol.asyncDispose]` always takes the closing path.
   *
   * Either way this resets the PROCESS-GLOBAL experimental config to defaults
   * (`resetModernCellRepConfig` and friends) — except
   * `readerSchemaPrecedence`, which dispose leaves standing: serving
   * runtimes are per-space and idle-disposed, so a teardown reset would
   * lift a live rollback from under the survivors. Under a non-default
   * flag that is visible to a second runtime still running against the
   * same store, which is exactly the caller this option serves — so set
   * the flags per process, not per runtime, if two of them must agree.
   */
  async dispose(
    { closeStorage = true }: { closeStorage?: boolean } = {},
  ): Promise<void> {
    try {
      await this.#disposeInner(closeStorage);
    } finally {
      // Exception-safe: a rejecting teardown step must not leak the
      // process-global enabler (the reset would then never fire).
      this.#releaseServerExecutionEnabler();
    }

    // Clear the current runtime reference
    // Removed setCurrentRuntime call - no longer using singleton pattern
  }

  async #disposeInner(closeStorage: boolean): Promise<void> {
    this.#viewReplication?.dispose();
    try {
      // A kept store keeps RECORDING, so this path drains what could still write
      // into it. In-flight async builtin work is that shape: a fetch / llm call or
      // a sqlite RPC runs from a post-commit outbox flush and writes its result
      // back when it lands, and `trackAsyncWork` exists because neither `idle()`
      // nor `synced()` waits for it. `settled()` is the barrier that does. The
      // closing path skips it because a caller who let the store close has no
      // reader left to mislead, and waiting on the network in every teardown is a
      // real cost; here the caller is about to read what this runtime wrote.
      //
      // BEFORE the cancellation below, not after: `stopAll()` and
      // `scheduler.dispose()` would cut a writeback's reactive cascade midway,
      // leaving the store holding part of a result — which is worse than either
      // extreme for a reader trying to learn what state this runtime reached.
      //
      // UNCAPPED, deliberately. `settled()`'s default 50 rounds falls out of the
      // loop and returns — silently, with work still outstanding — which is
      // exactly the hole this drain exists to close, one layer down. Measured: 60
      // generations of chained tracked work, and a capped drain returned at
      // generation 50 while the chain kept running and writing. `settledFor`'s
      // JSDoc gives the reason a cap is wrong for this question and why removing
      // it cannot spin: every round awaits real promises, so a runtime that keeps
      // working keeps the barrier open rather than busy-looping.
      if (!closeStorage) await this.settled(Infinity);
      // Kept-storage disposal first drains tracked writebacks above. From this
      // point onward, no delayed reconciliation or retry may mint new work
      // behind the teardown barriers below.
      this.#tearingDownWrites = true;
      this.#writeTeardown.abort();
      // Abort any pending (not-yet-started) queued jobs so they don't start
      // after storage is torn down.
      for (const queue of this.#queues.values()) {
        queue.abortPending();
      }
      this.#queues.clear();
      // Stop all running docs
      this.runner.stopAll();

      // The speculation overlay dies with the runtime (speculation.md §1:
      // process-memory only): withdraw its live entries and release the
      // watermark sinks BEFORE the storage sessions they read through
      // close.
      this.#speculationOverlay?.close();
      this.#speculationOverlay = undefined;
      this.#effectsChannel?.close();
      this.#effectsChannel = undefined;
      // Release the manager-side hook — but only when the installed hook
      // is OUR OWN (identity match): a later runtime constructed over the
      // SAME manager (the LT8 second life) has already replaced it, and
      // clearing unconditionally would drop THAT runtime's hook — its
      // channel would miss every space opened after this dispose
      // (independent review NOTE-a).
      if (
        this.#installedSpaceOpenObserver !== undefined &&
        this.storageManager.spaceOpenObserver ===
          this.#installedSpaceOpenObserver
      ) {
        this.storageManager.spaceOpenObserver = undefined;
      }
      this.#installedSpaceOpenObserver = undefined;

      // Background source checks are deliberately outside the scheduler. Abort
      // and settle them before the storage sessions they may write through close.
      await this.sourceReconciler.dispose();

      // Same contract for the runner's unloadable-pointer roll-forward commits
      // (CT-1923): settle before their storage sessions close. Commits only —
      // never the watcher pattern LOADS, which can be held/wedged arbitrarily
      // long and are lifecycle-epoch-guarded instead.
      await this.runner.settlePointerCommits();

      // Scheduler background work can still be using storage, for example the
      // lifecycle-guarded boot-time persistent-state listing. Let that finish
      // before tearing down storage sessions.
      await this.scheduler.idle();

      // Storage close can publish notifications while it retires providers.
      // Retire both reactive subscribers first, so those notifications cannot
      // schedule a read that opens a new provider behind the close.
      this.scheduler.dispose();
      this.runner.dispose();

      // Disposal prevents new work but does not cancel a run already admitted
      // by a notification. Let that run release storage before closing it.
      await this.scheduler.idle();

      // Clear module registry
      this.moduleRegistry.clear();

      // Cancel all storage operations
      if (closeStorage) await this.storageManager.close();
    } finally {
      this.#tearingDownWrites = true;
      this.#writeTeardown.abort();
      // Released whatever happened above. `storageManager.close()` can reject
      // — through a provider's `replica.close()` — and it is the one await
      // here that can. Every statement below is synchronous field-clearing
      // that cannot fail in turn, so running them on the error path costs
      // nothing while skipping them strands the process: the config resets
      // are PROCESS-GLOBAL, and one skipped leaves a non-default experimental
      // flag set for every runtime built afterwards, with nothing to put it
      // back.
      //
      // The error still propagates. What changes is how much has been
      // released by the time it does, not whether disposal fails.
      this.scheduler.dispose();
      this.runner.dispose();

      // Pop the default frame
      if (this.#defaultFrame) {
        popFrame(this.#defaultFrame);
        this.#defaultFrame = undefined;
      }

      // Dispose the Engine (clears compiler/runtime state and the console
      // hook)
      this.harness.dispose();

      // Reset experimental config to defaults. serverExecution releases
      // this runtime's ENABLER (stage F): the flag resets only when the
      // last live enabler process-wide goes — disposing a flag-less
      // runtime, or parking one serving runtime of several, must not clear
      // the ambient flag other owners and the memory server's admission
      // still depend on (mid-wave `derived` commits would be refused as
      // unclaimable). A single-runtime test keeps its stage-A cleanup
      // contract: the last enabler's dispose resets. Released in
      // #releaseServerExecutionEnabler (also called from the dispose
      // catch), so a REJECTING async teardown cannot leak the enabler.
      resetModernCellRepConfig();
      resetCommitPreconditionsConfig();
      // readerSchemaPrecedence deliberately does NOT reset here: a server
      // runs one serving runtime per space and disposes idle ones while
      // the rest live, so a dispose-time reset would lift a rollback out
      // from under them. The ambient changes only when a construction
      // sets it (last construction wins).
    }
  }

  /** Release this runtime's server-execution enabler (idempotent — the
   * handle guards re-entry; dispose() may run twice). */
  #releaseServerExecutionEnabler(): void {
    const release = this.#serverExecutionRelease;
    this.#serverExecutionRelease = undefined;
    release?.();
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   */
  edit(
    options: {
      changeGroup?: ChangeGroup;
      sourceUpdate?: PreparedSourceUpdate;
    } = {},
  ): IExtendedStorageTransaction {
    const tx = this.storageManager.edit();
    if (options.changeGroup !== undefined) {
      tx.changeGroup = options.changeGroup;
    }
    (tx as { writeTraceScopeId?: string }).writeTraceScopeId = this.id;
    const debugActionId = this.getWriteDebugContext();
    if (debugActionId) {
      (tx as { debugActionId?: string }).debugActionId = debugActionId;
    }
    const wrapped = new ExtendedStorageTransaction(tx, {
      resolvePolicyManifest: (
        reference,
        tx,
        destinationSpace,
        bindCommit,
      ) =>
        this.resolveCfcPolicyManifest(
          reference,
          tx,
          destinationSpace,
          bindCommit,
        ),
      hasPolicyManifest: (space, reference, tx) =>
        this.hasCfcPolicyManifest(space, reference, tx),
      installPolicyManifest: (space, reference, tx) =>
        this.installCfcPolicyManifest(space, reference, tx),
      onRelevantTx: () => {
        this.#cfcStats.cfcRelevantTx += 1;
      },
      onFlowLabelProbe: (outcome) => {
        if (outcome === "memo") this.#cfcStats.flowLabelProbeMemoHits += 1;
        else this.#cfcStats.flowLabelProbesComputed += 1;
      },
      onDereferenceTrace: (held) => {
        this.#cfcStats.dereferenceTracesRecorded += 1;
        if (held > this.#cfcStats.dereferenceTracesMax) {
          this.#cfcStats.dereferenceTracesMax = held;
        }
      },
      onPreparedTx: () => {
        this.#cfcStats.cfcPreparedTx += 1;
      },
      onRefusalDetail: () => {
        this.#cfcStats.refusalDetailsRecorded += 1;
      },
      onPreparationWork: (kind, count) => {
        this.#cfcStats[kind] += count;
      },
      onConsumedLabelWalk: () => {
        this.#cfcStats.consumedLabelWalks += 1;
      },
      onPrepareReject: (refusal) => {
        this.#cfcStats.cfcPrepareRejects += 1;
        // Every refusal is reported here, terminal or not. The scheduler's
        // error channel carries only the terminal ones (a refusal a fresh
        // attempt may resolve is retried rather than surfaced), so without
        // this a mixed-reason refusal — one verdict plus one unevaluable
        // input — reaches a host as nothing but a graph that stopped
        // converging.
        this.telemetry.submit({
          type: "cfc.prepare-reject",
          reasons: [...refusal.reasons],
          refusals: [...refusal.refusals],
          terminal: refusal.terminal,
        });
      },
      onDigestInvalidation: () => {
        this.#cfcStats.cfcDigestInvalidations += 1;
      },
      onOutboxFlush: () => {
        this.#cfcStats.cfcOutboxFlushes += 1;
      },
      onSinkDedupHit: () => {
        this.#cfcStats.sinkDedupHits += 1;
      },
      onSinkReleaseReject: () => {
        this.#cfcStats.sinkReleaseRejects += 1;
      },
      // Stage-0 D4 precision counters: installed only when the deployment
      // opted in, so the default prepare path skips all measurement.
      ...(this.cfcPrefixProvenanceStats
        ? {
          onPrefixProvenance: (summary: CfcPrefixProvenanceSummary) => {
            this.#cfcStats.prefixProvenanceSummaries += 1;
            this.#cfcStats.prefixProtectedWrites += summary.protectedWrites;
            this.#cfcStats.prefixGatedReads += summary.prefixGatedReads;
            this.#cfcStats.prefixTxGlobalGatedReads +=
              summary.txGlobalGatedReads;
            this.#cfcStats.prefixBoundReal += summary.boundSources.real;
            this.#cfcStats.prefixBoundInfinityFallback +=
              summary.boundSources.infinityFallback;
            this.#cfcStats.prefixBoundClockLess +=
              summary.boundSources.clockLess;
            this.#cfcStats.prefixS7ExemptionFires += summary.s7ExemptionFires;
            this.#cfcStats.prefixClockLessReads += summary.clockLessReads;
          },
        }
        : {}),
    });
    wrapped.setCfcEnforcementMode(this.cfcEnforcementMode);
    wrapped.setCfcFlowLabelsMode(this.cfcFlowLabels);
    wrapped.setCfcWriteFloorMode(this.cfcWriteFloor);
    wrapped.setCfcTriggerReadGating(this.cfcTriggerReadGating);
    wrapped.setCfcDecomposedEnvelopes(this.cfcDecomposedEnvelopes);
    wrapped.setCfcContentAddressedLabels(this.cfcContentAddressedLabels);
    wrapped.setCfcPolicyEvaluationMode(this.cfcPolicyEvaluation);
    wrapped.setCfcLabelMetadataProtectionMode(this.cfcLabelMetadataProtection);
    wrapped.setCfcDeclaredMonotonicityMode(this.cfcDeclaredMonotonicity);
    wrapped.setCfcSinkMaxConfidentiality(this.cfcSinkMaxConfidentiality);
    wrapped.setCfcPolicySnapshot(this.cfcPolicySnapshot);
    wrapped.setCfcTrustConfig(this.cfcTrustConfig);
    wrapped.setCfcModuleDelegations(
      this.#moduleDelegationSnapshot(options.sourceUpdate),
    );
    wrapped.setCfcTrustSnapshot(this.trustSnapshotProvider());
    wrapped.configureSealDestination(
      this.#transactionSealDestination ?? this.#speculationDestination(),
    );
    wrapped.configureRuntimeOwnedStores(this.#runtimeOwnedStores);
    this.#transactions.add(wrapped);
    return wrapped;
  }

  /**
   * Forget the stores enrolled for the piece at `owner` — its own documents
   * and the state documents its builtins minted. Called when a piece stops,
   * which is what keeps the enrollment bounded by the pieces running rather
   * than by every piece the process has ever run. A store another piece — a
   * second scope instance of this one, say — still holds stays.
   *
   * Takes the runtime's write-policy authorization, like the enrollment it
   * undoes: pattern-authored code reaches this object through a cell, and a
   * release it made would refuse another piece's writes.
   */
  releaseRuntimeOwnedStores(
    owner: NormalizedFullLink,
    authorization?: RuntimeWritePolicyAuthorization,
  ): void {
    if (!runtimeWritePolicyAuthorized(authorization)) return;
    // The owner stands as its own store here, so the key's space test holds.
    const key = runtimeOwnedStoreOwnerKey(owner, owner, this.scopeKeyIdentity)!;
    this.#runtimeOwnedStores.releaseOwner(key);
  }

  /**
   * The default seal destination under EXPERIMENTAL_SERVER_EXECUTION
   * (server-execution v2 Phase 2): a runtime with NO wave destination
   * installed — every client, and any non-serving server-side runtime —
   * seals its stamped derivation-kind runs into the speculation overlay
   * instead of committing them (speculation.md; the by-construction
   * removal of the client derivation-commit path). OFF arm: undefined —
   * transactions commit exactly as today.
   */
  #speculationDestination(): SpeculationOverlayDestination | undefined {
    if (this.experimental.serverExecution !== true) return undefined;
    if (this.servingPosture) return undefined;
    this.#speculationOverlay ??= new SpeculationOverlayDestination(this);
    return this.#speculationOverlay;
  }

  /** Renderer demand and local preview eligibility owned by this runtime. */
  get viewReplication(): ViewReplicationClient {
    return this.#viewReplication ??= new ViewReplicationClient(this);
  }

  /** Whether this client requests view replication, subject to session support. */
  get viewScopedReplicationRequested(): boolean {
    return this.#clientClass === "web" &&
      this.experimental.serverExecution === true && !this.servingPosture &&
      (this.experimental.webViewScopedReplication ??
        this.experimental.viewScopedReplication ?? false);
  }

  /** DIAGNOSTIC (tests): the lazily-created speculation overlay, if this
   * runtime has one. */
  get speculationOverlay(): SpeculationOverlayDestination | undefined {
    return this.#speculationOverlay;
  }

  /** Observe terminal client event-intent outcomes. Subscribing eagerly
   * installs the flag-ON client overlay so the production IPC bridge cannot
   * miss the first outcome while waiting for the first speculative edit. */
  subscribeEventIntentOutcomes(
    subscriber: (outcome: EventIntentOutcome) => void,
  ): () => void {
    return this.#speculationDestination()?.subscribeIntentOutcomes(
      subscriber,
    ) ??
      (() => undefined);
  }

  /** The client-effect channel of a flag-ON non-serving runtime
   * (server-execution v2 Phase 4, protocol.md §5): the overlay's
   * optimistic navigateTo enactment records its nonce here, and the
   * channel acks the authoritative intent without re-enacting.
   * Undefined in the OFF arm and on serving runtimes. */
  get effectsChannel(): EffectsChannel | undefined {
    return this.#effectsChannel;
  }

  /**
   * Install the transaction seal destination (server-execution v2,
   * serving-loop.md §3d): every transaction edit() creates while one is
   * installed closes by sealing into it instead of committing to the store.
   * Only the wave machinery of a serving runtime installs one, around each
   * wave; waves are serial per space, so a second install while one is
   * live is a bug, not a hand-over.
   */
  installSealDestination(
    destination: TransactionSealDestination,
    options: {
      /** The serving loop's run stamper (serving-loop.md §3d, RULED
       * 2026-08-05: every server-side commit path declares its run
       * context before it seals). The scheduler calls
       * {@link stampServerRun} at its two dispatch choke points with
       * what IT knows — the durable action id and the run's kind — and
       * the stamper (the SpaceServer) enriches with per-run identity
       * and attaches the wave run context. */
      runStamper?: (
        tx: IExtendedStorageTransaction,
        info: ServerRunInfo,
      ) => void;

      /** The per-(action × instance) run SUPPLY (server-execution v2
       * stage P2-F; fan-out stage B): resolves an action's demand roots
       * to the DEMANDERS the SpaceServer's registry holds for them. The
       * scheduler consults this at its reactive-action choke point and
       * runs the action once per demanded INSTANCE — derived from the
       * demanders and the node's known-scope ratchet — stamping each run
       * with that instance's identity (scopes.md §5: the DEMAND supplies
       * the run identity). Absent (or returning nothing) the run keeps
       * the wave-level fallback — the Phase-1 cardinality-1 posture. */
      runDemanderResolver?: ServerRunDemanderResolver;
    } = {},
  ): void {
    if (this.experimental.serverExecution !== true) {
      throw new Error(
        "A transaction seal destination requires EXPERIMENTAL_SERVER_EXECUTION " +
          "(docs/specs/server-side-execution/serving-loop.md §3d); the OFF arm " +
          "commits to the store",
      );
    }
    if (this.#transactionSealDestination !== undefined) {
      throw new Error(
        "A transaction seal destination is already installed; waves are " +
          "serial per space (serving-loop.md §3)",
      );
    }
    this.#transactionSealDestination = destination;
    this.#serverRunStamper = options.runStamper;
    this.#serverRunDemanderResolver = options.runDemanderResolver;
  }

  /** The installed seal destination (the serving loop), if any —
   * Phase 3's send site dispatches cross-space event staging through
   * it (cell.ts's serving branch; events.md §2's cross-space arm). */
  get installedSealDestination(): TransactionSealDestination | undefined {
    return this.#transactionSealDestination;
  }

  /** Whether a seal destination is installed — the ON-arm SERVING
   * posture (a flag-ON client speculating has none). Consumers branch
   * durability-sensitive side effects on this (the pattern swap defers
   * teardown to wave settlement only when sealing is in effect). */
  get sealDestinationInstalled(): boolean {
    return this.#transactionSealDestination !== undefined;
  }

  /** Remove the installed seal destination (the wave closed or aborted). */
  clearSealDestination(): void {
    this.#transactionSealDestination = undefined;
    this.#serverRunStamper = undefined;
    this.#serverRunDemanderResolver = undefined;
  }

  /**
   * The DEMANDERS a scheduler action's DEMAND ROOTS currently have (the
   * per-(action × instance) run SUPPLY, stage P2-F / fan-out stage B):
   * its own piece root plus every ancestor piece root that instantiated
   * it (`SchedulerObservationIdentity.demandRootIds`, Phase 7 — a nested
   * piece is demanded through the outer piece the client watches).
   * Undefined everywhere except a serving runtime whose SpaceServer
   * installed a resolver — the OFF arm and client speculation pay one
   * undefined check. The scheduler derives the instance set from the
   * demanders and the node's known-scope ratchet and runs the action once
   * per instance (instances live in keys/basis/stamps and the node's
   * fan-out record, never as extra graph nodes — C11b); an empty return
   * keeps the single wave-identity run.
   */
  serverRunDemandersFor(
    pieceRootIds: readonly string[],
  ): readonly ScopeKeyIdentity[] | undefined {
    return this.#serverRunDemanderResolver?.(pieceRootIds);
  }

  /**
   * A trust snapshot for one acting principal (serving-loop.md §3c: a
   * served run's CFC trust snapshot carries the run's ACTING principal,
   * never the serving runtime's ambient identity). The SpaceServer's run
   * stamper attaches these per transaction via `setCfcTrustSnapshot`, so
   * the current-principal label mints, the mid-run grant writes, and the
   * concept-floor evaluation of a served run all resolve against the
   * principal the run acts as. `revision` is the runtime's own trust
   * revision — the same composition the default provider uses — so a
   * trust-config change invalidates per-run prepared digests exactly as
   * it does ambient ones. On a runtime constructed with a CUSTOM
   * `trustSnapshotProvider` this still composes the RUNTIME's revision,
   * not the provider's. The DEFAULT provider routes every ordinary
   * edit() transaction through this method; the run stamper is the
   * ADDITIONAL serving-path caller, and a serving runtime refuses a
   * custom provider at construction, so the two composition paths can
   * never disagree on a serving runtime.
   */
  trustSnapshotForPrincipal(principal: string): TrustSnapshot {
    return {
      id: `principal:${principal}`,
      actingPrincipal: principal,
      revision: this.#trustRevision,
    };
  }

  /**
   * Stamp a scheduler-driven run's wave context (serving-loop.md §3d).
   * With a wave destination installed, the stamper (the SpaceServer)
   * attaches the wave run context. With NONE installed but the flag ON —
   * client speculation (Phase 2) — the run's kind is recorded on the
   * SPECULATION stamp instead, so the overlay destination can route
   * derivation-kind runs into the overlay while handler and bookkeeping
   * runs keep committing (speculation.md; the wave stamp stays a
   * server-only signal). The OFF arm pays one undefined check and
   * stamps nothing. The scheduler calls this at exactly its
   * transaction-minting choke points, so a destination sees every
   * scheduler run stamped and the seal-time unstamped refusal is
   * reserved for genuinely undeclared commit paths.
   */
  stampServerRun(
    tx: IExtendedStorageTransaction,
    info: ServerRunInfo,
  ): void {
    if (this.#serverRunStamper !== undefined) {
      this.#serverRunStamper(tx, info);
      return;
    }
    if (
      this.experimental.serverExecution === true && !this.servingPosture
    ) {
      stampSpeculationRunContext(tx, info);
    }
  }

  /**
   * (space, scope, id) triples for which a missing-link-target load has been
   * kicked this session. The kicked sync establishes a live per-doc
   * subscription, so a later creation of the doc still arrives — one kick per
   * doc suffices. Scope is part of the key: scoped instances (user/session) are
   * distinct docs, and a kick for one scope must not suppress another's.
   */
  #missingDocLoadKicks = new Set<string>();

  /**
   * Asynchronously load a link target that a read found absent from the
   * local replica. Cross-space targets (CT-1667): per-space server queries
   * cannot follow links across space boundaries, so the client must fetch
   * such targets itself. Same-space targets (fresh-replica read asymmetry):
   * a rejecting-selector sync delivers only the root doc, so a link can
   * point at a doc no selector ever walked — those are fetched only when
   * the local replica has never seen the doc (`shouldPullDoc`), so reads of
   * genuinely absent optional values do not become repeated server queries.
   * Fire-and-forget, but registered as a cross-space promise so
   * `storageManager.synced()` and `Cell.pull()`'s convergence loop can await
   * it; the absent doc is a tracked read, so the reader re-runs on arrival.
   * Deduped per (space, id): the kicked sync leaves a live subscription
   * behind, so repeat kicks add nothing.
   */
  ensureLinkedDocLoaded(
    link: NormalizedFullLink,
    sourceSpace?: MemorySpace,
    /** The reading run's identity when the read is a served per-instance
     * run's (server-execution v2 stage A — the runner's explicit-instance
     * read): the load then NAMES that principal's instance, keyed apart
     * from the runtime's own. Absent = the runtime's own identity, the
     * pre-stage-A path byte for byte. */
    identity?: ScopeKeyIdentity,
  ): void {
    const { space, id, scope } = link;
    // Kick keys are per scope INSTANCE (key-vocabulary.md §5's stage-F
    // serving-hazard list): name-keyed, A's kick suppressed B's load and
    // B's absent read never healed at cardinality > 1. Resolved against
    // the runtime's own identity — the OFF arm's one identity, so the
    // partition is unchanged at cardinality 1 (key-vocabulary.md §2) — or
    // against the served run's identity for a per-instance read (stage
    // A): each demanded instance's absent read kicks its own load.
    const key = `${space}\0${
      resolveScopeKey(scope, identity ?? this.scopeKeyIdentity)
    }\0${id}`;
    if (this.#missingDocLoadKicks.has(key)) return;
    // A same-space target the replica already has state for (or a manager
    // without lazy replication) needs no fetch.
    const sameSpace = sourceSpace === space;
    const mgr = this.storageManager;
    const reserved = sameSpace &&
      mgr.shouldPullDoc?.(space, id, scope, identity) === true;
    if (sameSpace && !reserved) return;
    this.#missingDocLoadKicks.add(key);
    const load = identity === undefined
      ? this.getCellFromLink(link).sync()
      // The instance-named load: the storage manager names the run's
      // instance on the wire (lease-holder-only at admission) and lands
      // the doc under it; an own-identity run takes the ordinary sync.
      : mgr.syncCell(this.getCellFromLink(link), {
        scopeKeyIdentity: identity,
      });
    mgr.trackUntilSettled(
      load.catch(() => {
        // Allow a retry on failure (e.g. transient disconnect): clear this
        // dedup set, and hand back the storage manager's reservation when
        // THIS kick took it — a cross-space kick never reserved, and must
        // not clear a reservation a concurrent same-space read holds.
        this.#missingDocLoadKicks.delete(key);
        if (reserved) mgr.retractDocPullKick?.(space, id, scope, identity);
      }),
    );
  }

  getCfcStats(): Readonly<CfcRuntimeStats> {
    return { ...this.#cfcStats };
  }

  resetCfcStats(): void {
    this.#cfcStats = initialCfcRuntimeStats();
  }

  getWriteDebugContext(): string | undefined {
    return this.#writeDebugContext.getStore() ?? this.scheduler.currentActionId;
  }

  createUnsafeHostTrust(
    options: UnsafeHostTrustOptions,
  ): UnsafeHostTrust {
    return createUnsafeHostTrustToken(
      options,
      (value) => this.harness.unsafeTrustHostValue(value, options),
    );
  }

  unsafeTrustPattern<T extends Pattern>(
    pattern: T,
    options: UnsafeHostTrustOptions,
  ): T {
    this.harness.unsafeTrustHostValue(pattern, options);
    return pattern;
  }

  unsafeTrustModule<T extends Module>(
    module: T,
    options: UnsafeHostTrustOptions,
  ): T {
    this.harness.unsafeTrustHostValue(module, options);
    return module;
  }

  withWriteDebugContext<T>(
    label: string | undefined,
    fn: () => T,
  ): T {
    if (!label) {
      return fn();
    }
    return this.#writeDebugContext.run(label, fn);
  }

  setWriteStackTraceMatchers(
    matchers: readonly WriteStackTraceMatcher[],
  ): void {
    setWriteStackTraceMatchers(matchers, { scopeId: this.id });
  }

  getWriteStackTrace(): WriteStackTraceEntry[] {
    return getWriteStackTrace({ scopeId: this.id });
  }

  /**
   * Runs `fn` in a storage transaction over locally replicated memory spaces.
   * The transaction can read from multiple spaces but write to only one.
   *
   * After `fn` returns, while retry budget remains, the runtime may load
   * documents read as absent that the replica has not examined. If any exist,
   * it aborts the staged attempt and invokes `fn` with a fresh transaction
   * before sending a commit. These reconciliation re-runs and retries after
   * commit rejection share one `maxRetries` budget, in addition to the initial
   * invocation. With no budget left, reconciliation is skipped and the current
   * transaction proceeds to ordinary commit validation.
   *
   * A retryable commit rejection also re-runs `fn` while budget remains.
   * Retryability is decided by the shared rejection vocabulary
   * (`isRetryableCommitRejection`, `storage/rejection.ts`),
   * which is an allow-list: a stale basis (server conflict or the local
   * inconsistency guard), a liveness failure the memory client heals on its own
   * (a transport failure, an undecodable frame), a discarded attempt
   * (`tx.abort()`, or a prepared CFC transaction whose inputs drifted before
   * the verdict), or an authorization denial the server itself marked
   * `retriable`. Every other rejection — an ACL/protocol refusal, an
   * authorization denial, a precondition failure, a commit-rule violation, a
   * CFC boundary refusal (`CfcCommitRefusalError`, a deterministic verdict on
   * the transaction's own reads and writes), a `SessionError` (nothing on this
   * path remounts the session, so every attempt reuses the handle the server
   * just refused) — is returned without another retry, because re-running
   * cannot change the outcome and each doomed attempt costs a round-trip plus
   * a subscriber revert notification.
   *
   * Every retry invokes `fn` again with a fresh transaction. Aborting an
   * attempt discards only the operations staged in that transaction; an effect
   * `fn` commits through another channel survives and repeats on retry unless
   * the caller gives it a stable identity or otherwise makes it idempotent.
   *
   * A caller that decides inside the transaction whether to write at all — one
   * re-reading a precondition against the fresh state each retry sees — says so
   * through the value `fn` returns, which comes back as `ok`. An `ok` of
   * `false` carrying no `error` is the convention for a write that was declined
   * rather than one that failed. The bound on that convention is that we commit
   * whatever `fn` staged, whatever `fn` returned: declining does not abort the
   * transaction, so it stands for "nothing was written" only where the callback
   * stages nothing before it declines.
   *
   * @param fn - Function to execute with the transaction.
   * @param maxRetries - Maximum combined number of reconciliation re-runs and
   *   commit-rejection retries after the initial invocation.
   * @returns `{ ok }` once the transaction commits, carrying whatever `fn`
   *   returned, or `{ error }` when it does not commit: a rejection that is not
   *   retryable, a retryable one whose retries are spent, or `fn` itself
   *   throwing, which aborts the transaction.
   */
  editWithRetry<T = void>(
    fn: (tx: IExtendedStorageTransaction) => T,
    maxRetries: number = DEFAULT_MAX_RETRIES,
    options: { sourceUpdate?: PreparedSourceUpdate } = {},
  ): Promise<
    { ok: T; error?: undefined } | { ok?: undefined; error: CommitError }
  > {
    const teardownResult = (): {
      ok?: undefined;
      error: CommitError;
    } => ({
      error: {
        name: "StorageTransactionAborted" as const,
        message: "editWithRetry stopped because the runtime is disposing",
        reason: new Error("runtime disposing"),
      },
    });
    if (this.#tearingDownWrites) return Promise.resolve(teardownResult());
    const tx = this.edit(options);
    this.scheduler.beginReadAttempt(tx, "editWithRetry");
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    let result: T;
    try {
      result = fn(tx);
    } catch (error) {
      // fn(tx) threw before commit -- abort the transaction so it isn't
      // orphaned, and surface the error as a Result instead of a rejection.
      tx.abort(error);
      return Promise.resolve({
        error: {
          name: "StorageTransactionAborted" as const,
          message: `editWithRetry action threw: ${error}`,
          reason: error,
        },
      });
    }
    const commitPrepared = (): Promise<
      { ok: T; error?: undefined } | { ok?: undefined; error: CommitError }
    > => {
      if (this.#tearingDownWrites) {
        tx.abort("editWithRetry stopped because the runtime is disposing");
        return Promise.resolve(teardownResult());
      }
      try {
        this.prepareTxForCommit(tx);
      } catch (error) {
        if (tx.status().status === "ready") tx.abort(error);
        throw error;
      }
      return tx.commit().then(async ({ error }) => {
        if (error) {
          if (maxRetries > 0 && isRetryableCommitRejection(error)) {
            await this.awaitCommitRetryReadiness(
              error,
              this.#writeTeardown.signal,
            );
            if (this.#tearingDownWrites) return teardownResult();
            return this.editWithRetry<T>(fn, maxRetries - 1, options);
          } else {
            return { error };
          }
        }
        return { ok: result };
      }).catch((error) => {
        return {
          error: {
            name: "StorageTransactionAborted" as const,
            message: `editWithRetry commit rejected: ${error}`,
            reason: error,
          },
        };
      });
    };

    // Absence reconciliation, before the read set is exported: a read of a
    // document this client never synced resolves as absent and would commit
    // as a `seq: 0` confirmed read — the claim that no such document exists.
    // Where one does exist, the engine's rejection of that claim is correct
    // and `fn` re-runs here anyway, after a server round trip, the
    // conflict's catch-up gate, and a rebuilt commit — once per LAYER of
    // cold documents, since each re-run can follow the arrived layer's links
    // into the next. The reads that found those documents absent also
    // started loading them, so waiting for those loads and re-running
    // locally is the same convergence, minus the wire: each round consumes
    // a retry from the same budget a rejection would.
    //
    // Two gates on the wait. Budget: a document that lands and turns out to
    // exist fails the transaction's commit-time claim check (the snapshot
    // read it as absent, and the replica now holds it), so with no budget to
    // re-run, the wait can only turn the server's verdict into a local
    // rejection; the unexamined claim goes to the server, judged as before.
    // Synchrony: a transaction with nothing in flight commits on the same
    // synchronous path as ever, which the commit-gated runner start depends
    // on.
    const reconciliation = maxRetries > 0
      ? this.#awaitUnexaminedAbsences(tx)
      : 0;
    if (typeof reconciliation === "number") return commitPrepared();
    return reconciliation.then((present) => {
      if (this.#tearingDownWrites) {
        tx.abort("editWithRetry stopped because the runtime is disposing");
        return teardownResult();
      }
      if (present > 0) {
        tx.abort(
          `editWithRetry re-run: ${present} document(s) read as absent ` +
            "are present; the action re-runs against them",
        );
        return this.editWithRetry<T>(fn, maxRetries - 1, options);
      }
      return commitPrepared();
    });
  }

  /**
   * Wait for the loads in flight for every document `tx` read as absent that
   * no involved replica has examined, resolving with how many exist after
   * all — the signal that the transaction's reads ran against documents it
   * did not hold. A cell read of a document the replica never synced starts
   * a load as a side effect — `Cell.get()` and `Cell.getRaw()` sync the cell
   * they read, and a link followed during traversal is kicked by
   * `ensureLinkedDocLoaded` — so the wait sends nothing of its own. A
   * document read by address alone starts no load and is left as the absence
   * claim it is, for the server to judge. Each space's provider names its
   * unexamined absences ({@link IStorageProvider.unexaminedAbsences}) and
   * counts the present ones afterwards; a provider without the capability
   * contributes zero. Synchronous zero when nothing is in flight, so a
   * round with no cold reads never leaves the synchronous path.
   */
  #awaitUnexaminedAbsences(
    tx: IExtendedStorageTransaction,
  ): number | Promise<number> {
    const reads = getDirectTransactionReadActivities(tx.tx);
    if (!reads) return 0;
    const manager = this.storageManager;
    if (
      manager.loadsSettled === undefined ||
      manager.pendingLoadGeneration === undefined
    ) {
      return 0;
    }
    const spaces = new Set<MemorySpace>();
    for (const read of reads) spaces.add(read.space);
    const absencesPerProvider: {
      presentCount: NonNullable<IStorageProvider["presentCount"]>;
      absences: readonly UnexaminedAbsence[];
    }[] = [];
    const keys: string[] = [];
    for (const space of spaces) {
      const provider = manager.open(space);
      if (
        provider.unexaminedAbsences === undefined ||
        provider.presentCount === undefined
      ) {
        continue;
      }
      let absences: readonly UnexaminedAbsence[];
      try {
        absences = provider.unexaminedAbsences(tx.tx);
      } catch {
        // Reconciliation only front-runs the authoritative commit verdict. A
        // provider that cannot name its absences leaves the transaction's
        // claims for the server to judge.
        continue;
      }
      if (absences.length === 0) continue;
      absencesPerProvider.push({
        presentCount: provider.presentCount.bind(provider),
        absences,
      });
      for (const absence of absences) {
        // An absence naming a foreign instance carries its key; the rest are
        // this runtime's own instances, the way the loads were registered.
        const key = entityKey(absence, this.scopeKeyIdentity);
        if (manager.pendingLoadGeneration(key) !== undefined) keys.push(key);
      }
    }
    if (keys.length === 0) return 0;
    // `loadsSettled` settles only once every key has, and a load that failed
    // leaves its document absent, so the count is taken the same way on
    // either outcome: what landed is present, and a failure is the
    // sync-failure log's to report while the commit's own verdict decides
    // what that absence claim was worth.
    const countPresent = () =>
      absencesPerProvider.reduce(
        (total, { presentCount, absences }) => total + presentCount(absences),
        0,
      );
    return manager.loadsSettled(keys).then(countPresent, countPresent);
  }

  /**
   * Waits for a rejection's catch-up gate and pulls its conflicting documents
   * concurrently in their declared scopes. The gate covers the watched view;
   * a validation dependency outside that view needs its own pull. Entries
   * without scope use the space instance. If no array entry names a usable
   * address, the singular conflict supplies the recovery target.
   *
   * Recovery is best-effort: failed waits and pulls leave the fresh retry's
   * commit to decide whether its basis is valid. Aborting `teardownSignal`
   * ends the wait; callers must check their lifetime before requeueing work.
   */
  async awaitCommitRetryReadiness(
    error: unknown,
    teardownSignal?: AbortSignal,
  ): Promise<void> {
    const waitUnlessTeardown = async (
      operation: PromiseLike<unknown>,
    ): Promise<boolean> => {
      if (teardownSignal === undefined) {
        await operation;
        return true;
      }
      if (teardownSignal.aborted) return false;
      const aborted = Promise.withResolvers<boolean>();
      const onAbort = () => aborted.resolve(false);
      teardownSignal.addEventListener("abort", onAbort, { once: true });
      try {
        return await Promise.race([
          Promise.resolve(operation).then(() => true),
          aborted.promise,
        ]);
      } finally {
        teardownSignal.removeEventListener("abort", onAbort);
      }
    };
    const readyToRetry = (error as { readyToRetry?: () => unknown })
      ?.readyToRetry;
    if (typeof readyToRetry === "function") {
      try {
        if (!await waitUnlessTeardown(Promise.resolve(readyToRetry()))) return;
      } catch {
        // Readiness aborted — the retry's commit decides.
      }
    }
    if (teardownSignal?.aborted) return;
    type ConflictAddress = { space: MemorySpace; of: URI; scope?: CellScope };
    const isPullableConflict = (value: unknown): value is ConflictAddress => {
      const conflict = value as Partial<ConflictAddress> | null | undefined;
      return typeof conflict?.space === "string" &&
        typeof conflict.of === "string" && conflict.of !== "of:unknown" &&
        (conflict.scope === undefined || isCellScope(conflict.scope));
    };
    const rejection = error as { conflict?: unknown; conflicts?: unknown };
    const listedConflicts = Array.isArray(rejection?.conflicts)
      ? rejection.conflicts.filter(isPullableConflict)
      : [];
    const conflicts = listedConflicts.length > 0
      ? listedConflicts
      : isPullableConflict(rejection?.conflict)
      ? [rejection.conflict]
      : [];
    const pulls: Promise<unknown>[] = [];
    const seen = new Set<string>();
    for (const conflict of conflicts) {
      const key = entityNameKey({
        space: conflict.space,
        id: conflict.of,
        scope: conflict.scope,
      });
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        pulls.push(
          Promise.resolve(
            this.storageManager.open(conflict.space).sync(
              conflict.of,
              { path: [], schema: false },
              conflict.scope,
            ),
          ).catch(() => undefined),
        );
      } catch {
        // A synchronous pull failure leaves the retry's commit to decide.
      }
    }
    if (pulls.length > 0) {
      await waitUnlessTeardown(Promise.all(pulls));
    }
  }

  /**
   * Per-lane state for UI writes (one lane per UI control's cell address):
   * the NEWEST requested value and how many write loops are still in
   * flight. A conflict retry writes the lane's newest value — never its
   * own — so a delayed retry can only ever re-assert the user's latest
   * input; the entry lives until every loop that might still write settles
   * (deleting it earlier would hand a late retry a stale fallback). See
   * {@link commitUiCellWrite}.
   */
  #uiWriteLanes = new Map<string, { value: unknown; inFlight: number }>();

  /**
   * Commit a UI-originated cell write — the renderer `$value`/input path
   * (handleCellSet/handleCellPush in the runtime-client backends) — with
   * the commit-retry protocol every other consumer of the retryable
   * rejection classes already uses ({@link editWithRetry}; the event
   * path's conflict catch-up-then-requeue in scheduler/events.ts; the
   * reactive path's re-queue).
   *
   * Why this exists (the cfc-group-chat-demo `:133` stall —
   * verification-coverage.md OW45's PHASE-3 groupchat observation,
   * rootcause §2b): a blind UI-input write threads a SHAPE precondition at
   * its cell's PARENT (`setBlindStructuralTarget`). Under server execution
   * a serving wave routinely lands structure on the same document
   * concurrently with typing — the first `/cfc` labelMap stamp, a sibling
   * key add on the piece argument doc — and the engine then rejects the
   * input's commit as `stale confirmed read`: a ConflictError the ruled
   * vocabulary classifies RETRYABLE (storage/rejection.ts — catch-up, then
   * a fresh read converges). The previous call sites fired `tx.commit()`
   * and dropped the result, so the rejection's `readyToRetry` gate had no
   * consumer and the USER'S INPUT was silently, permanently lost — while
   * the served derivations over it (a send button's `disabled`) stayed
   * correctly stale forever.
   *
   * Semantics:
   * - `blind: true` is the LWW leaf-overwrite class (every renderer
   *   `$value` input write). The blind marking and the structural target
   *   are re-threaded PER ATTEMPT on the attempt's own fresh transaction,
   *   so a retry re-resolves the cell and bases its shape read on the
   *   caught-up state ("the retry's write carries its true version" —
   *   {@link awaitCommitRetryReadiness}).
   * - `blind: false` is the CAS class (`CellHandle.push`): the value was
   *   resolved by the caller (read-modify-write on the main thread) and
   *   the value-equality reads stay in place. A conflicted CAS write takes
   *   ONE attempt and surfaces the loss loudly — re-running `set` with the
   *   same already-resolved value against fresh state could erase an
   *   intervening writer's append (cubic/codex P1 on #6477); the modify
   *   step is not re-runnable here, so retrying is the caller's decision.
   *   CAS writes also never join a supersede lane: a blind set's retry
   *   must never write a push's resolved value or vice versa.
   * - `supersedeKey` makes writes to one UI control one LANE, and each
   *   attempt writes the lane's NEWEST requested value rather than the
   *   value this call was issued with. That closes both failure shapes at
   *   once: a delayed retry can never re-assert an older input over a
   *   newer one (the LWW-inversion hazard the OW47 report recorded
   *   against unguarded auto-retry), and a newer same-lane call that
   *   resolves VACUOUSLY — its `set` no-ops against the older write's
   *   still-standing optimistic layer, so it holds no ops of its own —
   *   cannot strand the value when that older layer is reverted: the
   *   older call's retry is still live and re-issues the newest value on
   *   the repaired base (the d05-diagnosed remainder of the :133 stall,
   *   where token-based decline left the value owned by a no-op).
   * - a write that exhausts the budget or is refused non-retryably resolves
   *   `{ error }` and is LOUD: `ui-cell-write.lost` is logged at error
   *   level and counted, so a run's census can see dropped user input (the
   *   silent-loss detectability lesson of OW46/S-D). Callers that must not
   *   block (cell IPC) fire-and-forget the returned promise; the loss
   *   report does not depend on them.
   */
  async commitUiCellWrite(
    cell: Cell<unknown>,
    value: unknown,
    options: { blind: boolean; supersedeKey?: string },
  ): Promise<
    | { ok: "committed"; error?: undefined }
    | { ok?: undefined; error: CommitError }
  > {
    const { blind, supersedeKey } = options;
    let lane: { value: unknown; inFlight: number } | undefined;
    if (blind && supersedeKey !== undefined) {
      lane = this.#uiWriteLanes.get(supersedeKey);
      if (lane === undefined) {
        lane = { value, inFlight: 0 };
        this.#uiWriteLanes.set(supersedeKey, lane);
      } else {
        // This call is now the lane's newest input; every still-running
        // loop's next attempt writes this value.
        lane.value = value;
      }
      lane.inFlight++;
    }
    try {
      const result = await this.editWithRetry<"committed">(
        (tx) => {
          // (retry budget: blind writes only — see the CAS bullet above.)
          // Per attempt: write the lane's NEWEST requested value (see the
          // supersedeKey semantics above). Without a lane, this call's own
          // value.
          const attemptValue = lane === undefined ? value : lane.value;
          if (blind) {
            markUiInputBlindWriteTx(tx);
            // Renderer-input provenance that survives to commit, so the
            // scheduler can shape the resulting subscriber wake (timing
            // side-channel mitigation, channels 4/5).
            markRendererInputTx(tx);
            // The resolved storage address of the write target; its parent
            // is the structural existence/shape precondition for the blind
            // write. Resolved on THIS attempt's transaction, so a retry
            // bases on the caught-up state.
            const link = cell.withTx(tx).resolveAsCell()
              .getAsNormalizedFullLink();
            setBlindStructuralTarget(tx, {
              id: link.id,
              space: link.space,
              scope: link.scope,
              path: link.path.slice(0, -1),
            });
          }
          cell.withTx(tx).set(attemptValue);
          if (blind) unmarkUiInputBlindWriteTx(tx);
          return "committed";
        },
        blind ? DEFAULT_MAX_RETRIES : 0,
      );
      if (result.error !== undefined) {
        uiCellWriteLogger.error("lost", () => [
          "a UI cell write was refused and its retries are spent — the " +
          "user's input is dropped",
          {
            blind,
            supersedeKey,
            error: {
              name: (result.error as { name?: string }).name,
              message: (result.error as { message?: string }).message,
            },
          },
        ]);
        return { error: result.error };
      }
      return { ok: "committed" };
    } finally {
      if (blind && supersedeKey !== undefined && lane !== undefined) {
        lane.inFlight--;
        if (
          lane.inFlight <= 0 &&
          this.#uiWriteLanes.get(supersedeKey) === lane
        ) {
          this.#uiWriteLanes.delete(supersedeKey);
        }
      }
    }
  }

  /**
   * Settles whether `tx` is CFC-relevant and prepares it when it is, by
   * forwarding to `tx.prepareForCommit()`, which carries the step.
   *
   * `commit()` runs the same step, so calling this is never what decides
   * whether the transaction is enforced. Call it where the commit's caller
   * reads what prepare produces before the commit runs: the CFC outbox the
   * scheduler counts as post-commit work, and the label-map writes that a
   * reactivity log built before the commit carries.
   *
   * It stays a method on the runtime because a caller's prepare is
   * replaceable per runtime instance through it: the scheduler's backstop
   * for a throw out of prepare, and the cases that stand in for a caller
   * that never prepares, are exercised by replacing it here rather than by
   * patching every transaction the process makes.
   */
  prepareTxForCommit(tx: IExtendedStorageTransaction): void {
    tx.prepareForCommit();
  }

  /**
   * Admits one host-observed value through the ordinary CFC write boundary
   * without committing the staged document. The returned object is opaque:
   * its evidence lives only in this module's WeakMap and is usable once by a
   * matching transaction on this runtime.
   */
  async prepareExternalContentObservation(options: {
    targetTx: IExtendedStorageTransaction;
    space: MemorySpace;
    cause: unknown;
    schema: JSONSchema;
    value: unknown;
    producer: string;
  }): Promise<object> {
    const targetState = options.targetTx.getCfcState();
    if (
      !this.#transactions.has(options.targetTx) ||
      options.targetTx.status().status !== "ready" ||
      targetState.implementationIdentity?.kind !== "builtin" ||
      targetState.implementationIdentity.builtinId !== options.producer
    ) {
      throw externalObservationRefusal(
        "external content observation target does not match this runtime and producer",
        targetState,
      );
    }
    const tx = this.edit();
    const cell = this.getCell<unknown>(
      options.space,
      options.cause,
      options.schema,
      tx,
    );
    try {
      await cell.sync();
      cell.set(options.value);
      this.prepareTxForCommit(tx);
      const preparedState = tx.getCfcState();
      const enforcementDisabled = preparedState.enforcementMode === "disabled";
      if (!enforcementDisabled && preparedState.prepare.status !== "prepared") {
        throw externalObservationRefusal(
          "CFC refused the external content observation",
          preparedState,
        );
      }
      if (
        preparedState.consultedGrants.length > 0 ||
        preparedState.consultedPolicyManifests.length > 0
      ) {
        throw externalObservationRefusal(
          "external content observation admission depends on mutable policy evidence",
          preparedState,
        );
      }
      const policySnapshot = preparedState.policySnapshot === undefined
        ? undefined
        : { digest: preparedState.policySnapshot.digest };
      if (
        !deepEqual(targetState.trustSnapshot, preparedState.trustSnapshot) ||
        !deepEqual(targetState.trustConfig, preparedState.trustConfig) ||
        !deepEqual(
          targetState.policySnapshot === undefined
            ? undefined
            : { digest: targetState.policySnapshot.digest },
          policySnapshot,
        ) ||
        !moduleDelegationsEqual(
          targetState.moduleDelegations,
          preparedState.moduleDelegations,
        ) ||
        !deepEqual(
          externalObservationPosture(targetState),
          externalObservationPosture(preparedState),
        )
      ) {
        throw externalObservationRefusal(
          "external content observation admission context changed",
          preparedState,
        );
      }
      const evidence = {
        trustSnapshot: preparedState.trustSnapshot === undefined
          ? undefined
          : { ...preparedState.trustSnapshot },
        trustConfig: preparedState.trustConfig,
        policySnapshot,
        moduleDelegations: copyModuleDelegations(
          preparedState.moduleDelegations,
        ),
        posture: [...externalObservationPosture(preparedState)],
      };

      // This read runs only after the staged write passed preparation, or in
      // disabled mode where preparation is intentionally a no-op. Traversal
      // can discover an unloaded linked document and start its sync, so each
      // arrival is followed by another read until no link-target load remains.
      // Each pass drops current-instant read memoization so a value materialized
      // by the preceding load is traversed rather than answered from its hole.
      // The storage manager deduplicates every document load for the session;
      // a finite observed value therefore reaches this fixed point without a
      // timer or retrying a failed request.
      let loadRound = 0;
      for (; loadRound < EXTERNAL_OBSERVATION_LOAD_ROUNDS; loadRound++) {
        tx.resetCurrentReadMemoization();
        cell.get({ traverseCells: true });
        // Link resolution can register its tracked sync in a promise
        // continuation. Let that continuation run before inspecting the
        // manager's settled pool, or a just-kicked load looks absent here.
        await Promise.resolve();
        if (
          (this.storageManager.pendingCrossSpacePromiseCount?.() ?? 0) === 0
        ) {
          break;
        }
        await (this.storageManager.crossSpaceSettled?.() ?? Promise.resolve());
      }
      if (loadRound === EXTERNAL_OBSERVATION_LOAD_ROUNDS) {
        throw externalObservationRefusal(
          "external content observation traversal did not converge",
          tx.getCfcState(),
        );
      }
      tx.prepareCfc();
      const finalPreparedState = tx.getCfcState();
      if (
        !enforcementDisabled &&
        finalPreparedState.prepare.status !== "prepared"
      ) {
        throw externalObservationRefusal(
          "CFC refused the traversed external content observation",
          finalPreparedState,
        );
      }
      if (
        finalPreparedState.consultedGrants.length > 0 ||
        finalPreparedState.consultedPolicyManifests.length > 0
      ) {
        throw externalObservationRefusal(
          "external content observation traversal depends on mutable policy evidence",
          finalPreparedState,
        );
      }
      if (
        !deepEqual(
          finalPreparedState.trustSnapshot,
          evidence.trustSnapshot,
        ) ||
        !deepEqual(finalPreparedState.trustConfig, evidence.trustConfig) ||
        !deepEqual(
          finalPreparedState.policySnapshot === undefined
            ? undefined
            : { digest: finalPreparedState.policySnapshot.digest },
          evidence.policySnapshot,
        ) ||
        !moduleDelegationsEqual(
          finalPreparedState.moduleDelegations,
          evidence.moduleDelegations,
        ) ||
        !deepEqual(
          externalObservationPosture(finalPreparedState),
          evidence.posture,
        )
      ) {
        throw externalObservationRefusal(
          "external content observation context changed during traversal",
          finalPreparedState,
        );
      }
      const flow = deriveFlowJoin(tx, { collectLabeledSpaces: true });
      const consumed = collectConsumedLabel(tx);
      const source = cell.getAsNormalizedFullLink();
      const observation = cloneIfNecessary({
        source: {
          space: source.space,
          id: source.id,
          scope: source.scope,
          path: source.path,
        },
        flow: {
          confidentiality: [...flow.confidentiality],
          integrity: [...flow.integrity],
        },
        consumed: {
          confidentiality: [...consumed.confidentiality],
          integrity: [...consumed.integrity],
        },
        labeledSpaces: [...(flow.labeledSpaces ?? [])],
        sources: consumed.sources.map((entry) => ({
          atom: entry.atom,
          read: entry.read,
          labelPath: entry.labelPath,
        })),
      } as FabricValue) as unknown as CfcExternalContentObservation;
      const receipt = Object.freeze({});
      externalObservationReceipts.set(receipt, {
        runtime: this,
        sourceTx: tx,
        targetTx: options.targetTx,
        space: options.space,
        producer: options.producer,
        ...evidence,
        observation,
        consumed: false,
      });
      return receipt;
    } finally {
      if (tx.status().status === "ready") {
        tx.abort("external content observation recorded");
      }
    }
  }

  /** Records a receipt from {@link prepareExternalContentObservation}. */
  recordExternalContentObservation(
    tx: IExtendedStorageTransaction,
    receipt: object,
    options: { space: MemorySpace; producer: string },
  ): void {
    const payload = externalObservationReceipts.get(receipt);
    const state = tx.getCfcState();
    const mismatches = [
      ["missing", payload === undefined],
      ["consumed", payload?.consumed === true],
      ["runtime", payload !== undefined && payload.runtime !== this],
      ["target", payload !== undefined && payload.targetTx !== tx],
      ["target-owner", !this.#transactions.has(tx)],
      ["source-open", payload?.sourceTx.status().status === "ready"],
      ["space", payload !== undefined && payload.space !== options.space],
      [
        "producer",
        payload !== undefined && payload.producer !== options.producer,
      ],
      ["target-closed", tx.status().status !== "ready"],
      [
        "trust",
        payload !== undefined &&
        !deepEqual(state.trustSnapshot, payload.trustSnapshot),
      ],
      [
        "trust-config",
        payload !== undefined &&
        !deepEqual(state.trustConfig, payload.trustConfig),
      ],
      [
        "policy",
        payload !== undefined && !deepEqual(
          state.policySnapshot === undefined
            ? undefined
            : { digest: state.policySnapshot.digest },
          payload.policySnapshot,
        ),
      ],
      [
        "delegations",
        payload !== undefined &&
        !moduleDelegationsEqual(
          state.moduleDelegations,
          payload.moduleDelegations,
        ),
      ],
      [
        "posture",
        payload !== undefined &&
        !deepEqual(externalObservationPosture(state), payload.posture),
      ],
      ["identity-kind", state.implementationIdentity?.kind !== "builtin"],
      [
        "identity-producer",
        state.implementationIdentity?.kind === "builtin" &&
        state.implementationIdentity.builtinId !== options.producer,
      ],
    ].filter(([, mismatch]) => mismatch).map(([name]) => name);
    if (payload === undefined || mismatches.length > 0) {
      throw externalObservationRefusal(
        `external content observation receipt does not match this result write (${
          mismatches.join(", ")
        })`,
        state,
      );
    }
    tx.recordCfcExternalContentObservation(
      payload.observation,
      runtimeWritePolicyAuthorization,
    );
    payload.consumed = true;
  }

  /**
   * Returns the given transaction if it is ready, otherwise creates a new
   * read-only fallback transaction.
   */
  readTx(tx?: IExtendedStorageTransaction): IExtendedStorageTransaction {
    if (tx?.status().status === "ready") {
      return tx;
    }
    return this.#createReadTx();
  }

  #createReadTx(): IExtendedStorageTransaction {
    const tx = this.edit();
    tx.setReadOnly?.("runtime.readTx()");
    return tx;
  }

  // Cell factory methods
  getCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    cause: any,
    schema: S,
    tx?: IExtendedStorageTransaction,
    scope?: NormalizedFullLink["scope"],
  ): Cell<Schema<S>>;
  getCell<T>(
    space: MemorySpace,
    cause: any,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    scope?: NormalizedFullLink["scope"],
  ): Cell<T>;
  getCell(
    space: MemorySpace,
    cause: any,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    scope?: NormalizedFullLink["scope"],
  ): Cell<any> {
    // Creating a cell uses the schema to seed the initial link scope: an
    // explicit scope wins, otherwise a top-level schema scope, otherwise space.
    // (Per-property/asCell scopes are not a top-level concern here; they are
    // resolved during read/write, see data-updating.ts and link-resolution.ts.)
    const effectiveScope = scope ?? schemaCellScope(schema) ?? "space";
    return this.getCellFromLink(
      {
        id: toURI(createRef({}, cause)),
        path: [],
        space,
        scope: effectiveScope,
      },
      schema,
      tx,
    );
  }

  // Cell factory methods
  getSpaceCell<T = SpaceCellContents>(
    space: MemorySpace,
    schema?: undefined,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getSpaceCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getSpaceCell<T>(
    space: MemorySpace,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getSpaceCell(
    space: MemorySpace,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<any> {
    return this.getCell(
      space,
      space, // Use space DID as cause
      schema ?? spaceCellSchema,
      tx,
    );
  }

  getCellFromEntityId<T>(
    space: MemorySpace,
    entityId: EntityId | string,
    path?: readonly PropertyKey[],
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    scope?: NormalizedFullLink["scope"],
  ): Cell<T>;
  getCellFromEntityId<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    entityId: EntityId | string,
    path: readonly PropertyKey[],
    schema: S,
    tx?: IExtendedStorageTransaction,
    scope?: NormalizedFullLink["scope"],
  ): Cell<Schema<S>>;
  getCellFromEntityId(
    space: MemorySpace,
    entityId: EntityId | string,
    path: readonly PropertyKey[] = [],
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    scope: NormalizedFullLink["scope"] = "space",
  ): Cell<any> {
    return this.getCellFromLink(
      {
        id: toURI(entityId),
        path: path?.map(String) ?? [],
        space,
        scope,
      },
      schema,
      tx,
    );
  }

  getCellFromLink<T>(
    cellLink: CellLink | NormalizedLink | AnyCell<unknown>,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<T>;
  getCellFromLink<S extends JSONSchema = JSONSchema>(
    cellLink: CellLink | NormalizedLink | AnyCell<unknown>,
    schema: S,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<Schema<S>>;
  getCellFromLink(
    cellLink: CellLink | NormalizedLink | AnyCell<unknown>,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<any> {
    const carriedLabelView = cfcLabelView ??
      (isSigilLink(cellLink)
        ? linkCfcLabelView(cellLink)
        : isNormalizedFullLink(cellLink)
        ? (cellLink as NormalizedLink & { cfcLabelView?: CfcLabelView })
          .cfcLabelView
        : undefined);
    let link = isCellLink(cellLink)
      ? parseLink(cellLink)
      : isNormalizedFullLink(cellLink)
      ? cellLink
      : isFullNormalizedLinkShape(cellLink)
      ? {
        ...cellLink,
        scope: isCellScope(cellLink.scope)
          ? cellLink.scope
          : normalizeCellScope(undefined),
      }
      : undefined;
    if (!link) throw new Error("Invalid cell link");
    if ("cfcLabelView" in link) {
      const { cfcLabelView: _cfcLabelView, ...cleanLink } = link as
        & NormalizedLink
        & { cfcLabelView?: CfcLabelView };
      link = cleanLink;
    }
    // Intern the schema so the link carries the canonical deep-frozen
    // instance: all downstream identity-keyed schema caches (schemaAtPath,
    // schema-ref memos, SelectorTracker standardization, value-hash) key off
    // deep-frozen identity and stay cold for mutable schema literals. The
    // explicit parameter takes precedence; a schema already embedded in the
    // link (sigil links preserve them through parseLink) is interned too, so
    // schema-bearing links don't bypass the seam. Note that this deep-freezes
    // the schema object in place — see `internCellLinkSchema` for the
    // contract and the proxy exception.
    const effectiveSchema = schema !== undefined ? schema : link.schema;
    if (effectiveSchema !== undefined) {
      link = { ...link, schema: internCellLinkSchema(effectiveSchema) };
    }
    return createCell(
      this,
      link as NormalizedFullLink,
      tx,
      false,
      undefined,
      carriedLabelView,
    );
  }

  /**
   * Makes a read-only cell whose content is `data`, carried entirely in the
   * cell's own `data:` URI id; there is no document in a space to fetch.
   *
   * **Contract note:** `data` is an arbitrary value, deliberately NOT limited
   * to `FabricValue`. Callers pass, among other things, `Cell` objects (wish
   * candidate lists), userland event payloads (whatever patterns and the DOM
   * hand over, `Date`s and `Error`s included), and pattern-authored schema
   * defaults. A `Cell` becomes its sigil link on the way in, by `cellAsLink()`;
   * the conversion itself has no representation for one. Everything past that
   * converts via `fabricFromConvertibleJsValue()`, the designed intake for
   * exactly this: JS instances become their fabric counterparts, and input
   * that is already a deep-frozen `FabricValue` passes through by identity.
   *
   * @param space The space the cell claims as its own (it is not stored
   *   there; links within relate to it).
   * @param data The value to carry. Must be acyclic.
   * @param schema Optional schema for the resulting cell.
   * @param tx Optional transaction for the resulting cell.
   * @param cfcLabelView Optional CFC label view for the resulting cell.
   * @returns A read-only cell whose value is (the fabric conversion of)
   *   `data`.
   */
  getImmutableCell<T>(
    space: MemorySpace,
    data: T,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<T>;
  getImmutableCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    data: any,
    schema: S,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<Schema<S>>;
  getImmutableCell(
    space: MemorySpace,
    data: any,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<any> {
    // Not `dataUriFromValueWithResolvedLinks()`: its link-rewriting walk is
    // unwanted here (this data is immutable as given).
    //
    // Builder artifacts become their encodable form and cells become sigil
    // links HERE rather than at each caller. Neither has a fabric
    // representation, so both have to go before the value reaches
    // `fabricFromConvertibleJsValue()`. This is the designed intake, and the
    // callers are many: raw and JavaScript node inputs, wish candidates, schema
    // defaults. Covering them one at a time was tried and is whack-a-mole --
    // each site that is missed fails as a rejection at the conversion, or worse
    // as a cleanup error that masks it.
    //
    // One walk covers both. A cell is a leaf to it -- what stands in for a cell
    // is the link it names, not a container to descend into -- and an
    // artifact's encodable form is walked in turn, so a cell inside one is
    // reached as well.
    // Links serialized into a `data:` document carry their schemas inline
    // (see inlineExternalSchemaRefsInValue): the document is its id, so a
    // content-addressed reference inside it has no carrying write to install
    // its closure.
    const asDataURI = dataUriFromValue(
      inlineExternalSchemaRefsInValue(
        fabricFromConvertibleJsValue(
          flattenBuilderArtifacts(data, { replaceOther: cellAsLink }),
        ),
      ),
    );
    return createCell(
      this,
      {
        space,
        path: [],
        id: asDataURI,
        schema: internCellLinkSchema(schema),
      },
      tx,
      false,
      undefined,
      cfcLabelView,
    );
  }

  /**
   * The principal whose HOME SPACE a home-space resolution targets —
   * the wish builtin's `#favorites`/`#profile` family (server-execution
   * v2 Phase 5; builtins.md §5's per-demanding-identity wish
   * resolution, RULED 2026-08-14):
   *
   * - On a CLIENT (and the whole OFF arm): the runtime's own user —
   *   cardinality 1, today's behavior byte-for-byte.
   * - On a SERVING runtime: the RUN's identity — the demand-supplied
   *   instance identity (P2-F's run supply) or the event's stamped
   *   actor — read from the transaction's stamped wave run context.
   *   NEVER the runtime's own identity: that is the SERVICE identity,
   *   and resolving it was the lunch-wall trap (a wish materializing
   *   against the service home space — a foreign wave write).
   * - On a serving runtime with NO acting run identity (a space-scope
   *   run with no demanding principal): undefined — the caller
   *   refuses loudly rather than falling back to the service DID.
   */
  homeSpacePrincipalFor(
    tx?: IExtendedStorageTransaction,
  ): DID | undefined {
    if (!this.servingPosture) return this.userIdentityDID;
    const context = tx === undefined ? undefined : waveRunContextOf(tx);
    const principal = context?.scopeKeyIdentity?.principal ??
      context?.acting?.user;
    if (principal !== undefined && tx !== undefined) {
      // IDENTITY CONSUMPTION is a user-scoped read (server-execution v2
      // fan-out stage B, design §F's third ratchet source — RULED
      // 2026-08-16): resolving WHOSE home space this run targets makes
      // the run's value per demanding principal by construction — a
      // served `#profile` wish that reads no scoped doc but provisions
      // into the demander's home space is a USER-scoped node, so its
      // scope-derived attribution carries the user and its provisioning
      // rides the `demanded-run:<user>` carriage. The transaction's
      // read-scope ratchet is what the seal and the scheduler's
      // known-scope ratchet learn from; it only ever narrows.
      if (scopeRank(tx.getNarrowestReadScope()) < scopeRank("user")) {
        tx.resetNarrowestReadScope("user");
      }
    }
    return principal as DID | undefined;
  }

  getHomeSpaceCell(
    tx?: IExtendedStorageTransaction,
  ): Cell<SpaceCellContents> {
    const principal = this.homeSpacePrincipalFor(tx);
    if (principal === undefined) {
      // Serving posture with no demanding identity (see
      // homeSpacePrincipalFor): fail closed — never the service DID.
      throw new Error(
        "home-space resolution on a serving runtime requires the run's " +
          "demanding identity (builtins.md §5's per-demanding-identity " +
          "wish resolution; scopes.md §5 — the demand supplies the " +
          "identity); refusing to resolve the SERVICE identity's home " +
          "space",
      );
    }
    return this.getCell(
      principal,
      principal,
      spaceCellSchema,
      tx,
    ) as Cell<SpaceCellContents>;
  }

  /**
   * Returns the DID for a named `PatternFactory.inSpace("name")` target if it
   * has already been resolved (or is itself a DID), otherwise `undefined`.
   *
   * Synchronous so the pattern builder can route a child result into the target
   * space at graph-construction time. On a miss, the caller records the name as
   * pending and the runner resolves it via {@link resolveSpaceName} before
   * re-running the handler/action (see RetryImmediately).
   */
  resolveSpaceNameSync(name: string): MemorySpace | undefined {
    if (isDID(name)) return name;
    return this.#spaceNameToDid.get(name);
  }

  /**
   * Resolves a named `inSpace` target to a DID, caching the result.
   *
   * NOTE(#1): The derivation is intentionally name-based for now — `createSession`
   * derives the space key from the name alone (the identity is ignored on the
   * `spaceName` path), so equal names map to the same shared space across users.
   * This is the deliberate "shared profile space" behavior today; revisit once
   * we can derive unique space DIDs from a string.
   *
   * OW31 (RULED 2026-08-18): `options.owner` names the fresh space's
   * genesis ACL OWNER. On a SERVING runtime the caller MUST supply the
   * run's ACTING principal (the serving-side resolvePendingSpaceNames
   * threads it from the frame tx's wave run context) — a serving runtime
   * with no actor REFUSES to register, mirroring getHomeSpaceCell's
   * refusal: a served `.inSpace()` with no acting identity must never
   * mint a service-owned space (builtins.md §5; protocol.md §2b). On a
   * client the owner is omitted and the genesis names the manager's own
   * signer — the active user, byte-identical to before.
   *
   * `options.genesisAcl` is the exact ACL document the space is born with
   * when this resolution creates it (its first and only commit — no
   * world-writable default is ever written), validated by the memory
   * server's genesis admission; on a space that already exists the open
   * proceeds only if it is owned exactly as the document says, else
   * refuses. It is
   * refused together with `owner` (two descriptions of one document), for
   * a bare DID (no key to register against), and for a name already
   * resolved — by anything, including a pattern's `inSpace(name)` — unless
   * with the identical document; see `IStorageManager.registerSpaceIdentity`.
   * The name is cached at resolution, before the server can refuse the
   * document, so a refusal surfaced later (on the first sync) has no
   * correction path through this method: register a corrected document
   * with the storage manager directly, or use a fresh runtime. A SERVING
   * runtime refuses it outright: served provisioning names the run's
   * acting user OWNER through the OW31 owner path, and a document that
   * bypassed that path could name any principal — including the service —
   * on a space the acting user asked for. A creator that wants a sealed
   * space mints it from its own (client) runtime.
   */
  async resolveSpaceName(
    name: string,
    options?: { owner?: DID; genesisAcl?: ACL },
  ): Promise<MemorySpace> {
    if (options?.owner !== undefined && options?.genesisAcl !== undefined) {
      // Two descriptions of one document: refused before anything else,
      // cached path included, mirroring registerSpaceIdentity.
      throw new Error(
        `space-name resolution for "${name}": supply either owner or ` +
          "genesisAcl, not both — genesisAcl is the whole genesis document, " +
          "and owner only names the OWNER of the default one",
      );
    }
    if (
      options?.genesisAcl !== undefined &&
      this.storageManager.registerSpaceIdentity === undefined
    ) {
      // No seam to hand the document to; the optional call below would
      // drop it and the space would be born with the default.
      throw new Error(
        `space-name resolution for "${name}" cannot register a genesisAcl: ` +
          "this storage manager has no registerSpaceIdentity seam, so " +
          "nothing would write the document",
      );
    }
    const inFlight = this.#spaceNameResolutions.get(name);
    if (inFlight !== undefined) {
      // Join the resolution already under way — its rejection is this
      // caller's too — then take the cached path: an identical document is
      // a retry, a different one is refused.
      await inFlight;
      return await this.resolveSpaceName(name, options);
    }
    const cached = this.resolveSpaceNameSync(name);
    if (options?.genesisAcl !== undefined) {
      // A document the resolution cannot honor is refused, never dropped:
      // the caller asked for a space born closed.
      if (isDID(name)) {
        throw new Error(
          `space-name resolution for the DID ${name} cannot register a ` +
            "genesisAcl: the runtime derives no space key for a bare DID, " +
            "so nothing would write the document (register the identity " +
            "with the storage manager directly)",
        );
      }
      if (cached !== undefined) {
        const recorded = this.#spaceNameGenesisAcls.get(name);
        if (recorded === undefined || !sameAcl(recorded, options.genesisAcl)) {
          throw new Error(
            `space-name "${name}" was already resolved` +
              (recorded === undefined
                ? " without a genesisAcl"
                : " with a different genesisAcl") +
              "; the supplied document cannot be the space's genesis",
          );
        }
        return cached;
      }
    }
    if (cached !== undefined) return cached;
    if (this.servingPosture && options?.genesisAcl !== undefined) {
      throw new Error(
        `space-name resolution for "${name}" on a serving runtime does not ` +
          "accept genesisAcl: served provisioning names the run's acting " +
          "identity OWNER through the owner path (OW31, RULED 2026-08-18), " +
          "and a caller-supplied document would bypass it",
      );
    }
    if (this.servingPosture && options?.owner === undefined) {
      throw new Error(
        `space-name resolution for "${name}" on a serving runtime requires ` +
          "the run's acting identity as genesis owner (OW31, RULED " +
          "2026-08-18; builtins.md §5's per-demanding-identity resolution; " +
          "protocol.md §2b): refusing to register a space identity whose " +
          "genesis would name the SERVICE as owner",
      );
    }
    const resolution = (async (): Promise<MemorySpace> => {
      const session = await createSession({
        identity: this.storageManager.as as unknown as Identity,
        spaceName: name,
      });
      if (options?.genesisAcl !== undefined && !session.spaceIdentity) {
        throw new Error(
          `space-name resolution for "${name}" derived no space identity, ` +
            "so the supplied genesisAcl could not be registered",
        );
      }
      // Register the derived identity only as fresh-space ACL bootstrap
      // authority. Storage continues to authenticate ordinary reads and
      // writes as the active user (`storageManager.as`), so resolving a name
      // does not grant an existing space's key to the caller.
      if (session.spaceIdentity) {
        this.storageManager.registerSpaceIdentity?.(
          session.spaceIdentity,
          options?.owner !== undefined || options?.genesisAcl !== undefined
            ? {
              ...(options.owner !== undefined ? { owner: options.owner } : {}),
              ...(options.genesisAcl !== undefined
                ? { genesisAcl: options.genesisAcl }
                : {}),
            }
            : undefined,
        );
      }
      const did = session.space as MemorySpace;
      this.#spaceNameToDid.set(name, did);
      if (options?.genesisAcl !== undefined) {
        this.#spaceNameGenesisAcls.set(name, { ...options.genesisAcl });
      }
      return did;
    })();
    this.#spaceNameResolutions.set(name, resolution);
    try {
      return await resolution;
    } finally {
      this.#spaceNameResolutions.delete(name);
    }
  }

  // Convenience methods that delegate to the runner
  syncStoredSetupArgument(
    resultCell: Cell<unknown>,
  ): Promise<(candidate: Cell<unknown>) => boolean> {
    return this.runner.syncStoredSetupArgument(resultCell);
  }

  setup<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
    options?: RuntimeSetupOptions,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options?: RuntimeSetupOptions,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options?: RuntimeSetupOptions,
  ): Promise<Cell<R>> {
    return this.runner.setup<T, R>(
      tx,
      patternOrModule,
      argument,
      resultCell,
      options,
    );
  }
  run<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R> {
    return this.runner.run<T, R>(tx, patternOrModule, argument, resultCell);
  }

  /** Runs a pattern after synchronizing its stored dependencies. */
  runSynced(
    resultCell: Cell<any>,
    pattern: Pattern | Module,
    inputs?: any,
    options?: RunSyncedOptions,
  ): Promise<Cell<any>> {
    return this.runner.runSynced(resultCell, pattern, inputs, options);
  }

  /** Runs a pattern and returns its accepted setup transaction receipt. */
  runSyncedWithCommit(
    resultCell: Cell<any>,
    pattern: Pattern | Module,
    inputs: any,
    options: RunSyncedWithCommitOptions,
  ): Promise<RunSyncedCommitResult<any>> {
    return this.runner.runSyncedWithCommit(
      resultCell,
      pattern,
      inputs,
      options,
    );
  }

  start<T = any>(resultCell: Cell<T>): Promise<boolean> {
    return this.runner.start(resultCell);
  }

  /**
   * The host explicitly known to serve a space, if any: the seed map
   * wins, then runtime-learned hints (site table). Undefined means
   * "no per-space fact" — callers choose their own default (storage
   * and hostForSpace use apiUrl; LLM/fetch keep their module-level
   * defaults, which may deliberately differ from apiUrl).
   */
  mappedHostFor(space: MemorySpace): string | undefined {
    return this.spaceHostMap?.[space] ?? this.#dynamicHosts.get(space);
  }

  /**
   * The host that serves a space's space-bound work (LLM, fetch, blob).
   * A mapped space resolves to its host; everything else to the
   * default `apiUrl`. The single compute-side analog of the storage
   * layer's per-space address resolver.
   */
  hostForSpace(space: MemorySpace): URL {
    return new URL(this.mappedHostFor(space) ?? this.apiUrl);
  }

  /**
   * Records a runtime-learned HTTP or HTTPS origin for a space (the v0
   * site-table flow). Storage decides first. A seed or an accepted late hint
   * fixes the route for the session. A default-host provider stays provisional
   * while it is read-only. The first hint can replace it and replay its reads.
   * Compute routing follows when storage accepts the hint. Returns whether
   * storage accepted or confirmed the hint.
   */
  registerSpaceHost(space: MemorySpace, host: string): boolean {
    let route: URL;
    try {
      route = normalizeSpaceHost(host);
    } catch (cause) {
      if (!(cause instanceof SpaceHostValidationError)) throw cause;
      throw new Error(
        `Invalid host for space ${space}`,
        { cause },
      );
    }
    const normalized = route.toString();
    const accept = this.storageManager.registerSpaceHost?.(space, normalized);
    if (accept === undefined) return false; // manager has no remote resolution
    if (accept) this.#dynamicHosts.set(space, normalized);
    return accept;
  }

  /**
   * The default host's self-reported git commit, captured from its
   * `/_health` response's `x-cf-git-sha` header by the most recent
   * `healthCheck()` call. Null before any check or when the host omits
   * the header (older servers). Read from the headers — never the body
   * — so the capture completes exactly when the health probe does; a
   * stalled or truncated body cannot delay it.
   */
  get serverGitSha(): string | null {
    return this.#serverGitSha;
  }

  #serverGitSha: string | null = null;
  #healthCheckGeneration = 0;

  /**
   * True iff the default host AND every distinct mapped host are
   * reachable — one runtime can span hosts, so health is the
   * conjunction over all of them. The optional signal cancels the requests.
   */
  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    // Overlapping calls each capture into their own generation; only the
    // newest call's capture publishes, so a slow earlier response cannot
    // overwrite a newer one after the fact.
    const generation = ++this.#healthCheckGeneration;
    this.#serverGitSha = null;
    const defaultHost = this.apiUrl.toString();
    const hosts = new Set([defaultHost]);
    for (
      const host of [
        ...Object.values(this.spaceHostMap ?? {}),
        ...this.#dynamicHosts.values(),
      ]
    ) {
      try {
        hosts.add(new URL(host).toString());
      } catch {
        return false; // a malformed mapped host is unhealthy by definition
      }
    }
    const checks = [...hosts].map(async (host) => {
      try {
        const res = await fetch(new URL("/_health", host), { signal });
        if (
          host === defaultHost && generation === this.#healthCheckGeneration
        ) {
          const sha = res.headers.get("x-cf-git-sha")?.trim();
          this.#serverGitSha = sha ? sha : null;
        }
        return res.ok;
      } catch (_) {
        signal?.throwIfAborted();
        return false;
      }
    });
    return (await Promise.all(checks)).every(Boolean);
  }
}
