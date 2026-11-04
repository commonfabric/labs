/**
 * Schema interning (uniquing): one canonical, deep-frozen instance per
 * structurally distinct schema, paired with its content hash.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";

import { hashOf } from "@commonfabric/data-model";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { SchemaAndHash } from "./SchemaAndHash.ts";
import { toDeepFrozenSchema } from "./schema-copy.ts";

/**
 * Forward half of the bidirectional schema intern cache: schema object to its
 * `SchemaAndHash`. A `WeakMap`, so that when the schema object is collected
 * the entry — and with it the `SchemaAndHash` — becomes unreachable.
 */
const schemaToSah = new WeakMap<JSONSchemaObj, SchemaAndHash>();

/**
 * Reverse half of that cache: hash string to schema. An object schema is held
 * as a `WeakRef`, so it is not retained; dead refs are cleaned up by
 * `schemaFinalizer` and on lookup. A primitive schema — `true`, `false`, or
 * `undefined` — is stored as itself instead, a primitive being no possible
 * `WeakRef` target and having nothing to retain. Consumers tell the two apart
 * by `typeof`.
 *
 * Splitting the cache in two is what avoids strong retention, and it is why an
 * object schema's lookup by hash takes both halves: deref the `WeakRef` from
 * here, then read the `SchemaAndHash` out of `schemaToSah`. A `SchemaAndHash`
 * is thereby reachable only while its own schema object is alive. A primitive
 * hash takes neither step — it is read straight out of this map, and the
 * primitive stored here routes to `primInterns`.
 */
const hashToRef = new Map<
  string,
  WeakRef<JSONSchemaObj> | boolean | undefined
>();

/**
 * Prefab instances of `SchemaAndHash` for all possible primitive-value schemas
 * (including `undefined`).
 */
const primInterns = {
  false: new SchemaAndHash(false, hashOf(false)),
  true: new SchemaAndHash(true, hashOf(true)),
  undefined: new SchemaAndHash(undefined, hashOf(undefined)),
};

const schemaFinalizer = new FinalizationRegistry<string>((hashStr) => {
  const ref = hashToRef.get(hashStr);
  if ((typeof ref === "object") && (ref.deref() === undefined)) {
    hashToRef.delete(hashStr);
  }
});

// Seeds `hashToRef` with intern records for the primitive-value schemas.
hashToRef.set(primInterns.false.taggedHashString, false);
hashToRef.set(primInterns.true.taggedHashString, true);
hashToRef.set(primInterns.undefined.taggedHashString, undefined);

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

  const maybeRef = hashToRef.get(hashStr);

  if (typeof maybeRef === "object") {
    const existing = maybeRef.deref();
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

    // The `WeakRef`'s referent got collected. Clean up.
    hashToRef.delete(hashStr);

    // ...and fall through to add `frozen` to the cache.
  } else if (typeof maybeRef === "boolean") {
    // Shouldn't happen! This implies a hash collision between a `boolean`
    // schema and an `object` schema.
    throw new Error(
      "Shouldn't happen: Schema hash collision, object vs. boolean.",
    );
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

  const refOrPrim = hashToRef.get(hashStr);

  switch (typeof refOrPrim) {
    case "boolean": {
      return refOrPrim ? primInterns.true : primInterns.false;
    }

    case "undefined": {
      // We have to disambiguate "the caller passed the hash of `undefined`"
      // from "the caller passed in a hash that does not correspond to an
      // interned schema."
      const undefinedSah = primInterns.undefined;
      return (hashStr === undefinedSah.taggedHashString)
        ? undefinedSah
        : undefined;
    }

    case "object": {
      if (refOrPrim === null) {
        // Shouldn't happen!
        throw new Error("Unexpected `null` reference in schema intern table.");
      }

      const schema = refOrPrim.deref();

      if (schema === undefined) {
        // The `WeakRef`'s referent got collected. Clean up.
        hashToRef.delete(hashStr);
        return undefined;
      }

      // The `!` below is valid because we know that `schemaToSah` definitely
      // has a mapping for `schema`. Otherwise, we wouldn't have found a
      // `refOrPrim` to look up.
      return schemaToSah.get(schema)!;
    }

    default: {
      // Shouldn't happen!
      throw new Error(
        `Unexpected type in schema intern table: \`${typeof refOrPrim}\``,
      );
    }
  }
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
