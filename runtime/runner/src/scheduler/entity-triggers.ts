import {
  arraysOverlap,
  comparePaths,
  type SortedAndCompactPaths,
} from "../reactive-dependencies.ts";
import type { MemoryAddressPathComponent } from "../storage/interface.ts";
import type { Action } from "./types.ts";

type Path = readonly MemoryAddressPathComponent[];

/**
 * Scan work the trigger index performs, counted for the scaling profile in
 * `test/trigger-scaling.profile.ts`. Process-wide, so a reading covers every
 * runtime alive in it.
 */
export const triggerScanWork = {
  /** Calls to {@link EntityTriggers.matching}. */
  scans: 0,

  /**
   * Index entries those calls visited: one for each depth of the written path
   * the descent probed, and one for each entry examined below the written
   * path, an entry no action reads any longer included.
   */
  pathsVisited: 0,

  /** Reads those calls returned, one per action at a matching path. */
  pathsMatched: 0,

  /**
   * Row entries {@link EntityTriggers} examined to find what an action read
   * before, which it does by scanning the row only while it holds no
   * per-action map.
   */
  rowScanEntries: 0,
};

/** Sets every {@link triggerScanWork} count back to zero. */
export function resetTriggerScanWork(): void {
  triggerScanWork.scans = 0;
  triggerScanWork.pathsVisited = 0;
  triggerScanWork.pathsMatched = 0;
  triggerScanWork.rowScanEntries = 0;
}

/**
 * How many lists {@link EntityTriggers.set} had to put in ascending order or
 * rid of a repeated path before indexing them. Process-wide. A count above
 * zero is not a fault, since the index repairs the list either way, but it
 * names a caller handing over lists that break their type.
 */
export const triggerListRepairs = { count: 0 };

/**
 * Whether the every-mutation equivalence verifier runs: on under `ENV=test`
 * and off elsewhere.
 *
 * With it on, every registration and removal asserts that the rows hand over
 * exactly the (action, path) pairs a scan of an independent per-action record
 * under {@link arraysOverlap} finds, which is the definition the rows
 * implement, and that both count the same actions. Drift throws naming the
 * write path and the pairs the two disagree on.
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

/**
 * What each index was told each action reads, kept beside the rows while the
 * verifier runs and never derived from them, so that the verifier compares
 * the rows against something they cannot have corrupted.
 */
const references:
  | WeakMap<EntityTriggers, Map<Action, SortedAndCompactPaths>>
  | undefined = TRIGGER_EQUIVALENCE_CHECK ? new WeakMap() : undefined;

/** One read the index holds: an action, and one path it reads. */
export interface TriggerReader {
  /** The action that reads. */
  readonly action: Action;

  /** The path it reads. */
  readonly path: Path;
}

/**
 * A path written so that two different paths never read as one.
 *
 * A component may hold any character a property name may hold, `/` included,
 * so joining on a separator gives `["a/b"]` and `["a", "b"]` the same text.
 */
function pathKey(path: Path): string {
  return JSON.stringify(path);
}

/** The name a message gives an action. */
function actionName(action: Action): string {
  return action.name === "" ? "(anonymous)" : action.name;
}

/**
 * Helper for {@link createTriggerReference} and the verifier, which sorts
 * `items` by path once and returns a function giving, for a written path, the
 * items whose path the write overlaps.
 *
 * Proper prefixes are found by binary search, and each is taken with every
 * item at that same path. The written path and its extensions form a
 * contiguous range in path order, starting at the write's insertion point.
 */
function sortedReference<T>(
  items: readonly T[],
  pathOf: (item: T) => Path,
): (writePath: Path) => Iterable<T> {
  const sorted = [...items].sort((a, b) => comparePaths(pathOf(a), pathOf(b)));

  /** Returns the first sorted item at or after `target`, or the list's end. */
  const lowerBound = (target: Path): number => {
    let lower = 0;
    let upper = sorted.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (comparePaths(pathOf(sorted[middle]!), target) < 0) lower = middle + 1;
      else upper = middle;
    }
    return lower;
  };

  return function* (writePath) {
    for (let depth = 0; depth < writePath.length; depth++) {
      const prefix = writePath.slice(0, depth);
      for (let index = lowerBound(prefix); index < sorted.length; index++) {
        if (comparePaths(pathOf(sorted[index]!), prefix) !== 0) break;
        yield sorted[index]!;
      }
    }

    const lower = lowerBound(writePath);
    for (let index = lower; index < sorted.length; index++) {
      const item = sorted[index]!;
      if (!arraysOverlap(pathOf(item), writePath)) break;
      yield item;
    }
  };
}

