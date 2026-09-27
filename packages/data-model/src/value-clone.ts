/**
 * Cloning a value that is already a `FabricValue`, in order to change how
 * frozen it is. This is not conversion: the input is taken as valid, and what
 * varies is frozenness, depth, and whether a copy is forced rather than
 * elided.
 *
 * The more involved job is preparing a value for a structured mutation, which
 * is a copy-on-write descent. Only the containers along the path being mutated
 * are thawed and spliced back in, and every subtree off that path keeps its
 * identity. That identity is the point rather than an incidental saving: an
 * untouched subtree stays in the deep-frozen cache, so re-freezing the result
 * short-circuits on it instead of walking it again.
 *
 * Cycles are refused rather than accommodated, on the deep paths that would
 * otherwise recurse forever.
 */

import { backtickQuote } from "@commonfabric/utils/markdown";
import { type Immutable, isPlainContainer } from "@commonfabric/utils/types";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";

import {
  FabricInstance,
  FabricValue,
  MutableFabricArrayLayer,
  MutableFabricContainerValueLayer,
  MutableFabricPlainObjectLayer,
} from "./interface.ts";
import {
  isFabricContainerValue,
  isFabricPlainContainer,
  tagOfConvertibleJsValueElseNull,
  VALUE_TAGS,
} from "@/types";
import { deepFreeze, isValidDeepFrozenFabricValue } from "./deep-freeze.ts";
import { toDebugKindString } from "@/value-debug";

/** Options for `cloneIfNecessary()`. */
export interface CloneOptions {
  /** Whether the result should be frozen. Default: `true`. */
  frozen?: boolean;

  /** Whether to clone deeply or shallowly. Default: `true`. */
  deep?: boolean;

  /**
   * Force a copy to be made.
   *
   * - When `frozen = false`: defaults to `true` (always clone to guarantee
   *   mutable isolation).
   * - When `frozen = true`: defaults to `false` (clone only if necessary
   *   to achieve frozenness).
   * - `{ frozen: true, force: true }` is an error (pointless to force-copy
   *   something that will be immutable anyway).
   * - `{ frozen: false, force: false, deep: false }`: valid -- caller owns
   *   the reference and wants it mutable; thaws if frozen, returns as-is
   *   if already mutable.
   * - `{ frozen: false, force: false, deep: true }`: error -- ambiguous
   *   semantics for trees with mixed frozenness.
   */
  force?: boolean;
}

/**
 * Tracks an object for circular reference detection during deep cloning.
 * Lazily allocates the `seen` set on first use, throws if a cycle is
 * detected, and adds the object to the set. Returns the (possibly
 * newly-allocated) set.
 */
function trackForCircularity(
  obj: object,
  seen: Set<object> | null,
): Set<object> {
  seen ??= new Set();
  if (seen.has(obj)) {
    throw new Error("Cannot deep-clone circular reference");
  }
  seen.add(obj);
  return seen;
}

