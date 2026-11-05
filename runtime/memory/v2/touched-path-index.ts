import { prefixPointers } from "./path.ts";

/**
 * Helper for `TouchedPathIndex`, which returns the larger of two `seq`s, where
 * `undefined` stands for no `seq` at all.
 */
const newer = (
  left: number | undefined,
  right: number | undefined,
): number | undefined =>
  left === undefined
    ? right
    : right === undefined
    ? left
    : Math.max(left, right);

/**
 * A set of paths, each tagged with the `seq` of a revision that touched it,
 * which returns the newest `seq` among the paths that prefix, or that overlap,
 * a query path. A query costs time proportional to the query path's depth,
 * whatever the number of paths added, so a set that many queries consult is
 * not scanned once per query.
 *
 * Paths are keyed by the pointers `prefixPointers()` lists. An added path
 * records its `seq` under its own pointer, which a query finds among the
 * pointers of its own prefixes, and under the pointer of each of its
 * prefixes, which a query finds under its own pointer when the added path
 * lies below it.
 *
 * For a query path that is an array of strings, each query returns exactly
 * what a scan of the added paths under `isPrefixPath()` or `pathsOverlap()`
 * from `path.ts` would.
 */
export class TouchedPathIndex {
  /** The newest `seq` of the added paths, by each one's own pointer. */
  #newestAt = new Map<string, number>();

  /** The newest `seq` of the added paths, by the pointer of each prefix. */
  #newestBelow = new Map<string, number>();

  /** Adds `path`, touched by the revision at `seq`. */
  add(path: readonly string[], seq: number): void {
    const pointers = prefixPointers(path);
    for (const pointer of pointers) {
      this.#newestBelow.set(
        pointer,
        Math.max(this.#newestBelow.get(pointer) ?? seq, seq),
      );
    }
    const own = pointers[pointers.length - 1];
    this.#newestAt.set(own, Math.max(this.#newestAt.get(own) ?? seq, seq));
  }

  /**
   * Returns the newest `seq` among the added paths that prefix `path`,
   * `path` itself included, or `undefined` when none does.
   */
  newestPrefixOf(path: readonly string[]): number | undefined {
    return this.#newestAtPrefixes(prefixPointers(path));
  }

  /**
   * Returns the newest `seq` among the added paths that overlap `path` — the
   * paths that prefix it and the paths it prefixes — or `undefined` when none
   * does.
   */
  newestOverlapping(path: readonly string[]): number | undefined {
    const pointers = prefixPointers(path);
    return newer(
      this.#newestAtPrefixes(pointers),
      this.#newestBelow.get(pointers[pointers.length - 1]),
    );
  }

  /**
   * Helper for the two queries, which returns the newest `seq` of the added
   * paths whose own pointer is among `pointers`.
   */
  #newestAtPrefixes(pointers: readonly string[]): number | undefined {
    let newest: number | undefined;
    for (const pointer of pointers) {
      newest = newer(newest, this.#newestAt.get(pointer));
    }
    return newest;
  }
}
