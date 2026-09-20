import { JSONSchemaObj, type JSONValue } from "@commonfabric/api";
import { isDeepFrozen } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import { forEachSubschema } from "@commonfabric/data-model-schema/schema-walk";
import {
  isExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import type {
  AsCellEntry,
  CellKind,
  JSONSchema,
  SchemaScope,
} from "./builder/types.ts";
import type { CfcConfClause } from "./cfc/clause.ts";
import { uniqueCfcAtoms } from "./cfc/observation.ts";
import {
  cfcSchemaIsFalse,
  cfcSchemaIsInternalKey,
  cfcSchemaIsTrue,
  cfcSchemaResolvedRoot,
  cfcSchemaToObject,
  findCfcSchemaRefs,
  hoistCfcSchemaDefs,
  localDefinitionName,
  resolveCfcSchemaRef,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
  resolveCfcSchemaRefsOrThrow,
  selectReferencedCfcSchemaDefs,
} from "./cfc/schema-refs.ts";
import {
  externalResolutionMissCount,
  onSchemaRegistryClear,
} from "./schema-registry.ts";
import { isSchemaScope, narrowerScopeCap } from "./scope.ts";
export {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  CFC_FUSE_ATOM_CLASS,
  CFC_RUNTIME_SUBJECT,
  cfcAtom,
} from "@commonfabric/api/cfc";

type IFCAtom = JSONValue;

// schemaAtPath derivations per deep-frozen schema identity. The derivation is
// pure given (schema, path, the two defaults) when no extra confidentiality is
// passed — instance state never enters it (`lub` delegates to a static and has
// no subclasses) — and it runs per array element / object property on read and
// write-diff paths, so identical lookups repeat constantly. Module-level
// rather than per-instance: several hot paths create a fresh
// ContextualFlowControl per call (storage pull/watch, traversal contexts),
// which would leave a per-instance cache permanently cold. Mutable schemas are
// never cached (in-place edits must be observed), and neither is a mutable
// default (see `defaultSchemaTag`).
let schemaAtPathCache = new WeakMap<object, Map<string, JSONSchema>>();
// Path derivations can embed registry content; the registry clear (last
// lease out) swaps the cache so an epoch's derivations do not outlive it.
onSchemaRegistryClear(() => {
  schemaAtPathCache = new WeakMap();
});
const SCHEMA_AT_PATH_CACHE_MAX_ENTRIES = 2_048;

type SymbolicSchemaAtPathClassifier = (part: string) => string;
const SYMBOLIC_CLASSIFIER_UNSUPPORTED = Symbol("unsupported");
const symbolicSchemaAtPathClassifierCache = new WeakMap<
  object,
  SymbolicSchemaAtPathClassifier | typeof SYMBOLIC_CLASSIFIER_UNSUPPORTED
>();

interface RootedSchemaVisit {
  root: object;
  schema: object;
  parent?: RootedSchemaVisit;
}

const rootedSchemaVisitIsActive = (
  visit: RootedSchemaVisit | undefined,
  root: object,
  schema: object,
): boolean => {
  for (let cursor = visit; cursor !== undefined; cursor = cursor.parent) {
    if (cursor.root === root && cursor.schema === schema) return true;
  }
  return false;
};

const buildSymbolicSchemaAtPathClassifier = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
  active?: RootedSchemaVisit,
): SymbolicSchemaAtPathClassifier | undefined => {
  if (typeof schema === "boolean") return () => "boolean";
  const schemaRoot = fullSchema;
  const rootKey = isObjectOrArray(schemaRoot) ? schemaRoot : schema;
  if (rootedSchemaVisitIsActive(active, rootKey, schema)) return undefined;
  const nextActive = { root: rootKey, schema, parent: active };
  {
    if (schema.$ref !== undefined) {
      const resolved = resolveCfcSchemaRefs(schema, schemaRoot);
      if (resolved === undefined) return undefined;
      const nextFullSchema = cfcSchemaResolvedRoot(
        resolved,
        resolveCfcSchemaRefRoot(schema, schemaRoot),
      );
      return buildSymbolicSchemaAtPathClassifier(
        resolved,
        nextFullSchema,
        nextActive,
      );
    }
    if (Array.isArray(schema.type)) {
      const { type: _types, ...base } = schema;
      const classifiers: SymbolicSchemaAtPathClassifier[] = [];
      for (const type of schema.type) {
        const classifier = buildSymbolicSchemaAtPathClassifier(
          { ...base, type },
          schemaRoot,
          nextActive,
        );
        if (classifier === undefined) return undefined;
        classifiers.push(classifier);
      }
      return combineSymbolicSchemaClassifiers(classifiers);
    }
    if (schema.anyOf || schema.oneOf) {
      const options = (schema.anyOf && schema.oneOf)
        ? [...schema.anyOf, ...schema.oneOf]
        : schema.anyOf ?? schema.oneOf ?? [];
      const classifiers: SymbolicSchemaAtPathClassifier[] = [];
      for (const option of options) {
        const classifier = buildSymbolicSchemaAtPathClassifier(
          option,
          schemaRoot,
          nextActive,
        );
        if (classifier === undefined) return undefined;
        classifiers.push(classifier);
      }
      return combineSymbolicSchemaClassifiers(classifiers);
    }
    if (cfcSchemaIsTrue(schema)) return () => "wildcard";
    if (schema.type === "object") {
      const properties = schema.properties;
      if (properties !== undefined) {
        const fallback = Object.keys(properties).length === 0
          ? "empty"
          : "missing";
        return (part) =>
          Object.hasOwn(properties, part)
            ? `property:${part.length}:${part}`
            : schema.additionalProperties !== undefined
            ? "additional"
            : fallback;
      }
      return schema.additionalProperties !== undefined
        ? () => "additional"
        : () => "open";
    }
    if (schema.type === "array") {
      const prefixItemCount = schema.prefixItems?.length ?? 0;
      return (part) => {
        if (!isArrayIndexPropertyName(part)) return "invalid-index";
        const index = Number(part);
        return index < prefixItemCount ? `prefix:${index}` : "items";
      };
    }
    if (
      schema.type === "unknown" ||
      Array.isArray(schema.type) && schema.type.includes("unknown")
    ) {
      return () => "unknown";
    }
    // schemaAtPath cannot descend through terminal primitive schemas.
    return () => "terminal";
  }
};

