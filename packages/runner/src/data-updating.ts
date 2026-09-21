import type { JSONSchemaObj } from "@commonfabric/api";
import {
  getServerExecutionConfig,
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  assertValidFabricValueLayer,
  cloneIfNecessary,
  debugStr,
  fabricFromConvertibleJsValue,
  type FabricPlainObject,
  type FabricValue,
  isFabricSpecialObject,
  isKeyableObjectNotArray,
  shallowFabricFromConvertibleJsObjectElseUndefined,
} from "@commonfabric/data-model";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { isFabricDataUri } from "@commonfabric/data-model/codec-data-uri";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { getLogger } from "@commonfabric/utils/logger";
import { stringTupleKey } from "@commonfabric/utils/string-tuple-key";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { forEachSubschema } from "@commonfabric/data-model-schema/schema-walk";

import { type CellScope, type JSONSchema } from "./builder/types.ts";
import {
  CellImpl,
  isCell,
  recordRelevantSchemaWritePolicyInput,
} from "./cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { canonicalizeLogicalPath } from "./cfc/canonical.ts";
import type { CfcConfClause } from "./cfc/clause.ts";
import {
  type CfcLabelView,
  cloneCfcLabelView,
  getCarriedCfcLabelView,
} from "./cfc/label-view-state.ts";
import {
  type CfcCellLinkRefPayload,
  linkCfcLabelView,
} from "./cfc/link-label-view.ts";
import {
  readStoredCfcMetadata,
  storedCfcMetadataAppliesToPath,
  StoredCfcMetadataError,
} from "./cfc/metadata.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
  CFC_STRUCTURAL_PROVENANCE_UNDECLARABLE_STORE,
  type CfcAddress,
  runtimeWritePolicyAuthorization,
} from "./cfc/types.ts";
import { createRef } from "./create-ref.ts";
import { findAndInlineDataUriLinks } from "./data-uri.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  areLinksSame,
  areMaybeLinkAndNormalizedLinkSame,
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  declareStreamSchema,
  isCellLink,
  isPrimitiveCellLink,
  isSigilLink,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
  toMemorySpaceAddress,
} from "./link-utils.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { type Runtime } from "./runtime.ts";
import {
  allowMutableTransactionRead,
  markReadAsAttemptedWrite,
} from "./scheduler.ts";
import { schemaHasIfc } from "./schema-ifc.ts";
import { resolveSchema, resolveSchemaForValue } from "./schema.ts";
import { isCellScope, scopeRank } from "./scope.ts";
import { flattenBuilderArtifacts } from "./storage-preflight.ts";
import type {
  IExtendedStorageTransaction,
  IReadOptions,
} from "./storage/interface.ts";
import {
  ignoreReadForScheduling,
  internalVerifierRead,
  linkResolutionProbe,
  writeDestinationRead,
} from "./storage/reactivity-log.ts";
import { resolveSchemaRefsCanonical, schemaAcceptsType } from "./traverse.ts";
import { toURI } from "./uri-utils.ts";

const diffLogger = getLogger("normalizeAndDiff", {
  enabled: false,
  level: "debug",
});

// Sentinel value to distinguish "no precomputed value" from "precomputed value is undefined"
const NO_PRECOMPUTED = Symbol("no-precomputed");

// Docs whose seed-materialization absence check found a PRESENT value, keyed
// `space/id`, per runtime so tests with multiple runtimes stay isolated. A
// doc can't become un-created, so a settled entry can never suppress a needed
// seed; pending writes are deliberately not memoized (an aborted tx must
// re-seed). See the BRANCH_CELL seed materialization below.
const seedCheckSettled = new WeakMap<Runtime, Set<string>>();
const seededDocs = (runtime: Runtime): Set<string> => {
  let docs = seedCheckSettled.get(runtime);
  if (docs === undefined) {
    docs = new Set();
    seedCheckSettled.set(runtime, docs);
  }
  return docs;
};
// The scope INSTANCE is part of the key (key-vocabulary.md §1 site 4):
// per-user/per-session instances share an id with the space-scoped doc, and
// one instance's presence must not suppress another's seed — at fan-out one
// USER's presence must not suppress another's. Keys are built from the
// acting identity via the shared constructor; in the OFF arm that is the
// runtime's own session.
const seedMemoKey = (
  link: NormalizedFullLink,
  identity: ScopeKeyIdentity,
): string =>
  `${link.space}/${resolveScopeKey(link.scope, identity)}/${link.id}`;

const cfcAddressFromLink = (link: NormalizedFullLink): CfcAddress => ({
  space: link.space,
  id: link.id,
  scope: link.scope,
  path: [...link.path],
});

const isPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

const pathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean => isPrefix(left, right) || isPrefix(right, left);

const pathSegmentMatches = (left: string, right: string): boolean =>
  left === right || left === "*" || right === "*";

const pathPrefixMatches = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => pathSegmentMatches(segment, path[index]));

const schemaPathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean => pathPrefixMatches(left, right) || pathPrefixMatches(right, left);

const labelHasValues = (
  label: {
    confidentiality?: readonly CfcConfClause[];
    integrity?: readonly CfcAtom[];
  },
): boolean =>
  (label.confidentiality?.length ?? 0) > 0 ||
  (label.integrity?.length ?? 0) > 0;

const cfcLabelViewHasValues = (view: CfcLabelView | undefined): boolean =>
  view?.entries.some((entry) => labelHasValues(entry.label)) ?? false;

// Exported for unit testing of the overlap predicate. Not part of the
// public surface.
export const schemaIfcOverlapsPath = (
  schema: JSONSchema | undefined,
  basePath: readonly string[],
  sourcePath: readonly string[],
): boolean => {
  if (schema === undefined || typeof schema === "boolean") {
    return false;
  }
  // Keyword descent via the shared walk. This predicate only decides
  // whether a schema-policy input MIGHT cover the written path — a true
  // records and evaluates the input — so over-matching errs safe. That is
  // why `items`/`additionalProperties` keep unconditional `*` segments even
  // beside prefixItems/properties (unlike walkIfcSchema's minted entries,
  // where a `*` covering named positions would over-taint them), and why
  // combinator branches and `not` descend at the same path. Tuple slots
  // overlap at their concrete index.
  const visit = (
    current: JSONSchema,
    path: readonly string[],
  ): boolean => {
    if (typeof current === "boolean") {
      return false;
    }
    if (
      isObjectOrArray(current.ifc) &&
      labelHasValues(current.ifc) &&
      schemaPathsOverlap(path, sourcePath)
    ) {
      return true;
    }
    return forEachSubschema(current, (child, keyword, key, index) => {
      const childPath = keyword === "properties"
        ? [...path, key!]
        : keyword === "prefixItems"
        ? [...path, String(index!)]
        : keyword === "items" || keyword === "additionalProperties"
        ? [...path, "*"]
        : path;
      return visit(child, childPath);
    });
  };
  return visit(schema, basePath);
};

const hasPendingSchemaPolicyInput = (
  tx: IExtendedStorageTransaction,
  source: NormalizedFullLink,
): boolean => {
  const sourcePath = canonicalizeLogicalPath(source.path);
  return tx.getCfcSchemaPolicyInputs(source.space, source.id).some((input) =>
    pathsOverlap(canonicalizeLogicalPath(input.target.path), sourcePath) &&
    schemaIfcOverlapsPath(
      input.schema,
      canonicalizeLogicalPath(input.target.path),
      sourcePath,
    )
  );
};

const recordLinkWritePolicyInput = (
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
  source: NormalizedFullLink,
  cfcLabelView?: CfcLabelView,
): void => {
  if (tx.getCfcState().enforcementMode === "disabled") {
    return;
  }
  // A content-addressed document is a runtime surface outside labeling:
  // immutable, named by its own content, and never given an envelope —
  // the write-policy and flow-read passes exclude `cid:` ids on the same
  // ground. A link to one carries nothing a label could describe, so it
  // records no policy input; recording one would demand source metadata
  // the document can never carry.
  if (source.id.startsWith("cid:")) {
    return;
  }
  const carriedCfcLabelView = cloneCfcLabelView(cfcLabelView);
  let sourceMetadata: ReturnType<typeof readStoredCfcMetadata>;
  let sourceEnvelopeUninterpretable = false;
  try {
    sourceMetadata = readStoredCfcMetadata(tx, source);
  } catch (error) {
    // A source envelope this build cannot produce labels from still makes
    // the link CFC-relevant (fail closed): recording the policy input
    // routes the write to prepare, where the unreadable envelope rejects
    // it in enforcing modes instead of the labels silently not carrying.
    if (!(error instanceof StoredCfcMetadataError)) throw error;
    sourceEnvelopeUninterpretable = true;
  }
  const sourceRelevant = schemaIfcOverlapsPath(source.schema, [], []) ||
    sourceMetadata !== undefined || sourceEnvelopeUninterpretable ||
    hasPendingSchemaPolicyInput(tx, source) ||
    cfcLabelViewHasValues(carriedCfcLabelView);
  const targetRelevant = storedCfcMetadataAppliesToPath(tx, target) ||
    hasPendingSchemaPolicyInput(tx, target);
  if (!sourceRelevant && !targetRelevant) {
    return;
  }

  tx.markCfcRelevant(`link-write:${target.id}`);
  tx.recordCfcWritePolicyInput({
    kind: "link-write",
    target: cfcAddressFromLink(target),
    source: cfcAddressFromLink(source),
    ...(source.schema !== undefined && { linkSchema: source.schema }),
    ...(carriedCfcLabelView !== undefined && {
      cfcLabelView: carriedCfcLabelView,
    }),
  });
};

const cfcLabelViewForPrimitiveLink = (
  value: unknown,
): CfcLabelView | undefined => {
  if (!isSigilLink(value)) {
    return undefined;
  }
  return cloneCfcLabelView(linkCfcLabelView(value));
};

const attachCfcLabelViewToSigilLink = (
  value: unknown,
  cfcLabelView: CfcLabelView | undefined,
): unknown => {
  const clonedView = cloneCfcLabelView(cfcLabelView);
  if (!clonedView || !isSigilLink(value)) {
    return value;
  }
  return linkRefFrom<CfcCellLinkRefPayload>({
    ...linkRefPayload(value),
    cfcLabelView: clonedView,
  });
};

