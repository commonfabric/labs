import type { FabricValue } from "@commonfabric/api";
import {
  cloneForMutation,
  CloneForMutationError,
  cloneIfNecessary,
  deepFreeze,
  type MutableFabricContainerValueLayer,
  valueEqual,
} from "@commonfabric/data-model";
import { isInstance, isObjectNotArray } from "@commonfabric/utils/types";
import { type EntityDocument, isEntityDocument, type PatchOp } from "../v2.ts";
import { encodePointer, parsePointer } from "./path.ts";

type PatchObject = Record<string, FabricValue>;
type PatchContainer = PatchObject | FabricValue[];
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/**
 * Deep-clones an incoming patch value for isolation, preserving
 * `FabricInstance` wrappers (e.g. `FabricError`, `FabricMap`).
 *
 * `structuredClone()` MUST NOT be used here: it silently demotes class
 * instances to plain objects. A demoted `FabricError` then fails the
 * `value instanceof FabricInstance` check in the wire/persistence codec
 * (`jsonFromFabricValue()`/`FabricInstanceHandler`), so it is serialized
 * generically and its wrapped JS `Error` -- whose `message`/`stack`
 * are non-enumerable -- collapses to `{}`, losing the error entirely.
 *
 * `cloneIfNecessary()` deep-clones via the `FabricValue` machinery
 * (`FabricInstance.deepClone()` for wrappers), preserving the class.
 * Its default options (`{ frozen: true, deep: true }`) return an
 * already-deep-frozen input by identity, so replayed engine passes over a
 * previously-frozen subtree reuse it in place; otherwise the value is
 * deep-cloned to a deep-frozen result. The assembled tree is deep-frozen
 * at the `applyPatch` boundary regardless.
 */
const cloneValue = (value: FabricValue): FabricValue => cloneIfNecessary(value);

/**
 * A patch that cannot apply to the given base: a path descending through a
 * non-container, a kind mismatch (append onto a non-array), an invalid
 * pointer or index, or a root op producing a non-envelope result. Callers
 * that tolerate inapplicability (the client's pending replay renders such a
 * layer skipped) filter on THIS class; anything else propagating out of
 * patch application is an implementation failure and must not be swallowed.
 */
export class PatchApplyError extends Error {
  override name = "PatchApplyError";
}

/**
 * The base an absent document's patches replay over. Shared by the
 * engine's revision reconstruction and the client's pending-layer replay,
 * so both sides fold a document's very first patches identically.
 */
export const emptyEntityDocument = (): EntityDocument => ({});

/**
 * `applyPatch` over a possibly-absent document: an absent base normalizes
 * to the empty envelope. The one entry point for "replay these ops over
 * whatever this document currently is" — server-side reconstruction and
 * client-side pending replay share it rather than each knowing the
 * absent-base rule.
 */
export const applyPatchToDocument = (
  base: EntityDocument | undefined,
  ops: PatchOp[],
): EntityDocument => {
  const patched = applyPatch(base ?? emptyEntityDocument(), ops);
  // A root-level op can produce any FabricValue (replace at "" returns its
  // value verbatim); the entity envelope must stay a plain object. Reject
  // rather than type-launder — the client's pending replay treats this as
  // an unappliable layer, and no caller ever sees an invalid envelope.
  if (!isEntityDocument(patched)) {
    throw new PatchApplyError("patched root is not an entity document");
  }
  return patched;
};

/**
 * Applies a sequence of RFC 6902 JSON Patch operations (`replace`, `add`,
 * `remove`, `move`, `splice`) to a document tree, returning a new document
 * tree with the patches applied in order. JSON Pointer paths in the ops are
 * parsed via `parsePointer()` from `./path.ts`.
 *
 * Used during document materialization: `engine.ts` walks the stored patch
 * sequence for a branch and rebuilds the current document by replaying each
 * patch on top of the previous state (`applyPatchDocument` → `applyPatch`).
 * The function is therefore on the hot path for any read that reconstructs
 * a document from its stored patch list.
 *
 * Mutation discipline: each op is applied via a copy-on-write descent. The
 * spine of containers from the root down to the mutated container is thawed to
 * mutable copies (via `cloneForMutation()`), the leaf operation is applied to
 * that mutable container, and subtrees off the spine stay frozen-by-reference
 * (structural sharing). A container is copied the first time an op's spine
 * passes through it, and later ops in the same call mutate that copy in place,
 * so each container is copied at most once per call: `K` ops beneath one
 * `N`-key object copy it once, not `K` times. No op writes to the caller's
 * `state`. The assembled tree is then fully deep-frozen at the `applyPatch`
 * boundary, so callers can rely on the return value being deeply frozen; the
 * subtrees it shares with `state` are frozen in place, `state` itself included
 * when no op touches it.
 */