// The immediately repeated lookup is the dominant cache-hit case. One entry
// removes union-width cost without reintroducing raw path-part cardinality.
const combineSymbolicSchemaClassifiers = (
  classifiers: readonly SymbolicSchemaAtPathClassifier[],
): SymbolicSchemaAtPathClassifier => {
  const combinedKeyIds = new Map<string, string>();
  let memoPart: string | undefined;
  let memoKey = "";
  return (part) => {
    if (part === memoPart) return memoKey;
    let combinedKey = "union";
    for (const classifier of classifiers) {
      const childKey = classifier(part);
      combinedKey += `|${childKey.length}:${childKey}`;
    }
    let key = combinedKeyIds.get(combinedKey);
    if (key === undefined) {
      key = `union:${combinedKeyIds.size}`;
      combinedKeyIds.set(combinedKey, key);
    }
    memoPart = part;
    memoKey = key;
    return key;
  };
};

/**
 * A one-segment path key based on schema behavior rather than data cardinality.
 *
 * Homogeneous array indices and undeclared object property names all select the
 * same schema. Sharing those cache entries bounds the cache by schema shape
 * instead of by array length or dynamic object key count. For frozen schemas,
 * resolving the root ref/union structure once builds a reusable classifier for
 * later lookups. Unsupported shapes retain the bounded exact-path fallback.
 */
const symbolicSchemaAtPathPart = (
  schema: JSONSchemaObj,
  part: string,
): string | undefined => {
  let classifier = symbolicSchemaAtPathClassifierCache.get(schema);
  if (classifier === undefined) {
    classifier = buildSymbolicSchemaAtPathClassifier(
      schema,
      schema,
    ) ?? SYMBOLIC_CLASSIFIER_UNSUPPORTED;
    symbolicSchemaAtPathClassifierCache.set(schema, classifier);
  }
  return classifier === SYMBOLIC_CLASSIFIER_UNSUPPORTED
    ? undefined
    : classifier(part);
};

/**
 * A stable token for one of `schemaAtPath`'s two default schemas, or
 * `undefined` where the default cannot take part in a cache key.
 *
 * The defaults are usually the booleans `true` and `false`, which name
 * themselves. A caller can also pass a schema object instead — that is how a
 * reader asks to be TOLD that a property was not selected rather than handed
 * something indistinguishable from a selected one, which is what
 * `schema-view.ts` does for every property and every element it reads. Such a
 * default is a module-level frozen constant, so its identity is stable for the
 * life of the process and a tag minted once names it ever after.
 *
 * Deep-frozen is the condition, not a convenience: a mutable object could be
 * changed after a result was cached under it, and the entry would then answer
 * for a default it no longer describes.
 */
const defaultSchemaTags = new WeakMap<object, string>();

let nextDefaultSchemaTag = 0;

const defaultSchemaTag = (schema: JSONSchema): string | undefined => {
  if (typeof schema === "boolean") return String(schema);
  if (!isObjectOrArray(schema) || !isDeepFrozen(schema)) return undefined;
  let tag = defaultSchemaTags.get(schema);
  if (tag === undefined) {
    tag = `#${++nextDefaultSchemaTag}`;
    defaultSchemaTags.set(schema, tag);
  }
  return tag;
};

