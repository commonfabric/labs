/**
 * Effectively immutable wrappers for built-in collection types (`Map`, `Set`).
 *
 * These wrappers preserve the public collection surface and `instanceof`
 * behavior, but they intentionally do not carry JS `Map` / `Set` internal
 * slots. Their data lives in module-private backing stores keyed by the wrapper
 * instance. That makes intrinsic mutators like `Map.prototype.set.call(...)`
 * and `Set.prototype.add.call(...)` fail with an incompatible receiver instead
 * of mutating hidden internal state on a frozen object.
 */

type MapBacking<K, V> = Map<K, V>;
type SetBacking<T> = Set<T>;

/** Builder for a `FrozenMap`, which fills it before it is handed out. */
type MapBuilder<K, V> = {
  /** The map being built. */
  readonly wrapper: FrozenMap<K, V>;

  /** Sets `key` to `value`. */
  set(key: K, value: V): void;

  /** Seals the map and returns it. */
  finish(): FrozenMap<K, V>;
};

/** Builder for a `FrozenSet`, which fills it before it is handed out. */
type SetBuilder<T> = {
  /** The set being built. */
  readonly wrapper: FrozenSet<T>;

  /** Adds `value`. */
  add(value: T): void;

  /** Seals the set and returns it. */
  finish(): FrozenSet<T>;
};

const MAP_BACKING = new WeakMap<object, MapBacking<unknown, unknown>>();
const SET_BACKING = new WeakMap<object, SetBacking<unknown>>();
const INTERNAL_MAP_BUILDER = Symbol("FrozenMapBuilder");
const INTERNAL_SET_BUILDER = Symbol("FrozenSetBuilder");

/**
 * Helper for the mutator methods, which throws to signal a frozen-mutation
 * attempt.
 */
function throwFrozenMutation(typeName: string): never {
  throw new TypeError(`Cannot mutate a \`${typeName}\``);
}

/**
 * Helper for builders, which throws to signal a post-`finish()` mutation
 * attempt.
 */
function throwFinalizedBuilderMutation(typeName: string): never {
  throw new TypeError(`Cannot mutate a finalized \`${typeName}\` builder`);
}

/**
 * Helper for the `FrozenMap` methods, which fetches the backing `Map` for the
 * given wrapper instance. Throws if `value` is not a recognized `FrozenMap`
 * receiver (e.g. when a `FrozenMap` method was applied to a foreign object via
 * `call(...)`). Note that an *intrinsic* `Map` method applied to a `FrozenMap`
 * never gets this far: it fails its own internal-slot check first.
 */
function getMapBacking<K, V>(value: object): MapBacking<K, V> {
  const backing = MAP_BACKING.get(value);
  if (!backing) {
    throw new TypeError("Incompatible `FrozenMap` receiver");
  }
  return backing as MapBacking<K, V>;
}

/**
 * Helper for the `FrozenSet` methods, which fetches the backing `Set` for the
 * given wrapper instance. Throws if `value` is not a recognized `FrozenSet`
 * receiver, under the same conditions described on `getMapBacking()`.
 */
function getSetBacking<T>(value: object): SetBacking<T> {
  const backing = SET_BACKING.get(value);
  if (!backing) {
    throw new TypeError("Incompatible `FrozenSet` receiver");
  }
  return backing as SetBacking<T>;
}

/**
 * Helper for the set-algebra methods, which iterates the values of a
 * `ReadonlySetLike`, invoking `callback` for each.
 */
function forEachSetLikeValue<T>(
  setLike: ReadonlySetLike<T>,
  callback: (value: T) => void,
): void {
  const iterator = setLike.keys();
  while (true) {
    const next = iterator.next();
    if (next.done) {
      return;
    }
    callback(next.value);
  }
}

/**
 * Effectively-immutable `Map` wrapper. Read methods delegate to a
 * module-private backing `Map`; mutator methods (`set()`, `delete()`,
 * `clear()`, etc.) throw. Instances are frozen at construction time (or at
 * builder `finish()` time, see `createBuilder()`).
 */
export class FrozenMap<K, V> implements Map<K, V> {
  /**
   * Constructs an instance from the given entries. The instance is frozen
   * unless `builderToken` matches the module-private builder symbol (used by
   * `createBuilder()` to allow staged population before freezing).
   */
  constructor(
    entries?: Iterable<readonly [K, V]> | null,
    builderToken?: symbol,
  ) {
    MAP_BACKING.set(this, new Map(entries ?? undefined));
    if (builderToken !== INTERNAL_MAP_BUILDER) {
      Object.freeze(this);
    }
  }

  /** Same as `Map.prototype.size`. */
  get size(): number {
    return getMapBacking<K, V>(this).size;
  }

