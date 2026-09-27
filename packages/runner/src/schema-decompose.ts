/**
 * Decomposition of a self-contained JSON Schema into content-addressed schema
 * documents, and its inverse. The design is
 * `docs/specs/content-addressed-schemas.md`; this module is the pure value
 * layer — nothing here reads or writes storage.
 *
 * A decomposition splits a schema at `$defs` granularity. Each definition that
 * stands alone becomes its own document, referenced by bare document id; a
 * definition's name is not part of its document, so structurally identical
 * definitions deduplicate regardless of what their schemas called them.
 * Definitions that reference each other cyclically stay together in one
 * document of the form `{ "$defs": { ... } }`, referenced with a
 * `#/$defs/<name>` fragment. Grouping every cycle into a single document is
 * what keeps the cross-document reference graph acyclic, and only over an
 * acyclic graph are the content hashes well-founded: each document's hash
 * covers the external refs it carries, so the root reference pins the exact
 * content of the whole closure.
 *
 * An embedded schema ref (a URL in the static table of
 * `./embedded-schemas.ts`) is an allowed leaf: every realm resolves it from
 * that table, so it hashes as ordinary document content and contributes
 * nothing to the closure.
 *
 * Decomposition refuses input it cannot represent faithfully — a `$ref`
 * outside the `#/$defs/<name>`, external-document, and embedded
 * vocabularies, a dangling local ref, a nested `$defs` scope, or the
 * deprecated `definitions` keyword — by throwing
 * {@link SchemaNotDecomposableError}. A writer catches that and falls back
 * to carrying the schema inline.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import {
  decodeJsonPointer,
  encodeJsonPointer,
} from "@commonfabric/utils/json-pointer";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { internSchema } from "@commonfabric/data-model-schema";
import {
  classifySchemaMetaValue,
  collectExternalSchemaRefHashes,
  formatExternalSchemaRef,
  isExternalSchemaRef,
  MalformedSchemaMetaError,
  parseExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import {
  forEachSubschema,
  isSubschema,
  mapSubschemas,
  type SchemaWalkOptions,
} from "@commonfabric/data-model-schema/schema-walk";
import { isEmbeddedCfcSchemaRef } from "./embedded-schemas.ts";
import {
  lookupSchemaDocument,
  onSchemaRegistryClear,
} from "./schema-registry.ts";

// Every walk in this module must be COMPLETE over the subschema keywords,
// including the never-emitted tier: a ref a walk misses is a ref the
// decomposition silently drops or fails to rewrite. `$defs` bodies are never
// reached through these walks — the decomposition handles definition scope
// itself.
const ALL_SUBSCHEMAS: SchemaWalkOptions = { includeUnused: true };

// Keywords that start or address a JSON Schema resource scope, including the
// 2019-09 recursive pair the dynamic keywords replaced. Decomposition refuses
// them all (see scanFragment).
const RESOURCE_SCOPE_KEYWORDS = [
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$recursiveAnchor",
  "$recursiveRef",
] as const;

/** The result of {@link decomposeSchema}. */
export type DecomposedSchema = {
  /**
   * The external reference the position carrying the schema stamps as
   * `{ "$ref": rootRef }` — `cid:<hash>`, or `cid:<hash>#/$defs/<name>` when
   * the root reduced to a single reference into a cyclic group.
   */
  readonly rootRef: string;

  /**
   * Every document in the closure, keyed by tagged hash, values interned.
   * Iteration order is dependency-first: a document precedes every document
   * that references it.
   */
  readonly documents: ReadonlyMap<string, JSONSchema>;
};

/** Thrown by {@link decomposeSchema} for input it cannot represent. */
export class SchemaNotDecomposableError extends Error {
  constructor(reason: string) {
    super(`Schema cannot be decomposed: ${reason}`);
    this.name = "SchemaNotDecomposableError";
  }
}

