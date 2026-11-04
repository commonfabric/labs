/** Options common to the caches defined here. */
export interface CacheOptions {
  /** Maximum number of entries to hold. */
  capacity?: number;
}

/**
 * Options for a cache that bounds the total weight of what it holds, as well
 * as the number of entries.
 */
export interface WeightedCacheOptions<K, V> extends CacheOptions {
  /**
   * Cost of one entry, in whatever unit `maxWeight` is expressed in. Supply
   * both to bound a cache whose entries vary in size — an entry count alone
   * bounds how many things a cache holds, not how much memory they take.
   */
  weigh?: (key: K, value: V) => number;

  /** Maximum total weight to hold, in the unit `weigh` reports. */
  maxWeight?: number;
}

/** Options for a {@link BoundedKeyMap}. */
export interface BoundedKeyMapOptions<K, V> {
  /**
   * Called once per entry the map drops by CAPACITY EVICTION — never for the
   * caller's own removals (`delete`, `clear`) and never for the
   * refresh-delete of a key being re-`set`. For a consumer whose "loss is
   * never a wrong answer" claim depends on telling *evicted* apart from
   * *never present*, this is where it records that distinction (a
   * tombstone). Called after the entry is removed, before the triggering
   * `set` inserts its own entry.
   */
  onEvict?: (key: K, value: V) => void;
}

/**
 * A `Map` that drops its oldest key once it holds `limit` of them. Insertion
 * order is the eviction order, and re-setting a key refreshes its place, so
 * what goes first is whatever has gone longest without being written.
 *
 * The point of the `Map`-shaped surface is that an unbounded `Map` field
 * becomes bounded by changing only its declaration. Reach for this where the
 * entries are hints — a value whose loss costs a slower path, never a wrong
 * answer — and where the keys keep arriving: one per instance of something
 * the program creates and discards, rather than one per fixed thing it knows
 * about. Where absence itself feeds a decision, pass
 * {@link BoundedKeyMapOptions.onEvict} so eviction cannot masquerade as
 * never-present.
 */
export class BoundedKeyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #limit: number;
  readonly #onEvict: ((key: K, value: V) => void) | undefined;

  /**
   * Constructs an instance which holds at most `limit` entries. A `limit`
   * below `1` is taken as `1`, there being no useful cache of size zero.
   */
  constructor(limit: number, options: BoundedKeyMapOptions<K, V> = {}) {
    this.#limit = Math.max(limit, 1);
    this.#onEvict = options.onEvict;
  }

  /** @inheritDoc */
  get size(): number {
    return this.#entries.size;
  }

  /** @inheritDoc */
  has(key: K): boolean {
    return this.#entries.has(key);
  }

  /** @inheritDoc */
  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  /**
   * Sets `key` to `value`, dropping the oldest entries as needed to stay
   * within the limit. Setting a key that is already present refreshes its
   * place, making it the newest.
   */
  set(key: K, value: V): void {
    this.#entries.delete(key);
    // Keys come out in insertion order, so this drops the oldest first, and
    // stops as soon as the new entry has somewhere to go.
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size < this.#limit) break;
      const evicted = this.#entries.get(oldest) as V;
      this.#entries.delete(oldest);
      this.#onEvict?.(oldest, evicted);
    }
    this.#entries.set(key, value);
  }

  /** Removes the entry for `key`, returning whether there was one. */
  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  /** Removes all entries. */
  clear(): void {
    this.#entries.clear();
  }

  //
  // Traversals
  //
  // Every traversal runs oldest first, which is the order entries are dropped
  // in. Together with `.size`, `has()`, and `get()` above, these are the
  // standard `ReadonlyMap` surface, so a consumer that only reads takes
  // `ReadonlyMap` and accepts either this or a plain `Map`.
  //

  /** @inheritDoc */
  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  /** @inheritDoc */
  keys(): MapIterator<K> {
    return this.#entries.keys();
  }

  /** @inheritDoc */
  values(): MapIterator<V> {
    return this.#entries.values();
  }

  /** @inheritDoc */
  forEach(
    callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#entries) {
      callback.call(thisArg, value, key, this);
    }
  }

  /** @inheritDoc */
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#entries.entries();
  }
}

/** One entry of an `LRUCache`, as a node of its recency list. */
interface LRUNode<K, V> {
  /** Key the entry is stored under. */
  key: K;

  /** Value stored. */
  value: V;

  /** Weight of the entry, per the cache's `weigh` option. */
  weight: number;

  /** Adjacent node toward the oldest end, or `null` at that end. */
  prev: LRUNode<K, V> | null;