/**
 * Clones an already-valid `FabricValue` to achieve a desired frozenness,
 * with control over depth and copy semantics.
 *
 * Unlike `fabricFromConvertibleJsValue()` (which converts convertible JS values
 * into fabric wrappers), this function assumes the input is already a valid
 * `FabricValue` and only adjusts frozenness by cloning where necessary.
 *
 * Cyclic values are not supported: a deep clone (the default) throws on a
 * detected cycle.
 *
 * **Type Validation Note:** The argument must honor the whole `FabricValue`
 * contract, which says more than its type does, and what this does with a
 * value that does not is best-effort. The one refusal made comes free with
 * the dispatch on each value's tag: a value the dispatch does not recognize as
 * a kind of `FabricValue`, such as a class instance or a null-prototype
 * object, throws. The rest are not made, because each would cost a probe or a
 * look at every property of every value copied:
 *
 * * An own `__proto__` property, a name this runtime reserves (see
 *   `unsafeObjectKeyIn()`). The copy is built by assignment, which reaches the
 *   prototype's accessor rather than making a property, so a browser drops the
 *   property and, when its value is an object, repoints the copy's prototype.
 * * A record's accessor, whose getter the copy runs, keeping the value it
 *   returns; and its non-enumerable keys, which the copy drops. A deep copy
 *   drops its symbol keys too, where a shallow one keeps them.
 * * An array's prototype and non-index properties: the copy is a direct
 *   `Array` of the indices alone.
 * * A `FabricInstance`, which is trusted to clone itself.
 *
 * @param value - An already-valid `FabricValue`.
 * @param options - See `CloneOptions`. Defaults to
 *   `{ frozen: true, deep: true }`.
 */
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions & { frozen?: true },
): Immutable<T>;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options: CloneOptions & { frozen: false },
): T;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions,
): T;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions,
): T {
  const frozen = options?.frozen ?? true;
  const deep = options?.deep ?? true;
  const force = options?.force ?? (frozen ? false : true);

  if (frozen && force) {
    throw new Error(
      "`cloneIfNecessary()`: `{ frozen: true, force: true }` is invalid " +
        "(pointless to force-copy an immutable value)",
    );
  }

  if (!frozen && !force && deep) {
    throw new Error(
      "`cloneIfNecessary()`: `{ frozen: false, force: false, deep: true }` is invalid " +
        "(ambiguous: mixed-frozenness trees have no clear shallow-thaw semantics)",
    );
  }

  return cloneHelper(value, frozen, deep, force) as T;
}

/**
 * Returns a fresh **mutable top-level** copy of a `FabricValue` whose every
 * bound child is guaranteed **deep-frozen**. This is the shape wanted by the
 * "mutate the top, then deep-freeze the whole" pattern: a caller can freely
 * write top-level properties/elements and then perform a single
 * `Object.freeze()` (or `deepFreeze()`) on the result to obtain a
 * fully-deep-frozen value, with no leftover mutable bits hiding underneath.
 *
 * Children are made safe via `cloneIfNecessary()` with its default
 * (deep-frozen) options, so already-deep-frozen children are identity-passed
 * (zero-copy) while mutable children are deep-cloned-and-frozen. The input is
 * never mutated: mutable children are cloned, not frozen in place.
 *
 * Inherently-immutable inputs (primitives, `FabricPrimitive`s) are returned
 * as-is, since there is no mutable top level to produce.
 *
 * Callers that need to preserve child identity / structural sharing (e.g. the
 * persistent-structure spine thaw used in patch application) should reach for
 * `cloneForMutation()` instead.
 *
 * **Type Validation Note:** This is built on `cloneIfNecessary()`, so the same
 * contract holds and the same checks are not made; see that function's note.
 *
 * @param value - An already-valid `FabricValue`.
 */
export function shallowMutableClone<T extends FabricValue>(
  value: T,
): T {
  // Deep-freeze-clone first (cloning only where needed, never mutating the
  // input, identity-passing already-deep-frozen subtrees), which makes every
  // child safely shareable; then shallow-thaw just the top container so the
  // immediate result is mutable while its children stay deep-frozen.
  const deepFrozen = cloneIfNecessary(value, { frozen: true });
  return cloneIfNecessary(deepFrozen, {
    frozen: false,
    deep: false,
    force: true,
  }) as T;
}

/**
 * Performs the unified clone for both shallow and deep modes.
 *
 * When `deep` is true, recursively clones containers and detects circular
 * references via `seen`. When `deep` is false, copies only the top-level
 * container (children are shared by reference).
 *
 * When `force` is false, returns the value as-is if its frozenness already
 * matches the requested state. When `force` is true, always copies (unless
 * the value is a primitive or a `FabricPrimitive`).
 *
 * Deep mode uses `isValidDeepFrozenFabricValue()` for identity optimization;
 * shallow mode uses `Object.isFrozen(value) === frozen`.
 *
 * This is exported for the package's own use -- `convertible-js.ts` calls it
 * -- and deliberately not re-exported from `index.ts`. Its five positional
 * parameters are the internal shape the named clone functions above are the
 * public spelling of; an outside caller wants one of those.
 *
 * **Type Validation Note:** This is the machinery behind `cloneIfNecessary()`,
 * so the same contract holds and the same checks are not made; see that
 * function's note.
 */
