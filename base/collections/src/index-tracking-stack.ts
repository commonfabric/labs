/**
 * A stack of values offering `Array`-style {@link #indexOf} and {@link
 * #lastIndexOf}, and {@link #has} for a caller that wants no position. A
 * value's index is counted from the bottom, so the first value pushed is at
 * index `0`, and an index does not change while things are pushed above it.
 *
 * Values are compared as `Object.is` compares them: by identity for an object,
 * by value for a primitive, `NaN` matching itself, and `-0` distinct from `0`.
 *
 * A value may be pushed more than once, and then occupies as many positions as
 * it was pushed at. {@link #indexOf} names the lowest of them and {@link
 * #lastIndexOf} the highest, and a pop takes the highest away.
 *
 * A lookup does not get slower as the stack grows.
 */
export class IndexTrackingStack<T = unknown> {
  /** The values, in order, so a value's position is its index. */
  readonly #stack: T[] = [];

  /**
   * The positions each value occupies, ascending, and `undefined` while there
   * is none. Keyed by {@link #keyFor}, not by the value itself.
   *
   * Built by {@link #indexIfWanted} and dropped once the stack falls below
   * {@link #DROP_INDEX_BELOW}. Used at every height while it exists: what a
   * short stack is spared is maintaining this, and that is already spent by
   * the time a lookup asks. The two marks are far enough apart that ordinary
   * movement does not build and drop repeatedly -- a stack has to swing
   * across the whole gap.
   */
  #positions: Map<unknown, number[]> | undefined;

  //
  // Instance members
  //

  /**
   * How deep the stack is: how many values it holds, which is also the index
   * the next value pushed will take.
   */
  get depth(): number {
    return this.#stack.length;
  }

  /** Whether the stack holds the given value. */
  has(value: T): boolean {
    return this.indexOf(value) >= 0;
  }