const schemaAtPathKey = (
  schema: JSONSchemaObj,
  path: readonly string[],
  defaultEmptyProperties: string,
  defaultMissingProperty: string,
): string => {
  let key = `${defaultEmptyProperties}|${defaultMissingProperty}`;
  if (path.length === 1) {
    const symbolic = symbolicSchemaAtPathPart(schema, path[0]);
    if (symbolic !== undefined) return `${key}|s:${symbolic}`;
  }
  // Length-prefix each segment so a segment containing the separator (a
  // NUL-bearing property name) cannot collide with a differently-split path.
  for (const part of path) key += `|${part.length}:${part}`;
  return key;
};

// The cfc rules. Every member is static: the derivations are pure functions of
// their arguments, and what caching there is lives in module-level maps keyed
// by schema identity.
// The spec's confidentiality model is based on structured atoms.
export class ContextualFlowControl {
  static uniqueAtoms(atoms: Iterable<unknown>): IFCAtom[] {
    return uniqueCfcAtoms(atoms);
  }

  static addIfcAtoms(
    joined: Set<unknown>,
    atoms: readonly IFCAtom[] | undefined,
  ): void {
    if (!Array.isArray(atoms)) {
      return;
    }
    for (const atom of atoms) {
      joined.add(atom);
    }
  }

  /**
   * Collect any required confidentiality atoms required by the schema.
   * This could be made more conservative by combining the schema with the object
   * If our object lacks any of the fields that would add confidentiality,
   * we don't need to consider them.
   *
   * @param joined set to which we will add any confidentiality atoms
   * @param schema the schema with tags
   * @param fullSchema the full schema with any $defs needed
   * @param cycleTracker used to avoid reference cycles
   */
  static joinSchema(
    joined: Set<unknown>,
    schema: JSONSchema,
    fullSchema: JSONSchema = schema,
    active?: RootedSchemaVisit,
  ): Set<unknown> {
    if (typeof schema === "boolean") {
      return joined;
    }
    // A resolved schema is often unique, since it's generated by combining
    // other schema. `internSchema()` returns the canonical (identity-unique)
    // schema object, so structurally-equal schemas collapse to the same
    // reference — the cycle tracker can then dedup by identity. Also
    // correctly handles non-JSON-compatible `FabricValue`s (e.g.
    // `FabricEpochNsec`, `FabricBytes`, `FabricHash`) that may appear in
    // schema `default` fields; plain `JSON.stringify` would silently
    // mis-encode them.
    const schemaRoot = fullSchema;
    const rootKey = isObjectOrArray(schemaRoot) ? schemaRoot : schema;
    const canonical = internSchema(schema) as JSONSchemaObj;
    if (rootedSchemaVisitIsActive(active, rootKey, canonical)) {
      // we've already joined this
      return joined;
    }
    const nextActive = { root: rootKey, schema: canonical, parent: active };
    if (schema.ifc) {
      ContextualFlowControl.addIfcAtoms(joined, schema.ifc.confidentiality);
    }
    // The LUB must union the atoms of every subschema a value could validate
    // against — one (anyOf/oneOf) or all (allOf) branches, every property,
    // every tuple slot, items and additionalProperties alike; a skipped
    // keyword is branch-local confidentiality silently dropped (under-tainting
    // fail-open, audit 1.6). The default walk excludes the keywords we never
    // emit (`if`/`then`/`else`, `patternProperties`, ...) — ifc flags in
    // those unused schema fields are deliberately not collected. `not` is
    // unioned too: usually its atoms describe values the data must NOT
    // contain — a conservative over-taint — but a nested `not` (not-of-not)
    // re-selects values that DO match the inner subschema, so skipping `not`
    // could under-taint.
    forEachSubschema(schema, (child) => {
      ContextualFlowControl.joinSchema(joined, child, schemaRoot, nextActive);
    });
    if (schema.$ref) {
      // Follow the references
      const resolvedSchema = ContextualFlowControl.resolveSchemaRefsOrThrow(
        schema,
        schemaRoot,
      );
      const resolvedRoot = cfcSchemaResolvedRoot(
        resolvedSchema,
        resolveCfcSchemaRefRoot(schema, schemaRoot),
      );
      ContextualFlowControl.joinSchema(
        joined,
        resolvedSchema,
        resolvedRoot,
        nextActive,
      );
    }
    return joined;
  }

  /** Returns the joined confidentiality atoms from the schema. */
  static lubSchema(
    schema: JSONSchema,
    extraConfidentiality?: Set<unknown>,
  ): IFCAtom[] | undefined {
    const confidentiality = (extraConfidentiality !== undefined)
      ? new Set<unknown>(extraConfidentiality)
      : new Set<unknown>();
    ContextualFlowControl.joinSchema(confidentiality, schema);

    return (confidentiality.size === 0)
      ? undefined
      : ContextualFlowControl.lub(confidentiality);
  }

  static lub(joined: Set<unknown>): IFCAtom[] {
    return ContextualFlowControl.uniqueAtoms(joined);
  }