export const applyPatch = (
  state: FabricValue,
  ops: PatchOp[],
): FabricValue => {
  // Every container in this set was copied by an op of this call, so no one
  // outside the call holds it. Op values enter the tree through `cloneValue()`,
  // which never hands back a mutable container, so none of them is shared.
  const owned = new WeakSet<object>();
  let current = state;
  for (const op of ops) {
    current = applyOp(current, op, owned);
  }
  return deepFreeze(current);
};

const applyOp = (
  state: FabricValue,
  op: PatchOp,
  owned: WeakSet<object>,
): FabricValue => patchOpDescriptors[op.op].apply(state, op, owned);

/**
 * Copy-on-write thaw of the spine of `root` down to `thawPath`, returning the
 * new root and the mutable container at `thawPath`. Subtrees off the spine are
 * shared by identity (structural sharing). A spine container in `owned` was
 * copied by an earlier op of the same `applyPatch()` call and is reused in
 * place; any other is copied and added to `owned`, so the caller's input is
 * left untouched (`cloneForMutation` defaults to `force: true`).
 * `cloneForMutation`'s typed errors are translated into this module's
 * path-style messages, and a value-at-path that isn't a plain container is
 * rejected (patch ops only mutate objects/arrays). `fullPath` is used for error
 * messages.
 */
const thawSpine = (
  root: FabricValue,
  thawPath: string[],
  fullPath: string[],
  owned: WeakSet<object>,
  options?: { createMissing?: boolean; nextKeyAfterPath?: string },
): { root: FabricValue; container: PatchContainer } => {
  let value: FabricValue;
  let pathValue: MutableFabricContainerValueLayer;
  try {
    ({ value, pathValue } = cloneForMutation(root, thawPath, {
      ...options,
      owned,
    }));
  } catch (e) {
    if (e instanceof CloneForMutationError) {
      throw new PatchApplyError(
        e.kind === "missing-segment"
          ? `missing path ${encodePointer(fullPath)}`
          : `path is not traversable at ${encodePointer(fullPath)}`,
      );
    }
    throw e;
  }
  if (!isContainer(pathValue)) {
    throw new PatchApplyError(
      `path is not traversable at ${encodePointer(fullPath)}`,
    );
  }
  return { root: value, container: pathValue };
};

const replaceAtPath = (
  root: FabricValue,
  path: string[],
  value: FabricValue,
  owned: WeakSet<object>,
): FabricValue => {
  if (path.length === 0) {
    return cloneValue(value);
  }
  const { root: newRoot, container } = thawSpine(
    root,
    path.slice(0, -1),
    path,
    owned,
  );
  const key = path[path.length - 1]!;
  if (Array.isArray(container)) {
    container[requireExistingArrayIndex(container, key, path)] = cloneValue(
      value,
    );
  } else {
    container[key] = cloneValue(value);
  }
  return newRoot;
};

/**
 * Read-only check of `add`'s spine: missing *object* keys are fine (they get
 * created during the mutating descent), but a present array must already contain
 * any index traversed through, and a present non-container can't be traversed.
 * This is what keeps `add` from fabricating missing array indices (which
 * `cloneForMutation`'s `createMissing` would otherwise do).
 */
