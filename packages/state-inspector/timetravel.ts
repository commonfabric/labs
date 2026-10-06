// Time travel — how state got to where it is.
//
// The engine already reconstructs any entity at any seq (reconstruct.ts), so the
// autopsy can run the clock backwards and forwards. Two views:
//
//   diff      — what changed in an entity between two seqs (structural value diff)
//   timeline  — how an entity grew (per-write value summary + change count), or
//               how a space grew (commits over time, new vs touched entities)
//
// Values are normalized with `annotate` first, so links/streams compare as
// stable shapes instead of exploding into nested objects.

import {
  hashStringOf,
  isFabricArray,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import { applyPatch } from "@commonfabric/memory/v2/patch";
import type { PatchOp } from "@commonfabric/memory/v2";
import type { FabricValue } from "@commonfabric/api";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { isPlainObject } from "@commonfabric/utils/types";

import type { SpaceDb } from "./db.ts";
import {
  annotate,
  decodedLinkOf,
  decodeStored,
  escapeTerminalText,
  isStream,
  parseEntityRef,
  summarize,
} from "./decode.ts";
import {
  owningLink,
  reconstructDocument,
  selectAtPath,
} from "./reconstruct.ts";

/** Annotation depth used for values included in diff output. */
const COMPARE_DEPTH = 32;

const DEFAULT_DIFF_DEPTH = 12;

export type ChangeKind = "added" | "removed" | "changed";
export type StoredValueKind =
  | "array"
  | "bigint"
  | "boolean"
  | "fabric"
  | "function"
  | "link"
  | "null"
  | "number"
  | "object"
  | "reference"
  | "stream"
  | "string"
  | "symbol"
  | "undefined";

export interface ValueChange {
  /** Slash-delimited path of the change. */
  path: string;

  /** Exact path segments, e.g. `["value", "items", "0"]`. */
  pathSegments?: string[];

  kind: ChangeKind;
  before?: FabricValue;
  after?: FabricValue;

  /** Set when `before` is the annotation for a stored `undefined` value. */
  beforeIsUndefined?: true;

  /** Set when `after` is the annotation for a stored `undefined` value. */
  afterIsUndefined?: true;

  /** Set when different stored values have equal display annotations. */
  annotationCollision?: true;

  /** Stored value kind for `before` when display annotations collide. */
  beforeValueKind?: StoredValueKind;

  /** Stored value kind for `after` when display annotations collide. */
  afterValueKind?: StoredValueKind;
}

/** A value change whose path is available as exact string segments. */
export interface ExactValueChange extends ValueChange {
  pathSegments: string[];
}

// The data-model hash defines equality for `FabricValue` leaves, including
// BigInt, symbols, and `FabricInstance`s.
function canonical(v: FabricValue): string {
  return v === undefined ? "undefined" : hashStringOf(v);
}

function storedValueKind(value: FabricValue): StoredValueKind {
  if (value === null) return "null";
  if (decodedLinkOf(value) !== null) return "link";
  if (isStream(value)) return "stream";
  if (parseEntityRef(value) !== null) return "reference";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") {
    return isPlainObject(value) ? "object" : "fabric";
  }
  return typeof value;
}

function valuesEqual(a: FabricValue, b: FabricValue): boolean {
  const pending: [FabricValue, FabricValue][] = [[a, b]];
  const compared = new WeakMap<object, WeakSet<object>>();
  const alreadyCompared = (left: object, right: object): boolean => {
    let rights = compared.get(left);
    if (rights?.has(right)) return true;
    if (rights === undefined) {
      rights = new WeakSet<object>();
      compared.set(left, rights);
    }
    rights.add(right);
    return false;
  };

  while (pending.length > 0) {
    const [left, right] = pending.pop()!;
    if (Object.is(left, right)) continue;
    if (isFabricArray(left) || isFabricArray(right)) {
      if (
        !isFabricArray(left) || !isFabricArray(right) ||
        left.length !== right.length
      ) {
        return false;
      }
      const leftIndexes = Object.keys(left).filter(isArrayIndexPropertyName);
      const rightIndexes = Object.keys(right).filter(isArrayIndexPropertyName);
      if (leftIndexes.length !== rightIndexes.length) return false;
      if (alreadyCompared(left, right)) continue;
      for (const key of leftIndexes) {
        const index = Number(key);
        if (!Object.hasOwn(right, index)) return false;
        pending.push([left[index], right[index]]);
      }
      continue;
    }
    const leftIsObject = isFabricPlainObject(left);
    const rightIsObject = isFabricPlainObject(right);
    if (leftIsObject || rightIsObject) {
      if (!leftIsObject || !rightIsObject) return false;
      const leftKeys = Object.keys(left);
      const rightKeys = Object.keys(right);
      if (leftKeys.length !== rightKeys.length) return false;
      if (alreadyCompared(left, right)) continue;
      for (const key of leftKeys) {
        if (!Object.hasOwn(right, key)) return false;
        pending.push([left[key], right[key]]);
      }
      continue;
    }
    if (canonical(left) !== canonical(right)) return false;
  }
  return true;
}

