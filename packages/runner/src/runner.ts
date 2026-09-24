import {
  convertibleJsFromFabricValue,
  debugStr,
  fabricFromConvertibleJsValue,
  FabricInstance,
  type FabricValue,
  hashOf,
  hashStringOf,
  isDeepFrozen,
  isKeyableObjectOrArray,
  isWalkableObjectOrArray,
  refuseFabricInstance,
  valueEqual,
} from "@commonfabric/data-model";
import { BoundedKeyMap } from "@commonfabric/utils/cache";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { getLogger } from "@commonfabric/utils/logger";

import {
  requireLocalReadCondition,
  restrictToLocalReads,
  usesLocalReads,
  validateLocalReadBasis,
} from "./storage/local-read-policy.ts";
import { STORED_ARGUMENT_SCHEMA_REFUSAL } from "./stored-argument-refusal.ts";
import { storedArgumentValidationIssue } from "./stored-argument-validation.ts";
import { viewNodeId } from "./view-replication.ts";

export {
  isStoredArgumentSchemaRefusal,
  STORED_ARGUMENT_SCHEMA_REFUSAL,
} from "./stored-argument-refusal.ts";
import {
  isObjectNotArray,
  isObjectOrArray,
  isPlainObject,
} from "@commonfabric/utils/types";

import { isAliasBinding } from "./alias-binding.ts";
import { runInFrameContext } from "./builder/frame-context.ts";
import {
  patternFromFrame,
  popFrame,
  pushFrameFromCause,
} from "./builder/pattern.ts";
import {
  type CellScope,
  type FabricExecValue,
  type Frame,
  isModule,
  isPattern,
  type JSONSchema,
  JSONValue,
  type Module,
  NAME,
  type Node,
  type NodeFactory,
  type Pattern,
  UI,
} from "./builder/types.ts";
import {
  type AddCancel,
  type Cancel,
  type DeferredCancelOwnership,
  useCancelGroup,
  useDeferredCancelOwnership,
} from "./cancel.ts";
import {
  type Cell,
  createCell,
  isCell,
  schemaCellScope,
  syncCellForIdentity,
} from "./cell.ts";
import {
  ContextualFlowControl,
  resolveExternalRootRefForStructure,
} from "./cfc.ts";
import { recordNewProtectedDefaults } from "./cfc/default-initialization.ts";
import {
  recordReferencedArgumentFields,
  recordReplayedArgumentSlots,
} from "./cfc/reference-initialization.ts";
import { cfcSchemaWithInheritedDefs } from "./cfc/schema-refs.ts";
import { findAndInlineDataUriLinks } from "./data-uri.ts";
import type { EntityKind } from "./entity-kind.ts";
import { MAX_PATH_RESOLUTION_LENGTH, resolveLink } from "./link-resolution.ts";
import { FILTER_INPUT_SCHEMA } from "./builtins/filter.ts";
import { FLATMAP_INPUT_SCHEMA } from "./builtins/flatmap.ts";
import {
  listCoordinatorPlan,
  listElementResultCell,
  listSlotResolutions,
} from "./builtins/list-coordinator-plan.ts";
import { MAP_INPUT_SCHEMA } from "./builtins/map.ts";
import {
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  getDerivedInternalCell,
  getDerivedInternalCellLink,
  getMetaCell,
  getMetaLink,
  isCellLink,
  isSigilLink,
  isWriteRedirectLink,
  KeepAsCell,
  type NormalizedFullLink,
  parseLink,
  toMemorySpaceAddress,
} from "./link-utils.ts";
import {
  isRawBuiltinResult,
  type RawBuiltinReturnType,
  type RawNodeCause,
} from "./module.ts";
import { runtimeOwnedStoreOwnerKey } from "./cfc/runtime-owned-stores.ts";
import { writeResultSchemaMeta } from "./result-schema-meta.ts";
import {
  canResolveScopeKey,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { forEachSubschema } from "@commonfabric/data-model-schema/schema-walk";
import { speculationRunContextOf } from "./speculation/overlay-destination.ts";
import {
  navigateEventContextFromRunInfo,
  navigateEventContextOf,
  setNavigateEventContext,
} from "./builtins/navigate-context.ts";
import { opInputsDocKey } from "./builtins/op-pattern-ref.ts";
import {
  requireWaveAcceptance,
  waveRunContextOf,
  waveSettlementOf,
} from "./executor/wave.ts";
import { RUNNER_ACCEPTANCE_EFFECT_KIND } from "./executor/runner-acceptance.ts";
import {
  causalFormOfBinding,
  findAllWriteRedirectCells,
  opaqueArgumentKeys,
  sendValueToBinding,
  unwrapOneLevelAndBindToDoc,
} from "./pattern-binding.ts";
import {
  PatternManager,
  type PreparedSourceUpdate,
} from "./pattern-manager.ts";
import { isCellResultForDereferencing } from "./query-result-proxy.ts";
import type { Runtime } from "./runtime.ts";
import {
  type Action,
  type EventHandler,
  ignoreReadForScheduling,
} from "./scheduler.ts";
import { entityKey } from "./scheduler/keys.ts";
import { RetryImmediately } from "./scheduler/retry-immediately.ts";
import { isSchemaMismatchError } from "./schema-view.ts";
import { rendererVDOMSchema } from "./schemas.ts";
import { combineOptionalSchema } from "./traverse.ts";
import { flattenBuilderArtifacts } from "./storage-preflight.ts";
import { TransactionWrapper } from "./storage/extended-storage-transaction.ts";
import { getTransactionReadActivities } from "./storage/transaction-inspection.ts";
import {
  type CommitError,
  type DID,
  type IExtendedStorageTransaction,
  type IStorageSubscription,
  type MemorySpace,
  type Result,
  toThrowable,
  type Unit,
  type URI,
} from "./storage/interface.ts";
import {
  isDurableReadTx,
  machineryRead,
  markDurableReadTx,
  schedulerDependencyRead,
} from "./storage/reactivity-log.ts";
import {
  isCfcEnforcementRejection,
  isConflictRejection,
  isStaleReadConflict,
  isStorageTransactionInconsistent,
} from "./storage/rejection.ts";

import "./builtins/index.ts";

import { runInActionExecution } from "./builder/action-context.ts";
import {
  getArtifactEntryRef,
  getPatternProgram,
  getPatternSourcePath,
  isTrustedBuilderArtifact,
  resolveOriginal,
  resolveProducerEntryRef,
} from "./builder/pattern-metadata.ts";
import { classifyPieceOriginString } from "./piece-origin-kind.ts";
import {
  PATTERNS_ROUTE_PREFIX,
  systemPatternSource,
} from "./pattern-source-scheme.ts";
import {
  resolveBuiltinImplementationIdentity,
  resolvePolicyFacingImplementationIdentity,
} from "./cfc/implementation-identity.ts";
import {
  localRefTarget,
  relaxDefaultedRequired,
  validateSchemaValue,
} from "./cfc/schema-sanitization.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  type ImplementationIdentity,
  runtimeWritePolicyAuthorization,
  type TrustSnapshot,
} from "./cfc/types.ts";
import {
  prepareSourceClosureVerification,
  readVerifiedSourceClosure,
} from "./compilation-cache/cell-cache.ts";
import { createRef } from "./create-ref.ts";
import {
  diffAndUpdate,
  initializeScopedArgumentSlots,
  scopedArgumentInitializationTargets,
  sessionScopedArgumentKeys,
} from "./data-updating.ts";
import { getVerifiedProvenance } from "./harness/verified-provenance.ts";
import { setResultCell } from "./result-utils.ts";
import {
  describePatternOrModule,
  extractDefaultValues,
  foldStoredArgumentSlots,
  mergeSchemaDefaults,
  sanitizeDebugLabel,
  setRunnableName,
} from "./runner-utils.ts";
import { normalizeSandboxResult } from "./sandbox/result-normalization.ts";
import { narrowestScope } from "./scope.ts";
import { SigilLink } from "./sigil-types.ts";
import { toURI } from "./uri-utils.ts";
import {
  asPatternIdentityRef,
  rawMetaWriteAuthorization,
} from "./meta-seam.ts";
export {
  extractDefaultValues,
  mergeObjects,
  mergeSchemaDefaults,
  schemaAcceptsOpaqueCellValue,
  schemaHasDefaultValue,
} from "./runner-utils.ts";
export { validateAndCheckReactives } from "./sandbox/result-normalization.ts";

const logger = getLogger("runner", { enabled: true, level: "warn" });
const triggerFlowLogger = getLogger("runner.trigger-flow", {
  enabled: true,
  level: "warn",
  logCountEvery: 0,
});

/**
 * How many prepared/stopped result shortcuts one runner keeps. Sized well
 * above any plausible number of simultaneously live pieces, so the bound is
 * reached only by a pattern churning through results it will not revisit.
 */
const RESULT_SHORTCUT_LIMIT = 4096;

/**
 * Presence probes `Runner.#patternToNameBeforeRun` may spend before it stops
 * looking and holds the run for a name-sync. Each probe is one read of the
 * local replica, so the budget bounds the walk's cost and not its verdict: a
 * spent budget reads as absent, and the run pays one name-sync it may not
 * have needed. A wide argument — one whose links, and the values behind
 * them, fan out past the budget within the walk's depth — is therefore held
 * even when its whole family is local. A cached shortcut for that piece skips
 * the probes only while its pattern identity matches the run. Eviction or
 * replacement by another pattern can cause another probe and hold. The walk
 * follows links in a linked document's value because the name-sync's
 * argument-link-target wave warms them; a missed absence costs a conflicting
 * first commit, and a spurious hold costs a re-sync the client answers from
 * coverage it already has. The gate logs a spent budget so a wide piece
 * held for it is diagnosable.
 */
const NAMING_PROBE_BUDGET = 256;

type InternalCellDescriptor = {
  partialCause: JSONValue;

  /**
   * Entity kind of the materialized cell's id. Part of the manifest match
   * key alongside `partialCause`: a kind flip across pattern versions must
   * re-materialize the cell under its new id rather than reuse the old link.
   */
  kind?: EntityKind;

  link: SigilLink;
};

type StartAttempt = {
  readonly lifecycleEpoch: number;
  readonly generationsByDoc: Map<string, number>;
  readonly preResolutionStopKeys: Set<string>;

  /** Parent demand and synchronization context for a retained child. */
  readonly options?: Pick<
    RunnerRunOptions,
    "parentPieceRootId" | "awaitSyncBeforeInitialRun"
  >;

  // The result this attempt resolved to, which a link start only learns by
  // following the link.
  targetKey?: `${MemorySpace}/${ScopeKey}/${URI}`;
  // The exact registration THIS attempt's `#startCore()` created, when it
  // created one. A walk can also report success for a registration it did
  // NOT create (doStart's already-started returns, including the
  // mid-resume re-check) — a COMPETING start can install into a registry
  // the caller emptied, with no stop and so no generation bump to witness
  // it. A caller that hands a registration to an ownership it holds must
  // hand off THIS one, never merely whatever `cancels` holds at claim
  // time (the catch-up recovery does so).
  installedRegistration?: Cancel;
  // The attempt's outcome, which a concurrent start of the same doc joins
  // instead of running a second resolution pipeline. Assigned by start() once
  // the pipeline promise exists.
  settled?: Promise<boolean>;
  // The pattern keys this attempt has read inherited authority for. The walk
  // runs again from the top after the read, and must not read again for a
  // grant the durable metadata does not carry.
  authorityReadFor?: Set<string>;
};

/**
 * `schema` with a handler's `$event` slot removed: what a handler node's
 * bound inputs are synced under at start, where the slot holds the stream
 * link rather than an event.
 */
function schemaWithoutEventSlot(
  schema: JSONSchema | undefined,
): JSONSchema | undefined {
  if (!isObjectOrArray(schema) || !isObjectOrArray(schema.properties)) {
    return schema;
  }
  if (!Object.hasOwn(schema.properties, "$event")) return schema;
  const { $event: _event, ...properties } = schema.properties as Record<
    string,
    JSONSchema
  >;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key) => key !== "$event")
    : undefined;
  return {
    ...schema,
    properties,
    ...(required !== undefined && { required }),
  };
}

// The debug-name builders reuse the action's already-computed
// `schedulerActionInstanceKey` as their uniquifying suffix instead of hashing
// the same links a second time (one hashOf per action creation, not two). The
// name stays per-instance-unique — same-named actions differ in links, so the
// suffix differs; differently-named actions differ in the prefix.
function schedulerRawActionName(
  rawTargetName: string,
  instanceKey: string,
): string {
  return `raw:${rawTargetName}:${instanceKey}`;
}

function schedulerJavaScriptActionName(
  actionName: string,
  instanceKey: string,
): string {
  return `action:${actionName}:${instanceKey}`;
}

function schedulerActionLinkIdentity(link: NormalizedFullLink) {
  return {
    space: link.space,
    id: link.id,
    scope: link.scope,
    path: link.path,
  };
}

/**
 * A source-location-INDEPENDENT, per-instance discriminator for a scheduler
 * action: a short hash of the action's `{ process, reads, writes }` cell links.
 * Two instances of the same hoisted op (e.g. one `lift` called twice) differ in
 * their reads/writes, so this distinguishes them; the links are reload-stable,
 * so it is too. Unlike `schedulerJavaScriptActionName`/`schedulerRawActionName`
 * it folds in NO source-derived name, so it is independent of `fn.src` and the
 * debug annotation. It is appended to the content-addressed action id
 * (`cf:module/<hash>:<symbol>:<instanceKey>`, `getSchedulerActionId`) so that the
 * per-symbol content address stays the implementation *fingerprint* while the
 * action id — the `actionStats` key and the durable observation key — stays
 * per-*instance*. Without it, N instances of one symbol collide on a single id.
 */
function schedulerActionInstanceKey(parts: {
  process?: NormalizedFullLink;
  reads?: readonly NormalizedFullLink[];
  writes?: readonly NormalizedFullLink[];
}): string {
  return hashOf({
    process: parts.process ? schedulerActionLinkIdentity(parts.process) : null,
    reads: (parts.reads ?? []).map(schedulerActionLinkIdentity),
    writes: (parts.writes ?? []).map(schedulerActionLinkIdentity),
  }).hashString.slice(0, 12);
}

function patternDefaultScope(pattern: Pattern): CellScope | undefined {
  return schemaCellScope(pattern.resultSchema) ?? pattern.defaultScope;
}

/**
 * Structural description of `value` for the durable `schema` metadata of the
 * receipt cell it is about to be written into: the root container kind, plus
 * the property names when that kind is a record. Returns `undefined` for a
 * value with no container kind of its own — a scalar, a `FabricSpecialObject`,
 * or a link, whose kind belongs to whatever it resolves to rather than to the
 * receipt.
 *
 * A `data:` link is the exception among links: it carries its value inside
 * its own identifier, and the write inlines it, so the receipt holds that
 * value rather than a link to it. The description comes from the same
 * inlining, so it describes what is stored.
 *
 * This is DESCRIPTIVE — what this one receipt holds — and never a contract
 * bearing on anything written later. Description and authority cannot diverge
 * here, because the receipt's create-only mark means the value it describes is
 * the only value the document ever holds.
 *
 * The root kind is what lets a reader's selection become a fetch selector
 * instead of a filter applied after loading, since the same selection means
 * different things over a record and over an array. The property schemas are
 * left as `true` — everything is admissible at every position — which is what
 * keeps a link position honest: spelling one out means `asCell`, and `["cell"]`
 * asserts a writable handle on a document nothing can be written through.
 */
function receiptShapeSchema(value: unknown): JSONSchema | undefined {
  const stored = isCellLink(value) ? findAndInlineDataUriLinks(value) : value;
  if (isCellLink(stored)) return undefined;
  if (Array.isArray(stored)) return { type: "array" };
  if (!isPlainObject(stored)) return undefined;
  const properties: Record<string, JSONSchema> = {};
  for (const key of Object.keys(stored)) properties[key] = true;
  return { type: "object", properties };
}

const recordOutputSchemaPolicyInputs = (
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  resultCell: Cell<any>, // used as the base for output bindings
  outputBinding: unknown,
  resultSchema: JSONSchema | undefined,
  schemaPath: readonly string[] = [],
): void => {
  if (resultSchema === undefined) {
    return;
  }

  // Sigil redirects only. `outputBinding` has been through
  // `unwrapOneLevelAndBindToDoc`, which turns this level's `$alias` bindings
  // into sigil links; a record still carrying `$alias` here belongs to a
  // nested pattern and names nothing at this level.
  if (isWriteRedirectLink(outputBinding)) {
    const bindingBase = resultCell.getAsNormalizedFullLink();
    const bindingLink = parseLink(outputBinding, bindingBase);
    // Output-redirect resolution is result-plumbing machinery
    // (machineryRead, same family as sendValueToBinding's walk): its reads
    // must not consume `*`-path membership templates (these resolve the
    // SAME redirects immediately before the send).
    const link = tx.runWithAmbientReadMeta(
      machineryRead,
      () =>
        resolveLink(
          runtime,
          tx,
          bindingLink,
          "writeRedirect",
        ),
    );
    const schema = schemaPath.length === 0
      ? resultSchema
      : ContextualFlowControl.getSchemaAtPath(resultSchema, [...schemaPath]);
    if (schema === undefined) {
      return;
    }
    for (const targetLink of [bindingLink, link]) {
      tx.recordCfcWritePolicyInput({
        kind: "schema",
        target: {
          space: targetLink.space,
          id: targetLink.id,
          scope: targetLink.scope,
          path: [...targetLink.path],
        },
        schema,
        schemaRole: "output",
      });
    }
    return;
  }

  if (Array.isArray(outputBinding)) {
    outputBinding.forEach((child, index) =>
      recordOutputSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        child,
        resultSchema,
        [...schemaPath, String(index)],
      )
    );
    return;
  }

  // A `FabricInstance` is refused. `isObjectOrArray` admits one, and its enumerable
  // properties are empty, so descent would stop without reaching its codec
  // contents -- and a write-redirect link nested inside one would record no
  // `kind: "schema"` entry.
  //
  // Unlike the argument walks below, what that costs is not a hole: these
  // entries GRANT, so a missing one leaves a later write refused rather than
  // wrongly allowed, and the gap fails _closed_. The refusal is here because a
  // write refused far away for a reason nothing names is worse to diagnose
  // than a throw at the site that owes the work.
  //
  // Nothing reaches this in production today, de facto rather than by
  // construction.
  //
  // TODO(danfuzz): descend by codec-mediated traversal into instance state, at
  // which point this becomes a walk rather than a refusal.
  if (outputBinding instanceof FabricInstance) {
    refuseFabricInstance(
      outputBinding,
      "when recording output-schema policy inputs",
    );
  }

  // The refusal above has already returned for every `FabricInstance`, so this
  // walk never reaches one and the link test decides nothing a `FabricLink`
  // reaches. The two sibling walks below carry no such refusal, and ask the
  // keyable question instead.
  if (!isCellLink(outputBinding) && isWalkableObjectOrArray(outputBinding)) {
    for (const [key, child] of Object.entries(outputBinding)) {
      recordOutputSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        child,
        resultSchema,
        [...schemaPath, key],
      );
    }
  }
};

const recordSchemaPolicyInputForLink = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  schema: JSONSchema | undefined,
  schemaRole?: "output",
): void => {
  if (schema === undefined) {
    return;
  }
  tx.recordCfcWritePolicyInput({
    kind: "schema",
    target: {
      space: link.space,
      id: link.id,
      scope: link.scope,
      path: [...link.path],
    },
    schema,
    ...(schemaRole !== undefined && { schemaRole }),
  });
};

const recordRawBuiltinBindingSchemaPolicyInputs = (
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  resultCell: Cell<any>, // used as the base for output bindings
  outputBinding: unknown,
): void => {
  // Sigil redirects only, as in recordOutputSchemaPolicyInputs.
  if (isWriteRedirectLink(outputBinding)) {
    const bindingBase = resultCell.getAsNormalizedFullLink();
    const bindingLink = parseLink(outputBinding, bindingBase);
    // Result-plumbing machinery, as in recordOutputSchemaPolicyInputs.
    const link = tx.runWithAmbientReadMeta(
      machineryRead,
      () =>
        resolveLink(
          runtime,
          tx,
          bindingLink,
          "writeRedirect",
        ),
    );
    const schema = bindingLink.schema ?? link.schema;
    recordSchemaPolicyInputForLink(tx, bindingLink, schema, "output");
    recordSchemaPolicyInputForLink(tx, link, schema, "output");
    return;
  }

  if (Array.isArray(outputBinding)) {
    outputBinding.forEach((child) =>
      recordRawBuiltinBindingSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        child,
      )
    );
    return;
  }

  // TODO(danfuzz): same gap as `recordOutputSchemaPolicyInputs()` above: the
  // descent stops at a `FabricSpecialObject`, so a link inside a
  // `FabricInstance`'s codec contents records no policy input. Fails closed,
  // as there.
  if (!isCellLink(outputBinding) && isKeyableObjectOrArray(outputBinding)) {
    for (const child of Object.values(outputBinding)) {
      recordRawBuiltinBindingSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        child,
      );
    }
  }
};

const schemaForRawBuiltinRootOutputBinding = (
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  resultCell: Cell<any>, // used as the base for output bindings
  outputBinding: unknown,
): JSONSchema | undefined => {
  // Sigil redirects only, as in recordOutputSchemaPolicyInputs.
  if (!isWriteRedirectLink(outputBinding)) {
    return undefined;
  }
  const bindingBase = resultCell.getAsNormalizedFullLink();
  const bindingLink = parseLink(outputBinding, bindingBase);
  // Result-plumbing machinery, as in recordOutputSchemaPolicyInputs.
  const link = tx.runWithAmbientReadMeta(
    machineryRead,
    () =>
      resolveLink(
        runtime,
        tx,
        bindingLink,
        "writeRedirect",
      ),
  );
  return bindingLink.schema ?? link.schema;
};

const resultForRawBuiltinOutputBinding = (
  result: unknown,
  outputBindingSchema: JSONSchema | undefined,
  builtinIdentity: ImplementationIdentity | undefined,
): unknown => {
  if (
    !isCell(result) ||
    outputBindingSchema === undefined ||
    builtinIdentity?.kind !== "builtin" ||
    builtinIdentity.builtinId !== "generateObject"
  ) {
    return result;
  }
  return result.asSchema(outputBindingSchema).getAsLink({
    includeSchema: true,
  });
};

const recordRawBuiltinResultSchemaPolicyInput = (
  tx: IExtendedStorageTransaction,
  result: unknown,
): void => {
  if (!isCell(result)) {
    return;
  }
  recordSchemaPolicyInputForLink(
    tx,
    result.getAsNormalizedFullLink(),
    result.schema,
    "output",
  );
};

/**
 * The kind-free ids of a pattern's derived internal cells on `resultCell` — the
 * ids a manifest-blind binding conversion mints for a `partialCause` alias
 * (pattern-binding's descriptor-miss fallback), which is how the identity bind
 * renders such an alias. Cause-only by contract: the coordinates ARE the
 * position-derived identity, and nothing may read through them — where the
 * descriptor carries a kind, the data lives at the KINDED entity, so a read
 * here asks about bytes that are never there and ties the asking transaction to
 * replication state. {@link firstResolvedOutputRedirect} takes this set to
 * return such links parsed rather than resolved. The kind is omitted from the
 * mint on purpose: the hash preimage is kind-free, so one kindless mint per
 * descriptor names the id the fallback produces whatever the descriptor's kind
 * is.
 */
function causeOnlySpotIds(
  resultCell: Cell<any>,
  descriptors: Pattern["derivedInternalCells"],
): ReadonlySet<string> | undefined {
  if (descriptors === undefined || descriptors.length === 0) return undefined;
  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    ids.add(
      getDerivedInternalCellLink(resultCell, {
        partialCause: descriptor.partialCause,
      }).id,
    );
  }
  return ids;
}

/**
 * Find the first write-redirect link within an output binding and return its
 * FULLY RESOLVED normalized link (`id` and `space` populated). The output spot
 * a pattern node writes through is reserved for that node, so its resolved
 * coordinates form a stable, position-derived, program-independent identity —
 * suitable as the cause for the node's result cell instead of hashing the
 * pattern object (which drags in the session-varying `program`). Returns
 * undefined if the binding contains no write redirect.
 *
 * A link whose id is in `causeOnlyIds` (a derived internal cell's kind-free
 * id — see {@link causeOnlySpotIds}) is returned PARSED, never resolved:
 * its coordinates are already the identity the caller wants, resolution of
 * a loaded spot stops there anyway (a stored plain link is not followed
 * under `writeRedirect`), and reading an absent one ties the scan to
 * replication state while kicking a doc pull nothing can satisfy — for a
 * kinded descriptor, the data lives at the KINDED entity and this id is
 * never written.
 *
 * Exported for tests only.
 */
export function firstResolvedOutputRedirect(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  binding: unknown,
  baseCell: Cell<any>,
  causeOnlyIds?: ReadonlySet<string>,
): NormalizedFullLink | undefined {
  // Sigil redirects only, as in recordOutputSchemaPolicyInputs. A surviving
  // `$alias` record — most often a partialCause binding deferred to a child
  // level — names a derived internal cell of THAT level, never this node's
  // reserved result spot, so it contributes no redirect here. The walk below
  // steps over it and keeps scanning; the derived cells themselves are
  // collected from each pattern's own derivedInternalCells manifest.
  if (isWriteRedirectLink(binding)) {
    const bindingBase = baseCell.getAsNormalizedFullLink();
    const parsed = parseLink(binding, bindingBase);
    if (causeOnlyIds?.has(parsed.id)) return parsed;
    return resolveLink(runtime, tx, parsed, "writeRedirect");
  }
  if (Array.isArray(binding)) {
    for (const child of binding) {
      const found = firstResolvedOutputRedirect(
        runtime,
        tx,
        child,
        baseCell,
        causeOnlyIds,
      );
      if (found) return found;
    }
    return undefined;
  }
  // TODO(danfuzz): the descent stops at a `FabricSpecialObject`, so a
  // write-redirect link inside a `FabricInstance`'s codec contents is
  // invisible here. The caller then sees no redirect and silently skips the
  // sub-pattern's owned-cell pre-sync keyed off it.
  if (!isCellLink(binding) && isKeyableObjectOrArray(binding)) {
    for (const child of Object.values(binding)) {
      const found = firstResolvedOutputRedirect(
        runtime,
        tx,
        child,
        baseCell,
        causeOnlyIds,
      );
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Identity for a sub-pattern node the resume owned-cell walk skipped, shared by
 * both of `#collectResumeOwnedCells`'s skip exits so a console trace names the
 * same things either way: the result cell being resumed and enough about the
 * node to find it in the pattern that was resumed.
 */
function describeSkippedSubPatternNode(
  resultCellLink: NormalizedFullLink,
  nodeIndex: number,
  node: Node,
  childPattern: Pattern,
): Record<string, unknown> {
  return {
    resultCell: resultCellLink.id,
    space: resultCellLink.space,
    nodeIndex,
    ...(node.description !== undefined && { node: node.description }),
    childPattern: describePatternOrModule(childPattern),
  };
}

const recordSetupProjectionPolicyInputs = (
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  resultCell: Cell<any>,
  resultSchema: JSONSchema | undefined,
  projection: unknown,
  schemaPath: readonly string[] = [],
): void => {
  if (resultSchema === undefined) {
    return;
  }

  const schema = schemaPath.length === 0
    ? resultSchema
    : ContextualFlowControl.getSchemaAtPath(resultSchema, [...schemaPath]);
  if (schema === undefined) {
    return;
  }

  // Sigil redirects only: the projection is about to be STORED (argument via
  // diffAndUpdate, result via setRawUntyped), and in stored data only sigil
  // links function as redirects — a residual `$alias` record (e.g. a
  // still-deferred binding of an embedded pattern) is inert there. The
  // prepare gate agrees: marker verification requires the stored value to be
  // a sigil redirect (`setupProjectionSourceMatchesValue`), and recording a
  // marker for an alias would wrongly widen
  // `writeIsPatternSetupInitialization`'s trusted-initialization exemption to
  // a path nothing redirects to.
  if (isWriteRedirectLink(projection)) {
    const target = resultCell.getAsNormalizedFullLink();
    const source = parseLink(projection, target);
    tx.recordCfcWritePolicyInput({
      kind: "structural-provenance",
      target: {
        space: target.space,
        id: target.id,
        scope: target.scope,
        path: [...target.path, ...schemaPath],
      },
      claim: CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
      sources: [{
        space: source.space,
        id: source.id,
        scope: source.scope,
        path: [...source.path],
      }],
    });
    return;
  }

  if (Array.isArray(projection)) {
    projection.forEach((child, index) =>
      recordSetupProjectionPolicyInputs(
        tx,
        runtime,
        resultCell,
        resultSchema,
        child,
        [...schemaPath, String(index)],
      )
    );
    return;
  }

  // Refused for the same reason as `recordOutputSchemaPolicyInputs()` above,
  // and this site is the more reachable of the two: `projection` is the _raw_
  // pattern argument, so a `FabricSpecialObject` a pattern actually wrote is
  // what arrives here. Fails _closed_ as well, so the throw buys diagnosis
  // rather than safety.
  //
  // TODO(danfuzz): descend by codec-mediated traversal into instance state, at
  // which point this becomes a walk rather than a refusal.
  if (projection instanceof FabricInstance) {
    refuseFabricInstance(
      projection,
      "when recording setup-projection policy inputs",
    );
  }

  if (isObjectOrArray(projection) && !isCellLink(projection)) {
    for (const [key, child] of Object.entries(projection)) {
      recordSetupProjectionPolicyInputs(
        tx,
        runtime,
        resultCell,
        resultSchema,
        child,
        [...schemaPath, key],
      );
    }
  }
};

/**
 * Name `substrate` as a store the runtime owns for `resultCell`'s piece — its
 * result document, its argument document, or an internal document or stream
 * its result projects to. The result document is the one address on the route
 * an author chose rather than the runtime derived, so a schema declaring at a
 * written path there keeps its own policy and the route stands aside.
 *
 * Such a store holds whatever the transaction filling it read, and an author
 * cannot know which atoms a given transaction will carry, so no
 * confidentiality declaration written into a schema covers it. CFC's
 * write-side fit check (spec §8.12.4) reads this marker and declares that
 * policy itself; `docs/specs/cfc-enforcement-matrix.md` §4 states the route.
 *
 * `substrate` must be an address MINTED from `resultCell`'s cause, never one
 * read back out of stored metadata: a stored `argument` link can name another
 * document, and that document is its owner's store rather than this piece's.
 * The address goes on verbatim, path included, and the fit check takes the
 * marker only where it names a whole document.
 *
 * The marker carries the runtime's authorization, which is what the fit check
 * asks for: the method that records it is reachable from anything holding a
 * cell, so an unmarked marker naming the same document counts for nothing. It
 * names the store for THIS transaction; the enrollment that carries the claim
 * into later ones is {@link enrollPieceOwnedStores}.
 */
const recordRuntimeOwnedStore = (
  tx: IExtendedStorageTransaction,
  resultCell: Cell<any>,
  substrate: NormalizedFullLink,
): void => {
  const result = resultCell.getAsNormalizedFullLink();
  tx.recordCfcWritePolicyInput({
    kind: "structural-provenance",
    target: {
      space: substrate.space,
      id: substrate.id,
      scope: substrate.scope,
      path: [...substrate.path],
    },
    claim: CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
    sources: [{
      space: result.space,
      id: result.id,
      scope: result.scope,
      path: [...result.path],
    }],
  }, runtimeWritePolicyAuthorization);
};

/**
 * The stores the runtime owns for `resultCell`'s piece: its result document,
 * its argument document, and each internal document its result projects to.
 *
 * Every address but the first is MINTED from `resultCell`'s cause, never read
 * back out of stored metadata: a stored `argument` or manifest link can name
 * another document — a nested piece's argument lives in its host's — and that
 * document is its owner's store rather than this piece's. What the piece does
 * not actually write is harmless to name, because nobody else mints these
 * addresses.
 *
 * The RESULT document is the exception, and the weakest member of the set. It
 * is often minted from a node's cause — a nested piece's is `{resultFor}`, and
 * that is the case the widening exists for — but a top-level piece's is an
 * address its caller chose, and unlike the others it HAS a value schema: the
 * pattern's `resultSchema`, which an author may write `ifc` into. So the
 * "no schema can declare this" argument does not carry it. What carries it is
 * narrower: from the moment setup writes this piece's meta into it, the
 * document is that piece's store, and the runtime fills it with what the
 * transaction read. Where the author DID declare, `remintedDeclaredPaths`
 * hands the path back to them and the route declines. Where they did not, the
 * route reaches every path written there — by any writer, not only by the
 * runtime, since what it tests is the store rather than the caller.
 */
const pieceOwnedStores = (
  tx: IExtendedStorageTransaction,
  resultCell: Cell<any>,
  pattern: Pattern,
): NormalizedFullLink[] => [
  resultCell.getAsNormalizedFullLink(),
  getMetaCell(resultCell, "argument", tx).getAsNormalizedFullLink(),
  ...(pattern.derivedInternalCells ?? []).map((descriptor) =>
    getDerivedInternalCellLink(resultCell, descriptor)
  ),
];

/**
 * Name this piece's stores for the transaction setting it up. Setup fills them
 * in the transaction that names them, so the marker is all it needs.
 */
const markPieceOwnedStores = (
  tx: IExtendedStorageTransaction,
  resultCell: Cell<any>,
  pattern: Pattern,
): void => {
  for (const store of pieceOwnedStores(tx, resultCell, pattern)) {
    recordRuntimeOwnedStore(tx, resultCell, store);
  }
};

/**
 * Name this piece's stores and ENROLL them, which is what the graph about to
 * run needs: its reactive updates, event handlers and settled requests each
 * write on a transaction of their own, and none of them names anything.
 *
 * Called at node instantiation rather than at setup, so that a piece started
 * from its stored identity — a cold replica loading one — enrolls too, and so
 * that a setup attempt that never commits enrolls nothing. It runs again on
 * every re-instantiation, which is idempotent; the enrollment goes out once,
 * with the piece, at the release `Runner.#startCore()` registers.
 */
const enrollPieceOwnedStores = (
  tx: IExtendedStorageTransaction,
  resultCell: Cell<any>,
  pattern: Pattern,
): void => {
  const owner = resultCell.getAsNormalizedFullLink();
  const identity = resultCell.runtime.scopeKeyIdentity;
  for (const store of pieceOwnedStores(tx, resultCell, pattern)) {
    recordRuntimeOwnedStore(tx, resultCell, store);
    // Same space by construction: every store here is minted in the result
    // cell's space, which is the owner's.
    const ownerKey = runtimeOwnedStoreOwnerKey(store, owner, identity)!;
    tx.enrollRuntimeOwnedStore(
      {
        space: store.space,
        id: store.id,
        scope: store.scope,
        path: [...store.path],
      },
      ownerKey,
      runtimeWritePolicyAuthorization,
    );
  }
};

type SetupResult<R> = {
  resultCell: Cell<R>;
  pattern?: Pattern;
  patternRef?: { identity: string; symbol: string };
  needsStart: boolean;
};

/** Receipt for a pattern setup transaction accepted by storage. */
export interface PatternSetupCommitReceipt {
  /** Content-addressed pattern pointer written by the transaction. */
  pattern: { identity: string; symbol: string };
  /** The space whose commit log accepted the transaction. */
  space: MemorySpace;
  /**
   * Position in `space`'s commit log at which storage accepted the
   * transaction. With `space` it is the coordinate `cf inspect value-at --seq`
   * and `diff --from/--to` read, and it orders this receipt against every
   * other commit to the space.
   */
  seq: number;
}

/** Result of running a pattern through an owned setup transaction. */
export interface RunSyncedCommitResult<R> {
  /** Cell view reconciled to the pattern current after post-commit work. */
  cell: Cell<R>;
  /** Receipt issued from the accepted setup transaction. */
  commit: PatternSetupCommitReceipt;
}

/**
 * Why a committed setup receipt is unavailable while sealing into a wave.
 * Entry and transaction checks share this message so callers can identify the
 * refusal regardless of when the seal destination was installed.
 */
export const SEALING_RECEIPT_REFUSAL =
  "a committed pattern setup receipt is unavailable while sealing into a " +
  "wave, whose acceptance a later withdrawal can undo";

/** Why a withdrawable wave cannot publish source-update authority. */
export const SEALING_SOURCE_UPDATE_REFUSAL =
  "source update authority requires a durable setup commit and cannot be " +
  "published while sealing into a wave, whose acceptance a later withdrawal " +
  "can undo";

/**
 * Reports work which failed after storage accepted a pattern setup.
 *
 * The receipt remains authoritative for the setup transaction. `.cause`
 * describes the later dependency synchronization, start, or schema-load
 * failure.
 */
export class PatternSetupPostCommitError extends Error {
  #commit: PatternSetupCommitReceipt;

  /** Constructs an instance carrying the accepted transaction's receipt. */
  constructor(commit: PatternSetupCommitReceipt, cause: unknown) {
    super("pattern setup committed, but post-commit processing failed", {
      cause,
    });
    this.name = "PatternSetupPostCommitError";
    this.#commit = commit;
  }

  /** Receipt issued for the accepted setup transaction. */
  get commit(): PatternSetupCommitReceipt {
    return this.#commit;
  }
}

/** Options which constrain and annotate an atomic pattern setup. */
export interface RunSyncedOptions {
  /** Pattern pointer which must still be current inside the transaction. */
  expectedPatternIdentity?: { identity: string; symbol: string };
  /** Invariant over the argument stored before setup changes it. */
  validateCurrentArgument?: (argumentCell: Cell<unknown>) => void;
  /** Invariant over links retained by the candidate argument schema. */
  validateArgumentLinks?: (
    argumentCell: Cell<unknown>,
    argumentSchema: JSONSchema,
  ) => void;
  /** Repository locator written atomically with pattern setup. */
  patternRepository?: string;
  /** Source lifecycle change written atomically with ordinary pattern setup. */
  pieceSourceTransition?: PieceSourceTransition;

  /**
   * Commit the setup transaction to the store directly rather than sealing
   * it into a serving wave, so its verdict is the store's own. A serving
   * runtime's transactions otherwise seal into the cycle's wave, whose
   * acceptance a later withdrawal can undo, and a receipt or source-update
   * authority requires the durable verdict. Inert where no seal destination
   * is installed.
   */
  directCommit?: boolean;

  /**
   * Whether to start the piece once its setup has committed; `true` when
   * absent. `false` leaves the piece set up under its new pattern and not
   * run here, for a runtime that runs pieces on demand: a serving runtime's
   * swap watcher replaces a running piece's graph on the pointer write, and
   * its demand pass runs an unrun one.
   */
  start?: boolean;

  /**
   * The trust snapshot the owned setup transaction carries, set ahead of
   * its first read on every attempt: a serving runtime acting on a
   * requester's behalf supplies the requester's, so a label the setup
   * mints attributes to them rather than to the serving identity. Absent,
   * the transaction keeps the runtime's ambient snapshot. Not applied to a
   * caller-owned transaction, which keeps its owner's.
   */
  cfcTrustSnapshot?: TrustSnapshot;
}

/** Options for a pattern setup whose fresh source revision proves a commit. */
export interface RunSyncedWithCommitOptions extends RunSyncedOptions {
  /** Pattern pointer which must still be current inside the transaction. */
  expectedPatternIdentity: { identity: string; symbol: string };
  /**
   * Fresh source revision written by this transaction.
   *
   * Required because storage elides wholly redundant transactions before they
   * reach the server. The unique revision is the novelty which makes a
   * successful verdict proof that storage accepted this particular setup.
   */
  pieceSourceTransition: PieceSourceTransition;
}

type SetupValidationOptions = {
  /** Proposed module authority owned by this source transition. */
  sourceUpdate?: PreparedSourceUpdate;

  /** See `RunnerRunOptions.referencedArgumentFields`. */
  referencedArgumentFields?: readonly string[];

  /** Optional invariant over the argument stored before setup changes it. */
  validateCurrentArgument?: (argumentCell: Cell<unknown>) => void;

  /** Optional layer-specific invariant checked inside the setup transaction. */
  validateArgumentLinks?: (
    argumentCell: Cell<unknown>,
    argumentSchema: JSONSchema,
  ) => void;

  /** Optional repository locator written atomically with pattern setup. */
  patternRepository?: string;

  /** Source lifecycle change written atomically with pattern setup. */
  pieceSourceTransition?: PieceSourceTransition;

  /** Record a detached creation revision when setting up a new piece. */
  initializePieceSourceHistory?: boolean;

  /** Mutable source origin recorded with a new piece's creation revision. */
  initialPieceSourceOrigin?: string;

  /** Rebuild stored setup state even when patternIdentity already matches. */
  reapplyStoredSetup?: boolean;

  /** Keep the next start on the persisted-result dependency-sync path. */
  prepareForResume?: boolean;
};

export type PieceSourceRevisionOperation =
  | "baseline"
  | "create"
  | "edit"
  | "origin-update"
  | "detach"
  | "revert"
  | "follow"
  | "repoint";

export interface PieceSourceRevision {
  revisionId: string;
  timestamp: number;
  pattern: { identity: string; symbol: string };

  /** Link retaining the exact content-addressed source closure. */
  source: SigilLink;

  origin?: string;

  /** The legacy origin string, when normalizing it changed its value. */
  recordedOrigin?: string;

  operation: PieceSourceRevisionOperation;
  selectedRevisionId?: string;
}

export interface PieceSourceSnapshot {
  pattern: { identity: string; symbol: string };
  origin: string | null;
  revisionId: string | null;
}

/** What the last attempt to follow a piece's active origin did. */
export type PieceReconciliationOutcome =
  | "followed"
  | "unreachable"
  | "refused";

/**
 * Why a reconciliation did not adopt what its origin offered.
 *
 * `incompatible-schema` and `argument-mismatch` are different refusals and
 * only one of them can be overruled. The first says the candidate is not an
 * acceptable replacement for what the piece runs, which its owner may decide
 * to accept anyway. The second says the piece's own stored data does not
 * satisfy the candidate, so the piece could not run it — there is nothing to
 * accept, and the data has to change first.
 */
export type PieceReconciliationReason =
  | "incompatible-schema"
  | "argument-mismatch"
  | "source-invalid"
  | "identity-mismatch"
  | "apply-failed";

/**
 * The outcome of the last attempt to follow a piece's active origin, kept on
 * the piece so a reader can tell a piece that runs what its origin offers from
 * one that does not. It is not a revision: a refused candidate was never
 * accepted, and the revision log records only what the piece adopted.
 */
export interface PieceReconciliation {
  outcome: PieceReconciliationOutcome;

  /** When the piece reached this outcome. */
  at: number;

  /** The origin the attempt was following. */
  origin: string;

  /** The pattern the origin offered, when one was resolved. */
  offered?: { identity: string; symbol: string };

  /** Why the candidate was refused. Absent unless `outcome` is `refused`. */
  reason?: PieceReconciliationReason;

  /** What the attempt reported, in its own words. */
  detail?: string;
}

export type PieceSourceTransitionBaseline =
  | { kind: "retain"; revisionId: string }
  | { kind: "unavailable" };

export interface PieceSourceTransition {
  revisionId: string;
  baseline: PieceSourceTransitionBaseline;
  timestamp: number;
  operation: Exclude<PieceSourceRevisionOperation, "baseline" | "create">;

  /** The active origin after the transition. Null means detached. */
  origin: string | null;

  expected: PieceSourceSnapshot;
  selectedRevisionId?: string;
}

/**
 * Pre-syncs what a run of `pattern` on `resultCell` reads before it runs:
 * the result document, what each node's plan names under its read schema,
 * and the cells the pattern owns; on a fresh run the plans bind against an
 * immutable stand-in holding `inputs`. Resolves to whether the plans ran:
 * the shape of `Runner`'s own step.
 */
export type DependencySync = (
  resultCell: Cell<any>,
  pattern: Pattern,
  inputs?: any,
) => Promise<boolean>;

/**
 * The dependency pre-sync a test supplies in place of `Runner`'s own step.
 * It receives that step as `sync`, so it can pause before it, fail in its
 * stead, or observe what it returns.
 */
export type DependencySyncer = (
  resultCell: Cell<any>,
  pattern: Pattern,
  inputs: any,
  sync: DependencySync,
) => Promise<boolean>;

/**
 * Commits a commit-gated start's transaction and resolves to its verdict:
 * the shape of `Runner`'s own step.
 */
export type DeferredStartCommit = () => Promise<Result<Unit, CommitError>>;

/**
 * The committer a test supplies around `Runner`'s own commit of a
 * commit-gated start's transaction. It receives that step as `commit`, so
 * it can refuse the transaction in its stead, mark it before the store sees
 * it, or observe its verdict; `resultCell` is the piece the start is for.
 */
export type DeferredStartCommitter = (
  tx: IExtendedStorageTransaction,
  resultCell: Cell<any>,
  commit: DeferredStartCommit,
) => Promise<Result<Unit, CommitError>>;

type RunResult<R> = {
  resultCell: Cell<R>;

  /** The exact local cancel registration installed by this invocation. */
  installedCancel?: Cancel;

  /**
   * Cancels a start that this invocation deferred until its transaction
   * commits. Before installation it tombstones the pending start; afterwards
   * it stops the piece only when this invocation actually installed it.
   */
  cancelDeferredStart?: Cancel;
};

type DeferredStartResult<R> = {
  resultCell: Cell<R>;
  cancelDeferredStart?: Cancel;
};

type BoundNodeIO = {
  inputs: FabricExecValue;
  outputs: FabricExecValue;
  writes: NormalizedFullLink[];
  /**
   * The bound inputs as an immutable document: what a node reads its
   * argument from, and what the pre-sync syncs under the node's read schema.
   */
  inputsCell: Cell<any>;
};

/**
 * A raw node's bound inputs and outputs as `#instantiateRawNode()` hands
 * them to the builtin.
 */
type RawNodeInputs = BoundNodeIO & {
  argumentCellLink: NormalizedFullLink;
  resolvedOutputSpot: NormalizedFullLink | undefined;
  outputBinding: NormalizedFullLink | undefined;
};

/**
 * A pattern node's bound child and the result cell it runs under.
 * `childResultCell` is `undefined` when the outputs hold no write redirect
 * to anchor the child's identity on. `sendToBindings` says whether the
 * child's link is written through the outputs, or the outputs already name
 * the child's result cell.
 */
type PatternNodeBinding = Omit<BoundNodeIO, "inputsCell"> & {
  child: Pattern;
  childResultCell: Cell<any> | undefined;
  sendToBindings: boolean;
};

/**
 * What one node's bindings resolve to on a result cell: the module the node
 * runs, its inputs and outputs bound to the piece's argument and result
 * documents, the write-redirect links those bindings write through,
 * and what the node's kind adds. Instantiation and the pre-sync
 * derive it the same way, so what the pre-sync names is what the
 * instantiated node reads.
 */
export type NodePlan =
  | ({ kind: "javascript"; module: Module } & BoundNodeIO)
  | ({
    kind: "raw";
    module: Module;
    moduleRefName: string | undefined;
  } & RawNodeInputs)
  | ({ kind: "passthrough"; module: Module } & BoundNodeIO)
  | ({ kind: "pattern"; module: Module } & PatternNodeBinding);

type ResolvedJavaScriptModule = {
  fn: (...args: any[]) => any;
  name: string | undefined;
};

type JavaScriptNodeContext = BoundNodeIO & {
  reads: NormalizedFullLink[];
  tx: IExtendedStorageTransaction;
  module: Module;
  resultCell: Cell<any>;
  addCancel: AddCancel;
  pattern: Pattern;
  fn: (...args: any[]) => any;
  name: string | undefined;
  schedulerRehydration: SchedulerRehydrationSubscriptionOptions;
};

type JavaScriptActionResultCells = {
  // One result cell PER SCOPE INSTANCE, keyed by the shared scope_key
  // vocabulary (key-vocabulary.md §1 site 3) — never by the scope NAME:
  // on a serving runtime `byScope.get("session")` would return ONE cell
  // where the server needs one per session. The keys are built from the
  // acting identity at lookup time; in the OFF arm that is the runtime's
  // own session, so exactly one instance exists per scope name and the
  // map partitions as the name-keyed form did.
  byScope: Map<ScopeKey, Cell<any>>;
};

/** Selects a program using the current run's scoped pattern pointer. */
type ImplementationSelection = {
  key: string;
  actions: Set<Action>;
  instanceInitializers: Set<(tx: IExtendedStorageTransaction) => void>;
  matches(tx: IExtendedStorageTransaction): boolean;
};

/** Keeps guarded program groups distinct in scheduler dependency records. */
function programActionInstanceKey(
  instanceKey: string,
  selection: ImplementationSelection | undefined,
): string {
  return selection === undefined
    ? instanceKey
    : hashStringOf({ instanceKey, program: selection.key });
}

type SchedulerRehydrationSubscriptionOptions = {
  adoptViewIdentity?: string;
  implementationSelection?: ImplementationSelection;
  viewNodeId?: string;
  viewLocalOnly?: boolean;
  // The owning pattern instance for this reader, set unconditionally so the
  // scheduler can group a pattern's shaped cell-flip wakes by instance (timing
  // side-channel mitigation) and tell a pattern reader from internal machinery.
  observationIdentity?: {
    pieceId: string;
    ownerSpace: MemorySpace;
  };
  // Defer initial action runs until the space finishes syncing, so
  // re-running actions read confirmed-loaded inputs.
  awaitSyncBeforeInitialRun?: {
    space: MemorySpace;
  };
};

// Whether resumed nodes should hold their initial run until the space syncs.
// Used to propagate the intent to cross-space child runs and container-minting
// builtins.
function defersInitialRunUntilSynced(
  options: SchedulerRehydrationSubscriptionOptions,
): boolean {
  return !!options.awaitSyncBeforeInitialRun;
}

/** One pattern instance the resume pre-sync visits: the pattern and the
 * result cell it runs under. */
type ResumePatternInstance = { pattern: Pattern; resultCell: Cell<any> };

const LIST_OP_INPUT_SCHEMAS = {
  map: MAP_INPUT_SCHEMA,
  filter: FILTER_INPUT_SCHEMA,
  flatMap: FLATMAP_INPUT_SCHEMA,
} as const;

// Options shared by `run()`, `#startWithTx()`, and
// `#startAfterSuccessfulCommit()`.
type RunnerRunOptions = {
  doNotUpdateOnPatternChange?: boolean;
  // Resumed-from-synced-state: hold each action's initial rehydration/run until
  // the space has finished syncing, so consumers don't race the data.
  awaitSyncBeforeInitialRun?: boolean;
  // The piece root that INSTANTIATED this piece (a nested pattern node's
  // parent, a result-as-pattern child's producing piece). Its actions'
  // demand roots (`SchedulerObservationIdentity.demandRootIds`) become the
  // parent's chain plus this root, so the serving loop's per-(action ×
  // instance) run supply resolves a nested piece's demanded instances
  // through the OUTER piece a client watches.
  parentPieceRootId?: string;
  // Argument fields a collection builtin fills with a link to a cell that
  // exists already: a list's entry, the list itself. Each one whose staged
  // value is such a link is recorded as a protected initialization
  // (docs/specs/cfc-protected-initialization.md), so handing a new piece a
  // reference to an owner-protected cell does not pass for modifying it.
  referencedArgumentFields?: readonly string[];
  // The source origin a piece brought into being by this run records with its
  // creation revision. A run that finds the piece already there leaves both
  // alone: what a piece records after it exists is decided by a source
  // transition, never by another run of it.
  sourceOrigin?: string;
};

// The relaxed copy of a handler's argument schema, built once per schema
// rather than once per dispatched event: `generateHandlerSchema` interns its
// result (interned schemas are deep-frozen), so every dispatch of the same
// handler shares one entry by identity. Only deep-frozen schemas are cached —
// a mutable schema edited after its first dispatch must not keep serving a
// stale relaxed copy (the same rule the cfc resolvedRefsCache applies).
const relaxedHandlerSchemaCache = new WeakMap<object, JSONSchema>();

/**
 * The dispatch-side closed-world gate: under a closed event schema an
 * undeclared field is a rejection, never ignored.
 *
 * Returns the rejection message when a PRESENT event payload cannot satisfy
 * an event schema that declares `additionalProperties: false` — read off the
 * handler's `$event` schema itself, or off the definition a top-level local
 * `$ref` names (`generateHandlerSchema` hoists the event schema's `$defs`
 * onto the handler schema, so that schema is the root local refs resolve
 * against). Closure inside a combinator root (`allOf`/`anyOf`/`oneOf`) is
 * deliberately NOT detected. The miss direction is safe: an undetected
 * closure gets open-schema delivery, never a false rejection. Everything
 * else returns `undefined`:
 *
 * - An OPEN event schema: the schema read path delivers the declared fields
 *   and ignores the rest, and a payload that misses the schema reads back as
 *   an absent event. Closure is the schema's opt-in.
 * - An ABSENT payload is deliverable as `undefined` regardless of closure:
 *   absence is the CLI gate's question, and defaults never materialize for
 *   an absent event.
 *
 * Validation is the same composition the CLI's pre-dispatch gate applies
 * (`verbInputSchemaError`, packages/cli/lib/callable.ts): `required` lists are
 * relaxed for defaulted properties first (the runtime fills a present object's
 * missing defaulted properties before checking `required`, so judging the
 * unrelaxed schema would refuse payloads the verb accepts), then
 * `validateSchemaValue` judges the payload. Cell links inside the payload are
 * accepted opaquely: a link's target cannot be read here, and its schema check
 * belongs to the handler's own reactive reads — the same deferral the
 * pattern-argument validator applies to unresolvable links. A link VALUE passes
 * unjudged; an undeclared KEY still rejects.
 *
 * On rejection the handler wrapper throws, which fails the handling exactly
 * the way a thrown handler error fails — with no receipt shape, error class,
 * or wire format of its own.
 */
function closedWorldEventRejection(
  argumentSchema: JSONSchema | undefined,
  event: unknown,
  runtimeInjectedEventKeys?: readonly string[],
): string | undefined {
  if (event === undefined) return undefined;
  if (
    !isObjectOrArray(argumentSchema) ||
    !isObjectOrArray(argumentSchema.properties)
  ) {
    return undefined;
  }
  const eventSchema = argumentSchema.properties.$event;
  if (!isObjectOrArray(eventSchema)) return undefined;
  const refTarget = localRefTarget(eventSchema, argumentSchema);
  const closed = eventSchema.additionalProperties === false ||
    (isObjectOrArray(refTarget) && refTarget.additionalProperties === false);
  if (!closed) return undefined;

  // The runtime itself merges keys into some payloads — the LLM tool-call
  // path injects a `result` cell (`builtins/llm-dialog.ts`:
  // `handler.send({ ...input, result })`, hidden from the advertised schema
  // by `stripInjectedResult` there and `cloneWithoutBoundToolKeys` in the
  // CLI) — and the gate must not refuse a field the runtime injected. The
  // exemption is PROVENANCE, not shape: the injection site names its keys
  // through the send's internal options (mint-gated — see
  // `markRuntimeInjectedEventKeys`, cell.ts), which travel out-of-band to
  // `tx.dispatchedRuntimeInjectedEventKeys`, so payload DATA can never claim
  // it — a caller-supplied `result`, cell-link-valued or not, arrives
  // unmarked and is judged like any other undeclared field. (A shape rule —
  // "any link-valued `result` passes" — would let every caller smuggle an
  // undeclared key past closed-world by supplying a link, recreating the
  // accepted-and-ignored behavior this gate exists to kill.)
  //
  // A marked key the schema DECLARES is not stripped: the schema governs —
  // the handler asked for the slot, so the injected value is validated like
  // any field and delivered intact (stripping it would fail a required
  // declared `result` as missing). Only UNDECLARED marked keys are the
  // runtime's invisible side-channel, excluded from judgment entirely; the
  // handler never sees an undeclared one either way — the schema read path
  // only delivers declared fields.
  let payload: unknown = event;
  if (
    runtimeInjectedEventKeys !== undefined &&
    runtimeInjectedEventKeys.length > 0 &&
    isObjectOrArray(event)
  ) {
    const declaredProperties =
      isObjectOrArray(refTarget) && isObjectOrArray(refTarget.properties)
        ? refTarget.properties
        : undefined;
    const rest = { ...(event as Record<string, unknown>) };
    let strippedAny = false;
    for (const key of runtimeInjectedEventKeys) {
      if (
        declaredProperties !== undefined &&
        Object.hasOwn(declaredProperties, key)
      ) {
        continue;
      }
      delete rest[key];
      strippedAny = true;
    }
    if (strippedAny) payload = rest;
  }

  const cacheable = isDeepFrozen(argumentSchema);
  let relaxedRoot = cacheable
    ? relaxedHandlerSchemaCache.get(argumentSchema)
    : undefined;
  if (relaxedRoot === undefined) {
    relaxedRoot = relaxDefaultedRequired(
      argumentSchema,
      argumentSchema,
      new Map(),
    );
    if (cacheable) relaxedHandlerSchemaCache.set(argumentSchema, relaxedRoot);
  }
  const relaxedEvent =
    isObjectOrArray(relaxedRoot) && isObjectOrArray(relaxedRoot.properties)
      ? relaxedRoot.properties.$event
      : undefined;
  if (relaxedEvent === undefined) return undefined;

  const failure = validateSchemaValue(relaxedEvent, payload, relaxedRoot, {
    acceptOpaqueValue: (value) => isCellLink(value),
  });
  if (failure === undefined) return undefined;
  return "Event payload rejected by the verb's closed event schema " +
    "(additionalProperties: false — an undeclared field is a rejection, " +
    `never ignored): ${failure}`;
}

/**
 * How setup should treat the state already stored on a result cell.
 *
 * They are distinct on purpose. `sameStoredSetup` answers "is this the same run
 * of the same pattern", which is what name preservation keys on;
 * `restageStoredArgument` answers "was this pattern's argument schema ever
 * staged here", which a pointer comparison cannot see on a repair; and
 * `storedSetupMatches` answers "is the running graph provably this pattern",
 * which only a marker that NAMES it can establish.
 */
interface SetupStateReuse {
  /** Same pattern as the last run, so stored setup state is this run's own. */
  sameStoredSetup: boolean;

  /** Re-point the stored argument at this schema and validate it. */
  restageStoredArgument: boolean;

  /**
   * Same stored setup AND a completion marker that POSITIVELY names this
   * pattern. Distinct from `!restageStoredArgument`, which is also true when the
   * marker is absent — absence is not evidence that the running graph is this
   * pattern, only the lack of evidence that it is not.
   */
  storedSetupMatches: boolean;

  /**
   * Leave the completion marker as it stands. The marker says an identity's
   * argument was staged along with its internal cells and result projection,
   * and a later setup that finds it matching re-stages and validates nothing.
   * A caller that deliberately leaves the argument alone has not staged all of
   * that, so it leaves the marker saying what it said.
   */
  leaveCompletionMarker?: boolean;
}

/**
 * What the setup-completion marker on `resultCell` says about `entryRef`:
 * `"matches"` (staged by this pattern), `"other"` (staged by a different
 * version), or `"absent"` (nothing recorded).
 *
 * Three states rather than a boolean, because the two ways of not being
 * `"other"` license different things. `"matches"` is positive evidence that the
 * running graph is this pattern; `"absent"` is no evidence at all, and code
 * that collapses them writes state describing a version that may not be there.
 *
 * `patternIdentity` alone cannot answer this, because an update can move the
 * pointer before any setup runs. `PiecesController`'s roll-forward heal
 * commits the candidate's identity and then calls `runSynced`, and when that
 * second commit fails the root is left with its pointer moved and no setup at
 * all — to boot through `PiecesController`'s cold-start setup repair. Either
 * way the pointer already names the pattern being set up, so comparing
 * pointers reports "same pattern" for what is in fact an update. A
 * caller that hands setup a pattern the pointer does not name yet — `cf piece
 * setsrc`, which positively asserts the pointer has NOT moved, or the ordinary
 * default-root apply — is already recognized as a change without this.
 *
 * The completion marker is the signal that survives that: `#applySetupState`
 * stamps `patternSetupIdentity` only once it has staged this identity's schema,
 * arguments, internal cells and result projection, so a marker naming another
 * version means the stored argument was staged against another version's schema
 * and must be re-staged — and re-validated — against this one.
 *
 * Not every caller wants that conclusion, so this is a signal rather than a
 * policy: the nested-piece instantiation repair re-verifies the pinned identity
 * itself and opts out (`restageStoredArgument: false`), because it is the same
 * pattern rebuilding its own internal cells rather than an update.
 *
 * For the RE-STAGE decision specifically, an ABSENT marker reads as "same",
 * deliberately — `storedSetupMatches` is what callers use when they need the
 * positive fact instead. It cannot distinguish a
 * pending update from a root written before the marker existed, and re-staging
 * every such root would validate — and rewrite defaults over — arguments no
 * update is touching, turning a legacy doc into a piece that will not start.
 * That exemption currently covers most stored roots rather than a rare tail:
 * the marker itself is recent, so a root written before it exists gets one
 * unvalidated setup, and it is the aged roots — the ones most likely to hold an
 * argument a new schema cannot read — that are exempt for that one setup.
 */
type StoredSetupMarker = "matches" | "other" | "absent";

// `sessionRef` is a KEYLESS piece's session-side stand-in for the durable
// completion marker (see `Runner.#sessionPatternPointers`): the never-durable
// contract skips the `patternSetupIdentity` stamp for a keyless piece, and
// without a marker every re-setup of a re-derived sub-piece (a lift
// returning a pattern) would read "absent" and restage its own running
// setup.
function storedSetupMarker(
  resultCell: Cell<unknown>,
  entryRef: { identity: string; symbol: string } | undefined,
  sessionRef?: { identity: string; symbol: string },
): StoredSetupMarker {
  if (entryRef === undefined) return "absent";
  const stagedRef = getPatternSetupIdentityRef(resultCell) ?? sessionRef;
  if (stagedRef === undefined) return "absent";
  return patternIdentityKey(stagedRef) === patternIdentityKey(entryRef)
    ? "matches"
    : "other";
}

function dedupeNormalizedLinks(
  links: readonly NormalizedFullLink[],
): NormalizedFullLink[] {
  const deduped: NormalizedFullLink[] = [];
  for (const link of links) {
    if (deduped.some((existing) => areNormalizedLinksSame(existing, link))) {
      continue;
    }
    deduped.push(link);
  }
  return deduped;
}

/**
 * A started piece's registration: the cancel that retires it, carrying
 * whether the pattern graph it was installed with is still there. The
 * registration outlives that graph — a refused instantiation commit retires
 * the graph and the recovery installs another under the same registration —
 * so a caller asking what the piece can serve right now reads the probe
 * rather than the registration's presence.
 */
type PieceRegistration = Cancel & { graphIsInstalled: () => boolean };

/** A resident view graph whose unavailable bindings can resume independently. */
export type ViewPieceRegistration = PieceRegistration & {
  /** Binds newly available nodes; returns false if this registration retired. */
  resume(): boolean;
};

/** One shared piece registration with a node group per selected program. */
type ScopedPieceRegistration = PieceRegistration & {
  piece: string;
  variants: Map<string, PieceRegistration>;
  ensure(tx: IExtendedStorageTransaction, pattern: Pattern): void;
  wake(): void;
};

/** A node group's local ownership within a shared piece registration. */
type PieceVariantRegistration = {
  registrations: Map<string, PieceRegistration>;
  selection: ImplementationSelection;
};

export class Runner {
  #runtime: Runtime;
  readonly #cancels = new Map<
    `${MemorySpace}/${ScopeKey}/${URI}`,
    PieceRegistration
  >();
  #allCancels = new Set<Cancel>();
  #scopedPieces = new Map<string, ScopedPieceRegistration>();
  #scopedChildOwners = new Map<string, Set<object>>();

  /**
   * In-flight unloadable-pointer roll-forward commits. Deliberately outside the
   * scheduler, like `SourceReconciler`'s passes — `Runtime.dispose()` settles
   * both before the storage sessions they write through close. Bounded local
   * commits only.
   */
  #pendingPointerCommits = new Set<Promise<unknown>>();

  /**
   * In-flight watcher pattern-load attempts. _Never_ awaited by `dispose()`: a
   * load can be arbitrarily slow or wedged (network), and the fire-and-forget
   * design guards post-settle work with lifecycle epochs instead — awaiting
   * them would let one held load hang teardown. Tracked solely so tests can
   * synchronize deterministically under the frozen-clock preload, where
   * wall-clock polling cannot observe this work.
   */
  #pendingWatcherPatternLoads = new Set<Promise<unknown>>();

  /**
   * In-flight catch-up recoveries of commit-gated starts whose transaction lost
   * its basis to the serving side's own first-hydration materialization (see
   * `#catchUpAndStartOnStaleRead()`). _Never_ awaited by `dispose()`, for
   * the same reason as the watcher loads above: the readiness gate they await
   * is a session catch-up, which a closing runtime may never reach, and a
   * cancelled ownership already tombstones the work. Tracked solely so tests
   * can synchronize deterministically.
   */
  #pendingDeferredStartCatchUps = new Set<Promise<unknown>>();

  /**
   * In-flight settlements of self-minted piece instantiations, which commit
   * asynchronously. Their local graph is speculative until the commit and any
   * serving-wave settlement succeed, so a stale-read refusal or contribution
   * drop tears down that exact node group and re-instantiates it once against
   * the repaired view. This set is a deterministic test seam: disposal relies
   * on the registration and lifecycle guards rather than waiting for a
   * readiness gate or a wave that a closing serving loop may abandon.
   */
  #pendingPieceInstantiationSettlements = new Set<Promise<unknown>>();

  /**
   * Results this runner prepared, so a later start of the same result can reuse
   * the cells it already assembled instead of re-syncing dependencies and
   * rehydrating a snapshot. This map and `#locallyStoppedResults` are
   * shortcuts: a missing entry costs a slower start, never a wrong one. They
   * are bounded for that reason — a result key names one result document, and a
   * pattern that keeps starting and stopping children adds keys it will never
   * revisit.
   */
  readonly #locallyPreparedResults = new BoundedKeyMap<
    `${MemorySpace}/${ScopeKey}/${URI}`,
    string
  >(RESULT_SHORTCUT_LIMIT);

  /** Results this runner stopped, paired with `#locallyPreparedResults`. */
  readonly #locallyStoppedResults = new BoundedKeyMap<
    `${MemorySpace}/${ScopeKey}/${URI}`,
    string
  >(RESULT_SHORTCUT_LIMIT);

  /**
   * Successful event-result starts that are still live in this runner. This is
   * intentionally local and bounded by live starts: it lets a sequential
   * redelivery avoid re-materializing an already-won result before the
   * create-only receipt guard rejects the duplicate. It is not a replacement
   * for the system-wide commit precondition.
   */
  #locallyCommittedHandlerResultStarts = new Set<
    `${MemorySpace}/${ScopeKey}/${URI}`
  >();

  /**
   * Diagnostic counter, for tests (the loud-no-op pin): served receipt writes
   * skipped as write-once CAS losses — the handling's result cell already held
   * a value when the serving run went to write it
   * (`handleJavaScriptHandlerResult()`'s serving-side write, `events.md` §4,
   * "Result carriage"). Each skip also logs a warn line; this is the
   * machine-readable half.
   */
  #servedReceiptCasLosses = 0;

  /**
   * Results started in their own right rather than as part of an enclosing
   * pattern, which is what navigating to a nested result does. An enclosing
   * pattern releasing such a result leaves it running; only stopping it
   * directly ends it.
   */
  #independentlyStartedResults = new Set<
    `${MemorySpace}/${ScopeKey}/${URI}`
  >();

  /**
   * Tombstones for `#sessionPatternPointers` entries dropped by _capacity
   * eviction_ — never by the sanctioned removals (a real pattern's durable
   * stamps superseding the pointer; a failed staging's cleanup). Each records
   * the _pointer_ the eviction dropped, and the zero-evidence restage exemption
   * in `#setupInternal()` consults it: an evicted pointer is evidence unknown,
   * not no evidence. A re-setup with a _different_ identity takes the
   * conservative restage the un-evicted state would have taken — without the
   * tombstone, eviction silently skipped that revalidation. A re-setup with the
   * _same_ identity is evidence _agreeing_ with the stored setup (the mint is a
   * stable content hash of the pattern structure), so it keeps the exemption's
   * protective verdict: forcing a restage there would strictly validate a
   * stored argument the original staging never validated — the cf-get replay
   * breakage the exemption exists to prevent, manufactured in-session past 4096
   * setups. Entries are never individually removed (the doubt they record stays
   * true for every state that consults them); bounded like the pointer map
   * itself, so a doubly-blown bound degrades honestly to the designed
   * zero-evidence verdict.
   */
  #evictedSessionPatternPointers = new BoundedKeyMap<
    `${MemorySpace}/${ScopeKey}/${URI}`,
    { identity: string; symbol: string }
  >(RESULT_SHORTCUT_LIMIT);

  /**
   * _Session_-side pattern pointers for _keyless_ pieces. A hand-built
   * pattern's setup does not stamp its session-synthetic `keyless:` ref durably
   * (the never-durable contract), but the in-session flows that need that
   * pointer are sanctioned and go through this map instead: a separate
   * `start(resultCell)` after setup, `setup()`/`run()` without a pattern,
   * restart after `stop()`, and the setup-reuse marker (`storedSetupMarker()`)
   * that lets a re-derived sub-piece (a lift returning a pattern) reuse its
   * running setup rather than restage it. Served transactions stage their
   * pointer in a transaction-local overlay and publish it here only after
   * acceptance, including wave settlement. Client setup publishes eagerly and
   * restores the accepted pointer on failure. A real pattern's accepted stamps
   * supersede its keyless pointer. This map dies with the session. Bounded like
   * the shortcut maps beside it. Eviction costs the designed no-pattern-meta
   * verdict (the piece's producer re-derives it), a restage, or a loud
   * moved/not-current abort — with one guarded corner: absence alone would read
   * as the fresh-session _zero-evidence_ state and skip the restage validation,
   * so evictions leave a tombstone (above) and the exemption treats evicted as
   * evidence-unknown → restage.
   */
  readonly #sessionPatternPointers = new BoundedKeyMap<
    `${MemorySpace}/${ScopeKey}/${URI}`,
    { identity: string; symbol: string }
  >(RESULT_SHORTCUT_LIMIT, {
    onEvict: (key, pointer) =>
      this.#evictedSessionPatternPointers.set(key, pointer),
  });

  /** Served pointer writes remain private to their transaction until accepted. */
  readonly #stagedSessionPatternPointers = new WeakMap<
    IExtendedStorageTransaction["tx"],
    Map<`${MemorySpace}/${ScopeKey}/${URI}`, {
      pointer: { identity: string; symbol: string } | undefined;
      resultCell: Cell<unknown>;
    }>
  >();

  /**
   * _Session_-side pattern-swap channel for _running_ pieces, the third stamp
   * stand-in. With keyless stamps never durable, a `run()` over an
   * already-registered piece requests the swap here, handing the _live_ pattern
   * value straight to the watcher's own swap closure (same guards, same
   * fail-closed setup) — the machinery a re-derived child (a lift returning a
   * pattern) otherwise reaches through the durable stamp: setup writes the new
   * `patternIdentity`, the piece's meta watcher fires, and `swapToPattern()`
   * cancels the old graph and instantiates the new one. Real patterns keep the
   * durable-stamp path. Registered by `setupPatternWatcher()`, removed with the
   * piece's cancel group.
   */
  #sessionPatternSwaps = new Map<
    `${MemorySpace}/${ScopeKey}/${URI}`,
    (pattern: Pattern, ref: { identity: string; symbol: string }) => void
  >();

  /**
   * Commit-gated starts that have not installed a registration yet, indexed by
   * result so an explicit stop can tombstone them before installation.
   */
  readonly #pendingDeferredStarts = new Map<
    `${MemorySpace}/${ScopeKey}/${URI}`,
    Set<DeferredCancelOwnership>
  >();

  /**
   * Pieces this runner has named before running them — set up elsewhere and
   * reached through a link crossing — keyed by result: the name-sync while
   * it is in flight, and once it has landed the identity of the pattern it
   * landed for. A run under another pattern probes again: an upgrade can add
   * an internal cell the crossing never delivered. Bounded like the other
   * result shortcuts; an evicted entry costs a probe, never a wrong verdict.
   *
   * A name-sync that rejects lands all the same. The run proceeds over what
   * is local, with its own subscriptions fetching the rest and the rejection
   * logged as the signal. The cached landing skips the probes for this piece
   * only while its pattern identity matches the run, a transient rejection
   * included. Eviction or replacement by another pattern's landing can cause
   * another probe and hold. Recording the landing lets the deferred run's
   * re-check pass the gate.
   */
  readonly #namedFamilies = new BoundedKeyMap<
    string,
    { pending: Promise<void> } | { landed: string }
  >(RESULT_SHORTCUT_LIMIT);

  /**
   * Two-level memo of what each result cell holds: outer key the result _doc_
   * (space/id), inner key the resolved scope _instance_, value a hash of the
   * pattern's encodable form — what `#writeJavaScriptActionResult()` compares
   * to decide whether a returned sub-pattern has changed. The inner key is the
   * _same_ per-run resolved `ScopeKey` that selects the `byScope` result cell:
   * a serving runtime materializes one child per demanded instance, and a
   * doc-level (or service-identity-resolved) key would make the _second_
   * demanded instance look unchanged and skip its child materialization. The
   * outer doc key is what change notifications can name (they carry scope by
   * _name_, which cannot address per-run instances), so eviction drops the
   * whole doc's entry — over-eviction across instances is safe: re-preparing an
   * unchanged pattern is idempotent.
   */
  readonly #resultPatternCache = new Map<
    `${MemorySpace}/${URI}`,
    Map<ScopeKey, string>
  >();

  /**
   * Epoch which invalidates asynchronous start/resume continuations when
   * `stopAll()` begins. A later explicit start captures the new epoch and may
   * proceed normally.
   */
  #lifecycleEpoch = 0;

  /**
   * Per-result generation for starts that have not installed their cancel group
   * yet. `stop(result)` advances it so an in-flight sync or listing cannot
   * start that piece after the caller has already stopped it. Entries exist
   * only while at least one tracked start attempt for that doc is unsettled.
   */
  #startGenerationByDoc = new Map<string, number>();

  #activeStartAttemptsByDoc = new Map<string, Set<StartAttempt>>();

  /**
   * Every unsettled start attempt. Covers the pre-resolution window where a
   * link attempt does not know its eventual target doc and therefore cannot
   * appear in the per-doc index yet.
   */
  readonly #activeStartAttempts = new Set<StartAttempt>();

  /**
   * The attempt a concurrent `start()` of the same doc joins, keyed by the doc
   * the call entered through. One entry per doc: the newest attempt that is
   * still current. Entries are removed when their attempt settles; a stale
   * entry (stop moved the doc's generation, or the epoch changed) is
   * overwritten by the fresh attempt that replaces it.
   */
  #inFlightStartsByDoc = new Map<string, StartAttempt>();

  /**
   * The syncer a test supplies around the dependency pre-sync; `undefined`
   * means the runner's own.
   */
  #dependencySyncer: DependencySyncer | undefined = undefined;

  /** `NAMING_PROBE_BUDGET`, lowered by a test to reach the spent-budget hold. */
  #namingProbeBudget = NAMING_PROBE_BUDGET;

  /**
   * The committer a test supplies around a commit-gated start's commit;
   * `undefined` means the runner's own.
   */
  #deferredStartCommitter: DeferredStartCommitter | undefined = undefined;

  #crossSpaceChildSpaces = new WeakMap<
    IExtendedStorageTransaction,
    MemorySpace[]
  >();

  /** The subscriber registered below, kept so disposal can hand it back.
   * `subscribe` returns nothing, so the ARGUMENT is the only handle there
   * will ever be — building one inline leaves it unreachable. */
  readonly #storageSubscription: IStorageSubscription;

  /** Constructs an instance running pieces for `runtime`. */
  constructor(runtime: Runtime) {
    this.#runtime = runtime;
    this.#storageSubscription = this.#createStorageSubscription();
    this.#runtime.storageManager.subscribe(this.#storageSubscription);
  }

  /**
   * The result and pointer tables, the start-attempt set, the dependency
   * syncer and deferred-start committer a test may supply, the setup,
   * storage-subscription, commit-gated run, ownership, key, sync, walk, and
   * retry steps, the implementation invoker, and the node planner, which a
   * test drives directly.
   */
  get accessForTestingOnly(): {
    scopedProgramCounts(): Array<{ piece: string; variants: number }>;
    readonly locallyPreparedResults: BoundedKeyMap<
      `${MemorySpace}/${ScopeKey}/${URI}`,
      string
    >;
    readonly locallyStoppedResults: BoundedKeyMap<
      `${MemorySpace}/${ScopeKey}/${URI}`,
      string
    >;
    readonly sessionPatternPointers: BoundedKeyMap<
      `${MemorySpace}/${ScopeKey}/${URI}`,
      { identity: string; symbol: string }
    >;
    readonly resultPatternCache: Map<
      `${MemorySpace}/${URI}`,
      Map<ScopeKey, string>
    >;
    readonly activeStartAttempts: Set<StartAttempt>;
    dependencySyncer: DependencySyncer | undefined;
    deferredStartCommitter: DeferredStartCommitter | undefined;
    namingProbeBudget: number;
    createStorageSubscription(): IStorageSubscription;
    setupInternal<T, R>(
      providedTx: IExtendedStorageTransaction | undefined,
      patternOrModule: Pattern | Module | undefined,
      argument: T,
      resultCell: Cell<R>,
      validationOptions?: SetupValidationOptions,
    ): SetupResult<R>;
    runPatternAfterSuccessfulCommit<T>(
      tx: IExtendedStorageTransaction,
      resultCell: Cell<T>,
      pattern: Pattern,
      inputs: FabricValue,
      markCreateOnlyResult?: boolean,
      speculativeConsequence?: { eventId: string },
    ): Cancel;
    runWithStartOwnership<T, R>(
      providedTx: IExtendedStorageTransaction | undefined,
      patternOrModule: Pattern | Module | undefined,
      argument: T,
      resultCell: Cell<R>,
      options?: RunnerRunOptions,
    ): RunResult<R>;
    getDocKey(cell: Cell<any>): `${MemorySpace}/${ScopeKey}/${URI}`;
    collectWritableCellArgumentLinks(
      argumentSchema: JSONSchema | undefined,
      value: unknown,
      resultCell: Cell<any>,
      writeInputPaths?: readonly (readonly string[])[],
    ): NormalizedFullLink[];
    collectArgumentSchedulerReadLinks(
      argumentSchema: JSONSchema | undefined,
      value: unknown,
      resultCell: Cell<any>,
    ): NormalizedFullLink[];
    resolvePendingSpaceNamesAndRetry(
      frame: Frame,
      tx?: IExtendedStorageTransaction,
    ): Promise<never>;
    invokeJavaScriptImplementation(
      module: Module,
      fn: (...args: any[]) => any,
      argument: unknown,
    ): unknown;
    nodePlan(
      tx: IExtendedStorageTransaction,
      node: Node,
      resultCell: Cell<any>,
      pattern: Pattern,
    ): NodePlan | undefined;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      scopedProgramCounts: () =>
        [...this.#scopedPieces.values()].map(
          (registration) => ({
            piece: registration.piece,
            variants: registration.variants.size,
          }),
        ),
      locallyPreparedResults: this.#locallyPreparedResults,
      locallyStoppedResults: this.#locallyStoppedResults,
      sessionPatternPointers: this.#sessionPatternPointers,
      resultPatternCache: this.#resultPatternCache,
      activeStartAttempts: this.#activeStartAttempts,
      get dependencySyncer() {
        return outerThis.#dependencySyncer;
      },
      set dependencySyncer(value) {
        outerThis.#dependencySyncer = value;
      },
      get deferredStartCommitter() {
        return outerThis.#deferredStartCommitter;
      },
      set deferredStartCommitter(value) {
        outerThis.#deferredStartCommitter = value;
      },
      get namingProbeBudget() {
        return outerThis.#namingProbeBudget;
      },
      set namingProbeBudget(value) {
        outerThis.#namingProbeBudget = value;
      },
      createStorageSubscription: () => this.#createStorageSubscription(),
      setupInternal: (
        providedTx,
        patternOrModule,
        argument,
        resultCell,
        validationOptions,
      ) =>
        this.#setupInternal(
          providedTx,
          patternOrModule,
          argument,
          resultCell,
          validationOptions,
        ),
      runPatternAfterSuccessfulCommit: (
        tx,
        resultCell,
        pattern,
        inputs,
        markCreateOnlyResult,
        speculativeConsequence,
      ) =>
        this.#runPatternAfterSuccessfulCommit(
          tx,
          resultCell,
          pattern,
          inputs,
          markCreateOnlyResult,
          speculativeConsequence,
        ),
      runWithStartOwnership: (
        providedTx,
        patternOrModule,
        argument,
        resultCell,
        options,
      ) =>
        this.#runWithStartOwnership(
          providedTx,
          patternOrModule,
          argument,
          resultCell,
          options,
        ),
      getDocKey: (cell) => this.#getDocKey(cell),
      collectWritableCellArgumentLinks: (
        argumentSchema,
        value,
        resultCell,
        writeInputPaths,
      ) =>
        this.#collectWritableCellArgumentLinks(
          argumentSchema,
          value,
          resultCell,
          writeInputPaths,
        ),
      collectArgumentSchedulerReadLinks: (argumentSchema, value, resultCell) =>
        this.#collectArgumentSchedulerReadLinks(
          argumentSchema,
          value,
          resultCell,
        ),
      resolvePendingSpaceNamesAndRetry: (frame, tx) =>
        this.#resolvePendingSpaceNamesAndRetry(frame, tx),
      invokeJavaScriptImplementation: (module, fn, argument) =>
        this.#invokeJavaScriptImplementation(module, fn, argument),
      nodePlan: (tx, node, resultCell, pattern) =>
        this.#nodePlan(tx, node, resultCell, pattern),
    };
  }

  /** Registrations of running pieces, by space, scope, and document. */
  get cancels(): Map<`${MemorySpace}/${ScopeKey}/${URI}`, PieceRegistration> {
    return this.#cancels;
  }

  /**
   * Served receipt writes skipped as write-once CAS losses: the handling's
   * result cell already held a value when the serving run went to write it.
   * Each skip also logs a warn line; this is the machine-readable half.
   */
  get servedReceiptCasLosses(): number {
    return this.#servedReceiptCasLosses;
  }

  /**
   * The SESSION-side pattern pointer for a keyless piece this runner set up, or
   * undefined. The piece layer's read-through: a keyless piece carries no
   * durable `patternIdentity` (the never-durable contract), so consumers of the
   * durable meta consult this before concluding the piece has no pattern.
   * Session-scoped by construction — a fresh runtime correctly finds nothing.
   */
  sessionPatternPointerFor(
    resultCell: Cell<unknown>,
  ): { identity: string; symbol: string } | undefined {
    return this.#sessionPatternPointer(resultCell);
  }

  /** Reads the caller's staged pointer before the accepted session pointer. */
  #sessionPatternPointer(
    resultCell: Cell<unknown>,
  ): { identity: string; symbol: string } | undefined {
    const key = this.#getSetupKey(resultCell);
    const staged = resultCell.tx &&
      this.#stagedSessionPatternPointers.get(resultCell.tx.tx);
    if (staged?.has(key)) return staged.get(key)!.pointer;
    return this.#sessionPatternPointers.get(key);
  }

  /** Settles local state after both the transaction and its effect are accepted. */
  #afterAcceptedCommit(
    tx: IExtendedStorageTransaction,
    callback: (accepted: boolean) => void,
  ): void {
    if (!this.#runtime.servingPosture) {
      tx.addCommitCallback((_committed, result) => callback(!result.error));
      return;
    }
    requireWaveAcceptance(tx);
    const lifecycleEpoch = this.#lifecycleEpoch;
    let finished = false;
    let contributionAccepted = false;
    let effectAccepted = false;
    const finish = (accepted: boolean) => {
      if (finished) return;
      finished = true;
      callback(accepted && lifecycleEpoch === this.#lifecycleEpoch);
    };
    const publish = () => {
      if (contributionAccepted && effectAccepted) finish(true);
    };
    tx.enqueuePostCommitEffect({
      id: `runner-acceptance:${crypto.randomUUID()}`,
      kind: RUNNER_ACCEPTANCE_EFFECT_KIND,
      flush: () => {
        effectAccepted = true;
        publish();
      },
      abandon: () => finish(false),
    });
    tx.addCommitCallback((committed, result) => {
      if (result.error) return finish(false);
      const settlement = waveSettlementOf(committed) ?? waveSettlementOf(tx);
      const accepted = (success: boolean) => {
        if (!success) return finish(false);
        contributionAccepted = true;
        publish();
      };
      if (settlement === undefined) accepted(true);
      else {
        void settlement.then((outcome) =>
          accepted(outcome.error === undefined)
        );
      }
    });
  }

  /** Publishes a served pointer and wakes its coordinator only after acceptance. */
  #stageSessionPatternPointer(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<unknown>,
    pointer: { identity: string; symbol: string } | undefined,
  ): void {
    let staged = this.#stagedSessionPatternPointers.get(tx.tx);
    if (staged === undefined) {
      staged = new Map();
      this.#stagedSessionPatternPointers.set(tx.tx, staged);
      const writes = staged;
      this.#afterAcceptedCommit(tx, (accepted) => {
        this.#stagedSessionPatternPointers.delete(tx.tx);
        if (!accepted) return;
        for (const [key, write] of writes) {
          if (write.pointer === undefined) {
            this.#sessionPatternPointers.delete(key);
          } else {
            this.#sessionPatternPointers.set(key, write.pointer);
          }
          this.#scopedPieces.get(this.#getDocKey(write.resultCell))?.wake();
        }
      });
    }
    staged.set(this.#getSetupKey(resultCell.withTx(tx)), {
      pointer,
      resultCell: resultCell.withTx(undefined),
    });
  }

  /**
   * Unregister from storage notifications.
   *
   * A storage manager outliving this runner keeps every subscriber it was
   * given, and each one holds its runner reachable — so a process reusing one
   * manager across runtimes (`Runtime.dispose({ closeStorage: false })`, which
   * exists for exactly that) accumulates them. The subscription cannot retire
   * itself either: its `next` returns `{ done: false }` unconditionally, and
   * `{ done: true }` is the only self-cancelling answer the contract has.
   *
   * `unsubscribe` is optional on the capability, so a manager that does not
   * implement it is left as it was rather than crashing a disposal.
   */
  dispose(): void {
    this.#runtime.storageManager.unsubscribe?.(this.#storageSubscription);
  }

  /**
   * Helper for the result-pattern step, which records that the result doc
   * under `cacheDocKey` holds the pattern `resultPatternKey` for the scope
   * instance `scopeKey`, and emits the `runner.result-pattern.memoize` marker
   * for it.
   */
  #memoizeResultPattern(
    cacheDocKey: `${MemorySpace}/${URI}`,
    scopeKey: ScopeKey,
    resultPatternKey: string,
  ): void {
    let instanceMemos = this.#resultPatternCache.get(cacheDocKey);
    if (instanceMemos === undefined) {
      instanceMemos = new Map();
      this.#resultPatternCache.set(cacheDocKey, instanceMemos);
    }
    instanceMemos.set(scopeKey, resultPatternKey);
    this.#runtime.telemetry.submit({
      type: "runner.result-pattern.memoize",
      key: cacheDocKey,
      scopeKey,
    });
  }

  /**
   * Helper for the result-pattern step's commit callback, which drops the
   * memo for `scopeKey` under `cacheDocKey` when it still names
   * `resultPatternKey`, and emits the `runner.result-pattern.evict` marker
   * for it. A memo a later run has already replaced is left alone.
   */
  #rollBackResultPatternMemo(
    cacheDocKey: `${MemorySpace}/${URI}`,
    scopeKey: ScopeKey,
    resultPatternKey: string,
  ): void {
    const memos = this.#resultPatternCache.get(cacheDocKey);
    if (memos?.get(scopeKey) !== resultPatternKey) return;
    memos.delete(scopeKey);
    if (memos.size === 0) this.#resultPatternCache.delete(cacheDocKey);
    this.#runtime.telemetry.submit({
      type: "runner.result-pattern.evict",
      key: cacheDocKey,
      scopeKey,
    });
  }

  /**
   * Helper for the storage subscription, which drops every instance's memo
   * under `cacheDocKey` and emits the `runner.result-pattern.evict` marker
   * for it. Does nothing for a doc with no memo.
   */
  #evictResultPatternMemos(cacheDocKey: `${MemorySpace}/${URI}`): void {
    if (!this.#resultPatternCache.delete(cacheDocKey)) return;
    this.#runtime.telemetry.submit({
      type: "runner.result-pattern.evict",
      key: cacheDocKey,
    });
  }

  /**
   * Creates and returns a new storage subscription.
   *
   * This will be used to remove the cached pattern information when the result
   * cell changes. As a result, if we are scheduled, we will run that pattern
   * and regenerate the result.
   *
   * @returns A new IStorageSubscription instance
   */
  #createStorageSubscription(): IStorageSubscription {
    return {
      next: (notification) => {
        const space = notification.space;
        if ("changes" in notification) {
          for (const change of notification.changes) {
            // The notification names the DOC (scope arrives by NAME, which
            // cannot address a per-run scope instance on a serving runtime), so
            // eviction drops the doc's WHOLE entry: every instance's memo
            // clears, and the over-eviction is safe — re-preparing an unchanged
            // pattern commits no differing bytes (writeJavaScriptActionResult's
            // unchanged path is idempotent). No scope segment in the key also
            // means no raw-vs-normalized mismatch can make eviction silently
            // miss an entry. The eviction-on-notification CONTRACT is what the
            // storage subscription exists for and is pinned by the "clears
            // cached patterns when storage notifies of changes" test.
            this.#evictResultPatternMemos(`${space}/${change.address.id}`);
          }
        } else if (notification.type === "reset") {
          // copy keys, since we'll mutate the collection while iterating
          const cacheKeys = [...this.#resultPatternCache.keys()];
          cacheKeys.filter((key) => key.startsWith(`${notification.space}/`))
            .forEach((key) => this.#evictResultPatternMemos(key));
        }
        return { done: false };
      },
    };
  }

  /**
   * Prepare a piece for running by creating/updating its process and result
   * cells, registering the pattern, and applying defaults/arguments.
   * This does not schedule any nodes. Use start() to schedule execution.
   * If the piece is already running and the pattern changes, it will stop the
   * piece.
   */
  setup<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
    options?: SetupValidationOptions,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options?: SetupValidationOptions,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    providedTx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options: SetupValidationOptions = {},
  ): Promise<Cell<R>> {
    if (providedTx) {
      this.#setupInternal(
        providedTx,
        patternOrModule,
        argument,
        resultCell,
        options,
      );
      return Promise.resolve(resultCell);
    } else {
      // Ignore retry/commit errors after retrying for now, as outside the tx,
      // we'll see the latest true value; it just lost the race against someone
      // else changing the pattern or argument. Correct action is anyhow similar
      // to what would have happened if the write succeeded and was immediately
      // overwritten. Still surface real callback failures from
      // `#setupInternal()` so callers don't silently continue after a broken
      // setup.
      return this.#runtime.editWithRetry((tx) => {
        this.#setupInternal(tx, patternOrModule, argument, resultCell, options);
      }).then(({ error }) => {
        if (error) {
          if (
            error.name === "StorageTransactionAborted" &&
            error.message.startsWith("editWithRetry action threw:")
          ) {
            throw error.reason instanceof Error
              ? error.reason
              : new Error(error.message);
          }
          if (
            (error.name === "CfcCommitRefusalError" ||
              error.name === "StorageTransactionAborted") &&
            isCfcEnforcementRejection(error)
          ) {
            // The two rejections carry their diagnostic differently: the
            // boundary refusal carries every prepare reason as `reasons`,
            // while the prepared-digest drift carries a marker `reason`.
            // Reading only one drops the cause for the other.
            const { reason, reasons } = error as {
              reason?: unknown;
              reasons?: readonly string[];
            };
            throw new Error(error.message, {
              cause: reasons !== undefined ? [...reasons] : reason,
            });
          }
        }

        return resultCell;
      });
    }
  }

  /**
   * Whether setting `pattern` up on `resultCell` would rewrite the result
   * projection: `pattern` is not the pattern the document was last set up
   * with, and the projection it binds to the document differs from the one
   * stored. Setup writes the projection only then, and records the result
   * schema as a write-policy input only with that write, so this is also
   * whether the setup commit merges `pattern`'s result schema into the
   * document's stored CFC envelope. `cf piece setsrc --check` asks it before
   * it merges that envelope in dry run, so a source update that leaves the
   * projection as it is — one changing only what the projection does not
   * carry — is not refused over an envelope the commit never touches. Reads
   * only.
   *
   * A source update never asks setup to reapply a stored setup, so the same
   * pattern as the last run — by the pointer setup itself compares, a
   * keyless pattern's session pointer included — is the one case where
   * setup keeps the stored projection without comparing. For any other
   * pattern, setup re-points the argument link at `pattern`'s argument
   * schema before it compares, so the projection is bound here against the
   * link setup would have staged, not the one stored.
   */
  setupRewritesResultProjection(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    resultCell: Cell<unknown>,
  ): boolean {
    const previousIdentityRef = getPatternIdentityRef(resultCell.withTx(tx)) ??
      this.#sessionPatternPointer(resultCell.withTx(tx));
    const entryRef = this.#entryRefForPattern(pattern);
    if (
      previousIdentityRef !== undefined &&
      entryRef.identity === previousIdentityRef.identity &&
      entryRef.symbol === previousIdentityRef.symbol
    ) {
      return false;
    }
    // The link `#applySetupState` stages for a pattern change: the argument
    // document it finds, or the one it would create, under the pattern's
    // argument schema.
    const argumentLink = getMetaLink(resultCell.withTx(tx), "argument");
    const argumentCell = argumentLink === undefined
      ? getMetaCell(resultCell, "argument", tx)
      : this.#runtime.getCellFromLink(argumentLink, undefined, tx);
    return this.#nextResultProjection(
      tx,
      pattern,
      resultCell,
      argumentCell.asSchema(pattern.argumentSchema).getAsNormalizedFullLink(),
      { preserveName: false },
    ).changed;
  }

  /**
   * Validate a piece's stored argument against a candidate without staging it.
   *
   * Uses setup's value validation and defaults. Unreadable argument documents
   * and linked slots defer to reactive reads; readable wrong-typed values
   * throw a stored-argument schema refusal. Optional `undefined` fields count
   * as absent. Validation reads the supplied transaction's snapshot.
   */
  validateStoredArgument<R>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<R>,
    pattern: Pattern,
  ): void {
    const argumentLink = getMetaLink(resultCell.withTx(tx), "argument");
    if (argumentLink === undefined) return;
    const stored = this.#runtime.getCellFromLink(argumentLink, undefined, tx)
      .getRaw({ meta: ignoreReadForScheduling });
    if (stored === undefined) return;
    const defaults = extractDefaultValues(pattern.argumentSchema);
    this.#validateArgument(
      tx,
      argumentLink,
      pattern.argumentSchema,
      defaults,
    );
  }

  #resolveSetupPattern(
    patternOrModule: Pattern | Module | undefined,
    previousIdentityRef: { identity: string; symbol: string } | undefined,
  ):
    | {
      pattern: Pattern;
      entryRef: { identity: string; symbol: string };
      resolvedPatternOrModule: Pattern | Module;
    }
    | undefined {
    let resolvedPatternOrModule = patternOrModule;

    // No pattern in hand: resolve the previously-stored `{ identity, symbol }`
    // pointer synchronously from the in-session artifact index (the module is
    // live this session — the reload path loaded it before reaching here).
    if (!resolvedPatternOrModule) {
      if (!previousIdentityRef) return undefined;
      const resolved = this.#runtime.patternManager.artifactFromIdentitySync(
        previousIdentityRef.identity,
        previousIdentityRef.symbol,
      ) as Pattern | undefined;
      if (!resolved) {
        throw new Error(
          `Unknown pattern: ${previousIdentityRef.identity}#${previousIdentityRef.symbol}`,
        );
      }
      resolvedPatternOrModule = resolved;
    }

    const pattern = isModule(resolvedPatternOrModule)
      ? this.#moduleToPattern(resolvedPatternOrModule)
      : resolvedPatternOrModule;
    const entryRef = this.#entryRefForPattern(pattern);

    return { pattern, entryRef, resolvedPatternOrModule };
  }

  /**
   * The pattern pointer for `pattern`: its real content-addressed entry ref
   * when it has one (a compiled pattern), else a stable session-synthetic
   * `keyless:` ref minted for the hand-built pattern object. The keyless ref is
   * INDEX-only — it resolves through `artifactFromIdentitySync` for any
   * in-session holder of the ref, but it is never recorded durably
   * (`#applySetupState` skips the stamp for it), so a keyless piece carries no
   * pattern pointer and cannot be started by identity: its producer re-derives
   * and re-runs it instead.
   */
  #entryRefForPattern(
    pattern: Pattern,
  ): { identity: string; symbol: string } {
    const real = this.#runtime.patternManager.getArtifactEntryRef(pattern);
    if (real) {
      // Artifact refs are process-global metadata on the pattern object, while
      // the addressable artifact index is runtime-local. Re-associate a pattern
      // handed to this runtime so a subsequent start-by-durable-identity can
      // resolve it even when another runtime minted the ref first.
      this.#runtime.patternManager.associatePatternIdentity(
        resolveOriginal(pattern) as Pattern,
        real,
      );
      return real;
    }
    // Keyless: a content-hash session pointer (structurally-identical patterns
    // share it — no churn). See PatternManager.ensureKeylessPatternIdentity.
    return this.#runtime.patternManager.ensureKeylessPatternIdentity(pattern);
  }

  #updateArgument<T>(
    tx: IExtendedStorageTransaction,
    argumentLink: NormalizedFullLink,
    argument: T,
    argumentSchema: JSONSchema | undefined,
    projection: unknown = argument,
  ): void {
    const argumentCell = this.#runtime.getCellFromLink(
      argumentLink,
      undefined,
      tx,
    );
    // A sub-pattern's argument can carry a builder artifact -- a pattern
    // handed to another pattern as an input. This is a storage boundary like
    // any other, so the artifact is replaced on the way in, once, for every
    // write below: they must agree on what was stored. A query result is a
    // leaf here for the same reason it is one to the writes below, which each
    // replace such a value with the sigil link it names.
    const storable = flattenBuilderArtifacts(argument, {
      isLeaf: isCellResultForDereferencing,
    });
    argumentCell.set(storable);
    // The policy recorder sees the RAW argument, as its sibling in
    // `#updateResultProjection` does. Handing it the flattened one would walk
    // a serialized pattern graph the raw walk stops at -- a function halts
    // its descent, a record does not -- and record structural-provenance
    // claims from positions it has never seen.
    //
    // What it walks is what this setup PROJECTS, which is `projection`: the
    // argument itself wherever the two are one value, and the caller's own
    // argument where the value being written folded the stored document's
    // slots in. Each redirect it finds records a setup-projection marker, and
    // a marker exempts writes at-or-below its target from `writeAuthorizedBy`
    // for the rest of the transaction (`writeIsPatternSetupInitialization` in
    // cfc/prepare.ts), so the redirects it walks are the ones this setup
    // establishes rather than the ones the document already held.
    recordSetupProjectionPolicyInputs(
      tx,
      this.#runtime,
      argumentCell,
      argumentSchema,
      projection,
    );
    diffAndUpdate(
      this.#runtime,
      tx,
      argumentLink,
      storable,
      argumentLink,
    );
    initializeScopedArgumentSlots(
      this.#runtime,
      tx,
      argumentLink,
      argumentSchema,
    );
  }

  /** Stage an argument write, materialize aliases in the same transaction, and
   * reject the transaction unless the resulting value satisfies its schema. */
  #updateAndValidateArgument<T>(
    tx: IExtendedStorageTransaction,
    argumentLink: NormalizedFullLink,
    argument: T,
    argumentSchema: JSONSchema,
    defaults: FabricValue,
  ): void {
    this.#updateArgument(
      tx,
      argumentLink,
      argument,
      argumentSchema,
    );
    this.#validateArgument(
      tx,
      argumentLink,
      argumentSchema,
      defaults,
    );
  }

  #validateArgument(
    tx: IExtendedStorageTransaction,
    argumentLink: NormalizedFullLink,
    argumentSchema: JSONSchema,
    defaults: FabricValue,
  ): void {
    const validationFailure = storedArgumentValidationIssue(
      this.#runtime.getCellFromLink(argumentLink, undefined, tx),
      argumentSchema,
      defaults,
      tx,
    );
    if (validationFailure !== undefined) {
      throw new Error(
        `${STORED_ARGUMENT_SCHEMA_REFUSAL}: ${validationFailure}`,
      );
    }
  }

  #updateResultSchemaMeta<R>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<R>,
    resultSchema: JSONSchema | undefined,
  ): void {
    if (resultSchema === undefined) return;
    writeResultSchemaMeta(resultCell.withTx(tx), resultSchema);
  }

  /**
   * Skip setup for a piece that is already RUNNING this pattern.
   *
   * A running piece is never re-staged here, and that is the whole point of the
   * branch: `#applySetupState` installs the incoming version's argument schema,
   * internal manifest and result projection, but only the pattern watcher can
   * cancel the live nodes and instantiate the new ones. Staging without that
   * leaves the stored setup describing a version the running graph is not —
   * the piece's projection reads as the new pattern while its handlers still
   * drive the old one's cells — and stamps the completion marker forward,
   * erasing the very mismatch a later repair would use to notice.
   *
   * What it does NOT do is report success without looking, on the branch that
   * supplies no argument: a stale setup marker there means nobody has checked
   * the stored argument against this pattern, so it is validated in place — no
   * write, no schema retarget, nothing that moves the piece — and a refusal
   * surfaces to the caller. The supplied-argument branch below writes the
   * caller's value through without that check, as it always has; callers of
   * that shape validate what they supply before entering Runner.
   */
  #maybeReuseRunningSetup<T, R>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<R>,
    argument: T,
    pattern: Pattern,
    patternRef: { identity: string; symbol: string },
    setupState: SetupStateReuse,
    referencedArgumentFields: readonly string[] = [],
  ): SetupResult<R> | undefined {
    const key = this.#getDocKey(resultCell);
    if (!this.#cancels.has(key)) return undefined;
    if (
      this.#usesScopedPrograms(resultCell) &&
      !this.#scopedPieces.get(key)?.variants.has(patternIdentityKey(patternRef))
    ) {
      return undefined;
    }

    // Record the result schema for BOTH reuse branches below, on the one
    // condition that makes it safe: the setup marker names THIS pattern, so the
    // running graph is this pattern and the schema cannot describe a version
    // that is not there. (`storedSetupMatches` implies `sameStoredSetup`, so
    // every path reaching this write returns from one of those branches.)
    // The stale-marker case is deliberately excluded — see the class comment —
    // but a piece whose `schema` meta is missing or stale-but-same-version
    // still gets it repaired, which is what keeps its reads typed and its
    // durable write contract present. Both branches need it: a caller may
    // re-run a running piece WITH an argument (`PiecesController.runWithPattern`),
    // and that piece's metadata is no less worth repairing.
    if (setupState.storedSetupMatches) {
      this.#updateResultSchemaMeta(tx, resultCell, pattern.resultSchema);
    }

    if (argument === undefined && setupState.sameStoredSetup) {
      if (setupState.restageStoredArgument) {
        this.validateStoredArgument(tx, resultCell, pattern);
      }
      return { resultCell, patternRef, needsStart: false };
    }

    if (setupState.sameStoredSetup) {
      const argumentLink = getMetaLink(resultCell.withTx(tx), "argument")!;
      const defaults = extractDefaultValues(pattern.argumentSchema);
      const supplied = mergeSchemaDefaults(
        argument,
        defaults,
        pattern.argumentSchema,
      );
      const nextArgument = mergeSchemaDefaults(
        this.#argumentOverStoredSlots(tx, argumentLink, argument),
        defaults,
        pattern.argumentSchema,
      );
      // Nested-pattern replay passes opaque Cell handles here. Candidate-
      // schema validation materializes the argument cell and would dereference
      // those handles before validating them, rejecting a valid `asCell` slot
      // when its payload is cold or absent. Piece API argument mutations
      // validate their exact supplied value before entering Runner;
      // pattern-changing updates always take the validated path below.
      this.#updateArgument(
        tx,
        argumentLink,
        nextArgument,
        pattern.argumentSchema,
        supplied,
      );
      recordReferencedArgumentFields(
        tx,
        argumentLink,
        referencedArgumentFields,
      );
      return { resultCell, patternRef, needsStart: false };
    }

    return undefined;
  }

  #updateResultProjection<R>(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    resultCell: Cell<R>,
    options: { preserveName: boolean },
  ): void {
    const { result, fabricResult, changed } = this.#nextResultProjection(
      tx,
      pattern,
      resultCell,
      getMetaLink(resultCell.withTx(tx), "argument")!,
      options,
    );
    if (changed) {
      recordSetupProjectionPolicyInputs(
        tx,
        this.#runtime,
        resultCell,
        pattern.resultSchema,
        result,
      );
      const writableResultCell = pattern.resultSchema === undefined
        ? resultCell.withTx(tx)
        : resultCell.withTx(tx).asSchema(pattern.resultSchema);
      // The result root marks the whole result document as generated: setup
      // rewrites the complete projection.
      writableResultCell.setRawUntyped(fabricResult, false, "output");
    }
  }

  /**
   * The projection setting `pattern` up stores on `resultCell`, beside the
   * one stored now: `result` is the projection as bound to the document,
   * which the policy-input recorder walks; `fabricResult` is what a write
   * stores; and `changed` is whether that differs from what is stored, which
   * is the one condition under which setup writes it. `argumentCellLink` is
   * the argument link the projection binds to, which setup has staged under
   * `pattern`'s argument schema by the time it writes. Reads only.
   */
  #nextResultProjection<R>(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    resultCell: Cell<R>,
    argumentCellLink: NormalizedFullLink,
    options: { preserveName: boolean },
  ): { result: R; fabricResult: FabricValue; changed: boolean } {
    const writableResultCell = pattern.resultSchema === undefined
      ? resultCell.withTx(tx)
      : resultCell.withTx(tx).asSchema(pattern.resultSchema);
    // `Pattern` erases its authored result type to `JSONValue`, so validate
    // that actual execution value here, then restore its association with
    // `Cell<R>`.
    let result = unwrapOneLevelAndBindToDoc(
      pattern.result,
      argumentCellLink,
      resultCell,
      { derivedInternalCells: pattern.derivedInternalCells },
    ) as R;
    const previousResult = writableResultCell.getRaw({
      meta: ignoreReadForScheduling,
    });
    if (
      options.preserveName &&
      isObjectOrArray(previousResult) &&
      previousResult[NAME]
    ) {
      result = { ...result, [NAME]: previousResult[NAME] };
    }
    // Convert-and-freeze (default): a deep-frozen value lets the storage write
    // boundary's `cloneIfNecessary` identity-pass instead of
    // deep-cloning-to-freeze.
    //
    // The conversion MUST precede the no-op gate. A raw result is not
    // necessarily a `FabricValue` — one carrying `toJSON`, say, only becomes one
    // here — and `valueEqual` hashes its operands, so comparing a raw result
    // throws `` `hashOf()`: unsupported object type `` instead of deciding
    // anything. Converting first also makes the gate compare what a write
    // would actually store, since the stored side is already a `FabricValue`.
    // A result can carry a builder artifact -- a pattern tool, say -- and an
    // artifact is not a `FabricValue`, so it is replaced before the
    // conversion. That keeps the gate below comparing what a write would
    // actually store, which is the whole point of converting first.
    const fabricResult = fabricFromConvertibleJsValue(
      flattenBuilderArtifacts(result),
    );
    return {
      result,
      fabricResult,
      changed: !valueEqual(fabricResult, previousResult),
    };
  }

  /**
   * Creates and initializes any internal cells needed for the pattern.
   *
   * @param tx
   * @param pattern
   * @param resultCell
   * @param internal a FabricValue with the existing array of InternalCellDescriptors
   * @returns a FabricValue with the array of InternalCellDescriptors
   */
  #materializeDerivedInternalCells<R>(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    resultCell: Cell<R>,
    internal: FabricValue,
  ): FabricValue {
    const descriptors = pattern.derivedInternalCells;
    if (!descriptors?.length) return [];

    // Our internal meta field contains a manifest with information about all
    // the individual internal cells.
    const nativeInternal = convertibleJsFromFabricValue(internal);
    const existingManifest: InternalCellDescriptor[] =
      Array.isArray(nativeInternal)
        ? [...nativeInternal] as InternalCellDescriptor[]
        : [];
    // We'll build the updated manifest from the existing
    const manifest: InternalCellDescriptor[] = [];

    for (const descriptor of descriptors) {
      const derivedCell = getDerivedInternalCell(
        resultCell,
        descriptor,
        tx,
      );
      const manifestMatch = existingManifest.findIndex((existingDescriptor) =>
        deepEqual(existingDescriptor.partialCause, descriptor.partialCause) &&
        existingDescriptor.kind === descriptor.kind
      );
      // Re-emit the manifest link and backlink from the current descriptor on
      // every setup. A compatible setsrc may narrow an internal schema while
      // retaining the same partial cause; preserving the old manifest entry
      // would leave stale producer authority attached to that cell.
      const derivedSigilLink = derivedCell.getAsWriteRedirectLink({
        base: resultCell,
        includeSchema: true,
      });
      manifest.push({
        partialCause: descriptor.partialCause,
        ...(descriptor.kind !== undefined && { kind: descriptor.kind }),
        link: derivedSigilLink,
      });
      setResultCell(derivedCell, resultCell.asSchema(pattern.resultSchema));
      if (manifestMatch === -1) {
        // Seed the build-time default for the freshly created cell. The
        // manifest entry and this default are written together in one
        // transaction, so a manifest-referenced cell is already durable; on a
        // cold-cache resume its value may simply be unsynced. Reading and
        // seeding only when there is no manifest entry keeps resume read-mostly:
        // a probe read of the not-yet-loaded value would otherwise enter the
        // commit's conflict set and lose to the durable value when it streams
        // in, reverting the whole instantiation commit.
        const schemaDefault = isObjectOrArray(descriptor.schema)
          ? descriptor.schema.default as JSONValue | undefined
          : undefined;
        if (schemaDefault !== undefined) {
          const currentValue = derivedCell.getRawUntyped({
            meta: ignoreReadForScheduling,
          });
          if (currentValue === undefined) {
            derivedCell.setRawUntyped(
              fabricFromConvertibleJsValue(schemaDefault),
            );
          }
        }
      }
    }

    return fabricFromConvertibleJsValue(manifest);
  }

  /**
   * The argument to write for a piece whose argument document already exists,
   * built from `argument` over the slots that document holds. The stored read
   * goes through `tx`, so the write it shapes sits in the same conflict set.
   */
  #argumentOverStoredSlots<T>(
    tx: IExtendedStorageTransaction,
    argumentLink: NormalizedFullLink,
    argument: T,
  ): T {
    if (argument === undefined) return argument;
    const stored = this.#runtime
      .getCellFromLink(argumentLink, undefined, tx)
      .getRaw({ meta: ignoreReadForScheduling });
    recordReplayedArgumentSlots(tx, argumentLink, argument, stored);
    return foldStoredArgumentSlots(argument, stored);
  }

  /**
   * When this function is first called, the resultCell may not have its
   * internal, argument, and pattern cells set up, so do that here.
   */
  #applySetupState<T, R>(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    entryRef: { identity: string; symbol: string } | undefined,
    setupState: SetupStateReuse,
    argument: T,
    resultCell: Cell<R>,
    referencedArgumentFields: readonly string[] = [],
  ): void {
    // Every write below fills a store this piece owns — the argument
    // document, each internal document the result projects to, and the result
    // document the projection lands in — so the transaction making them has to
    // name them. This is the one place all of that happens, and it is reached
    // on a transaction of its own from a pattern swap and from a start repair
    // as well as from `#setupInternal()`, neither of which the instantiation's
    // enrollment covers: a swap commits its setup before instantiating, and a
    // descriptor the incoming pattern adds is a document nothing has named.
    markPieceOwnedStores(tx, resultCell, pattern);
    const { sameStoredSetup, restageStoredArgument } = setupState;
    const defaults = extractDefaultValues(pattern.argumentSchema);
    let argumentLink = getMetaLink(resultCell.withTx(tx), "argument");
    const previousInternal = resultCell.withTx(tx).getMetaRaw("internal", {
      meta: ignoreReadForScheduling,
    });
    const internalManifest = this.#materializeDerivedInternalCells(
      tx,
      pattern,
      resultCell,
      previousInternal,
    );
    resultCell.withTx(tx).setMetaRaw(
      "internal",
      internalManifest,
      rawMetaWriteAuthorization,
    );

    let nextArgument: T | undefined = argument;
    // What the setup projects, where that is not the value being written. Set
    // only where the two differ; the write below falls back to `nextArgument`.
    let suppliedProjection: T | undefined;
    let argumentUpdated = false;
    // The argument meta field of the result cell should be a link to the
    // argument cell. If it doesn't exist, we need to apply the defaults
    // I don't include the schema here, since I don't want cfc enforcement yet
    if (argumentLink === undefined) {
      let newArgumentCell = getMetaCell(
        resultCell,
        "argument",
        tx,
      );
      setResultCell(newArgumentCell, resultCell.asSchema(pattern.resultSchema));
      nextArgument = mergeSchemaDefaults<T>(
        argument,
        defaults,
        pattern.argumentSchema,
      );
      //newArgumentCell.set(nextArgument);

      newArgumentCell = newArgumentCell.asSchema(pattern.argumentSchema);
      const newArgumentSigilLink = newArgumentCell.getAsWriteRedirectLink({
        base: resultCell,
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
      });
      resultCell.withTx(tx).setMetaRaw(
        "argument",
        newArgumentSigilLink,
        rawMetaWriteAuthorization,
      );

      argumentLink = newArgumentCell.getAsNormalizedFullLink();
      if (argumentLink === undefined) {
        throw new Error("Invalid argument link in updateArgument");
      }
    } else if (!restageStoredArgument) {
      // Same stored setup over an argument document that already exists. The
      // write below replaces the whole document, so it carries the slots this
      // caller does not name: a nested piece is replayed with the argument its
      // parent's expression carries — `Poll({ votes })` names one slot — and
      // the piece's own state lives in the rest. What the setup PROJECTS stays
      // the argument this caller supplied.
      suppliedProjection = argument;
      nextArgument = this.#argumentOverStoredSlots(tx, argumentLink, argument);
    } else {
      const previousArgumentCell = this.#runtime.getCellFromLink(
        argumentLink,
        undefined,
        tx,
      );
      const previousArgument = previousArgumentCell.getRaw({
        meta: ignoreReadForScheduling,
      }) as T | undefined;

      const previousArgumentSchema = argumentLink.schema;
      const nextArgumentCell = previousArgumentCell.asSchema(
        pattern.argumentSchema,
      );
      const nextArgumentSigilLink = nextArgumentCell.getAsWriteRedirectLink({
        base: resultCell,
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
      });
      resultCell.withTx(tx).setMetaRaw(
        "argument",
        nextArgumentSigilLink,
        rawMetaWriteAuthorization,
      );
      argumentLink = nextArgumentCell.getAsNormalizedFullLink();

      if (argument === undefined && previousArgument === undefined) {
        // Pattern change over an argument doc that reads nothing right now.
        // This is the normal client state whenever the argument links into a
        // piece that is down or a doc that has not synced — a nested piece's
        // argument lives in its HOST's doc (for example, BacklinksIndex's
        // `pieceRegistry` argument under a host whose own pattern failed to
        // load). There is no supplied value to stage, and validating — or
        // writing defaults over — a doc we cannot read would either kill the
        // swap or clobber whatever the doc really holds. Keep the stored
        // bytes; instantiation reads the argument reactively once it loads.
        nextArgument = undefined;
      } else {
        nextArgument = mergeSchemaDefaults<T>(
          argument === undefined ? previousArgument : argument,
          defaults as Partial<T>,
          pattern.argumentSchema,
        );

        if (this.#runtime.patternManager.getArtifactEntryRef(pattern)) {
          recordNewProtectedDefaults(
            tx,
            argumentLink,
            previousArgumentSchema,
            pattern.argumentSchema,
            defaults,
            nextArgument,
          );
        }

        // Stage the exact Fabric-layer representation before validating it.
        // The untyped materialization inside resolves ordinary sigil links
        // through this same transaction without dropping fields that fail the
        // candidate schema. A thrown validation error aborts the transaction,
        // so neither this write nor the schema retarget can become durable on
        // failure. A slot whose staged link chain cannot be read RIGHT NOW
        // validates as opaque rather than as its unreadable materialization —
        // supplied and re-staged arguments alike, because which link targets
        // this replica holds is a fact about the moment, not about the value
        // the caller staged. (At least one of `argument`/`previousArgument`
        // is defined here — the skip branch above owns the both-undefined
        // case — so the merge yields a value.)
        this.#updateAndValidateArgument(
          tx,
          argumentLink,
          nextArgument,
          pattern.argumentSchema,
          defaults,
        );
        argumentUpdated = true;
      }
    }
    if (nextArgument !== undefined && !argumentUpdated) {
      // A changed pattern with an existing argument either validated above or
      // produced no value to write, so this branch is only reachable for new
      // argument cells and same-setup replay. Piece API argument mutations
      // validate their exact supplied value before entering Runner.
      this.#updateArgument(
        tx,
        argumentLink,
        nextArgument,
        pattern.argumentSchema,
        suppliedProjection ?? nextArgument,
      );
    }
    if (nextArgument !== undefined) {
      recordReferencedArgumentFields(
        tx,
        argumentLink,
        referencedArgumentFields,
      );
    }

    // Record the content-addressed {identity, symbol} reference — the ONLY
    // pattern pointer — when the pattern's entry identity is a REAL one (as
    // every space-compiled pattern's is). On reload this loads the pattern
    // straight from the compiled cache by identity (or, on a version bump,
    // recompiles from the source-doc closure). A KEYLESS hand-built pattern
    // gets NO durable pointer: `#entryRefForPattern` mints a `keyless:<hash>`
    // session pointer for it, but that identity is session-only by construction
    // and must never land in durable state (pattern-manager's contract).
    // Readers of such a piece get the designed no-pattern-meta verdict;
    // recovery is the producer's (re-run the producing lift), never a load. The
    // ref carries the authoritative export symbol (recorded at compile/load
    // time); we never recompute it from `pattern`'s program here, since a
    // source-free reloaded pattern only has a stub program (mainExport
    // "default"), which would clobber a non-"default" export name.
    const durableEntryRef =
      entryRef && !PatternManager.isKeylessPatternIdentity(entryRef.identity)
        ? entryRef
        : undefined;
    if (durableEntryRef) {
      resultCell.withTx(tx).setMetaRaw("patternIdentity", {
        identity: durableEntryRef.identity,
        symbol: durableEntryRef.symbol,
      }, rawMetaWriteAuthorization);
    }
    // The instantiation observer is a session-side reporting channel, not a
    // durable write, so it deliberately does NOT share the durable stamp's
    // keyless gate: it reports the SESSION pointer, `keyless:` included.
    // Reporting the session-synthetic identity is exactly how a harness's
    // stranded-piece guard (cf-harness `run_pattern` via `keylessSince`)
    // learns that the piece it just materialized is session-bound — under
    // the never-durable contract such a piece gets the no-pattern-meta
    // verdict instead of a durable pointer, but it is exactly as unopenable
    // by any other runtime, and suppressing the report would make that
    // guard fail open. No consumer uses the reported identity as a load or
    // update key; the recorders match on the cell hash and treat the
    // identity as evidence.
    if (entryRef) {
      this.#runtime.onPatternInstantiated?.({
        identity: entryRef.identity,
        symbol: entryRef.symbol,
        // The source path stamped at module-index time is the reliable one: a
        // pattern reloaded BY IDENTITY carries no program, so a nested
        // instantiation would otherwise arrive sourceless. Fall back to the
        // program for a hand-built pattern, which has one but was never indexed.
        main: getPatternSourcePath(pattern) ?? getPatternProgram(pattern)?.main,
        cell: resultCell.getAsNormalizedFullLink(),
      });
    }

    this.#updateResultProjection(tx, pattern, resultCell.withTx(tx), {
      preserveName: sameStoredSetup,
    });

    // This completion marker records the identity whose schema, arguments,
    // internal cells, and result projection were staged by setup(). Pattern
    // loading continues to use patternIdentity.
    if (durableEntryRef) {
      if (!setupState.leaveCompletionMarker) {
        resultCell.withTx(tx).setMetaRaw("patternSetupIdentity", {
          identity: durableEntryRef.identity,
          symbol: durableEntryRef.symbol,
        }, rawMetaWriteAuthorization);
      }
      // The durable stamps staged above supersede a keyless session pointer
      // — WHEN they commit. They are transaction state, so the pointer
      // removal rides the same commit: dropping it at staging would leave a
      // still-committed keyless piece pointer-less if this transaction
      // fails (its stamps roll back; the delete would not). The
      // unchanged-value guard keeps a re-setup staged after this one
      // authoritative — its own bookkeeping then owns the entry.
      const key = this.#getSetupKey(resultCell.withTx(tx));
      const priorPointer = this.#sessionPatternPointers.get(key);
      if (this.#runtime.servingPosture) {
        if (this.#sessionPatternPointer(resultCell.withTx(tx)) !== undefined) {
          this.#stageSessionPatternPointer(tx, resultCell, undefined);
        }
      } else if (priorPointer !== undefined) {
        tx.addCommitCallback((_tx, result) => {
          if (
            !result.error &&
            this.#sessionPatternPointers.get(key) === priorPointer
          ) {
            this.#sessionPatternPointers.delete(key);
          }
        });
      }
    } else if (entryRef) {
      // A piece that carries a DIFFERENT durable pointer (a real identity from
      // an earlier keyed setup, or a legacy keyless orphan) must not keep it:
      // setup just staged the KEYLESS pattern's state, and a standing stale
      // pointer would make later starts — fresh sessions especially — select
      // the OLD pattern over it. Clear both durable metas transactionally with
      // this setup; the cleared state IS the keyless piece's designed durable
      // verdict (no-pattern-meta), and clearing writes no keyless identity.
      const staleRef = getPatternIdentityRef(resultCell.withTx(tx));
      if (staleRef !== undefined) {
        resultCell.withTx(tx).setMetaRaw(
          "patternIdentity",
          undefined,
          rawMetaWriteAuthorization,
        );
      }
      if (
        getPatternSetupIdentityRef(resultCell.withTx(tx)) !== undefined
      ) {
        resultCell.withTx(tx).setMetaRaw(
          "patternSetupIdentity",
          undefined,
          rawMetaWriteAuthorization,
        );
      }
      if (this.#runtime.servingPosture) {
        this.#stageSessionPatternPointer(tx, resultCell, entryRef);
        return;
      }
      // The KEYLESS piece's stand-in for both skipped stamps, session-side:
      // the pattern pointer (start/resume flows) and the setup-completion
      // marker (`storedSetupMarker`'s reuse decision — without it a
      // re-derived sub-piece would restage its running setup every pass).
      //
      // Set EAGERLY at staging — visible before this transaction commits,
      // mirroring `locallyPreparedResults` (the pre-existing idiom for
      // setup bookkeeping; a concurrent start in the staging window is the
      // same race that map has always carried). The failure cleanup
      // RESTORES the prior committed pointer rather than deleting: the
      // durable stamp this map replaces was transactional, so an earlier
      // keyless setup's pointer survived a later setup's failed commit.
      // (If the prior pointer itself was never committed — two failing
      // stagings interleaved on one doc — the restore resurrects a staged
      // value; recording per-key committed state would close that residue
      // and is not worth its weight here.)
      const key = this.#getSetupKey(resultCell.withTx(tx));
      const priorPointer = this.#sessionPatternPointers.get(key);
      this.#sessionPatternPointers.set(key, entryRef);
      tx.addCommitCallback((_tx, result) => {
        if (!result.error) return;
        if (this.#sessionPatternPointers.get(key) === entryRef) {
          if (priorPointer !== undefined) {
            this.#sessionPatternPointers.set(key, priorPointer);
          } else {
            this.#sessionPatternPointers.delete(key);
          }
        } else if (
          this.#evictedSessionPatternPointers.get(key) === entryRef
        ) {
          // The staged pointer was capacity-evicted inside its own staging
          // window, so the TOMBSTONE now names an identity that never
          // committed — and a later replay of the pattern that DID commit
          // would read it as different-identity evidence and restage.
          // Re-point the tombstone at the last committed pointer (the value
          // the eviction would have recorded had this staging not refreshed
          // the entry).
          if (priorPointer !== undefined) {
            this.#evictedSessionPatternPointers.set(key, priorPointer);
          } else {
            this.#evictedSessionPatternPointers.delete(key);
          }
        }
      });
    }
  }

  /** Internal setup that returns whether scheduling is required. */
  #setupInternal<T, R = any>(
    providedTx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    validationOptions: SetupValidationOptions = {},
  ): SetupResult<R> {
    const tx = providedTx ?? this.#runtime.edit();

    logger.debug("cell-info", () => [
      `resultCell: ${resultCell.getAsNormalizedFullLink().id}`,
    ]);

    // A keyless piece set up by THIS session resolves through the
    // session-side pointer map (its `keyless:` ref is never stamped
    // durably); a fresh session correctly finds nothing.
    const previousIdentityRef = getPatternIdentityRef(resultCell.withTx(tx)) ??
      this.#sessionPatternPointer(resultCell.withTx(tx));
    const resolvedPattern = this.#resolveSetupPattern(
      patternOrModule,
      previousIdentityRef,
    );

    if (!resolvedPattern) {
      console.warn(
        "No pattern provided and no pattern found in result metadata. Not running.",
      );
      this.#locallyPreparedResults.delete(
        this.#getSetupKey(resultCell.withTx(tx)),
      );
      return { resultCell, needsStart: false };
    }

    const { pattern, entryRef, resolvedPatternOrModule } = resolvedPattern;
    // The reuse arms below write the argument without reaching
    // `#applySetupState`, which names these stores for every other setup
    // write. Naming them twice on one transaction costs a second marker
    // record and decides nothing differently.
    markPieceOwnedStores(tx, resultCell, pattern);
    // "Same pattern between runs" — drives name preservation and
    // reuse-running-setup. Compare the new pattern pointer against the stored
    // one. A keyless pattern carries a stable session-synthetic ref (minted per
    // pattern object), so re-setting up the same object compares equal too.
    const samePattern = previousIdentityRef !== undefined &&
      entryRef.identity === previousIdentityRef.identity &&
      entryRef.symbol === previousIdentityRef.symbol;
    const sameStoredSetup = samePattern &&
      !validationOptions.reapplyStoredSetup;
    // Derived once and used by BOTH gates below. The running-piece fast path
    // short-circuits before `#applySetupState`, so a live piece whose stored
    // setup was staged by another version would otherwise keep skipping the
    // re-stage no matter what the re-stage branch itself decides — the repair
    // would report success over an argument nothing validated.
    // Read through `tx`, like the identity read above: this decides whether the
    // transaction writes the argument, so it belongs in the same conflict set
    // rather than reading around it off committed state.
    const marker = storedSetupMarker(
      resultCell.withTx(tx),
      entryRef,
      this.#sessionPatternPointer(resultCell.withTx(tx)),
    );
    // What a capacity eviction dropped for this doc, if anything — the
    // evidence the exemption below weighs when the live pointer is gone.
    const evictedPointer = this.#evictedSessionPatternPointers.get(
      this.#getSetupKey(resultCell.withTx(tx)),
    );
    const setupState: SetupStateReuse = {
      sameStoredSetup,
      // The zero-evidence exemption: a piece with NO pattern pointer (durable
      // or session) and NO setup marker carries no evidence any update moved it
      // — the KEYLESS piece's designed durable verdict (a keyless piece stamps
      // nothing, so a FRESH session re-encountering one reads exactly this),
      // and the pre-marker legacy root. The absent-marker exemption's own
      // rationale applies in full: re-staging would validate — and rewrite
      // defaults over — a stored argument no update touched. A marker naming
      // ANOTHER identity still restages, and any surviving pointer keeps the
      // ordinary rule. An EVICTED session pointer is NOT zero evidence — this
      // session had the evidence and lost it to capacity. The tombstone says
      // WHICH pattern it lost: a different-identity re-setup takes the
      // conservative restage the un-evicted state would have taken, while a
      // same-identity re-setup keeps the exemption — the evidence agrees with
      // the stored setup, and forcing a restage there would break the very
      // replay the exemption ships for.
      restageStoredArgument: (!sameStoredSetup || marker === "other") &&
        !(previousIdentityRef === undefined && marker === "absent" &&
          !validationOptions.reapplyStoredSetup &&
          (evictedPointer === undefined ||
            (evictedPointer.identity === entryRef.identity &&
              evictedPointer.symbol === entryRef.symbol))),
      // "matches" only. An ABSENT marker is not evidence that the running graph
      // is this pattern — it is the absence of evidence either way, and the two
      // must not collapse into one boolean.
      storedSetupMatches: sameStoredSetup && marker === "matches",
    };
    const sourceKey = getTxDebugActionId(tx) ?? "none";
    triggerFlowLogger.debug(`setup-internal/${sourceKey}`, () => [
      `[SETUP] source=${sourceKey}`,
      `result=${resultCell.getAsNormalizedFullLink().id}`,
      `pattern=${describePatternOrModule(resolvedPatternOrModule)}`,
      `previousPatternIdentity=${
        previousIdentityRef ? previousIdentityRef.identity : "none"
      }`,
      `nextPatternIdentity=${entryRef ? entryRef.identity : "keyless"}`,
    ]);

    if (isCellLink(argument)) {
      argument = createSigilLinkFromParsedLink(
        parseLink(argument),
        {
          base: resultCell.getAsNormalizedFullLink(),
          includeSchema: true,
          overwrite: "redirect",
        },
      ) as T;
    }

    if (validationOptions.validateCurrentArgument !== undefined) {
      const currentArgumentLink = getMetaLink(
        resultCell.withTx(tx),
        "argument",
      );
      if (currentArgumentLink === undefined) {
        throw new Error("piece missing its current argument");
      }
      validationOptions.validateCurrentArgument(
        this.#runtime.getCellFromLink(
          currentArgumentLink,
          undefined,
          tx,
        ),
      );
    }

    if (validationOptions.patternRepository !== undefined) {
      setPatternRepository(
        resultCell,
        tx,
        validationOptions.patternRepository,
      );
    }
    if (validationOptions.initializePieceSourceHistory === true) {
      initializePieceSourceHistory(
        this.#runtime,
        resultCell,
        tx,
        entryRef,
        validationOptions.initialPieceSourceOrigin,
      );
    }
    if (validationOptions.pieceSourceTransition !== undefined) {
      applyPieceSourceTransition(
        this.#runtime,
        resultCell,
        tx,
        entryRef,
        validationOptions.pieceSourceTransition,
      );
      if (validationOptions.sourceUpdate !== undefined) {
        this.#runtime.patternManager.stageSourceUpdate(
          validationOptions.sourceUpdate,
          resultCell.space,
          validationOptions.pieceSourceTransition.expected.pattern.identity,
          entryRef.identity,
          tx,
        );
      }
    }

    const runningSetup = this.#maybeReuseRunningSetup(
      tx,
      resultCell,
      argument,
      pattern,
      entryRef,
      setupState,
      validationOptions.referencedArgumentFields,
    );
    if (runningSetup) {
      return runningSetup;
    }

    // AFTER the running-piece gate, deliberately. Later reads resolve the root
    // through this meta, so writing the candidate's result schema over a piece
    // whose nodes still produce the previous version's shape is the same
    // partial swap the gate above exists to prevent — reads would describe a
    // version that is not running. A piece that is NOT reused reaches
    // `#applySetupState` below, which stages the matching projection in the same
    // transaction, so the schema and the projection cannot disagree.
    this.#updateResultSchemaMeta(tx, resultCell, pattern.resultSchema);

    this.#applySetupState(
      tx,
      pattern,
      entryRef,
      setupState,
      argument,
      resultCell,
      validationOptions.referencedArgumentFields,
    );

    if (validationOptions.validateArgumentLinks !== undefined) {
      // applySetupState() either installs this link or throws.
      const argumentLink = getMetaLink(resultCell.withTx(tx), "argument")!;
      validationOptions.validateArgumentLinks(
        this.#runtime.getCellFromLink(argumentLink, undefined, tx),
        pattern.argumentSchema,
      );
    }

    if (!validationOptions.prepareForResume) {
      const key = this.#getSetupKey(resultCell.withTx(tx));
      const preparedPatternKey = patternIdentityKey(entryRef);
      this.#locallyPreparedResults.set(key, preparedPatternKey);
      tx.addCommitCallback((_tx, result) => {
        if (
          result.error &&
          this.#locallyPreparedResults.get(key) === preparedPatternKey
        ) {
          this.#locallyPreparedResults.delete(key);
        }
      });
      // ALREADY-RUNNING piece, full setup staged, KEYLESS pattern: for a real
      // pattern the durable stamp carries this exact moment to the piece's meta
      // watcher, whose swap replaces the running graph with the new version
      // (bare setup(), run(), and the deferred-start arm all funnel through
      // here — the reuse paths returned earlier). A keyless identity never
      // lands durably, so request the swap through the session channel once the
      // setup commit lands — the watcher's own ordering, with the watcher's own
      // guards deciding whether anything changed.
      if (PatternManager.isKeylessPatternIdentity(entryRef.identity)) {
        const sessionSwap = this.#sessionPatternSwaps.get(key);
        if (sessionSwap !== undefined) {
          const swapPattern = pattern;
          const swapRef = entryRef;
          tx.addCommitCallback((_tx, result) => {
            if (result.error) return;
            sessionSwap(swapPattern, swapRef);
          });
        }
      }
    }

    return { resultCell, pattern, patternRef: entryRef, needsStart: true };
  }

  /**
   * Start scheduling nodes for a previously set up piece.
   * If already started, this is a no-op.
   *
   * Returns a Promise that resolves to true when this start left the piece
   * running with a lifetime of its own, false when it was superseded or the
   * piece was stopped while the start resolved, or rejects with an error.
   * Runs synchronously when data is available (important for tests).
   *
   * Single-flight per doc: a call whose doc already carries a current
   * in-flight attempt returns that attempt's outcome instead of running a
   * second resolution pipeline. The dependency pre-sync is the expensive phase
   * of a start, and concurrent callers — several views asking for the same
   * space root during one page load, say — would otherwise each run it in
   * full. Joining shares the outcome, rejection included, and runs under the
   * first caller's options. A call made after a stop never
   * joins — the stop moved the doc's start generation, so the held attempt is
   * no longer current and a fresh attempt runs. Calls entering through
   * different docs whose links resolve to the same piece do not join either;
   * they run separate resolutions and converge at the registration guard
   * before instantiation.
   */
  start<T = any>(resultCell: Cell<T>): Promise<boolean> {
    const startKey = this.#getDocKey(resultCell);
    const inFlight = this.#inFlightStartsByDoc.get(startKey);
    if (
      inFlight?.settled !== undefined && this.#isStartAttemptCurrent(inFlight)
    ) {
      return inFlight.settled;
    }
    const attempt: StartAttempt = {
      lifecycleEpoch: this.#lifecycleEpoch,
      generationsByDoc: new Map(),
      preResolutionStopKeys: new Set(),
    };
    this.#activeStartAttempts.add(attempt);
    this.#trackStartAttempt(attempt, startKey);
    try {
      const settled = this.#doStart(resultCell, new Set(), attempt)
        .then((started) => {
          // This start gives the result a lifetime of its own, so an enclosing
          // pattern releasing it later leaves it running. An attempt whose
          // target a stop superseded claims nothing: the registration under
          // the key belongs to whatever replaced it, and a stop that won the
          // race leaves no registration at all. Both cases report that this
          // start is not running. The check is scoped to the target: a stop of
          // an intermediate link doc after the target's registration installed
          // does not touch that registration, so it neither voids the claim
          // nor the report.
          const target = attempt.targetKey;
          const stillRunning = started && target !== undefined &&
            this.#isStartAttemptCurrentFor(attempt, target) &&
            this.#cancels.has(target);
          if (stillRunning) {
            this.#independentlyStartedResults.add(target);
          }
          return stillRunning;
        })
        .finally(() => {
          this.#finishStartAttempt(attempt);
        });
      attempt.settled = settled;
      this.#inFlightStartsByDoc.set(startKey, attempt);
      return settled;
    } catch (error) {
      this.#finishStartAttempt(attempt);
      return Promise.reject(error);
    }
  }

  /**
   * Releases a child an enclosing pattern is done with. Stops only the exact
   * registration this invocation installed — a later attempt that replaced it
   * owns itself — and leaves a result that has a lifetime of its own running.
   */
  releaseChild<T>(
    resultCell: Cell<T>,
    installedCancel: Cancel | undefined,
  ): void {
    // Shared scoped registrations belong to all selecting instances. A
    // launch's registration token cannot authorize their collective teardown.
    if (this.#usesScopedPrograms(resultCell)) return;
    this.#releaseUnownedChild(resultCell, installedCancel);
  }

  /** Holds a child for a parent node group's lifetime. */
  retainChild<T>(resultCell: Cell<T>): Cancel {
    if (!this.#usesScopedPrograms(resultCell)) {
      return () => this.releaseChild(resultCell, undefined);
    }
    const key = this.#getDocKey(resultCell);
    let owners = this.#scopedChildOwners.get(key);
    if (owners === undefined) {
      owners = new Set();
      this.#scopedChildOwners.set(key, owners);
    }
    const registrations = owners;
    const owner = {};
    registrations.add(owner);
    return () => {
      if (!registrations.delete(owner)) return;
      if (
        this.#scopedChildOwners.get(key) !== registrations ||
        registrations.size !== 0
      ) return;
      this.#scopedChildOwners.delete(key);
      this.#releaseUnownedChild(resultCell, undefined);
    };
  }

  #releaseUnownedChild<T>(
    resultCell: Cell<T>,
    installedCancel: Cancel | undefined,
  ): void {
    const key = this.#getDocKey(resultCell);
    const registration = this.#cancels.get(key);
    if (installedCancel !== undefined && registration !== installedCancel) {
      return;
    }
    if (this.#independentlyStartedResults.has(key)) return;
    // A start still resolving may be about to give this result a lifetime of
    // its own, and it cannot say so until it finishes. Declining here keeps a
    // page that is still opening from being closed by its parent. An attempt
    // that then fails leaves the result registered until the runtime stops it,
    // which is the same bound the scheduler already accepts for a start that
    // exhausts its retries.
    if ((this.#activeStartAttemptsByDoc.get(key)?.size ?? 0) > 0) return;
    if (registration === undefined) {
      // A commit-gated start installs nothing until its transaction commits,
      // so a launch whose child is still gated holds that child through the
      // pending start alone. Cancelling it is what keeps the child from
      // starting after the pattern that launched it is gone. The width is the
      // one the TODO in stopResult() describes: every pending start for the
      // result goes, not only the one this launch scheduled.
      this.#cancelPendingDeferredStarts(key);
      return;
    }
    // A link start that has not yet followed its link is not indexed under
    // `key`, so the check above cannot see it. An explicit stop is
    // authoritative over such a start and tombstones it; a release is not, and
    // leaves it to resolve into a result of its own.
    this.#stopResult(resultCell);
  }

  /**
   * True when `resultCell` is its space's default/root pattern — the piece the
   * PieceController's own cold-start repair (startEnsuredDefaultPattern) owns,
   * including its roll-forward-to-official backstop and clear-error contract.
   * The runner's initial-start setup repair must DEFER to the controller for
   * the root and heal only the nested pieces the controller never sees (a
   * profile mounted via a #wish, say). Profiles are plain `inSpace` pieces and
   * are never a space's `defaultPattern` (only the controller sets that), so
   * they are correctly not excluded. Called only on the rare repair path, so
   * the space-cell read costs nothing on a healthy start. A read failure
   * returns false: better to attempt the idempotent, fail-closed repair than
   * to leave a piece bricked because a lookup raced.
   */
  #isSpaceDefaultPattern(resultCell: Cell<unknown>): boolean {
    try {
      const defaultPatternCell = this.#runtime
        .getSpaceCell(resultCell.space)
        .key("defaultPattern")
        .get() as Cell<unknown> | undefined;
      if (defaultPatternCell === undefined) return false;
      const a = resultCell.getAsNormalizedFullLink();
      const b = defaultPatternCell.getAsNormalizedFullLink();
      // Full document identity: space + scope + id. `scope` (space/user/session)
      // is part of the address — a user- or session-scoped nested cell can share
      // an entity id with the space-scoped root, so omitting scope would
      // misclassify it as the root and silently suppress its heal. `path` is
      // intentionally not compared: doStart normalizes a subpath input to its
      // root before `#startCore()`, so resultCell is always a root cell here.
      return a.space === b.space &&
        (a.scope ?? "space") === (b.scope ?? "space") &&
        a.id === b.id;
    } catch {
      return false;
    }
  }

  /**
   * Whether the internal-cell manifest stored on `resultCell` names every
   * derived internal cell of `pattern`. `false` says no setup for this pattern
   * ran over this document, which is what the cold-start repair in
   * `#startCore()` turns on.
   */
  #storedManifestCovers(resultCell: Cell<unknown>, pattern: Pattern): boolean {
    const descriptors = pattern.derivedInternalCells ?? [];
    if (descriptors.length === 0) return true;
    const stored = convertibleJsFromFabricValue(
      resultCell.getMetaRaw("internal", { meta: ignoreReadForScheduling }),
    );
    if (!Array.isArray(stored)) return false;
    const manifest = stored as InternalCellDescriptor[];
    return descriptors.every((descriptor) =>
      manifest.some((entry) =>
        deepEqual(entry.partialCause, descriptor.partialCause) &&
        entry.kind === descriptor.kind
      )
    );
  }

  /** Convert a module to pattern format */
  #moduleToPattern(module: Module): Pattern {
    const resultSchema = module.resultSchema ?? {};
    return {
      argumentSchema: module.argumentSchema ?? {},
      resultSchema,
      derivedInternalCells: [{
        partialCause: "$result",
        schema: resultSchema,
      }],
      result: { $alias: { partialCause: "$result", path: [] } },
      nodes: [
        {
          module,
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "$result", path: [] } },
        },
      ],
    } satisfies Pattern;
  }

  /** Resolve a Pattern or Module to a Pattern */
  #resolveToPattern(patternOrModule: Pattern | Module): Pattern {
    return isModule(patternOrModule)
      ? this.#moduleToPattern(patternOrModule as Module)
      : (patternOrModule as Pattern);
  }

  /** Whether this piece shares its registration across scoped serving runs. */
  #usesScopedPrograms(resultCell: Cell<unknown>): boolean {
    return this.#runtime.servingPosture &&
      this.#runtime.experimental.serverExecution === true &&
      (["user", "session"].includes(
        resultCell.getAsNormalizedFullLink().scope ?? "space",
      ));
  }

  /**
   * Owns one node group per program while the pointer coordinator observes
   * each demanded instance through ordinary scheduler reads.
   */
  #startScopedPrograms(
    resultCell: Cell<any>,
    options: RunnerRunOptions & {
      tx?: IExtendedStorageTransaction;
      givenPattern?: Pattern;
    },
  ): ScopedPieceRegistration {
    const pieceKey = this.#getDocKey(resultCell);
    const existing = this.#scopedPieces.get(pieceKey);
    if (existing !== undefined) {
      if (options.tx && options.givenPattern) {
        existing.ensure(options.tx, options.givenPattern);
      }
      return existing;
    }
    const variants = new Map<string, PieceRegistration>();
    const selections = new Map<string, ImplementationSelection>();
    const choices = new Map<ScopeKey, string>();
    const pendingChoices = new Map<IExtendedStorageTransaction, {
      instance: ScopeKey;
      selected: string | undefined;
    }>();
    const [cancelGroup, addCancel] = useCancelGroup();
    let active = true;
    const cancel = (() => {
      if (!active) return;
      active = false;
      cancelGroup();
      for (const registration of variants.values()) {
        registration();
        this.#allCancels.delete(registration);
      }
      variants.clear();
      selections.clear();
      choices.clear();
      pendingChoices.clear();
      this.#scopedPieces.delete(pieceKey);
      this.#runtime.releaseRuntimeOwnedStores(
        resultCell.getAsNormalizedFullLink(),
        runtimeWritePolicyAuthorization,
      );
    }) as ScopedPieceRegistration;
    cancel.graphIsInstalled = () =>
      [...variants.values()].some((variant) => variant.graphIsInstalled());
    cancel.variants = variants;
    cancel.piece = resultCell.getAsNormalizedFullLink().id;
    this.#cancels.set(pieceKey, cancel);
    this.#allCancels.add(cancel);
    this.#scopedPieces.set(pieceKey, cancel);

    const readSelection = (tx: IExtendedStorageTransaction) => {
      const cell = resultCell.withTx(tx);
      return asPatternIdentityRef(cell.getMetaRaw("patternIdentity")) ??
        this.#sessionPatternPointer(cell);
    };
    const retireUnused = () => {
      const selected = new Set([
        ...choices.values(),
        ...[...pendingChoices.values()].map((choice) => choice.selected),
      ]);
      for (const [key, registration] of variants) {
        if (selected.has(key)) continue;
        variants.delete(key);
        selections.delete(key);
        this.#allCancels.delete(registration);
        registration();
      }
    };
    const recordSelection = (
      tx: IExtendedStorageTransaction,
      selected: string | undefined,
    ) => {
      const identity = tx.tx.scopeKeyIdentity ?? this.#runtime.scopeKeyIdentity;
      const instance = resolveScopeKey(
        resultCell.getAsNormalizedFullLink().scope,
        identity,
      );
      const alreadyRecorded = pendingChoices.has(tx);
      if (!alreadyRecorded && choices.get(instance) === selected) {
        // An earlier pending choice can still replace the accepted one. Keep
        // this observation until both transactions receive their verdicts.
        const hasPendingChange = [...pendingChoices.values()].some((choice) =>
          choice.instance === instance && choice.selected !== selected
        );
        if (!hasPendingChange) return;
      }
      pendingChoices.set(tx, { instance, selected });
      if (alreadyRecorded) return;
      this.#afterAcceptedCommit(tx, (accepted) => {
        if (!active) return;
        const choice = pendingChoices.get(tx);
        pendingChoices.delete(tx);
        if (accepted && choice) {
          if (choice.selected === undefined) choices.delete(choice.instance);
          else choices.set(choice.instance, choice.selected);
        }
        retireUnused();
      });
    };
    cancel.ensure = (tx, pattern) => {
      if (!active) return;
      const ref = this.#entryRefForPattern(pattern);
      const key = patternIdentityKey(ref);
      recordSelection(tx, key);
      if (variants.get(key)?.graphIsInstalled()) {
        for (const initialize of selections.get(key)!.instanceInitializers) {
          initialize(tx);
        }
        return;
      }
      const selection: ImplementationSelection = {
        key,
        actions: new Set(),
        instanceInitializers: new Set(),
        matches: (runTx) => {
          if (!active) return false;
          const selected = readSelection(runTx);
          return selected !== undefined && patternIdentityKey(selected) === key;
        },
      };
      selections.set(key, selection);
      this.#startCore(resultCell, {
        tx,
        givenPattern: pattern,
        doNotUpdateOnPatternChange: true,
        parentPieceRootId: options.parentPieceRootId,
        variantRegistration: { registrations: variants, selection },
      });
    };
    const coordinator: Action = (tx) => {
      const selected = readSelection(tx);
      if (selected === undefined) {
        recordSelection(tx, undefined);
        return;
      }
      const live = this.#runtime.patternManager.artifactFromIdentitySync(
        selected.identity,
        selected.symbol,
      ) as Pattern | undefined;
      if (live === undefined) {
        return this.#runtime.patternManager.loadPatternByIdentity(
          selected.identity,
          selected.symbol,
          resultCell.space,
        ).then((loaded) => {
          if (loaded === undefined) {
            throw new Error(
              `Selected program ${patternIdentityKey(selected)} is unavailable`,
            );
          }
          throw new RetryImmediately("Loading the selected program");
        });
      }
      cancel.ensure(tx, live);
    };
    Object.assign(coordinator, {
      implementationHash: "cf:runner/program-selection",
      schedulerInstanceKey: pieceKey,
      reads: [resultCell.getAsNormalizedFullLink()],
      writes: [resultCell.getAsNormalizedFullLink()],
    });
    cancel.wake = () => {
      if (!active) return;
      this.#runtime.scheduler.invalidateAction(coordinator);
      for (const selection of selections.values()) {
        for (const action of selection.actions) {
          this.#runtime.scheduler.invalidateAction(action);
        }
      }
    };
    addCancel(this.#runtime.scheduler.subscribe(
      coordinator,
      this.#schedulerRehydrationOptions(
        resultCell,
        false,
        options.parentPieceRootId,
      ),
    ));
    if (options.tx && options.givenPattern) {
      cancel.ensure(options.tx, options.givenPattern);
    }
    return cancel;
  }

  /** Clears one scoped instance's program selection and result atomically. */
  clearInTransaction(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<unknown>,
  ): void {
    if (!this.#usesScopedPrograms(resultCell)) {
      const key = this.#getDocKey(resultCell);
      const registration = this.#cancels.get(key);
      tx.addCommitCallback((committed, outcome) => {
        if (outcome.error) return;
        const retire = () => {
          if (
            registration !== undefined &&
            this.#cancels.get(key) === registration &&
            getPatternIdentityRef(resultCell.withTx(undefined)) === undefined
          ) this.stop(resultCell);
        };
        const settlement = waveSettlementOf(committed) ?? waveSettlementOf(tx);
        if (settlement === undefined) retire();
        else {
          void settlement.then((accepted) => {
            if (accepted.error === undefined) retire();
          });
        }
      });
    }
    const result = resultCell.withTx(tx);
    const key = this.#getSetupKey(result);
    if (this.#runtime.servingPosture) {
      this.#stageSessionPatternPointer(tx, result, undefined);
    } else {
      const prior = this.#sessionPatternPointers.get(key);
      this.#sessionPatternPointers.delete(key);
      tx.addCommitCallback((_committed, outcome) => {
        if (outcome.error && prior && !this.#sessionPatternPointers.has(key)) {
          this.#sessionPatternPointers.set(key, prior);
        }
      });
    }
    result.setMetaRaw("patternIdentity", undefined, rawMetaWriteAuthorization);
    result.set(undefined);
  }

  /**
   * Core start implementation. Sets up cancel groups, instantiates nodes,
   * and watches for pattern changes.
   *
   * @param resultCell - The result cell to start
   * @param options.tx - Transaction to use for initial setup (optional)
   * @param options.givenPattern - Pattern to use instead of looking up by ID
   * @returns The exact cancel registration installed for this start
   */
  #startCore<T = any>(
    resultCell: Cell<T>,
    options: {
      tx?: IExtendedStorageTransaction;
      variantRegistration?: PieceVariantRegistration;
      givenPattern?: Pattern;
      doNotUpdateOnPatternChange?: boolean;
      schedulerRehydration?: SchedulerRehydrationSubscriptionOptions;
      // Resumed-from-synced-state: hold each action's initial rehydration/run
      // until the space has finished syncing, so consumers don't race the data.
      awaitSyncBeforeInitialRun?: boolean;
      // See RunnerRunOptions.parentPieceRootId.
      parentPieceRootId?: string;
    } = {},
  ): Cancel {
    const {
      tx,
      givenPattern,
      doNotUpdateOnPatternChange,
    } = options;
    if (
      options.variantRegistration === undefined &&
      this.#usesScopedPrograms(resultCell)
    ) {
      return this.#startScopedPrograms(resultCell, options);
    }
    const registrations: Map<string, PieceRegistration> =
      options.variantRegistration?.registrations ?? this.#cancels;
    const pieceKey = this.#getDocKey(resultCell);
    const key = options.variantRegistration?.selection.key ??
      this.#getDocKey(resultCell);
    // Before the registration below is set, so that a listener reads the
    // registry as it stood when this install began.
    this.#runtime.telemetry.submit({ type: "runner.piece.install", key });
    this.#locallyStoppedResults.delete(pieceKey);

    // Create cancel group early, before wiring pattern/node sinks.
    const [cancelGroup, addCancel] = useCancelGroup();
    // A recoverable instantiation may be waiting for its conflict/session gate
    // and a named-document pull before it retries. That work belongs to the
    // OUTER registration, not the retired node group: stopping the piece must
    // release the fire-and-forget settlement even when readiness never does.
    const retryReadinessTeardown = new AbortController();
    addCancel(() => retryReadinessTeardown.abort());
    const startLifecycleEpoch = this.#lifecycleEpoch;
    let active = true;
    const cancel = (() => {
      if (!active) return;
      active = false;
      this.#locallyCommittedHandlerResultStarts.delete(pieceKey);
      cancelGroup();
      // AFTER the group, not inside it. The stores this piece owns are
      // enrolled per instantiation and released once, with the piece — but a
      // builtin's teardown writes into those same stores on a transaction of
      // its own (a dialog takes its pending flag down, a fetch clears its
      // request id), and a release that ran first would leave those writes
      // measured against a ceiling the route can no longer answer. Releasing
      // as a member of the group would do exactly that: `useCancelGroup` runs
      // its members in insertion order, and this one is registered before the
      // node group is.
      //
      // Hanging it on the per-instantiation node group instead would be wrong
      // for a different reason: a swap, a repair and a withdrawn-contribution
      // recovery each tear that group down and re-instantiate, so the
      // enrollment would survive only while every such site happened to cancel
      // before instantiating.
      if (options.variantRegistration === undefined) {
        this.#runtime.releaseRuntimeOwnedStores(
          resultCell.getAsNormalizedFullLink(),
          runtimeWritePolicyAuthorization,
        );
      }
    }) as PieceRegistration;
    // `cancelNodes` holds the live graph's cancellation, and stands empty
    // between the retirement a refused instantiation commit performs and the
    // instantiation that replaces it.
    cancel.graphIsInstalled = () => cancelNodes !== undefined;
    registrations.set(key, cancel);
    this.#allCancels.add(cancel);

    // Helper to clean up on error
    const cleanup = () => {
      registrations.delete(key);
      this.#allCancels.delete(cancel);
      cancel();
    };

    // Track the current pattern's identity key and node cancellation. The key
    // is `patternIdentityKey({identity, symbol})` for a keyed pattern, or a
    // keyless sentinel for a hand-built pattern with no stored pointer (whose
    // pattern can only change via a fresh run(), not via the meta watcher).
    const KEYLESS = "\0keyless";
    let currentPatternKey: string | undefined;
    // The identity of the pattern whose nodes are LIVE right now — which can
    // differ from `currentPatternKey` (the pointer value last observed): a
    // parent-driven start instantiates its given pattern while the durable
    // pointer may still hold an older identity. The unloadable-pointer
    // roll-forward below writes THIS ref back, never the observed key.
    let runningRef: { identity: string; symbol: string } | undefined;
    // The live pattern VALUE those nodes were instantiated from. Kept for the
    // roll-forward's keyless arm: when `runningRef` is absent or keyless (the
    // never-durable session mint), the durable convergence target is the
    // value's module-addressed PRODUCER — the first real entry ref up its
    // derivation chain (`resolveProducerEntryRef`).
    let runningPattern: Pattern | undefined;
    let cancelNodes: Cancel | undefined;
    let initialSchedulerRehydrationAvailable = true;
    // The cold-start setup repair `instantiateInitialPattern` found owed for
    // the pattern this start began with. It stages into the instantiation's
    // own transaction, so the setup and the graph that reads it land or fail
    // together, under the one retry and the wave settlement that transaction
    // already has.
    let setupRepair: {
      pattern: Pattern;
      stage: (tx: IExtendedStorageTransaction) => void;
    } | undefined;

    // Helper to instantiate nodes for a pattern
    const instantiatePattern = (
      pattern: Pattern,
      useTx?: IExtendedStorageTransaction,
      recoverOnce = true,
    ) => {
      if (!active || startLifecycleEpoch !== this.#lifecycleEpoch) return;
      // Create new cancel group for nodes
      const [nodeCancel, addNodeCancel] = useCancelGroup();
      cancelNodes = nodeCancel;
      addCancel(nodeCancel);

      // Instantiate nodes
      const actualTx = useTx ?? this.#runtime.edit();
      enrollPieceOwnedStores(actualTx, resultCell, pattern);
      const shouldCommit = !useTx;
      // A transaction that also carries the cold-start setup repair is named
      // for it, so its seal and any refusal of it are attributed to the repair
      // rather than to an ordinary instantiation.
      const repair = shouldCommit && setupRepair?.pattern === pattern &&
          !this.#storedManifestCovers(resultCell, pattern)
        ? setupRepair
        : undefined;
      const startActionId = `${
        repair ? "piece-start-repair" : "piece-instantiate"
      }/${resultCell.sourceURI}`;
      if (shouldCommit) {
        // Self-minted instantiation tx (the hot-swap watcher's swapToPattern
        // arm reaches here tx-less): runtime-internal piece machinery with no
        // scheduler run around it, so stamp the sanctioned bookkeeping kind
        // (serving-loop.md §3d) like the sibling setup write in swapToPattern
        // below. A PROVIDED tx keeps its caller's stamp — never restamped here.
        // No-op off the serving posture.
        this.#runtime.stampServerRun(actualTx, {
          actionId: startActionId,
          kind: "bookkeeping",
        });
        // The instantiation's writes are authored bookkeeping bound for
        // the wire, so it reads the durable replica view: a commit basis
        // naming a client speculation layer is refused terminally
        // (speculation.md §6), and the arm that catches that refusal
        // retires the piece registration along with the event handlers
        // its graph installed.
        markDurableReadTx(actualTx);
        if (repair !== undefined) {
          // Staged ahead of the nodes, which read what it writes. Fail
          // closed: a repair that cannot proceed aborts the transaction
          // before anything is wired or committed, and the piece is left
          // exactly as it was.
          try {
            repair.stage(actualTx);
          } catch (repairError) {
            actualTx.abort();
            throw repairError;
          }
        }
      }
      // A boot snapshot belongs to exactly one pattern instantiation. A later
      // patternIdentity hot-swap must register fresh under the same durable
      // piece identity rather than replaying the old implementation's cache.
      const schedulerRehydration = initialSchedulerRehydrationAvailable
        ? options.schedulerRehydration ?? this.#schedulerRehydrationOptions(
          resultCell,
          options.awaitSyncBeforeInitialRun,
          options.parentPieceRootId,
        )
        : this.#schedulerRehydrationOptions(
          resultCell,
          undefined,
          options.parentPieceRootId,
        );
      schedulerRehydration.implementationSelection = options.variantRegistration
        ?.selection;
      initialSchedulerRehydrationAvailable = false;
      try {
        if (
          this.#runtime.servingPosture &&
          this.#runtime.experimental.serverExecution &&
          sessionScopedArgumentKeys(pattern.argumentSchema).length > 0
        ) {
          const selection = schedulerRehydration.implementationSelection;
          const argument = getMetaLink(resultCell.withTx(actualTx), "argument");
          const bindings = argument ? [argument] : [];
          const declaredTargets = bindings.flatMap((link) =>
            sessionScopedArgumentKeys(pattern.argumentSchema).map((key) => ({
              ...link,
              scope: "user" as const,
              path: [...link.path, key],
            }))
          );
          const initialize: Action = async (runTx) => {
            if (selection && !selection.matches(runTx)) return;
            const argument = getMetaLink(resultCell.withTx(runTx), "argument");
            if (argument) {
              const targets = scopedArgumentInitializationTargets(
                this.#runtime,
                runTx,
                argument,
                pattern.argumentSchema,
              );
              Object.assign(initialize, {
                materializerWriteEnvelopes: dedupeNormalizedLinks([
                  ...declaredTargets,
                  ...targets,
                ]),
              });
              // Initialization needs the actor's whole user document: diffing
              // a partially delivered row can remove unseen sibling fields.
              await Promise.all(
                targets.map((target) =>
                  syncCellForIdentity(
                    this.#runtime.getCellFromLink({
                      ...target,
                      path: [],
                      schema: false,
                    }),
                    runTx.tx.scopeKeyIdentity,
                  )
                ),
              );
              initializeScopedArgumentSlots(
                this.#runtime,
                runTx,
                argument,
                pattern.argumentSchema,
              );
            }
          };
          Object.assign(initialize, {
            implementationHash: "cf:runner/scoped-input-initialization",
            schedulerInstanceKey: programActionInstanceKey(
              schedulerActionInstanceKey({
                process: resultCell.getAsNormalizedFullLink(),
                reads: bindings,
                writes: bindings,
              }),
              selection,
            ),
            reads: bindings,
            writes: [],
            materializerWriteEnvelopes: declaredTargets,
            pattern,
          });
          selection?.actions.add(initialize);
          addNodeCancel(() => selection?.actions.delete(initialize));
          addNodeCancel(this.#runtime.scheduler.subscribe(
            initialize,
            schedulerRehydration,
          ));
        }
        for (const [nodeIndex, node] of pattern.nodes.entries()) {
          const baseCell = resultCell.withTx(actualTx);
          this.#instantiateNode(
            actualTx,
            node,
            baseCell,
            addNodeCancel,
            pattern,
            {
              ...schedulerRehydration,
              viewNodeId: viewNodeId(
                resultCell.getAsNormalizedFullLink(),
                nodeIndex,
              ),
            },
          );
        }
      } finally {
        if (shouldCommit) {
          this.#runtime.prepareTxForCommit(actualTx);
          // Fire-and-forget by design (start() resolves before the
          // commit settles), but NEVER swallowed: a refused or failed
          // instantiation commit means the piece is running against
          // writes that never landed, so the failure surfaces loudly
          // and, on a serving runtime, counted.
          const instantiateActionId = startActionId;
          const patternKeyAtInstantiation = currentPatternKey;
          const teardownRegistrationIfCurrent = () => {
            if (registrations.get(key) !== cancel) return;
            registrations.delete(key);
            this.#allCancels.delete(cancel);
            cancel();
          };
          const exactNodesAreCurrent = () =>
            active && startLifecycleEpoch === this.#lifecycleEpoch &&
            registrations.get(key) === cancel && cancelNodes === nodeCancel &&
            currentPatternKey === patternKeyAtInstantiation;
          const recoverInstantiationOnce = async (
            error: unknown,
            recoverable = true,
          ) => {
            if (!exactNodesAreCurrent()) {
              // A stop, a runtime cycle, or a newer instantiation retired
              // these nodes while the commit was in flight. Whoever holds
              // the key now has their own graph; nothing was lost.
              logger.warn("piece-start-commit-superseded", () => [
                `piece-start commit ${instantiateActionId} was refused after ` +
                "its nodes were retired; the current owner is unaffected",
                error,
              ]);
              return;
            }
            if (!recoverOnce || !recoverable) {
              // Either the one retry lost the same way, or this failure was
              // never the recoverable class. The graph's setup does not
              // become durable and the load has genuinely failed.
              this.#reportPieceStartCommitFailure(instantiateActionId, error);
              teardownRegistrationIfCurrent();
              return;
            }

            // Recoverable, and about to be recovered: the setup writes have
            // not landed YET. Counting this as a structure-load failure
            // would report a loss that the retry below goes on to repair,
            // and a routine race would read as a health regression.
            logger.warn("piece-start-commit-recovering", () => [
              `piece-start commit ${instantiateActionId} lost its basis to ` +
              "the serving side; re-instantiating once from the caught-up view",
              error,
            ]);

            // The graph reads its own pending setup and internal-cell writes
            // while it is installed. A stale-read refusal or a later wave
            // withdrawal means those writes never became durable. Retire only
            // the nodes this transaction installed; the outer registration
            // remains in place so its parent/root owner keeps the same
            // cancellation handle.
            nodeCancel();
            if (cancelNodes === nodeCancel) cancelNodes = undefined;
            await this.#runtime.awaitCommitRetryReadiness(
              error,
              retryReadinessTeardown.signal,
            );

            // A stop aborts the readiness/pull work above; a runtime cycle,
            // pointer change, or newer instantiation during the wait owns the
            // key now. Otherwise retry exactly once; a second recoverable
            // failure tears the registration down instead of spinning.
            if (
              retryReadinessTeardown.signal.aborted || !active ||
              startLifecycleEpoch !== this.#lifecycleEpoch ||
              registrations.get(key) !== cancel ||
              currentPatternKey !== patternKeyAtInstantiation ||
              cancelNodes !== undefined
            ) {
              return;
            }
            try {
              instantiatePattern(pattern, undefined, false);
            } catch (retryError) {
              this.#reportPieceStartCommitFailure(
                instantiateActionId,
                retryError,
              );
              teardownRegistrationIfCurrent();
            }
          };
          const commitWork = actualTx.commit().then(async ({ error }) => {
            if (error !== undefined) {
              if (
                this.#runtime.experimental.serverExecution === true &&
                isStaleReadConflict(error)
              ) {
                await recoverInstantiationOnce(error);
                return;
              }
              this.#reportPieceStartCommitFailure(instantiateActionId, error);
              if (exactNodesAreCurrent()) teardownRegistrationIfCurrent();
              return;
            }
            const settlement = waveSettlementOf(actualTx);
            if (settlement === undefined) return;
            const settled = await settlement;
            if (settled.error === undefined) return;

            const waveWithdrawalCause = (settled.error as {
              waveWithdrawalCause?: unknown;
            }).waveWithdrawalCause;
            if (waveWithdrawalCause === "wave-abandoned") {
              // Explicit abandon is clean enclosing-lifecycle teardown, not a
              // structure-load failure. Keep it visible without incrementing
              // the serving runtime's failure observer/health counter.
              logger.warn("piece-start-commit-abandoned", () => [
                `piece-start commit ${instantiateActionId} was withdrawn by ` +
                "wave abandon; the enclosing lifecycle owns any restart",
                settled.error,
              ]);
              if (exactNodesAreCurrent()) teardownRegistrationIfCurrent();
              return;
            }
            // A WHOLE contribution drop is recoverable in the same sense the
            // stale-read refusal is, and the helper reports only if its one
            // retry also loses. A partial drop is not: part of the
            // contribution stands, so there is no rolled-back view to
            // re-instantiate against, and it takes the same terminal arm a
            // second failure takes.
            await recoverInstantiationOnce(
              settled.error,
              waveWithdrawalCause === "contribution-dropped",
            );
          }).catch((error) => {
            this.#reportPieceStartCommitFailure(instantiateActionId, error);
            if (exactNodesAreCurrent()) teardownRegistrationIfCurrent();
          });
          this.#pendingPieceInstantiationSettlements.add(commitWork);
          commitWork.finally(() =>
            this.#pendingPieceInstantiationSettlements.delete(commitWork)
          );
        }
      }
    };

    // Helper to set up the pattern watcher. Sinks on the `patternIdentity` meta
    // (the only pattern pointer); a keyless pattern writes none, so its watcher
    // is inert by design (keyless patterns change only via a fresh run()).
    const setupPatternWatcher = () => {
      // A hot-swap targets a DIFFERENT program over this piece's existing doc:
      // the incoming pattern's internal cells and its argument-schema
      // defaults have never been materialized here. A fresh start() does
      // that in its setup phase, so run the same setup state first, and only
      // tear down the old nodes once it commits — a failed setup leaves the
      // running pattern in place instead of a dead piece.
      const swapToPattern = (
        loaded: Pattern | NodeFactory<unknown, unknown>,
        newRef: { identity: string; symbol: string },
      ) => {
        const pattern = this.#resolveToPattern(loaded as Pattern);
        // Whoever moved the pointer may have staged the incoming pattern in
        // the same transaction, which is how a transition makes staging and
        // the pointer succeed or fail together. Its completion marker says
        // so, and staging what is already staged would restage the argument a
        // second time for no gain: re-instantiate and stop.
        const setupMarker = getPatternSetupIdentityRef(resultCell);
        if (
          setupMarker?.identity === newRef.identity &&
          setupMarker.symbol === newRef.symbol
        ) {
          cancelNodes?.();
          instantiatePattern(pattern);
          runningRef = newRef;
          return;
        }
        const setupTx = this.#runtime.edit();
        // Under an installed seal destination (serving-loop.md §3d) every
        // commit path declares its run context; the swap's setup write is
        // runtime-internal bookkeeping. A no-op everywhere else. The action
        // identity is per PIECE (the swapped result cell's stable address), not
        // per {identity, symbol}: two pieces swapping to one pattern must not
        // share a basis action (their rows would overwrite each other under
        // §3b's per-(action, instance) replacement), while consecutive swaps of
        // ONE piece overwrite, which keeps the rows bounded.
        const pieceLink = resultCell.getAsNormalizedFullLink();
        this.#runtime.stampServerRun(setupTx, {
          actionId: `pattern-swap/${pieceLink.space}/${
            pieceLink.scope ?? "space"
          }/${pieceLink.id}`,
          kind: "bookkeeping",
        });
        const finishSwap = () => {
          cancelNodes?.();
          instantiatePattern(pattern);
          runningRef = newRef;
          runningPattern = pattern;
        };
        if (!this.#runtime.sealDestinationInstalled) {
          // The OFF arm (and ON-arm client speculation): setup commits to
          // the store and the swap proceeds synchronously.
          try {
            this.#applySetupState(
              setupTx,
              pattern,
              newRef,
              {
                sameStoredSetup: false,
                restageStoredArgument: true,
                storedSetupMatches: false,
              },
              undefined,
              resultCell,
            );
            this.#runtime.prepareTxForCommit(setupTx);
            setupTx.commit();
          } catch (error) {
            logger.error(
              "pattern-swap-setup-error",
              `Setup for swapped-in pattern ${newRef.identity}#${newRef.symbol} failed`,
              error,
            );
            return;
          }
          finishSwap();
          return;
        }
        // ON-arm serving: the setup seals into the wave, and the wave
        // can still WITHDRAW it at the commit step (a conflict drop, a
        // lease-lost abort) AFTER commit() resolved — so the running
        // graph is replaced only once the setup is DURABLY accepted
        // (waveSettlementOf). On withdrawal the OLD graph stays: v2
        // running against withdrawn setup would read internal cells that
        // setup never materialized, while old-graph-plus-new-pointer is a
        // coherent not-yet-swapped state a later pointer write (or
        // reactivation) repairs.
        void (async () => {
          try {
            this.#applySetupState(
              setupTx,
              pattern,
              newRef,
              {
                sameStoredSetup: false,
                restageStoredArgument: true,
                storedSetupMatches: false,
              },
              undefined,
              resultCell,
            );
            this.#runtime.prepareTxForCommit(setupTx);
            const committed = await setupTx.commit();
            if (committed.error !== undefined) {
              logger.error(
                "pattern-swap-setup-error",
                `Setup for swapped-in pattern ${newRef.identity}#${newRef.symbol} was refused at the seal`,
                committed.error,
              );
              return;
            }
          } catch (error) {
            logger.error(
              "pattern-swap-setup-error",
              `Setup for swapped-in pattern ${newRef.identity}#${newRef.symbol} failed`,
              error,
            );
            return;
          }
          const settlement = waveSettlementOf(setupTx);
          if (settlement !== undefined) {
            const settled = await settlement;
            if (settled.error !== undefined) {
              logger.warn(
                "pattern-swap-setup-withdrawn",
                () => [
                  `Setup for swapped-in pattern ${newRef.identity}#${newRef.symbol} was withdrawn by the wave; the running pattern is preserved`,
                  settled.error,
                ],
              );
              return;
            }
          }
          // Liveness + supersession: the piece may have stopped, the
          // runtime cycled, or a NEWER pointer write swapped past this
          // one while the settlement was pending.
          if (!active || startLifecycleEpoch !== this.#lifecycleEpoch) return;
          if (currentPatternKey !== patternIdentityKey(newRef)) return;
          finishSwap();
        })();
      };
      // The session-swap half of the watcher (see `#sessionPatternSwaps`):
      // exactly the sinkMeta arm's semantics, driven directly with a live
      // pattern value instead of through a durable pointer a keyless piece
      // is forbidden to write.
      const sessionSwapHandler = (
        pattern: Pattern,
        newRef: { identity: string; symbol: string },
      ) => {
        if (!active || startLifecycleEpoch !== this.#lifecycleEpoch) return;
        const newKey = patternIdentityKey(newRef);
        if (newKey === currentPatternKey) return; // No change
        currentPatternKey = newKey;
        swapToPattern(pattern, newRef);
      };
      this.#sessionPatternSwaps.set(pieceKey, sessionSwapHandler);
      addCancel(() => {
        if (this.#sessionPatternSwaps.get(pieceKey) === sessionSwapHandler) {
          this.#sessionPatternSwaps.delete(pieceKey);
        }
      });
      // Follow a pointer the watcher saw move to `newRef`: swap to the
      // pattern the runtime holds, or load it first.
      const followPointer = (
        newRef: { identity: string; symbol: string },
        newKey: string,
      ): void => {
        // In-memory fast path: the module is usually live this session.
        const live = this.#runtime.patternManager.artifactFromIdentitySync(
          newRef.identity,
          newRef.symbol,
        ) as Pattern | undefined;
        if (live) {
          // A pointer moved here, by this runtime or by a transition it
          // took part in, has what the incoming pattern reads in place
          // and swaps at once, in the state the pointer moved in. One
          // moved elsewhere may point at a pattern whose argument and
          // owned cells another replica wrote: the store delivers none of
          // them with the pointer, so they are named before the swap
          // reads them.
          const argumentLink = getMetaLink(resultCell, "argument");
          if (
            argumentLink === undefined ||
            !this.#swapReadsAbsent(
              this.#resolveToPattern(live),
              argumentLink,
              resultCell,
            )
          ) {
            swapToPattern(live, newRef);
            return;
          }
          const named = this.#syncCellsForRunningPattern(resultCell, live)
            .then(() => {
              // A pointer that moved again while the sync was in flight
              // has its own swap on the way; this one is stale.
              if (
                !active || startLifecycleEpoch !== this.#lifecycleEpoch ||
                currentPatternKey !== newKey
              ) {
                return;
              }
              swapToPattern(live, newRef);
            })
            .catch((err) => {
              logger.error(
                "pattern-swap-name-error",
                `Naming swapped-in pattern ${newRef.identity}#${newRef.symbol} failed`,
                err,
              );
            });
          this.#pendingWatcherPatternLoads.add(named);
          named.finally(() => this.#pendingWatcherPatternLoads.delete(named));
          return;
        }
        // Async load for a pattern change after initial start. Errors are
        // logged here since there's no caller to propagate to. The whole
        // chain (load attempt + any pointer roll-forward it decides on) is
        // tracked so dispose() — and deterministic tests — can settle it
        // without wall-clock waits (the runner suite runs under a frozen
        // clock).
        const watcherLoad = this.#runtime.patternManager
          .loadPatternByIdentity(
            newRef.identity,
            newRef.symbol,
            resultCell.space,
          )
          .then((loaded) => {
            if (
              !active ||
              startLifecycleEpoch !== this.#lifecycleEpoch ||
              currentPatternKey !== newKey
            ) return;
            if (!loaded) {
              if (
                PatternManager.isKeylessPatternIdentity(newRef.identity)
              ) {
                // A `keyless:` pointer READ from durable state is a legacy
                // orphan (nothing mints one into a store): unloadable by
                // construction for every session but its minter, and expected
                // in aged spaces. Tolerated as the orphan it is — a debug
                // record, not an error — and healed below when a producer
                // identity is available to converge to.
                logger.debug("legacy-keyless-pattern-pointer", () => [
                  `durable patternIdentity carries a session-synthetic`,
                  `identity ${newRef.identity}#${newRef.symbol} (pre-guard`,
                  "legacy state); no session can load it",
                ]);
              } else {
                logger.error(
                  "pattern-load-error",
                  `Failed to load pattern ${newRef.identity}#${newRef.symbol}`,
                );
              }
              // An undefined result is a DEFINITIVE verdict — the load synced
              // and found the identity's docs absent or uncompilable — while a
              // pattern is still running here. Left alone, the durable pointer
              // keeps naming an identity no session can load: every boot
              // re-logs this error and any start-by-identity of this piece is
              // dead (the stranded blank-section state). Roll the pointer back
              // to the RUNNING pattern's identity, durably, with a
              // superseded-check so a legitimate concurrent repoint wins.
              // Thrown load errors (which may be transient) never trigger this.
              // One verdict is NOT definitive and must never trigger it: with
              // CFC enforcement disabled, loadPatternByIdentity returns
              // undefined for anything outside the in-memory index (probe
              // unsupported, not artifact dead).
              //
              // The ref written back must be durable-legal: a session-synthetic
              // keyless ref never is (a fresh runtime is guaranteed unable to
              // load it). When the RUNNING ref is keyless or absent, converge
              // to the running VALUE's module-addressed PRODUCER instead — the
              // first real entry ref up its derivation chain (walking as many
              // steps as recorded). A from-scratch runtime-built value has no
              // such link; the piece then keeps running on its session value
              // and the pointer is left alone (the tolerated orphan), because
              // there is nothing durable-legal to write.
              const revertTarget = runningRef !== undefined &&
                  !PatternManager.isKeylessPatternIdentity(
                    runningRef.identity,
                  )
                ? runningRef
                : runningPattern !== undefined
                ? resolveProducerEntryRef(runningPattern)
                : undefined;
              if (
                this.#runtime.cfcEnforcementMode !== "disabled" &&
                revertTarget === undefined &&
                runningPattern !== undefined
              ) {
                logger.debug("keyless-running-no-producer", () => [
                  "unloadable durable pointer over a running keyless",
                  "pattern with no module-addressed producer link;",
                  "nothing durable-legal to converge to — leaving the",
                  "pointer as written",
                ]);
              }
              if (
                this.#runtime.cfcEnforcementMode !== "disabled" &&
                revertTarget !== undefined &&
                patternIdentityKey(revertTarget) !== newKey
              ) {
                const revertRef = revertTarget;
                const rollForward = this.#runtime.editWithRetry((tx) => {
                  // Async pointer repair from the meta watcher's load
                  // promise — no scheduler run stamps it; bookkeeping
                  // per serving-loop.md §3d.
                  this.#runtime.stampServerRun(tx, {
                    actionId:
                      `pattern-pointer-rollforward/${resultCell.sourceURI}`,
                    kind: "bookkeeping",
                  });
                  const cur = asPatternIdentityRef(
                    resultCell.withTx(tx).getMetaRaw("patternIdentity", {
                      meta: ignoreReadForScheduling,
                    }),
                  );
                  if (!cur || patternIdentityKey(cur) !== newKey) {
                    return false;
                  }
                  resultCell.withTx(tx).setMetaRaw("patternIdentity", {
                    identity: revertRef.identity,
                    symbol: revertRef.symbol,
                  }, rawMetaWriteAuthorization);
                  return true;
                }).then((result) => {
                  // Only reclaim the observed key while it is STILL the
                  // failed one — a valid repoint that raced this rollback
                  // has already advanced the watcher state, and clobbering
                  // it would make the key guard discard that repoint's
                  // in-flight load.
                  if (result.ok && currentPatternKey === newKey) {
                    currentPatternKey = patternIdentityKey(revertRef);
                    logger.warn(
                      "unloadable-pointer-rolled-forward",
                      () => [
                        "durable patternIdentity named an unloadable",
                        `identity (${newRef.identity}#${newRef.symbol});`,
                        revertRef === runningRef
                          ? "rolled back to the running pattern"
                          : "converged to the running pattern's producer",
                        `${revertRef.identity}#${revertRef.symbol}`,
                      ],
                    );
                  }
                }).catch((error) => {
                  logger.warn(
                    "unloadable-pointer-roll-forward-failed",
                    () => [
                      "could not roll the unloadable pointer back to the",
                      "running pattern",
                      error,
                    ],
                  );
                });
                // Track so dispose() can settle it before storage teardown.
                this.#pendingPointerCommits.add(rollForward);
                rollForward.finally(() =>
                  this.#pendingPointerCommits.delete(rollForward)
                );
              }
              return;
            }
            logger.info("pattern changed", {
              to: { ref: newRef, pattern: loaded },
            });
            // Loaded from the store, so what it reads may be absent here
            // too; named before the swap as on the live path.
            return this.#syncCellsForRunningPattern(resultCell, loaded).then(
              () => {
                if (
                  !active || startLifecycleEpoch !== this.#lifecycleEpoch ||
                  currentPatternKey !== newKey
                ) {
                  return;
                }
                swapToPattern(loaded, newRef);
              },
            );
          })
          .catch((err) => {
            if (!active || startLifecycleEpoch !== this.#lifecycleEpoch) {
              return;
            }
            logger.error(
              "pattern-load-error",
              `Failed to load pattern ${newRef.identity}#${newRef.symbol}`,
              err,
            );
          });
        this.#pendingWatcherPatternLoads.add(watcherLoad);
        watcherLoad.finally(() =>
          this.#pendingWatcherPatternLoads.delete(watcherLoad)
        );
      };
      addCancel(
        resultCell.sinkMeta("patternIdentity", (newValue) => {
          if (!active || startLifecycleEpoch !== this.#lifecycleEpoch) return;
          const newRef = asPatternIdentityRef(newValue);
          if (!newRef) return;
          const newKey = patternIdentityKey(newRef);
          if (newKey === currentPatternKey) return; // No change
          currentPatternKey = newKey;

          // A source update that moves the pointer grants the new pattern the
          // writer authority of the one before it, and registers the grant
          // only in the runtime that performed it. Without it, the new
          // pattern's writes to fields bound to the old one are refused, so
          // a runtime that does not hold it reads it before swapping.
          const owed = this.#readInheritedAuthority(resultCell, newRef);
          if (owed === undefined) {
            followPointer(newRef, newKey);
            return;
          }
          const followed = owed.then(() => {
            if (
              !active || startLifecycleEpoch !== this.#lifecycleEpoch ||
              currentPatternKey !== newKey
            ) {
              return;
            }
            followPointer(newRef, newKey);
          });
          this.#pendingWatcherPatternLoads.add(followed);
          followed.finally(() =>
            this.#pendingWatcherPatternLoads.delete(followed)
          );
        }),
      );
    };

    // Initial instantiation with a cold-start setup repair for pieces mounted
    // WITHOUT a setup phase. A nested/embedded piece — a profile mounted via a
    // `#wish`, say — is instantiated by the runtime's start walk, and no
    // pattern watcher is armed yet to self-heal (setupPatternWatcher runs only
    // AFTER a successful instantiate). Such a piece's stored doc can have been
    // set up by one version of its pattern and then pointed at another with no
    // setup for it: the internal cells the new version's setup would have
    // materialized — a handler's stream among them — have no manifest entry
    // and no result projection reaching them, and nothing about the stored
    // doc changes on its own. A fresh run() would materialize them; this is
    // the same repair the home ROOT gets in startEnsuredDefaultPattern,
    // reachable here for the nested pieces that never pass through it.
    //
    // The trigger is that stored state and nothing else: a setup-completion
    // marker that does not name this version, and a manifest missing one of
    // this pattern's derived internal cells. A marker naming another version
    // and no marker at all both qualify: a doc set up before the marker
    // existed carries none, and drifts the same way. Only a marker naming
    // this version says its setup ran. A keyless piece keeps that marker
    // session-side (`#sessionPatternPointers`, the never-durable contract),
    // so it reads as matching and is not repaired here; the precondition
    // below re-reads a durable identity it never had. The repair moves no
    // durable identity pointer; it replays the pattern the pointer already
    // names
    // (samePattern=true: materializes the missing internal cells but leaves
    // the existing argument — the piece's data — untouched; no roll-forward,
    // no user-data rewrite). It stages into the instantiation's own
    // transaction (`setupRepair`), so the setup and the graph that reads it
    // commit together, and a refused commit takes the instantiation's one
    // retry, which stages the repair again. Fail-closed: a repair that cannot
    // proceed throws and leaves the piece exactly as it was. Only the plain
    // start path is repaired — a caller-supplied `useTx` is a setup/run
    // transaction that is already materializing state, so it is skipped
    // rather than reasoned about.
    const instantiateInitialPattern = (
      pattern: Pattern,
      ref: { identity: string; symbol: string } | undefined,
      useTx?: IExtendedStorageTransaction,
    ) => {
      if (
        useTx === undefined &&
        ref !== undefined &&
        storedSetupMarker(
            resultCell,
            ref,
            this.#sessionPatternPointer(resultCell),
          ) !== "matches" &&
        !this.#storedManifestCovers(resultCell, pattern) &&
        // The root/default pattern is the PieceController's to repair (it has
        // the richer roll-forward + clear-error path); defer to it there.
        !this.#isSpaceDefaultPattern(resultCell)
      ) {
        setupRepair = {
          pattern,
          stage: (repairTx) => {
            // A retry re-stages what a refused commit rolled back; once a
            // commit has landed the manifest covers the pattern and there is
            // nothing left to stage.
            if (
              this.#storedManifestCovers(resultCell.withTx(repairTx), pattern)
            ) {
              return;
            }
            // Precondition: the pinned identity must still equal `ref`. A
            // concurrent updater or boot may have moved it; re-running the
            // stale pinned pattern's setup would roll that newer identity
            // back. The read is through the instantiation's transaction, so
            // it also participates in commit conflict detection (mirrors the
            // controller repair's expectedPatternIdentity).
            const currentRef = getPatternIdentityRef(
              resultCell.withTx(repairTx),
            );
            if (
              currentRef === undefined ||
              currentRef.identity !== ref.identity ||
              currentRef.symbol !== ref.symbol
            ) {
              throw new Error(
                `Piece \`${resultCell.sourceURI}\` moved to another pattern ` +
                  "while its setup was being repaired",
              );
            }
            this.#applySetupState(
              repairTx,
              pattern,
              ref,
              // No re-stage, even though this doc's setup state was staged by
              // another version: the precondition just re-read the pinned
              // identity, so this is the SAME pattern repairing its own
              // internal cells, not an update. Re-pointing the argument here
              // would rewrite user data on a narrow instantiation repair.
              {
                sameStoredSetup: true,
                restageStoredArgument: false,
                // Inert here — `#applySetupState` reads only the two fields
                // above — but stated rather than defaulted, because this
                // repair deliberately leaves the piece's ARGUMENT alone even
                // though its precondition proves the pattern is the same one.
                storedSetupMatches: false,
                // The argument was staged by another version and is not
                // re-validated here, so the marker keeps saying so: the next
                // setup for this identity still re-stages and validates it.
                // The repair does not come back for that, because the
                // manifest it writes now covers the pattern.
                leaveCompletionMarker: true,
              },
              undefined,
              resultCell,
            );
          },
        };
      }
      instantiatePattern(pattern, useTx);
    };

    const resultCellForRead = tx ? resultCell.withTx(tx) : resultCell;
    // Durable pointer first; a keyless piece set up by this session has only
    // the session-side entry (the never-durable contract).
    const initialRef = getPatternIdentityRef(resultCellForRead) ??
      this.#sessionPatternPointer(resultCellForRead);

    // Determine initial pattern
    if (givenPattern) {
      currentPatternKey = initialRef ? patternIdentityKey(initialRef) : KEYLESS;
      try {
        instantiateInitialPattern(givenPattern, initialRef, tx);
        // Real artifact refs only: setup mints and INDEXES a `keyless:`
        // session pointer for hand-built patterns, so getArtifactEntryRef
        // returns it — filter synthetics explicitly, or the roll-forward
        // would write a pointer no fresh runtime can load. The VALUE is kept
        // regardless: the roll-forward's keyless arm converges through its
        // derivation chain to a module-addressed producer when one exists.
        const givenRef = this.#runtime.patternManager.getArtifactEntryRef(
          givenPattern,
        );
        runningRef = givenRef !== undefined &&
            !PatternManager.isKeylessPatternIdentity(givenRef.identity)
          ? givenRef
          : undefined;
        runningPattern = givenPattern;
      } catch (error) {
        // Without cleanup the piece stays registered in `this.#cancels`, so
        // every later start() reports "already running" for a piece that has
        // no nodes or event handlers — events sent to it are then dropped.
        //
        // Cleanup runs every registered cancel, any of which may itself throw.
        // Letting that escape would REPLACE the error being handled, so what
        // surfaced would describe the cleanup rather than the failure that
        // caused it — and a cancel running against half-initialized state
        // fails in ways that look nothing like the original. Report it and
        // rethrow what actually went wrong.
        try {
          cleanup();
        } catch (cleanupError) {
          logger.warn(
            "start",
            "Cleanup failed while handling a start error; reporting the " +
              "start error, which is the one that matters.",
            cleanupError,
          );
        }
        throw error;
      }
      if (!doNotUpdateOnPatternChange) {
        setupPatternWatcher();
      }
      return cancel;
    }

    if (!initialRef) {
      cleanup();
      throw new Error("Cannot start: no pattern identity");
    }

    // Sync lookup by identity (the module is live this session).
    const initialResolved = this.#runtime.patternManager
      .artifactFromIdentitySync(
        initialRef.identity,
        initialRef.symbol,
      ) as Pattern | undefined;
    if (!initialResolved) {
      cleanup();
      throw new Error(
        `Unknown pattern: ${initialRef.identity}#${initialRef.symbol}`,
      );
    }

    // Sync path - instantiate immediately
    currentPatternKey = patternIdentityKey(initialRef);
    const initialPattern = this.#resolveToPattern(initialResolved);
    instantiateInitialPattern(initialPattern, initialRef, tx);
    runningRef = initialRef;
    runningPattern = initialPattern;
    if (!doNotUpdateOnPatternChange) {
      setupPatternWatcher();
    }

    return cancel;
  }

  /** Installs resident JavaScript graph bindings without setup or output writes. */
  async startViewPiece(
    resultCell: Cell<unknown>,
    expectedIdentity: string,
    current: () => boolean,
  ): Promise<ViewPieceRegistration | undefined> {
    if (!current()) return undefined;
    const key = this.#getDocKey(resultCell);
    if (this.#cancels.has(key)) return undefined;
    const read = this.#runtime.readTx();
    restrictToLocalReads(read.tx);
    let ref: ReturnType<typeof getPatternIdentityRef>;
    try {
      ref = getPatternIdentityRef(resultCell.withTx(read));
    } catch (error) {
      if (validateLocalReadBasis(read) === undefined) throw error;
      return undefined;
    } finally {
      read.clearReadOnly?.();
      read.abort("stored graph identity read complete");
    }
    if (ref === undefined || patternIdentityKey(ref) !== expectedIdentity) {
      return undefined;
    }
    const manager = this.#runtime.patternManager;
    const loaded = manager.artifactFromIdentitySync(ref.identity, ref.symbol) ??
      await manager.loadPatternByIdentity(
        ref.identity,
        ref.symbol,
        resultCell.space,
      );
    if (!current() || loaded === undefined || this.#cancels.has(key)) {
      return undefined;
    }
    const pattern = this.#resolveToPattern(loaded as Pattern);
    const pending = new Set(pattern.nodes.keys());
    const [cancelNodes, addCancel] = useCancelGroup();
    let active = true;
    const cancel = (() => {
      if (!active) return;
      active = false;
      cancelNodes();
      pending.clear();
      if (this.#cancels.get(key) === cancel) this.#cancels.delete(key);
      this.#allCancels.delete(cancel);
    }) as ViewPieceRegistration;
    cancel.graphIsInstalled = () => active && pending.size === 0;
    this.#cancels.set(key, cancel);
    this.#allCancels.add(cancel);
    const resume = () => {
      if (!active) return false;
      if (pending.size === 0) return true;
      const identityRead = this.#runtime.readTx();
      restrictToLocalReads(identityRead.tx);
      try {
        const stored = getPatternIdentityRef(resultCell.withTx(identityRead));
        if (
          stored === undefined ||
          patternIdentityKey(stored) !== expectedIdentity
        ) {
          cancel();
          return false;
        }
      } catch (error) {
        if (validateLocalReadBasis(identityRead) === undefined) {
          throw error;
        }
        return true;
      } finally {
        identityRead.clearReadOnly?.();
        identityRead.abort("stored graph resume identity read complete");
      }
      for (const index of pending) {
        const node = pattern.nodes[index];
        let module = node.module;
        if (isModule(module) && module.type === "ref") {
          module = this.#runtime.moduleRegistry.getModule(
            module.implementation as string,
            module.defaultScope,
          );
        }
        // Raw outputs and child graph roots are supplied by the server view plan.
        if (!isModule(module) || module.type !== "javascript") {
          pending.delete(index);
          continue;
        }
        const tx = this.#runtime.readTx();
        restrictToLocalReads(tx.tx);
        const [cancelAttempt, addAttemptCancel] = useCancelGroup();
        try {
          this.#instantiateNode(
            tx,
            { ...node, module },
            resultCell.withTx(tx),
            addAttemptCancel,
            pattern,
            {
              ...this.#schedulerRehydrationOptions(resultCell),
              viewNodeId: viewNodeId(
                resultCell.getAsNormalizedFullLink(),
                index,
              ),
              viewLocalOnly: true,
              adoptViewIdentity: expectedIdentity,
            },
          );
          const unavailable = validateLocalReadBasis(tx);
          if (unavailable !== undefined) throw unavailable;
          addCancel(cancelAttempt);
          pending.delete(index);
        } catch (error) {
          cancelAttempt();
          if (validateLocalReadBasis(tx) === undefined) {
            throw error;
          }
        } finally {
          tx.clearReadOnly?.();
          tx.abort("stored graph binding read complete");
        }
      }
      return true;
    };
    cancel.resume = () => {
      try {
        return resume();
      } catch (error) {
        cancel();
        throw error;
      }
    };
    if (!cancel.resume()) return undefined;
    if (!current()) {
      cancel();
      return undefined;
    }
    return cancel;
  }

  /**
   * Internal start implementation with cascade of checks.
   * Each check: if it fails and needs async work, return a promise that
   * resolves the missing piece and retries.
   */
  #doStart<T = any>(
    resultCell: Cell<T>,
    seenCells: Set<Cell>,
    attempt: StartAttempt,
  ): Promise<boolean> {
    if (
      this.#runtime.viewScopedReplicationRequested &&
      this.#runtime.viewReplication.active(resultCell.space)
    ) {
      attempt.targetKey = this.#getDocKey(resultCell);
      return Promise.resolve(this.#cancels.has(attempt.targetKey));
    }
    if (!this.#isStartAttemptCurrent(attempt)) {
      return Promise.resolve(false);
    }
    // `synced === true` means this cell was rehydrated from storage rather than
    // assembled purely from writes in the current runtime, so start() may need
    // to await dependency sync before process startup.
    const wasSyncedAtEntry =
      (resultCell as Cell<any> & { synced?: boolean }).synced === true;

    // Step 1: For subpath cells, resolve to root cell
    const link = resultCell.getAsNormalizedFullLink();
    const rootCell = link.path.length > 0
      ? this.#runtime.getCellFromLink({ ...link, path: [] })
      : resultCell;

    const key = this.#getDocKey(rootCell);
    attempt.targetKey = key;
    // Step 2: Already started? Return success
    if (this.#cancels.has(key)) return Promise.resolve(true);

    // Step 3: Not synced yet? Sync and retry
    // Once getRaw() has a value, all properties including source are synced.
    if (rootCell.getRaw() === undefined) {
      const rootSyncStart = performance.now();
      return rootCell.sync().then(() => {
        if (!this.#isStartAttemptCurrent(attempt)) return false;
        logger.time(rootSyncStart, "start", "rootCellSync");
        if (rootCell.getRaw() === undefined) {
          return Promise.reject(new Error("No data at cell"));
        } else {
          return this.#doStart(rootCell, seenCells, attempt);
        }
      });
    }

    // Step 4: Check whether the pattern is available, otherwise load it. A
    // keyless piece carries no durable pointer (never-durable contract); its
    // pointer, when this session set it up, is the session-side entry.
    const setupKey = this.#getSetupKey(rootCell);
    const identityRef = getPatternIdentityRef(rootCell) ??
      this.#sessionPatternPointer(rootCell);
    if (!identityRef) {
      // We may have a slug instead of a resultCell, so try the link.
      const maybeLink = parseLink(rootCell.getRaw(), rootCell);
      if (maybeLink) {
        const nextCell = this.#runtime.getCellFromLink(maybeLink);
        if (seenCells.has(nextCell)) {
          return Promise.reject(new Error("Circular link detected"));
        }
        seenCells.add(nextCell);
        // A slug/link only locates the piece; once resolved, stopping the
        // target doc must invalidate any asynchronous work that follows.
        // Track that doc and capture its current generation before entering
        // the target's start cascade.
        const nextStartKey = this.#getDocKey(nextCell);
        this.#trackStartAttempt(attempt, nextStartKey);
        return this.#doStart(nextCell, seenCells, attempt);
      }

      return Promise.reject(
        new Error(`Cannot start: no pattern identity`),
      );
    }
    const currentPatternKey = patternIdentityKey(identityRef);
    const preparedPatternKey = this.#locallyPreparedResults.get(setupKey);
    const stoppedPatternKey = this.#locallyStoppedResults.get(setupKey);
    const wasPreparedLocally = preparedPatternKey === currentPatternKey;
    const wasStoppedLocally = stoppedPatternKey === currentPatternKey;
    if (preparedPatternKey !== undefined && !wasPreparedLocally) {
      this.#locallyPreparedResults.delete(setupKey);
    }
    if (stoppedPatternKey !== undefined && !wasStoppedLocally) {
      this.#locallyStoppedResults.delete(setupKey);
    }
    const owed = attempt.authorityReadFor?.has(currentPatternKey)
      ? undefined
      : this.#readInheritedAuthority(rootCell, identityRef);
    if (owed !== undefined) {
      (attempt.authorityReadFor ??= new Set()).add(currentPatternKey);
      return owed.then(() => {
        if (!this.#isStartAttemptCurrent(attempt)) return false;
        // The piece may have started, or its pointer moved, while the read
        // was in flight, so the walk runs again from the top.
        return this.#doStart(rootCell, seenCells, attempt);
      });
    }
    return this.#startAvailablePattern(
      rootCell,
      identityRef,
      wasSyncedAtEntry,
      wasPreparedLocally,
      wasStoppedLocally,
      seenCells,
      attempt,
    );
  }

  /**
   * The read that gives this runtime the writer authority a piece's pattern
   * `identityRef` inherited from the patterns the piece ran before it, when
   * the runtime does not already hold all of it (see
   * `PatternManager.readInheritedAuthority()`).
   *
   * A source update, the only grantor, records the pattern it moves a piece
   * to as the latest revision of the piece's source history. So a read is
   * owed only when that revision names `identityRef`, and the predecessors
   * are the other patterns the history names, any of which may still own a
   * field of the piece. A pointer that moved without a revision, or a
   * history naming no other pattern, owes none.
   */
  #readInheritedAuthority(
    rootCell: Cell<unknown>,
    identityRef: { identity: string; symbol: string },
  ): Promise<void> | undefined {
    let revisions: PieceSourceRevision[];
    try {
      revisions = getPieceSourceRevisions(rootCell);
    } catch {
      // An invalid history names no predecessor. Setup, which requires a
      // valid one, reports it.
      return undefined;
    }
    if (revisions.at(-1)?.pattern.identity !== identityRef.identity) {
      return undefined;
    }
    return this.#runtime.patternManager.readInheritedAuthority(
      rootCell.space,
      identityRef.identity,
      revisions.map((revision) => revision.pattern.identity),
    );
  }

  #startAvailablePattern<T = any>(
    rootCell: Cell<T>,
    identityRef: { identity: string; symbol: string },
    wasSyncedAtEntry: boolean,
    wasPreparedLocally: boolean,
    wasStoppedLocally: boolean,
    seenCells: Set<Cell>,
    attempt: StartAttempt,
  ): Promise<boolean> {
    if (!this.#isStartAttemptCurrent(attempt)) {
      return Promise.resolve(false);
    }
    const pm = this.#runtime.patternManager;
    const pattern = pm.artifactFromIdentitySync(
      identityRef.identity,
      identityRef.symbol,
    ) as Pattern | undefined;
    if (
      !pattern &&
      PatternManager.isKeylessPatternIdentity(identityRef.identity)
    ) {
      // A durable `keyless:` pointer is legacy state (nothing mints one into a
      // store), and session-only by construction: with the in-memory index
      // missed there is no closure anywhere to load. Tolerate the orphan —
      // record it and report the piece as not started, rather than failing the
      // caller's whole start walk over state no session can ever serve.
      logger.debug("legacy-keyless-pattern-pointer", () => [
        `piece ${rootCell.getAsNormalizedFullLink().id} carries a`,
        `session-synthetic patternIdentity ${identityRef.identity}#` +
        `${identityRef.symbol} (pre-guard legacy state); not startable`,
      ]);
      return Promise.resolve(false);
    }
    if (!pattern) {
      // Load by content identity: in-memory live module → compiled closure →
      // cold recompile from the verified source-doc closure (a version bump).
      // No patternId, no meta cell — the source docs are the single durable
      // source. A piece carrying only a legacy `pattern` link is unrecoverable
      // (the sanctioned data-wipe outcome).
      const loadStart = performance.now();
      return pm
        .loadPatternByIdentity(
          identityRef.identity,
          identityRef.symbol,
          rootCell.space,
        )
        .then((loaded) => {
          if (!this.#isStartAttemptCurrent(attempt)) return false;
          // Resume-boot decomposition: source-doc fetch + module load/eval for
          // a pattern this runtime has never instantiated.
          logger.time(loadStart, "start", "loadPatternByIdentity");
          if (loaded) {
            return this.#doStart(rootCell, seenCells, attempt);
          } else {
            return Promise.reject(
              new Error(
                `Could not load pattern ${identityRef.identity}#${identityRef.symbol}`,
              ),
            );
          }
        });
    }

    const resolvedPattern = this.#resolveToPattern(pattern);

    // Fast path for pieces prepared in the current runtime via setup()/run() or
    // explicitly restarted after stop(). Those writes are already present
    // locally, so we should preserve the historical synchronous start()
    // behavior. The dependency sync + snapshot resume below is specifically for
    // pieces resumed from storage in a fresh runtime.
    //
    // We gate on the locally-assembled signals (`wasPreparedLocally` /
    // `wasStoppedLocally`) rather than the cell's `synced` flag: a fresh-runtime
    // resume reaches here past Step 3 with `getRaw()` populated, so it is not
    // locally assembled iff neither flag is set. The `synced` flag is not
    // reliably set for a storage-loaded cell, so gating on it would drop the
    // resume path and re-run the piece from scratch (`wasSyncedAtEntry` kept for
    // diagnostics).
    void wasSyncedAtEntry;
    if (wasPreparedLocally || wasStoppedLocally) {
      if (!this.#isStartAttemptCurrent(attempt)) return Promise.resolve(false);
      try {
        attempt.installedRegistration = this.#startCore(rootCell, {
          ...attempt.options,
          givenPattern: resolvedPattern,
        });
      } catch (err) {
        return Promise.reject(err);
      }

      return Promise.resolve(true);
    }

    // Step 5: Sync the cells this running pattern depends on before wiring the
    // scheduler back up in a fresh runtime. Without this, resumed pieces can
    // observe the last persisted result but miss subsequent input updates.
    const expectedPatternKey = patternIdentityKey(identityRef);
    const patternIdentityStillCurrent = (): boolean => {
      // A keyless piece's pointer is session-side (never stamped durably),
      // so the currency re-check must read the same source the walk's step 4
      // resolved from — a durable-only read would report a keyless piece
      // "no longer current" forever and restart the resolution cascade in an
      // unbounded loop.
      const current = getPatternIdentityRef(rootCell) ??
        this.#sessionPatternPointer(rootCell);
      return current !== undefined &&
        patternIdentityKey(current) === expectedPatternKey;
    };
    return (async () => {
      await this.#syncCellsForRunningPattern(rootCell, resolvedPattern);
      if (!this.#isStartAttemptCurrent(attempt)) return false;
      // The result doc can hot-swap while the dependency pre-sync is awaiting
      // I/O. Never carry the old resolved Pattern into the new identity; restart
      // the resolution cascade against the current metadata instead.
      if (!patternIdentityStillCurrent()) {
        return await this.#doStart(rootCell, seenCells, attempt);
      }

      // Another path may have installed this piece's registration while the
      // pre-sync was awaiting I/O. start() joins same-doc calls before they
      // get here, so the remaining writers of this race are an identity-change
      // restart within this same attempt and an attempt that entered through a
      // different doc whose links resolve to this piece.
      if (this.#cancels.has(this.#getDocKey(rootCell))) {
        return true;
      }

      const startCoreStart = performance.now();
      try {
        attempt.installedRegistration = this.#startCore(rootCell, {
          ...attempt.options,
          givenPattern: resolvedPattern,
          schedulerRehydration: this.#schedulerRehydrationOptions(
            rootCell,
            // Resumed from a synced state (it just awaited
            // `#syncCellsForRunningPattern()`): hold each action's initial run
            // until the space finishes syncing so we don't race the data
            // (e.g. maps reconciling an empty array, then re-running once it
            // streams in).
            true,
            attempt.options?.parentPieceRootId,
          ),
        });
      } finally {
        // Synchronous instantiation cost of the resumed piece (pattern
        // setup, node wiring), distinct from the syncs around it.
        logger.time(startCoreStart, "start", "startCoreResume");
      }

      return true;
    })();
  }

  /**
   * Starts the pattern behind `resultCell` inside `tx`, returning the
   * registration's cancel, or nothing when there was nothing to start.
   */
  #startWithTx<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    givenPattern?: Pattern,
    options: RunnerRunOptions = {},
  ): Cancel | undefined {
    const key = this.#getDocKey(resultCell);
    const scoped = this.#scopedPieces.get(key);
    if (scoped !== undefined && givenPattern !== undefined) {
      scoped.ensure(tx, givenPattern);
      return undefined;
    }
    if (this.#cancels.has(key)) return undefined;

    const registration = this.#startCore(resultCell, {
      tx,
      givenPattern,
      doNotUpdateOnPatternChange: options.doNotUpdateOnPatternChange,
      awaitSyncBeforeInitialRun: options.awaitSyncBeforeInitialRun,
      parentPieceRootId: options.parentPieceRootId,
    });
    // Selection settlement owns scoped setup rollback. The shared group is
    // not an individual launch's compensation token.
    return this.#usesScopedPrograms(resultCell) ? undefined : registration;
  }

  /**
   * Commits `tx`, a commit-gated start's transaction for `resultCell`, and
   * resolves to its verdict. A committer a test supplied wraps the commit.
   */
  #commitDeferredStart(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<any>,
  ): Promise<Result<Unit, CommitError>> {
    const committer = this.#deferredStartCommitter;
    const commit: DeferredStartCommit = () => tx.commit();
    return committer === undefined
      ? commit()
      : committer(tx, resultCell, commit);
  }

  #createDeferredStartOwnership<T>(
    resultCell: Cell<T>,
  ): DeferredCancelOwnership {
    const key = this.#getDocKey(resultCell);
    const base = useDeferredCancelOwnership((installedCancel) => {
      // A result key can be stopped and restarted while deferred startup is
      // re-entering runner code. Only stop if this attempt's exact cancel
      // registration is still current; a later replacement owns itself.
      if (this.#cancels.get(key) !== installedCancel) return;
      this.stop(resultCell);
    });
    // Ownership of a commit-gated start begins when the start is scheduled,
    // not when its callback installs it, so a stop before that commit has to
    // reach the pending start and tombstone it. The entry goes as soon as the
    // start settles either way: it installed a registration, which owns itself
    // from then on, or it was cancelled.
    const ownership: DeferredCancelOwnership = {
      cancel: () => {
        this.#unregisterPendingDeferredStart(key, ownership, "cancelled");
        base.cancel();
      },
      isCancelled: base.isCancelled,
      markInstalled: (registration) => {
        this.#unregisterPendingDeferredStart(key, ownership, "installed");
        return base.markInstalled(registration);
      },
    };
    this.#registerPendingDeferredStart(key, ownership);
    return ownership;
  }

  /**
   * Helper for the deferred-start paths, which enters `ownership` into the
   * pending index under `key` and emits the `runner.deferred-start.pending`
   * marker for it.
   */
  #registerPendingDeferredStart(
    key: `${MemorySpace}/${ScopeKey}/${URI}`,
    ownership: DeferredCancelOwnership,
  ): void {
    let pending = this.#pendingDeferredStarts.get(key);
    if (pending === undefined) {
      pending = new Set();
      this.#pendingDeferredStarts.set(key, pending);
    }
    pending.add(ownership);
    this.#runtime.telemetry.submit({
      type: "runner.deferred-start.pending",
      key,
    });
  }

  /**
   * Helper for the deferred-start paths, which removes `ownership` from the
   * pending index under `key` and emits the `runner.deferred-start.settled`
   * marker for it. Does nothing for an ownership the index does not hold, so
   * the marker pairs with the one `#registerPendingDeferredStart()` emitted.
   */
  #unregisterPendingDeferredStart(
    key: `${MemorySpace}/${ScopeKey}/${URI}`,
    ownership: DeferredCancelOwnership,
    outcome: "installed" | "cancelled",
  ): void {
    const pending = this.#pendingDeferredStarts.get(key);
    if (pending === undefined || !pending.delete(ownership)) return;
    if (pending.size === 0) this.#pendingDeferredStarts.delete(key);
    this.#runtime.telemetry.submit({
      type: "runner.deferred-start.settled",
      key,
      outcome,
    });
  }

  #cancelPendingDeferredStarts(
    key: `${MemorySpace}/${ScopeKey}/${URI}`,
  ): void {
    const pending = this.#pendingDeferredStarts.get(key);
    if (pending === undefined) return;
    // Every entry leaves the index before any of them is cancelled, so the
    // index never holds an attempt whose cancel is under way.
    const owners = [...pending];
    for (const ownership of owners) {
      this.#unregisterPendingDeferredStart(key, ownership, "cancelled");
    }
    for (const ownership of owners) ownership.cancel();
  }

  #startAfterSuccessfulCommit<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    givenPattern?: Pattern,
    options: RunnerRunOptions = {},
    speculativeConsequence?: { eventId: string },
  ): Cancel {
    const resultLink = resultCell.getAsNormalizedFullLink();
    const startLifecycleEpoch = this.#lifecycleEpoch;
    const ownership = this.#createDeferredStartOwnership(resultCell);
    tx.addCommitCallback((_committedTx, result) => {
      if (result.error) {
        // The callback that would install this start is the one running now,
        // so a failed transaction leaves nothing to reach the pending entry
        // later. Settle it here, which also drops it from the index of starts
        // pending under this result's key.
        ownership.cancel();
        return;
      }
      if (ownership.isCancelled()) return;

      const startTx = this.#runtime.edit();
      // Minted inside a commit callback — by definition outside any scheduler
      // run; the deferred start's node wiring is piece machinery, stamped
      // bookkeeping per serving-loop.md §3d. A flag-ON CLIENT's
      // navigate-deferred start carries §3d's speculative-consequence stamp: it
      // is a handler CONSEQUENCE (the receipt + result wrapper of a speculative
      // echo), so it stamps event-handler-kind and the overlay diverts it —
      // committing it authored would race the SERVING side's own deferred start
      // for the create-only receipt, and a client win would suppress the served
      // navigateTo (no intent would ever be computed). §3d's bookkeeping-only
      // rule governs internal writes at the wave seal destination, which this
      // client-side start tx never reaches. The serving side and the OFF arm
      // keep bookkeeping.
      this.#runtime.stampServerRun(startTx, {
        actionId: `piece-start/${resultLink.id}`,
        ...(speculativeConsequence !== undefined
          ? {
            kind: "event-handler" as const,
            eventId: speculativeConsequence.eventId,
          }
          : { kind: "bookkeeping" as const }),
      });
      // A deferred start minted from an EVENT-HANDLER run carries that run's
      // event context across to the start tx, so a navigateTo instantiated
      // under it can address the firing session (builtins.md §4;
      // navigate-context.ts's capture point 1).
      const navigateContext = navigateEventContextFromRunInfo(
        waveRunContextOf(tx) ?? speculationRunContextOf(tx),
      );
      if (navigateContext !== undefined) {
        setNavigateEventContext(startTx, navigateContext);
      }
      const committedResultCell = this.#runtime.getCellFromLink<T>(
        resultLink,
        undefined,
        startTx,
      );
      try {
        const installedRegistration = this.#startWithTx(
          startTx,
          committedResultCell,
          givenPattern,
          options,
        );
        if (ownership.markInstalled(installedRegistration)) {
          startTx.abort("Deferred runner start was cancelled");
          return;
        }
        this.#runtime.prepareTxForCommit(startTx);
        this.#commitDeferredStart(startTx, resultCell).then(({ error }) => {
          if (error) {
            if (
              this.#catchUpAndStartOnStaleRead(
                error,
                resultCell,
                "start",
                startLifecycleEpoch,
                ownership,
                installedRegistration,
              )
            ) {
              return;
            }
            ownership.cancel();
            logger.error(
              "tx-commit-error",
              "Error committing deferred start transaction",
              error,
            );
          }
        }).catch((error) => {
          ownership.cancel();
          logger.error(
            "tx-commit-error",
            "Deferred start transaction commit rejected",
            error,
          );
        });
      } catch (error) {
        startTx.abort(error);
        ownership.cancel();
        logger.error("runner-start", "Deferred start failed", error);
        throw error;
      }
    });
    return ownership.cancel;
  }

  /** Key a named execution family by its complete resolution identity. */
  #getFamilyKey(
    cell: Cell<any>,
    identity = cell.tx?.tx.scopeKeyIdentity,
  ): string {
    const key = this.#getDocKey(cell);
    if (identity === undefined) return key;
    const scope = identity.sessionId !== undefined
      ? "session"
      : identity.principal !== undefined
      ? "user"
      : "space";
    return `${key}/${resolveScopeKey(scope, identity)}`;
  }

  /** Create a fresh read view for a captured execution-family identity. */
  #familyReadTx(
    identity: ScopeKeyIdentity | undefined,
  ): IExtendedStorageTransaction {
    const tx = this.#runtime.readTx();
    if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
    return tx;
  }

  /** Load one family document under the identity captured before awaiting. */
  #syncFamilyCell<T>(
    cell: Cell<T>,
    identity: ScopeKeyIdentity | undefined,
  ): Promise<Cell<T>> {
    return syncCellForIdentity(cell, identity);
  }

  /**
   * The pattern to name `resultCell` with before running it, when it is a
   * piece set up elsewhere whose execution family this replica has yet to
   * receive: its `argument` link names a document, and that document or a
   * document the run reads — one the argument links to, through the redirect
   * chains those links form, or a derived internal cell of the pattern or of
   * a sub-piece it instantiates — is absent here. A piece with no setup
   * evidence is one the run sets up itself, family included, and returns
   * nothing; a stored pattern pointer this session cannot resolve throws,
   * as setup's own resolution does. A piece this runner has named is not
   * held again once the name-sync has landed for the same pattern: whatever
   * the store lacked, it lacks, and the run reports it as it always has.
   */
  #patternToNameBeforeRun(
    patternOrModule: Pattern | Module | undefined,
    argument: unknown,
    tx: IExtendedStorageTransaction,
    resultCell: Cell<any>,
  ): {
    pattern: Pattern;
    entryKey: string;
    identity?: ScopeKeyIdentity;
  } | undefined {
    resultCell = resultCell.withTx(tx);
    const identity = tx.tx.scopeKeyIdentity === undefined
      ? undefined
      : { ...tx.tx.scopeKeyIdentity };
    const key = this.#getFamilyKey(resultCell, identity);
    const setupKey = this.#getSetupKey(resultCell);
    // Setup reads these through the caller's transaction too, so they can
    // be read there: a fresh piece leaves here before anything is minted.
    const argumentLink = getMetaLink(resultCell.withTx(tx), "argument");
    if (argumentLink === undefined) return undefined;
    const resolved = this.#resolveSetupPattern(
      patternOrModule,
      getPatternIdentityRef(resultCell.withTx(tx)) ??
        this.#sessionPatternPointer(resultCell.withTx(tx)),
    );
    if (resolved === undefined) return undefined;
    const entryKey = patternIdentityKey(resolved.entryRef);
    const named = this.#namedFamilies.get(key);
    if (named !== undefined && "pending" in named) {
      return { pattern: resolved.pattern, entryKey, identity };
    }
    if (named?.landed === entryKey) return undefined;
    // A result this runner prepared under this pattern has its family here
    // already, however much of it the store holds; a missing entry costs a
    // probe, never a wrong verdict.
    if (
      !this.#runtime.servingPosture &&
      this.#locallyPreparedResults.get(setupKey) === entryKey
    ) return undefined;
    return this.#familyAbsent(
        resolved.pattern,
        entryKey,
        argument,
        argumentLink,
        resultCell,
        identity,
      )
      ? { pattern: resolved.pattern, entryKey, identity }
      : undefined;
  }

  /**
   * Whether the document `link` names is on this replica, probed through
   * `readTx`. A document is here when it holds a value. A stream's document
   * never holds one, so for a link that declares a stream the record is
   * probed instead: setup writes the `result` back-link onto it. Any other
   * document that has its metadata and no value — a computed cell nothing
   * has computed yet — reads absent.
   */
  #documentPresent(
    readTx: IExtendedStorageTransaction,
    link: NormalizedFullLink,
  ): boolean {
    return readTx.readOrThrow(
      {
        space: link.space,
        id: link.id,
        path: ContextualFlowControl.declaresStream(link.schema)
          ? []
          : ["value"],
        ...(link.scope !== undefined && { scope: link.scope }),
      },
      { meta: ignoreReadForScheduling },
    ) !== undefined;
  }

  /**
   * Whether a swap of `resultCell` to `pattern` would read a document this
   * replica lacks: the argument document `argumentLink` names, which the
   * swap's setup reads whole, or an owned cell the stored manifest lists —
   * one a setup somewhere has materialized — that is absent here. A cell the
   * manifest does not list is one the swap's setup seeds itself, and a link
   * target the argument holds is read reactively once the piece runs, so
   * neither holds the swap.
   */
  #swapReadsAbsent(
    pattern: Pattern,
    argumentLink: NormalizedFullLink,
    resultCell: Cell<any>,
  ): boolean {
    const readTx = this.#familyReadTx(resultCell.tx?.tx.scopeKeyIdentity);
    const present = (link: NormalizedFullLink): boolean =>
      this.#documentPresent(readTx, link);
    if (!present(argumentLink)) return true;
    const cell = resultCell.withTx(readTx);
    const manifest = convertibleJsFromFabricValue(
      cell.getMetaRaw("internal", { meta: ignoreReadForScheduling }),
    );
    if (!Array.isArray(manifest)) return false;
    const listed = new Set<string>();
    for (const entry of manifest) {
      const link = isObjectOrArray(entry)
        ? parseLink((entry as { link?: unknown }).link, resultCell)
        : undefined;
      if (link !== undefined) listed.add(link.id);
    }
    if (listed.size === 0) return false;
    const owned: Cell<any>[] = [];
    this.#collectResumeOwnedCells(pattern, cell, owned, new Set(), readTx);
    return owned.some((ownedCell) => {
      const link = ownedCell.getAsNormalizedFullLink();
      return listed.has(link.id) && !present(link);
    });
  }

  /**
   * Whether a document a run of `pattern` over `resultCell` reads is absent
   * from this replica: the argument document `argumentLink` names, a
   * document the caller's `argument` or the stored argument links to through
   * the redirect chains those links form, or an owned cell of the pattern
   * or of a sub-piece it instantiates. The store delivers none of these with
   * the result document; a run that reads one absent commits against a
   * document the store holds and is refused, so a caller that finds one
   * absent names the family before it runs.
   */
  #familyAbsent(
    pattern: Pattern,
    entryKey: string,
    argument: unknown,
    argumentLink: NormalizedFullLink,
    resultCell: Cell<any>,
    identity: ScopeKeyIdentity | undefined,
  ): boolean {
    // Presence probes on a read transaction of their own, so an absent
    // document enters neither the caller's dependencies nor its commit's
    // read set: the run that follows the name-sync reads these for real.
    // The document itself is what is probed (`#documentPresent`), not a
    // value read through a schema, which returns the schema's default for an
    // absent document. A cell nothing has written yet — a derived cell whose
    // producer never ran — reads absent here too, and holds the run once; the
    // probes stop at a budget (`NAMING_PROBE_BUDGET`), and a budget spent
    // reads absent as well: a hold costs one name-sync, a wrong local verdict
    // costs a conflicting commit.
    const readTx = this.#familyReadTx(identity);
    const cell = resultCell.withTx(readTx);
    let probes = this.#namingProbeBudget;
    let budgetSpent = false;
    const present = (link: NormalizedFullLink): boolean => {
      if (probes === 0) {
        budgetSpent = true;
        return false;
      }
      probes--;
      return this.#documentPresent(readTx, link);
    };
    // The hold, with what decided it: a document of `stage` read absent, or
    // the budget ran out on a probe of that stage — the case worth a log,
    // since a piece held for its width and not for an absence looks, from
    // outside, like any other named run.
    const hold = (stage: string): boolean => {
      if (budgetSpent) {
        logger.debug("named-run-gate", () => [
          "probe budget spent; holding the run for a name-sync",
          {
            resultCell: resultCell.getAsNormalizedFullLink().id,
            pattern: entryKey,
            budget: this.#namingProbeBudget,
            stage,
          },
        ]);
      }
      return true;
    };
    if (!present(argumentLink)) return hold("the argument document");
    // What the run reads through the argument: every document the caller's
    // argument and the stored argument link to, followed through the
    // targets those links resolve into — a coordinator's element link is a
    // chain of redirects, and setup reads each hop. Bounded by depth, by a
    // document being probed once, and by the probe budget.
    // Presence is a fact about a document, probed once; what a link reaches
    // depends on its path, so two links into one document at different
    // paths are each walked.
    const probed = new Set<string>();
    const walked = new Set<string>();
    const linksAbsent = (value: unknown, depth: number): boolean => {
      const link = parseLink(value, resultCell);
      if (link !== undefined) {
        const probeKey = `${link.space}/${link.scope}/${link.id}`;
        if (!probed.has(probeKey)) {
          probed.add(probeKey);
          if (!present(link)) return true;
        }
        if (depth === 0) return false;
        const walkKey = `${probeKey}/${link.path.join("/")}`;
        if (walked.has(walkKey)) return false;
        walked.add(walkKey);
        return linksAbsent(
          readTx.readOrThrow(
            {
              space: link.space,
              id: link.id,
              path: ["value", ...link.path],
              ...(link.scope !== undefined && { scope: link.scope }),
            },
            { meta: ignoreReadForScheduling },
          ),
          depth - 1,
        );
      }
      if (!isKeyableObjectOrArray(value)) return false;
      for (const field in value) {
        if (linksAbsent((value as Record<string, unknown>)[field], depth)) {
          return true;
        }
      }
      return false;
    };
    if (linksAbsent(argument, 4)) {
      return hold("a document the caller's argument links to");
    }
    if (
      linksAbsent(
        readTx.readOrThrow(
          {
            space: argumentLink.space,
            id: argumentLink.id,
            path: ["value"],
            ...(argumentLink.scope !== undefined &&
              { scope: argumentLink.scope }),
          },
          { meta: ignoreReadForScheduling },
        ),
        4,
      )
    ) {
      return hold("a document the stored argument links to");
    }
    // The owned cells the run reads: the pattern's derived internal cells
    // and, through each nested sub-pattern's result spot, those of the
    // sub-pieces the run instantiates — the same walk the resume pre-sync
    // syncs by name.
    const owned: Cell<any>[] = [];
    this.#collectResumeOwnedCells(
      pattern,
      cell,
      owned,
      new Set(),
      readTx,
    );
    for (const ownedCell of owned) {
      if (!present(ownedCell.getAsNormalizedFullLink())) {
        return hold("an owned cell");
      }
    }
    return false;
  }

  /**
   * Names a piece's execution family once per pending load and records the
   * pattern whose dependencies arrived.
   */
  #nameFamilyBeforeRun(
    resultCell: Cell<any>,
    toName: {
      pattern: Pattern;
      entryKey: string;
      identity?: ScopeKeyIdentity;
    },
    argument: unknown,
  ): Promise<void> {
    const sourceIdentity = toName.identity ??
      resultCell.tx?.tx.scopeKeyIdentity;
    const identity = sourceIdentity === undefined
      ? undefined
      : { ...sourceIdentity };
    const key = this.#getFamilyKey(resultCell, identity);
    const resultLink = resultCell.getAsNormalizedFullLink();
    const inFlight = this.#namedFamilies.get(key);
    if (inFlight !== undefined && "pending" in inFlight) {
      return inFlight.pending;
    }
    const pending = this.#syncCellsForRunningPattern(
      resultCell,
      toName.pattern,
      argument,
      identity,
    ).then(
      () => {},
      (error: unknown) => {
        logger.warn(
          "runner-start",
          "naming a piece before its run rejected",
          [resultLink.id, error],
        );
      },
    ).then(() => {
      this.#namedFamilies.set(key, { landed: toName.entryKey });
    });
    this.#namedFamilies.set(key, { pending });
    return pending;
  }

  /**
   * Names `resultCell` — the dependency pre-sync a resumed piece pays, which
   * delivers what running `pattern` over it reads — and runs the piece once
   * that sync has landed, in a transaction of its own. Ownership of the
   * start begins now, as a commit-gated start's does, so a release before
   * the run cancels it, and it spans every name the run turns out to need:
   * a pattern pointer that moved while the sync was in flight is named in
   * turn, under the same ownership. A run that fails is reported the way a
   * piece-start commit failure is: loud, and to the serving runtime's
   * observer. Returns the cancel.
   */
  #runAfterNamedFamilyLands<T, R>(
    tx: IExtendedStorageTransaction,
    patternOrModule: Pattern | Module | undefined,
    named: {
      pattern: Pattern;
      entryKey: string;
      identity?: ScopeKeyIdentity;
    },
    argument: T,
    resultCell: Cell<R>,
    options: RunnerRunOptions,
  ): Cancel {
    const sourceIdentity = named.identity ?? tx.tx.scopeKeyIdentity;
    const identity = sourceIdentity === undefined
      ? undefined
      : { ...sourceIdentity };
    const resultLink = resultCell.getAsNormalizedFullLink();
    const actionId = `piece-run/${resultLink.id}`;
    const startLifecycleEpoch = this.#lifecycleEpoch;
    const ownership = this.#createDeferredStartOwnership(resultCell);
    const speculationContext = speculationRunContextOf(tx);
    const durableReads = isDurableReadTx(tx);
    const navigateContext = navigateEventContextFromRunInfo(
      waveRunContextOf(tx) ?? speculationContext,
    );
    const work = (async () => {
      let toName = named;
      for (;;) {
        await this.#nameFamilyBeforeRun(resultCell, toName, argument);
        if (ownership.isCancelled()) return;
        const startTx = this.#runtime.edit();
        if (durableReads) markDurableReadTx(startTx);
        if (identity !== undefined) startTx.tx.scopeKeyIdentity = identity;
        // A speculative child's continuation keeps its origin across the
        // data load. Authored and served starts use piece bookkeeping.
        this.#runtime.stampServerRun(
          startTx,
          speculationContext ?? { actionId, kind: "bookkeeping" },
        );
        if (navigateContext !== undefined) {
          setNavigateEventContext(startTx, navigateContext);
        }
        const startCell = this.#runtime.getCellFromLink<R>(
          resultLink,
          undefined,
          startTx,
        );
        let started: RunResult<R>;
        try {
          // A run given no pattern follows the stored pointer, which can
          // move while the name-sync is in flight: what landed is the named
          // pattern's family, and the pattern now pointed at may own cells
          // it never delivered. Name that one in turn, so the caller's one
          // handle reaches the start wherever it lands.
          const again = this.#patternToNameBeforeRun(
            patternOrModule,
            argument,
            startTx,
            startCell,
          );
          if (again !== undefined) {
            startTx.abort("Named piece's pattern moved before its run");
            toName = again;
            continue;
          }
          // The run consults the gate once more on its way in and gets the
          // answer the re-check just got: the landing that satisfied it is
          // recorded, and nothing runs between the two that could evict it —
          // an eviction takes a name-sync landing for another piece, and this
          // stretch is synchronous.
          started = this.#runWithStartOwnership(
            startTx,
            patternOrModule,
            argument,
            startCell,
            options,
          );
          if (ownership.markInstalled(started.installedCancel)) {
            startTx.abort("Deferred runner start was cancelled");
            return;
          }
          this.#runtime.prepareTxForCommit(startTx);
        } catch (error) {
          startTx.abort(error);
          ownership.cancel();
          this.#reportPieceStartCommitFailure(actionId, error);
          throw error;
        }
        const { error } = await this.#commitDeferredStart(startTx, resultCell);
        if (!error) return;
        if (
          this.#catchUpAndStartOnStaleRead(
            error,
            resultCell,
            "start",
            startLifecycleEpoch,
            ownership,
            started.installedCancel,
          )
        ) {
          return;
        }
        ownership.cancel();
        this.#reportPieceStartCommitFailure(actionId, error);
        return;
      }
    })();
    this.#runtime.scheduler.trackBackgroundTask(work);
    return ownership.cancel;
  }

  /**
   * The catch-up recovery a commit-gated start earns when its transaction
   * is refused for a STALE CONFIRMED READ under server execution. Returns
   * whether a recovery was scheduled — `false` leaves the caller's terminal
   * arm to run exactly as it does for every other refusal.
   *
   * WHY a start earns one at all. Under the flag a piece is materialized
   * SERVER-side, and the client's navigate-deferred start reads that
   * piece's computed documents to base its own transaction on. At first
   * hydration those two acts race by construction: the serving loop's
   * derived commits for the just-born piece are in flight exactly while
   * the client reads their targets as absent, so the client's basis is
   * stale whenever the interleaving is tight — the EXPECTED outcome of
   * losing the race, not an exceptional one. Terminating there would make
   * the race fatal: `#startWithTx()` has already installed the
   * client-side piece inside the transaction when the refusal lands, the
   * error arm's cancel tears that install down, and nothing re-runs it —
   * the piece would have no client context for the rest of the session and
   * every read that depends on it would resolve to nothing, while the store
   * holds every append.
   *
   * WHAT the recovery does — and deliberately does not. The refusal is treated
   * as "the server won the race": await the conflict's readiness (the session
   * catch-up the wire attaches as `readyToRetry`, plus the named document's
   * pull — `Runtime.awaitCommitRetryReadiness`), then START the piece from the
   * served documents through the ordinary load walk (`#doStart`), the same walk
   * a reload runs. The recovery arm COMMITS NOTHING: it does not re-mint and
   * re-commit the refused materialization, and it mints no transaction of its
   * own. The load walk's own instantiation transaction keeps its sanctioned
   * `bookkeeping` stamp exactly as a reload's does (serving-loop.md §3d's
   * piece-start site), and for a piece the server materialized it has nothing
   * left to write. A document still in flight reads as PENDING and re-triggers
   * on arrival (speculation.md §2's unresolved-input semantics) — the entirely
   * reactive flow that catches up with the server.
   *
   * ON-ONLY: under OFF a stale confirmed read on a deferred start means another
   * CLIENT raced, and the cross-tab mutex semantics own that story — the OFF
   * arm stays terminal.
   *
   * WHAT stays terminal. Only the engine's stale-read family recovers —
   * `stale confirmed read` and its `stale pending read` sibling
   * ({@link isStaleReadConflict}, head-anchored). Every other refusal stays
   * terminal: a CFC or speculative-basis refusal, an authorization denial, a
   * precondition failure, a row-label violation, a withdrawal that merely
   * embeds a staleness phrase — none of them describe a basis the served
   * documents repair.
   *
   * CANCELLATION AUTHORITY. The recovery RIDES THE ORIGINAL ATTEMPT'S OWNERSHIP
   * TOKEN — the one Cancel handle the parent holds (its cancel group and
   * lineage piece-stop) — and recovers only an attempt whose install is STILL
   * THE CURRENT REGISTRATION when the refusal lands. Concretely: (1) at entry,
   * a stop or supersede that landed during the commit round trip (which removed
   * the install, could cancel no pending token — the ownership unregistered at
   * markInstalled — and bumps no epoch) makes the recovery DECLINE, so the stop
   * wins exactly as it does on the terminal path; (2) the refused install is
   * torn down with the same registry-guarded stop the token's own cancel
   * performs, WITHOUT spending the token, and the token's now-stale install
   * reference is CLEARED (the token's cancel is a one-shot `stopped` latch —
   * fired against a stale install it would no-op AND burn the latch, leaving a
   * later hand-off unable to stop the recovered run; with the install cleared,
   * a cancel landing anywhere in the wait or walk window stays pending-shaped);
   * (3) the token re-enters the pending index for the readiness wait, so a
   * stop, a release, or `stopAll()` during that window tombstones the recovery
   * through the same path that tombstones a pending first attempt; (4) the walk
   * hands the claimed registration to the token INSIDE its claim mapping — the
   * same synchronous block as the claim checks, no promise hop for a
   * stop+restart to slip a foreign registration into — and the hand-off is
   * EXACT: only the registration this attempt's own `#startCore()` created,
   * still current (a COMPETING start can install into the registry the
   * recovery's entry emptied with no stop and so no generation bump, and the
   * walk's already-started returns report it as success; an identity-blind
   * hand-off would bind the parent's token to a run whose lifecycle the parent
   * does not own, so the recovery instead yields exactly as on an owned key). A
   * parent cancel from the hand-off on stops the recovered run, and one that
   * landed during the wait or the walk is finished by that markInstalled
   * against the real registration: the run is stopped in the same breath and
   * the walk reports not-running. If another start took the key while the
   * recovery waited, the recovery yields exactly as `#startWithTx()` yields on
   * an owned key: the piece has a context under someone else's authority, and
   * the token settles without touching it. The lifecycle epoch still covers the
   * one window no token can: a teardown that ran before the refusal's
   * continuation, whose sweep could not see this scheduling.
   */
  #catchUpAndStartOnStaleRead<T>(
    error: { name?: string; message?: string },
    resultCell: Cell<T>,
    label: string,
    scheduledLifecycleEpoch: number,
    ownership: DeferredCancelOwnership,
    installedRegistration: Cancel | undefined,
  ): boolean {
    if (this.#runtime.experimental.serverExecution !== true) return false;
    if (!isStaleReadConflict(error)) return false;
    if (scheduledLifecycleEpoch !== this.#lifecycleEpoch) return false;
    if (ownership.isCancelled()) return false;
    const key = this.#getDocKey(resultCell);
    // The cancellation-authority gate: recover only an attempt whose install is
    // still the current registration as the refusal lands. A stop or release
    // during the commit round trip removed it; a replacement start superseded
    // it. Either way the authority over this key has moved on, and the recovery
    // must not override it — the caller's terminal arm runs (which
    // no-op-cancels the spent registration).
    if (
      installedRegistration === undefined ||
      this.#cancels.get(key) !== installedRegistration
    ) {
      return false;
    }
    logger.warn(
      "deferred-start-catchup",
      `Deferred ${label} transaction lost its first-hydration basis to ` +
        "the serving side; starting from the served documents instead",
      error,
    );
    // Tear the refused install down exactly as the token's own cancel
    // would — the registry-guarded stop — WITHOUT spending the token: the
    // token is the parent's one handle to this start, and it now carries
    // the recovery.
    this.stop(resultCell);
    // Clear the token's now-STALE install. The token's cancel is a ONE-SHOT
    // `stopped` latch: fired against the stale install it would be a
    // registry-guarded no-op that BURNS the latch, and the hand-off's later
    // markInstalled would return at the latch WITHOUT stopping the freshly
    // recovered run, leaking it. With the install cleared, a cancel landing
    // anywhere in the wait or walk window stays pending-shaped (no latch burn),
    // and the hand-off's markInstalled finishes it against the real
    // registration.
    ownership.markInstalled(undefined);
    // Back into the pending index under the SAME token, so a stop or a
    // release during the readiness wait tombstones the recovery through
    // the same path that tombstones a pending first attempt. (The
    // markInstalled above also unregistered the token — a no-op, it was
    // not registered — so this add is the token's one live entry.)
    this.#registerPendingDeferredStart(key, ownership);
    const recovery = this.#runtime.awaitCommitRetryReadiness(error)
      .then(async () => {
        // Paired guards, each the other's backstop: the token covers a stop or
        // a stopAll that ran while the readiness gate was awaited (the token
        // re-entered the pending index before the await, so the sweep sees it),
        // and the epoch covers a teardown that ran before this recovery was
        // even scheduled, when the sweep could not have seen it.
        if (
          ownership.isCancelled() ||
          scheduledLifecycleEpoch !== this.#lifecycleEpoch
        ) {
          return;
        }
        if (this.#cancels.has(key)) {
          // Another start took the key while the recovery waited — the
          // same yield `#startWithTx()` makes on an owned key. The piece HAS
          // a context under someone else's authority; the recovery's purpose
          // is met and its claim dissolves. Settling the token touches no
          // live registration (its stale install no longer matches).
          ownership.cancel();
          return;
        }
        try {
          // The hand-off to the parent's token happens INSIDE the walk's claim
          // mapping — the same synchronous block as the claim checks — so there
          // is no promise-hop window between "the walk left the piece running"
          // and "the token owns that registration" for a stop+restart to slip a
          // foreign registration into. `started` is therefore already the
          // hand-off's verdict: true means the token owns the recovered run
          // un-cancelled; false with a cancelled token means a cancel landed in
          // the wait or walk window and the run was stopped in the same breath.
          const started = await this.#startFromServedState(
            resultCell,
            ownership,
          );
          if (started) return;
          if (!ownership.isCancelled()) {
            // A recovery that resolves without leaving the piece running,
            // with nobody having stopped it, is the silent no-context
            // state this arm exists to prevent — surface it loudly (the
            // r06 gate run's post-mortem could not distinguish this
            // outcome from a read-side stall; this line makes the next
            // occurrence decisive).
            logger.error(
              "deferred-start-catchup-failed",
              `Deferred ${label} catch-up start resolved without the ` +
                "piece running (superseded or stopped mid-walk)",
            );
            ownership.cancel();
          }
        } catch (cause) {
          // Settle the token before surfacing: its stale install matches
          // no live registration, so this cancel only unregisters.
          ownership.cancel();
          throw cause;
        }
      })
      .catch((cause) => {
        // Loud in every arm, per serving-loop.md §3d's piece-start
        // surfacing rule: a failed recovery is a piece with no client
        // context, never a silent state.
        logger.error(
          "deferred-start-catchup-failed",
          `Deferred ${label} catch-up start failed; the piece has no ` +
            "client-side context",
          cause,
        );
      });
    this.#pendingDeferredStartCatchUps.add(recovery);
    recovery.finally(() => this.#pendingDeferredStartCatchUps.delete(recovery));
    return true;
  }

  /**
   * The ordinary load walk (`#doStart`), invoked for a catch-up recovery:
   * the piece starts from what the store serves, exactly as a reload
   * would start it. Identical to {@link start} except that the result is
   * NOT marked independently started — a recovered deferred start remains
   * its parent's child, releasable exactly like the install the refused
   * attempt would have registered.
   *
   * When an `ownership` token is supplied, the walk hands the claimed
   * registration to it IN THE CLAIM MAPPING — the same synchronous block as the
   * claim checks — so a cancel that landed during the walk stops the
   * just-claimed run in the same breath (markInstalled finishes a pending
   * cancellation), and no promise hop separates the claim from the hand-off.
   * The mapping then reports whether the token owns a RUNNING piece: a hand-off
   * that resolved a pending cancellation reports false.
   */
  #startFromServedState<T>(
    resultCell: Cell<T>,
    ownership?: DeferredCancelOwnership,
    options?: StartAttempt["options"],
  ): Promise<boolean> {
    const attempt: StartAttempt = {
      options,
      lifecycleEpoch: this.#lifecycleEpoch,
      generationsByDoc: new Map(),
      preResolutionStopKeys: new Set(),
    };
    this.#activeStartAttempts.add(attempt);
    this.#trackStartAttempt(attempt, this.#getDocKey(resultCell));
    try {
      return this.#doStart(resultCell, new Set(), attempt)
        .then((started) => {
          // Same target-scoped claim as start(): a stop that superseded
          // this walk, or a start that resolved elsewhere, reports false.
          const target = attempt.targetKey;
          const stillRunning = started && target !== undefined &&
            this.#isStartAttemptCurrentFor(attempt, target) &&
            this.#cancels.has(target);
          if (stillRunning && ownership !== undefined) {
            const current = this.#cancels.get(target!);
            if (
              attempt.installedRegistration === undefined ||
              current !== attempt.installedRegistration
            ) {
              // Not this walk's own registration: a COMPETING start claimed the
              // result while the walk was in flight — installing into the
              // registry the recovery's entry emptied needs no stop, so no
              // generation bump witnesses it, and doStart's already-started
              // returns report it as success. The piece runs under the
              // competitor's authority; binding it to the caller's token would
              // let a parent cancel tear down a run whose lifecycle the parent
              // does not own. Yield exactly as `#startWithTx()` yields on an
              // owned key: settle the token without touching the registration.
              ownership.cancel();
              return true;
            }
            if (ownership.markInstalled(current!)) {
              // A cancel was pending (it landed during the wait or the
              // walk): markInstalled just finished it against the real
              // registration — the run is stopped, not owned.
              return false;
            }
          }
          return stillRunning;
        })
        .finally(() => {
          this.#finishStartAttempt(attempt);
        });
    } catch (error) {
      this.#finishStartAttempt(attempt);
      return Promise.reject(error);
    }
  }

  #runPatternAfterSuccessfulCommit<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    pattern: Pattern,
    inputs: FabricValue,
    markCreateOnlyResult = false,
    speculativeConsequence?: { eventId: string },
    parentPieceRootId?: string,
  ): Cancel {
    const resultLink = resultCell.getAsNormalizedFullLink();
    const startLifecycleEpoch = this.#lifecycleEpoch;
    const ownership = this.#createDeferredStartOwnership(resultCell);
    // The piece this result belongs to is known now and not at the deferred
    // start, and a child the result instantiates asks for it by the chain
    // (`#ancestorSystemOrigin`), so the chain is recorded ahead of the start
    // exactly as the immediate path's start records it.
    this.#demandRootChainFor(resultLink.id, parentPieceRootId);
    tx.addCommitCallback((_committedTx, result) => {
      if (result.error) {
        // Settled here for the same reason as the start above: this callback
        // is the only thing that reaches the pending entry, so a failed
        // transaction would otherwise strand it under the result's key.
        ownership.cancel();
        return;
      }
      if (ownership.isCancelled()) return;

      const startTx = this.#runtime.edit();
      // Minted inside a commit callback — outside any scheduler run;
      // bookkeeping per serving-loop.md §3d, like the deferred start above (and
      // with the same §3d speculative-consequence stamp: a flag-ON client's
      // navigate-deferred start is a speculative handler CONSEQUENCE and
      // diverts to the overlay instead of racing the serving side's receipt
      // create).
      this.#runtime.stampServerRun(startTx, {
        actionId: `piece-start/${resultLink.id}`,
        ...(speculativeConsequence !== undefined
          ? {
            kind: "event-handler" as const,
            eventId: speculativeConsequence.eventId,
          }
          : { kind: "bookkeeping" as const }),
      });
      // Carry the instantiating event-handler run's event context to the start
      // tx (builtins.md §4) — capture point 1, as in startAfterSuccessfulCommit
      // above.
      const navigateContext = navigateEventContextFromRunInfo(
        waveRunContextOf(tx) ?? speculationRunContextOf(tx),
      );
      if (navigateContext !== undefined) {
        setNavigateEventContext(startTx, navigateContext);
      }
      const committedResultCell = this.#runtime.getCellFromLink<T>(
        resultLink,
        pattern.resultSchema,
        startTx,
      );
      try {
        const installedRegistration = this.#runWithStartOwnership(
          startTx,
          pattern,
          inputs,
          committedResultCell,
          parentPieceRootId === undefined ? {} : { parentPieceRootId },
        ).installedCancel;
        if (ownership.markInstalled(installedRegistration)) {
          startTx.abort("Deferred runner start was cancelled");
          return;
        }
        if (markCreateOnlyResult) {
          startTx.markCreateOnly?.(
            committedResultCell.getAsNormalizedFullLink(),
          );
        }
        this.#runtime.prepareTxForCommit(startTx);
        this.#commitDeferredStart(startTx, resultCell).then(({ error }) => {
          if (error) {
            if (
              this.#catchUpAndStartOnStaleRead(
                error,
                resultCell,
                "cross-space pattern",
                startLifecycleEpoch,
                ownership,
                installedRegistration,
              )
            ) {
              return;
            }
            ownership.cancel();
            logger.error(
              "tx-commit-error",
              "Error committing deferred cross-space pattern transaction",
              error,
            );
          }
        }).catch((error) => {
          ownership.cancel();
          logger.error(
            "tx-commit-error",
            "Deferred cross-space pattern transaction rejected",
            error,
          );
        });
      } catch (error) {
        startTx.abort(error);
        ownership.cancel();
        logger.error(
          "runner-start",
          "Deferred cross-space pattern failed",
          error,
        );
        throw error;
      }
    });
    return ownership.cancel;
  }

  /**
   * Run a pattern.
   *
   * resultCell is required and should have an id. Pattern, argument, and
   * internal links are stored in result-cell metadata.
   *
   * If no pattern is provided, the previous one is used, and the pattern is
   * started if it isn't already started.
   *
   * If no argument is provided, the previous one is used, and the pattern is
   * started if it isn't already running.
   *
   * If a new pattern or any argument value is provided, a currently running
   * pattern is stopped, the pattern and argument replaced and the pattern
   * restarted.
   *
   * @param patternFactory - Function that takes the argument and returns a
   * pattern.
   * @param argument - The argument to pass to the pattern. Can be static data
   * and/or cell references, including cell value proxies, docs and regular
   * cells.
   * @param resultCell - Cell to run the pattern off.
   * @returns The result cell.
   */
  run<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
    options?: RunnerRunOptions,
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options?: RunnerRunOptions,
  ): Cell<R>;
  run<T, R = any>(
    providedTx: IExtendedStorageTransaction,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options: RunnerRunOptions = {},
  ): Cell<R> {
    return this.#runWithStartOwnership(
      providedTx,
      patternOrModule,
      argument,
      resultCell,
      options,
    ).resultCell;
  }

  /**
   * Runs a pattern with setup staged in the caller's transaction. When its
   * stored dependencies need loading, resolves that load and throws
   * `RetryImmediately` so the scheduler retries with a fresh transaction.
   * No deferred setup transaction can outlive the caller's resolution writes.
   */
  runInTransaction<T, R>(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    argument: T,
    resultCell: Cell<R>,
    options: RunnerRunOptions = {},
  ): Cell<R> | Promise<never> {
    const toName = this.#patternToNameBeforeRun(
      pattern,
      argument,
      tx,
      resultCell,
    );
    if (toName !== undefined) {
      return this.#nameFamilyBeforeRun(resultCell, toName, argument).then(
        () => {
          throw new RetryImmediately(
            "Loading the compiled child's execution family",
          );
        },
      );
    }
    return this.run(tx, pattern, argument, resultCell, options);
  }

  /**
   * Internal run variant that reports whether this invocation installed or
   * commit-gated the result wrapper's local start/cancel registration. Callers
   * that attach failure compensation must only compensate work they own: a
   * duplicate event can reuse a winner's deterministic result cell, and must
   * never stop that shared winner when its create-only receipt loses.
   */
  #runWithStartOwnership<T, R = any>(
    providedTx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options: RunnerRunOptions = {},
  ): RunResult<R> {
    const tx = providedTx ?? this.#runtime.edit();
    if (providedTx === undefined) {
      // Self-minted fallback arm (reached e.g. from wish's async
      // suggestion-pattern fetch continuation): setup + start writes
      // with no scheduler run around them; bookkeeping per
      // serving-loop.md §3d. A provided tx keeps its caller's stamp.
      this.#runtime.stampServerRun(tx, {
        actionId: `piece-run/${resultCell.sourceURI}`,
        kind: "bookkeeping",
      });
    }
    const sourceKey = getTxDebugActionId(tx) ?? "none";

    triggerFlowLogger.debug(`runner-run/${sourceKey}`, () => [
      `[RUN] source=${sourceKey}`,
      `result=${resultCell.getAsNormalizedFullLink().id}`,
      `pattern=${describePatternOrModule(patternOrModule)}`,
      `providedTx=${Boolean(providedTx)}`,
    ]);

    // A piece set up elsewhere, reached here through a link crossing, has
    // arrived as its document alone: the argument document and the internal
    // cells its setup wrote belong to whoever names it (05-queries.md), and
    // both the setup re-check and the instantiation below read them. Name
    // it, and run it — setup and start alike — once the name-sync has
    // landed, in a transaction of its own.
    const toName = this.#patternToNameBeforeRun(
      patternOrModule,
      argument,
      tx,
      resultCell,
    );
    if (toName !== undefined) {
      const cancelDeferredStart = this.#runAfterNamedFamilyLands(
        tx,
        patternOrModule,
        toName,
        argument,
        resultCell,
        options,
      );
      if (!providedTx) {
        this.#runtime.prepareTxForCommit(tx);
        tx.commit();
      }
      return { resultCell, cancelDeferredStart };
    }
    // A creation revision belongs to the run that creates the piece. A run of
    // one that is already there changes neither its source state nor its
    // origin: that is a source transition's to decide, and a run reaching a
    // piece whose pattern moved underneath it is an ordinary in-place swap.
    const creatingPiece = options.sourceOrigin !== undefined &&
      getPatternIdentityRef(resultCell.withTx(tx)) === undefined;
    const { needsStart, pattern } = this.#setupInternal(
      tx,
      patternOrModule,
      argument,
      resultCell,
      {
        referencedArgumentFields: options.referencedArgumentFields,
        ...(creatingPiece
          ? {
            initializePieceSourceHistory: true,
            initialPieceSourceOrigin: options.sourceOrigin,
          }
          : {}),
      },
    );

    let installedCancel: Cancel | undefined;
    let cancelDeferredStart: Cancel | undefined;
    if (needsStart) {
      if (
        tx.tx.immediate === true &&
        (tx.tx as { deferRunnerStartUntilCommit?: boolean })
            .deferRunnerStartUntilCommit === true
      ) {
        cancelDeferredStart = this.#startAfterSuccessfulCommit(
          tx,
          resultCell,
          pattern,
          options,
        );
      } else {
        installedCancel = this.#startWithTx(
          tx,
          resultCell,
          pattern,
          options,
        );
      }
    }

    // The setup writes are staged in this transaction; the registration is
    // not, so a transaction that does not become durable would otherwise leave
    // a piece running over writes that never landed. A stale basis is the
    // exception: the re-run that follows reuses what is already there.
    if (installedCancel !== undefined) {
      const startedCancel = installedCancel;
      tx.addCommitCallback((_settledTx, result) => {
        if (!result.error) return;
        if (
          isConflictRejection(result.error) ||
          isStorageTransactionInconsistent(result.error)
        ) {
          return;
        }
        this.releaseChild(resultCell, startedCancel);
      });
    }

    if (!providedTx) {
      this.#runtime.prepareTxForCommit(tx);
      tx.commit();
    }

    return {
      resultCell,
      installedCancel,
      cancelDeferredStart,
    };
  }

  /**
   * Runs a pattern and returns its reconciled result-cell view.
   *
   * A failure after the setup transaction commits reaches the caller as the
   * failure itself, never wrapped: a receipt is what a wrapper would carry,
   * and this surface asks for none. Callers that classify such a failure by
   * message — `isCfcMigrationRejection` among them — depend on that, so the
   * gate that keeps receipts to the callers who request one is load-bearing
   * for more than the receipt.
   */
  async runSynced(
    resultCell: Cell<any>,
    pattern: Pattern | Module,
    inputs?: any,
    options?: RunSyncedOptions,
  ): Promise<Cell<any>> {
    return (await this.#runSynced(
      resultCell,
      pattern,
      inputs,
      options,
      false,
    )).cell;
  }

  /**
   * Runs a pattern source update and returns its accepted transaction receipt.
   *
   * A resolved call is proof that storage accepted this transaction. Five
   * conditions make that so, and each is enforced here rather than inferred
   * from the caller's options or its runtime, so narrowing one cannot quietly
   * downgrade the receipt into a claim nothing checked:
   *
   * - the operation owns the transaction, so the receipt reports a storage
   *   verdict and never writes merely staged in a caller-owned transaction;
   * - the runtime commits to storage rather than sealing into a wave, where
   *   acceptance means "taken into the wave" and a later withdrawal —
   *   superseded, requeued, lease lost — can undo it. Such a contribution
   *   cannot back a receipt that says `committed`, and waiting for the wave to
   *   settle from inside the action that feeds it can deadlock, so the answer
   *   is a refusal at the boundary rather than a weaker word for durable —
   *   unless the caller asks for a direct commit (`directCommit`), which the
   *   serving loop commits to the store outside the wave, its verdict the
   *   store's own. A flag-ON client speculating installs no destination and
   *   is unaffected; its setup is stamped as bookkeeping, which the overlay
   *   passes through to the real store;
   * - a commit that storage rejects throws an `Error` carrying the
   *   rejection's name, message, and fields, and never falls through to the
   *   post-commit work that a receipt-less run tolerates;
   * - the required source transition appends a fresh revision, so the setup
   *   cannot be elided as a wholly redundant transaction before reaching
   *   storage;
   * - a setup that recorded no pattern pointer throws, because a receipt
   *   naming no pattern is not a receipt.
   *
   * @throws PatternSetupPostCommitError when the transaction commits and the
   * work that refreshes the running piece then fails. Its `.commit` is the
   * accepted transaction's receipt and its `.cause` the later failure.
   */
  async runSyncedWithCommit(
    resultCell: Cell<any>,
    pattern: Pattern | Module,
    inputs: any,
    options: RunSyncedWithCommitOptions,
  ): Promise<RunSyncedCommitResult<any>> {
    if (resultCell.tx?.status().status === "ready") {
      throw new Error(
        "a committed pattern setup receipt requires an unbound result cell",
      );
    }
    // A fast refusal. The condition is asked again inside the transaction,
    // which is where it decides anything: a destination installed while the
    // synchronization below is in flight would pass this check and still seal
    // the transaction the receipt would describe.
    if (
      this.#runtime.sealDestinationInstalled && options.directCommit !== true
    ) {
      throw new Error(SEALING_RECEIPT_REFUSAL);
    }
    if (options.pieceSourceTransition === undefined) {
      // TypeScript callers cannot omit this, but the runtime boundary is also
      // used from JavaScript. Without a fresh revision a redundant setup can
      // be elided locally and would mint a receipt for a commit storage never
      // saw, so fail closed rather than relying on a caller's discipline.
      throw new Error(
        "a committed pattern setup receipt requires a fresh source transition",
      );
    }
    const result = await this.#runSynced(
      resultCell,
      pattern,
      inputs,
      options,
      true,
    );
    // Under `requireCommit` the helper has two exits: it throws, or it issues
    // a receipt. The check above is what rules out the third — the staging
    // path, which commits nothing — and it holds for the whole call rather
    // than only at entry: a cell's `tx` is readonly and `withTx()` yields a
    // different cell, so this one cannot acquire a transaction along the way,
    // and `ready` is a transaction's initial state, which `pending` and `done`
    // follow but never precede.
    return { cell: result.cell, commit: result.commit! };
  }

  /**
   * Helper for `runSynced()` and `runSyncedWithCommit()`.
   *
   * `requireCommit` is what separates them. It makes an owned transaction
   * mandatory, turns a rejected commit and a pointer-less setup into throws,
   * and is the only condition under which a receipt is issued at all — so a
   * receipt-less caller cannot receive a `PatternSetupPostCommitError` that
   * hides its failure's own type behind a wrapper.
   */
  async #runSynced(
    resultCell: Cell<any>,
    pattern: Pattern | Module,
    inputs: any,
    options: RunSyncedOptions | undefined,
    requireCommit: boolean,
  ): Promise<{
    cell: Cell<any>;
    commit?: PatternSetupCommitReceipt;
  }> {
    if (pattern === undefined) {
      // TypeScript callers cannot omit this, but the runtime boundary is also
      // used from JavaScript. A missing pattern is first read deep in the
      // pre-sync, where it surfaces as a `TypeError` naming a property rather
      // than the argument, so fail closed here, at the one point both public
      // entry points pass through, before any work is done.
      throw new Error("a synced run requires a pattern");
    }
    // A module runs as the one-node pattern `run()` wraps it in, and the
    // pre-sync names what that node reads: `inputs` under the module's
    // argument schema.
    const presyncPattern = this.#resolveToPattern(pattern);
    await resultCell.sync();

    const synced = await this.#syncCellsForRunningPattern(
      resultCell,
      presyncPattern,
      inputs,
    );

    const transition = options?.pieceSourceTransition;
    const candidateRef = this.#runtime.patternManager.getArtifactEntryRef(
      pattern,
    );
    const sourceUpdate = transition?.baseline.kind === "retain" && candidateRef
      ? await this.#runtime.patternManager.prepareSourceUpdate(
        resultCell.space,
        transition.expected.pattern.identity,
        candidateRef.identity,
      )
      : undefined;

    // Run the pattern.
    //
    // If the result cell has a transaction attached, and it is still open,
    // we'll use it for all reads and writes as it might be a pending read.
    //
    // TODO(seefeld): There is currently likely a race condition with the
    // scheduler if the transaction isn't committed before the first functions
    // run. Though most likely the worst case is just extra invocations.
    const givenTx = resultCell.tx?.status().status === "ready" && resultCell.tx;
    let setupRes: SetupResult<any> | undefined;
    let commit: PatternSetupCommitReceipt | undefined;
    let committedTx: IExtendedStorageTransaction | undefined;
    const assertExpectedPatternIdentity = (
      cell: Cell<any>,
    ): void => {
      const expected = options?.expectedPatternIdentity;
      if (!expected) return;
      // A keyless piece's pointer is session-side (the never-durable
      // contract), so the currency check reads through the session map when
      // the durable meta is absent.
      const current = getPatternIdentityRef(cell) ??
        this.#sessionPatternPointer(cell);
      if (
        current === undefined ||
        patternIdentityKey(current) !== patternIdentityKey(expected)
      ) {
        throw new Error(
          "piece pattern changed while the source update was compiling",
        );
      }
    };
    if (givenTx) {
      if (sourceUpdate !== undefined) {
        throw new Error(
          "source update authority requires an owned setup transaction",
        );
      }
      // If tx is given, i.e. result cell was part of a tx that is still open,
      // caller manages retries
      assertExpectedPatternIdentity(resultCell.withTx(givenTx));
      setupRes = this.#setupInternal(
        givenTx,
        pattern,
        inputs,
        resultCell.withTx(givenTx),
        {
          patternRepository: options?.patternRepository,
          pieceSourceTransition: options?.pieceSourceTransition,
          validateCurrentArgument: options?.validateCurrentArgument,
          validateArgumentLinks: options?.validateArgumentLinks,
        },
      );
    } else {
      const outcome = await this.#runtime.editWithRetry(
        (tx) => {
          // The attempt that commits is the last one this callback sees, so
          // the receipt below names the commit it produced.
          committedTx = tx;
          // Receipts and source-update authority require this transaction's
          // durable acceptance, which a direct commit supplies and a seal
          // into the wave does not. Check each attempt because a seal
          // destination can be installed during synchronization or between
          // retries.
          if (
            (requireCommit || sourceUpdate !== undefined) &&
            this.#runtime.sealDestinationInstalled &&
            options?.directCommit !== true
          ) {
            throw new Error(
              requireCommit
                ? SEALING_RECEIPT_REFUSAL
                : SEALING_SOURCE_UPDATE_REFUSAL,
            );
          }
          // runSynced's own setup tx (async surface, e.g. compileAndRun's
          // continuation on a served run): no scheduler run around it;
          // bookkeeping per serving-loop.md §3d.
          //
          // The kind also decides where this transaction lands. Under
          // experimental server execution a derivation or event-handler run is
          // diverted into the speculation overlay, whose acceptance is a seal
          // that a later withdrawal can undo; bookkeeping commits to storage.
          // A receipt minted from an overlay seal would claim durability it
          // does not have, so re-stamping this one is not a naming change.
          this.#runtime.stampServerRun(tx, {
            actionId: `piece-run-synced/${resultCell.sourceURI}`,
            kind: "bookkeeping",
            ...(options?.directCommit === true ? { directCommit: true } : {}),
          });
          if (options?.cfcTrustSnapshot !== undefined) {
            tx.setCfcTrustSnapshot(options.cfcTrustSnapshot);
          }
          assertExpectedPatternIdentity(resultCell.withTx(tx));
          return this.#setupInternal(
            tx,
            pattern,
            inputs,
            resultCell.withTx(tx),
            {
              patternRepository: options?.patternRepository,
              pieceSourceTransition: options?.pieceSourceTransition,
              sourceUpdate,
              validateCurrentArgument: options?.validateCurrentArgument,
              validateArgumentLinks: options?.validateArgumentLinks,
            },
          );
        },
        undefined,
        { sourceUpdate },
      );
      if (outcome.error) {
        const error = outcome.error;
        if (
          error.name === "StorageTransactionAborted" &&
          error.message.startsWith("editWithRetry action threw:") &&
          error.reason instanceof Error
        ) {
          throw error.reason;
        }
        // A caller owed a receipt is owed the storage verdict too: continuing
        // here would run the post-commit work over a setup storage refused and
        // then report no receipt for it. The identity arm below predates the
        // receipt and covers its own callers; neither subsumes the other.
        //
        // A verdict that is a plain `Result` object goes out as an `Error`
        // carrying its name, message, and fields: thrown as it stands it
        // fails every `instanceof Error` check on the way up and renders as
        // `[object Object]`, its message discarded. One that is already an
        // `Error`, a precondition failure among them, goes out as itself, so
        // its identity, stack, and `cause` survive.
        if (requireCommit || options?.expectedPatternIdentity) {
          throw error instanceof Error ? error : toThrowable(error);
        }
        logger.error("pattern-setup-error", "Error setting up pattern", error);
        setupRes = undefined;
      } else {
        setupRes = outcome.ok;
        // Only a caller that asked for a receipt gets one, and that decides
        // more than the return value: the receipt is what the post-commit
        // wrapper below carries, so withholding it here is what keeps
        // `runSynced`'s failures unwrapped for the callers that read their
        // messages. Minting unconditionally would wrap those failures in a
        // type whose message names none of them.
        if (requireCommit) {
          const patternRef = setupRes.patternRef;
          // deno-coverage-ignore-start -- every caller passes a pattern
          if (patternRef === undefined) {
            // `#setupInternal()` returns without a pointer when it resolves no
            // pattern at all. A caller passing one cannot reach that, so this
            // guards the type's edge rather than a live path — and it fails
            // loudly instead of minting a receipt that names nothing.
            throw new Error(
              "the pattern setup committed without recording a pattern identity",
            );
          }
          // deno-coverage-ignore-stop
          // Recorded on the transaction at its verdict, before the commit
          // promise resolved, so a resolved commit carries it; like the
          // pointer above, a missing seq is the type's edge and fails loudly
          // rather than minting a receipt that names no commit.
          const seq = committedTx?.committedSeq?.(resultCell.space);
          if (seq === undefined) {
            throw new Error(
              "the pattern setup committed without recording its store seq",
            );
          }
          commit = { pattern: patternRef, space: resultCell.space, seq };
        }
      }
    }

    try {
      // If a new pattern was specified, make sure to sync any new cells
      if (pattern || !synced) {
        await this.#syncCellsForRunningPattern(resultCell, presyncPattern);
      }

      if (setupRes?.needsStart && options?.start !== false) {
        if (givenTx) {
          this.#startWithTx(
            givenTx,
            resultCell.withTx(givenTx),
            setupRes.pattern,
          );
        } else {
          // The setup commit can be superseded while dependency sync is in
          // flight. Resolve startup from the current durable pattern pointer so
          // a stale caller can never instantiate its old candidate while
          // recording a newer identity as current.
          await resultCell.sync();
          await this.start(resultCell);
        }
      }

      // A concurrent source update can supersede this caller after its setup
      // commit but before its post-commit dependency sync settles. Return a view
      // typed by the pattern that is actually durable now, not by this caller's
      // stale candidate.
      let currentRef = getPatternIdentityRef(resultCell);
      while (currentRef !== undefined) {
        const loadedRef = currentRef;
        // A direct commit's caller answers for what it seals into the
        // serving wave, so the load repairs no cache on its behalf.
        const currentPattern = await this.#runtime.patternManager
          .loadPatternByIdentity(
            loadedRef.identity,
            loadedRef.symbol,
            resultCell.space,
            { repairCache: options?.directCommit !== true },
          );
        currentRef = getPatternIdentityRef(resultCell);
        if (
          currentRef !== undefined &&
          patternIdentityKey(currentRef) !== patternIdentityKey(loadedRef)
        ) {
          continue;
        }
        if (
          currentRef === undefined || currentPattern?.resultSchema === undefined
        ) {
          return {
            cell: resultCell,
            ...(commit === undefined ? {} : { commit }),
          };
        }
        return {
          cell: resultCell.asSchema(currentPattern.resultSchema),
          ...(commit === undefined ? {} : { commit }),
        };
      }
      return {
        cell: pattern?.resultSchema !== undefined
          ? resultCell.asSchema(pattern.resultSchema)
          : resultCell,
        ...(commit === undefined ? {} : { commit }),
      };
    } catch (error) {
      if (commit !== undefined) {
        throw new PatternSetupPostCommitError(commit, error);
      }
      throw error;
    }
  }

  /**
   * Returns the per-scope-_instance_ key under which this runner tracks
   * `cell`'s document (`key-vocabulary.md` §1 site 2): two instances of one doc
   * may resolve to different patterns, so the key carries the shared scope key,
   * resolved against the runtime's own session (the OFF arm's one identity).
   */
  #getDocKey(cell: Cell<any>): `${MemorySpace}/${ScopeKey}/${URI}` {
    const { space, id, scope } = cell.getAsNormalizedFullLink();
    return `${space}/${
      resolveScopeKey(scope, this.#runtime.scopeKeyIdentity)
    }/${id}`;
  }

  /** Addresses setup evidence in the same instance as the caller's writes. */
  #getSetupKey(cell: Cell<unknown>): `${MemorySpace}/${ScopeKey}/${URI}` {
    if (
      !this.#runtime.servingPosture ||
      !this.#runtime.experimental.serverExecution
    ) {
      return this.#getDocKey(cell);
    }
    const { space, id, scope } = cell.getAsNormalizedFullLink();
    const identity = cell.tx?.tx.scopeKeyIdentity ??
      this.#runtime.scopeKeyIdentity;
    return `${space}/${resolveScopeKey(scope, identity)}/${id}`;
  }

  /**
   * Reports a piece-start setup/instantiation commit failure. Such a commit
   * is fire-and-forget by design but NEVER silent — loud in every arm, and
   * handed to the serving runtime's installed observer (the SpaceServer
   * counts it into serving-loop.md §7's structureLoadFailures).
   */
  #reportPieceStartCommitFailure(
    actionId: string,
    error: unknown,
  ): void {
    logger.error("piece-start-commit-failed", () => [
      `piece-start commit ${actionId} failed; the started graph's setup ` +
      "writes did not land (stage P2-F, F1)",
      error,
    ]);
    try {
      this.#runtime.pieceStartCommitFailureObserver?.({ actionId, error });
    } catch (observerError) {
      logger.warn("piece-start-commit-observer-failed", () => [
        "pieceStartCommitFailureObserver threw",
        observerError,
      ]);
    }
  }

  /**
   * The `system:` origin a child instantiated under `parent` claims, or
   * `undefined` when it claims none.
   *
   * A child claims one when the piece it is instantiated under follows a
   * `system:` origin and the child's module is one the runtime fetched from
   * the deployment's patterns route as part of that program — the same
   * ground on which the runtime claims the `system:` ref for the surfaces it
   * instantiates itself (`docs/specs/piece-source-lifecycle.md`, "Origins").
   * The caller asks only for a child in a space of its own.
   * Both halves are required: the module's name alone is author-controlled
   * (a locally compiled program may call a file anything), and it is the
   * followed parent that says the name was a route the runtime resolved.
   *
   * The parent is the piece a handler belongs to as much as the piece a
   * nested node sits in: a handler's result pattern runs into a receipt
   * cell that records no origin, so the search walks the demand-root chain
   * that receipt was started under.
   */
  #childSystemOrigin(
    tx: IExtendedStorageTransaction,
    parent: Cell<unknown>,
    child: Pattern | Module,
  ): string | undefined {
    const sourcePath = getPatternSourcePath(child);
    if (
      sourcePath === undefined || !sourcePath.startsWith(PATTERNS_ROUTE_PREFIX)
    ) {
      return undefined;
    }
    if (this.#ancestorSystemOrigin(tx, parent) === undefined) return undefined;
    return systemPatternSource(sourcePath.slice(PATTERNS_ROUTE_PREFIX.length));
  }

  /**
   * Helper for {@link Runner.#childSystemOrigin}, which finds the `system:`
   * origin `cell` or the nearest piece root it was started under records.
   */
  #ancestorSystemOrigin(
    tx: IExtendedStorageTransaction,
    cell: Cell<unknown>,
  ): string | undefined {
    const { space, id } = cell.getAsNormalizedFullLink();
    const roots = this.#demandRootChains.get(id) ?? [];
    for (const rootId of [id, ...roots]) {
      const candidate = rootId === id
        ? cell.withTx(tx)
        : this.#runtime.getCellFromLink(
          { id: rootId as URI, space, path: [] },
          undefined,
          tx,
        );
      const origin = getPatternSource(candidate);
      if (origin === undefined) continue;
      if (classifyPieceOriginString(origin).kind === "system") return origin;
    }
    return undefined;
  }

  /**
   * The demand-root CHAIN of a piece root: the roots of every ancestor piece
   * that instantiated it, ending in itself. Recorded when a piece starts under
   * a known parent (`RunnerRunOptions.parentPieceRootId`); a root started with
   * no parent (a top-level piece, or a resume whose parent is unknown) keeps
   * whatever chain an earlier parent-driven start recorded, else stands alone.
   * Only ever grows per root — a nested piece re-started standalone (a client
   * navigating to it) must not lose the outer demand it is also served under.
   */
  #demandRootChains = new Map<string, readonly string[]>();

  #demandRootChainFor(
    id: string,
    parentPieceRootId?: string,
  ): readonly string[] {
    const known = this.#demandRootChains.get(id);
    if (parentPieceRootId === undefined || parentPieceRootId === id) {
      return known ?? [id];
    }
    const parentChain = this.#demandRootChains.get(parentPieceRootId) ??
      [parentPieceRootId];
    const merged = new Set<string>([...(known ?? []), ...parentChain, id]);
    const chain = [...merged];
    this.#demandRootChains.set(id, chain);
    return chain;
  }

  /**
   * Returns the scheduler observation identity for a piece's result cell.
   * Pattern readers subscribe with this so the timing shapers can group and
   * rate-cap a pattern's wakes; without it, cell-flip shaping silently does not
   * apply to the piece. Its `pieceId` and owner space are derived purely from
   * the result cell, so they are available even when scheduler state is not
   * rehydrated. The pieceId bucket is per scope INSTANCE (key-vocabulary.md
   * §5's serving-identity sites): name-keyed buckets collapse shaper groups and
   * rate caps across principals — cross-principal budget consumption, and a
   * timing channel correlating one principal's activity with another's wakes.
   * Resolved against the runtime's own identity; partition-unchanged at
   * cardinality 1 (key-vocabulary.md §2 — the resolver also gives a scope-less
   * link the `space` key, the same instance by definition).
   */
  #schedulerObservationIdentity(
    resultCell: Cell<any>,
    parentPieceRootId?: string,
  ) {
    const { space, id, scope } = resultCell.getAsNormalizedFullLink();
    const demandRootIds = this.#demandRootChainFor(id, parentPieceRootId);
    return {
      pieceId: `${
        resolveScopeKey(scope, this.#runtime.scopeKeyIdentity)
      }:${id}`,
      ownerSpace: space,
      // The RAW root doc id, un-prefixed, for the per-(action × instance) run
      // supply: the scheduler resolves this piece's demanded instances through
      // it.
      pieceRootId: id,
      // Plus the ancestor roots that instantiated it — a nested piece is
      // demanded through the outer piece the client watches.
      ...(demandRootIds.length > 1 ? { demandRootIds } : {}),
    };
  }

  #schedulerRehydrationOptions(
    resultCell: Cell<any>,
    awaitSync?: boolean,
    parentPieceRootId?: string,
  ): SchedulerRehydrationSubscriptionOptions {
    const { space } = resultCell.getAsNormalizedFullLink();
    const observationIdentity = this.#schedulerObservationIdentity(
      resultCell,
      parentPieceRootId,
    );
    // Actions always re-run on resume. When resuming from a synced state,
    // hold the initial run until the space is synced so re-derivations read
    // confirmed-loaded inputs.
    return {
      observationIdentity,
      ...(awaitSync ? { awaitSyncBeforeInitialRun: { space } } : {}),
    };
  }

  /**
   * Loads the stored argument and what a setup staged over it reads of the
   * documents it links to, and returns a transaction guard for that state.
   * The argument document is named root-only: the meta link carries the
   * pattern's authored schema, and what the nodes read through the document
   * is named by their plans. Setup's proof that a supplied link stays
   * compatible reads each linked document and the result document of the
   * piece that owns it, so those are named root-only too, the owner through
   * the `result` backlink the linked document carries.
   */
  async syncStoredSetupArgument(
    resultCell: Cell<unknown>,
  ): Promise<(candidate: Cell<unknown>) => boolean> {
    await resultCell.sync();
    const argumentLink = getMetaLink(resultCell, "argument");
    if (argumentLink === undefined) {
      return (candidate) => getMetaLink(candidate, "argument") === undefined;
    }

    const argumentCell = this.#runtime.getCellFromLink({
      ...argumentLink,
      schema: undefined,
    });
    await argumentCell.sync();
    const argumentValue = argumentCell.getRawUntyped();
    await this.#syncStoredArgumentLinkTargets(argumentCell);
    return (candidate) => {
      const candidateLink = getMetaLink(candidate, "argument");
      if (
        candidateLink === undefined ||
        !areNormalizedLinksSame(candidateLink, argumentLink)
      ) {
        return false;
      }
      const candidateArgument = this.#runtime.getCellFromLink(
        candidateLink,
        undefined,
        candidate.tx,
      );
      return valueEqual(candidateArgument.getRawUntyped(), argumentValue);
    };
  }

  /**
   * Names, root-only, each document the stored argument at `argumentCell`
   * links to directly, and the result document of the piece that owns each,
   * reached through the `result` backlink the linked document carries once
   * it is local. Setup's proof that a supplied link stays compatible reads
   * both, and the gate that decides whether a run over a stored piece must
   * name its family first probes them. `argumentCell` is local already.
   */
  async #syncStoredArgumentLinkTargets(
    argumentCell: Cell<unknown>,
    identity?: ScopeKeyIdentity,
  ): Promise<void> {
    const targets: Cell<unknown>[] = [];
    const seen = new Set<unknown>();
    const collect = (value: unknown): void => {
      if (seen.has(value)) return;
      const link = parseLink(value, argumentCell);
      if (link !== undefined) {
        targets.push(
          this.#runtime.getCellFromLink({ ...link, schema: undefined }),
        );
        return;
      }
      // TODO(danfuzz): the walk stops at a `FabricSpecialObject`, so a link
      // inside a `FabricInstance` held in the stored argument is never named
      // here, and setup's proof over it reads a cold document.
      if (!isKeyableObjectOrArray(value)) return;
      seen.add(value);
      for (const key in value) collect(value[key]);
    };
    collect(argumentCell.getRawUntyped());
    const syncNamed = (cells: readonly Cell<unknown>[]): Promise<void> =>
      Promise.all(
        cells.map((cell) =>
          this.#syncFamilyCell(cell, identity).catch((error) => {
            logger.warn("stored-argument-links", () => [
              "a document the stored argument links to did not sync",
              error,
            ]);
          })
        ),
      ).then(() => {});
    await syncNamed(targets);
    const owners: Cell<unknown>[] = [];
    for (const target of targets) {
      const owner = getMetaLink(target, "result");
      if (owner !== undefined) {
        owners.push(
          this.#runtime.getCellFromLink({ ...owner, schema: undefined }),
        );
      }
    }
    await syncNamed(owners);
  }

  /**
   * Names what a setup or start of `pattern` over the stored piece at
   * `resultCell` reads and writes: the result document, the argument
   * document, what the pattern's nodes read through them, and the cells the
   * pattern owns. The store delivers none of these with the result document,
   * and a write to a document this replica has not loaded replaces the
   * document the store holds, so a caller staging a setup over a stored piece
   * names its family first. Resolves once the documents have arrived.
   */
  syncStoredPieceCells(
    resultCell: Cell<any>,
    pattern: Pattern | Module,
  ): Promise<void> {
    return this.#syncCellsForRunningPattern(
      resultCell,
      this.#resolveToPattern(pattern),
    ).then(() => {});
  }

  /**
   * Pre-syncs what a run of `pattern` on `resultCell` reads before it runs:
   * the result document, what each node's plan names under its read schema,
   * and the cells the pattern owns; on a fresh run the plans bind against an
   * immutable stand-in holding `inputs`. Resolves to whether the plans ran.
   * A syncer a test supplied wraps the whole step.
   */
  #syncCellsForRunningPattern(
    resultCell: Cell<any>,
    pattern: Pattern,
    inputs?: any,
    identity = resultCell.tx?.tx.scopeKeyIdentity,
  ): Promise<boolean> {
    const capturedIdentity = identity === undefined
      ? undefined
      : { ...identity };
    const sync: DependencySync = async (resultCell, pattern, inputs) => {
      const syncStart = performance.now();
      try {
        return await this.#syncCellsForRunningPatternInner(
          resultCell,
          pattern,
          inputs,
          capturedIdentity,
        );
      } finally {
        // Resume-boot decomposition: this is the dependency pre-sync a fresh
        // runtime pays before wiring a stored piece back up. Recorded under
        // the runner timing stats (they record even when the logger is
        // disabled) so load summaries can attribute slow storage-resume
        // boots.
        logger.time(syncStart, "start", "syncCellsForRunningPattern");
      }
    };
    const syncer = this.#dependencySyncer;
    return syncer === undefined
      ? sync(resultCell, pattern, inputs)
      : syncer(resultCell, pattern, inputs, sync);
  }

  /** Helper for `#syncCellsForRunningPattern()`, which does the syncing. */
  async #syncCellsForRunningPatternInner(
    resultCell: Cell<any>,
    pattern: Pattern,
    inputs?: any,
    identity?: ScopeKeyIdentity,
  ): Promise<boolean> {
    const resultSyncStart = performance.now();
    await this.#syncFamilyCell(resultCell, identity);
    if (resultCell.tx?.status().status !== "ready") {
      resultCell = resultCell.withTx(this.#familyReadTx(identity));
    }
    logger.time(resultSyncStart, "start", "resumeResultSync");

    const cells: Cell<any>[] = [];
    const plans: NodePlan[] = [];

    // The nodes bind against the piece's argument document once setup has
    // written it. Before that, on a fresh run, they bind against an
    // immutable stand-in holding the caller's argument: a data-URI document,
    // local by construction, whose links are the caller's, so a plan bound
    // against it names the same stored documents the run will read through
    // them. Planning resolves each node's output redirect chain, which reads
    // link metadata through a transaction; the plans only read, so it is
    // discarded afterward.
    const planTx = this.#runtime.edit();
    if (identity !== undefined) planTx.tx.scopeKeyIdentity = identity;
    const argumentMetaLink = getMetaLink(resultCell, "argument");
    const argumentLink = argumentMetaLink ??
      (inputs !== undefined
        ? this.#runtime
          .getImmutableCell(resultCell.space, inputs, undefined)
          .getAsNormalizedFullLink()
        : undefined);
    if (argumentLink === undefined) {
      // A resume finds the meta link on the result document, and a fresh run
      // supplies its argument; a start with neither has nothing to bind
      // against, which is worth a trace.
      logger.warn("resume-pre-sync", () => [
        "no argument to bind against; skipping node pre-sync",
        {
          resultCell: resultCell.getAsNormalizedFullLink().id,
          nodes: pattern.nodes.length,
        },
      ]);
    } else {
      const planned = this.#cellsPatternNodes(
        planTx,
        pattern,
        resultCell,
        argumentLink,
      );
      cells.push(...planned.cells);
      plans.push(...planned.plans);
      // The argument document itself, whole and under no schema: setup
      // reads it raw to write the argument over the slots it holds. The
      // node syncs above carry the narrower schemas the runs read through
      // it with; the meta link's own schema is the pattern's authored one,
      // which would pull everything the authored type reaches.
      if (argumentMetaLink !== undefined) {
        cells.push(
          this.#runtime.getCellFromLink({
            ...argumentMetaLink,
            schema: undefined,
          }),
        );
      }
    }

    // Sync the owned (derived internal) cells of this pattern and every nested
    // sub-pattern, to any depth, before instantiating. The setup re-derivation
    // and the sub-patterns' argument writes read these owned cells by value
    // (e.g. a child bound to the parent's list). On a cold-cache resume an
    // unsynced owned cell reads as absent and its read enters the instantiation
    // commit's conflict set, so when the durable value streams in the whole
    // batched instantiation commit loses and reverts — stranding the optimistic
    // writes that the resumed actions then depend on. Pulling them here keeps
    // that commit read-mostly.
    const instances: ResumePatternInstance[] = [];
    this.#collectResumeOwnedCells(
      pattern,
      resultCell,
      cells,
      new Set(),
      planTx,
      instances,
    );
    planTx.abort("resume node plans: read-only resolution");

    // Sync all the previously computed results.
    if (pattern.resultSchema !== undefined) {
      cells.push(resultCell.asSchema(pattern.resultSchema));
    }

    // If the result has a UI and it wasn't already included in the result
    // schema, sync it as well. This prevents the UI from flashing, because it's
    // first locally computed, then conflicts on write and only then properly
    // received from the server.
    if (
      isObjectOrArray(pattern.result) &&
      pattern.result[UI] &&
      (!isObjectOrArray(pattern.resultSchema) ||
        !pattern.resultSchema.properties?.[UI])
    ) {
      cells.push(resultCell.key(UI).asSchema(rendererVDOMSchema));
    }
    // Per-cell spans: `n` in the timing stats is the number of cells this
    // resume pre-synced, total/max its round-trip cost (spans overlap, so the
    // wall cost is bounded by the enclosing `#syncCellsForRunningPattern()`
    // span).
    const cellSyncWaveStart = performance.now();
    await Promise.all(cells.map((c) => {
      const cellSyncStart = performance.now();
      return this.#syncFamilyCell(c, identity).finally(() =>
        logger.time(cellSyncStart, "start", "resumeCellSync")
      );
    }));
    logger.time(cellSyncWaveStart, "start", "resumeCellSyncWave");

    await this.#syncCrossSpaceReads(plans, identity);

    // The list coordinators' children. The inputs their identities derive
    // from arrived above, so this cannot run any earlier, and it must finish
    // before instantiation runs those children.
    const followupSyncStart = performance.now();
    const listInstances = await this.#syncResumeListChildren(
      instances,
      identity,
    );
    logger.time(followupSyncStart, "start", "resumeFollowupSync");

    // The nested instances' own nodes, whose plans need each instance's
    // argument link, data on the result document the steps above named. The
    // root's nodes were planned above.
    const instanceNodesStart = performance.now();
    await this.#syncResumeInstanceNodes(
      [...instances.slice(1), ...listInstances],
      identity,
    );
    logger.time(instanceNodesStart, "start", "resumeInstanceNodesSync");

    // What setup reads of the stored argument beyond its own bytes: the
    // documents it links to, and their owners, named root-only. Last, so a
    // document a plan reads under a narrowed schema is asked for under that
    // schema first and this naming finds it local.
    if (argumentMetaLink !== undefined) {
      const argumentLinksStart = performance.now();
      await this.#syncStoredArgumentLinkTargets(
        this.#runtime.getCellFromLink({
          ...argumentMetaLink,
          schema: undefined,
        }),
        identity,
      );
      logger.time(argumentLinksStart, "start", "resumeArgumentLinksSync");
    }

    return true;
  }

  /**
   * The cells to sync for what `pattern`'s nodes on `resultCell` read and
   * write, each node planned against `argumentLink`. A node whose bindings
   * cannot be bound contributes nothing rather than breaking the pre-sync;
   * it is logged, so a resume that silently skips a node's pre-sync is
   * diagnosable.
   */
  #cellsPatternNodes(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    resultCell: Cell<any>,
    argumentLink: NormalizedFullLink,
  ): { cells: Cell<any>[]; plans: NodePlan[] } {
    const cells: Cell<any>[] = [];
    const plans: NodePlan[] = [];
    for (const node of pattern.nodes) {
      let plan: NodePlan | undefined;
      try {
        plan = this.#nodePlan(
          tx,
          node,
          resultCell,
          pattern,
          undefined,
          argumentLink,
        );
      } catch (error) {
        logger.warn("resume-pre-sync", () => [
          "skipping a node whose bindings did not unwrap",
          error,
        ]);
        continue;
      }
      if (plan === undefined) continue;
      plans.push(plan);
      // Each node's plan, synced under the schema its run reads through. The
      // inputs document is a data URI, so syncing it under a schema hands the
      // server one selector per binding link, and the server's query walk
      // follows links from there the way a read does: as deep as the
      // declaration goes, through `asCell` positions, stopping at an opaque
      // one. What arrives is what the node's first run reads.
      cells.push(...this.#cellsNodePlanReads(plan, resultCell));
      // What the node writes through, under the output binding's schema.
      for (const link of plan.writes) {
        cells.push(this.#runtime.getCellFromLink(link));
      }
    }
    return { cells, plans };
  }

  /**
   * The schema a plan's node reads its inputs document under, or undefined
   * for a node whose inputs no schema of its own describes: a pattern node's
   * are read by the child's plans, a passthrough node's are copied whole.
   */
  #planReadSchema(plan: NodePlan): JSONSchema | undefined {
    switch (plan.kind) {
      case "javascript":
        return schemaWithoutEventSlot(plan.module.argumentSchema);
      case "raw":
        return plan.module.argumentSchema;
      case "passthrough":
      case "pattern":
        return undefined;
    }
  }

  /**
   * Names what the plans' reads reach in other spaces. The server's query
   * walk delivers what a plan's selector reaches within its space and stops
   * at a link into another, so after the plan syncs land this reads each
   * plan's inputs under its read schema through a read transaction: a read
   * that dead-ends on such a link kicks that document's load. Pending loads
   * for documents the transaction read are awaited before the next read,
   * which reaches one space further. Each round awaits only loads no
   * earlier round awaited, by document, so a link whose target never arrives,
   * kicked again by every read, ends the pass rather than extending it, and a round
   * whose reads leave no new load pending ends it. The manager's settled
   * pool is not what is awaited: on a client it holds the runtime's other
   * work, sinks' first loads and coordinators' republishes among it, which
   * a resume must not wait behind.
   */
  async #syncCrossSpaceReads(
    plans: readonly NodePlan[],
    identity: ScopeKeyIdentity | undefined,
  ): Promise<void> {
    const manager = this.#runtime.storageManager;
    if (!manager.loadsSettled || !manager.pendingLoadAddresses) return;
    const awaited = new Set<string>();
    for (;;) {
      const readTx = this.#familyReadTx(identity);
      for (const plan of plans) {
        if (plan.kind === "pattern") continue;
        const schema = this.#planReadSchema(plan);
        if (schema === undefined) continue;
        try {
          plan.inputsCell.asSchema(schema).withTx(readTx).get();
        } catch (error) {
          // A read a cold document cannot satisfy kicks its load all the
          // same; the next round reads it warm.
          logger.debug("resume-pre-sync", () => [
            "a cross-space read of a plan's inputs did not resolve",
            error,
          ]);
        }
      }
      const pending = manager.pendingLoadAddresses();
      if (pending.length === 0) return;
      const readIdentity = identity ?? this.#runtime.scopeKeyIdentity;
      const readKeys = new Set<string>();
      for (const read of getTransactionReadActivities(readTx)) {
        if (
          read.scopeKey !== undefined ||
          canResolveScopeKey(read.scope, readIdentity)
        ) {
          readKeys.add(entityKey(read, readIdentity));
        }
      }
      const keys = pending
        .map((address) => entityKey(address, this.#runtime.scopeKeyIdentity))
        .filter((key) => readKeys.has(key) && !awaited.has(key));
      if (keys.length === 0) return;
      for (const key of keys) awaited.add(key);
      const settleStart = performance.now();
      try {
        await manager.loadsSettled(keys);
      } catch (error) {
        // A load that failed leaves its document absent; the next round
        // reads past it, and the run reads the same absence.
        logger.debug("resume-pre-sync", () => [
          "a load a cross-space read kicked did not land",
          error,
        ]);
      }
      logger.time(settleStart, "start", "resumeCrossSpaceSettle");
    }
  }

  /**
   * Names what the nested instances' nodes read, level by level. An
   * instance's plans need its argument document's link, which is data on
   * its result document, delivered by the wave that named that document.
   * Each round plans every instance whose argument link is readable and
   * not yet planned, and syncs together what those plans name, the child
   * result cells of the instance's pattern nodes among them, which is what
   * lets the next round plan the level below. A round that plans nothing
   * ends the walk: an instance whose result document never arrived is left
   * unplanned rather than holding the resume, and its own start names what
   * it needs.
   */
  async #syncResumeInstanceNodes(
    instances: readonly ResumePatternInstance[],
    identity: ScopeKeyIdentity | undefined,
  ): Promise<void> {
    const pending = new Map<string, ResumePatternInstance>();
    for (const instance of instances) {
      const link = instance.resultCell.getAsNormalizedFullLink();
      pending.set(
        `${link.space}\0${link.id}\0${link.scope ?? "space"}`,
        instance,
      );
    }
    while (pending.size > 0) {
      const cells: Cell<any>[] = [];
      const plans: NodePlan[] = [];
      const planTx = this.#runtime.edit();
      if (identity !== undefined) planTx.tx.scopeKeyIdentity = identity;
      try {
        for (const [key, { pattern, resultCell }] of pending) {
          const argumentLink = getMetaLink(resultCell, "argument");
          if (argumentLink === undefined) continue;
          pending.delete(key);
          const planned = this.#cellsPatternNodes(
            planTx,
            pattern,
            resultCell,
            argumentLink,
          );
          cells.push(...planned.cells);
          plans.push(...planned.plans);
          cells.push(
            this.#runtime.getCellFromLink({
              ...argumentLink,
              schema: undefined,
            }),
          );
        }
      } finally {
        planTx.abort("resume instance nodes: read-only planning");
      }
      if (cells.length === 0) return;
      const waveStart = performance.now();
      await Promise.all(
        cells.map((cell) =>
          this.#syncFamilyCell(cell, identity).catch((error) => {
            logger.warn("resume-pre-sync", () => [
              "instance node sync failed; resuming without it",
              error,
            ]);
          })
        ),
      );
      logger.time(waveStart, "start", "resumeInstanceNodeSyncWave");
      await this.#syncCrossSpaceReads(plans, identity);
    }
  }

  /**
   * The cells to sync for what a node's first run reads: its inputs document
   * under the node's read schema, and for a handler node the stream document
   * its `$event` slot names. A pattern node names its child result cell
   * under the child's result schema and nothing of its inputs: the child's
   * own nodes read through them, and are planned once that document is
   * local (`#syncResumeInstanceNodes`).
   */
  #cellsNodePlanReads(plan: NodePlan, resultCell: Cell<any>): Cell<any>[] {
    switch (plan.kind) {
      case "javascript": {
        const cells = [
          plan.inputsCell.asSchema(
            schemaWithoutEventSlot(plan.module.argumentSchema),
          ),
        ];
        // A handler node's `$event` slot names its stream's document through
        // a redirect chain. Instantiation registers on the slot's link and
        // reads nothing behind it; a send resolves every hop, so each is
        // named here, and named whole: it is not a value the module schema
        // describes.
        if (isObjectOrArray(plan.inputs) && "$event" in plan.inputs) {
          for (
            const streamLink of findAllWriteRedirectCells(
              plan.inputs.$event,
              resultCell,
            )
          ) {
            cells.push(
              this.#runtime.getCellFromLink({
                ...streamLink,
                schema: undefined,
              }),
            );
          }
        }
        return cells;
      }
      case "raw":
        return [plan.inputsCell.asSchema(plan.module.argumentSchema)];
      case "passthrough":
        return [plan.inputsCell];
      case "pattern":
        return plan.childResultCell === undefined ? [] : [plan.childResultCell];
    }
  }

  /**
   * Pull what the list coordinators' slot resolutions end on, to their
   * ends. Each round resolves every slot the way the plan does and syncs
   * the documents those resolutions end on; a round that ends where the
   * previous one did is the fixpoint, which every finite chain reaches: a
   * document is synced once, so each round either exposes a document no
   * round has synced or is the last. A list whose entity is not yet local
   * is synced as such, so the next round can read its slots.
   *
   * The resolver bounds a chain at `MAX_PATH_RESOLUTION_LENGTH` hops, and
   * so does this walk: a chain still moving at that depth is one the
   * coordinator's own resolution will refuse, and the nodes it belongs to
   * are returned so no child is derived from an incomplete identity. The
   * returned keys are the instance's result cell key and the node's index,
   * joined by `#`.
   */
  async #syncListSlotResolutions(
    instances: readonly ResumePatternInstance[],
    identity: ScopeKeyIdentity | undefined,
  ): Promise<Set<string>> {
    const synced = new Set<string>();
    for (let round = 0;; round++) {
      const fresh: Cell<any>[] = [];
      const moving = new Set<string>();
      const planTx = this.#runtime.edit();
      if (identity !== undefined) planTx.tx.scopeKeyIdentity = identity;
      try {
        for (const { pattern, resultCell: storedCell } of instances) {
          const resultCell = storedCell.withTx(planTx);
          if (getMetaLink(resultCell, "argument") === undefined) continue;
          const instanceLink = resultCell.getAsNormalizedFullLink();
          const instanceKey = `${instanceLink.space}\0${instanceLink.id}\0${
            instanceLink.scope ?? "space"
          }`;
          for (const [nodeIndex, node] of pattern.nodes.entries()) {
            const module = node.module;
            if (!isModule(module) || module.type !== "ref") continue;
            const op = module.implementation;
            if (op !== "map" && op !== "filter" && op !== "flatMap") continue;
            let links: NormalizedFullLink[];
            try {
              const resolved = this.#runtime.moduleRegistry.getModule(
                op,
                module.defaultScope,
              );
              const { inputsCell } = this.#buildRawNodeInputs(
                planTx,
                resolved,
                node.inputs,
                node.outputs,
                resultCell,
                pattern,
                op,
              );
              const { listCell, rawList, slots } = listSlotResolutions(
                this.#runtime,
                planTx,
                inputsCell,
              );
              links = rawList === undefined
                ? [listCell.getAsNormalizedFullLink()]
                : slots;
            } catch (error) {
              logger.debug("resume-list-children", () => [
                "skipping a list node whose slots could not be resolved",
                error,
              ]);
              continue;
            }
            for (const link of links) {
              const key = `${link.space}\0${link.id}\0${link.scope ?? "space"}`;
              if (synced.has(key)) continue;
              synced.add(key);
              fresh.push(this.#runtime.getCellFromLink(link));
              moving.add(`${instanceKey}#${nodeIndex}`);
            }
          }
        }
      } finally {
        planTx.abort("resume list slots: read-only resolution");
      }
      if (fresh.length === 0) return new Set();
      if (round >= MAX_PATH_RESOLUTION_LENGTH) {
        logger.warn("resume-list-children", () => [
          "list slot chains still unresolved at the resolver's bound; " +
          "their coordinators' children are not derived",
          { rounds: round, nodes: moving.size },
        ]);
        return moving;
      }
      const syncWaveStart = performance.now();
      await Promise.all(fresh.map((cell) => {
        const syncStart = performance.now();
        return this.#syncFamilyCell(cell, identity)
          .catch((error) => {
            logger.warn("resume-list-children", () => [
              "list slot resolution sync failed; resuming without it",
              error,
            ]);
          })
          .finally(() =>
            logger.time(syncStart, "start", "resumeListChildSync")
          );
      }));
      logger.time(
        syncWaveStart,
        "start",
        "resumeListSlotResolutionSyncWave",
      );
    }
  }

  /**
   * Name the children the pattern tree's list coordinators (map/filter/
   * flatMap) will run, before anything instantiates.
   *
   * A coordinator resumes its durable children from inside its own
   * scheduler run, synchronously: `run()` instantiates the child in the
   * coordinator's transaction, and instantiation reads the child's
   * execution family — its argument document and its derived internal
   * cells among them. A child a subscription
   * merely reached arrives without that family, so the family is named
   * here, where every other resume dependency is: naming a child's result
   * document delivers the family, and the coordinator's synchronous start
   * — inside its scheduler transaction, under that transaction's retry
   * envelope — then reads what it needs.
   *
   * Which children a coordinator will run is derived exactly as the
   * coordinator derives it (`listCoordinatorPlan`, shared with its
   * reconcile) — from inputs that are LOCAL to the same depth the
   * coordinator's own derivation will read them. An element's key is the
   * value resolution of its slot (`listSlotResolutions`), and that chase
   * ends wherever the replica goes cold: a slot holding a cell whose stored
   * value redirects to a piece keys the element on the piece when warm and
   * on the cell when cold, and a child keyed on the cold chase is one the
   * warm coordinator never mints. So each round first pulls what every
   * coordinator's slot resolutions end on, until a round ends where the
   * last one did — the cells the coordinator's reconcile reads as well, so
   * it reads them warm rather than at seq 0. Each child is then
   * a resumed instance like any other: the cells it owns — its derived
   * internal cells, and those of the sub-patterns nested in it — are
   * collected the way the owned-cell walk collects them for the root, so
   * a child's first run reads them warm rather than entering the commit
   * basis at seq 0 (the one cold read a populated home's reload otherwise
   * makes per element). A child's own coordinators are handled in turn
   * once its family has landed, so the reach is the tree's depth. A node
   * whose plan cannot be derived — inputs not yet readable, an unresolvable
   * op — contributes nothing rather than failing the resume; the
   * coordinator's own reconcile holds for such inputs. Returns the child
   * instances it named, and the instances nested in them, for the caller's
   * pass over their nodes.
   */
  async #syncResumeListChildren(
    instances: readonly ResumePatternInstance[],
    identity: ScopeKeyIdentity | undefined,
  ): Promise<ResumePatternInstance[]> {
    const namedInstances: ResumePatternInstance[] = [];
    const named = new Set<string>();
    // The owned-cell walk's own dedup: an instance the root walk already
    // visited is not collected again here.
    const walked = new Set<string>();
    for (const { resultCell } of instances) {
      const link = resultCell.getAsNormalizedFullLink();
      walked.add(`${link.space}\0${link.id}\0${link.scope ?? "space"}`);
    }
    let frontier = [...instances];
    while (frontier.length > 0) {
      const unsettled = await this.#syncListSlotResolutions(frontier, identity);
      const next: ResumePatternInstance[] = [];
      const promises: Promise<unknown>[] = [];
      const planTx = this.#runtime.edit();
      if (identity !== undefined) planTx.tx.scopeKeyIdentity = identity;
      try {
        for (const { pattern, resultCell: storedCell } of frontier) {
          const resultCell = storedCell.withTx(planTx);
          // A fresh first run has no argument meta yet; nothing durable is
          // resumed under it.
          if (getMetaLink(resultCell, "argument") === undefined) continue;
          const instanceLink = resultCell.getAsNormalizedFullLink();
          const instanceKey = `${instanceLink.space}\0${instanceLink.id}\0${
            instanceLink.scope ?? "space"
          }`;
          for (const [nodeIndex, node] of pattern.nodes.entries()) {
            const module = node.module;
            if (!isModule(module) || module.type !== "ref") continue;
            const op = module.implementation;
            if (op !== "map" && op !== "filter" && op !== "flatMap") continue;
            // A chain the resolver's bound cut short keys nothing: the
            // coordinator's own derivation refuses it too.
            if (unsettled.has(`${instanceKey}#${nodeIndex}`)) continue;
            let children: Cell<any>[];
            let opPattern: Pattern;
            try {
              const resolved = this.#runtime.moduleRegistry.getModule(
                op,
                module.defaultScope,
              );
              const { inputsCell, outputBinding } = this.#buildRawNodeInputs(
                planTx,
                resolved,
                node.inputs,
                node.outputs,
                resultCell,
                pattern,
                op,
              );
              const plan = listCoordinatorPlan(
                this.#runtime,
                planTx,
                op,
                inputsCell,
                LIST_OP_INPUT_SCHEMAS[op],
                resultCell,
                outputBinding,
              );
              opPattern = plan.opPattern;
              children = [...plan.elementKeys.values()].map((elementKey) =>
                listElementResultCell(
                  this.#runtime,
                  planTx,
                  op,
                  plan.container,
                  elementKey,
                )
              );
            } catch (error) {
              logger.debug("resume-list-children", () => [
                "skipping a list node whose children could not be derived",
                error,
              ]);
              continue;
            }
            for (const child of children) {
              const link = child.getAsNormalizedFullLink();
              const key = `${link.space}\0${link.id}\0${link.scope ?? "space"}`;
              if (named.has(key)) continue;
              named.add(key);
              // Unbound from the derivation transaction: the sync and the
              // next round outlive it.
              const unbound = this.#runtime.getCellFromLink(link);
              const syncStart = performance.now();
              promises.push(
                this.#syncFamilyCell(unbound, identity)
                  .catch((error) => {
                    logger.warn("resume-list-children", () => [
                      "list child sync failed; resuming without it",
                      error,
                    ]);
                  })
                  .finally(() =>
                    logger.time(syncStart, "start", "resumeListChildSync")
                  ),
              );
              // The child's owned cells, and the instances nested in it —
              // those join the next round for the coordinators they hold.
              const owned: Cell<any>[] = [];
              const nested: ResumePatternInstance[] = [];
              this.#collectResumeOwnedCells(
                opPattern,
                unbound,
                owned,
                walked,
                planTx,
                nested,
              );
              for (const cell of owned) {
                const ownedLink = cell.getAsNormalizedFullLink();
                const ownedKey = `${ownedLink.space}\0${ownedLink.id}\0${
                  ownedLink.scope ?? "space"
                }`;
                if (named.has(ownedKey)) continue;
                named.add(ownedKey);
                const ownedStart = performance.now();
                promises.push(
                  this.#syncFamilyCell(cell, identity)
                    .catch((error) => {
                      logger.warn("resume-list-children", () => [
                        "list child owned-cell sync failed; resuming without it",
                        error,
                      ]);
                    })
                    .finally(() =>
                      logger.time(ownedStart, "start", "resumeListChildSync")
                    ),
                );
              }
              next.push(...nested);
              namedInstances.push(...nested);
            }
          }
        }
      } finally {
        planTx.abort("resume list children: read-only derivation");
      }
      const syncWaveStart = performance.now();
      await Promise.all(promises);
      logger.time(syncWaveStart, "start", "resumeListChildSyncWave");
      frontier = next;
    }
    return namedInstances;
  }

  /**
   * Walks the pattern tree — this pattern and every nested sub-pattern — and
   * collects each one's owned (derived internal) cells into `out`, so the
   * resume pre-sync pulls them before instantiation reads them. A sub-pattern
   * node's result cell is the cell reserved by the node's resolved output spot,
   * the same `resultFor` identity `instantiatePatternNode()` mints; deriving
   * owned cells from it matches what the child's setup will use. The `seen` set
   * keys on the result cell to bound the walk against a cyclic reference. This
   * only pulls cells, so a node shape it cannot resolve contributes nothing
   * rather than misbehaving.
   */
  #collectResumeOwnedCells(
    pattern: Pattern,
    resultCell: Cell<any>,
    out: Cell<any>[],
    seen: Set<string>,
    tx: IExtendedStorageTransaction,
    // Every (pattern, result cell) the walk visits, for the pre-sync's
    // second pass over the list coordinators those patterns hold.
    visited?: ResumePatternInstance[],
  ): void {
    resultCell = resultCell.withTx(tx);
    const link = resultCell.getAsNormalizedFullLink();
    const key = `${link.space}\0${link.id}\0${link.scope ?? "space"}`;
    if (seen.has(key)) return;
    seen.add(key);
    visited?.push({ pattern, resultCell });

    for (const descriptor of pattern.derivedInternalCells ?? []) {
      out.push(getDerivedInternalCell(resultCell, descriptor));
    }

    for (const [nodeIndex, node] of pattern.nodes.entries()) {
      const module = node.module;
      if (module.type !== "pattern" || !isPattern(module.implementation)) {
        continue;
      }
      const childPattern = module.implementation;
      // The child's result cell, derived exactly as its instantiation mints
      // it: the plan resolves the node's output spot to its end, so a
      // multi-hop binding yields the same `resultFor` identity the child's
      // setup mints rather than the unresolved head.
      let plan: NodePlan | undefined;
      try {
        plan = this.#nodePlan(tx, node, resultCell, pattern);
      } catch (error) {
        // A node whose outputs cannot be bound (e.g. they alias the argument
        // doc while the argument link is unavailable) or resolved contributes
        // nothing rather than breaking the resume walk; log it so a resume
        // that silently skips its owned-cell pre-sync is diagnosable.
        logger.warn("resume-owned-cells", () => [
          "skipping a sub-pattern node whose outputs did not bind or resolve",
          error,
          describeSkippedSubPatternNode(link, nodeIndex, node, childPattern),
        ]);
        continue;
      }
      if (plan?.kind !== "pattern") continue;
      if (plan.childResultCell === undefined) {
        // The same two skips as the catch above — this node's owned-cell
        // pre-sync AND the recursion that would reach the child's own
        // `derivedInternalCells` manifest — reached without an error: the
        // outputs bound, but held no write redirect the scan could resolve
        // (outputs consisting only of partialCause aliases still deferred to
        // a deeper level, say). Instantiation refuses the same node, since
        // it has nothing to anchor the child's identity on, so a healthy run
        // never takes this exit; a pattern that does reach it fails at its
        // own start.
        //
        // DEBUG, not warn: the start that follows reports the refusal itself.
        // The exit still hides a skipped subtree, so it carries the same key
        // and the same identity payload as its sibling, and turning this
        // logger up to debug brings it back for someone tracing a stranded
        // piece:
        // `commonfabric.logger["runner"].level = "debug"` on the main thread,
        // `commonfabric.rt.setLoggerLevel("debug", "runner")` for the worker
        // the runner actually lives in. (`CF_LOG_LEVEL` will NOT do it: it is a
        // floor, and this logger's own configured level — `warn` — is the more
        // restrictive of the two.) A console filter on `resume-owned-cells`
        // then catches both exits. `resume-owned-cells-skip-log.test.ts` pins
        // the level in both directions.
        logger.debug("resume-owned-cells", () => [
          "skipping a sub-pattern node whose outputs resolved to no write redirect",
          describeSkippedSubPatternNode(link, nodeIndex, node, childPattern),
        ]);
        continue;
      }
      this.#collectResumeOwnedCells(
        plan.child,
        plan.childResultCell,
        out,
        seen,
        tx,
        visited,
      );
    }
  }

  /**
   * Whether the piece owning `resultCell` has a pattern graph installed
   * right now.
   *
   * A piece is registered from the moment its start walk runs, and the
   * instantiation commit that graph was built in settles afterwards. A
   * refused commit retires the graph while the registration stands, so a
   * caller deciding what the piece can serve — the scheduler, holding an
   * event for a stream it finds no handler on — asks this rather than
   * reading the start's outcome.
   *
   * @param resultCell - The result doc or cell of the piece to ask about.
   */
  pieceGraphIsInstalled<T>(resultCell: Cell<T>): boolean {
    return this.#cancels.get(this.#getDocKey(resultCell))
      ?.graphIsInstalled() ===
      true;
  }

  /**
   * Whether a graph is registered for `resultCell`'s document: the piece is
   * running, and a start would return on its fast path without touching the
   * stored doc. A subpath cell stands for its root document.
   */
  isRunning<T>(resultCell: Cell<T>): boolean {
    const link = resultCell.getAsNormalizedFullLink();
    const rootCell = link.path.length > 0
      ? this.#runtime.getCellFromLink({ ...link, path: [] })
      : resultCell;
    return this.#cancels.has(this.#getDocKey(rootCell));
  }

  /**
   * Stop a pattern. This will cancel the pattern and all its children.
   *
   * TODO: This isn't a good strategy, as other instances might depend on behavior
   * provided here, even if the user might no longer care about e.g. the UI here.
   * A better strategy would be to schedule based on effects and unregister the
   * effects driving execution, e.g. the UI.
   *
   * @param resultCell - The result doc or cell to stop.
   */
  stop<T>(resultCell: Cell<T>): void {
    // An unresolved link start does not know its target yet, so it cannot be
    // indexed under the target's key. An explicit stop records the target on
    // every active attempt that has not discovered it; an attempt that later
    // resolves to the target observes the tombstone and terminates. The
    // tombstone lives only on the active token and is released when that start
    // settles. This step is what makes a stop authoritative over a start still
    // resolving; releaseChild() calls stopResult() directly and leaves such a
    // start to resolve into a result of its own.
    const key = this.#getDocKey(resultCell);
    for (const attempt of this.#activeStartAttempts) {
      if (!attempt.generationsByDoc.has(key)) {
        attempt.preResolutionStopKeys.add(key);
      }
    }
    this.#stopResult(resultCell);
  }

  #stopResult<T>(resultCell: Cell<T>): void {
    this.#runtime.sourceReconciler.unwatch(resultCell);
    const key = this.#getDocKey(resultCell);
    const setupKey = this.#getSetupKey(resultCell);
    this.#scopedChildOwners.delete(key);
    this.#independentlyStartedResults.delete(key);
    // TODO(hixie): This reaches every pending commit-gated start for the result,
    // which is wider than a release's authority: one that another launch
    // scheduled goes too. Narrowing it needs the release to name the pending
    // start its own launch created, the way it already names the registration
    // it installed.
    this.#cancelPendingDeferredStarts(key);
    if ((this.#activeStartAttemptsByDoc.get(key)?.size ?? 0) > 0) {
      this.#startGenerationByDoc.set(
        key,
        (this.#startGenerationByDoc.get(key) ?? 0) + 1,
      );
    } else {
      // No asynchronous continuation can observe this generation. Avoid
      // retaining one entry per stopped piece for the runtime's lifetime.
      this.#startGenerationByDoc.delete(key);
    }
    const cancel = this.#cancels.get(key);
    try {
      cancel?.();
    } finally {
      this.#cancels.delete(key);
      this.#locallyCommittedHandlerResultStarts.delete(key);
      if (cancel !== undefined) {
        this.#allCancels.delete(cancel);
        // Only a piece that was actually running is safe to restart from its
        // already-assembled local cells. Stopping an unresolved/storage-only
        // target must not bypass dependency sync and snapshot rehydration on a
        // later explicit start.
        // A keyless piece's pointer is session-side (never stamped durably),
        // so fall through to it.
        const stoppedIdentity = getPatternIdentityRef(resultCell) ??
          this.#sessionPatternPointer(resultCell);
        if (stoppedIdentity !== undefined) {
          this.#locallyStoppedResults.set(
            setupKey,
            patternIdentityKey(stoppedIdentity),
          );
        } else {
          this.#locallyStoppedResults.delete(setupKey);
        }
      }
    }
  }

  #trackStartAttempt(attempt: StartAttempt, key: string): void {
    if (attempt.generationsByDoc.has(key)) return;
    attempt.generationsByDoc.set(
      key,
      this.#startGenerationByDoc.get(key) ?? 0,
    );
    let active = this.#activeStartAttemptsByDoc.get(key);
    if (active === undefined) {
      active = new Set();
      this.#activeStartAttemptsByDoc.set(key, active);
    }
    active.add(attempt);
  }

  #finishStartAttempt(attempt: StartAttempt): void {
    this.#activeStartAttempts.delete(attempt);
    for (const key of attempt.generationsByDoc.keys()) {
      if (this.#inFlightStartsByDoc.get(key) === attempt) {
        this.#inFlightStartsByDoc.delete(key);
      }
      const active = this.#activeStartAttemptsByDoc.get(key);
      if (!active?.delete(attempt)) continue;
      if (active.size === 0) {
        this.#activeStartAttemptsByDoc.delete(key);
        this.#startGenerationByDoc.delete(key);
      }
    }
    attempt.generationsByDoc.clear();
    attempt.preResolutionStopKeys.clear();
  }

  #isStartAttemptCurrent(attempt: StartAttempt): boolean {
    if (attempt.lifecycleEpoch !== this.#lifecycleEpoch) return false;
    for (const [key, generation] of attempt.generationsByDoc) {
      if (attempt.preResolutionStopKeys.has(key)) return false;
      if ((this.#startGenerationByDoc.get(key) ?? 0) !== generation) {
        return false;
      }
    }
    return true;
  }

  /**
   * True when the attempt's view of one doc is still current: the doc was
   * discovered, and no stop has tombstoned it or moved its generation since.
   * The whole-attempt check above ranges over every doc a link chain visited,
   * which is the right guard while the cascade is still resolving; claiming
   * the target's lifetime at settle time asks about the target alone, because
   * a stop of an intermediate link doc does not touch the target's
   * registration.
   */
  #isStartAttemptCurrentFor(
    attempt: StartAttempt,
    key: `${MemorySpace}/${ScopeKey}/${URI}`,
  ): boolean {
    if (attempt.lifecycleEpoch !== this.#lifecycleEpoch) return false;
    if (attempt.preResolutionStopKeys.has(key)) return false;
    const generation = attempt.generationsByDoc.get(key);
    return generation !== undefined &&
      (this.#startGenerationByDoc.get(key) ?? 0) === generation;
  }

  /**
   * Settle in-flight pointer roll-forward COMMITS — bounded local work,
   * awaited by dispose() before the storage sessions they write through
   * close. Deliberately excludes watcher pattern LOADS: a load can be
   * arbitrarily slow or wedged, and its post-settle work is already
   * lifecycle-epoch-guarded.
   */
  async settlePointerCommits(): Promise<void> {
    while (this.#pendingPointerCommits.size > 0) {
      await Promise.allSettled([...this.#pendingPointerCommits]);
    }
  }

  /**
   * TESTS ONLY: settle in-flight watcher pattern loads AND any pointer
   * roll-forward commits they spawn; loops because a roll-forward is
   * created inside its load chain. The deterministic synchronization point
   * under the frozen-clock preload, where wall-clock polling cannot observe
   * this work. Never called from dispose() — a held load would hang
   * teardown.
   */
  async idlePointerMaintenance(): Promise<void> {
    while (
      this.#pendingWatcherPatternLoads.size > 0 ||
      this.#pendingPointerCommits.size > 0
    ) {
      await Promise.allSettled([
        ...this.#pendingWatcherPatternLoads,
        ...this.#pendingPointerCommits,
      ]);
    }
  }

  /**
   * TESTS ONLY: settle in-flight catch-up recoveries of commit-gated starts
   * (see `#catchUpAndStartOnStaleRead()`). Loops in case a settled
   * recovery's continuation schedules another. Never called from dispose():
   * the readiness gate a recovery awaits is a session catch-up, which a
   * closing runtime need never reach — a cancelled ownership is what stops
   * the work there.
   */
  async idleDeferredStartCatchUps(): Promise<void> {
    while (this.#pendingDeferredStartCatchUps.size > 0) {
      await Promise.allSettled([...this.#pendingDeferredStartCatchUps]);
    }
  }

  /**
   * TESTS ONLY: settle self-minted piece-instantiation commits and any
   * one-shot recovery they schedule. Never called from dispose(): a readiness
   * gate or serving wave can remain open until its host closes or abandons it,
   * while lifecycle guards already prevent a settled continuation from
   * reviving stopped work.
   */
  async idlePieceInstantiationSettlements(): Promise<void> {
    while (this.#pendingPieceInstantiationSettlements.size > 0) {
      await Promise.allSettled([
        ...this.#pendingPieceInstantiationSettlements,
      ]);
    }
  }

  stopAll(): void {
    // Invalidate every asynchronous start continuation before canceling live
    // registrations. In-flight snapshot listings may still resolve after
    // storage teardown, but they can neither publish a cache nor call
    // `#startCore()` under the new epoch.
    this.#lifecycleEpoch++;
    // The epoch change already makes every held attempt non-current, so no
    // later start can join one; dropping the index releases the attempts too.
    this.#inFlightStartsByDoc.clear();
    this.#independentlyStartedResults.clear();
    for (const key of [...this.#pendingDeferredStarts.keys()]) {
      this.#cancelPendingDeferredStarts(key);
    }
    this.#pendingDeferredStarts.clear();
    // Cancel all tracked operations
    for (const cancel of this.#allCancels) {
      try {
        cancel();
      } catch (error) {
        console.warn("Error canceling operation:", error);
      }
    }
    this.#allCancels.clear();
    this.#cancels.clear();
    this.#scopedChildOwners.clear();
    // Clear the result pattern cache as well, since the actions have been
    // canceled
    this.#resultPatternCache.clear();
    this.#locallyPreparedResults.clear();
    this.#locallyStoppedResults.clear();
    this.#locallyCommittedHandlerResultStarts.clear();
    this.#startGenerationByDoc.clear();
    this.#activeStartAttemptsByDoc.clear();
    for (const attempt of this.#activeStartAttempts) {
      attempt.generationsByDoc.clear();
      attempt.preResolutionStopKeys.clear();
    }
    this.#activeStartAttempts.clear();
  }

  #instantiateNode(
    tx: IExtendedStorageTransaction,
    node: Node,
    resultCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
  ) {
    const plan = this.#nodePlan(tx, node, resultCell, pattern);
    if (plan === undefined) return;
    switch (plan.kind) {
      case "javascript":
        this.#instantiateJavaScriptNode(
          tx,
          plan,
          resultCell,
          addCancel,
          pattern,
          schedulerRehydration,
        );
        break;
      case "raw":
        this.#instantiateRawNode(
          tx,
          plan,
          resultCell,
          addCancel,
          pattern,
          schedulerRehydration,
        );
        break;
      case "passthrough":
        this.#instantiatePassthroughNode(
          tx,
          plan,
          resultCell,
          addCancel,
          pattern,
          schedulerRehydration,
        );
        break;
      case "pattern":
        this.#instantiatePatternNode(
          tx,
          plan,
          resultCell,
          addCancel,
          pattern,
          schedulerRehydration,
        );
        break;
    }
  }

  /**
   * The plan for `node` on `resultCell`: its module resolved through the
   * registry, its bindings bound to the piece's argument and result
   * documents, and the links those bindings read and write through.
   * `undefined` for a dynamic node, which nothing instantiates. The
   * bindings bind against the piece's argument document, or against
   * `argumentLink` where a caller supplies one: the pre-sync of a fresh run
   * binds against a stand-in holding the caller's argument, since setup has
   * not written the document yet. Binding resolution is op-wiring
   * machinery: the write-redirect walk reads alias shells and plumbing
   * containers' child paths, and those reads must not consume `*`-path
   * membership templates (machineryRead; template-population §6, the SC-8
   * machinery-read boundary).
   */
  #nodePlan(
    tx: IExtendedStorageTransaction,
    node: Node,
    resultCell: Cell<any>,
    pattern: Pattern,
    moduleRefName?: string,
    argumentLink?: NormalizedFullLink,
  ): NodePlan | undefined {
    const module = node.module;
    if (isModule(module)) {
      switch (module.type) {
        case "ref": {
          const refName = module.implementation as string;
          // `.asScope(scope)` records its scope on the *ref* module (the node's
          // module), but resolving the ref swaps in the registry's module — so
          // hand the declared default scope to the registry, or it is silently
          // dropped and the node falls back to "space". The registry owns
          // applying it, because the copy it takes to do so must also carry
          // the module's `debugName` (its policy identity) across.
          const resolved = this.#runtime.moduleRegistry.getModule(
            refName,
            module.defaultScope,
          );
          return this.#nodePlan(
            tx,
            { ...node, module: resolved },
            resultCell,
            pattern,
            refName,
            argumentLink,
          );
        }
        case "javascript":
        case "passthrough":
          return tx.runWithAmbientReadMeta(machineryRead, () => ({
            kind: module.type as "javascript" | "passthrough",
            module,
            ...this.#bindNodeIO(
              tx,
              node.inputs,
              node.outputs,
              resultCell,
              pattern,
              argumentLink,
            ),
          }));
        case "raw":
          return tx.runWithAmbientReadMeta(machineryRead, () => ({
            kind: "raw",
            module,
            moduleRefName,
            ...this.#buildRawNodeInputs(
              tx,
              module,
              node.inputs,
              node.outputs,
              resultCell,
              pattern,
              moduleRefName,
              argumentLink,
            ),
          }));
        case "pattern":
          return tx.runWithAmbientReadMeta(machineryRead, () => ({
            kind: "pattern",
            module,
            ...this.#bindPatternNode(
              tx,
              module,
              node.inputs,
              node.outputs,
              resultCell,
              pattern,
              argumentLink,
            ),
          }));
        default:
          throw new Error(`Unknown module type: ${module.type}`);
      }
    } else if (isWriteRedirectLink(module) || isAliasBinding(module)) {
      // TODO(seefeld): Implement, a dynamic node
      return undefined;
    } else {
      throw new Error(debugStr`Unknown module: $quote${module}`);
    }
  }

  #bindNodeIO(
    tx: IExtendedStorageTransaction,
    inputBindings: FabricExecValue,
    outputBindings: FabricExecValue,
    resultCell: Cell<any>,
    pattern: Pattern,
    argumentCellLink: NormalizedFullLink = getMetaLink(
      resultCell,
      "argument",
    )!,
  ): BoundNodeIO {
    const inputs = unwrapOneLevelAndBindToDoc(
      inputBindings,
      argumentCellLink,
      resultCell,
      {
        derivedInternalCells: pattern.derivedInternalCells,
        argumentCapSchema: pattern.argumentSchema,
      },
    );
    const outputs = unwrapOneLevelAndBindToDoc(
      outputBindings,
      argumentCellLink,
      resultCell,
      {
        derivedInternalCells: pattern.derivedInternalCells,
        argumentCapSchema: pattern.argumentSchema,
      },
    );
    return {
      inputs,
      outputs,
      writes: findAllWriteRedirectCells(outputs, resultCell, {
        followRedirectChains: !usesLocalReads(resultCell.tx),
      }),
      inputsCell: this.#runtime.getImmutableCell(
        resultCell.space,
        inputs,
        undefined,
        tx,
      ),
    };
  }

  #collectStaticRedirectWriteTargets(
    tx: IExtendedStorageTransaction,
    outputCells: readonly NormalizedFullLink[],
  ): NormalizedFullLink[] {
    return this.#collectStaticRedirectWriteTargetsWithCompleteness(
      tx,
      outputCells,
    ).targets;
  }

  #collectStaticRedirectWriteTargetsWithCompleteness(
    tx: IExtendedStorageTransaction,
    outputCells: readonly NormalizedFullLink[],
  ): { targets: NormalizedFullLink[]; complete: boolean } {
    if (usesLocalReads(tx)) return { targets: [], complete: false };
    // Write redirects are the static writable-output form: resolving them here
    // lets pull-mode indexing treat the resolved target like a normal declared
    // write. Dynamic writable-input writes use materializer envelopes instead.
    if (!outputCells.some((link) => link.overwrite === "redirect")) {
      return { targets: [], complete: true };
    }

    // Redirect-target resolution is op-wiring machinery (machineryRead):
    // its reads must not consume `*`-path membership templates.
    return tx.runWithAmbientReadMeta(machineryRead, () => {
      const targets: NormalizedFullLink[] = [];
      let complete = true;
      for (const output of outputCells) {
        if (output.overwrite !== "redirect") continue;
        try {
          const { overwrite: _overwrite, ...target } = resolveLink(
            this.#runtime,
            tx,
            output,
            "writeRedirect",
          );
          targets.push(target);
        } catch (error) {
          complete = false;
          // Some setup paths have not fully materialized metadata redirects
          // yet. Leave those to runtime dependency collection after the action
          // has run, but keep debug context for unexpected resolution failures.
          logger.debug("static-redirect-write-target", () => [
            "Unable to resolve static redirect write target",
            { output, error },
          ]);
        }
      }
      return { targets: dedupeNormalizedLinks(targets), complete };
    });
  }

  #collectStaticReadTargetsWithCompleteness(
    tx: IExtendedStorageTransaction,
    inputCells: readonly NormalizedFullLink[],
  ): { targets: NormalizedFullLink[]; complete: boolean } {
    if (usesLocalReads(tx)) return { targets: [], complete: false };
    // Declared inputs can point through their argument-slot redirect and then
    // through an ordinary link to the effective source cell. Resolve the full
    // static chain so the completeness certificate covers the same target the
    // action transaction will record at runtime.
    return tx.runWithAmbientReadMeta(machineryRead, () => {
      const targets: NormalizedFullLink[] = [];
      let complete = true;
      for (const input of inputCells) {
        try {
          const { overwrite: _overwrite, ...target } = resolveLink(
            this.#runtime,
            tx,
            input,
            "value",
          );
          targets.push(target);
        } catch (error) {
          complete = false;
          logger.debug("static-read-target", () => [
            "Unable to resolve static read target",
            { input, error },
          ]);
        }
      }
      return { targets: dedupeNormalizedLinks(targets), complete };
    });
  }

  #populateDeclaredSchedulerReads(
    reads: readonly NormalizedFullLink[],
    depTx: IExtendedStorageTransaction,
  ): void {
    depTx.runWithAmbientReadMeta(schedulerDependencyRead, () => {
      this.#populateDeclaredSchedulerReadsInner(reads, depTx);
    });
  }

  #populateDeclaredSchedulerReadsInner(
    reads: readonly NormalizedFullLink[],
    depTx: IExtendedStorageTransaction,
  ): void {
    // For event preflight, writable-input links are narrower than traversing
    // captured argument objects and avoid treating broad closures as demand.
    for (const read of reads) {
      let target = read;
      if (read.overwrite === "redirect") {
        try {
          const { overwrite: _overwrite, ...resolved } = resolveLink(
            this.#runtime,
            depTx,
            read,
            "writeRedirect",
          );
          target = {
            ...resolved,
            schema: resolved.schema ?? read.schema,
          };
        } catch (error) {
          logger.debug("scheduler-read-redirect", () => [
            "Unable to resolve scheduler read redirect",
            { read, error },
          ]);
        }
      }
      this.#runtime.getCellFromLink(target, target.schema, depTx)?.get();
    }
  }

  #populateHandlerEventSchedulerReads(
    argumentSchema: JSONSchema | undefined,
    resultCell: Cell<any>,
    event: unknown,
    depTx: IExtendedStorageTransaction,
  ): void {
    if (
      !isObjectOrArray(argumentSchema) ||
      !isObjectOrArray(argumentSchema.properties)
    ) {
      return;
    }
    const eventSchema = argumentSchema.properties.$event;
    if (eventSchema === undefined) {
      return;
    }

    const eventDependencySchema = cfcSchemaWithInheritedDefs(
      { type: "object", properties: { $event: eventSchema as JSONSchema } },
      resolveExternalRootRefForStructure(argumentSchema).$defs,
    );
    const inputsCell = this.#runtime.getImmutableCell(
      resultCell.space,
      { $event: event },
      undefined,
      depTx,
    );
    inputsCell.asSchema(eventDependencySchema).get({
      traverseCells: true,
    });
  }

  #collectWritableCellArgumentLinks(
    argumentSchema: JSONSchema | undefined,
    value: unknown,
    resultCell: Cell<any>,
    writeInputPaths?: readonly (readonly string[])[],
  ): NormalizedFullLink[] {
    const links: NormalizedFullLink[] = [];
    const seen = new WeakMap<object, Set<string>>();

    const pathsOverlap = (
      left: readonly string[],
      right: readonly string[],
    ): boolean => {
      const shorter = left.length <= right.length ? left : right;
      const longer = left.length <= right.length ? right : left;
      return shorter.every((segment, index) => longer[index] === segment);
    };
    const shouldCollectPath = (path: readonly string[]): boolean =>
      !writeInputPaths || writeInputPaths.length === 0 ||
      writeInputPaths.some((writePath) => pathsOverlap(path, writePath));

    const visit = (
      schema: unknown,
      currentValue: unknown,
      path: readonly string[],
    ): void => {
      if (!isObjectOrArray(schema)) return;
      const pathKey = JSON.stringify(path);
      const seenPaths = seen.get(schema);
      if (seenPaths?.has(pathKey)) return;
      if (seenPaths) {
        seenPaths.add(pathKey);
      } else {
        seen.set(schema, new Set([pathKey]));
      }

      // Ahead of the `asCell` branch below, deliberately. That branch collects
      // and returns, so a guard placed after it never sees a value standing at
      // an `asCell` or `writeonly` node -- and a link nested in an instance
      // there would be missed while the walk reported success.
      //
      // A `FabricSpecialObject` at a container position is INDEXED rather than
      // rebuilt, so nothing is decomposed. For a `FabricPrimitive` that settles
      // it: zero enumerable own properties, every keyed read yields
      // `undefined`, and a leaf holds no link to collect anyway.
      //
      // A `FabricInstance` is refused. A write-redirect link nested in its
      // codec contents is unreachable by property name, so passing one through
      // _misses_ that link -- and over-collection is this walker's safe
      // direction, which makes a miss the unsafe one.
      //
      // Nothing reaches this in production today, de facto rather than by
      // construction: a `FabricError` is ungated and exposed to pattern
      // authors, so what keeps this safe is that no action argument yet
      // carries one.
      //
      // TODO(danfuzz): descend by codec-mediated traversal into instance
      // state, at which point this becomes a walk rather than a refusal.
      if (currentValue instanceof FabricInstance) {
        refuseFabricInstance(
          currentValue,
          "when collecting writable cell links from an argument",
        );
      }

      const asCell = schema.asCell;
      if (
        Array.isArray(asCell) &&
        (asCell.includes("cell") || asCell.includes("writeonly"))
      ) {
        if (shouldCollectPath(path)) {
          links.push(
            ...findAllWriteRedirectCells(currentValue, resultCell, {
              followRedirectChains: !usesLocalReads(resultCell.tx),
            }),
          );
        }
        return;
      }

      // Keyword descent via the shared walk (a keyword missed here means asCell
      // markers escaping write tracking). The value-position keywords align
      // value and path — a named property or undeclared-key
      // (`additionalProperties`) at its key, a tuple slot at its index, `items`
      // elements past the slots at theirs — falling back to the conservative
      // same-value/same-path visit when value and schema misalign. Combinator
      // branches and `not` genuinely describe the same position: same value,
      // same path. `not` is included deliberately: a nested `not` (not-of-not)
      // re-selects values that DO match the inner subschema, so skipping it
      // could let an asCell marker escape tracking; over-collection is this
      // walker's safe direction (mirrors joinSchema's `not` union).
      //
      forEachSubschema(schema as JSONSchema, (child, keyword, key, index) => {
        switch (keyword) {
          case "properties":
            if (isObjectOrArray(currentValue)) {
              visit(child, currentValue[key!], [...path, key!]);
            }
            return;
          case "prefixItems":
            visit(
              child,
              Array.isArray(currentValue) ? currentValue[index!] : currentValue,
              [...path, String(index!)],
            );
            return;
          case "items":
            if (Array.isArray(currentValue)) {
              // `items` covers the elements past the tuple slots (2020-12).
              const start = Array.isArray(schema.prefixItems)
                ? schema.prefixItems.length
                : 0;
              for (let i = start; i < currentValue.length; i++) {
                visit(child, currentValue[i], [...path, String(i)]);
              }
            } else {
              visit(child, currentValue, path);
            }
            return;
          case "additionalProperties":
            if (isObjectNotArray(currentValue)) {
              // Covers only the keys `properties` does not declare.
              const declaredKeys = isObjectOrArray(schema.properties)
                ? new Set(Object.keys(schema.properties))
                : undefined;
              for (const [k, v] of Object.entries(currentValue)) {
                if (declaredKeys?.has(k)) continue;
                visit(child, v, [...path, k]);
              }
            } else {
              visit(child, currentValue, path);
            }
            return;
          default:
            visit(child, currentValue, path);
            return;
        }
      });
    };

    visit(argumentSchema, value, []);
    return dedupeNormalizedLinks(links);
  }

  #moduleHasOpaqueResult(module: Module): boolean {
    const resultSchema = module.resultSchema;
    return isObjectOrArray(resultSchema) &&
      Array.isArray(resultSchema.asCell) &&
      resultSchema.asCell.includes("opaque");
  }

  #collectArgumentSchedulerReadLinks(
    argumentSchema: JSONSchema | undefined,
    value: unknown,
    resultCell: Cell<any>,
  ): NormalizedFullLink[] {
    const links: NormalizedFullLink[] = [];
    const seen = new WeakMap<object, Set<unknown>>();
    // The argument schema at rest can be a `cid:` reference, whose
    // definitions live on the document it names.
    const argumentRoot = isObjectNotArray(argumentSchema)
      ? resolveExternalRootRefForStructure(argumentSchema)
      : undefined;
    const rootDefinitions = argumentRoot?.$defs;

    const visit = (schema: unknown, currentValue: unknown): void => {
      // Sigil-only: the value is post-unwrap, where the only `$alias`
      // records left belong to embedded Pattern values (their `defer`
      // bookkeeping resolves them at that pattern's own instantiation) —
      // parsing one here would read it at the wrong nesting level.
      if (isWriteRedirectLink(currentValue)) {
        const link = parseLink(currentValue, resultCell);
        links.push({
          ...link,
          schema: combineOptionalSchema(
            schema === undefined ? undefined : cfcSchemaWithInheritedDefs(
              schema as JSONSchema,
              rootDefinitions,
            ),
            link.schema,
          ),
        });
        return;
      }
      if (isCellLink(currentValue)) {
        return;
      }
      if (!isObjectOrArray(schema)) return;
      const seenValues = seen.get(schema) ?? new Set<unknown>();
      if (seenValues.has(currentValue)) return;
      seenValues.add(currentValue);
      seen.set(schema, seenValues);

      // Indexed, not rebuilt. Right for a `FabricPrimitive`: zero enumerable
      // own properties, and a leaf holds no link to collect.
      //
      // A `FabricInstance` is refused, for the same reason as the sibling walk
      // in `collectWritableCellArgumentLinks()`: a link in its codec contents
      // is unreachable by property name, so passing one through misses it, and
      // a miss is the unsafe direction here.
      //
      // Nothing reaches this in production today, de facto rather than by
      // construction.
      //
      // TODO(danfuzz): descend by codec-mediated traversal into instance
      // state, at which point this becomes a walk rather than a refusal.
      if (currentValue instanceof FabricInstance) {
        refuseFabricInstance(
          currentValue,
          "when collecting scheduler read links from an argument",
        );
      }
      if (isObjectOrArray(schema.properties) && isObjectOrArray(currentValue)) {
        for (const [key, propertySchema] of Object.entries(schema.properties)) {
          visit(propertySchema, currentValue[key]);
        }
      }

      if (Array.isArray(currentValue)) {
        // A tuple slot covers its exact index; `items` covers the indices
        // past the slots (2020-12). Under a `prefixItems`-only schema the
        // slots are the only elements visited.
        const prefixItems = Array.isArray(schema.prefixItems)
          ? schema.prefixItems
          : undefined;
        for (let index = 0; index < currentValue.length; index++) {
          const slotSchema =
            prefixItems !== undefined && index < prefixItems.length
              ? prefixItems[index]
              : schema.items;
          if (slotSchema !== undefined) {
            visit(slotSchema, currentValue[index]);
          }
        }
      }
      if (
        schema.additionalProperties !== undefined &&
        isObjectOrArray(currentValue)
      ) {
        const declaredKeys = isObjectOrArray(schema.properties)
          ? new Set(Object.keys(schema.properties))
          : undefined;
        for (const [key, propertyValue] of Object.entries(currentValue)) {
          if (declaredKeys?.has(key)) continue;
          visit(schema.additionalProperties, propertyValue);
        }
      }
      for (const key of ["anyOf", "oneOf", "allOf"] as const) {
        const branches = schema[key];
        if (Array.isArray(branches)) {
          for (const branch of branches) visit(branch, currentValue);
        }
      }
    };

    visit(argumentSchema, value);
    return dedupeNormalizedLinks(links);
  }

  #resolveJavaScriptFunction(
    module: Module,
  ): ResolvedJavaScriptModule {
    // Resolution order (docs/specs/content-addressed-action-identity.md):
    // 1. content-addressed `$implRef` — resolve the registered builder
    //    artifact by `{ identity, symbol }` from the in-memory indexes (only
    //    trust-gated artifacts are indexed, so whatever resolves is
    //    builder-made — host pseudo-modules included) and run its
    //    implementation;
    // 2. the module's LIVE implementation, when it carries trust-gated
    //    identity facts — module-eval provenance (process-global,
    //    content-derived), or an entry ref THIS runtime's engine resolves to
    //    the same function (host pseudo-modules are registry-scoped: a host
    //    trust grant in another runtime of the same process proves nothing
    //    here). This is the in-memory instantiation path: a trusted module
    //    that never round-tripped through JSON has no `$implRef` property,
    //    but its function IS the artifact;
    // 3. the stringified-source fallback (SES-sandboxed, CFC-unverified) —
    //    test-built / never-verified modules. A forged fn carries neither
    //    provenance nor an entry ref, so it always lands here.
    const liveEntryRef = typeof module.implementation === "function"
      ? getArtifactEntryRef(module.implementation)
      : undefined;
    const liveTrusted = typeof module.implementation === "function" &&
        (getVerifiedProvenance(module.implementation) !== undefined ||
          (liveEntryRef !== undefined &&
            this.#runtime.harness.getVerifiedImplementation?.(
                liveEntryRef.identity,
                liveEntryRef.symbol,
              ) === module.implementation))
      ? module.implementation as (...args: any[]) => any
      : undefined;
    const fn: (...args: any[]) => any = this.#resolveByImplRef(module) ??
      liveTrusted ??
      this.#getFallbackJavaScriptImplementation(module);

    const namedFn = fn as { src?: string; name?: string };
    const name = namedFn.src || fn.name;

    return { fn, name };
  }

  /**
   * The module's content-addressed `$implRef` — the defining module's content
   * identity plus the registered artifact's export/`__cfReg` symbol — when it
   * is structurally whole. A ref missing either half addresses nothing, so it
   * reads the same as no ref at all, and every caller treats it that way.
   */
  #contentAddressedImplRef(
    module: Module,
  ): { identity: string; symbol: string } | undefined {
    const ref = (module as { $implRef?: { identity: string; symbol: string } })
      .$implRef;
    return ref && typeof ref.identity === "string" &&
        typeof ref.symbol === "string"
      ? ref
      : undefined;
  }

  /**
   * Resolve a module's implementation through its content-addressed
   * `$implRef`. Returns undefined when the module carries no usable ref or the
   * ref names an implementation this runtime never registered; the caller then
   * falls through to the module's live implementation, and failing that to the
   * stringified source.
   */
  #resolveByImplRef(
    module: Module,
  ): ((...args: any[]) => any) | undefined {
    const ref = this.#contentAddressedImplRef(module);
    if (!ref) {
      return undefined;
    }
    const artifact = this.#runtime.patternManager.artifactFromIdentitySync(
      ref.identity,
      ref.symbol,
    );
    if (artifact) {
      const implementation =
        (artifact as { implementation?: unknown }).implementation ?? artifact;
      if (typeof implementation === "function") {
        return implementation as (...args: any[]) => any;
      }
    }
    // Second-chance resolution through the engine's content-addressed
    // implementation index, which is strong for the whole session. The
    // artifact index consulted above is also session-lifetime and never
    // evicted — the pattern manager's bounded FIFO covers only the
    // module-namespace reuse cache — so this arm exists for the cases where
    // the two indexes genuinely diverge: a module verified-evaluated by the
    // engine without passing through the pattern manager's registration
    // (a standalone-Engine compile), and a post-flip graph that carries no
    // legacy ref and no body.
    return this.#runtime.harness.getVerifiedImplementation?.(
      ref.identity,
      ref.symbol,
    ) as ((...args: any[]) => any) | undefined;
  }

  /**
   * Attach a stable, content-addressed implementation identity
   * (`cf:module/<identity>:<symbol>`) to an action, derived from its module
   * implementation's verified provenance — NOT from the source location. This
   * keeps action identity / fingerprints independent of `.src` and its (broken)
   * source-map resolution: the discriminator is the hoisted `__cfReg`/export
   * `symbol`, not `:line:col`. No-op for implementations with no verified
   * provenance (host / dynamic / test builders); the scheduler then resolves
   * `getVerifiedProvenance` live or falls to a generated id.
   * See docs/specs/content-addressed-action-identity.md.
   */
  #applyImplementationHash(
    action: Action | EventHandler,
    implementation: unknown,
  ): void {
    const provenance = typeof implementation === "function"
      ? getVerifiedProvenance(implementation)
      : undefined;
    if (provenance?.identity) {
      (action as { implementationHash?: string }).implementationHash =
        provenance.symbol
          ? `cf:module/${provenance.identity}:${provenance.symbol}`
          : `cf:module/${provenance.identity}`;
    }
  }

  /**
   * The stream a handler node registers on, parsed from its `$event` input,
   * or `undefined` for an action node. A node is a handler exactly when its
   * module carries the handler wrapper, and its stream is whatever `$event`
   * names: nothing is read at that target, which holds no value for a stream.
   *
   * A node that is one thing and shaped like the other is refused. A handler
   * with no `$event` has nothing to register on. An action binding a `$event`
   * is the shape a handler lowered where a lift belongs takes, and running it
   * as an action would run a handler body as a computation.
   */
  #handlerStreamLink(
    module: Module,
    inputs: FabricExecValue,
    base: NormalizedFullLink,
    name: string | undefined,
  ): NormalizedFullLink | undefined {
    const event = isObjectOrArray(inputs) && "$event" in inputs
      ? inputs.$event
      : undefined;
    const label = name ? `node \`${name}\`` : "node";
    if (module.wrapper === "handler") {
      if (event === undefined) {
        throw new Error(`Handler ${label} has no \`$event\` input`);
      }
      // `$event` is builder-generated and always a sigil redirect link; a
      // residual `$alias` here could only be an embedded pattern's binding,
      // which must not be followed at this level.
      if (!isWriteRedirectLink(event)) {
        throw new Error(
          debugStr`Handler ${label}'s \`$event\` input is not a link (got: $quote,long${event})`,
        );
      }
      return parseLink(event, base);
    }
    if (event !== undefined) {
      throw new Error(
        `Lift ${label} binds a \`$event\` input, which only a handler takes`,
      );
    }
    return undefined;
  }

  #createPatternFrame(
    cause: unknown,
    pattern: Pattern,
    resultCell: Cell<any>,
    tx: IExtendedStorageTransaction,
    inHandler: boolean,
    implementationIdentity?: ImplementationIdentity,
  ): Frame {
    return pushFrameFromCause(cause, {
      unsafe_binding: {
        pattern,
        materialize: (path: readonly PropertyKey[]) =>
          resultCell.getAsQueryResult(path, tx),
        space: resultCell.space,
        tx,
      },
      inHandler,
      frameKind: inHandler ? "handler" : "lift",
      // Freeze the handler's ambient clock to the dispatching event's instant
      // (see Frame.eventTime / sandboxDateNow). A handler invoked directly rather
      // than through event dispatch (a test, an internal call) has no dispatched
      // time, so capture the clock once here; it stays frozen for that run.
      ...(inHandler ? { eventTime: tx.dispatchedEventTime ?? Date.now() } : {}),
      runtime: this.#runtime,
      space: resultCell.space,
      tx,
      ...(implementationIdentity ? { implementationIdentity } : {}),
    });
  }

  #readJavaScriptArgument(
    module: Module,
    inputsCell: Cell<any>,
    tx: IExtendedStorageTransaction,
    options: { bindTxToSchema?: boolean } = {},
  ): { argument: any; isValidArgument: boolean } {
    const argument = module.argumentSchema !== undefined
      ? options.bindTxToSchema
        ? inputsCell.asSchema(module.argumentSchema).withTx(tx).get()
        : inputsCell.asSchema(module.argumentSchema).get()
      : inputsCell.getAsQueryResult([], tx);

    return {
      argument,
      isValidArgument: module.argumentSchema === false ||
        argument !== undefined,
    };
  }

  /**
   * What an action's argument was validated against and what it was
   * validated from, for the invalid-input diagnostics. The raw binding is
   * the inputs as bound — links unresolved — so building this reads no
   * document the argument schema does not, and registers nothing in the
   * action's transaction beyond what validating the argument already did.
   */
  #getJavaScriptInputState(
    module: Module,
    inputsCell: Cell<any>,
  ): { schema: Module["argumentSchema"]; raw: unknown } {
    return {
      schema: module.argumentSchema,
      raw: inputsCell.getRaw(),
    };
  }

  #updateInvalidInputFlag(
    name: string | undefined,
    isValidArgument: boolean,
    module: Module,
    inputsCell: Cell<any>,
  ): void {
    if (!name) return;

    if (!isValidArgument) {
      logger.flag(
        "action invalid input",
        `action:${name}`,
        true,
        this.#getJavaScriptInputState(module, inputsCell),
      );
      return;
    }

    logger.flag(
      "action invalid input",
      `action:${name}`,
      false,
    );
  }

  /**
   * Opt `tx` into multi-space writes for a cross-space child, accumulating the
   * commit order so every child space committed in this transaction is ordered
   * before `parentSpace`. Without accumulation, a second cross-space child would
   * replace the order with `[child2, parent]`, dropping `child1` to after the
   * parent (orderedCommitSpaces appends unlisted written spaces), which would
   * make the parent's link to `child1` durable before `child1`'s target.
   */
  enableCrossSpaceChildCommit(
    tx: IExtendedStorageTransaction,
    childSpace: MemorySpace,
    parentSpace: MemorySpace,
  ): void {
    // Public so the pattern builder (builder/pattern.ts
    // `optIntoInSpaceMultiSpaceCommit`) can opt a transaction into a
    // multi-space commit the moment a handler's `.inSpace(...)` target
    // resolves — before the cross-space write executes (e.g. appending to the
    // home `profiles` list, whose elements live in their own spaces).
    let childSpaces = this.#crossSpaceChildSpaces.get(tx);
    if (childSpaces === undefined) {
      childSpaces = [];
      this.#crossSpaceChildSpaces.set(tx, childSpaces);
    }
    if (childSpace !== parentSpace && !childSpaces.includes(childSpace)) {
      childSpaces.push(childSpace);
    }
    // All accumulated child spaces first, parent last.
    tx.enableMultiSpaceWrites?.([...childSpaces, parentSpace]);
  }

  #handleJavaScriptHandlerResult(
    tx: IExtendedStorageTransaction,
    resultSchema: JSONSchema | undefined,
    result: any,
    resultHasReactives: boolean,
    frame: Frame,
    patternResultCell: Cell<any>,
    addCancel: AddCancel,
    cause: Record<string, any>,
  ): any {
    const receiptCell = this.#runtime.getCell(
      patternResultCell.space,
      { resultFor: cause },
      undefined,
      tx,
    );
    const receiptsEnabled =
      this.#runtime.experimental.commitPreconditions === true &&
      // Events-down (runtime-mapping.md, row N26): receipt create-only
      // exactly-once is SUBSUMED by the stream's `eventWatermark`
      // (events.md §4), and the two mechanisms must not be active for the same
      // event — client handler runs divert to the overlay anyway, and a
      // serving run's create-only mark would ride the WAVE commit as a
      // precondition the watermark already covers.
      this.#runtime.experimental.serverExecution !== true;
    // The serving-side receipt/result write (events.md §4 "Result carriage"):
    // the watermark subsumes the receipt's EXACTLY-ONCE role, not its
    // RESULT-CARRIAGE role. Under the flag the SERVING side writes the
    // handling's receipt — every served handler completion writes its result
    // cell, even when the declared value is undefined — in the handler run's
    // own transaction, so the write seals into the run's wave with the entry's
    // `consequenced` mark (events.md §4 mark/effects atomicity) and enters the
    // space through the same carriage every served event-handler write rides.
    // Only a run whose body actually ran writes (a skipped served dispatch is
    // withdrawn whole — see `dispatchedHandlerNotRun`); the client's write
    // stays disabled (`receiptsEnabled` above), so the serving run is the ONE
    // writer.
    const servedReceiptWrite =
      this.#runtime.experimental.serverExecution === true &&
      waveRunContextOf(tx)?.kind === "event-handler" &&
      tx.dispatchedHandlerNotRun === undefined;
    // Expose the handling's receipt address on the transaction, where the
    // sender's commit callback can read it. Stashed before the branches so BOTH
    // outcomes carry it: a committed handling hands back its own receipt, and a
    // create-only collision loser hands back the same address — which is the
    // winner's original outcome.
    //
    // Only while receipts are actually being written. With commitPreconditions
    // off nothing below creates or create-only marks this cell, so publishing
    // its address would hand the caller a witness that does not exist and
    // invite a readback against an unwritten cell. Absent beats fabricated —
    // the same fail-closed stance cfc/grants.ts takes when its gate is off.
    //
    // Under EXPERIMENTAL_SERVER_EXECUTION the receipt IS being written — by the
    // SERVING side (see the write above). The address is
    // cause-derived, so the client's diverted ECHO of the same event mints the
    // same address the serving run writes; publishing it on the echo's
    // transaction is what hands an unchanged caller (the CLI verb dispatch) a
    // readable handle on the served outcome. The durable-ack coupling (cell.ts)
    // settles that caller's callback only after the handling CONSEQUENCED — the
    // serving wave, receipt included, committed before the address is ever
    // dereferenced.
    if (
      receiptsEnabled || this.#runtime.experimental.serverExecution === true
    ) {
      tx.handlingReceiptLink = receiptCell.getAsNormalizedFullLink();
    }
    if (!resultHasReactives && frame.reactives.size === 0) {
      if (receiptsEnabled) {
        // Receipt-only handling (spec scheduler-v2 §7.6): nothing was
        // launched, but the result cell is still created — its create is the
        // exactly-once witness for this event id. Under plainResultReceipts
        // the witness also carries the handler's (already-normalized) return,
        // so a caller — or a same-id retry colliding on the receipt — reads
        // the verb's result back by receipt address (verb contract Part 2).
        // `{}` remains the value-less shape either way.
        //
        // The value goes through the receipt cell's STANDARD write flow
        // (`set` → diffAndUpdate), the same conversion any cell write gets:
        // plain JSON persists as-is and a live Cell handle converts to a
        // link. That matters because incidental cell returns are a sanctioned
        // idiom — `set()` returns its cell for chaining, so an
        // expression-body `action(() => cell.set(...))` returns the mutated
        // cell — and a raw write here fails the whole handling on such a
        // value with an uncloneable-live-object storage error instead of
        // recording what was returned.
        const receiptValue =
          this.#runtime.experimental.plainResultReceipts === true &&
            result !== undefined
            ? result
            : {};
        const receipt = receiptCell.withTx(tx);
        receipt.set(receiptValue);
        // The receipt says what it holds, the way any other cell does. The
        // shape is only knowable here: the cell is minted at the top of the
        // dispatch, before the handler runs. Both writes ride this one
        // transaction, which the create-only mark below gates, so the schema
        // and the value it describes commit together or not at all.
        const shape = receiptShapeSchema(receiptValue);
        if (shape !== undefined) writeResultSchemaMeta(receipt, shape);
        tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
      } else if (servedReceiptWrite) {
        // The serving-side receipt write: the value-less/plain shape is EXACTLY
        // the client-written one — `{}` as the existence witness, the handler's
        // plain return under `plainResultReceipts` — and the cell identity is
        // the same cause-derived address, so the verb contract's readback
        // (`cf call`'s `.result`) reads a serving-written receipt the same
        // way it reads a client-written one.
        //
        // Write-once is CAS, not a wire precondition: no markCreateOnly (a
        // create-only mark must not ride a wave commit whose event the
        // watermark already covers), and a receipt that ALREADY holds a value
        // is a LOUD NO-OP. A lost CAS means a writer already landed this
        // handling's receipt — a re-served replay converging on the same
        // cause-derived id, or a pre-created cell — and first-writer-wins is
        // the OFF arm's receipt-collision semantics: never a second write,
        // never an error that fails the wave (the entry's consequenced mark and
        // the handler's other consequences still commit; the read below rides
        // the wave's basis for this doc, so a genuinely concurrent landing
        // rebases the run and the re-run takes this same no-op arm).
        const existing = receiptCell.getRaw({ meta: ignoreReadForScheduling });
        if (existing !== undefined) {
          this.#servedReceiptCasLosses += 1;
          logger.warn("served-receipt", () => [
            "served receipt write skipped (write-once CAS loss): the " +
            "handling's result cell already holds a value — a prior " +
            "serve/replay or a pre-created cell landed it first, and " +
            "the standing value wins",
            {
              receipt: receiptCell.getAsNormalizedFullLink().id,
              eventId: waveRunContextOf(tx)?.eventId,
            },
          ]);
        } else {
          const receiptValue =
            this.#runtime.experimental.plainResultReceipts === true &&
              result !== undefined
              ? result
              : {};
          const receipt = receiptCell.withTx(tx);
          receipt.set(receiptValue);
          const shape = receiptShapeSchema(receiptValue);
          if (shape !== undefined) writeResultSchemaMeta(receipt, shape);
        }
      }
      return result;
    }

    const receiptKey = this.#getDocKey(receiptCell);
    if (
      receiptsEnabled &&
      this.#locallyCommittedHandlerResultStarts.has(receiptKey) &&
      this.#cancels.has(receiptKey) &&
      receiptCell.getRaw({ meta: ignoreReadForScheduling }) !== undefined
    ) {
      // Local sequential-redelivery fast path. The winner's result wrapper is
      // already durably committed and still live in this runner, so do not run
      // the newly-built result pattern into that shared cell: doing so can
      // stage a changed inSpace child before the duplicate loses its receipt.
      // The server-side create-only precondition remains authoritative and
      // still rejects every parent write in this duplicate transaction. This
      // local observation is only containment, not a system-wide receipt proof.
      tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
      return result;
    }

    // The verb's DECLARED result type (`module.resultSchema`, lowered from
    // `action<E, R>` / `handler<E, T, R>`) becomes this synthesized pattern's
    // result schema, which `#setupInternal()` records as the receipt cell's
    // durable `schema` meta. A launched result is a link, so its settled value
    // describes nothing; the declaration is the only description there is. An
    // undeclared verb passes `undefined` and keeps the unconstrained schema a
    // frame-synthesized pattern has always carried.
    const resultPattern = patternFromFrame(
      () => result,
      undefined,
      resultSchema,
    );
    // navigateTo result patterns must start after the handler's transaction
    // commits so the navigation target is durable. Every other handler result
    // pattern runs into the canonical result/receipt cell in the handler's
    // space. Individual inSpace child nodes route themselves to their target
    // space in instantiatePatternNode, which also establishes child-before-
    // parent commit order and replicates the child's pattern artifacts.
    const deferForNavigate = this.#handlerResultPatternHasNavigateTo(
      resultPattern,
    );
    // On a flag-ON CLIENT (protocol.md §5), a navigate-bearing result's
    // deferred start is a SPECULATIVE handler consequence — it must divert to
    // the overlay with its event's id, never commit the receipt authored (the
    // serving side owns the durable create; see startAfterSuccessfulCommit's
    // stamp comment). Wave-stamped (serving) and unstamped (OFF-arm) handler
    // runs pass nothing.
    const speculativeConsequence = deferForNavigate &&
        waveRunContextOf(tx) === undefined
      ? (() => {
        const info = navigateEventContextFromRunInfo(
          speculationRunContextOf(tx),
        );
        return info !== undefined ? { eventId: info.eventId } : undefined;
      })()
      : undefined;

    if (deferForNavigate && result === undefined) {
      // navigateTo results are commit-gated (startAfterSuccessfulCommit);
      // the receipt precondition rides the deferred start's own create.
      const cancelDeferredStart = this.#runPatternAfterSuccessfulCommit(
        tx,
        receiptCell,
        resultPattern,
        undefined,
        true,
        speculativeConsequence,
        patternResultCell.getAsNormalizedFullLink().id,
      );
      addCancel(cancelDeferredStart);
      this.#runtime.scheduler.lineage.recordPieceStop(
        tx,
        cancelDeferredStart,
      );
      return result;
    }

    let installedCancel: Cancel | undefined;
    let cancelDeferredStart: Cancel | undefined;
    const resultCell = deferForNavigate
      ? (() => {
        const setup = this.#setupDeferredHandlerResultPattern(
          tx,
          resultPattern,
          patternResultCell.space,
          cause,
          true,
          speculativeConsequence,
          patternResultCell.getAsNormalizedFullLink().id,
        );
        cancelDeferredStart = setup.cancelDeferredStart;
        return setup.resultCell;
      })()
      : (() => {
        const run = this.#runWithStartOwnership(
          tx,
          resultPattern,
          undefined,
          receiptCell,
          {
            // A result-as-pattern child's demand roots include the producing
            // piece's chain (see RunnerRunOptions).
            parentPieceRootId: patternResultCell.getAsNormalizedFullLink()
              .id,
          },
        );
        installedCancel = run.installedCancel;
        cancelDeferredStart = run.cancelDeferredStart;
        return run.resultCell;
      })();

    if (!deferForNavigate && receiptsEnabled) {
      // Gated like every other receipt write above: under serverExecution the
      // receipt create-only mechanism is subsumed by the stream's
      // eventWatermark and MUST NOT ride a serving run's wave commit — an
      // ungated mark here would leave the create-only precondition active
      // alongside the watermark, so a duplicate derived run would abort on
      // receipt-exists instead of coalescing to the watermark.
      tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
    }

    if (!deferForNavigate && this.#usesScopedPrograms(resultCell)) {
      addCancel(this.retainChild(resultCell));
    }

    if (deferForNavigate) {
      if (cancelDeferredStart !== undefined) {
        // The start itself is commit-gated, but the parent piece owns it from
        // scheduling onward: cancellation before commit tombstones the start;
        // cancellation after installation stops only this attempt's child.
        addCancel(cancelDeferredStart);
        this.#runtime.scheduler.lineage.recordPieceStop(
          tx,
          cancelDeferredStart,
        );
      }
    } else if (
      installedCancel !== undefined || cancelDeferredStart !== undefined
    ) {
      // Both lifetime cancellation and failure compensation belong only to the
      // attempt that owns this local start (immediate or commit-gated). A
      // receipt-losing duplicate reuses the deterministic wrapper and must not
      // stop the winner.
      let cancelled = false;
      const cancelOwnedStart = cancelDeferredStart ?? (() => {
        if (cancelled) return;
        cancelled = true;
        const key = this.#getDocKey(resultCell);
        if (this.#cancels.get(key) !== installedCancel) return;
        this.stop(resultCell);
      });
      addCancel(cancelOwnedStart);
      // Spec scheduler-v2 §7.6 rule 2: the launch is speculative; if this
      // handler's transaction ultimately fails, stop the piece (data writes
      // roll back with the transaction; registrations do not).
      this.#runtime.scheduler.lineage.recordPieceStop(
        tx,
        cancelOwnedStart,
      );
      if (receiptsEnabled) {
        tx.addCommitCallback((_committedTx, commitResult) => {
          if (!commitResult.error && this.#cancels.has(receiptKey)) {
            this.#locallyCommittedHandlerResultStarts.add(receiptKey);
          }
        });
      }
    }

    return result;
  }

  /**
   * Resolves any `PatternFactory.inSpace("name")` targets that the just-finished
   * handler/action referenced but whose space DID was not yet cached, then
   * throws {@link RetryImmediately} so the scheduler re-runs the handler/action.
   * On the re-run the names resolve synchronously from the runtime cache (see
   * the pattern builder's resolveInSpaceTargetSpace), so the child results are
   * routed into the correct spaces from the start — no link rewriting required.
   *
   * On a SERVING runtime the fresh space's genesis ACL must name the run's
   * ACTING user as OWNER, so the acting principal is read from the run
   * transaction's wave run context and threaded to
   * {@link Runtime.resolveSpaceName} as the genesis owner. Read WITHOUT
   * `homeSpacePrincipalFor`'s read-scope-ratchet side effect: resolving a
   * provisioning target is not a scoped READ of the run. The ACTING user is the
   * ONLY source: the genesis owner must be the same principal the provisioning
   * crossing's grant probe and carriage carry, or replay's acl arm would probe
   * a stranger — a demand-supplied `scopeKeyIdentity` is resolution scaffolding
   * whose acting settles (possibly to NONE) at the seal, so a context carrying
   * only it REFUSES here exactly like a bare one: its crossing would be refused
   * carriage-less anyway, and registering the scaffolding principal would mint
   * an orphaned genesis under an owner the wave never grants. On a client
   * (`!servingPosture`) no owner is supplied and the genesis names the active
   * user.
   */
  async #resolvePendingSpaceNamesAndRetry(
    frame: Frame,
    tx?: IExtendedStorageTransaction,
  ): Promise<never> {
    const names = [...(frame.pendingSpaceNames ?? [])];
    let owner: DID | undefined;
    if (this.#runtime.servingPosture && tx !== undefined) {
      owner = waveRunContextOf(tx)?.acting?.user as DID | undefined;
    }
    await Promise.all(
      names.map((name) =>
        this.#runtime.resolveSpaceName(
          name,
          owner !== undefined ? { owner } : undefined,
        )
      ),
    );
    throw new RetryImmediately(
      `Resolving in-space target spaces: ${names.join(", ")}`,
    );
  }

  #handlerResultPatternHasNavigateTo(
    pattern: Pattern,
  ): boolean {
    return pattern.nodes.some(({ module }) =>
      module.type === "ref" && module.implementation === "navigateTo"
    );
  }

  #setupDeferredHandlerResultPattern(
    tx: IExtendedStorageTransaction,
    resultPattern: Pattern,
    resultSpace: MemorySpace,
    cause: Record<string, any>,
    markCreateOnlyResult = false,
    speculativeConsequence?: { eventId: string },
    parentPieceRootId?: string,
  ): DeferredStartResult<any> {
    const resultCell = this.#runtime.getCell(
      resultSpace,
      { resultFor: cause },
      undefined,
      tx,
    );
    // Recorded before the setup instantiates the result's children: a child
    // asks the chain for the piece its handler belongs to
    // (`#ancestorSystemOrigin`), and the deferred start comes too late for it.
    this.#demandRootChainFor(
      resultCell.getAsNormalizedFullLink().id,
      parentPieceRootId,
    );
    const resultSetup = this.#setupInternal(
      tx,
      resultPattern,
      undefined,
      resultCell,
    );
    // The receipt mark must ride the transaction that creates the result
    // cell's head — `#setupInternal()` just wrote it into the handler tx.
    // Marking the deferred start tx instead would see the already-committed
    // head and reject the FIRST delivery as receipt-exists, while
    // redeliveries (whose own handler tx re-creates the cell) would go
    // unguarded.
    if (markCreateOnlyResult) {
      tx.markCreateOnly?.(resultCell.getAsNormalizedFullLink());
    }
    const cancelDeferredStart = resultSetup.needsStart
      ? this.#startAfterSuccessfulCommit(
        tx,
        resultCell,
        resultSetup.pattern,
        parentPieceRootId === undefined ? {} : { parentPieceRootId },
        speculativeConsequence,
      )
      : undefined;
    return { resultCell, cancelDeferredStart };
  }

  #writeJavaScriptActionResult(
    tx: IExtendedStorageTransaction,
    resultSchema: JSONSchema | undefined,
    result: any,
    resultHasReactives: boolean,
    frame: Frame,
    resultCell: Cell<any>,
    outputs: FabricExecValue,
    addCancel: AddCancel,
    _resultFor: {
      inputs: FabricExecValue;
      outputs: FabricExecValue;
      fn: string;
    },
    previousResultCellRef: JavaScriptActionResultCells,
    narrowestReadScope?: CellScope,
  ): any {
    if (!resultHasReactives && frame.reactives.size === 0) {
      recordOutputSchemaPolicyInputs(
        tx,
        this.#runtime,
        resultCell,
        outputs,
        resultSchema,
      );
      sendValueToBinding(
        tx,
        resultCell,
        getMetaLink(resultCell, "argument")!,
        outputs,
        result,
        {
          narrowestReadScope,
        },
      );
      return result;
    }

    const parentPieceRootId = resultCell.getAsNormalizedFullLink().id;
    if (usesLocalReads(tx)) {
      requireLocalReadCondition(
        tx.tx,
        toMemorySpaceAddress(resultCell.getAsNormalizedFullLink()),
        () => false,
      );
    }
    const resultPattern = patternFromFrame(() => result);
    const effectiveOutputScope = narrowestScope([
      schemaCellScope(resultSchema),
      schemaCellScope(resultPattern.resultSchema),
      narrowestReadScope,
    ]);
    // See if the resultCell was already in this effective output INSTANCE (the
    // discovered scope name resolved against the run's acting identity — the
    // runtime's own session in the OFF arm; a served run's DEMAND-SUPPLIED
    // identity when the wave run context carries one).
    const effectiveOutputScopeKey = resolveScopeKey(
      effectiveOutputScope,
      waveRunContextOf(tx)?.scopeKeyIdentity ?? this.#runtime.scopeKeyIdentity,
    );
    const previousScopedResultCell = previousResultCellRef.byScope.get(
      effectiveOutputScopeKey,
    );
    if (previousScopedResultCell === undefined) {
      const baseResultCell = this.#runtime.getCell(
        resultCell.space,
        _resultFor,
        undefined,
        tx,
      );
      const newResultCell = effectiveOutputScope === "space"
        ? baseResultCell
        : createCell(
          this.#runtime,
          {
            ...baseResultCell.getAsNormalizedFullLink(),
            scope: effectiveOutputScope,
          },
          tx,
        );
      previousResultCellRef.byScope.set(
        effectiveOutputScopeKey,
        newResultCell,
      );
      resultCell = newResultCell;
      if (this.#usesScopedPrograms(resultCell)) {
        addCancel(this.retainChild(resultCell));
      }
    } else {
      resultCell = previousScopedResultCell;
    }

    // The change key is a content hash of the pattern's encodable form, taken
    // through the artifact walk so an artifact reached by any route --
    // including a sub-graph under a node's `inputs` -- is serialized before it
    // is hashed. A hash is canonical, so a difference in member order is not a
    // difference in the key.
    //
    // `hashOf` throws on anything the data model refuses. That is a second
    // line of defense rather than the first: `normalizeSandboxResult` runs on
    // every route here and already rejects a bare function at any depth, with
    // a better message than a hash could give.
    //
    // The walk types its result as a `FabricExecValue`, which admits a
    // function; the cast says there is none left. The only functions in a
    // pattern graph are builder artifacts, since `normalizeSandboxResult`
    // refuses any other, and the walk replaces every artifact with its
    // encodable form. The leaves were converted on the way out of the sandbox.
    const resultPatternKey = hashStringOf(
      flattenBuilderArtifacts(resultPattern) as FabricValue,
    );
    // Keyed doc-then-INSTANCE, the instance being the SAME per-run resolved key
    // that selected the byScope cell above: a doc-level or
    // service-identity-resolved key would make the second demanded instance's
    // run read the first's memo as "unchanged" and skip its child
    // materialization.
    const resultDocLink = resultCell.getAsNormalizedFullLink();
    const cacheDocKey =
      `${resultDocLink.space}/${resultDocLink.id}` as `${MemorySpace}/${URI}`;
    const previousResultPatternKey = this.#resultPatternCache.get(cacheDocKey)
      ?.get(effectiveOutputScopeKey);
    const patternUnchanged = previousResultPatternKey === resultPatternKey;

    if (!patternUnchanged) {
      this.#memoizeResultPattern(
        cacheDocKey,
        effectiveOutputScopeKey,
        resultPatternKey,
      );

      const childSetupTx = new TransactionWrapper(tx, {
        nonReactive: true,
      });
      this.run(
        childSetupTx,
        resultPattern,
        undefined,
        resultCell,
        { parentPieceRootId },
      );
      addCancel(() => this.releaseChild(resultCell, undefined));

      tx.addCommitCallback((_committedTx, result) => {
        if (!result.error) return;
        // Releasing the child is only half of the rollback: this memo of what
        // the result cell holds decides whether the next run materializes the
        // child again. A rejected commit rolls the child's links back and the
        // notification for that rollback clears the memo, but an abort settles
        // without reaching storage, so clear it here. Left set, the memo makes
        // the next run treat the pattern as unchanged and skip a child that
        // now exists nowhere. Cleared ahead of the release, so a
        // materialization that releasing re-enters keeps the memo it writes.
        // A rollback carries a release's authority, not a stop's: it lets go
        // of the registration this materialization installed and is not
        // authoritative over a lifetime or a start it does not own.
        this.#rollBackResultPatternMemo(
          cacheDocKey,
          effectiveOutputScopeKey,
          resultPatternKey,
        );
        this.releaseChild(resultCell, undefined);
      });
    }

    const effectiveResultSchema = resultSchema ?? resultPattern.resultSchema ??
      resultCell.schema;
    recordOutputSchemaPolicyInputs(
      tx,
      this.#runtime,
      resultCell,
      outputs,
      effectiveResultSchema,
    );
    sendValueToBinding(
      tx,
      resultCell,
      getMetaLink(resultCell, "argument")!,
      outputs,
      resultCell.getAsLink(),
      { narrowestReadScope: effectiveOutputScope },
    );
    return result;
  }

  #instantiateJavaScriptHandlerNode(
    {
      module,
      resultCell,
      addCancel,
      pattern,
      fn,
      name,
      inputs,
      reads,
      writes,
      streamLink,
      schedulerRehydration,
    }: JavaScriptNodeContext & { streamLink: NormalizedFullLink },
  ): void {
    // What names this node, as opposed to what it reads through: the bound
    // inputs with every link reduced to the cell it names. Hoisted out of the
    // handler because the bindings are fixed for the node, so the reduction
    // runs once rather than per event.
    const causalInputs = causalFormOfBinding(inputs) as Record<string, any>;

    const handlerResultCell = schedulerRehydration.viewLocalOnly
      ? resultCell.withTx()
      : resultCell;
    // Each run gets a frame context of its own, so its frame, which stays
    // pushed until an async result settles, is invisible to anything that runs
    // while it awaits.
    const handler = (tx: IExtendedStorageTransaction, event: any) =>
      runInFrameContext(() => runHandler(tx, event));
    const runHandler = (tx: IExtendedStorageTransaction, event: any) => {
      const resultCell = schedulerRehydration.viewLocalOnly
        ? handlerResultCell.withTx(tx)
        : handlerResultCell;
      if (event?.preventDefault) event.preventDefault();

      // The dispatch-side closed-world gate. A present payload that cannot
      // satisfy a closed event schema fails the handling exactly the way a
      // thrown handler error fails: the body never runs, the transaction aborts
      // (no receipt is created, the event id is not spent), scheduler onError
      // fires, and the commit callback settles with the errored transaction.
      const closedWorldRejection = closedWorldEventRejection(
        module.argumentSchema,
        event,
        tx.dispatchedRuntimeInjectedEventKeys,
      );
      if (closedWorldRejection !== undefined) {
        throw new Error(closedWorldRejection);
      }

      const eventInputs = {
        ...(inputs as Record<string, any>),
        $event: event,
      };
      // Spec scheduler-v2 §7.6 / decision 13: the handler's result cell — and
      // every id minted in this frame — derives from the durable event id, so
      // retries of the same event reuse the same ids and duplicate handlings
      // collide on the receipt. The fallback covers non-dispatch invocations
      // (tests calling the handler directly).
      const cause = {
        ...causalInputs,
        $event: tx.dispatchedEventId ?? crypto.randomUUID(),
      };
      const policyFacingIdentity = resolvePolicyFacingImplementationIdentity(
        module,
        { implementation: fn },
      );
      const frame = this.#createPatternFrame(
        cause,
        pattern,
        resultCell,
        tx,
        true,
        policyFacingIdentity,
      );
      if (policyFacingIdentity) {
        tx.setCfcImplementationIdentity(policyFacingIdentity);
      }

      let popFrameAfterReturn = true;
      try {
        const inputsCell = this.#runtime.getImmutableCell(
          resultCell.space,
          eventInputs,
          undefined,
          tx,
        );
        logger.timeStart("stream", "readInputs");
        const { argument, isValidArgument } = (() => {
          try {
            return this.#readJavaScriptArgument(module, inputsCell, tx);
          } finally {
            logger.timeEnd("stream", "readInputs");
          }
        })();

        this.#updateInvalidInputFlag(
          name,
          isValidArgument,
          module,
          inputsCell,
        );

        if (!isValidArgument) {
          logger.error(
            "stream",
            () => [
              "action argument is undefined (potential schema mismatch) -- not running",
              this.#getJavaScriptInputState(module, inputsCell),
            ],
          );
          // Record the skip on the transaction: the scheduler's event
          // finalize withdraws the transaction instead of sealing it and
          // re-runs the handler (events.md §5). On a replica still loading
          // what the argument reaches, `undefined` is a cold read rather
          // than a mismatch, and a sealed skip would consume the event —
          // for a served dispatch as a 1-op mark-only consequence, for a
          // client dispatch as a commit callback reporting a handling
          // that never happened.
          tx.dispatchedHandlerNotRun = {
            reason: "action argument is undefined (potential schema mismatch)",
          };
        }

        let result: any = undefined;
        if (isValidArgument) {
          logger.timeStart("stream", "invokeJavaScriptImplementation");
          try {
            result = this.#invokeJavaScriptImplementation(
              module,
              fn,
              argument,
            );
            if (result instanceof Promise) {
              result = result.finally(() =>
                logger.timeEnd("stream", "invokeJavaScriptImplementation")
              );
            } else {
              logger.timeEnd("stream", "invokeJavaScriptImplementation");
            }
          } catch (error) {
            logger.timeEnd("stream", "invokeJavaScriptImplementation");
            throw error;
          }
        }
        const postRun = (result: any) => {
          logger.timeStart("stream", "postRun");
          try {
            if (frame.pendingSpaceNames && frame.pendingSpaceNames.size > 0) {
              return this.#resolvePendingSpaceNamesAndRetry(frame, tx);
            }
            const normalized = normalizeSandboxResult(result, name);
            return this.#handleJavaScriptHandlerResult(
              tx,
              module.resultSchema,
              normalized.value,
              normalized.hasReactive,
              frame,
              resultCell,
              addCancel,
              cause,
            );
          } finally {
            logger.timeEnd("stream", "postRun");
          }
        };

        const postRunResult = result instanceof Promise
          ? result.then(postRun)
          : postRun(result);
        if (postRunResult instanceof Promise) {
          popFrameAfterReturn = false;
          return postRunResult.finally(() => popFrame(frame));
        }
        return postRunResult;
      } catch (error) {
        // The handler body may throw while materializing a not-yet-resolved
        // inSpace("name") child (e.g. set into a cell). If so, resolve the
        // pending names and retry instead of surfacing the error.
        if (
          !(error instanceof RetryImmediately) &&
          frame.pendingSpaceNames && frame.pendingSpaceNames.size > 0
        ) {
          popFrameAfterReturn = false;
          return this.#resolvePendingSpaceNamesAndRetry(frame, tx)
            .finally(() => popFrame(frame));
        }
        (error as Error & { frame?: Frame }).frame = frame;
        throw error;
      } finally {
        if (popFrameAfterReturn) popFrame(frame);
      }
    };

    if (name) {
      setRunnableName(handler, `handler:${name}`, { setSrc: true });
    }
    if (schedulerRehydration.implementationSelection !== undefined) {
      const instanceKey = programActionInstanceKey(
        schedulerActionInstanceKey({
          process: resultCell.getAsNormalizedFullLink(),
          reads,
          writes,
        }),
        schedulerRehydration.implementationSelection,
      );
      this.#applyImplementationHash(handler, fn);
      (handler as { schedulerInstanceKey?: string }).schedulerInstanceKey =
        instanceKey;
      setRunnableName(
        handler,
        `handler:${name ?? "anonymous"}:${instanceKey}`,
        {
          setSrc: true,
        },
      );
    }

    // Ensure the handler's input docs are locally available before the body
    // runs: sync the inputs, with the event in its slot, under the module's
    // argument schema. The server's query walk follows links from there the
    // way the handler's reads will, `asCell` handles included, so a
    // synchronous in-handler read of a handle (e.g. SqliteDb.exec reading
    // the handle doc) finds the doc local. The scheduler awaits this before
    // dispatching the event. Steady-state this is ~free: covered selectors
    // resolve without a server round trip.
    const presyncInputs =
      !usesLocalReads(resultCell.tx) && module.argumentSchema !== undefined
        ? async (
          event: any,
          identity: ScopeKeyIdentity | undefined,
          tx: IExtendedStorageTransaction,
        ): Promise<void> => {
          const eventInputs = {
            ...(inputs as Record<string, any>),
            $event: event,
          };
          const inputsCell = this.#runtime.getImmutableCell(
            resultCell.space,
            eventInputs,
            module.argumentSchema,
            tx,
          );
          if (identity === undefined) {
            await inputsCell.sync();
          } else {
            // A served event's presync loads the ACTOR's instances of the
            // handler's scoped inputs (the runner's explicit-instance read; see
            // EventHandler.presyncInputs).
            await this.#runtime.storageManager.syncCell(inputsCell, {
              scopeKeyIdentity: identity,
            });
          }
          // Materialize the inputs once through the presync transaction: the
          // link resolutions the body's first reads would otherwise pay are
          // accounted to the presync, the scheduler's read budget keeps them
          // apart from the body's own reads, and a read that dead-ends on a
          // link into another space kicks that document's load here rather
          // than in the body.
          inputsCell.asSchema(module.argumentSchema).withTx(tx).get();
        }
        : undefined;

    // Tag the handler with its owning pattern instance so the delivery shaper
    // can group a pattern's input across its several streams into one shaping
    // window (per-pattern coalescing, W3). The result cell is stable per
    // instance, so all of one instance's handlers share this id.
    const instanceLink = resultCell.getAsNormalizedFullLink();
    const wrappedHandler = Object.assign(handler, {
      implementationSelection: schedulerRehydration.implementationSelection,
      viewNodeId: schedulerRehydration.viewNodeId,
      viewLocalOnly: schedulerRehydration.viewLocalOnly,
      viewPiece: resultCell.getAsNormalizedFullLink(),
      reads,
      writes,
      module,
      pattern,
      schedulerObservationIdentity: {
        // Per scope INSTANCE, matching schedulerObservationIdentity above
        // (key-vocabulary.md §5's serving-identity sites).
        pieceId: `${
          resolveScopeKey(instanceLink.scope, this.#runtime.scopeKeyIdentity)
        }:${instanceLink.id}`,
        ownerSpace: instanceLink.space,
        // Raw root id for the per-(action × instance) run supply.
        pieceRootId: instanceLink.id,
      },
      ...(presyncInputs !== undefined && { presyncInputs }),
    });

    const schedulerReads = this.#collectArgumentSchedulerReadLinks(
      module.argumentSchema,
      inputs,
      resultCell,
    );
    const declaredSchedulerReads = schedulerReads.length > 0
      ? schedulerReads
      : reads;
    const populateDependencies = reads.length > 0
      ? (depTx: IExtendedStorageTransaction, event: any) => {
        this.#populateDeclaredSchedulerReads(declaredSchedulerReads, depTx);
        this.#populateHandlerEventSchedulerReads(
          module.argumentSchema,
          resultCell,
          event,
          depTx,
        );
      }
      : module.argumentSchema
      ? (depTx: IExtendedStorageTransaction, event: any) => {
        const eventInputs = {
          ...(inputs as Record<string, any>),
          $event: event,
        };
        const inputsCell = this.#runtime.getImmutableCell(
          resultCell.space,
          eventInputs,
          undefined,
          depTx,
        );
        inputsCell.asSchema(module.argumentSchema!).get({
          traverseCells: true,
        });
      }
      : undefined;

    addCancel(
      this.#runtime.scheduler.addEventHandler(
        wrappedHandler,
        streamLink,
        populateDependencies,
      ),
    );
  }

  #instantiateJavaScriptActionNode(
    {
      tx,
      module,
      resultCell,
      addCancel,
      pattern,
      fn,
      name,
      inputs,
      outputs,
      reads,
      writes,
      inputsCell,
      schedulerRehydration,
    }: JavaScriptNodeContext,
  ): void {
    const previousResultCellRef: JavaScriptActionResultCells = {
      byScope: new Map(),
    };
    let previouslyInvalidArgument = false;
    const fnSource = fn.toString();
    // See the handler's counterpart above: what names the node, reduced once
    // here rather than on every action invocation.
    const resultFor = {
      inputs: causalFormOfBinding(inputs),
      outputs: causalFormOfBinding(outputs),
      fn: fnSource,
    };

    const actionResultCell = schedulerRehydration.viewLocalOnly
      ? resultCell.withTx()
      : resultCell;
    const action: Action & {
      ignoredSchedulingWrites?: NormalizedFullLink[];
    } = (tx: IExtendedStorageTransaction) =>
      // A frame context of its own, as for a handler.
      runInFrameContext(() => runAction(tx));
    const runAction = (tx: IExtendedStorageTransaction) => {
      const resultCell = schedulerRehydration.viewLocalOnly
        ? actionResultCell.withTx(tx)
        : actionResultCell;
      action.ignoredSchedulingWrites = [];
      if (schedulerRehydration.implementationSelection?.matches(tx) === false) {
        return;
      }
      const policyFacingIdentity = resolvePolicyFacingImplementationIdentity(
        module,
        { implementation: fn },
      );
      const frame = this.#createPatternFrame(
        resultFor,
        pattern,
        resultCell,
        tx,
        false,
        policyFacingIdentity,
      );
      (action as Action & { lastFrame?: Frame }).lastFrame = frame;
      if (policyFacingIdentity) {
        tx.setCfcImplementationIdentity(policyFacingIdentity);
      }

      const handleErrorOutput = (error: unknown) => {
        // RetryImmediately is an internal control-flow signal: re-throw it
        // untouched so the scheduler re-runs the action instead of writing an
        // error result into the binding.
        if (error instanceof RetryImmediately) throw error;
        if (
          error !== null &&
          (typeof error === "object" || typeof error === "function")
        ) {
          (error as Error & { frame?: Frame }).frame = frame;
        }
        try {
          sendValueToBinding(
            tx,
            resultCell,
            getMetaLink(resultCell, "argument")!,
            outputs,
            undefined,
          );
        } catch (bindingError) {
          logger.error(
            "runner",
            "Failed to write undefined to binding on error",
            bindingError,
          );
        }
        throw error;
      };

      let popFrameAfterReturn = true;
      // Assigned inside the try before the body is invoked, and reachable from
      // the catch: a refusal that escaped the body, synchronously or as a
      // rejection, is disposed of through the same result path as one the
      // body swallowed.
      let postRun: ((result: any) => any) | undefined;
      try {
        logger.timeStart("action", "readInputs");
        tx.resetNarrowestReadScope();
        // A lift reads its argument, and reads through it while it runs. Both
        // go lazily: the body materializes the paths it touches and nothing
        // else. Turned off again before the result is written, so diffing and
        // the scheduler's own reads keep eager semantics.
        if (this.#runtime.experimental.lazyMaterialization) {
          tx.markLazyMaterialize(true);
        }
        const { argument, isValidArgument } = (() => {
          try {
            return this.#readJavaScriptArgument(
              module,
              inputsCell,
              tx,
              { bindTxToSchema: true },
            );
          } finally {
            logger.timeEnd("action", "readInputs");
          }
        })();

        this.#updateInvalidInputFlag(
          name,
          isValidArgument,
          module,
          inputsCell,
        );

        if (!isValidArgument || previouslyInvalidArgument) {
          logger.info(
            "action",
            () => [
              isValidArgument
                ? "action argument is valid now -- running"
                : "action argument is undefined (potential schema mismatch) -- not running",
              this.#getJavaScriptInputState(module, inputsCell),
            ],
          );
          previouslyInvalidArgument = !isValidArgument;
        }

        postRun = (result: any) => {
          logger.timeStart("action", "postRun");
          try {
            tx.markLazyMaterialize(false);
            // A refusal is recorded on the transaction as well as thrown, so a
            // body that caught it — its own `try`/`catch`, a discarded
            // rejection — does not get to hand back a result built on data the
            // schema does not describe. Either way the run is disposed of as an
            // argument that did not resolve: an undefined result through the
            // ordinary path, not an error. The reads it took are registered,
            // including the one that failed, so it runs again when the data
            // changes and may then find it valid.
            const refusal = tx.takeSchemaRefusal();
            if (refusal !== undefined) {
              logger.info(
                "action",
                () => [
                  "action argument stopped matching its schema -- not running",
                  refusal instanceof Error ? refusal.message : refusal,
                ],
              );
              result = undefined;
            }
            if (frame.pendingSpaceNames && frame.pendingSpaceNames.size > 0) {
              return this.#resolvePendingSpaceNamesAndRetry(frame, tx);
            }
            const normalized = normalizeSandboxResult(result, name);
            return this.#writeJavaScriptActionResult(
              tx,
              module.resultSchema,
              normalized.value,
              normalized.hasReactive,
              frame,
              resultCell,
              outputs,
              addCancel,
              resultFor,
              previousResultCellRef,
              tx.getNarrowestReadScope(),
            );
          } finally {
            logger.timeEnd("action", "postRun");
          }
        };

        let result: any = undefined;
        if (isValidArgument) {
          logger.timeStart("action", "invokeJavaScriptImplementation");
          try {
            result = this.#invokeJavaScriptImplementation(
              module,
              fn,
              argument,
            );
            if (result instanceof Promise) {
              result = result.finally(() =>
                logger.timeEnd("action", "invokeJavaScriptImplementation")
              );
            } else {
              logger.timeEnd("action", "invokeJavaScriptImplementation");
            }
          } catch (error) {
            logger.timeEnd("action", "invokeJavaScriptImplementation");
            throw error;
          }
        }

        const postRunResult = result instanceof Promise
          // An async body reaches mismatching data after an `await`, so its
          // refusal arrives as a rejection the synchronous catch below never
          // sees. Route it to the same disposition a synchronous one gets —
          // an undefined result through the ordinary path — before the generic
          // error handler turns it into a reported action failure.
          ? result
            .then(postRun)
            .catch((error: unknown) =>
              isSchemaMismatchError(error)
                ? postRun!(undefined)
                : handleErrorOutput(error)
            )
          : postRun(result);
        if (postRunResult instanceof Promise) {
          popFrameAfterReturn = false;
          return postRunResult.finally(() => popFrame(frame));
        }
        return postRunResult;
      } catch (error) {
        // The action body may throw while materializing a not-yet-resolved
        // inSpace("name") child. If so, resolve the pending names and retry
        // instead of surfacing the error.
        if (
          !(error instanceof RetryImmediately) &&
          frame.pendingSpaceNames && frame.pendingSpaceNames.size > 0
        ) {
          popFrameAfterReturn = false;
          return this.#resolvePendingSpaceNamesAndRetry(frame, tx)
            .finally(() => popFrame(frame));
        }
        // A refusal that escaped the body takes the same disposition as one it
        // swallowed: the run could not proceed on the data available, which is
        // a non-event rather than a fault.
        if (isSchemaMismatchError(error)) return postRun?.(undefined);
        handleErrorOutput(error);
      } finally {
        if (popFrameAfterReturn) popFrame(frame);
      }
    };

    // Identity stamping is UNCONDITIONAL — the single identity channel (the
    // scheduler reads only these stamps; there is no fallback derivation).
    // The debug NAME below may come from sidecar-backed `fn.src`, authored
    // `fn.name`, or a fallback function name, but identity must not depend on
    // any of them: gating the stamps on `name` silently re-opened the per-symbol
    // multi-instance collision (N instances of one lift sharing one id, so one
    // actionStats entry and one durable observation) whenever no name existed.
    //
    // Use the RESOLVED implementation `fn` (`resolveByImplRef(module) ?? …`),
    // not `module.implementation`: an `$implRef`-resolved module (reloaded from
    // a serialized graph) carries the ref, not the live function, so reading
    // provenance off `module.implementation` would drop the content-addressed
    // scheduler identity on reload.
    this.#applyImplementationHash(action, fn);
    const selectedActions = schedulerRehydration.implementationSelection
      ?.actions;
    if (selectedActions !== undefined) {
      selectedActions.add(action);
      addCancel(() => selectedActions.delete(action));
    }
    const instanceKey = programActionInstanceKey(
      schedulerActionInstanceKey({
        process: resultCell.getAsNormalizedFullLink(),
        reads,
        writes,
      }),
      schedulerRehydration.implementationSelection,
    );
    (action as { schedulerInstanceKey?: string }).schedulerInstanceKey =
      instanceKey;
    if (name) {
      setRunnableName(
        action,
        schedulerJavaScriptActionName(name, instanceKey),
        { setSrc: true },
      );
    }

    // Writable arguments alone do not make an output-producing action a
    // materializer: pure UI computations frequently read Writable cells. The
    // transformer marks callbacks that actually write through captured cells;
    // the opaque-result fallback covers older generated side-write modules
    // that do not carry that metadata.
    const materializerWriteEnvelopes = module.materializerWriteEnvelopes ??
      (module.materializerWriteInputPaths !== undefined
        ? this.#collectWritableCellArgumentLinks(
          module.argumentSchema,
          inputs,
          resultCell,
          module.materializerWriteInputPaths,
        )
        : this.#moduleHasOpaqueResult(module)
        ? this.#collectWritableCellArgumentLinks(
          module.argumentSchema,
          inputs,
          resultCell,
        )
        : []);
    const hasMaterializerWriteEnvelopes = materializerWriteEnvelopes.length > 0;
    const redirectWriteTargets = (!hasMaterializerWriteEnvelopes ||
        module.completeSchedulerScopeSummary === true)
      ? this.#collectStaticRedirectWriteTargetsWithCompleteness(tx, writes)
      : { targets: [], complete: true };
    const redirectReadTargets = module.completeSchedulerScopeSummary === true
      ? this.#collectStaticReadTargetsWithCompleteness(tx, reads)
      : { targets: [], complete: true };
    const staticRedirectWriteTargets = hasMaterializerWriteEnvelopes
      ? []
      : redirectWriteTargets.targets;
    const schedulingWrites = dedupeNormalizedLinks([
      ...writes,
      ...staticRedirectWriteTargets,
    ]);
    const structuralMetaLinks = module.completeSchedulerScopeSummary === true
      ? (["pattern", "argument", "result"] as const)
        .map((field) => getMetaLink(resultCell, field))
        .filter((link): link is NormalizedFullLink => link !== undefined)
      : [];
    const internalMetaLink = module.completeSchedulerScopeSummary === true
      ? getMetaCell(resultCell, "internal", tx)
        .getAsNormalizedFullLink()
      : undefined;
    const derivedInternalLinks = module.completeSchedulerScopeSummary === true
      ? (pattern.derivedInternalCells ?? []).map((descriptor) =>
        getDerivedInternalCellLink(resultCell, descriptor)
      )
      : [];
    const wrappedAction = Object.assign(action, {
      viewNodeId: schedulerRehydration.viewNodeId,
      viewLocalOnly: schedulerRehydration.viewLocalOnly,
      viewPiece: resultCell.getAsNormalizedFullLink(),
      reads,
      writes: schedulingWrites,
      ...(hasMaterializerWriteEnvelopes ? { materializerWriteEnvelopes } : {}),
      ...(module.completeSchedulerScopeSummary === true &&
          schedulerRehydration.implementationSelection === undefined &&
          redirectWriteTargets.complete && redirectReadTargets.complete
        ? {
          completeSchedulerScopeSummary: {
            complete: true as const,
            piece: resultCell.getAsNormalizedFullLink(),
            // The callback's declared reads are only part of the action's
            // structurally fixed read surface. Reads follow static redirects;
            // the runner also materializes the immutable argument container
            // and reads direct output cells while diffing/writing their values.
            // Include those framework reads in the trusted certificate so a
            // complete space-only lift is not mistaken for a contradiction.
            reads: dedupeNormalizedLinks([
              ...reads,
              ...redirectReadTargets.targets,
              inputsCell.getAsNormalizedFullLink(),
              resultCell.getAsNormalizedFullLink(),
              ...structuralMetaLinks,
              ...(internalMetaLink ? [internalMetaLink] : []),
              ...derivedInternalLinks,
              ...schedulingWrites,
            ]),
            writes: dedupeNormalizedLinks([
              ...schedulingWrites,
              ...redirectWriteTargets.targets,
            ]),
            materializerWriteEnvelopes,
            directOutputs: writes,
          },
        }
        : {}),
      module,
      pattern,
    });

    addCancel(
      this.#runtime.scheduler.subscribe(wrappedAction, {
        ...schedulerRehydration,
      }),
    );
  }

  #instantiateJavaScriptNode(
    tx: IExtendedStorageTransaction,
    plan: NodePlan & { kind: "javascript" },
    resultCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
  ) {
    const { module, inputs, outputs, writes } = plan;
    // Pre-sync reads the inputs document under the module's schema. Only
    // instantiation needs the scheduler's static read links, so resolve them
    // here, under the same machinery-read boundary as the bound plan.
    const reads = tx.runWithAmbientReadMeta(
      machineryRead,
      () =>
        findAllWriteRedirectCells(inputs, resultCell, {
          followRedirectChains: !usesLocalReads(resultCell.tx),
        }),
    );
    const { fn, name } = this.#resolveJavaScriptFunction(module);
    const context: JavaScriptNodeContext = {
      tx,
      module,
      resultCell,
      addCancel,
      pattern,
      fn,
      name,
      schedulerRehydration,
      inputs,
      outputs,
      reads,
      writes,
      inputsCell: plan.inputsCell,
    };

    const streamLink = this.#handlerStreamLink(
      module,
      inputs,
      resultCell.getAsNormalizedFullLink(),
      name,
    );
    if (streamLink) {
      this.#instantiateJavaScriptHandlerNode({ ...context, streamLink });
      return;
    }

    this.#instantiateJavaScriptActionNode(context);
  }

  #getFallbackJavaScriptImplementation(
    module: Module,
  ): (...args: any[]) => any {
    const implRef = this.#contentAddressedImplRef(module);
    if (implRef) {
      // The module carries a content-addressed `$implRef` — it was expected to
      // resolve through the verified registry — yet resolution fell through to
      // here. The action will run
      // SES-recompiled and CFC-unverified (`writeAuthorizedBy` sees
      // `unsupported`), so leave a breadcrumb for enforcement-mode debugging.
      logger.debug("verified-fallback-downgrade", () => [
        "Verified function resolution missed; running SES-recompiled," +
        " CFC-unverified fallback",
        { $implRef: implRef },
      ]);
    } else {
      // No `$implRef` at all: the module carries neither provenance nor a
      // verified entry ref, so the bare-SES re-evaluation below is the only
      // resolution left. Module-scope references do not exist under that
      // evaluator, so when a module that needs them lands here, helpers fail
      // at call time with no upstream signal — this counter is the tell.
      // Counts increment even while the logger is disabled, so a live
      // worker's logger ledger always exposes how often unverified source is
      // executing.
      logger.error("unverified-source-fallback", () => [
        "Module reached resolution with no $implRef; running SES-recompiled," +
        " CFC-unverified fallback from stringified source",
        {
          preview: typeof module.implementation === "function"
            ? Function.prototype.toString.call(module.implementation).slice(
              0,
              80,
            )
            : String(module.implementation).slice(0, 80),
        },
      ]);
    }
    if (typeof module.implementation === "function") {
      return this.#runtime.harness.getInvocation(
        Function.prototype.toString.call(module.implementation),
      ) as (...args: any[]) => any;
    }
    if (typeof module.implementation === "string") {
      return this.#runtime.harness.getInvocation(module.implementation) as (
        ...args: any[]
      ) => any;
    }
    throw new Error(
      "JavaScript module is missing an executable implementation",
    );
  }

  #invokeJavaScriptImplementation(
    module: Module,
    fn: (...args: any[]) => any,
    argument: unknown,
  ): unknown {
    const invoke = () => {
      if (module.wrapper === "handler") {
        const event = isObjectOrArray(argument) && "$event" in argument
          ? argument.$event
          : undefined;
        const context = isObjectOrArray(argument) && "$ctx" in argument
          ? argument.$ctx
          : undefined;
        return fn(event, context);
      }

      return fn(argument);
    };

    // Builder artifacts cannot be minted inside a running action: they would
    // have no content-addressed identity, no provenance, and — closure-bearing
    // — no serializable body, so nothing could ever rehydrate them. The
    // transformer hoists every authored builder call to module scope; the
    // window makes a mint that slipped through fail loudly at creation time
    // (see builder/frame-context.ts) instead of producing an unrehydratable
    // value. The window is kept on the action's frame context, so an async
    // action's continuations stay covered past its awaits.
    return runInActionExecution(invoke);
  }

  /**
   * For the list builtins (`map`/`filter`/`flatMap`), annotates the `op` input
   * with its content-addressed `{ identity, symbol }` entry ref (when known) so
   * the builtin can resolve the live canonical pattern by identity instead of
   * deserializing the embedded graph. Mutates `inputBindings` in place: `op`
   * becomes `{ $patternRef }`.
   *
   * Only the `op` key is rewritten — it is the sole pattern-valued input the
   * builtins rehydrate (`resolveOpPattern`). Rewriting other inputs (e.g. a
   * pattern captured in `params`) would leave an unresolved `$patternRef` object
   * that nothing reads back.
   *
   * The sentinel carries NO embedded fallback graph: the artifact index is
   * session-lifetime, and the op's module evaluated in this session by
   * construction (the sentinel is stamped from its live artifact right here),
   * so the builtin's sync resolution cannot miss short of a bug — and a bug
   * should be loud, not silently served a stale graph.
   *
   * The `op` substitution below writes through `inputBindings`, so it needs
   * that record to be a fresh copy rather than the node's own `inputs`.
   * `unwrapOneLevelAndBindToDoc` shares structure — it returns the original for
   * any container under which nothing rebound — so the copy is not guaranteed
   * in general. It is guaranteed HERE: this path runs only for the list
   * builtins, whose `list` input is an alias, so the root always rebinds and is
   * always copied.
   *
   * Either way the ref resolves. A copied pattern value carries its derivation
   * link (`noteDerivedCopy`), and a shared one simply IS the original, so
   * `getArtifactEntryRef` finds the ref (assigned post-eval by
   * `registerEvaluatedModules`) in both cases.
   *
   * An op with NO known ref but a LIVE trusted original is a KEYLESS pattern —
   * hand-built through the in-process builder DSL, or evaluated through the
   * bare non-registering `Engine.compileAndEvaluateModules` — whose serialized
   * copy carries a derivation link to its pristine in-memory pattern. It is
   * minted its content-hash session identity right here (the same pointer
   * `#entryRefForPattern` mints for a keyless ROOT pattern) — but that identity
   * is session-synthetic and must never land in the durable inputs doc. So the
   * op is LEFT IN PLACE — the boundary walk inside `getImmutableCell`
   * serializes its full graph, readable by any session — and the minted ref is
   * returned for the caller to register as a SESSION-side resolution hint keyed
   * by the inputs doc (`registerKeylessOpResolution`): the builtin then
   * resolves the pristine artifact in-session, so the embedded round-trip's
   * defer corruption never engages for the instantiating session. The trust
   * gate stays intact: minting BRANDS, so only a value whose original is
   * already a trusted builder pattern is minted.
   *
   * An op with no ref AND no live original — a plain deserialized graph, i.e. a
   * STORED no-entry-ref pattern value (the live keyless writer path pinned by
   * stored-pattern-rehydration.test.ts) — is left embedded with no hint: there
   * is no pristine artifact in existence to point at. Such an op takes the
   * builtin's legacy graph path.
   */
  #substituteOpPatternRefs(
    moduleRefName: string | undefined,
    inputBindings: FabricExecValue,
  ): { identity: string; symbol: string } | undefined {
    if (
      moduleRefName !== "map" && moduleRefName !== "filter" &&
      moduleRefName !== "flatMap"
    ) {
      return undefined;
    }
    if (!isObjectOrArray(inputBindings)) return undefined;
    const op = (inputBindings as Record<string, unknown>).op;
    if (!isObjectOrArray(op)) return undefined;
    const ref = this.#runtime.patternManager.getArtifactEntryRef(
      op as unknown as object,
    );
    if (ref && !PatternManager.isKeylessPatternIdentity(ref.identity)) {
      (inputBindings as Record<string, unknown>).op = {
        $patternRef: { identity: ref.identity, symbol: ref.symbol },
      };
      return undefined;
    }
    const original = resolveOriginal(op as unknown as object);
    if (isTrustedBuilderArtifact(original) && isPattern(original)) {
      // Keyless: session mint only — never substituted into the (durable)
      // bindings; the caller registers the in-session hint.
      return this.#runtime.patternManager.ensureKeylessPatternIdentity(
        original as unknown as Pattern,
      );
    }
    return undefined;
  }

  /**
   * A raw builtin node's bound inputs and output binding: what
   * `#instantiateRawNode` hands the builtin, derived from the node alone
   * so the resume pre-sync can derive the same for a list coordinator it
   * has not instantiated yet (`#syncResumeListChildren`).
   */
  #buildRawNodeInputs(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricExecValue,
    outputBindings: FabricExecValue,
    resultCell: Cell<any>,
    pattern: Pattern,
    moduleRefName: string | undefined,
    argumentCellLink: NormalizedFullLink = getMetaLink(
      resultCell,
      "argument",
    )!,
  ): RawNodeInputs {
    const mappedInputBindings = unwrapOneLevelAndBindToDoc(
      inputBindings,
      argumentCellLink,
      resultCell,
      {
        derivedInternalCells: pattern.derivedInternalCells,
        argumentCapSchema: pattern.argumentSchema,
      },
    );
    const mappedOutputBindings = unwrapOneLevelAndBindToDoc(
      outputBindings,
      argumentCellLink,
      resultCell,
      {
        derivedInternalCells: pattern.derivedInternalCells,
        argumentCapSchema: pattern.argumentSchema,
      },
    );

    // For the list builtins, replace a pattern-valued input (the `op`) with a
    // compact `{ $patternRef }` sentinel when its content-addressed entry ref
    // is known. This is the post-eval moment where the in-memory op object
    // (linked to its original via `noteDerivedCopy`, preserved through binding)
    // carries its `{ identity, symbol }`; the sentinel then survives the
    // immutable-cell JSON round-trip, so the builtin resolves the live
    // canonical pattern by identity instead of deserializing the embedded
    // graph. A KEYLESS op is never substituted (its session identity must not
    // land durably); the returned mint is registered below, once the inputs
    // doc's address is known, as this session's resolution hint for the
    // builtin.
    const keylessOpRef = this.#substituteOpPatternRefs(
      moduleRefName,
      mappedInputBindings,
    );

    // outputCells tracks the static write surface for dependency ordering and
    // event preflight.
    const outputCells = findAllWriteRedirectCells(
      mappedOutputBindings,
      resultCell,
    );

    // The input bindings are about to cross into the data model, and a
    // pattern author can bind a builder artifact (a handler, a pattern) as an
    // ordinary input value at any depth. Each is replaced with its serialized
    // form on the way, so what crosses is representable -- by the walk INSIDE
    // `getImmutableCell`, not by a call here. That it happens there and not
    // alongside the `op` substitution above is what keeps it clear of
    // `findAllWriteRedirectCells`, which walks the same bindings for a
    // different purpose and must see them as bound.
    const inputsCell = this.#runtime.getImmutableCell(
      resultCell.space,
      mappedInputBindings,
      undefined,
      tx,
    );
    if (keylessOpRef !== undefined) {
      // The keyless op's in-session resolution hint (see
      // `#substituteOpPatternRefs`): the builtin reads the embedded graph from
      // this immutable doc and resolves the pristine minted artifact through
      // this registration instead (the embedded round-trip's defer corruption
      // never engages in-session, and nothing keyless is durable).
      this.#runtime.patternManager.registerKeylessOpResolution(
        opInputsDocKey(inputsCell),
        keylessOpRef,
      );
    }

    // The output spot this node writes through is reserved for this node, so
    // its fully-resolved coordinates are a stable, position-derived,
    // program-independent identity. Builtins that mint a result container
    // (map/flatmap/filter) key it on this instead of the serialized op / inputs
    // cell (both of which drag in the session-varying `program`).
    const resolvedOutputSpot = firstResolvedOutputRedirect(
      this.#runtime,
      tx,
      mappedOutputBindings,
      resultCell,
    );

    // The output spot's *declared* scope is not inherently on the resolved link
    // (`.asScope("user")` lands on `module.defaultScope`, and a `PerUser<>`
    // annotation on `module.resultSchema.scope`), so fold both in here and hand
    // the builtin a fully-normalized output link carrying that scope + schema.
    // Scope-aware builtins (sqliteDatabase) mint their result container at this
    // scope; the rest ignore the extra argument.
    const outputBinding = resolvedOutputSpot
      ? {
        ...resolvedOutputSpot,
        scope: schemaCellScope(module.resultSchema) ??
          module.defaultScope ?? resolvedOutputSpot.scope,
      }
      : undefined;
    return {
      inputs: mappedInputBindings,
      outputs: mappedOutputBindings,
      writes: outputCells,
      argumentCellLink,
      inputsCell,
      resolvedOutputSpot,
      outputBinding,
    };
  }

  #instantiateRawNode(
    tx: IExtendedStorageTransaction,
    plan: NodePlan & { kind: "raw" },
    resultCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
  ) {
    const {
      module,
      moduleRefName,
      argumentCellLink,
      outputs: mappedOutputBindings,
      writes: outputCells,
      inputsCell,
      resolvedOutputSpot,
      outputBinding,
    } = plan;
    // Opaque forwarded references (e.g. ifElse's unselected branch) are
    // never value-read by the builtin. Exclude them from its declared reads
    // so the scheduler does not pull their writers. Resume pre-sync uses
    // inputsCell directly and does not need this scheduler read list.
    const opaqueInputKeys = opaqueArgumentKeys(module.argumentSchema);
    const inputCells = tx.runWithAmbientReadMeta(
      machineryRead,
      () =>
        findAllWriteRedirectCells(
          plan.inputs,
          resultCell,
          opaqueInputKeys.size > 0
            ? { skipTopLevelKeys: opaqueInputKeys }
            : undefined,
        ),
    );
    if (typeof module.implementation !== "function") {
      throw new Error(
        `Raw module is not a function, got: ${module.implementation}`,
      );
    }

    const builtinIdentity = resolveBuiltinImplementationIdentity(module);
    if (builtinIdentity) {
      tx.setCfcImplementationIdentity(builtinIdentity);
    }

    const builtinFrame = builtinIdentity
      ? pushFrameFromCause(undefined, {
        runtime: this.#runtime,
        tx,
        space: resultCell.space,
        implementationIdentity: builtinIdentity,
      })
      : undefined;
    let builtinResult: RawBuiltinReturnType;
    try {
      builtinResult = module.implementation(
        inputsCell,
        (tx: IExtendedStorageTransaction, result: any) => {
          const outputBindingSchema = schemaForRawBuiltinRootOutputBinding(
            tx,
            this.#runtime,
            resultCell,
            mappedOutputBindings,
          );
          recordRawBuiltinBindingSchemaPolicyInputs(
            tx,
            this.#runtime,
            resultCell,
            mappedOutputBindings,
          );
          recordRawBuiltinResultSchemaPolicyInput(
            tx,
            result,
          );
          sendValueToBinding(
            tx,
            resultCell,
            argumentCellLink!,
            mappedOutputBindings,
            resultForRawBuiltinOutputBinding(
              result,
              outputBindingSchema,
              builtinIdentity,
            ),
            { preserveLinkOutput: true },
          );
        },
        addCancel,
        {
          inputs: inputsCell,
          parents: resultCell.entityId,
          ...(resolvedOutputSpot
            ? {
              outputSpot: {
                space: resolvedOutputSpot.space,
                id: resolvedOutputSpot.id,
                path: [...resolvedOutputSpot.path],
              },
            }
            : {}),
        } satisfies RawNodeCause,
        resultCell,
        this.#runtime,
        outputBinding,
        // The resumed-from-synced-state flag is passed out-of-band (a behavioral
        // param, like `outputBinding`) instead of folded into the identity
        // `cause` above. It is transient (present only on resume), so hashing it
        // into the result-cell id would diverge a fresh runtime from a resumed
        // one for the same logical node — the root of the cross-runtime write
        // storm. Container-minting builtins (map/filter/flatMap) read it to
        // defer their per-element sub-pattern runs until sync completes too.
        defersInitialRunUntilSynced(schedulerRehydration),
        resolvedOutputSpot,
      );
    } finally {
      if (builtinFrame) popFrame(builtinFrame);
    }

    // Handle both legacy (just Action) and new (RawBuiltinResult) return formats
    const builtinAction = isRawBuiltinResult(builtinResult)
      ? builtinResult.action
      : builtinResult;
    // Capture point 2 of navigate-context.ts (builtins.md §4):
    // tag the builtin's action with the event context its instantiation
    // was a consequence of — the deferred start's carried context, or
    // the instantiating handler tx's own stamp when the result pattern
    // runs under it directly. The builtin's later scheduler runs (which
    // stamp as ordinary derivations) read the tag off the action. OFF
    // arm: both sources are undefined; one WeakMap miss.
    const navigateContext = navigateEventContextOf(tx) ??
      navigateEventContextFromRunInfo(
        waveRunContextOf(tx) ?? speculationRunContextOf(tx),
      );
    if (navigateContext !== undefined) {
      setNavigateEventContext(builtinAction, navigateContext);
    }
    const builtinIsEffect = isRawBuiltinResult(builtinResult)
      ? builtinResult.isEffect
      : undefined;
    const builtinDebounce = isRawBuiltinResult(builtinResult)
      ? builtinResult.debounce
      : undefined;
    const builtinNoDebounce = isRawBuiltinResult(builtinResult)
      ? builtinResult.noDebounce
      : undefined;
    const builtinThrottle = isRawBuiltinResult(builtinResult)
      ? builtinResult.throttle
      : undefined;
    const builtinDependencies = isRawBuiltinResult(builtinResult)
      ? builtinResult.dependencies
      : undefined;
    const useDeclaredReadsAsDependencies = isRawBuiltinResult(builtinResult)
      ? builtinResult.useDeclaredReadsAsDependencies
      : false;
    const deferUntilDemand = isRawBuiltinResult(builtinResult)
      ? builtinResult.deferUntilDemand
      : undefined;
    const builtinOnActionRegistered = isRawBuiltinResult(builtinResult)
      ? builtinResult.onActionRegistered
      : undefined;

    // Name the raw action for debugging - use implementation name or fallback to "raw"
    const impl = module.implementation as ((...args: unknown[]) => Action) & {
      src?: string;
      name?: string;
    };
    const rawTargetName = sanitizeDebugLabel(
      moduleRefName,
    ) ??
      sanitizeDebugLabel(
        (module as { debugName?: string }).debugName,
      ) ??
      sanitizeDebugLabel(impl.src) ??
      sanitizeDebugLabel(impl.name) ??
      "anonymous";
    const rawInstanceKey = programActionInstanceKey(
      schedulerActionInstanceKey({
        reads: inputCells,
        writes: outputCells,
      }),
      schedulerRehydration.implementationSelection,
    );
    const rawName = schedulerRawActionName(rawTargetName, rawInstanceKey);

    const action: Action = (tx: IExtendedStorageTransaction) => {
      if (schedulerRehydration.implementationSelection?.matches(tx) === false) {
        return;
      }
      logger.timeStart("raw", "run", rawTargetName);
      try {
        const result = builtinAction(tx);
        if (result instanceof Promise) {
          return result.finally(() =>
            logger.timeEnd("raw", "run", rawTargetName)
          );
        }
        logger.timeEnd("raw", "run", rawTargetName);
        return result;
      } catch (error) {
        logger.timeEnd("raw", "run", rawTargetName);
        throw error;
      }
    };
    setRunnableName(action, rawName, { setSrc: true });
    const selectedActions = schedulerRehydration.implementationSelection
      ?.actions;
    if (selectedActions !== undefined) {
      selectedActions.add(action);
      addCancel(() => selectedActions.delete(action));
    }
    this.#applyImplementationHash(action, impl);
    (action as { schedulerInstanceKey?: string }).schedulerInstanceKey =
      rawInstanceKey;

    // Annotate raw actions with their pattern/module/write metadata so
    // scheduler registration can derive static surfaces and ordering hints.
    const staticRedirectWriteTargets = module.materializerWriteEnvelopes
      ? []
      : this.#collectStaticRedirectWriteTargets(tx, outputCells);
    const schedulingWrites = dedupeNormalizedLinks([
      ...outputCells,
      ...staticRedirectWriteTargets,
    ]);
    Object.assign(action, builtinAction, {
      reads: inputCells,
      writes: schedulingWrites,
      ...(module.materializerWriteEnvelopes
        ? { materializerWriteEnvelopes: module.materializerWriteEnvelopes }
        : {}),
      module,
      pattern,
    });

    // isEffect can come from module options or from the builtin result
    const isEffect = module.isEffect ?? builtinIsEffect;
    const debounce = module.debounce ?? builtinDebounce;
    const noDebounce = module.noDebounce ?? builtinNoDebounce;
    const throttle = module.throttle ?? builtinThrottle;

    const schedulerDependencies = builtinDependencies ??
      (useDeclaredReadsAsDependencies
        ? {
          reads: inputCells.map(toMemorySpaceAddress),
          shallowReads: [],
          writes: [],
        }
        : undefined);
    const schedulerOptions = {
      isEffect,
      deferUntilDemand,
      debounce,
      noDebounce,
      throttle,
      ...schedulerRehydration,
    };

    addCancel(
      schedulerDependencies
        ? this.#runtime.scheduler.subscribe(
          action,
          schedulerDependencies,
          schedulerOptions,
        )
        : this.#runtime.scheduler.subscribe(action, schedulerOptions),
    );
    // The scheduler is keyed by the wrapper's identity, so hand the builtin
    // the wrapper — its own `action` cannot address the subscription.
    builtinOnActionRegistered?.(action);
  }

  #instantiatePassthroughNode(
    tx: IExtendedStorageTransaction,
    plan: NodePlan & { kind: "passthrough" },
    resultCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
  ) {
    const argumentCellLink = getMetaLink(resultCell, "argument")!;
    const initialize = (instanceTx: IExtendedStorageTransaction) => {
      sendValueToBinding(
        instanceTx,
        resultCell.withTx(instanceTx),
        argumentCellLink,
        plan.outputs,
        plan.inputs,
        { derivedInternalCells: pattern.derivedInternalCells },
      );
    };
    initialize(tx);
    const initializers = schedulerRehydration.implementationSelection
      ?.instanceInitializers;
    if (initializers !== undefined) {
      initializers.add(initialize);
      addCancel(() => initializers.delete(initialize));
    }
  }

  /**
   * Binds a pattern node's child, inputs, and outputs on `resultCell`, and
   * derives the result cell the child runs under, the way its instantiation
   * mints it: from the fully resolved output spot the node writes through.
   */
  #bindPatternNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricExecValue,
    outputBindings: FabricExecValue,
    resultCell: Cell<any>,
    pattern: Pattern,
    argumentLink?: NormalizedFullLink,
  ): PatternNodeBinding {
    // May be undefined: the owned-cell walk plans before setup writes the
    // meta on a fresh first run, and a child result cell is not synced yet
    // on a cold-cache resume. Binding needs the link only when an alias
    // actually names the argument document, and throws otherwise.
    // Substituting a different document instead would derive the wrong
    // `resultFor` identity and pre-sync the wrong owned-cell subtree;
    // a stand-in a caller supplies deliberately is what the
    // fresh run's pre-sync binds against.
    const argumentCellLink = argumentLink ??
      getMetaLink(resultCell, "argument");
    if (!isPattern(module.implementation)) throw new Error(`Invalid pattern`);
    // The child's nodes are bound as the child's own start sees them: this
    // bind crosses one `defer` boundary of every alias inside the
    // implementation before the child instantiates it.
    const child = unwrapOneLevelAndBindToDoc(
      module.implementation,
      argumentCellLink,
      resultCell,
      { derivedInternalCells: pattern.derivedInternalCells },
    );
    // A node's inputs nearly always alias the argument document, so without
    // the link they stay unbound: a walk that runs before setup writes the
    // link wants the child's identity, which the outputs alone anchor, and
    // instantiation never runs without it.
    const inputs = argumentCellLink === undefined
      ? inputBindings
      : unwrapOneLevelAndBindToDoc(
        inputBindings,
        argumentCellLink,
        resultCell,
        {
          targetSchema: child.argumentSchema,
          derivedInternalCells: pattern.derivedInternalCells,
          // The links serialized into the sub-piece's argument doc must keep
          // the containing pattern's declared slot scopes; the authored
          // schema is the only place those declarations still exist (the
          // meta link carries a sanitized schema). See
          // foldDeclaredScopeIntoLinkSchema.
          sourceSchemas: { argument: pattern.argumentSchema },
        },
      );
    // VALUE BIND (kind: the descriptor's). Binding WITH the manifest resolves a
    // partialCause output to the descriptor's derived internal cell, so
    // `getDerivedInternalCellLink` mints its id under the descriptor's kind:
    // `computed:fid1:<hash>` for a descriptor classified `kind: "computed"`,
    // and the same `of:fid1:<hash>` the identity bind below mints for a kindless
    // one (the classifier declines the node, or `experimental.computedCellIds`
    // is off). This is the binding the child link is SENT to
    // (`sendValueToBinding` in `#instantiatePatternNode`), so this is where
    // the child's value actually lives — at a DIFFERENT entity from the
    // identity bind's only when the descriptor carries a kind. See the
    // identity bind for the pairing.
    const outputs = unwrapOneLevelAndBindToDoc(
      outputBindings,
      argumentCellLink,
      resultCell,
      {
        derivedInternalCells: pattern.derivedInternalCells,
        argumentCapSchema: pattern.argumentSchema,
      },
    );
    const io = {
      child,
      inputs,
      outputs,
      writes: findAllWriteRedirectCells(outputs, resultCell),
    };

    // If output bindings is a link to a non-redirect cell,
    // use that instead of creating a new cell.
    if (isSigilLink(outputs) && !isWriteRedirectLink(outputs)) {
      return {
        ...io,
        childResultCell: this.#runtime.getCellFromLink(
          parseLink(outputs, resultCell),
          child.resultSchema,
          tx,
        ),
        sendToBindings: false,
      };
    }
    // Identify the result cell by the (fully resolved) output spot
    // reserved for this node — a stable, position-derived, program-independent
    // identity — rather than hashing the pattern object (which drags in the
    // session-varying `program` and forces `materializeRuntimeProgram`). We
    // still mint a NEW cell and point the binding at it (`sendToBindings`);
    // we only borrow the resolved output link's coordinates as the cause. A
    // pattern node always writes through a write redirect, so the absence of
    // one leaves `childResultCell` undefined, which the instantiation refuses.
    //
    // Bind the output bindings first (as `#buildRawNodeInputs` does), so the
    // `argument`/`internal`/`result` pseudo-cell aliases resolve to their
    // DISTINCT concrete cells. Resolving the raw bindings would let pseudo
    // cells at the same path (e.g. `internal.x` vs `result.x`) collapse onto
    // the base result cell and collide on one shared child cell.
    // `bindPatterns: false` — output bindings never carry sub-patterns to
    // instantiate, so skip that work; we only need the pseudo-cell aliases
    // resolved to their concrete links.
    //
    // IDENTITY BIND (kind: always `of:`). This omits
    // `derivedInternalCells` where the value bind above passes it, and the
    // manifest descriptor is what carries the entity kind. Same cause, same
    // hash preimage — but no descriptor means no kind, so this mint always
    // lands on the unkinded `of:fid1:<hash>`
    // (docs/specs/computed-cell-identity.md: the preimage is kind-free, the
    // URI scheme IS the kind). Whether that is a SECOND entity depends on the
    // descriptor the value bind saw:
    //   - descriptor with `kind: "computed"` — the value bind minted
    //     `computed:fid1:<hash>`, so the two binds address two distinct
    //     entities that differ only by scheme, and the child link lives on
    //     the `computed:` one;
    //   - kindless descriptor (the classifier declined the node, or
    //     `experimental.computedCellIds` is off) — both binds land on this
    //     same `of:` entity, and the child link is written here.
    // The split is fine because both use the link purely as the `resultFor`
    // CAUSE — a stable coordinate, never read for a value. But anything that
    // wants to READ the child link must use the id the VALUE bind minted:
    // where the descriptor was computed, reading the `of:` one returns
    // undefined for a healthy piece.
    const mappedOutputBindings = unwrapOneLevelAndBindToDoc(
      outputBindings,
      argumentCellLink,
      resultCell,
    );
    // The manifest-blind bind above renders a partialCause alias as its
    // derived cell's kind-free id, which is cause-only — resolving it
    // would read an entity the kinded data never lives at (and kick a
    // doc pull nothing can satisfy), so the scan is told to take those
    // coordinates as they stand.
    const outputRedirect = firstResolvedOutputRedirect(
      this.#runtime,
      tx,
      mappedOutputBindings,
      resultCell,
      causeOnlySpotIds(resultCell, pattern.derivedInternalCells),
    );
    if (outputRedirect === undefined) {
      return { ...io, childResultCell: undefined, sendToBindings: true };
    }
    const resultScope = patternDefaultScope(child) ?? module.defaultScope;
    const targetSpace = module.targetSpace ?? resultCell.space;
    let childResultCell = this.#runtime.getCell(
      targetSpace,
      {
        resultFor: {
          space: outputRedirect.space,
          id: outputRedirect.id,
          path: [...outputRedirect.path],
        },
      },
      child.resultSchema,
      tx,
    );
    if (resultScope !== undefined && resultScope !== "space") {
      // The result cell's scope isn't "space", so we may have just created
      // this cell. If so, create the corresponding argument/internal cells.
      childResultCell = createCell(
        this.#runtime,
        { ...childResultCell.getAsNormalizedFullLink(), scope: resultScope },
        tx,
      );
    }
    return { ...io, childResultCell, sendToBindings: true };
  }

  #instantiatePatternNode(
    tx: IExtendedStorageTransaction,
    plan: NodePlan & { kind: "pattern" },
    resultCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    schedulerRehydration: SchedulerRehydrationSubscriptionOptions = {},
  ) {
    const parentResultCell = resultCell;
    const argumentCellLink = getMetaLink(resultCell, "argument")!;
    const { child: patternImpl, inputs, outputs, sendToBindings } = plan;
    if (plan.childResultCell === undefined) {
      throw new Error(
        "instantiatePatternNode: result cell requires a write-redirect " +
          "output binding to anchor a reload-stable identity",
      );
    }
    const childResultCell = plan.childResultCell;

    const sourceKey = getTxDebugActionId(tx) ?? "none";
    triggerFlowLogger.debug(`instantiate-pattern-node/${sourceKey}`, () => [
      `[PATTERN-NODE] source=${sourceKey}`,
      `result=${childResultCell.getAsNormalizedFullLink().id}`,
      `pattern=${describePatternOrModule(patternImpl)}`,
      `sendToBindings=${sendToBindings}`,
    ]);

    const initialize = (instanceTx: IExtendedStorageTransaction) => {
      const storedChild = childResultCell.withTx(instanceTx);
      const crossSpace = childResultCell.space !== parentResultCell.space;
      // An independently managed child owns its code and inputs, including
      // after an owner detaches it. History keeps that fact after the origin
      // is cleared; ordinary untracked nested children still bind inputs.
      const resumeExisting = crossSpace &&
        getPatternIdentityRef(storedChild) !== undefined &&
        (getPatternSource(storedChild) !== undefined ||
          getPieceSourceRevisions(storedChild).length > 0);
      if (crossSpace && !resumeExisting) {
        // Cross-space child pattern: run it inline in a multi-space transaction
        // (child space committed first) rather than re-instantiating it in a
        // deferred second transaction, which would lose its verified-function
        // identity. The journal allows the cross-space write once opted in.
        this.enableCrossSpaceChildCommit(
          instanceTx,
          childResultCell.space,
          parentResultCell.space,
        );
        // A fresh runtime navigating to the child piece loads its
        // pattern artifacts from `resultCell.space` (the child's own space),
        // where neither the meta nor the compiled closure exist yet. Replicate
        // them there (fire-and-forget) so the child is independently loadable.
        // On a SERVING runtime the replication's writebacks into the child's
        // space are FOREIGN to the home wave, so they ride the instantiating
        // run's delegated carriage (protocol.md §2b) — the served mirror of
        // the client committing the program under the user's own session;
        // without it the wave's accept gate refuses the crossing and the
        // child space's program never materializes.
        const runContext = waveRunContextOf(instanceTx);
        this.#runtime.patternManager.replicatePatternToSpace(
          patternImpl,
          childResultCell.space,
          parentResultCell.space,
          runContext?.acting !== undefined &&
            runContext.capabilityRef !== undefined
            ? {
              acting: runContext.acting,
              capabilityRef: runContext.capabilityRef,
            }
            : undefined,
        );
      }
      // Only a child in a space of its own claims one: an in-space nested
      // node is part of its parent's graph and is re-instantiated from the
      // parent's program on each release of the parent, so an origin of its
      // own would be followed twice; a cross-space child outlives the
      // program that made it and is what a release has to reach.
      const sourceOrigin = crossSpace && !resumeExisting
        ? this.#childSystemOrigin(instanceTx, parentResultCell, patternImpl)
        : undefined;
      const options = {
        awaitSyncBeforeInitialRun: defersInitialRunUntilSynced(
          schedulerRehydration,
        ),
        parentPieceRootId: parentResultCell.getAsNormalizedFullLink().id,
      };
      const childRun: RunResult<unknown> = resumeExisting
        ? this.#usesScopedPrograms(childResultCell)
          ? {
            resultCell: childResultCell,
            installedCancel: this.#startWithTx(
              instanceTx,
              storedChild,
              undefined,
              options,
            ),
          }
          : this.#resumeChildAfterCommit(instanceTx, childResultCell, options)
        : this.#runWithStartOwnership(
          instanceTx,
          patternImpl,
          inputs,
          storedChild,
          {
            ...options,
            ...(sourceOrigin === undefined ? {} : { sourceOrigin }),
          },
        );
      if (childRun.cancelDeferredStart !== undefined) {
        // Each actor initializer may own a separate pending start. Register
        // its exact token so parent teardown cannot stop a replacement run.
        const cancel = childRun.cancelDeferredStart;
        addCancel(() => {
          if (
            !this.#independentlyStartedResults.has(
              this.#getDocKey(childResultCell),
            )
          ) cancel();
        });
      }

      if (sendToBindings) {
        sendValueToBinding(
          instanceTx,
          parentResultCell.withTx(instanceTx),
          argumentCellLink,
          outputs,
          childResultCell.getAsLink(),
          { derivedInternalCells: pattern.derivedInternalCells },
        );
      }
      return childRun;
    };
    const childRun = initialize(tx);
    // Static bindings and child setup belong to each selected actor. The
    // enclosing program group owns one graph and one child retention.
    const initializers = schedulerRehydration.implementationSelection
      ?.instanceInitializers;
    if (initializers !== undefined) {
      initializers.add(initialize);
      addCancel(() => initializers.delete(initialize));
    }

    addCancel(
      this.#usesScopedPrograms(childResultCell)
        ? this.retainChild(childResultCell)
        : () => {
          if (childRun.cancelDeferredStart === undefined) {
            this.releaseChild(childResultCell, childRun.installedCancel);
          }
        },
    );
  }

  /** Resumes a child from its retained source after its parent's commit. */
  #resumeChildAfterCommit<T>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    options: StartAttempt["options"],
  ): RunResult<T> {
    const ownership = this.#createDeferredStartOwnership(resultCell);
    tx.addCommitCallback((_committedTx, result) => {
      if (result.error) {
        ownership.cancel();
        return;
      }
      if (ownership.isCancelled()) return;
      const work = this.#startFromServedState(
        resultCell.withTx(),
        ownership,
        options,
      )
        .then((started) => {
          if (!started) ownership.cancel();
        }).catch((error) => {
          ownership.cancel();
          this.#reportPieceStartCommitFailure(
            `piece-start/${resultCell.sourceURI}`,
            error,
          );
          throw error;
        });
      this.#runtime.scheduler.trackBackgroundTask(work);
    });
    return { resultCell, cancelDeferredStart: ownership.cancel };
  }
}

function getTxDebugActionId(
  tx?: IExtendedStorageTransaction,
): string | undefined {
  return tx ? (tx.tx as { debugActionId?: string }).debugActionId : undefined;
}

/**
 * Read the content-addressed `{ identity, symbol }` pattern reference — the ONLY
 * pattern pointer — from a result cell's `patternIdentity` meta. Returns
 * undefined for a cell that carries no such pointer (a keyless hand-built
 * pattern run in-session, or a legacy result cell predating the migration; the
 * latter is unrecoverable by the sanctioned data-wipe decision).
 */
export function getPatternIdentityRef(
  resultCell: Cell<unknown>,
): { identity: string; symbol: string } | undefined {
  const raw = resultCell.getMetaRaw("patternIdentity", {
    meta: ignoreReadForScheduling,
  });
  return asPatternIdentityRef(raw);
}

/**
 * Read the identity whose complete setup state was installed on a result cell.
 * This is a setup-completion marker; pattern loading uses `patternIdentity`.
 */
export function getPatternSetupIdentityRef(
  resultCell: Cell<unknown>,
): { identity: string; symbol: string } | undefined {
  const raw = resultCell.getMetaRaw("patternSetupIdentity", {
    meta: ignoreReadForScheduling,
  });
  return asPatternIdentityRef(raw);
}

/**
 * Read the active web or fabric source origin stored in `patternSource`.
 * Undefined means the piece is detached.
 */
export function getPatternSource(
  resultCell: Cell<unknown>,
): string | undefined {
  const raw = resultCell.getMetaRaw("patternSource", {
    meta: ignoreReadForScheduling,
  });
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Stamp a piece's `patternSource` provenance. Meta writes are transactional, so
 * a transaction is required (mirrors the `patternIdentity` write).
 */
export function setPatternSource(
  resultCell: Cell<unknown>,
  tx: IExtendedStorageTransaction,
  url: string,
): void {
  resultCell.withTx(tx).setMetaRaw(
    "patternSource",
    url,
    rawMetaWriteAuthorization,
  );
}

/** Read the validated, append-only source revisions carried by a piece. */
export function getPieceSourceRevisions(
  resultCell: Cell<unknown>,
): PieceSourceRevision[] {
  const raw = resultCell.getMetaRaw("pieceSourceHistory", {
    meta: ignoreReadForScheduling,
  });
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("piece source history is invalid");
  }
  const revisions: PieceSourceRevision[] = [];
  const revisionIds = new Set<string>();
  for (const value of raw) {
    if (!isObjectOrArray(value)) {
      throw new Error("piece source history is invalid");
    }
    const pattern = asPatternIdentityRef(value.pattern);
    let sourceLink: NormalizedFullLink | undefined;
    if (isSigilLink(value.source)) {
      try {
        sourceLink = parseLink(
          value.source,
          resultCell.getAsNormalizedFullLink(),
        );
      } catch {
        // The validation below reports one stable history error.
      }
    }
    if (
      typeof value.revisionId !== "string" ||
      value.revisionId.length === 0 ||
      revisionIds.has(value.revisionId) ||
      typeof value.timestamp !== "number" ||
      !Number.isFinite(value.timestamp) ||
      value.timestamp < 0 ||
      pattern === undefined ||
      sourceLink === undefined ||
      sourceLink.space !== resultCell.space ||
      sourceLink.id !== toURI(createRef({}, `pattern:${pattern.identity}`)) ||
      (sourceLink.scope ?? "space") !== "space" ||
      sourceLink.path.length !== 0 ||
      !isPieceSourceRevisionOperation(value.operation) ||
      value.origin !== undefined && typeof value.origin !== "string" ||
      value.recordedOrigin !== undefined &&
        (typeof value.recordedOrigin !== "string" ||
          typeof value.origin !== "string") ||
      value.selectedRevisionId !== undefined &&
        (typeof value.selectedRevisionId !== "string" ||
          value.selectedRevisionId.length === 0)
    ) {
      throw new Error("piece source history is invalid");
    }
    const revision: PieceSourceRevision = {
      revisionId: value.revisionId,
      timestamp: value.timestamp,
      pattern,
      source: value.source as SigilLink,
      operation: value.operation,
    };
    if (typeof value.origin === "string") revision.origin = value.origin;
    if (typeof value.recordedOrigin === "string") {
      revision.recordedOrigin = value.recordedOrigin;
    }
    if (typeof value.selectedRevisionId === "string") {
      revision.selectedRevisionId = value.selectedRevisionId;
    }
    revisionIds.add(revision.revisionId);
    revisions.push(revision);
  }
  return revisions;
}

/**
 * Read the outcome of the last attempt to follow this piece's active origin.
 *
 * A value this runtime cannot read is reported as absent. This state describes
 * a piece rather than guarding a write, so an unreadable one leaves the panel
 * saying nothing instead of failing the read that carries it.
 */
export function getPieceReconciliation(
  resultCell: Cell<unknown>,
): PieceReconciliation | undefined {
  const raw = resultCell.getMetaRaw("pieceReconciliation", {
    meta: ignoreReadForScheduling,
  });
  if (!isObjectOrArray(raw)) return undefined;
  const { outcome, at, origin, offered, reason, detail } = raw;
  if (
    !isPieceReconciliationOutcome(outcome) ||
    typeof at !== "number" || !Number.isFinite(at) || at < 0 ||
    typeof origin !== "string" || origin.length === 0
  ) {
    return undefined;
  }
  const offeredRef = asPatternIdentityRef(offered);
  return {
    outcome,
    at,
    origin,
    ...(offeredRef === undefined ? {} : { offered: offeredRef }),
    ...(isPieceReconciliationReason(reason) ? { reason } : {}),
    ...(typeof detail === "string" && detail.length > 0 ? { detail } : {}),
  };
}

/**
 * Record what following the active origin just did. Meta writes are
 * transactional, so a transaction is required.
 */
export function setPieceReconciliation(
  resultCell: Cell<unknown>,
  tx: IExtendedStorageTransaction,
  reconciliation: PieceReconciliation,
): void {
  resultCell.withTx(tx).setMetaRaw(
    "pieceReconciliation",
    reconciliation as unknown as FabricValue,
    rawMetaWriteAuthorization,
  );
}

/** Whether two recorded outcomes say the same thing, ignoring when. */
export function samePieceReconciliation(
  left: PieceReconciliation | undefined,
  right: PieceReconciliation | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.outcome === right.outcome && left.origin === right.origin &&
    left.reason === right.reason && left.detail === right.detail &&
    (left.offered === undefined || right.offered === undefined
      ? left.offered === right.offered
      : patternIdentityKey(left.offered) === patternIdentityKey(right.offered));
}

function isPieceReconciliationOutcome(
  value: unknown,
): value is PieceReconciliationOutcome {
  return value === "followed" || value === "unreachable" ||
    value === "refused";
}

function isPieceReconciliationReason(
  value: unknown,
): value is PieceReconciliationReason {
  return value === "incompatible-schema" || value === "argument-mismatch" ||
    value === "source-invalid" || value === "identity-mismatch" ||
    value === "apply-failed";
}

/**
 * The source state guarded by a lifecycle transition. `sessionPattern` is a
 * KEYLESS piece's session-side pointer (the never-durable contract: the
 * durable meta legitimately holds nothing for one):
 * callers that resolved it through the runner pass it so a builder-run
 * piece still has a source state to transition FROM.
 */
export function getPieceSourceSnapshot(
  resultCell: Cell<unknown>,
  sessionPattern?: { identity: string; symbol: string },
): PieceSourceSnapshot | undefined {
  const pattern = getPatternIdentityRef(resultCell) ?? sessionPattern;
  if (pattern === undefined) return undefined;
  const revisions = getPieceSourceRevisions(resultCell);
  return {
    pattern,
    origin: getPatternSource(resultCell) ?? null,
    revisionId: revisions.at(-1)?.revisionId ?? null,
  };
}

function isPieceSourceRevisionOperation(
  value: unknown,
): value is PieceSourceRevisionOperation {
  return value === "baseline" || value === "create" || value === "edit" ||
    value === "origin-update" || value === "detach" ||
    value === "revert" || value === "follow" || value === "repoint";
}

function sourceRetentionLink(
  runtime: Runtime,
  resultCell: Cell<unknown>,
  tx: IExtendedStorageTransaction,
  pattern: { identity: string; symbol: string },
): SigilLink {
  return runtime.getCell(
    resultCell.space,
    `pattern:${pattern.identity}`,
    undefined,
    tx,
  ).getAsLink();
}

function initializePieceSourceHistory(
  runtime: Runtime,
  resultCell: Cell<unknown>,
  tx: IExtendedStorageTransaction,
  pattern: { identity: string; symbol: string },
  origin?: string,
): void {
  const candidate = resultCell.withTx(tx);
  const existingPattern = getPatternIdentityRef(candidate);
  const existingHistory = candidate.getMetaRaw("pieceSourceHistory", {
    meta: ignoreReadForScheduling,
  });
  if (existingPattern !== undefined) {
    if (
      patternIdentityKey(existingPattern) !== patternIdentityKey(pattern)
    ) {
      throw new Error("piece already exists with a different pattern");
    }
    if (existingHistory !== undefined) getPieceSourceRevisions(candidate);
    return;
  }
  if (existingHistory !== undefined) {
    getPieceSourceRevisions(candidate);
    throw new Error("piece source history exists without a pattern identity");
  }
  if (origin !== undefined) {
    candidate.setMetaRaw("patternSource", origin, rawMetaWriteAuthorization);
  }
  // The creation revision links the retained source, so it waits for a space
  // that holds it: a cross-space child's closure replicates after its run.
  // The origin is a claim about where the code comes from and stands either
  // way; a piece carrying one and no revision is followed from a baseline the
  // first adoption records.
  if (
    readVerifiedSourceClosure(
      runtime,
      resultCell.space,
      pattern.identity,
      tx,
    ) === undefined
  ) {
    return;
  }
  candidate.setMetaRaw("pieceSourceHistory", [{
    revisionId: crypto.randomUUID(),
    timestamp: Date.now(),
    pattern,
    source: sourceRetentionLink(runtime, resultCell, tx, pattern),
    ...(origin === undefined ? {} : { origin }),
    operation: "create",
  }], rawMetaWriteAuthorization);
}

function samePieceSourceSnapshot(
  left: PieceSourceSnapshot,
  right: PieceSourceSnapshot,
): boolean {
  return patternIdentityKey(left.pattern) ===
      patternIdentityKey(right.pattern) &&
    left.origin === right.origin &&
    left.revisionId === right.revisionId;
}

function normalizePieceSourceOrigin(
  runtime: Runtime,
  resultCell: Cell<unknown>,
  origin: string | null,
): { origin: string | null; recordedOrigin?: string } {
  if (origin === null || !origin.startsWith("/")) return { origin };
  return {
    origin: new URL(origin, runtime.hostForSpace(resultCell.space)).href,
    recordedOrigin: origin,
  };
}

/**
 * What a source transition throws when the piece is no longer on the state
 * the transition was prepared against — checked before the write and again
 * inside the transaction that commits it.
 *
 * Exported because a caller that pinned an expected reference has to tell
 * this apart from an operational failure, and matching on a copy of the text
 * is how the two silently drift.
 */
export const PIECE_SOURCE_MOVED =
  "piece source changed while the source transition was being prepared";

/**
 * The session-side pattern the prepare/apply moved-guards below check a KEYLESS
 * piece's source state against. A keyless expected pattern is session-side by
 * construction — the durable pointer legitimately holds nothing and a
 * concurrent keyless re-setup moves neither durable meta nor source revisions —
 * so the only supersession signal such a piece has is the runner's LIVE session
 * pointer, and the guards must read exactly that: it is what differs from the
 * expected pattern once a NEWER keyless setup has landed. The durable read wins
 * when present, so a REAL pointer appearing over a keyless piece reads as
 * moved; an EVICTED session pointer reads as moved too — a spurious loud abort,
 * failing safe. A real expected pattern gets no fallback: a cleared or changed
 * durable pointer must read as moved.
 */
function keylessTransitionSessionPattern(
  runtime: Runtime,
  resultCell: Cell<unknown>,
  expectedPattern: { identity: string; symbol: string },
): { identity: string; symbol: string } | undefined {
  return PatternManager.isKeylessPatternIdentity(expectedPattern.identity)
    ? runtime.runner.sessionPatternPointerFor(resultCell)
    : undefined;
}

/**
 * Verify that a source transition can restore the current source. Recovery
 * paths may omit an unavailable legacy baseline and retain the displaced
 * executable identity outside the restorable history instead.
 */
export async function preparePieceSourceTransitionBaseline(
  runtime: Runtime,
  resultCell: Cell<unknown>,
  expected: PieceSourceSnapshot,
  options: { allowUnavailable?: boolean } = {},
): Promise<PieceSourceTransitionBaseline> {
  await prepareSourceClosureVerification();
  const current = getPieceSourceSnapshot(
    resultCell,
    keylessTransitionSessionPattern(runtime, resultCell, expected.pattern),
  );
  if (
    current === undefined ||
    !samePieceSourceSnapshot(current, expected)
  ) {
    throw new Error(PIECE_SOURCE_MOVED);
  }
  const baseline = {
    kind: "retain" as const,
    revisionId: crypto.randomUUID(),
  };
  // Load and verify the current closure before opening the write transaction.
  // The write transaction verifies it again and keeps those reads in its OCC
  // set. This first pass synchronizes the recursive closure and compiler stack.
  const program = await runtime.patternManager
    .getPatternSourceProgramByIdentity(
      expected.pattern.identity,
      resultCell.space,
    );
  if (program !== undefined) return baseline;
  if (options.allowUnavailable) return { kind: "unavailable" };
  throw new Error("the piece's current source is not available");
}

/**
 * Append a source revision and change active origin in the pattern setup
 * transaction. A legacy or externally changed current state first receives a
 * baseline revision so no source or origin is skipped.
 */
export function applyPieceSourceTransition(
  runtime: Runtime,
  resultCell: Cell<unknown>,
  tx: IExtendedStorageTransaction,
  nextPattern: { identity: string; symbol: string },
  transition: PieceSourceTransition,
): void {
  const candidate = resultCell.withTx(tx);
  // Same live-session-pointer read as the prepare step above: the guard's
  // whole job is catching what moved BETWEEN prepare and this commit.
  const current = getPieceSourceSnapshot(
    candidate,
    keylessTransitionSessionPattern(
      runtime,
      resultCell,
      transition.expected.pattern,
    ),
  );
  if (
    current === undefined ||
    !samePieceSourceSnapshot(current, transition.expected)
  ) {
    throw new Error(PIECE_SOURCE_MOVED);
  }
  const history = getPieceSourceRevisions(candidate);
  if (
    history.some((revision) => revision.revisionId === transition.revisionId)
  ) {
    throw new Error(
      `piece source revision ID already exists: ` +
        `\`${transition.revisionId}\``,
    );
  }

  const verifyRetainedPattern = (
    pattern: { identity: string; symbol: string },
  ): void => {
    if (
      readVerifiedSourceClosure(
        runtime,
        resultCell.space,
        pattern.identity,
        tx,
      ) === undefined
    ) {
      throw new Error(
        `source for pattern ${pattern.identity} is not available`,
      );
    }
  };
  if (transition.baseline.kind === "retain") {
    verifyRetainedPattern(current.pattern);
  }
  if (
    transition.baseline.kind !== "retain" ||
    patternIdentityKey(current.pattern) !== patternIdentityKey(nextPattern)
  ) {
    verifyRetainedPattern(nextPattern);
  }
  if (
    transition.baseline.kind === "unavailable" &&
    // A keyless displaced identity must never land durably: the
    // displaced executable was a session-built value no session can reload,
    // and the history's absent baseline is the honest record of that.
    !PatternManager.isKeylessPatternIdentity(current.pattern.identity)
  ) {
    candidate.setMetaRaw("displacedPattern", {
      identity: current.pattern.identity,
      symbol: current.pattern.symbol,
      displacedAt: transition.timestamp,
    }, rawMetaWriteAuthorization);
  }

  const recordedCurrent = history.at(-1);
  const currentOrigin = normalizePieceSourceOrigin(
    runtime,
    resultCell,
    current.origin,
  );
  const nextOrigin = normalizePieceSourceOrigin(
    runtime,
    resultCell,
    transition.origin,
  );
  const needsBaseline = recordedCurrent === undefined ||
    patternIdentityKey(recordedCurrent.pattern) !==
      patternIdentityKey(current.pattern) ||
    (recordedCurrent.origin ?? null) !== currentOrigin.origin;
  if (needsBaseline && transition.baseline.kind === "retain") {
    history.push({
      revisionId: transition.baseline.revisionId,
      timestamp: transition.timestamp,
      pattern: current.pattern,
      source: sourceRetentionLink(runtime, resultCell, tx, current.pattern),
      ...(currentOrigin.origin === null ? {} : {
        origin: currentOrigin.origin,
        ...(currentOrigin.recordedOrigin === undefined
          ? {}
          : { recordedOrigin: currentOrigin.recordedOrigin }),
      }),
      operation: "baseline",
    });
  }

  history.push({
    revisionId: transition.revisionId,
    timestamp: transition.timestamp,
    pattern: nextPattern,
    source: sourceRetentionLink(runtime, resultCell, tx, nextPattern),
    ...(nextOrigin.origin === null ? {} : {
      origin: nextOrigin.origin,
      ...(nextOrigin.recordedOrigin === undefined
        ? {}
        : { recordedOrigin: nextOrigin.recordedOrigin }),
    }),
    operation: transition.operation,
    ...(transition.selectedRevisionId === undefined
      ? {}
      : { selectedRevisionId: transition.selectedRevisionId }),
  });
  candidate.setMetaRaw(
    "patternSource",
    nextOrigin.origin ?? undefined,
    rawMetaWriteAuthorization,
  );
  candidate.setMetaRaw(
    "pieceSourceHistory",
    history as unknown as FabricValue,
    rawMetaWriteAuthorization,
  );
  // An accepted transition supersedes whatever the last reconciliation
  // concluded: the piece has moved, and the recorded outcome describes a state
  // it has left.
  candidate.setMetaRaw(
    "pieceReconciliation",
    undefined,
    rawMetaWriteAuthorization,
  );
}

/** Read an explicitly supplied repository locator for a piece's source. */
export function getPatternRepository(
  resultCell: Cell<unknown>,
): string | undefined {
  const raw = resultCell.getMetaRaw("patternRepository", {
    meta: ignoreReadForScheduling,
  });
  return typeof raw === "string" ? raw : undefined;
}

/** Stamp an explicitly supplied repository locator with pattern setup. */
export function setPatternRepository(
  resultCell: Cell<unknown>,
  tx: IExtendedStorageTransaction,
  repository: string,
): void {
  resultCell.withTx(tx).setMetaRaw(
    "patternRepository",
    repository,
    rawMetaWriteAuthorization,
  );
}

/**
 * A stable string key for a `{ identity, symbol }` pattern ref, for "same
 * pattern between runs" comparisons (name preservation, reuse-running-setup).
 */
export function patternIdentityKey(
  ref: { identity: string; symbol: string },
): string {
  return `${ref.identity}\0${ref.symbol}`;
}
