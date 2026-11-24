/**
 * A memo cache keyed in two levels, with both levels held weakly.
 *
 * The outer key groups entries; the inner key identifies a value within that
 * group. Both levels are WeakMaps, so a whole group is collected once its outer
 * key is unreachable, and an individual entry is collected once its inner key
 * is unreachable while the group is still alive.
 *
 * The TypeScript pipelines use this to memoize a fact derived from a `ts.Type`
 * or AST node — a type's cell brand, a call's kind — against the
 * `ts.TypeChecker` that owns it. The fact depends only on the inner key's shape
 * within its checker, so keying by the checker first keeps a value from ever
 * being read against a foreign checker.
 *
 * Stored values may be `undefined`. Presence is tracked with `WeakMap.has`, so
 * a computed `undefined` is cached and not recomputed.
 */
export class TwoLevelWeakCache<
  Outer extends WeakKey,
  Key extends WeakKey,
  Value,
> {
  readonly #groups = new WeakMap<Outer, WeakMap<Key, Value>>();

  /** The inner map for `outer`, created empty on first access. */
  groupFor(outer: Outer): WeakMap<Key, Value> {
    let group = this.#groups.get(outer);
    if (group === undefined) {
      group = new WeakMap<Key, Value>();
      this.#groups.set(outer, group);
    }
    return group;
  }

  /**
   * The value stored for (`outer`, `key`), computing and storing it on the
   * first request. `compute` runs at most once per distinct (`outer`, `key`)
   * pair; a computed `undefined` is cached like any other value.
   */
  memoize(outer: Outer, key: Key, compute: () => Value): Value {
    const group = this.groupFor(outer);
    if (group.has(key)) {
      return group.get(key) as Value;
    }
    const value = compute();
    group.set(key, value);
    return value;
  }
}