export function cloneHelper(
  value: FabricValue,
  frozen: boolean,
  deep: boolean,
  force: boolean,
  seen: Set<object> | null = null,
): FabricValue {
  // Identity optimization: when `force` is off, check if the value's frozenness
  // already matches the requested state. Deep mode uses
  // `isValidDeepFrozenFabricValue()`; shallow mode uses `Object.isFrozen(v) ===
  // frozen`.
  function canReturnAsIs(v: FabricValue): boolean {
    if (force) return false;
    if (deep) {
      if (frozen && isValidDeepFrozenFabricValue(v)) return true;
      if (!frozen && !Object.isFrozen(v)) return true;
      return false;
    }
    return Object.isFrozen(v) === frozen;
  }

  switch (tagOfConvertibleJsValueElseNull(value)) {
    // Inherently immutable types -- frozenness is irrelevant, no cloning
    // needed regardless of force.
    case VALUE_TAGS.bigint:
    case VALUE_TAGS.boolean:
    case VALUE_TAGS.null:
    case VALUE_TAGS.number:
    case VALUE_TAGS.string:
    case VALUE_TAGS.symbol:
    case VALUE_TAGS.undefined:
    case VALUE_TAGS.FabricEpochNsec:
    case VALUE_TAGS.FabricEpochDay:
    case VALUE_TAGS.FabricBytes:
    case VALUE_TAGS.FabricKeyPair:
    case VALUE_TAGS.FabricRegExp:
    case VALUE_TAGS.FabricHash:
    case VALUE_TAGS.FabricUnavailable:
      return value;

    case VALUE_TAGS.FabricInstance: {
      // Identity optimization: already-correct frozenness needs no clone.
      if (canReturnAsIs(value)) {
        return value;
      } else if (deep) {
        return (value as FabricInstance).deepClone(frozen);
      } else {
        return (value as FabricInstance).shallowClone(frozen);
      }
    }

    case VALUE_TAGS.Array: {
      if (canReturnAsIs(value)) return value;
      const arr = value as FabricValue[];
      if (deep) seen = trackForCircularity(arr, seen);
      const copy: FabricValue[] = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        if (i in arr) {
          copy[i] = deep
            ? cloneHelper(arr[i], frozen, deep, force, seen)
            : arr[i];
        }
      }
      if (deep) seen!.delete(arr);
      if (frozen) Object.freeze(copy);
      return copy;
    }

    case VALUE_TAGS.Object: {
      if (canReturnAsIs(value)) return value;
      const obj = value as object;
      if (deep) seen = trackForCircularity(obj, seen);
      const copy = {} as Record<string, FabricValue>;
      if (deep) {
        for (const [key, val] of Object.entries(obj)) {
          copy[key] = cloneHelper(
            val,
            frozen,
            deep,
            force,
            seen,
          );
        }
        seen!.delete(obj);
      } else {
        Object.assign(copy, value as Record<string, unknown>);
      }
      if (frozen) Object.freeze(copy);
      return copy;
    }

    default:
      // All valid `FabricValue` types are handled above.
      throw new Error(
        `Cannot clone: ${
          backtickQuote((value as object).constructor?.name ?? typeof value)
        }`,
      );
  }
}

/**
 * Categorical kinds of error that `cloneForMutation()` can fail with.
 *
 * - `"non-mutable-root"` — empty `path` and the root value isn't a kind for
 *   which a mutable handle exists (a primitive, a `FabricPrimitive`, etc.).
 * - `"non-container-root"` — non-empty `path` and the root isn't a plain object
 *   or array, so there's nothing to descend into.
 * - `"missing-segment"` — a `path` segment names a slot that doesn't exist on
 *   its container, and `createMissing` is `false`.
 * - `"non-container-descent"` — an intermediate segment lands on a value that
 *   isn't a plain object or array, so descent can't continue.
 * - `"non-mutable-leaf"` — the final segment lands on a value for which no
 *   mutable handle exists (a primitive or `FabricPrimitive`).
 */
