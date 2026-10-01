/**
 * /!\ Shared between client and runtime threads.
 * /!\ Take care in only importing lightweight types,
 * /!\ interfaces and utilities.
 */

export { refuseFabricInstance } from "@commonfabric/data-model";
export {
  isStoredArgumentSchemaRefusal,
  STORED_ARGUMENT_SCHEMA_REFUSAL,
  storedArgumentRefusalDetail,
} from "./stored-argument-refusal.ts";
export {
  addressKey,
  CELL_SCOPE_VALUES,
  createLLMFriendlyLink,
  encodeJsonPointer,
  isPieceHandle,
  isSigilLink,
  linkPathSegmentToCellPathSegment,
  matchLLMFriendlyLink,
  type NormalizedFullLink,
  parseLLMFriendlyLink,
  parseReferenceParts,
  parseScopedIdSegment,
  type ReferenceParts,
} from "./link-types.ts";
export { type AliasBinding, isAliasBinding } from "./alias-binding.ts";
export {
  isLinkRef,
  type LinkRef,
  linkRefFrom,
  linkRefPayload,
  linkRefPayloadFromString,
  linkRefPayloadToString,
  type WireLinkRefPayload,
} from "@commonfabric/data-model/cell-rep";
export {
  assertWebhookCellLinkRefPayload,
  LINK_V1_TAG,
  type SigilLink,
  type URI,
  type WebhookCellLinkRefPayload,
} from "./sigil-types.ts";
export {
  CHIP_UI,
  FRAMEWORK_RESULT_KEYS,
  type JSONObject,
  type JSONSchema,
  type JSONValue,
  NAME,
  type Schema,
  TILE_UI,
  TYPE,
  UI,
  VIEWS,
} from "./builder/types.ts";
export { type Cancel, useCancelGroup } from "./cancel.ts";
export { parseFabricRef } from "./sandbox/fabric-import-specifier.ts";
export type {
  CycleReport,
  NonIdempotentReport,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarkerResult,
  SchedulerDiagnosisResult,
  SchedulerGraphEdge,
  SchedulerGraphNode,
  SchedulerGraphSnapshot,
} from "./telemetry.ts";
export type {
  ActionRunTraceEntry,
  SettleIterationStats,
  SettleStats,
  SettleStatsHistoryEntry,
  TriggerTraceActionRecord,
  TriggerTraceEntry,
  TriggerTraceValueKind,
  TriggerTraceValueSummary,
} from "./scheduler.ts";
export type {
  WriteStackTraceEntry,
  WriteStackTraceMatcher,
  WriteStackTraceMatchMode,
} from "./storage/write-stack-trace.ts";
// Type-only: the plain-JSON shape the worker returns for a pattern-coverage
// dump. No runtime import (the module's value exports never load here).
export type {
  PatternCoverageData,
  PatternCoverageKind,
  PatternCoverageSpan,
} from "./pattern-coverage.ts";

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
