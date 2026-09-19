import {
  fabricAwareEqual,
  type FabricValue,
  isFabricPlainObject,
  isValidFabricPlainObject,
  isWalkableObjectOrArray,
  shallowMutableClone,
} from "@commonfabric/data-model";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { internSchema } from "@commonfabric/data-model-schema";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  isModule,
  type JSONSchema,
  type Module,
  type Pattern,
} from "./builder/types.ts";
import { isCell, isStream } from "./cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { isCellLink } from "./link-utils.ts";
import { isFabricInstanceOrView } from "./query-result-proxy.ts";
import { type SigilLink, type URI } from "./sigil-types.ts";
import {
  cfcSchemaResolvedRoot,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
} from "./cfc/schema-refs.ts";
import { validateSchemaValue } from "./cfc/schema-sanitization.ts";
import {
  hasOwnEnumerableDataProperty,
  isAsCellEntryArray,
  isCellKind,
  isSchemaScope,
} from "./scope.ts";

/**
 * Whether a merged result is equivalent to the value it was built from, for
 * the four decisions in this file that return the original value when it is.
 *
 * A value this cannot read compares unequal, so the merged snapshot is kept.
 * `mergeSchemaDefaults()` walks values that are only partly materialized: a
 * retained descendant may be a getter that throws rather than answering, and
 * the walk `fabricAwareEqual()` falls back to reads by property. The
 * comparison is an optimization -- it decides whether to hand back the
 * original object rather than the copy -- so a value it cannot read costs a
 * copy rather than an answer.
 */
function mergedValueEquals(left: unknown, right: unknown): boolean {
  try {
    return fabricAwareEqual(left, right);
  } catch {
    return false;
  }
}

type ActiveDefaultMergePairs = WeakMap<
  object,
  WeakMap<object, WeakSet<object>>
>;

/** Completed result, including a result whose value is `undefined`. */
interface DefaultMergeResult {
  /** Value after applying the requested defaults. */
  value: unknown;
}

/** Per-call state for reusing defaults and completed graph merges. */
interface DefaultMergeContext {
  /** Value, schema root, and schema combinations currently being merged. */
  activePairs: ActiveDefaultMergePairs;

  /** Completed results keyed by value, root, schema, and supplied defaults. */
  results: WeakMap<
    object,
    WeakMap<object, WeakMap<object, Map<unknown, DefaultMergeResult>>>
  >;

  /** Extracted defaults keyed by their schema root and schema. */
  defaults: Map<JSONSchema, Map<JSONSchema, { value: FabricValue }>>;

  /** Number of active back edges encountered during this merge. */
  cycleVersion: number;
}

/** Returns an empty cache owned by a single default merge. */
function createDefaultMergeContext(): DefaultMergeContext {
  return {
    activePairs: new WeakMap(),
    results: new WeakMap(),
    defaults: new Map(),
    cycleVersion: 0,
  };
}

/** Returns canonical default extraction reused within one merge. */
function defaultValuesForMerge(
  schema: JSONSchema,
  root: JSONSchema,
  context: DefaultMergeContext,
): FabricValue {
  const canonicalSchema = internSchema(schema);
  const canonicalRoot = internSchema(root);
  let bySchema = context.defaults.get(canonicalRoot);
  if (bySchema === undefined) {
    bySchema = new Map();
    context.defaults.set(canonicalRoot, bySchema);
  }
  const cached = bySchema.get(canonicalSchema);
  if (cached !== undefined) return cached.value;
  const value = extractDefaultValues(canonicalSchema, canonicalRoot);
  bySchema.set(canonicalSchema, { value });
  return value;
}