  /**
   * The lowest index at which the given value sits, or `-1` if it is not in
   * the stack.
   */
  indexOf(value: T): number {
    const positions = this.#indexIfWanted();

    if (positions !== undefined) {
      return positions.get(IndexTrackingStack.#keyFor(value))?.[0] ?? -1;
    } else if (typeof value === "number") {
      // `Array.prototype.indexOf` compares strictly, so it would find a `0`
      // for a `-0` and never find a `NaN`. `===` and `Object.is` part company
      // on numbers and only on numbers, so this arm is exactly the set that
      // needs the slower search.
      return this.#stack.findIndex((held) => Object.is(held, value));
    } else {
      return this.#stack.indexOf(value);
    }
  }

  /**
   * The highest index at which the given value sits, or `-1` if it is not in
   * the stack.
   */
  lastIndexOf(value: T): number {
    const positions = this.#indexIfWanted();

    if (positions !== undefined) {
      const found = positions.get(IndexTrackingStack.#keyFor(value));

      return (found === undefined) ? -1 : found[found.length - 1]!;
    } else if (typeof value === "number") {
      return this.#stack.findLastIndex((held) => Object.is(held, value));
    } else {
      return this.#stack.lastIndexOf(value);
    }
  }

  /**
   * Pops the topmost value off the stack and returns it.
   *
   * @throws If the stack is empty.
   */
  pop(): T {
    if (this.#stack.length === 0) {
      throw new Error("Cannot pop an empty stack.");
    }

    return this.#popNonEmpty();
  }

  /**
   * Pops the topmost value off the stack and returns it, or returns
   * `undefined` if the stack is empty.
   *
   * This cannot tell an empty stack from one whose topmost value is
   * `undefined`, so it is for a caller whose `T` does not admit that. One
   * whose `T` does has {@link #depth} to ask with, and {@link #pop}.
   */
  popElseUndefined(): T | undefined {
    return (this.#stack.length === 0) ? undefined : this.#popNonEmpty();
  }

  /**
   * Pops the topmost value off the stack, which has to be the given one. The
   * stack is left as it was if it is not: what a caller has to sort out is one
   * unbalanced push and pop, not that plus a pop it did not intend.
   *
   * @throws If the stack is empty, or its topmost value is not `expected`.
   */
  popExpect(expected: T): void {
    if (this.#stack.length === 0) {
      throw new Error("Cannot pop an empty stack.");
    }

    const top = this.#stack[this.#stack.length - 1] as T;

    if (!Object.is(top, expected)) {
      throw new Error("The top of the stack is not the expected value.");
    }

    this.#popNonEmpty();
  }

  /** Pushes a value onto the stack, at the current top. */
  push(value: T): void {
    const at = this.#stack.length;

    this.#stack.push(value);

    // Only an index that already exists is maintained. Building one is
    // {@link #indexIfWanted}'s business, and a stack nobody asks a position of
    // never has one to maintain.
    if (this.#positions !== undefined) {
      const key = IndexTrackingStack.#keyFor(value);
      const found = this.#positions.get(key);

      if (found === undefined) {
        this.#positions.set(key, [at]);
      } else {
        found.push(at);
      }
    }
  }

  /**
   * The index, built first if the stack is tall enough to want one and has
   * none, and `undefined` if it is not.
   *
   * Built here rather than as the stack grows, because height alone is no
   * reason to have one: what an index is for is answering a lookup, and a
   * stack that is never asked never needs it.
   */
  #indexIfWanted(): Map<unknown, number[]> | undefined {
    if (this.#positions !== undefined) {
      return this.#positions;
    } else if (this.#stack.length < IndexTrackingStack.#ADD_INDEX_AT) {
      return undefined;
    }

    const positions = new Map<unknown, number[]>();

    for (let index = 0; index < this.#stack.length; index++) {
      const key = IndexTrackingStack.#keyFor(this.#stack[index] as T);
      const found = positions.get(key);

      if (found === undefined) {
        positions.set(key, [index]);
      } else {
        found.push(index);
      }
    }

    this.#positions = positions;

    return positions;
  }

  /**
   * Pops off a stack already known not to be empty, and returns what came off.
   */
  #popNonEmpty(): T {
    const value = this.#stack.pop() as T;
    const positions = this.#positions;

    // Nothing below is reached, nor the key computed for it, while there is no
    // index -- which is the whole of what a short stack does here.
    if (positions !== undefined) {
      const key = IndexTrackingStack.#keyFor(value);

      // Non-nullish type assertion (`!`) below, because `key` is in the map
      // by construction: while an index exists, every value in the stack has
      // an entry in it. The build takes the whole stack, and the only two
      // places that change the stack are this one and `push()`, both of which
      // maintain it. Asserting rather than testing is deliberate -- a test
      // here would skip silently, and leave a corrupt index behind.
      const found = positions.get(key)!;

      // The positions of one value ascend, and what came off the stack is the
      // highest of them, so it is the last of these.
      found.pop();

      if (found.length === 0) {
        positions.delete(key);
      }

      if (this.#stack.length < IndexTrackingStack.#DROP_INDEX_BELOW) {
        this.#positions = undefined;
      }
    }

    return value;
  }

  //
  // Static members
  //

  /**
   * Stands in for `NaN` as an index key, so that nothing rests on how a `Map`
   * happens to treat one.
   */
  static readonly #NAN = Symbol("NaN");

  /**
   * Stands in for `-0` as an index key. A `Map` normalizes a `-0` key to `0`,
   * so the two would share an entry and become indistinguishable.
   */
  static readonly #NEGATIVE_ZERO = Symbol("negative zero");

  /**
   * The height at which an index is built. Set well below the height at which
   * a scan and a keyed lookup cost the same, so that reaching it never costs
   * more than not having reached it.
   */
  static readonly #ADD_INDEX_AT = 64;

  /**
   * The height below which the index is dropped. The gap between this and
   * {@link #ADD_INDEX_AT} is what keeps a stack from building and dropping
   * over and over: a stack has to swing across the whole of it to rebuild.
   */
  static readonly #DROP_INDEX_BELOW = 32;

  /**
   * The heights this class arranges itself around, for a test or a benchmark
   * to bound its cases with.
   */
  static get accessForTestingOnly(): {
    readonly ADD_INDEX_AT: number;
    readonly DROP_INDEX_BELOW: number;
  } {
    return {
      ADD_INDEX_AT: IndexTrackingStack.#ADD_INDEX_AT,
      DROP_INDEX_BELOW: IndexTrackingStack.#DROP_INDEX_BELOW,
    };
  }

  /**
   * The index key for the given value: the value itself, except for the two a
   * `Map` does not key as `Object.is` would have it. A `Map` normalizes a
   * `-0` key to `0`, so those two would otherwise share an entry. Two values
   * take the same key exactly when `Object.is` calls them the same value.
   *
   * A `NaN` needs no standing in as `Map` is written today, and gets one
   * anyway, so that the pair is read as one rule rather than as one rule and
   * one coincidence. Nothing tests the difference, there being none to see.
   *
   * The `typeof` runs first and settles it for everything that is not a
   * number, which is what keeps this off the cost of an ordinary stack.
   */
  static #keyFor(value: unknown): unknown {
    if (typeof value !== "number") {
      return value;
    } else if (Number.isNaN(value)) {
      return IndexTrackingStack.#NAN;
    } else if (Object.is(value, -0)) {
      return IndexTrackingStack.#NEGATIVE_ZERO;
    } else {
      return value;
    }
  }
}
