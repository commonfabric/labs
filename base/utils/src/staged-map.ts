/**
 * Temporary map changes over an exclusively held base. Reads and writes touch
 * only the requested keys; `commit()` publishes them into the base. Discarding
 * the stage publishes nothing. The caller must neither mutate the base nor
 * retain the stage after committing it. Mutable values need a copying function
 * so reading a value from the stage cannot expose a mutable base container.
 */
export class StagedMap<K, V> extends Map<K, V> {
  #base: Map<K, V>;
  #copy?: (value: V) => V;
  #changes = new Map<K, V>();
  #removed = new Set<K>();
  #cleared = false;
  #size: number;

  /** Constructs an instance which stages changes without enumerating `base`. */
  constructor(base: Map<K, V>, copy?: (value: V) => V) {
    super();
    this.#base = base;
    this.#copy = copy;
    this.#size = base.size;
  }

  /** @inheritDoc */
  override get size(): number {
    return this.#size;
  }

  /** @inheritDoc */
  override has(key: K): boolean {
    return this.#changes.has(key) ||
      (!this.#cleared && !this.#removed.has(key) && this.#base.has(key));
  }

  /** @inheritDoc */
  override get(key: K): V | undefined {
    if (this.#changes.has(key)) return this.#changes.get(key);
    if (this.#cleared || this.#removed.has(key) || !this.#base.has(key)) {
      return undefined;
    }
    const value = this.#base.get(key)!;
    if (this.#copy === undefined) return value;
    const copied = this.#copy(value);
    this.#changes.set(key, copied);
    return copied;
  }

  /** @inheritDoc */
  override set(key: K, value: V): this {
    if (!this.has(key)) this.#size++;
    this.#changes.set(key, value);
    return this;
  }

  /** @inheritDoc */
  override getOrInsert(key: K, value: V): V {
    if (this.has(key)) return this.get(key)!;
    this.set(key, value);
    return value;
  }

  /** @inheritDoc */
  override getOrInsertComputed(key: K, callback: (key: K) => V): V {
    if (typeof callback !== "function") {
      throw new TypeError("`getOrInsertComputed` requires a callable callback");
    }
    if (this.has(key)) return this.get(key)!;
    const canonicalKey = Object.is(key, -0) ? 0 as K : key;
    const value = callback(canonicalKey);
    this.set(canonicalKey, value);
    return value;
  }

  /** @inheritDoc */
  override delete(key: K): boolean {
    if (!this.has(key)) return false;
    this.#size--;
    this.#changes.delete(key);
    if (!this.#cleared && this.#base.has(key)) this.#removed.add(key);
    return true;
  }

  /** @inheritDoc */
  override clear(): void {
    this.#cleared = true;
    this.#size = 0;
    this.#changes.clear();
    this.#removed.clear();
  }

  /** @inheritDoc */
  override *entries(): MapIterator<[K, V]> {
    for (const key of this.#base.keys()) {
      if (this.#cleared) break;
      if (!this.#removed.has(key)) yield [key, this.get(key)!];
    }
    for (const [key, value] of this.#changes) {
      if (this.#cleared || this.#removed.has(key) || !this.#base.has(key)) {
        yield [key, value];
      }
    }
    return undefined;
  }

  /** @inheritDoc */
  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  /** @inheritDoc */
  override *keys(): MapIterator<K> {
    for (const [key] of this.entries()) yield key;
    return undefined;
  }

  /** @inheritDoc */
  override *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
    return undefined;
  }

  /** @inheritDoc */
  override forEach(
    callbackfn: (value: V, key: K, map: Map<K, V>) => void,
    thisArg?: unknown,
  ): void {
    if (typeof callbackfn !== "function") {
      throw new TypeError("`forEach` requires a callable callback");
    }
    for (const [key, value] of this.entries()) {
      Reflect.apply(callbackfn, thisArg, [value, key, this]);
    }
  }

  /** Yields keys whose values or membership may differ from the base. */
  *changedKeys(): IterableIterator<K> {
    const removed = this.#cleared ? this.#base.keys() : this.#removed;
    for (const key of removed) {
      if (!this.#changes.has(key)) yield key;
    }
    yield* this.#changes.keys();
  }

  /** Publishes the stage into the base, preserving map insertion order. */
  commit(): void {
    if (this.#cleared) this.#base.clear();
    else for (const key of this.#removed) this.#base.delete(key);
    for (const [key, value] of this.#changes) this.#base.set(key, value);
  }
}
