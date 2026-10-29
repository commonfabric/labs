/**
 * Interning and canonicalization of `SchemaPathSelector`s.
 *
 * The two canonical selectors below are interned at this module's load, which
 * needs `schema-intern.ts` to be initialized by then. This package's modules
 * import acyclically, so each one is fully evaluated before any module that
 * names it; an import cycle reaching back here would forfeit that.
 */

import type { JSONSchema, SchemaPathSelector } from "@commonfabric/api";

import { internSchema } from "./schema-intern.ts";

/**
 * Common shape of the two canonical-selector maps. Its key type spans both
 * maps' keys, so a single variable selected between the object `WeakMap` and
 * the primitive `Map` accepts the un-narrowed interned schema as a key —
 * without TypeScript collapsing the two maps' key types to `never` (which is
 * what a bare `WeakMap | Map` union does).
 */
type CanonicalSelectorMap = {
  /** Returns the selectors for `key`, or `undefined` if there are none. */
  get(
    key: JSONSchema | undefined,
  ): Map<string, WeakRef<SchemaPathSelector>> | undefined;

  /** Sets the selectors for `key`. */
  set(
    key: JSONSchema | undefined,
    value: Map<string, WeakRef<SchemaPathSelector>>,
  ): unknown;
};

/**
 * Canonical selector instances per (interned schema identity, path content).
 * A `SchemaPathSelector` is just `{ path, schema? }`, so structurally-equal
 * selectors can safely collapse to ONE frozen instance. That makes the
 * selector WRAPPER identity stable across repeat constructions — without it,
 * every freshly built selector misses entry-level identity caches
 * (`hashOf()`'s frozen-object WeakMap, `MapSetStringToPathSelectors`'s
 * hashing key fn, cycle trackers) and re-walks the embedded schema, which CPU
 * profiles showed as a dominant remount cost.
 *
 * Inner values are `WeakRef`s: a selector held strongly here would strongly
 * reference its schema — the outer `WeakMap` key — pinning both forever.
 * Dead refs are dropped lazily on lookup.
 *
 * As a `WeakMap`, this can only map from GC-able objects, so primitives are
 * handled by {@link #canonicalSelectorsByPrimitiveSchema}.
 */
const canonicalSelectorsByObjectSchema = new WeakMap<
  object,
  Map<string, WeakRef<SchemaPathSelector>>
>();

/**
 * Like {@link #canonicalSelectorsByObjectSchema}, except for primitive-valued
 * schemas including the "schema" `undefined`.
 */
const canonicalSelectorsByPrimitiveSchema = new Map<
  boolean | undefined,
  Map<string, WeakRef<SchemaPathSelector>>
>();

/**
 * Path-key strings per (frozen) path array identity. `internPathSelector()`
 * computes the key on EVERY call -- including idempotent re-interning of an
 * already-canonical selector, the common repeat case -- and that string build
 * showed up with >100ms self time in remount profiles. Canonical selectors
 * carry frozen, identity-stable path arrays, so a `WeakMap` hits.
 */
const selectorPathKeyCache = new WeakMap<readonly string[], string>();

/**
 * Injective string key for a path: each component is length-prefixed, so a
 * component containing the separator cannot collide with a differently-split
 * path.
 */
const selectorPathKey = (path: readonly string[]): string => {
  if (path.length === 0) return "";
  const cached = selectorPathKeyCache.get(path);
  if (cached !== undefined) return cached;
  let key = "";
  for (const part of path) key += `${part.length}:${part}`;
  if (Object.isFrozen(path)) {
    selectorPathKeyCache.set(path, key);
  }
  return key;
};

/**
 * Sweep threshold for a per-schema path map: schemas that never die -- interned
 * canonical schemas, primitive schemas, or `undefined` (no schama) -- would
 * otherwise accumulate `pathKey -> dead WeakRef` entries forever, since the
 * lazy cleanup below only fires when the exact same path is looked up again.
 * Sweeping on insert once the map is large bounds growth to live selectors
 * (plus the threshold).
 */
const SELECTOR_CACHE_SWEEP_THRESHOLD = 2048;