function beforeOutput(
  value: FabricValue,
): Pick<ValueChange, "before" | "beforeIsUndefined"> {
  return {
    before: annotate(value, COMPARE_DEPTH),
    ...(value === undefined ? { beforeIsUndefined: true as const } : {}),
  };
}

function afterOutput(
  value: FabricValue,
): Pick<ValueChange, "after" | "afterIsUndefined"> {
  return {
    after: annotate(value, COMPARE_DEPTH),
    ...(value === undefined ? { afterIsUndefined: true as const } : {}),
  };
}

function changedOutput(
  before: FabricValue,
  after: FabricValue,
): Pick<
  ValueChange,
  | "before"
  | "beforeIsUndefined"
  | "after"
  | "afterIsUndefined"
  | "annotationCollision"
  | "beforeValueKind"
  | "afterValueKind"
> {
  const beforeFields = beforeOutput(before);
  const afterFields = afterOutput(after);
  const annotationCollision = valuesEqual(
    beforeFields.before,
    afterFields.after,
  );
  return {
    ...beforeFields,
    ...afterFields,
    ...(annotationCollision
      ? {
        annotationCollision: true as const,
        beforeValueKind: storedValueKind(before),
        afterValueKind: storedValueKind(after),
      }
      : {}),
  };
}

interface SelectedDiffValue {
  present: boolean;
  value: FabricValue;
}

function diffSelectedValues(
  before: SelectedDiffValue,
  after: SelectedDiffValue,
  basePath: string[],
  maxDepth: number,
): ExactValueChange[] {
  const out: ExactValueChange[] = [];
  const walk = (
    a: FabricValue,
    b: FabricValue,
    path: string[],
    depth: number,
    aPresent: boolean,
    bPresent: boolean,
  ) => {
    const here = { path: path.join("/"), pathSegments: [...path] };
    if (!aPresent && !bPresent) return;
    if (!aPresent) {
      out.push({ ...here, kind: "added", ...afterOutput(b) });
      return;
    }
    if (!bPresent) {
      out.push({ ...here, kind: "removed", ...beforeOutput(a) });
      return;
    }
    if (valuesEqual(a, b)) return;
    if (depth <= 0) {
      out.push({
        ...here,
        kind: "changed",
        ...changedOutput(a, b),
      });
      return;
    }
    if (isFabricPlainObject(a) && isFabricPlainObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const aHasKey = Object.hasOwn(a, key);
        const bHasKey = Object.hasOwn(b, key);
        walk(
          aHasKey ? a[key] : undefined,
          bHasKey ? b[key] : undefined,
          [...path, key],
          depth - 1,
          aHasKey,
          bHasKey,
        );
      }
      return;
    }
    if (isFabricArray(a) && isFabricArray(b)) {
      const aIndexes = Object.keys(a).filter(isArrayIndexPropertyName);
      const bIndexes = Object.keys(b).filter(isArrayIndexPropertyName);
      if (
        a.length !== b.length &&
        (aIndexes.length !== a.length || bIndexes.length !== b.length)
      ) {
        out.push({
          ...here,
          kind: "changed",
          ...changedOutput(a, b),
        });
        return;
      }
      const keys = [...new Set([...aIndexes, ...bIndexes])].sort(
        (left, right) => Number(left) - Number(right),
      );
      for (const key of keys) {
        const index = Number(key);
        const aHasKey = Object.hasOwn(a, index);
        const bHasKey = Object.hasOwn(b, index);
        walk(
          aHasKey ? a[index] : undefined,
          bHasKey ? b[index] : undefined,
          [...path, key],
          depth - 1,
          aHasKey,
          bHasKey,
        );
      }
      return;
    }
    out.push({
      ...here,
      kind: "changed",
      ...changedOutput(a, b),
    });
  };
  walk(
    before.value,
    after.value,
    basePath,
    maxDepth,
    before.present,
    after.present,
  );
  return out;
}

/**
 * Structurally diff two values. `maxDepth` bounds the reported path depth.
 * Deeper differences collapse to a single `changed` entry at the boundary.
 */
export function diffValues(
  before: FabricValue,
  after: FabricValue,
  basePath: string[] = [],
  maxDepth = DEFAULT_DIFF_DEPTH,
): ExactValueChange[] {
  return diffSelectedValues(
    { present: before !== undefined, value: before },
    { present: after !== undefined, value: after },
    basePath,
    maxDepth,
  );
}