/**
 * Builds an independent reference for the reads a write overlaps.
 *
 * Sorting once lets every moved path be checked without scanning all
 * registered reads for each probe; the reference shares no storage with the
 * rows.
 */
export function createTriggerReference(
  registered: readonly Path[],
): (writePath: Path) => Iterable<Path> {
  return sortedReference(registered, (path) => path);
}

/**
 * Throws unless `indexed` and the reads of `registered` that `writePath`
 * overlaps are the same set of paths.
 *
 * Applies {@link arraysOverlap} to the reference reads on one side and takes
 * the index result on the other. The reference may be narrowed to the
 * matching reads by {@link createTriggerReference}. The message names the
 * write and every path the two disagree on.
 */
export function assertNoTriggerDrift(
  indexed: Iterable<Path>,
  registered: Iterable<Path>,
  writePath: Path,
): void {
  const answered = new Set<string>();
  for (const path of indexed) answered.add(pathKey(path));
  const scanned = new Set<string>();
  for (const path of registered) {
    if (arraysOverlap(path, writePath)) scanned.add(pathKey(path));
  }
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
 * Throws unless `indexed` holds each read of `registered` that `writePath`
 * overlaps exactly once, and nothing else.
 *
 * Like {@link assertNoTriggerDrift}, except that a read is an action together
 * with a path, so an index that hands a path to the wrong action, or hands
 * one read over twice, is told apart from one that is right. The message
 * names the write and every read that is missing, invented, or repeated, each
 * by its action's name, so two actions sharing a name read as one in it.
 */
export function assertNoReaderDrift(
  indexed: Iterable<TriggerReader>,
  registered: Iterable<TriggerReader>,
  writePath: Path,
): void {
  const answered = new Map<Action, Map<string, number>>();
  for (const { action, path } of indexed) {
    let paths = answered.get(action);
    if (paths === undefined) answered.set(action, paths = new Map());
    const key = pathKey(path);
    paths.set(key, (paths.get(key) ?? 0) + 1);
  }
  const scanned = new Map<Action, Set<string>>();
  for (const { action, path } of registered) {
    if (!arraysOverlap(path, writePath)) continue;
    let paths = scanned.get(action);
    if (paths === undefined) scanned.set(action, paths = new Set());
    paths.add(pathKey(path));
  }

  const drift: string[] = [];
  for (const [action, paths] of answered) {
    for (const [path, visits] of paths) {
      const name = `${actionName(action)} at ${path}`;
      if (scanned.get(action)?.has(path) !== true) drift.push(`extra ${name}`);
      if (visits > 1) drift.push(`${name} ${visits} times`);
    }
  }
  for (const [action, paths] of scanned) {
    for (const path of paths) {
      if (answered.get(action)?.has(path) !== true) {
        drift.push(`missing ${actionName(action)} at ${path}`);
      }
    }
  }
  if (drift.length > 0) {
    throw new Error(
      `Trigger reader drift for write ${pathKey(writePath)}: ${
        drift.join(", ")
      }`,
    );
  }
}

/**
 * Orders two path components that differ. Components of different types
 * order by type name, so a number sorts ahead of a string.
 */
function compareComponents(
  a: MemoryAddressPathComponent,
  b: MemoryAddressPathComponent,
): number {
  const typeOfA = typeof a;
  const typeOfB = typeof b;
  if (typeOfA !== typeOfB) return typeOfA < typeOfB ? -1 : 1;
  return a < b ? -1 : 1;
}

/**
 * Orders `path` against the first `depth` components of `prefix`, as
 * {@link compareRowPaths} orders `path` against that prefix taken as a path.
 */
function comparePathToPrefix(path: Path, prefix: Path, depth: number): number {
  const shared = path.length < depth ? path.length : depth;
  for (let i = 0; i < shared; i++) {
    if (path[i] !== prefix[i]) return compareComponents(path[i]!, prefix[i]!);
  }
  return path.length - depth;
}

/** Whether `path` begins with the first `depth` components of `prefix`. */
function hasPrefix(path: Path, prefix: Path, depth: number): boolean {
  if (path.length < depth) return false;
  for (let i = 0; i < depth; i++) {
    if (path[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Orders two paths for the trigger rows: a path ahead of every path it is a
 * prefix of, and otherwise by the first component the two disagree on.
 *
 * For paths of strings, which is what the type admits, this returns what
 * {@link comparePaths} returns. Where the two components disagree in type, it
 * orders them by type, a number ahead of a string. That keeps the order
 * strict and total, with two components the same in it exactly when `===`
 * says so, over any path of strings and numbers other than `NaN`, which a
 * sorted row needs to stay searchable.
 */
export function compareRowPaths(a: Path, b: Path): number {
  return comparePathToPrefix(a, b, b.length);
}

/** Throws naming the first path of `paths` holding a component that is not a string. */
function assertComponentsAreStrings(paths: SortedAndCompactPaths): void {
  for (const path of paths) {
    for (const component of path) {
      if (typeof component !== "string") {
        throw new Error(
          `Read path \`${
            pathKey(path)
          }\` holds a component that is not a string.`,
        );
      }
    }
  }
}

/** Whether `a` and `b` hold the same paths in the same order. */
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

/**
 * `paths` in ascending order under {@link compareRowPaths} with each path once:
 * `paths` itself when it already is, and otherwise a sorted copy, which
 * {@link triggerListRepairs} counts.
 */
function ascendingOnce(paths: SortedAndCompactPaths): SortedAndCompactPaths {
  for (let i = 1; i < paths.length; i++) {
    if (compareRowPaths(paths[i - 1]!, paths[i]!) >= 0) {
      triggerListRepairs.count++;
      const sorted = [...paths].sort(compareRowPaths);
      return sorted.filter((path, at) =>
        at === 0 || compareRowPaths(sorted[at - 1]!, path) !== 0
      );
    }
  }
  return paths;
}

/** The actions reading one path: one bare, a few in an array, more in a set. */
type Readers = Action | Action[] | Set<Action>;

/** Whether `readers` holds `action`. */
function readersHold(readers: Readers, action: Action): boolean {
  return typeof readers === "function"
    ? readers === action
    : Array.isArray(readers)
    ? readers.includes(action)
    : readers.has(action);
}

/** Sizes at which {@link EntityTriggers} changes how it holds its reads. */
export interface TriggerRowLimits {
  /** Most readers of one path held in an array, at least 2; more take a set. */
  readonly readersInArray: number;

  /** Most actions a document holds before it keeps a per-action map. */
  readonly actionsWithoutMap: number;

  /** Most row entries a document holds before it keeps a per-action map. */
  readonly rowWithoutMap: number;

  /** Most entries one block of the row holds, at least 2. */
  readonly block: number;
}

/** The limits every index runs at unless a test hands it others. */
const DEFAULT_LIMITS: TriggerRowLimits = Object.freeze({
  readersInArray: 8,
  actionsWithoutMap: 8,
  rowWithoutMap: 16,
  block: 256,
});

/** One block of a long row. */
interface RowBlock {
  /** Distinct paths, ascending, a path no action reads any longer included. */
  paths: Path[];

  /** The readers of each path, beside it; `undefined` where none is left. */
  readers: (Readers | undefined)[];

  /** How many entries of `readers` are `undefined`. */
  holes: number;
}

/** The blocks of a long row, and how many entries they hold between them. */
interface RowBlocks {
  /** The blocks, none empty, each ascending and all ascending together. */
  list: RowBlock[];

  /** Entries across every block, those no action reads included. */
  entries: number;
}

/**
 * The actions subscribed to one document, indexed by the paths they read.
 *
 * A write reaches a read whose path is a prefix of the written path or an
 * extension of it, and no other. The index holds each distinct registered
 * path once, in one row sorted by {@link compareRowPaths}, with the actions
 * reading it beside it. In that order every prefix of a path sorts ahead of
 * it, and the path and its extensions sit together in one run, so a write
 * finds its prefixes by one binary search per depth and its extensions by
 * reading on from the last. A write therefore consults the reads whose paths
 * can match rather than every read of the document, which keeps its cost
 * proportional to the reads it reaches rather than to the readership.
 *
 * A row longer than `limits.block` entries is cut into blocks of at most that
 * many, so that adding a path moves at most one block's entries; a short row
 * is held in the instance itself, which is what most documents have. A path
 * whose last reader leaves stays as a hole until holes are more than half its
 * block, and the block is then compacted. Once more than a few actions read the
 * document, or the row grows past a few entries, a per-action map records
 * what each action reads, so that replacing an action's reads does not scan
 * the row to find them.
 *
 * The rows hold the path arrays handed to {@link set} rather than copies, so
 * a caller must not change a list or a path after handing it over.
 */
export class EntityTriggers {
  /** The paths of the inline row, which is the whole row while it is short. */
  #paths: Path[] = [];

  /** The readers of each path of the inline row, beside it. */
  #readers: (Readers | undefined)[] = [];

  /** How many entries of the inline row no action reads any longer. */
  #holes = 0;

  /** The row once it is long, and then the inline row is empty. */
  #blocks: RowBlocks | undefined;

  /** What each action reads, once the document has more than a few. */
  #byAction: Map<Action, SortedAndCompactPaths> | undefined;

  /** How many actions read at least one path. */
  #size = 0;

  /** The sizes at which the index changes how it holds its reads. */
  #limits: TriggerRowLimits;

  /**
   * Constructs an instance. `limits` replaces any of the sizes at which it
   * changes how it holds its reads, which a test does to reach every such
   * change with a handful of reads.
   *
   * @throws If `limits` sets `readersInArray` or `block` below 2.
   */
  constructor(limits?: Partial<TriggerRowLimits>) {
    if (limits === undefined) {
      this.#limits = DEFAULT_LIMITS;
      return;
    }
    const merged = { ...DEFAULT_LIMITS, ...limits };
    if (merged.readersInArray < 2 || merged.block < 2) {
      throw new Error(
        `Trigger row limits need \`readersInArray\` and \`block\` of at least 2: ${
          JSON.stringify(merged)
        }`,
      );
    }
    this.#limits = merged;
  }

  /** How many actions read this document. */
  get size(): number {
    return this.#size;
  }

  /**
   * Registers `paths` as everything `action` reads of this document,
   * replacing what it read before. Registering the paths an action already
   * holds leaves the index untouched, and registering none removes it.
   *
   * `paths` is held as handed over when it is ascending with no path twice,
   * and otherwise put in that form first.
   *
   * @throws While the verifier runs, if a path holds a component that is not
   * a string.
   */
  set(action: Action, paths: SortedAndCompactPaths): void {
    const previous = this.#registered(action);
    if (previous !== undefined && pathsEqual(previous, paths)) return;
    if (TRIGGER_EQUIVALENCE_CHECK) assertComponentsAreStrings(paths);
    const next = ascendingOnce(paths);
    if (next.length === 0) {
      this.delete(action);
      return;
    }
    if (previous !== undefined && pathsEqual(previous, next)) return;

    if (previous === undefined) {
      this.#size++;
      if (this.#blocks === undefined && this.#paths.length === 0) {
        this.#fill(action, next);
      } else {
        for (const path of next) this.#index(action, path);
      }
    } else {
      // Both lists ascend, so one walk finds what left and what arrived, and
      // a path in both is not touched.
      const arrived: Path[] = [];
      let i = 0;
      let j = 0;
      while (i < previous.length || j < next.length) {
        const order = i === previous.length
          ? 1
          : j === next.length
          ? -1
          : compareRowPaths(previous[i]!, next[j]!);
        if (order === 0) {
          i++;
          j++;
        } else if (order < 0) {
          this.#unindex(action, previous[i++]!);
        } else {
          arrived.push(next[j++]!);
        }
      }
      for (const path of arrived) this.#index(action, path);
    }

    const limits = this.#limits;
    if (this.#byAction !== undefined) {
      this.#byAction.set(action, next);
    } else if (
      this.#size > limits.actionsWithoutMap ||
      this.#entries() > limits.rowWithoutMap
    ) {
      this.#buildMap();
    }

    if (references !== undefined) {
      let record = references.get(this);
      if (record === undefined) references.set(this, record = new Map());
      record.set(action, next);
      this.#assertEquivalence(
        previous === undefined ? next : [...previous, ...next],
      );
    }
  }

  /** Removes whatever `action` reads of this document. */
  delete(action: Action): void {
    const previous = this.#registered(action);
    if (previous === undefined) return;
    for (const path of previous) this.#unindex(action, path);
    this.#byAction?.delete(action);
    this.#size--;
    if (this.#size === 0) this.#byAction = undefined;

    if (references !== undefined) {
      references.get(this)?.delete(action);
      this.#assertEquivalence(previous);
    }
  }

  /**
   * Calls `visit` once for each registered read a write to `writePath`
   * reaches — each action at each path that is a prefix of it or an
   * extension of it, and no other.
   *
   * The reads arrive in ascending path order under {@link compareRowPaths},
   * so each action's arrive in that order too. `visit` must not register or
   * remove reads on this index.
   */
  forEachMatching(
    writePath: Path,
    visit: (path: Path, action: Action) => void,
  ): void {
    triggerScanWork.scans++;
    const blocks = this.#blockCount();
    let b = 0;
    let at = 0;

    // Down the written path: at each depth, the first entry at or after the
    // written path's prefix of that length. When it is that prefix, the
    // write reaches its reads; when it does not even begin with it, nothing
    // longer is registered either.
    for (let depth = 0;; depth++) {
      triggerScanWork.pathsVisited++;
      const found = this.#seekBlock(writePath, depth, b);
      at = this.#seekEntry(
        found,
        writePath,
        depth,
        found === b ? at : 0,
      );
      b = found;
      if (b === blocks) return;
      const paths = this.#pathsIn(b);
      const path = paths[at]!;
      if (!hasPrefix(path, writePath, depth)) return;
      if (path.length === depth) {
        const readers = this.#readersIn(b)[at];
        if (readers !== undefined) visitReaders(path, readers, visit);
        if (++at === paths.length) {
          b++;
          at = 0;
        }
      }
      if (depth === writePath.length) break;
    }

    // Below it: the run of entries that extend the written path, which the
    // write reaches as well.
    const depth = writePath.length;
    for (; b < blocks; b++, at = 0) {
      const paths = this.#pathsIn(b);
      const readers = this.#readersIn(b);
      for (; at < paths.length; at++) {
        triggerScanWork.pathsVisited++;
        const path = paths[at]!;
        if (!hasPrefix(path, writePath, depth)) return;
        const reading = readers[at];
        if (reading !== undefined) visitReaders(path, reading, visit);
      }
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
  matching(writePath: Path): Map<Action, SortedAndCompactPaths> {
    const byAction = new Map<Action, SortedAndCompactPaths>();
    this.forEachMatching(writePath, (path, action) => {
      const paths = byAction.get(action);
      if (paths === undefined) byAction.set(action, [path]);
      else paths.push(path);
    });
    return byAction;
  }

  /**
   * Asserts the rows keep their shape, hold what the independent record
   * holds for the root write and for each of `moved`, and count the same
   * actions.
   *
   * The empty path is a prefix of every registered read, so the root write
   * reaches all of them: that one probe compares every read the rows hold
   * against every read in the record. The paths a mutation moved are probed
   * as well, which covers the descent through the part of the rows it
   * rewrote. The work counters are left as the check found them, since a
   * verification is not work the scheduler did.
   */
  #assertEquivalence(moved: readonly Path[]): void {
    if (references === undefined) return;
    const record = references.get(this) ??
      new Map<Action, SortedAndCompactPaths>();
    const registered: TriggerReader[] = [];
    for (const [action, paths] of record) {
      for (const path of paths) registered.push({ action, path });
    }
    // A few probes cost less as full scans than as a sort of the readership.
    // Broad mutations share one sorted reference across all of their probes.
    const reference = moved.length <= 4
      ? () => registered
      : sortedReference(registered, (reading) => reading.path);
    const { scans, pathsVisited, pathsMatched, rowScanEntries } =
      triggerScanWork;
    try {
      this.#assertShape();
      if (this.#size !== record.size) {
        throw new Error(
          `Trigger index counts ${this.#size} actions where its record holds ${record.size}.`,
        );
      }
      for (const writePath of [[], ...moved]) {
        const indexed: TriggerReader[] = [];
        this.forEachMatching(
          writePath,
          (path, action) => indexed.push({ action, path }),
        );
        assertNoReaderDrift(indexed, reference(writePath), writePath);
      }
    } finally {
      triggerScanWork.scans = scans;
      triggerScanWork.pathsVisited = pathsVisited;
      triggerScanWork.pathsMatched = pathsMatched;
      triggerScanWork.rowScanEntries = rowScanEntries;
    }
  }

  /**
   * Helper for {@link #assertEquivalence}, which throws unless every block is
   * non-empty and within `limits.block`, the entries ascend across the whole
   * row with each path once, the counts of holes and entries are what the
   * row holds, and each path's readers take the form their number calls for.
   * What actions those readers are is the probes' to check, not this.
   */
  #assertShape(): void {
    const limits = this.#limits;
    const fail = (what: string): never => {
      throw new Error(`Trigger rows are out of shape: ${what}.`);
    };
    if (this.#blocks?.list.length === 0) fail("a block list with no block");
    const blocks = this.#blockCount();
    let entries = 0;
    let last: Path | undefined;
    for (let b = 0; b < blocks; b++) {
      const paths = this.#pathsIn(b);
      const readers = this.#readersIn(b);
      if (paths.length > limits.block) fail(`a block of ${paths.length}`);
      if (paths.length === 0) fail(`block ${b} empty`);
      if (readers.length !== paths.length) fail(`block ${b} misaligned`);
      let holes = 0;
      for (let at = 0; at < paths.length; at++) {
        const path = paths[at]!;
        if (last !== undefined && compareRowPaths(last, path) >= 0) {
          fail(`${pathKey(last)} ahead of ${pathKey(path)}`);
        }
        last = path;
        const reading = readers[at];
        if (reading === undefined) holes++;
        else if (
          Array.isArray(reading)
            ? reading.length < 2 || reading.length > limits.readersInArray
            : reading instanceof Set && reading.size <= limits.readersInArray
        ) fail(`the readers of ${pathKey(path)} in the wrong form`);
      }
      if (holes !== this.#changeHoles(b, 0)) fail(`block ${b} miscounts holes`);
      entries += paths.length;
    }
    if (entries !== this.#entries()) fail(`${entries} entries miscounted`);
  }

  /** How many blocks the row is in, the short row held inline counting as one. */
  #blockCount(): number {
    if (this.#blocks !== undefined) return this.#blocks.list.length;
    return this.#paths.length === 0 ? 0 : 1;
  }

  /** How many entries the row holds, those no action reads included. */
  #entries(): number {
    return this.#blocks === undefined
      ? this.#paths.length
      : this.#blocks.entries;
  }

  /** The paths of block `b`. */
  #pathsIn(b: number): Path[] {
    return this.#blocks === undefined
      ? this.#paths
      : this.#blocks.list[b]!.paths;
  }

  /** The readers of block `b`, beside its paths. */
  #readersIn(b: number): (Readers | undefined)[] {
    return this.#blocks === undefined
      ? this.#readers
      : this.#blocks.list[b]!.readers;
  }

  /** Adds `change` to the count of holes in block `b`, and returns the count. */
  #changeHoles(b: number, change: number): number {
    if (this.#blocks === undefined) return this.#holes += change;
    return this.#blocks.list[b]!.holes += change;
  }

  /**
   * Returns the first block at or after `from` whose last entry sorts at or
   * after the first `depth` components of `prefix`, or the block count when
   * there is none.
   */
  #seekBlock(prefix: Path, depth: number, from: number): number {
    let lower = from;
    let upper = this.#blockCount();
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      const paths = this.#pathsIn(middle);
      if (comparePathToPrefix(paths[paths.length - 1]!, prefix, depth) < 0) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    return lower;
  }

  /**
   * Returns the first entry of block `b`, from `from` on, that sorts at or
   * after the first `depth` components of `prefix`, or the block's length
   * when there is none. A `b` past the last block returns 0.
   */
  #seekEntry(b: number, prefix: Path, depth: number, from: number): number {
    if (b === this.#blockCount()) return 0;
    const paths = this.#pathsIn(b);
    let lower = from;
    let upper = paths.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (comparePathToPrefix(paths[middle]!, prefix, depth) < 0) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    return lower;
  }

  /**
   * Returns what `action` reads of this document, ascending, or `undefined`
   * when it reads nothing: from the per-action map when there is one, and
   * otherwise from a scan of the row, which {@link triggerScanWork} counts.
   */
  #registered(action: Action): SortedAndCompactPaths | undefined {
    if (this.#byAction !== undefined) return this.#byAction.get(action);
    let found: Path[] | undefined;
    const blocks = this.#blockCount();
    for (let b = 0; b < blocks; b++) {
      const paths = this.#pathsIn(b);
      const readers = this.#readersIn(b);
      triggerScanWork.rowScanEntries += paths.length;
      for (let at = 0; at < paths.length; at++) {
        const reading = readers[at];
        if (reading !== undefined && readersHold(reading, action)) {
          (found ??= []).push(paths[at]!);
        }
      }
    }
    return found;
  }

  /** Builds the per-action map from the row. */
  #buildMap(): void {
    const byAction = new Map<Action, Path[]>();
    const blocks = this.#blockCount();
    for (let b = 0; b < blocks; b++) {
      const paths = this.#pathsIn(b);
      const readers = this.#readersIn(b);
      for (let at = 0; at < paths.length; at++) {
        const reading = readers[at];
        if (reading === undefined) continue;
        visitReaders(paths[at]!, reading, (path, action) => {
          const held = byAction.get(action);
          if (held === undefined) byAction.set(action, [path]);
          else held.push(path);
        });
      }
    }
    this.#byAction = byAction;
  }

  /**
   * Helper for {@link set}, which builds the row of an empty document from
   * one action's reads at once: inline when they fit in one block, and
   * otherwise in blocks of half that size. Each array is made at the length
   * it holds, which is what a document reading a few paths keeps.
   */
  #fill(action: Action, paths: SortedAndCompactPaths): void {
    const block = this.#limits.block;
    if (paths.length <= block) {
      this.#paths = paths.slice();
      this.#readers = paths.map(() => action);
      this.#holes = 0;
      return;
    }
    const half = block >>> 1;
    const list: RowBlock[] = [];
    for (let at = 0; at < paths.length; at += half) {
      const slice = paths.slice(at, at + half);
      list.push({ paths: slice, readers: slice.map(() => action), holes: 0 });
    }
    this.#blocks = { list, entries: paths.length };
  }

  /** Adds `action` as a reader of `path`, which it does not yet read. */
  #index(action: Action, path: Path): void {
    const blocks = this.#blockCount();
    let b = this.#seekBlock(path, path.length, 0);
    let at: number;
    if (b === blocks) {
      // After every entry: the end of the last block, or of an empty row.
      b = blocks === 0 ? 0 : blocks - 1;
      at = this.#pathsIn(b).length;
    } else {
      at = this.#seekEntry(b, path, path.length, 0);
      if (compareRowPaths(this.#pathsIn(b)[at]!, path) === 0) {
        this.#join(b, at, action);
        return;
      }
    }

    const paths = this.#pathsIn(b);
    paths.splice(at, 0, path);
    this.#readersIn(b).splice(at, 0, action);
    if (this.#blocks !== undefined) this.#blocks.entries++;
    if (paths.length > this.#limits.block) this.#split(b);
  }

  /** Adds `action` to the readers of entry `at` of block `b`. */
  #join(b: number, at: number, action: Action): void {
    const readers = this.#readersIn(b);
    const reading = readers[at];
    if (reading === undefined) {
      readers[at] = action;
      this.#changeHoles(b, -1);
    } else if (typeof reading === "function") {
      readers[at] = [reading, action];
    } else if (!Array.isArray(reading)) {
      reading.add(action);
    } else if (reading.length < this.#limits.readersInArray) {
      reading.push(action);
    } else {
      const set = new Set(reading);
      set.add(action);
      readers[at] = set;
    }
  }

  /**
   * Removes `action` from the readers of `path`.
   *
   * @throws If the row holds no such entry, or `action` does not read it.
   */
  #unindex(action: Action, path: Path): void {
    const b = this.#seekBlock(path, path.length, 0);
    const at = this.#seekEntry(b, path, path.length, 0);
    const paths = b === this.#blockCount() ? [] : this.#pathsIn(b);
    const readers = b === this.#blockCount() ? [] : this.#readersIn(b);
    const reading = readers[at];
    if (
      at === paths.length || compareRowPaths(paths[at]!, path) !== 0 ||
      reading === undefined || !readersHold(reading, action)
    ) {
      throw new Error(
        `Registered read \`${path.join("/")}\` is missing from the index.`,
      );
    }

    if (typeof reading === "function") {
      readers[at] = undefined;
      if (this.#changeHoles(b, 1) * 2 > paths.length) this.#compact(b);
    } else if (Array.isArray(reading)) {
      reading.splice(reading.indexOf(action), 1);
      if (reading.length === 1) readers[at] = reading[0]!;
    } else {
      reading.delete(action);
      if (reading.size === this.#limits.readersInArray) {
        readers[at] = [...reading];
      }
    }
  }

  /** Cuts block `b`, which has grown past `limits.block`, in two. */
  #split(b: number): void {
    const paths = this.#pathsIn(b);
    const readers = this.#readersIn(b);
    const half = paths.length >>> 1;
    const tail: RowBlock = {
      paths: paths.slice(half),
      readers: readers.slice(half),
      holes: 0,
    };
    for (const reading of tail.readers) {
      if (reading === undefined) tail.holes++;
    }

    if (this.#blocks === undefined) {
      const head: RowBlock = {
        paths: paths.slice(0, half),
        readers: readers.slice(0, half),
        holes: this.#holes - tail.holes,
      };
      this.#blocks = { list: [head, tail], entries: paths.length };
      this.#paths = [];
      this.#readers = [];
      this.#holes = 0;
      return;
    }
    paths.length = half;
    readers.length = half;
    this.#changeHoles(b, -tail.holes);
    this.#blocks.list.splice(b + 1, 0, tail);
  }

  /**
   * Drops the holes from block `b`. A block left empty is removed, one left
   * small is merged into the block after it when the two fit in one, and a
   * row left with `limits.block / 4` entries or fewer goes back inline.
   */
  #compact(b: number): void {
    const paths = this.#pathsIn(b);
    const readers = this.#readersIn(b);
    let kept = 0;
    for (let at = 0; at < paths.length; at++) {
      const reading = readers[at];
      if (reading === undefined) continue;
      paths[kept] = paths[at]!;
      readers[kept] = reading;
      kept++;
    }
    const removed = paths.length - kept;
    paths.length = kept;
    readers.length = kept;

    const blocks = this.#blocks;
    if (blocks === undefined) {
      this.#holes = 0;
      if (kept === 0) {
        this.#paths = [];
        this.#readers = [];
      }
      return;
    }

    blocks.entries -= removed;
    const block = blocks.list[b]!;
    block.holes = 0;
    const quarter = this.#limits.block >>> 2;
    if (kept === 0) {
      blocks.list.splice(b, 1);
    } else if (kept < quarter && b + 1 < blocks.list.length) {
      const after = blocks.list[b + 1]!;
      if (kept + after.paths.length <= this.#limits.block) {
        for (let at = 0; at < after.paths.length; at++) {
          block.paths.push(after.paths[at]!);
          block.readers.push(after.readers[at]);
        }
        block.holes = after.holes;
        blocks.list.splice(b + 1, 1);
      }
    }
    if (blocks.entries <= quarter) this.#collapse();
  }

  /** Moves every entry a reader still reads back into the inline row. */
  #collapse(): void {
    const paths: Path[] = [];
    const readers: (Readers | undefined)[] = [];
    for (const block of this.#blocks!.list) {
      for (let at = 0; at < block.paths.length; at++) {
        const reading = block.readers[at];
        if (reading === undefined) continue;
        paths.push(block.paths[at]!);
        readers.push(reading);
      }
    }
    this.#blocks = undefined;
    this.#paths = paths;
    this.#readers = readers;
    this.#holes = 0;
  }
}

/** Calls `visit` with `path` once for each of `readers`. */
function visitReaders(
  path: Path,
  readers: Readers,
  visit: (path: Path, action: Action) => void,
): void {
  if (typeof readers === "function") {
    visit(path, readers);
    return;
  }
  for (const action of readers) visit(path, action);
}