const validateAddSpine = (root: FabricValue, path: string[]): void => {
  let current: FabricValue = root;
  // Becomes true once we pass a missing object key: everything below is freshly
  // created, so all containers from there down are empty.
  let creating = false;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    if (creating) {
      // A freshly-created array is empty, so an intermediate array index (or the
      // `-` append marker) can never resolve to an existing element to traverse
      // into -- reject it rather than fabricate one. Plain object keys are fine;
      // they get created on the way down.
      if (isArraySegment(segment) || segment === "-") {
        throw new PatchApplyError(`missing path ${encodePointer(path)}`);
      }
      continue;
    }
    if (Array.isArray(current)) {
      current = current[requireExistingArrayIndex(current, segment, path)];
    } else if (isPatchObject(current)) {
      if (!Object.hasOwn(current, segment)) {
        creating = true;
        continue;
      }
      current = current[segment];
    } else {
      throw new PatchApplyError(
        `path is not traversable at ${encodePointer(path)}`,
      );
    }
  }
};

const addAtPath = (
  root: FabricValue,
  path: string[],
  value: FabricValue,
  owned: WeakSet<object>,
): FabricValue => {
  if (path.length === 0) {
    return cloneValue(value);
  }
  validateAddSpine(root, path);
  const key = path[path.length - 1]!;
  const { root: newRoot, container } = thawSpine(
    root,
    path.slice(0, -1),
    path,
    owned,
    {
      createMissing: true,
      nextKeyAfterPath: key,
    },
  );
  if (Array.isArray(container)) {
    if (key === "-") {
      container.push(cloneValue(value));
    } else {
      container.splice(
        parseArrayInsertIndex(key, container.length),
        0,
        cloneValue(value),
      );
    }
  } else {
    container[key] = cloneValue(value);
  }
  return newRoot;
};

const removeAtPath = (
  root: FabricValue,
  path: string[],
  owned: WeakSet<object>,
): FabricValue => {
  if (path.length === 0) {
    throw new PatchApplyError(
      "root remove must be represented as a delete operation",
    );
  }
  const { root: newRoot, container } = thawSpine(
    root,
    path.slice(0, -1),
    path,
    owned,
  );
  const key = path[path.length - 1]!;
  if (Array.isArray(container)) {
    container.splice(requireExistingArrayIndex(container, key, path), 1);
  } else {
    if (!Object.hasOwn(container, key)) {
      throw new PatchApplyError(`missing object key at ${encodePointer(path)}`);
    }
    delete container[key];
  }
  return newRoot;
};

const moveValue = (
  root: FabricValue,
  from: string[],
  path: string[],
  owned: WeakSet<object>,
): FabricValue => {
  if (from.length === 0) {
    throw new PatchApplyError("cannot move the root value");
  }
  if (isStrictPrefixPath(from, path)) {
    throw new PatchApplyError("cannot move a value into its own descendant");
  }

  // The extracted value may be a container an earlier op copied, and it
  // re-enters the tree through `addAtPath()`'s `cloneValue()`, so the tree
  // never holds it at two places.
  const extracted = getAtPath(root, from);
  return addAtPath(removeAtPath(root, from, owned), path, extracted, owned);
};

const spliceAtPath = (
  root: FabricValue,
  path: string[],
  index: number,
  remove: number,
  add: FabricValue[],
  owned: WeakSet<object>,
): FabricValue => {
  const { root: newRoot, container } = thawSpine(root, path, path, owned);
  if (!Array.isArray(container)) {
    throw new PatchApplyError(
      `splice target is not an array at ${encodePointer(path)}`,
    );
  }
  if (index < 0 || remove < 0 || index > container.length) {
    throw new PatchApplyError(`invalid splice at ${encodePointer(path)}`);
  }
  container.splice(index, remove, ...add.map((value) => cloneValue(value)));
  return newRoot;
};

// A tail-relative append resolves its position against the array's live state
// rather than any client-supplied index, and creates the array (and the path to
// it) when absent. `validateAddSpine` keeps the parent descent from fabricating
// missing array indices, exactly as `add` does.
const appendAtPath = (
  root: FabricValue,
  path: string[],
  values: FabricValue[],
  owned: WeakSet<object>,
): FabricValue => {
  validateAddSpine(root, path);
  const { root: newRoot, container } = thawSpine(root, path, path, owned, {
    createMissing: true,
    nextKeyAfterPath: "0",
  });
  if (!Array.isArray(container)) {
    throw new PatchApplyError(
      `append target is not an array at ${encodePointer(path)}`,
    );
  }
  container.push(...values.map((value) => cloneValue(value)));
  return newRoot;
};