export type CloneForMutationErrorKind =
  | "non-mutable-root"
  | "non-container-root"
  | "missing-segment"
  | "non-container-descent"
  | "non-mutable-leaf";

/**
 * Error thrown by `cloneForMutation()` when the input value or path is
 * unsuitable for producing a mutable handle. Carries structured fields so
 * the caller can preserve typed error info rather than parsing the
 * message.
 */
export class CloneForMutationError extends Error {
  /** Value for {@link #kind}. */
  readonly #kind: CloneForMutationErrorKind;

  /** Value for {@link #pathIndex}. */
  readonly #pathIndex: number;

  /** Value for {@link #valueKind}. */
  readonly #valueKind: string;

  /**
   * Constructs an instance describing one clone-for-mutation failure.
   *
   * @param kind - Categorical reason.
   * @param pathIndex - The path index at which the error occurred, or `-1`
   *   for a root-level error.
   * @param valueKind - Debug-string kind of the offending value.
   * @param message - What is wrong.
   */
  constructor(
    kind: CloneForMutationErrorKind,
    pathIndex: number,
    valueKind: string,
    message: string,
  ) {
    super(message);

    this.name = "CloneForMutationError";
    this.#kind = kind;
    this.#pathIndex = pathIndex;
    this.#valueKind = valueKind;
  }

  /** Categorical reason. See {@link CloneForMutationErrorKind}. */
  get kind(): CloneForMutationErrorKind {
    return this.#kind;
  }

  /**
   * The path index at which the error occurred, or `-1` for a root-level
   * error.
   */
  get pathIndex(): number {
    return this.#pathIndex;
  }

  /**
   * Debug-string kind of the offending value, matching
   * `toDebugKindString()`.
   */
  get valueKind(): string {
    return this.#valueKind;
  }
}

/** Options for `cloneForMutation()`. */
export interface CloneForMutationOptions {
  /**
   * Force fresh shallow copies of every spine container, even when the
   * input's containers are already mutable. Default: `true` -- matches
   * `cloneIfNecessary`'s default when `frozen: false` (which is what each
   * per-container thaw effectively requests).
   *
   * - `force: true` (default) — the caller's input is guaranteed to be left
   *   untouched. Every container along the spine -- including the root and
   *   the value at `path` -- is a fresh shallow copy.
   * - `force: false` — spine containers that are already mutable are reused
   *   by identity, and the helper may mutate the caller's input's spine
   *   slots in place when it needs to splice a freshly-thawed child into a
   *   mutable parent. Choose this when the caller owns the input outright.
   *
   * Mirrors `cloneIfNecessary`'s `force` semantics: this option is forwarded
   * verbatim to the per-container `cloneIfNecessary(_, { frozen: false,
   * deep: false, force })` calls that perform the actual shallow thaws.
   */
  force?: boolean;

  /**
   * Whether to create missing intermediate plain containers along `path` as
   * the helper descends. Default: `false` (throws `CloneForMutationError` with
   * kind `"missing-segment"` on the first missing slot).
   *
   * When `createMissing: true`, at each path step where the container at that
   * key is absent, the helper allocates a fresh plain container and splices it
   * into its parent before descending. Its shape (array vs. plain object) is
   * chosen from the NEXT segment that will be used as a key against it:
   *
   * - For intermediate path steps, the next segment is `path[i+1]`.
   * - For the final path step, the next segment is `nextKeyAfterPath` if
   *   supplied; otherwise the empty string (which selects a plain object).
   *
   * Array-index-shaped keys (`isArrayIndexPropertyName(key)`) and the
   * JSON-Pointer append marker `"-"` select an array; everything else selects a
   * plain object.
   */
  createMissing?: boolean;

  /**
   * Hint for the plain-container shape to create at the final path step when
   * it's missing and `createMissing: true`. Should be the next key the caller
   * intends to access against the value-at-path. Ignored when `createMissing:
   * false` or when the final path step already exists. Default: `""` (selects a
   * plain object).
   *
   * Same shape-selection rule as for intermediate steps: array-index-shaped
   * values (per `isArrayIndexPropertyName`) and the JSON-Pointer append marker
   * `"-"` select an array; everything else selects a plain object.
   *
   * Mirrors `v2-path.ensureParentContainers`'s `lastKey` parameter.
   */
  nextKeyAfterPath?: string;
}

