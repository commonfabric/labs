import type { JSONSchema } from "@commonfabric/api";
import {
  cloneIfNecessary,
  debugStr,
  fabricFromConvertibleJsValue,
  type FabricValue,
  toStructuredDebugValue,
} from "@commonfabric/data-model";
import { newDefaultJsonCodecEngine } from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  type SiteTable,
  siteTableCause,
  siteTableSchema,
} from "@commonfabric/home-schemas";
import {
  normalizeRenderConfidentialityCeiling,
  normalizeRenderDeclassificationPolicy,
  type RenderConfidentialityCeiling,
  type RenderDeclassificationPolicy,
  rootRenderPolicyFor,
  type SpaceAccessProvider,
  WorkerReconciler,
} from "@commonfabric/html/worker";
import { DID, Identity, type Session } from "@commonfabric/identity";
import { isDID } from "@commonfabric/identity/did";
import type { Program } from "@commonfabric/js-compiler";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { setLLMUrl } from "@commonfabric/llm";
import { type ACL, isACLUser, isCapability } from "@commonfabric/memory/acl";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  PresenceEvent,
  PresenceMembership,
} from "@commonfabric/memory/v2/client";
import { presenceRoomForField } from "@commonfabric/memory/v2/presence";
import {
  dbNeedsColumnProvenance,
  DEFAULT_BRANCH,
  eventAttentionEntryKey,
  type EventAttentionIndexValue,
  type OperationFieldAddress,
  resolveScopeKey,
  SERVER_EXECUTION_ATTENTION_DOC_ID,
  type SqliteDbRef,
  type StreamEventsDocValue,
  toValuePath,
  type UnresolvedEventAttention,
} from "@commonfabric/memory/v2";
import {
  PieceController,
  PiecesController,
  type PreparedPieceSourceChange,
  readPieceSourceMetadata,
  readPieceSourceRevision,
  readPieceSourceState,
} from "@commonfabric/piece/ops";
import type { RuntimeOptions } from "@commonfabric/runner";
import {
  ACLManager,
  type BrowserWorkerPresetParams,
  type Cancel,
  type Cell,
  ContextualFlowControl,
  encodeSqliteParams,
  entityIdFrom,
  type EventIntentOutcome,
  getCellOrThrow,
  getMetaLink,
  getPatternIdentityRef,
  hasOperationStorageCapability,
  hasPresenceStorageCapability,
  hostValueOf,
  type IExtendedStorageTransaction,
  type IOperationStorageCapability,
  isCell,
  isCellResult,
  isLoopbackHostname,
  markDurableReadTx,
  type NormalizedFullLink,
  normalizeSpaceHost,
  parseLink,
  PatternCoverageCollector,
  popFrame,
  pushFrame,
  resolveExternalRootRefForStructure,
  resolveSlugReference,
  resolveSlugTargetInPiece,
  Runtime,
  runtimePresets,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  setPatternEnvironment,
  type SigilLink,
  SlugResolutionError,
  SpaceHostValidationError,
} from "@commonfabric/runner";
import {
  type CfcModulePolicySource,
  createRenderConfidentialityResolver,
  createRuntimeCfcModulePolicySource,
  createRuntimeSpaceMembershipProvider,
  markRendererTrustedEvent,
  type RenderConfidentialityResolver,
  type SpaceMembershipProvider,
  stripSigilCfcLabelViews,
} from "@commonfabric/runner/cfc";
import {
  commitSnapshotShare,
  prepareSnapshotShare,
  type SnapshotShareConsent,
} from "@commonfabric/runner/cfc/share-snapshot";
import {
  commitCustodySeal,
  CUSTODY_SEAL_GESTURE,
  type CustodySealConsent,
  prepareCustodySeal,
  publishCustodyAnswer,
  readCustodyAnswer,
} from "@commonfabric/runner/cfc/custody-seal";
import { hashStringForEntityAddress } from "@commonfabric/runner/entity-kind";
import {
  NameSchema,
  rendererVDOMSchema,
  viewPieceSchema,
} from "@commonfabric/runner/schemas";
import { linkRefPayload } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import {
  getLogger,
  getLoggerCountsBreakdown,
  getLoggerFlagsBreakdown,
  getTimingStatsBreakdown,
  Logger,
  resetAllCountBaselines,
  resetAllTimingBaselines,
} from "@commonfabric/utils/logger";
import { backtickQuote } from "@commonfabric/utils/markdown";
import {
  isObjectNotArray,
  isObjectOrArray,
  isPlainObject,
} from "@commonfabric/utils/types";

import { type DocumentAt, HostReadGate } from "./host-read-gate.ts";
import { postToClient } from "./post-to-client.ts";
import { preloadProfiles } from "./preload-profiles.ts";
import { runtimeErrorReport } from "./runtime-error.ts";
import {
  assertFabricLoggerFlags,
  getCell,
  mapCellRefsToSigilLinks,
} from "./utils.ts";
import {
  type ClientId,
  clientKeyPrefix,
  clientScopedKey,
  ownerClient,
  type WorkerClient,
} from "./worker-client.ts";
import {
  type ActionRunTraceResponse,
  BooleanResponse,
  type CellFieldsRequest,
  type CellFieldsResponse,
  type CellGetCfcLabelRequest,
  type CellGetRequest,
  type CellGetResponse,
  type CellInitializeRequest,
  type CellPullRequest,
  type CellPushRequest,
  type CellRef,
  type CellResolveAsCellRequest,
  type CellResolveResponse,
  CellResponse,
  type CellSendRequest,
  type CellSetRequest,
  type CellSubscribeRequest,
  type CellUnsubscribeRequest,
  type CellValueResponse,
  type CfcLabelViewResponse,
  ClientNotificationType,
  type CommandResponse,
  type CreateSpaceRequest,
  type CustodyAnswerPublishRequest,
  type CustodyAnswerPublishResponse,
  type CustodyAnswerReadRequest,
  type CustodyAnswerReadResponse,
  type CustodySealCommitRequest,
  type CustodySealCommitResponse,
  type CustodySealPrepareRequest,
  type CustodySealPreview,
  type DetectNonIdempotentRequest,
  type DetectNonIdempotentResponse,
  type EnsureHomePatternRunningRequest,
  type EventAttentionListResponse,
  type EventAttentionResolveResponse,
  type EventIntentOutcomeNotification,
  type EventNeedsAttentionNotification,
  type GetActionRunTraceRequest,
  type GetCellRequest,
  GetGraphSnapshotRequest,
  type GetHomeSpaceCellRequest,
  type GetLoggerCountsRequest,
  type GetPatternCoverageRequest,
  type GetPatternSourcesRequest,
  type GetSettleStatsHistoryRequest,
  type GetSettleStatsRequest,
  GetSpaceRootPatternRequest as PatternGetSpaceRoot,
  type GetTriggerTraceRequest,
  type GetWriteStackTraceRequest,
  GraphSnapshotResponse,
  type InitializationData,
  type IPCClientNotification,
  IPCClientRequest,
  isCellRef,
  type ListEventAttentionRequest,
  type LoggerCountsResponse,
  type LoggerMetadata,
  type LogLevel,
  NotificationType,
  type OperationApplyRequest,
  type OperationApplyResponse,
  type OperationCapabilitiesRequest,
  type OperationCapabilitiesResponse,
  type OperationFieldResponse,
  type OperationQueryRequest,
  type OperationReleaseRequest,
  type OperationSessionCloseRequest,
  type OperationSubscribeRequest,
  type OperationUnsubscribeRequest,
  type PatternCoverageResponse,
  type PatternSourceInfo,
  type PatternSourcesResponse,
  type PieceCloneRequest,
  type PieceCreateRequest,
  type PieceGetAllRequest,
  type PieceGetRequest,
  type PieceGetSlugRequest,
  type PieceGetSourceRequest,
  type PieceGetSourceRevisionRequest,
  type PieceRemoveRequest,
  PieceResponse,
  type PieceSourceResponse,
  type PieceSourceRevisionResponse,
  type PieceStartRequest,
  type PieceStopRequest,
  type PieceSyncedRequest,
  type PieceUpdateSourceRequest,
  type PieceUpdateSourceResponse,
  type PieceUpdateSourceResult,
  type PresenceJoinRequest,
  type PresenceJoinResponse,
  type PresenceLeaveRequest,
  type PresencePublishRequest,
  type PresenceWireEvent,
  type RecreateSpaceRootPatternRequest,
  type RegisterSpaceHostDetailedRequest,
  type RegisterSpaceHostRequest,
  RequestType,
  type ResolveEventAttentionRequest,
  type RetrySpaceAccessRequest,
  RuntimeErrorCode,
  type RuntimeSecurityContext,
  type SetActionRunTraceEnabledRequest,
  type SetBreakpointsRequest,
  type SetLoggerEnabledRequest,
  type SetLoggerLevelRequest,
  type SetMemoryMessageCompressionRequest,
  type SetReadStatsEnabledRequest,
  type SetSettleStatsEnabledRequest,
  type SetTelemetryEnabledRequest,
  type SettleStatsHistoryResponse,
  type SettleStatsResponse,
  type SetTriggerTraceEnabledRequest,
  type SetWriteStackTraceMatchersRequest,
  type SlugReferenceResponse,
  type SlugResolveRequest,
  type SlugResponse,
  type SnapshotShareCommitRequest,
  type SnapshotSharePrepareRequest,
  type SnapshotSharePrepareResponse,
  type SpaceAclResponse,
  type SpaceGetAclRequest,
  type SpaceHostRegistrationResponse,
  type SpaceRemoveAclEntryRequest,
  type SpaceResponse,
  type SpaceSetAclEntryRequest,
  type SqliteExecRequest,
  type SqliteParams,
  type SqliteQueryRequest,
  type SqliteQueryResponse,
  type TriggerTraceResponse,
  type UploadBlobRequest,
  type UploadBlobResponse,
  type VDomBatchAppliedNotification,
  type VDomEventNotification,
  type VDomMountRequest,
  type VDomMountResponse,
  type VDomUnmountRequest,
  type WriteStackTraceResponse,
} from "@/protocol/mod.ts";
import type { RemoteResponse, VDomOp } from "@/protocol/types.ts";
import {
  type EveryFieldOf,
  normalizeOrigin,
  normalizeSpaceHostMap,
  securityContextDifferences,
} from "@/shared/security-context.ts";
import { cellRefToKey, describeFailure } from "@/shared/utils.ts";

/** Subscribe the worker bridge to attention and refused-admission outcomes. Keeping
 * the filter and wire projection here makes the host boundary independently
 * testable without booting a worker runtime. */
export function subscribeEventAttentionNotifications(
  runtime: Pick<Runtime, "subscribeEventIntentOutcomes">,
  post: (notification: EventNeedsAttentionNotification) => void = postToClient,
  postRefusal: (notification: EventIntentOutcomeNotification) => void =
    postToClient,
): Cancel {
  return runtime.subscribeEventIntentOutcomes((outcome: EventIntentOutcome) => {
    if (outcome.kind === "refused") {
      postRefusal({
        type: NotificationType.EventIntentOutcome,
        space: outcome.space,
        eventId: outcome.eventId,
        kind: "refused",
        reason: "admission-refused",
      });
      return;
    }
    if (
      outcome.kind !== "needs-attention" ||
      outcome.sidecarId === undefined ||
      typeof outcome.seq !== "number" ||
      outcome.attention === undefined
    ) return;
    post({
      type: NotificationType.EventNeedsAttention,
      space: outcome.space,
      eventId: outcome.eventId,
      seq: outcome.seq,
      sidecarId: outcome.sidecarId,
      retryable: outcome.retryable,
      reason: outcome.reason,
      attention: outcome.attention,
    });
  });
}

/**
 * Maximum nesting depth of a console argument's debug rendering. The bound is
 * on the size of a message pattern code can emit in a loop; the transport
 * imposes none of its own. Two of the levels are the rendering's, spent on the
 * shapes this bridge exists to carry -- a tag around an instance's encoded
 * contents, a ref beside a query result's data -- so the depth of the logged
 * value that survives is smaller than the number here.
 */
const MAX_CONSOLE_DEBUG_DEPTH = 7;

const blobUploadCodec = newDefaultJsonCodecEngine();

/** Each registered logger's enabled state and level. */
function loggerMetadata(): LoggerMetadata {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, Logger> };
  };
  const result: LoggerMetadata = {};
  if (global.commonfabric?.logger) {
    for (const [name, logger] of Object.entries(global.commonfabric.logger)) {
      result[name] = {
        enabled: !logger.disabled,
        level: (logger.level ?? "info") as LogLevel,
      };
    }
  }
  return result;
}

function spaceAclResponse(
  runtime: Runtime,
  space: DID,
  acl: ACL | null,
): SpaceAclResponse {
  const principal = runtime.userIdentityDID;
  const capability = acl?.[principal] ?? acl?.["*"];
  return {
    access: {
      space,
      principal,
      acl: { ...(acl ?? {}) } as SpaceAclResponse["access"]["acl"],
      canEdit: capability === "OWNER",
    },
  };
}

// Split-timing for the CFC label IPC path. Counts/timing are readable via
// getLoggerCounts(); enabled silently so the hot path pays only the timestamp.
const cfcLabelLogger = getLogger("runtime-client.cfc-label", {
  enabled: true,
  level: "error",
});

function isSqliteDbRefValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" &&
    !!candidate.tables && typeof candidate.tables === "object" &&
    !Array.isArray(candidate.tables) &&
    (candidate.scope === undefined || candidate.scope === "space" ||
      candidate.scope === "user" || candidate.scope === "session") &&
    (candidate.owner === undefined || typeof candidate.owner === "string");
}

function sqliteParamForRuntime(
  runtime: Runtime,
  value: FabricValue,
  tx?: IExtendedStorageTransaction,
): unknown {
  if (value instanceof FabricBytes) return value;
  if (isCellRef(value)) {
    const cell = getCell(runtime, value);
    return tx ? cell.withTx(tx) : cell;
  }
  if (Array.isArray(value)) {
    return value.map((member) => sqliteParamForRuntime(runtime, member, tx));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        sqliteParamForRuntime(runtime, member, tx),
      ]),
    );
  }
  return value;
}

/**
 * Whether `cell` holds no value: nothing at all, or an empty plain object. A
 * pull can find a scoped target in either state while the write that creates
 * its value is still committing, which the commit-aware barrier waits for.
 */
function holdsNoValue(cell: Cell<unknown>): boolean {
  const raw = cell.getRaw({ lastNode: "value" });
  return raw === undefined ||
    (isPlainObject(raw) && Object.keys(raw).length === 0);
}

function sqliteParamsForRuntime(
  runtime: Runtime,
  params: SqliteParams,
  tx?: IExtendedStorageTransaction,
): ReadonlyArray<unknown> | Record<string, unknown> {
  const decode = (value: FabricValue) =>
    sqliteParamForRuntime(runtime, value, tx);
  return params.kind === "positional"
    ? params.values.map(decode)
    : Object.fromEntries(
      params.entries.map(([key, value]) => [key, decode(value)]),
    );
}

function sqliteValueForClient(value: unknown): FabricValue {
  return fabricFromConvertibleJsValue(value);
}

function resolveBlobUrl(url: string, apiUrl: URL, space: DID): string {
  const spaceBaseUrl = new URL(`/${space}/`, apiUrl);
  return new URL(url, spaceBaseUrl).href;
}

/**
 * Asserts that the constructed runtime's resolved server-execution posture
 * matches the one the host declared in
 * `InitializationData.experimental.serverExecution`, and throws on a
 * divergence in either direction: a host that declared ON over a worker
 * that resolved OFF, or a worker whose realm-ambient default flipped ON
 * under a host that declared nothing. Either way the F10 client contract
 * (`docs/specs/server-side-execution/`) would run in one realm and not the
 * other, with handler commits diverted on one side only, so initialization
 * refuses rather than proceeding. A host that declares nothing and a worker
 * that resolves OFF agree, so a deployment that sets no flag passes.
 * Exported for testing.
 */
export function assertServerExecutionPostureAgreement(
  declared: InitializationData["experimental"],
  runtime: { experimental: { serverExecution?: boolean | undefined } },
): void {
  const hostOn = declared?.serverExecution === true;
  const workerOn = runtime.experimental.serverExecution === true;
  if (hostOn !== workerOn) {
    throw new Error(
      "worker/host server-execution posture mismatch: the host declared " +
        `${hostOn ? "ON" : "OFF (or absent)"} but the worker runtime ` +
        `resolved ${workerOn ? "ON" : "OFF"} — a divergent posture runs ` +
        "the F10 client contract in one realm and not the other " +
        "(see docs/specs/server-side-execution/)",
    );
  }
}

/**
 * Maps host-decided `InitializationData` onto `runtimePresets.browserWorker`
 * params. The shared first-party posture (CFC pins, patternEnvironment from
 * apiUrl) lives in the preset; this function carries only what the host
 * actually decided. Exported for testing.
 */
export function browserWorkerParamsFromInitializationData(
  data: InitializationData,
  storageManager: RuntimeOptions["storageManager"],
  telemetry: RuntimeTelemetry,
): BrowserWorkerPresetParams {
  return {
    apiUrl: new URL(data.apiUrl),
    storageManager,
    // The host decides the flags (shell build-time defines); absent ⇒ runtime
    // defaults.
    experimental: data.experimental ?? {},
    telemetry,
    ...(data.spaceHostMap !== undefined
      ? { spaceHostMap: data.spaceHostMap }
      : {}),
    ...(data.cfcEnforcementMode !== undefined
      ? { cfcEnforcementMode: data.cfcEnforcementMode }
      : {}),
    ...(data.cfcFlowLabels !== undefined
      ? { cfcFlowLabels: data.cfcFlowLabels }
      : {}),
    ...(data.cfcReadMaxConfidentiality !== undefined
      ? { cfcReadMaxConfidentiality: data.cfcReadMaxConfidentiality }
      : {}),
    ...(data.cfcReadOnExceed !== undefined
      ? { cfcReadOnExceed: data.cfcReadOnExceed }
      : {}),
    ...(data.cfcTrustConfig !== undefined
      ? { cfcTrustConfig: data.cfcTrustConfig }
      : {}),
    ...(data.trustSnapshot
      ? { trustSnapshotProvider: () => data.trustSnapshot }
      : {}),
    // The worker owns its collector so the GetPatternCoverage handler can read
    // it back through `runtime.patternCoverage`; the harness pulls it at teardown.
    ...(data.patternCoverage
      ? { patternCoverage: new PatternCoverageCollector() }
      : {}),
  };
}