// Set-add by identity: append each value to the tail only if no existing element
// equals it (by stored-value content equality), creating the array if absent.
// The dedup runs against durable state on the server, so it is idempotent and
// merges with concurrent adds of distinct elements.
const addUniqueAtPath = (
  root: FabricValue,
  path: string[],
  values: FabricValue[],
  owned: WeakSet<object>,
): FabricValue => {
  validateAddSpine(root, path);
  const { root: newRoot, container } = thawSpine(root, path, path, owned, {
    createMissing: true,
    nextKeyAfterPath: "0",
  });
  if (!Array.isArray(container)) {
    throw new PatchApplyError(
      `add-unique target is not an array at ${encodePointer(path)}`,
    );
  }
  for (const value of values) {
    if (!container.some((existing) => valueEqual(existing, value))) {
      container.push(cloneValue(value));
    }
  }
  return newRoot;
};

// Remove every element of the array at `path` that equals `value` by stored-value
// content equality. A missing path or non-array target is a no-op (nothing to
// remove). Resolved against durable state, so it never clobbers via a whole-array
// rewrite.
const removeByValueAtPath = (
  root: FabricValue,
  path: string[],
  value: FabricValue,
  owned: WeakSet<object>,
): FabricValue => {
  const existing = readNumberOrAbsent(root, path);
  if (!Array.isArray(existing)) {
    return root;
  }
  if (!existing.some((element) => valueEqual(element, value))) {
    return root;
  }
  const { root: newRoot, container } = thawSpine(root, path, path, owned);
  // The value at `path` was confirmed to be an array above, so its thawed
  // container is that same array.
  const array = container as FabricValue[];
  for (let index = array.length - 1; index >= 0; index -= 1) {
    if (valueEqual(array[index], value)) {
      array.splice(index, 1);
    }
  }
  return newRoot;
};

const readNumberOrAbsent = (
  root: FabricValue,
  path: string[],
): FabricValue | undefined => {
  let current: FabricValue = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (
        !isArraySegment(segment) || !Object.hasOwn(current, Number(segment))
      ) {
        return undefined;
      }
      current = current[Number(segment)];
    } else if (isPatchObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
};

// Numeric increment: add `by` to the number at `path`, treating an absent value
// as 0 and creating the path if absent. The add runs against durable state on
// the server, so concurrent increments sum rather than clobber.
const incrementAtPath = (
  root: FabricValue,
  path: string[],
  by: number,
  owned: WeakSet<object>,
): FabricValue => {
  if (path.length === 0) {
    throw new PatchApplyError("increment requires a non-root path");
  }
  if (!Number.isFinite(by) || by === 0) {
    throw new PatchApplyError(
      `increment requires a finite non-zero amount at ${encodePointer(path)}`,
    );
  }
  const current = readNumberOrAbsent(root, path);
  if (current !== undefined && typeof current !== "number") {
    throw new PatchApplyError(
      `increment target is not a number at ${encodePointer(path)}`,
    );
  }
  const next = (typeof current === "number" ? current : 0) + by;
  validateAddSpine(root, path);
  const { root: newRoot, container } = thawSpine(
    root,
    path.slice(0, -1),
    path,
    owned,
    {
      createMissing: true,
      nextKeyAfterPath: path[path.length - 1]!,
    },
  );
  const key = path[path.length - 1]!;
  if (Array.isArray(container)) {
    container[parseArrayInsertIndex(key, container.length)] = next;
  } else {
    container[key] = next;
  }
  return newRoot;
};

const getAtPath = (root: FabricValue, path: string[]): FabricValue => {
  let current: FabricValue = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[requireExistingArrayIndex(current, segment, path)];
    } else if (isPatchObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      throw new PatchApplyError(`missing path ${encodePointer(path)}`);
    }
  }
  return current;
};

const parseArrayIndex = (segment: string): number => {
  if (!isArraySegment(segment)) {
    throw new PatchApplyError(`invalid array index: ${segment}`);
  }
  const index = Number(segment);
  if (index > MAX_ARRAY_INDEX) {
    throw new PatchApplyError(`array index out of bounds: ${segment}`);
  }
  return index;
};

const parseArrayInsertIndex = (segment: string, length: number): number => {
  const index = parseArrayIndex(segment);
  if (index > length) {
    throw new PatchApplyError(`array index out of bounds: ${segment}`);
  }
  return index;
};

