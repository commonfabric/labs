import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import {
  debugStr,
  deepFreeze,
  fabricAwareEqual,
  type FabricValue,
  hashStringOf,
  isDeepFrozen,
} from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import {
  forEachSubschema,
  isSubschema,
  mapSubschemas,
  type SchemaWalkOptions,
} from "@commonfabric/data-model-schema/schema-walk";
import {
  type ExternalSchemaRef,
  formatExternalSchemaRef,
  isExternalSchemaRef,
  parseExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { utf8Compare } from "@commonfabric/utils/utf8";

import { decodeJsonPointer, encodeJsonPointer } from "../link-types.ts";

// `$ref` discovery / rewriting must be COMPLETE over every subschema keyword,
// including the ones we never emit: a ref this walk misses is a schema doc that
// fails to replicate (fail-open). So opt into the unused-keyword tier
// everywhere in this module. (`$defs` bodies stay dormant — reached through the
// definition-scope logic, not this flag.)
const ALL_SUBSCHEMAS: SchemaWalkOptions = { includeUnused: true };
import {
  embeddedSchemas,
  isEmbeddedCfcSchemaRef,
} from "../embedded-schemas.ts";
import {
  externalResolutionMissCount,
  isSchemaDocumentClosureComplete,
  lookupSchemaDocument,
  noteExternalResolutionMiss,
  onSchemaRegistryClear,
} from "../schema-registry.ts";
import {
  cfcSchemaToObject,
  isRootDefsSchemaPointer,
  localDefinitionName,
} from "./schema-primitives.ts";

export { isEmbeddedCfcSchemaRef };
export {
  cfcSchemaIsFalse,
  cfcSchemaIsInternalKey,
  cfcSchemaIsTrue,
  cfcSchemaToObject,
  localDefinitionName,
} from "./schema-primitives.ts";

const logger = getLogger("cfc");

type SchemaDefinitions = NonNullable<JSONSchemaObj["$defs"]>;

type SchemaRefSummary = {
  /** All refs below this fragment, excluding dormant `$defs` bodies. */
  all: ReadonlySet<string>;

  /**
   * Names the `#/$defs/<name>` refs below this fragment resolve against its
   * document's definition map, dormant `$defs` bodies excluded.
   */
  localDefinitions: ReadonlySet<string>;
};

type DefinitionIndex = {
  dependencies: Map<string, ReadonlySet<string>>;
  subsets: Map<string, SchemaDefinitions>;
};

const EMPTY_REFS: ReadonlySet<string> = new Set<string>();
const EMPTY_REF_SUMMARY: SchemaRefSummary = {
  all: EMPTY_REFS,
  localDefinitions: EMPTY_REFS,
};

// Memos for the pure schema-ref walks below, keyed by schema object identity.
// A walk populates summaries bottom-up for every visited fragment, so a root
// scan also prepares its child fragments for later schemaAtPath() lookups.
// Only deep-frozen schemas are cached: mutable schemas could be edited in place
// after caching. Definition dependency graphs and canonical subsets are keyed
// separately by the active `$defs` object, since the same fragment may be used
// under different documents.
const schemaRefSummaryCache = new WeakMap<object, SchemaRefSummary>();
const definitionIndexCache = new WeakMap<object, DefinitionIndex>();
const prunedRootSchemaCache = new WeakMap<object, JSONSchema>();
const prunedNestedSchemaCache = new WeakMap<object, JSONSchema>();

// Caching resolveCfcSchemaRef also makes its result identity-STABLE per
// (fullSchema, ref), which lets downstream identity-keyed hash/traverse caches
// hit instead of seeing a fresh spread per resolution.
const resolvedRefCache = new WeakMap<
  object,
  Map<string, JSONSchema | undefined>
>();

const hasDefinitionMap = (
  schema: JSONSchema,
): schema is JSONSchemaObj & { $defs: SchemaDefinitions } =>
  isObjectOrArray(schema) && isObjectNotArray(schema.$defs);

/**
 * Return the document root for `resolved`, the view a `$ref` resolved to,
 * given the root that owns the ref's target: the referrer's document for a
 * local ref, the target document for an embedded or external one.
 *
 * A `#/$defs/<name>` ref names a definition of the document root, as JSON
 * Schema resolves it: `#` is the root of the schema resource, and this
 * runtime supports no keyword that starts another one below it. Descending
 * into a subschema therefore keeps the root, whatever `$defs` the subschema
 * declares of its own; a `$defs` below the root is inert. Only resolution
 * moves the root, and it mints views that are documents of their own. A
 * target flattened with the siblings of its ref site carries a merged
 * definition map, and the ref-site names in it exist nowhere else; a view
 * carrying a map other than the owning root's is therefore its own root. A
 * definition body carrying the owning root's exact map, which is what
 * resolution attaches so the body resolves standalone, opens no new
 * document, which keeps the root identity that cycle guards key on stable
 * across hops.
 */
export const cfcSchemaResolvedRoot = (
  resolved: JSONSchema,
  owningRoot: JSONSchema,
): JSONSchema =>
  hasDefinitionMap(resolved) &&
    !(isObjectOrArray(owningRoot) && resolved.$defs === owningRoot.$defs)
    ? resolved
    : owningRoot;

/** The `#/$defs/<name>` reference naming the local definition `name`. */
export const encodedLocalDefinitionRef = (name: string): string =>
  encodeJsonPointer(["#", "$defs", name]);

const localDefinitionNamesInScope = (
  schema: JSONSchemaObj,
  definitions: SchemaDefinitions,
): Set<string> => {
  const names = new Set(Object.keys(definitions));
  const collect = (fragment: JSONSchema): void => {
    if (!isObjectOrArray(fragment)) return;
    if (typeof fragment.$ref === "string") {
      const name = localDefinitionName(fragment.$ref);
      if (name !== undefined) names.add(name);
    }
    forEachSubschema(fragment, collect, ALL_SUBSCHEMAS);
  };
  collect(schema);
  for (const definition of Object.values(definitions)) collect(definition);
  return names;
};

/**
 * Namespace one flattened document so its local refs cannot bind to names
 * owned by another document. Every local ref below `schema`, and every one
 * inside `definitions`, belongs to the one document being renamed; `tag`
 * names its origin in the renamed definitions.
 */
const namespaceLocalDefinitionScope = (
  schema: JSONSchemaObj,
  definitions: SchemaDefinitions,
  reservedNames: ReadonlySet<string>,
  tag: string,
): JSONSchemaObj => {
  const names = localDefinitionNamesInScope(schema, definitions);
  if (names.size === 0) {
    // No local name crosses the document boundary. An empty map would mint
    // a new document identity on each visit to an external recursive branch.
    const { $defs: _empty, ...body } = schema;
    return body;
  }

  const usedNames = new Set([...reservedNames, ...names]);
  const renamed = new Map<string, string>();
  let suffix = 0;
  for (const name of [...names].toSorted(utf8Compare)) {
    let candidate: string;
    do candidate = `__cfc_${tag}_${suffix++}_${name}`; while (
      usedNames.has(candidate)
    );
    usedNames.add(candidate);
    renamed.set(name, candidate);
  }

  const rewritten = renameLocalDefinitionRefs(schema, renamed) as JSONSchemaObj;
  const rewrittenDefinitions = Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      renamed.get(name)!,
      renameLocalDefinitionRefs(definition, renamed),
    ]),
  );
  return { ...rewritten, $defs: rewrittenDefinitions };
};