/**
 * The shape returned by `cloneForMutation()`. See the function's doc comment
 * for the contract on each field.
 */
export interface CloneForMutationResult<T extends FabricValue> {
  /**
   * Replacement for the caller's input value, with the spine to `path` made
   * mutable. Identical to the input by reference iff no clone was necessary
   * (only possible when `force: false` and the input's spine was already
   * mutable throughout).
   */
  value: T;

  /**
   * The value at `path` in the result tree, guaranteed mutable. The caller
   * mutates this directly to perform their structured-mutation operation
   * (property set/delete, array push/splice/set-element, ...). For a plain
   * object or array at `path`, `pathValue` is a shallow-thawed copy whose
   * own children remain identity-shared with the input. For a
   * `FabricInstance` at `path`, `pathValue` is its `shallowClone(false)`.
   */
  pathValue: MutableFabricContainerValueLayer;
}

/**
 * Produces a view of `value` with the spine of containers along `path` made
 * mutable, so the caller can apply a structured mutation at `path` without
 * leaking changes back to the input. Subtrees off the spine retain their
 * identity (and their place in the deep-frozen cache) -- so a subsequent
 * `deepFreeze()` of the result tree short-circuits on every off-spine
 * subtree.
 *
 * Conceptually a copy-on-write descent: starting from the root, at each
 * step the next container along `path` is shallow-thawed (via
 * `cloneIfNecessary(_, { frozen: false, deep: false, force })`) and the
 * shallow clone is spliced into its (already-mutable) parent. The result
 * `pathValue` is the mutable container at the end of `path`.
 *
 * ### Mutation patterns supported via the returned `pathValue`
 *
 * - Object property add / set / delete: `pathValue.k = v`, and
 *   `delete pathValue.k`.
 * - Array set-element / push / splice / length: `pathValue[i] = v`,
 *   `pathValue.push(v)`, `pathValue.splice(i, n, ...add)`, and
 *   `pathValue.length = n`.
 * - "Replace the value at some slot": pass the parent's path as `path`,
 *   then assign through `pathValue[lastKey] = newValue`.
 *
 * ### Path semantics
 *
 * `path` is an array of pre-parsed segments (JSON-Pointer-style, but already
 * unescaped and split). Each segment is a property name for objects or an
 * array-index string for arrays. The helper descends through plain JS
 * objects and arrays; it does NOT descend into `FabricInstance` values
 * (those don't expose path-style member access in the current data model).
 * A `FabricInstance` is permitted as the final value at `path`, in which
 * case it's shallow-thawed via its own `shallowClone(false)` interface.
 *
 * ### Missing path segments
 *
 * By default (`createMissing: false`), missing segments throw a
 * `CloneForMutationError` with kind `"missing-segment"`. With
 * `createMissing: true`, the helper allocates fresh plain containers as it
 * descends through missing slots; see {@link CloneForMutationOptions} for
 * the shape-selection rules (in particular the `nextKeyAfterPath` hint).
 *
 * ### Errors
 *
 * Throws a `CloneForMutationError` (see {@link CloneForMutationErrorKind})
 * for unsuitable inputs or paths. Other unexpected errors (e.g. cycles in
 * the spine surfaced by the underlying `cloneIfNecessary` machinery)
 * propagate as plain `Error`s.
 *
 * **Type Validation Note:** `value` must honor the whole `FabricValue`
 * contract, which says more than its type does, and what this does with one
 * that does not is best-effort. The containers along the path are copied by
 * `cloneIfNecessary()`, so the checks that function does not make are not
 * made here either; see its note. Nor is `path` checked for a name this
 * runtime reserves, a check left, like the one on records, to the boundaries
 * where values enter or leave storage. With `createMissing`, a segment naming
 * `__proto__` is written through the prototype's accessor rather than as a
 * key, and what that does depends on the host.
 *
 * @param value - The input value tree.
 * @param path - Path to the container to expose as mutable.
 * @param options - See `CloneForMutationOptions`.
 */