const requireExistingArrayIndex = (
  array: FabricValue[],
  segment: string,
  path: string[],
): number => {
  const index = parseArrayIndex(segment);
  if (!Object.hasOwn(array, index)) {
    throw new PatchApplyError(`missing path ${encodePointer(path)}`);
  }
  return index;
};

const isStrictPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length < path.length &&
  prefix.every((segment, index) => path[index] === segment);

const isArraySegment = (segment: string): boolean =>
  /^(0|[1-9]\d*)$/.test(segment);

const isPatchObject = (value: FabricValue): value is PatchObject =>
  isObjectNotArray(value) && !isInstance(value);

const isContainer = (value: FabricValue): value is PatchContainer =>
  Array.isArray(value) || isPatchObject(value);

/**
 * The single definition of one patch operation kind. Every site that must
 * answer a per-op question reads it from here instead of re-deriving it from a
 * switch:
 *
 * - `apply` is the mutation the durable store performs for the op (used by
 *   {@link applyPatch} above). Its `owned` argument holds the containers
 *   earlier ops of the same `applyPatch()` call copied, which it mutates in
 *   place rather than copying again, and it adds to the set every container it
 *   copies.
 * - `pointerFields` names the fields whose value is a JSON Pointer into the
 *   document (`["path"]` for most ops, `["from", "path"]` for `move`). It is the
 *   source for every "which paths does this op touch" computation: the
 *   commit-conflict and scheduler reader-dirty matchers in `engine.ts` and the
 *   client-side pending-replay path computation in `runner storage/v2.ts` all
 *   derive from it (see {@link touchedPointerPaths}).
 * - `structural` is true for ops that UNCONDITIONALLY restructure a container's
 *   key set — `add`, `remove`, `move` — which add, drop, or relocate a child key
 *   on every apply. For those, a shape-only (nonRecursive) reader of the parent
 *   must be invalidated at the parent path (the parent injection in
 *   `touchedPathsForPatch`), and the client replay resolves the target against
 *   live state. `replace` / `splice` / `append` / `add-unique` /
 *   `remove-by-value` / `increment` are false: they touch the leaf/array path
 *   itself, which a reader of that path already prefixes.
 *
 *   `append` / `add-unique` / `increment` DO change the parent's key set in one
 *   case — when they materialize a previously-absent path (their apply creates
 *   the array/scalar and the path to it). That is conditional on the pre-state,
 *   which this static flag cannot express, so it is carried per-instance by the
 *   op's `createsKey` field (stamped by the writer that saw the path absent) and
 *   folded in by {@link patchOpChangesParentKeySet}, which is what the shape-read
 *   conflict matcher uses instead of `structural`. Marking these ops structural
 *   unconditionally would instead over-conflict every parent shape reader against
 *   an ordinary append to an already-present child — the write-contention the
 *   mergeable ops exist to avoid. See
 *   docs/specs/memory-v2/08-conflict-granularity.md.
 *
 * Adding a new wire op is a single new entry here: the `Record<PatchOp["op"],
 * …>` type makes a missing entry (or an entry for a tag not in the `PatchOp`
 * union) a compile error, so `apply` and the path matchers can never silently
 * fall out of step with the union.
 */
export type PatchOpDescriptor<Op extends PatchOp = PatchOp> = {
  readonly op: Op["op"];
  readonly pointerFields: readonly string[];
  readonly structural: boolean;
  readonly apply: (
    state: FabricValue,
    op: Op,
    owned: WeakSet<object>,
  ) => FabricValue;
};

const descriptor = <Op extends PatchOp>(
  d: PatchOpDescriptor<Op>,
): PatchOpDescriptor => d as unknown as PatchOpDescriptor;

