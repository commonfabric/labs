/**
 * Runtime-local immutable documents. A compact URI addresses a frozen value
 * and the origin against which its relative links resolve. Values stay native
 * until an outbound write expands the snapshot; no payload lives in the URI.
 */

import type { JSONSchema } from "@commonfabric/api";
import {
  assertAcyclicFabricValue,
  cloneIfNecessary,
  type FabricValue,
  forEachFabricContainerValue,
  hashStringOf,
} from "@commonfabric/data-model";
import {
  hasDataUriScheme,
  isFabricDataUri,
  valueFromDataUri,
} from "@commonfabric/data-model/codec-data-uri";
import {
  isLinkRef,
  linkRefFrom,
  linkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import { collectExternalSchemaRefHashes } from "@commonfabric/data-model-schema/schema-refs";
import { walkSchemaDocumentClosure } from "@commonfabric/data-model-schema/schema-closure";

import {
  lookupSchemaDocument,
  onSchemaDocumentRegistered,
} from "./schema-registry.ts";
import type { NormalizedLink } from "./link-types.ts";
import type { CellLinkRefPayload, URI } from "./sigil-types.ts";

/** The addressing context needed to interpret a relative primitive link. */
type SnapshotOrigin = Pick<NormalizedLink, "id" | "space" | "scope">;

/**
 * A frozen snapshot and its optional relative-link origin: the stored
 * document the value was read out of, which a relative link inside the
 * value resolves against. A snapshot minted from a value no space has stored
 * (`Runtime.getImmutableCell()`) has none.
 */
export interface ImmutableSnapshot {
  readonly id: URI;
  readonly value: FabricValue;
  readonly origin: SnapshotOrigin | undefined;
}

/** Weak lookup shared by live runtimes; values are retained by their owners. */
const snapshots = new Map<
  URI,
  { value: WeakRef<ImmutableSnapshot>; owners: number }
>();

/** Ephemeron edges: live values and handles retain their element owners. */
const elementSnapshotOwners = new WeakMap<
  ImmutableSnapshot,
  WeakMap<ImmutableCellStore, ImmutableCellStore>
>();
const handleSnapshots = new WeakMap<object, ImmutableSnapshot>();
const finalizedElementStores = new FinalizationRegistry<{
  owners: Set<WeakRef<ImmutableCellStore>>;
  ref: WeakRef<ImmutableCellStore>;
}>(({ owners, ref }) => owners.delete(ref));

/** Owners and their transactions share one store without extending its life. */
const owners = new WeakMap<object, ImmutableCellStore>();

/** Releases one owner's identifiers without invalidating another owner's values. */
function releaseSnapshots(ids: Set<URI>): void {
  for (const id of ids) {
    const entry = snapshots.get(id);
    if (entry !== undefined && --entry.owners === 0) snapshots.delete(id);
  }
  ids.clear();
}

/** Releases identifiers when a runtime is reclaimed without disposal. */
const finalizedStores = new FinalizationRegistry<Set<URI>>(releaseSnapshots);

/**
 * Holds explicitly created snapshots for one runtime. Traversal snapshots are
 * owned by their frozen source values and live cell/link handles, so discarded
 * document versions release their snapshots. Disposal releases both kinds.
 */
export class ImmutableCellStore {
  #elementStores = new WeakMap<object, ImmutableCellStore>();
  readonly #elementOwners = new Set<WeakRef<ImmutableCellStore>>();
  readonly #ids = new Set<URI>();
  readonly #snapshots = new Map<URI, ImmutableSnapshot>();
  #dependencies = new WeakMap<object, readonly ImmutableSnapshot[]>();
  #readerSchemas = new WeakMap<object, FabricValue>();
  readonly #settled = new Set<URI>();
  readonly #pending = new Set<ImmutableSnapshot>();
  readonly #pendingValues = new Set<FabricValue>();
  readonly #retaining = new Set<URI>();
  #unsubscribeSchemas: (() => void) | undefined;
  #origins = new Map<string, { value: SnapshotOrigin; hash: string }>();
  #disposed = false;

  /** Registers cleanup without retaining the store or its values. */
  constructor() {
    finalizedStores.register(this, this.#ids, this);
  }

  /**
   * Returns a snapshot, copying only mutable input. The content hash is the
   * shared Fabric hash, memoized by frozen-value identity. Origins omit paths
   * and schemas: relative link paths start at their document's value root.
   */
  create(value: FabricValue, base?: NormalizedLink): ImmutableSnapshot {
    if (this.#disposed) throw new Error("Immutable cell store is disposed");
    assertAcyclicFabricValue(value);
    const snapshot = this.#findSnapshot(cloneIfNecessary(value), base);
    this.#retain(snapshot);
    return snapshot;
  }

  /**
   * Creates an element snapshot owned by its frozen value and escaped handles.
   * A bare URI string does not retain an element; portable export is required
   * when the reference must outlive those owners.
   */
  createElement(value: FabricValue, base: NormalizedLink): ImmutableSnapshot {
    if (this.#disposed) throw new Error("Immutable cell store is disposed");
    const frozen = cloneIfNecessary(value);
    if (typeof frozen !== "object" || frozen === null) {
      throw new TypeError("Element snapshots require a container");
    }
    assertAcyclicFabricValue(frozen);
    const snapshot = this.#findSnapshot(frozen, base);
    // Equal content shares one weak owner even across distinct source objects.
    let snapshotOwners = elementSnapshotOwners.get(snapshot);
    if (snapshotOwners === undefined) {
      snapshotOwners = new WeakMap();
      elementSnapshotOwners.set(snapshot, snapshotOwners);
    }
    let store = snapshotOwners.get(this) ?? this.#elementStores.get(frozen);
    if (store === undefined) {
      store = new ImmutableCellStore();
      const ref = new WeakRef(store);
      this.#elementOwners.add(ref);
      finalizedElementStores.register(store, {
        owners: this.#elementOwners,
        ref,
      });
    }
    this.#elementStores.set(frozen, store);
    store.#retain(snapshot);
    snapshotOwners.set(this, store);
    return snapshot;
  }

  /** Retains snapshots referenced by a reader schema without minting a value ID. */
  retainSchema(schema: JSONSchema | undefined): void {
    if (this.#disposed) throw new Error("Immutable cell store is disposed");
    if (schema === undefined || typeof schema === "boolean") return;
    const frozen = cloneIfNecessary(schema);
    let value = this.#readerSchemas.get(frozen);
    if (value === undefined) {
      value = linkRefFrom({ schema: frozen });
      this.#readerSchemas.set(frozen, value);
    }
    this.#retainValue(value);
  }

  /** Returns a live snapshot, or throws for an absent or expired identifier. */
  get(id: URI): ImmutableSnapshot {
    const snapshot = this.#snapshots.get(id);
    if (snapshot === undefined) throw new Error("Unknown immutable cell");
    return snapshot;
  }

  /** Releases this runtime's snapshots and invalidates their identifiers. */
  dispose(): void {
    this.#disposed = true;
    for (const owner of this.#elementOwners) owner.deref()?.dispose();
    this.#elementOwners.clear();
    this.#elementStores = new WeakMap();
    this.#snapshots.clear();
    this.#settled.clear();
    this.#pending.clear();
    this.#pendingValues.clear();
    this.#unsubscribeSchemas?.();
    this.#unsubscribeSchemas = undefined;
    this.#dependencies = new WeakMap();
    this.#readerSchemas = new WeakMap();
    this.#origins.clear();
    releaseSnapshots(this.#ids);
    finalizedStores.unregister(this);
  }

  #findSnapshot(frozen: FabricValue, base?: NormalizedLink): ImmutableSnapshot {
    const resolved = base === undefined ? undefined : immutableOrigin(base);
    // This key contains only address strings, never cell data or a schema.
    const originKey = resolved === undefined ? undefined : JSON.stringify([
      resolved.id,
      resolved.space,
      resolved.scope,
    ]);
    let cachedOrigin = originKey === undefined
      ? undefined
      : this.#origins.get(originKey);
    if (
      resolved !== undefined && originKey !== undefined &&
      cachedOrigin === undefined
    ) {
      const value = Object.freeze({
        ...(resolved.id === undefined ? {} : { id: resolved.id }),
        ...(resolved.space === undefined ? {} : { space: resolved.space }),
        ...(resolved.scope === undefined ? {} : { scope: resolved.scope }),
      });
      cachedOrigin = { value, hash: hashStringOf(value) };
      this.#origins.set(originKey, cachedOrigin);
    }
    const origin = cachedOrigin?.value;
    const key = hashStringOf(frozen) +
      (cachedOrigin === undefined ? "" : `:${cachedOrigin.hash}`);
    const id: URI = `snapshot:${key}`;
    let snapshot = this.#snapshots.get(id);
    if (snapshot === undefined) {
      snapshot = snapshots.get(id)?.value.deref();
      if (snapshot === undefined) {
        snapshot = Object.freeze({ id, value: frozen, origin });
      }
    }
    return snapshot;
  }

  #retainValue(value: FabricValue, deferExpired = false): void {
    const { dependencies, complete } = this.#collectDependencies(
      value,
      deferExpired,
    );
    for (const dependency of dependencies) {
      this.#retain(dependency, deferExpired);
    }
    if (complete) this.#pendingValues.delete(value);
    else {
      this.#pendingValues.add(value);
      this.#watchSchemas();
    }
  }

  /** Finds dependencies in codec state, inline schemas, and available closures. */
  #collectDependencies(value: FabricValue, deferExpired: boolean): {
    dependencies: readonly ImmutableSnapshot[];
    complete: boolean;
  } {
    const object = typeof value === "object" && value !== null
      ? value
      : undefined;
    const cached = object === undefined
      ? undefined
      : this.#dependencies.get(object);
    if (cached !== undefined) return { dependencies: cached, complete: true };
    const nested = new Set<ImmutableSnapshot>();
    let hasExpired = false;
    const schemaRoots = new Set<string>();
    const collect = (value: FabricValue, follow?: (hash: string) => void) => {
      forEachFabricContainerValue(value, (container) => {
        if (!isLinkRef(container)) return;
        const payload = linkRefPayload(container) as CellLinkRefPayload;
        if (payload.id !== undefined && isImmutableCellId(payload.id)) {
          const target = snapshots.get(payload.id)?.value.deref();
          if (target !== undefined) nested.add(target);
          else if (deferExpired) hasExpired = true;
          else immutableSnapshot(payload.id);
        }
        for (const hash of collectExternalSchemaRefHashes(payload.schema)) {
          if (!schemaRoots.has(hash)) {
            schemaRoots.add(hash);
            follow?.(hash);
          }
        }
      }, { allowCycles: true });
    };
    collect(value);
    const closure = walkSchemaDocumentClosure({
      roots: schemaRoots,
      load: (hash) => {
        const schema = lookupSchemaDocument(hash);
        return schema === undefined ? undefined : { kind: "verified", schema };
      },
      onVerified: (_hash, schema, walk) => {
        collect(schema, (hash) => walk.follow(hash));
      },
    });
    const dependencies = Object.freeze([...nested]);
    const complete = closure.missing.size === 0 && !hasExpired;
    if (object !== undefined && complete) {
      this.#dependencies.set(object, dependencies);
    }
    return { dependencies, complete };
  }

  /** Acquires dependencies, revisiting incomplete closures when documents arrive. */
  #retain(snapshot: ImmutableSnapshot, deferExpired = false): void {
    if (this.#settled.has(snapshot.id) || this.#retaining.has(snapshot.id)) {
      return;
    }
    this.#retaining.add(snapshot.id);
    try {
      const collected = this.#collectDependencies(
        snapshot.value,
        deferExpired,
      );
      let complete = collected.complete;
      for (const dependency of collected.dependencies) {
        this.#retain(dependency, deferExpired);
      }
      if (
        snapshot.origin?.id !== undefined &&
        isImmutableCellId(snapshot.origin.id)
      ) {
        const origin = snapshots.get(snapshot.origin.id)?.value.deref();
        if (origin !== undefined) this.#retain(origin, deferExpired);
        else if (deferExpired) complete = false;
        else immutableSnapshot(snapshot.origin.id);
      }
      if (!this.#snapshots.has(snapshot.id)) {
        const shared = snapshots.get(snapshot.id);
        snapshots.set(snapshot.id, {
          value: new WeakRef(snapshot),
          owners: (shared?.owners ?? 0) + 1,
        });
        this.#snapshots.set(snapshot.id, snapshot);
        this.#ids.add(snapshot.id);
      }
      if (complete) {
        this.#settled.add(snapshot.id);
        this.#pending.delete(snapshot);
      } else {
        this.#pending.add(snapshot);
        this.#watchSchemas();
      }
    } finally {
      this.#retaining.delete(snapshot.id);
    }
  }

  #watchSchemas(): void {
    if (this.#unsubscribeSchemas !== undefined) return;
    const owner = new WeakRef(this);
    const unsubscribe = onSchemaDocumentRegistered(() => {
      const store = owner.deref();
      if (store === undefined) unsubscribe();
      else store.#refreshPending();
    });
    this.#unsubscribeSchemas = unsubscribe;
  }

  /** Acquires newly visible dependencies before schema registration returns. */
  #refreshPending(): void {
    for (const snapshot of this.#pending) this.#retain(snapshot, true);
    for (const value of this.#pendingValues) this.#retainValue(value, true);
    if (this.#pending.size === 0 && this.#pendingValues.size === 0) {
      this.#unsubscribeSchemas?.();
      this.#unsubscribeSchemas = undefined;
    }
  }
}

/** Creates or returns the store for an explicitly declared lifetime owner. */
export function ownImmutableCells(owner: object): ImmutableCellStore {
  let store = owners.get(owner);
  if (store === undefined) {
    store = new ImmutableCellStore();
    owners.set(owner, store);
  }
  return store;
}

/** Returns a bound owner's store, following transparent transaction wrappers. */
export function immutableCellsFor(owner: object): ImmutableCellStore {
  const store = findImmutableCells(owner);
  if (store === undefined) {
    throw new Error("Immutable cells require an explicitly bound owner");
  }
  return store;
}

/** Finds an existing ownership binding through transparent wrappers. */
export function findImmutableCells(
  owner: object,
): ImmutableCellStore | undefined {
  const visited = new Set<object>();
  let current: object | undefined = owner;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const store = owners.get(current);
    if (store !== undefined) return store;
    const wrapped: unknown = Reflect.get(current, "wrappedTransaction") ??
      Reflect.get(current, "tx");
    current = typeof wrapped === "object" && wrapped !== null
      ? wrapped
      : undefined;
  }
  return undefined;
}

/** Keeps an element snapshot alive for as long as its cell or link object. */
export function pinImmutableCell<T extends object>(
  handle: T,
  id: URI | undefined,
): T {
  if (id !== undefined && isImmutableCellId(id)) {
    handleSnapshots.set(handle, immutableSnapshot(id));
  }
  return handle;
}

/** Binds a transaction to the immutable documents of its owning runtime. */
export function bindImmutableCells(
  owner: object,
  store: ImmutableCellStore,
): void {
  owners.set(owner, store);
}

/** Whether an identifier names a runtime-local snapshot. */
export function isImmutableCellId(id: string): id is `snapshot:${string}` {
  return id.startsWith("snapshot:");
}

/** Whether an identifier names an inline, read-only document of any format. */
export function hasInlineCellScheme(id: string): boolean {
  return isImmutableCellId(id) || hasDataUriScheme(id);
}

/** Whether an inline identifier is one the runtime can expand to a value. */
export function isInlineCellId(id: string): boolean {
  return isImmutableCellId(id) || isFabricDataUri(id);
}

/**
 * How many distinct snapshots any store in this process retains, element
 * stores included. A snapshot several stores share counts once; one released
 * by every owner, or whose owners were reclaimed, is gone from the count.
 */
export function liveImmutableSnapshotCount(): number {
  return snapshots.size;
}

/** The key an unattributed snapshot counts under, by space. */
export const IMMUTABLE_SNAPSHOTS_NO_SPACE = "(none)";

/**
 * The snapshots {@link liveImmutableSnapshotCount} counts, by the space of
 * the stored document each was read out of, following an element's chain of
 * origins to its root. A snapshot whose chain ends anywhere but a stored
 * document, at a value no space has stored, at an inline document, or at an
 * origin that has expired, and one whose own value has been reclaimed ahead
 * of its identifier count under {@link IMMUTABLE_SNAPSHOTS_NO_SPACE}. One
 * pass over the snapshot table, so the read costs what the table holds.
 */
export function liveImmutableSnapshotsBySpace(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { value } of snapshots.values()) {
    const key = storedOriginSpace(value.deref()) ??
      IMMUTABLE_SNAPSHOTS_NO_SPACE;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Helper for `liveImmutableSnapshotsBySpace()`: the space of the stored
 * document at the root of `snapshot`'s chain of origins, or `undefined` when
 * the chain ends at no stored document: at a snapshot with no origin, at an
 * inline document, or at an origin that has expired.
 */
function storedOriginSpace(
  snapshot: ImmutableSnapshot | undefined,
): string | undefined {
  let origin = snapshot?.origin;
  while (origin !== undefined) {
    const { id } = origin;
    if (id === undefined) return origin.space;
    if (!isImmutableCellId(id)) {
      return hasInlineCellScheme(id) ? undefined : origin.space;
    }
    const next = snapshots.get(id)?.value.deref();
    if (next === undefined) return undefined;
    origin = next.origin;
  }
  return undefined;
}

/**
 * Whether `id` names a snapshot minted from a value no space has stored: one
 * read out of no stored document, so with no origin, or an element snapshot
 * whose chain of origins ends at one rather than at a stored document. The
 * links inside such a snapshot were never written, so no space holds the
 * closure a reference among their schemas names; the registry that minted
 * the reference does.
 */
export function mintedFromUnstoredValue(id: string): boolean {
  while (isImmutableCellId(id)) {
    const origin = immutableSnapshot(id).origin;
    if (origin === undefined) return true;
    if (origin.id === undefined) return false;
    id = origin.id;
  }
  return false;
}

/** Looks up a runtime-local snapshot without retaining its runtime. */
export function immutableSnapshot(id: URI): ImmutableSnapshot {
  const snapshot = snapshots.get(id)?.value.deref();
  if (snapshot === undefined) {
    throw new Error("Unknown or expired immutable cell");
  }
  return snapshot;
}

/** Returns an inline cell's native value, decoding legacy identifiers as needed. */
export function inlineCellValue(id: URI): FabricValue {
  return isImmutableCellId(id)
    ? immutableSnapshot(id).value
    : valueFromDataUri(id);
}

/** Returns the origin a link inside `base` resolves against. */
export function immutableOrigin<T extends SnapshotOrigin>(base: T): T {
  if (base.id === undefined || !isImmutableCellId(base.id)) return base;
  const origin = immutableSnapshot(base.id).origin;
  return origin === undefined ? base : { ...base, ...origin };
}
