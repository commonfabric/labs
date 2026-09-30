import { isPlainContainer } from "@commonfabric/utils/types";
import {
  FabricInstance,
  type FabricValue,
  isWalkableObjectOrArray,
  valueEqual,
} from "@commonfabric/data-model";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import { isPrimitiveCellLink } from "./link-utils.ts";
import { normalizeCellScope } from "./scope.ts";
import { arrayEqual } from "./path-utils.ts";
import type { Action, SpaceScopeAndURI } from "./scheduler.ts";
import { entityKey } from "./scheduler/keys.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
} from "./storage/interface.ts";

export type SortedAndCompactPaths = Array<
  readonly MemoryAddressPathComponent[]
>;
export interface DetermineTriggeredActionsOptions {
  /**
   * Non-recursive reads are invalidated by parent/same-path writes only.
   * Child-path writes invalidate only if they add a new direct child key.
   */
  nonRecursive?: boolean;
}

type Keyable = Record<MemoryAddressPathComponent, FabricValue>;

/**
 * Sorts and compactifies the paths.
 *
 * Compactifies by removing any duplicate entries, and potentially entries
 * that have another as a prefix.
 *
 * @param paths - The paths to sort and compactify.
 * @param compactifyChildren - whether to remove entries that have the same prefix
 * @returns The sorted and compactified paths.
 */