  /** Same as `Map.prototype[Symbol.toStringTag]`; always `"Map"`. */
  get [Symbol.toStringTag](): string {
    return "Map";
  }

  /** Same as `Map.prototype.get`. */
  get(key: K): V | undefined {
    return getMapBacking<K, V>(this).get(key);
  }

  /** Same as `Map.prototype.has`. */
  has(key: K): boolean {
    return getMapBacking<K, V>(this).has(key);
  }

  /** Same as `Map.prototype.entries`. */
  entries(): ReturnType<Map<K, V>["entries"]> {
    return getMapBacking<K, V>(this).entries();
  }

  /** Same as `Map.prototype.keys`. */
  keys(): ReturnType<Map<K, V>["keys"]> {
    return getMapBacking<K, V>(this).keys();
  }

  /** Same as `Map.prototype.values`. */
  values(): ReturnType<Map<K, V>["values"]> {
    return getMapBacking<K, V>(this).values();
  }

  /** Same as `Map.prototype.forEach`. */
  forEach(
    callbackfn: (value: V, key: K, map: Map<K, V>) => void,
    thisArg?: unknown,
  ): void {
    getMapBacking<K, V>(this).forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }

  /** Same as `Map.prototype[Symbol.iterator]`. */
  [Symbol.iterator](): ReturnType<Map<K, V>[typeof Symbol.iterator]> {
    return this.entries();
  }

  /** Always throws (instance is frozen). */
  set(_key: K, _value: V): this {
    throwFrozenMutation("FrozenMap");
  }

  /** Always throws (instance is frozen). */
  getOrInsert(_key: K, _defaultValue: V): V {
    throwFrozenMutation("FrozenMap");
  }

  /** Always throws (instance is frozen). */
  getOrInsertComputed(_key: K, _callback: (key: K) => V): V {
    throwFrozenMutation("FrozenMap");
  }

  /** Always throws (instance is frozen). */
  delete(_key: K): boolean {
    throwFrozenMutation("FrozenMap");
  }

  /** Always throws (instance is frozen). */
  clear(): void {
    throwFrozenMutation("FrozenMap");
  }

  //
  // Static members
  //

  /**
   * Returns a builder that can be used to populate a `FrozenMap` incrementally
   * before freezing it. Call `set()` to add entries, then `finish()` to freeze
   * the wrapper and return it.
   */
  static createBuilder<K, V>(): MapBuilder<K, V> {
    const wrapper = new FrozenMap<K, V>(undefined, INTERNAL_MAP_BUILDER);
    let finalized = false;

    const assertOpen = (): void => {
      if (finalized) {
        throwFinalizedBuilderMutation("FrozenMap");
      }
    };

    return {
      wrapper,
      set(key: K, value: V): void {
        assertOpen();
        getMapBacking<K, V>(wrapper).set(key, value);
      },
      finish(): FrozenMap<K, V> {
        finalized = true;
        Object.freeze(wrapper);
        return wrapper;
      },
    };
  }
}

Object.setPrototypeOf(FrozenMap.prototype, Map.prototype);
Object.setPrototypeOf(FrozenMap, Map);

/**
 * Effectively-immutable `Set` wrapper. Read methods and set-algebra methods
 * delegate to a module-private backing `Set`; mutator methods (`add()`,
 * `delete()`, `clear()`) throw. Instances are frozen at construction time (or
 * at builder `finish()` time, see `createBuilder()`).
 */
export class FrozenSet<T> implements Set<T> {
  /**
   * Constructs an instance from the given values. The instance is frozen
   * unless `builderToken` matches the module-private builder symbol (used by
   * `createBuilder()` to allow staged population before freezing).
   */
  constructor(values?: Iterable<T> | null, builderToken?: symbol) {
    SET_BACKING.set(this, new Set(values ?? undefined));
    if (builderToken !== INTERNAL_SET_BUILDER) {
      Object.freeze(this);
    }
  }

  /** Same as `Set.prototype.size`. */
  get size(): number {
    return getSetBacking<T>(this).size;
  }

  /** Same as `Set.prototype[Symbol.toStringTag]`; always `"Set"`. */
  get [Symbol.toStringTag](): string {
    return "Set";
  }

  /** Same as `Set.prototype.has`. */
  has(value: T): boolean {
    return getSetBacking<T>(this).has(value);
  }

  /** Same as `Set.prototype.entries`. */
  entries(): ReturnType<Set<T>["entries"]> {
    return getSetBacking<T>(this).entries();
  }

  /** Same as `Set.prototype.keys`. */
  keys(): ReturnType<Set<T>["keys"]> {
    return getSetBacking<T>(this).keys();
  }