const stripCfcLabelViewFromPrimitiveLink = (value: unknown): unknown => {
  if (!isSigilLink(value)) {
    return value;
  }
  const inner = linkRefPayload(value) as CfcCellLinkRefPayload;
  if (inner.cfcLabelView === undefined) {
    return value;
  }
  const { cfcLabelView: _cfcLabelView, ...cleanInner } = inner;
  return linkRefFrom(cleanInner);
};

/**
 * Whether a slot's schema would TOLERATE the value reading as missing —
 * i.e. it matches `undefined` or carries a `default` (ubik2's criterion on
 * #4561). Used to restrict the scope-isolation warn to slots where an
 * unresolvable link actually bites: a slot that accepts undefined (or
 * defaults) degrades harmlessly per reader, so storing a narrower-scoped
 * link there is a legitimate per-reader pattern rather than a footgun.
 * Complemented by the parent-`required` threading (see normalizeAndDiff's
 * `slotRequiredByParent`): the full criterion is "the read would actually
 * reject the missing cell".
 */
const _toleratesMissingCache = new WeakMap<object, boolean>();

function schemaToleratesMissing(schema: JSONSchema | undefined): boolean {
  if (schema === undefined) return true;
  if (!isObjectOrArray(schema)) return true;
  // Schemas are identity-stable (interned / deep-frozen) on the paths that
  // reach here, mirroring traverse's own ref cache — memoize the verdict so
  // per-row write loops don't re-resolve refs (a CI-visible cost otherwise).
  const cached = _toleratesMissingCache.get(schema);
  if (cached !== undefined) return cached;
  const verdict = computeToleratesMissing(schema);
  _toleratesMissingCache.set(schema, verdict);
  return verdict;
}

function computeToleratesMissing(schema: JSONSchema): boolean {
  // Resolve a top-level $ref before the default check (via the MEMOIZED
  // canonical resolver traverse uses), and apply the default with the same
  // LOOSE comparison the read side uses when it applies defaults
  // (`!= undefined`): a `default: null` is skipped by the read and therefore
  // does not make the slot tolerant, while `default: 0/""/false` do. Judged
  // on the resolved schema so a default carried by the $defs target counts.
  let resolved: JSONSchema | undefined = schema;
  if (isObjectOrArray(schema) && "$ref" in schema) {
    resolved = resolveSchemaRefsCanonical(schema as JSONSchemaObj) ?? schema;
  }
  if (isObjectOrArray(resolved) && resolved.default != undefined) return true;
  // Type tolerance judged with the read side's own matcher (schemaAcceptsType
  // wraps the logic extracted from SchemaObjectTraverser.#isValidType,
  // including $ref resolution and allOf/anyOf/oneOf).
  return schemaAcceptsType(schema, "undefined");
}

/**
 * The scope at which a slot's content is stored (the write target scope). It
 * shares its precedence with the read follow-cap (see
 * `ContextualFlowControl.getSchemaScopeCap`) so writes and reads agree on which
 * scoped instance a slot addresses. `any`/no constraint yields `undefined` —
 * i.e. no narrowing. Distinct from the link's own base scope.
 */
function declaredCellScope(
  schema: JSONSchema | undefined,
): CellScope | undefined {
  const cap = ContextualFlowControl.getSchemaScopeCap(schema);
  return isCellScope(cap) ? cap : undefined;
}

export type DiffAndUpdateOptions = IReadOptions & {
  /**
   * Marks every schema-bearing document produced by this traversal as a
   * generated output. This must propagate through collection entries anchored
   * as entity documents: they are separate storage targets, so an output
   * marker on the containing document cannot cover them.
   */
  schemaRole?: "output";
};

/**
 * Mutable state threaded through a single `normalizeAndDiff()` walk.
 */
export interface DiffWalkState {
  /** Shared-reference / cycle tracking: source value → normalized link. */
  seen: Map<any, NormalizedFullLink>;

  /**
   * When present, a plain object sitting in an array that is not already a
   * link gets anchored into an entity document of its own, its id drawn from
   * this source. The `Cell` write paths that can put a plain object into an
   * array — `set()`, `push()`, `addUnique()` — draw it from the frame their
   * cell was made in (`frameAnchorIds()`). A walk reached without it stores
   * such elements inline.
   */
  nextAnchorId?: () => string | number;
}

/**
 * Traverses newValue and updates `current` and any relevant linked documents.
 *
 * Returns true if any changes were made.
 *
 * A plain object sitting in an array becomes an entity document of its own
 * when `anchorIds` is supplied, its id drawn from that source. The entity id
 * also derives from the object's relative location and the passed context,
 * and the changes are written to that entity.
 *
 * @param current - A doc link to the current value to compare against.
 * @param newValue - The new value to traverse.
 * @param log - The log to write to.
 * @param context - The context of the change.
 * @param anchorIds - The id source for anchoring array-element objects
 * (typically a builder frame's counter, see `frameAnchorIds()`).
 * @returns Whether any changes were made.
 */
export function diffAndUpdate(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  newValue: unknown,
  context?: unknown,
  options?: DiffAndUpdateOptions,
  anchorIds?: () => string | number,
): boolean {
  const readOptions: DiffAndUpdateOptions = {
    ...options,
    meta: {
      ...options?.meta,
      ...markReadAsAttemptedWrite,
      ...allowMutableTransactionRead,
    },
  };
  // A builder artifact -- a module, a handler, a pattern, the factory carrying
  // a module's members -- has no fabric representation, so the runtime replaces
  // it with its encodable form before the value reaches the data model. This is
  // the raw write path, reached by `Cell.set()` and the collection operations;
  // the pattern-driven paths (a run's result, its argument) do the same at
  // their own boundaries.
  //
  // A query result is a leaf to that walk, because it is one to the diff
  // below: `normalizeAndDiff()` replaces such a value with the sigil link it
  // names without reading a member of it. Each member read on one resolves
  // through this transaction and is recorded on it as a dependency the commit
  // has to check.
  const changes = normalizeAndDiff(
    runtime,
    tx,
    link,
    flattenBuilderArtifacts(newValue, {
      isLeaf: isCellResultForDereferencing,
    }),
    context,
    readOptions,
    { seen: new Map(), nextAnchorId: anchorIds },
  );
  diffLogger.debug(
    "diff",
    () => debugStr`[diffAndUpdate] changes: $quote,long${changes}`,
  );
  applyChangeSet(tx, changes);
  return changes.length > 0;
}

/** Declared input fields whose default storage continues through a user row. */
export function sessionScopedArgumentKeys(
  schema: JSONSchema | undefined,
): string[] {
  const resolved = resolveSchema(schema);
  if (!isObjectOrArray(resolved) || !isObjectOrArray(resolved.properties)) {
    return [];
  }
  return Object.keys(resolved.properties).filter((key) =>
    declaredCellScope(ContextualFlowControl.getSchemaAtPath(schema, [key])) ===
      "session"
  );
}

/** The default initialization declaration carried by a stored link value. */
function scopeInitialization(value: unknown): "session" | undefined {
  if (!isPrimitiveCellLink(value)) return undefined;
  return (linkRefPayload(value) as Record<string, unknown>)
      .scopeInitialization === "session"
    ? "session"
    : undefined;
}

/** A space-to-user default link whose missing user instances continue to session. */
function sessionInitializationLink(
  target: NormalizedFullLink,
  base: NormalizedFullLink,
) {
  return linkRefFrom({
    ...linkRefPayload(createSigilLinkFromParsedLink(target, { base })),
    scopeInitialization: "session",
  });
}

/** The canonical user continuation named by an automatic session default. */
function sessionInitializationTarget(
  value: unknown,
  source: NormalizedFullLink,
): NormalizedFullLink | undefined {
  if (source.scope !== "space" || scopeInitialization(value) !== "session") {
    return undefined;
  }
  const target = parseLink(value, source);
  return target && areNormalizedLinksSame(target, { ...source, scope: "user" })
    ? target
    : undefined;
}

/** User slots whose presence must be loaded before initializing a session default. */
export function scopedArgumentInitializationTargets(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  argument: NormalizedFullLink,
  schema: JSONSchema | undefined,
): NormalizedFullLink[] {
  if (!getServerExecutionConfig()) return [];
  let blocked = false;
  const container = resolveLink(runtime, tx, argument, "value", {
    onScopeBlocked: () => blocked = true,
  });
  if (
    blocked || container.pendingHopDoc || container.scope !== "space" ||
    isFabricDataUri(container.id)
  ) return [];
  const value = tx.readValueOrThrow(container, {
    nonRecursive: true,
    meta: { ...markReadAsAttemptedWrite, ...allowMutableTransactionRead },
  });
  if (!isKeyableObjectNotArray(value) || isPrimitiveCellLink(value)) return [];
  return sessionScopedArgumentKeys(schema).flatMap((key) => {
    const source = { ...container, path: [...container.path, key] };
    const target = Object.hasOwn(value, key)
      ? sessionInitializationTarget(
        tx.readValueOrThrow(source, { meta: linkResolutionProbe }),
        source,
      )
      : { ...source, scope: "user" as const };
    return target ? [target] : [];
  });
}

