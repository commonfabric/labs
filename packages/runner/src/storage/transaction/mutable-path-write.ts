/**
 * Mutate-in-place write primitives for `v2-transaction.ts`: shallow-thaw the
 * spine, create missing intermediates, mutate the leaf in place.
 *
 * The hot path is `applyMutablePathWrite()`. Sibling helpers
 * (`isContainerValue`, `getValueTypeName`, `applyArrayLengthWrite`) are
 * exposed for callers that need to do their own pre-flight inspection
 * (e.g. v2-transaction's `inspectPath` no-op short-circuits) without
 * pulling in the whole write helper.
 */

import {
  cloneForMutation,
  CloneForMutationError,
  type FabricValue,
  isFabricPlainContainer,
  toDebugKindString,
  valueEqual,
} from "@commonfabric/data-model";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import type {
  IInvalidArrayLengthError,
  IMemoryAddress,
  ITypeMismatchError,
  Result,
} from "../interface.ts";
import { TypeMismatchError } from "./attestation.ts";
import { InvalidArrayLengthError } from "../transaction-errors.ts";
import { createPathContainer, readValueAtPath } from "../v2-path.ts";

export type MutableWriteResult = {
  root: FabricValue | undefined;
  previousValue: FabricValue | undefined;
  changed: boolean;
};

export type MutablePathWriteOptions = {
  /**
   * When true, the write removes the slot at the address path — deleting an
   * object key or punching an array hole — instead of storing a value.
   * `value` is ignored (callers pass `undefined`). Without this flag,
   * writing `undefined` stores `undefined` as a real value:
   * present-but-undefined is distinct from absent.
   */
  delete?: boolean;
};

/**
 * Indicates whether a value is one a path key addresses -- an array or a plain
 * object. A `FabricInstance` is refused: it is a container, but it holds its
 * state privately, so reading `value[key]` off one finds an inherited member or
 * nothing, and writing one leaves an own property the instance never reports.
 */
export const isContainerValue = (
  value: FabricValue | undefined,
): value is Record<string, FabricValue> | FabricValue[] =>
  isFabricPlainContainer(value);

export const getValueTypeName = (value: FabricValue | undefined): string => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
};

/**
 * Applies a write at `address.path` within `currentRoot`, returning the
 * (possibly new) root, the previous value at the path, and whether
 * anything changed.
 *
 * Delegates spine descent + thaw + missing-intermediate creation to
 * `cloneForMutation` (with `createMissing: true`), which exposes the
 * parent container at `address.path.slice(0, -1)` as a mutable handle.
 * The function then performs the leaf write -- a property set on an
 * object, an element set on an array, or the legacy length-write
 * coercion when the parent is an array and the leaf key is `"length"`.
 * Subtrees off the spine are preserved by identity, so a subsequent
 * re-freeze short-circuits on everything except the freshly thawed
 * spine.
 *
 * A length write of a finite `2 ** 32` or more to an array is refused
 * with an `InvalidArrayLengthError`, decided before `cloneForMutation`
 * runs, so that refusal leaves `currentRoot` as it was, spine identities
 * included.
 *
 * Writing `undefined` stores `undefined` (present-but-undefined is a
 * real state, distinct from absent) and materializes missing
 * intermediates like any other value. Removal is requested explicitly
 * via `options.delete`, which deletes the leaf slot (object key removal
 * or array hole) and never materializes intermediates for a slot that
 * wasn't there. A delete with leaf key `"length"` funnels through the
 * legacy length coercion (undefined → NaN → truncate), matching the
 * historical `tx.write(path/length, undefined)` behavior.
 *
 * `force: false` is passed to `cloneForMutation` because the root, by
 * this point, is either (a) freshly allocated by us (in the
 * `undefined`-root branch) and thus owned outright, or (b) the caller's
 * value which by contract is treated as caller-owned within the
 * transaction.
 */
export const applyMutablePathWrite = (
  currentRoot: FabricValue | undefined,
  address: IMemoryAddress,
  value: FabricValue | undefined,
  options?: MutablePathWriteOptions,
): Result<
  MutableWriteResult,
  ITypeMismatchError | IInvalidArrayLengthError
