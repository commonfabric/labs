/**
 * Freezing a value all the way down, and asking whether it already is.
 *
 * Both walks are memoized in a `WeakSet`, which is what makes the ordinary
 * case cheap: a value frozen once takes constant time ever after, and a
 * primitive never needs asking at all. Both fast paths run before any per-walk
 * state is allocated, so the cheap path costs nothing.
 *
 * A `FabricInstance` keeps its contents private, so neither walk can descend
 * into one directly. Each calls the instance's own protocol member and passes
 * recursion back in, which is what keeps the cycle tracking and the cache
 * shared across that boundary instead of restarting inside it.
 */

import { isObjectOrArray } from "@commonfabric/utils/types";
import type { FabricValue } from "./interface.ts";
import {
  BaseFabricInstance,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "./fabric-bases/BaseFabricInstance.ts";
import { BaseFabricPrimitive } from "./fabric-bases/BaseFabricPrimitive.ts";
import { isValidFabricValue } from "@/types/validation.ts";

/** Cache of confirmed deep-frozen objects. */
const deepFrozenCache = new WeakSet<object>();

/**
 * Object graphs proven to be deep-frozen `FabricValue`s, memoized by root
 * identity for `isValidDeepFrozenFabricValue()`. Sound to cache because the
 * deep-frozen-honesty mandate makes such a proof permanent (see
 * `[IS_DEEP_FROZEN]` on `BaseFabricInstance` and the `FabricValue` doc).
 */
const deepFrozenFabricValueCache = new WeakSet<object>();

/** Adds a value which has been determined to be deep-frozen to the cache. */
function addToDeepFrozenCache(obj: object) {
  deepFrozenCache.add(obj);
}

/**
 * Indicates whether or not the given object is already in the
 * `deepFrozenCache`.
 */
function isInDeepFrozenCache(obj: object): boolean {
  return deepFrozenCache.has(obj);
}

/**
 * Indicates whether the given value is "necessarily frozen" -- immutable by its
 * very nature, without any `Object.freeze()` having been applied. Reports
 * `true` for every primitive (`null`, `undefined`, booleans, numbers, strings,
 * `bigint`s, symbols) and `FabricPrimitive` instances (which self-freeze at
 * construction and hold no outbound references). Ordinary objects and arrays
 * are `false`, as are `FabricInstance`s (whose frozen-ness depends on
 * `Object.freeze()` and their `[IS_DEEP_FROZEN]` report).
 *
 * KNOWN LIMITATION -- these do the wrong thing for `function`s, specifically. A
 * function reports `true` here (its `typeof` is not `"object"`), so
 * `deepFreeze()` and `isDeepFrozen()` treat it as an opaque immutable leaf:
 * `isDeepFrozen(fn)` is `true`, and a frozen graph reaching a function reads as
 * deep-frozen, even though the function's internals -- its `prototype` object
 * and closure state -- remain mutable. This is deliberate, so general-purpose
 * callers that freeze objects-with-methods (e.g. `api/cfc.ts`'s `cfcPattern`)
 * keep working.
 *
 * TODO(danfuzz): Migrate `deepFreeze()` to accept `FabricValue` only. A
 * function is not a `FabricValue`, so a strict signature removes the case
 * rather than special-casing it; the blocker is the general-purpose callers
 * above, which must stop passing objects-with-methods first.
 */
function isNecessarilyFrozenValue(value: unknown): boolean {
  if (typeof value === "object") {
    return (value === null) || BaseFabricPrimitive.isInstance(value);
  }
  return true;
}

/**
 * Indicates whether the given value is either _necessarily_ or _already known
 * to be_ deep-frozen.
 */
function isNecessarilyOrKnownDeepFrozen(value: unknown): boolean {
  // The `as` cast is safe: a `false` antecedent means `value` is a
  // non-`FabricPrimitive` object (primitives and functions short-circuit `true`
  // above), which is a valid `WeakSet` key.
  return isNecessarilyFrozenValue(value) ||
    isInDeepFrozenCache(value as object);
}

/**
 * Returns `true` if the value is deeply frozen: either a primitive, or a
 * frozen object/array whose every nested value is also deeply frozen
 * (recursively). Caches results for fast repeat checks.
 *
 * Handles circular references and sparse arrays.
 */
export function isDeepFrozen(value: unknown): boolean {
  // Fast leaf paths first, so a primitive or already-cached value returns
  // without allocating the cycle-tracking set or the recursion closure below.
  if (isNecessarilyOrKnownDeepFrozen(value)) {
    return true;
  } else if (!Object.isFrozen(value)) {
    return false;
  }

  // We have non-leaf structure to walk. Allocate the cycle-tracking set and
  // build the recursion callback ONCE here, reusing the same closure at every
  // layer rather than allocating an equivalent `(v) => …` per descent.
  const inProgress = new Set<object>();
  const check = (value: unknown): boolean => {
    if (isNecessarilyOrKnownDeepFrozen(value)) {
      return true;
    } else if (!Object.isFrozen(value)) {
      return false;
    }

    const obj = value as object;

    // If we're already checking `obj` higher in the recursion, treat it as
    // frozen for the rest of this check: it only ends up marked actually
    // deep-frozen if the outer check confirms.
    if (inProgress.has(obj)) return true;
    inProgress.add(obj);

    let result = true;

    if (BaseFabricInstance.isInstance(obj)) {
      // A `FabricInstance`'s logical contents are not its enumerable own-props
      // (e.g. a `FabricError` keeps its custom properties in a private extras
      // `Map`), so it answers the deep-frozen question via its
      // `[IS_DEEP_FROZEN]` protocol member -- the side-effect-free sibling of
      // `[DEEP_FREEZE]` -- recursing into each nested `FabricValue` through
      // `check`, which shares this call's cycle state. Gating via
      // `BaseFabricInstance.isInstance()` keeps this generic (and enforces the
      // "every `FabricInstance` is a `BaseFabricInstance`" invariant); the
      // member is abstract on `BaseFabricInstance`, so every instance
      // implements it. (A `FabricPrimitive` never reaches here: it is
      // necessarily frozen, so it short-circuits at the
      // `isNecessarilyOrKnownDeepFrozen` check above.)
      result = obj[IS_DEEP_FROZEN](check);
    } else if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) continue; // sparse hole
        if (!check(obj[i])) {
          result = false;
          break;
        }
      }
    } else {
      for (const v of Object.values(obj)) {
        if (!check(v)) {
          result = false;
          break;
        }
      }
    }

    inProgress.delete(obj);
    if (result) {
      addToDeepFrozenCache(obj);
    }
    return result;
  };

  return check(value);
}

