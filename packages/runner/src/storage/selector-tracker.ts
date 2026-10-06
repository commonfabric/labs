import type { FabricValue, SchemaPathSelector } from "@commonfabric/api";
import { isDeepFrozen, isKeyableObjectOrArray } from "@commonfabric/data-model";
import {
  hashSchema,
  internSchema,
  schemaWithProperties,
} from "@commonfabric/data-model-schema";
import type { Result, Unit } from "@commonfabric/memory/interface";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
  scopeOfScopeKey,
} from "@commonfabric/memory/v2";
import { LRUCache } from "@commonfabric/utils/cache";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import {
  externalResolutionMissCount,
  onSchemaRegistryClear,
} from "../schema-registry.ts";
import { BaseMemoryAddress, MapSetStringToStrings } from "../traverse.ts";
import * as Address from "./transaction/address.ts";

// Subscription-selector keys are per scope INSTANCE (key-vocabulary.md §5,
// the M4-coupled list; stage F): `${scope_key}\0${id}` via the shared
// vocabulary, resolved against the tracker's bound identity. Name-keyed,
// A's watch deduped B's at cardinality > 1, so B never subscribed. At
// cardinality 1 the instance is derivable from the session and the
// partition is unchanged (key-vocabulary.md §2). The scope NAME is
// recovered from the key for the wire (watch entries name scopes;
// instances resolve server-side per session).
const fromKey = (key: string): BaseMemoryAddress => {
  const separator = key.indexOf("\0");
  if (separator === -1) {
    return {
      id: key as BaseMemoryAddress["id"],
      type: "application/json",
    };
  }
  const scopeKey = key.slice(0, separator);
  const scope = scopeOfScopeKey(scopeKey);
  return {
    ...(scope === "space" ? {} : { scope }),
    id: key.slice(separator + 1) as BaseMemoryAddress["id"],
    type: "application/json",
  };
};

// Only cache by identity against already-deep-frozen inputs. Mutable schemas
// can be edited in place, and keying this cache by their identity would
// return stale results.
const standardizedSchemaCache = new WeakMap<object, JSONSchema>();

// Standardization results for MUTABLE inputs, keyed by content hash. The hash
// is recomputed per call (hashOf does not identity-cache mutable objects), so
// in-place edits change the key and stay correct — while structurally-equal
// fresh objects, the common case on the subscription path, pay one content
// hash instead of a full rebuild + intern + re-hash each call.
const standardizedByContentCache = new LRUCache<string, JSONSchema>({
  capacity: 4096,
});

// hashSchema(getStandardSchema(schema-without-$defs)) per interned schema
// instance. getSupersetSelector compares this pair for every tracked selector
// on every lookup; without the memo each comparison rebuilds the spread and
// re-hashes both sides.
const noDefsStandardHashCache = new WeakMap<object, string>();

const noDefsStandardHash = (schema: Record<string, unknown>): string => {
  let hash = noDefsStandardHashCache.get(schema);
  if (hash === undefined) {
    const { $defs: _defs, ...rest } = schema;
    hash = hashSchema(SelectorTracker.getStandardSchema(rest as JSONSchema));
    noDefsStandardHashCache.set(schema, hash);
  }
  return hash;
};

const selectorRefFor = (selector: SchemaPathSelector): string =>
  JSON.stringify([
    selector.path,
    selector.schema === undefined
      ? ""
      : hashSchema(SelectorTracker.getStandardSchema(selector.schema)),
  ]);

// This class helps us maintain a client model of our server side subscriptions.
export class SelectorTracker<T = Result<Unit, Error>> {
  #refTracker = new MapSetStringToStrings();
  #selectors = new Map<string, SchemaPathSelector>();
  #standardizedSelector = new Map<string, SchemaPathSelector>();
  #selectorPromises = new Map<string, Promise<T>>();
  readonly #identity: () => ScopeKeyIdentity;

  constructor(identity: () => ScopeKeyIdentity) {
    this.#identity = identity;
  }

