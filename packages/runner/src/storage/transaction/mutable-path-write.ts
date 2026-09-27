/**
 * Plan-then-apply write primitives for `v2-transaction.ts`. A write is first
 * planned, which decides whether it is refused and reports what it finds,
 * reading the root and changing nothing; the plan then carries it out,
 * shallow-thawing the spine, creating missing intermediates, and mutating the
 * leaf in place.
 *
 * The plan decides from a trace of the path (`tracePath()`), the same facts
 * `cloneForMutation()` decides its own errors from, and carrying a plan out
 * has no error in its type. So a refusal cannot follow a mutation, and a
 * refused write leaves a root the caller mutates in place exactly as it was.
 */

import {
  cloneForMutation,
  cloneIfNecessary,
  type FabricValue,
  isFabricPlainContainer,
  missingContainerIsArray,
  type PathTrace,
  toDebugKindString,
  tracePath,
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

/** An error a write is refused with. */
export type MutablePathWriteError =
  | ITypeMismatchError
  | IInvalidArrayLengthError;

/**
 * A write `planMutablePathWrite()` admitted: what the write finds before it
 * changes anything, and the means to carry it out.
 */
export interface PlannedPathWrite {
  /**
   * Whether the slot at the address path is there before the write. For the
   * empty path, whether the root is defined.
   */
  readonly present: boolean;

  /** The value at the address path before the write, where `present`. */
  readonly previousValue: FabricValue | undefined;

  /**
   * Where a write that creates missing containers first changes the
   * document: the path of the deepest container already there, or the empty
   * path where the write creates the root. `undefined` for a write whose
   * parent is already there, and for every delete.
   */
  readonly materializedAt: readonly string[] | undefined;

  /**
   * The value at `materializedAt` before the write: the container there, or
   * `undefined` where the write creates the root.
   */
  readonly materializedValue: FabricValue | undefined;

  /**
   * Carries the write out, storing an isolated copy of the value planned.
   * The root it was planned against must be unchanged since, and is mutated
   * in place where it is already mutable. A delete with nothing to remove
   * returns that root unchanged.
   */
  apply(): MutableWriteResult;
}

/**
 * Decides whether a write at `address.path` within `root` is refused, and
 * reports what the write finds, reading `root` and changing nothing. A write
 * it admits is carried out by the plan's `apply()`, which stores `value`.
 *
 * A write of a value is refused with a `TypeMismatchError` naming the path
 * through the offending key where a key lands in a container that cannot hold
 * it -- an array takes an index or `length` and no other key, whether it is
 * already there or is one the write would create -- or where the path goes on
 * past a value that is not an array or a plain object. A `length` written onto
 * an array already there is refused with an `InvalidArrayLengthError` where no
 * array can have it (`isOutOfRangeArrayLength()`). A delete is never refused:
 * a slot the path does not reach has nothing in it to remove.
 *
 * Writing `undefined` stores `undefined` (present-but-undefined is a real
 * state, distinct from absent) and creates missing containers like any other
 * value. Each container a write creates, a missing root included, is shaped
 * by the key that goes on to address it, as `missingContainerIsArray()`
 * decides.
 */
export const planMutablePathWrite = (
  root: FabricValue | undefined,
  address: IMemoryAddress,
  value: FabricValue | undefined,
  options?: MutablePathWriteOptions,
): Result<PlannedPathWrite, MutablePathWriteError> => {
  const isDelete = options?.delete === true;
  const path = address.path;
  if (path.length === 0) {
    return {
      ok: new Plan(root, address, value, isDelete, root !== undefined, root),
    };
  }

  let trace: PathTrace | undefined;
  if (root === undefined) {
    trace = undefined;
  } else if (isContainerValue(root)) {
    trace = tracePath(root, path);
  } else if (isDelete) {
    return { ok: new Plan(root, address, value, isDelete, false, undefined) };
  } else {
    return {
      error: TypeMismatchError(
        { ...address, path: path.slice(0, 1) },
        getValueTypeName(root),
        "write",
      ),
    };
  }

  const previousValue = trace?.end === "complete" ? trace.value : undefined;
  const present = trace?.end === "complete";
  if (isDelete) {
    return {
      ok: new Plan(root, address, value, isDelete, present, previousValue),
    };
  }

  const refusal = refusalOf(trace, address, value);
  if (refusal !== undefined) {
    return { error: refusal };
  }

  // A missing slot short of the leaf is where the write first changes the
  // document; one at the leaf is an ordinary write into a parent already
  // there.
  let materializedAt: readonly string[] | undefined;
  let materializedValue: FabricValue | undefined;
  if (trace === undefined) {
    materializedAt = [];
  } else if (trace.end === "missing" && trace.at < path.length - 1) {
    materializedAt = path.slice(0, trace.at);
    materializedValue = trace.containers[trace.at];
  }
  return {
    ok: new Plan(
      root,
      address,
      value,
      isDelete,
      present,
      previousValue,
      materializedAt,
      materializedValue,
    ),
  };
};

/**
 * Indicates whether a value is one a path key addresses -- an array or a plain
 * object. A `FabricInstance` is refused: it is a container, but it holds its
 * state privately, so reading `value[key]` off one finds an inherited member or
 * nothing, and writing one leaves an own property the instance never reports.
 */
const isContainerValue = (
  value: FabricValue | undefined,
): value is Record<string, FabricValue> | FabricValue[] =>
  isFabricPlainContainer(value);

/** Names the kind of a value a write cannot descend into, for its error. */
const getValueTypeName = (value: FabricValue | undefined): string => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
};