/**
 * Recursively freezes the given value in place. Dispatches on three arms, in
 * order:
 *
 * 1. Necessarily- or already-known-deep-frozen value (primitives,
 *    `FabricPrimitive`s, and cached objects): short-circuit unchanged.
 * 2. `FabricInstance`: delegate generically to its `[DEEP_FREEZE]` protocol
 *    member, handing recursion through as the `subFreeze` callback. The
 *    dispatch gates via `BaseFabricInstance.isInstance()` (where the member is
 *    declared) -- it operates generically and does not enumerate concrete
 *    subclasses.
 * 3. Plain object or array: recursively freeze children, then freeze the
 *    container.
 *
 * Arrays and plain objects are frozen after their children are recursively
 * frozen. Primitives pass through unchanged. Records the result in the
 * deep-frozen cache so subsequent `isDeepFrozen()` checks return in O(1).
 * Returns the (now-frozen) value.
 *
 * Handles circular references: a shared `inProgress` set is threaded through
 * all recursive calls -- including into participating `FabricInstance`s'
 * `[DEEP_FREEZE]` impls via the `subFreeze` callback closure -- so a cycle
 * back to a value currently being deep-frozen short-circuits rather than
 * recursing infinitely.
 */
export function deepFreeze<T>(value: T): T {
  // Arm 1: necessarily- or already-known-deep-frozen (primitives,
  // `FabricPrimitive`s, and cached objects). Handling this here, before
  // allocating the cycle-tracking set or the recursion closure below, keeps
  // them off the heavyweight path.
  if (isNecessarilyOrKnownDeepFrozen(value)) {
    return value;
  }

  // We have non-leaf structure to freeze. Allocate the shared cycle-detection
  // set and build the recursion callback ONCE here, reusing the same closure
  // at every layer -- including as the `subFreeze` passed into participating
  // `FabricInstance`s' `[DEEP_FREEZE]` impls -- rather than allocating an
  // equivalent `(v) => …` per descent.
  //
  // The closure does NOT remove values from `inProgress` (unlike the
  // deep-frozen *check*, whose answer is local to each subtree): a value being
  // deep-frozen stays-the-course, so the outer call owns the freeze and every
  // cycle-arrival defers to it.
  const inProgress = new Set<object>();
  const freeze = <U>(value: U): U => {
    // Leaf short-circuits, repeated for nested values reached by recursion.
    if (isNecessarilyOrKnownDeepFrozen(value)) {
      return value;
    }

    const obj = value as object;

    if (inProgress.has(obj)) {
      // A cycle back to a value the outer call is already deep-freezing.
      // Short-circuit: the outer call owns the freeze; recursing here would
      // either loop or pre-freeze before the outer call finishes its own
      // children.
      return value;
    }
    inProgress.add(obj);

    // Arm 2: a `FabricInstance` freezes itself in place via its `[DEEP_FREEZE]`
    // protocol member. `freeze` is handed in as the `subFreeze` callback: it
    // closes over `inProgress`, so the impl's recursion into nested
    // `FabricValue`s shares cycle state with this call -- the participating
    // instance doesn't need to be `inProgress`-aware in its own signature.
    if (BaseFabricInstance.isInstance(value)) {
      const result = value[DEEP_FREEZE](freeze) as U;
      // Cache the now-deep-frozen result so subsequent `isDeepFrozen()` checks
      // short-circuit in O(1), mirroring arm 4's cache-write below.
      addToDeepFrozenCache(result as object);
      return result;
    }

    // Arm 3: plain object or array -- recurse into children, then freeze.
    const alreadyFrozen = Object.isFrozen(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (i in value) freeze(value[i]);
      }
    } else {
      const o = value as Record<string, unknown>;
      for (const key of Object.keys(o)) {
        freeze(o[key]);
      }
    }

    if (!alreadyFrozen) Object.freeze(value);
    addToDeepFrozenCache(value as object);
    return value;
  };

  return freeze(value);
}