/**
 * The inline form of a schema in the `schema` metadata member grammar:
 * the reference form recomposes from the document it names, the inline
 * form is returned as it is, and the malformed form throws
 * {@link MalformedSchemaMetaError}. `lookup` supplies documents by tagged
 * hash; a missing document throws, like {@link recomposeSchema} — callers
 * that can tolerate a hole check closure completeness first and keep the
 * reference form.
 */
export function recomposeSchemaRefs(
  schema: JSONSchema,
  lookup: (taggedHash: string) => JSONSchema | undefined,
): JSONSchema {
  const form = classifySchemaMetaValue(schema);
  switch (form.kind) {
    case "reference":
      return internSchema(recomposeSchema(form.ref, lookup));
    case "malformed":
      throw new MalformedSchemaMetaError(form.reason);
    default:
      return schema;
  }
}

/** The `<name>` of a `#/$defs/<name>` ref, or `undefined` for any other. */
function localDefName(ref: string): string | undefined {
  if (!ref.startsWith("#")) return undefined;
  const pointer = decodeJsonPointer(ref);
  return (pointer.length === 3 && pointer[0] === "#" &&
      pointer[1] === "$defs" && pointer[2]!.length > 0)
    ? pointer[2]
    : undefined;
}

/**
 * Collects the local definition names referenced anywhere in `fragment`,
 * refusing every construct the decomposition cannot represent. `fragment` is
 * a root body or a definition body — never a `$defs` holder itself. The
 * decomposed form carries one definition map, at the root, so a `$defs`
 * inside a fragment has no place in it and is refused rather than dropped.
 */
function scanFragment(
  fragment: JSONSchema,
  defNames: ReadonlySet<string>,
  into: Set<string>,
): void {
  if (!isObjectNotArray(fragment)) return;
  if (fragment.$defs !== undefined) {
    throw new SchemaNotDecomposableError(
      "a subschema declares its own `$defs`",
    );
  }
  if (fragment.definitions !== undefined) {
    throw new SchemaNotDecomposableError(
      "the deprecated `definitions` keyword is present",
    );
  }
  // A `$id` starts a new JSON Schema resource scope, and the anchor and
  // dynamic-ref keywords address into one; rewriting `#/$defs/<name>` refs
  // across such a boundary would silently change their meaning. The schema
  // generator emits none of them.
  for (const keyword of RESOURCE_SCOPE_KEYWORDS) {
    if ((fragment as Record<string, unknown>)[keyword] !== undefined) {
      throw new SchemaNotDecomposableError(
        `the \`${keyword}\` keyword is present`,
      );
    }
  }
  if (typeof fragment.$ref === "string") {
    const name = localDefName(fragment.$ref);
    if (name !== undefined) {
      if (!defNames.has(name)) {
        throw new SchemaNotDecomposableError(
          `\`$ref\` names a definition that does not exist: \`${fragment.$ref}\``,
        );
      }
      into.add(name);
    } else if (
      !isExternalSchemaRef(fragment.$ref) &&
      !isEmbeddedCfcSchemaRef(fragment.$ref)
    ) {
      throw new SchemaNotDecomposableError(
        `unsupported \`$ref\` form: \`${fragment.$ref}\``,
      );
    }
  }
  forEachSubschema(fragment, (child) => {
    scanFragment(child, defNames, into);
  }, ALL_SUBSCHEMAS);
}

/**
 * Rewrites every local `#/$defs/<name>` ref in `fragment` through `refFor`,
 * leaving names in `keepLocal` (a cyclic group's own members) as local refs.
 * External refs already present pass through untouched.
 */
function rewriteRefs(
  fragment: JSONSchema,
  refFor: (name: string) => string,
  keepLocal: ReadonlySet<string>,
): JSONSchema {
  if (!isObjectNotArray(fragment)) return fragment;
  let result: JSONSchemaObj = fragment;
  if (typeof fragment.$ref === "string") {
    const name = localDefName(fragment.$ref);
    if (name !== undefined && !keepLocal.has(name)) {
      result = { ...result, $ref: refFor(name) };
    }
  }
  return mapSubschemas(
    result,
    (child) => rewriteRefs(child, refFor, keepLocal),
    ALL_SUBSCHEMAS,
  );
}