  /** Returns a copy of the schema with joined confidentiality atoms. */
  static schemaWithLub(
    schema: JSONSchema,
    confidentiality: readonly CfcConfClause[],
  ): JSONSchema {
    const joined = new Set<unknown>(confidentiality);
    if (isObjectOrArray(schema) && schema.ifc !== undefined) {
      ContextualFlowControl.addIfcAtoms(joined, schema.ifc.confidentiality);
    }
    // If we have no confidentiality, we can leave the schema
    if (joined.size === 0) {
      return schema;
    }
    // We don't really support "not" schemas, but it's the only good way we
    // have to attach ifc to a `false` schema.
    const schemaObj = ContextualFlowControl.toSchemaObj(schema);
    const restrictedSchema = {
      ...schemaObj,
      ifc: {
        ...schemaObj.ifc,
        confidentiality: ContextualFlowControl.lub(joined),
      },
    };
    return restrictedSchema;
  }

  /**
   * Convert a schema that may be undefined or boolean to an object version.
   *
   * @param schema optional schema to convert
   */
  static toSchemaObj(schema?: JSONSchema): JSONSchemaObj {
    return cfcSchemaToObject(schema);
  }

  /**
   * Resolve a $ref in a schema, following other $ref links if needed.
   *
   * This doesn't currently handle $anchor tags or external documents
   * This will follow the $ref until the top level object is not a $ref.
   *
   * @param schemaObj an object containing the $ref, which may have properties
   *     that override those in the object pointed to by the $ref.
   * @param fullSchema Top level document for the schema which will be used
   *     to resolve the $ref. This should have the $defs.
   * @returns an updated JSONSchema, with a schema that points to the
   *     $ref's final target or undefined if the $ref could not be resolved.
   */
  static resolveSchemaRefs(
    schemaObj: JSONSchemaObj,
    fullSchema: JSONSchema = schemaObj,
  ): JSONSchema | undefined {
    return resolveCfcSchemaRefs(schemaObj, fullSchema);
  }

  // TODO(@ubik2): We may need to collect ifc labels as we walk the tree
  // This could be dome similarly to schemaAtPath, but that assumes
  // our cursor points at a schema, while we will walk objects like the
  // $defs that are not schema.
  // In the case where we point to a definition, this should already do
  // the right thing, since those are all at the top level. However, we
  // could have a reference to an anchor (not currently allowed), and
  // for those, if the User is secret, their Address should be too.

  /**
   * Resolve a $ref in a schema.
   * This doesn't currently handle $anchor tags or external documents
   *
   * If the schemaRef points to an object that is also a $ref, this will not
   * follow that link. Use resolveSchemaRefs for that behavior.
   *
   * @param fullSchema Top level document for the schema which will be used
   *     to resolve the $ref.
   * @param schemaRef the string value of the $ref
   * @returns an updated JSONSchema, with a schema that points to the
   *     $ref's target or undefined if the $ref could not be resolved.
   */
  static resolveSchemaRef(
    fullSchema: JSONSchema,
    schemaRef: string,
  ): JSONSchema | undefined {
    return resolveCfcSchemaRef(fullSchema, schemaRef);
  }

  /**
   * Traverse a schema finding any $ref links.
   *
   * This does not scan the $defs, so a $ref that points to a $defs entry that
   * then references another $defs entry would not have that second reference
   * included.
   *
   * @param schema
   * @param refSet
   */
  static findRefs(
    schema: JSONSchema,
    refSet: Set<string> = new Set<string>(),
  ): void {
    return findCfcSchemaRefs(schema, refSet);
  }

  static resolveSchemaRefsOrThrow(
    schemaObj: JSONSchemaObj,
    fullSchema: JSONSchema = schemaObj,
  ) {
    return resolveCfcSchemaRefsOrThrow(schemaObj, fullSchema);
  }

  /**
   * Like `schemaAtPath()`, except it allows an undefined schema, and returns
   * the empty object instead of `true` and `undefined` instead of `false`.
   */
  static getSchemaAtPath(
    schema: JSONSchema | undefined,
    path: string[],
    extraConfidentiality?: Set<unknown>,
  ): JSONSchema | undefined {
    if (schema === undefined) {
      return undefined;
    }
    const result = ContextualFlowControl.schemaAtPath(
      schema,
      path,
      extraConfidentiality,
    );
    return result === false ? undefined : result === true ? {} : result;
  }