// `schema` with every `#/$defs/<name>` ref below it whose name `renamed`
// maps rewritten to the mapped name. A definition map below `schema` is
// renamed with it, keys and bodies: a resolved body carries the map of the
// document it came from (`resolveCfcSchemaRef()`), and a map left under the
// old names beside refs rewritten to the new ones would disagree with the
// document's root map for as long as the document lives.
const renameLocalDefinitionRefs = (
  schema: JSONSchema,
  renamed: ReadonlyMap<string, string>,
): JSONSchema => {
  if (!isObjectOrArray(schema)) return schema;
  let result = schema;
  if (typeof schema.$ref === "string") {
    const name = localDefinitionName(schema.$ref);
    const nextName = name === undefined ? undefined : renamed.get(name);
    if (nextName !== undefined) {
      result = { ...result, $ref: encodedLocalDefinitionRef(nextName) };
    }
  }
  if (isObjectNotArray(schema.$defs)) {
    result = {
      ...result,
      $defs: Object.fromEntries(
        Object.entries(schema.$defs as SchemaDefinitions).map((
          [name, definition],
        ) => [
          renamed.get(name) ?? name,
          renameLocalDefinitionRefs(definition, renamed),
        ]),
      ),
    };
  }
  return mapSubschemas(
    result,
    (child) => renameLocalDefinitionRefs(child, renamed),
    ALL_SUBSCHEMAS,
  );
};

/**
 * Partitions the definitions of one map into classes of definitions that
 * mean the same schema, and returns each name's class number. Two definitions
 * share a class when their bodies are equal once every local ref in them is
 * read as the class of the definition it names, recursion included: the
 * names start in one class, and each round splits a class by the hash of its
 * members' bodies with refs written as class numbers, until no class splits.
 * Two copies of a self-referential definition then share a class, where
 * comparing their bodies name by name never would. A ref naming no
 * definition in `definitions` stays as written, so it matches only the same
 * ref. The bodies carry no `$defs` below them; a caller holding bodies that
 * do strips those first, since they are inert.
 */
const definitionEquivalenceClasses = (
  definitions: ReadonlyMap<string, JSONSchema>,
): Map<string, number> => {
  const names = [...definitions.keys()];

  // A class is written into a ref under a marker no name the definitions
  // refer to begins with, so a ref written as a class can never read as a
  // ref to a definition, resolved or not, that happens to carry that text.
  const referenced = localDefinitionNamesInScope(
    {},
    Object.fromEntries(definitions),
  );
  let leadingNuls = 0;
  for (const name of referenced) {
    let count = 0;
    while (count < name.length && name.charCodeAt(count) === 0) count++;
    if (count > leadingNuls) leadingNuls = count;
  }
  const marker = "\u0000".repeat(leadingNuls + 1);

  // A round's key carries the class the name was in, so a class only ever
  // splits, and an unchanged count is an unchanged partition.
  let classOf = new Map<string, number>(names.map((name) => [name, 0]));
  let classCount = 1;
  while (true) {
    const spelling = new Map<string, string>(
      names.map((name) => [name, `${marker}${classOf.get(name)}`]),
    );
    const classByKey = new Map<string, number>();
    const next = new Map<string, number>();
    for (const name of names) {
      const key = `${classOf.get(name)}:${
        hashStringOf(
          renameLocalDefinitionRefs(
            definitions.get(name)!,
            spelling,
          ) as FabricValue,
        )
      }`;
      let id = classByKey.get(key);
      if (id === undefined) {
        id = classByKey.size;
        classByKey.set(key, id);
      }
      next.set(name, id);
    }
    classOf = next;
    if (classByKey.size === classCount) return classOf;
    classCount = classByKey.size;
  }
};

/**
 * Merge the definition maps of `fragments` into one map, and return the
 * fragments without theirs. Each fragment is a self-contained view whose
 * `$defs` holds the closure its local refs reach, which is how
 * `schemaAtPath()` leaves a union arm.
 *
 * Fragments of one document carry the same definition under a name, and
 * their maps merge as they are. A fragment whose map defines a name
 * differently comes from another document — an arm that resolved through a
 * `cid:` ref into a cyclic group — and its whole map is renamed, refs and
 * all, so the merged map keeps the two meanings apart. A definition a later
 * fragment brings that means the same schema as one the merged map already
 * holds, by `definitionEquivalenceClasses()`, is not added: the fragment's
 * refs to it name the one already there. So hoisting a fragment against a
 * map that already took in its definitions adds nothing and names nothing
 * new. A fragment carrying no map is returned as it is.
 */
export const hoistCfcSchemaDefs = (
  fragments: readonly JSONSchema[],
): {
  fragments: JSONSchema[];
  definitions: SchemaDefinitions | undefined;
} => {
  // Accumulated as a `Map` so that a definition named `__proto__` is an entry
  // like any other rather than a prototype assignment.
  let merged: Map<string, JSONSchema> | undefined;
  const hoisted = fragments.map((fragment): JSONSchema => {
    if (!hasDefinitionMap(fragment)) return fragment;
    const { $defs: map, ...body } = fragment;
    const conflicts = merged !== undefined &&
      Object.entries(map).some(([name, definition]) => {
        const existing = merged!.get(name);
        return existing !== undefined && existing !== definition &&
          !fabricAwareEqual(existing, definition);
      });
    let stripped: JSONSchemaObj = body;
    let additions: SchemaDefinitions = map;
    if (conflicts) {
      const { $defs: renamed, ...renamedBody } = namespaceLocalDefinitionScope(
        body,
        map,
        new Set(merged!.keys()),
        "hoisted",
      );
      stripped = renamedBody;
      additions = renamed!;
    }
    if (merged === undefined) {
      merged = new Map(Object.entries(additions));
      return stripped;
    }
    const held = merged;
    const newNames = Object.keys(additions).filter((name) => !held.has(name));
    if (newNames.length === 0) return stripped;
    const union = new Map<string, JSONSchema>();
    for (const [name, definition] of held) {
      union.set(name, pruneCfcSchemaDefinitionsInternal(definition, false));
    }
    for (const name of newNames) {
      union.set(
        name,
        pruneCfcSchemaDefinitionsInternal(additions[name], false),
      );
    }
    const classes = definitionEquivalenceClasses(union);
    // The first held name of each class is the one its later members take.
    const heldNames = new Map<number, string>();
    for (const name of held.keys()) {
      const index = classes.get(name)!;
      if (!heldNames.has(index)) heldNames.set(index, name);
    }
    const renamed = new Map<string, string>();
    for (const name of newNames) {
      const heldName = heldNames.get(classes.get(name)!);
      if (heldName !== undefined) renamed.set(name, heldName);
    }
    for (const name of newNames) {
      if (renamed.has(name)) continue;
      held.set(name, renameLocalDefinitionRefs(additions[name], renamed));
    }
    return renameLocalDefinitionRefs(stripped, renamed) as JSONSchemaObj;
  });
  return {
    fragments: hoisted,
    definitions: merged === undefined ? undefined : Object.fromEntries(merged),
  };
};