> => {
  const isDelete = options?.delete === true;
  if (address.path.length === 0) {
    const nextRoot = isDelete ? undefined : value;
    return {
      ok: {
        root: nextRoot,
        previousValue: currentRoot,
        changed: !valueEqual(currentRoot, nextRoot),
      },
    };
  }

  if (currentRoot === undefined) {
    if (isDelete) {
      // Delete-of-nonexistent stays a no-op: don't materialize intermediates
      // just to remove a slot that wasn't there. A non-delete write — even of
      // `undefined` — materializes the path below.
      return {
        ok: {
          root: currentRoot,
          previousValue: undefined,
          changed: false,
        },
      };
    }
    currentRoot = createPathContainer(address.path[0]!);
  } else if (!isContainerValue(currentRoot)) {
    return {
      error: TypeMismatchError(
        { ...address, path: address.path.slice(0, 1) },
        getValueTypeName(currentRoot),
        "write",
      ),
    };
  }

  const leafKey = address.path[address.path.length - 1]!;
  const parentPath = address.path.slice(0, -1);

  // A length no array can have is refused here, reading `currentRoot` alone,
  // because `cloneForMutation()` below thaws the spine of a root the caller
  // owns in place: a refusal decided after it would leave that root edited.
  if (
    leafKey === "length" && !isDelete && isOutOfRangeArrayLength(value) &&
    Array.isArray(readValueAtPath(currentRoot, parentPath))
  ) {
    return { error: InvalidArrayLengthError(address, value) };
  }

  // Thaw the spine and create missing intermediates, all in one call.
  // The resulting `parent` is the mutable container at `parentPath` --
  // the slot whose `[leafKey]` we're about to write.
  let newRoot: FabricValue;
  let parent: Record<string, FabricValue> | FabricValue[];
  try {
    const result = cloneForMutation(currentRoot, parentPath, {
      createMissing: true,
      nextKeyAfterPath: leafKey,
      force: false,
    });
    newRoot = result.value;
    if (!isFabricPlainContainer(result.pathValue)) {
      // `cloneForMutation()` hands back any container arm at the end of its
      // path, and `leafKey` addresses none of them but the plain ones. The
      // offending value is at `parentPath`, whose last key is the one before
      // the leaf.
      return {
        error: TypeMismatchError(
          { ...address, path: parentPath },
          toDebugKindString(result.pathValue),
          "write",
        ),
      };
    }
    parent = result.pathValue as
      | Record<string, FabricValue>
      | FabricValue[];
  } catch (e) {
    if (e instanceof CloneForMutationError) {
      // The descent surfaced a type mismatch (or a non-container value
      // along the path); convert to the v2-transaction-shaped error.
      // `e.pathIndex` is the index within `parentPath`, which is the
      // same as the index within `address.path` (since `parentPath` is
      // a prefix). The slice end is `e.pathIndex + 1` to include the
      // offending key, matching `read`/`write`'s error-path semantics.
      return {
        error: TypeMismatchError(
          { ...address, path: address.path.slice(0, e.pathIndex + 1) },
          e.valueKind,
          "write",
        ),
      };
    }
    throw e;
  }

  // Leaf write at `parent[leafKey]`.
  if (Array.isArray(parent)) {
    if (leafKey === "length") {
      return applyArrayLengthWrite(newRoot, parent, value);
    }
    if (!isArrayIndexPropertyName(leafKey)) {
      return {
        error: TypeMismatchError(
          { ...address, path: address.path },
          "array",
          "write",
        ),
      };
    }
    const slot = Number(leafKey);
    const previousValue = parent[slot];
    if (isDelete) {
      if (!(slot in parent)) {
        return { ok: { root: newRoot, previousValue, changed: false } };
      }
      delete parent[slot];
      return { ok: { root: newRoot, previousValue, changed: true } };
    }
    // Presence-aware no-op detection: a hole and a stored `undefined` are
    // different states, so equal values only short-circuit when the slot
    // actually exists.
    if (slot in parent && valueEqual(previousValue, value)) {
      return { ok: { root: newRoot, previousValue, changed: false } };
    }
    parent[slot] = value;
    return { ok: { root: newRoot, previousValue, changed: true } };
  }

  // Object branch. Mirrors the array branch's presence-aware no-op detection
  // above, but presence on an object is an OWN-property question:
  // `Object.hasOwn`, not `in`. With `in`, a key named after an
  // `Object.prototype` member — `toString`, `valueOf`, `hasOwnProperty` — read
  // as present on every record, `previousValue` came back as the inherited
  // FUNCTION, and `valueEqual` then threw "Cannot compare a function value".
  // Writing a property with one of those perfectly legal names failed outright.
  // (`__proto__`/`constructor` are refused upstream by #5264; these are not,
  // and are ordinary data keys.)
  const obj = parent as Record<string, FabricValue>;
  const hasOwnLeaf = Object.hasOwn(obj, leafKey);
  // Absent means absent: without the guard this is the prototype's member.
  const previousValue = hasOwnLeaf ? obj[leafKey] : undefined;
  if (isDelete) {
    if (!hasOwnLeaf) {
      return { ok: { root: newRoot, previousValue, changed: false } };
    }
    delete obj[leafKey];
    return { ok: { root: newRoot, previousValue, changed: true } };
  }
  if (hasOwnLeaf && valueEqual(previousValue, value)) {
    return { ok: { root: newRoot, previousValue, changed: false } };
  }
  obj[leafKey] = value;
  return { ok: { root: newRoot, previousValue, changed: true } };
};

