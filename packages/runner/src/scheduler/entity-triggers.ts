import {
  arraysOverlap,
  comparePaths,
  type SortedAndCompactPaths,
} from "../reactive-dependencies.ts";
import type { MemoryAddressPathComponent } from "../storage/interface.ts";
import type { Action } from "./types.ts";

/**
 * Scan work the trigger index performs, counted for the scaling profile in
 * `test/trigger-scaling.profile.ts`. Process-wide, so a reading covers every
 * runtime alive in it.
 */
export const triggerScanWork = {
  /** Calls to {@link EntityTriggers.matching}. */
  scans: 0,

  /** Index entries those calls visited, one per trie node reached. */
  pathsVisited: 0,

  /** Reads those calls returned, one per action at a matching path. */
  pathsMatched: 0,
};

/** Sets every {@link triggerScanWork} count back to zero. */
export function resetTriggerScanWork(): void {
  triggerScanWork.scans = 0;
  triggerScanWork.pathsVisited = 0;
  triggerScanWork.pathsMatched = 0;
}

/**
 * Whether the every-mutation equivalence verifier runs: on under `ENV=test`
 * and off elsewhere.
 *
 * With it on, every registration and removal asserts that the trie answers
 * what a scan of the per-action record under {@link arraysOverlap} answers,
 * which is the definition the trie implements. Drift throws naming the write
 * path and the paths the two disagree on.
 *
 * Takes the environment reader rather than reaching for `Deno.env` itself, so
 * that what it decides for a given environment is a thing a test can ask.
 */
export function triggerEquivalenceEnabled(
  readEnv: (name: string) => string | undefined,
): boolean {
  try {
    return readEnv("ENV") === "test";
  } catch {
    return false; // no env permission: stay disabled
  }
}

const TRIGGER_EQUIVALENCE_CHECK: boolean = triggerEquivalenceEnabled(
  (name) => typeof Deno === "undefined" ? undefined : Deno.env.get(name),
);

/** One path in the trie, and whatever reads end at it. */
interface PathNode {
  /** Path from the document root to here. */
  readonly path: readonly MemoryAddressPathComponent[];

  /** Actions whose registered read ends here. */
  readonly actions: Set<Action>;

  /** Nodes one component deeper, keyed by that component. */
  readonly children: Map<MemoryAddressPathComponent, PathNode>;
}

function pathNode(path: readonly MemoryAddressPathComponent[]): PathNode {
  return { path, actions: new Set(), children: new Map() };
}

/**
 * A path written so that two different paths never read as one.
 *
 * A component may hold any character a property name may hold, `/` included,
 * so joining on a separator gives `["a/b"]` and `["a", "b"]` the same text.
 */
function pathKey(path: readonly MemoryAddressPathComponent[]): string {
  return JSON.stringify(path);
}

/**
 * Throws unless `indexed` and the reads of `registered` that `writePath`
 * overlaps are the same set of paths.
 *
 * This is the definition the trie implements, written out as a scan: what the
 * trie answered on one side, and {@link arraysOverlap} over every registered
 * read on the other. The message names the write and every path the two
 * disagree on.
 */
export function assertNoTriggerDrift(
  indexed: Iterable<readonly MemoryAddressPathComponent[]>,
  registered: readonly (readonly MemoryAddressPathComponent[])[],
  writePath: readonly MemoryAddressPathComponent[],
): void {
  const answered = new Set<string>();
  for (const path of indexed) answered.add(pathKey(path));
  const scanned = new Set(
    registered.filter((path) => arraysOverlap(path, writePath)).map(pathKey),
  );
  const drift = [
    ...[...answered].filter((path) => !scanned.has(path)),
    ...[...scanned].filter((path) => !answered.has(path)),
  ];
  if (drift.length > 0) {
    throw new Error(
      `Trigger index drift for write ${pathKey(writePath)}: ${
        drift.join(", ")
      }`,
    );
  }
}

/**
 * The actions subscribed to one document, indexed by the paths they read.
 *
 * A write reaches a read whose path is a prefix of the written path or an
 * extension of it, and no other, so the registered paths are held in a trie
 * over path components: descending the written path visits every prefix, and
 * the node the descent ends on carries every extension below it. A write
 * therefore consults the reads whose paths can match rather than every read of
 * the document, which is what keeps the cost of one write proportional to the
 * reads it affects rather than to the size of the document's readership.
 */
export class EntityTriggers {
  #pathsByAction = new Map<Action, SortedAndCompactPaths>();
  #root: PathNode = pathNode([]);

  /** How many actions read this document. */
  get size(): number {
    return this.#pathsByAction.size;
  }

