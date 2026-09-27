import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import {
  isFabricObjectOrArray,
  isFabricSpecialObject,
  valueEqual,
} from "@commonfabric/data-model";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { isPlainObject } from "@commonfabric/utils/types";

import { normalizeCellScope } from "../scope.ts";
import type {
  IMemoryAddress,
  IMemoryChange,
  IMergedChanges,
  State,
} from "./interface.ts";
import * as Address from "./transaction/address.ts";

// A differential merges one notification batch's changes per address
// IDENTITY — per scope instance (key-vocabulary.md §1 site 8), so two
// instances of one doc in a batch never collapse into one change entry.
// `identity` is the session the batch belongs to: the changes arrive
// scope-NAMED on today's per-session wire, and the owning session's
// identity maps each name to the same instance the session's reads map to.
export const create = (identity: ScopeKeyIdentity) => new Changes(identity);

interface Memory {
  get(entry: IMemoryAddress): State | undefined;
}

type ScopedState = State & Pick<IMemoryAddress, "scope" | "scopeKey">;

const stateScope = (state: State) =>
  normalizeCellScope((state as ScopedState).scope);

// The explicit scope INSTANCE a state names (server-execution v2 stage A,
// OW17's instance-keyed replica): a serving replica that holds several
// instances of one doc snapshots each with its key, so one notification
// batch keeps them apart and its change addresses carry the instance to
// the scheduler's per-instance dependency keys. Absent everywhere else
// (every client, the OFF arm): the batch identity resolves the name, and
// the change address is byte-identical to before.
const stateScopeKey = (state: State): string | undefined =>
  (state as ScopedState).scopeKey;

const valuelessWithScope = (state: State): State =>
  ({
    the: state.the,
    of: state.of,
    scope: stateScope(state),
    ...(stateScopeKey(state) !== undefined
      ? { scopeKey: stateScopeKey(state) }
      : {}),
  }) as State;

const toKey = (state: State, identity: ScopeKeyIdentity) =>
  `/${
    stateScopeKey(state) ?? resolveScopeKey(stateScope(state), identity)
  }/${state.the}/${state.of}`;
const toAddress = (
  state: State,
  path: readonly string[] = [],
): IMemoryAddress => ({
  id: state.of,
  type: state.the,
  scope: stateScope(state),
  ...(stateScopeKey(state) !== undefined
    ? { scopeKey: stateScopeKey(state) as IMemoryAddress["scopeKey"] }
    : {}),
  path: [...path],
});