  /**
   * This gets the schema at a specific path.
   * This is a leaky abstraction, since you can have changes in a parent object
   * that shape the potential values and types of child objects.
   *
   * For example, if you have anyOf USAddress, CanadaAddress and the USAddress
   * differentiated by country name, when you ask for the postalCode, the schema
   * if the parent portions were a USAddress is a a sequence of 5 numbers.
   * However if the parent portions were a CanadaAddress, the postalCode is a
   * sequence of 6 letters or numbers.
   *
   * You can't know how the schema will be narrowed without evaluating it
   * against a candidate object.
   *
   * Nonetheless, it's very convenient to have a schema without knowing, so we
   * provide this method and use it.
   *
   * The additionalPropertiesDefault lets you change the behavior when there is
   * an object with an empty properties map and no additional properties.
   * The JSON-Schema spec would default this to true, but we often want to
   * use it to exclude properties that we don't care about without failing.
   * We also allow you to provide a special string value, so the caller can detect
   * that this has happened.
   *
   * While we will handle $ref links as needed while getting to the schema,
   * the returned object will retain those $ref links.
   */
  static schemaAtPath(
    schema: JSONSchema,
    path: readonly string[],
    extraConfidentiality?: Set<unknown>,
    defaultEmptyProperties: JSONSchema = true,
    defaultMissingProperty: JSONSchema = true,
  ): JSONSchema {
    if (schema === false) return false;
    if (schema === true && extraConfidentiality === undefined) return true;
    // Take defs from schema if available
    const defs = isObjectOrArray(schema) && schema.$defs
      ? schema.$defs
      : undefined;
    // Both defaults take part in the cache key, whether each is a boolean or
    // a frozen sentinel schema. Refusing to cache the sentinel case turned the
    // cache off for the whole of `schema-view.ts`, which passes sentinels on
    // every property and every element it reads — so a view re-derived each
    // child's schema from scratch, and handed the caller a fresh object that
    // then cost a content hash to intern. That is the hot path, not a corner
    // of one: reading a list of N references narrows N times per pass.
    const emptyTag = defaultSchemaTag(defaultEmptyProperties);
    const missingTag = defaultSchemaTag(defaultMissingProperty);
    const cacheable = extraConfidentiality === undefined &&
      emptyTag !== undefined && missingTag !== undefined &&
      isObjectOrArray(schema) && isDeepFrozen(schema);
    if (!cacheable) {
      return ContextualFlowControl.#schemaAtPathInternal(
        schema,
        path,
        defs,
        extraConfidentiality,
        defaultEmptyProperties,
        defaultMissingProperty,
      );
    }
    let byKey = schemaAtPathCache.get(schema);
    if (byKey === undefined) {
      byKey = new Map();
      schemaAtPathCache.set(schema, byKey);
    }
    const key = schemaAtPathKey(schema, path, emptyTag, missingTag);
    let result = byKey.get(key);
    if (result === undefined) {
      // Intern the derivation so the cached result is the canonical frozen
      // instance: downstream identity-keyed caches (standardization, value
      // hashing) hit instead of re-walking a fresh anyOf rebuild every time.
      const missesBefore = externalResolutionMissCount();
      result = internSchema(ContextualFlowControl.#schemaAtPathInternal(
        schema,
        path,
        defs,
        undefined,
        defaultEmptyProperties,
        defaultMissingProperty,
      ));
      // Populate-only guard: a derivation during which a `cid:` resolution
      // missed must not be memoized — the document can arrive later. The
      // miss counter is exact and walk-free; a schema-content check here
      // paid a full walk, dormant `$defs` bodies included, on the first
      // lookup for every schema identity.
      if (externalResolutionMissCount() === missesBefore) {
        if (byKey.size >= SCHEMA_AT_PATH_CACHE_MAX_ENTRIES) byKey.clear();
        byKey.set(key, result);
      }
    }
    return result;
  }

  static #schemaAtPathInternal(
    schema: JSONSchema,
    path: readonly string[],
    defs: Record<string, JSONSchema> | undefined,
    extraConfidentiality: Set<unknown> | undefined,
    defaultEmptyProperties: JSONSchema,
    defaultMissingProperty: JSONSchema,
  ): JSONSchema {
    const joined = (extraConfidentiality !== undefined)
      ? new Set<unknown>(extraConfidentiality)
      : new Set<unknown>();
    let cursor = schema;
    for (
      const [index, part] of path.map((value, index) =>
        [index, value] as [number, string]
      )
    ) {
      // If the cursor is a $ref, get the target location
      if (isObjectOrArray(cursor) && "$ref" in cursor) {
        // Follow the reference
        cursor = ContextualFlowControl.resolveSchemaRefsOrThrow(
          cursor,
          { $defs: defs },
        );
        // Resolve schema refs can resolve to a fullSchema, in which case we
        // need to replace our defs.
        if (isObjectOrArray(cursor) && cursor.$defs) {
          defs = cursor.$defs;
        }
      }
      if (
        isObjectOrArray(cursor) &&
        (Array.isArray(cursor.type) || "anyOf" in cursor || "oneOf" in cursor)
      ) {
        const armSchemas: JSONSchema[] = [];
        const cursorObject = cursor;
        const options = Array.isArray(cursorObject.type)
          ? cursorObject.type.map((type) => ({ ...cursorObject, type }))
          : (cursorObject.anyOf && cursorObject.oneOf)
          ? [...cursorObject.anyOf, ...cursorObject.oneOf]
          : cursorObject.anyOf ?? cursorObject.oneOf ?? [];
        for (const entry of options) {
          // An arm sits in the union's document, so its refs resolve against
          // the map in effect, whatever `$defs` the arm declares of its own.
          const optSchema = ContextualFlowControl.#schemaAtPathInternal(
            entry,
            path.slice(index),
            defs,
            extraConfidentiality,
            defaultEmptyProperties,
            defaultMissingProperty,
          );
          if (typeof optSchema !== "boolean" && typeof optSchema !== "object") {
            return optSchema;
          }
          const subSchema = optSchema as JSONSchema;
          if (subSchema === false) {
            continue;
          } else if (ContextualFlowControl.isTrueSchema(subSchema)) {
            cursor = true;
            break;
          } else {
            armSchemas.push(subSchema);
          }
        }
        // Only update cursor from the arms if the isTrueSchema branch
        // didn't already set cursor = true and break out of the loop.
        if (cursor !== true) {
          // Each arm came back as a document of its own, carrying the closure
          // its refs reach. The union is one document, so the arms' maps
          // merge into the map the result is selected from, and an arm that
          // resolved into another document is renamed apart.
          const { fragments, definitions } = hoistCfcSchemaDefs(armSchemas);
          if (definitions !== undefined) defs = definitions;
          // `internSchema()` returns the canonical (identity-unique)
          // schema object, so structurally-equal schemas collapse to
          // the same reference. That gives identity-based dedup via
          // `Set<JSONSchema>`, and correctly handles non-JSON-compatible
          // `FabricValue`s (e.g. `FabricEpochNsec`, `FabricBytes`,
          // `FabricHash`) that may appear in schema `default` fields.
          const subSchemaArr = [
            ...new Set(fragments.map((arm) => internSchema(arm))),
          ];
          if (subSchemaArr.length === 0) {
            cursor = false;
          } else if (subSchemaArr.length === 1) {
            cursor = subSchemaArr[0];
          } else {
            cursor = { "anyOf": subSchemaArr };
          }
        }
        break;
      }
      if (typeof cursor === "boolean") {
        break;
      } else if (ContextualFlowControl.isTrueSchema(cursor)) {
        // wildcard schema -- equivalent to true, but we can add ifc tags
        break;
      } else if (cursor.type === "object") {
        if (cursor.ifc !== undefined) {
          ContextualFlowControl.addIfcAtoms(
            joined,
            cursor.ifc.confidentiality,
          );
        }
        if (cursor.properties && Object.hasOwn(cursor.properties, part)) {
          const cursorObj = cursor.properties as Record<string, JSONSchema>;
          cursor = cursorObj[part];
          if (typeof cursor === "boolean") {
            break;
          } else {
            if (cursor.ifc !== undefined) {
              ContextualFlowControl.addIfcAtoms(
                joined,
                cursor.ifc.confidentiality,
              );
            }
          }
        } else if (cursor.additionalProperties !== undefined) {
          cursor = cursor.additionalProperties;
        } else if (
          cursor.properties && Object.keys(cursor.properties).length === 0
        ) {
          // We'll often ignore, but validate in this case
          cursor = defaultEmptyProperties;
        } else if (cursor.properties) {
          // We'll generally include these, but sometimes we don't
          cursor = defaultMissingProperty;
        } else { // no additionalProperties field is the same as having one that is true
          cursor = true;
        }
      } else if (cursor.type === "array") {
        if (isArrayIndexPropertyName(part)) {
          const index = Number(part);
          if (cursor.prefixItems && index < cursor.prefixItems.length) {
            cursor = cursor.prefixItems[index];
          } else {
            cursor = cursor.items ?? true;
          }
        } else {
          return false;
        }
      } else if (
        cursor.type === "unknown" ||
        Array.isArray(cursor.type) && cursor.type.includes("unknown")
      ) {
        // we can descend into unknown, but we just get more unknown
        cursor = { type: "unknown", ...(cursor.ifc && { ifc: cursor.ifc }) };
      } else {
        // we can only descend into objects and arrays or unknown
        return false;
      }
    }
    if (isObjectOrArray(cursor) && cursor.ifc !== undefined) {
      ContextualFlowControl.addIfcAtoms(joined, cursor.ifc.confidentiality);
    }
    if (typeof cursor === "boolean") {
      if (!cursor) {
        return false; // no need to attach tags -- we'll never match
      } else if (joined.size === 0) {
        return true; // no ifc tags -- can just return true
      }
      cursor = {}; // change to use the empty object schema, so we can attach ifc.
    }
    // If we've encountered any confidentiality atoms while walking down the
    // schema, we need to add them to the returned object.
    const ifc = (joined.size !== 0)
      ? { ...cursor.ifc, confidentiality: ContextualFlowControl.lub(joined) }
      : cursor.ifc;
    const selectedDefs = selectReferencedCfcSchemaDefs(cursor, defs);
    const result = { ...cursor, ...(ifc && { ifc }) } as Record<
      string,
      unknown
    >;
    delete result.$defs;
    if (selectedDefs !== undefined) result.$defs = selectedDefs;
    return result as JSONSchema;
  }

  /**
   * Returns whether `schema` is one of the special values meaning it should
   * always validate.
   */
  static isTrueSchema(schema: JSONSchema): boolean {
    return cfcSchemaIsTrue(schema);
  }

  /**
   * Returns whether `key` is an internal schema key. Symbol keys are not
   * included in `Object.keys()` return values, so no symbol-keyed entry needs
   * checking here.
   */
  static isInternalSchemaKey(key: string): boolean {
    return cfcSchemaIsInternalKey(key);
  }

  static isFalseSchema(schema: JSONSchema): boolean {
    return cfcSchemaIsFalse(schema);
  }

  /**
   * Returns the `asCell` entries of `schema`, or none when it has no `asCell`
   * array.
   */
  static getAsCellValues(
    schema: JSONSchema | undefined,
  ): readonly AsCellEntry[] {
    if (isObjectOrArray(schema) && Array.isArray(schema.asCell)) {
      return schema.asCell;
    }
    return [];
  }

  static getAsCellKind(entry: AsCellEntry | undefined): CellKind | undefined {
    return typeof entry === "string" ? entry : entry?.kind;
  }

  /**
   * Whether `schema` declares a stream position: the handle kind it declares
   * ({@link declaredHandleKind}) is `stream`. Such a position holds no value,
   * and its handle is minted from the schema alone.
   */
  static declaresStream(schema: JSONSchema | undefined): boolean {
    return ContextualFlowControl.declaredHandleKind(schema) === "stream";
  }

  /**
   * The kind of handle `schema` declares at its root, read through a root
   * `$ref` — external or into the schema's own `$defs` — and through a
   * composition whose branches agree: `allOf` declares what any of its
   * branches declares, and `anyOf`/`oneOf` what every branch declares, since
   * the value may be any of them. `undefined` where nothing is declared, or
   * where the branches disagree, or where a reference does not resolve.
   *
   * `root` is the document local `$ref`s resolve against. It defaults to
   * `schema`, which a link's schema is self-contained enough for
   * (`schemaAtPath` keeps the reachable `$defs` closure on it), and it moves
   * to the resolved document when an external reference is followed, since
   * the local references inside that document name its own `$defs`. A
   * reference into a `$defs` the root does not carry declares nothing,
   * quietly: this is asked of every position a read passes, and most carry
   * no such closure.
   *
   * `active` is the descent under way. It stops a reference from being
   * followed back into itself; a definition two sibling branches share is
   * read once for each, since the first branch has left it by the time the
   * second arrives.
   */
  static declaredHandleKind(
    schema: JSONSchema | undefined,
    root: JSONSchema | undefined = schema,
    active: Set<object> = new Set(),
  ): CellKind | undefined {
    if (!isObjectOrArray(schema) || active.has(schema)) return undefined;
    active.add(schema);
    try {
      const resolved = resolveExternalRootRefForStructure(schema);
      if (resolved !== schema) root = resolved;
      const direct = ContextualFlowControl.getAsCellKind(
        ContextualFlowControl.getAsCellValues(resolved).at(0),
      );
      if (direct !== undefined) return direct;
      if (typeof resolved.$ref === "string") {
        return ContextualFlowControl.declaredHandleKind(
          localDefinition(root, resolved.$ref),
          root,
          active,
        );
      }
      const agreed = (
        branches: unknown,
        every: boolean,
      ): CellKind | undefined => {
        if (!Array.isArray(branches) || branches.length === 0) return undefined;
        let kind: CellKind | undefined;
        for (const branch of branches) {
          const declared = ContextualFlowControl.declaredHandleKind(
            branch as JSONSchema,
            root,
            active,
          );
          if (declared === undefined) {
            if (every) return undefined;
            continue;
          }
          if (kind !== undefined && kind !== declared) return undefined;
          kind = declared;
        }
        return kind;
      };
      return agreed(resolved.allOf, false) ?? agreed(resolved.anyOf, true) ??
        agreed(resolved.oneOf, true);
    } finally {
      active.delete(schema);
    }
  }

  static getAsCellScope(
    entry: AsCellEntry | undefined,
  ): SchemaScope | undefined {
    return typeof entry === "string" ? undefined : entry?.scope;
  }

  /**
   * The scope a schema declares at this level: the outermost `asCell` entry's
   * scope if present, otherwise the top-level `scope`. The outermost `asCell`
   * entry describes the immediate cell/slot (the addressing scope of the link
   * to it, and the read follow-cap for that immediate hop); the top-level
   * `scope` applies only when there is no `asCell` wrapper.
   *
   * This single precedence is used both for the read follow-cap (which link
   * scopes a read may follow — see link-resolution.ts / traverse.ts) and for
   * the write target scope (where content is stored — see data-updating.ts), so
   * the two never disagree. It is a schema-level declaration only; it must never
   * be stamped onto a navigated link's own scope (see CT-1623).
   */
  static getSchemaScopeCap(
    schema: JSONSchema | undefined,
  ): SchemaScope | undefined {
    if (!isObjectOrArray(schema)) return undefined;
    schema = resolveExternalRootRefForStructure(schema);
    const entryScope = ContextualFlowControl.getAsCellScope(
      ContextualFlowControl.getAsCellValues(schema).at(0),
    );
    if (isSchemaScope(entryScope)) return entryScope;
    if (isSchemaScope(schema.scope)) return schema.scope;
    return undefined;
  }

  /**
   * The follow cap declared by an `asCell` ENTRY, looking through `anyOf` /
   * `oneOf` wrappers.
   *
   * Two differences from {@link getSchemaScopeCap}, both deliberate:
   *
   * - No `schema.scope` fallback. Authors write `scope` on a node to say "this
   *   value lives at that scope"; reading it as a follow cap at a handle
   *   boundary invents a restriction nobody asked for.
   * - It descends into `anyOf`/`oneOf`. A cap wrapped in a compound schema —
   *   `{anyOf: [{...asCell: [{kind:"cell", scope:"space"}]}, {type:"null"}]}`
   *   — is a real shape here, and reading only the top level made it a
   *   one-line cap bypass. Branches that declare no `asCell` at all (a `null`
   *   alternative) are not handles and are skipped; among those that do, the
   *   NARROWEST wins, since the runtime value may be any of them.
   */
  static getAsCellFollowScopeCap(
    schema: JSONSchema | undefined,
  ): SchemaScope | undefined {
    if (!isObjectOrArray(schema)) return undefined;
    schema = resolveExternalRootRefForStructure(schema);
    const entryScope = ContextualFlowControl.getAsCellScope(
      ContextualFlowControl.getAsCellValues(schema).at(0),
    );
    if (isSchemaScope(entryScope)) return entryScope;
    let cap: SchemaScope | undefined;
    for (const branches of [schema.anyOf, schema.oneOf]) {
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        const branchCap = ContextualFlowControl.getAsCellFollowScopeCap(
          branch as JSONSchema,
        );
        cap = narrowerScopeCap(cap, branchCap);
      }
    }
    return cap;
  }
}