export function cloneForMutation<T extends FabricValue>(
  value: T,
  path: readonly string[],
  options?: CloneForMutationOptions,
): CloneForMutationResult<T> {
  const force = options?.force ?? true;
  const createMissing = options?.createMissing ?? false;
  const nextKeyAfterPath = options?.nextKeyAfterPath ?? "";
  // Used for every per-container shallow thaw along the spine, and for the
  // final value-at-`path` thaw, whichever container arm that lands on. The
  // `frozen: false` overload returns the input type, so a thawed container
  // arrives here as the readonly view of itself; that is what the casts to
  // `MutableFabricContainerValueLayer` below correct.
  const cloneOpts = { frozen: false as const, deep: false as const, force };

  // Empty-path fast path
  if (path.length === 0) {
    // A non-container is a primitive or a `FabricPrimitive`, and neither has a
    // mutable handle to hand back.
    if (!isFabricContainerValue(value)) {
      throw new CloneForMutationError(
        "non-mutable-root",
        -1,
        toDebugKindString(value),
        `\`cloneForMutation()\`: cannot mutate ${
          backtickQuote(toDebugKindString(value))
        } at root ` +
          `(empty path)`,
      );
    }
    const newRoot = cloneIfNecessary(value, cloneOpts) as T;
    return {
      value: newRoot,
      pathValue: newRoot as MutableFabricContainerValueLayer,
    };
  }

  // Non-empty path: The root must be a plain container; descent through a
  // `FabricInstance` root would have nowhere to go (path-style access into
  // FabricInstance internals isn't supported).
  if (!isPlainContainer(value)) {
    throw new CloneForMutationError(
      "non-container-root",
      -1,
      toDebugKindString(value),
      `\`cloneForMutation()\`: cannot descend into ${
        backtickQuote(toDebugKindString(value))
      } at ` +
        `root (path has ${path.length} segment${path.length === 1 ? "" : "s"})`,
    );
  }

  const newRoot = cloneIfNecessary(value, cloneOpts) as T;
  // `current` is always a plain container at the top of each loop iteration:
  // we enter with `newRoot` (a plain container by the root check above) and
  // before descending we always type-check the next container.
  let current: MutableFabricArrayLayer | MutableFabricPlainObjectLayer =
    newRoot as MutableFabricArrayLayer | MutableFabricPlainObjectLayer;

  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const isLast = i === path.length - 1;

    let next: FabricValue;
    if (Object.hasOwn(current, key)) {
      next = (current as Record<string, FabricValue>)[key];
    } else if (createMissing) {
      // Allocate a fresh plain container at this slot. Its shape comes from
      // the next key that will be used against it: `path[i+1]` for
      // intermediate steps, `nextKeyAfterPath` for the final step.
      const nextKey = isLast ? nextKeyAfterPath : path[i + 1]!;
      const fresh = createMissingContainer(nextKey);
      (current as Record<string, FabricValue>)[key] = fresh;
      // `fresh` is freshly allocated and already mutable; skip the
      // shallow-thaw step below.
      if (isLast) return { value: newRoot, pathValue: fresh };
      current = fresh;
      continue;
    } else {
      throw new CloneForMutationError(
        "missing-segment",
        i,
        "undefined",
        `\`cloneForMutation()\`: missing path segment ${
          backtickQuote(key)
        } at ` +
          `index \`${i}\``,
      );
    }

    if (isLast) {
      // A non-container leaf has no mutable handle; see the root check above.
      if (!isFabricContainerValue(next)) {
        throw new CloneForMutationError(
          "non-mutable-leaf",
          i,
          toDebugKindString(next),
          `\`cloneForMutation()\`: cannot mutate ${
            backtickQuote(toDebugKindString(next))
          } at path ` +
            `index \`${i}\` (final segment)`,
        );
      }
    } else {
      if (!isPlainContainer(next)) {
        throw new CloneForMutationError(
          "non-container-descent",
          i,
          toDebugKindString(next),
          `\`cloneForMutation()\`: cannot descend into ${
            backtickQuote(toDebugKindString(next))
          } at ` +
            `path index \`${i}\``,
        );
      }
    }

    // Shallow-thaw the next spine container. Whichever container arm it is,
    // that is a `cloneIfNecessary(_, { frozen: false, deep: false, force })`
    // call; under `force: false` and an already-mutable input it
    // short-circuits to identity.
    const thawed = cloneIfNecessary(next, cloneOpts);
    if (thawed !== next) {
      (current as Record<string, FabricValue>)[key] = thawed;
    }

    if (isLast) {
      return {
        value: newRoot,
        pathValue: thawed as MutableFabricContainerValueLayer,
      };
    }

    // Type assertion safe: we type-checked `next` is a plain container,
    // and shallow-thaw preserves prototype, so `thawed` is also a plain
    // container.
    current = thawed as MutableFabricArrayLayer | MutableFabricPlainObjectLayer;
  }

  // Unreachable: the loop always returns on its final iteration when
  // `path.length > 0` (handled above for `path.length === 0`).
  /* c8 ignore next 3 */
  throw new Error("`cloneForMutation()`: unreachable");
}