/**
 * Strongly connected components of the definition dependency graph, in
 * dependency-first order: every component appears before each component that
 * references it. Tarjan's algorithm; a component containing one definition is
 * cyclic only when that definition references itself.
 */
function definitionComponents(
  names: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const connect = (name: string): void => {
    indexOf.set(name, counter);
    lowlink.set(name, counter);
    counter++;
    stack.push(name);
    onStack.add(name);
    for (const dep of edges.get(name) ?? []) {
      if (!indexOf.has(dep)) {
        connect(dep);
        lowlink.set(name, Math.min(lowlink.get(name)!, lowlink.get(dep)!));
      } else if (onStack.has(dep)) {
        lowlink.set(name, Math.min(lowlink.get(name)!, indexOf.get(dep)!));
      }
    }
    if (lowlink.get(name) === indexOf.get(name)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === name) break;
      }
      components.push(component);
    }
  };

  for (const name of names) {
    if (!indexOf.has(name)) connect(name);
  }
  return components;
}

/** Options for {@link decomposeSchema}. */
export type DecomposeSchemaOptions = {
  /**
   * Supplies the document behind an external ref the input already carries,
   * so the returned closure can include it (the schema-document registry's
   * lookup is the expected implementation). Without it, an input carrying
   * an external ref is refused: returning a closure with a hole would let a
   * writer persist a durably dangling reference.
   */
  readonly resolveDocument?: (taggedHash: string) => JSONSchema | undefined;
};

// Memo for decompositions of interned inputs. `decomposeSchema` interns its
// input, so in steady state every call after the first for a given schema is
// one `WeakMap` probe. A refusal (throw) is never memoized.
//
// A decomposition that consulted no resolver is a pure function of its input
// and memoizes for the realm. One that resolved an external ref is a fact
// about what the resolver held at the time: handing it to a later caller
// whose resolver would miss — no resolver at all, or the registry after its
// lease epoch cleared — returns a closure that caller could not have built,
// and callers register what comes back, resurrecting documents the current
// epoch never received. So a resolver-dependent result memoizes only for the
// registry's own lookup, and only until the registry clears: within an epoch
// the registry is monotonic, so a success stays true.
const decompositionCache = new WeakMap<JSONSchemaObj, DecomposedSchema>();
let registryDecompositionCache = new WeakMap<
  JSONSchemaObj,
  DecomposedSchema
>();
onSchemaRegistryClear(() => {
  registryDecompositionCache = new WeakMap();
});

/**
 * Decomposes a self-contained schema into content-addressed documents.
 *
 * The input is interned (and therefore deep-frozen in place — callers must be
 * okay with that, as with `internSchema` itself). The result is deterministic
 * for structurally equal inputs regardless of key order, and memoized on the
 * interned input.
 *
 * Definitions unreachable from the root body are dropped: they are inert for
 * matching, and carrying them would make two schemas that match identically
 * decompose differently. A root body — or a definition — that reduces to a
 * single external reference and nothing else does not get a document of its
 * own; the reference points directly at the target, so a chain of pure-ref
 * aliases decomposes to the same closure as a direct reference.
 *
 * External refs the input already carries are resolved through
 * `options.resolveDocument` and their documents (transitively) included in
 * the returned closure, keeping the "every document in the closure"
 * contract; an external ref that cannot be resolved is refused.
 *
 * Throws {@link SchemaNotDecomposableError} for input it cannot represent;
 * the caller keeps such a schema inline.
 */
