import {
  AnyCellWrapping,
  type JSONSchemaObj,
  type JSONValue,
} from "@commonfabric/api";
import {
  cloneIfNecessary,
  fabricAwareEqual,
  FabricInstance,
  FabricPrimitive,
  type FabricValue,
  isDeepFrozen,
  isWalkableObjectOrArray,
  shallowMutableClone,
} from "@commonfabric/data-model";
import {
  internSchema,
  isNontrivialSchema,
  schemaWithProperties,
} from "@commonfabric/data-model-schema";
import { readStatsActive, recordLinkResolution } from "./read-stats.ts";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { opaqueReference, toCell } from "./back-to-cell.ts";
import { type JSONSchema, type SchemaScope } from "./builder/types.ts";
import { createCell, isCell } from "./cell.ts";
import {
  ContextualFlowControl,
  resolveExternalRootRefForStructure,
} from "./cfc.ts";
import { cfcSchemaWithInheritedDefs } from "./cfc/schema-refs.ts";
import { CfcLabelViewRebaser } from "./cfc/label-view-rebaser.ts";
import {
  type CfcLabelView,
  cfcLabelViewForDereference,
  cfcLabelViewForDereferenceTraces,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./cfc/label-view-state.ts";
import { storedCfcMetadataAppliesToPath } from "./cfc/metadata.ts";
import type { CfcAddress } from "./cfc/types.ts";
import { waveRunContextOf } from "./executor/wave.ts";
import {
  readMaybeLink,
  resolveLink,
  undefinedDataLink,
} from "./link-resolution.ts";
import type {
  IMemorySpaceValueAddress,
  NormalizedFullLink,
} from "./link-utils.ts";
import {
  createQueryResultProxy,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import type { Runtime } from "./runtime.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import { markIfcBearingLinkCrossing, schemaHasIfc } from "./schema-ifc.ts";
import { arrayMatchesPositionally } from "./schema-match.ts";
import {
  externalResolutionMissCount,
  onSchemaRegistryClear,
} from "./schema-registry.ts";
import {
  defaultForAbsentValue,
  materializeSchemaView,
  UnresolvedInputError,
} from "./schema-view.ts";
import { canFollowScopedLink, isCellScope } from "./scope.ts";
import { getTransactionForChildCells } from "./storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { usesLocalReads } from "./storage/local-read-policy.ts";
import {
  excludeReadFromConflict,
  internalVerifierRead,
  linkResolutionProbe,
} from "./storage/reactivity-log.ts";
import {
  canBranchMatch,
  combineOptionalSchema,
  combineSchema,
  combineSchemaForLink,
  createDefaultTraversalContext,
  IObjectCreator,
  mergeAnyOfMatches,
  SchemaObjectTraverser,
} from "./traverse.ts";

const logger = getLogger("validateAndTransform", {
  enabled: true,
  level: "debug",
});

const cfcAddressFromLink = (link: NormalizedFullLink): CfcAddress => ({
  space: link.space,
  id: link.id,
  scope: link.scope,
  path: [...link.path],
});

// The `asCell` declaration chooses the scope of a new slot. Existing values
// and references keep their storage-resolved scope; their schema scope only
// constrains which links a read may follow.
const linkWithAsCellScope = (
  link: NormalizedFullLink,
  entry:
    | ReturnType<typeof ContextualFlowControl.getAsCellValues>[number]
    | undefined,
): NormalizedFullLink => {
  const scope = ContextualFlowControl.getAsCellScope(entry);
  return isCellScope(scope) ? { ...link, scope } : link;
};

// Value-independent part of asCellCompoundSchemaForValue: the merged
// candidate schemas (those that carry asCell entries) for each anyOf/oneOf
// branch. Building them spreads the base schema and resolves + combines +
// interns every branch — and that repeats on EVERY read of a cell with a
// compound schema (e.g. every vdom node under rendererVDOMSchema), which
// CPU profiles showed as the dominant hashing seam of reconciler mounts.
// Cache per deep-frozen schema identity; mutable schemas recompute per call.
// The cached candidates are interned (combineSchema interns its results), so
// downstream identity-keyed memos see stable references too.
let compoundAsCellCandidatesCache = new WeakMap<
  JSONSchemaObj,
  readonly JSONSchemaObj[]
>();
// Candidates embed resolved branch content, so a registry clear (last lease
// out) swaps the cache — a resolution success must not outlive its epoch.
onSchemaRegistryClear(() => {
  compoundAsCellCandidatesCache = new WeakMap();
});

const asCellCompoundCandidates = (
  schema: JSONSchemaObj,
): readonly JSONSchemaObj[] => {
  const cacheable = isDeepFrozen(schema);
  if (cacheable) {
    const cached = compoundAsCellCandidatesCache.get(schema);
    if (cached !== undefined) return cached;
  }
  const missesBefore = externalResolutionMissCount();
  const branches = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
  ];
  const candidates: JSONSchemaObj[] = [];
  if (branches.length > 0) {
    const { anyOf: _anyOf, oneOf: _oneOf, ...baseSchema } = schema;
    for (const branch of branches) {
      const branchWithDefs = cfcSchemaWithInheritedDefs(branch, schema.$defs);
      const resolved = resolveSchema(branchWithDefs) ?? branchWithDefs;
      const merged = combineSchema(baseSchema as JSONSchemaObj, resolved);
      if (
        isObjectOrArray(merged) &&
        ContextualFlowControl.getAsCellValues(merged).length > 0
      ) {
        candidates.push(merged as JSONSchemaObj);
      }
    }
  }
  // Populate only when no `cid:` resolution missed while building: a branch
  // whose ref missed resolves to nothing and would be missing from a
  // memoized candidate list forever, though the document can still arrive.
  if (cacheable && externalResolutionMissCount() === missesBefore) {
    compoundAsCellCandidatesCache.set(schema, candidates);
  }
  return candidates;
};

/**
 * The link a handle gets when its target is narrower than the cap its schema
 * declares: undefined-data in place, the same shape resolveLink hands back for
 * a blocked follow. It is still a Cell -- so a `required` container is not
 * voided -- it reads as undefined, and it is not writable, because a data URI
 * is a read-only address.
 */
const blockedHandleLink = (
  link: NormalizedFullLink,
  cap: SchemaScope | undefined,
): NormalizedFullLink => {
  logger.warn(
    `blocked narrower-scope asCell handle: a "${cap}"-scoped read cannot ` +
      `hold a "${link.scope}"-scoped link, so the handle reads as undefined. ` +
      `Declare the handle's asCell scope at least as narrow as the value it ` +
      `points at.`,
  );
  return undefinedDataLink(link);
};

const asCellCompoundSchemaForValue = (
  schema: JSONSchemaObj,
  value: unknown,
): JSONSchemaObj | undefined => {
  if (value === undefined) {
    return undefined;
  }
  for (const merged of asCellCompoundCandidates(schema)) {
    if (matchesConcreteValue(merged, value)) {
      return merged;
    }
  }
  return undefined;
};

export type CellViewRef = {
  link: NormalizedFullLink;
  cfcLabelView?: CfcLabelView;
};

const isCellViewRef = (
  ref: NormalizedFullLink | CellViewRef,
): ref is CellViewRef => isObjectOrArray(ref) && "link" in ref;

const isPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

const labelViewForLink = (
  baseLink: NormalizedFullLink,
  baseView: CfcLabelViewRebaser,
  link: NormalizedFullLink,
): CfcLabelView | undefined => {
  if (
    baseLink.space === link.space &&
    baseLink.id === link.id &&
    isPrefix(baseLink.path, link.path)
  ) {
    return baseView.rebase(link.path.slice(baseLink.path.length));
  }
  return baseView.rebase(link.path);
};

const matchesConcreteValue = (
  schema: JSONSchema,
  value: unknown,
): boolean => {
  if (schema === false) {
    return false;
  }
  const resolved = resolveSchema(schema);
  if (resolved === undefined) {
    return true;
  }
  if (typeof resolved === "boolean") {
    return resolved;
  }
  if (!canBranchMatch(resolved, value)) {
    return false;
  }
  if (
    resolved.const !== undefined && !fabricAwareEqual(resolved.const, value)
  ) {
    return false;
  }
  if (
    Array.isArray(resolved.enum) &&
    !resolved.enum.some((candidate) => fabricAwareEqual(candidate, value))
  ) {
    return false;
  }

  if (Array.isArray(resolved.anyOf)) {
    const { anyOf, ...rest } = resolved;
    return anyOf.some((branch) =>
      matchesConcreteValue(
        combineSchema(
          rest as JSONSchemaObj,
          resolveSchema(cfcSchemaWithInheritedDefs(branch, resolved.$defs)) ??
            cfcSchemaWithInheritedDefs(branch, resolved.$defs),
        ),
        value,
      )
    );
  }
  if (Array.isArray(resolved.oneOf)) {
    const { oneOf, ...rest } = resolved;
    return oneOf.filter((branch) =>
      matchesConcreteValue(
        combineSchema(
          rest as JSONSchemaObj,
          resolveSchema(cfcSchemaWithInheritedDefs(branch, resolved.$defs)) ??
            cfcSchemaWithInheritedDefs(branch, resolved.$defs),
        ),
        value,
      )
    ).length === 1;
  }

  if (isObjectOrArray(value) && isObjectOrArray(resolved.properties)) {
    return Object.entries(resolved.properties).every(([key, childSchema]) =>
      value[key] === undefined ||
      matchesConcreteValue(
        cfcSchemaWithInheritedDefs(childSchema, resolved.$defs),
        value[key],
      )
    );
  }

  if (Array.isArray(value)) {
    // Shared position rule (schema-match.ts): tuple slots match their exact
    // position, `items` matches only the positions past them. A
    // prefixItems-only schema previously fell through to `return true`,
    // letting ANY array match — so the wrong anyOf/oneOf branch could be
    // selected for tuple values.
    return arrayMatchesPositionally(
      resolved,
      value,
      (childSchema, childValue) =>
        matchesConcreteValue(
          cfcSchemaWithInheritedDefs(childSchema, resolved.$defs),
          childValue,
        ),
    );
  }

  return true;
};

/**
 * Schemas are mostly a subset of JSONSchema.
 *
 * One addition is `asCell`. When true, the `.get()` returns an instance of
 * `Cell`, i.e. a reactive reference to the value underneath. Some implications
 * this has:
 *  - The cell reflects as closely as possible the current value. So it doesn't
 *    change when the underlying reference changes. This is useful to e.g. to
 *    read the current value of "currently selected item" and keep that constant
 *    even if in the future another item is selected. NOTE:
 *    - For this to work, the underlying value should be a reference itself.
 *      Otherwise the closest parent document is used, so that e.g. reading
 *      current.name tracks changes on current.
 *    - If the value is an alias, aliases are followed first and the cell is
 *      based on the first non-alias value. This is because writes will follow
 *      aliases as well.
 *
 * `asCell` can also be an array, so it can indicate a `Cell<Cell<T>>` or
 * capture other options like opaque or stream types.
 *
 * Calling `effect` on returned cells within a higher-level `effect` works as
 * expected. Be sure to track the cancels, though. (Tracking cancels isn't
 * necessary when using the schedueler directly)
 */

/**
 * Resolve a schema to its canonical interned form, or `undefined` when the
 * input carries no usable information.
 *
 * The return value is the **canonical interned reference** for the resolved
 * schema's structural content — produced by `internSchema()`. Concrete
 * consequences of that contract:
 *
 * - For structurally-equal schemas, `resolveSchema()` returns the same
 *   reference across calls. Downstream identity-based caches
 *   (`schemaHasIfc`'s memo, `standardizedSchemaCache`, hashSchema WeakMaps,
 *   the `resolveLink`-exit canonicalization, etc.) hit O(1) on those
 *   returns without needing to rehash.
 * - The return value is **not** guaranteed to be the same reference as the
 *   caller-supplied `schema`, even when the caller's schema is already
 *   deep-frozen. A caller-frozen schema that happens to be content-equal
 *   to an already-interned instance is replaced by the canonical one.
 * - When the caller supplies a schema that **is** itself the canonical
 *   interned instance, the same reference is returned (because
 *   `internSchema()` short-circuits on WeakMap hit).
 * - `undefined` is returned for trivial inputs (`undefined`, `null`, `{}`,
 *   non-object) and for `$ref`-chains that resolve to a boolean or
 *   trivial schema.
 *
 * Callers that need a stable reference across calls should therefore rely
 * on structural canonicalization (same content yields same reference)
 * rather than caller-identity preservation. This is the same contract the
 * `resolveLink()` exit follows (see `link-resolution.ts`).
 */
export function resolveSchema(
  schema: JSONSchema | undefined,
): JSONSchema | undefined {
  // Treat undefined/null/{} or any other non-object as no schema
  // We don't use ContextualFlowControl.isTrueSchema here, since we want to
  // handle flags like default or ifc
  if (!isNontrivialSchema(schema)) {
    return undefined;
  }

  let resolvedSchema = schema;
  if (typeof schema.$ref === "string") {
    const resolved = ContextualFlowControl.resolveSchemaRefs(schema);
    if (resolved === undefined) {
      // The ref names a definition this schema does not carry. That is not the
      // same as no schema, which lets every value through untouched — it is a
      // schema the runtime cannot read, and a value cannot be shown to match
      // one of those. `false` selects nothing, which is the answer traversal
      // already gives a top-level ref it fails to resolve; returning
      // `undefined` here instead handed the reader the raw value.
      logger.warn(
        "unresolvable $ref in a schema; nothing matches it",
        schema.$ref,
      );
      return false;
    }
    if (!isObjectOrArray(resolved)) {
      // For boolean schema or the default `{}` schema, we don't have any
      // meaningful information in the schema, so just return undefined.
      return undefined;
    }
    resolvedSchema = resolved;
  }

  // Return no schema if all it said is that this was a reference or an
  // object without properties. Intern here (rather than just
  // deep-freezing) so structurally-equal schemas collapse to a single
  // canonical reference across calls — see the contract above.
  return isNontrivialSchema(resolvedSchema)
    ? internSchema(resolvedSchema)
    : undefined;
}

const selectMatchingCompoundBranch = (
  schema: JSONSchemaObj,
  value: unknown,
  kind: "anyOf" | "oneOf",
): JSONSchema | undefined => {
  const branches = schema[kind];
  if (!Array.isArray(branches) || branches.length === 0) {
    return undefined;
  }

  const { [kind]: _compound, ...rest } = schema;
  const baseSchema = rest as JSONSchemaObj;
  const matches = branches.flatMap((branch) => {
    const resolvedBranch =
      resolveSchema(cfcSchemaWithInheritedDefs(branch, schema.$defs)) ??
        cfcSchemaWithInheritedDefs(branch, schema.$defs);
    const merged = combineSchema(baseSchema, resolvedBranch);
    return matchesConcreteValue(merged, value) ? [merged] : [];
  });

  return matches.length === 1 ? matches[0] : undefined;
};

export function resolveSchemaForValue(
  schema: JSONSchema | undefined,
  value: unknown,
): JSONSchema | undefined {
  const resolved = resolveSchema(schema);
  if (
    resolved === undefined || typeof resolved === "boolean" ||
    !isObjectOrArray(resolved)
  ) {
    return resolved;
  }

  let narrowed: JSONSchema = resolved;
  if (Array.isArray(resolved.anyOf)) {
    narrowed = selectMatchingCompoundBranch(resolved, value, "anyOf") ??
      resolved;
  } else if (Array.isArray(resolved.oneOf)) {
    narrowed = selectMatchingCompoundBranch(resolved, value, "oneOf") ??
      resolved;
  }

  if (!isObjectOrArray(narrowed)) {
    return narrowed;
  }

  if (!isObjectOrArray(value) || !isObjectOrArray(narrowed.properties)) {
    return narrowed;
  }

  let changed = false;
  const nextProperties: Record<string, JSONSchema> = {
    ...narrowed.properties,
  };
  for (const [key, childSchema] of Object.entries(narrowed.properties)) {
    const childValue = value[key];
    const resolvedChild = resolveSchemaForValue(
      cfcSchemaWithInheritedDefs(childSchema, narrowed.$defs),
      childValue,
    );
    if (resolvedChild !== undefined && resolvedChild !== childSchema) {
      nextProperties[key] = resolvedChild;
      changed = true;
    }
  }

  return changed
    ? {
      ...narrowed,
      properties: nextProperties,
    }
    : narrowed;
}

export { schemaHasIfc };

const _filterAsCellCache = new WeakMap<
  JSONSchemaObj,
  JSONSchema | "<undefined>"
>();

function filterAsCell(schema: JSONSchema | undefined): JSONSchema | undefined {
  if (!isNontrivialSchema(schema)) {
    return schema;
  }

  const makeRawResult = () => {
    const { asCell: _asCell, ...restSchema } = schema;
    return isNontrivialSchema(restSchema) ? restSchema : undefined;
  };

  if (isDeepFrozen(schema)) {
    // Note: We cache literal `<undefined>` when we are to return `undefined`,
    // to disambiguate with no-entry.
    const cached = _filterAsCellCache.get(schema);
    if (cached) return (cached === "<undefined>") ? undefined : cached;
    const rawResult = makeRawResult();
    if (rawResult) {
      const result = internSchema(rawResult);
      _filterAsCellCache.set(schema, result);
      return result;
    } else {
      _filterAsCellCache.set(schema, "<undefined>");
      return undefined;
    }
  } else {
    return makeRawResult();
  }
}

/**
 * Process a default value from a schema, transforming it based on the schema
 * structure to account for asCell/asStream and other schema features.
 *
 * For `required` objects and arrays assume {} and [] as default value.
 */
export function processDefaultValue(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  defaultValue: any,
  synced = false,
  cfcLabelView?: CfcLabelView,
): any {
  const schema = link.schema;
  if (!schema) return defaultValue;

  let resolvedSchema = resolveSchema(schema);
  if (!isObjectOrArray(resolvedSchema)) {
    // For primitive types, return as is
    return annotateWithBackToCellSymbols(
      defaultValue,
      runtime,
      link,
      tx,
      synced,
      cfcLabelView,
    );
  }

  const asCellValues = ContextualFlowControl.getAsCellValues(resolvedSchema);
  if (asCellValues.length > 0) {
    // Remove the asCell flags from the schema
    const { asCell: _c, ...restSchema } = resolvedSchema;
    resolvedSchema = restSchema;

    if (
      ContextualFlowControl.getAsCellKind(asCellValues.at(0)) === "stream"
    ) {
      // A stream position holds no value: the handle is what the schema
      // declares, and the handlers registered on its link are what an event
      // sent to it reaches.
      return createCell(
        runtime,
        { ...link, schema: resolvedSchema },
        tx,
        synced,
        "stream",
        cfcLabelView,
      );
    } else {
      const asCellEntry = asCellValues.at(0);
      const asCellKind = ContextualFlowControl.getAsCellKind(asCellEntry);
      if (asCellKind === undefined) {
        return undefined;
      }
      // If schema indicates this should be some sort of a cell
      // If the cell itself has a default value, make it its own (immutable)
      // doc, to emulate the behavior of .get() returning a different underlying
      // document when the value is changed. A classic example is
      // `currentlySelected` with a default of `null`.
      if (defaultValue === undefined && resolvedSchema.default !== undefined) {
        return runtime.getImmutableCell(
          link.space,
          resolvedSchema.default,
          resolvedSchema,
          tx,
          cfcLabelView,
        );
      } else {
        // This is a creation path (no default value to box): use the schema to
        // set the new cell's initial scope from the asCell entry.
        return createCell(
          runtime,
          {
            ...linkWithAsCellScope(link, asCellEntry),
            schema: mergeDefaults(resolvedSchema, defaultValue),
          },
          getTransactionForChildCells(tx),
          synced,
          asCellKind,
          cfcLabelView,
        );
      }
    }
  }

  // A `FabricPrimitive` default is an opaque leaf; return it as-is ahead of
  // the object-type rebuild below (it takes no back-to-cell annotation --
  // see `annotateWithBackToCellSymbols`).
  if (defaultValue instanceof FabricPrimitive) {
    return defaultValue;
  }
  // TODO(danfuzz): a `FabricInstance` default is not yet handled -- it needs
  // processing by its codec contents. Fail loudly until that exists.
  if (defaultValue instanceof FabricInstance) {
    throw new Error(
      `Cannot yet handle \`${defaultValue.constructor.name}\` (a ` +
        "`FabricInstance`) as a schema default.",
    );
  }

  // Handle object type defaults
  if (
    resolvedSchema?.type === "object" && isObjectNotArray(defaultValue)
  ) {
    const result: Record<string, any> = {};
    const processedKeys = new Set<string>();

    // Process properties defined in both the schema and default value
    if (resolvedSchema?.properties) {
      for (const key of Object.keys(resolvedSchema.properties)) {
        const rawPropSchema = ContextualFlowControl.schemaAtPath(
          resolvedSchema,
          [key],
        );
        const propSchema = (isObjectOrArray(rawPropSchema) &&
            typeof rawPropSchema.$ref === "string")
          ? ContextualFlowControl.resolveSchemaRefs(
            rawPropSchema,
            resolvedSchema,
          )
          : rawPropSchema;
        // `Object.hasOwn`, not `in`: `key` is a schema-declared property NAME,
        // and `defaultValue` is data. `in` walks the prototype chain, so a
        // schema property called `toString` or `valueOf` matched every object
        // and read back `Object.prototype`'s function instead of the default.
        if (Object.hasOwn(defaultValue, key)) {
          result[key] = processDefaultValue(
            runtime,
            tx,
            { ...link, schema: propSchema, path: [...link.path, key] },
            defaultValue[key as keyof typeof defaultValue],
            synced,
            rebaseCfcLabelView(cfcLabelView, [key]),
          );
          processedKeys.add(key);
        } else if (isObjectOrArray(propSchema)) {
          const asCellValues = ContextualFlowControl.getAsCellValues(
            propSchema,
          );
          if (asCellValues.length > 0) {
            // asCell are always created, it's their value that can be
            // `undefined` — and for a stream, is never anything else.
            result[key] = processDefaultValue(
              runtime,
              tx,
              { ...link, schema: propSchema, path: [...link.path, key] },
              undefined,
              synced,
              rebaseCfcLabelView(cfcLabelView, [key]),
            );
          } else if (propSchema.default !== undefined) {
            result[key] = processDefaultValue(
              runtime,
              tx,
              { ...link, schema: propSchema, path: [...link.path, key] },
              propSchema.default,
              synced,
              rebaseCfcLabelView(cfcLabelView, [key]),
            );
          } else if (
            resolvedSchema?.required?.includes(key) &&
            (propSchema.type === "object" || propSchema.type === "array")
          ) {
            result[key] = processDefaultValue(
              runtime,
              tx,
              { ...link, schema: propSchema, path: [...link.path, key] },
              propSchema.type === "object" ? {} : [],
              synced,
              rebaseCfcLabelView(cfcLabelView, [key]),
            );
          }
        }
      }
    }

    // Handle additional properties in the default value with additionalProperties schema
    if (resolvedSchema.additionalProperties) {
      const additionalPropertiesSchema =
        typeof resolvedSchema.additionalProperties === "object"
          ? resolvedSchema.additionalProperties
          : undefined;

      for (const key in defaultValue) {
        if (!processedKeys.has(key)) {
          processedKeys.add(key);
          result[key] = processDefaultValue(
            runtime,
            tx,
            {
              ...link,
              schema: additionalPropertiesSchema,
              path: [...link.path, key],
            },
            defaultValue[key as keyof typeof defaultValue],
            synced,
            rebaseCfcLabelView(cfcLabelView, [key]),
          );
        }
      }
    }

    return annotateWithBackToCellSymbols(
      result,
      runtime,
      link,
      tx,
      synced,
      cfcLabelView,
    );
  }

  // Handle array type defaults. A tuple slot (prefixItems[i]) covers its
  // exact index; `items` covers the indices past the slots (2020-12).
  // prefixItems-only schemas previously skipped this branch entirely, so
  // tuple defaults went unprocessed.
  if (
    resolvedSchema.type === "array" && Array.isArray(defaultValue) &&
    (resolvedSchema.items !== undefined ||
      Array.isArray(resolvedSchema.prefixItems))
  ) {
    const prefixItems = Array.isArray(resolvedSchema.prefixItems)
      ? resolvedSchema.prefixItems
      : undefined;
    const schemaForIndex = (i: number): JSONSchema => {
      const covering = prefixItems !== undefined && i < prefixItems.length
        ? prefixItems[i]
        : resolvedSchema.items;
      // An absent or `true` covering schema allows any item.
      if (covering === undefined || covering === true) return {};
      if ((covering as unknown) === false) {
        // `false` means no value allowed at this position. For default value
        // processing, we'll treat this as an error. (With prefixItems, an
        // `items: false` rest schema only conflicts when the default has
        // elements PAST the tuple slots.)
        throw new Error(
          "Array schema error: items: false conflicts with non-empty default\n" +
            "help: either allow items with valid schema, or use empty array default",
        );
      }
      // Thread the array schema's $defs so a $ref slot resolves during
      // recursive default processing (PR #4969 review).
      return cfcSchemaWithInheritedDefs(
        covering as JSONSchema,
        resolvedSchema.$defs,
      );
    };

    const result = defaultValue.map((item, i) =>
      processDefaultValue(
        runtime,
        tx,
        {
          ...link,
          schema: schemaForIndex(i),
          path: [...link.path, String(i)],
        },
        item,
        synced,
        rebaseCfcLabelView(cfcLabelView, [String(i)]),
      )
    );
    return annotateWithBackToCellSymbols(
      result,
      runtime,
      link,
      tx,
      synced,
      cfcLabelView,
    );
  }

  // For primitive types, return as is
  return annotateWithBackToCellSymbols(
    defaultValue,
    runtime,
    link,
    tx,
    synced,
    cfcLabelView,
  );
}

/** @internal Exported for testing only. */
export function mergeDefaults(
  schema: JSONSchema | undefined,
  defaultValue: Readonly<FabricValue>,
): JSONSchema {
  const base = isNontrivialSchema(schema) ? schema : {};

  // TODO(seefeld): What's the right thing to do for arrays?
  //
  // A `FabricPrimitive` default on either side takes the `defaultValue` arm:
  // it has no properties for the spread to copy, so merging one yields `{}`
  // and loses whichever side held the value. A `FabricInstance` default is
  // refused rather than merged.
  const mergedDefault = base.type === "object" &&
      isWalkableObjectOrArray(base.default) &&
      isWalkableObjectOrArray(defaultValue)
    ? { ...base.default, ...defaultValue } as JSONValue
    : defaultValue as JSONValue;

  return schemaWithProperties(base, { default: mergedDefault });
}

/**
 * This adds appropriate properties to a given `value` to give it an associated
 * cell, if possible. This only takes any action if `value` is an object type
 * and isn't itself a cell-related thing.
 *
 * If this function decides to add properties but `value` is either frozen (or
 * generally non-extensible) or already bound into some (other) context, then it
 * is first shallow-cloned. It is up to callers to ensure that mutable and
 * unbound `value`s are indeed appropriate to be mutated.
 */
export function annotateWithBackToCellSymbols(
  value: any,
  runtime: Runtime,
  link: NormalizedFullLink,
  tx: IExtendedStorageTransaction | undefined,
  synced = false,
  cfcLabelView?: CfcLabelView,
) {
  if (
    !isObjectOrArray(value) || isCell(value) ||
    value instanceof FabricPrimitive
  ) {
    // We only possibly annotate plain objects or arrays that _aren't_ cells.
    // A `FabricPrimitive` passes through untouched, exactly like a plain
    // `number` or `string` leaf.
    return value;
  }
  if (value instanceof FabricInstance) {
    // TODO(danfuzz): the back-to-cell story for a `FabricInstance` (which,
    // unlike a primitive, can have model-visible outgoing references) does
    // not exist yet. Fail loudly until it does.
    throw new Error(
      `Cannot yet handle \`${value.constructor.name}\` (a ` +
        "`FabricInstance`) in back-to-cell annotation.",
    );
  }

  const extensible = Object.isExtensible(value);
  if (!extensible || isCellResultForDereferencing(value)) {
    // We have to clone `value` to get a mutable top before attaching the
    // back-to-cell symbol. See function header comment for details.
    // `shallowMutableClone` deep-freezes the bound children as
    // inexpensive defense-in-depth; in practice the only trigger here is a
    // non-extensible (hence deep-frozen) value,
    // so the children are already deep-frozen and pass through by identity.
    value = shallowMutableClone(value as FabricValue);
  }

  // Non-enumerable, so that {...obj} won't copy these symbols
  Object.defineProperty(value, toCell, {
    // Use getTransactionForChildCells so that if this was called from sample(),
    // the resulting cell is still reactive
    value: () =>
      createCell(
        runtime,
        link,
        getTransactionForChildCells(tx),
        synced,
        undefined,
        cfcLabelView,
      ),
    enumerable: false,
  });

  Object.freeze(value);
  return value;
}

/**
 * Derive the label view for the dereferences made since `traceStart`.
 *
 * The derivation reads each involved document's `cfc` path. Those are
 * runtime-internal verifier reads — the runtime made them to check a label, not
 * the reader on its own behalf — and an eager read makes them once, for the
 * document it was handed, never for the documents its traversal reaches.
 *
 * A view re-enters here per property, so the same reads would land once per
 * child. They are kept out of the scheduler's view of what the ACTION read:
 * addresses the declared scope summary does not cover drop the action's
 * execution-context floor to `session`, which stops its observations being
 * adopted across users. The labels themselves are still derived and still
 * applied — CFC's own prepare pass reads the raw activity list and skips
 * internal verifier reads there regardless.
 */
function deriveDereferenceLabelView(
  tx: IExtendedStorageTransaction,
  traceStart: number,
  viewChild: boolean,
): CfcLabelView | undefined {
  const derive = () =>
    cfcLabelViewForDereferenceTraces(
      tx,
      tx.getCfcState().dereferenceTraces.slice(traceStart),
    );
  return viewChild
    ? tx.runWithAmbientReadMeta(ignoreReadForScheduling, derive)
    : derive();
}

/**
 * The value a resolved link points at, including the one address that is
 * computed rather than stored.
 *
 * A string's `length` is not a path the store holds. Traversal reads it off
 * the string it sits on (`getAtPath` in `traverse.ts`), so a link ending there
 * — `subject.key("label", "length")` where `label` is a string — resolves to
 * an address the store cannot serve, and a bare read of it yields `undefined`.
 * Reading it off the string applies traversal's rule where a link is
 * followed rather than where a value is walked, so both routes agree on what
 * `<string>/length` is worth. An array's `length` needs none of this; the store
 * reads that segment itself.
 *
 * The read of the string is the dependency: a string's length changes only when
 * the string is replaced, and it is replaced at the parent's own path.
 */
function readValueAtResolvedLink(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  address: IMemorySpaceValueAddress,
): FabricValue | undefined {
  // Read without telling the scheduler. Whatever materializes this value —
  // the traverser or a view — registers its own reads as it walks.
  const meta = {
    meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
  };
  const value = tx.readOrThrow(address, meta);
  if (value !== undefined || link.path.at(-1) !== "length") return value;
  const parentLink = { ...link, path: link.path.slice(0, -1) };
  const parent = tx.readOrThrow(toMemorySpaceAddress(parentLink), meta);
  // Register the parent read whichever way it turns out. A string's length
  // changes only when the string is replaced, which happens at the parent's own
  // path; and a parent that is not there yet — a computed that has not produced
  // — has to bring the reader back when it arrives. Non-recursive: nothing
  // below the parent decides this.
  tx.readValueOrThrow(parentLink, { nonRecursive: true });
  return typeof parent === "string" ? parent.length : value;
}

export interface ValidateAndTransformOptions {
  /** When true, also read into each Cell created for asCell fields to capture dependencies */
  traverseCells?: boolean;

  /** When true, cells created during traversal are marked as already synced */
  synced?: boolean;

  /**
   * Set by a schema view reading one of its children: a mismatch there is a
   * refusal the reader must be told about, not the `undefined` a root read
   * yields, which a reader cannot tell from an absent value.
   */
  mismatchThrows?: boolean;

  /**
   * Set by a schema view reading one of its children: this is a step inside a
   * read the entry point already began, so the entry-point-only work — the
   * stored CFC metadata probe — does not run again per property.
   */
  viewChild?: boolean;
}

export function validateAndTransform(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  sourceRef: NormalizedFullLink | CellViewRef,
  _seen?: Array<[string, any]>,
  options?: ValidateAndTransformOptions,
): any {
  // If the transaction is no longer open, read through the runtime's ambient
  // read path instead. Open transactions still take precedence so reads can see
  // their own uncommitted state.
  //
  // A transaction marked for lazy materialization is kept whatever its state:
  // a view reads the state ITS transaction saw, and swapping a finished one for
  // a fresh read would read newer state where the view's contract is to
  // refuse. The refusal comes from the marked transaction's own guard below.
  if (tx?.isLazyMaterialize() !== true) tx = runtime.readTx(tx);

  // Reconstruct doc, path, schema from link and runtime
  let link = isCellViewRef(sourceRef) ? sourceRef.link : sourceRef;
  const schema = link.schema;
  const resolvedSchema = resolveSchema(schema);
  let cfcLabelView = isCellViewRef(sourceRef)
    ? sourceRef.cfcLabelView
    : undefined;

  // For opaque cells, create the cell directly from the current link.
  // We intentionally avoid traversing redirect chains or reading through the
  // transaction, since opaque cells should preserve identity without materializing
  // the pointed-to value.
  const asCellValues = ContextualFlowControl.getAsCellValues(resolvedSchema);
  if (ContextualFlowControl.getAsCellKind(asCellValues.at(0)) === "opaque") {
    return new TransformObjectCreator(
      runtime,
      tx!,
      options?.synced ?? false,
      link,
      cfcLabelView,
    ).createObject(
      { ...link, schema: resolvedSchema },
      undefined,
    );
  }

  cfcLabelView = cloneCfcLabelView(cfcLabelView);

  // Follow aliases, etc. to last element on path + just aliases on that last one
  // When we generate cells below, we want them to be based off this value, as that
  // is what a setter would change when they update a value or reference.
  const writeRedirectTraceStart = tx.getCfcState().dereferenceTraces.length;
  // Read entry: opt into the crossing seam, so every labeled hop this
  // resolution crosses marks the transaction cfc-relevant (write-path
  // resolutions leave relevance to the write-policy gate).
  const resolvedLink = resolveLink(runtime, tx, link, "writeRedirect", {
    markIfcCrossings: true,
  });
  cfcLabelView = mergeCfcLabelViews([
    cfcLabelView,
    deriveDereferenceLabelView(
      tx,
      writeRedirectTraceStart,
      options?.viewChild === true,
    ),
  ]);

  const resolvedLinkSchema = resolveSchema(resolvedLink.schema);
  const effectiveSchema = resolvedSchema !== undefined
    ? resolvedLinkSchema !== undefined
      ? combineSchemaForLink(resolvedSchema, resolvedLinkSchema)
      : resolvedSchema
    : resolvedLinkSchema;
  const filteredSchema = filterAsCell(effectiveSchema);
  // The stored-metadata probe reads `<doc>/cfc`, and it belongs to the entry
  // point: an eager read runs it once for the document it was handed and never
  // for the documents its traversal reaches through links. A view re-enters
  // here for every property it resolves, so without this gate it probes every
  // linked document too — reads outside any declared scope envelope, which
  // drops the action's execution-context floor to `session` and stops its
  // observations being adopted across users. The schema checks cost no read
  // and stay. The link schema is consulted on its own because reader
  // precedence (`combineSchemaForLink`) keeps a shaped reader's combined
  // schema free of the link's `ifc` — the marking must not depend on which
  // side won the combination.
  if (
    schemaHasIfc(effectiveSchema) ||
    schemaHasIfc(resolvedLinkSchema) ||
    (options?.viewChild !== true &&
      storedCfcMetadataAppliesToPath(tx, resolvedLink))
  ) {
    tx.markCfcRelevant(`schema-ifc-read:${link.id}`);
  }

  // Unlike the original, we have kept the asCell markers in the schema
  link = {
    ...resolvedLink,
    ...(effectiveSchema !== undefined && { schema: effectiveSchema }),
  };
  // If we don't have a schema, and we aren't asCell/asStream, use a proxy
  if (
    (
      effectiveSchema === undefined ||
      !SchemaObjectTraverser.hasAsCell(effectiveSchema)
    ) &&
    filteredSchema === undefined
  ) {
    return createQueryResultProxy(runtime, tx, link, 0, cfcLabelView);
  }

  // Now resolve further links until we get the actual value.
  // We'll use this for the value, and potentially merge the schema
  // This gets me the result of following all the links, so I can get the value
  const valueTraceStart = tx.getCfcState().dereferenceTraces.length;
  const resolvedValueLink = resolveLink(runtime, tx, link, "value", {
    markIfcCrossings: true,
  });
  cfcLabelView = mergeCfcLabelViews([
    cfcLabelView,
    deriveDereferenceLabelView(
      tx,
      valueTraceStart,
      options?.viewChild === true,
    ),
  ]);
  // The write-redirect pass the gate above resolved cannot see a plain
  // value link at the entry path; the full resolution can. Same cheap
  // schema check, same marking — reader precedence keeps the crossing's
  // `ifc` off the combined schema, so the marking must not depend on it.
  if (schemaHasIfc(resolvedValueLink.schema)) {
    tx.markCfcRelevant(`schema-ifc-read:${link.id}`);
  }
  const objectCreator = new TransformObjectCreator(
    runtime,
    tx,
    options?.synced ?? false,
    resolvedValueLink,
    cfcLabelView,
  );

  // If our link is asCell/asStream, and we don't have any path portions, we
  // can just create the cell and mostly skip reading the value and traversal.
  if (SchemaObjectTraverser.hasAsCell(effectiveSchema)) {
    // We check for a link value, since we will follow links one step in get
    // We've already followed all the writeRedirect links above.
    const next = readMaybeLink(tx, link);
    if (next !== undefined) {
      if (readStatsActive) recordLinkResolution(tx);
      // This one-step hop bypasses resolveLink and the traversal, so it
      // carries the crossing seam itself (the schema.ts twin of
      // getNextCellLink).
      markIfcBearingLinkCrossing(tx, link.space, next.schema, next.id);
      // An asCell schema turns this link into a handle instead of following
      // it, so resolveLink's cap check never sees this hop. Apply it here too,
      // or reading THROUGH the handle escapes the cap the schema declared
      // (#5230).
      cfcLabelView = mergeCfcLabelViews([
        cfcLabelView,
        cfcLabelViewForDereference(
          tx,
          cfcAddressFromLink(link),
          cfcAddressFromLink(next),
        ),
      ]);
      // We leave the asCell/asStream in the schema, so that createObject
      // knows to create a cell
      const mergedSchema = (next.schema !== undefined)
        ? combineSchemaForLink(effectiveSchema!, next.schema)
        : effectiveSchema!;
      link = { ...next, schema: mergedSchema };
    }
    // The fully value-resolved link is the last crossing of the chain, so
    // its schema combines onto the result preserved above under the same
    // reader precedence as every other hop: an agnostic reader adopts the
    // final target's schema under its own asCell wrapper, a shaped reader
    // stands (inheriting only the crossing's `default`), and the handle
    // must never carry the link's wider schema past the reader's — a
    // stored `required` the reader did not ask for would void the read
    // through the handle. The result stays a cell (the reader's asCell
    // survives every arm); the effectiveSchema fallback guards the
    // combination ever losing it.
    if (resolvedValueLink.schema !== undefined) {
      const combined = combineSchemaForLink(
        link.schema ?? effectiveSchema!,
        resolvedValueLink.schema,
      );
      link.schema = SchemaObjectTraverser.hasAsCell(combined)
        ? combined
        : effectiveSchema!;
    }
    const handleSchema = resolveSchema(link.schema);
    const handleEntry = ContextualFlowControl.getAsCellValues(handleSchema)[0];
    if (
      isObjectOrArray(handleSchema) && handleSchema.default !== undefined &&
      isCellScope(ContextualFlowControl.getAsCellScope(handleEntry))
    ) {
      // Inspect the addressed slot before following its leaf reference: an
      // existing reference retains its target even when that target is absent.
      // This handle-only probe remains reactive to the slot's arrival.
      const absentSlot = tx.runWithAmbientReadMeta(
        excludeReadFromConflict,
        () => {
          let blocked = false;
          const sourceLink = isCellViewRef(sourceRef)
            ? sourceRef.link
            : sourceRef;
          const slot = resolveLink(runtime, tx, sourceLink, "top", {
            onScopeBlocked: () => {
              blocked = true;
            },
          });
          if (
            blocked || slot.pendingHopDoc || slot.id.startsWith("data:") ||
            tx.readValueOrThrow(slot, {
                nonRecursive: true,
                meta: linkResolutionProbe,
              }) !== undefined
          ) return false;
          const address = toMemorySpaceAddress(slot);
          const parent = tx.readOrThrow({
            ...address,
            path: address.path.slice(0, -1),
          }, { nonRecursive: true, meta: linkResolutionProbe });
          return !isObjectOrArray(parent) ||
            !Object.hasOwn(parent, address.path.at(-1)!);
        },
      );
      if (absentSlot) link = linkWithAsCellScope(link, handleEntry);
    }
    objectCreator.setBase(link, cfcLabelView);
    return objectCreator.createObject(link, undefined);
  }

  // Link paths don't include value, but doc address should
  const address: IMemorySpaceValueAddress = toMemorySpaceAddress(
    resolvedValueLink,
  );
  // Get the full value without telling the scheduler. The traverse method will
  // notify the scheduler for shallow reads as they occur.
  const value = readValueAtResolvedLink(tx, resolvedValueLink, address);
  const doc = { address, value: value };
  const valueSelectedSchema = isObjectOrArray(effectiveSchema)
    ? asCellCompoundSchemaForValue(effectiveSchema, value)
    : undefined;
  // If we have a ref with a schema, use that; otherwise, use the link's schema
  const selector = {
    path: doc.address.path,
    schema: valueSelectedSchema ?? resolvedValueLink.schema ?? link.schema!,
  };
  // A marked transaction takes the lazy route from here. Everything above has
  // run either way — link resolution, the `asCell` dispatch, schema
  // combination — so a view and an eager read start from the same link and the
  // same schema; only the materialization differs.
  //
  // A view describes the instant this read fixes, and goes on describing it
  // however the reader writes afterwards — which is what a reader iterating a
  // list while writing into it stands on, and what an eager read gives, since
  // an eager read hands back a value built before the write. Seeing its own
  // write means taking the read again.
  if (tx.isLazyMaterialize()) {
    // Crossing the last link is a hop the eager traverser combines schemas
    // across (`linkHopSelector`), because a link's own schema describes the
    // value at its target while the reader's schema describes what the reader
    // asked for, and both apply. A view re-enters here for that hop instead of
    // walking through it, so it has to do the same combining: the selector
    // alone is the link's schema, and a reader asking for a property the link's
    // schema does not name — `title` off a piece typed by its own
    // registration — would read as a property the schema does not select.
    const viewSchema = valueSelectedSchema ??
      combineOptionalSchema(effectiveSchema, resolvedValueLink.schema) ??
      selector.schema;
    // The RULED unresolved-input refusal (OW51, 2026-08-21): the walk
    // crossed a hop (or started from a data-derived handle) and
    // dead-ended at a doc this replica cannot serve (link-resolution's
    // `pendingHopDoc`), so nothing about the value — not even its
    // absence — is knowable yet. When the reader's schema DECLARES a
    // default, the view's absent-value arm stands that default in and
    // registers the read (the existing "computed that has not produced
    // yet" contract — schema-view.test.ts pins it); with NO default
    // there is nothing honest to hand the body: register the dead-end
    // doc's read FIRST (the dependency that re-triggers this reader
    // when the doc arrives; the address-level read survives the
    // NotFoundError `readValueOrThrow` swallows), then refuse. The
    // action-run boundary disposes the refusal as a non-event: output
    // `undefined`, no action failure, re-run on any registered read
    // change — instead of handing `undefined` into a body whose schema
    // promised a value (the OW51 splitDefinitions crash, browser and
    // serving runtime alike). Lazy-branch only: eager reads (bindings,
    // diffing, scheduler internals) keep today's behavior.
    if (
      resolvedValueLink.pendingHopDoc === true &&
      value === undefined &&
      defaultForAbsentValue(viewSchema) === undefined
    ) {
      tx.readValueOrThrow(resolvedValueLink);
      const refusal = new UnresolvedInputError(resolvedValueLink);
      tx.noteSchemaRefusal(refusal);
      throw refusal;
    }
    return materializeSchemaView(
      runtime,
      tx,
      { ...resolvedValueLink, schema: viewSchema },
      value,
      cfcLabelView,
      options?.synced ?? false,
      options?.mismatchThrows !== true,
    );
  }

  // TODO(@ubik2): these constructor parameters are complex enough that we should
  // use an options struct
  // The traversal's acting identity (key-vocabulary.md §1 sites 5-6): a
  // served run's DEMAND-SUPPLIED identity when the wave run context
  // carries one (M1's per-run threading, server-execution v2 Phase 2) —
  // or when the STORAGE transaction carries one (stage A: the event
  // preflight's dependency probe runs under the event's actor without a
  // wave stamp) — else the runtime's own session. `runIdentity` stays
  // undefined for an own-identity traversal, so its absent-target loads
  // take the ordinary path.
  const runIdentity =
    waveRunContextOf(tx as IExtendedStorageTransaction)?.scopeKeyIdentity ??
      (tx as IExtendedStorageTransaction).tx?.scopeKeyIdentity;
  const traverser = new SchemaObjectTraverser<any>(
    tx!,
    selector,
    createDefaultTraversalContext(
      runIdentity ?? runtime.scopeKeyIdentity,
      options?.traverseCells ?? false,
      undefined,
      // Absent link targets get an async load kicked (cross-space always;
      // same-space only when the replica has never seen the doc); the
      // tracked read re-runs the reader on arrival. A served per-instance
      // run's absent target loads AS that run's instance (stage A — the
      // runner's explicit-instance read).
      usesLocalReads(tx)
        ? undefined
        : (missing, sourceSpace) =>
          runtime.ensureLinkedDocLoaded(missing, sourceSpace, runIdentity),
    ),
    objectCreator,
  );
  const { ok: val, error: _err } = traverser.traverse(doc, link);
  // TODO(@ubik2): Now that undefined is a valid return value from traverse,
  // we need some other way to indicate success to our caller. For now, I'm
  // still just returning undefined in the error case.
  return val;
}

/**
 * Memo for `TransformObjectCreator.mergeMatches`' combined anyOf/allOf cell
 * schema, keyed per deep-frozen compound schema identity × the cell match's
 * (tiny) `asCell` values. `mergeMatches` runs once per matched anyOf cell on
 * the traverse path and the combined schema is deterministic from these two
 * inputs; without the memo every call rebuilds the (large) combined schema
 * and pays a full content hash to intern it onto the cell link. Mutable
 * compound schemas are never cached (in-place edits must be observed).
 * Module-level so the memo survives across traverser instances.
 */
const combinedCellSchemaCache = new WeakMap<
  JSONSchemaObj,
  Map<string, JSONSchema>
>();

/**
 * The value an opaque (`type: "unknown"`) position projects to when something
 * is there: an empty object carrying the back-to-cell annotation and the
 * marker that says it holds nothing of what it names. Both read paths mint it
 * here, so a reader cannot tell which one answered.
 */
export function createOpaqueReference(
  runtime: Runtime,
  link: NormalizedFullLink,
  tx: IExtendedStorageTransaction | undefined,
  synced: boolean,
  cfcLabelView: CfcLabelView | undefined,
): FabricValue {
  const value: Record<symbol, unknown> = {};
  // Non-enumerable, like the back-to-cell annotation beside it, so the marker
  // stays off `Object.keys` and out of a spread.
  Object.defineProperty(value, opaqueReference, {
    value: true,
    enumerable: false,
  });
  return annotateWithBackToCellSymbols(
    value,
    runtime,
    link,
    tx,
    synced,
    cfcLabelView,
  );
}

class TransformObjectCreator
  implements IObjectCreator<AnyCellWrapping<FabricValue>> {
  #runtime: Runtime;

  #tx: IExtendedStorageTransaction;

  #synced: boolean;
  #baseLink: NormalizedFullLink;
  #cfcLabelView: CfcLabelViewRebaser;

  constructor(
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    synced: boolean,
    baseLink: NormalizedFullLink,
    cfcLabelView: CfcLabelView | undefined,
  ) {
    this.#runtime = runtime;
    this.#tx = tx;
    this.#synced = synced;
    this.#baseLink = baseLink;
    this.#cfcLabelView = new CfcLabelViewRebaser(cfcLabelView);
  }

  setBase(
    baseLink: NormalizedFullLink,
    cfcLabelView: CfcLabelView | undefined,
  ): void {
    this.#baseLink = baseLink;
    this.#cfcLabelView.setView(cfcLabelView);
  }

  #labelViewFor(link: NormalizedFullLink): CfcLabelView | undefined {
    return labelViewForLink(this.#baseLink, this.#cfcLabelView, link);
  }

  /**
   * @param matches
   * @param schema An allOf or anyOf schema
   * @returns
   */
  mergeMatches<T>(
    matches: T[],
    schema: JSONSchemaObj,
  ): T | Record<string, T> | undefined {
    // These value objects should be merged. While this isn't JSONSchema
    // spec, when we have an anyOf with branches where name is set in one
    // schema, but the address is ignored, and a second option where
    // address is set, and name is ignored, we want to include both.
    if (matches.length > 1) {
      // If more than one match, but we have a cell, return that
      // If we tried to combine the objects, the result would not be a cell
      // anymore.
      const cellMatch = matches.find((v) => isCell(v));
      if (cellMatch !== undefined) {
        // At least one match is a cell. If they are all cells, we should be
        // able to combine them. If some are not, we could alter our schema on
        // the cell to include the anyOf. Since that's already a cell, we want
        // to remove the first "cell" entry from the asCell array.
        // I'm not going to fully support legacy streams here, since this is
        // already a super edge case.
        if (schema.asCell !== undefined) {
          // Use the asCell from the anyOf/allOf schema
          // This code isn't typically reached, since a cell with an asCell
          // schema will have just removed one level from asCell and returned
          // that instead. However, I include it here for completeness.
          const unwrappedSchema = unwrapAsCellSchema(schema);
          return cellMatch.asSchema(unwrappedSchema) as any;
        } else {
          // at least one of the entries should have had an asCell or we
          // wouldn't have a cell. We will use the asCell used for creating
          // this cell, but change the rest of the schema to be the logical
          // combination schema.
          const asCellValues = ContextualFlowControl.getAsCellValues(
            cellMatch.schema,
          );
          const cacheKey = isDeepFrozen(schema)
            ? JSON.stringify(asCellValues)
            : undefined;
          if (cacheKey !== undefined) {
            const cached = combinedCellSchemaCache.get(schema)?.get(cacheKey);
            if (cached !== undefined) return cellMatch.asSchema(cached) as any;
          }
          const allOfItems = (schema.allOf ?? []).map(removeAsCellFromSchema);
          const anyOfItems = (schema.anyOf ?? []).map(removeAsCellFromSchema);
          // Intern here so the memo holds the canonical instance and the
          // `asSchema` interning below is an identity cache hit.
          const combinedSchema = internSchema({
            ...schema,
            ...(allOfItems.length > 0) && { allOf: allOfItems },
            ...(anyOfItems.length > 0) && { anyOf: anyOfItems },
            ...(asCellValues.length > 0) && { asCell: asCellValues },
          });
          if (cacheKey !== undefined) {
            let byKey = combinedCellSchemaCache.get(schema);
            if (byKey === undefined) {
              byKey = new Map();
              combinedCellSchemaCache.set(schema, byKey);
            }
            byKey.set(cacheKey, combinedSchema);
          }
          return cellMatch.asSchema(combinedSchema) as any;
        }
      }
    }
    return mergeAnyOfMatches(matches);
  }

  /**
   * Does nothing: when `properties` is specified but `additionalProperties` is
   * not, a property outside the map is excluded rather than stored.
   */
  addOptionalProperty(
    _obj: Record<string, FabricValue>,
    _key: string,
    _value: FabricValue,
  ) {
    // We want to exclude properties when we have a properties map provided
    // in the schema, but it doesn't include our property, and we don't have
    // additionalProperties set. So we don't do `obj[key] = value`;
  }

  applyDefault<T>(
    link: NormalizedFullLink,
    value: T | undefined,
  ): T | undefined {
    return processDefaultValue(
      this.#runtime,
      this.#tx,
      link,
      value,
      this.#synced,
      this.#labelViewFor(link),
    );
  }

  /**
   * An opaque (`type: "unknown"`) position that holds something projects to an
   * empty object carrying the back-to-cell annotation. That is the whole
   * contract: it is truthy, it compares by identity through `equals()`, and
   * writing it back stores a link to the same document. It carries no
   * properties, so a reader that probes it learns nothing about the target
   * beyond its existence — which is what `unknown` declares.
   *
   * An empty object rather than a fresh symbol only because the back-to-cell
   * annotation is carried as a property and a symbol cannot hold one; see the
   * TODO on `toCell`.
   */
  createOpaquePresence(
    link: NormalizedFullLink,
  ): AnyCellWrapping<FabricValue> {
    return createOpaqueReference(
      this.#runtime,
      link,
      this.#tx,
      this.#synced,
      this.#labelViewFor(link),
    ) as AnyCellWrapping<FabricValue>;
  }

  /**
   * Plain-schema traversal has already ruled out asCell and default keywords,
   * so only attach the ordinary back-to-cell annotation here. Keeping this
   * beside createObject() makes the skipped semantics explicit and leaves the
   * generic path unchanged for every richer schema.
   */
  createPlainSchemaObject(
    link: NormalizedFullLink,
    value: AnyCellWrapping<FabricValue> | undefined,
  ): AnyCellWrapping<FabricValue> {
    return annotateWithBackToCellSymbols(
      value,
      this.#runtime,
      link,
      this.#tx,
      this.#synced,
      this.#labelViewFor(link),
    );
  }

  /**
   * Creates the object. This is an early pass to see if we should just create a
   * proxy or cell; if not, we actually resolve our links to get to our values.
   */
  createObject(
    link: NormalizedFullLink,
    value: AnyCellWrapping<FabricValue> | undefined,
  ): AnyCellWrapping<FabricValue> {
    // If we have a schema with an asCell or asStream (or if our anyOf values
    // do), we should create a cell here.
    // If we don't have a schema, or a true schema, we should create a query result proxy.
    // If we have a schema without asCell or asStream, we should annotate the
    // object so we can get back to the cell if needed.
    if (link.schema === undefined || link.schema === true) {
      return createQueryResultProxy(
        this.#runtime,
        this.#tx,
        link,
        0,
        this.#labelViewFor(link),
      );
    } else if (isObjectOrArray(link.schema)) {
      // A reference-form schema resolves here — materialization is a
      // structural use (asCell handles, defaults), and the handle minted
      // below works over the resolved document. The link itself keeps its
      // reference; an unresolvable one behaves as the schemaless
      // degradation (a plain proxy read, no handle, no defaults).
      const structuralSchema = isObjectNotArray(link.schema)
        ? resolveExternalRootRefForStructure(link.schema)
        : link.schema;
      const schema = asCellCompoundSchemaForValue(structuralSchema, value) ??
        structuralSchema;
      const asCellValues = ContextualFlowControl.getAsCellValues(schema);
      if (asCellValues.length > 0) {
        // We'll use the first asCell for the outermost, and pass the rest
        // in with the schema for the created cell.
        const asCellEntry = asCellValues[0];
        const cellKind = ContextualFlowControl.getAsCellKind(asCellEntry);
        if (cellKind === undefined) {
          return undefined;
        }
        // This is a read/materialization path: keep the link's own
        // storage-resolved scope. The asCell entry scope is honored as a
        // follow cap during link resolution, never copied onto the link here
        // (doing so would re-address the value to a different scoped instance).
        //
        // Minting a handle is the one place a link is NOT followed, so
        // resolveLink's cap check never sees this hop -- and the holder reads
        // through the handle later, which is exactly the follow the cap bounds
        // (#5230). Every route that produces a handle lands here, including
        // the compound anyOf/oneOf shape `getSchemaScopeCap` cannot see, so
        // this is the one place the check belongs.
        const followCap = ContextualFlowControl.getAsCellFollowScopeCap(schema);
        const handleLink = canFollowScopedLink(followCap, link.scope)
          ? link
          : blockedHandleLink(link, followCap);
        return createCell(
          this.#runtime,
          {
            ...handleLink,
            schema: unwrapAsCellSchema(schema as JSONSchemaObj),
          },
          getTransactionForChildCells(this.#tx),
          this.#synced,
          cellKind,
          this.#labelViewFor(link),
        ) as AnyCellWrapping<FabricValue>;
      }
      // If it's not a cell/stream, but the schema is true-ish, use a
      // QueryResultProxy
      if (ContextualFlowControl.isTrueSchema(schema)) {
        return createQueryResultProxy(
          this.#runtime,
          this.#tx,
          link,
          0,
          this.#labelViewFor(link),
        );
      }
      // link.schema is not true, and not asCell/asStream
      // If we're undefined, check for a default and apply that
      if (schema.default !== undefined && value === undefined) {
        // processDefaultValue already annotates with back to cell
        return processDefaultValue(
          this.#runtime,
          this.#tx,
          link,
          schema.default,
          this.#synced,
          this.#labelViewFor(link),
        );
      }
      // If we're an object, we may be missing some properties that have a
      // default.
      if (
        isObjectNotArray(value) &&
        schema.properties !== undefined
      ) {
        // Ensure value is mutable before injecting default properties.
        // cloneIfNecessary with { deep: false, frozen: false, force: false }
        // is a no-op for unfrozen objects and shallow-clones frozen ones.
        value = cloneIfNecessary(value, {
          deep: false,
          frozen: false,
          force: false,
        }) as typeof value;
        const propertyEntries = Object.entries(schema.properties) as [
          string,
          JSONSchema,
        ][];
        for (const [propName, propSchema] of propertyEntries) {
          if (isObjectOrArray(propSchema) && propSchema.default !== undefined) {
            const valueObj = value as Record<string, any>;
            if (valueObj[propName] === undefined) {
              valueObj[propName] = processDefaultValue(
                this.#runtime,
                this.#tx,
                {
                  ...link,
                  path: [...link.path, propName],
                  schema: propSchema,
                },
                undefined,
                this.#synced,
                rebaseCfcLabelView(this.#labelViewFor(link), [propName]),
              );
            }
          }
        }
      }
      // TODO(@ubik2): What if we're an array? Is it possible to have undefined
      // elements in our array?
    }
    return annotateWithBackToCellSymbols(
      value,
      this.#runtime,
      link,
      this.#tx,
      this.#synced,
      this.#labelViewFor(link),
    );
  }
}

/**
 * This assumes that there will not be a conflict in definitions between the
 * eventSchema and the stateSchema.
 */
export function generateHandlerSchema(
  eventSchema?: JSONSchema,
  stateSchema?: JSONSchema,
): JSONSchema | undefined {
  // TODO(@ubik2): We also need to re-write any relative refs
  if (eventSchema === undefined && stateSchema === undefined) {
    return undefined;
  }
  const mergedDefs: Record<string, JSONSchema> = {};
  const mergedDefinitions: Record<string, JSONSchema> = {};
  if (isObjectOrArray(eventSchema)) {
    // extract $defs and definitions and remove them from eventSchema
    const { $defs, definitions, ...rest } = eventSchema;
    eventSchema = rest;
    Object.assign(mergedDefs, $defs);
    Object.assign(mergedDefinitions, definitions);
  }
  if (isObjectOrArray(stateSchema)) {
    // extract $defs and definitions and remove them from stateSchema
    const { $defs, definitions, ...rest } = stateSchema;
    stateSchema = rest;
    Object.assign(mergedDefs, $defs);
    Object.assign(mergedDefinitions, definitions);
  }
  return internSchema({
    type: "object",
    properties: {
      "$event": eventSchema ?? true,
      "$ctx": stateSchema ?? true,
    },
    required: ["$ctx"],
    ...(Object.keys(mergedDefs).length && { $defs: mergedDefs }),
    ...(Object.keys(mergedDefinitions).length &&
      { definitions: mergedDefinitions }),
  });
}

// unwrapAsCellSchema results per deep-frozen schema identity. The unwrapped
// schema rides on every created child cell's link, where downstream identity
// caches (link-resolution interning, schemaAtPath, value hashing) key on it —
// a fresh spread per cell creation re-hashed the whole schema each time.
const unwrappedAsCellSchemaCache = new WeakMap<JSONSchemaObj, JSONSchemaObj>();

function unwrapAsCellSchema(schema: JSONSchemaObj): JSONSchemaObj {
  const cacheable = isDeepFrozen(schema);
  if (cacheable) {
    const cached = unwrappedAsCellSchemaCache.get(schema);
    if (cached !== undefined) {
      return cached;
    }
  }
  const { asCell: _c, ...restSchema } = schema;
  const asCellValues = ContextualFlowControl.getAsCellValues(schema);
  // Intern so the result is the canonical frozen instance: child cell links
  // then carry an identity-stable schema across repeat materializations.
  const result = internSchema({
    ...restSchema,
    ...(asCellValues.length > 1 && { asCell: asCellValues.slice(1) }),
  });
  if (cacheable) {
    unwrappedAsCellSchemaCache.set(schema, result);
  }
  return result;
}

function removeAsCellFromSchema(schema: JSONSchema): JSONSchema {
  if (isObjectOrArray(schema)) {
    const { asCell: _c, ...restSchema } = schema;
    return restSchema;
  }
  return schema;
}