/**
 * Builds the display-boundary resolver for a worker's renders. When a ceiling
 * is in force, each render egress resolves principal-form atoms
 * (Space-via-HasRole) RUNNER-side; the reconciler only fits the result.
 *
 * Reader membership is sourced ONLY from verified facts, never from a cell's
 * mere local residency:
 *  - the current session workspace (`sessionSpace` = the space the session was
 *    authorized to open), while the acting principal is the session's own key
 *    holder: `session.open` gated on READ there, so an own-workspace
 *    `Space(...)` label resolves rather than over-blocking. That workspace is
 *    usually the user's Home space. Being the space's DID is not itself
 *    evidence: a Home space's user reads it because its ACL says so. A
 *    principal a host names in the key holder's place reaches that space
 *    through the membership lookup below.
 *
 * Broader cross-space membership comes from the §4.9.3 membership lookup: a
 * runtime-backed `SpaceMembershipProvider` reads each other space's declared
 * ACL doc and mints a reader fact only when it grants the acting user READ+
 * (never from residency). Its cross-space guarantee is exactly as strong as
 * the deployment `MEMORY_ACL_MODE`. A label that selects a module policy
 * (`PolicyOf<...>`) runs that module's exchange rules too, with its manifest
 * read and verified through `modulePolicySource` from the space the label is
 * stored in, and the policy's subject space's membership looked up like a
 * `Space(...)` atom's. The source is required so the caller shares one with
 * the reconciler, which re-renders through its subscriptions; `undefined`
 * resolves no manifest, and every `PolicyOf` label stays sealed. Service DIDs
 * are NOT threaded to the worker today (design §9), so `serviceDids` is `[]`
 * and service principals — which rarely render — fail closed. Returns
 * undefined when no ceiling is configured (no render gating — today's
 * behavior).
 */
export function renderConfidentialityResolverFor(
  runtime: Runtime,
  identity: Identity,
  ceiling: RenderConfidentialityCeiling | undefined,
  sessionSpace: string | undefined,
  membershipProvider: SpaceMembershipProvider | undefined,
  modulePolicySource: CfcModulePolicySource | undefined,
): RenderConfidentialityResolver | undefined {
  if (ceiling === undefined) {
    return undefined;
  }
  const actingPrincipal = runtime.trustSnapshotProvider()?.actingPrincipal ??
    identity.did();
  // `session.open` authorizes the key holder, so the workspace it gated on is
  // a member for that principal's own renders. A host that names somebody else
  // as acting has shown nothing about what that principal reads.
  const memberSpaces = actingPrincipal === identity.did() &&
      sessionSpace !== undefined
    ? [sessionSpace]
    : [];
  return createRenderConfidentialityResolver({
    actingPrincipal,
    trustConfig: runtime.cfcTrustConfig,
    memberSpaces,
    // Share the reconciler's provider instance when supplied (so ACL
    // subscriptions and the resolver's reads observe the same cells); else
    // build a private one — both read the same underlying runtime documents.
    membershipProvider: membershipProvider ??
      createRuntimeSpaceMembershipProvider(runtime, actingPrincipal),
    // A `PolicyOf` label's module rules run at the display boundary too,
    // resolved through the runtime's verified manifest read; a manifest that
    // is missing or fails verification leaves the label sealed. The source is
    // the reconciler's, so the manifests it watches and the ones this
    // resolves are one cache.
    modulePolicyResolver: modulePolicySource?.resolve,
  });
}

/**
 * The §4.9.3 membership provider for a worker's renders — the reactive half of
 * the render lookup. Built once per worker (same lifetime as the resolver) and
 * threaded to BOTH `renderConfidentialityResolverFor` (as the resolver's
 * lookup) and the reconciler (for ACL-change subscriptions), so the two share
 * one instance. Undefined when no ceiling is configured — no render gating, so
 * no membership lookup. Service DIDs are not threaded to the worker
 * (design §9), so service principals fail closed.
 */
export function renderMembershipProviderFor(
  runtime: Runtime,
  identity: Identity,
  ceiling: RenderConfidentialityCeiling | undefined,
): SpaceMembershipProvider | undefined {
  if (ceiling === undefined) {
    return undefined;
  }
  const actingPrincipal = runtime.trustSnapshotProvider()?.actingPrincipal ??
    identity.did();
  return createRuntimeSpaceMembershipProvider(runtime, actingPrincipal);
}

/**
 * The module-policy manifest source for a worker's renders, shared like
 * {@link renderMembershipProviderFor}'s provider: the resolver reads verified
 * manifests through it, and the reconciler subscribes to a manifest a sealed
 * `PolicyOf` cell is still waiting on. Undefined when no ceiling is
 * configured.
 */
export function renderModulePolicySourceFor(
  runtime: Runtime,
  ceiling: RenderConfidentialityCeiling | undefined,
): CfcModulePolicySource | undefined {
  if (ceiling === undefined) {
    return undefined;
  }
  return createRuntimeCfcModulePolicySource(runtime);
}

/**
 * Formats a cell link for display in console output.
 * Returns a string like "[Cell: of:fid1:abc.../path/to/prop]"
 */
function formatCellLink(cell: Cell<unknown>): string {
  try {
    const link: SigilLink = cell.getAsLink();
    const inner = linkRefPayload(link);
    const pathStr = inner.path?.length ? `/${inner.path.join("/")}` : "";
    return `[Cell: ${inner.id ?? "?"}${pathStr}]`;
  } catch {
    return "[Cell]";
  }
}

/**
 * Produces the replacer that `toConsoleDebugValue()` converts through. It
 * renders the values the conversion cannot render on its own: a cell by the
 * link it holds, and a query-result proxy by that link together with the data
 * behind it.
 *
 * The result is stateful -- it holds what it built for each proxy -- so it
 * serves a single conversion.
 */
function newConsoleDebugReplacer(): (value: any) => any {
  const proxyValues = new Map<object, unknown>();

  return (value: any) => {
    if (isCell(value)) {
      return formatCellLink(value);
    }

    // `isCellResult()` reads a symbol-keyed property, which a hostile proxy's
    // `get` trap throws from. A throw here counts as declining to replace, and
    // the value goes on to be rendered as whatever it appears to be.
    if (!isCellResult(value)) {
      return value;
    }

    const already = proxyValues.get(value);
    if (already !== undefined) {
      // The same proxy converts to the same object every time, so that the
      // conversion's own identity-keyed cycle detection sees a repeat as one.
      return already;
    }

    const result: Record<string, unknown> = {
      __ref: formatCellLink(getCellOrThrow(value)),
    };

    // The properties are exposed rather than copied, so that the conversion
    // reads each one under its own guard: a proxy that throws on one key
    // still reports the rest, and `__ref` along with them.
    for (const key of Object.keys(value)) {
      Object.defineProperty(result, key, {
        enumerable: true,
        get: () => value[key],
      });
    }

    // Held only once complete, so that a proxy which throws before its keys
    // can be listed is rendered the same way everywhere it appears rather
    // than leaving a half-built object behind for its later positions. The
    // conversion descends after this returns, so a cycle still finds it.
    proxyValues.set(value, result);

    return result;
  };
}

/**
 * Converts one of a pattern's `console.*` arguments into the value that crosses
 * to the main thread. A string crosses as whole as the conversion allows:
 * what a pattern logs is often a stack, a fetched body, or a model's output,
 * whose tail is the point.
 *
 * Exported for testing.
 */
export function toConsoleDebugValue(value: unknown): FabricValue {
  return toStructuredDebugValue(value, {
    maxDepth: MAX_CONSOLE_DEBUG_DEPTH,
    maxProperties: Infinity,
    maxStringLines: Infinity,
    replacer: newConsoleDebugReplacer(),
  });
}

export const hasExplicitSubscriptionSchema = (schema: unknown): boolean =>
  schema === true ||
  (schema !== undefined && schema !== false &&
    isObjectOrArray(schema) &&
    Object.keys(schema).length > 0);

/** Connects render boundaries to authoritative access verdict changes. */
export function renderSpaceAccessProviderFor(
  runtime: Pick<Runtime, "storageManager">,
): SpaceAccessProvider {
  const storage = runtime.storageManager;
  return {
    error: (space) => storage.spaceAccessError?.(space as MemorySpace),
    subscribe: (space, onChange) => {
      const changed = (changedSpace: MemorySpace) => {
        if (changedSpace === space) onChange();
      };
      return storage.subscribeSpaceAccessChange?.(changed) ??
        storage.subscribeSpaceAccessLoss?.(changed) ?? (() => {});
    },
  };
}

/**
 * Where a mount's render errors go: the client that mounted it, and no other.
 *
 * A render error belongs to the document showing the tree rather than to
 * whichever client happens to own the worker, and a reconciler reports one
 * from deep inside a render. Named here so that rule is one a test can state,
 * the render failures that raise it being reachable only through a pattern.
 */
export function mountErrorSink(
  client: WorkerClient,
  gate: HostReadGate,
): (error: Error) => void {
  return (error) => {
    client.post(gate.error(runtimeErrorReport(error)));
  };
}

/**
 * The security posture a worker's runtime runs under, read off the payload it
 * was initialized from. The backend and the per-space host map are normalized
 * here, so an attach that spells the same backend another way agrees. The
 * render policy and the render ceiling are recorded as the payload spelled
 * them, while the processor applies a normalized form of each, so two
 * spellings of one render posture refuse each other.
 *
 * Every field the context declares is named, held by the `satisfies` clause.
 * What is recorded here is what an attach is compared against, so a field this
 * one drops is a value the runtime applies and no client can assert.
 */
export function securityContextFrom(
  data: InitializationData,
  identity: DID,
): RuntimeSecurityContext {
  return {
    identity,
    apiUrl: normalizeOrigin(data.apiUrl),
    spaceHostMap: normalizeSpaceHostMap(data.spaceHostMap),
    spaceDid: data.spaceDid,
    experimental: data.experimental,
    cfcEnforcementMode: data.cfcEnforcementMode,
    cfcFlowLabels: data.cfcFlowLabels,
    cfcReadMaxConfidentiality: data.cfcReadMaxConfidentiality,
    cfcReadOnExceed: data.cfcReadOnExceed,
    cfcTrustConfig: data.cfcTrustConfig,
    renderDeclassificationPolicy: data.renderDeclassificationPolicy,
    renderConfidentialityCeiling: data.renderConfidentialityCeiling,
    trustSnapshot: data.trustSnapshot,
  } satisfies EveryFieldOf<RuntimeSecurityContext>;
}

/**
 * The message reporting a host that did not answer the boot-time health
 * check. The check gives one verdict over the backend and every space host,
 * so the message names them all where there is more than one. Hosts are
 * compared as the check compares them, as parsed URLs; one that does not
 * parse is named as written, since that is what failed the check.
 */
function unreachableHostMessage(data: InitializationData): string {
  const asChecked = (host: string) => {
    try {
      return new URL(host).toString();
    } catch {
      return host;
    }
  };
  const backend = asChecked(data.apiUrl);
  const spaceHosts = new Set<string>();
  for (const host of Object.values(data.spaceHostMap ?? {})) {
    const checked = asChecked(host);
    if (checked !== backend) spaceHosts.add(checked);
  }
  const quoted = [...spaceHosts].map((host) => `"${host}"`).join(", ");
  return `Could not connect to "${data.apiUrl}"` +
    (spaceHosts.size > 0 ? ` or to a space host (${quoted})` : "");
}

/** Builds the refusal for a detached client's or a disposed runtime's seal. */
const custodySealingUnavailable = () =>
  new Error("Custody sealing is unavailable");

/** A prepared custody seal, held in the backend until its host confirms. */
type PendingCustodySeal = {
  consent: CustodySealConsent;
};

type RuntimeOperationTarget = {
  capability: IOperationStorageCapability;

  /**
   * The collaborative field the operations read and change: the cell the
   * host named, resolved through its links when the target was made, and
   * held for a session's life. Every answer is decided on this cell, and an
   * operation is addressed by the cell decided on
   * ({@link operationFieldAddress}).
   */
  field: Cell<unknown>;
};

/** Where the collaborative field `field` is, as the storage addresses it. */
function operationFieldAddress(field: Cell<unknown>): OperationFieldAddress {
  const link = field.getAsNormalizedFullLink();
  return { id: link.id, scope: link.scope, path: toValuePath(link.path) };
}

/**
 * One client's membership in one presence room, keyed by the subscription
 * id the client chose. `membership` is absent while the join is in flight,
 * and `ended` records a leave or a client departure that arrived before it
 * settled, so the membership is left as soon as it exists.
 */
type RuntimePresenceMembership = {
  client: WorkerClient;
  membership: PresenceMembership | undefined;
  ended: boolean;
};

/** Reduces a room event to what crosses the worker boundary. */
const toPresenceWireEvent = (event: PresenceEvent): PresenceWireEvent =>
  event.kind === "failure"
    ? {
      kind: "failure",
      error: { name: event.error.name, message: event.error.message },
    }
    : event;

type RuntimeOperationSession = {
  cellKey: string;
  target: RuntimeOperationTarget;
  subscriptions: Set<string>;

  /**
   * The client that opened this session. A session id is a UUID its client
   * minted, which keeps two clients from colliding but does not stop one
   * naming another's -- so who may close it is recorded rather than assumed.
   */
  clientId: ClientId;
};

/** The render policy a processor is built with, as the host configures it. */
type RenderPolicyConfiguration = Pick<
  InitializationData,
  "renderDeclassificationPolicy" | "renderConfidentialityCeiling"
>;

/**
 * `answer`, as the answer to a request of type `type`. Each of the
 * dispatcher's cases answers through this, so that a case whose answer is
 * not of the type its own request's answer is, such as an answer the
 * host-read gate did not build where the request's answer carries its mark,
 * fails to type-check, rather than passing as some other request's answer.
 */
function answering<K extends RequestType>(
  _type: K,
  answer: AnswerTo<K> | Promise<AnswerTo<K>>,
): AnswerTo<K> | Promise<AnswerTo<K>> {
  return answer;
}

/**
 * The answer to a request of type `K`, as a handler gives it: a request whose
 * answer is empty is answered by a handler that returns nothing.
 */
type AnswerTo<K extends RequestType> = [CommandResponse<K>] extends [undefined]
  ? CommandResponse<K> | void
  : CommandResponse<K>;

/**
 * The worker side of a runtime client connection. An instance owns the
 * worker's `Runtime`, keeps a `PiecesController` for the home space and for
 * each other space a request has named, and serves every client attached to
 * the worker: `handleRequest()` routes a client's request to the handler for
 * its type, and what the runtime produces on its own (console output, errors,
 * navigation, subscription updates) reaches the client through
 * `postToClient()`. Subscriptions, operation sessions, and VDOM mounts are
 * keyed by the client that opened them, so one client's departure takes down
 * only its own. The security context is fixed at `initialize()` and is the
 * one every attached client is held to. `dispose()` cancels what is
 * outstanding and disposes the runtime, once, however many times it is
 * called.
 */
export class RuntimeProcessor {
  #runtime: Runtime;
  #cc: PiecesController;
  #spaces = new Map<DID, PiecesController>();
  // The boot-time health check's verdict, and whether `initialize()` waited
  // for it before returning. A processor built without `initialize()` made
  // no check and reads as healthy.
  #health: Promise<boolean> = Promise.resolve(true);
  #awaitedHealth = false;
  #identity: Identity;
  #legacySpacesAdopted: Promise<void> | undefined;
  #isDisposed = false;
  #disposingPromise: Promise<void> | undefined;

  /**
   * Cell subscriptions, by the subscribing client's scoped cell key. Two
   * clients watching one cell are two subscriptions, so that one client's
   * unsubscribe stops its own feed and no one else's.
   */
  #subscriptions = new Map<string, Cancel>();

  #operationSubscriptions = new Map<
    string,
    {
      cancel?: Cancel;
      cancelled: boolean;
      sessionKey?: string;
      client: WorkerClient;
    }
  >();
  #operationSessions = new Map<string, RuntimeOperationSession>();
  #presenceMemberships = new Map<string, RuntimePresenceMembership>();
  #pieceSourceConfirmations = new Map<
    string,
    { token: string; prepared: PreparedPieceSourceChange }
  >();
  #snapshotShares = new Map<string, SnapshotShareConsent>();
  #custodySeals = new Map<string, PendingCustodySeal>();
  /** One abort per commit in flight, aborted when its client detaches. */
  #custodySealCommits = new Map<string, AbortController>();
  #detachedClients = new WeakSet<WorkerClient>();
  #telemetry: RuntimeTelemetry;

  /**
   * Whom this runtime acts as and under which enforcement configuration, fixed
   * by the client that initialized it. A runtime carries exactly one, and every
   * client attached to it is checked against this one.
   */
  readonly #securityContext: RuntimeSecurityContext;

  #telemetryEnabled = false;
  #intentOutcomeCancel: Cancel | undefined;
  #profilePreloadCancel: Cancel | undefined;

  /**
   * VDOM mounts, by the mounting client's scoped mount id. A mount id comes
   * from a counter that starts at 1 in each client's own document, so the id
   * alone names a mount only while there is one client.
   */
  #vdomMounts = new Map<
    string,
    { reconciler: WorkerReconciler; cancel: Cancel; client: WorkerClient }
  >();

  #vdomBatchIdCounter = 0;

  /**
   * Render-boundary declassification policy applied to every mount's
   * reconciler, from the initialization data; `allow` when it names none.
   */
  #renderDeclassificationPolicy: RenderDeclassificationPolicy = "allow";

  /**
   * Host-supplied default render ceiling applied to every mount's reconciler;
   * `undefined` when the host set none.
   */
  #renderConfidentialityCeiling?: RenderConfidentialityCeiling;

  /**
   * Runner-side display-boundary resolver, built once from the runtime's trust
   * config and acting principal when a ceiling is in force. Rewrites a cell's
   * label through the exchange rules so `Space(...)`-via-`HasRole` principal
   * forms resolve before the reconciler's ceiling fit.
   */
  #renderConfidentialityResolver?: RenderConfidentialityResolver;

  /**
   * The membership provider shared with the resolver above and handed to every
   * mount's reconciler, so a `Space(X)`-labeled cell blocked before X's ACL
   * synced re-renders once the ACL grants READ (§4.9.3). `undefined` when no
   * ceiling is in force.
   */
  #renderMembershipProvider?: SpaceMembershipProvider;

  /**
   * The module-policy manifest source shared with the resolver above and
   * handed to every mount's reconciler, so a `PolicyOf` cell blocked before
   * its manifest synced re-renders once it arrives. `undefined` when no
   * ceiling is in force.
   */
  #renderModulePolicySource?: CfcModulePolicySource;

  /**
   * What builds every answer to a host's read of a cell, deciding it under
   * the ceiling every mount's root renders with, with the resolver and the
   * providers every mount is given. Built by the constructor from the render
   * policy it is given, so no answer is ever built by a gate that has not
   * been, and rebuilt whenever the render policy is configured; with no
   * ceiling it returns every read as read, as a root with none renders
   * everything.
   */
  #hostReadGate: HostReadGate;

  /** The session's workspace, which the exchange rules resolve against. */
  readonly #workspace: DID;
  #cancelSpaceAccessLoss?: Cancel;