const addRefs = (target: Set<string>, source: ReadonlySet<string>): void => {
  for (const ref of source) target.add(ref);
};

const summarizeCfcSchemaRefs = (schema: JSONSchema): SchemaRefSummary => {
  if (!isObjectOrArray(schema)) return EMPTY_REF_SUMMARY;
  const cached = schemaRefSummaryCache.get(schema);
  if (cached !== undefined) return cached;

  // Most fragments hold no ref, so a set is made only once there is a ref to
  // hold, and a fragment whose one child holds all of them shares the child's.
  let all: ReadonlySet<string> = EMPTY_REFS;
  let localDefinitions: ReadonlySet<string> = EMPTY_REFS;
  let ownsAll = false;
  let ownsLocal = false;
  const addAll = (refs: ReadonlySet<string>): void => {
    if (refs.size === 0) return;
    if (all === EMPTY_REFS) {
      all = refs;
    } else {
      if (!ownsAll) {
        all = new Set(all);
        ownsAll = true;
      }
      addRefs(all as Set<string>, refs);
    }
  };
  const addLocal = (names: ReadonlySet<string>): void => {
    if (names.size === 0) return;
    if (localDefinitions === EMPTY_REFS) {
      localDefinitions = names;
    } else {
      if (!ownsLocal) {
        localDefinitions = new Set(localDefinitions);
        ownsLocal = true;
      }
      addRefs(localDefinitions as Set<string>, names);
    }
  };
  if (schema.$ref !== undefined) {
    addAll(new Set([schema.$ref]));
    const name = localDefinitionName(schema.$ref);
    if (name !== undefined) addLocal(new Set([name]));
  }
  // A child's own `$defs` opens no scope (see `cfcSchemaResolvedRoot()`), so
  // the names its refs resolve against are this fragment's document's too.
  forEachSubschema(schema, (child) => {
    const childSummary = summarizeCfcSchemaRefs(child);
    addAll(childSummary.all);
    addLocal(childSummary.localDefinitions);
  }, ALL_SUBSCHEMAS);

  const summary: SchemaRefSummary = { all, localDefinitions };
  if (isDeepFrozen(schema)) schemaRefSummaryCache.set(schema, summary);
  return summary;
};

export const findCfcSchemaRefs = (
  schema: JSONSchema,
  refSet: Set<string> = new Set<string>(),
): void => {
  addRefs(refSet, summarizeCfcSchemaRefs(schema).all);
};

// Whether `schema` can take `inheritedDefinitions` at all: an object schema
// offered a definition map it does not already carry. A definition map is a
// non-array record; an array would resolve indices as member names.
const canInheritDefs = (
  schema: JSONSchema,
  inheritedDefinitions: SchemaDefinitions | undefined,
): schema is JSONSchemaObj =>
  isObjectOrArray(schema) && isObjectNotArray(inheritedDefinitions) &&
  schema.$defs !== inheritedDefinitions;

// Whether a `#/$defs/<name>` ref anywhere below `schema` names a definition
// of its document, dormant `$defs` bodies excluded. A ref under a child that
// declares its own `$defs` counts: that `$defs` is inert below the document
// root (see `cfcSchemaResolvedRoot()`).
const hasLocalDefinitionRef = (schema: JSONSchema): boolean =>
  summarizeCfcSchemaRefs(schema).localDefinitions.size > 0;

// Views `cfcSchemaWithInheritedDefs()` minted for a deep-frozen fragment, per
// fragment per definition map. A fragment read repeatedly under one document
// then keeps one identity, which downstream identity-keyed caches depend on.
// A view whose map is deep-frozen too is deep-frozen itself: its parts are
// then all frozen, so freezing costs the root object alone, and the memos
// keyed on a resolution's root hold for a resolution rooted at the view.
const inheritedDefsViews = new WeakMap<object, WeakMap<object, JSONSchema>>();

const memoizedInheritedDefsView = (
  schema: JSONSchemaObj,
  key: object,
  mint: () => JSONSchema,
): JSONSchema => {
  if (!isDeepFrozen(schema)) return mint();
  let byMap = inheritedDefsViews.get(schema);
  if (byMap === undefined) {
    byMap = new WeakMap();
    inheritedDefsViews.set(schema, byMap);
  }
  let view = byMap.get(key);
  if (view === undefined) {
    view = isDeepFrozen(key) ? deepFreeze(mint()) : mint();
    byMap.set(key, view);
  }
  return view;
};

// The document `cfcSchemaDocumentOf()` minted for a deep-frozen definition
// map, and the one it hands out for no map at all.
const definitionDocuments = new WeakMap<object, JSONSchemaObj>();
const EMPTY_DEFINITION_DOCUMENT: JSONSchemaObj = deepFreeze({});

/**
 * Return the document whose `$defs` is `definitions`, for resolving a local
 * ref against a map held apart from the schema that declared it. A
 * deep-frozen map gets one deep-frozen document, kept per map, so the memos
 * keyed on a resolution's root hold across every resolution against that
 * map; no map at all gets one shared empty document. A map that is not
 * deep-frozen is never a memo key, so its document is minted fresh.
 */
export const cfcSchemaDocumentOf = (
  definitions: SchemaDefinitions | undefined,
): JSONSchemaObj => {
  if (definitions === undefined) return EMPTY_DEFINITION_DOCUMENT;
  if (!isDeepFrozen(definitions)) return { $defs: definitions };
  let document = definitionDocuments.get(definitions);
  if (document === undefined) {
    document = deepFreeze({ $defs: definitions });
    definitionDocuments.set(definitions, document);
  }
  return document;
};

/**
 * Return `schema` carrying the definitions its local refs resolve against.
 *
 * A fragment evaluated apart from the schema that encloses it — a union arm, a
 * property, an array's element schema — no longer reaches the `$defs` its
 * `#/$defs/<name>` refs name. This attaches `inheritedDefinitions` to the
 * fragment, in place of any `$defs` it declares of its own, which is inert
 * below the enclosing document's root (see `cfcSchemaResolvedRoot()`). With
 * nothing to inherit the fragment is returned as it is: a caller holding no
 * map may be holding a document in reference form, and a fragment carrying a
 * map of its own is then the self-contained view resolution minted, which
 * the consumer reads as a document.
 *
 * A deep-frozen fragment is scanned for such a ref first, and comes back as
 * the same object when it has none — its refs are all embedded or external,
 * which resolve against their own documents — so identity-keyed caches keep
 * hitting; a view minted for a deep-frozen fragment is memoized per map for
 * the same reason, and is deep-frozen when the map is, so a resolution
 * rooted at it is memoized too. The scan memoizes by identity, which is
 * what makes it cheap there. A fragment that is not deep-frozen gets the
 * definitions without the scan: unmemoized, the scan walks the whole
 * subtree on every call, and an unfrozen object is never a cache key, so
 * nothing is lost by attaching definitions the fragment turns out not to
 * need.
 */