/** Materialize absent scoped input slots and declared session continuations. */
export function initializeScopedArgumentSlots(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  argumentLink: NormalizedFullLink,
  schema: JSONSchema | undefined,
): void {
  const resolvedSchema = resolveSchema(schema);
  if (
    !isObjectOrArray(resolvedSchema) ||
    !isObjectOrArray(resolvedSchema.properties)
  ) return;
  let blocked = false;
  const container = resolveLink(runtime, tx, argumentLink, "value", {
    onScopeBlocked: () => blocked = true,
  });
  if (blocked || container.pendingHopDoc || isFabricDataUri(container.id)) {
    return;
  }
  const options = {
    nonRecursive: true,
    meta: { ...markReadAsAttemptedWrite, ...allowMutableTransactionRead },
  };
  const value = tx.readValueOrThrow(container, options);
  if (!isKeyableObjectNotArray(value) || isPrimitiveCellLink(value)) return;
  const changes: ChangeSet = [];
  for (const key of Object.keys(resolvedSchema.properties)) {
    const childSchema = ContextualFlowControl.getSchemaAtPath(schema, [key]);
    const scope = declaredCellScope(childSchema);
    if (scope === undefined || scopeRank(scope) <= scopeRank(container.scope)) {
      continue;
    }
    const childLink: NormalizedFullLink = {
      ...container,
      path: [...container.path, key],
      schema: childSchema,
    };
    const present = Object.hasOwn(value, key);
    if (
      getServerExecutionConfig() && scope === "session" &&
      container.scope === "space"
    ) {
      // The declaration is a link-value dependency, including changes that
      // preserve the containing object's key set and the reference address.
      const target = present
        ? sessionInitializationTarget(
          tx.readValueOrThrow(childLink, { meta: linkResolutionProbe }),
          childLink,
        )
        : { ...childLink, scope: "user" as const };
      if (!target) continue;
      let targetBlocked = false;
      const resolvedTarget = resolveLink(runtime, tx, target, "top", {
        onScopeBlocked: () => targetBlocked = true,
      });
      if (
        targetBlocked || resolvedTarget.pendingHopDoc ||
        !areNormalizedLinksSame(target, resolvedTarget)
      ) continue;
      if (!present) {
        changes.push(...normalizeAndDiff(
          runtime,
          tx,
          childLink,
          sessionInitializationLink(target, childLink),
          argumentLink,
          options,
          { seen: new Map() },
          undefined,
        ));
      }
      const parent = tx.readValueOrThrow({
        ...target,
        path: target.path.slice(0, -1),
      }, options);
      // The leaf absence remains a commit dependency when a concurrent write
      // fills the slot without changing its parent's nonrecursive shape.
      tx.readValueOrThrow(target, options);
      if (
        parent !== undefined && (
          !isKeyableObjectNotArray(parent) || isPrimitiveCellLink(parent) ||
          Object.hasOwn(parent, target.path.at(-1)!)
        )
      ) continue;
      if (parent === undefined) {
        // Missing containers may be created, but an explicitly undefined
        // ancestor is an authored value and must not be replaced by a record.
        const address = toMemorySpaceAddress(target);
        let presentAncestor = false;
        for (let depth = address.path.length - 1; depth > 0; depth--) {
          const owner = tx.readOrThrow({
            ...address,
            path: address.path.slice(0, depth - 1),
          }, options);
          if (owner === undefined) continue;
          presentAncestor = !isKeyableObjectNotArray(owner) ||
            Object.hasOwn(owner, address.path[depth - 1]);
          break;
        }
        if (presentAncestor) continue;
      }
      changes.push(...normalizeAndDiff(
        runtime,
        tx,
        target,
        createSigilLinkFromParsedLink({ ...target, scope: "session" }, {
          base: target,
        }),
        argumentLink,
        options,
        { seen: new Map() },
        undefined,
      ));
      continue;
    }
    if (present) continue;
    changes.push(...scopedRedirectChanges(
      runtime,
      tx,
      childLink,
      scope,
      argumentLink,
      options,
      { seen: new Map() },
      undefined,
    ));
  }
  applyChangeSet(tx, changes);
}

/** Build the redirect chain for a declared narrower slot without writing its content. */
function scopedRedirectChanges(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  scope: CellScope,
  context: unknown,
  options: DiffAndUpdateOptions | undefined,
  state: DiffWalkState,
  currentValue: unknown,
): ChangeSet {
  const scopedLink: NormalizedFullLink = { ...link, scope };
  const viaUser = getServerExecutionConfig() && scope === "session" &&
    scopeRank(link.scope) < scopeRank("user");
  const target = viaUser ? { ...link, scope: "user" as const } : scopedLink;
  const changes = viaUser
    ? normalizeAndDiff(
      runtime,
      tx,
      target,
      createSigilLinkFromParsedLink(scopedLink, { base: target }),
      context,
      options,
      state,
    )
    : [];
  changes.push(...normalizeAndDiff(
    runtime,
    tx,
    link,
    viaUser
      ? sessionInitializationLink(target, link)
      : createSigilLinkFromParsedLink(target, { base: link }),
    context,
    options,
    state,
    currentValue,
  ));
  return changes;
}

export type ChangeSet = {
  location: NormalizedFullLink;
  value: FabricValue;

  /**
   * When true, the change removes the slot at `location` (object key
   * removal or array hole) instead of writing a value; `value` is
   * `undefined`. Without this flag, a change whose `value` is `undefined`
   * stores `undefined` as a real value — present-but-undefined is distinct
   * from absent.
   */
  delete?: boolean;
}[];

/**
 * Turns `content` into an entity document of its own: the slot at `link` gets
 * a link to a (possibly new) document whose id derives from `idSeed`, the
 * slot's location, and the passed context, and `content` is diffed into that
 * document. When the slot is an element of a STORED array, the id derives
 * from the nearest non-array ancestor location, so the element's identity
 * does not depend on its position. Array ancestry is read from transaction
 * pre-state, so on a fresh array's first write the indices remain in the
 * derivation and identity IS position-bearing there -- a long-standing
 * limitation.
 *
 * `registerKey` is the caller's original value, and `content` a distinct
 * shallow copy of it; `registerKey` is registered in `state.seen` so shared
 * references to it resolve to the same document.
 */
function anchorValueAsEntity(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  content: FabricPlainObject,
  registerKey: unknown,
  idSeed: string | number,
  context: unknown,
  options: DiffAndUpdateOptions | undefined,
  state: DiffWalkState,
): ChangeSet {
  let path = link.path;

  // If we're setting an array element, make the array the context for the
  // derived id, not the array index. If it's a nested array, take the parent
  // array as context, recursively.
  while (
    path.length > 0 &&
    Array.isArray(
      tx.readValueOrThrow({ ...link, path: path.slice(0, -1) }, options),
    )
  ) {
    path = path.slice(0, -1);
  }

  const entityId = createRef({ id: idSeed }, {
    parent: { id: link.id, space: link.space },
    path,
    context,
  });

  const newEntryLink: NormalizedFullLink = {
    id: toURI(entityId),
    space: link.space,
    scope: link.scope,
    path: [],
    schema: resolveSchemaForValue(link.schema, content),
  };

  state.seen.set(registerKey, newEntryLink);

  // This helper handles both creation and later writes to an anchored entity.
  // Carry the child schema on every visit so CFC can merge the candidate
  // envelope — including generated-output provenance — against an existing
  // long-lived document.
  recordRelevantSchemaWritePolicyInput(
    tx,
    newEntryLink,
    newEntryLink.schema,
    options?.schemaRole,
  );

  // Anchoring splits one value across two documents, so the child is the
  // runtime's store whenever the parent is: its id is derived here rather than
  // named by an author, and nothing but this write puts anything in it.
  // §8.2 treats either representation of a pass-through as valid so long as
  // the label is preserved; this reads that one step further, as the choice
  // not deciding a verdict. The
  // claim rides the marker alone, not an enrollment — the anchored document is
  // written by the transaction that anchors it, and a later write that reaches
  // the same position walks through here again. A transaction that addresses
  // the child directly rather than through its parent finds no claim and is
  // measured against the child's own ceiling, which is the fail-closed
  // direction. The marker also carries the claim down a nested anchor, whose
  // own parent is the child this call just marked.
  if (
    tx.isRuntimeOwnedStore(
      link.space,
      link.id,
      runtimeWritePolicyAuthorization,
    )
  ) {
    tx.recordCfcWritePolicyInput({
      kind: "structural-provenance",
      target: {
        space: newEntryLink.space,
        id: newEntryLink.id,
        scope: newEntryLink.scope,
        path: [],
      },
      claim: CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
      sources: [{
        space: link.space,
        id: link.id,
        scope: link.scope,
        path: [...path],
      }],
    }, runtimeWritePolicyAuthorization);
  }

  // The same carry for the other class of parent, on the same reasoning. A
  // document no schema declares a policy on splits its value the same way: a
  // cache document's `imports` array holds one document per edge, and what
  // each holds is a piece of the parent's own record at an id derived here.
  // Without the carry the parent is exempt and its children are measured, so
  // a transaction carrying a join that rewrites a cache document is refused
  // at the child.
  if (
    tx.isUndeclarablePolicyStore(
      link.space,
      link.id,
      runtimeWritePolicyAuthorization,
    )
  ) {
    tx.recordCfcWritePolicyInput({
      kind: "structural-provenance",
      target: {
        space: newEntryLink.space,
        id: newEntryLink.id,
        scope: newEntryLink.scope,
        path: [],
      },
      claim: CFC_STRUCTURAL_PROVENANCE_UNDECLARABLE_STORE,
      sources: [{
        space: link.space,
        id: link.id,
        scope: link.scope,
        path: [...path],
      }],
    }, runtimeWritePolicyAuthorization);
  }

  return [
    // If it wasn't already, set the current value to be a doc link to this doc
    ...normalizeAndDiff(
      runtime,
      tx,
      link,
      createSigilLinkFromParsedLink(newEntryLink, { base: link }),
      context,
      options,
      state,
    ),
    // And see whether the value of the document itself changed
    ...normalizeAndDiff(
      runtime,
      tx,
      newEntryLink,
      content,
      context,
      options,
      state,
    ),
  ];
}

/**
 * Reads the slot again, without the write-destination exclusion, at the
 * points where what is stored there decides where the write lands rather
 * than only whether it happens. The comparison read this repeats leaves the
 * transaction's flow join; this one joins it, so the slot's own label gates
 * every write the redirect carries the walk to.
 */
function consumeSteeringSlot(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  options: DiffAndUpdateOptions | undefined,
): void {
  tx.readValueOrThrow(link, options);
}

/**
 * Traverses objects and returns an array of changes that should be written. An
 * empty array means no changes.
 *
 * A plain object sitting in an array becomes an entity document of its own
 * when the walk state carries an id source (`nextAnchorId`, supplied by
 * writers running under a builder frame). The changes are queued to be
 * written to that entity, and the slot holds a link to it.
 *
 * Otherwise, when traversing and if the new value is a regular JSON value, but
 * the old value is an alias, follow the alias before writing. However document
 * references get overwritten (except as per above, the object gets converted to
 * a document itself).
 *
 * Any proxy is unwrapped, and docs and cells mapped to doc links.
 *
 * @param current - A doc link to the current value to compare against.
 * @param newValue - The new value to traverse.
 * @param log - The log to write to.
 * @param context - The context of the change.
 * @returns An array of changes that should be written.
 */