/**
 * Indicates whether `value`, written as an array's `length`, is a number no
 * array can have: a finite `2 ** 32` or more. `+Infinity` is not one, since the
 * length coercion leaves the array unchanged for it.
 */
const isOutOfRangeArrayLength = (
  value: FabricValue | undefined,
): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 2 ** 32;

/**
 * Helper for the legacy array-length-write semantics, called when
 * `applyMutablePathWrite` reaches a leaf key of `"length"` against an
 * array parent. Replicates `Array.prototype.slice(0, nextLength)`'s
 * coercion rules for truncation (NaN → 0, +Infinity → unchanged,
 * −Infinity → 0, negative → count from end, fractional → floor). Grow
 * with holes uses the JS native semantic of `arr.length = nextLength`
 * (with `Math.floor` to keep length an integer). A length that assignment
 * would throw on is one `isOutOfRangeArrayLength()` admits, and
 * `applyMutablePathWrite` refuses it before calling this.
 */
const applyArrayLengthWrite = (
  newRoot: FabricValue,
  parent: FabricValue[],
  value: FabricValue | undefined,
): Result<MutableWriteResult, ITypeMismatchError> => {
  const previousValue = parent.length;
  if (valueEqual(previousValue, value)) {
    return { ok: { root: newRoot, previousValue, changed: false } };
  }
  // Funnel non-numbers (and `undefined`, which arises from
  // `tx.write(path/length, undefined)`) through the existing NaN
  // handling branch -- otherwise `Math.floor(nonNumber)` would yield
  // `NaN` and `parent.length = NaN` would throw `RangeError`.
  const nextLength = typeof value === "number" ? value : NaN;
  if (
    nextLength < previousValue || nextLength < 0 ||
    !Number.isFinite(nextLength)
  ) {
    let effective: number;
    if (Number.isNaN(nextLength)) {
      effective = 0;
    } else if (nextLength === Number.POSITIVE_INFINITY) {
      effective = previousValue;
    } else if (nextLength === Number.NEGATIVE_INFINITY) {
      effective = 0;
    } else if (nextLength < 0) {
      effective = Math.max(0, previousValue + Math.floor(nextLength));
    } else {
      effective = Math.min(previousValue, Math.floor(nextLength));
    }
    parent.length = effective;
  } else {
    parent.length = Math.floor(nextLength);
  }
  // The coercion paths above (`+Infinity → previousValue`, NaN→0 when
  // previousValue is already 0, etc.) can leave the array's `.length`
  // unchanged even when `value !== previousValue`; report the change
  // status against the post-mutation length rather than asserting
  // `true` unconditionally.
  return {
    ok: {
      root: newRoot,
      previousValue,
      changed: parent.length !== previousValue,
    },
  };
};
