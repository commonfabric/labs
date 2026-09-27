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
  debugStr,
  type FabricValue,
  isFabricPlainContainer,
  missingContainerIsArray,
  toDebugKindString,
  valueEqual,
} from "@commonfabric/data-model";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import type {
  IMemoryAddress,
  ITypeMismatchError,
  Result,
} from "../interface.ts";
import { TypeMismatchError } from "./attestation.ts";
import { createPathContainer } from "../v2-path.ts";

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
 * Whether the write is refused is settled first, by `checkWritePath()`,
 * which reads `currentRoot` and changes nothing. A write it admits goes to
 * `cloneForMutation` (with `createMissing: true`) for spine descent, thaw,
 * and missing-intermediate creation, which exposes the parent container at
 * `address.path.slice(0, -1)` as a mutable handle. The function then
 * performs the leaf write -- a property set on an object, an element set
 * on an array, or the legacy length-write coercion when the parent is an
 * array and the leaf key is `"length"`. Subtrees off the spine are
 * preserved by identity, so a subsequent re-freeze short-circuits on
 * everything except the freshly thawed spine.
 *
 * A refused write therefore leaves `currentRoot` exactly as it was, spine
 * identities included. That is what lets a caller hand in a root it
 * mutates in place and keep it after an error.
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
): Result<MutableWriteResult, ITypeMismatchError> => {
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

  // Both branches above leave a plain container here: one freshly made, or
  // one `isContainerValue()` admitted.
  const check = checkWritePath(
    currentRoot as Record<string, FabricValue> | FabricValue[],
    address,
    isDelete,
  );
  if (check.error) {
    return { error: check.error };
  }
  if (check.ok === "absent") {
    return {
      ok: { root: currentRoot, previousValue: undefined, changed: false },
    };
  }

  const leafKey = address.path[address.path.length - 1]!;

  // Thaw the spine and create missing intermediates, all in one call. The
  // check above refuses every path this call would throw on, and every
  // parent but a plain container, so what comes back is the mutable plain
  // container at the parent path -- the slot whose `[leafKey]` we're about
  // to write.
  const { value: newRoot, pathValue } = cloneForMutation(
    currentRoot,
    address.path.slice(0, -1),
    { createMissing: true, nextKeyAfterPath: leafKey, force: false },
  );
  const parent = pathValue as Record<string, FabricValue> | FabricValue[];

  // Leaf write at `parent[leafKey]`.
  if (Array.isArray(parent)) {
    if (leafKey === "length") {
      return applyArrayLengthWrite(newRoot, parent, value);
    }
    // deno-coverage-ignore-start -- the check admits only an index here
    if (!isArrayIndexPropertyName(leafKey)) {
      // Reaching this means the check and `cloneForMutation()` disagree on
      // the shape of the parent. Going on would write `parent[NaN]`, a slot
      // no read reports and no commit carries, so this fails loudly instead.
      throw new Error(
        debugStr`The key $quote${leafKey} passed the write check, but its parent is an array`,
      );
    }
    // deno-coverage-ignore-stop
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
 * Helper for `applyMutablePathWrite()`, which decides whether the write to
 * `address` within `root` is refused, reading `root` and changing nothing.
 * Returns `apply` where the write goes ahead, and `absent` for a delete whose
 * path passes a missing slot, which leaves it nothing to remove.
 *
 * Each key is checked against the container that holds it once the write's
 * missing intermediates exist: the one already there, or the one
 * `cloneForMutation()` creates, which is an array exactly when
 * `missingContainerIsArray()` says so of the key addressing it. An array
 * takes an index or `length` and no other key, since any other slot on one
 * is a value that no path read reports and no commit carries. A key short of
 * the leaf that lands on anything but a plain container is refused too,
 * `length` on an array included. Either way, the error names the path
 * through the offending key.
 *
 * The descent admits only what `isContainerValue()` does, which is narrower
 * than what `cloneForMutation()` descends through, so every path that
 * function throws on is refused here first.
 */
const checkWritePath = (
  root: Record<string, FabricValue> | FabricValue[],
  address: IMemoryAddress,
  isDelete: boolean,
): Result<"apply" | "absent", ITypeMismatchError> => {
  const path = address.path;
  // `undefined` once the walk has passed a missing slot: every container from
  // there down is one the write creates.
  let container: Record<string, FabricValue> | FabricValue[] | undefined = root;
  for (let index = 0; index < path.length; index++) {
    const key = path[index]!;
    const inArray = container === undefined
      ? missingContainerIsArray(key)
      : Array.isArray(container);
    if (inArray && key !== "length" && !isArrayIndexPropertyName(key)) {
      return {
        error: TypeMismatchError(
          { ...address, path: path.slice(0, index + 1) },
          "array",
          "write",
        ),
      };
    }
    if (container === undefined || index === path.length - 1) {
      continue;
    }
    if (!Object.hasOwn(container, key)) {
      if (isDelete) {
        return { ok: "absent" };
      }
      container = undefined;
      continue;
    }
    const next: FabricValue = (container as Record<string, FabricValue>)[key];
    if (!isContainerValue(next)) {
      return {
        error: TypeMismatchError(
          { ...address, path: path.slice(0, index + 1) },
          toDebugKindString(next),
          "write",
        ),
      };
    }
    container = next;
  }
  return { ok: "apply" };
};

/**
 * Helper for the legacy array-length-write semantics, called when
 * `applyMutablePathWrite` reaches a leaf key of `"length"` against an
 * array parent. Replicates `Array.prototype.slice(0, nextLength)`'s
 * coercion rules for truncation (NaN → 0, +Infinity → unchanged,
 * −Infinity → 0, negative → count from end, fractional → floor). Grow
 * with holes uses the JS native semantic of `arr.length = nextLength`
 * (with `Math.floor` to keep length a uint32).
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