/**
 * Returns a deep-frozen `SchemaPathSelector` whose `schema` (if any) is the
 * canonical interned instance and whose `path` array is frozen.
 *
 * Usually the input reference itself is canonicalized in place — its `schema`
 * replaced with the interned instance if needed, then it and its `path` frozen
 * — and returned. The one exception: when the input is **already frozen** and
 * its `schema` is not the canonical interned instance, the schema cannot be
 * written back, so a new deep-frozen selector is allocated and returned.
 * Therefore the result is NOT guaranteed to be `===` to the input. (It is `===`
 * when the input is mutable _and_ there is no already-interned equivalent.)
 *
 * Idempotent: re-interning a result returns that same result
 * (`internPathSelector(internPathSelector(x)) === internPathSelector(x)`),
 * since a returned selector's `schema` is already canonical.
 *
 * Exists so that callers who feed selectors into `MapSetStringToPathSelectors`
 * (or any other cache keyed on `hashStringOf()` of a selector) can hand in an
 * already-interned, deep-frozen selector. That satisfies the `isDeepFrozen()`
 * guard internal to `hashOf()` and lets its `WeakMap` cache retain its hash
 * across repeat calls.
 */
export function internPathSelector(
  selector: SchemaPathSelector,
): SchemaPathSelector {
  const { path, schema } = selector;

  const interned = internSchema(schema);
  const topMap: CanonicalSelectorMap = (typeof interned === "object")
    ? canonicalSelectorsByObjectSchema
    : canonicalSelectorsByPrimitiveSchema;
  let byPath = topMap.get(interned);
  if (byPath === undefined) {
    byPath = new Map();
    topMap.set(interned, byPath);
  }

  const pathK = selectorPathKey(path);
  const existingRef = byPath.get(pathK);
  if (existingRef !== undefined) {
    const existing = existingRef.deref();
    if (existing !== undefined) {
      // Preserve the pre-cache contract for callers that keep using their
      // input object: a mutable input is still canonicalized and frozen in
      // place even when a structurally-equal canonical instance exists.
      if (existing !== selector && !Object.isFrozen(selector)) {
        if (interned !== schema) {
          selector.schema = interned;
        }
        Object.freeze(path);
        Object.freeze(selector);
      }
      return existing;
    }
    byPath.delete(pathK);
  }

  if (byPath.size >= SELECTOR_CACHE_SWEEP_THRESHOLD) {
    for (const [k, ref] of byPath) {
      if (ref.deref() === undefined) byPath.delete(k);
    }
  }

  // First instance with this content becomes the canonical one. Keep the
  // pre-existing in-place behavior: swap in the canonical schema and freeze
  // when the input is mutable; allocate only when the input is frozen with a
  // non-canonical schema.
  let canonical: SchemaPathSelector;
  if (interned !== schema && Object.isFrozen(selector)) {
    canonical = Object.freeze({
      path: Object.freeze(path),
      schema: interned,
    }) as SchemaPathSelector;
  } else {
    if (interned !== schema) {
      selector.schema = interned;
    }
    Object.freeze(path);
    canonical = Object.freeze(selector);
  }
  byPath.set(pathK, new WeakRef(canonical));
  return canonical;
}

/**
 * Canonical "reject everything at the root" path selector. Used by sites that
 * want to record a doc dependency (or normalize a `{ schema: false, ... }`
 * input) without actually traversing into it.
 *
 * Interned at load, so this is the canonical instance for its content:
 * `internPathSelector({ path: [], schema: false })` returns this object rather
 * than a second wrapper for the same selector.
 */
export const REJECTING_SELECTOR: SchemaPathSelector = internPathSelector({
  path: [],
  schema: false,
});

/**
 * Canonical "accept the full value" path selector. `SchemaPathSelector`s are
 * relative to the doc root, so to look at the value of the doc the path needs
 * to have `"value"` in it.
 *
 * Interned at load, like `REJECTING_SELECTOR`, so this is the canonical
 * instance for its content.
 */
export const DEFAULT_SELECTOR: SchemaPathSelector = internPathSelector({
  path: ["value"],
  schema: true,
});
