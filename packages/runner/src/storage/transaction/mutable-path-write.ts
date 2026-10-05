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
  debugStr,
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

/** What carrying out a planned write did. */
export type MutableWriteResult = {
  /**
   * The root after the write: the one planned against, changed in place where
   * it was already mutable, or its replacement.
   */
  root: FabricValue | undefined;

  /** Whether the write changed anything. */
  changed: boolean;

  /**
   * Where the write first changes the document: the address path, or, for a
   * write that creates missing containers, the path of the deepest container
   * already there -- the empty path where the write creates the root.
   */
  activityPath: readonly string[];

  /**
   * An isolated copy of the value at `activityPath` as it was before the
   * write, taken before anything changed.
   */
  previousActivityValue: FabricValue | undefined;

  /** Whether a value was at `activityPath` before the write. */
  previousActivityPresent: boolean;
};

/** Options for `planMutablePathWrite()`. */
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
   * Carries the write out, storing an isolated copy of the value planned, on
   * the root it was planned against. That root is changed in place where it
   * is already mutable. A delete with nothing to remove returns it unchanged.
   *
   * A plan is carried out at most once, and only while the root is as it was
   * planned against: any change to it, another plan's `apply()` included,
   * leaves every plan taken before it stale, so a caller plans each write
   * against the root as it stands. A second `apply()` throws before anything
   * changes. A stale plan is not otherwise detected; one that finds its parent
   * an array where it planned a key other than an index throws rather than
   * writing that key, though not before the spine is thawed.
   *
   * No refusal can come from here. Otherwise it throws only where
   * `cloneIfNecessary()` refuses the value it isolates -- the value planned,
   * or the one it reports as `previousActivityValue` -- which is one outside
   * the `FabricValue` contract, and before anything is changed.
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
 * a slot the path does not reach has nothing in it to remove. A delete of an
 * array's `length` empties the array, whatever value the call carries.
 *
 * Those refusals are exact for a `root` that honors the `FabricValue`
 * contract. Past it the answer is best-effort: an array carrying a key other
 * than an index, which no stored value can, may admit a write beneath that
 * key.
 *
 * Writing `undefined` stores `undefined` (present-but-undefined is a real
 * state, distinct from absent) and creates missing containers like any other
 * value. A container the write creates beneath the root is shaped by the key
 * that goes on to address it, as `missingContainerIsArray()` decides; a root
 * it creates, as `createdRootIsArray()` does.
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
    return { ok: new Plan(root, address, value, isDelete, undefined) };
  }

  let trace: PathTrace | undefined;
  if (root === undefined) {
    trace = undefined;
  } else if (isContainerValue(root)) {
    trace = tracePath(root, path);
  } else if (isDelete) {
    return { ok: new Plan(root, address, value, isDelete, undefined) };
  } else {
    return {
      error: TypeMismatchError(
        { ...address, path: path.slice(0, 1) },
        getValueTypeName(root),
        "write",
      ),
    };
  }

  if (!isDelete) {
    const refusal = refusalOf(trace, address, value);
    if (refusal !== undefined) {
      return { error: refusal };
    }
  }
  return { ok: new Plan(root, address, value, isDelete, trace) };
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

/** Names the kind of a root a write cannot descend into, for its error. */
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
 * Indicates whether the root a write creates is an array, given `firstKey`,
 * the key that goes on to address it: where that key is an index. Unlike a
 * container created beneath the root (`missingContainerIsArray()`), the root
 * is not an array for `-`, which is a plain key of a fresh root, as it is of
 * any record already there.
 */
const createdRootIsArray = (firstKey: string): boolean =>
  isArrayIndexPropertyName(firstKey);

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
  if (trace?.end === "complete") {
    // Every key names a slot its container holds, which in an array that
    // honors the `FabricValue` contract is an index or `length`; a `length`
    // short of the leaf leads to a number, and would have ended the trace.
    // So only the leaf's length can be refused.
    const leaf = path.length - 1;
    return path[leaf] === "length" && Array.isArray(containers[leaf]) &&
        typeof value === "number" && isOutOfRangeArrayLength(value)
      ? InvalidArrayLengthError(address, value)
      : undefined;
  }
  // `containers[index]` holds `path[index]` below this index; from it on,
  // each key lands in a container the write creates.
  const firstCreated = trace?.end === "missing"
    ? trace.at + 1
    : containers.length;
  for (let index = 0; index < path.length; index++) {
    const key = path[index]!;
    const inArray = index < firstCreated
      ? Array.isArray(containers[index])
      : trace === undefined && index === 0
      ? createdRootIsArray(key)
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
  }
  // The leaf's length bound is checked above: a leaf `length` in an array
  // already there leaves the trace complete, and a created container is
  // never an array for `length`.
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

/**
 * The plan `planMutablePathWrite()` returns, which reads what it reports off
 * the trace of the path it was planned along.
 */
class Plan implements PlannedPathWrite {
  readonly #root: FabricValue | undefined;
  readonly #address: IMemoryAddress;
  readonly #value: FabricValue | undefined;
  readonly #isDelete: boolean;
  // `undefined` for the empty path, a missing root, and a delete beneath a
  // root that is not a container.
  readonly #trace: PathTrace | undefined;
  #applied = false;

