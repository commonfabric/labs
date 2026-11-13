/**
 * A `WeakSet` kept in generations, for an identity cache that would otherwise
 * outgrow what V8 lets one weak table hold.
 *
 * V8 grows a `WeakSet` or `WeakMap` only up to a fixed number of live entries
 * (about 23 million on the Deno this repository pins), and its refusal to grow
 * further is not an exception a caller could catch: the process ends with
 * "Fatal JavaScript out of memory: invalid table size", however much heap is
 * left. A cache that remembers every object of every value it has seen
 * reaches that on a server holding a few gigabytes of such values.
 *
 * Here the newest generation takes every addition until it has taken `limit`
 * keys. The next addition starts a new generation, and once there are more
 * than `generations` of them the oldest is dropped. No one table ever holds
 * more than `limit` keys, so none reaches V8's ceiling, and a key in a dropped
 * generation is simply forgotten, which is all a cache may do with an entry.
 * Only `add()` puts a key in the newest generation: a hit in an older one
 * answers `true` and leaves the key where it is, so a key in steady use is
 * forgotten with its generation too, and enters the newest one again when its
 * owner next proves and adds it.
 *
 * Forgetting makes this fit for a cache and for nothing whose answers must
 * hold. A cache that forgets an entry only redoes the work the entry saved. An
 * interning table that forgot one would hand out a second object for a value
 * it had already interned, so two values it treats as the same would no longer
 * be `===`.
 */
export class GenerationalWeakSet<T extends WeakKey> {
  #newest = new WeakSet<T>();
  #older: WeakSet<T>[] = [];
  #taken = 0;
  readonly #limit: number;
  readonly #maxOlder: number;

  /**
   * Constructs an instance whose generations each take at most `limit` keys,
   * keeping at most `generations` of them.
   */
  constructor(limit: number, generations: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(`limit must be a positive integer, got ${limit}`);
    }
    if (!Number.isSafeInteger(generations) || generations < 1) {
      throw new RangeError(
        `generations must be a positive integer, got ${generations}`,
      );
    }
    this.#limit = limit;
    this.#maxOlder = generations - 1;
  }

  /**
   * Adds `value` to the newest generation, starting a new generation first
   * when the newest has taken its `limit`. A value the newest generation
   * already holds is not added again, so it takes up no room there.
   */
  add(value: T): void {
    if (this.#newest.has(value)) return;
    if (this.#taken >= this.#limit) {
      this.#older.unshift(this.#newest);
      if (this.#older.length > this.#maxOlder) this.#older.pop();
      this.#newest = new WeakSet<T>();
      this.#taken = 0;
    }
    this.#newest.add(value);
    this.#taken += 1;
  }

  /** Indicates whether any kept generation holds `value`. */
  has(value: T): boolean {
    if (this.#newest.has(value)) return true;
    for (const generation of this.#older) {
      if (generation.has(value)) return true;
    }
    return false;
  }

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}