export function decomposeSchema(
  schema: JSONSchemaObj,
  options: DecomposeSchemaOptions = {},
): DecomposedSchema {
  const interned = internSchema(schema);
  const cached = decompositionCache.get(interned) ??
    (options.resolveDocument === lookupSchemaDocument
      ? registryDecompositionCache.get(interned)
      : undefined);
  if (cached !== undefined) return cached;

  const defs = interned.$defs ?? {};
  const defNames = new Set(Object.keys(defs));

  const { $defs: _defs, ...rootBody } = interned;
  if (interned.definitions !== undefined) {
    throw new SchemaNotDecomposableError(
      "the deprecated `definitions` keyword is present",
    );
  }

  const rootRefs = new Set<string>();
  scanFragment(rootBody, defNames, rootRefs);
  const refsByName = new Map<string, Set<string>>();
  for (const name of defNames) {
    const body = defs[name];
    if (!isSubschema(body)) {
      throw new SchemaNotDecomposableError(
        `definition \`${name}\` is not a schema`,
      );
    }
    const refs = new Set<string>();
    scanFragment(body, defNames, refs);
    refsByName.set(name, refs);
  }

  // Reachability from the root body; unreachable definitions are dropped.
  const reachable = new Set<string>();
  const queue = [...rootRefs];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    queue.push(...refsByName.get(name)!);
  }

  const components = definitionComponents(
    [...reachable].toSorted(utf8Compare),
    refsByName,
  );

  const documents = new Map<string, JSONSchema>();
  const externalRefByName = new Map<string, string>();
  const refFor = (name: string): string => externalRefByName.get(name)!;
  const NO_LOCALS: ReadonlySet<string> = new Set();

  const addDocument = (value: JSONSchema): string => {
    const sah = internSchema(value, true);
    documents.set(
      sah.taggedHashString,
      sah.schemaOrUndefined as JSONSchema,
    );
    return sah.taggedHashString;
  };

  // Pre-existing external refs: resolve their documents (hash-verified) and
  // include the transitive closure, dependencies before dependents.
  let resolvedExternal = false;
  const includeExternalClosure = (fromFragment: JSONSchema): void => {
    for (const hash of collectExternalSchemaRefHashes(fromFragment)) {
      if (documents.has(hash)) continue;
      resolvedExternal = true;
      const supplied = options.resolveDocument?.(hash);
      if (supplied === undefined) {
        throw new SchemaNotDecomposableError(
          `references a schema document that is not at hand: \`${hash}\``,
        );
      }
      const sah = internSchema(supplied, true);
      if (sah.taggedHashString !== hash) {
        throw new SchemaNotDecomposableError(
          `resolved schema document does not match its id: \`${hash}\``,
        );
      }
      const document = sah.schemaOrUndefined as JSONSchema;
      includeExternalClosure(document);
      documents.set(hash, document);
    }
  };
  includeExternalClosure(rootBody);
  for (const name of reachable) includeExternalClosure(defs[name]!);

  for (const component of components) {
    const cyclic = component.length > 1 ||
      refsByName.get(component[0]!)!.has(component[0]!);
    if (cyclic) {
      const members = component.toSorted(utf8Compare);
      const memberSet = new Set(members);
      const groupDefs = Object.fromEntries(
        members.map((
          name,
        ) => [name, rewriteRefs(defs[name]!, refFor, memberSet)]),
      );
      const hash = addDocument({ $defs: groupDefs });
      for (const name of members) {
        externalRefByName.set(name, formatExternalSchemaRef(hash, name));
      }
    } else {
      const name = component[0]!;
      const rewritten = rewriteRefs(defs[name]!, refFor, NO_LOCALS);
      // A definition that is nothing but a reference is an alias: minting a
      // wrapper document for it would not survive a recompose/decompose
      // round trip (the alias inlines away), so the name binds straight to
      // the target and the closure stays canonical across alias chains.
      const aliasKeys = isObjectNotArray(rewritten)
        ? Object.keys(rewritten)
        : [];
      if (
        aliasKeys.length === 1 && aliasKeys[0] === "$ref" &&
        isExternalSchemaRef((rewritten as JSONSchemaObj).$ref!)
      ) {
        externalRefByName.set(name, (rewritten as JSONSchemaObj).$ref!);
      } else {
        externalRefByName.set(
          name,
          formatExternalSchemaRef(addDocument(rewritten)),
        );
      }
    }
  }

  const rewrittenRoot = rewriteRefs(
    rootBody,
    refFor,
    NO_LOCALS,
  ) as JSONSchemaObj;
  const rootKeys = Object.keys(rewrittenRoot);
  const rootRef = (rootKeys.length === 1 && rootKeys[0] === "$ref" &&
      isExternalSchemaRef(rewrittenRoot.$ref!))
    ? rewrittenRoot.$ref!
    : formatExternalSchemaRef(addDocument(rewrittenRoot));

  const result: DecomposedSchema = { rootRef, documents };
  if (!resolvedExternal) decompositionCache.set(interned, result);
  else if (options.resolveDocument === lookupSchemaDocument) {
    registryDecompositionCache.set(interned, result);
  }
  return result;
}