/**
 * Allocates a fresh, mutable plain container of the right shape for
 * `nextKey`. Array-index-shaped keys (per `isArrayIndexPropertyName`) and the
 * JSON-Pointer append marker `"-"` produce an array; everything else
 * produces a plain object.
 */
function createMissingContainer(
  nextKey: string,
): MutableFabricArrayLayer | MutableFabricPlainObjectLayer {
  return isArrayIndexPropertyName(nextKey) || nextKey === "-" ? [] : {};
}

/**
 * Helper for the path-edit functions, which reads the child of `container` at
 * `key`. A `key` that isn't a canonical array index never addresses an array
 * element (so e.g. `length` or a non-canonical `08` reads as absent).
 */
const readChildAt = (
  container: Record<string, unknown> | unknown[],
  key: string,
): FabricValue => {
  if (Array.isArray(container) && !isArrayIndexPropertyName(key)) {
    return undefined;
  }
  return (container as Record<string, unknown>)[key] as FabricValue;
};

/**
 * Helper for the path-edit functions, which indicates whether `container` has
 * an own child at `key`. A `key` that isn't a canonical array index is never
 * an array element (excludes `length` and number-looking-but-non-canonical
 * names like `08`); `Object.hasOwn` then also treats sparse holes and
 * out-of-range indices as absent, so removing one is a no-op rather than a
 * shift-inducing splice.
 */
const hasChildAt = (
  container: Record<string, unknown> | unknown[],
  key: string,
): boolean => {
  if (Array.isArray(container) && !isArrayIndexPropertyName(key)) {
    return false;
  }
  return Object.hasOwn(container, key);
};

/**
 * Returns a deep-frozen clone of `root` with `value` set at `path`, creating
 * missing intermediate plain containers as needed (their array-vs-object
 * shape is chosen from the next path segment, per `cloneForMutation`'s
 * `createMissing`).
 * Subtrees off the mutated spine are shared by identity. An empty `path`
 * replaces the whole value.
 *
 * Like `cloneForMutation`, descent through a *present* value that is not a
 * plain container -- a primitive, or a `FabricInstance`/`FabricPrimitive` --
 * throws a `CloneForMutationError` rather than silently replacing that leaf
 * with fresh spine structure. That reaches the *parent* of `path` as well: a
 * `FabricInstance` there is a container but not one a key addresses, so it is
 * refused rather than given an own property. Cyclic values are not yet
 * supported (see `cloneIfNecessary`).
 *
 * **Type Validation Note:** `root` and `value` must honor the whole
 * `FabricValue` contract, which says more than their types do, and what this
 * does with either when it does not is best-effort. The containers along the
 * path, and `value` itself, are copied by `cloneIfNecessary()`, so the checks
 * that function does not make are not made here either; see its note. Nor is
 * `path` checked for a name this runtime reserves, a check left, like the one
 * on records, to the boundaries where values enter or leave storage. A
 * segment naming `__proto__` is written through the prototype's accessor
 * rather than as a key, and what that does depends on the host.
 */