const comparePaths = (
  left: readonly string[],
  right: readonly string[],
): number => {
  for (let index = 0; index < left.length && index < right.length; index += 1) {
    if (left[index] === right[index]) {
      continue;
    }
    return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length - right.length;
};

const pushChangedPath = (
  paths: string[][],
  currentPath: string[],
  depth: number,
): void => {
  paths.push(currentPath.slice(0, depth));
};

/**
 * Helper for {@link addStateChange}, which walks `before` and `after` in step
 * and records the path of every position where they differ.
 *
 * The walk is the whole of the comparison: a pair both values share is passed
 * over by identity, and a pair holding the same content is walked without
 * recording anything. So comparing a document with a copy-on-write revision of
 * itself costs the edited spine, and comparing it with a separately decoded
 * copy costs one walk of the whole.
 *
 * Two things stop the walk short of reading a pair by its keys, and ask
 * `valueEqual()` instead. A pair that is not two arrays or two plain records
 * is one the walk cannot read by key without misreading it. And a pair
 * whose `after` side is already open on the walk's path closes a cycle, which
 * walking would descend forever; `valueEqual()` compares a cycle where the
 * walk cannot. `ancestors` holds the `after` containers open on the path, and
 * one side suffices: the walk descends only as deep as both values reach.
 */
const collectChangedPaths = (
  before: FabricValue,
  after: FabricValue,
  currentPath: string[],
  depth: number,
  paths: string[][],
  ancestors: object[],
): void => {
  if (Object.is(before, after)) {
    return;
  }

  if (before === undefined || after === undefined) {
    pushChangedPath(paths, currentPath, depth);
    return;
  }

  if (isFabricObjectOrArray(before) && isFabricObjectOrArray(after)) {
    // A `FabricSpecialObject` keeps its state in private fields, so the
    // key-walk below sees zero own-keys and would wrongly report "no change"
    // for two that differ. Compare it by content, record a change at this
    // path when it differs, and don't decompose; otherwise a `FabricBytes`
    // value updated in place never reaches reactive consumers.
    //
    // The `FabricPrimitive` vs `FabricInstance` distinction matters here even
    // though both are handled the same way: a `FabricPrimitive` genuinely IS an
    // atomic frozen leaf (no outgoing references), so emitting a single change
    // at its path is exactly correct. A `FabricInstance` is neither necessarily
    // frozen nor a leaf — it can hold outgoing references to other
    // memory-tracked objects, so a fully correct walk would descend into them
    // (cf. `codecOf()` in cell.ts) and emit per-reference change paths. Lumping
    // it in as a leaf here misses a change to a reference an instance holds:
    // the fetch builtins store a `FabricError` as a result, so an instance does
    // reach storage.
    //
    // TODO(danfuzz): descend an instance by its codec contents here, at which
    // point this arm covers only the `FabricPrimitive` leaves it is correct
    // for.
    if (
      isFabricSpecialObject(before) || isFabricSpecialObject(after)
    ) {
      if (!valueEqual(before, after)) {
        pushChangedPath(paths, currentPath, depth);
      }
      return;
    }

    const beforeIsArray = Array.isArray(before);
    const afterIsArray = Array.isArray(after);
    if (
      (!beforeIsArray && !isPlainObject(before, false)) ||
      (!afterIsArray && !isPlainObject(after, false))
    ) {
      if (!valueEqual(before, after)) {
        pushChangedPath(paths, currentPath, depth);
      }
      return;
    }

    if (ancestors.includes(after) && valueEqual(before, after)) {
      return;
    }

    if (beforeIsArray && afterIsArray) {
      if (before.length !== after.length) {
        pushChangedPath(paths, currentPath, depth);
      }

      ancestors.push(after);
      const maxLength = Math.max(before.length, after.length);
      for (let index = 0; index < maxLength; index += 1) {
        const beforeHas = index in before;
        const afterHas = index in after;
        if (!beforeHas && !afterHas) {
          continue;
        }

        if (beforeHas && afterHas) {
          currentPath[depth] = String(index);
          collectChangedPaths(
            before[index],
            after[index],
            currentPath,
            depth + 1,
            paths,
            ancestors,
          );
          continue;
        }

        if (before.length === after.length) {
          currentPath[depth] = String(index);
          pushChangedPath(paths, currentPath, depth + 1);
        }
      }
      ancestors.pop();
      currentPath.length = depth;
      return;
    }

    if (beforeIsArray !== afterIsArray) {
      pushChangedPath(paths, currentPath, depth);
      return;
    }

    // Both are plain records here: `FabricSpecialObject`s, arrays, and
    // everything else returned above. Narrowing does not carry those
    // exclusions forward, so name it.
    const beforeObject = before as FabricPlainObject;
    const afterObject = after as FabricPlainObject;
    const beforeKeys = Object.keys(beforeObject);
    const afterKeys = Object.keys(afterObject);
    ancestors.push(after);

    if (beforeKeys.length === afterKeys.length) {
      let sameKeys = true;
      for (const key of beforeKeys) {
        if (!Object.hasOwn(after, key)) {
          sameKeys = false;
          break;
        }
      }

      if (sameKeys) {
        for (const key of beforeKeys) {
          currentPath[depth] = key;
          collectChangedPaths(
            beforeObject[key],
            afterObject[key],
            currentPath,
            depth + 1,
            paths,
            ancestors,
          );
        }
        ancestors.pop();
        currentPath.length = depth;
        return;
      }
    }

    const seen = new Set<string>();
    for (const key of beforeKeys) {
      seen.add(key);
      const afterHas = Object.hasOwn(after, key);
      currentPath[depth] = key;
      if (afterHas) {
        collectChangedPaths(
          beforeObject[key],
          afterObject[key],
          currentPath,
          depth + 1,
          paths,
          ancestors,
        );
        continue;
      }

      pushChangedPath(paths, currentPath, depth + 1);
    }

    for (const key of afterKeys) {
      if (seen.has(key)) {
        continue;
      }
      currentPath[depth] = key;
      pushChangedPath(paths, currentPath, depth + 1);
    }
    ancestors.pop();
    currentPath.length = depth;
    return;
  }

  if (!valueEqual(before, after)) {
    pushChangedPath(paths, currentPath, depth);
  }
};

const addStateChange = (
  changes: Changes,
  state: State,
  before: State["is"] | undefined,
  after: State["is"] | undefined,
): void => {
  if (Object.is(before, after)) {
    return;
  }

  if (before === undefined || after === undefined) {
    changes.add({
      address: toAddress(state),
      before,
      after,
    });
    return;
  }

  const paths: string[][] = [];
  collectChangedPaths(before, after, [], 0, paths, []);
  if (paths.length === 0) {
    return;
  }

  paths.sort(comparePaths);
  for (const path of paths) {
    changes.add({
      address: toAddress(state, path),
      before,
      after,
    });
  }
};

/**
 * Checks out state from the given memory so that we can compute changes
 * later on. An address the memory does not hold is checked out as its
 * address alone, carrying no value.
 */
export const checkout = (
  memory: Memory,
  states: Iterable<State>,
  identity: ScopeKeyIdentity,
) => {
  const checkout = new Checkout(identity);
  for (const member of states) {
    const address = toAddress(member);
    const existing = memory.get(address);
    if (existing) {
      checkout.add(existing);
    } else {
      checkout.add(valuelessWithScope(member));
    }
  }
  return checkout;
};

export const load = (states: Iterable<State>, identity: ScopeKeyIdentity) =>
  create(identity).set(states);

class Checkout {
  #model: Map<string, State> = new Map();
  constructor(readonly identity: ScopeKeyIdentity) {}
  add(state: State) {
    this.#model.set(toKey(state, this.identity), state);
  }

  compare(memory: Memory) {
    const changes = new Changes(this.identity);
    for (const state of this.#model.values()) {
      const before = state?.is;
      const after = memory.get(toAddress(state))?.is;
      addStateChange(changes, state, before, after);
    }
    return changes;
  }
}

class Changes implements IMergedChanges {
  #model: Map<string, IMemoryChange> = new Map();
  constructor(readonly identity: ScopeKeyIdentity) {}
  *[Symbol.iterator]() {
    yield* this.#model.values();
  }

  /**
   * Adds new state to the changeset.
   */
  set(states: Iterable<State>) {
    for (const state of states) {
      addStateChange(this, state, undefined, state.is);
    }
    return this;
  }

  /**
   * Captures changes between what is in the given memory and
   * provided state.
   */
  update(memory: Memory, states: Iterable<State>) {
    for (const state of states) {
      const before = memory.get(toAddress(state))?.is;
      const after = state.is;
      addStateChange(this, state, before, after);
    }
    return this;
  }

  add(change: IMemoryChange) {
    const key = Address.toString(change.address, this.identity);

    if (!this.#model.has(key)) {
      this.#model.set(key, change);
    }
    return this;
  }

  toJSON() {
    return [...this.#model.values()];
  }

  close(): IMergedChanges {
    return this;
  }
}