  /**
   * Registers `paths` as everything `action` reads of this document,
   * replacing what it read before. Registering the paths an action already
   * holds leaves the index untouched.
   */
  set(action: Action, paths: SortedAndCompactPaths): void {
    const previous = this.#pathsByAction.get(action);
    if (previous !== undefined) {
      if (pathsEqual(previous, paths)) return;
      for (const path of previous) this.#unindex(action, path);
    }
    this.#pathsByAction.set(action, paths);
    for (const path of paths) this.#index(action, path);
    this.#assertEquivalence(
      previous === undefined ? paths : [...previous, ...paths],
    );
  }

  /** Removes whatever `action` reads of this document. */
  delete(action: Action): void {
    const previous = this.#pathsByAction.get(action);
    if (previous === undefined) return;
    this.#pathsByAction.delete(action);
    for (const path of previous) this.#unindex(action, path);
    this.#assertEquivalence(previous);
  }

  /**
   * Calls `visit` for each registered path a write to `writePath` reaches —
   * every path that is a prefix of it or an extension of it, and no other —
   * with the actions that read that path.
   *
   * The prefixes arrive first, shortest first; the extensions arrive after
   * them in trie order.
   */
  forEachMatching(
    writePath: readonly MemoryAddressPathComponent[],
    visit: (
      path: readonly MemoryAddressPathComponent[],
      actions: ReadonlySet<Action>,
    ) => void,
  ): void {
    triggerScanWork.scans++;

    // Down the written path: each node along it holds reads of one of its
    // prefixes, which the write reaches.
    let node: PathNode | undefined = this.#root;
    let depth = 0;
    while (node !== undefined) {
      triggerScanWork.pathsVisited++;
      if (node.actions.size > 0) {
        triggerScanWork.pathsMatched += node.actions.size;
        visit(node.path, node.actions);
      }
      if (depth === writePath.length) break;
      node = node.children.get(writePath[depth]!);
      depth++;
    }
    if (node === undefined) return;

    // Below it: every read of an extension of the written path, which the
    // write reaches as well.
    const pending = [...node.children.values()];
    while (pending.length > 0) {
      const below = pending.pop()!;
      triggerScanWork.pathsVisited++;
      if (below.actions.size > 0) {
        triggerScanWork.pathsMatched += below.actions.size;
        visit(below.path, below.actions);
      }
      for (const child of below.children.values()) pending.push(child);
    }
  }

  /**
   * The registered paths a write to `writePath` reaches, grouped by action.
   *
   * Each group holds a subset of what its action registered, in ascending
   * path order, which is the order {@link determineTriggeredActions} reads
   * them in. The groups themselves are in no particular order: the scheduler
   * settles run order in `topology.ts` from the dependency edges and each
   * action's registration ordinal, not from the order a change woke them.
   */
  matching(
    writePath: readonly MemoryAddressPathComponent[],
  ): Map<Action, SortedAndCompactPaths> {
    // Sorted per group rather than over the whole match set. Only an action
    // reading several of the reached paths needs ordering, and a write to a
    // whole document reaches one path for each of its readers.
    const byAction = new Map<Action, SortedAndCompactPaths>();
    const unsorted: SortedAndCompactPaths[] = [];
    this.forEachMatching(writePath, (path, actions) => {
      for (const action of actions) {
        const paths = byAction.get(action);
        if (paths === undefined) byAction.set(action, [path]);
        else if (paths.push(path) === 2) unsorted.push(paths);
      }
    });
    for (const paths of unsorted) paths.sort(comparePaths);
    return byAction;
  }

  /**
   * Asserts the trie holds what the per-action record holds, for the root
   * write and for each of `moved`.
   *
   * The empty path is a prefix of every registered read, so the root write
   * reaches all of them: that one probe compares the whole trie against the
   * whole record. The paths a mutation moved are probed as well, which covers
   * the descent through the part of the trie it rewrote. The work counters are
   * left as the check found them, since a verification is not work the
   * scheduler did.
   */
  #assertEquivalence(
    moved: readonly (readonly MemoryAddressPathComponent[])[],
  ): void {
    if (!TRIGGER_EQUIVALENCE_CHECK) return;
    const registered: (readonly MemoryAddressPathComponent[])[] = [];
    for (const paths of this.#pathsByAction.values()) registered.push(...paths);
    const scans = triggerScanWork.scans;
    const pathsVisited = triggerScanWork.pathsVisited;
    const pathsMatched = triggerScanWork.pathsMatched;
    try {
      for (const writePath of [[], ...moved]) {
        const indexed: (readonly MemoryAddressPathComponent[])[] = [];
        this.forEachMatching(writePath, (path) => indexed.push(path));
        assertNoTriggerDrift(indexed, registered, writePath);
      }
    } finally {
      triggerScanWork.scans = scans;
      triggerScanWork.pathsVisited = pathsVisited;
      triggerScanWork.pathsMatched = pathsMatched;
    }
  }

  #index(action: Action, path: readonly MemoryAddressPathComponent[]): void {
    let node = this.#root;
    for (let depth = 0; depth < path.length; depth++) {
      const component = path[depth]!;
      let child = node.children.get(component);
      if (child === undefined) {
        child = pathNode(path.slice(0, depth + 1));
        node.children.set(component, child);
      }
      node = child;
    }
    node.actions.add(action);
  }

  #unindex(action: Action, path: readonly MemoryAddressPathComponent[]): void {
    const walked: PathNode[] = [this.#root];
    let node = this.#root;
    for (const component of path) {
      const child = node.children.get(component);
      if (child === undefined) {
        throw new Error(
          `Registered read \`${path.join("/")}\` is missing from the index.`,
        );
      }
      walked.push(child);
      node = child;
    }
    node.actions.delete(action);

    // A node that now holds nothing and leads nowhere is dropped, so the
    // descent above stays proportional to the paths still registered.
    for (let depth = walked.length - 1; depth > 0; depth--) {
      const empty = walked[depth]!;
      if (empty.actions.size > 0 || empty.children.size > 0) break;
      walked[depth - 1]!.children.delete(path[depth - 1]!);
    }
  }
}

function pathsEqual(
  a: SortedAndCompactPaths,
  b: SortedAndCompactPaths,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) {
      if (a[i][j] !== b[i][j]) return false;
    }
  }
  return true;
}