/**
 * The definition a `#/$defs/<name>` reference names in `root`, or `undefined`
 * for any other reference or a name `root` does not define. Looked up
 * directly rather than through {@link ContextualFlowControl.resolveSchemaRefs}
 * so that a miss stays silent.
 */
function localDefinition(
  root: JSONSchema | undefined,
  ref: string,
): JSONSchema | undefined {
  const name = localDefinitionName(ref);
  if (name === undefined || !isObjectOrArray(root)) return undefined;
  const defs = root.$defs;
  if (!isObjectOrArray(defs) || !Object.hasOwn(defs, name)) return undefined;
  const definition = (defs as Record<string, unknown>)[name];
  return isObjectOrArray(definition) || typeof definition === "boolean"
    ? definition as JSONSchema
    : undefined;
}

/**
 * A structural read of a schema position resolves an external reference
 * first (`docs/specs/content-addressed-schemas.md`): the reference is the
 * at-rest form of the schema, and declarations like the scope caps above
 * live on the resolved document. Links are NOT rewritten — the reference
 * stays the working representation, and each structural consumer resolves
 * (memoized) at its point of use. A reference whose closure has not
 * arrived reads as what it degrades to — schemaless, hence no
 * declarations — matching the binding degradation rule; the traversal's
 * document loader separately gates data selection on exactly that state.
 */
