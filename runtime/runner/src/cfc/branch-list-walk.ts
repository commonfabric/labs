/**
 * The bookkeeping a schema walk needs to expand each branch list it reaches
 * once, for a walk whose result at a list joins what the list's branches come
 * to — narrowing unions the schemas its arms narrow to, and the `asCell` follow
 * cap takes the narrowest cap among them.
 *
 * A list can reach itself again through references before the walk moves past
 * it, as `type R = Cell<R> | null` does at once, and lists can reach one
 * another along many routes. Expanding a list afresh along every route costs
 * an expansion per route, and routes multiply exponentially with the lists
 * that name one another. Here a list is expanded once and its result is reused,
 * wherever reusing it is exact.
 */

/**
 * What `BranchListWalk.expand()` returns for a list reached again while it is
 * being expanded further up. It contributes nothing: every branch it could
 * reach is being reached from where it was first expanded.
 */
export const REACHED_AGAIN: unique symbol = Symbol("reached again");

/**
 * One walk's record of the branch lists it has expanded, keyed by whatever
 * identifies a list's result apart from the lists it reaches: the list itself,
 * and whatever else its expansion reads, such as the definitions it resolves
 * against and the path it still has to narrow.
 *
 * It serves a walk whose result at a list joins what the list's branches come
 * to, and in which a list reaching another under that list's own key takes the
 * other's result in unchanged. A result is reused on two terms:
 *
 * - A result that never came back to a list still being expanded further up is
 *   what the list comes to wherever it is reached, and holds for the rest of
 *   the walk.
 * - A result that came back to one lacks what that list contributes, and holds
 *   only until the outermost list its cycle came back to settles. Until then
 *   every route to it runs inside that list's expansion, which joins every list
 *   reachable from it: each is expanded once below it, and its result joins
 *   into the list that first reached it. When that list settles, such results
 *   are dropped, and a later route reaches their lists afresh.
 *
 * Each list keeps the shallowest open list its result depends on, its lowlink
 * as Tarjan's algorithm has it, so a cycle settles when its own outermost list
 * does, whatever cycle further up is still open.
 *
 * The outermost result therefore joins what a fresh expansion along every
 * route would join, though inside a cycle it can nest the same results
 * differently. A list is expanded once, and again only when a route reaches
 * it after the cycle it was part of has settled.
 */
export class BranchListWalk<V> {
  /** The lists being expanded, outermost first. */
  #open: OpenList[] = [];

  /** Results that hold wherever their lists are reached. */
  #settled = new ResultsByKey<V>();

  /** Results that hold only while the list they came back to is open. */
  #provisional = new ResultsByKey<V>();

  /**
   * The provisional results in the order they were recorded, so that a list
   * settling can drop those recorded since it began.
   */
  #provisionalLog: KeyedResult<V>[] = [];

  /**
   * What the list `key` identifies comes to: a result the walk can reuse, or
   * else what `expandList` returns, reading the lists it reaches through this
   * walk. Returns `REACHED_AGAIN` for a list still being expanded further up.
   */
  expand(
    key: readonly unknown[],
    expandList: () => V,
  ): V | typeof REACHED_AGAIN {
    const open = this.#open;
    const expanding = open.at(-1);
    for (let depth = open.length - 1; depth >= 0; depth--) {
      if (!sameKey(open[depth].key, key)) continue;
      // The list being expanded now depends on that one.
      expanding!.lowlink = Math.min(expanding!.lowlink, depth);
      return REACHED_AGAIN;
    }
    const settled = this.#settled.get(key);
    if (settled !== undefined) return settled.value;
    const provisional = this.#provisional.get(key);
    if (provisional !== undefined) {
      // A provisional result exists only while the list it depends on is
      // open, and the list taking it in depends on that list too.
      const holder = openHolder(provisional.dependsOn!);
      expanding!.lowlink = Math.min(expanding!.lowlink, holder.depth);
      return provisional.value;
    }

    const depth = open.length;
    const list: OpenList = {
      key,
      depth,
      lowlink: depth,
      provisionalBefore: this.#provisionalLog.length,
    };
    open.push(list);
    let value: V;
    try {
      value = expandList();
    } finally {
      open.pop();
    }
    if (list.lowlink === depth) {
      // Every provisional result recorded since this list began came back to
      // this list or below it, and this list is now settled.
      for (
        const dropped of this.#provisionalLog.splice(list.provisionalBefore)
      ) {
        this.#provisional.delete(dropped);
      }
      this.#settled.add({ key, value });
    } else {
      // The result depends on a list further up, and so does the list that
      // reached this one.
      list.dependsOn = open[list.lowlink];
      const parent = open[depth - 1];
      parent.lowlink = Math.min(parent.lowlink, list.lowlink);
      const result = { key, value, dependsOn: list };
      this.#provisional.add(result);
      this.#provisionalLog.push(result);
    }
    return value;
  }
}

/**
 * The open list `list` depends on: `list` itself while it is open, else the
 * one its result came to depend on when it finished without settling.
 */
function openHolder(list: OpenList): OpenList {
  let holder = list;
  while (holder.dependsOn !== undefined) holder = holder.dependsOn;
  return holder;
}

/** A branch list being expanded by a `BranchListWalk`. */
interface OpenList {
  /** What identifies the list and its result. */
  readonly key: readonly unknown[];

  /** The list's position among the open lists, counting from the outermost. */
  readonly depth: number;

  /**
   * The depth of the shallowest open list the result depends on, the list's
   * own depth while it depends on none further up.
   */
  lowlink: number;

  /** How many provisional results the walk held when this list began. */
  readonly provisionalBefore: number;

  /**
   * Once the list has finished without settling, the list further up its
   * result depends on.
   */
  dependsOn?: OpenList;
}

/** A branch list's result, with the key that identifies it. */
interface KeyedResult<V> {
  /** What identifies the list and its result. */
  readonly key: readonly unknown[];

  /** What the list comes to. */
  readonly value: V;

  /** For a provisional result, the finished list it came from. */
  readonly dependsOn?: OpenList;
}

/**
 * Results indexed by the first element of their keys, which is the branch
 * list itself; a list is read under few distinct keys, so the rest are
 * compared in turn.
 */
class ResultsByKey<V> {
  #byList = new Map<unknown, KeyedResult<V>[]>();

  /** The result recorded under `key`, if any. */
  get(key: readonly unknown[]): KeyedResult<V> | undefined {
    return this.#byList.get(key[0])?.find((result) => sameKey(result.key, key));
  }

  /** Records `result` under its key. */
  add(result: KeyedResult<V>): void {
    const results = this.#byList.get(result.key[0]);
    if (results === undefined) this.#byList.set(result.key[0], [result]);
    else results.push(result);
  }

  /** Forgets `result`. */
  delete(result: KeyedResult<V>): void {
    const results = this.#byList.get(result.key[0]);
    const at = results?.indexOf(result) ?? -1;
    if (at >= 0) results!.splice(at, 1);
  }
}

/** Whether two keys name the same things, element by element. */
function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
