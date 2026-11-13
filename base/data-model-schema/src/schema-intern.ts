/**
 * Schema interning (uniquing): one canonical, deep-frozen instance per
 * structurally distinct schema, paired with its content hash.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";

import { hashOf } from "@commonfabric/data-model";
import type { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { SchemaAndHash } from "./SchemaAndHash.ts";
import { toDeepFrozenSchema } from "./schema-copy.ts";

/**
 * Forward half of the bidirectional schema intern cache: schema object to its
 * `SchemaAndHash`. A `WeakMap`, so that when the schema object is collected
 * the entry — and with it the `SchemaAndHash` — becomes unreachable.
 */
const schemaToSah = new WeakMap<JSONSchemaObj, SchemaAndHash>();

/**
 * Reverse half of that cache: hash string to object schema, held as a
 * `WeakRef` so that it is not retained. An entry whose schema was collected is
 * removed by `schemaFinalizer`, or by the next lookup of its hash, whichever
 * comes first.
 *
 * Splitting the cache in two is what avoids strong retention, and it is why a
 * lookup by hash takes both halves: deref the `WeakRef` from here, then read
 * the `SchemaAndHash` out of `schemaToSah`. A `SchemaAndHash` is thereby
 * reachable only while its own schema object is alive.
 */
const hashToRef = new Map<string, WeakRef<JSONSchemaObj>>();

/**
 * Prefab instances of `SchemaAndHash` for all possible primitive-value schemas
 * (including `undefined`).
 */
const primInterns = {
  false: new SchemaAndHash(false, hashOf(false)),
  true: new SchemaAndHash(true, hashOf(true)),
  undefined: new SchemaAndHash(undefined, hashOf(undefined)),
};

/** The prefab instances in `primInterns`, by hash string. */
const primInternsByHash = new Map(
  Object.values(primInterns).map((sah) => [sah.taggedHashString, sah]),
);

/**
 * The live object schema interned under `hashStr`, if any. An entry whose
 * schema was collected is removed on the way.
 */
function liveInternedSchema(hashStr: string): JSONSchemaObj | undefined {
  const schema = hashToRef.get(hashStr)?.deref();
  if (schema === undefined) hashToRef.delete(hashStr);
  return schema;
}

const schemaFinalizer = new FinalizationRegistry<string>(liveInternedSchema);

/**
 * Helper for `internSchema()` and friends, which always returns a
 * `SchemaAndHash` and takes configurable sharing-or-not.
 */
function internSchemaReturningSchemaAndHash(
  schema: JSONSchema | undefined,
  canShare: boolean,
): SchemaAndHash {
  // Return prefab instances for primitives.
  switch (schema) {
    case true: {
      return primInterns.true;
    }

    case false: {
      return primInterns.false;
    }

    case undefined: {
      return primInterns.undefined;
    }
  }

  // At this point `schema` is a `JSONSchemaObj`.

  const cached = schemaToSah.get(schema);
  if (cached) return cached;

  // `toDeepFrozenSchema()` returns the same reference if already deep-frozen or
  // if no sub-properties needed to be cloned to achieve frozenness.
  const frozen = toDeepFrozenSchema(schema, canShare);

  // Check the hash-keyed reverse map (structurally-equal but different object).
  const hash = hashOf(frozen);
  const hashStr = hash.taggedHashString;

  const existing = liveInternedSchema(hashStr);
  if (existing !== undefined) {
    const existingSah = schemaToSah.get(existing)!;

    // If possible, cache the result for the caller's schema, so future calls
    // with the same object hit the `WeakMap` at the top instead of re-hashing
    // every time. We only do this when the input was already deep-frozen or
    // was itself deep-frozen via the assignment to `frozen` above, because
    // mutable objects could be changed after caching, producing stale hits.
    const inputIsFrozen = frozen === schema;
    if (inputIsFrozen) {
      schemaToSah.set(frozen, existingSah);
    }

    return existingSah;
  }

  // Not interned yet (or interned but later collected).

  const sah = new SchemaAndHash(frozen, hash);
  schemaToSah.set(frozen, sah);
  hashToRef.set(hashStr, new WeakRef(frozen));
  schemaFinalizer.register(frozen, hashStr);

  return sah;
}