export const cfcSchemaWithInheritedDefs = (
  schema: JSONSchema,
  inheritedDefinitions: SchemaDefinitions | undefined,
): JSONSchema => {
  if (
    !isObjectNotArray(inheritedDefinitions) ||
    !canInheritDefs(schema, inheritedDefinitions) ||
    (isDeepFrozen(schema) && !hasLocalDefinitionRef(schema))
  ) {
    return schema;
  }
  const definitions = inheritedDefinitions;
  return memoizedInheritedDefsView(
    schema,
    definitions,
    () => ({ ...schema, $defs: definitions }),
  );
};

// Views `definitionBodyWithDefs()` minted for a deep-frozen definition body
// under a deep-frozen map, per body per map, whichever document the ref was
// resolved from. Every document carrying one map then resolves a definition
// to one object, and interning that object hashes the map it carries once
// rather than once per document. The map's identity is what a view is keyed
// by: a view carrying the owning root's exact map opens no new document (see
// `cfcSchemaResolvedRoot()`), and that holds across documents only where
// they share the map itself. The view's parts are all frozen, so freezing it
// costs the root object alone.
const definitionViews = new WeakMap<object, WeakMap<object, JSONSchema>>();

const memoizedDefinitionView = (
  body: JSONSchemaObj,
  definitions: SchemaDefinitions,
): JSONSchema => {
  let byMap = definitionViews.get(body);
  if (byMap === undefined) {
    byMap = new WeakMap();
    definitionViews.set(body, byMap);
  }
  let view = byMap.get(definitions);
  if (view === undefined) {
    view = deepFreeze({ ...body, $defs: definitions });
    byMap.set(definitions, view);
  }
  return view;
};

// The resolver's form of the same: a resolved definition body carries the
// document's map when a local ref needs it, frozen or not. Its result is the
// canonical view of that definition, and `$defs` it does not need would
// change what that view hashes to, so a body with no local ref takes nothing,
// and one carrying an inert `$defs` of its own has that removed.
const definitionBodyWithDefs = (
  body: JSONSchema,
  documentDefinitions: SchemaDefinitions | undefined,
): JSONSchema => {
  if (
    !isObjectNotArray(documentDefinitions) ||
    !canInheritDefs(body, documentDefinitions)
  ) {
    return body;
  }
  if (hasLocalDefinitionRef(body)) {
    return isDeepFrozen(body) && isDeepFrozen(documentDefinitions)
      ? memoizedDefinitionView(body, documentDefinitions)
      : { ...body, $defs: documentDefinitions };
  }
  if (body.$defs === undefined) return body;
  const { $defs: _inert, ...rest } = body;
  return rest;
};

const definitionIndexFor = (
  definitions: SchemaDefinitions,
): { index: DefinitionIndex; cacheable: boolean } => {
  const cacheable = isDeepFrozen(definitions);
  if (!cacheable) {
    return {
      index: { dependencies: new Map(), subsets: new Map() },
      cacheable,
    };
  }
  let index = definitionIndexCache.get(definitions);
  if (index === undefined) {
    index = { dependencies: new Map(), subsets: new Map() };
    definitionIndexCache.set(definitions, index);
  }
  return { index, cacheable };
};

const definitionDependencies = (
  name: string,
  definitions: SchemaDefinitions,
  index: DefinitionIndex,
): ReadonlySet<string> => {
  const cached = index.dependencies.get(name);
  if (cached !== undefined) return cached;
  const definition = definitions[name];
  // resolveCfcSchemaRef() attaches the containing definition map to a reached
  // definition body, so every local ref below the body depends on this map.
  const dependencies = definition === undefined
    ? EMPTY_REFS
    : summarizeCfcSchemaRefs(definition).localDefinitions;
  index.dependencies.set(name, dependencies);
  return dependencies;
};

const definitionSetKey = (names: readonly string[]): string => {
  let key = "";
  for (const name of names) key += `${name.length}:${name}`;
  return key;
};

/**
 * Return the minimal `$defs` map needed by `schema`'s local refs, selected
 * from `definitions`, the map of the document `schema` sits in. A caller
 * holding the document itself passes its own `$defs`; one holding a fragment
 * passes the enclosing document's, since a `$defs` the fragment declares is
 * inert there. Returns `undefined` when the document declares no map.
 *
 * Definition bodies are scanned lazily and only when reachable. Frozen schema
 * fragments populate reusable ref summaries bottom-up, while frozen definition
 * maps reuse dependency closures and canonical subset objects across callers.
 */
export const selectReferencedCfcSchemaDefs = (
  schema: JSONSchema,
  definitions: SchemaDefinitions | undefined,
): SchemaDefinitions | undefined => {
  if (!isObjectOrArray(schema) || !isObjectNotArray(definitions)) {
    return undefined;
  }

  const initial = summarizeCfcSchemaRefs(schema).localDefinitions;
  if (initial.size === 0) return undefined;

  const { index, cacheable } = definitionIndexFor(definitions);
  const needed = new Set<string>();
  const pending = [...initial];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (needed.has(name) || !Object.hasOwn(definitions, name)) continue;
    needed.add(name);
    for (
      const dependency of definitionDependencies(
        name,
        definitions,
        index,
      )
    ) {
      if (!needed.has(dependency)) pending.push(dependency);
    }
  }
  if (needed.size === 0) return undefined;

  const names = [...needed].toSorted(utf8Compare);
  const key = definitionSetKey(names);
  if (cacheable) {
    const cached = index.subsets.get(key);
    if (cached !== undefined) return cached;
  }

  const subset = Object.fromEntries(
    names.map((name) => [name, definitions[name]]),
  ) as Record<string, JSONSchema>;
  if (!cacheable) return subset;

  // Intern once so every derived schema sharing this closure also shares one
  // frozen, deterministically ordered `$defs` object.
  const holder = internSchema({ $defs: subset });
  const canonical = (holder as JSONSchemaObj).$defs!;
  index.subsets.set(key, canonical);
  return canonical;
};