/**
 * Helper for `planMutablePathWrite()`, which returns the error a write of
 * `value` along `trace` is refused with, or `undefined` where it is admitted.
 * `trace` is `undefined` where the write creates the root.
 */
const refusalOf = (
  trace: PathTrace | undefined,
  address: IMemoryAddress,
  value: FabricValue | undefined,
): MutablePathWriteError | undefined => {
  const path = address.path;
  const containers = trace?.containers ?? [];
  // Keys from this index on land in containers the write creates: every key
  // where the write creates the root, and those past a missing slot.
  const firstCreated = trace === undefined
    ? 0
    : trace.end === "missing"
    ? trace.at + 1
    : path.length;
  for (let index = 0; index < path.length; index++) {
    const key = path[index]!;
    const inArray = index < firstCreated
      ? Array.isArray(containers[index])
      : missingContainerIsArray(key);
    if (inArray && key !== "length" && !isArrayIndexPropertyName(key)) {
      return TypeMismatchError(
        { ...address, path: path.slice(0, index + 1) },
        "array",
        "write",
      );
    }
    if (trace?.end === "blocked" && index === trace.at - 1) {
      // `path[index]` leads to a value no key addresses, and the path goes on.
      return TypeMismatchError(
        { ...address, path: path.slice(0, trace.at) },
        toDebugKindString(trace.value),
        "write",
      );
    }
    if (
      index === path.length - 1 && key === "length" && inArray &&
      index < firstCreated && typeof value === "number" &&
      isOutOfRangeArrayLength(value)
    ) {
      return InvalidArrayLengthError(address, value);
    }
  }
  return undefined;
};

/**
 * Indicates whether `value`, written as an array's `length`, is one the
 * length coercion would grow the array to but no array can have: a finite
 * `2 ** 32` or more. `+Infinity` is not one, since the coercion leaves the
 * array unchanged for it.
 */
const isOutOfRangeArrayLength = (value: number): boolean =>
  Number.isFinite(value) && value >= 2 ** 32;

/** The plan `planMutablePathWrite()` returns. */
class Plan implements PlannedPathWrite {
  readonly present: boolean;
  readonly previousValue: FabricValue | undefined;
  readonly materializedAt: readonly string[] | undefined;
  readonly materializedValue: FabricValue | undefined;
  readonly #root: FabricValue | undefined;
  readonly #address: IMemoryAddress;
  readonly #value: FabricValue | undefined;
  readonly #isDelete: boolean;

  /** Constructs an instance holding what the planning found. */
  constructor(
    root: FabricValue | undefined,
    address: IMemoryAddress,
    value: FabricValue | undefined,
    isDelete: boolean,
    present: boolean,
    previousValue: FabricValue | undefined,
    materializedAt?: readonly string[],
    materializedValue?: FabricValue,
  ) {
    this.present = present;
    this.previousValue = previousValue;
    this.materializedAt = materializedAt;
    this.materializedValue = materializedValue;
    this.#root = root;
    this.#address = address;
    this.#value = value;
    this.#isDelete = isDelete;
  }