export interface EntityDiff {
  id: string;
  fromSeq: number | null;
  toSeq: number | null;
  fromExists: boolean;
  toExists: boolean;
  changes: ValueChange[];
}

/** An entity diff whose changes include exact path segments. */
export interface ExactEntityDiff extends EntityDiff {
  changes: ExactValueChange[];
}

/**
 * Diff an entity between two seqs. By default diffs `value`; pass `doc` to
 * include the whole document or a `path` to focus within `value`.
 *
 * @throws {Error} When `doc` and `path` are both provided.
 * @throws {Error} When either selected document cannot be reconstructed.
 */
export function diffEntity(
  space: SpaceDb,
  opts: {
    id: string;
    scope?: string;
    branch?: string;
    fromSeq?: number;
    toSeq?: number;
    path?: string[];
    doc?: boolean;
  },
): ExactEntityDiff {
  if (opts.doc && opts.path !== undefined) {
    throw new Error("`doc` and `path` cannot be used together.");
  }
  const { id } = opts;
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const path = opts.path ?? [];
  // `from` defaults to birth (seq 0 = empty baseline), NOT latest — omitting
  // atSeq would reconstruct the head, making a no-`--from` diff always empty.
  const before = reconstructDocument(space, {
    id,
    scope,
    branch,
    atSeq: opts.fromSeq ?? 0,
  });
  const after = reconstructDocument(space, {
    id,
    scope,
    branch,
    atSeq: opts.toSeq,
  });
  const pick = (doc: typeof before): SelectedDiffValue => {
    if (doc === undefined) return { present: false, value: undefined };
    if (opts.doc) {
      return { present: true, value: doc };
    }
    if (!Object.hasOwn(doc, "value")) {
      return { present: false, value: undefined };
    }
    const selected = selectAtPath(doc.value, path);
    return {
      present: selected.found,
      value: selected.value,
    };
  };
  return {
    id,
    fromSeq: opts.fromSeq ?? null,
    toSeq: opts.toSeq ?? null,
    fromExists: before !== undefined,
    toExists: after !== undefined,
    changes: diffSelectedValues(
      pick(before),
      pick(after),
      [],
      DEFAULT_DIFF_DEPTH,
    ),
  };
}

export interface TimelineStep {
  seq: number;
  opIndex: number;
  op: string;
  commitSeq: number;
  session: string;
  createdAt: string;

  /** One-line summary of the entity's value after this write. */
  summary: string;

  /** Whether the entity is known to exist after this write. */
  exists: boolean;

  /** Number of changes from the preceding state. */
  changes: number;

  /** Set when the preceding or current state could not be reconstructed. */
  changesKnown?: false;

  /** Set when the entity's state after this write could not be reconstructed. */
  stateKnown?: false;

  /** The reconstruction error, when this write could not establish state. */
  error?: string;
}

/**
 * The life of one entity: every write, with the value summary after it and how
 * many paths changed. Reconstructs incrementally write-by-write.
 */