export function resolveExternalRootRefForStructure(
  schema: JSONSchemaObj,
): JSONSchemaObj {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !isExternalSchemaRef(ref)) return schema;
  const resolved = ContextualFlowControl.resolveSchemaRefs(schema);
  if (!isObjectNotArray(resolved)) return schema;
  // A resolved document can carry an empty `$defs`. Drop it so consumers
  // compare and combine these structurally as the writer's sanitized input —
  // but only when nothing in the body names a local definition, so the strip
  // can never orphan a `#/...` reference. (With an empty `$defs` such a
  // reference already dangles; the guard states the invariant instead of
  // inferring it from emptiness.)
  if (
    isObjectNotArray(resolved.$defs) &&
    Object.keys(resolved.$defs).length === 0 &&
    !hasLocalSchemaRef(resolved)
  ) {
    const { $defs: _empty, ...rest } = resolved;
    return internSchema(rest) as JSONSchemaObj;
  }
  return resolved;
}

/** Whether the schema's body (its `$defs` excluded) names a local `#/...`. */
function hasLocalSchemaRef(schema: JSONSchema): boolean {
  const refs = new Set<string>();
  findCfcSchemaRefs(schema, refs);
  for (const ref of refs) {
    if (ref.startsWith("#")) return true;
  }
  return false;
}