  /** @inheritDoc */
  apply(): MutableWriteResult {
    const path = this.#address.path;
    const value = this.#isDelete || this.#value === undefined
      ? undefined
      : cloneIfNecessary(this.#value);
    if (path.length === 0) {
      return {
        root: value,
        previousValue: this.#root,
        changed: !valueEqual(this.#root, value),
      };
    }
    if (this.#isDelete && !this.present) {
      return { root: this.#root, previousValue: undefined, changed: false };
    }

    const leafKey = path[path.length - 1]!;
    // A write the plan admitted never reaches a root that is defined but not
    // a container, so a root still missing here is one to create.
    const root = this.#root === undefined
      ? (missingContainerIsArray(path[0]!) ? [] : {})
      : this.#root;
    // `cloneForMutation()` decides its errors from the same trace the plan
    // refused by, over the same unchanged root, so it throws on nothing the
    // plan admitted, and what it returns at the parent path is an array or a
    // plain object.
    const { value: newRoot, pathValue } = cloneForMutation(
      root,
      path.slice(0, -1),
      { createMissing: true, nextKeyAfterPath: leafKey, force: false },
    );
    const parent = pathValue as Record<string, FabricValue> | FabricValue[];

    // Leaf write at `parent[leafKey]`.
    if (Array.isArray(parent)) {
      if (leafKey === "length") {
        return applyArrayLengthWrite(
          newRoot,
          parent,
          value,
        );
      }
      // The plan admits no other key into an array than an index.
      const slot = Number(leafKey);
      const previousValue = parent[slot];
      if (this.#isDelete) {
        if (!(slot in parent)) {
          return { root: newRoot, previousValue, changed: false };
        }
        delete parent[slot];
        return { root: newRoot, previousValue, changed: true };
      }
      // Presence-aware no-op detection: a hole and a stored `undefined` are
      // different states, so equal values only short-circuit when the slot
      // actually exists.
      if (slot in parent && valueEqual(previousValue, value)) {
        return { root: newRoot, previousValue, changed: false };
      }
      parent[slot] = value;
      return { root: newRoot, previousValue, changed: true };
    }

    // Object branch. Mirrors the array branch's presence-aware no-op
    // detection above, but presence on an object is an own-property question,
    // `Object.hasOwn()` rather than `in`: with `in`, a key named after an
    // `Object.prototype` member -- `toString`, `valueOf`, `hasOwnProperty` --
    // reads as present on every record, and `previousValue` is the inherited
    // function, which `valueEqual()` throws on.
    const obj = parent as Record<string, FabricValue>;
    const hasOwnLeaf = Object.hasOwn(obj, leafKey);
    // Absent means absent: without the guard this is the prototype's member.
    const previousValue = hasOwnLeaf ? obj[leafKey] : undefined;
    if (this.#isDelete) {
      if (!hasOwnLeaf) {
        return { root: newRoot, previousValue, changed: false };
      }
      delete obj[leafKey];
      return { root: newRoot, previousValue, changed: true };
    }
    if (hasOwnLeaf && valueEqual(previousValue, value)) {
      return { root: newRoot, previousValue, changed: false };
    }
    obj[leafKey] = value;
    return { root: newRoot, previousValue, changed: true };
  }
}

/**
 * Helper for the legacy array-length-write semantics, called when
 * `PlannedPathWrite.apply()` reaches a leaf key of `"length"` against an
 * array parent. Replicates `Array.prototype.slice(0, nextLength)`'s
 * coercion rules for truncation (NaN → 0, +Infinity → unchanged,
 * −Infinity → 0, negative → count from end, fractional → floor). Grow
 * with holes uses the JS native semantic of `arr.length = nextLength`
 * (with `Math.floor` to keep length an integer). A length that assignment
 * would throw on is one `isOutOfRangeArrayLength()` returns `true` for, and
 * `planMutablePathWrite()` refuses it before this is reached.
 */
const applyArrayLengthWrite = (
  newRoot: FabricValue,
  parent: FabricValue[],
  value: FabricValue | undefined,
): MutableWriteResult => {
  const previousValue = parent.length;
  if (valueEqual(previousValue, value)) {
    return { root: newRoot, previousValue, changed: false };
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
    root: newRoot,
    previousValue,
    changed: parent.length !== previousValue,
  };
};