/**
 * Interns a schema: freezes it, computes its hash, and caches the bidirectional
 * mapping. Returns the actual interned schema object or, optionally, the full
 * `SchemaAndHash`. The returned schema object is the same as (`===` to) the
 * given `schema` only if an identical schema was not already interned.
 *
 * If given a non-deep-frozen `schema`, this function will _always_ make it
 * deep-frozen as a side effect. Callers must be okay with this! This design is
 * motivated by the desire to minimize unnecessary cloning of objects, colored
 * by the observation that most mutable schemas are built by starting with an
 * effectively -- if not actually -- deep-immutable schema and selectively
 * shallow-cloned as mutable, for the express purpose of tactical modification
 * and then immediately treated once again as deep-immutable.
 */
export function internSchema<T extends JSONSchema | undefined>(
  schema: T,
  wantSchemaAndHash?: false,
): T;
export function internSchema<T extends JSONSchema | undefined>(
  schema: T,
  wantSchemaAndHash: true,
): SchemaAndHash;
export function internSchema<T extends JSONSchema | undefined>(
  schema: T,
  wantSchemaAndHash?: boolean,
): JSONSchema | undefined | SchemaAndHash;
export function internSchema<T extends JSONSchema | undefined>(
  schema: T,
  wantSchemaAndHash: boolean = false,
): JSONSchema | undefined | SchemaAndHash {
  const sahResult = internSchemaReturningSchemaAndHash(schema, true);
  return wantSchemaAndHash ? sahResult : sahResult.schemaOrUndefined;
}

/**
 * Like {@link #internSchema}, except that when given a non-deep-frozen `schema`
 * it makes a deep-frozen clone of it first instead of freezing it in place.
 * This is for the rare cases where it is _not_ safe to do freezing in place.
 * _Do not reach for this function_ unless you are sure that you're in unsafe
 * territory, and strongly recommend commenting the use site with an explanation
 * about why.
 */
export function deepFrozenCloneAndInternSchema<
  T extends JSONSchema | undefined,
>(
  schema: T,
): T {
  const sahResult = internSchemaReturningSchemaAndHash(schema, false);
  return sahResult.schemaOrUndefined as T;
}

/**
 * Looks up a previously interned schema by its hash. Accepts a `FabricHash` or
 * a plain string of the _tagged_ hash. Returns `undefined` if the schema has
 * not been interned or has been garbage-collected. If found, returns the
 * corresponding full `SchemaAndHash`.
 *
 * This function _will_ find the `SchemaAndHash` corresponding to the "schema"
 * `undefined`.
 */
export function findInternedSchema(
  hash: FabricHash | string,
): SchemaAndHash | undefined {
  const hashStr = typeof hash === "string" ? hash : hash.taggedHashString;
  const prim = primInternsByHash.get(hashStr);
  if (prim !== undefined) return prim;

  const schema = liveInternedSchema(hashStr);

  // The `!` below is valid because `schemaToSah` has a mapping for every
  // schema `hashToRef` holds.
  return schema === undefined ? undefined : schemaToSah.get(schema)!;
}

/**
 * Indicates whether or not the given `schema` is already interned. This returns
 * `false` even if there is already a schema in the intern cache that is
 * equivalent to the given one, unless `schema` is in fact the one that is in
 * the cache.
 *
 * This returns `true` for the primitive-value schemas and `undefined`.
 */
export function isInternedSchema(schema: JSONSchema | undefined): boolean {
  switch (typeof schema) {
    case "boolean":
    case "undefined": {
      return true;
    }

    default: {
      return schemaToSah.has(schema);
    }
  }
}

/**
 * Interns (and thus deep-freezes) the given schema, returning its hash
 * string. Equivalent to `internSchema(schema, true).taggedHashString`, but
 * names the operation and avoids the non-obvious `true` (`wantSchemaAndHash`)
 * argument at call sites.
 */
export function internSchemaAsTaggedHashString(
  schema: JSONSchema | undefined,
): string {
  return internSchema(schema, true).taggedHashString;
}

/**
 * Returns a cache-key string for an ordered pair of schemas, each interned
 * (and thus deep-frozen) via `internSchema()`. The `|` delimiter is outside
 * the base64url alphabet used by hash strings, so the two halves cannot
 * merge ambiguously.
 */
export function internSchemaPairAsKey(a: JSONSchema, b: JSONSchema): string {
  return `${internSchemaAsTaggedHashString(a)}|${
    internSchemaAsTaggedHashString(b)
  }`;
}
