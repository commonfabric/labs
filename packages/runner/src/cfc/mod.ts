export type {
  CfcLabelView,
  CfcLabelViewEntry,
  CfcLabelViewSource,
  CfcLabelViewStatus,
  ResolvedLabelReadOptions,
} from "./label-view.ts";
export {
  type CfcCellLinkRefPayload,
  linkCfcLabelView,
  setLinkCfcLabelView,
  stripSigilCfcLabelViews,
} from "./link-label-view.ts";
export {
  CLASSIFIED_KIND_FAMILIES,
  classifyAtomField,
  classifyLabelField,
  LABEL_FIELD_CLASSIFICATION,
  type LabelAtomFamily,
  type LabelFieldClassificationEntry,
  type LabelFieldRepresentationClass,
} from "./label-field-classification.ts";
export {
  type CfcFieldCommitment,
  commitCfcFieldValue,
  commitmentAwareEquals,
  containsCfcFieldCommitment,
  isCfcFieldCommitment,
  transformCfcLabelForCrossSpacePersist,
} from "./label-representation.ts";
export {
  cfcLabelViewForAddress,
  cfcLabelViewForCell,
  cfcLabelViewForCellFailClosed,
  cfcLabelViewForCellFailClosedWithStatus,
  cfcLabelViewForCellWithStatus,
  cfcLabelViewForDereference,
  cfcLabelViewForDereferenceTraces,
  cfcLabelViewForResolvedCell,
  cfcLabelViewForResolvedCellWithStatus,
  cfcLabelViewFromMetadata,
  cfcLabelViewSourceForCell,
  cfcLabelViewSymbol,
  cloneCfcLabelView,
  getCarriedCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
  redactCaveatSourcesForDisplay,
} from "./label-view.ts";
export { cfcLabelViewFromSchema } from "./schema-label-view.ts";
export type {
  AttemptedWrite,
  CfcAddress,
  CfcContentAddressedLabels,
  CfcDeclaredMonotonicityMode,
  CfcDeclaredWideningExemption,
  CfcDecomposedEnvelopes,
  CfcDereferenceTrace,
  CfcEnforcementMode,
  CfcExternalContentObservation,
  CfcFlowLabelsMode,
  CfcLabelMetadataObservation,
  CfcLabelMetadataProtectionMode,
  CfcMetadata,
  CfcPolicyEvaluationMode,
  CfcPreparationWork,
  CfcPrepareState,
  CfcSandboxDiagnostic,
  CfcSandboxExitCodeObservation,
  CfcSandboxJsonValue,
  CfcSandboxOutputPolicy,
  CfcSandboxResult,
  CfcStreamChannel,
  CfcStreamObservation,
  CfcStreamSegment,
  CfcTriggerReadGating,
  CfcTxState,
  CfcWriteFloorMode,
  ConsultedGrant,
  ConsultedPolicyManifest,
  ConsumedRead,
  EntityDocumentWithCfc,
  IFCLabel,
  ImplementationIdentity,
  OrderedWriteAttempt,
  PostCommitSideEffect,
  PreparedDigestInput,
  RuntimeWritePolicyAuthorization,
  TrustSnapshot,
  WritePolicyInput,
} from "./types.ts";
// `runtimeWritePolicyAuthorization` is deliberately NOT re-exported here.
// `./cfc` is a public entry point of this package, and the value is what
// mints a write-policy input the route-2 declaration acts on; publishing it
// would let anything that can import the package name it. The type above
// carries no such risk — it is erased, and names nothing at run time. The
// runtime passes the value through an in-package import.
export {
  cfcCanonicalClauseDigest,
  collectDeclaredMonotonicityViolations,
} from "./declared-monotonicity.ts";
export {
  CONF_LABEL_NOT_AVAILABLE,
  evaluateConfLabelQuery,
  inspectStoredConfLabel,
  parseConfLabelTargetPath,
} from "./label-introspection.ts";
export type {
  ConfLabelQuery,
  ConfLabelQueryEvaluation,
  InspectConfLabelResult,
  LabelAtomProjection,
} from "./label-introspection.ts";
export {
  CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON,
  CfcSchemaMigrationError,
} from "./migration-reason.ts";
export { LABEL_METADATA_OBSERVATION } from "./observation-classes.ts";
export type { LabelMetadataObservationClass } from "./observation-classes.ts";
export {
  CFC_ENFORCEMENT_MODES,
  CFC_ENFORCING_STRICTNESS,
  cfcEnforcementStrictness,
  DEFAULT_CFC_CONTENT_ADDRESSED_LABELS,
  DEFAULT_CFC_DECLARED_MONOTONICITY_MODE,
  DEFAULT_CFC_DECOMPOSED_ENVELOPES,
  DEFAULT_CFC_ENFORCEMENT_MODE,
  DEFAULT_CFC_FLOW_LABELS_MODE,
  DEFAULT_CFC_LABEL_METADATA_PROTECTION_MODE,
  DEFAULT_CFC_POLICY_EVALUATION_MODE,
  DEFAULT_CFC_TRIGGER_READ_GATING,
  DEFAULT_CFC_WRITE_FLOOR_MODE,
  isCfcEnforcementMode,
} from "./types.ts";
export {
  canonicalizeCfcLabel,
  canonicalizeCfcMetadata,
  canonicalizeDereferenceTrace,
  canonicalizeLogicalPath,
  canonicalizePreparedDigestInput,
  canonicalizeWritePolicyInput,
  cfcDereferenceTracesEqual,
  logicalPathToPointer,
  preparedDigestFor,
} from "./canonical.ts";
export type { CfcConfClause, CfcOrClause } from "./clause.ts";
export {
  type CfcModulePolicyLoader,
  type CfcModulePolicySource,
  createRuntimeCfcModulePolicySource,
  createTxCfcModulePolicyResolver,
  type RenderModulePolicyResolver,
} from "./policy-resolver.ts";
export {
  clauseAlternatives,
  clausesEqual,
  clauseSubsumes,
  isOrClause,
  normalizeClause,
} from "./clause.ts";
export type { AtomPattern, AtomPatternBindings } from "./atom-pattern.ts";
export {
  atomEntails,
  instantiateAtomPattern,
  isAtomVarPlaceholder,
  matchAtomPattern,
  matchAtomPatternAgainstAtoms,
  matchAtomPatternConjunction,
} from "./atom-pattern.ts";
export type {
  CfcPolicyRecordInput,
  ExchangeRule,
  PolicyRecord,
  PolicySnapshot,
} from "./policy.ts";
export {
  buildCfcPolicyArtifactManifest,
  buildCfcPolicySnapshot,
} from "./policy.ts";
export {
  MATERIAL_RISK_DISCHARGE_KINDS,
  MATERIAL_RISK_DISCHARGE_POLICY,
  MATERIAL_RISK_KINDS,
  STANDARD_PROMPT_CAVEAT_POLICY,
} from "./standard-profile.ts";
export type {
  CfcConceptEdge,
  CfcTrustConfig,
  CfcTrustConfigInput,
  CfcTrustStatement,
  CfcVerifierDelegation,
  TrustResolver,
} from "./trust.ts";
export {
  buildCfcTrustConfig,
  createTrustResolver,
  MAX_TRUST_CLOSURE_DEPTH,
} from "./trust.ts";
export type {
  CfcGrantConsumptionContext,
  CfcGrantResolver,
  CfcGrantResolverQuery,
  ExchangeEvalContext,
  ExchangeEvalResult,
  RuleFiring,
} from "./exchange-eval.ts";
export {
  DEFAULT_EXCHANGE_FUEL,
  evaluateExchangeRules,
} from "./exchange-eval.ts";
export type {
  CfcGrant,
  CfcGrantConsumptionReceipt,
  CfcGrantIdentity,
  CfcGrantWriteInput,
} from "./grants.ts";
export {
  CFC_GRANT_ABSENT_DIGEST,
  CFC_GRANT_ID_PREFIX,
  cfcGrantConsumedReceiptId,
  cfcGrantDocId,
  cfcGrantIsLive,
  createTxCfcGrantResolver,
  disallowedGrantAudienceEntryReason,
  expandCfcGrantFacts,
  flushCfcGrantConsumptionClaims,
  prepareCfcGrantWrite,
  verifyCfcGrantDocument,
} from "./grants.ts";
export type {
  RenderConfidentialityResolver,
  RenderConfidentialityResolverConfig,
  RenderLabelInput,
} from "./render-ceiling.ts";
export {
  createRenderConfidentialityResolver,
  membershipSpacesInConfidentiality,
  modulePolicyRefsInConfidentiality,
  RENDER_DISPLAY_SINK_CLASS,
  RENDER_SINK_NAME,
  STANDARD_RENDER_EXCHANGE_RULES,
} from "./render-ceiling.ts";
export type { SpaceMembershipProvider, SpaceRole } from "./space-membership.ts";
export {
  createRuntimeSpaceMembershipProvider,
  spaceReaderRole,
} from "./space-membership.ts";
export {
  CFC_PREFIX_PROVENANCE_MAX_WRITES,
  describeSinkReleaseRefusal,
  flowLabelWorkExists,
  flowReadExcluded,
  gatedSinkRequestExists,
  loadStoredCfcEnvelope,
  prepareBoundaryCommit,
  storedCfcEnvelopeMergeIssue,
} from "./prepare.ts";
export type {
  CfcPrefixBoundSource,
  CfcPrefixProvenanceSummary,
  CfcPrefixProvenanceWrite,
  CfcPrepareInstrumentation,
  StoredCfcEnvelope,
} from "./prepare.ts";
export {
  reportCfcDenial,
  resetCfcDenialAnnouncements,
} from "./denial-report.ts";
export {
  cfcMetadataPresent,
  readStoredCfcMetadata,
  StoredCfcMetadataError,
  UnknownCfcMetadataVersionError,
  UnreadableCfcMetadataError,
  UnresolvableCfcLabelDocumentError,
} from "./metadata.ts";
export {
  CFC_LABEL_INLINE_LIMIT,
  cfcLabelDocumentContent,
  cfcLabelDocumentHash,
  isCfcLabelReference,
  parseCfcLabelReference,
  referencedCfcLabelDocumentHashes,
} from "./label-documents.ts";
export type {
  CfcSchemaMergeIssue,
  IfcKey,
  MergeCfcSchemaEnvelopeOptions,
} from "./schema-merge.ts";
export {
  createSinkRequestPolicyInput,
  recordSinkRequestPolicyInput,
  verifySinkRequestRelease,
} from "./sink-request.ts";
export type {
  HarnessPromptSlotLike,
  HarnessPromptSlotRole,
  HarnessWriteFileAuthorizationDecision,
  HarnessWriteFileAuthorizationRequest,
} from "./harness-write-policy.ts";
export { evaluateHarnessWriteFileAuthorization } from "./harness-write-policy.ts";
export {
  type CfcExternalFetchIngestMeta,
  type CfcExternalIngestMeta,
  type CfcExternalIngestTarget,
  externalIngestStamp,
  stampExternalFetchIngest,
  stampExternalIngest,
} from "./external-ingest.ts";
export {
  CFC_DIAL_LADDERS,
  cfcPostureReport,
  inheritedCfcPostureReport,
  projectedCfcPostureReport,
  resolveCfcDials,
  RUNTIME_CFC_DIAL_DEFAULTS,
} from "./posture-report.ts";
export type {
  CfcDialOptions,
  CfcDialReport,
  CfcPostureDeviation,
  CfcPostureOptions,
  CfcPostureProvenance,
  CfcPostureReport,
  CfcPostureSource,
  CfcSinkReport,
  ResolvedCfcDials,
} from "./posture-report.ts";
export {
  DEFAULT_SINK_MAX_CONFIDENTIALITY,
  INITIAL_SINK_INVENTORY,
  isInitialSinkInventoryName,
  KNOWN_SINKS,
  SINK_CLASSES,
  SINK_UNGATED_RATIONALES,
  sinkCeilingsOf,
  sinkClassOf,
  ungatedSink,
} from "./sink-inventory.ts";
export type {
  KnownSinkName,
  SinkClass,
  SinkGovernance,
  SinkGovernanceRegistry,
  SinkMaxConfidentiality,
  SinkUngatedRationale,
  UngatedSinkName,
} from "./sink-inventory.ts";
export {
  buildCfcReadCeiling,
  type CfcReadCeiling,
  CfcReadCeilingError,
  type CfcReadCeilingLabels,
  type CfcReadCeilingOptions,
  type CfcReadOnExceed,
} from "./read-ceiling.ts";
export { markRendererTrustedEvent } from "./ui-contract.ts";
export {
  cfcObjectSchemaIsClosed,
  INJECTION_SAFE_ATOM,
  isPrimitiveJsonValue,
  isPromptInjectionMaterialRiskAtom,
  resolveSchemaForValidation,
  schemaWithInjectionSafeAnnotations,
  validateAgainstSchema,
  validateSchemaDefinition,
  validateSchemaValue,
} from "./schema-sanitization.ts";
export {
  atomsOutsideCeiling,
  CFC_LABEL_READ_FAILED_ATOM,
  cfcConfidentialityForObservationNode,
  type CfcFloorTrustContext,
  cfcIntegritySatisfiesFloorCoherently,
  cfcIntegrityWitnessKey,
  cfcJsonPointerForPath,
  cfcObservationFitsCeiling,
  type CfcObservationMaxConfidentiality,
  type CfcObservationResult,
  type CfcObservedConfidentiality,
  type CfcOpaqueLink,
  cfcOpaqueLinkForPath,
  joinCfcObservedConfidentiality,
  meetCfcObservationCeilings,
  uniqueCfcAtoms,
} from "./observation.ts";
export {
  cfcSchemaIsFalse,
  cfcSchemaIsInternalKey,
  cfcSchemaIsTrue,
  cfcSchemaResolvedRoot,
  cfcSchemaToObject,
  cfcSchemaWithInheritedDefs,
  findCfcSchemaRefs,
  hoistCfcSchemaDefs,
  isEmbeddedCfcSchemaRef,
  pruneCfcSchemaDefinitions,
  resolveCfcSchemaRef,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
  resolveCfcSchemaRefsOrThrow,
  selectReferencedCfcSchemaDefs,
} from "./schema-refs.ts";
export {
  LLM_DERIVED_RESULT_STAMP_SCHEMA,
  withLlmDerivedStamp,
} from "./llm-derived-stamp.ts";
export {
  type SchemaOpaqueLinkSanitizationResult,
  type StructuredResultReservedKeys,
  validateAndSanitizeSchemaValueWithOpaqueLinks,
  validateAndSanitizeStructuredResultValue,
  validateStructuredResultValue,
} from "./structured-result.ts";
export {
  type CfcRefusalAttribution,
  type CfcRefusalDetail,
  type CfcRefusalGate,
  type CfcRefusalInput,
  type ConsumedAtomSource,
  describeRefusalInputs,
  renderCfcAtom,
} from "./refusal-detail.ts";
