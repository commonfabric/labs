/**
 * Indexes prefix and bidirectional overlap queries over a set of paths.
 *
 * A linear scan costs the set's size per query, and the set is a document's
 * dereference-trace sources — measured at 249 for one pane, consulted once per
 * read activity at commit preparation. A trie costs the query path's length
 * instead, which is small and does not grow with the set.
 *
 * The predicate is `isPrefix` below, which treats `"*"` as matching any segment
 * on EITHER side. The index implements that predicate, and
 * a test holds the two together across a generated corpus.
 *
 * Concrete queries follow one branch. Each node also buckets sources whose
 * first wildcard follows that node's concrete prefix; only buckets on the
 * query's branch need `isPrefix` checks. Cost depends on the query length and
 * those candidates, including all wildcard sources when they start with `"*"`.
 * A wildcard QUERY uses the scan: walking every child at its wildcard depth
 * measured 730x slower than scanning a 256-source set.
 */

/**
 * Whether `prefix` prefixes `path`, with `"*"` matching any segment on EITHER
 * side.
 *
 * This is the predicate `PathPrefixIndex` indexes, and the one its wildcard
 * fallback runs directly, so the two cannot be separate definitions: a change
 * to the wildcard rule in one would silently disagree with the other. It lives
 * here rather than in `prepare.ts`, which consumes it in both forms.
 */
export const isPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) =>
    segment === path[index] || segment === "*" || path[index] === "*"
  );

/** A path segment, with wildcard candidates sharing its concrete prefix. */
type PathPrefixNode = {
  /** Next path segments, including wildcard tails retained for deduplication. */
  children: Map<string, PathPrefixNode>;

  /** The added path that ends here, if one does. */
  path: readonly string[] | undefined;

  /** Sources whose first wildcard immediately follows this node. */
  wildcardPaths: (readonly string[])[];
};

/** Constructs an empty path node. */
const createNode = (): PathPrefixNode => ({
  children: new Map(),
  path: undefined,
  wildcardPaths: [],
});

/** A set of paths queried by prefix or ancestor-or-descendant overlap. */
export class PathPrefixIndex {
  #root = createNode();

  /** The same paths, for the queries the trie declines. */
  #paths: (readonly string[])[] = [];

  /** What the wildcard fallback scans, for a test that pins its contents. */
  get accessForTestingOnly(): { scannedPaths: readonly (readonly string[])[] } {
    return { scannedPaths: this.#paths };
  }

  /**
   * Adds a path to the set. Adding the same path twice is a no-op, for the
   * scanned copy as much as for the trie — a duplicate there would be rescanned
   * on every wildcard query for no gain. The path is copied rather than
   * retained, so a caller that reuses a mutable array cannot make the two
   * representations disagree.
   */
  add(path: readonly string[]): void {
    let node = this.#root;
    let wildcardNode: PathPrefixNode | undefined;
    for (const segment of path) {
      if (segment === "*" && wildcardNode === undefined) wildcardNode = node;
      let next = node.children.get(segment);
      if (next === undefined) {
        next = createNode();
        node.children.set(segment, next);
      }
      node = next;
    }
    if (node.path !== undefined) return;
    const copy = [...path];
    node.path = copy;
    this.#paths.push(copy);
    wildcardNode?.wildcardPaths.push(copy);
  }

  /** Whether any added path is a prefix of `path`, by `isPrefix`'s rules. */
  hasPrefixOf(path: readonly string[]): boolean {
    return this.#matches(path, false);
  }

  /** Whether any added path prefixes `path` or has `path` as a prefix. */
  overlaps(path: readonly string[]): boolean {
    return this.#matches(path, true);
  }

  /**
   * The added paths that prefix `path` or have `path` as a prefix, by
   * `isPrefix`'s rules, each once and in no particular order.
   */
  overlapping(path: readonly string[]): (readonly string[])[] {
    const overlaps = (source: readonly string[]) =>
      isPrefix(source, path) || isPrefix(path, source);
    if (path.includes("*")) return this.#paths.filter(overlaps);
    const found = new Set<readonly string[]>();
    let node = this.#root;
    for (const segment of path) {
      if (node.path !== undefined) found.add(node.path);
      for (const source of node.wildcardPaths) {
        if (overlaps(source)) found.add(source);
      }
      const next = node.children.get(segment);
      if (next === undefined) return [...found];
      node = next;
    }
    // Everything at or below `path` has it as a prefix, wildcards included.
    const below = [node];
    for (let current = below.pop(); current; current = below.pop()) {
      if (current.path !== undefined) found.add(current.path);
      for (const child of current.children.values()) below.push(child);
    }
    return [...found];
  }

  #matches(path: readonly string[], includeDescendants: boolean): boolean {
    if (this.#root.path !== undefined) return true;
    if (path.includes("*")) {
      return this.#paths.some((source) =>
        isPrefix(source, path) || includeDescendants && isPrefix(path, source)
      );
    }
    let node = this.#root;
    for (const segment of path) {
      for (const source of node.wildcardPaths) {
        if (
          isPrefix(source, path) || includeDescendants && isPrefix(path, source)
        ) return true;
      }
      const next = node.children.get(segment);
      if (next === undefined) return false;
      if (next.path !== undefined) return true;
      node = next;
    }
    return includeDescendants && node.children.size > 0;
  }
}