// `atRoot` says whether `schema` is the document root. The root's `$defs` is
// pruned to what the document reaches; a `$defs` below the root is inert (see
// `cfcSchemaResolvedRoot()`) and is removed, its refs counting toward the
// root's map.
const pruneCfcSchemaDefinitionsInternal = (
  schema: JSONSchema,
  atRoot: boolean,
): JSONSchema => {
  // A boolean schema, and anything a schema cannot be, has no definitions to
  // prune and is returned as it arrived.
  if (!isObjectOrArray(schema)) return schema;
  const cacheable = isDeepFrozen(schema);
  const cache = atRoot ? prunedRootSchemaCache : prunedNestedSchemaCache;
  if (cacheable) {
    const cached = cache.get(schema);
    if (cached !== undefined) return cached;
  }

  // Only a `$defs` that is a definition map counts as one.
  const declaresMap = isObjectNotArray(schema.$defs);
  let result = mapSubschemas(
    schema,
    (child) => pruneCfcSchemaDefinitionsInternal(child, false),
    ALL_SUBSCHEMAS,
  );
  if (declaresMap) {
    let definitions: SchemaDefinitions | undefined;
    if (atRoot) {
      const selected = selectReferencedCfcSchemaDefs(schema, schema.$defs);
      definitions = selected;
      if (selected !== undefined) {
        let entries: [string, JSONSchema][] | undefined;
        const selectedEntries = Object.entries(selected);
        for (let index = 0; index < selectedEntries.length; index++) {
          const [name, definition] = selectedEntries[index];
          const pruned = pruneCfcSchemaDefinitionsInternal(definition, false);
          if (pruned !== definition) {
            entries ??= selectedEntries;
            entries[index] = [name, pruned];
          }
        }
        if (entries !== undefined) definitions = Object.fromEntries(entries);
      }
    }
    if (definitions !== schema.$defs) {
      const next = { ...result } as Record<string, unknown>;
      delete next.$defs;
      if (definitions !== undefined) next.$defs = definitions;
      result = next as JSONSchemaObj;
    }
  }
  const pruned = cacheable && result !== schema ? internSchema(result) : result;
  if (cacheable) cache.set(schema, pruned);
  return pruned;
};

/**
 * Remove definitions that cannot be reached from this schema document: the
 * entries of its map that nothing references, and every `$defs` below the
 * root, which is inert there.
 */
export const pruneCfcSchemaDefinitions = (schema: JSONSchema): JSONSchema =>
  pruneCfcSchemaDefinitionsInternal(schema, true);

/**
 * `schema` as a definition body: every `$defs` in it removed, since a map
 * below a document's root is inert, and one carried by a body stored in the
 * root's own map would hold that map inside itself.
 */
export const pruneCfcSchemaDefinitionBody = (schema: JSONSchema): JSONSchema =>
  pruneCfcSchemaDefinitionsInternal(schema, false);

// A name the hoist mints: `__cfc_<tag>_<n>_<name>` (`namespaceLocalDefinitionScope`).
const MINTED_DEFINITION_NAME = /^__cfc_[a-z_]+_\d+_/;

const isMintedDefinitionName = (name: string): boolean =>
  MINTED_DEFINITION_NAME.test(name);

/**
 * The canonical form of a schema document that is about to be persisted or
 * hashed: one definition map at the root, holding every definition the
 * author named, at most one minted definition per meaning the authored ones
 * do not already carry, and no minted definition the document does not
 * reach.
 *
 * A merge of two envelopes keeps both documents' definitions apart by
 * renaming one side's map wholesale (`hoistCfcSchemaDefs()`), and a
 * resolved view attaches the document's map to each body it expands
 * (`resolveCfcSchemaRef()`). Persisted as they are, those two leave a
 * document whose root map holds the same definition under many names and
 * whose bodies each carry a copy of that map, and every later merge adds
 * another round of both. This folds the minted names of content-identical
 * definitions onto one name, rewrites every local ref to the surviving
 * name, drops the nested maps (inert under the root's,
 * `pruneCfcSchemaDefinitions()`), and drops the minted definitions nothing
 * reaches. A definition the author named is kept whether or not anything
 * refers to it, and is never folded onto another authored name. A `$defs`
 * below the root is inert whatever it holds: a `#/$defs/<name>` ref names a
 * definition of the document root (`docs/specs/json_schema.md`), so
 * dropping the map rebinds nothing.
 *
 * Two definitions mean the same when `definitionEquivalenceClasses()` puts
 * them in one class, recursion included.
 */
export const canonicalizeCfcSchemaDocument = (
  schema: JSONSchema,
): JSONSchema => {
  if (!isObjectNotArray(schema) || !isObjectNotArray(schema.$defs)) {
    return schema;
  }
  // The unchanged-write fast path (`mergeStoredCfcEnvelope`) asks about the
  // stored envelope, interned and deep-frozen, on every write to its
  // document, so that answer is kept by identity. A merge's own document is
  // freshly built, never asked about twice, and not kept.
  const cacheable = isDeepFrozen(schema);
  if (cacheable) {
    const cached = canonicalDocumentCache.get(schema);
    if (cached !== undefined) return cached;
  }
  const canonical = canonicalizeCfcSchemaDocumentUncached(schema);
  if (!cacheable) return canonical;
  // Interned, so what the cache hands out is frozen and shared; a document
  // already in canonical form interns to itself.
  const interned = internSchema(canonical);
  canonicalDocumentCache.set(schema, interned);
  return interned;
};

const canonicalDocumentCache = new WeakMap<object, JSONSchema>();

const canonicalizeCfcSchemaDocumentUncached = (
  schema: JSONSchemaObj,
): JSONSchema => {
  // Held as `Map`s throughout, so that a definition named `__proto__` is an
  // entry like any other rather than a prototype assignment. Each definition
  // is taken without the maps below it, which are inert, so that neither
  // the comparison nor the renaming ever sees one.
  const root = new Map(
    Object.entries(schema.$defs as SchemaDefinitions).toSorted((
      [left],
      [right],
    ) => utf8Compare(left, right)).map(([name, definition]) => [
      name,
      pruneCfcSchemaDefinitionsInternal(definition, false),
    ]),
  );
  const names = [...root.keys()];

  const classOf = definitionEquivalenceClasses(root);

  // One surviving name per class: every authored name of the class stays,
  // and the class's minted names fold onto its first authored name, or onto
  // the first minted one where the class has no authored name.
  const members = new Map<number, string[]>();
  for (const name of names) {
    const id = classOf.get(name)!;
    const list = members.get(id);
    if (list === undefined) members.set(id, [name]);
    else list.push(name);
  }
  const renamed = new Map<string, string>();
  for (const list of members.values()) {
    const authored = list.filter((name) => !isMintedDefinitionName(name));
    const keep = authored[0] ?? list[0];
    for (const name of list) {
      if (name !== keep && isMintedDefinitionName(name)) {
        renamed.set(name, keep);
      }
    }
  }

  const rename = (fragment: JSONSchema): JSONSchema =>
    renamed.size === 0
      ? fragment
      : renameLocalDefinitionRefs(fragment, renamed);
  const { $defs: _map, ...body } = schema;
  const definitions = new Map<string, JSONSchema>();
  for (const name of names) {
    if (renamed.has(name)) continue;
    definitions.set(name, rename(root.get(name)!));
  }
  const pruned = pruneCfcSchemaDefinitions({
    ...(rename(body) as JSONSchemaObj),
    $defs: Object.fromEntries(definitions),
  });
  if (!isObjectNotArray(pruned)) return pruned;

  // A definition the author named stays whether or not anything refers to
  // it, pruned below the root as any other, with what it refers to.
  const kept = new Map<string, JSONSchema>(
    Object.entries((pruned.$defs ?? {}) as SchemaDefinitions),
  );
  let retained = false;
  const definitionMap = Object.fromEntries(definitions);
  for (const [name, definition] of definitions) {
    if (isMintedDefinitionName(name) || kept.has(name)) continue;
    retained = true;
    kept.set(name, pruneCfcSchemaDefinitionsInternal(definition, false));
    const closure = selectReferencedCfcSchemaDefs(definition, definitionMap);
    if (closure !== undefined) {
      for (const [dependency, body] of Object.entries(closure)) {
        if (!kept.has(dependency)) {
          kept.set(
            dependency,
            pruneCfcSchemaDefinitionsInternal(body, false),
          );
        }
      }
    }
  }
  if (!retained) return pruned;
  return {
    ...pruned,
    $defs: Object.fromEntries(
      [...kept].toSorted(([left], [right]) => utf8Compare(left, right)),
    ),
  };
};