export function sortAndCompactPaths(
  unsorted: IMemorySpaceAddress[],
  compactifyChildren = true,
): IMemorySpaceAddress[] {
  if (unsorted.length === 0) return [];

  // The instance segment: an address that NAMES its instance
  // (`scopeKey`, server-execution v2 stage A — a served per-instance
  // run's logged read) compares by that key, so the union of one node's
  // N instance runs' logs keeps N reads of one doc apart instead of
  // compacting them into one; an address without one compares by scope
  // NAME as before (byte-identical ordering and compaction OFF).
  const instanceOf = (address: IMemorySpaceAddress): string =>
    address.scopeKey ?? normalizeCellScope(address.scope);

  // Grouped by document instance before anything is sorted. A read log names
  // many documents and few paths in each, so ordering the groups and then
  // each group's paths costs far fewer comparisons than one sort over every
  // address, and produces the same order: groups by space, id and instance,
  // paths within a group by `comparePaths()`, and equal addresses in the
  // order they arrived.
  const groups = new Map<string, IMemorySpaceAddress[]>();
  for (const address of unsorted) {
    const key = `${address.space}\0${address.id}\0${instanceOf(address)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [address]);
    else group.push(address);
  }
  const ordered = [...groups.values()];
  if (ordered.length > 1) {
    ordered.sort(([a], [b]) => {
      if (a.space !== b.space) return a.space < b.space ? -1 : 1;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return instanceOf(a) < instanceOf(b) ? -1 : 1;
    });
  }

  const result: IMemorySpaceAddress[] = [];
  for (const group of ordered) {
    if (group.length > 1) {
      group.sort((a, b) => comparePaths(a.path, b.path));
    }
    let previous: IMemorySpaceAddress | undefined;
    for (const address of group) {
      if (
        previous !== undefined &&
        // Is the previous path a prefix of the current path?
        previous.path.every((value, index) => value === address.path[index]) &&
        // If we compactifyChildren, or the paths are identical, skip this
        (compactifyChildren || previous.path.length === address.path.length)
      ) {
        continue;
      }
      result.push(address);
      previous = address;
    }
  }
  return result;
}

/**
 * The grouping `addressesToPathByEntity()` last produced for each address
 * list, keyed on the list itself. A scheduling log's reads are grouped when
 * the action registers them and grouped again, as the previous log, when it
 * re-registers, and the list is not changed between the two, so the second
 * grouping is the first read back. The identity is part of the answer, so an
 * entry made under a different one is not served, and the length is checked
 * so a list that did grow is grouped afresh.
 */
const groupingsByAddressList = new WeakMap<IMemorySpaceAddress[], {
  readonly identity: ScopeKeyIdentity;
  readonly length: number;
  readonly byEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
}>();

/**
 * Converts a list of paths to a map of space/id to paths.
 *
 * The map is memoized on `addresses` (see `groupingsByAddressList`), so the
 * list must not be changed after this is called, and a caller must not change
 * the map or the path arrays it holds: both are shared with every later call
 * that hands over the same list.
 *
 * @param addresses - The paths to convert.
 * @returns A map of space/id to paths.
 */
export function addressesToPathByEntity(
  addresses: IMemorySpaceAddress[],
  identity: ScopeKeyIdentity,
): Map<SpaceScopeAndURI, SortedAndCompactPaths> {
  const memoized = groupingsByAddressList.get(addresses);
  if (
    memoized !== undefined &&
    memoized.length === addresses.length &&
    memoized.identity.principal === identity.principal &&
    memoized.identity.sessionId === identity.sessionId
  ) {
    return memoized.byEntity;
  }
  const map = new Map<SpaceScopeAndURI, SortedAndCompactPaths>();
  for (const address of addresses) {
    // Same key vocabulary as the dependency graph — one map entry per
    // scope instance, via the shared constructor (no inline restatement).
    const key = entityKey(address, identity);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(address.path);
  }
  groupingsByAddressList.set(addresses, {
    identity: { principal: identity.principal, sessionId: identity.sessionId },
    length: addresses.length,
    byEntity: map,
  });
  return map;
}

/**
 * Whether the descent below may address `value` by key.
 *
 * This is {@link isWalkableObjectOrArray} with its refusal of a
 * `FabricInstance` replaced by `true`. The descent reads an instance by
 * property name, reaching the accessors a `FabricError` carries and finding
 * nothing on a `FabricMap`. Answering `false` would make an instance
 * indistinguishable from a leaf, and a read below one would then stop
 * triggering when the instance is deleted or replaced by a scalar.
 *
 * TODO(danfuzz): remove this once `isWalkableObjectOrArray()` stops throwing
 * for a `FabricInstance`. The descent it gains at that point is the one this
 * function already performs, so the two answers converge and the call sites
 * below name the shared predicate directly.
 */
function isKeyable(value: unknown): boolean {
  return value instanceof FabricInstance || isWalkableObjectOrArray(value);
}

/**
 * Determines the actions that are triggered based on the changes to the data.
 *
 * Functionally equivalent looking for any `!deepEqual` for `getAtPath` for all
 * the paths per action.
 *
 * @param dependencies - A map of actions to their sorted paths.
 * @param before - The data before the changes.
 * @param after - The data after the changes.
 * @param startPath - The path the passed in data starts at.
 * @returns The actions that need to be triggered.
 */
export function determineTriggeredActions(
  dependencies: Map<Action, SortedAndCompactPaths>,
  before: FabricValue,
  after: FabricValue,
  startPath: readonly MemoryAddressPathComponent[] = [],
  options?: DetermineTriggeredActionsOptions,
): Action[] {
  const triggeredActions: Action[] = [];

  let subscribers: { action: Action; paths: SortedAndCompactPaths }[] = Array
    .from(
      dependencies.entries(),
    ).map((
      [action, paths],
    ) => ({
      action,
      paths: paths.toReversed(),
    }));

  if (startPath.length > 0) {
    // If we're starting from a specific path, filter the subscribers to only
    // include those that can be affected by that path.
    subscribers = subscribers.map(({ action, paths }) => ({
      action,
      paths: paths.filter((path) => arraysOverlap(path, startPath)),
    })).filter(({ paths }) => paths.length > 0);
  }

  // Sort subscribers by last/longest path first.
  subscribers.sort((a, b) => comparePaths(b.paths[0], a.paths[0]));

  // Traversal state:
  let currentPath: readonly MemoryAddressPathComponent[] = [];

  // *Values: An array of data values along currentPath
  const beforeValues: FabricValue[] = [before];
  const afterValues: FabricValue[] = [after];

  // *LastObject: Last key-able object along currentPath. A `FabricPrimitive`
  // is not key-able: its state sits behind no property name, so the descent
  // stops at one and a path continuing below reads as unreachable rather than
  // as present-and-empty.
  //
  // TODO(danfuzz): a `FabricInstance` is descended by property name, which
  // reaches what its class exposes that way and not what its codec holds. A
  // subscriber path below a `FabricMap` or `FabricSet` therefore reads as
  // present-and-empty on both sides, and its action never triggers however
  // the contents changed. The `shallowEqual` marker at the bottom of this
  // file covers the leaf comparison; this is the descent's half of the same
  // gap.
  let beforeLastObject = isKeyable(before) ? 0 : -1;
  let afterLastObject = isKeyable(after) ? 0 : -1;

  while (subscribers.length > 0) {
    // Pull the next path from the queue
    const current = [subscribers.shift()!];
    const targetPath = current[0].paths.shift()!;

    // Also pull in all subscribers that have the same path
    while (
      subscribers.length > 0 && arrayEqual(targetPath, subscribers[0].paths[0])
    ) {
      subscribers[0].paths.shift();
      current.push(subscribers.shift()!);
    }

    // Now traverse the data to target path
    const overlap = commonPrefixLength(targetPath, currentPath);
    for (let i = overlap; i < targetPath.length; i++) {
      if (i <= beforeLastObject) {
        beforeValues[i + 1] = (beforeValues[i] as Keyable)[targetPath[i]!];
        if (isKeyable(beforeValues[i + 1])) beforeLastObject = i + 1;
        else beforeLastObject = i;
      }
      if (i <= afterLastObject) {
        afterValues[i + 1] = (afterValues[i] as Keyable)[targetPath[i]!];
        if (isKeyable(afterValues[i + 1])) afterLastObject = i + 1;
        else afterLastObject = i;
      }
    }
    currentPath = targetPath;

    // Check if we could traverse far enough to reach the target path
    const beforeCanReach = beforeLastObject + 1 >= targetPath.length;
    const afterCanReach = afterLastObject + 1 >= targetPath.length;

    // Determine if there was a change. For recursive reads, trigger if:
    // 1. Both paths are reachable and the values differ
    // 2. Reachability changed (one can reach, the other can't)
    // 3. Neither can reach, but the depth of reachability changed
    //    (e.g., before we couldn't get past "a", now we can get to "a.b")
    let hasChanged: boolean;
    if (beforeCanReach && afterCanReach) {
      // Both reachable - compare actual values
      if (options?.nonRecursive) {
        hasChanged = !shallowEqual(
          beforeValues[targetPath.length],
          afterValues[targetPath.length],
        );
      } else {
        hasChanged = !valueEqual(
          beforeValues[targetPath.length],
          afterValues[targetPath.length],
        );
      }
    } else if (beforeCanReach !== afterCanReach) {
      // Reachability changed - definitely a structural change
      hasChanged = true;
    } else {
      // Neither reachable - check if we can traverse to different depths
      // This detects when intermediate path segments appear/disappear
      hasChanged = beforeLastObject !== afterLastObject;
    }

    if (hasChanged) {
      // If the value changed, trigger the actions
      triggeredActions.push(...current.map(({ action }) => action));
    } else {
      // Otherwise, queue up the next path, keeping subscribers sorted by path
      for (const subscriber of current) {
        if (subscriber.paths.length > 0) {
          const nextPath = subscriber.paths[0];
          for (let i = 0; i <= subscribers.length; i++) {
            if (
              i === subscribers.length ||
              comparePaths(nextPath, subscribers[i].paths[0]) >= 0
            ) {
              subscribers.splice(i, 0, subscriber);
              break;
            }
          }
        }
      }
    }
  }

  return triggeredActions;
}

export function arraysOverlap(
  a: readonly MemoryAddressPathComponent[],
  b: readonly MemoryAddressPathComponent[],
): boolean {
  return (a.length > b.length)
    ? b.every((value, index) => value === a[index])
    : a.every((value, index) => value === b[index]);
}

export function nonRecursiveReadMayOverlapWrite(
  readPath: readonly MemoryAddressPathComponent[],
  writePath: readonly MemoryAddressPathComponent[],
): boolean {
  return writePath.length <= readPath.length + 1 &&
    arraysOverlap(writePath, readPath);
}

function commonPrefixLength(
  a: readonly MemoryAddressPathComponent[],
  b: readonly MemoryAddressPathComponent[],
): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return Math.min(a.length, b.length);
}

/**
 * Returns true if the SHALLOW structure of `before` and `after` are the same.
 *
 * For non-recursive reads, only structural changes at the target level
 * (key additions/removals, type changes, link identity changes) should
 * trigger re-evaluation. Deep value changes inside existing keys should not.
 *
 * - Links: compared by identity (deepEqual), since a link IS the pointer.
 * - Plain objects: changed iff the key set changed (not the values).
 * - Arrays: changed iff the key set changed (not the values).
 * - Everything else: an opaque leaf, changed iff its value changed.
 *
 * Comparing by key set is only meaningful for a plain object or array, where
 * the key set IS the shallow structure and a subscriber on a deeper path still
 * catches a changed value underneath it. It says nothing useful about any
 * other object: a `FabricPrimitive` holds its state in private fields, so
 * comparing key sets reports every two of them as unchanged — and because that
 * state sits behind no enumerable key, no deeper subscriber path reaches it
 * either. The change goes unnoticed at every depth, which is what separates
 * this from a plain object's values being skipped by design. Those are leaves,
 * and a leaf is compared by value.
 *
 * That resolves an ambiguity this function used to leave open — whether a
 * shallow read of an opaque leaf should react to a change of class or to any
 * change of value. Treating non-plain values as leaves answers "any change of
 * value", which is also what the recursive path answers, so the same value
 * gets the same verdict whichever way it is read.
 *
 * A leaf whose comparison `valueEqual()` cannot perform will throw, and that
 * is deliberate: the classes it currently cannot compare are ones whose
 * protocol members are unimplemented stubs. A stub announcing itself loudly is
 * worth more than a quiet answer derived from it, and swallowing the failure
 * would let an unfinished class shape behavior here. Do not add a `catch`.
 */
function shallowEqual(
  before: FabricValue,
  after: FabricValue,
): boolean {
  // Links compare by full identity — a different link target matters.
  if (isPrimitiveCellLink(before) || isPrimitiveCellLink(after)) {
    return valueEqual(before, after);
  }

  if (isPlainContainer(before) && isPlainContainer(after)) {
    const beforeKeys = Object.keys(before);
    const afterKeys = Object.keys(after);
    if (beforeKeys.length !== afterKeys.length) return false;
    // if one is an array, both must be
    if (Array.isArray(before) != Array.isArray(after)) return false;
    // if our array length changed, we've changed
    if (Array.isArray(before) && before.length !== after.length) return false;
    return beforeKeys.every((k) => Object.hasOwn(after, k));
  }

  // Opaque leaf: compared by value. `valueEqual()` leads with `Object.is()`,
  // so an identical pair short-circuits before any structural work.
  // TODO(danfuzz): `FabricInstance` cases will currently end up here, and we
  // should be treating them more like the plain container cases above.
  return valueEqual(before, after);
}

/**
 * Orders two paths, a path ahead of every path it is a prefix of, and
 * otherwise by the first component the two disagree on.
 */
export function comparePaths(
  a: readonly MemoryAddressPathComponent[],
  b: readonly MemoryAddressPathComponent[],
): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return a.length - b.length;
}