  /**
   * Constructs an instance which writes `value`, or deletes, at
   * `address.path` within `root`, as `trace` found that path.
   */
  constructor(
    root: FabricValue | undefined,
    address: IMemoryAddress,
    value: FabricValue | undefined,
    isDelete: boolean,
    trace: PathTrace | undefined,
  ) {
    this.#root = root;
    this.#address = address;
    this.#value = value;
    this.#isDelete = isDelete;
    this.#trace = trace;
  }

  /** @inheritDoc */
  get present(): boolean {
    return this.#address.path.length === 0
      ? this.#root !== undefined
      : this.#trace?.end === "complete";
  }

  /** @inheritDoc */
  get previousValue(): FabricValue | undefined {
    if (this.#address.path.length === 0) return this.#root;
    return this.#trace?.end === "complete" ? this.#trace.value : undefined;
  }

  /** @inheritDoc */
  apply(): MutableWriteResult {
    if (this.#applied) {
      throw new Error("A planned write is carried out at most once");
    }
    this.#applied = true;
    const value = this.#isDelete || this.#value === undefined
      ? undefined
      : cloneIfNecessary(this.#value);
    // Read before the write below, which changes the root -- and with it the
    // container the write first changes -- in place where it is mutable.
    const { path } = this.#address;
    const trace = this.#trace;
    let activityPath = path;
    let previousActivityValue = this.previousValue;
    let previousActivityPresent = this.present;
    if (!this.#isDelete && path.length > 0) {
      if (this.#root === undefined) {
        // The write creates the root, so that is where it first shows.
        activityPath = [];
        previousActivityValue = undefined;
        previousActivityPresent = false;
      } else if (trace?.end === "missing" && trace.at < path.length - 1) {
        // A missing slot short of the leaf: the write first shows in the
        // deepest container already there, which it creates the slot in.
        activityPath = path.slice(0, trace.at);
        previousActivityValue = trace.containers[trace.at];
        previousActivityPresent = true;
      }
    }
    // Isolated now, while it is still the value from before the write.
    const previousActivityCopy = cloneIfNecessary(previousActivityValue) as
      | FabricValue
      | undefined;
    const { root, changed } = this.#write(value);
    return {
      root,
      changed,
      activityPath,
      previousActivityValue: previousActivityCopy,
      previousActivityPresent,
    };
  }

  /**
   * Helper for `apply()`, which writes `value` -- already isolated, and
   * `undefined` for a delete -- and returns the root it leaves.
   */
  #write(
    value: FabricValue | undefined,
  ): { root: FabricValue | undefined; changed: boolean } {
    const path = this.#address.path;
    if (path.length === 0) {
      return { root: value, changed: !valueEqual(this.#root, value) };
    }
    if (this.#isDelete && !this.present) {
      return { root: this.#root, changed: false };
    }

    const leafKey = path[path.length - 1]!;
    // A write the plan admitted never reaches a root that is defined but not
    // a container, so a root still missing here is one to create.
    const root = this.#root === undefined
      ? (createdRootIsArray(path[0]!) ? [] : {})
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

    // Leaf write at `parent[leafKey]`. A delete reaches here only for a slot
    // that is there.
    if (Array.isArray(parent)) {
      if (leafKey === "length") {
        return applyArrayLengthWrite(newRoot, parent, value);
      }
      if (!isArrayIndexPropertyName(leafKey)) {
        // Planned against a root that has changed since: the parent it
        // planned for is an array now. Going on would write `parent[NaN]`.
        throw new Error(
          debugStr`A stale plan reached an array with the key $quote${leafKey}`,
        );
      }
      const slot = Number(leafKey);
      if (this.#isDelete) {
        delete parent[slot];
        return { root: newRoot, changed: true };
      }
      // Presence-aware no-op detection: a hole and a stored `undefined` are
      // different states, so equal values only short-circuit when the slot
      // actually exists.
      if (slot in parent && valueEqual(parent[slot], value)) {
        return { root: newRoot, changed: false };
      }
      parent[slot] = value;
      return { root: newRoot, changed: true };
    }

    // Object branch. Mirrors the array branch's presence-aware no-op
    // detection above, but presence on an object is an own-property question,
    // `Object.hasOwn()` rather than `in`: with `in`, a key named after an
    // `Object.prototype` member -- `toString`, `valueOf`, `hasOwnProperty` --
    // reads as present on every record, and the value read is the inherited
    // function, which `valueEqual()` throws on.
    const obj = parent as Record<string, FabricValue>;
    if (this.#isDelete) {
      delete obj[leafKey];
      return { root: newRoot, changed: true };
    }
    if (Object.hasOwn(obj, leafKey) && valueEqual(obj[leafKey], value)) {
      return { root: newRoot, changed: false };
    }
    obj[leafKey] = value;
    return { root: newRoot, changed: true };
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
): { root: FabricValue; changed: boolean } => {
  const previousValue = parent.length;
  if (valueEqual(previousValue, value)) {
    return { root: newRoot, changed: false };
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
  return { root: newRoot, changed: parent.length !== previousValue };
};
