export { decomposeSchema, recomposeSchema } from "./schema-decompose.ts";
export { parseExternalSchemaRef } from "@commonfabric/data-model-schema/schema-refs";
export { lookupSchemaDocument } from "./schema-registry.ts";
export { mapSubschemas } from "@commonfabric/data-model-schema/schema-walk";
export { Runtime } from "./runtime.ts";
export {
  fabricAuthorityMatchesSpaceHost,
  type FabricSpaceHostOptions,
  isLoopbackHostname,
  normalizeSpaceHost,
  spaceHostFromFabricAuthority,
  SpaceHostValidationError,
} from "./space-host.ts";
export type {
  ConsoleHandler,
  ConsoleHandlerOutput,
  ErrorHandler,
  ErrorWithContext as RuntimeErrorWithContext,
  ExperimentalOptions, // Space-model feature flags; see ExperimentalOptions in runtime.ts
  PatternInstantiation,
  PatternInstantiationObserver,
  RuntimeFetch,
  RuntimeOptions,
  SpaceCellContents,
} from "./runtime.ts";
export type { EventIntentOutcome } from "./speculation/overlay-destination.ts";
export {
  ADOPT_SERVER_FLAGS_ENV,
  type BrowserWorkerPresetParams,
  type CfcPosture,
  type DeployedClientExperimentalParams,
  type EnvReader,
  EXPERIMENTAL_ENV_VARS,
  EXPERIMENTAL_FLAG_AUTHORITY,
  type ExperimentalFlagAuthority,
  experimentalOptionsForDeployedClient,
  experimentalOptionsFromEnv,
  MAX_ENFORCEMENT_CFC_OPTIONS,
  MAX_ENFORCEMENT_SINK_CEILINGS,
  MAX_ENFORCEMENT_SINK_GOVERNANCE,
  type PatternTestPresetParams,
  presetCfcOptions,
  type PresetCfcParams,
  type ProductionServerPresetParams,
  type RemoteClientPresetParams,
  RUNTIME_OPTION_KEYS,
  type RuntimeOptionKey,
  runtimePresets,
  SERVER_EXPERIMENTAL_PATH,
  type UnitTestPresetParams,
  withServerExecutionDefault,
} from "./runtime-presets.ts";
export type {
  UnsafeHostTrust,
  UnsafeHostTrustOptions,
} from "./unsafe-host-trust.ts";
export * from "./interface.ts";
export { raw } from "./module.ts";
export type { Cell, Stream } from "./cell.ts";
// The seam's vocabulary, which describes a document's shape and is read by
// hosts. Its write authorization is deliberately not here: it rides the
// `@commonfabric/runner/meta-seam` subpath, so an import of it names the seam
// it opens.
export {
  asPatternIdentityRef,
  isMetaField,
  META_FIELDS,
  META_LINK_FIELDS,
  type MetaField,
  type MetaLinkField,
} from "./meta-seam.ts";
export type { NormalizedFullLink, NormalizedLink } from "./link-types.ts";
export { decodeJsonPointer, encodeJsonPointer } from "./link-types.ts";
export type { SigilLink, URI } from "./sigil-types.ts";
export {
  createRef,
  type EntityId,
  entityIdFrom,
  getEntityId,
  idStringForEntityAddress,
} from "./create-ref.ts";
export type { CellResult as QueryResult } from "./query-result-proxy.ts";
export type {
  Action,
  ErrorWithContext,
  ReactivityLog,
  SettleStats,
} from "./scheduler.ts";
export type {
  ChangeGroup,
  EventAppendDeliveryOutcome,
  IExtendedStorageTransaction,
  IOperationStorageCapability,
  MemorySpace,
  TransactionCommitOptions,
} from "./storage/interface.ts";
export { hasOperationStorageCapability } from "./storage/interface.ts";
export { isCfcEnforcementRejection } from "./storage/rejection.ts";
export type {
  EntityIdListOptions,
  EntityIdListResult,
} from "@commonfabric/memory/v2";
export {
  debugTransactionWrites,
  formatTransactionSummary,
  summarizeTransaction,
  type TransactionSummary,
} from "./storage/transaction-summary.ts";
export {
  type CellLinkInput,
  convertCellsToLinks,
  encodeSqliteParams,
  isCell,
  isReadableCell,
  isStream,
} from "./cell.ts";
export {
  getCellOrThrow,
  isCellResult,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
export { effect } from "./reactivity.ts";
export { type AddCancel, type Cancel, noOp, useCancelGroup } from "./cancel.ts";
export { cellOfOpaqueReference, isOpaqueReference } from "./back-to-cell.ts";
export {
  CompilerStackLoadError,
  computeEntryIdentity,
  Console,
  type ConsoleEvent,
  ConsoleMethod,
  Engine,
  ensureCompilerStack,
  type EntryIdentityOptions,
  resolveEntryIdentity,
  type RuntimeProgram,
  type TypeScriptHarnessProcessOptions,
} from "./harness/index.ts";
export {
  PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
  PATTERN_COVERAGE_TEST_NAME,
  PatternCoverageCollector,
  type PatternCoverageData,
  type PatternCoverageFileReport,
  type PatternCoverageKind,
  patternCoverageOutputPath,
  type PatternCoverageReport,
  type PatternCoverageReportOptions,
  patternCoverageReportToLcov,
  type PatternCoverageSpan,
  writePatternCoverageLcov,
} from "./pattern-coverage.ts";
export {
  type BlindStructuralTarget,
  isRendererInputTx,
  markDurableReadTx,
  markRendererInputTx,
  markUiInputBlindWriteTx,
  setBlindStructuralTarget,
  unmarkUiInputBlindWriteTx,
} from "./storage/reactivity-log.ts";
export {
  resolveLink,
  resolveLinkTracingDereferences,
} from "./link-resolution.ts";
export {
  areLinksSame,
  getMetaLink,
  isCellLink as isLink,
  isWriteRedirectLink,
  KeepAsCell,
  matchLLMFriendlyLink,
  parseLink,
  parseLinkOrThrow,
  parseLLMFriendlyLink,
  sanitizeSchemaForLinks,
} from "./link-utils.ts";
export * from "./pattern-manager.ts";
export {
  createSpaceRootIfAbsent,
  DEFAULT_APP_PATTERN_SOURCE,
  ensureSpaceRootPattern,
  type EnsureSpaceRootResult,
  HOME_PATTERN_SOURCE,
  patternSourceUrl,
  resolveSpaceRootPattern,
  type SpaceRootCreationHooks,
  spaceRootPatternConfig,
} from "./ensure-space-root.ts";
export {
  normalizePatternSource,
  PATTERNS_ROUTE_PREFIX,
  resolveSystemPatternSource,
  SYSTEM_PATTERN_SOURCE_SCHEME,
  systemPatternSource,
} from "./pattern-source-scheme.ts";
export {
  classifyPieceOriginString,
  type PieceOriginKind as PieceOriginClassification,
} from "./piece-origin-kind.ts";
export {
  type ReconcileOutcome,
  SourceReconciler,
} from "./source-reconciler.ts";
export {
  applyPieceSourceTransition,
  extractDefaultValues,
  getPatternIdentityRef,
  getPatternRepository,
  getPatternSetupIdentityRef,
  getPatternSource,
  getPieceReconciliation,
  getPieceSourceRevisions,
  getPieceSourceSnapshot,
  isStoredArgumentSchemaRefusal,
  mergeSchemaDefaults,
  patternIdentityKey,
  type PatternSetupCommitReceipt,
  PatternSetupPostCommitError,
  PIECE_SOURCE_MOVED,
  type PieceReconciliation,
  type PieceReconciliationOutcome,
  type PieceReconciliationReason,
  type PieceSourceRevision,
  type PieceSourceRevisionOperation,
  type PieceSourceSnapshot,
  type PieceSourceTransition,
  type PieceSourceTransitionBaseline,
  preparePieceSourceTransitionBaseline,
  type RunSyncedCommitResult,
  type RunSyncedOptions,
  type RunSyncedWithCommitOptions,
  schemaAcceptsOpaqueCellValue,
  schemaHasDefaultValue,
  SEALING_RECEIPT_REFUSAL,
  SEALING_SOURCE_UPDATE_REFUSAL,
  setPatternRepository,
  setPatternSource,
  setPieceReconciliation,
  STORED_ARGUMENT_SCHEMA_REFUSAL,
} from "./runner.ts";

// Builder functionality (migrated from @commonfabric/builder package)
export { createBuilder, type CreateBuilderOptions } from "./builder/factory.ts";
export type {
  BuilderFunctionsAndConstants as BuilderFunctions,
  BuilderRuntime,
} from "./builder/types.ts";

// Internal functions and exports needed by other packages
export {
  getPatternEnvironment,
  getPatternEnvironment as builderGetPatternEnvironment,
  type PatternEnvironment,
  setPatternEnvironment,
  setPatternEnvironment as builderSetPatternEnvironment,
} from "./builder/env.ts";
export {
  getTopFrame,
  patternFromFrame,
  popFrame,
  pushFrame,
  pushFrameFromCause,
} from "./builder/pattern.ts";
export {
  AuthSchema,
  type Cell as BuilderCell,
  CHIP_UI,
  type FactoryInput,
  type Frame,
  FRAMEWORK_RESULT_KEYS,
  FS,
  type FsProjection,
  type HandlerFactory,
  isModule,
  isPattern,
  isReactive,
  isStreamValue,
  type JSONObject,
  type JSONSchema,
  type JSONValue,
  type Module,
  type ModuleFactory,
  type MutableJSONSchemaObj,
  NAME,
  type NodeFactory,
  OAuth2TokenSchema,
  type Pattern,
  type PatternFactory,
  type Props,
  type Reactive,
  type RenderNode,
  type Schema,
  schema,
  type SchemaWithoutCell,
  type StreamValue,
  TESTS,
  TILE_UI,
  type toJSON,
  TYPE,
  UI,
  type UnsafeBinding,
  VIEWS,
  type VNode,
  WebhookConfigSchema,
} from "./builder/types.ts";
export { createNodeFactory } from "./builder/module.ts";
export { reactive as cell } from "./builder/reactive.ts";
export {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  CFC_FUSE_ATOM_CLASS,
  CFC_RUNTIME_SUBJECT,
  cfcAtom,
  ContextualFlowControl,
  resolveExternalRootRefForStructure,
} from "./cfc.ts";
export type { Mutable } from "@commonfabric/utils/types";
export {
  type ActionReadStats,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarker,
  type RuntimeTelemetryMarkerResult,
  type SchedulerGraphEdge,
  type SchedulerGraphNode,
  type SchedulerGraphSnapshot,
} from "./telemetry.ts";
// Export the bridge TYPES from the barrel, but NOT its values. A static value
// re-export would pull telemetry-otel-bridge.ts -> @opentelemetry/api (whose node
// platform build does `require("perf_hooks")`) into every bundle that imports the
// runner barrel, including the browser web-worker — which breaks worker load.
// Consumers import the values via the dedicated subpath
// `@commonfabric/runner/telemetry-otel-bridge` (see deno.jsonc) so the OTel
// dependency only reaches hosts that actually set up a provider.
export type {
  OtelBridgeOptions,
  RuntimeTelemetryOtelBridge,
} from "./telemetry-otel-bridge.ts";

// Utility functions (split from utils.ts)
export { createJsonSchema } from "./builder/create-json-schema.ts";
export { deepEqual } from "@commonfabric/utils/deep-equal";
export { getValueAtPath, setValueAtPath } from "./path-utils.ts";
export { schemaToTypeString } from "./schema-format.ts";
export type { SchemaFormatOptions } from "./schema-format.ts";
export { ACLManager } from "./acl-manager.ts";
export {
  cellEntityIdString,
  type CellPath,
  cellWithScopedLinkRequiredsRelaxed,
  compileAndSavePattern,
  parseCellPath,
  resolveCellPath,
} from "./piece-helpers.ts";
export {
  readResultSchemaMeta,
  resultSchemaMetaSpelling,
  writeResultSchemaMeta,
} from "./result-schema-meta.ts";
export type { ModuleByteCache } from "./runtime.ts";
export type { CompiledModuleArtifact } from "./harness/types.ts";
export {
  getCompileCacheRuntimeVersion,
  sourceDocKey,
} from "./compilation-cache/cell-cache.ts";
export {
  isSlugAddress,
  slugCause,
  slugIdForSpace,
  slugIndexIdForSpace,
  validateSlug,
} from "./slugs.ts";
export {
  type FabricChaseResult,
  resolveFabricRefToIdentity,
} from "./fabric-ref-resolution.ts";
export {
  type FabricRef,
  FabricRefError,
  formatFabricRef,
  isFabricImportSpecifier,
  parseFabricRef,
} from "./sandbox/fabric-import-specifier.ts";
export { type PinRewrite, rewriteFabricPins } from "./fabric-pin-rewrite.ts";
export { DEFAULT_CELL_SCOPE } from "./scope.ts";
export {
  isPieceDocument,
  isPieceRoot,
  parseSlugRedirect,
  resolveSlugReference,
  resolveSlugTargetCell,
  resolveSlugTargetInPiece,
  type SlugReferenceTarget,
  SlugResolutionError,
  type SlugTargetInPiece,
} from "./slug-resolution.ts";

export { schemaPathSelection } from "./schema-path.ts";
export {
  acceptsOpaqueCellOrUnresolvedLink,
  overlayUnreadableLinkPlaceholders,
  storedArgumentValidationIssue,
} from "./stored-argument-validation.ts";

export {
  parseCellReference,
  parsePieceSegment,
  parseReferenceContext,
  parseRelativeReference,
  type ReferenceContext,
  type ReferenceMember,
  type RelativeReferenceParts,
  type RenderableCellReference,
  renderCellReference,
  renderReferenceContext,
} from "./cell-reference.ts";
