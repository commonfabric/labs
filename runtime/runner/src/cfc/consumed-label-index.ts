/**
 * Indexes the label paths a consumed read can overlap, in label-map order.
 * Concrete queries follow one trie branch and check wildcard sources bucketed
 * by their concrete prefix. A trailing wildcard selects the matching child
 * depth or subtree; interior wildcard queries use the prefix predicate.
 * Callers still apply origin and read-depth rules to the candidates,
 * which include both ancestors and descendants.
 */

import type { NonDocumentPath } from "@commonfabric/memory/v2";

import { canonicalizeLogicalPath } from "./canonical.ts";
import { isPrefix } from "./path-prefix-index.ts";
import type { LabelMapEntry } from "./types.ts";

/** A label entry with its canonical path and original label-map position. */
type IndexedEntry = {
  /** The validated entry supplied by the label map. */
  entry: LabelMapEntry;

  /** The entry's logical path, frozen so the index can retain it. */
  path: readonly string[];

  /** Position in the label map, used to restore encounter order. */
  ordinal: number;
};

/** Exact entries and the inclusive subtree, each retained in label-map order. */
type Node = {
  /** The next concrete segment of each indexed path. */
  children: Map<string, Node>;

  /** Entries ending at this node. */
  exact: IndexedEntry[];

  /** Entries whose first wildcard immediately follows this node. */
  wildcard: IndexedEntry[];

  /** Entries at this node and below it, in original map order. */
  descendants: IndexedEntry[];
};

/** An empty path node. */
const createNode = (): Node => ({
  children: new Map(),
  exact: [],
  wildcard: [],
  descendants: [],
});

/**
 * The entries an index is built over: every entry of the list, or those a
 * predicate keeps. `key` names the predicate, so that two indexes built over
 * one list under predicates of the same name share their trie; a predicate is
 * therefore a pure function of the entry, and the same function under the
 * same name everywhere.
 */
export type ConsumedLabelSelection = {
  readonly key: string;
  readonly keeps: (entry: LabelMapEntry) => boolean;
};

/**
 * The tries built, by the entries list they were built over and the name of
 * the selection. A list is indexed again by every transaction that reads the
 * document, and a resolved label map is memoized by its stored value, so the
 * same list arrives each time; the trie is pure data over it. An index never
 * writes to its trie after building it, and the entries are treated as
 * immutable from the first index over them, as the index's retention of
 * their paths already requires.
 */
const builtRoots = new WeakMap<
  readonly LabelMapEntry[],
  Map<string | undefined, Node>
>();

/** Helper for `ConsumedLabelIndex`, which builds the trie over `entries`. */
const buildRoot = (
  entries: readonly LabelMapEntry[],
  keeps: ((entry: LabelMapEntry) => boolean) | undefined,
): Node => {
  const root = createNode();
  for (let ordinal = 0; ordinal < entries.length; ordinal++) {
    const entry = entries[ordinal]!;
    if (keeps !== undefined && !keeps(entry)) continue;
    const path = canonicalizeLogicalPath(entry.path);
    const indexed = { entry, path, ordinal };
    let current = root;
    current.descendants.push(indexed);
    for (const segment of path) {
      if (segment === "*") break;
      let child = current.children.get(segment);
      if (child === undefined) {
        child = createNode();
        current.children.set(segment, child);
      }
      current = child;
      current.descendants.push(indexed);
    }
    if (path.includes("*")) current.wildcard.push(indexed);
    else current.exact.push(indexed);
  }
  return root;
};

/** A collection-local snapshot of one validated label map. */
export class ConsumedLabelIndex {
  #root: Node;
  #onQuery: ((wildcard: boolean) => void) | undefined;

  /**
   * Constructs a snapshot over validated entries, or over those `select`
   * keeps. The trie is shared with every other index over the same list and
   * selection; what is this index's own is `onQuery`.
   */
  constructor(
    entries: readonly LabelMapEntry[],
    options: {
      onQuery?: (wildcard: boolean) => void;
      select?: ConsumedLabelSelection;
    } = {},
  ) {
    this.#onQuery = options.onQuery;
    // No selection is its own slot, apart from every selection key.
    const key = options.select?.key;
    let roots = builtRoots.get(entries);
    let root = roots?.get(key);
    if (root === undefined) {
      root = buildRoot(entries, options.select?.keeps);
      if (roots === undefined) {
        roots = new Map();
        builtRoots.set(entries, roots);
      }
      roots.set(key, root);
    }
    this.#root = root;
  }

  /**
   * Ancestor, equal, and descendant entries in their original map order.
   * With `includeDescendants` false, returns ancestors and equals only.
   * `path` is a logical path, as the entries' paths are.
   */
  overlapping(
    path: NonDocumentPath,
    includeDescendants = true,
  ): readonly IndexedEntry[] {
    this.#onQuery?.(path.includes("*"));
    if (path.length === 0) {
      return includeDescendants ? this.#root.descendants : this.#root.exact;
    }
    const wildcardDepth = path.indexOf("*");
    if (wildcardDepth >= 0 && wildcardDepth !== path.length - 1) {
      return this.#root.descendants.filter((source) =>
        isPrefix(source.path, path) ||
        (includeDescendants && isPrefix(path, source.path))
      );
    }
    const candidates: IndexedEntry[] = [];
    let current = this.#root;
    for (const segment of path) {
      if (segment === "*") {
        if (includeDescendants) {
          for (const entry of current.descendants) candidates.push(entry);
        } else {
          for (const entry of current.exact) candidates.push(entry);
          for (const source of current.wildcard) {
            if (source.path.length <= path.length) candidates.push(source);
          }
          for (const child of current.children.values()) {
            for (const entry of child.exact) candidates.push(entry);
          }
        }
        return candidates.sort((a, b) => a.ordinal - b.ordinal);
      }
      for (const entry of current.exact) candidates.push(entry);
      for (const source of current.wildcard) {
        if (
          isPrefix(source.path, path) ||
          (includeDescendants && isPrefix(path, source.path))
        ) {
          candidates.push(source);
        }
      }
      const child = current.children.get(segment);
      if (child === undefined) {
        return candidates.sort((a, b) => a.ordinal - b.ordinal);
      }
      current = child;
    }
    // Recursive reads also include every entry below this concrete endpoint,
    // including wildcard tails bucketed here or at a deeper concrete node.
    const finalEntries = includeDescendants
      ? current.descendants
      : current.exact;
    for (const entry of finalEntries) candidates.push(entry);
    return candidates.sort((a, b) => a.ordinal - b.ordinal);
  }
}