// Member views of cyclic-group documents, per document per member name. A
// fragment ref resolves to the member with its refs into the group rewritten
// to external form, and that view is minted once so downstream identity-keyed
// caches see one object rather than a fresh rewrite per resolution.
// Documents are interned before entering the registry, so keying weakly on
// the document is stable.
let memberViewCache = new WeakMap<
  JSONSchemaObj,
  Map<string, JSONSchema | undefined>
>();
// Both caches memoize resolution SUCCESSES that embed registry content, so
// a registry clear (last lease out) swaps them for empty ones — a success
// cached in one lease epoch must not keep resolving in the next.
onSchemaRegistryClear(() => {
  memberViewCache = new WeakMap();
  resolvedRefsCache = new WeakMap();
});

// Look up the registered document an external ref names. Returns `undefined`
// on a miss — an unregistered document may still arrive, which is exactly why
// the arrival-curable misses bump the external-resolution miss counter:
// derived caches memoize only across a derivation the counter did not move
// in.
const lookupExternalCfcSchemaDocument = (
  parsed: ExternalSchemaRef,
): JSONSchema | undefined => {
  const document = lookupSchemaDocument(parsed.taggedHash);
  if (document === undefined) {
    noteExternalResolutionMiss();
    logger.debug("cfc", () => [
      "Schema document not (yet) registered: ",
      parsed.taggedHash,
    ]);
    return undefined;
  }
  // An incomplete closure is a miss, exactly like an unregistered root:
  // resolving the root while a child is absent would let derived caches
  // (IFC scans, standardized forms) memoize a result computed over a hole,
  // keyed by the root's stable identity — and the child's later arrival
  // would never invalidate them. Completeness is monotonic, so this gate
  // opens by itself once the closure lands.
  if (!isSchemaDocumentClosureComplete(parsed.taggedHash)) {
    noteExternalResolutionMiss();
    logger.debug("cfc", () => [
      "Schema document closure not (yet) complete: ",
      parsed.taggedHash,
    ]);
    return undefined;
  }
  return document;
};

// A registered document a fragment ref can address into: one holding a
// definition map. A definition map is a non-array record; an array would
// resolve indices as member names.
const isGroupDocument = (
  document: JSONSchema,
): document is JSONSchemaObj & { $defs: SchemaDefinitions } =>
  isObjectNotArray(document) && isObjectNotArray(document.$defs);

// The member of `group` a fragment ref names, or `undefined` when it names no
// member.
const externalCfcSchemaMember = (
  group: JSONSchemaObj & { $defs: SchemaDefinitions },
  parsed: ExternalSchemaRef & { defName: string },
): JSONSchema | undefined => {
  const member = Object.hasOwn(group.$defs, parsed.defName)
    ? group.$defs[parsed.defName]
    : undefined;
  if (member === undefined || !isSubschema(member)) {
    logger.warn("cfc", () => [
      "Fragment ref names no member of its schema document: ",
      `${parsed.taggedHash}#/$defs/${parsed.defName}`,
    ]);
    return undefined;
  }
  return member;
};

// The group a fragment ref addresses into, or `undefined` for a ref into a
// document that holds no definition map.
const lookupExternalCfcSchemaGroup = (
  parsed: ExternalSchemaRef & { defName: string },
): (JSONSchemaObj & { $defs: SchemaDefinitions }) | undefined => {
  const document = lookupExternalCfcSchemaDocument(parsed);
  if (document === undefined) return undefined;
  if (!isGroupDocument(document)) {
    logger.warn("cfc", () => [
      "Fragment ref into a schema document without `$defs`: ",
      parsed.taggedHash,
    ]);
    return undefined;
  }
  return document;
};

/**
 * Resolve an external `cid:` ref through the schema-document registry, to
 * the document itself or to a view of the member a fragment ref names.
 * Returns `undefined` on a miss, which a later arrival can cure.
 */
const resolveExternalCfcSchemaRef = (
  parsed: ExternalSchemaRef,
): JSONSchema | undefined => {
  if (parsed.defName === undefined) {
    return lookupExternalCfcSchemaDocument(parsed);
  }
  const defName = parsed.defName;
  const group = lookupExternalCfcSchemaGroup({ ...parsed, defName });
  if (group === undefined) return undefined;
  let views = memberViewCache.get(group);
  if (views === undefined) {
    views = new Map();
    memberViewCache.set(group, views);
  }
  if (views.has(defName)) return views.get(defName);
  const member = externalCfcSchemaMember(group, { ...parsed, defName });
  let view: JSONSchema | undefined;
  if (member !== undefined) {
    const externalized = externalizeGroupMember(member, parsed.taggedHash);
    view = externalized === member ? member : internSchema(externalized);
  }
  views.set(defName, view);
  return view;
};

// Self-contained forms of group members, per document per member name, for
// `resolveExternalCfcSchemaRefAsDocument()`; minted once so a walk memoizing
// by input identity sees one object per member.
let memberDocumentCache = new WeakMap<
  JSONSchemaObj,
  Map<string, JSONSchema | undefined>
>();
onSchemaRegistryClear(() => {
  memberDocumentCache = new WeakMap();
});

/**
 * Resolve an external `cid:` ref to a self-contained document: the document
 * itself, or for a fragment ref the member's body carrying the group's whole
 * `$defs`, its refs into the group left local. A walk that rewrites a
 * document and re-externalizes the result — the link sanitizer stripping
 * `asCell` — takes this form, so that the group's other members are rewritten
 * with it and its cycles are local ones the walk already handles. Returns
 * `undefined` on a registry miss, or for a fragment ref that names no member.
 */