export function cloneWithValueAtPath(
  root: FabricValue,
  path: readonly string[],
  value: FabricValue,
): FabricValue {
  if (path.length === 0) {
    return cloneIfNecessary(value);
  }
  const lastKey = path[path.length - 1]!;
  const { value: newRoot, pathValue } = cloneForMutation(
    root ?? {},
    path.slice(0, -1),
    { createMissing: true, nextKeyAfterPath: lastKey },
  );
  if (!isFabricPlainContainer(pathValue)) {
    // `cloneForMutation()` admits any container arm at the end of its path,
    // and a `FabricInstance` is one. `lastKey` means nothing against an
    // instance, whose state is private, so assigning through it would leave an
    // own property that no reading of the instance as a `FabricValue` sees.
    const pathIndex = path.length - 2;
    throw new CloneForMutationError(
      (pathIndex < 0) ? "non-container-root" : "non-container-descent",
      pathIndex,
      toDebugKindString(pathValue),
      `\`cloneWithValueAtPath()\`: cannot set ${backtickQuote(lastKey)} in ${
        backtickQuote(toDebugKindString(pathValue))
      }`,
    );
  }

  // A canonical array-index `lastKey` indexes (and extends) an array
  // `pathValue` directly; otherwise it's a plain object key.
  (pathValue as Record<string, FabricValue>)[lastKey] = cloneIfNecessary(value);
  return deepFreeze(newRoot);
}

/**
 * Returns a deep-frozen clone of `root` with the value at `path` removed
 * (object key deleted, or array element spliced out). Subtrees off the
 * mutated spine are shared by identity.
 *
 * When `path` is genuinely absent -- a missing key, an out-of-range array
 * index, or a non-plain-container (primitive / `FabricInstance` /
 * `FabricPrimitive`) anywhere along the way -- there is nothing to remove, so
 * a deep-frozen clone of `root` is returned (identity when `root` is already
 * deep-frozen). A `root` of `undefined` or empty `path` returns `undefined`
 * (whole-value removal). Cyclic values are not yet supported (see
 * `cloneIfNecessary`).
 *
 * **Type Validation Note:** `root` must honor the whole `FabricValue`
 * contract, which says more than its type does, and what this does with one
 * that does not is best-effort. The containers along the path are copied by
 * `cloneIfNecessary()`, so the checks that function does not make are not
 * made here either; see its note. Nor is `path` checked for a name this
 * runtime reserves, a check left, like the one on records, to the boundaries
 * where values enter or leave storage. A segment naming `__proto__` short of
 * the last is read through the prototype's accessor rather than as a key, and
 * what that does depends on the host: a browser's accessor hands back the
 * prototype, and the walk goes on into it.
 */
export function cloneWithoutValueAtPath(
  root: FabricValue,
  path: readonly string[],
): FabricValue {
  if (root === undefined || path.length === 0) {
    return undefined;
  }

  // Pre-walk: confirm the full path is reachable through plain containers and
  // the final slot is present. Anything else means "nothing to remove" -- and
  // gating on `isPlainContainer` (rather than a bare object check) is what
  // keeps us from descending into a `FabricInstance`/`FabricPrimitive`.
  let parent: FabricValue = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isPlainContainer(parent)) return cloneIfNecessary(root);
    const child = readChildAt(parent, path[i]!);
    if (child === undefined) return cloneIfNecessary(root);
    parent = child;
  }
  if (
    !isPlainContainer(parent) || !hasChildAt(parent, path[path.length - 1]!)
  ) {
    return cloneIfNecessary(root);
  }

  const { value: newRoot, pathValue } = cloneForMutation(
    root,
    path.slice(0, -1),
  );
  const lastKey = path[path.length - 1]!;
  if (Array.isArray(pathValue)) {
    pathValue.splice(Number(lastKey), 1);
  } else {
    delete (pathValue as Record<string, FabricValue>)[lastKey];
  }
  return deepFreeze(newRoot);
}