export function entityTimeline(
  space: SpaceDb,
  opts: {
    id: string;
    scope?: string;
    branch?: string;
    limit?: number;
  },
): TimelineStep[] {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const limit = opts.limit ?? 500;
  // The branch that OWNS the visible row, not the branch asked about: the
  // replay below mirrors `reconstructWithinBranch`, which never composes across
  // a fork, so the rows to replay are that branch's. Reading local rows only
  // would return an empty timeline for an entity the branch inherited.
  const owner = owningLink(space, { branch, scope, id: opts.id });
  const rows = owner === undefined ? [] : space.db
    .prepare(
      `SELECT r.seq, r.op_index, r.op, r.data, r.commit_seq,
              c.session_id, c.created_at
       FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.branch = ? AND r.id = ? AND r.scope_key = ? AND r.seq <= ?
       ORDER BY r.seq ASC, r.op_index ASC LIMIT ?`,
    )
    .all<{
      seq: number;
      op_index: number;
      op: string;
      data: string | null;
      commit_seq: number;
      session_id: string;
      created_at: string;
    }>(owner.branch, opts.id, scope, owner.atSeq, limit);

  // Replay the owning branch's rows INCREMENTALLY — apply one op per step against a
  // running document — instead of re-reconstructing from scratch at every seq
  // (which is O(writes²) and won't return on a hot entity). The op semantics
  // mirror reconstructWithinBranch: set=decode, patch=applyPatch(doc ?? {}),
  // delete=tombstone (a later patch then starts from {}, as the engine does).
  const steps: TimelineStep[] = [];
  let doc: FabricValue | undefined = undefined;
  let stateKnown = true;
  let previousValue: SelectedDiffValue = {
    present: false,
    value: undefined,
  };
  for (const r of rows) {
    const previousStateKnown = stateKnown;
    let reconstructionError: string | undefined;
    if (r.op === "patch" && !stateKnown) {
      reconstructionError =
        "State remains unknown because an earlier write could not be reconstructed.";
    } else {
      try {
        if (r.op === "set") {
          doc = r.data ? decodeStored(r.data) : undefined;
          stateKnown = true;
        } else if (r.op === "patch") {
          const ops = r.data ? (decodeStored(r.data) as PatchOp[]) : [];
          doc = applyPatch(doc ?? {}, ops);
          stateKnown = true;
        } else if (r.op === "delete") {
          doc = undefined;
          stateKnown = true;
        } else {
          throw new Error(`Unsupported revision operation: ${r.op}`);
        }
      } catch (e) {
        reconstructionError = (e as Error).message;
        doc = undefined;
        stateKnown = false;
      }
    }
    const exists = stateKnown && doc !== undefined;
    const value: SelectedDiffValue = exists && isFabricPlainObject(doc) &&
        Object.hasOwn(doc, "value")
      ? { present: true, value: doc.value }
      : { present: false, value: undefined };
    const changesKnown = previousStateKnown && stateKnown;
    const changes = changesKnown
      ? diffSelectedValues(
        previousValue,
        value,
        [],
        DEFAULT_DIFF_DEPTH,
      ).length
      : 0;
    steps.push({
      seq: r.seq,
      opIndex: r.op_index,
      op: r.op,
      commitSeq: r.commit_seq,
      session: r.session_id,
      createdAt: r.created_at,
      summary: reconstructionError
        ? `«unknown: ${escapeTerminalText(reconstructionError)}»`
        : exists
        ? summarize(value.value)
        : "(deleted)",
      exists,
      changes,
      ...(!changesKnown ? { changesKnown: false as const } : {}),
      ...(!stateKnown ? { stateKnown: false as const } : {}),
      ...(reconstructionError ? { error: reconstructionError } : {}),
    });
    if (stateKnown) previousValue = value;
  }
  return steps;
}

export interface SpaceTimelineEntry {
  commitSeq: number;
  createdAt: string;
  session: string;

  /** Entities touched (revisions) in this commit. */
  touched: number;

  /** Entities seen here for the first time. */
  created: number;

  /** Cumulative distinct entities up to and including this commit. */
  cumulativeEntities: number;
}

/** How a space grew: per-commit touched/created counts and a cumulative total. */
export function spaceTimeline(
  space: SpaceDb,
  opts: { branch?: string; scope?: string; limit?: number } = {},
): SpaceTimelineEntry[] {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const limit = opts.limit ?? 500;

  // First-seen seq per entity → lets us count "created" per commit.
  const firstSeen = new Map<string, number>();
  for (
    const r of space.db
      .prepare(
        `SELECT id, min(commit_seq) firstCommit FROM revision
         WHERE branch = ? AND scope_key = ? GROUP BY id`,
      )
      .all<{ id: string; firstCommit: number }>(branch, scope)
  ) {
    firstSeen.set(r.id, r.firstCommit);
  }

  const commits = space.db
    .prepare(
      // `touched` counts DISTINCT entities (an entity written twice in one
      // commit is one touch). Commits are filtered to the requested branch so a
      // non-default-branch timeline isn't padded with unrelated `touched: 0`
      // commits from other branches.
      `SELECT c.seq, c.created_at, c.session_id,
              count(DISTINCT r.id) touched
       FROM "commit" c
       LEFT JOIN revision r ON r.commit_seq = c.seq
         AND r.branch = ? AND r.scope_key = ?
       WHERE c.branch = ?
       GROUP BY c.seq ORDER BY c.seq ASC LIMIT ?`,
    )
    .all<{
      seq: number;
      created_at: string;
      session_id: string;
      touched: number;
    }>(branch, scope, branch, limit);

  // created-per-commit: count entities whose firstCommit == this commit.
  const createdByCommit = new Map<number, number>();
  for (const fc of firstSeen.values()) {
    createdByCommit.set(fc, (createdByCommit.get(fc) ?? 0) + 1);
  }

  let cumulative = 0;
  return commits.map((c) => {
    const created = createdByCommit.get(c.seq) ?? 0;
    cumulative += created;
    return {
      commitSeq: c.seq,
      createdAt: c.created_at,
      session: c.session_id,
      touched: c.touched,
      created,
      cumulativeEntities: cumulative,
    };
  });
}