export const resolveExternalCfcSchemaRefAsDocument = (
  schemaRef: string,
): JSONSchema | undefined => {
  const parsed = parseExternalSchemaRef(schemaRef);
  if (parsed === undefined) return undefined;
  if (parsed.defName === undefined) {
    return lookupExternalCfcSchemaDocument(parsed);
  }
  const defName = parsed.defName;
  const group = lookupExternalCfcSchemaGroup({ ...parsed, defName });
  if (group === undefined) return undefined;
  let forms = memberDocumentCache.get(group);
  if (forms === undefined) {
    forms = new Map();
    memberDocumentCache.set(group, forms);
  }
  if (forms.has(defName)) return forms.get(defName);
  const member = externalCfcSchemaMember(group, { ...parsed, defName });
  const form = member === undefined
    ? undefined
    : internSchema(definitionBodyWithDefs(member, group.$defs));
  forms.set(defName, form);
  return form;
};

// A member view carries no definition map of its own. Every `#/$defs/<name>`
// in the member's body names a definition of its group, so each is rewritten
// to the external `cid:<hash>#/$defs/<name>` form, which resolves through the
// registry wherever the view is later embedded — a narrowed schema places it
// below a root whose `$defs` is not the group's, and a local pointer there
// would name the wrong document. A `$defs` on the member itself is inert in
// the group document and is dropped from the view.
const externalizeGroupMember = (
  member: JSONSchema,
  taggedHash: string,
): JSONSchema => {
  const rewrite = (fragment: JSONSchema): JSONSchema => {
    if (!isObjectOrArray(fragment)) return fragment;
    let result = fragment;
    if (typeof fragment.$ref === "string") {
      const name = localDefinitionName(fragment.$ref);
      if (name !== undefined) {
        result = { ...result, $ref: formatExternalSchemaRef(taggedHash, name) };
      }
    }
    return mapSubschemas(result, rewrite, ALL_SUBSCHEMAS);
  };
  const rewritten = rewrite(member);
  if (!isObjectOrArray(rewritten) || rewritten.$defs === undefined) {
    return rewritten;
  }
  const { $defs: _inert, ...rest } = rewritten;
  return rest;
};

export const resolveCfcSchemaRef = (
  fullSchema: JSONSchema,
  schemaRef: string,
): JSONSchema | undefined => {
  if (Object.hasOwn(embeddedSchemas, schemaRef)) {
    return embeddedSchemas[schemaRef];
  }
  // External refs resolve through the registry and bypass the per-root cache
  // entirely: a hit is already one probe, and a MISS must never be memoized —
  // the document can arrive after the first failed lookup.
  const external = parseExternalSchemaRef(schemaRef);
  if (external !== undefined) return resolveExternalCfcSchemaRef(external);
  const cacheable = isObjectOrArray(fullSchema) && isDeepFrozen(fullSchema);
  if (cacheable) {
    const byRef = resolvedRefCache.get(fullSchema);
    if (byRef !== undefined && byRef.has(schemaRef)) {
      return byRef.get(schemaRef);
    }
  }
  const result = resolveCfcSchemaRefUncached(fullSchema, schemaRef);
  if (cacheable) {
    // The view is a document of its own wherever it carries a map other
    // than the referrer's, and the identity-keyed memos downstream — the
    // resolution of a `$ref` within a document, the narrowing of a path —
    // key on a deep-frozen root alone. Its parts are the frozen document's;
    // freezing it costs the root object and nothing below.
    deepFreeze(result);
    let byRef = resolvedRefCache.get(fullSchema as object);
    if (byRef === undefined) {
      byRef = new Map();
      resolvedRefCache.set(fullSchema as object, byRef);
    }
    byRef.set(schemaRef, result);
  }
  return result;
};

/** Return the owning schema root after following a ref chain. */
export const resolveCfcSchemaRefRoot = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
): JSONSchema => {
  let current = schema;
  let root = fullSchema;
  const seenRefs = new Map<JSONSchema, Set<string>>();
  while (isObjectOrArray(current) && typeof current.$ref === "string") {
    const ref = current.$ref;
    let refsForRoot = seenRefs.get(root);
    if (refsForRoot?.has(ref)) break;
    if (!refsForRoot) {
      refsForRoot = new Set();
      seenRefs.set(root, refsForRoot);
    }
    refsForRoot.add(ref);
    const next = resolveCfcSchemaRef(root, ref);
    if (next === undefined) break;
    // An embedded or external target is its own document: local refs inside
    // it bind to its map, never to the referrer's.
    const owningRoot = isEmbeddedCfcSchemaRef(ref) || isExternalSchemaRef(ref)
      ? next
      : root;
    root = cfcSchemaResolvedRoot(next, owningRoot);
    current = next;
  }
  return root;
};

const resolveCfcSchemaRefUncached = (
  fullSchema: JSONSchema,
  schemaRef: string,
): JSONSchema | undefined => {
  if (!schemaRef.startsWith("#")) {
    logger.warn("cfc", () => ["Unsupported $ref in schema: ", schemaRef]);
    return undefined;
  }
  const pathToDef = decodeJsonPointer(schemaRef);
  if (pathToDef[0] !== "#") {
    logger.warn(
      "cfc",
      () => ["Unsupported anchor $ref in schema: ", schemaRef],
    );
    return undefined;
  }
  if (!isRootDefsSchemaPointer(pathToDef)) {
    logger.warn("cfc", () => [
      "Unsupported local $ref in schema (only #/$defs/<name> is supported): ",
      schemaRef,
    ]);
    return undefined;
  }
  let schemaCursor: unknown = fullSchema;
  for (let i = 1; i < pathToDef.length; i++) {
    if (
      !isObjectOrArray(schemaCursor) ||
      !Object.hasOwn(schemaCursor, pathToDef[i])
    ) {
      logger.warn("cfc", () => [
        "Unresolved $ref in schema: ",
        schemaRef,
        fullSchema,
      ]);
      return undefined;
    }
    schemaCursor = schemaCursor[pathToDef[i]];
  }
  if (!isSubschema(schemaCursor)) {
    // A definition holding something a schema cannot be resolves no better than
    // a name the document does not carry.
    logger.warn("cfc", () => [
      "Non-schema target for $ref in schema: ",
      schemaRef,
      fullSchema,
    ]);
    return undefined;
  }
  return definitionBodyWithDefs(
    schemaCursor as JSONSchema,
    isObjectOrArray(fullSchema) ? fullSchema.$defs : undefined,
  );
};

// resolveCfcSchemaRefs results per (frozen schemaObj, frozen fullSchema)
// identity pair. The loop body builds a fresh `{...resolved, ...rest, $defs}`
// spread whenever a $ref schema carries extra keys (e.g. `{$ref, $defs}` —
// the rendererVDOMSchema read path), and that fresh object then re-paid a
// full content hash at downstream interning on every read. A sentinel marks
// `undefined` results so failed resolutions are memoized too.
const RESOLVED_UNDEFINED = Symbol("resolved-undefined");
let resolvedRefsCache = new WeakMap<
  object,
  WeakMap<object, JSONSchema | typeof RESOLVED_UNDEFINED>
>();