/**
 * Indicates whether the value is a deep-frozen `FabricValue`: both a
 * `FabricValue` (`isValidFabricValue()`) and deeply frozen (`isDeepFrozen()`),
 * with an identity-cached fast path. The cache is sound per the
 * deep-frozen-honesty mandate (see `[IS_DEEP_FROZEN]` and the `FabricValue`
 * doc), which makes a deep-frozen proof permanent.
 */
export function isValidDeepFrozenFabricValue(
  value: unknown,
): value is FabricValue {
  if (
    isObjectOrArray(value) &&
    deepFrozenFabricValueCache.has(value)
  ) {
    return true;
  }

  // The frozen-ness question goes first because it is the cheap one, and a
  // `false` from it settles the conjunction. `isDeepFrozen()` returns in
  // constant time for anything not frozen at its root, and memoizes every
  // subtree it does walk; `isValidFabricValue()` walks the whole tree afresh on
  // every call. With the walk second, a mutable tree -- what the write path
  // hands this function at every level of its own recursion -- costs one
  // `Object.isFrozen()` call rather than a full membership walk of its
  // subtree.
  const result = isDeepFrozen(value) && isValidFabricValue(value);

  if (result && isObjectOrArray(value)) {
    deepFrozenFabricValueCache.add(value);
  }

  return result;
}