export function normalizeAndDiff(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  newValue: unknown,
  context?: unknown,
  options?: DiffAndUpdateOptions,
  state: DiffWalkState = { seen: new Map() },
  precomputedCurrent: unknown = NO_PRECOMPUTED,
  // Whether the PARENT object's schema lists this slot in `required`
  // (threaded one hop by the object branch below; undefined = unknown).
  // Consumed by the scope-isolation warn: a missing cell only voids the
  // read when the parent requires the property, so optional slots stay
  // quiet (ubik2's criterion on #4561).
  slotRequiredByParent?: boolean,
  // Whether this call's `newValue` arrived as an element of an array in the
  // WRITTEN tree (threaded one hop by the array branch below, and forwarded
  // by re-entries that keep the value while changing the target link). The
  // written tree's structure is what decides anchoring eligibility -- the
  // stored parent may not exist yet on a fresh array's first write.
  isArrayElement: boolean = false,
): ChangeSet {
  const changes: ChangeSet = [];

  // Log entry with value type and symbol presence
  const valueType = Array.isArray(newValue) ? "array" : typeof newValue;
  const pathStr = link.path.join(".");
  diffLogger.debug(
    "diff",
    () =>
      debugStr`[DIFF_ENTER] path=${pathStr} type=${valueType} newValue=$quote,long${newValue}`,
  );

  // When detecting a circular reference on JS objects, turn it into a cell,
  // which below will be turned into a relative link.
  if (state.seen.has(newValue)) {
    const seenLink = state.seen.get(newValue)!;
    // An anchor-eligible array occurrence must not become a link into a
    // document's mutable INTERIOR (a non-root `seen` location, i.e. an
    // earlier inline occurrence): removing that inline property later would
    // leave the array element dangling. Instead, PROMOTE the shared object
    // into an entity document of its own and repoint the earlier inline
    // location at it too -- all occurrences stay aliased to one stable
    // document. A root `seen` location (an already-anchored occurrence)
    // needs no promotion; the plain link below is stable.
    //
    // A `FabricInstance` is excluded here alongside the other atomic special
    // objects: the instance branch below emits it whole.
    if (
      state.nextAnchorId !== undefined &&
      isArrayElement &&
      isKeyableObjectNotArray(newValue) &&
      !isCellLink(newValue) &&
      seenLink.path.length > 0
    ) {
      // An element carried through untouched from the stored array must stay
      // untouched (see the anchoring branch below for why this is
      // load-bearing): emit nothing rather than promote it.
      if (
        precomputedCurrent !== NO_PRECOMPUTED &&
        Object.is(precomputedCurrent, newValue)
      ) {
        return [];
      }
      diffLogger.debug(
        "diff",
        () =>
          `[SEEN_PROMOTE] Promoting inline-aliased array element at path=${pathStr}`,
      );
      // The promoted document's content must not link back through the
      // inline location that is about to be repointed: descendants of the
      // shared object were registered UNDER that location, and a document
      // whose content links into `/first/...` while `/first` links to the
      // document is a read-time cycle. Drop those entries so the content
      // recursion re-derives them under the document root.
      for (const [registeredKey, registered] of state.seen) {
        if (
          registered.id === seenLink.id &&
          registered.path.length > seenLink.path.length &&
          seenLink.path.every((seg, i) => registered.path[i] === seg)
        ) {
          state.seen.delete(registeredKey);
        }
      }
      // Anchoring re-registers the object in `state.seen` under the new
      // document's root, so later occurrences (and the content recursion's
      // own cycle hits) link there.
      const anchorChanges = anchorValueAsEntity(
        runtime,
        tx,
        link,
        { ...(newValue as FabricPlainObject) },
        newValue,
        state.nextAnchorId(),
        context,
        options,
        state,
      );
      const promotedLink = state.seen.get(newValue)!;
      return [
        ...anchorChanges,
        // Repoint the earlier inline occurrence at the promoted document.
        ...normalizeAndDiff(
          runtime,
          tx,
          seenLink,
          createSigilLinkFromParsedLink(promotedLink, { base: seenLink }),
          context,
          options,
          state,
        ),
      ];
    }
    diffLogger.debug(
      "diff",
      () =>
        `[SEEN_CHECK] Already seen object at path=${pathStr}, converting to cell`,
    );
    newValue = new CellImpl(runtime, tx, seenLink);
  }

  // Scope narrowing: if this slot's schema declares a scope narrower than the
  // link's base scope, the content belongs in the narrower-scope instance and
  // the broader-scope slot holds a link to it, so readers at the broader scope
  // follow it to the narrower instance. A reference value (link/cell) is exempt:
  // it already carries its own target scope. Both writes recurse back through
  // normalizeAndDiff so they get the usual diffing, no-op detection, and CFC
  // label/policy handling. Applying this at the top of normalizeAndDiff makes it
  // compose to arbitrary depth (every nested descent re-enters here): narrowing
  // fires at whatever slot declares it. Element-level scope (an array's `items`
  // schema) therefore yields one redirect per element, while array-level scope
  // (the array slot's own schema) redirects the whole array.
  const declaredScope = declaredCellScope(link.schema);
  if (
    declaredScope !== undefined &&
    scopeRank(declaredScope) > scopeRank(link.scope) &&
    !isCellLink(newValue) &&
    !isCell(newValue)
  ) {
    const scopedLink: NormalizedFullLink = { ...link, scope: declaredScope };
    // The eager via-user hop (scopes.md §2's MUST, flag-gated so the OFF
    // arm keeps today's one-hop-per-event behavior): a space→session
    // narrowing writes CHAINED redirects, space→user→session — ALWAYS
    // via user, even when the declaration jumps straight to session, so
    // every chain has the one uniform shape.
    if (
      getServerExecutionConfig() &&
      declaredScope === "session" &&
      scopeRank(link.scope) < scopeRank("user")
    ) {
      const userLink: NormalizedFullLink = { ...link, scope: "user" };
      return [
        // Content goes into the session instance.
        ...normalizeAndDiff(
          runtime,
          tx,
          scopedLink,
          newValue,
          context,
          options,
          state,
          NO_PRECOMPUTED,
          undefined,
          isArrayElement,
        ),
        // The user-level slot points to the session instance.
        ...normalizeAndDiff(
          runtime,
          tx,
          userLink,
          createSigilLinkFromParsedLink(scopedLink, {
            base: userLink,
          }) as unknown,
          context,
          options,
          state,
        ),
        // The broader slot points via user.
        ...normalizeAndDiff(
          runtime,
          tx,
          link,
          sessionInitializationLink(userLink, link),
          context,
          options,
          state,
        ),
      ];
    }
    return [
      // Content goes into the narrower-scope instance (its missing container
      // structure is created by the storage write, which builds parents for the
      // path). Diffed against the narrower instance's own current value.
      ...normalizeAndDiff(
        runtime,
        tx,
        scopedLink,
        newValue,
        context,
        options,
        state,
        NO_PRECOMPUTED,
        undefined,
        isArrayElement,
      ),
      // The broader-scope slot points to that instance.
      ...normalizeAndDiff(
        runtime,
        tx,
        link,
        createSigilLinkFromParsedLink(scopedLink, { base: link }) as unknown,
        context,
        options,
        state,
      ),
    ];
  }

  // Unwrap proxies and handle special types
  if (isCellResultForDereferencing(newValue)) {
    const carriedCfcLabelView = getCarriedCfcLabelView(
      getCellOrThrow(newValue),
    );
    const parsedLink = parseLink(newValue);
    const sigilLink = attachCfcLabelViewToSigilLink(
      createSigilLinkFromParsedLink(parsedLink),
      carriedCfcLabelView,
    );
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_QUERY_RESULT] Converted query result to sigil link at path=${pathStr} link=${sigilLink} parsedLink=${parsedLink}`,
    );
    newValue = sigilLink;
  }

  // Track whether this link originates from a Cell value (either a cycle we
  // wrapped into a CellImpl above, or a user-supplied Cell). For Cell-origin
  // links we preserve the link (do NOT collapse). For links created via
  // query-result dereferencing (non-Cell), we may collapse immediate-parent
  // self-links.
  let linkOriginFromCell = false;
  if (isCell(newValue)) {
    diffLogger.debug(
      "diff",
      () => `[BRANCH_CELL] Converting cell to link at path=${pathStr}`,
    );
    linkOriginFromCell = true;
    const carriedCfcLabelView = getCarriedCfcLabelView(newValue);
    // Materialize a runtime-constructed cell's initial value: a
    // `Writable(initialValue)` built inside a lift/handler frame (the CTS
    // wraps derived initials this way) carries its seed only as the link
    // schema's `default` — nothing else ever writes the backing doc, so a
    // fresh session reads the field as undefined (and a `required` field
    // collapses the whole result; the blank-profile-name bug). This is the
    // first point where the cell's identity is settled AND a live tx covers
    // the write, so seed the target doc here, only if it has no value yet —
    // re-derivations serialize the same cell again but find the doc present
    // and leave user edits alone.
    const cellSchema = newValue.schema;
    let initializedSeed = false;
    const seedDefault = isObjectOrArray(cellSchema)
      ? cellSchema.default
      : undefined;
    // A descriptor from before streams were declared by schema spells the
    // declaration as a default of `{ $stream: true }`. That is not a value a
    // stream holds, and a stream's document holds none, so it seeds nothing.
    const seedTarget = seedDefault !== undefined &&
        !(isObjectOrArray(seedDefault) &&
          (seedDefault as Record<string, unknown>).$stream === true)
      ? newValue.getAsNormalizedFullLink()
      : undefined;
    if (
      seedDefault !== undefined &&
      // Only root-linked cells: those are the runtime-constructed
      // `Writable(value)` cells whose doc the default describes in full. A
      // sub-path cell (e.g. via `.key()`) carries a FIELD default — writing
      // that over the doc root would clobber the document.
      seedTarget !== undefined && seedTarget.path.length === 0 &&
      // Each doc needs the absence check at most once per runtime: once
      // found present (or seeded here), later serializations of the same
      // cell skip it — the check would otherwise run on EVERY defaulted-cell
      // serialization, a measurable hot-path cost (the CI perf check caught
      // +22–36% on the CLI integration suites for the unmemoized version).
      // The memo keys per INSTANCE under the RUN's identity (server-
      // execution v2 stage A — key-vocabulary.md §1 site 4's audit): a
      // served per-instance run's tx carries its demand-supplied
      // identity, so Alice's presence check memoizes under Alice's
      // instance and never suppresses Bob's seed of HIS default (one
      // user's presence must not suppress another's). Absent identity —
      // every client, the OFF arm — resolves the runtime's own, as before.
      !seededDocs(runtime).has(
        seedMemoKey(
          seedTarget,
          tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity,
        ),
      )
    ) {
      // Don't subscribe the serializing action to the seed doc — mirror
      // materializeDerivedInternalCells' read for the same check.
      const absent = tx.readValueOrThrow(seedTarget, {
        meta: ignoreReadForScheduling,
      }) === undefined;
      if (!absent) {
        seededDocs(runtime).add(
          seedMemoKey(
            seedTarget,
            tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity,
          ),
        );
      }
      if (absent) {
        recordRelevantSchemaWritePolicyInput(tx, seedTarget, cellSchema);
        tx.writeValueOrThrow(
          seedTarget,
          fabricFromConvertibleJsValue(seedDefault),
        );
        // Only the exact seed written into an absent slot is initialization.
        // The private mark prevents a caller from manufacturing this authority
        // through the public transaction interface.
        tx.recordCfcWritePolicyInput({
          kind: "initialization",
          mode: "seed",
          target: {
            space: seedTarget.space,
            id: seedTarget.id,
            scope: seedTarget.scope,
            path: [],
          },
          value: fabricFromConvertibleJsValue(seedDefault),
        }, runtimeWritePolicyAuthorization);
        initializedSeed = true;
        // Deliberately NOT memoized here: if this tx aborts, the doc stays
        // absent and the next serialization must seed again. Once the
        // write commits, the next check finds the doc present and settles.
      }
    }
    const streamHandle = newValue instanceof CellImpl &&
      newValue.kind === "stream";
    // A rerun can return the same protected cell with a different, unused
    // default. Record the unchanged root reference for CFC to verify alongside
    // its final protection. Materialization runs first so an existing reference
    // cannot hide an absent backing document.
    if (
      options?.schemaRole === "output" && !streamHandle &&
      link.path.length === 0 &&
      seedTarget !== undefined && seedTarget.path.length === 0 &&
      !initializedSeed && schemaHasIfc(cellSchema) &&
      !cfcLabelViewHasValues(carriedCfcLabelView)
    ) {
      const probeOptions = {
        meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
      };
      const currentReference = tx.readValueOrThrow(link, probeOptions);
      if (
        isPrimitiveCellLink(currentReference) &&
        !isWriteRedirectLink(currentReference) &&
        scopeInitialization(currentReference) === undefined &&
        areNormalizedLinksSame(parseLink(currentReference, link), seedTarget) &&
        tx.readValueOrThrow(seedTarget, probeOptions) !== undefined
      ) {
        // Preserve this attempt: preparation must refuse changed policy or any
        // additional write attempt, even when the reference bytes stay equal.
        tx.readValueOrThrow(link, {
          ...options,
          meta: {
            ...options?.meta,
            ...markReadAsAttemptedWrite,
            ...writeDestinationRead,
          },
        });
        tx.recordCfcWritePolicyInput({
          kind: "preserved-output",
          target: {
            space: link.space,
            id: link.id,
            scope: link.scope,
            path: [],
          },
          value: currentReference,
        }, runtimeWritePolicyAuthorization);
        tx.retainPendingWriteElision?.(toMemorySpaceAddress(link));
        return [];
      }
    }
    // A stream handle's own schema is the event schema it accepts. The link
    // that stands for the handle declares the stream, so a reader following
    // it to a document that holds nothing still knows what the position is.
    // The handle's kind decides, with nothing read: a read of the target here
    // would join its label into this write.
    const cellLink = newValue.getAsNormalizedFullLink();
    newValue = attachCfcLabelViewToSigilLink(
      createSigilLinkFromParsedLink(
        streamHandle
          ? { ...cellLink, schema: declareStreamSchema(cellLink.schema) }
          : cellLink,
        {
          base: link,
          includeSchema: true,
        },
      ),
      carriedCfcLabelView,
    );
    if (initializedSeed && !streamHandle) {
      tx.recordCfcWritePolicyInput({
        kind: "initialization",
        mode: "projection",
        target: {
          space: link.space,
          id: link.id,
          scope: link.scope,
          path: [...link.path],
        },
        value: newValue as FabricValue,
      }, runtimeWritePolicyAuthorization);
    }
  }

  // Check for links that are data: URIs and inline them, by calling
  // normalizeAndDiff on the contents of the link. This re-entry REPLACES the
  // value (the link's contents, not the link), so anchoring eligibility
  // deliberately does not carry over: inlined content in an array slot stores
  // inline, exactly as the annotation scheme (which never looked behind
  // links) stored it.
  //
  // The re-entry hands on what `findAndInlineDataUriLinks` produced, so the
  // check accepts exactly the media type that call inlines: this codec's
  // own. A `data:` URI of any other media type stores as an ordinary link.
  const newValueLinkId = isCellLink(newValue)
    ? parseLink(newValue, link).id
    : undefined;
  if (newValueLinkId !== undefined && isFabricDataUri(newValueLinkId)) {
    return normalizeAndDiff(
      runtime,
      tx,
      link,
      findAndInlineDataUriLinks(newValue),
      context,
      options,
      state,
    );
  }

  // If we're about to create a reference to ourselves, no-op
  if (areMaybeLinkAndNormalizedLinkSame(newValue, link, link)) {
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_SELF_REF] Self-reference detected, no-op at path=${pathStr}`,
    );
    return [];
  }

  // Get current value to compare against (use precomputed if available).
  // `writeDestinationRead` says what this read is for: the comparison
  // decides whether the walk writes here, and what it returns reaches no
  // written value. The two branches below where a stored link sends the
  // write elsewhere read the slot again through `consumeSteeringSlot`.
  let currentValue = precomputedCurrent === NO_PRECOMPUTED
    ? tx.readValueOrThrow(link, {
      ...options,
      meta: { ...options?.meta, ...writeDestinationRead },
    })
    : precomputedCurrent;

  // A new alias can overwrite a previous alias. No-op if the same.
  if (isWriteRedirectLink(newValue)) {
    const carriedCfcLabelView = cfcLabelViewForPrimitiveLink(newValue);
    const parsedLink = parseLink(newValue, link);
    if (
      isWriteRedirectLink(currentValue) &&
      areNormalizedLinksSame(
        parseLink(currentValue, link),
        parsedLink,
      )
    ) {
      diffLogger.debug(
        "diff",
        () => `[BRANCH_WRITE_REDIRECT] Same redirect, no-op at path=${pathStr}`,
      );
      if (cfcLabelViewHasValues(carriedCfcLabelView)) {
        recordLinkWritePolicyInput(tx, link, parsedLink, carriedCfcLabelView);
      }
      tx.retainPendingWriteElision?.(toMemorySpaceAddress(link));
      return [];
    } else {
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_WRITE_REDIRECT] Different redirect, updating at path=${pathStr}`,
      );
      recordLinkWritePolicyInput(tx, link, parsedLink, carriedCfcLabelView);
      changes.push({
        location: link,
        value: stripCfcLabelViewFromPrimitiveLink(newValue) as FabricValue,
      });
      return changes;
    }
  }

  // Handle alias in current value (at this point: if newValue is not an alias)
  if (isWriteRedirectLink(currentValue)) {
    consumeSteeringSlot(tx, link, options);
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_CURRENT_ALIAS] Following current value alias at path=${pathStr}`,
    );
    // Log reads of the alias, so that changing aliases cause refreshes
    const redirectLink = resolveLink(
      runtime,
      tx,
      parseLink(currentValue, link),
      "writeRedirect",
    );
    return normalizeAndDiff(
      runtime,
      tx,
      redirectLink,
      newValue,
      context,
      options,
      state,
      NO_PRECOMPUTED,
      undefined,
      isArrayElement,
    );
  }

  // Scope realization on write: the base-scope slot of a scoped instance
  // holds a regular link with an explicitly narrower scope (materialized at
  // setup; see the narrowing branch above and the eager-redirect pass in the
  // object branch below). A write of *content* arriving at this slot without
  // a scope-declaring schema (e.g. through a serialized binding whose schema
  // is scope-silent, like the renderer's $value cell) must follow that link
  // into the narrower-scope instance — overwriting it would land per-user /
  // per-session state at the shared base scope. Reference values are exempt:
  // writing a link re-binds the slot (and the schema-declared narrowing above
  // already handled scoped re-binds before reaching here).
  if (isPrimitiveCellLink(currentValue) && !isCellLink(newValue)) {
    const storedLink = parseLink(currentValue, link);
    if (scopeRank(storedLink.scope) > scopeRank(link.scope)) {
      consumeSteeringSlot(tx, link, options);
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_SCOPED_REDIRECT] Following narrower-scope stored link at path=${pathStr} (${link.scope} -> ${storedLink.scope})`,
      );
      return normalizeAndDiff(
        runtime,
        tx,
        storedLink.schema === undefined && link.schema !== undefined
          ? { ...storedLink, schema: link.schema }
          : storedLink,
        newValue,
        context,
        options,
        state,
        NO_PRECOMPUTED,
        undefined,
        isArrayElement,
      );
    }
  }

  if (isPrimitiveCellLink(newValue)) {
    diffLogger.debug(
      "diff",
      () =>
        debugStr`[BRANCH_CELL_LINK] Processing cell link at path=${pathStr} link=$quote,long${newValue}`,
    );
    const carriedCfcLabelView = cfcLabelViewForPrimitiveLink(newValue);
    const parsedLink = parseLink(newValue, link);

    // Collapse same-document self/parent links created by query-result dereferencing.
    // Example: "internal.__#1.next" -> "internal.__#1". Writing that link would
    // create a tight self-loop, so we instead embed the target's current value
    // (a plain JSON snapshot). Do not collapse when the link came from converting
    // a seen cycle to a Cell, and only collapse when the target is the immediate
    // parent path.
    if (!linkOriginFromCell && isImmediateParent(parsedLink, link)) {
      diffLogger.debug(
        "diff",
        () =>
          `[CELL_LINK_COLLAPSE] Same-doc ancestor/self link detected at path=${pathStr} -> embedding snapshot from ${
            parsedLink.path.join(".")
          }`,
      );
      const snapshot = tx.readValueOrThrow(
        parsedLink,
        options,
      ) as unknown;
      // This re-entry REPLACES the value (the snapshot, not the link), so
      // anchoring eligibility deliberately does not carry over -- matching
      // the annotation scheme, which never looked behind links.
      return normalizeAndDiff(
        runtime,
        tx,
        link,
        snapshot,
        context,
        options,
        state,
      );
    }
    if (
      isPrimitiveCellLink(currentValue) &&
      areLinksSame(newValue, currentValue, link) &&
      scopeInitialization(newValue) === scopeInitialization(currentValue)
    ) {
      diffLogger.debug(
        "diff",
        () => `[BRANCH_CELL_LINK] Same cell link, no-op at path=${pathStr}`,
      );
      if (cfcLabelViewHasValues(carriedCfcLabelView)) {
        recordLinkWritePolicyInput(tx, link, parsedLink, carriedCfcLabelView);
      }
      tx.retainPendingWriteElision?.(toMemorySpaceAddress(link));
      return [];
    } else {
      // Scope-isolation guard (spec: docs/specs/scoped-cell-instances.md,
      // "the runtime must not read across effective scope keys"; pitfall #6 in
      // docs/development/debugging/gotchas/scoped-cell-pitfalls.md): a link
      // whose scope is NARROWER than the slot it's written into resolves to a
      // DIFFERENT instance for every reader — links deliberately do not encode
      // the principal, so e.g. a `user`-scoped link stored in `space`-scoped
      // shared data hands every other participant a link to their own (empty)
      // instance. When the write meant to SHARE data, it can never propagate;
      // readers see a permanent hole (the B2 reader-blackout investigation,
      // #4457/#4532). The slot's schema declaring the scope (the narrowing
      // branch above and scoped asCell entries) is a scope CAP (seefeld):
      // content may be AT MOST that narrow — a same-or-broader link is
      // correct usage and silent; a narrower-than-cap link still warns. The
      // undeclared case has no cap, so the warn there is a sharing-intent
      // heuristic, not cap enforcement. The warn fires where the slot's shape says the
      // author wanted SHARED data (ubik2's criterion): the slot's schema
      // doesn't match undefined and carries no effective default
      // (schemaToleratesMissing, judged with the read side's own matcher),
      // AND the parent's schema lists the slot in `required`
      // (slotRequiredByParent, threaded one hop by the object branch; direct
      // slot writes — cell.key().set(), bound handler cells — have no parent
      // in view and keep the warn). This approximates but is NOT identical to
      // "the read would reject": the B2 element grace (and its
      // generation-skew extension, #4668) means array-element reads degrade
      // rather than void, and rejection is ultimately judged against each
      // READER's combined schema — the warn is a write-site lint, not a
      // proof. The degrades make this warn MORE load-bearing, not less: a
      // reader cannot distinguish an unresolvable narrower-scoped link from
      // an old-generation absent target (both resolve to undefined), so this
      // write-site diagnostic is where a scope mistake self-identifies. Undefined-tolerant, defaulted, or optional slots
      // degrade harmlessly per reader, which is a legitimate pattern and also
      // what the runtime's own scoped-link writes (.asScope() results,
      // navigateTo result cells, updateArgument setup wiring, cold-resume
      // re-scope walks) flow through. This is a WARN, not a throw, pending
      // review; see #4561. Authors: share the value, or a space-scoped cell
      // with a PerUser pointer to "mine" (pitfall #6 shows the idiom).
      if (scopeRank(parsedLink.scope) > scopeRank(link.scope)) {
        const declared = declaredCellScope(link.schema);
        if (
          (declared === undefined ||
            scopeRank(declared) < scopeRank(parsedLink.scope)) &&
          !schemaToleratesMissing(link.schema) &&
          // Optional slots (parent schema present, key not in `required`)
          // degrade harmlessly when the cell is missing — only a required
          // slot voids the read. Unknown parents (direct slot writes) keep
          // the warn.
          slotRequiredByParent !== false
        ) {
          diffLogger.warn(
            "diff",
            () => [
              `Storing a ${parsedLink.scope}-scoped link in ` +
              `${link.scope}-scoped data at path "${pathStr}": scoped links ` +
              `do not carry a principal, so every reader resolves it to ` +
              `their own ${parsedLink.scope} instance. If this write meant ` +
              `to SHARE data, it cannot propagate — share the value itself, ` +
              `or a space-scoped cell (keep a PerUser pointer to "mine"), ` +
              `or declare the slot's schema with scope ` +
              `"${parsedLink.scope}" if per-reader resolution is intended. ` +
              `See docs/development/debugging/gotchas/` +
              `scoped-cell-pitfalls.md (pitfall 6).`,
            ],
          );
        }
      }
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_CELL_LINK] Different cell link, updating at path=${pathStr}`,
      );
      recordLinkWritePolicyInput(tx, link, parsedLink, carriedCfcLabelView);
      return [
        // TODO(seefeld): Normalize the link to a sigil link?
        {
          location: link,
          value: stripCfcLabelViewFromPrimitiveLink(newValue) as FabricValue,
        },
      ];
    }
  }

  // Mint the fabric form of a JS object -- a `Date`, a `Uint8Array`, an
  // `Error`. Anything else comes back `undefined`, which says only that
  // nothing needed minting; the value then has to be storable as it stands,
  // and the vet is what holds it to that. Nothing minted here is a container,
  // so a container keeps its own identity all the way through the walk below
  // -- and that identity is the one shared references and cycles arrive
  // under, which is what `state.seen` is keyed on.
  const minted = shallowFabricFromConvertibleJsObjectElseUndefined(newValue);
  if (minted === undefined) {
    assertValidFabricValueLayer(newValue);
  } else {
    diffLogger.debug(
      "diff",
      () =>
        `[TO_STORABLE_VALUE] Converted ${typeof newValue} at path=${pathStr}`,
    );
    newValue = minted as FabricValue;
  }

  // Anchor a plain object sitting in an array into an entity document of its
  // own, so mutable arrays hold links rather than inline objects. Only a
  // writer that supplied an id source (i.e. one running under a builder frame)
  // anchors, and the source is consumed once per eligible element in traversal
  // order, so the derived ids do not depend on the currently stored state.
  // Cells, links, and query results were consumed by earlier branches, and
  // atomic `FabricSpecialObject`s are excluded here; arrays never anchor, only
  // the objects inside them.
  //
  // An element carried through UNTOUCHED from the stored array diffs to
  // NOTHING -- returned here without descending. This is load-bearing for
  // the mergeable collection ops (`push`/`addUnique`) twice over: their
  // array read is excluded from the commit's conflict set (see
  // docs/features/mergeable-collection-writes.md), which is only safe
  // while the op emits no writes below the tail, so (1) the element itself
  // must not be re-anchored or rewritten, and (2) it must not be DESCENDED
  // either -- descending would register its interior objects in
  // `state.seen`, letting a later occurrence in the same write alias (and
  // promotion would then repoint!) content inside the untouched prefix.
  //
  // "Untouched" is exact identity with the stored value, deliberately NOT
  // content equality: the ops build their combined arrays by carrying the
  // stored elements through by reference (the stored tree is frozen, so the
  // reference IS the stored value), while the written value here is only
  // shallowly normalized -- its nested contents (Cells, JS objects) are
  // converted later in the recursion, so a deep comparison would inspect
  // values whose canonical form does not exist yet.
  //
  // Atomic `FabricSpecialObject`s are excluded from this guard: an untouched
  // special-object prefix element re-emits its identical stored instance
  // from the instance branch below, and the mergeable invariant for those
  // elements rests on the write layer eliding that identical write from the
  // journal rather than on this guard.
  if (
    state.nextAnchorId !== undefined &&
    isArrayElement &&
    isKeyableObjectNotArray(newValue) &&
    !isCellLink(newValue)
  ) {
    if (Object.is(currentValue, newValue)) {
      diffLogger.debug(
        "diff",
        () => `[BRANCH_ANCHOR] Untouched element, no-op at path=${pathStr}`,
      );
      return [];
    }
    diffLogger.debug(
      "diff",
      () => `[BRANCH_ANCHOR] Anchoring array element at path=${pathStr}`,
    );
    // The content must be a distinct object from the registered one: the
    // recursion that writes it into the entity document would otherwise find
    // the value in `state.seen` and no-op as a self-reference, and the
    // document would never be written. A shallow copy keeps nested shared
    // references intact, so cycles still resolve through `state.seen`.
    return anchorValueAsEntity(
      runtime,
      tx,
      link,
      { ...(newValue as FabricPlainObject) },
      newValue,
      state.nextAnchorId(),
      context,
      options,
      state,
    );
  }

  // Handle arrays
  if (Array.isArray(newValue)) {
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_ARRAY] Processing array at path=${pathStr} length=${newValue.length}`,
    );
    // If the current value is not an array, set it to an empty array
    if (!Array.isArray(currentValue)) {
      changes.push({ location: link, value: [] });
    }

    // Have to set this before recursing!
    state.seen.set(newValue, link);

    // Get current array for precomputing child values (if it was an array)
    const currentArray = Array.isArray(currentValue) ? currentValue : undefined;

    // On GROWTH the length change must precede the element writes: applying
    // a slot write beyond the current end auto-extends the array, turning a
    // later length write into a no-op the write layer elides from the
    // journal — write-detail consumers (flow-label clear/re-stamp of the
    // ["length"] entries) would never see the length change, fossilizing
    // its labels at whatever join first stamped them. The shrink direction
    // is the opposite (deletes first, length last) — see below.
    if (
      Array.isArray(currentValue) && newValue.length > currentValue.length
    ) {
      const lub = (link.schema !== undefined)
        ? ContextualFlowControl.lubSchema(link.schema)
        : undefined;
      const lengthSchema = (lub !== undefined)
        ? { type: "number", ifc: { confidentiality: lub } } as JSONSchema
        : { type: "number" } as JSONSchema;
      changes.push({
        location: {
          ...link,
          path: [...link.path, "length"],
          schema: lengthSchema,
        },
        value: newValue.length,
      });
    }

    for (let i = 0; i < newValue.length; i++) {
      const inNew = i in newValue;
      const inCur = currentArray ? i in currentArray : false;

      if (!inNew && !inCur) continue; // hole→hole: no change

      if (!inNew && inCur) {
        // value→hole: emit an explicit delete (a plain `undefined` write
        // would store `undefined` rather than punching a hole)
        changes.push({
          location: {
            ...link,
            path: [...link.path, i.toString()],
            schema: ContextualFlowControl.getSchemaAtPath(link.schema, [
              i.toString(),
            ]),
          },
          value: undefined,
          delete: true,
        });
        continue;
      }

      // hole→value or value→value: recurse normally
      const childSchema = ContextualFlowControl.getSchemaAtPath(link.schema, [
        i.toString(),
      ]);

      // hole→explicit-undefined: a real change (the slot becomes
      // present-but-undefined) that the value diff below can't see, since
      // both sides read as `undefined`. Emit the write directly.
      if (newValue[i] === undefined && !inCur) {
        changes.push({
          location: {
            ...link,
            path: [...link.path, i.toString()],
            schema: childSchema,
          },
          value: undefined,
        });
        continue;
      }

      const nestedChanges = normalizeAndDiff(
        runtime,
        tx,
        {
          ...link,
          path: [...link.path, i.toString()],
          schema: childSchema,
        },
        newValue[i],
        context,
        options,
        state,
        inCur ? currentArray![i] : undefined,
        undefined,
        true,
      );
      changes.push(...nestedChanges);
    }

    // Handle array SHRINK (growth emitted its length change above, before
    // the element writes)
    if (Array.isArray(currentValue) && currentValue.length > newValue.length) {
      // We need to add the schema here, since the array may be secret, so the length should be too
      const lub = (link.schema !== undefined)
        ? ContextualFlowControl.lubSchema(link.schema)
        : undefined;
      // We have to cast these, since the type could be changed to another value
      const childSchema = (lub !== undefined)
        ? { type: "number", ifc: { confidentiality: lub } } as JSONSchema
        : { type: "number" } as JSONSchema;
      // Slots truncated by a shrink are removed, not merely out of range:
      // emit explicit deletes (the direct `length`-write path's idiom) so
      // write-detail consumers — notably the flow-label carry-forward that
      // must drop the removed slots' stale per-slot link entries — see the
      // removal. Ordered BEFORE the length change: once the length write
      // has truncated the array, a delete at a now-absent slot is a no-op
      // the write layer elides from the journal. Growth needs nothing
      // here — the element loop above already visited every new slot.
      for (let i = newValue.length; i < currentValue.length; i++) {
        if (!(i in currentValue)) continue; // hole: nothing to remove
        changes.push({
          location: {
            ...link,
            path: [...link.path, i.toString()],
            schema: ContextualFlowControl.getSchemaAtPath(link.schema, [
              i.toString(),
            ]),
          },
          value: undefined,
          delete: true,
        });
      }
      changes.push({
        location: {
          ...link,
          path: [...link.path, "length"],
          schema: childSchema,
        },
        value: newValue.length,
      });
    }

    // Authoritative container re-assert (round-2 thread 16, the F2
    // family): an EMPTY (or all-equal-links) array produces no leaf
    // writes at all — the element walk above has nothing to emit — so
    // a completion writeback of an equal `[]` against a DOOMED
    // optimistic overlay would commit only its sibling fields
    // (pending/requestHash) and the durable result slot stays torn,
    // exactly the elision the authoritative primitive branch below
    // exists to prevent. Assert the container itself when the subtree
    // emitted nothing; identical re-asserts are idempotent at the
    // store (serving-loop.md §5).
    if (changes.length === 0 && tx.isAuthoritativeWrites?.() === true) {
      // Written whole rather than by its members, and this is the only branch
      // that does so, which makes it the only one that owes the store a value
      // the caller cannot go on mutating. Already-frozen input is handed
      // through by identity.
      changes.push({
        location: link,
        value: cloneIfNecessary(newValue as FabricValue, { deep: false }),
      });
    } else if (changes.length === 0) {
      tx.retainPendingWriteElision?.(toMemorySpaceAddress(link));
    }

    return changes;
  }

  // `FabricSpecialObject` values (`FabricInstance` wrappers and `FabricPrimitive`
  // leaves alike) are atomic from this layer's perspective: their
  // own-enumerable properties are implementation details, not
  // user-visible structure, and iterating them via the generic
  // `isObjectOrArray` branch below would walk wrapper-internal fields (or, for a
  // primitive whose state is private, flatten it to `{}`), which
  // is meaningless at the change-emission level. Emit a single change at
  // this link with the value as-is — the storage layer's JSON encoding handles
  // serialization (via each type's `[CODEC]`). Placed after the write-redirect
  // resolution above so writes through a redirect land on the target,
  // not on the redirect itself.
  if (isFabricSpecialObject(newValue)) {
    diffLogger.debug(
      "diff",
      () => `[BRANCH_FABRIC_INSTANCE] Atomic FabricInstance at path=${pathStr}`,
    );
    // TODO(danfuzz): Replace this band-aid once the unified walk supports
    // coordinated descent into `FabricInstance` internals (see below); at that
    // point switch this to a shallow conversion.
    //
    // BAND-AID: this *should* be a shallow conversion. This is a unified walk
    // (one walk state for shared-ref/cycle handling, element anchoring, and
    // diffing), and the right design is to shallow-wrap the `FabricInstance`
    // here and let this walk descend into its `FabricValue` internals as part
    // of the same coordinated pass. We don't support that descent yet, so the
    // wrapper's internals could otherwise reach storage improperly converted.
    //
    // As a stopgap we run the deep `fabricFromConvertibleJsValue()`, which
    // converts the internals via a *separate, uncoordinated* pass. The cost:
    // any `FabricValue` reachable both inside the wrapper and elsewhere in the
    // outer tree gets de-shared (the outer walk handles one copy; this deep
    // call mints an independent, separately-frozen copy with no shared `seen` /
    // ID bookkeeping). That is invisible for `FabricError` today only because
    // an error's `cause` / custom props aren't, in practice, shared with the
    // rest of the tree -- but `FabricSet` / `FabricMap` (collections of
    // arbitrary, routinely-shared `FabricValue`s) WILL break here once they
    // carry real traffic. Proper fix: coordinated descent into wrapper
    // internals, after which a shallow conversion suffices.
    //
    // The call is class-agnostic (no concrete-subclass special-casing): each
    // subclass governs its own deep conversion and already-proper / deep-frozen
    // instances short-circuit by identity.
    changes.push({
      location: link,
      value: fabricFromConvertibleJsValue(newValue),
    });
    return changes;
  }

  // Handle objects
  if (isObjectOrArray(newValue)) {
    diffLogger.debug(
      "diff",
      () => `[BRANCH_OBJECT] Processing object at path=${pathStr}`,
    );
    // If the current value is not a (regular) object, set it to an empty object.
    // Note that the alias case is handled above.
    // Resetting on an array→object transition is required; otherwise per-key
    // writes land in a slot whose stored parent is still an array and storage
    // rejects them with a TypeMismatchError. This mirrors the array branch
    // above, which resets a mismatched container via `value: []`.
    //
    // A stored special object gets that same reset, for the same reason: it
    // reaches storage whole via the branch above, its zero keys yield no
    // removals, and without a reset the per-key child writes would land in
    // slots whose stored parent is still the special object.
    if (
      !isKeyableObjectNotArray(currentValue) ||
      isPrimitiveCellLink(currentValue)
    ) {
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_OBJECT] Current value is not a record or cell link, setting to empty object at path=${pathStr}`,
      );
      changes.push({ location: link, value: {} });
      currentValue = {};
    }

    // Have to set this before recursing!
    state.seen.set(newValue, link);

    // At this point currentValue is guaranteed to be a record
    const currentRecord = currentValue as Record<string, unknown>;

    // Requiredness of each child slot, for the scope-isolation warn: only a
    // parent-`required` property makes a missing cell void the read.
    // A resolved object schema with no top-level `required` array is treated
    // as requiring nothing (known `false` for every key); only an absent /
    // unresolvable parent schema leaves requiredness unknown (undefined).
    // KNOWN GAP (deliberate, false-negative direction): `required` carried
    // inside a compound parent (`allOf` branches, all-branches-require
    // `anyOf`) is not merged here — resolveSchema resolves only a top-level
    // $ref — so such parents read as requiring nothing and the warn stays
    // silent, even though the read side's required-intersection machinery may
    // still reject. A missed warn is acceptable for a lint; asserting
    // requiredness where there is none is not.
    const resolvedParentSchema = resolveSchema(link.schema);
    const requiredProps = isObjectOrArray(resolvedParentSchema)
      ? new Set(
        Array.isArray(resolvedParentSchema.required)
          ? (resolvedParentSchema.required as readonly string[])
          : [],
      )
      : undefined;

    // `Object.keys`, not `for...in`: the latter also walks the prototype chain,
    // and only `newValue`'s own keys are being written.
    for (const key of Object.keys(newValue)) {
      diffLogger.debug("diff", () => {
        const childPath = [...link.path, key].join(".");
        return `[DIFF_RECURSE] Recursing into key='${key}' childPath=${childPath}`;
      });

      const childSchema = ContextualFlowControl.getSchemaAtPath(link.schema, [
        key,
      ]);

      // An explicit `undefined` for a key the current object doesn't have is
      // a real change — the slot becomes present-but-undefined — but the
      // value diff below sees `undefined === undefined` and would emit
      // nothing. `undefined` is a leaf, so emit the write directly.
      //
      // `Object.hasOwn`, not `in`: `key` is a data key and `currentRecord` is
      // data. `in` walks the prototype chain, so setting a key called
      // `toString` to `undefined` looked like it was already present and the
      // write was dropped.
      if (newValue[key] === undefined && !Object.hasOwn(currentRecord, key)) {
        changes.push({
          location: { ...link, path: [...link.path, key], schema: childSchema },
          value: undefined,
        });
        continue;
      }

      const nestedChanges = normalizeAndDiff(
        runtime,
        tx,
        { ...link, path: [...link.path, key], schema: childSchema },
        newValue[key],
        context,
        options,
        state,
        // Indexing alone would fall through to the prototype: for a key named
        // `valueOf`, a record with no such own property yields
        // `Object.prototype.valueOf`, and the diff below then fails with
        // "Cannot compare a function value" — a write refused because of a
        // method the data never had. Absent means absent.
        Object.hasOwn(currentRecord, key) ? currentRecord[key] : undefined,
        requiredProps === undefined ? undefined : requiredProps.has(key),
      );
      changes.push(...nestedChanges);
    }

    // The scope-narrowing branch at the top of normalizeAndDiff only fires for
    // keys present in newValue (e.g. populated from a schema default). A
    // property whose schema declares a narrower scope but arrives with no
    // value would leave the base-scope slot empty, so later schema-less writes
    // (e.g. through a handler's cell reference) would land at the base scope
    // instead of the narrower instance. Eagerly materialize the redirect for
    // those keys, and exempt them from removal below so an object rewrite that
    // omits the key can't strip the redirect either. Only the redirect is
    // written; the narrower-scope instance's content is left untouched.
    // (resolveSchema, not resolveSchemaForValue: the latter recurses through
    // property values and diverges on circular values + recursive $ref
    // schemas; only the top-level property names are needed here.)
    const eagerScopedKeys = new Set<string>();
    const schemaProperties = isObjectOrArray(resolvedParentSchema)
      ? resolvedParentSchema.properties
      : undefined;
    if (isObjectOrArray(schemaProperties)) {
      // `Object.keys`, not `for...in`: the latter walks the prototype chain
      // too, and these are the schema's OWN declared property names.
      for (const key of Object.keys(schemaProperties)) {
        // `Object.hasOwn`, not `in`, for the same reason one line up: `key` is
        // a schema-declared name and `newValue` is data, so a property called
        // `toString` looked present on every object and its eager scoping was
        // skipped.
        if (Object.hasOwn(newValue, key)) continue;
        const childSchema = ContextualFlowControl.getSchemaAtPath(link.schema, [
          key,
        ]);
        const childScope = declaredCellScope(childSchema);
        if (
          childScope === undefined ||
          scopeRank(childScope) <= scopeRank(link.scope)
        ) {
          continue;
        }
        const childLink: NormalizedFullLink = {
          ...link,
          path: [...link.path, key],
          schema: childSchema,
        };
        changes.push(...scopedRedirectChanges(
          runtime,
          tx,
          childLink,
          childScope,
          context,
          options,
          state,
          currentRecord[key],
        ));
        eagerScopedKeys.add(key);
      }
    }

    // Handle removed keys: explicit deletes, so a key the new value omits is
    // removed rather than left behind as present-but-undefined.
    //
    // `Object.keys` + `Object.hasOwn`, not `for...in` + `in`: both walk the
    // prototype chain. A stored property named `toString` was never removed,
    // because `"toString" in newValue` is true for every object — so setting
    // `{ name }` over `{ name, toString }` left the `toString` behind.
    for (const key of Object.keys(currentRecord)) {
      if (!Object.hasOwn(newValue, key) && !eagerScopedKeys.has(key)) {
        changes.push({
          location: { ...link, path: [...link.path, key] },
          value: undefined,
          delete: true,
        });
      }
    }

    // Authoritative container re-assert — the record-branch twin of the
    // array branch's (round-2 thread 16): an empty `{}` (or a record of
    // only unchanged links) emits no per-key writes, so without this a
    // completion's equal-`{}` result riding a doomed overlay is never
    // asserted durably. See the array branch for the full rationale.
    if (changes.length === 0 && tx.isAuthoritativeWrites?.() === true) {
      // Written whole rather than by its members, and this is the only branch
      // that does so, which makes it the only one that owes the store a value
      // the caller cannot go on mutating. Already-frozen input is handed
      // through by identity.
      changes.push({
        location: link,
        value: cloneIfNecessary(newValue as FabricValue, { deep: false }),
      });
    } else if (changes.length === 0) {
      tx.retainPendingWriteElision?.(toMemorySpaceAddress(link));
    }

    return changes;
  }

  // When setting array length, also update the removed/added elements.
  if (
    link.path.length > 0 && link.path[link.path.length - 1] === "length"
  ) {
    const maybeCurrentArray = tx.readValueOrThrow({
      ...link,
      path: link.path.slice(0, -1),
    }, options);
    if (Array.isArray(maybeCurrentArray)) {
      const currentLength = maybeCurrentArray.length;
      const newLength = newValue as number;
      if (currentLength !== newLength) {
        changes.push({ location: link, value: newLength });
        for (
          let i = Math.min(currentLength, newLength);
          i < Math.max(currentLength, newLength);
          i++
        ) {
          // Slots beyond the shorter length are removed (or, on growth,
          // were never present): explicit deletes, not `undefined` values.
          changes.push({
            location: {
              ...link,
              path: [...link.path.slice(0, -1), i.toString()],
            },
            value: undefined,
            delete: true,
          });
        }
        return changes;
      }
    } // else, i.e. parent is not an array: fall through to the primitive case
  }

  // Handle primitive values and other cases (Object.is handles NaN and -0).
  //
  // Authoritative transactions (markAuthoritativeWrites — effect-completion
  // writebacks under the serving posture) emit equal-value leaves TOO:
  // `currentValue` was read through the replica's optimistic view, which can
  // layer a DOOMED sealed overlay (a derivation write a later wave-commit
  // supersede-drops) over confirmed state — so "already equal" is not
  // evidence the store holds the value. Eliding a completion's
  // `inputHash`/`pending` write against such an overlay durably lands
  // `result present + inputHash stale`, and the next run's memo guard
  // destroys the just-served value (the completion-visibility wedge, F2).
  // One nuance this accepts: an authoritative write of `undefined` to an
  // ABSENT slot materializes it as present-but-undefined instead of
  // eliding — reads see `undefined` either way.
  if (
    !Object.is(currentValue, newValue) ||
    tx.isAuthoritativeWrites?.() === true
  ) {
    changes.push({ location: link, value: newValue as FabricValue });
  } else {
    tx.retainPendingWriteElision?.(toMemorySpaceAddress(link));
  }

  return changes;
}

/**
 * Checks if a value contains data at a given path.
 * Returns true if the path exists in the value (even if the value at that path is undefined).
 */
function hasPath(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return true;

  if (!isObjectOrArray(value)) {
    return false;
  }

  const [first, ...rest] = path;

  if (Array.isArray(value)) {
    // Special case: "length" is always present on arrays
    if (first === "length" && rest.length === 0) return true;
    // Only valid array index strings can access array elements
    if (!isArrayIndexPropertyName(first)) return false;
    // Use `in` to correctly handle sparse arrays (holes are not present)
    const index = Number(first);
    if (!(index in value)) return false;
    return hasPath(value[index], rest);
  }

  const obj = value as Record<string, unknown>;
  if (!(first in obj)) return false;
  return hasPath(obj[first], rest);
}

/**
 * Compacts a ChangeSet by removing redundant child path changes when a
 * parent path change already includes that data.
 *
 * This optimization reduces the number of writes when setting nested structures.
 * For example, if we set `foo = {a: 1, b: 2}` and also set `foo/a = 1`,
 * the child write is redundant since the parent already contains it.
 *
 * Key rules:
 * - Empty objects `{}` or arrays `[]` do NOT subsume children (children populate them)
 * - Parent deletions (`delete: true`) and parent writes of `undefined` DO
 *   subsume child changes (either way the subtree at the parent is gone)
 * - Parent must actually CONTAIN the child's path for subsumption to occur
 *
 * @param changes - The original change set
 * @returns A compacted change set with redundant child paths removed
 */
export function compactChangeSet(changes: ChangeSet): ChangeSet {
  if (changes.length <= 1) return changes;

  // Group by document without conflating boundaries between address fields.
  const byDocument = new Map<string, ChangeSet>();
  for (const change of changes) {
    const key = stringTupleKey([
      change.location.space,
      change.location.id,
    ]);
    if (!byDocument.has(key)) byDocument.set(key, []);
    byDocument.get(key)!.push(change);
  }

  const result: ChangeSet = [];
  for (const docChanges of byDocument.values()) {
    // Sort by path length (shortest first - parents before children)
    const sorted = docChanges.toSorted(
      (a, b) => a.location.path.length - b.location.path.length,
    );

    // Track parent paths that can subsume children
    // Empty {} or [] don't subsume - children populate them!
    const subsumingPaths: Array<
      { path: readonly string[]; value: unknown; delete?: boolean }
    > = [];

    for (const change of sorted) {
      const path = change.location.path;

      // Check if subsumed by a parent with actual content
      const isSubsumed = subsumingPaths.some((parent) => {
        if (parent.path.length >= path.length) return false;
        if (!parent.path.every((seg, i) => seg === path[i])) return false;

        // Parent path is prefix - check if parent VALUE contains this child's path
        const parentVal = parent.value;
        if (parentVal === null || parentVal === undefined) return false;
        if (typeof parentVal !== "object") return false;

        // Calculate the relative path from parent to child
        const relativePath = path.slice(parent.path.length);

        // Only subsume if parent's value actually contains data at the child's relative path
        return hasPath(parentVal, relativePath);
      });

      // Also check: is this child subsumed by a parent whose subtree is gone
      // (explicit delete, or overwritten with `undefined`)?
      const isDeletedByParent = subsumingPaths.some((parent) => {
        if (parent.path.length >= path.length) return false;
        if (!parent.path.every((seg, i) => seg === path[i])) return false;
        return parent.delete === true || parent.value === undefined;
      });

      if (!isSubsumed && !isDeletedByParent) {
        result.push(change);
        // Track this path for potential child subsumption
        subsumingPaths.push({
          path,
          value: change.value,
          delete: change.delete,
        });
      }
    }
  }

  diffLogger.debug(
    "compact",
    () =>
      `[compactChangeSet] Compacted ${changes.length} changes to ${result.length}`,
  );

  return result;
}

/**
 * Apply a change set to all mentioned documents.
 *
 * @param changes - The change set to apply.
 * @param log - The log to write to.
 */
export function applyChangeSet(
  tx: IExtendedStorageTransaction,
  changes: ChangeSet,
) {
  // CT-1123: Removed compactChangeSet - structural sharing makes redundant writes
  // cheap (O(path_depth) with noop detection), while compaction added O(N²) overhead.
  // Benchmarks showed 2.5-4.4x slowdown with compactChangeSet enabled.
  if (tx.writeValuesOrThrow) {
    tx.writeValuesOrThrow(
      changes.map((change) => ({
        address: change.location,
        value: change.value,
        delete: change.delete,
      })),
    );
    return;
  }
  for (const change of changes) {
    // `diffAndUpdate()` establishes attempted-target coverage before we get
    // here, so these direct writes preserve the phase-1 `attemptedWrites` view.
    tx.writeValueOrThrow(
      change.location,
      change.value,
      change.delete ? { delete: true } : undefined,
    );
  }
}

/**
 * Returns true if `target` is the immediate parent of `base` in the same document.
 *
 * Example:
 * - base.path = ["__#1", "next"]
 * - target.path = ["__#1"]
 *
 * This is used to decide when to collapse a self/parent link that would create
 * a tight self-loop (e.g., obj.next -> obj) while allowing references to
 * higher ancestors (like an item's `items` pointing to its containing array).
 */
function isImmediateParent(
  target: NormalizedFullLink,
  base: NormalizedFullLink,
): boolean {
  return (
    target.id === base.id &&
    target.space === base.space &&
    target.path.length === base.path.length - 1 &&
    target.path.every((seg, i) => seg === base.path[i])
  );
}