  /** Adjacent node toward the newest end, or `null` at that end. */
  next: LRUNode<K, V> | null;
}

/**
 * Cache which drops its least recently used entry once it is full, where a
 * successful `get()` and any `put()` both count as a use. Fullness is by
 * entry count, and additionally by total weight when the `weigh` option is
 * supplied.
 */
export class LRUCache<K, V> {
  #map = new Map<K, LRUNode<K, V>>();
  #head: LRUNode<K, V> | null = null;
  #tail: LRUNode<K, V> | null = null;
  #capacity: number;
  // Declared as an explicit `| undefined` rather than an optional field, so
  // assigning the caller's optional `weigh` stays legal for the packages that
  // compile with exactOptionalPropertyTypes.
  #weigh: ((key: K, value: V) => number) | undefined;
  #maxWeight: number;
  #weight = 0;

  /**
   * Constructs an instance per `options`, holding at most `capacity` entries
   * (`1000` by default) and, when `weigh` is given, at most `maxWeight` total
   * weight.
   */
  constructor(options: WeightedCacheOptions<K, V> = {}) {
    this.#capacity = Math.max(options.capacity ?? 1000, 1);
    this.#weigh = options.weigh;
    this.#maxWeight = options.maxWeight ?? Infinity;
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.#map.size;
  }

  /** Total weight of the entries currently held, per the `weigh` option. */
  get weight(): number {
    return this.#weight;
  }

  /**
   * Indicates whether there is an entry for `key`. This does not count as a
   * use, and so does not affect what gets dropped next.
   */
  has(key: K): boolean {
    return this.#map.has(key);
  }

  /**
   * Returns the value for `key`, or `undefined` if there is no entry. A hit
   * counts as a use.
   */
  get(key: K): V | undefined {
    const node = this.#map.get(key);
    if (node === undefined) {
      return undefined;
    }
    this.#moveToTail(node);
    return node.value;
  }

  /**
   * Sets `key` to `value`, counting as a use, and drops entries as needed to
   * stay within the capacity and weight bounds.
   */
  put(key: K, value: V): void {
    const weight = this.#weigh?.(key, value) ?? 0;
    const existingNode = this.#map.get(key);
    if (existingNode !== undefined) {
      this.#weight += weight - existingNode.weight;
      existingNode.value = value;
      existingNode.weight = weight;
      this.#moveToTail(existingNode);
      this.#evictToFit();
      return;
    }

    if (this.#map.size >= this.#capacity) {
      this.#evictHead();
    }

    const node: LRUNode<K, V> = { key, value, weight, prev: null, next: null };
    this.#map.set(key, node);
    this.#addToTail(node);
    this.#weight += weight;
    this.#evictToFit();
  }

  /** Removes the entry for `key`, returning whether there was one. */
  delete(key: K): boolean {
    const node = this.#map.get(key);
    if (node === undefined) {
      return false;
    }
    this.#map.delete(key);
    this.#removeNode(node);
    this.#weight -= node.weight;
    return true;
  }

  /** Removes all entries. */
  clear(): void {
    this.#map.clear();
    this.#head = null;
    this.#tail = null;
    this.#weight = 0;
  }

  /**
   * Helper for `put()`, which drops entries from the oldest end until the
   * weight budget is met. The newest entry stays even when it alone exceeds
   * the budget, so a single oversized value cannot leave the cache empty on
   * every `put()`.
   */
  #evictToFit(): void {
    while (this.#weight > this.#maxWeight && this.#map.size > 1) {
      this.#evictHead();
    }
  }

  /** Unlinks `node` from the recency list. */
  #removeNode(node: LRUNode<K, V>): void {
    if (node.prev !== null) {
      node.prev.next = node.next;
    } else {
      this.#head = node.next;
    }
    if (node.next !== null) {
      node.next.prev = node.prev;
    } else {
      this.#tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  /** Links `node` in at the newest end of the recency list. */
  #addToTail(node: LRUNode<K, V>): void {
    if (this.#tail === null) {
      this.#head = node;
      this.#tail = node;
    } else {
      node.prev = this.#tail;
      this.#tail.next = node;
      this.#tail = node;
    }
  }

  /** Moves `node` to the newest end of the recency list. */
  #moveToTail(node: LRUNode<K, V>): void {
    if (node === this.#tail) {
      return;
    }
    this.#removeNode(node);
    this.#addToTail(node);
  }

  /** Drops the entry at the oldest end, if there is one. */
  #evictHead(): void {
    if (this.#head === null) {
      return;
    }
    const node = this.#head;
    this.#map.delete(node.key);
    this.#removeNode(node);
    this.#weight -= node.weight;
  }
}
