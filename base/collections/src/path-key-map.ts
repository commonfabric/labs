/**
 * Trie-style map keyed by arrays of path segments. Use this when you need
 * structural operations across a tree of paths -- in particular,
 * "invalidate everything on the chain of a given path" -- without paying
 * O(cache-size) per operation.
 *
 * Semantics:
 *
 * - `set(path, value)` / `get(path)` / `has(path)` / `delete(path)` /
 *   `clear()` behave like the corresponding `Map<string[], V>` operations,
 *   except keys are compared by segment-array contents rather than by
 *   reference. Distinct from a key's value is its _presence_: a key whose
 *   value is `undefined` (when `V` admits `undefined`) is still considered
 *   present by `has()`.
 * - `invalidateChain(path)` drops the cached value at every ancestor of
 *   `path` (including the root and `path` itself) _and_ drops the entire
 *   subtree rooted at `path`. Sibling subtrees off a divergent ancestor
 *   are preserved.
 *
 * Cost model: every operation is O(D) where D is the depth of the input
 * `path`, independent of the total number of keys stored. `invalidateChain`
 * additionally drops a subtree as a single reference-detach (the subtree
 * itself is GC'd; the operation does not walk it).
 */
export class PathKeyMap<V> {
  #root: PathKeyMapNode<V> = new PathKeyMapNode();

  /** Sets the value at `path`. */
  set(path: readonly string[], value: V): void {
    let node = this.#root;
    for (const seg of path) {
      let next = node.children.get(seg);
      if (!next) {
        next = new PathKeyMapNode();
        node.children.set(seg, next);
      }
      node = next;
    }
    node.hasValue = true;
    node.value = value;
  }

  /** Returns the value at `path`, or `undefined` if absent. */
  get(path: readonly string[]): V | undefined {
    const node = this.#findNode(path);
    return node?.hasValue ? node.value : undefined;
  }

  /** Returns whether `path` has a value present. */
  has(path: readonly string[]): boolean {
    const node = this.#findNode(path);
    return node?.hasValue === true;
  }

  /**
   * Removes the value at `path`. Returns `true` if a value was present and
   * removed, `false` otherwise. Empty interior nodes are not pruned (they
   * sit harmlessly until a `clear()` or until `invalidateChain` drops their
   * subtree).
   */
  delete(path: readonly string[]): boolean {
    const node = this.#findNode(path);
    if (!node?.hasValue) return false;
    node.hasValue = false;
    node.value = undefined;
    return true;
  }

  /** Drops every value in the map. */
  clear(): void {
    this.#root = new PathKeyMapNode();
  }

  /** Returns whether the map holds no values. O(tree-size) worst case. */
  isEmpty(): boolean {
    return this.#root.isEmpty();
  }

  /**
   * Drops the cached value at every ancestor of `path` (including the root
   * and `path` itself) _and_ drops the entire subtree rooted at `path`. For
   * `path === []` (root), behaves like `clear()`.
   */
  invalidateChain(path: readonly string[]): void {
    if (path.length === 0) {
      this.clear();
      return;
    }
    let node = this.#root;
    if (node.hasValue) {
      node.hasValue = false;
      node.value = undefined;
    }
    for (let i = 0; i < path.length - 1; i++) {
      const next = node.children.get(path[i]!);
      if (!next) return;
      node = next;
      if (node.hasValue) {
        node.hasValue = false;
        node.value = undefined;
      }
    }
    node.children.delete(path[path.length - 1]!);
  }

  /**
   * Yields every present path in the map. Order is depth-first by insertion
   * order of each node's child entries (`Map` iteration order).
   */
  *keys(): Generator<readonly string[]> {
    yield* this.#root.keys([]);
  }

  /** Yields every `[path, value]` entry in the map, ordered as `keys()` is. */
  *entries(): Generator<readonly [readonly string[], V]> {
    yield* this.#root.entries([]);
  }

  /** Returns the node at `path`, or `undefined` if there is none. */
  #findNode(path: readonly string[]): PathKeyMapNode<V> | undefined {
    let node: PathKeyMapNode<V> | undefined = this.#root;
    for (const seg of path) {
      node = node.children.get(seg);
      if (!node) return undefined;
    }
    return node;
  }
}

/** One node of a `PathKeyMap`'s trie, that is, one path prefix. */
class PathKeyMapNode<V> {
  /** Whether this node's path is present in the map. */
  hasValue = false;

  /** Value at this node's path, meaningful only when `hasValue` is true. */
  value: V | undefined = undefined;

  /** Child nodes, by the segment that reaches each. */
  children: Map<string, PathKeyMapNode<V>> = new Map();

  /** Indicates whether this node's subtree holds no values at all. */
  isEmpty(): boolean {
    if (this.hasValue) return false;
    for (const child of this.children.values()) {
      if (!child.isEmpty()) return false;
    }
    return true;
  }

  /** Yields every present path in this node's subtree, under `prefix`. */
  *keys(prefix: readonly string[]): Generator<readonly string[]> {
    if (this.hasValue) yield prefix;
    for (const [seg, child] of this.children) {
      yield* child.keys([...prefix, seg]);
    }
  }

  /** Yields every present entry in this node's subtree, under `prefix`. */
  *entries(
    prefix: readonly string[],
  ): Generator<readonly [readonly string[], V]> {
    if (this.hasValue) yield [prefix, this.value as V];
    for (const [seg, child] of this.children) {
      yield* child.entries([...prefix, seg]);
    }
  }
}