/**
 * Recomposes a document closure back into one self-contained schema — the
 * reference inverse of {@link decomposeSchema}, used by tests and debugging
 * output. `lookup` supplies a document by tagged hash; a missing document
 * throws, since a recomposition is only asked for when the closure is at
 * hand (the fail-closed read path is the resolver's job, not this one's).
 *
 * Cyclic-group members keep their names in the recomposed `$defs`; a bare
 * (name-free) document gets a hash-derived name. A name collision between
 * two documents is broken by suffixing, so recomposition of such a closure
 * is equivalent but not byte-identical to a decomposition input that had
 * unique names throughout.
 */
export function recomposeSchema(
  rootRef: string,
  lookup: (taggedHash: string) => JSONSchema | undefined,
  options?: {
    /**
     * Preferred `$defs` name for a document reached by BARE reference —
     * the case whose authored name the decomposition rewrote away. A
     * caller that knows the original naming (a declared document at hand)
     * supplies it here; collisions still break by suffixing, and
     * fragment-referenced group members keep their own names regardless.
     */
    nameFor?: (taggedHash: string) => string | undefined;
  },
): JSONSchema {
  const parsedRoot = parseExternalSchemaRef(rootRef);
  if (parsedRoot === undefined) {
    throw new Error(`Not an external schema reference: \`${rootRef}\``);
  }

  const getDocument = (taggedHash: string): JSONSchema => {
    const document = lookup(taggedHash);
    if (document === undefined) {
      throw new Error(`Schema document not found: \`${taggedHash}\``);
    }
    return document;
  };

  const usedNames = new Set<string>();
  const nameByRef = new Map<string, string>();
  // Accumulated as a Map and converted with Object.fromEntries at the end:
  // a plain-object assignment under a member named `__proto__` would hit
  // the prototype setter instead of creating a definition.
  const combined = new Map<string, JSONSchema>();
  const pending: string[] = [];

  const assignName = (ref: string, preferred: string): string => {
    const existing = nameByRef.get(ref);
    if (existing !== undefined) return existing;
    let candidate = preferred;
    let suffix = 2;
    while (usedNames.has(candidate)) candidate = `${preferred}_${suffix++}`;
    usedNames.add(candidate);
    nameByRef.set(ref, candidate);
    pending.push(ref);
    return candidate;
  };

  // A bare document's derived name: enough of the hash to read as an
  // identifier, unique in practice, with collisions broken by `assignName`.
  const derivedName = (taggedHash: string): string => {
    const bare = taggedHash.slice(taggedHash.indexOf(":") + 1);
    return `def_${bare.slice(0, 8)}`;
  };

  const localize = (
    fragment: JSONSchema,
    ownMembers: ReadonlyMap<string, string>,
  ): JSONSchema => {
    if (!isObjectNotArray(fragment)) return fragment;
    let result: JSONSchemaObj = fragment;
    if (typeof fragment.$ref === "string") {
      const local = localDefName(fragment.$ref);
      if (local !== undefined) {
        const renamed = ownMembers.get(local);
        if (renamed === undefined) {
          throw new Error(
            `Unresolvable local ref in schema document: \`${fragment.$ref}\``,
          );
        }
        if (renamed !== local) {
          result = {
            ...result,
            $ref: encodeJsonPointer(["#", "$defs", renamed]),
          };
        }
      } else {
        const external = parseExternalSchemaRef(fragment.$ref);
        if (external !== undefined) {
          const name = assignName(
            fragment.$ref,
            external.defName ?? options?.nameFor?.(external.taggedHash) ??
              derivedName(external.taggedHash),
          );
          result = { ...result, $ref: encodeJsonPointer(["#", "$defs", name]) };
        }
      }
    }
    return mapSubschemas(
      result,
      (child) => localize(child, ownMembers),
      ALL_SUBSCHEMAS,
    );
  };

  // Names for one document's own cyclic-group members, assigning combined
  // names for each; a document without `$defs` has none.
  const membersOf = (
    taggedHash: string,
    document: JSONSchema,
  ): Map<string, string> => {
    const members = new Map<string, string>();
    // A definition map is a non-array record; an array's indices are not
    // member names.
    if (isObjectNotArray(document) && isObjectNotArray(document.$defs)) {
      for (const name of Object.keys(document.$defs)) {
        members.set(
          name,
          assignName(formatExternalSchemaRef(taggedHash, name), name),
        );
      }
    }
    return members;
  };

  // The root position: a fragment ref makes the root a local ref into the
  // group's recomposed members; a bare ref makes the document's own schema
  // the root body.
  let rootBody: JSONSchema;
  const rootDocument = getDocument(parsedRoot.taggedHash);
  if (parsedRoot.defName !== undefined) {
    const members = membersOf(parsedRoot.taggedHash, rootDocument);
    const rootName = members.get(parsedRoot.defName);
    if (rootName === undefined) {
      throw new Error(
        `Schema document has no member \`${parsedRoot.defName}\``,
      );
    }
    rootBody = { $ref: encodeJsonPointer(["#", "$defs", rootName]) };
  } else {
    if (isObjectNotArray(rootDocument) && rootDocument.$defs !== undefined) {
      throw new Error(
        "A bare root reference must not target a cyclic-group document",
      );
    }
    rootBody = localize(rootDocument, new Map());
  }

  // Drain the referenced-document queue, recomposing each into `combined`.
  // A cyclic group contributes each member under its assigned name; a bare
  // document contributes its own schema under its derived name. The queue
  // holds each ref at most once: `assignName` is its only feeder, and a ref
  // enqueues only on its first name assignment.
  while (pending.length > 0) {
    const ref = pending.shift()!;
    const parsed = parseExternalSchemaRef(ref)!;
    const document = getDocument(parsed.taggedHash);
    if (parsed.defName !== undefined) {
      const members = membersOf(parsed.taggedHash, document);
      // Object.hasOwn before the read: a member named `__proto__` must be
      // read as an own property, never through the prototype accessor.
      const groupDefs = (document as JSONSchemaObj).$defs;
      const body = isObjectNotArray(groupDefs) &&
          Object.hasOwn(groupDefs, parsed.defName)
        ? groupDefs[parsed.defName]
        : undefined;
      if (body === undefined) {
        throw new Error(
          `Schema document has no member \`${parsed.defName}\``,
        );
      }
      combined.set(members.get(parsed.defName)!, localize(body, members));
    } else {
      combined.set(nameByRef.get(ref)!, localize(document, new Map()));
    }
  }

  if (combined.size === 0) return internSchema(rootBody);
  if (!isObjectNotArray(rootBody)) {
    throw new Error("A boolean root cannot carry a `$defs` scope");
  }
  return internSchema({ ...rootBody, $defs: Object.fromEntries(combined) });
}