  private constructor(
    runtime: Runtime,
    cc: PiecesController,
    initSpace: DID,
    identity: Identity,
    telemetry: RuntimeTelemetry,
    securityContext: RuntimeSecurityContext,
    renderPolicy: RenderPolicyConfiguration,
    clients: () => Iterable<WorkerClient> = () => [ownerClient],
  ) {
    this.#runtime = runtime;
    this.#cc = cc;
    this.#workspace = initSpace;
    this.#spaces.set(initSpace, cc);
    this.#identity = identity;
    this.#hostReadGate = this.#configureRenderPolicy(renderPolicy);
    this.#telemetry = telemetry;
    this.#telemetry.addEventListener("telemetry", this.#onTelemetry);
    this.#securityContext = securityContext;
    this.#cancelSpaceAccessLoss = runtime.storageManager
      ?.subscribeSpaceAccessLoss?.((space) => {
        for (const client of clients()) {
          client.post({ type: NotificationType.SpaceAccessLost, space });
        }
      });
  }

  /**
   * The runtime and home context this processor was built over, the tables
   * it keeps by space, by client, and by session, the disposed flag, the
   * render policy and ceiling a mount inherits, the boot-time health check's
   * verdict and whether `initialize()` waited for it, and the per-space
   * context step, which a test drives directly.
   */
  get accessForTestingOnly(): {
    runtime: Runtime;
    readonly cc: PiecesController;
    readonly spaces: Map<DID, PiecesController>;
    subscriptions: Map<string, Cancel>;
    operationSubscriptions: Map<
      string,
      {
        cancel?: Cancel;
        cancelled: boolean;
        sessionKey?: string;
        client: WorkerClient;
      }
    >;
    operationSessions: Map<string, RuntimeOperationSession>;
    pieceSourceConfirmations: Map<
      string,
      { token: string; prepared: PreparedPieceSourceChange }
    >;
    isDisposed: boolean;
    vdomMounts: Map<
      string,
      { reconciler: WorkerReconciler; cancel: Cancel; client: WorkerClient }
    >;
    renderConfidentialityCeiling: RenderConfidentialityCeiling | undefined;
    readonly renderDeclassificationPolicy: RenderDeclassificationPolicy;
    readonly health: Promise<boolean>;
    readonly awaitedHealth: boolean;
    getSpaceCtx(space: DID): PiecesController;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get runtime() {
        return outerThis.#runtime;
      },
      set runtime(value) {
        outerThis.#runtime = value;
      },
      get health() {
        return outerThis.#health;
      },
      get awaitedHealth() {
        return outerThis.#awaitedHealth;
      },
      cc: this.#cc,
      spaces: this.#spaces,
      get subscriptions() {
        return outerThis.#subscriptions;
      },
      set subscriptions(value) {
        outerThis.#subscriptions = value;
      },
      get operationSubscriptions() {
        return outerThis.#operationSubscriptions;
      },
      set operationSubscriptions(value) {
        outerThis.#operationSubscriptions = value;
      },
      get operationSessions() {
        return outerThis.#operationSessions;
      },
      set operationSessions(value) {
        outerThis.#operationSessions = value;
      },
      get pieceSourceConfirmations() {
        return outerThis.#pieceSourceConfirmations;
      },
      set pieceSourceConfirmations(value) {
        outerThis.#pieceSourceConfirmations = value;
      },
      get isDisposed() {
        return outerThis.#isDisposed;
      },
      set isDisposed(value) {
        outerThis.#isDisposed = value;
      },
      get vdomMounts() {
        return outerThis.#vdomMounts;
      },
      set vdomMounts(value) {
        outerThis.#vdomMounts = value;
      },
      get renderConfidentialityCeiling() {
        return outerThis.#renderConfidentialityCeiling;
      },
      set renderConfidentialityCeiling(value) {
        outerThis.#configureRenderPolicy({
          renderDeclassificationPolicy: outerThis.#renderDeclassificationPolicy,
          renderConfidentialityCeiling: value,
        });
      },
      get renderDeclassificationPolicy() {
        return outerThis.#renderDeclassificationPolicy;
      },
      getSpaceCtx: (space) => this.#getSpaceCtx(space),
    };
  }

  #siteTableCancel: Cancel | undefined;
  #siteTableWarned = new Set<string>();

  /**
   * Subscribes to the home-space site table and registers the last entry for
   * each space that contains only an HTTP or HTTPS origin. Fire-and-forget:
   * resolution hints are an enhancement, never a boot dependency.
   *
   * One entry is read rather than registered. A loopback origin names the
   * toolshed as the machine that wrote the row sees it, so it is no route for a
   * page that reached the toolshed by another name — and a browser refuses the
   * `ws://` socket it implies from an `https` page. When the entry is loopback
   * and this runtime's `apiUrl` is not, the space stays on `apiUrl`, and the
   * row retires any earlier row for that space. A page that did reach loopback
   * registers it as usual.
   *
   * ORDERING CONTRACT for embedders: push a newly learned hint through the
   * RegisterSpaceHost IPC before relying on that space, and proceed only when
   * registration succeeds. The first hint can replace a provisional
   * default-host provider that has not issued a write. A route already accepted
   * from the table remains fixed and rejects a conflicting IPC hint. The table
   * is the durable record.
   */
  watchSiteTable(): void {
    try {
      const userDid = this.#runtime.userIdentityDID;
      const table = this.#runtime.getCell(
        userDid,
        siteTableCause(userDid),
        siteTableSchema,
      );
      Promise.resolve(table.sync()).then(() => {
        // dispose() may have run while sync was in flight — installing
        // the sink then would leak a live subscription past disposal.
        if (this.#isDisposed) return;
        this.#siteTableCancel = table.sink(
          (entries: Readonly<SiteTable> | undefined) => {
            const latestEntries = new Map<
              string,
              { did: DID; host: string }
            >();
            for (const entry of entries ?? []) {
              if (
                !isDID(entry?.did) ||
                typeof entry.host !== "string" ||
                entry.host.length === 0
              ) {
                continue;
              }
              let host: URL;
              try {
                host = normalizeSpaceHost(entry.host);
              } catch (error) {
                if (!(error instanceof SpaceHostValidationError)) throw error;
                console.warn(
                  `[RuntimeProcessor] Ignoring invalid site-table entry for ${entry.did}:`,
                  error.message,
                );
                continue;
              }
              // A loopback entry names the toolshed from the machine that
              // wrote it, so a page served from anywhere else cannot reach it
              // — and a browser on an https page refuses the ws:// socket it
              // implies. Leave those spaces on the URL this runtime already
              // reached its toolshed at.
              if (
                isLoopbackHostname(host.hostname) &&
                !isLoopbackHostname(this.#runtime.apiUrl.hostname)
              ) {
                const key = `${entry.did}|${host.toString()}`;
                if (!this.#siteTableWarned.has(key)) {
                  this.#siteTableWarned.add(key);
                  console.debug(
                    `[RuntimeProcessor] Ignoring loopback site-table entry for ${entry.did} ` +
                      `(${host.toString()}); using ${this.#runtime.apiUrl.toString()}`,
                  );
                }
                // The table is last-row-wins, so this row also retires an
                // earlier non-loopback row for the same space: the space has
                // since moved to the writer's own toolshed.
                latestEntries.delete(entry.did);
                continue;
              }
              latestEntries.set(entry.did, {
                did: entry.did as DID,
                host: host.toString(),
              });
            }
            for (const entry of latestEntries.values()) {
              try {
                const accepted = this.#runtime.registerSpaceHost(
                  entry.did,
                  entry.host,
                );
                // Warn once per rejected fact. A seeded route or an earlier
                // accepted hint can fix a different host.
                if (!accepted) {
                  const key = `${entry.did}|${entry.host}`;
                  const effective = this.#runtime.hostForSpace(
                    entry.did,
                  ).toString();
                  if (
                    effective !== new URL(entry.host).toString() &&
                    !this.#siteTableWarned.has(key)
                  ) {
                    this.#siteTableWarned.add(key);
                    console.warn(
                      `[RuntimeProcessor] Site-table hint for ${entry.did} not in effect ` +
                        `(explicit space route already fixed); using ${effective}`,
                    );
                  }
                }
              } catch (error) {
                console.warn(
                  `[RuntimeProcessor] Ignoring invalid site-table entry for ${entry.did}:`,
                  error instanceof Error ? error.message : error,
                );
              }
            }
          },
        );
      }).catch((error: unknown) => {
        console.warn(
          "[RuntimeProcessor] Site table unavailable (continuing without hints):",
          error instanceof Error ? error.message : error,
        );
      });
    } catch (error) {
      console.warn(
        "[RuntimeProcessor] Site table watch failed to start:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * The PiecesController already serving a space, if any. Used by the
   * piece-created callback to register a piece in its own space's
   * list; deliberately does NOT create a context (a piece can only be
   * created by a pattern some existing context started).
   */
  piecesFor(space: DID): PiecesController | undefined {
    return this.#spaces.get(space);
  }

  dispose(): Promise<void> {
    if (this.#disposingPromise) return this.#disposingPromise;
    this.#isDisposed = true;
    this.#disposingPromise = (async () => {
      this.#telemetry.removeEventListener("telemetry", this.#onTelemetry);
      try {
        this.#intentOutcomeCancel?.();
        this.#cancelSpaceAccessLoss?.();
        this.#cancelSpaceAccessLoss = undefined;
        this.#intentOutcomeCancel = undefined;
        this.#profilePreloadCancel?.();
        this.#profilePreloadCancel = undefined;
        this.#siteTableCancel?.();
        this.#siteTableCancel = undefined;
        for (const cancel of this.#subscriptions.values()) {
          cancel();
        }
        this.#subscriptions.clear();
        for (const subscription of this.#operationSubscriptions.values()) {
          subscription.cancelled = true;
          subscription.cancel?.();
        }
        this.#operationSubscriptions.clear();
        this.#operationSessions.clear();
        this.#pieceSourceConfirmations.clear();
        this.#snapshotShares.clear();
        this.#custodySeals.clear();
        for (const commit of this.#custodySealCommits.values()) {
          commit.abort(custodySealingUnavailable());
        }

        // Clean up VDOM mounts
        for (const { reconciler, cancel } of this.#vdomMounts.values()) {
          cancel();
          reconciler.unmount();
        }
        this.#vdomMounts.clear();

        await this.#runtime.storageManager.synced();
        await this.#runtime.dispose();
      } catch (e) {
        console.error(`Failure during WorkerRuntime disposal: ${e}`);
      }
    })();
    return this.#disposingPromise;
  }

  isDisposed(): boolean {
    return this.#isDisposed;
  }

  /**
   * Refuses an attach whose asserted security context is not this runtime's.
   *
   * One runtime is one signer under one enforcement configuration, so every
   * document attached to it acts as the same principal with the same posture.
   * A client asserting anything else is asking for a runtime this is not, and
   * the two contexts are never merged: a merge would leave each document
   * believing a posture the runtime does not hold. The refusal is the honest
   * answer, and a second runtime is the remedy.
   *
   * @throws If any field of the asserted context differs from the running
   *   one's. The message names every field that differs.
   */
  assertAttachable(asserted: RuntimeSecurityContext): void {
    const differing = securityContextDifferences(
      asserted,
      this.#securityContext,
    );
    if (differing.length === 0) return;
    const named = differing.map((field) => backtickQuote(field)).join(", ");
    throw new Error(
      "Attach refused: the asserted security context differs from the " +
        `runtime's at ${named}.`,
    );
  }

  /**
   * Tears down everything one client owns, leaving the runtime and every other
   * client's work running. This is what a client's departure costs: its cell
   * and operation subscriptions stop, its presence memberships end, its VDOM
   * trees unmount, and nothing else moves.
   *
   * The runtime itself is never touched here, however the departing client
   * came to leave. Only {@link dispose} ends a runtime, and only the client
   * that stood it up asks for that.
   *
   * `pieceSourceConfirmations` is deliberately not swept. It holds a two-phase
   * confirmation for a PIECE, keyed by the piece rather than by a client, and
   * its token is a UUID handed to whoever prepared the change -- so a
   * departing client takes the only means of confirming its pending entry with
   * it, and what is left is a token nobody holds, replaced the next time
   * anyone prepares a change to that piece. Two clients preparing one piece's
   * change do collide there, the second prepare invalidating the first's
   * token; that is a refusal rather than a lost write, and it is the same
   * collision two tabs have today.
   */
  disposeClient(client: WorkerClient): void {
    const prefix = clientKeyPrefix(client);
    this.#detachedClients.add(client);
    for (const key of this.#snapshotShares.keys()) {
      if (key.startsWith(prefix)) this.#snapshotShares.delete(key);
    }
    for (const key of this.#custodySeals.keys()) {
      if (key.startsWith(prefix)) this.#custodySeals.delete(key);
    }
    for (const [key, commit] of this.#custodySealCommits) {
      if (key.startsWith(prefix)) commit.abort(custodySealingUnavailable());
    }

    for (const [key, cancel] of [...this.#subscriptions]) {
      if (!key.startsWith(prefix)) continue;
      cancel();
      this.#subscriptions.delete(key);
    }

    for (
      const [subscriptionId, subscription] of [
        ...this.#operationSubscriptions,
      ]
    ) {
      if (subscription.client.id !== client.id) continue;
      this.handleOperationUnsubscribe({
        type: RequestType.OperationUnsubscribe,
        subscriptionId,
      }, client);
    }

    for (const [key, mount] of [...this.#vdomMounts]) {
      if (!key.startsWith(prefix)) continue;
      mount.cancel();
      mount.reconciler.unmount();
      this.#vdomMounts.delete(key);
    }

    for (const [sessionId, session] of [...this.#operationSessions]) {
      if (session.clientId !== client.id) continue;
      this.#operationSessions.delete(sessionId);
    }

    for (const [subscriptionId, membership] of [...this.#presenceMemberships]) {
      if (membership.client.id !== client.id) continue;
      void this.#endPresenceMembership(subscriptionId);
    }
  }

  #hostSelectedCell(ref: CellRef): Cell<unknown> {
    // The host selects an address; stored policy owns its schema and label.
    return getCell(this.#runtime, {
      space: ref.space,
      id: ref.id,
      path: ref.path,
      scope: ref.scope,
    });
  }

  /**
   * Resolve the piece context for a space. The space the worker was
   * initialized with gets the context built at initialize; any other
   * space lazily gets its own PiecesController, sharing
   * this worker's runtime/scheduler/storage (the storage layer is
   * already multi-space). The per-space session authenticates as the
   * user — no per-space signer, matching the storage connections.
   *
   * `space` is required: piece operations carry their space explicitly,
   * with no implicit default at this layer. A request arrives as data, so
   * its `space` can be missing despite the type. This method throws when it
   * is.
   */
  #getSpaceCtx(space: DID): PiecesController {
    const target: DID | undefined = space;
    if (!target) {
      throw new Error("Piece operations must name a space explicitly.");
    }
    let ctx = this.#spaces.get(target);
    if (!ctx) {
      const created = new PiecesController(
        { as: this.#identity, space: target },
        this.#runtime,
      );
      ctx = created;
      this.#spaces.set(target, ctx);
      // The constructor kicks the space-cell sync into `ready` without
      // awaiting it. Observe the failure and evict, so a transient
      // error (unreachable host, bad space) doesn't poison this space
      // for the worker's lifetime — the next request rebuilds the
      // context — and doesn't surface as an unhandled rejection.
      created.ready.catch((error: unknown) => {
        if (this.#spaces.get(target) === created) {
          this.#spaces.delete(target);
        }
        console.error(
          `[RuntimeProcessor] Space context for ${target} failed to sync:`,
          error instanceof Error ? error.message : error,
        );
      });
    }
    return ctx;
  }

  handleCellGet(
    request: CellGetRequest,
  ): CellGetResponse {
    // `MetaField` does not include `cfc`. A request arrives as data, though,
    // and checking its fields is this handler's job. As a result, `meta` can
    // be `cfc`. The branch below passes any `meta` that is not a link field to
    // `getMetaRaw()`. `getMetaRaw()` reads whichever document-root field it is
    // given. The `cfc` field holds the raw label metadata, `Caveat.source`
    // included. So we refuse the request here. A label for display comes from
    // `includeCfcLabel` on a `CellGet` request or from a `CellGetCfcLabel`
    // request. Both return the label with `Caveat.source` removed.
    if ((request.meta as string | undefined) === "cfc") {
      throw new Error(
        'A `CellGet` request with `meta: "cfc"` is not served; ' +
          "use `CellHandle.getCfcLabel()` for the redacted display view",
      );
    }
    const gate = this.#hostReadGate;
    let cell = getCell(this.#runtime, request.cell);
    if (request.meta !== undefined) {
      const rootCell = getCell(this.#runtime, { ...request.cell, path: [] });
      if (request.meta !== "argument" && request.meta !== "result") {
        // A metadata field that is not a link returns the raw data.
        return gate.readMetadata(rootCell, request.meta);
      }
      // A metadata link field reads the cell it links to, once its document
      // admits the read.
      const refusal = gate.metadataRefusal(rootCell);
      if (refusal !== undefined) return refusal;
      const link = getMetaLink(rootCell, request.meta);
      if (link === undefined) return gate.nothing();
      cell = this.#runtime.getCellFromLink({
        ...link,
        path: [...link.path, ...request.cell.path],
      });
    }
    // The sigil links inside the answer carry each cell's `cfcLabelView` in
    // its display form, the same redaction the top-level `cfcLabel` gets.
    // Display-only: the worker neither persists nor re-imports inbound views,
    // so a redacted copy cannot round-trip into under-labeled state. The
    // conversion preserves a `FabricPrimitive` by identity, and the
    // envelope's encoding carries one to the main thread with its class. The
    // read cell's own ref, when asked for, addresses for a metadata link read
    // the linked cell itself, so the caller can subscribe to it or consult
    // its schema's declarations.
    return gate.read(cell, {
      includeRef: request.includeRef,
      includeCfcLabel: request.includeCfcLabel,
    });
  }

  async handleCellPull(
    request: CellPullRequest,
  ): Promise<CellGetResponse> {
    const cell = getCell(this.#runtime, request.cell);
    await cell.pull();
    // The durable pull crosses the commit-aware fixpoint so subsequent
    // operations observe all work causally demanded here. Rendering can read
    // reactive state while the host continues to report unconfirmed writes,
    // once there is a value to read. A cell holding none may be waiting on the
    // very write that creates it, so that pull crosses the barrier too.
    if (request.awaitDurability !== false || holdsNoValue(cell)) {
      await this.#runtime.scheduler.idleWithPendingCommits();
    }
    return await this.#settledGet({
      type: RequestType.CellGet,
      cell: request.cell,
    });
  }

  /**
   * {@link handleCellGet}, made once more where its answer was a refusal
   * made before the access lists it consulted had loaded, once they have
   * (`HostReadGate.settle()`). A one-shot read has no watch to make it again,
   * and the refusal would otherwise stand on the host's handle.
   */
  async #settledGet(request: CellGetRequest): Promise<CellGetResponse> {
    const answer = this.handleCellGet(request);
    if (answer.refused === undefined) return answer;
    const settled = await this.#hostReadGate.settle(
      getCell(this.#runtime, request.cell),
    );
    return settled ? this.handleCellGet(request) : answer;
  }

  /** Atomically stores a default only while the target has no backing value. */
  async handleCellInitialize(
    request: CellInitializeRequest,
  ): Promise<CellValueResponse> {
    if (request.value === undefined) {
      throw new TypeError("Cell initialize requires a defined value.");
    }
    const initial = mapCellRefsToSigilLinks(request.value);
    let stored: CellValueResponse | undefined;
    const result = await this.#runtime.editWithRetry((tx) => {
      const cell = getCell(this.#runtime, request.cell).withTx(tx);
      // Initialization materializes the same backing value a whole-cell write
      // targets. A schema default is a readable fallback, not proof that the
      // cell has been stored, and a write redirect is an address rather than
      // backing data. Treating either as an existing value leaves a later
      // child write with no durable parent and can replace the visible default.
      // Follow a final write redirect only for this existence check, while
      // retaining the view schema because its scope cap controls whether that
      // redirect is reachable. When storage already won, the host is sent
      // the value this transaction found, read as every host read is, and
      // read here, before the transaction ends, so that a write landing after
      // it commits is not mistaken for what it selected. The transaction
      // wrote nothing, so a read of the runtime's state sees what it saw.
      const backing = cell.getRaw({
        lastNode: "writeRedirect",
      });
      if (backing !== undefined) {
        if (cell.get() === undefined) {
          throw new TypeError(
            "Cell backing value is incompatible with its schema.",
          );
        }
        stored = this.#hostReadGate.read(getCell(this.#runtime, request.cell));
        return undefined;
      }
      stored = undefined;
      cell.set(initial);
      return hostValueOf(initial);
    });
    if (result.error) throw new Error(result.error.message);
    return stored ?? this.#hostReadGate.sentByHost(result.ok);
  }

  /**
   * Handles a `CellSetRequest`. A `CellHandle.set()` is a blind leaf overwrite
   * (last-write-wins); `CellHandle.push()` sends only appended members and
   * uses `Cell.push()`'s native mergeable operation. The decision is made by
   * _method_, never by inspecting the value's shape.
   */
  handleCellSet(request: CellSetRequest): void | Promise<void> {
    const commit = this.applyCellSet(request);
    if (request.awaitCommit) return this.#requireCellCommit(commit);
    void commit.catch((error) => {
      console.error(
        "[RuntimeProcessor] Cell set commit failed:",
        error,
      );
    });
  }

  handleCellPush(request: CellPushRequest): void | Promise<void> {
    const tx = this.#runtime.edit();
    // A frame ordinal distinguishes members within one append. The operation
    // cause distinguishes first members minted by independent client runtimes.
    const frame = pushFrame({
      cause: `runtime-client cell push ${crypto.randomUUID()}`,
      runtime: this.#runtime,
      tx,
      space: request.cell.space,
      generatedIdCounter: 0,
    });
    try {
      const cell = getCell(this.#runtime, request.cell) as Cell<FabricValue[]>;
      const values = request.values.map(mapCellRefsToSigilLinks);
      cell.withTx(tx).pushAll(values);
    } finally {
      popFrame(frame);
    }
    this.#runtime.prepareTxForCommit(tx);
    const commit = tx.commit();
    if (request.awaitCommit) return this.#requireCellCommit(commit);
    this.#observeCellCommit(commit, "push");
  }

  #operationSessionKey(cell: CellGetRequest["cell"]): string {
    return JSON.stringify([
      cell.space,
      cell.id,
      cell.scope ?? "space",
      cell.path,
    ]);
  }

  #operationTarget(
    cell: CellGetRequest["cell"],
    operationSessionId: string | undefined,
    client: WorkerClient,
  ) {
    if (
      operationSessionId !== undefined &&
      (operationSessionId.length === 0 || operationSessionId.length > 256)
    ) {
      throw new Error("operation session id is malformed");
    }
    const cellKey = this.#operationSessionKey(cell);
    const sessionKey = operationSessionId;
    const existing = sessionKey === undefined
      ? undefined
      : this.#operationSessions.get(sessionKey);
    if (existing !== undefined) {
      if (existing.cellKey !== cellKey) {
        throw new Error("operation session cannot change its source cell");
      }
      return { ...existing.target, sessionKey, session: existing };
    }
    const field = getCell(this.#runtime, cell).resolveAsCell();
    const provider = this.#runtime.storageManager.open(
      field.getAsNormalizedFullLink().space,
    );
    const capability = hasOperationStorageCapability(provider)
      ? provider
      : provider.replica;
    if (!hasOperationStorageCapability(capability)) {
      throw new Error(
        "runtime storage does not support collaborative operations",
      );
    }
    const target = { capability, field };
    if (sessionKey === undefined) {
      return { ...target, sessionKey: undefined, session: undefined };
    }
    const session = {
      cellKey,
      target,
      subscriptions: new Set<string>(),
      clientId: client.id,
    };
    this.#operationSessions.set(sessionKey, session);
    return { ...target, sessionKey, session };
  }

  /**
   * Joins a presence room for the client: the one derived from the cell's
   * resolved field, or the one the request names, under the cell's space.
   * The first snapshot is the request's response; every later event of the
   * membership reaches the client as a `presence:update`.
   */
  async handlePresenceJoin(
    request: PresenceJoinRequest,
    client: WorkerClient = ownerClient,
  ): Promise<PresenceJoinResponse> {
    if (this.#presenceMemberships.has(request.subscriptionId)) {
      throw new Error("presence membership id is already in use");
    }
    const link = getCell(this.#runtime, request.cell).resolveAsCell()
      .getAsNormalizedFullLink();
    const provider = this.#runtime.storageManager.open(link.space);
    const capability = hasPresenceStorageCapability(provider)
      ? provider
      : provider.replica;
    if (!hasPresenceStorageCapability(capability)) {
      throw new Error("runtime storage does not support presence");
    }
    const room = request.room ?? presenceRoomForField({
      space: link.space,
      branch: DEFAULT_BRANCH,
      id: link.id,
      scopeKey: resolveScopeKey(
        link.scope,
        this.#runtime.storageManager.scopeKeyIdentity(),
      ),
      path: toValuePath(link.path),
    });
    const state: RuntimePresenceMembership = {
      client,
      membership: undefined,
      ended: false,
    };
    this.#presenceMemberships.set(request.subscriptionId, state);
    let opening: Extract<PresenceEvent, { kind: "snapshot" }> | undefined;
    let membership: PresenceMembership;
    try {
      membership = await capability.joinPresenceRoom(room, (event) => {
        if (this.#presenceMemberships.get(request.subscriptionId) !== state) {
          return;
        }
        // The membership delivers its opening snapshot before it is handed
        // back, and that one is the join's response rather than an update.
        if (opening === undefined && event.kind === "snapshot") {
          opening = event;
          return;
        }
        queueMicrotask(() =>
          client.post({
            type: NotificationType.PresenceUpdate,
            subscriptionId: request.subscriptionId,
            event: toPresenceWireEvent(event),
          })
        );
      });
    } catch (error) {
      if (this.#presenceMemberships.get(request.subscriptionId) === state) {
        this.#presenceMemberships.delete(request.subscriptionId);
      }
      throw error;
    }
    state.membership = membership;
    if (state.ended || this.#isDisposed) {
      await membership.leave();
      throw new Error("presence membership ended while joining");
    }
    return {
      participantId: membership.participantId,
      room,
      participants: opening?.participants ?? [],
    };
  }

  /**
   * Replaces the client's record in the room. A publication outside the
   * relay's bounds throws before anything is sent.
   */
  handlePresencePublish(
    request: PresencePublishRequest,
    client: WorkerClient = ownerClient,
  ): BooleanResponse {
    const state = this.#presenceMemberships.get(request.subscriptionId);
    if (
      state === undefined || state.client.id !== client.id ||
      state.membership === undefined
    ) {
      return { value: false };
    }
    state.membership.publish({ name: request.name, facets: request.facets });
    return { value: true };
  }

  /** Ends the client's membership; a membership is its joiner's to end. */
  async handlePresenceLeave(
    request: PresenceLeaveRequest,
    client: WorkerClient = ownerClient,
  ): Promise<BooleanResponse> {
    const state = this.#presenceMemberships.get(request.subscriptionId);
    if (state === undefined || state.client.id !== client.id) {
      return { value: false };
    }
    await this.#endPresenceMembership(request.subscriptionId);
    return { value: true };
  }

  async #endPresenceMembership(subscriptionId: string): Promise<void> {
    const state = this.#presenceMemberships.get(subscriptionId);
    if (state === undefined) return;
    this.#presenceMemberships.delete(subscriptionId);
    state.ended = true;
    await state.membership?.leave();
  }

  async handleOperationCapabilities(
    request: OperationCapabilitiesRequest,
    client: WorkerClient = ownerClient,
  ): Promise<OperationCapabilitiesResponse> {
    const { capability } = this.#operationTarget(
      request.cell,
      request.operationSessionId,
      client,
    );
    return { codecs: [...await capability.operationCodecs()] };
  }

  async handleOperationQuery(
    request: OperationQueryRequest,
    client: WorkerClient = ownerClient,
  ): Promise<OperationFieldResponse> {
    const { capability, field } = this.#operationTarget(
      request.cell,
      request.operationSessionId,
      client,
    );
    return await this.#hostReadGate.fromCell(
      field,
      async (decided) => ({
        field: await capability.queryOperationField({
          ...operationFieldAddress(decided),
          ...(request.after === undefined ? {} : { after: request.after }),
        }),
      }),
      getCell(this.#runtime, request.cell),
    );
  }

  async handleOperationApply(
    request: OperationApplyRequest,
    client: WorkerClient = ownerClient,
  ): Promise<OperationApplyResponse> {
    const { capability, field } = this.#operationTarget(
      request.cell,
      request.operationSessionId,
      client,
    );
    // An operation on a field the host may not see is not applied: what it
    // was made from was not shown, and its resolution would show the field.
    return await this.#hostReadGate.fromCell(
      field,
      async (decided) => ({
        resolution: await capability.applyOperation({
          op: "apply-op",
          ...operationFieldAddress(decided),
          codec: request.codec,
          submissionId: request.submissionId,
          base: request.base,
          ...(request.baselineHash === undefined
            ? {}
            : { baselineHash: request.baselineHash }),
          payload: request.payload,
        }),
      }),
      getCell(this.#runtime, request.cell),
    );
  }

  async handleOperationSubscribe(
    request: OperationSubscribeRequest,
    client: WorkerClient = ownerClient,
  ): Promise<BooleanResponse> {
    if (this.#operationSubscriptions.has(request.subscriptionId)) {
      return { value: false };
    }
    const { capability, field, sessionKey, session } = this.#operationTarget(
      request.cell,
      request.operationSessionId,
      client,
    );
    const named = getCell(this.#runtime, request.cell);
    // A subscription id is a UUID the client mints, so two clients never
    // collide on one. What the owning client settles is where an update goes,
    // and what a departing client takes with it.
    const subscription: {
      cancel?: Cancel;
      cancelled: boolean;
      sessionKey?: string;
      client: WorkerClient;
    } = {
      cancelled: false,
      client,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    };
    this.#operationSubscriptions.set(request.subscriptionId, subscription);
    session?.subscriptions.add(request.subscriptionId);
    let cancel: Cancel;
    try {
      cancel = await capability.subscribeOperationField({
        ...operationFieldAddress(field),
        ...(request.after === undefined ? {} : { after: request.after }),
      }, (snapshot) => {
        if (
          this.#operationSubscriptions.get(request.subscriptionId) !==
            subscription
        ) return;
        queueMicrotask(() =>
          client.post(
            this.#hostReadGate.operationUpdate(
              field,
              request.subscriptionId,
              snapshot,
              named,
            ),
          )
        );
      });
    } catch (error) {
      if (
        this.#operationSubscriptions.get(request.subscriptionId) ===
          subscription
      ) {
        this.#operationSubscriptions.delete(request.subscriptionId);
        session?.subscriptions.delete(request.subscriptionId);
        if (
          sessionKey !== undefined && session?.subscriptions.size === 0 &&
          this.#operationSessions.get(sessionKey) === session
        ) {
          this.#operationSessions.delete(sessionKey);
        }
      }
      throw error;
    }
    if (
      this.#isDisposed || subscription.cancelled ||
      this.#operationSubscriptions.get(request.subscriptionId) !== subscription
    ) {
      cancel();
      return { value: false };
    }
    subscription.cancel = cancel;
    return { value: true };
  }

  async handleOperationRelease(
    request: OperationReleaseRequest,
    client: WorkerClient = ownerClient,
  ): Promise<BooleanResponse> {
    const { capability, field } = this.#operationTarget(
      request.cell,
      request.operationSessionId,
      client,
    );
    await capability.releaseOperationField({
      op: "release-op-field",
      ...operationFieldAddress(field),
      codec: request.codec,
      cursor: request.cursor,
    });
    return { value: true };
  }

  handleOperationUnsubscribe(
    request: OperationUnsubscribeRequest,
    client: WorkerClient = ownerClient,
  ): BooleanResponse {
    const subscription = this.#operationSubscriptions.get(
      request.subscriptionId,
    );
    // A subscription is its subscriber's to stop, and no one else's. The id
    // is a UUID, so another client naming it is a client that came by it
    // somehow rather than one that guessed it -- which is the case worth
    // refusing.
    if (subscription === undefined || subscription.client.id !== client.id) {
      return { value: false };
    }
    this.#operationSubscriptions.delete(request.subscriptionId);
    subscription.cancelled = true;
    subscription.cancel?.();
    if (subscription.sessionKey !== undefined) {
      const session = this.#operationSessions.get(subscription.sessionKey);
      session?.subscriptions.delete(request.subscriptionId);
      if (session?.subscriptions.size === 0) {
        this.#operationSessions.delete(subscription.sessionKey);
      }
    }
    return { value: true };
  }

  handleOperationSessionClose(
    request: OperationSessionCloseRequest,
    client: WorkerClient = ownerClient,
  ): BooleanResponse {
    const session = this.#operationSessions.get(request.operationSessionId);
    if (session === undefined || session.clientId !== client.id) {
      return { value: false };
    }
    return {
      value: this.#operationSessions.delete(request.operationSessionId),
    };
  }

  /**
   * Applies a `CellSetRequest`, the blind, last-write-wins arm.
   * `Runtime.commitUiCellWrite()` owns its structural precondition, retry
   * policy, and per-address supersede lane. Ordinary UI writes remain
   * fire-and-forget, while strict capability writes can await the same outcome
   * through `handleCellSet()`.
   */
  applyCellSet(request: CellSetRequest) {
    const cell = getCell(this.#runtime, request.cell);
    const value = mapCellRefsToSigilLinks(request.value);
    return this.#runtime.commitUiCellWrite(cell, value, {
      blind: true,
      supersedeKey: this.#operationSessionKey(request.cell),
    });
  }

  handleCellSend(request: CellSendRequest): void | Promise<void> {
    const tx = this.#runtime.edit();
    const cell = getCell(this.#runtime, request.cell);
    cell.withTx(tx).send(mapCellRefsToSigilLinks(request.event));
    this.#runtime.prepareTxForCommit(tx);
    const commit = tx.commit();
    if (request.awaitCommit) return this.#requireCellCommit(commit);
    this.#observeCellCommit(commit, "send");
  }

  #observeCellCommit(
    commit: ReturnType<ReturnType<Runtime["edit"]>["commit"]>,
    operation: "set" | "push" | "send",
  ): void {
    void commit.then(
      (result) => {
        if (result.error) {
          console.error(
            `[RuntimeProcessor] Cell ${operation} commit failed:`,
            result.error,
          );
        }
      },
      (error) => {
        console.error(
          `[RuntimeProcessor] Cell ${operation} commit failed:`,
          error,
        );
      },
    );
  }

  async #requireCellCommit(
    commit: ReturnType<ReturnType<Runtime["edit"]>["commit"]>,
  ): Promise<void> {
    const result = await commit;
    if (result.error) throw new Error(result.error.message);
  }

  handleCellSubscribe(
    request: CellSubscribeRequest,
    client: WorkerClient = ownerClient,
  ): BooleanResponse {
    const key = clientScopedKey(client, cellRefToKey(request.cell));

    if (this.#subscriptions.has(key)) {
      return { value: false };
    }

    const cell = getCell(this.#runtime, request.cell);

    const cancel = this.#hostReadGate.subscribe(cell, request.cell, {
      includeCfcLabel: request.includeCfcLabel,
    }, (value) => {
      // Log empty-schema subscriptions that produce CellResult proxies.
      // These are the call sites that need real schemas added.
      const hasSchema = hasExplicitSubscriptionSchema(request.cell.schema);
      if (!hasSchema && isCellResult(value)) {
        console.error(
          `[handleCellSubscribe] EMPTY SCHEMA SUBSCRIPTION producing ` +
            `CellResult proxy. Add a schema to this subscription site!\n` +
            `  cell: ${request.cell.id}\n` +
            `  path: ${JSON.stringify(request.cell.path)}\n` +
            `  space: ${request.cell.space}\n` +
            `  schema: ${JSON.stringify(request.cell.schema)}`,
        );
      }
    }, (update) =>
      // `.sink` fires synchronously on invocation. Each notification leaves
      // in a microtask so that the subscription response returns before it.
      queueMicrotask(() => client.post(update)));

    this.#subscriptions.set(key, cancel);
    return { value: true };
  }

  handleCellUnsubscribe(
    request: CellUnsubscribeRequest,
    client: WorkerClient = ownerClient,
  ): BooleanResponse {
    const key = clientScopedKey(client, cellRefToKey(request.cell));
    const cancel = this.#subscriptions.get(key);
    if (cancel) {
      cancel();
      this.#subscriptions.delete(key);
      return { value: true };
    }
    return { value: false };
  }

  handleCellResolveAsCell(
    request: CellResolveAsCellRequest,
  ): CellResolveResponse {
    const cell = getCell(this.#runtime, request.cell);
    const answer = this.#hostReadGate.resolveAsCell(cell);
    if ("refused" in answer) return answer;
    const resolved = cell.resolveAsCell();
    const ref = answer.cell;
    if (
      ref.schema && typeof ref.schema === "object" &&
      !Array.isArray(ref.schema)
    ) {
      ref.schema = resolveExternalRootRefForStructure(ref.schema);
    }
    const raw = (resolved as Cell<unknown> & {
      getRaw?: (options: { lastNode: "value" }) => unknown;
    }).getRaw?.({ lastNode: "value" });
    if (isSqliteDbRefValue(raw)) {
      const schema = ref.schema && typeof ref.schema === "object" &&
          !Array.isArray(ref.schema)
        ? ref.schema
        : { type: "object" as const };
      ref.schema = { ...schema, asCell: ["sqlite"] as const };
    }
    return answer;
  }

  /** Keeps release authority in this backend while the host shows a preview. */
  async handleSnapshotSharePrepare(
    request: SnapshotSharePrepareRequest,
    client: WorkerClient = ownerClient,
  ): Promise<SnapshotSharePrepareResponse> {
    if (this.#isDisposed || this.#detachedClients.has(client)) {
      throw new Error("Snapshot sharing is unavailable");
    }
    const source = this.#hostSelectedCell(request.source);
    const audience = request.audience;
    if (
      !isObjectNotArray(audience) ||
      ("user" in audience) === ("space" in audience)
    ) throw new Error("Snapshot sharing requires one audience");
    const audienceCell = this.#hostSelectedCell(
      "user" in audience ? audience.user : audience.space,
    );
    const appendBooksTo = request.appendBooksTo && {
      recommended: this.#hostSelectedCell(
        request.appendBooksTo.recommended,
      ),
      received: this.#hostSelectedCell(request.appendBooksTo.received),
    };
    await Promise.all([
      source.sync(),
      audienceCell.sync(),
      appendBooksTo?.recommended.sync(),
      appendBooksTo?.received.sync(),
    ]);
    // The preview shows the host the source's value, so it is decided as an
    // answer built from the source is, and no consent is kept for one the
    // display ceiling refuses.
    return await this.#hostReadGate.fromCell(source, (decided) => {
      if (this.#isDisposed || this.#detachedClients.has(client)) {
        throw new Error("Snapshot sharing is unavailable");
      }
      const prepared = prepareSnapshotShare(
        decided,
        "user" in audience ? { user: audienceCell } : { space: audienceCell },
        appendBooksTo,
      );
      const id = crypto.randomUUID();
      this.#snapshotShares.set(clientScopedKey(client, id), prepared.consent);
      return Promise.resolve({
        id,
        value: prepared.value,
        audience: prepared.audience,
      });
    });
  }

  /** Consumes one preview through the dedicated trusted host transport. */
  async handleSnapshotShareCommit(
    request: SnapshotShareCommitRequest,
    client: WorkerClient = ownerClient,
  ): Promise<CellResponse> {
    const key = clientScopedKey(client, request.id);
    const consent = this.#snapshotShares.get(key);
    this.#snapshotShares.delete(key);
    if (consent === undefined) {
      throw new Error("Snapshot share confirmation is unavailable");
    }
    const event = {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: { pattern: "ShareSnapshot" },
      },
    };
    markRendererTrustedEvent(event);
    const shared = await commitSnapshotShare(consent, event);
    return { cell: this.#hostReadGate.ref(shared) };
  }

  /**
   * Prepares a custody seal and keeps its consent in this backend while the
   * host shows the preview. The seal reads the policy reference from the cell
   * the host names, and the allowed sources from the settings cell the host
   * names, only in the actor's home space. It reads both again inside the
   * commit, so a value either cell holds that differs from the reviewed one
   * refuses the seal as stale rather than sealing what was reviewed.
   */
  async handleCustodySealPrepare(
    request: CustodySealPrepareRequest,
    client: WorkerClient = ownerClient,
  ): Promise<CustodySealPreview> {
    const unavailable = () =>
      this.#isDisposed || this.#detachedClients.has(client);
    if (unavailable()) throw new Error("Custody sealing is unavailable");
    const draft = this.#hostSelectedCell(request.draft);
    const terms = this.#hostSelectedCell(request.terms);
    const policy = this.#hostSelectedCell(request.policy);
    const settings = this.#hostSelectedCell(request.allowedSources);
    const box = request.box === undefined
      ? undefined
      : this.#hostSelectedCell(request.box);
    const prepared = await prepareCustodySeal(
      draft,
      { terms, policy, ...(box === undefined ? {} : { box }) },
      { allowedSources: settings },
    );
    if (unavailable()) throw new Error("Custody sealing is unavailable");
    const id = crypto.randomUUID();
    this.#custodySeals.set(clientScopedKey(client, id), {
      consent: prepared.consent,
    });
    return {
      id,
      actor: prepared.actor as DID,
      room: prepared.room as DID,
      readers: prepared.readers.map((reader) => ({ ...reader })),
      terms: prepared.terms,
      instance: prepared.instance,
      policy: prepared.policy,
      sources: [...prepared.sources],
      witnessedRelease: prepared.witnessedRelease,
      stance: prepared.stance,
    };
  }

  /**
   * Consumes one custody seal preview through the dedicated trusted host
   * transport. The trusted gesture is built here, never taken from the
   * request. The seal reads the actor's source policy again, and the
   * transaction that writes the entry verifies that read, so a policy
   * narrowed at any point before the entry commits refuses the seal. The
   * commit is aborted if its client detaches before the entry's transaction
   * is sent.
   */
  async handleCustodySealCommit(
    request: CustodySealCommitRequest,
    client: WorkerClient = ownerClient,
  ): Promise<CustodySealCommitResponse> {
    const key = clientScopedKey(client, request.id);
    const pending = this.#custodySeals.get(key);
    this.#custodySeals.delete(key);
    // Detaching a client and disposing the processor both discard pending
    // previews, so a preview found here belongs to a live client.
    if (pending === undefined) {
      throw new Error("Custody seal confirmation is unavailable");
    }
    const event = {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: { pattern: CUSTODY_SEAL_GESTURE },
      },
    };
    markRendererTrustedEvent(event);
    // A client that detaches at any point before the entry's transaction is
    // sent aborts the commit, so nothing is sealed for a client that is gone.
    const commit = new AbortController();
    this.#custodySealCommits.set(key, commit);
    try {
      const sealed = await commitCustodySeal(pending.consent, event, {
        signal: commit.signal,
      });
      return {
        receipt: this.#hostReadGate.ref(sealed.receipt),
        box: this.#hostReadGate.ref(sealed.box),
        instance: sealed.instance,
      };
    } finally {
      this.#custodySealCommits.delete(key);
    }
  }

  /**
   * Publishes a custody instance's answer once. The worker reads the room's
   * terms, policy and projected answer at the addresses the host names, and
   * the seal decides from what it reads whether the answer is released to the
   * room's readers and not yet published; nothing in the request vouches for
   * the answer.
   */
  async handleCustodyAnswerPublish(
    request: CustodyAnswerPublishRequest,
  ): Promise<CustodyAnswerPublishResponse> {
    if (this.#isDisposed) throw new Error("Custody sealing is unavailable");
    const terms = this.#hostSelectedCell(request.terms);
    const policy = this.#hostSelectedCell(request.policy);
    const output = this.#hostSelectedCell(request.output);
    const published = await publishCustodyAnswer({ terms, policy }, output);
    return { instance: published.instance, answer: published.value };
  }

  /**
   * Reads a custody instance's published answer from the slot the seal
   * derives from the room's terms and policy, verified to be the seal's own
   * write. A host renders this rather than anything the room holds.
   */
  async handleCustodyAnswerRead(
    request: CustodyAnswerReadRequest,
  ): Promise<CustodyAnswerReadResponse> {
    if (this.#isDisposed) throw new Error("Custody sealing is unavailable");
    const answer = await readCustodyAnswer({
      terms: this.#hostSelectedCell(request.terms),
      policy: this.#hostSelectedCell(request.policy),
    });
    return answer === undefined ? {} : { answer };
  }

  /**
   * The fields a record holds, each as a link to its own cell, as the
   * host-read gate decides them. Synced first, so that the labels the list
   * is decided on are the record's.
   */
  async handleCellFields(
    request: CellFieldsRequest,
  ): Promise<CellFieldsResponse> {
    const cell = getCell(this.#runtime, request.cell);
    await cell.sync();
    return this.#hostReadGate.fields(cell);
  }

  handleCellGetCfcLabel(
    request: CellGetCfcLabelRequest,
  ): CfcLabelViewResponse {
    // Label reads must use the runtime's stored cell identity. The request
    // schema is client-supplied view context, not trusted label provenance.
    const { schema: _schema, ...cellRef } = request.cell;
    const cell = getCell(this.#runtime, cellRef);
    // This reads the label with `cfcLabelViewForResolvedCell()`, which reads
    // what the store holds now, following a link the path crosses part way
    // through to the document that holds the value, and does not sync the
    // cell or any document along its path. When the store holds no
    // label metadata for the cell, `cfcLabel` in the response is `undefined`.
    // That covers a document the store has not loaded as well as a cell with
    // no label. Keeping the cell current is the caller's job. A caller that
    // needs the label as it changes subscribes with `includeCfcLabel`, and
    // each update then carries the label as read for that update. The gate
    // redacts `Caveat.source` from the label for display, and joins its
    // entries at the root where the display ceiling refuses the cell.
    const totalStart = performance.now();
    const response = this.#hostReadGate.label(cell);
    cfcLabelLogger.time(totalStart, "total");
    return response;
  }

  async handleSqliteQuery(
    request: SqliteQueryRequest,
  ): Promise<SqliteQueryResponse> {
    const cell = getCell(this.#runtime, request.cell);
    // Decided on the database handle's labels: the rows are reached through
    // it, and not through a read the gate can measure.
    return await this.#hostReadGate.fromCell(
      cell,
      (decided) => this.#querySqlite(decided, request),
    );
  }

  /** Helper for {@link handleSqliteQuery}, once the read is admitted. */
  async #querySqlite(
    cell: Cell<unknown>,
    request: SqliteQueryRequest,
  ): Promise<{ rows: { [key: string]: FabricValue }[] }> {
    const db = await this.#pullSqliteDbRef(cell);
    // A direct IPC query has no runner result cell on which to persist the
    // label derived from result-column provenance. Refuse that database shape
    // instead of returning rows with their CFC labels silently stripped.
    if (dbNeedsColumnProvenance(db.tables)) {
      throw new Error(
        "Direct SQLite bridge queries are unavailable for CFC-labeled " +
          "tables; query them inside a pattern so result labels propagate.",
      );
    }
    const provider = this.#runtime.storageManager.open(request.cell.space);
    if (!provider.sqliteQuery) {
      throw new Error(
        "sqlite: storage provider does not support queries " +
          "(sqliteQuery unavailable)",
      );
    }
    const params = request.params === undefined
      ? undefined
      : encodeSqliteParams(
        request.sql,
        sqliteParamsForRuntime(this.#runtime, request.params),
      );
    const result = await provider.sqliteQuery(db, request.sql, params);
    return {
      rows: result.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            sqliteValueForClient(value),
          ]),
        )
      ),
    };
  }

  async handleSqliteExec(request: SqliteExecRequest): Promise<void> {
    const source = getCell(this.#runtime, request.cell);
    const db = await this.#pullSqliteDbRef(source);
    const result = await this.#runtime.editWithRetry((tx) => {
      markDurableReadTx(tx);
      const params = request.params === undefined
        ? undefined
        : sqliteParamsForRuntime(this.#runtime, request.params, tx);
      const cell = getCell(this.#runtime, request.cell).withTx(
        tx,
      ) as unknown as Cell<unknown> & {
        exec(
          sql: string,
          params?: ReadonlyArray<unknown> | Record<string, unknown>,
        ): void;
      };
      if (cell.getRaw({ lastNode: "value" }) === undefined) {
        cell.asSchema<SqliteDbRef>({
          type: "object",
          additionalProperties: true,
        }).set(db);
      }
      cell.exec(request.sql, params);
    });
    if (result.error) throw new Error(result.error.message);
  }

  async #pullSqliteDbRef(cell: Cell<unknown>): Promise<SqliteDbRef> {
    await cell.pull();
    if (holdsNoValue(cell)) {
      // A resolved scoped target can be demanded while its lazy factory write
      // is still committing. Its object schema presents that missing value as
      // an empty object rather than `undefined`. Pull waits for reactive work,
      // but deliberately not for in-flight commits; sync before that commit can
      // confirm the target absent and leave this request holding an empty
      // replica. Cross the commit-aware barrier before loading only that first
      // missing value. Non-empty malformed handles still fail immediately in
      // readSqliteDbRef instead of being mistaken for a pending factory.
      await this.#runtime.scheduler.idleWithPendingCommits();
      await cell.sync();
    }
    return this.#readSqliteDbRef(cell);
  }

  #readSqliteDbRef(cell: Cell<unknown>): SqliteDbRef {
    const raw = cell.getRaw({ lastNode: "value" }) as
      | {
        id?: unknown;
        tables?: unknown;
        scope?: unknown;
        owner?: unknown;
      }
      | undefined;
    if (!raw || typeof raw.id !== "string") {
      throw new TypeError(
        "SQLite operations require a valid SqliteDb cell handle.",
      );
    }
    if (
      raw.scope !== undefined && raw.scope !== "space" &&
      raw.scope !== "user" && raw.scope !== "session"
    ) {
      throw new TypeError(
        `Invalid SQLite database scope: ${String(raw.scope)}`,
      );
    }
    if (raw.owner !== undefined && typeof raw.owner !== "string") {
      throw new TypeError("Invalid SQLite database owner.");
    }
    const materialized = cell.asSchema<{
      tables?: FabricValue;
    }>({ type: "object", additionalProperties: true }).get();
    const tables = materialized?.tables !== undefined
      ? cloneIfNecessary(materialized.tables, {
        frozen: false,
      }) as SqliteDbRef["tables"]
      : raw.tables as SqliteDbRef["tables"];
    return {
      id: raw.id,
      ...(tables !== undefined && { tables }),
      ...((raw.scope === "space" || raw.scope === "user" ||
        raw.scope === "session") && { scope: raw.scope }),
      ...(typeof raw.owner === "string" && { owner: raw.owner }),
    };
  }

  handleGetCell(request: GetCellRequest): CellResponse {
    const cell = this.#runtime.getCell(
      request.space,
      request.cause,
      request.schema,
    );

    return {
      cell: this.#hostReadGate.ref(cell, request.schema),
    };
  }

  handleGetHomeSpaceCell(_request: GetHomeSpaceCellRequest): CellResponse {
    const homeSpaceCell = this.#runtime.getHomeSpaceCell();
    return {
      cell: this.#hostReadGate.ref(homeSpaceCell),
    };
  }

  /**
   * Ensure the home space's default pattern is running and return a CellRef to it.
   * This is needed for favorites operations which require the pattern to be active.
   * Creates the home pattern if it doesn't exist yet.
   */
  async handleEnsureHomePatternRunning(
    _request: EnsureHomePatternRunningRequest,
  ): Promise<CellResponse> {
    const homeSpaceCell = this.#runtime.getHomeSpaceCell();
    await homeSpaceCell.sync();

    // Always the PiecesController path: ensureDefaultPattern() follows the
    // root's origin and carries the cold-start setup repair that heals an aged
    // home root. Starting the pattern directly here would skip both, and
    // nothing else heals the root — so no fast path belongs in front of the
    // controller.
    const homePattern = await this.#ensureHomePattern();
    return { cell: this.#hostReadGate.ref(homePattern) };
  }

  /**
   * Ensures the user's Home pattern is running and returns its result cell.
   * The first time in this worker, it also adopts the Home space list's
   * name-only entries (see `PiecesController.adoptLegacySpaces`).
   */
  async #ensureHomePattern(): Promise<Cell<unknown>> {
    const homeCC = this.#homeController();
    await homeCC.synced();
    const home = (await homeCC.ensureDefaultPattern()).getCell();
    // Adoption is housekeeping over the Home pattern the user already has; a
    // failure is reported and tried again on the next ensure, and never keeps
    // Home from opening.
    this.#legacySpacesAdopted ??= homeCC.adoptLegacySpaces().catch((error) => {
      this.#legacySpacesAdopted = undefined;
      console.warn("[RuntimeProcessor] Adopting legacy Home spaces:", error);
    });
    await this.#legacySpacesAdopted;
    return home;
  }

  /** A controller over the user's Home space. */
  #homeController(): PiecesController {
    const homeSession: Session = {
      as: this.#identity,
      space: this.#runtime.userIdentityDID,
    };
    return new PiecesController(homeSession, this.#runtime);
  }

  async handleIdle(): Promise<void> {
    // The client reads "idle" as a safe point to navigate or reload, so it
    // must include durability of just-issued writes: idleWithPendingCommits()
    // waits for reactive quiescence and for every in-flight commit together
    // (see Scheduler.idleWithPendingCommits; the pending set is sourced from
    // the storage manager, covering event handlers, direct cell IPC writes,
    // and reactive write-backs alike). Internal callers that only need
    // reactive quiescence use runtime.idle() and are unaffected.
    await this.#runtime.scheduler.idleWithPendingCommits();
  }

  async handleListEventAttention(
    request: ListEventAttentionRequest,
  ): Promise<EventAttentionListResponse> {
    const provider = this.#runtime.storageManager.open(request.space);
    const indexSync = await provider.sync(
      SERVER_EXECUTION_ATTENTION_DOC_ID as never,
      undefined,
      "space",
    );
    if (indexSync.error !== undefined) throw indexSync.error;
    if (provider.replica === undefined) {
      throw new Error("storage provider does not expose an attention replica");
    }
    const index = provider.replica.getDocument(
      SERVER_EXECUTION_ATTENTION_DOC_ID as never,
      "space",
    )?.value as EventAttentionIndexValue | undefined;
    const notices: EventAttentionListResponse["notices"] = [];
    const summariesBySidecar = new Map<string, UnresolvedEventAttention[]>();
    for (const sidecarSummaries of Object.values(index?.entries ?? {})) {
      for (const summary of Object.values(sidecarSummaries)) {
        const summaries = summariesBySidecar.get(summary.sidecarId) ?? [];
        summaries.push(summary);
        summariesBySidecar.set(summary.sidecarId, summaries);
      }
    }
    for (const [sidecarId, summaries] of summariesBySidecar) {
      const sidecarSync = await provider.sync(
        sidecarId as never,
        undefined,
        "space",
      );
      if (sidecarSync.error !== undefined) throw sidecarSync.error;
      const sidecar = provider.replica.getDocument(
        sidecarId as never,
        "space",
      )?.value as StreamEventsDocValue | undefined;
      const entries = new Map(
        sidecar?.entries?.map((entry) =>
          [eventAttentionEntryKey(entry.eventId, entry.seq), entry] as const
        ),
      );
      for (const summary of summaries) {
        const entry = entries.get(
          eventAttentionEntryKey(summary.eventId, summary.seq),
        );
        const actingUser = entry?.firedAt?.user;
        if (
          entry?.status !== "needs-attention" ||
          entry.attention === undefined ||
          entry.resolution !== undefined ||
          (actingUser !== undefined && actingUser !== this.#identity.did())
        ) continue;
        notices.push({
          space: request.space,
          eventId: entry.eventId,
          seq: summary.seq,
          sidecarId,
          retryable: actingUser !== undefined,
          reason: entry.reason ?? "Event delivery needs attention",
          attention: entry.attention,
        });
      }
    }
    return { notices };
  }

  async handleResolveEventAttention(
    request: ResolveEventAttentionRequest,
  ): Promise<EventAttentionResolveResponse> {
    const resolve = this.#runtime.storageManager.resolveEventAttention;
    if (resolve === undefined) {
      throw new Error("storage manager does not support event attention");
    }
    const result = await resolve.call(
      this.#runtime.storageManager,
      request.space,
      request.eventId,
      request.seq,
      request.sidecarId,
      request.action,
    );
    return { resolution: result.resolution };
  }

  /**
   * Awaits in-flight compile-cache write-backs, so a subsequent load reads the
   * freshly-written entry instead of recompiling. This is persistence
   * durability, distinct from `handleIdle()`'s reactive quiescence.
   */
  async handleFlushCompileCacheWrites(): Promise<void> {
    await this.#runtime.patternManager.flushCompileCacheWrites();
  }

  async handlePieceCreate(
    request: PieceCreateRequest,
  ): Promise<PieceResponse> {
    const cc = this.#getSpaceCtx(request.space);
    let program: Program | undefined;
    if ("url" in request.source && request.source.url) {
      const sourceUrl = new URL(request.source.url);
      if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
        throw new Error("Piece source URL must use HTTP or HTTPS.");
      }
      // The URL is a place to read a program from once, not an origin. A piece
      // follows what this deployment serves and what the fabric holds, so an
      // arbitrary endpoint names nothing the lifecycle can resolve later, and
      // recording one would leave the piece carrying an origin nothing follows.
      // The piece is created detached, and its owner can name an origin after.
      program = await cc.runtime.harness.resolve(
        new HttpProgramResolver(sourceUrl),
      );
    } else if ("program" in request.source) {
      program = request.source.program;
    } else {
      throw new Error("Invalid source.");
    }

    // Checked rather than cast. The wire carries a `FabricValue`; a piece's
    // input is narrower, being a record of named inputs, which is the question
    // `isPlainObject()` asks.
    const argument = request.argument;
    if ((argument !== undefined) && !isPlainObject(argument)) {
      // The rejected value is named rather than its `typeof`, which calls both
      // an array and `null` an `object` and so says nothing about either. It
      // is bounded because the argument is a caller's data.
      throw new Error(
        debugStr`A piece's argument must be a record, not: $quote,long${argument}`,
      );
    }

    const piece = await cc.create<NameSchema>(program, {
      input: argument,
      start: request.run ?? true,
    }, request.cause);
    return {
      piece: this.#hostReadGate.pieceRef(piece.getCell()),
    };
  }

  async handleGetSpaceRootPattern(
    request: PatternGetSpaceRoot,
  ): Promise<PieceResponse> {
    const cc = this.#getSpaceCtx(request.space);
    if (request.start === false) {
      // The caller reads the root's exports rather than rendering it, so
      // resolving what is stored answers it — reconciled, so what it reads
      // is still healed against the root's origin. Only a space with no root
      // yet falls through: a root has to exist before it can have exported
      // anything, and creating one is not the cost this avoids.
      const stored = await cc.getDefaultPattern({
        reconcile: true,
        start: false,
      });
      if (stored) return { piece: this.#hostReadGate.pieceRef(stored) };
    }
    const piece = await cc.ensureDefaultPattern();
    return {
      piece: this.#hostReadGate.pieceRef(piece.getCell()),
    };
  }

  async handleRecreateSpaceRootPattern(
    request: RecreateSpaceRootPatternRequest,
  ): Promise<PieceResponse> {
    const cc = this.#getSpaceCtx(request.space);
    const piece = await cc.recreateDefaultPattern();
    return {
      piece: this.#hostReadGate.pieceRef(piece.getCell()),
    };
  }

  /**
   * Handles a `PieceGetRequest`. The answer is an address — a cell carrying
   * the schema it is read under — so what this loads is what deciding the
   * address takes: the requested document, and behind a redirect the document
   * the redirect lands in, whose metadata says whether it is a piece and what
   * result schema a cell inside it takes. Serving a slug document, the server
   * resolves the redirect through the links on its path, which is the floor
   * for an address a redirect answers. Nothing here reads the target's value,
   * so whatever that value reaches stays cold until a caller subscribes to
   * the cell it was handed.
   *
   * Resolves a redirect here rather than through the runner's slug
   * resolution, which `handleSlugResolve()` uses. Do not copy the bare
   * `parseLink()` below into a new caller: a slug cell can be written by a
   * foreign client over the memory protocol, and `parseSlugRedirect()` in
   * `packages/runner/src/slug-resolution.ts` exists to fold the `TypeError` a
   * sigil-shaped payload with broken internals throws into a typed refusal.
   * These are one walk with two implementations, and this is the copy to
   * retire.
   */
  async handlePieceGet(
    request: PieceGetRequest,
  ): Promise<PieceResponse> {
    // TODO(danfuzz): Refuse a cell that is not a piece cell in the surviving
    // walk, once `parseSlugRedirect()` is the one copy.
    const cc = this.#getSpaceCtx(request.space);
    // Probed in the scope the request names, because the id alone names a
    // different document in every other scope: reading the default one would
    // ask whether some unrelated document is a redirect.
    const requestedCell = this.#runtime.getCellFromEntityId(
      cc.getSpace(),
      entityIdFrom(request.pieceId),
      [],
      undefined,
      undefined,
      request.scope,
    );
    // Schema-less, so the selector rejects the value's subtree: the document
    // arrives, plus what the server resolves at the address itself when the
    // value stored there is a link.
    await requestedCell.sync();
    const redirect = parseLink(
      requestedCell.getRaw(),
      requestedCell.getAsNormalizedFullLink(),
    );
    if (redirect?.overwrite === "redirect") {
      // Where a redirect leads is what its document holds, so it is decided
      // as the node holding a link is: a host refused it is told so, and not
      // where it leads.
      const refused = this.#hostReadGate.linkRefusal(requestedCell);
      if (refused !== undefined) {
        throw new Error(
          `The worker refused to name where this redirect leads ` +
            `(${refused.refused.refusedBy}).`,
        );
      }
      const target = this.#runtime.getCellFromLink({
        ...redirect,
        space: redirect.space ?? cc.getSpace(),
        scope: redirect.scope ?? "space",
      });
      const targetLink = target.getAsNormalizedFullLink();
      // The document the redirect lands in, at its root. Whether it is a
      // piece, and the result schema a cell inside it takes, are its
      // metadata. Synced at the root rather than at the redirect's path, so
      // the watch this leaves behind covers the document alone rather than
      // every link the server resolves along that path.
      const landing = targetLink.path.length === 0
        ? target
        : this.#runtime.getCellFromLink({
          id: targetLink.id,
          space: targetLink.space,
          scope: targetLink.scope,
          path: [],
        });
      await landing.sync();
      const hasPattern = getPatternIdentityRef(landing) !== undefined;
      const viewScoped = this.#runtime.viewScopedReplicationRequested &&
        await this.#runtime.viewReplication.enable(target.space);
      if (viewScoped && (!hasPattern || targetLink.path.length > 0)) {
        const pieceCell = target.asSchema(viewPieceSchema);
        await pieceCell.pull();
        return { piece: this.#hostReadGate.pieceRef(pieceCell) };
      }
      if (!hasPattern) return { piece: this.#hostReadGate.pieceRef(target) };
      if (targetLink.path.length > 0) {
        // The schema a cell inside a piece is read under: what the links
        // along its path carry, as `getPieceCell()` resolves a piece cell
        // reached with a path; else what the redirect itself carries; else
        // the piece's result schema at that path. Reached through the
        // landing document, whose sync it shares, so that nothing here
        // starts a watch at the path.
        const inside = landing.key(...targetLink.path);
        const linked = inside.asSchemaFromLinks();
        if (linked.getAsNormalizedFullLink().schema !== undefined) {
          return { piece: this.#hostReadGate.pieceRef(linked) };
        }
        if (targetLink.schema !== undefined) {
          return {
            piece: this.#hostReadGate.pieceRef(
              inside.asSchema(targetLink.schema),
            ),
          };
        }
        const resultSchema = landing.getMetaRaw("schema") as
          | JSONSchema
          | undefined;
        const cell = resultSchema === undefined ? inside : inside.asSchema(
          ContextualFlowControl.schemaAtPath(resultSchema, targetLink.path),
        );
        return { piece: this.#hostReadGate.pieceRef(cell) };
      }
      const cell = await cc.getPieceCell(landing, request.runIt ?? false);
      return { piece: this.#hostReadGate.pieceRef(cell) };
    }

    const cell = await cc.getPieceCell(
      request.pieceId,
      request.runIt ?? false,
      undefined,
      request.scope,
    );

    return {
      piece: this.#hostReadGate.pieceRef(cell),
    };
  }

  async handlePieceGetSlug(
    request: PieceGetSlugRequest,
  ): Promise<SlugResponse> {
    const pieces = this.#getSpaceCtx(request.space);
    const cell = this.#runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(request.pieceId),
      [],
      undefined,
      undefined,
      request.scope,
    );
    // Synced first, so that the labels it is decided on are the document's.
    await cell.sync();
    return this.#hostReadGate.slug(cell);
  }

  /**
   * Where a slug reference lands, unstarted: the piece it reached, and the
   * segments the walk did not spend. Starting and caching stay with
   * {@link handlePieceGet}, which a caller reaches through this piece's id.
   *
   * A reference naming no member asks a different question of the same slug —
   * which piece is this name inside — because a page URL names a piece to
   * render and a collection is a cell within one. {@link
   * resolveSlugTargetInPiece} answers exactly that, so `/<space>/top` opens
   * the piece holding the collection; the path from that piece's root down to
   * the collection is no part of a page address and is dropped here.
   *
   * A reference naming a member spends that member only where the slug names
   * a collection. A slug naming a piece at its root spends nothing, and the
   * member comes back in `pathAfter` for the caller to reckon with, rather
   * than being dropped into a page whose address still carries it.
   *
   * Fails as the runner's resolution fails — `missing-member` for a member
   * the collection does not hold, naming both, and `not-piece` for a target
   * that is neither a piece nor a member of one.
   */
  async handleSlugResolve(
    request: SlugResolveRequest,
  ): Promise<SlugReferenceResponse> {
    const cc = this.#getSpaceCtx(request.space);
    const space = cc.getSpace();
    // Each document the walk read, at its root: the answer, and a failure's
    // message, are made from what they hold, so the gate decides it on them.
    const walked: Cell<unknown>[] = [];
    const read = (cell: Cell<unknown>) => {
      const { space, id, scope } = cell.getAsNormalizedFullLink();
      walked.push(
        this.#runtime.getCellFromLink({ space, id, scope, path: [] }),
      );
    };
    try {
      if (request.member === undefined) {
        const { piece } = await resolveSlugTargetInPiece(
          this.#runtime,
          space,
          request.slug,
          read,
        );
        return await this.#hostReadGate.slugReference(walked, {
          piece,
          pathAfter: [],
        });
      }
      const { piece, pathAfter } = await resolveSlugReference(
        this.#runtime,
        space,
        request.slug,
        [request.member],
        read,
      );
      return await this.#hostReadGate.slugReference(walked, {
        piece,
        pathAfter,
      });
    } catch (error) {
      // A reference reaching nothing is what the caller asked about, so it
      // comes back as an answer. Everything else — a transport fault, a
      // document that will not decode — stays an error, which is the only
      // way a caller can tell "this name is not bound" from "ask again".
      if (error instanceof SlugResolutionError) {
        return await this.#hostReadGate.slugReference(walked, {
          refusal: { code: error.code ?? "unresolved", message: error.message },
        });
      }
      throw error;
    }
  }

  async handlePieceRemove(
    request: PieceRemoveRequest,
  ): Promise<BooleanResponse> {
    const cc = this.#getSpaceCtx(request.space);
    return { value: await cc.remove(request.pieceId, request.scope) };
  }

  async handlePieceStart(
    request: PieceStartRequest,
  ): Promise<BooleanResponse> {
    const cc = this.#getSpaceCtx(request.space);
    await cc.startPiece(request.pieceId, request.scope);
    // A missing piece throws in `startPiece()`, so `true` here means the
    // piece started.
    // TODO(danfuzz): Report whether it was already running, once
    // `startPiece()` says so.
    return { value: true };
  }

  async handlePieceStop(
    request: PieceStopRequest,
  ): Promise<BooleanResponse> {
    const cc = this.#getSpaceCtx(request.space);
    await cc.stopPiece(request.pieceId, request.scope);
    // A missing piece throws in `stopPiece()`, so `true` here means the
    // piece is stopped, whether or not it was running.
    // TODO(danfuzz): Report whether it was running, once `stopPiece()`
    // says so.
    return { value: true };
  }

  async handlePieceGetAll(request: PieceGetAllRequest): Promise<CellResponse> {
    const pieces = this.#getSpaceCtx(request.space);
    const piecesCell = await pieces.getPieceRegistry();
    return {
      cell: this.#hostReadGate.ref(piecesCell),
    };
  }

  async handlePieceSynced(request: PieceSyncedRequest): Promise<void> {
    const pieces = this.#getSpaceCtx(request.space);
    await pieces.synced();
  }

  async handlePieceGetSource(
    request: PieceGetSourceRequest,
  ): Promise<PieceSourceResponse> {
    const pieces = this.#getSpaceCtx(request.space);
    // The reader syncs the piece itself, as its first step.
    const cell = this.#runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(request.pieceId),
      [],
      undefined,
      undefined,
      request.scope,
    );
    // Synced first, so that the labels it is decided on are the document's.
    await cell.sync();
    return await this.#hostReadGate.fromMetadata(cell, async (decided) => {
      const state = await readPieceSourceState(this.#runtime, decided);
      return { source: { ...state, space: state.space as DID } };
    });
  }

  async handlePieceGetSourceRevision(
    request: PieceGetSourceRevisionRequest,
  ): Promise<PieceSourceRevisionResponse> {
    const pieces = this.#getSpaceCtx(request.space);
    const cell = this.#runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(request.pieceId),
      [],
      undefined,
      undefined,
      request.scope,
    );
    await cell.sync();
    return await this.#hostReadGate.fromMetadata(cell, async (decided) => ({
      source: await readPieceSourceRevision(
        this.#runtime,
        decided,
        request.revisionId,
      ),
    }));
  }

  /** Clone a source piece into another space. */
  async handlePieceClone(request: PieceCloneRequest): Promise<PieceResponse> {
    const sourcePieces = this.#getSpaceCtx(request.sourceSpace);
    const sourceCell = this.#runtime.getCellFromEntityId(
      sourcePieces.getSpace(),
      entityIdFrom(request.pieceId),
      [],
      undefined,
      undefined,
      request.scope,
    );
    const source = new PieceController(sourcePieces, sourceCell);
    const clone = await source.cloneTo(
      this.#getSpaceCtx(request.destinationSpace),
      { copyData: request.copyData === true },
    );
    return { piece: this.#hostReadGate.pieceRef(clone.getCell()) };
  }

  async handlePieceUpdateSource(
    request: PieceUpdateSourceRequest,
  ): Promise<PieceUpdateSourceResponse> {
    if (
      request.confirmationToken !== undefined &&
      (typeof request.confirmationToken !== "string" ||
        request.confirmationToken.length === 0)
    ) {
      throw new Error("confirmationToken must be a non-empty string");
    }
    const pieces = this.#getSpaceCtx(request.space);
    // Keyed on the piece's whole address, and on its bare hash rather than on
    // the request's spelling of it: a caller may prepare a change under one
    // accepted address form and confirm it under the other, and both must
    // reach the one pending entry. The scope is part of that address, so a
    // confirmation prepared against one document cannot be spent against the
    // same-id document in another scope.
    const confirmationKey = `${request.space}\u0000${
      request.scope ?? "space"
    }\u0000${hashStringForEntityAddress(request.pieceId)}`;
    let confirmedChange: PreparedPieceSourceChange | undefined;
    if (request.confirmationToken === undefined) {
      this.#pieceSourceConfirmations.delete(confirmationKey);
    } else {
      const pending = this.#pieceSourceConfirmations.get(confirmationKey);
      this.#pieceSourceConfirmations.delete(confirmationKey);
      if (
        pending === undefined ||
        pending.token !== request.confirmationToken
      ) {
        throw new Error(
          "the piece source compatibility confirmation is no longer valid",
        );
      }
      confirmedChange = pending.prepared;
    }
    const cell = this.#runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(request.pieceId),
      [],
      undefined,
      undefined,
      request.scope,
    );
    // A piece whose source the display ceiling keeps from the host is not
    // changed through it: decided on the piece's metadata, once synced, before
    // anything is changed.
    await cell.sync();
    return await this.#hostReadGate.fromMetadata(
      cell,
      (decided) =>
        this.#changePieceSource(
          pieces,
          decided,
          request,
          confirmationKey,
          confirmedChange,
        ),
    );
  }

  /** Helper for {@link handlePieceUpdateSource}, once the read is admitted. */
  async #changePieceSource(
    pieces: PiecesController,
    cell: Cell<unknown>,
    request: PieceUpdateSourceRequest,
    confirmationKey: string,
    confirmedChange: PreparedPieceSourceChange | undefined,
  ): Promise<PieceUpdateSourceResult> {
    const controller = new PieceController(pieces, cell);
    const result = await controller.changeSource(request.action, {
      confirmedChange,
    });
    let confirmationToken: string | undefined;
    if (result.status === "incompatible") {
      confirmationToken = crypto.randomUUID();
      this.#pieceSourceConfirmations.set(confirmationKey, {
        token: confirmationToken,
        prepared: result.prepared,
      });
    }
    const appliedState = result.status === "applied"
      ? readPieceSourceMetadata(this.#runtime, cell)
      : undefined;
    let state;
    let sourceReadWarning: string | undefined;
    try {
      state = await readPieceSourceState(this.#runtime, cell);
    } catch (error) {
      if (result.status !== "applied") throw error;
      state = appliedState!;
      sourceReadWarning = `source details could not be refreshed: ${
        describeFailure(error)
      }`;
    }
    const executionWarning = result.status === "applied"
      ? [result.executionWarning, sourceReadWarning]
        .filter((message): message is string => message !== undefined)
        .join("; ") || undefined
      : undefined;
    const executionResponse = executionWarning === undefined
      ? {}
      : { executionWarning };
    return {
      source: { ...state, space: state.space as DID },
      ...executionResponse,
      ...(result.status === "incompatible"
        ? {
          compatibilityWarning: result.message,
          confirmationToken,
        }
        : {}),
    };
  }

  async handleSpaceGetAcl(
    request: SpaceGetAclRequest,
  ): Promise<SpaceAclResponse> {
    this.#getSpaceCtx(request.space);
    const acl = await new ACLManager(this.#runtime, request.space).get();
    return spaceAclResponse(this.#runtime, request.space, acl);
  }

  async handleSpaceSetAclEntry(
    request: SpaceSetAclEntryRequest,
  ): Promise<SpaceAclResponse> {
    if (!isACLUser(request.user)) {
      throw new Error("user must be `*` or a valid DID");
    }
    if (!isCapability(request.capability)) {
      throw new Error("capability must be `READ`, `WRITE`, or `OWNER`");
    }
    this.#getSpaceCtx(request.space);
    const manager = new ACLManager(this.#runtime, request.space);
    const acl = await manager.set(request.user, request.capability);
    return spaceAclResponse(
      this.#runtime,
      request.space,
      acl,
    );
  }

  async handleSpaceRemoveAclEntry(
    request: SpaceRemoveAclEntryRequest,
  ): Promise<SpaceAclResponse> {
    if (!isACLUser(request.user)) {
      throw new Error("user must be `*` or a valid DID");
    }
    this.#getSpaceCtx(request.space);
    const manager = new ACLManager(this.#runtime, request.space);
    const acl = await manager.remove(request.user);
    return spaceAclResponse(
      this.#runtime,
      request.space,
      acl,
    );
  }

  handleRegisterSpaceHost(
    request: RegisterSpaceHostRequest,
  ): BooleanResponse {
    return {
      value: this.#runtime.registerSpaceHost(request.space, request.host),
    };
  }

  handleRegisterSpaceHostDetailed(
    request: RegisterSpaceHostDetailedRequest,
  ): SpaceHostRegistrationResponse {
    return {
      registration: this.#runtime.registerSpaceHostDetailed(
        request.space,
        request.host,
      ),
    };
  }

  /** Forwards to `Runtime.retrySpaceAccess()`, and resolves once it has. */
  async handleRetrySpaceAccess(
    request: RetrySpaceAccessRequest,
  ): Promise<void> {
    await this.#runtime.retrySpaceAccess(request.space);
  }

  async handleCreateSpace(
    request: CreateSpaceRequest,
  ): Promise<SpaceResponse> {
    await this.#ensureHomePattern();
    return { space: await this.#homeController().createSpace(request.label) };
  }

  /** Convergence across every opened space — no space named, none implied. */
  async handleRuntimeSynced(): Promise<void> {
    await Promise.all(
      [...this.#spaces.values()].map((pieces) => pieces.synced()),
    );
  }

  getGraphSnapshot(_: GetGraphSnapshotRequest): GraphSnapshotResponse {
    return { snapshot: this.#runtime.scheduler.getGraphSnapshot() };
  }

  getLoggerCounts(_: GetLoggerCountsRequest): LoggerCountsResponse {
    const counts = getLoggerCountsBreakdown();
    const metadata = loggerMetadata();
    const timing = getTimingStatsBreakdown();
    const flags = getLoggerFlagsBreakdown();
    assertFabricLoggerFlags(flags);
    return {
      counts,
      metadata,
      timing,
      flags,
      cfc: this.#runtime.getCfcStats(),
    };
  }

  setLoggerLevel(request: SetLoggerLevelRequest): void {
    const loggers = this.#getLoggers(request.loggerName);
    for (const logger of loggers) {
      logger.level = request.level;
    }
  }

  setLoggerEnabled(request: SetLoggerEnabledRequest): void {
    const loggers = this.#getLoggers(request.loggerName);
    for (const logger of loggers) {
      logger.disabled = !request.enabled;
    }
  }

  setTelemetryEnabled(request: SetTelemetryEnabledRequest): void {
    this.#telemetryEnabled = request.enabled;
    this.#runtime.scheduler.setEventPreflightTelemetryEnabled(request.enabled);
  }

  /** Sets body accounting independently of telemetry transport. */
  setReadStatsEnabled(request: SetReadStatsEnabledRequest): void {
    this.#runtime.scheduler.setReadStatsEnabled(request.enabled);
  }

  /** Changes memory-message compression for every remote storage session. */
  async setMemoryMessageCompression(
    request: SetMemoryMessageCompressionRequest,
  ): Promise<void> {
    await this.#runtime.storageManager.setMessageCompressionEnabled?.(
      request.enabled,
    );
  }

  resetLoggerBaselines(_: any): void {
    resetAllCountBaselines();
    resetAllTimingBaselines();
  }

  #getLoggers(loggerName?: string): Logger[] {
    const global = globalThis as unknown as {
      commonfabric?: { logger?: Record<string, Logger> };
    };
    if (!global.commonfabric?.logger) {
      return [];
    }
    if (loggerName) {
      const logger = global.commonfabric.logger[loggerName];
      return logger ? [logger] : [];
    }
    return Object.values(global.commonfabric.logger);
  }

  #onTelemetry = (event: Event) => {
    if (!this.#telemetryEnabled) return;
    const { marker, consumed } = event as RuntimeTelemetryEvent;
    postToClient(
      this.#hostReadGate.telemetry(marker, this.#documentAt, consumed),
    );
  };

  /** The root of the document a diagnostic names, which it is decided on. */
  #documentAt: DocumentAt = (space, id, scope) =>
    this.#runtime.getCellFromLink({
      space: space as DID,
      id: id as `${string}:${string}`,
      path: [],
      ...(scope === undefined ? {} : { scope }),
    });

  getPatternSources(
    _request: GetPatternSourcesRequest,
  ): PatternSourcesResponse {
    const snapshot = this.#runtime.scheduler.getGraphSnapshot();
    const seen = new Set<string>();
    const patterns: PatternSourceInfo[] = [];

    for (const node of snapshot.nodes) {
      const ref = node.patternIdentity;
      if (!ref || seen.has(ref.identity)) continue;
      seen.add(ref.identity);
      // Best-effort source view for LIVE patterns: resolve the running
      // pattern by identity and read its authored files (source is per
      // module, so the symbol only selects a representative artifact). A
      // source-free by-identity reload carries no program, so that pattern is
      // omitted.
      const program = this.#runtime.patternManager.getPatternProgramBySync(
        ref.identity,
        ref.symbol,
      );
      if (program) {
        patterns.push({
          identity: ref.identity,
          files: program.files.map((f) => ({
            name: f.name,
            contents: f.contents,
          })),
          ...(program.dataFiles === undefined
            ? {}
            : { dataFiles: program.dataFiles }),
        });
      }
    }
    return { patterns };
  }

  setBreakpoints(request: SetBreakpointsRequest): void {
    this.#runtime.scheduler.setBreakpoints(request.actionIds);
  }

  async handleUploadBlob(
    request: UploadBlobRequest,
  ): Promise<UploadBlobResponse> {
    // A request arrives as data, so its `space` is checked here. A request
    // whose `space` is not a DID fails with an error that says so. Without the
    // check, a request with no `space` would build an upload URL whose path
    // begins `/undefined/blobs/`.
    if (!isDID(request.space)) {
      throw new Error("uploadBlob requires a space DID");
    }
    const suffix = (request.suffix ?? "bin").replace(/^\./, "") || "bin";
    // The blob belongs to the named space, so it uploads to — and its
    // returned URL resolves against — THAT space's host.
    const host = this.#runtime.hostForSpace(request.space);
    const target = new URL(
      `/${request.space}/blobs/upload.${encodeURIComponent(suffix)}`,
      host,
    );
    // The envelope's decode already produced this; `request.body` is a
    // `FabricBytes` by the time it arrives, and a handler owns the values its
    // request carries per `BaseRequest`, so nothing else is reading it. The
    // check is on the arm rather than the decode: the declared type is what
    // the client is meant to send, not what a malformed message can hold.
    const bytes = request.body;
    if (!(bytes instanceof FabricBytes)) {
      throw new Error("uploadBlob requires bytes as its body");
    }
    // Blob upload payloads must preserve FabricBytes even when the wider
    // process is running with legacy memory JSON flags.
    const body = blobUploadCodec.encode({
      type: request.contentType,
      body: bytes,
    });
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) {
      throw new Error(
        `Blob upload failed: ${response.status} ${await response.text()}`,
      );
    }
    const result = await response.json() as Partial<UploadBlobResponse>;
    if (typeof result.id !== "string" || typeof result.url !== "string") {
      throw new Error("Blob upload returned an invalid response");
    }
    return {
      id: result.id,
      url: resolveBlobUrl(result.url, host, request.space),
    };
  }

  async detectNonIdempotent(
    request: DetectNonIdempotentRequest,
  ): Promise<DetectNonIdempotentResponse> {
    const result = await this.#runtime.scheduler.runDiagnosis(
      request.durationMs,
    );
    return this.#hostReadGate.diagnosis(result, this.#documentAt);
  }

  getPatternCoverage(_: GetPatternCoverageRequest): PatternCoverageResponse {
    return { data: this.#runtime.patternCoverage?.toData() ?? null };
  }

  getSettleStats(
    _request: GetSettleStatsRequest,
  ): SettleStatsResponse {
    return {
      stats: this.#runtime.scheduler.getSettleStats(),
    };
  }

  getSettleStatsHistory(
    _request: GetSettleStatsHistoryRequest,
  ): SettleStatsHistoryResponse {
    return {
      history: this.#runtime.scheduler.getSettleStatsHistory(),
    };
  }

  setSettleStatsEnabled(
    request: SetSettleStatsEnabledRequest,
  ): void {
    this.#runtime.scheduler.setSettleStatsEnabled(request.enabled);
  }

  getActionRunTrace(
    _request: GetActionRunTraceRequest,
  ): ActionRunTraceResponse {
    return {
      trace: this.#runtime.scheduler.getActionRunTrace(),
    };
  }

  setActionRunTraceEnabled(
    request: SetActionRunTraceEnabledRequest,
  ): void {
    this.#runtime.scheduler.setActionRunTraceEnabled(request.enabled);
  }

  getTriggerTrace(
    _request: GetTriggerTraceRequest,
  ): TriggerTraceResponse {
    return this.#hostReadGate.triggerTrace(
      this.#runtime.scheduler.getTriggerTrace(),
      this.#documentAt,
    );
  }

  setTriggerTraceEnabled(
    request: SetTriggerTraceEnabledRequest,
  ): void {
    this.#runtime.scheduler.setTriggerTraceEnabled(request.enabled);
  }

  getWriteStackTrace(
    _request: GetWriteStackTraceRequest,
  ): WriteStackTraceResponse {
    return {
      trace: this.#runtime.getWriteStackTrace(),
    };
  }

  setWriteStackTraceMatchers(
    request: SetWriteStackTraceMatchersRequest,
  ): void {
    this.#runtime.setWriteStackTraceMatchers(request.matchers);
  }

  async handleRequest(
    request: IPCClientRequest,
    client: WorkerClient = ownerClient,
  ): Promise<RemoteResponse | void> {
    switch (request.type) {
      case RequestType.Dispose:
        return answering(RequestType.Dispose, await this.dispose());
      case RequestType.CellGet:
        return answering(RequestType.CellGet, await this.#settledGet(request));
      case RequestType.CellPull:
        return answering(
          RequestType.CellPull,
          await this.handleCellPull(request),
        );
      case RequestType.CellInitialize:
        return answering(
          RequestType.CellInitialize,
          await this.handleCellInitialize(request),
        );
      case RequestType.CellSet:
        return answering(RequestType.CellSet, this.handleCellSet(request));
      case RequestType.CellPush:
        return answering(RequestType.CellPush, this.handleCellPush(request));
      case RequestType.CellSend:
        return answering(RequestType.CellSend, this.handleCellSend(request));
      case RequestType.CellSubscribe:
        return answering(
          RequestType.CellSubscribe,
          this.handleCellSubscribe(request, client),
        );
      case RequestType.CellUnsubscribe:
        return answering(
          RequestType.CellUnsubscribe,
          this.handleCellUnsubscribe(request, client),
        );
      case RequestType.CellResolveAsCell:
        return answering(
          RequestType.CellResolveAsCell,
          this.handleCellResolveAsCell(request),
        );
      case RequestType.CellGetCfcLabel:
        return answering(
          RequestType.CellGetCfcLabel,
          await this.handleCellGetCfcLabel(request),
        );
      case RequestType.CellFields:
        return answering(
          RequestType.CellFields,
          await this.handleCellFields(request),
        );
      case RequestType.SnapshotSharePrepare:
        return answering(
          RequestType.SnapshotSharePrepare,
          await this.handleSnapshotSharePrepare(request, client),
        );
      case RequestType.SnapshotShareCommit:
        return answering(
          RequestType.SnapshotShareCommit,
          await this.handleSnapshotShareCommit(request, client),
        );
      case RequestType.SnapshotShareCancel:
        this.#snapshotShares.delete(clientScopedKey(client, request.id));
        return;
      case RequestType.CustodySealPrepare:
        return answering(
          RequestType.CustodySealPrepare,
          await this.handleCustodySealPrepare(request, client),
        );
      case RequestType.CustodySealCommit:
        return answering(
          RequestType.CustodySealCommit,
          await this.handleCustodySealCommit(request, client),
        );
      case RequestType.CustodySealCancel:
        this.#custodySeals.delete(clientScopedKey(client, request.id));
        return;
      case RequestType.CustodyAnswerPublish:
        return answering(
          RequestType.CustodyAnswerPublish,
          await this.handleCustodyAnswerPublish(request),
        );
      case RequestType.CustodyAnswerRead:
        return answering(
          RequestType.CustodyAnswerRead,
          await this.handleCustodyAnswerRead(request),
        );
      case RequestType.OperationQuery:
        return answering(
          RequestType.OperationQuery,
          await this.handleOperationQuery(request, client),
        );
      case RequestType.OperationCapabilities:
        return answering(
          RequestType.OperationCapabilities,
          await this.handleOperationCapabilities(request, client),
        );
      case RequestType.OperationApply:
        return answering(
          RequestType.OperationApply,
          await this.handleOperationApply(request, client),
        );
      case RequestType.OperationRelease:
        return answering(
          RequestType.OperationRelease,
          await this.handleOperationRelease(request, client),
        );
      case RequestType.OperationSubscribe:
        return answering(
          RequestType.OperationSubscribe,
          await this.handleOperationSubscribe(request, client),
        );
      case RequestType.OperationUnsubscribe:
        return answering(
          RequestType.OperationUnsubscribe,
          this.handleOperationUnsubscribe(request, client),
        );
      case RequestType.OperationSessionClose:
        return answering(
          RequestType.OperationSessionClose,
          this.handleOperationSessionClose(request, client),
        );
      case RequestType.PresenceJoin:
        return answering(
          RequestType.PresenceJoin,
          await this.handlePresenceJoin(request, client),
        );
      case RequestType.PresencePublish:
        return answering(
          RequestType.PresencePublish,
          this.handlePresencePublish(request, client),
        );
      case RequestType.PresenceLeave:
        return answering(
          RequestType.PresenceLeave,
          await this.handlePresenceLeave(request, client),
        );
      case RequestType.SqliteQuery:
        return answering(
          RequestType.SqliteQuery,
          await this.handleSqliteQuery(request),
        );
      case RequestType.SqliteExec:
        return answering(
          RequestType.SqliteExec,
          await this.handleSqliteExec(request),
        );
      case RequestType.GetCell:
        return answering(RequestType.GetCell, this.handleGetCell(request));
      case RequestType.GetHomeSpaceCell:
        return answering(
          RequestType.GetHomeSpaceCell,
          this.handleGetHomeSpaceCell(request),
        );
      case RequestType.EnsureHomePatternRunning:
        return answering(
          RequestType.EnsureHomePatternRunning,
          await this.handleEnsureHomePatternRunning(request),
        );
      case RequestType.Idle:
        return answering(RequestType.Idle, await this.handleIdle());
      case RequestType.ListEventAttention:
        return answering(
          RequestType.ListEventAttention,
          await this.handleListEventAttention(request),
        );
      case RequestType.ResolveEventAttention:
        return answering(
          RequestType.ResolveEventAttention,
          await this.handleResolveEventAttention(request),
        );
      case RequestType.FlushCompileCacheWrites:
        return answering(
          RequestType.FlushCompileCacheWrites,
          await this.handleFlushCompileCacheWrites(),
        );
      case RequestType.PieceCreate:
        return answering(
          RequestType.PieceCreate,
          await this.handlePieceCreate(
            request,
          ),
        );
      case RequestType.GetSpaceRootPattern:
        return answering(
          RequestType.GetSpaceRootPattern,
          await this.handleGetSpaceRootPattern(
            request,
          ),
        );
      case RequestType.RecreateSpaceRootPattern:
        return answering(
          RequestType.RecreateSpaceRootPattern,
          await this.handleRecreateSpaceRootPattern(
            request,
          ),
        );
      case RequestType.PieceGet:
        return answering(
          RequestType.PieceGet,
          await this.handlePieceGet(request),
        );
      case RequestType.PieceGetSlug:
        return answering(
          RequestType.PieceGetSlug,
          await this.handlePieceGetSlug(request),
        );
      case RequestType.SlugResolve:
        return answering(
          RequestType.SlugResolve,
          await this.handleSlugResolve(request),
        );
      case RequestType.PieceRemove:
        return answering(
          RequestType.PieceRemove,
          await this.handlePieceRemove(request),
        );
      case RequestType.PieceStart:
        return answering(
          RequestType.PieceStart,
          await this.handlePieceStart(request),
        );
      case RequestType.PieceStop:
        return answering(
          RequestType.PieceStop,
          await this.handlePieceStop(request),
        );
      case RequestType.PieceGetAll:
        return answering(
          RequestType.PieceGetAll,
          await this.handlePieceGetAll(request),
        );
      case RequestType.PieceGetSource:
        return answering(
          RequestType.PieceGetSource,
          await this.handlePieceGetSource(request),
        );
      case RequestType.PieceGetSourceRevision:
        return answering(
          RequestType.PieceGetSourceRevision,
          await this.handlePieceGetSourceRevision(request),
        );
      case RequestType.PieceClone:
        return answering(
          RequestType.PieceClone,
          await this.handlePieceClone(request),
        );
      case RequestType.PieceUpdateSource:
        return answering(
          RequestType.PieceUpdateSource,
          await this.handlePieceUpdateSource(request),
        );
      case RequestType.SpaceGetAcl:
        return answering(
          RequestType.SpaceGetAcl,
          await this.handleSpaceGetAcl(request),
        );
      case RequestType.SpaceSetAclEntry:
        return answering(
          RequestType.SpaceSetAclEntry,
          await this.handleSpaceSetAclEntry(request),
        );
      case RequestType.SpaceRemoveAclEntry:
        return answering(
          RequestType.SpaceRemoveAclEntry,
          await this.handleSpaceRemoveAclEntry(request),
        );
      case RequestType.PieceSynced:
        return answering(
          RequestType.PieceSynced,
          await this.handlePieceSynced(request),
        );
      case RequestType.RuntimeSynced:
        return answering(
          RequestType.RuntimeSynced,
          await this.handleRuntimeSynced(),
        );
      case RequestType.CreateSpace:
        return answering(
          RequestType.CreateSpace,
          await this.handleCreateSpace(request),
        );
      case RequestType.RegisterSpaceHost:
        return answering(
          RequestType.RegisterSpaceHost,
          this.handleRegisterSpaceHost(request),
        );
      case RequestType.RegisterSpaceHostDetailed:
        return answering(
          RequestType.RegisterSpaceHostDetailed,
          this.handleRegisterSpaceHostDetailed(request),
        );
      case RequestType.RetrySpaceAccess:
        return answering(
          RequestType.RetrySpaceAccess,
          await this.handleRetrySpaceAccess(request),
        );
      case RequestType.GetGraphSnapshot:
        return answering(
          RequestType.GetGraphSnapshot,
          this.getGraphSnapshot(request),
        );
      case RequestType.GetStorageDiagnostics:
        return answering(RequestType.GetStorageDiagnostics, {
          diagnostics: this.#runtime.storageManager.getDiagnostics?.() ?? null,
        });
      case RequestType.GetLoggerCounts:
        return answering(
          RequestType.GetLoggerCounts,
          this.getLoggerCounts(request),
        );
      case RequestType.GetPatternCoverage:
        return answering(
          RequestType.GetPatternCoverage,
          this.getPatternCoverage(request),
        );
      case RequestType.SetLoggerLevel:
        return answering(
          RequestType.SetLoggerLevel,
          this.setLoggerLevel(request),
        );
      case RequestType.SetLoggerEnabled:
        return answering(
          RequestType.SetLoggerEnabled,
          this.setLoggerEnabled(request),
        );
      case RequestType.SetTelemetryEnabled:
        return answering(
          RequestType.SetTelemetryEnabled,
          this.setTelemetryEnabled(request),
        );
      case RequestType.SetReadStatsEnabled:
        return answering(
          RequestType.SetReadStatsEnabled,
          this.setReadStatsEnabled(request),
        );
      case RequestType.SetMemoryMessageCompression:
        return answering(
          RequestType.SetMemoryMessageCompression,
          await this.setMemoryMessageCompression(request),
        );
      case RequestType.ResetLoggerBaselines:
        return answering(
          RequestType.ResetLoggerBaselines,
          this.resetLoggerBaselines(request),
        );
      case RequestType.GetSettleStats:
        return answering(
          RequestType.GetSettleStats,
          this.getSettleStats(request),
        );
      case RequestType.GetSettleStatsHistory:
        return answering(
          RequestType.GetSettleStatsHistory,
          this.getSettleStatsHistory(request),
        );
      case RequestType.SetSettleStatsEnabled:
        return answering(
          RequestType.SetSettleStatsEnabled,
          this.setSettleStatsEnabled(request),
        );
      case RequestType.GetActionRunTrace:
        return answering(
          RequestType.GetActionRunTrace,
          this.getActionRunTrace(request),
        );
      case RequestType.SetActionRunTraceEnabled:
        return answering(
          RequestType.SetActionRunTraceEnabled,
          this.setActionRunTraceEnabled(request),
        );
      case RequestType.GetTriggerTrace:
        return answering(
          RequestType.GetTriggerTrace,
          this.getTriggerTrace(request),
        );
      case RequestType.SetTriggerTraceEnabled:
        return answering(
          RequestType.SetTriggerTraceEnabled,
          this.setTriggerTraceEnabled(request),
        );
      case RequestType.GetWriteStackTrace:
        return answering(
          RequestType.GetWriteStackTrace,
          this.getWriteStackTrace(request),
        );
      case RequestType.SetWriteStackTraceMatchers:
        return answering(
          RequestType.SetWriteStackTraceMatchers,
          this.setWriteStackTraceMatchers(request),
        );
      case RequestType.DetectNonIdempotent:
        return answering(
          RequestType.DetectNonIdempotent,
          await this.detectNonIdempotent(request),
        );
      case RequestType.GetPatternSources:
        return answering(
          RequestType.GetPatternSources,
          this.getPatternSources(request),
        );
      case RequestType.SetBreakpoints:
        return answering(
          RequestType.SetBreakpoints,
          this.setBreakpoints(request),
        );
      case RequestType.UploadBlob:
        return answering(
          RequestType.UploadBlob,
          await this.handleUploadBlob(request),
        );
      case RequestType.VDomMount:
        return answering(
          RequestType.VDomMount,
          this.handleVDomMount(request, client),
        );
      case RequestType.VDomUnmount:
        return answering(
          RequestType.VDomUnmount,
          this.handleVDomUnmount(request, client),
        );
      default:
        throw new Error(`Unknown message type: ${(request as any).type}`);
    }
  }

  /**
   * Dispatch a one-way notification from the main thread. There is no response
   * channel back to the sender, so handlers return void; a throw propagates to
   * the worker message loop, which logs it worker-side.
   */
  handleNotification(
    notification: IPCClientNotification,
    client: WorkerClient = ownerClient,
  ): void {
    switch (notification.type) {
      case ClientNotificationType.VDomEvent:
        return this.handleVDomEvent(notification, client);
      case ClientNotificationType.VDomBatchApplied:
        return this.handleVDomBatchApplied(notification, client);
      default:
        console.warn(
          `[RuntimeProcessor] Unknown notification type: ${
            (notification as any).type
          }`,
        );
    }
  }

  /**
   * Handle a DOM event dispatched from the main thread. It reaches the
   * reconciler of the sending client's own mount, so one document's events
   * never find another document's handlers.
   */
  handleVDomEvent(
    request: VDomEventNotification,
    client: WorkerClient = ownerClient,
  ): void {
    const mount = this.#vdomMounts.get(
      clientScopedKey(client, request.mountId),
    );
    if (!mount) {
      console.warn(
        `[RuntimeProcessor] No mount found for mountId: ${request.mountId}`,
      );
      return;
    }

    // `request.event` comes from the main thread and can hold sigil links. A
    // sigil link is not a `CellRef`, so it passes through neither `getCell()`
    // nor `cellRefToSigilLink()`, which are what drop a ref's `cfcLabelView`.
    // We strip the view from each link here, before a handler can write one.
    const dispatched = mount.reconciler.dispatchEvent(
      request.handlerId,
      stripSigilCfcLabelViews(request.event) as typeof request.event,
    );
    if (!dispatched) {
      console.warn(
        `[RuntimeProcessor] No handler found for mountId: ${request.mountId}, handlerId: ${request.handlerId}`,
      );
    }
  }

  /**
   * Takes the render policy from `data`: the declassification policy and the
   * ceiling, each normalized, and the membership provider, module-policy
   * source and resolver derived from them. Every mount's reconciler is built
   * from these, and so is the host-read gate, which is why it is rebuilt
   * here: a host's read is decided under the same root policy, by the same
   * fit, as a render of the same cell, so the two never disagree about what
   * the host may see.
   */
  #configureRenderPolicy(data: RenderPolicyConfiguration): HostReadGate {
    // InitializationData crosses postMessage with no runtime validation, so a
    // typo'd host config or version-skewed peer must fail CLOSED, not open:
    // any present-but-unknown value becomes "deny"; absent stays "allow".
    this.#renderDeclassificationPolicy = normalizeRenderDeclassificationPolicy(
      data.renderDeclassificationPolicy,
    );
    this.#renderConfidentialityCeiling = normalizeRenderConfidentialityCeiling(
      data.renderConfidentialityCeiling,
    );
    this.#renderMembershipProvider = renderMembershipProviderFor(
      this.#runtime,
      this.#identity,
      this.#renderConfidentialityCeiling,
    );
    this.#renderModulePolicySource = renderModulePolicySourceFor(
      this.#runtime,
      this.#renderConfidentialityCeiling,
    );
    this.#renderConfidentialityResolver = renderConfidentialityResolverFor(
      this.#runtime,
      this.#identity,
      this.#renderConfidentialityCeiling,
      this.#workspace,
      this.#renderMembershipProvider,
      this.#renderModulePolicySource,
    );
    this.#hostReadGate = new HostReadGate(
      rootRenderPolicyFor(this.#renderConfidentialityCeiling),
      {
        resolveConfidentiality: this.#renderConfidentialityResolver,
        membership: this.#renderMembershipProvider,
        modulePolicies: this.#renderModulePolicySource,
      },
    );
    return this.#hostReadGate;
  }

  /**
   * Handle a request to start VDOM rendering for a cell.
   * Creates a WorkerReconciler, subscribes to the cell, and sends VDomBatch notifications.
   */
  handleVDomMount(
    request: VDomMountRequest,
    client: WorkerClient = ownerClient,
  ): VDomMountResponse | Promise<VDomMountResponse> {
    const { mountId, cell: cellRef } = request;
    const key = clientScopedKey(client, mountId);

    // Check if already mounted. Scoped to this client, so a second client
    // mounting under the same id mounts rather than displacing the first.
    if (this.#vdomMounts.has(key)) {
      this.handleVDomUnmount(
        { type: RequestType.VDomUnmount, mountId },
        client,
      );
    }

    // Get the cell from the runtime and apply rendererVDOMSchema
    // The schema has a [UI] property definition that handles VDOM unwrapping
    const rawCell = getCell(this.#runtime, cellRef);
    const cell = rawCell.asSchema(rendererVDOMSchema);

    // Create a reconciler that sends ops to the main thread
    const reconciler = new WorkerReconciler({
      renderDeclassificationPolicy: this.#renderDeclassificationPolicy,
      renderConfidentialityCeiling: this.#renderConfidentialityCeiling,
      resolveRenderConfidentiality: this.#renderConfidentialityResolver,
      membershipProvider: this.#renderMembershipProvider,
      modulePolicySource: this.#renderModulePolicySource,
      spaceAccess: renderSpaceAccessProviderFor(this.#runtime),
      onOps: (ops: VDomOp[]) => {
        const batchId = this.#vdomBatchIdCounter++;
        // `mountId` as the client sent it: the scoping is this worker's
        // bookkeeping, and the client knows its mounts by its own ids.
        client.post({
          type: NotificationType.VDomBatch,
          batchId,
          ops,
          mountId,
          rootId: reconciler.getRootNodeId(),
        });
        return batchId;
      },
      onError: mountErrorSink(client, this.#hostReadGate),
    });

    let active = true;
    let cancelRender: (() => void) | undefined;
    let cancelView: (() => void) | undefined;
    const mount = {
      reconciler,
      client,
      cancel: () => {
        active = false;
        cancelRender?.();
        cancelView?.();
      },
    };
    this.#vdomMounts.set(key, mount);
    const render = () => {
      if (active) cancelRender = reconciler.mount(cell);
      return { rootId: reconciler.getRootNodeId() };
    };
    if (!this.#runtime.viewScopedReplicationRequested) return render();
    return this.#runtime.viewReplication.mount(
      rawCell,
      key,
      mountErrorSink(client, this.#hostReadGate),
    ).then((cancel) => {
      if (!active) cancel?.();
      else cancelView = cancel;
      return render();
    }).catch((error) => {
      mount.cancel();
      reconciler.unmount();
      if (this.#vdomMounts.get(key) === mount) this.#vdomMounts.delete(key);
      throw error;
    });
  }

  /**
   * Handle a request to stop VDOM rendering for a mount.
   */
  handleVDomUnmount(
    request: VDomUnmountRequest,
    client: WorkerClient = ownerClient,
  ): void {
    const { mountId } = request;

    const mount = this.#vdomMounts.get(clientScopedKey(client, mountId));
    if (!mount) {
      console.warn(`[RuntimeProcessor] Mount ${mountId} not found for unmount`);
      return;
    }

    // Cancel subscriptions and clean up
    mount.cancel();
    mount.reconciler.unmount();
    this.#vdomMounts.delete(clientScopedKey(client, mountId));
  }

  handleVDomBatchApplied(
    request: VDomBatchAppliedNotification,
    client: WorkerClient = ownerClient,
  ): void {
    const mount = this.#vdomMounts.get(
      clientScopedKey(client, request.mountId),
    );
    if (!mount) {
      return;
    }
    mount.reconciler.acknowledgeBatchApplied(request.batchId);
  }

  //
  // Static members
  //

  /**
   * The constructor, which `initialize()` otherwise keeps to itself, so that
   * a test builds a real instance over the collaborators it supplies.
   */
  static get accessForTestingOnly(): {
    construct(
      runtime: Runtime,
      cc: PiecesController,
      initSpace: DID,
      identity: Identity,
      telemetry: RuntimeTelemetry,
      securityContext: RuntimeSecurityContext,
      renderPolicy?: RenderPolicyConfiguration,
    ): RuntimeProcessor;
  } {
    return {
      construct: (
        runtime,
        cc,
        initSpace,
        identity,
        telemetry,
        securityContext,
        renderPolicy = {},
      ) =>
        new RuntimeProcessor(
          runtime,
          cc,
          initSpace,
          identity,
          telemetry,
          securityContext,
          renderPolicy,
        ),
    };
  }

  /**
   * Constructs the worker's processor from the host's `InitializationData`:
   * opens storage and a runtime for the home space as the given identity,
   * wires the runtime's console, navigation, piece-creation, and error
   * bridges to `postToClient()`, and starts the home-space site-table watch.
   * Rejects when the runtime's server-execution posture diverges from what
   * the host declared, or, with `awaitHealth`, when a host fails the health
   * check. Otherwise the check runs alongside: the returned processor handles
   * requests at once, and a host the check could not reach is reported to
   * the clients connected when it answers. A caller that needs storage and
   * pieces to have converged waits on `synced()`. `clients` resolves the
   * current authorized recipients of runtime-wide notifications.
   */
  static async initialize(
    data: InitializationData,
    clients: () => Iterable<WorkerClient> = () => [ownerClient],
  ): Promise<RuntimeProcessor> {
    const apiUrlObj = new URL(data.apiUrl);
    const identity = await Identity.fromKeyPair(
      data.identity,
    );
    const space = data.spaceDid;
    const telemetry = new RuntimeTelemetry();

    setLLMUrl(data.apiUrl);
    setPatternEnvironment({ apiUrl: apiUrlObj });

    const session = {
      as: identity,
      space: data.spaceDid,
    };

    const storageManager = StorageManager.open({
      as: identity,
      memoryHost: apiUrlObj,
      spaceHostMap: data.spaceHostMap,
      // Host dogfood toggle (commonfabric.concurrentWatchRefresh): overlap
      // watch-refresh round trips up to a bounded window. Off unless the host
      // set it; the default is strict single-flight.
      settings: {
        experimentalConcurrentWatchRefresh:
          data.concurrentWatchRefresh === true,
      },
    });

    // Mirror the durability barrier to the page: `pending` is true while any
    // issued commit is still unconfirmed. The shell keeps the latest value and
    // consults it from its beforeunload handler, so a reload with unconfirmed
    // writes prompts the user instead of silently dropping them.
    storageManager.subscribePendingCommits((pending) => {
      postToClient({
        type: NotificationType.PendingWritesChanged,
        pending,
      });
    });

    let homePieces: PiecesController | undefined = undefined;
    let processor: RuntimeProcessor | undefined = undefined;
    // What decides a console call or an error report the runtime raises
    // before the processor, and its gate, exist: the configured ceiling, with
    // none of the resolver and providers that admit a space's members, so
    // that it refuses what the processor's gate might admit and admits
    // nothing it would refuse.
    const earlyGate = HostReadGate.forConfiguredCeiling(
      data.renderConfidentialityCeiling,
    );
    const gate = () =>
      processor === undefined ? earlyGate : processor.#hostReadGate;
    // Everything below goes through the browserWorker preset: host-decided
    // data via the params mapper, plus this worker's declared deltas (the
    // postMessage bridges for console/navigate/piece/errors).
    const runtime = new Runtime(runtimePresets.browserWorker({
      ...browserWorkerParamsFromInitializationData(
        data,
        storageManager,
        telemetry,
      ),
      consoleHandler: ({ metadata, method, args, consumed }) => {
        // The arguments reach the host as the gate decides, on what the
        // action that logged had read. The worker's own console, in the
        // runtime's own context, is handed them as they are.
        postToClient(
          gate().console(
            { metadata, method },
            args.map((arg) => toConsoleDebugValue(arg)),
            consumed,
          ),
        );
        return args;
      },

      navigateCallback: (target, consumed) => {
        const link = parseLink(target.getAsLink()) as NormalizedFullLink;
        // Where to go is what the action that asked chose, from what it had
        // read, so the gate decides the request on that.
        const request = gate().navigate(link, consumed);
        if (request !== undefined) postToClient(request);
      },

      pieceCreatedCallback: (piece) => {
        const writeContext = runtime.getWriteDebugContext();
        // Register the piece in its own space's list. The piece goes to the
        // controller serving its space, when there is one. Otherwise it goes
        // to the home controller.
        const pieces = (piece.space && processor?.piecesFor(piece.space)) ??
          homePieces;
        if (!pieces) return;
        void runtime.withWriteDebugContext(
          writeContext,
          () => pieces.add([piece]),
        ).catch((e: unknown) => {
          console.error(
            "[RuntimeProcessor] Failed to add created piece:",
            {
              error: e instanceof Error ? e.message : e,
            },
          );
        });
      },

      errorHandlers: [
        (error) =>
          postToClient(
            gate().error(runtimeErrorReport(error), error.consumed),
          ),
      ],
    }));

    assertServerExecutionPostureAgreement(data.experimental, runtime);

    // The check fans out to the default host and every seeded one, so it
    // answers at the pace of the slowest of them. The reply does not wait for
    // it: storage reconnects with its own backoff, and a host that stays
    // unreachable is reported below. The check cannot reject on its own; a
    // rejection is treated as an unreachable host all the same.
    const health = runtime.healthCheck().then(
      (healthy) => healthy,
      () => false,
    );
    if (data.awaitHealth === true && !await health) {
      throw new Error(unreachableHostMessage(data));
    }

    // Allow the worker to acknowledge initialization immediately. Consumers
    // that need storage/piece convergence should call `synced()`.
    homePieces = new PiecesController(session, runtime);

    processor = new RuntimeProcessor(
      runtime,
      homePieces,
      space,
      identity,
      telemetry,
      securityContextFrom(data, identity.did()),
      data,
      clients,
    );
    processor.#health = health;
    processor.#awaitedHealth = data.awaitHealth === true;
    if (!processor.#awaitedHealth) {
      // Nothing between the check and the return awaits, so the host has its
      // reply, and its error listener in place, before this notice can go
      // out. An `await` added on that path would reorder the two.
      const built = processor;
      void health.then((healthy) => {
        if (healthy || built.#isDisposed) return;
        for (const client of clients()) {
          client.post(
            gate().runtimeError({
              code: RuntimeErrorCode.HostUnreachable,
              message: unreachableHostMessage(data),
            }),
          );
        }
      });
    }
    processor.#intentOutcomeCancel = subscribeEventAttentionNotifications(
      runtime,
      undefined,
      (notification) => {
        for (const client of clients()) client.post(notification);
      },
    );
    // The home-space site table carries space-to-host hints, which the
    // runtime reads as its live host lookup. A seeded route or earlier hint
    // can reject an entry. A default-host provider is provisional. Failures
    // here must not block worker boot.
    processor.watchSiteTable();
    try {
      processor.#profilePreloadCancel = preloadProfiles(runtime);
    } catch (error) {
      console.warn("[RuntimeProcessor] Could not preload profiles:", error);
    }
    return processor;
  }
}