  /** Same as `Set.prototype.values`. */
  values(): ReturnType<Set<T>["values"]> {
    return getSetBacking<T>(this).values();
  }

  /** Same as `Set.prototype.forEach`. */
  forEach(
    callbackfn: (value: T, key: T, set: Set<T>) => void,
    thisArg?: unknown,
  ): void {
    getSetBacking<T>(this).forEach((value) => {
      callbackfn.call(thisArg, value, value, this as Set<T>);
    });
  }

  /** Same as `Set.prototype[Symbol.iterator]`. */
  [Symbol.iterator](): ReturnType<Set<T>[typeof Symbol.iterator]> {
    return this.values();
  }

  /** Same as `Set.prototype.union`. Returns a new (mutable) `Set`. */
  union<U>(other: ReadonlySetLike<U>): Set<T | U> {
    const result = new Set<T | U>(this.values());
    forEachSetLikeValue(other, (value) => {
      result.add(value);
    });
    return result;
  }

  /**
   * Same as `Set.prototype.intersection`. Returns a new (mutable) `Set`.
   *
   * As with the intrinsic, the smaller operand is the one iterated, which
   * means the result's iteration order follows that operand.
   */
  intersection<U>(other: ReadonlySetLike<U>): Set<T & U> {
    const result = new Set<T & U>();
    if (this.size <= other.size) {
      for (const value of this.values()) {
        if (other.has(value as unknown as U)) {
          result.add(value as T & U);
        }
      }
    } else {
      forEachSetLikeValue(other, (value) => {
        if (this.has(value as unknown as T)) {
          result.add(value as T & U);
        }
      });
    }
    return result;
  }

  /** Same as `Set.prototype.difference`. Returns a new (mutable) `Set`. */
  difference<U>(other: ReadonlySetLike<U>): Set<T> {
    const result = new Set<T>();
    for (const value of this.values()) {
      if (!other.has(value as unknown as U)) {
        result.add(value);
      }
    }
    return result;
  }

  /**
   * Same as `Set.prototype.symmetricDifference`. Returns a new (mutable)
   * `Set`.
   */
  symmetricDifference<U>(other: ReadonlySetLike<U>): Set<T | U> {
    const result = new Set<T | U>(this.values());
    forEachSetLikeValue(other, (value) => {
      if (result.has(value)) {
        result.delete(value);
      } else {
        result.add(value);
      }
    });
    return result;
  }

  /** Same as `Set.prototype.isSubsetOf`. */
  isSubsetOf(other: Parameters<Set<T>["isSubsetOf"]>[0]): boolean {
    for (const value of this.values()) {
      if (!other.has(value)) {
        return false;
      }
    }
    return true;
  }

  /** Same as `Set.prototype.isSupersetOf`. */
  isSupersetOf(other: Parameters<Set<T>["isSupersetOf"]>[0]): boolean {
    let result = true;
    forEachSetLikeValue(other, (value) => {
      if (!this.has(value as T)) {
        result = false;
      }
    });
    return result;
  }

  /** Same as `Set.prototype.isDisjointFrom`. */
  isDisjointFrom(other: Parameters<Set<T>["isDisjointFrom"]>[0]): boolean {
    let result = true;
    forEachSetLikeValue(other, (value) => {
      if (this.has(value as T)) {
        result = false;
      }
    });
    return result;
  }

  /** Always throws (instance is frozen). */
  add(_value: T): this {
    throwFrozenMutation("FrozenSet");
  }

  /** Always throws (instance is frozen). */
  delete(_value: T): boolean {
    throwFrozenMutation("FrozenSet");
  }

  /** Always throws (instance is frozen). */
  clear(): void {
    throwFrozenMutation("FrozenSet");
  }

  //
  // Static members
  //

  /**
   * Returns a builder that can be used to populate a `FrozenSet` incrementally
   * before freezing it. Call `add()` to add values, then `finish()` to freeze
   * the wrapper and return it.
   */
  static createBuilder<T>(): SetBuilder<T> {
    const wrapper = new FrozenSet<T>(undefined, INTERNAL_SET_BUILDER);
    let finalized = false;

    const assertOpen = (): void => {
      if (finalized) {
        throwFinalizedBuilderMutation("FrozenSet");
      }
    };

    return {
      wrapper,
      add(value: T): void {
        assertOpen();
        getSetBacking<T>(wrapper).add(value);
      },
      finish(): FrozenSet<T> {
        finalized = true;
        Object.freeze(wrapper);
        return wrapper;
      },
    };
  }
}

Object.setPrototypeOf(FrozenSet.prototype, Set.prototype);
Object.setPrototypeOf(FrozenSet, Set);