const mergeDefaultCandidateObjects = (
  earlier: Record<string, FabricValue>,
  later: Record<string, FabricValue>,
): Record<string, FabricValue> => {
  const result: Record<string, FabricValue> = {};
  for (const key of new Set([...Object.keys(earlier), ...Object.keys(later)])) {
    const hasEarlier = Object.hasOwn(earlier, key);
    const hasLater = Object.hasOwn(later, key);
    const earlierValue = earlier[key];
    const laterValue = later[key];
    const value = hasEarlier && hasLater &&
        isFabricPlainObject(earlierValue) && !isCellLink(earlierValue) &&
        isFabricPlainObject(laterValue) && !isCellLink(laterValue)
      ? mergeDefaultCandidateObjects(earlierValue, laterValue)
      : hasEarlier
      ? earlierValue
      : laterValue;
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
};

/** Whether an opaque Cell materialization matches this schema's wrapper. */
export const schemaAcceptsOpaqueCellValue = (
  value: unknown,
  schema: JSONSchema,
): boolean => {
  if (!isCell(value)) return false;
  if (
    !isObjectOrArray(schema) ||
    !hasOwnEnumerableDataProperty(schema, "asCell") ||
    !isAsCellEntryArray(schema.asCell)
  ) {
    return false;
  }
  if ("scope" in schema) {
    if (!hasOwnEnumerableDataProperty(schema, "scope")) return false;
    if (schema.scope !== undefined && !isSchemaScope(schema.scope)) {
      return false;
    }
  }
  const expectedKind = ContextualFlowControl.getAsCellKind(
    schema.asCell.at(0),
  );
  return isCellKind(expectedKind) &&
    (expectedKind === "stream") === isStream(value);
};

export function setRunnableName<T extends object & { src?: string }>(
  target: T,
  name: string,
  options: { setSrc?: boolean } = {},
): void {
  Object.defineProperty(target, "name", {
    value: name,
    configurable: true,
  });

  if (options.setSrc) {
    target.src = name;
  }
}

export function sanitizeDebugLabel(label?: string): string | undefined {
  if (!label) return undefined;
  return label.replace(/^async\s+/, "").trim() || undefined;
}

export function getSigilLink(id: URI): SigilLink {
  return linkRefFrom({ id });
}

export function describePatternOrModule(
  patternOrModule: Pattern | Module | undefined,
): string {
  if (!patternOrModule) return "undefined";
  if (isModule(patternOrModule)) {
    if (
      patternOrModule.type === "ref" &&
      typeof patternOrModule.implementation === "string"
    ) {
      return `module:ref:${patternOrModule.implementation}`;
    }

    if (typeof patternOrModule.implementation === "function") {
      const impl = patternOrModule.implementation as {
        debugName?: string;
        src?: string;
        name?: string;
      };
      const name = sanitizeDebugLabel(impl.debugName) ??
        sanitizeDebugLabel(impl.src) ??
        sanitizeDebugLabel(impl.name) ??
        "anonymous";
      return `module:${patternOrModule.type}:${name}`;
    }

    return `module:${patternOrModule.type}`;
  }

  return `pattern:nodes=${patternOrModule.nodes.length}`;
}

/**
 * Extracts default values from a JSON schema object.
 * @param schema - The JSON schema to extract defaults from
 * @returns An object containing the default values, or undefined if none found
 */
export function extractDefaultValues(
  schema: JSONSchema,
  fullSchema: JSONSchema = schema,
): FabricValue {
  const extracted = extractDefaultValuesInternal(
    schema,
    fullSchema,
    new WeakMap(),
  );
  return extracted === NO_SCHEMA_DEFAULT ? undefined : extracted;
}

/** Whether extraction found a default, including an explicit `undefined`. */
export function schemaHasDefaultValue(
  schema: JSONSchema,
  fullSchema: JSONSchema = schema,
): boolean {
  return extractDefaultValuesInternal(schema, fullSchema, new WeakMap()) !==
    NO_SCHEMA_DEFAULT;
}

const NO_SCHEMA_DEFAULT = Symbol("no-schema-default");

function extractDefaultValuesInternal(
  schema: JSONSchema,
  fullSchema: JSONSchema,
  activeSchemasByRoot: WeakMap<object, WeakSet<object>>,
): FabricValue | typeof NO_SCHEMA_DEFAULT {
  if (!isObjectOrArray(schema)) {
    return NO_SCHEMA_DEFAULT;
  }

  const schemaRoot = fullSchema;
  const resolved = schema.$ref
    ? resolveCfcSchemaRefs(schema, schemaRoot)
    : schema;
  if (!isObjectOrArray(resolved)) {
    return NO_SCHEMA_DEFAULT;
  }
  const resolvedRoot = schema.$ref
    ? cfcSchemaResolvedRoot(
      resolved,
      resolveCfcSchemaRefRoot(schema, schemaRoot),
    )
    : schemaRoot;

  const canonical = internSchema(resolved);
  const rootKey = isObjectOrArray(resolvedRoot) ? resolvedRoot : canonical;
  let activeSchemas = activeSchemasByRoot.get(rootKey);
  if (activeSchemas?.has(canonical)) return NO_SCHEMA_DEFAULT;
  if (!activeSchemas) {
    activeSchemas = new WeakSet();
    activeSchemasByRoot.set(rootKey, activeSchemas);
  }
  activeSchemas.add(canonical);

  try {
    const unionConstraints = [canonical.anyOf, canonical.oneOf].filter(
      (branches): branches is JSONSchema[] => Array.isArray(branches),
    );
    if (unionConstraints.length > 0) {
      if (Object.hasOwn(canonical, "default")) {
        return validateSchemaValue(
            canonical,
            canonical.default,
            resolvedRoot,
          ) === undefined
          ? canonical.default
          : NO_SCHEMA_DEFAULT;
      }

      const {
        anyOf: _anyOf,
        oneOf: _oneOf,
        default: _default,
        ...baseSchema
      } = canonical;
      type DefaultCandidate = {
        value: FabricValue | typeof NO_SCHEMA_DEFAULT;
        selectedBranches: JSONSchema[];
      };
      let candidates: DefaultCandidate[] = [{
        value: extractDefaultValuesInternal(
          baseSchema,
          resolvedRoot,
          activeSchemasByRoot,
        ),
        selectedBranches: [],
      }];
      for (const branches of unionConstraints) {
        const expanded: DefaultCandidate[] = [];
        for (const candidate of candidates) {
          for (const branch of branches) {
            const branchDefault = extractDefaultValuesInternal(
              branch,
              resolvedRoot,
              activeSchemasByRoot,
            );
            let value = candidate.value;
            if (value === NO_SCHEMA_DEFAULT) {
              value = branchDefault;
            } else if (
              branchDefault !== NO_SCHEMA_DEFAULT &&
              isFabricPlainObject(value) && !isCellLink(value) &&
              isFabricPlainObject(branchDefault) &&
              !isCellLink(branchDefault)
            ) {
              value = mergeDefaultCandidateObjects(value, branchDefault);
            }
            expanded.push({
              value,
              selectedBranches: [...candidate.selectedBranches, branch],
            });
          }
        }
        candidates = expanded;
      }
      const validCandidates = candidates.filter((candidate) =>
        candidate.value !== NO_SCHEMA_DEFAULT &&
        candidate.selectedBranches.every((branch) =>
          validateSchemaValue(branch, candidate.value, resolvedRoot) ===
            undefined
        ) &&
        validateSchemaValue(canonical, candidate.value, resolvedRoot) ===
          undefined
      ).map((candidate) => candidate.value);
      return validCandidates.length > 0 &&
          validCandidates.every((candidate) =>
            mergedValueEquals(candidate, validCandidates[0])
          )
        ? validCandidates[0]
        : NO_SCHEMA_DEFAULT;
    }

    if (
      (canonical.type === "object" ||
        Array.isArray(canonical.type) && canonical.type.includes("object")) &&
      canonical.properties &&
      isObjectOrArray(canonical.properties)
    ) {
      // A fabric-valued default takes this return alongside the scalars: it
      // carries no properties for the assembly below to build on, and is
      // already the whole of what the schema declares.
      if (
        Object.hasOwn(canonical, "default") &&
        !isWalkableObjectOrArray(canonical.default)
      ) {
        return canonical.default;
      }
      const hasObjectDefault = Object.hasOwn(canonical, "default") &&
        isWalkableObjectOrArray(canonical.default);
      // Mutable top-level copy of the schema default, so injecting top-level
      // property defaults below doesn't mutate the schema's own default object.
      // Only top-level keys are written here, and the result is normalized
      // downstream by `fabricFromConvertibleJsValue` (which rebuilds a fresh
      // tree), so a shallow copy would suffice for correctness; we deep-freeze
      // the bound children as inexpensive defense-in-depth against accidental
      // deeper mutation of the shared default.
      const obj = shallowMutableClone(
        isWalkableObjectOrArray(canonical.default) ? canonical.default : {},
      ) as Record<string, FabricValue>;
      for (
        const [propKey, propSchema] of Object.entries(canonical.properties)
      ) {
        const value = extractDefaultValuesInternal(
          propSchema,
          resolvedRoot,
          activeSchemasByRoot,
        );
        if (value !== NO_SCHEMA_DEFAULT) {
          obj[propKey] = value;
        }
      }

      // Freeze the assembled defaults. Safe (consumers only read the result) and
      // nearly free, and it feeds the system's deep-freeze discipline: this
      // function is recursive, so the per-level freeze composes into a
      // deep-frozen result wherever the schema's own defaults are already frozen
      // -- which a downstream `cloneIfNecessary(_, { frozen: true })` can then
      // reuse by identity instead of re-cloning.
      return Object.keys(obj).length > 0 || hasObjectDefault
        ? Object.freeze(obj)
        : NO_SCHEMA_DEFAULT;
    }

    return Object.hasOwn(canonical, "default")
      ? canonical.default
      : NO_SCHEMA_DEFAULT;
  } finally {
    activeSchemas.delete(canonical);
  }
}

/**
 * Merges objects into a single object, preferring values from later objects.
 * Recursively calls itself for nested objects, passing on any objects that
 * matching properties.
 * @param objects - Objects to merge
 * @returns A merged object, or undefined if no objects provided
 */
export function mergeObjects<T>(
  ...objects: (Partial<T> | undefined)[]
): T {
  objects = objects.filter((obj) => obj !== undefined);
  if (objects.length === 0) return {} as T;
  if (objects.length === 1) return objects[0] as T;

  const seen = new Set<PropertyKey>();
  const result: Record<string, unknown> = {};

  for (const obj of objects) {
    if (!isObjectNotArray(obj) || isCellLink(obj)) {
      return obj as T;
    }

    for (const key of Object.keys(obj)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const merged = mergeObjects<T[keyof T]>(
        ...objects.map((entry) =>
          isObjectOrArray(entry) && Object.hasOwn(entry, key)
            ? (entry as Record<string, unknown>)[key] as T[keyof T]
            : undefined
        ),
      );
      if (merged !== undefined) {
        Object.defineProperty(result, key, {
          value: merged,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  }

  return result as T;
}

/**
 * Fold the slots a stored argument holds into the argument a caller supplied,
 * so a write of the result leaves untouched every top-level slot the caller
 * did not name. A supplied slot wins over the stored one at every key it
 * carries, including a key it carries as `undefined`.
 *
 * Both operands must be plain records for there to be slots to fold; anything
 * else (a scalar, an array, a link) is a whole value, and the supplied one
 * stands as it is.
 */
export function foldStoredArgumentSlots<T>(
  supplied: T,
  stored: unknown,
): T {
  if (
    !isFabricPlainObject(supplied as FabricValue) || isCellLink(supplied) ||
    !isFabricPlainObject(stored as FabricValue) || isCellLink(stored)
  ) {
    return supplied;
  }
  return { ...stored as object, ...supplied as object } as T;
}

/**
 * Merge schema defaults into an existing argument while avoiding optional
 * object defaults that would create an invalid partial value on their own.
 * Reuses completed merges of shared acyclic values under the same contract
 * and defaults. Cyclic merges retain active-path semantics, so results that
 * depend on a back edge are not reused on other paths.
 */
export function mergeSchemaDefaults<T>(
  value: T | undefined,
  defaults: unknown,
  schema: JSONSchema,
  options: {
    mergeMaterializedLinks?: boolean;
    valuePresent?: boolean;
    acceptOpaqueValue?: (
      value: unknown,
      schema: JSONSchema,
      fullSchema: JSONSchema,
    ) => boolean;

    /** Disambiguate otherwise-valid top-level union default candidates. */
    acceptUnionCandidate?: (candidate: unknown) => boolean;
  } = {},
): T {
  return mergeSchemaDefaultsInternal(
    value,
    defaults,
    schema,
    schema,
    options.valuePresent ?? value !== undefined,
    options.mergeMaterializedLinks === true,
    options.acceptOpaqueValue,
    options.acceptUnionCandidate,
    createDefaultMergeContext(),
  ) as T;
}

/** Reuses completed merges of the same value, contract, and defaults. */
function mergeSchemaDefaultsInternal(
  value: unknown,
  defaults: unknown,
  schema: JSONSchema,
  fullSchema: JSONSchema,
  valuePresent: boolean,
  mergeMaterializedLinks: boolean,
  acceptOpaqueValue:
    | ((value: unknown, schema: JSONSchema, fullSchema: JSONSchema) => boolean)
    | undefined,
  acceptUnionCandidate: ((candidate: unknown) => boolean) | undefined,
  context: DefaultMergeContext,
): unknown {
  let byDefaults: Map<unknown, DefaultMergeResult> | undefined;
  if (
    valuePresent && isObjectOrArray(value) &&
    isObjectOrArray(schema) &&
    acceptUnionCandidate === undefined
  ) {
    const canonicalSchema = internSchema(schema);
    const canonicalRoot = isObjectOrArray(fullSchema)
      ? internSchema(fullSchema)
      : canonicalSchema;
    let byRoot = context.results.get(value);
    if (byRoot === undefined) {
      byRoot = new WeakMap();
      context.results.set(value, byRoot);
    }
    let bySchema = byRoot.get(canonicalRoot);
    if (bySchema === undefined) {
      bySchema = new WeakMap();
      byRoot.set(canonicalRoot, bySchema);
    }
    byDefaults = bySchema.get(canonicalSchema);
    if (byDefaults === undefined) {
      byDefaults = new Map();
      bySchema.set(canonicalSchema, byDefaults);
    }
    const cached = byDefaults.get(defaults);
    if (cached !== undefined) return cached.value;
  }

  const cycleVersion = context.cycleVersion;
  const result = mergeSchemaDefaultsUncached(
    value,
    defaults,
    schema,
    fullSchema,
    valuePresent,
    mergeMaterializedLinks,
    acceptOpaqueValue,
    acceptUnionCandidate,
    context,
  );
  // A back edge returns an ancestor's original value while that ancestor is
  // still being merged. Such a result depends on the active path and cannot
  // serve as a completed result for a different path through the graph.
  if (cycleVersion === context.cycleVersion) {
    byDefaults?.set(defaults, { value: result });
  }
  return result;
}

/** Applies defaults with active-path cycle detection. */
function mergeSchemaDefaultsUncached(
  value: unknown,
  defaults: unknown,
  schema: JSONSchema,
  fullSchema: JSONSchema,
  valuePresent: boolean,
  mergeMaterializedLinks: boolean,
  acceptOpaqueValue:
    | ((
      value: unknown,
      schema: JSONSchema,
      fullSchema: JSONSchema,
    ) => boolean)
    | undefined,
  acceptUnionCandidate: ((candidate: unknown) => boolean) | undefined,
  context: DefaultMergeContext,
): unknown {
  const schemaRoot = fullSchema;
  const resolved = isObjectOrArray(schema) && schema.$ref
    ? resolveCfcSchemaRefs(schema, schemaRoot)
    : schema;
  const resolvedRoot = isObjectOrArray(schema) && schema.$ref
    ? cfcSchemaResolvedRoot(
      resolved ?? schema,
      resolveCfcSchemaRefRoot(schema, schemaRoot),
    )
    : schemaRoot;

  const trackedValue = valuePresent && isObjectOrArray(value)
    ? value as object
    : undefined;
  const trackedSchema = isObjectOrArray(resolved)
    ? internSchema(resolved)
    : undefined;
  const trackedRoot = isObjectOrArray(resolvedRoot)
    ? resolvedRoot
    : trackedSchema;
  let activeSchemas: WeakSet<object> | undefined;
  if (
    trackedValue !== undefined && trackedSchema !== undefined &&
    trackedRoot !== undefined
  ) {
    let byRoot = context.activePairs.get(trackedValue);
    if (!byRoot) {
      byRoot = new WeakMap();
      context.activePairs.set(trackedValue, byRoot);
    }
    activeSchemas = byRoot.get(trackedRoot);
    if (!activeSchemas) {
      activeSchemas = new WeakSet();
      byRoot.set(trackedRoot, activeSchemas);
    }
    if (activeSchemas.has(trackedSchema)) {
      context.cycleVersion++;
      return value;
    }
    activeSchemas.add(trackedSchema);
  }

  try {
    // A present `FabricInstance` is durable state, handed back whole: the
    // rule below for a scalar or special object, stated ahead of the union
    // arms because one seen through a cell read is a view whose prototype is
    // `Object.prototype`, which those arms and the record copy would take
    // for a record. The copy cannot even fail quietly -- a spread's
    // descriptor query meets the instance's non-configurable freeze shield,
    // which the view's stub target lacks, so the proxy invariant throws
    // before any verdict. `traverseDAG` leafs the instance through on the
    // schemaless read that produced the view, and the merge owes the same:
    // defaults fill absent slots and never replace a present value, and the
    // instance's own verdict belongs to the validator, which judges it whole.
    //
    // TODO(danfuzz): schemas will come to describe an instance's contents -- a
    // `FabricMap` with keys of one type and values of another, say -- and a
    // default can then sit inside one. This return, and the special-object
    // rule below it, is what stops the merge at the instance's surface; when
    // that lands, the merge descends an instance by its codec contents
    // instead, and both stops come out.
    if (valuePresent && isFabricInstanceOrView(value)) return value;

    if (
      valuePresent &&
      (isFabricPlainObject(value as FabricValue) || Array.isArray(value)) &&
      isObjectOrArray(resolved) &&
      (Array.isArray(resolved.anyOf) || Array.isArray(resolved.oneOf))
    ) {
      const {
        anyOf,
        oneOf,
        default: _unionDefault,
        ...baseSchema
      } = resolved;
      const baseDefaults = defaultValuesForMerge(
        baseSchema,
        resolvedRoot,
        context,
      );
      type UnionCandidate = {
        value: unknown;
        selectedBranches: JSONSchema[];
      };
      const unionDefaultValue = mergeSchemaDefaultsInternal(
        value,
        defaults,
        baseSchema,
        resolvedRoot,
        true,
        mergeMaterializedLinks,
        acceptOpaqueValue,
        undefined,
        context,
      );
      let candidates: UnionCandidate[] = [{
        value: mergeSchemaDefaultsInternal(
          unionDefaultValue,
          baseDefaults,
          baseSchema,
          resolvedRoot,
          true,
          mergeMaterializedLinks,
          acceptOpaqueValue,
          undefined,
          context,
        ),
        selectedBranches: [],
      }];
      const unionConstraints = [anyOf, oneOf].filter(
        (branches): branches is JSONSchema[] => Array.isArray(branches),
      );
      for (const branches of unionConstraints) {
        const expanded: UnionCandidate[] = [];
        for (const candidate of candidates) {
          for (const branch of branches) {
            const branchDefaults = defaultValuesForMerge(
              branch,
              resolvedRoot,
              context,
            );
            expanded.push({
              value: mergeSchemaDefaultsInternal(
                candidate.value,
                branchDefaults,
                branch,
                resolvedRoot,
                true,
                mergeMaterializedLinks,
                acceptOpaqueValue,
                undefined,
                context,
              ),
              selectedBranches: [...candidate.selectedBranches, branch],
            });
          }
        }
        candidates = expanded;
      }
      const validCandidates = candidates.filter((candidate) =>
        candidate.selectedBranches.every((branch) =>
          validateSchemaValue(branch, candidate.value, resolvedRoot, {
            acceptOpaqueValue,
          }) === undefined
        ) &&
        validateSchemaValue(resolved, candidate.value, resolvedRoot, {
            acceptOpaqueValue,
          }) === undefined
      ).map((candidate) => candidate.value);
      const acceptedCandidates = acceptUnionCandidate === undefined
        ? validCandidates
        : validCandidates.filter(acceptUnionCandidate);
      if (
        acceptedCandidates.length > 0 &&
        acceptedCandidates.every((candidate) =>
          mergedValueEquals(candidate, acceptedCandidates[0])
        )
      ) {
        return acceptedCandidates[0];
      }
      return value;
    }

    if (
      valuePresent && isFabricPlainObject(value as FabricValue) &&
      isObjectOrArray(resolved) &&
      Array.isArray(resolved.type) && resolved.type.includes("object")
    ) {
      const { default: _unionDefault, ...objectSchema } = resolved;
      const objectDefaults = defaultValuesForMerge(
        { ...objectSchema, type: "object" },
        resolvedRoot,
        context,
      );
      const unionDefaultValue = mergeSchemaDefaultsInternal(
        value,
        defaults,
        { ...objectSchema, type: "object" },
        resolvedRoot,
        true,
        mergeMaterializedLinks,
        acceptOpaqueValue,
        undefined,
        context,
      );
      return mergeSchemaDefaultsInternal(
        unionDefaultValue,
        objectDefaults,
        { ...objectSchema, type: "object" },
        resolvedRoot,
        true,
        mergeMaterializedLinks,
        acceptOpaqueValue,
        undefined,
        context,
      );
    }

    if (
      valuePresent && Array.isArray(value) &&
      isObjectOrArray(resolved) &&
      Array.isArray(resolved.type) && resolved.type.includes("array")
    ) {
      const { default: _unionDefault, ...arraySchema } = resolved;
      return mergeSchemaDefaultsInternal(
        value,
        defaultValuesForMerge(
          { ...arraySchema, type: "array" },
          resolvedRoot,
          context,
        ),
        { ...arraySchema, type: "array" },
        resolvedRoot,
        true,
        mergeMaterializedLinks,
        acceptOpaqueValue,
        undefined,
        context,
      );
    }

    if (
      valuePresent && Array.isArray(value) &&
      isObjectOrArray(resolved) &&
      (resolved.type === "array" || resolved.items !== undefined ||
        resolved.prefixItems !== undefined)
    ) {
      const result = value.slice();
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) continue;
        const itemSchema = Array.isArray(resolved.prefixItems) &&
            index < resolved.prefixItems.length
          ? resolved.prefixItems[index]!
          : resolved.items ?? true;
        result[index] = mergeSchemaDefaultsInternal(
          value[index],
          defaultValuesForMerge(itemSchema, resolvedRoot, context),
          itemSchema,
          resolvedRoot,
          true,
          mergeMaterializedLinks,
          acceptOpaqueValue,
          undefined,
          context,
        );
      }
      return mergedValueEquals(result, value) ? value : result;
    }

    const objectSchema = isObjectOrArray(resolved) &&
        (resolved.type === undefined || resolved.type === "object" ||
          (Array.isArray(resolved.type) && resolved.type.includes("object")))
      ? resolved
      : undefined;
    const traversesPresentObject = valuePresent &&
      isFabricPlainObject(value as FabricValue) && objectSchema !== undefined;

    if (defaults === undefined && !traversesPresentObject) return value;
    if (
      defaults !== undefined &&
      (!isValidFabricPlainObject(defaults) || isCellLink(defaults))
    ) {
      return valuePresent ? value : defaults;
    }
    // Defaults only fill absent values or recursively merge plain records. A
    // defined scalar, sparse array, `FabricSpecialObject`, or sigil link is
    // durable user state, not an empty object to replace with defaults.
    if (
      valuePresent &&
      (!isFabricPlainObject(value as FabricValue) ||
        (isCellLink(value) && !mergeMaterializedLinks))
    ) {
      return value;
    }

    const existing = valuePresent ? value as Record<string, unknown> : {};
    const result: Record<string, unknown> = { ...existing };
    // Object-shaped unions (including Common Fabric's non-standard
    // `type: ["object", "undefined"]`) still need presence-aware merging. A
    // generic merge cannot distinguish an absent property from an own property
    // whose durable value is explicitly undefined.
    const required = new Set(objectSchema?.required ?? []);
    const defaultObject = (defaults ?? {}) as Record<string, unknown>;
    const keys = new Set([
      ...Object.keys(existing),
      ...Object.keys(defaultObject),
    ]);
    for (const key of keys) {
      const hasExistingValue = Object.hasOwn(existing, key);
      const hasDefaultValue = Object.hasOwn(defaultObject, key);
      const propertySchemas = schemasForObjectProperty(objectSchema, key);
      let merged = existing[key];
      let mergedValuePresent = hasExistingValue;
      for (let index = 0; index < propertySchemas.length; index++) {
        const propertySchema = propertySchemas[index]!;
        const propertyDefaults = index === 0 && hasDefaultValue
          ? defaultObject[key]
          : defaultValuesForMerge(propertySchema, resolvedRoot, context);
        merged = mergeSchemaDefaultsInternal(
          merged,
          propertyDefaults,
          propertySchema,
          resolvedRoot,
          mergedValuePresent,
          mergeMaterializedLinks,
          acceptOpaqueValue,
          undefined,
          context,
        );
        if (
          !mergedValuePresent &&
          schemaHasDefaultValue(propertySchema, resolvedRoot)
        ) {
          mergedValuePresent = true;
        }
      }
      if (
        hasExistingValue || required.has(key) ||
        propertySchemas.every((propertySchema) =>
          validateSchemaValue(propertySchema, merged, resolvedRoot, {
            acceptOpaqueValue,
          }) === undefined
        )
      ) {
        Object.defineProperty(result, key, {
          value: merged,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return valuePresent && mergedValueEquals(result, value) ? value : result;
  } finally {
    if (trackedSchema !== undefined) activeSchemas?.delete(trackedSchema);
  }
}

function schemasForObjectProperty(
  schema: Exclude<JSONSchema, boolean> | undefined,
  property: string,
): JSONSchema[] {
  if (schema === undefined) return [true];
  const schemas: JSONSchema[] = [];
  if (
    schema.properties !== undefined &&
    Object.hasOwn(schema.properties, property)
  ) {
    schemas.push(schema.properties[property]!);
  }
  for (
    const [source, patternSchema] of Object.entries(
      schema.patternProperties ?? {},
    )
  ) {
    if (new RegExp(source).test(property)) schemas.push(patternSchema);
  }
  if (schemas.length === 0) {
    schemas.push(schema.additionalProperties ?? true);
  }
  return schemas;
}