export const resolveCfcSchemaRefs = (
  schemaObj: JSONSchemaObj,
  fullSchema: JSONSchema = schemaObj,
): JSONSchema | undefined => {
  const cacheable = isDeepFrozen(schemaObj) &&
    (fullSchema === schemaObj ||
      (isObjectOrArray(fullSchema) && isDeepFrozen(fullSchema)));
  let byFull: WeakMap<object, JSONSchema | typeof RESOLVED_UNDEFINED>;
  if (cacheable) {
    const fullKey = fullSchema as object;
    let existing = resolvedRefsCache.get(schemaObj);
    if (existing === undefined) {
      existing = new WeakMap();
      resolvedRefsCache.set(schemaObj, existing);
    }
    byFull = existing;
    const cached = byFull.get(fullKey);
    if (cached !== undefined) {
      return cached === RESOLVED_UNDEFINED ? undefined : cached;
    }
    // Intern the result so the cached instance is canonical and frozen —
    // downstream identity-keyed caches then hit, and sharing it across callers
    // is safe. Primitive and `undefined` results intern to themselves.
    const missesBefore = externalResolutionMissCount();
    const raw = resolveCfcSchemaRefsUncached(schemaObj, fullSchema);
    const result = internSchema(raw);
    if (externalResolutionMissCount() !== missesBefore) {
      // A `cid:` resolution missed during this walk; the document can
      // arrive later, so nothing from this run may be pinned.
      return result;
    }
    byFull.set(fullKey, result === undefined ? RESOLVED_UNDEFINED : result);
    return result;
  }
  return resolveCfcSchemaRefsUncached(schemaObj, fullSchema);
};

const resolveCfcSchemaRefsUncached = (
  schemaObj: JSONSchemaObj,
  fullSchema: JSONSchema = schemaObj,
): JSONSchema | undefined => {
  const seenRefs = new Map<JSONSchema, Set<string>>();
  const pendingSiblings: {
    schema: JSONSchemaObj;
    root: JSONSchema;
  }[] = [];
  const mergePendingSiblings = (
    initial: JSONSchema,
    initialRoot: JSONSchema,
  ): JSONSchema => {
    let resolved = initial;
    let resolvedRoot = initialRoot;
    while (pendingSiblings.length > 0) {
      const { schema: siblings, root: siblingRoot } = pendingSiblings.pop()!;
      if (isObjectOrArray(resolved)) {
        // The target's document is `resolvedRoot`; a `$defs` on the target
        // below that document's map is inert, so the map comes from the root
        // whenever it declares one.
        const resolvedDefinitions = hasDefinitionMap(resolvedRoot)
          ? resolvedRoot.$defs
          : resolved.$defs;
        let scopedSiblings = siblings;
        let siblingDefinitions = isObjectOrArray(siblingRoot)
          ? siblingRoot.$defs
          : undefined;
        if (siblingRoot !== resolvedRoot) {
          // The `$ref` target and the ref-site siblings belong to different
          // documents. Carry only the definitions the siblings reach, so
          // unrelated definitions do not mint new scopes at recursive hops.
          // Unresolved local refs must still be namespaced even when that
          // closure is empty, to keep them from binding in the target.
          const targetDefinitions = isObjectOrArray(resolvedDefinitions)
            ? resolvedDefinitions
            : {};
          const refSiteDefinitions = selectReferencedCfcSchemaDefs(
            siblings,
            siblingDefinitions,
          ) ?? {};
          scopedSiblings = namespaceLocalDefinitionScope(
            siblings,
            refSiteDefinitions,
            localDefinitionNamesInScope(resolved, targetDefinitions),
            "ref_site",
          );
          siblingDefinitions = scopedSiblings.$defs;
        }
        // A flattened resolved view has one `$defs` slot even though refs in
        // the target and in its ref-site siblings may originate in different
        // documents. Ref-site names are namespaced above, leaving the
        // target's existing names authoritative.
        const definitions = isObjectOrArray(resolvedDefinitions) &&
            isObjectOrArray(siblingDefinitions) &&
            resolvedDefinitions !== siblingDefinitions
          ? { ...siblingDefinitions, ...resolvedDefinitions }
          : resolvedDefinitions ?? siblingDefinitions;
        resolved = {
          ...resolved,
          ...scopedSiblings,
          ...(definitions !== undefined && { $defs: definitions }),
        } as JSONSchemaObj;
      } else {
        resolved = {
          ...cfcSchemaToObject(resolved),
          ...siblings,
        } as JSONSchemaObj;
      }
      resolvedRoot = cfcSchemaResolvedRoot(resolved, resolvedRoot);
    }
    return resolved;
  };
  while (true) {
    const { $ref, ...rest } = schemaObj;
    if ($ref === undefined) {
      return mergePendingSiblings(schemaObj, fullSchema);
    }
    let refsForRoot = seenRefs.get(fullSchema);
    if (refsForRoot?.has($ref)) {
      return undefined;
    }
    if (!refsForRoot) {
      refsForRoot = new Set();
      seenRefs.set(fullSchema, refsForRoot);
    }
    refsForRoot.add($ref);
    const resolved = resolveCfcSchemaRef(fullSchema, $ref);
    if (resolved === undefined) {
      return undefined;
    }
    // As in resolveCfcSchemaRefRoot: an embedded or external target is its
    // own document.
    const owningRoot =
      Object.hasOwn(embeddedSchemas, $ref) || isExternalSchemaRef($ref)
        ? resolved
        : fullSchema;
    const resolvedRoot = cfcSchemaResolvedRoot(resolved, owningRoot);
    if (Object.keys(rest).length > 0) {
      // Delay ref-site siblings until the referenced target's own ref chain is
      // resolved in its document. Unwinding then merges the siblings, whose
      // refs belong to the ref site's document, without rebinding an
      // intermediate target.
      const siblings = rest as JSONSchemaObj;
      pendingSiblings.push({ schema: siblings, root: fullSchema });
    }
    if (typeof resolved === "boolean") {
      return mergePendingSiblings(resolved, resolvedRoot);
    }
    schemaObj = resolved;
    fullSchema = resolvedRoot;
  }
};

export const resolveCfcSchemaRefsOrThrow = (
  schemaObj: JSONSchemaObj,
  fullSchema: JSONSchema = schemaObj,
): JSONSchema => {
  if (!isObjectOrArray(fullSchema)) {
    throw new Error("Found $ref without fullSchema object");
  }
  const resolved = resolveCfcSchemaRefs(schemaObj, fullSchema);
  if (resolved === undefined) {
    const ref = Object.hasOwn(schemaObj, "$ref")
      ? schemaObj.$ref
      : debugStr`$quote${schemaObj}`;
    throw new Error(
      `Failed to resolve $ref: ${ref}. ` +
        (typeof ref === "string" && ref.startsWith("http")
          ? `External $ref URLs must be registered in embeddedSchemas (packages/runner/src/embedded-schemas.ts). ` +
            `If you added a new native type to NATIVE_TYPE_SCHEMAS in ` +
            `packages/schema-generator/src/formatters/native-type-formatter.ts, ` +
            `add its schema to embeddedSchemas as well.`
          : debugStr`Schema: $quote,long${schemaObj}`),
    );
  }
  return resolved;
};