  #toKey({ id, scope, scopeKey }: BaseMemoryAddress): string {
    // An address that NAMES its instance (server-execution v2 stage A —
    // an instance-named load) keys by it; else the bound identity
    // resolves the scope name as before.
    return `${scopeKey ?? resolveScopeKey(scope, this.#identity())}\0${id}`;
  }

  add(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
    promise: Promise<T>,
  ) {
    if (selector === undefined || selector.schema === undefined) {
      return;
    }
    const selectorRef = selectorRefFor(selector);
    this.#refTracker.add(this.#toKey(address), selectorRef);
    this.#selectors.set(selectorRef, selector);
    this.#standardizedSelector.set(selectorRef, {
      path: selector.path,
      schema: SelectorTracker.getStandardSchema(selector.schema),
    });
    const promiseKey = `${this.#toKey(address)}?${selectorRef}`;
    this.#selectorPromises.set(promiseKey, promise);
  }

  has(address: BaseMemoryAddress): boolean {
    return this.#refTracker.has(this.#toKey(address));
  }

  hasSelector(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
  ): boolean {
    const selectorRefs = this.#refTracker.get(this.#toKey(address));
    if (selectorRefs !== undefined) {
      const selectorRef = selectorRefFor(selector);
      return selectorRefs.has(selectorRef);
    }
    return false;
  }

  getSupersetSelector(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
  ): [SchemaPathSelector?, Promise<T>?] {
    const selectorRefs = this.#refTracker.get(this.#toKey(address));
    const noMatch: [SchemaPathSelector?, Promise<T>?] = [undefined, undefined];
    if (selectorRefs === undefined) {
      return noMatch;
    }
    const newSelectorRef = selectorRefFor(selector);
    if (selectorRefs.has(newSelectorRef)) {
      const promiseKey = `${this.#toKey(address)}?${newSelectorRef}`;
      return [
        this.#standardizedSelector.get(newSelectorRef)!,
        this.#selectorPromises.get(promiseKey)!,
      ];
    }
    const newAddress = { ...address, path: selector.path };
    const newSchema = selector.schema
      ? SelectorTracker.getStandardSchema(selector.schema)
      : false;
    const newSchemaHash = newSchema === false ? false : hashSchema(newSchema);
    const newSchemaObj = isObjectOrArray(newSchema) ? newSchema : undefined;
    // Constant across the candidate loop; hoisted so the $defs-insensitive
    // comparison below doesn't recompute it per tracked selector.
    let newSchemaRefCount: number | undefined;
    for (const selectorRef of selectorRefs) {
      const existingSelector = this.#standardizedSelector.get(selectorRef)!;
      const existingAddress = { ...address, path: existingSelector.path };
      if (Address.includes(existingAddress, newAddress)) {
        const existingSchema = existingSelector.schema;
        if (existingSchema === undefined) {
          continue;
        }
        const subPath = newAddress.path.slice(existingAddress.path.length);
        // Tracked schemas are interned (deep-frozen), so this derivation hits
        // cfc.schemaAtPath's identity-keyed memo.
        const subSchema = ContextualFlowControl.schemaAtPath(
          existingSchema,
          subPath,
          undefined,
          false,
          false,
        );
        const sortedSubSchema = SelectorTracker.getStandardSchema(subSchema);
        const sortedSubSchemaHash = typeof sortedSubSchema === "boolean"
          ? sortedSubSchema
          : hashSchema(sortedSubSchema);
        if (
          ContextualFlowControl.isTrueSchema(subSchema) ||
          sortedSubSchemaHash === newSchemaHash ||
          SelectorTracker.checkAnyOf(subSchema, newSchemaHash) ||
          newSchema === false
        ) {
          const promiseKey = `${this.#toKey(address)}?${selectorRef}`;
          return [existingSelector, this.#selectorPromises.get(promiseKey)!];
        } else {
          const sortedSubSchemaObj = isObjectOrArray(sortedSubSchema)
            ? sortedSubSchema
            : undefined;
          if (newSchemaObj && sortedSubSchemaObj) {
            if (newSchemaRefCount === undefined) {
              const newSchemaRefs = new Set<string>();
              ContextualFlowControl.findRefs(newSchema, newSchemaRefs);
              newSchemaRefCount = newSchemaRefs.size;
            }
            if (
              newSchemaRefCount == 0 &&
              noDefsStandardHash(sortedSubSchemaObj) ===
                noDefsStandardHash(newSchemaObj)
            ) {
              const promiseKey = `${this.#toKey(address)}?${selectorRef}`;
              return [
                existingSelector,
                this.#selectorPromises.get(promiseKey)!,
              ];
            }
          }
        }
      }
    }
    return noMatch;
  }

  get(address: BaseMemoryAddress): IteratorObject<SchemaPathSelector> {
    const selectorRefs = this.#refTracker.get(this.#toKey(address)) ?? [];
    return selectorRefs.values().map((selectorRef) =>
      this.#selectors.get(selectorRef)!
    );
  }

  getPromise(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
  ): Promise<T> | undefined {
    const selectorRef = selectorRefFor(selector);
    const promiseKey = `${this.#toKey(address)}?${selectorRef}`;
    return this.#selectorPromises.get(promiseKey);
  }

  delete(address: BaseMemoryAddress, selector: SchemaPathSelector): void {
    const selectorRef = selectorRefFor(selector);
    this.#refTracker.deleteValue(this.#toKey(address), selectorRef);
    const promiseKey = `${this.#toKey(address)}?${selectorRef}`;
    this.#selectorPromises.delete(promiseKey);
    if (![...this.#refTracker].some(([, refs]) => refs.has(selectorRef))) {
      this.#selectors.delete(selectorRef);
      this.#standardizedSelector.delete(selectorRef);
    }
  }

  getAllPromises(): Iterable<Promise<T>> {
    return this.#selectorPromises.values();
  }

  getAllSubscriptions(): {
    address: BaseMemoryAddress;
    selector: SchemaPathSelector;
  }[] {
    const subscriptions: {
      address: BaseMemoryAddress;
      selector: SchemaPathSelector;
    }[] = [];
    for (const [factKey, selectorRefs] of this.#refTracker) {
      const address = fromKey(factKey);
      for (const selectorRef of selectorRefs) {
        const selector = this.#selectors.get(selectorRef);
        if (selector) {
          subscriptions.push({ address, selector });
        }
      }
    }
    return subscriptions;
  }

  static checkAnyOf(
    schema: JSONSchema,
    schemaHash: string | false,
  ): boolean {
    return isObjectOrArray(schema) && Array.isArray(schema.anyOf) &&
      (schema.anyOf.some((item) =>
        SelectorTracker.#anyOfItemHashes(schema, item).includes(
          schemaHash as string,
        )
      ));
  }

  /**
   * The standardized hashes an anyOf item can match under: its plain form,
   * its inherited-`$defs` form, and its `$ref`-resolved form. Branch-local
   * definitions keep their own scope. Computing these
   * builds fresh schema objects and re-hashes them, so cache the resulting
   * hash strings per (parent schema, item) identity when the parent is
   * deep-frozen (its items then are too).
   */
  static #anyOfItemHashesCache = new WeakMap<
    object,
    Map<JSONSchema, readonly string[]>
  >();

  static {
    // Entries can embed $ref-resolved forms, so a registry clear (last
    // lease out) swaps the cache — a resolution success must not outlive
    // its lease epoch.
    onSchemaRegistryClear(() => {
      SelectorTracker.#anyOfItemHashesCache = new WeakMap();
    });
  }

  static #anyOfItemHashes(
    schema: JSONSchema & object,
    item: JSONSchema,
  ): readonly string[] {
    const cacheable = isDeepFrozen(schema);
    let byItem: Map<JSONSchema, readonly string[]> | undefined;
    if (cacheable) {
      byItem = SelectorTracker.#anyOfItemHashesCache.get(schema);
      const cached = byItem?.get(item);
      if (cached !== undefined) {
        return cached;
      }
    }
    const hashes: string[] = [];
    const missesBefore = externalResolutionMissCount();
    let current = SelectorTracker.getStandardSchema(item);
    hashes.push(hashSchema(current));
    // An arm sits in the union's document, so it is also hashed carrying the
    // union's `$defs`, in place of any the arm declares of its own.
    if (isObjectNotArray(schema.$defs)) {
      current = SelectorTracker.getStandardSchema(
        schemaWithProperties(current, { $defs: schema.$defs }),
      );
      hashes.push(hashSchema(current));
    }
    if (isObjectOrArray(current) && current.$ref !== undefined) {
      // An unresolvable ref contributes no resolved-form hash. For an
      // external ref that is a recoverable miss — the schema document can
      // arrive later — which is why the populate below is gated on the
      // miss counter.
      const resolved = ContextualFlowControl.resolveSchemaRefs(
        current,
        schema,
      );
      if (resolved !== undefined) {
        hashes.push(
          hashSchema(SelectorTracker.getStandardSchema(resolved)),
        );
      }
    }
    // Populate only when no `cid:` resolution missed while computing: a
    // hash list computed over a hole must not outlive the document's
    // arrival. The miss counter is exact and walk-free.
    if (cacheable && externalResolutionMissCount() === missesBefore) {
      if (byItem === undefined) {
        byItem = new Map();
        SelectorTracker.#anyOfItemHashesCache.set(schema, byItem);
      }
      byItem.set(item, hashes);
    }
    return hashes;
  }

  static getStandardSchema(schema: JSONSchema): JSONSchema {
    if (typeof schema === "boolean") {
      return schema;
    }
    const cacheable = isDeepFrozen(schema);
    if (cacheable) {
      const cached = standardizedSchemaCache.get(schema);
      if (cached !== undefined) {
        return cached;
      }
    }
    // Content-keyed lookup. For frozen schemas the hash itself is cached by
    // identity (value-hash WeakMap), so a fresh-but-equal frozen copy costs
    // one walk ever; mutable schemas re-hash per call, which is what keeps
    // in-place edits correct.
    const contentKey = hashSchema(schema);
    const byContent = standardizedByContentCache.get(contentKey);
    if (byContent !== undefined) {
      if (cacheable) {
        standardizedSchemaCache.set(schema, byContent);
      }
      return byContent;
    }
    // TODO(danfuzz): this rebuild filters by key name only, so it also
    // rebuilds `default`/`examples` VALUES, dropping an `asCell` that a
    // default value happens to carry. Value-bearing keys want to pass
    // through by reference.
    //
    // A fabric value passes through by reference either way: the rebuild
    // reads a node by property name and would standardize one to `{}`,
    // losing it from the interned schema and making two schemas that differ
    // only in such a default intern identically.
    const traverse = (
      value: Readonly<any>,
    ): FabricValue => {
      if (isKeyableObjectOrArray(value)) {
        if (Array.isArray(value)) {
          return value.map((val) => traverse(val));
        } else {
          return Object.fromEntries(
            Object.entries(value).filter(([key, _val]) =>
              key !== "asCell" && key !== "asStream"
            ).sort(([keyA, _valA], [keyB, _valB]) =>
              keyA < keyB ? -1 : keyA > keyB ? 1 : 0
            ).map(([key, val]: [PropertyKey, any]) => [
              key.toString(),
              traverse(val),
            ]),
          );
        }
      } else return value;
    };
    const standardized = internSchema(traverse(schema) as JSONSchema);
    if (cacheable) {
      standardizedSchemaCache.set(schema, standardized);
    }
    standardizedByContentCache.put(contentKey, standardized);
    return standardized;
  }
}