export const patchOpDescriptors: Record<PatchOp["op"], PatchOpDescriptor> = {
  replace: descriptor<Extract<PatchOp, { op: "replace" }>>({
    op: "replace",
    pointerFields: ["path"],
    structural: false,
    apply: (state, op, owned) =>
      replaceAtPath(state, parsePointer(op.path), op.value, owned),
  }),
  add: descriptor<Extract<PatchOp, { op: "add" }>>({
    op: "add",
    pointerFields: ["path"],
    structural: true,
    apply: (state, op, owned) =>
      addAtPath(state, parsePointer(op.path), op.value, owned),
  }),
  remove: descriptor<Extract<PatchOp, { op: "remove" }>>({
    op: "remove",
    pointerFields: ["path"],
    structural: true,
    apply: (state, op, owned) =>
      removeAtPath(state, parsePointer(op.path), owned),
  }),
  move: descriptor<Extract<PatchOp, { op: "move" }>>({
    op: "move",
    pointerFields: ["from", "path"],
    structural: true,
    apply: (state, op, owned) =>
      moveValue(state, parsePointer(op.from), parsePointer(op.path), owned),
  }),
  splice: descriptor<Extract<PatchOp, { op: "splice" }>>({
    op: "splice",
    pointerFields: ["path"],
    structural: false,
    apply: (state, op, owned) =>
      spliceAtPath(
        state,
        parsePointer(op.path),
        op.index,
        op.remove,
        op.add,
        owned,
      ),
  }),
  append: descriptor<Extract<PatchOp, { op: "append" }>>({
    op: "append",
    pointerFields: ["path"],
    structural: false,
    apply: (state, op, owned) =>
      appendAtPath(state, parsePointer(op.path), op.values, owned),
  }),
  "add-unique": descriptor<Extract<PatchOp, { op: "add-unique" }>>({
    op: "add-unique",
    pointerFields: ["path"],
    structural: false,
    apply: (state, op, owned) =>
      addUniqueAtPath(state, parsePointer(op.path), op.values, owned),
  }),
  "remove-by-value": descriptor<Extract<PatchOp, { op: "remove-by-value" }>>({
    op: "remove-by-value",
    pointerFields: ["path"],
    structural: false,
    apply: (state, op, owned) =>
      removeByValueAtPath(state, parsePointer(op.path), op.value, owned),
  }),
  increment: descriptor<Extract<PatchOp, { op: "increment" }>>({
    op: "increment",
    pointerFields: ["path"],
    structural: false,
    apply: (state, op, owned) =>
      incrementAtPath(state, parsePointer(op.path), op.by, owned),
  }),
};

/**
 * The JSON-Pointer paths a patch op names, parsed to segment arrays: `["path"]`
 * for most ops, `["from", "path"]` for `move`. These are the op's exact changed
 * leaf paths — with no parent injection. This is the shared source for the
 * leaf-only conflict/reactivity matchers (`engine.ts`
 * `touchedLeafPathsForPatch`), and the base from which the parent-injecting
 * (shape-read) and client pending-replay path computations are built.
 */
export const touchedPointerPaths = (op: PatchOp): string[][] =>
  patchOpDescriptors[op.op].pointerFields.map((field) =>
    parsePointer((op as unknown as Record<string, string>)[field])
  );

/**
 * Whether the op adds, removes, or reorders a container's keys (`add`, `remove`,
 * `move`). Callers that must invalidate a shape-only reader of the container, or
 * resolve the target against live state, key off this flag.
 */
export const patchOpIsStructural = (op: PatchOp): boolean =>
  patchOpDescriptors[op.op].structural;

/**
 * Whether the op changes its parent container's key set, so a shape-only
 * (nonRecursive) reader of the parent must be invalidated. True for the
 * unconditionally-structural ops (`patchOpIsStructural`) AND for a mergeable op
 * instance that materialized a previously-absent path (its `createsKey` flag —
 * a value-dependent fact the writer records, since the static op kind cannot
 * express it; see the `structural` doc above and the `createsKey` field in
 * `../v2.ts`). Used only by the shape-read conflict matcher; the replay and
 * indexed-array-guard sites use the static `patchOpIsStructural`.
 */
export const patchOpChangesParentKeySet = (op: PatchOp): boolean =>
  patchOpDescriptors[op.op].structural ||
  (op as { createsKey?: boolean }).createsKey === true;

/**
 * The names of the op's JSON-Pointer-valued fields (`["path"]`, or
 * `["from", "path"]` for `move`), so a caller can read the raw pointer strings
 * an op carries without knowing which op it is.
 */
export const patchOpPointerFields = (op: PatchOp): readonly string[] =>
  patchOpDescriptors[op.op].pointerFields;
